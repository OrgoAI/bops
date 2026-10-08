import "server-only";
import { APIError } from "openai";
import { AI_CREDIT_EMPTY, AI_CREDIT_LOW, type CloudSession } from "@/cloud/protocol";
import { cloudUrl } from "./cloud-url";
import { appHeaders } from "./app-version";
import { loadOrgoKey, orgoKey } from "./orgo-auth";
import { onPostgres } from "./persist";
import { getState, update } from "./store";

/**
 * Bops Cloud (cloud/README.md): the server Orgo runs so that Orgo's provider keys never sit on a
 * user's Mac. Signed in with Orgo, the app calls OpenAI, AgentPhone, Honcho, Composio, Typesafe and
 * texted codes through the cloud on the user's Orgo key (cloudProxy), and AgentMail directly with a
 * key that reaches only the user's own pod (the session). While it runs, it keeps a tunnel open for
 * webhooks (cloud-tunnel.ts). The app's state itself lives there too (persist-cloud.ts).
 *
 * Self-hosting (BOPS_SELF_HOSTED=1, keys in .env.local) and a hosted server (BOPS_DATABASE_URL,
 * which holds its own keys) call every service directly, as before. BOPS_CLOUD_URL points the app
 * at another cloud (staging, or one running on this Mac).
 */

export { cloudUrl };

/** Whether services go through Bops Cloud: signed in with Orgo, in the app on a Mac, and not self-hosting. */
export const cloudOn = () => !!orgoKey() && process.env.BOPS_SELF_HOSTED !== "1" && !onPostgres();

/**
 * A call to Bops Cloud that didn't work, in words the app can show. `status` is the cloud's HTTP status
 * (0 when it didn't answer), `code` its code for it when it gave one (AI_CREDIT_EMPTY).
 */
export class CloudError extends Error {
  status: number;
  code?: string;
  constructor(message: string, status = 0, code?: string) {
    super(message);
    this.status = status;
    this.code = code;
  }
}

/** A request to Bops Cloud as the signed-in user (their Orgo key as Bearer). `fetchImpl` lets a test check the wire shape. */
export async function cloudFetch(path: string, init: RequestInit = {}, fetchImpl: typeof fetch = fetch): Promise<Response> {
  const key = orgoKey();
  if (!key) throw new CloudError("Sign in with Orgo first.");
  const headers = new Headers(init.headers);
  headers.set("Authorization", `Bearer ${key}`);
  for (const [k, v] of Object.entries(appHeaders())) headers.set(k, v);
  try {
    return await fetchImpl(`${cloudUrl()}${path}`, { cache: "no-store", signal: AbortSignal.timeout(20_000), ...init, headers });
  } catch {
    throw new CloudError("Couldn't reach Bops Cloud. Check your internet connection.");
  }
}

/** What a failed answer means, for the user. Out of AI credit (402), the cloud's own words. */
function problem(status: number, said?: string) {
  if (status === 401) return "Bops Cloud didn't accept your Orgo sign-in. Sign out and sign in again.";
  if (status >= 500) return `Bops Cloud isn't working right now (${status}). Try again in a minute.`;
  return said || `Bops Cloud turned the request down (${status}).`;
}

/** A JSON call to Bops Cloud: its answer, or a CloudError that says what went wrong. */
export async function cloudJson<T>(path: string, init: RequestInit = {}): Promise<T> {
  const res = await cloudFetch(path, init);
  const body = (await res.json().catch(() => null)) as (T & { error?: unknown; code?: unknown }) | null;
  if (!res.ok) throw new CloudError(problem(res.status, typeof body?.error === "string" ? body.error : undefined), res.status, typeof body?.code === "string" ? body.code : undefined);
  if (body === null || typeof body !== "object") throw new CloudError("Bops Cloud sent back something Bops couldn't read.", res.status);
  return body;
}

type Box = {
  /** The session, with the key it was made for: another sign-in makes another. */
  session?: { key: string; value: CloudSession };
  /** The request out for it, shared by everyone asking at once. */
  asking?: { key: string; answer: Promise<CloudSession> };
  /** The last one that failed, kept briefly so a cloud that's down isn't asked on every call. */
  failed?: { key: string; at: number; error: CloudError };
};
const g = globalThis as unknown as { bopsCloud?: Box };
const box: Box = (g.bopsCloud ??= {});
const RETRY_MS = 10_000;

/**
 * This user's Bops Cloud session (POST /v1/session; CloudSession in cloud/protocol.ts): which
 * services the cloud runs for them, and their own ids and keys in each. Asked once per signed-in
 * key and kept; `fresh` asks again (a sign-in does).
 */
export function cloudSession(fresh = false): Promise<CloudSession> {
  const key = orgoKey();
  if (!key) return Promise.reject(new CloudError("Sign in with Orgo first."));
  if (!fresh && box.session?.key === key) return Promise.resolve(box.session.value);
  if (box.asking?.key === key) return box.asking.answer;
  if (!fresh && box.failed?.key === key && Date.now() - box.failed.at < RETRY_MS) return Promise.reject(box.failed.error);
  const answer: Promise<CloudSession> = cloudJson<CloudSession>("/v1/session", { method: "POST" }).then(
    (value) => {
      if (typeof value.userId !== "string") throw new CloudError("Bops Cloud sent back something Bops couldn't read.");
      // A sign-out or another sign-in while it was out has the last word.
      if (box.asking?.answer === answer) box.session = { key, value };
      return value;
    },
  );
  box.asking = { key, answer };
  answer.then(
    () => {
      if (box.asking?.answer === answer) box.asking = box.failed = undefined;
    },
    (e: unknown) => {
      if (box.asking?.answer !== answer) return;
      box.asking = undefined;
      box.failed = { key, at: Date.now(), error: e instanceof CloudError ? e : new CloudError((e as Error).message) };
    },
  );
  return answer;
}

/**
 * The session when it's here already, for the checks that can't wait ("is email on?"): null before
 * its first answer (it's asked for then), when signed out, or when the app isn't using the cloud.
 */
export function cloudSessionNow(): CloudSession | null {
  const key = cloudOn() ? orgoKey() : null;
  if (!key) return null;
  if (box.session?.key === key) return box.session.value;
  void cloudSession().catch(() => {});
  return null;
}

/** Forget the session (a sign-out). */
export function forgetCloudSession() {
  box.session = box.asking = box.failed = undefined;
}

/** Where a provider is reached through Bops Cloud and the key to reach it with (the user's Orgo key), or null when the app calls it directly. */
export function cloudProxy(provider: "openai" | "agentphone" | "honcho" | "composio" | "typesafe" | "treg") {
  const key = cloudOn() ? orgoKey() : null;
  return key ? { url: `${cloudUrl()}/proxy/${provider}`, key } : null;
}

/**
 * The OpenAI key copied onto bot computers (and given to Codex on this Mac) for `codex exec-server`:
 * Bops Cloud's restricted, spend-capped one, or OPENAI_EXECUTOR_API_KEY.
 */
export async function executorKey(): Promise<string> {
  if (!cloudOn()) return process.env.OPENAI_EXECUTOR_API_KEY ?? "";
  const key = (await cloudSession()).openai?.executorKey;
  if (!key) throw new CloudError("Bops Cloud can't run tasks on computers right now.");
  return key;
}

/* ---------------- AI credit ---------------- */

/**
 * Whether an error is Bops Cloud saying the user's AI credit is used up (402, AI_CREDIT_EMPTY): a
 * CloudError (AgentPhone's through /proxy/agentphone too, lib/server/phone.ts), or an OpenAI SDK error
 * from /proxy/openai, which keeps only the cloud's words, not its code: OpenAI itself never answers 402.
 */
export function outOfCredits(e: unknown): boolean {
  if (e instanceof CloudError) return e.status === 402 && (!e.code || e.code === AI_CREDIT_EMPTY);
  return e instanceof APIError && e.status === 402 && cloudOn();
}

/**
 * Bops Cloud's words when a task can't start or go on for want of more AI credit, while some is left
 * (AI_CREDIT_LOW: a 403 from /proxy/openai through the OpenAI SDK, or a turn the cloud stopped), or
 * undefined for any other error. Unlike AI_CREDIT_EMPTY, the credit isn't counted as used up.
 */
export function shortOfCredit(e: unknown): string | undefined {
  if (e instanceof CloudError) return e.code === AI_CREDIT_LOW ? e.message : undefined;
  if (!(e instanceof APIError) || e.status !== 403 || e.code !== AI_CREDIT_LOW) return undefined;
  const message = (e.error as { message?: unknown } | undefined)?.message;
  return typeof message === "string" && message ? message : e.message;
}

/** What a bot says, once, in place of the error, when the credit ran out under it. */
export const OUT_OF_CREDIT = "I'm out of AI credit, so I've stopped. Upgrade in Settings to keep me going.";

/**
 * Mark the AI credit used up when `e` says so (state.credits: the chat shows it with Upgrade, and the
 * bots stop asking the cloud for AI work). True when it did.
 */
export function noteOutOfCredit(e: unknown): boolean {
  if (!outOfCredits(e)) return false;
  if (!getState().credits?.out) update((s) => (s.credits = { out: true, at: Date.now() }));
  return true;
}

/** What a bot's work fails with when it doesn't start for want of AI credit (creditsOut). */
export const outOfCreditError = () => new CloudError(OUT_OF_CREDIT, 402, AI_CREDIT_EMPTY);

/** How long "out of AI credit" stands before Orgo is asked again (a month renewed, a plan paid for elsewhere). */
const CREDIT_RECHECK_MS = 5 * 60_000;

/**
 * Whether the AI credit is used up, so a bot shouldn't ask the cloud for AI work now. After a few
 * minutes Orgo is asked again (lib/server/plan.ts readBopsPlan clears it when there's credit).
 */
export async function creditsOut(): Promise<boolean> {
  const c = getState().credits;
  if (!c?.out || !cloudOn()) return false;
  if (Date.now() - c.at < CREDIT_RECHECK_MS) return true;
  const key = await loadOrgoKey();
  const { readBopsPlan } = await import("./plan");
  const plan = key ? await readBopsPlan(key).catch(() => null) : null;
  // Still out, or Orgo didn't say: asked again in a few minutes.
  if (getState().credits?.out) update((s) => (s.credits = { out: true, at: Date.now() }));
  return !plan?.credit || plan.credit.leftMicros <= 0;
}
