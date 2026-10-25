import "server-only";
import { APIConnectionTimeoutError } from "openai";
import WebSocket from "ws";
import { appHeaders } from "./app-version";
import { CloudError, cloudProxy } from "./cloud";
import { usageTags } from "./usage";

/**
 * A task turn's Responses calls over one WebSocket (OpenAI's WebSocket mode): each step a
 * `response.create` with only its new input and `previous_response_id`, which OpenAI says makes long
 * tool loops up to about 40% faster, and recommends for Ultrafast (computer-task.ts uses it for its
 * fast steps). Signed in, it goes through Bops Cloud (cloud/proxy.ts responsesSocket), which checks
 * and counts each step as it does a POST; self-hosting, straight to OpenAI on OPENAI_API_KEY.
 *
 * One step at a time. A step OpenAI (or the cloud) refuses throws as the SDK would: its status, so a
 * busy tier falls back (routing.ts withSpeed), and Bops Cloud's credit codes (cloud.ts outOfCredits).
 * A socket that won't open, or drops, throws a TransportError: the caller makes that step over HTTP.
 * BOPS_RESPONSES_WS=0 turns it off.
 */

export const responsesSocketOn = () => process.env.BOPS_RESPONSES_WS?.trim() !== "0";

/** The socket itself failed (it wouldn't open, or closed mid-step): the step wasn't answered, so it can go over HTTP. */
export class TransportError extends Error {}

type Pending = { resolve: (r: unknown) => void; reject: (e: unknown) => void; done: () => void };

export class ResponsesSocket {
  private pending: Pending | null = null;
  private dead = false;
  private ws: WebSocket;

  private constructor(ws: WebSocket) {
    this.ws = ws;
    ws.on("message", (data, binary) => {
      if (binary || !this.pending) return;
      let e: { type?: string; status?: number; error?: { message?: string; code?: string | null }; response?: { error?: { message?: string } } } | undefined;
      try {
        e = JSON.parse(data.toString()) as typeof e;
      } catch {
        return;
      }
      const p = this.pending;
      if (e?.type === "response.completed" || e?.type === "response.incomplete") p.resolve(e.response);
      else if (e?.type === "response.failed") p.reject(Object.assign(new Error(e.response?.error?.message ?? "The response failed."), { status: 500 }));
      else if (e?.type === "error") p.reject(stepError(e.status, e.error?.message, e.error?.code ?? undefined));
    });
    ws.on("close", () => {
      this.dead = true;
      this.pending?.reject(new TransportError("The socket closed mid-step."));
    });
    ws.on("error", () => {
      this.dead = true;
      this.pending?.reject(new TransportError("The socket failed."));
    });
  }

  /** Open a socket for a bot's task steps (counted for it as a task's: usage.ts usageTags). Throws a TransportError when it won't open. */
  static open(botId: string, timeoutMs = 15_000): Promise<ResponsesSocket> {
    const via = cloudProxy("openai");
    const key = via ? via.key : process.env.OPENAI_API_KEY;
    if (!key) return Promise.reject(new TransportError("No OpenAI key."));
    // Self-hosting: where the SDK would send it (OPENAI_BASE_URL, else OpenAI's).
    const url = `${(via ? `${via.url}/v1` : process.env.OPENAI_BASE_URL?.trim() || "https://api.openai.com/v1").replace(/\/+$/, "").replace(/^http/, "ws")}/responses`;
    // Through Bops Cloud, which app is calling (its version and state level: an older one is refused once a newer one wrote the user's state).
    const headers: Record<string, string> = {
      authorization: `Bearer ${key}`,
      ...(usageTags("session", botId).headers ?? {}),
      ...(via ? appHeaders() : {}),
    };
    return new Promise((resolve, reject) => {
      const ws = new WebSocket(url, { headers, handshakeTimeout: timeoutMs, maxPayload: 64 * 1024 * 1024 });
      ws.once("open", () => resolve(new ResponsesSocket(ws)));
      ws.once("unexpected-response", (req, res) => {
        req.destroy();
        reject(new TransportError(`The socket was refused (${res.statusCode}).`));
      });
      ws.once("error", (e) => reject(new TransportError(e.message)));
    });
  }

  get open() {
    return !this.dead && this.ws.readyState === WebSocket.OPEN;
  }

  /** One step: the body a POST /v1/responses would have. Resolves with the finished response. */
  create(body: Record<string, unknown>, opts: { signal?: AbortSignal; timeoutMs: number }): Promise<unknown> {
    if (!this.open) return Promise.reject(new TransportError("The socket isn't open."));
    if (this.pending) return Promise.reject(new Error("One step at a time."));
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => finish(() => reject(new APIConnectionTimeoutError())), opts.timeoutMs);
      const onAbort = () => finish(() => reject(new Error("Stopped")));
      const finish = (then: () => void) => {
        clearTimeout(timer);
        opts.signal?.removeEventListener("abort", onAbort);
        this.pending = null;
        then();
      };
      if (opts.signal?.aborted) return reject(new Error("Stopped"));
      opts.signal?.addEventListener("abort", onAbort, { once: true });
      this.pending = { resolve: (r) => finish(() => resolve(r)), reject: (e) => finish(() => reject(e)), done: () => finish(() => {}) };
      try {
        this.ws.send(JSON.stringify({ type: "response.create", ...body }));
      } catch (e) {
        this.pending.reject(new TransportError((e as Error).message));
      }
    });
  }

  close() {
    this.dead = true;
    try {
      this.ws.close(1000);
    } catch {
      this.ws.terminate();
    }
  }
}

/** A refused step as the SDK's errors look: Bops Cloud's credit refusals as CloudError (with its code), the rest with their status. */
function stepError(status: number | undefined, message = "OpenAI refused the step.", code?: string): Error {
  const s = Number(status) || (code && /rate_limit/.test(code) ? 429 : 400);
  if (s === 402 || s === 403) return new CloudError(message, s, code);
  return Object.assign(new Error(message), { status: s, code });
}
