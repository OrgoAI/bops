import { STATUS_CODES, type IncomingMessage, type ServerResponse } from "node:http";
import type { Duplex } from "node:stream";
import { WebSocket, WebSocketServer, type RawData } from "ws";
import { bearer, userForKey, type CloudUser } from "./auth.ts";
import { HttpError, readJson, refuseUpgrade, sendJson, type Route, type Upgrade } from "./http.ts";
import { botsOn } from "./computer-scope.ts";
import { onStateWritten } from "./live.ts";
import { levelOf, permits, type MemberAccess } from "./member-access.ts";
import { ROLE_MS, trackMemberStream, viewerOf, watchable } from "./members.ts";
import {
  BROWSER_INPUT_HEADER,
  BROWSER_INPUT_PATH,
  BROWSER_NEEDS_COMPUTER,
  BROWSER_NEEDS_WRITE,
  BROWSER_SHARED_COMPUTER,
  isBrowserMethod,
  POINTER_KINDS,
  type BrowserAct,
  type BrowserActivity,
  type BrowserEvent,
  type BrowserInputAct,
  type BrowserInputReply,
  type BrowserPerson,
  type BrowserToRunner,
  type RunnerToBrowser,
} from "./protocol.ts";
import { loadState } from "./state.ts";
import { computerFor } from "./turns.ts";
import { computerUseOf, list, viewerAccess, wsOfBot } from "./ws-slice.ts";
import { probeInput, probeTiming } from "./browser-probe.ts";

/**
 * The bot's browser (protocol.ts "The bot's browser"): Bops Cloud between the runner on a bot's computer, which captures
 * its Chrome (lib/browser-relay.ts), and whoever watches it from their Bops (components/app/bot-browser.tsx). It relays
 * and keeps nothing: a frame goes straight on to the viewers it's for, or nowhere.
 *
 * - **The runner** opens WS /v1/browser/runner, signed in as its computer (auth.ts CloudUser.computer). One per computer;
 *   a new one replaces the last. It's told who watches each of its bots ("watch"), and what they ask.
 * - **A viewer** opens GET /v1/browser/watch?bot=<id>[&project=<Orgo workspace>] (server-sent events, BrowserEvent). Only
 *   the owner, or someone the owner gave Write on that bot AND Use its computer (mayUseBrowser: the check a member's chat
 *   turn on the computer goes by, turns.ts memberStill), and Write on every other bot that works on that computer (they
 *   share its screens), as orgo-web and the owner's state say it now; looked at again
 *   every ROLE_MS while it's open, at each write of the owner's state (a level, a bot hidden or moved to another computer:
 *   recheck), and ended at once by orgo-web's notice that their access changed (members.ts). With
 *   `&only=activity` it hears only what the bot is doing with its browser and whether its computer is there, and isn't
 *   watching: the runner captures nothing for it (a Watch chip's, components/app/bops-app.tsx).
 * - **What a bot is doing** with its browser (BrowserActivity), as its runner last said: kept in memory while that
 *   runner is connected, told to each viewer as it comes and to a new one at once.
 * - **Acting**: POST /v1/browser/act takes control, hands it back, or sends one CDP input, checked the same way each time.
 *   The runner holds who has control (one person at a time) and refuses any input but theirs, and any method outside
 *   BROWSER_METHODS.
 * - **Acting on one socket**: WS /v1/browser/input?bot=<id>[&project=<Orgo workspace>] (protocol.ts BROWSER_INPUT_PATH)
 *   carries one viewer's acts in order, each checked as a POST's is (actOf, sendAct), without asking the owner's state for
 *   each: who may is asked at the upgrade, every ROLE_MS while it's open and at each write of the owner's state, and
 *   orgo-web's notice ends it at once, as a watch stream. A pointer's moves go about 60 a second there, which a POST each
 *   (a database read each) couldn't carry. Pinged every KEEPALIVE_MS: one that hasn't answered by the next goes (a Mac
 *   that changed networks leaves it open with nobody there).
 */

const BOT_ID = /^[A-Za-z0-9_-]{1,80}$/;
const PROJECT_ID = /^[A-Za-z0-9-]{1,64}$/;
/** Frames are JPEGs of up to 1280 px a side, as base64. */
const MAX_FRAME = 8 * 1024 * 1024;
/** A viewer's stream says something at least this often, so a proxy never takes it for dead. */
const KEEPALIVE_MS = 15_000;
/** The most bots one runner message is for. */
const MAX_BOTS = 50;
/** The most one act may be, on the socket as in a POST's body. */
const MAX_ACT = 64 * 1024;
/** An input socket's end: they may no longer use the bot's browser, or its computer or account changed. */
const INPUT_REFUSED = 4403;
const INPUT_MOVED = 4409;

/** `quiet`: an activity-only stream (`?only=activity`): not watching, so never in `watching`, and only told activity and the computer. */
type Viewer = { person: BrowserPerson; desktop: string; res: ServerResponse; end: () => void; quiet: boolean };
type Runner = { ws: WebSocket; account: string; desktop: string };

/** By "<account>\n<computer id>". */
const runners = new Map<string, Runner>();
/** By "<account>\n<bot id>": who watches that bot's browser. */
const viewers = new Map<string, Set<Viewer>>();
/** By "<account>\n<bot id>": what the bot is doing with its browser, as the runner of that computer last said. */
const doing = new Map<string, { desktop: string; activity: BrowserActivity }>();
/** Each input socket open now, as its end. */
const inputs = new Set<() => void>();
/** By account: each watch stream and input socket open now, as its look at who may with the owner's state as just written. */
const rechecks = new Map<string, Set<(blob: Record<string, unknown>) => void>>();
const runnerKey = (account: string, desktop: string) => `${account}\n${desktop}`;
const botKey = (account: string, bot: string) => `${account}\n${bot}`;

let ownerState = async (account: string) => ((await loadState(account))?.state ?? {}) as Record<string, unknown>;
let every = ROLE_MS;
let pingEvery = KEEPALIVE_MS;

/** Every socket and stream ends (the cloud stopping): each runner and viewer reconnects to the next start. */
export function closeBrowser() {
  for (const set of viewers.values()) for (const v of [...set]) v.end();
  for (const end of [...inputs]) end();
  for (const r of runners.values()) r.ws.terminate();
  runners.clear();
  viewers.clear();
  doing.clear();
  rechecks.clear();
}

/** Tests: the owner's state as given, how often an open stream is checked again, and how often an input socket is pinged. */
export function resetBrowser(o: { state?: (account: string) => Promise<Record<string, unknown>>; every?: number; ping?: number } = {}) {
  ownerState = o.state ?? (async (account) => ((await loadState(account))?.state ?? {}) as Record<string, unknown>);
  every = o.every ?? ROLE_MS;
  pingEvery = o.ping ?? KEEPALIVE_MS;
  closeBrowser();
}

/**
 * The owner's state was just written (live.ts stateWritten): each watch stream and input socket of that account asks
 * again who may, from the blob as written (no database read; orgo-web's answer as kept). A Member set to Read or hidden
 * on the bot, or the bot moved to another computer or onto one with bots they don't have, stops at once rather than at
 * the next ROLE_MS look: orgo-web sends no notice for what lives only in the owner's state.
 */
function recheck(account: string, blob: Record<string, unknown>) {
  for (const f of [...(rechecks.get(account) ?? [])]) f(blob);
}
onStateWritten(recheck);

/** Keep `f` as one of `account`'s looks at each write of its state (recheck); gives back its undoing. */
function onWrite(account: string, f: (blob: Record<string, unknown>) => void): () => void {
  let set = rechecks.get(account);
  if (!set) rechecks.set(account, (set = new Set()));
  set.add(f);
  return () => {
    const s = rechecks.get(account);
    s?.delete(f);
    if (s && !s.size) rechecks.delete(account);
  };
}

/* ---------------- Who may ---------------- */

/** `owner`: the caller owns the bot (their own, or the workspace's owner), so their take goes over a member's control. */
export type BrowserAccess = { account: string; person: BrowserPerson; desktop: string; botName: string; owner: boolean };

/**
 * Whether `user` may watch (and take control of) `botId`'s browser: their own bot (no `projectId`), or one in the
 * workspace shared with them as orgo-web says it now, where the owner gave them Write on it and Use its computer, and
 * on every other bot that works on its computer: bots that share a computer share its screens (lib/server/browser-runner.ts
 * screenFor), so watching one shows, and taking over drives, whichever screen any of them holds. A bot hidden from them,
 * at Read, or of another workspace there (a main bot on the free computer) keeps it the owner's. 404 for a workspace or a
 * bot they don't see (never saying whether it exists), 403 with the words for what they lack, 409 when the bot has no computer.
 */
export async function mayUseBrowser(
  user: CloudUser,
  key: string,
  projectId: string | null,
  botId: string,
  opts: { fresh?: boolean; written?: { account: string; blob: Record<string, unknown> } } = {},
): Promise<BrowserAccess> {
  if (!BOT_ID.test(botId)) throw new HttpError(400, "bot must be a bot's id");
  const person: BrowserPerson = { id: user.id, name: (user.name || user.email || "Someone").slice(0, 80) };
  let account = user.id;
  let owner = true;
  let blob: Record<string, unknown>;
  // Someone other than the owner: their workspace and what they have of its bots, for the computer's other bots below.
  let theirs: { ws: string; access: MemberAccess } | null = null;
  // `written`: the owner's state just written (recheck), used only when it's this account's.
  const stateOf = async (of: string) => (opts.written?.account === of ? opts.written.blob : ownerState(of));
  if (projectId === null) blob = await stateOf(account);
  else {
    if (!PROJECT_ID.test(projectId)) throw new HttpError(400, "project must be an Orgo workspace id");
    const { access, target } = await watchable(user, key, projectId, opts);
    account = target.account;
    blob = await stateOf(account);
    const ws = list(blob.workspaces).find((w) => w.id === target.ws) ?? null;
    const bot = list(blob.bots).find((b) => b.id === botId);
    if (!ws || !bot || wsOfBot(bot) !== target.ws) throw new HttpError(404, "No such bot");
    if (access.role !== "owner") {
      owner = false;
      const viewer = viewerOf(user, access);
      theirs = { ws: target.ws, access: viewerAccess(ws, viewer) };
      const level = levelOf(theirs.access, botId);
      if (level === "none") throw new HttpError(404, "No such bot");
      const name = nameOf(blob, botId);
      if (!permits(level, "write")) throw new HttpError(403, `Watching ${name}'s browser takes Write on ${name}, and the owner gave you Read. They can change it in People.`, { code: BROWSER_NEEDS_WRITE });
      if (!computerUseOf(ws, viewer)) throw new HttpError(403, `Watching ${name}'s browser takes Use its computer, which the owner hasn't turned on for you. They can turn it on in People.`, { code: BROWSER_NEEDS_COMPUTER });
    }
  }
  if (!list(blob.bots).some((b) => b.id === botId)) throw new HttpError(404, "No such bot");
  const desktop = computerFor(blob, botId);
  if (!desktop) throw new HttpError(409, `${nameOf(blob, botId)} has no computer, so it has no browser to show.`, { code: "browser_no_computer" });
  const mine = theirs;
  if (mine && botsOn(blob, desktop).some((b) => wsOfBot(b) !== mine.ws || !permits(levelOf(mine.access, b.id as string), "write")))
    throw new HttpError(403, `${nameOf(blob, botId)} shares its computer with bots you don't have, so only the owner can watch its browser.`, { code: BROWSER_SHARED_COMPUTER });
  return { account, person, desktop, botName: nameOf(blob, botId), owner };
}

const nameOf = (blob: Record<string, unknown>, botId: string) => {
  const n = list(blob.bots).find((b) => b.id === botId)?.name;
  return typeof n === "string" && n.trim() ? n.trim().slice(0, 80) : "The bot";
};

/**
 * Asked again for a watch stream or input socket that's open: the key itself first, as each POST's is (userForKey, kept
 * as long: one Orgo turns down now, or someone else's, is a 401 within HIT_MS and ROLE_MS, though no notice comes for an
 * owner's own bot), then who may now (mayUseBrowser). Orgo or the database out of reach: a 5xx, which keeps it open.
 */
async function stillMay(user: CloudUser, key: string, projectId: string | null, botId: string): Promise<BrowserAccess> {
  const who = await userForKey(key);
  if (!who || who.id !== user.id) throw new HttpError(401, "Sign in with Orgo again to see the bot's browser.", { code: "signed_out" });
  return mayUseBrowser(user, key, projectId, botId, { fresh: true });
}

/* ---------------- Viewers ---------------- */

/** What a runner says its bot is doing with its browser, checked; null for anything else. A sign-in's page: http or https only. */
function activityOf(m: Record<string, unknown>): BrowserActivity | null {
  if (m.step !== "browsing" && m.step !== "idle") return null;
  const signIn = typeof m.signIn === "string" && m.signIn.length <= 4096 && /^https?:\/\//i.test(m.signIn) ? m.signIn : null;
  return { step: m.step, waiting: m.waiting === true, signIn };
}

/** Who a runner says drove something: a person as Bops Cloud vouched for them to it, else nobody (the bot). */
const personOf = (v: unknown): BrowserPerson | null =>
  v && typeof v === "object" && typeof (v as BrowserPerson).id === "string" && typeof (v as BrowserPerson).name === "string" ? { id: (v as BrowserPerson).id, name: (v as BrowserPerson).name.slice(0, 80) } : null;

const event = (res: ServerResponse, e: BrowserEvent) => res.write(`event: ${e.t}\ndata: ${JSON.stringify(e)}\n\n`);

/** Who watches a bot's browser now, each once. */
function watching(account: string, bot: string, desktop: string): BrowserPerson[] {
  const out = new Map<string, BrowserPerson>();
  for (const v of viewers.get(botKey(account, bot)) ?? []) if (v.desktop === desktop && !v.quiet) out.set(v.person.id, v.person);
  return [...out.values()];
}

/** Tell the bot's runner who watches it now; `joined`: a stream just opened (its runner catches it up). */
function sayWatching(account: string, bot: string, desktop: string, joined = false) {
  sendRunner(runners.get(runnerKey(account, desktop)), { t: "watch", bot, viewers: watching(account, bot, desktop), ...(joined ? { joined: true as const } : {}) });
}

function sendRunner(r: Runner | undefined, m: BrowserToRunner) {
  if (r && r.ws.readyState === WebSocket.OPEN) r.ws.send(JSON.stringify(m));
}

const watchRoute: Route = {
  method: "GET",
  path: "/v1/browser/watch",
  auth: "user",
  handle: async (req, res, { user, url }) => {
    const bot = url.searchParams.get("bot") ?? "";
    const project = url.searchParams.get("project");
    const quiet = url.searchParams.get("only") === "activity";
    const key = bearer(req);
    const a = await mayUseBrowser(user!, key, project, bot);
    // Gone while that was asked (its close already fired): never a viewer, or it would keep the capture going.
    if (res.destroyed || req.socket.destroyed) return;
    res.writeHead(200, { "content-type": "text/event-stream", "cache-control": "no-store", "x-accel-buffering": "no" });
    res.write(": watching\n\n");
    const k = botKey(a.account, bot);
    let set = viewers.get(k);
    if (!set) viewers.set(k, (set = new Set()));
    let over = false;
    const v: Viewer = {
      person: a.person,
      desktop: a.desktop,
      quiet,
      res,
      end: () => {
        if (over) return;
        over = true;
        clearInterval(beat);
        clearInterval(look);
        untrack();
        unwrite();
        const s = viewers.get(k);
        s?.delete(v);
        if (s && !s.size) viewers.delete(k);
        if (!quiet) sayWatching(a.account, bot, a.desktop);
        if (!res.writableEnded) res.end();
      },
    };
    set.add(v);
    event(res, { t: "computer", connected: runners.has(runnerKey(a.account, a.desktop)) });
    const now = doing.get(k);
    if (now?.desktop === a.desktop) event(res, { t: "activity", ...now.activity });
    if (!quiet) sayWatching(a.account, bot, a.desktop, true);
    const beat = setInterval(() => res.write(": still\n\n"), KEEPALIVE_MS);
    beat.unref?.();
    // Asked afresh while it's open: a key turned down, someone out of the workspace, or without Write or Use its computer
    // now, stops watching.
    const judge = (asked: Promise<BrowserAccess>) =>
      void asked
        .then((now) => {
          if (now.account !== a.account || now.desktop !== a.desktop) v.end();
        })
        .catch((e) => {
          if (e instanceof HttpError && e.status < 500 && !over) {
            event(res, { t: "refused", why: e.message, code: String(e.extra?.code ?? `http_${e.status}`) });
            v.end();
          }
        });
    const look = setInterval(() => judge(stillMay(user!, key, project, bot)), every);
    look.unref?.();
    // And at each write of the owner's state, from it (recheck).
    const unwrite = onWrite(a.account, (blob) => !over && judge(mayUseBrowser(user!, key, project, bot, { written: { account: a.account, blob } })));
    // orgo-web's notice that their access to the workspace changed ends it at once (members.ts membersChanged).
    const untrack = project ? trackMemberStream(user!.id, project, () => v.end()) : () => {};
    req.on("close", v.end);
    res.on("close", v.end);
    res.on("error", v.end);
  },
};

/* ---------------- Acting ---------------- */

type Act = BrowserInputAct["act"];

/** An act's name, checked: take, release or input. */
function actOf(v: unknown): Act {
  if (v !== "take" && v !== "release" && v !== "input") throw new HttpError(400, "act must be take, release or input");
  return v;
}

/** One act of someone who may use `bot`'s browser (`a`), sent to the runner of its computer now; what it refuses, thrown. */
function sendAct(a: BrowserAccess, bot: string, act: Act, body: Partial<BrowserInputAct>) {
  const r = runners.get(runnerKey(a.account, a.desktop));
  if (!r) throw new HttpError(409, `${a.botName}'s computer isn't connected right now.`, { code: "browser_offline" });
  if (act === "input") {
    if (!isBrowserMethod(body.method)) throw new HttpError(400, "The browser tab can't do that.");
    sendRunner(r, { t: "input", bot, who: a.person, method: body.method, params: body.params ?? {} });
  } else if (act === "take") sendRunner(r, { t: "take", bot, who: a.person, ...(a.owner ? { over: true as const } : {}) });
  else sendRunner(r, { t: "release", bot, who: a.person });
}

const actRoute: Route = {
  method: "POST",
  path: "/v1/browser/act",
  auth: "user",
  handle: async (req, res, { user }) => {
    const body = await readJson<Partial<BrowserAct>>(req, MAX_ACT);
    probeInput("cloud_got", body.method, body.params);
    const act = actOf(body.act);
    const project = typeof body.project === "string" && body.project ? body.project : null;
    const bot = typeof body.bot === "string" ? body.bot : "";
    sendAct(await mayUseBrowser(user!, bearer(req), project, bot), bot, act, body);
    sendJson(res, 202, { ok: true });
  },
};

const inputWss = new WebSocketServer({ noServer: true, clientTracking: false, maxPayload: MAX_ACT, perMessageDeflate: false });

/** What didn't go, told on the socket it came on (nothing for what did). */
const replyInput = (ws: WebSocket, e: HttpError) => {
  if (ws.readyState !== WebSocket.OPEN) return;
  const m: BrowserInputReply = { t: "error", code: String(e.extra?.code ?? `http_${e.status}`), why: e.message };
  ws.send(JSON.stringify(m));
};

/**
 * WS /v1/browser/input: asked as the watch stream is (mayUseBrowser; a refusal is the upgrade's status), then each message
 * one act, checked and sent on in the order it came. Asked afresh every ROLE_MS (stillMay: the key too) and at each write
 * of the owner's state (recheck), and ended at once by orgo-web's notice that their access changed; ended too when the
 * bot's computer or account isn't the one it was.
 */
async function openInput(req: IncomingMessage, socket: Duplex, head: Buffer, user: CloudUser, url: URL) {
  const bot = url.searchParams.get("bot") ?? "";
  const project = url.searchParams.get("project");
  const key = bearer(req);
  let a = await mayUseBrowser(user, key, project, bot);
  // Gone while that was asked: never a socket.
  if (socket.destroyed) return;
  inputWss.handleUpgrade(req, socket, head, (ws) => {
    let over = false;
    const end = (code: number, why: string) => {
      if (over) return;
      over = true;
      inputs.delete(stop);
      clearInterval(look);
      clearInterval(ping);
      untrack();
      unwrite();
      if (ws.readyState === WebSocket.OPEN) ws.close(code, why);
      else ws.terminate();
    };
    const stop = () => end(1001, "Bops Cloud is restarting");
    inputs.add(stop);
    const judge = (asked: Promise<BrowserAccess>) =>
      void asked
        .then((now) => {
          if (over) return;
          if (now.account !== a.account || now.desktop !== a.desktop) end(INPUT_MOVED, "The bot's computer changed");
          else a = now;
        })
        .catch((e) => {
          // Orgo or the database out of reach (5xx): kept as it is, as a watch stream is.
          if (e instanceof HttpError && e.status < 500) end(INPUT_REFUSED, e.status === 401 ? "Sign in again" : "No longer allowed");
        });
    const look = setInterval(() => judge(stillMay(user, key, project, bot)), every);
    look.unref?.();
    // At each write of the owner's state too, from it (recheck): a level or a bot's computer, which no notice says.
    const unwrite = onWrite(a.account, (blob) => !over && judge(mayUseBrowser(user, key, project, bot, { written: { account: a.account, blob } })));
    const untrack = project ? trackMemberStream(user.id, project, () => end(INPUT_REFUSED, "Access changed")) : () => {};
    // Pinged: one that hasn't answered (a pong, or any act) since the last ping is gone without a close (a Mac that
    // changed networks), and would otherwise be kept, and looked at, for good. Ended without a close to wait for.
    let heard = true;
    ws.on("pong", () => (heard = true));
    const ping = setInterval(() => {
      if (!heard) return void ws.terminate();
      heard = false;
      ws.ping();
    }, pingEvery);
    ping.unref?.();
    ws.on("message", (data: RawData, binary: boolean) => {
      if (over) return;
      heard = true;
      let m: unknown = null;
      try {
        if (!binary) m = JSON.parse(String(data));
      } catch {}
      const body = (m && typeof m === "object" ? m : {}) as Partial<BrowserInputAct>;
      probeInput("cloud_got", body.method, body.params);
      try {
        sendAct(a, bot, actOf(body.act), body);
      } catch (e) {
        if (e instanceof HttpError) replyInput(ws, e);
      }
    });
    ws.on("close", () => end(1000, ""));
    ws.on("error", () => ws.terminate());
  });
}

/* ---------------- The runner ---------------- */

const wss = new WebSocketServer({ noServer: true, clientTracking: false, maxPayload: MAX_FRAME });

/** A runner's list of its browser's tabs, kept to what a tab is (an id of letters and digits, a title, an address), at most 20. */
function tabsOf(m: { tabs?: unknown; front?: unknown }): { tabs: { id: string; title: string; url: string }[]; front: string | null } {
  const tabs = (Array.isArray(m.tabs) ? m.tabs : [])
    .filter((t): t is { id: string; title?: unknown; url?: unknown } => !!t && typeof t === "object" && typeof t.id === "string" && /^[A-Za-z0-9]{1,64}$/.test(t.id))
    .slice(0, 20)
    .map((t) => ({ id: t.id, title: typeof t.title === "string" ? t.title.slice(0, 200) : "", url: typeof t.url === "string" ? t.url.slice(0, 2048) : "" }));
  const front = typeof m.front === "string" && tabs.some((t) => t.id === m.front) ? m.front : null;
  return { tabs, front };
}

/** What a runner said, passed on to the viewers of each bot it's for (on that computer); a frame skips a viewer that's behind. */
function fromRunner(r: Runner, m: RunnerToBrowser) {
  if (!m || typeof m !== "object" || !Array.isArray(m.bots)) return;
  const activity = m.t === "activity" ? activityOf(m) : null;
  for (const bot of m.bots.slice(0, MAX_BOTS)) {
    if (typeof bot !== "string") continue;
    if (activity) doing.set(botKey(r.account, bot), { desktop: r.desktop, activity });
    for (const v of viewers.get(botKey(r.account, bot)) ?? []) {
      if (v.desktop !== r.desktop) continue;
      if (activity) event(v.res, { t: "activity", ...activity });
      if (v.quiet) continue;
      if (m.t === "frame") {
        if (!v.res.writableNeedDrain && typeof m.data === "string") {
          probeTiming("cloud_frame", { timestamp: m.meta?.timestamp, bytes: Buffer.byteLength(m.data, "base64") });
          event(v.res, { t: "frame", data: m.data, meta: m.meta });
        }
      } else if (m.t === "page") event(v.res, { t: "page", url: String(m.url ?? ""), title: String(m.title ?? ""), back: typeof m.back === "number" ? m.back : null });
      else if (m.t === "tabs") event(v.res, { t: "tabs", ...tabsOf(m) });
      else if (m.t === "control") event(v.res, { t: "control", by: m.by ?? null, you: !!m.by && m.by.id === v.person.id });
      else if (m.t === "pointer") {
        // A move or a scroll skips a viewer that's behind, as a frame does (the next says where); a press never does.
        const by = personOf(m.by);
        if (!(POINTER_KINDS as readonly string[]).includes(m.kind) || !Number.isFinite(m.x) || !Number.isFinite(m.y) || ((m.kind === "move" || m.kind === "wheel") && v.res.writableNeedDrain)) continue;
        event(v.res, { t: "pointer", kind: m.kind, x: m.x, y: m.y, by, you: !!by && by.id === v.person.id });
      }
      else if (m.t === "refused" && m.to === v.person.id) event(v.res, { t: "refused", why: String(m.why ?? "") });
    }
  }
}

function attach(user: CloudUser, ws: WebSocket) {
  const desktop = user.computer!.desktopId;
  const k = runnerKey(user.id, desktop);
  runners.get(k)?.ws.close(4000, "Another runner of this computer connected");
  const r: Runner = { ws, account: user.id, desktop };
  runners.set(k, r);
  // Who watches each of its bots now, and that it's here.
  for (const [vk, set] of viewers) {
    const [account, bot] = vk.split("\n");
    if (account !== user.id) continue;
    const here = [...set].filter((v) => v.desktop === desktop);
    if (!here.length) continue;
    for (const v of here) event(v.res, { t: "computer", connected: true });
    sayWatching(account, bot, desktop);
  }
  ws.on("message", (data: RawData) => {
    try {
      fromRunner(r, JSON.parse(String(data)) as RunnerToBrowser);
    } catch {}
  });
  ws.on("error", () => {});
  ws.on("close", () => {
    if (runners.get(k) !== r) return;
    runners.delete(k);
    for (const [bk, d] of doing) if (bk.startsWith(`${user.id}\n`) && d.desktop === desktop) doing.delete(bk);
    for (const [vk, set] of viewers) if (vk.startsWith(`${user.id}\n`)) for (const v of set) if (v.desktop === desktop) event(v.res, { t: "computer", connected: false });
  });
}

/** A runner of this computer is connected (tests). */
export const runnerConnected = (account: string, desktop: string) => runners.has(runnerKey(account, desktop.toLowerCase()));
/** How many streams watch a bot's browser (tests). */
export const viewersOf = (account: string, bot: string) => viewers.get(botKey(account, bot))?.size ?? 0;

export const routes: Route[] = [watchRoute, actRoute];
export const upgrades: Upgrade[] = [
  {
    path: "/v1/browser/runner",
    computer: true,
    handle: (req: IncomingMessage, socket, head, { user }) => {
      // Only a computer, as itself: the user's own key (a Mac) has no computer to relay.
      if (!user.computer?.desktopId) return refuseUpgrade(socket, 403, "Forbidden");
      wss.handleUpgrade(req, socket, head, (ws) => attach(user, ws));
    },
  },
  {
    // A person's own key only: a computer is refused before this (server.ts computerCheck).
    path: BROWSER_INPUT_PATH,
    handle: (req, socket, head, { user, url }) => {
      // Node takes its own error handler off an upgrading socket: one dropping mid-handshake mustn't take the process down.
      socket.on("error", () => socket.destroy());
      openInput(req, socket, head, user, url).catch((e: unknown) => {
        const status = e instanceof HttpError ? e.status : 500;
        if (!(e instanceof HttpError)) console.error(`[browser] input socket: ${(e as Error)?.message ?? e}`);
        // Marked as this route's: a 404 without the mark is a Bops Cloud from before it.
        if (!socket.destroyed) refuseUpgrade(socket, status, STATUS_CODES[status] ?? "Error", { [BROWSER_INPUT_HEADER]: "1" });
      });
    },
  },
];
