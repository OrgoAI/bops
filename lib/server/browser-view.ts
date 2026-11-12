import "server-only";
import WebSocket from "ws";
import { BOPS_DEVICE_HEADER, BROWSER_INPUT_HEADER, BROWSER_INPUT_PATH, isBrowserMethod, type BrowserAct, type BrowserInputAct, type BrowserInputReply } from "@/cloud/protocol";
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
 *
 * Inputs go to Bops Cloud on one socket per bot and workspace (WS /v1/browser/input), in order, each answered as soon as
 * it's on its way rather than after a round trip to Bops Cloud and a database read there. A Bops Cloud from before that
 * socket (its upgrade a plain 404) gets every act by POST, as before, for ten minutes (timing.noSocketMs); then it's asked
 * again, as it may have been updated since. The socket is pinged: one a network change left dead without a close goes,
 * and the next act opens another.
 */

type Who = { id: string; url: string; headers: Record<string, string>; project: string | null };

/** Where to ask, as whom: null when this Bops isn't signed in on Bops Cloud. `id`: the person and key it's asked as. */
function asWhom(): Who | null {
  const user = stateUser();
  const key = orgoKey();
  if (!cloudOn() || !user || !key) return null;
  return { id: `${user}\n${key}`, url: cloudUrl(), headers: { Authorization: `Bearer ${key}`, [BOPS_DEVICE_HEADER]: deviceIdFor(user), ...appHeaders() }, project: sharedProjectId() };
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
  const res = await fetch(`${who.url}/v1/browser/watch?${q}`, { headers: { ...who.headers, accept: "text/event-stream" }, cache: "no-store", signal }).catch(() => null);
  if (!res) return refused("Couldn't reach Bops Cloud. Check your internet connection.", "unreachable", true);
  if (!res.ok || !res.body) {
    const body = (await res.json().catch(() => ({}))) as { error?: string; code?: string };
    if (res.status === 404) return refused("This bot isn't shared with you.", "not_shared");
    return refused(body.error || `Bops Cloud answered ${res.status}.`, body.code ?? `http_${res.status}`, res.status >= 500);
  }
  return new Response(res.body, { headers: SSE });
}

type Answer = { status: number; body: unknown };
const SENT: Answer = { status: 202, body: { ok: true } };

/** POST: take control, hand it back, or one input, as Bops Cloud answers it. `project`: as watchBrowser's. */
export async function actBrowser(act: Omit<BrowserAct, "project">, project: string): Promise<Answer> {
  const who = asWhom();
  if (!who) return { status: 409, body: { error: "Sign in with Orgo first." } };
  if (!sameWorkspace(who, project)) return { status: 409, body: { error: MOVED, code: "workspace_changed" } };
  // Take, hand back and a method outside BROWSER_METHODS go by POST: their refusals come back in Bops Cloud's words.
  return act.act === "input" && isBrowserMethod(act.method) && !(Date.now() < (noSocketUntil.get(who.url) ?? 0)) ? viaSocket(who, act) : post(who, act);
}

/** One act by POST /v1/browser/act, as Bops Cloud answers it. */
async function post(who: Who, act: Omit<BrowserAct, "project">): Promise<Answer> {
  const res = await fetch(`${who.url}/v1/browser/act`, {
    method: "POST",
    headers: { ...who.headers, "content-type": "application/json" },
    body: JSON.stringify({ ...act, ...(who.project ? { project: who.project } : {}) }),
    cache: "no-store",
    signal: AbortSignal.timeout(10_000),
  }).catch(() => null);
  if (!res) return { status: 502, body: { error: "Couldn't reach Bops Cloud." } };
  return { status: res.status, body: await res.json().catch(() => ({})) };
}

/* ---------------- One socket per bot ---------------- */

/**
 * `idleMs`: a socket with no act for this long closes; the next act opens another. `pingMs`: how often an open one is
 * pinged; one that hasn't answered by the next ping is gone (a network change can leave it so, taking acts into nothing
 * without a close), and the next act opens another. `noSocketMs`: how long a Bops Cloud from before the socket gets acts
 * by POST before it's asked again.
 */
const timing = { idleMs: 60_000, pingMs: 5_000, noSocketMs: 10 * 60_000 };
/** The most one act may be on the socket (Bops Cloud's limit); a bigger one goes by POST, which refuses it in words. */
const MAX_ACT = 64 * 1024;

type Waiting = { who: Who; act: Omit<BrowserAct, "project">; done: (a: Answer) => void };
/**
 * `waiting`: acts that came while it opens, sent in order once it has. `said`: an act Bops Cloud said didn't go (its
 * computer isn't connected): the next goes by POST, so the window hears it in Bops Cloud's words.
 */
type Pipe = { ws: WebSocket; who: Who; waiting: Waiting[]; said: boolean; idle?: ReturnType<typeof setTimeout>; beat?: ReturnType<typeof setInterval> };

/** By "<person and key>\n<Bops Cloud>\n<workspace>\n<bot>". */
const pipes = new Map<string, Pipe>();
/** By Bops Cloud's address: one with no input socket (a plain 404) gets every act by POST until then. */
const noSocketUntil = new Map<string, number>();

function viaSocket(who: Who, act: Omit<BrowserAct, "project">): Promise<Answer> {
  const msg = JSON.stringify({ act: act.act, method: act.method, params: act.params } satisfies BrowserInputAct);
  if (Buffer.byteLength(msg) > MAX_ACT) return post(who, act);
  const id = `${who.id}\n${who.url}\n${who.project ?? ""}\n${act.bot}`;
  let p = pipes.get(id);
  if (p && p.ws.readyState > WebSocket.OPEN) {
    gone(id, p);
    p = undefined;
  }
  if (p?.said) {
    p.said = false;
    return post(who, act);
  }
  const pipe = p ?? openPipe(id, who, act.bot);
  rest(id, pipe);
  return new Promise((done) => {
    if (pipe.ws.readyState === WebSocket.OPEN) send(pipe, { who, act, done }, msg);
    else pipe.waiting.push({ who, act, done });
  });
}

/** On its way: answered once the socket took it; a socket that failed sends it by POST instead. */
function send(p: Pipe, w: Waiting, msg = JSON.stringify({ act: w.act.act, method: w.act.method, params: w.act.params })) {
  p.ws.send(msg, (e) => (e ? void post(w.who, w.act).then(w.done) : w.done(SENT)));
}

function openPipe(id: string, who: Who, bot: string): Pipe {
  const q = new URLSearchParams({ bot, ...(who.project ? { project: who.project } : {}) });
  const ws = new WebSocket(`${who.url.replace(/^http/, "ws")}${BROWSER_INPUT_PATH}?${q}`, { headers: who.headers, handshakeTimeout: 10_000, perMessageDeflate: false, maxPayload: MAX_ACT });
  const p: Pipe = { ws, who, waiting: [], said: false };
  pipes.set(id, p);
  ws.once("open", () => {
    for (const w of p.waiting.splice(0)) send(p, w);
    // No answer since the last ping: gone, though nothing said so.
    let heard = true;
    ws.on("pong", () => (heard = true));
    p.beat = setInterval(() => {
      if (!heard) return gone(id, p);
      heard = false;
      ws.ping();
    }, timing.pingMs);
    p.beat.unref?.();
  });
  ws.once("unexpected-response", (req, res) => {
    // A Bops Cloud from before this socket: by POST for a while. Any other refusal: these by POST, which say why in words.
    if (res.statusCode === 404 && !res.headers[BROWSER_INPUT_HEADER]) noSocketUntil.set(who.url, Date.now() + timing.noSocketMs);
    req.destroy();
    gone(id, p);
  });
  ws.on("message", (data, binary) => {
    if (binary) return;
    try {
      if ((JSON.parse(String(data)) as BrowserInputReply).t === "error") p.said = true;
    } catch {}
  });
  ws.on("error", () => gone(id, p));
  ws.on("close", () => gone(id, p));
  return p;
}

/** Closed after timing.idleMs without an act. */
function rest(id: string, p: Pipe) {
  if (p.idle) clearTimeout(p.idle);
  p.idle = setTimeout(() => {
    p.ws.close(1000);
    gone(id, p);
  }, timing.idleMs);
  p.idle.unref?.();
}

/** The socket is gone (or going): forgotten, and acts still waiting for it go by POST, in order. */
function gone(id: string, p: Pipe) {
  if (pipes.get(id) === p) pipes.delete(id);
  if (p.idle) clearTimeout(p.idle);
  if (p.beat) clearInterval(p.beat);
  const waiting = p.waiting.splice(0);
  if (p.ws.readyState < WebSocket.CLOSING) p.ws.terminate();
  void waiting.reduce((chain, w) => chain.then(() => post(w.who, w.act).then(w.done)), Promise.resolve());
}

/** Tests: how long a socket rests, how often it's pinged, and how long an older Bops Cloud gets acts by POST. */
export const browserViewForTests = { timing };
