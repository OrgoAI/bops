import "server-only";
import { BOPS_DEVICE_HEADER, type BrowserAct } from "@/cloud/protocol";
import { appHeaders } from "./app-version";
import { cloudOn, cloudUrl } from "./cloud";
import { orgoKey } from "./orgo-auth";
import { deviceIdFor } from "./persist-cloud";
import { sharedProjectId } from "./shared";
import { stateUser } from "./store";

/**
 * The bot's browser for this Bops's window (components/app/bot-browser.tsx, through app/api/browser): Bops Cloud's
 * stream of it (cloud/browser.ts), asked for on the signed-in user's own key, for a bot of the workspace open now: the
 * user's own, or the one shared with them (by its Orgo id). Bops Cloud decides who may; this only passes it on. Nothing
 * of it is kept: frames go straight through to the window.
 */

/** Where to ask, as whom: null when this Bops isn't signed in on Bops Cloud. */
function asWhom(): { headers: Record<string, string>; project: string | null } | null {
  const user = stateUser();
  const key = orgoKey();
  if (!cloudOn() || !user || !key) return null;
  return { headers: { Authorization: `Bearer ${key}`, [BOPS_DEVICE_HEADER]: deviceIdFor(user), ...appHeaders() }, project: sharedProjectId() };
}

const SSE = { "content-type": "text/event-stream", "cache-control": "no-store", "x-accel-buffering": "no" };

/**
 * A stream of one event, "refused", saying why the window can't show it (and `retry`: whether it may come by itself,
 * so the window asks again): what Bops Cloud said, in its words.
 */
const refused = (why: string, code?: string, retry = false) =>
  new Response(`retry: 5000\nevent: refused\ndata: ${JSON.stringify({ t: "refused", why, ...(code ? { code } : {}), ...(retry ? { retry } : {}) })}\n\n`, { headers: SSE });

/**
 * Whether the window asked about the workspace open here now (`project`: the shared one's Orgo id it shows, "" for the
 * user's own): a window still showing the last one never watches or acts in the next by a bot of the same id.
 */
const sameWorkspace = (who: { project: string | null }, project: string) => (who.project ?? "") === project;
const MOVED = "The workspace changed. Open the bot's browser again.";

/**
 * GET: the bot's browser as server-sent events (cloud/protocol.ts BrowserEvent), for as long as the window listens.
 * `quiet`: only what the bot is doing with it, which doesn't count as watching (a Watch chip's).
 */
export async function watchBrowser(bot: string, project: string, signal: AbortSignal, quiet = false): Promise<Response> {
  const who = asWhom();
  if (!who) return refused("Sign in with Orgo to see the bot's browser.", "signed_out");
  if (!sameWorkspace(who, project)) return refused(MOVED, "workspace_changed");
  const q = new URLSearchParams({ bot, ...(who.project ? { project: who.project } : {}), ...(quiet ? { only: "activity" } : {}) });
  const res = await fetch(`${cloudUrl()}/v1/browser/watch?${q}`, { headers: { ...who.headers, accept: "text/event-stream" }, cache: "no-store", signal }).catch(() => null);
  if (!res) return refused("Couldn't reach Bops Cloud. Check your internet connection.", "unreachable", true);
  if (!res.ok || !res.body) {
    const body = (await res.json().catch(() => ({}))) as { error?: string; code?: string };
    if (res.status === 404) return refused("This bot isn't shared with you.", "not_shared");
    return refused(body.error || `Bops Cloud answered ${res.status}.`, body.code ?? `http_${res.status}`, res.status >= 500);
  }
  return new Response(res.body, { headers: SSE });
}

/** POST: take control, hand it back, or one input, as Bops Cloud answers it. `project`: as watchBrowser's. */
export async function actBrowser(act: Omit<BrowserAct, "project">, project: string): Promise<{ status: number; body: unknown }> {
  const who = asWhom();
  if (!who) return { status: 409, body: { error: "Sign in with Orgo first." } };
  if (!sameWorkspace(who, project)) return { status: 409, body: { error: MOVED, code: "workspace_changed" } };
  const res = await fetch(`${cloudUrl()}/v1/browser/act`, {
    method: "POST",
    headers: { ...who.headers, "content-type": "application/json" },
    body: JSON.stringify({ ...act, ...(who.project ? { project: who.project } : {}) }),
    cache: "no-store",
    signal: AbortSignal.timeout(10_000),
  }).catch(() => null);
  if (!res) return { status: 502, body: { error: "Couldn't reach Bops Cloud." } };
  return { status: res.status, body: await res.json().catch(() => ({})) };
}
