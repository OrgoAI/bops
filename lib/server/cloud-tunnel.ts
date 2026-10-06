import "server-only";
import { randomBytes, timingSafeEqual } from "node:crypto";
import WebSocket from "ws";
import { CLOUD_TUNNEL_HEADER, type CloudToMac, type MacToCloud } from "@/cloud/protocol";
import { cloudOn, cloudSession, cloudUrl, forgetCloudSession } from "./cloud";
import { checkBackup, flushBackup } from "./cloud-state";
import { orgoKey } from "./orgo-auth";
import { onExit } from "./persist";

/**
 * The tunnel to Bops Cloud (cloud/README.md, "The tunnel"): while the app works through the cloud
 * (cloudOn in cloud.ts), one WebSocket to <cloud>/v1/connect on the user's Orgo key. Webhooks for
 * the user's numbers and Bops' Slack app's events for the user's bots come down it as requests,
 * which are replayed against this server (only those webhook routes: anything else is turned down
 * here). What waited while the Mac was away comes down as events, handed to /api/cloud/event one at
 * a time and acknowledged once handled. Dropped, the tunnel comes back after 1 second, then 2, 4… up
 * to a minute; a sign-in starts it over on the new key; a sign-out or the server stopping closes it.
 * When a newer connection of the same user's takes over (another Mac, or another Bops on this one),
 * the cloud closes this one as replaced: it stays closed until the next sign-in or start, so two
 * Macs don't keep taking it from each other.
 *
 * A replayed request carries CLOUD_TUNNEL_HEADER with a token made at random when this server
 * started and kept only in its memory: the webhook routes take it as proof that the cloud checked
 * the provider's signature. It's only ever sent to this server itself (no redirects followed), and
 * a frame's own copy of the header is dropped first.
 */

const MAX_WAIT_MS = 60_000;

type Req = Extract<CloudToMac, { t: "req" }>;
type Event = Extract<CloudToMac, { t: "event" }>;
type Tunnel = {
  token: string;
  socket?: WebSocket;
  /** Whether it should be open: a close then brings it back. */
  want: boolean;
  /** A newer connection of the same user's took over: closed until the next sign-in or start. */
  replaced?: boolean;
  failures: number;
  openedAt?: number;
  retry?: ReturnType<typeof setTimeout>;
  /** Events are handled one at a time, in the order they came. */
  events: Promise<void>;
  /** The latest code for a frame (an open socket outlives a code reload in development). */
  onFrame?: (socket: WebSocket, frame: CloudToMac) => void;
};
const g = globalThis as unknown as { bopsCloudTunnel?: Tunnel };
const tunnel: Tunnel = (g.bopsCloudTunnel ??= { token: randomBytes(32).toString("base64url"), want: false, failures: 0, events: Promise.resolve() });

/** Whether a request was replayed by this server's own tunnel: it carries the token only this server knows. */
export function fromCloudTunnel(request: Request) {
  const got = Buffer.from(request.headers.get(CLOUD_TUNNEL_HEADER) ?? "");
  const want = Buffer.from(tunnel.token);
  return got.length === want.length && timingSafeEqual(got, want);
}

/** What the cloud may reach on this server: the webhooks it takes for the user (cloud/README.md, "Webhooks" and "Slack"). */
const REPLAYABLE = new Set(["/api/phone/agentphone", "/api/phone/openai", "/api/channels/slack/events"]);
/** Headers about one connection rather than the request, the length (it follows the body) and any copy of the token's header: never passed on. */
const DROP = new Set(["connection", "keep-alive", "proxy-authenticate", "proxy-authorization", "proxy-connection", "te", "trailer", "transfer-encoding", "upgrade", "host", "content-length", CLOUD_TUNNEL_HEADER]);

/** This server, as the tunnel reaches it. */
const self = () => `http://127.0.0.1:${process.env.PORT || 3210}`;

const send = (socket: WebSocket, frame: MacToCloud) => {
  if (socket.readyState === WebSocket.OPEN) socket.send(JSON.stringify(frame));
};

/** A webhook the cloud took for this user, replayed against this server with the token, and its answer. */
async function replay(req: Req): Promise<MacToCloud> {
  const refuse = (status: number, error: string): MacToCloud => ({
    t: "res",
    id: req.id,
    status,
    headers: { "content-type": "application/json" },
    body: Buffer.from(JSON.stringify({ error })).toString("base64"),
  });
  const origin = self();
  const path = typeof req.path === "string" ? req.path : "";
  let url: URL | null = null;
  try {
    if (path.startsWith("/")) url = new URL(`${origin}${path}`);
  } catch {
    /* refused below */
  }
  // Only this server, and only the webhooks: no path can send the token anywhere else.
  if (!url || url.origin !== origin || !REPLAYABLE.has(url.pathname)) return refuse(403, "not allowed");
  const headers = new Headers();
  for (const [name, value] of Object.entries(req.headers ?? {}))
    if (!DROP.has(name.toLowerCase()))
      try {
        headers.append(name, String(value));
      } catch {
        /* not a header a request can carry */
      }
  headers.set(CLOUD_TUNNEL_HEADER, tunnel.token);
  const method = String(req.method || "POST").toUpperCase();
  try {
    const res = await fetch(url, {
      method,
      headers,
      body: method === "GET" || method === "HEAD" ? undefined : new Uint8Array(Buffer.from(req.body ?? "", "base64")),
      redirect: "manual",
      cache: "no-store",
      signal: AbortSignal.timeout(60_000),
    });
    const body = Buffer.from(await res.arrayBuffer()).toString("base64");
    const answer: Record<string, string> = {};
    // (fetch has already undone any compression, so the encoding goes too.)
    res.headers.forEach((value, name) => {
      if (!DROP.has(name) && name !== "content-encoding") answer[name] = value;
    });
    return { t: "res", id: req.id, status: res.status, headers: answer, body };
  } catch (e) {
    return refuse(502, `this Mac's server didn't answer: ${(e as Error).message}`);
  }
}

/** Something that waited for this Mac, handed to /api/cloud/event; acknowledged only once handled, so one that wasn't comes again on the next connect. */
async function deliver(socket: WebSocket, event: Event) {
  const res = await fetch(`${self()}/api/cloud/event`, {
    method: "POST",
    headers: { "Content-Type": "application/json", [CLOUD_TUNNEL_HEADER]: tunnel.token },
    body: JSON.stringify({ id: event.id, kind: event.kind, payload: event.payload, at: event.at }),
    redirect: "manual",
    cache: "no-store",
    signal: AbortSignal.timeout(60_000),
  }).catch((e: Error) => (console.warn(`[cloud] event ${event.id}: ${e.message}`), null));
  if (res?.ok) send(socket, { t: "ack", id: event.id });
  else if (res) console.warn(`[cloud] event ${event.id} (${event.kind}) wasn't handled: ${res.status}`);
}

tunnel.onFrame = (socket, frame) => {
  if (frame.t === "ping") send(socket, { t: "pong" });
  else if (frame.t === "req") void replay(frame).then((res) => send(socket, res));
  else if (frame.t === "event") tunnel.events = tunnel.events.then(() => deliver(socket, frame)).catch(() => {});
};

/** Try again after 1 second, then 2, 4… up to a minute; a connection that held a while starts that over. */
function retryLater() {
  if (tunnel.openedAt && Date.now() - tunnel.openedAt > MAX_WAIT_MS) tunnel.failures = 0;
  tunnel.openedAt = undefined;
  tunnel.retry = setTimeout(connect, Math.min(MAX_WAIT_MS, 1000 * 2 ** tunnel.failures++));
  tunnel.retry.unref?.();
}

function connect() {
  tunnel.retry = undefined;
  const key = cloudOn() ? orgoKey() : null;
  if (!tunnel.want || !key) {
    tunnel.want = false;
    return;
  }
  let socket: WebSocket;
  try {
    socket = new WebSocket(`${cloudUrl().replace(/^http/, "ws")}/v1/connect`, { headers: { Authorization: `Bearer ${key}` }, handshakeTimeout: 15_000 });
  } catch (e) {
    console.warn(`[cloud] tunnel: ${(e as Error).message}`);
    return retryLater();
  }
  tunnel.socket = socket;
  let replaced = false;
  socket.on("open", () => {
    tunnel.openedAt = Date.now();
    // The cloud can be reached: the backup's check, if it's still to do.
    void checkBackup().catch((e: Error) => console.warn(`[cloud] ${e.message}`));
  });
  socket.on("message", (data) => {
    let frame: CloudToMac;
    try {
      frame = JSON.parse(data.toString());
    } catch {
      return;
    }
    if (frame?.t === "replaced") replaced = true;
    else if (frame) tunnel.onFrame?.(socket, frame);
  });
  socket.on("error", (e) => {
    if (tunnel.socket === socket) console.warn(`[cloud] tunnel: ${e.message}`);
  });
  socket.on("close", (code) => {
    if (tunnel.socket !== socket) return;
    tunnel.socket = undefined;
    if (!tunnel.want) return;
    if (replaced || code === 4000) {
      console.warn("[cloud] another Bops signed in as this user took over the tunnel: this one stays closed until the next sign-in or start");
      tunnel.want = false;
      tunnel.replaced = true;
      return;
    }
    retryLater();
  });
}

function closeSocket() {
  if (tunnel.retry) clearTimeout(tunnel.retry);
  tunnel.retry = undefined;
  const socket = tunnel.socket;
  tunnel.socket = undefined;
  tunnel.openedAt = undefined;
  if (socket?.readyState === WebSocket.OPEN) socket.close(1000);
  else socket?.terminate();
}

/** Open the tunnel on the signed-in key, closing one open on another. */
function openTunnel() {
  closeSocket();
  tunnel.want = true;
  tunnel.failures = 0;
  connect();
}

/** Close the tunnel until it's started again (a sign-out, or the server stopping). */
function closeTunnel() {
  tunnel.want = false;
  closeSocket();
}

/**
 * What the app runs on Bops Cloud while it works through it: the session, the tunnel, and the state
 * backup's check (lib/server/cloud-state.ts). Called when the server starts (instrumentation.ts) and
 * after a sign-in (`signedIn`: the session is asked afresh and the tunnel starts over on the new
 * key). Nothing happens signed out or self-hosting.
 */
export async function startCloud({ signedIn = false } = {}) {
  if (!cloudOn()) return;
  if (signedIn) tunnel.replaced = false;
  if (signedIn || (!tunnel.want && !tunnel.replaced)) openTunnel();
  try {
    await cloudSession(signedIn);
    await checkBackup();
  } catch (e) {
    console.warn(`[cloud] ${(e as Error).message}`);
  }
}

/** Bops Cloud running whenever it should be, even with a key the Keychain only gave later. The state route calls it on every poll, so it's cheap when it already is. */
export function ensureCloud() {
  if (cloudOn() && !tunnel.want && !tunnel.replaced) void startCloud();
}

const within = (p: Promise<unknown>, ms: number) => Promise.race([p, new Promise((r) => setTimeout(r, ms))]);

/** Before a sign-out, while the key is still here: the latest state goes up (for at most 10 seconds), the tunnel closes, and the session is forgotten. */
export async function stopCloud() {
  if (cloudOn()) await within(flushBackup().catch((e: Error) => console.warn(`[cloud] state backup: ${e.message}`)), 10_000);
  closeTunnel();
  forgetCloudSession();
}

// On the way out: the latest state goes up, and the cloud hears the tunnel close.
onExit("cloud", async () => {
  if (cloudOn()) await flushBackup().catch(() => {});
  closeTunnel();
});
