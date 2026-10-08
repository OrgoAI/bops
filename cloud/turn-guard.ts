import { config } from "./config.ts";
import { creditLeft, creditsOn, OUT_OF_CREDIT, outOfCredit, shortOfCredit } from "./credit.ts";
import { query, sessionUsed } from "./db.ts";
import { HttpError } from "./http.ts";
import { tokenCost, turnHold } from "./pricing.ts";
import { AI_CREDIT_EMPTY, AI_CREDIT_LOW } from "./protocol.ts";
import { recordTokens } from "./usage.ts";

/**
 * Agent turns held to the user's AI credit while they run, as orgo-web's budget gate holds its agent
 * loops (lib/chat/budget-gate.ts): a task stops once what it's spending reaches what the user has
 * left, not after. orgo-web runs its own loop and sees each step's tokens. OpenAI's Agents API runs
 * this one and says what a turn used only once it's over (checked 2026-10-06: a running turn's `usage`
 * is null and its traces are empty; a cancelled turn's use comes in about 5 seconds after it stops).
 * So:
 *
 * - A turn starts only with room for its first seconds on top of everything already held and
 *   starting for the user (admitTurn, claimed at once so a burst of starts can't share one balance).
 *   The proxy names each session that gets work (watchSession, before the work is sent on, so a Mac
 *   that hangs up can't skip it).
 * - Every few seconds the cloud reads each watched session's turns with its own key: all of them the
 *   first time, then the newest, and any it knows aren't over one by one. A finished turn is paid at
 *   once (usage.ts keeps one row per turn, so the Mac's sighting and reconcile.ts's never pay it
 *   twice). A running turn is held at its session's rate (pricing.ts turnHold, then what its own turns
 *   cost) for the time the cloud has seen it running (not its time waiting on the user or queued), plus
 *   the time it takes to see and stop it; one that's over but whose use isn't in yet stays held for
 *   the time it ran. A session with a turn not over is never let go.
 * - When what's held for a user's turns reaches what they have left, each session with a running turn
 *   is cancelled (agent.session.input.cancel), all at once, and the real use is paid when it comes in.
 * - Then it's decided what next, once. The task is set going again (a new turn, where it left off: the
 *   hold is a cautious guess, and the credit may well have been there) only when the cloud cancelled
 *   its main turn (not only a helper's), the Mac is still following it, the user didn't stop it, there's
 *   room for another minute of it, and it hasn't been set going again 5 times this hour. Otherwise it
 *   stays stopped, and the Mac's stream gets the cancelled turn as failed with why (verdict): no credit
 *   left (AI_CREDIT_EMPTY), or too little (AI_CREDIT_LOW).
 *
 * Off when AI credit is off. Each user is guarded on their own (a slow one never holds up the rest),
 * with a few reads at once, and at most `perUser` sessions watched or starting. The cloud is one
 * process, so what's watched is kept here; at the start the sessions that got work lately and may not
 * be over are watched again.
 */

/** Tests shorten them. */
export const guardTiming = {
  everyMs: 5_000,
  /** How long a cancel takes to stop a turn (about 7 seconds, seen 2026-10-06). */
  stopMs: 10_000,
  /** How long a stopped turn's use is waited for before it's decided without it. */
  settleMs: 45_000,
  /** The room a stopped task needs to keep going: this many seconds at its rate. */
  resumeS: 60,
  /** A task is set going again at most this many times in `resumeWindowMs`; then it stays stopped. */
  resumes: 5,
  resumeWindowMs: 60 * 60_000,
  /** Sweeps in a row with nothing of it running before a session is let go. */
  idleSweeps: 3,
  /** Reads that failed in a row (each waited on longer) before a session with nothing known running is let go. */
  maxErrors: 20,
  /** A session whose turns not over are all waiting (on the user, or queued) is read this often. */
  waitingMs: 15_000,
  /** At the start, sessions that got work this recently are watched again. */
  seedMs: 6 * 60 * 60_000,
  /** Turns per page (the newest first), and pages read the first time a session is looked at. */
  page: 100,
  firstPages: 10,
  /** Sessions read at once for one user, and sessions watched or starting at once for one user. */
  parallel: 4,
  perUser: 24,
};

/** The guard's clock (ms): tests move it forward. */
export const guardClock = { now: () => Date.now() };

/** What a task is told when it may keep going. */
export const KEEP_GOING = "Keep going with the task from where you left off.";

/** What the Mac's stream is told about a turn the cloud stopped: why, and the code its app reads. */
export type Verdict = { code: string; message: string };

const TERMINAL = new Set(["completed", "failed", "cancelled"]);

type Turn = { id?: unknown; status?: unknown; subagent_id?: unknown; usage?: unknown; created_at?: unknown; started_at?: unknown; completed_at?: unknown };
type Seen = Turn & { id: string };

/** A stop of one session: the turns it cancelled, and what the Mac is told about them once it's decided. */
type Stop = {
  at: number;
  /** The session's turns that weren't over when it was stopped (any of them may end cancelled). */
  turns: Set<string>;
  settled: boolean;
  done: Promise<Verdict | null>;
  /** The first call decides it; later ones do nothing. */
  settle: (v: Verdict | null) => void;
};

type Watched = {
  userId: string;
  session: string;
  model: string | null;
  botId: string | null;
  /** When the cloud started watching it (seconds): a turn finished well before is reconcile.ts's to pay. */
  since: number;
  /** Micro-dollars a second each of its running turns is held at. */
  rate: number;
  /** What its finished turns cost and ran for, which its rate is learned from. */
  spent: { micros: number; secs: number };
  /** Its finished turns already counted (paid, and learned from). */
  counted: Set<string>;
  /** Its turns not known to be over: read one by one when they're no longer among the newest. */
  open: Set<string>;
  /** How long each open turn has been seen running (seconds), as of when (seconds), and whether it was running then. */
  ran: Map<string, { s: number; at: number; running: boolean }>;
  looked: boolean;
  /** What its turns were held at, at the last read. */
  held: number;
  idle: number;
  errors: number;
  /** Not read again before this (ms): after failed reads, or while all it has open is waiting. */
  nextLookAt: number;
  stop?: Stop;
  /** When the user last cancelled it themselves (the app's Stop, through the proxy). */
  userStoppedAt: number;
  /** When the cloud set it going again, for the cap. */
  resumedAt: number[];
};

/** Every watched session, and each user's. */
const watched = new Map<string, Watched>();
const byUser = new Map<string, Set<Watched>>();
/** A start let through: its reserve, and its session once known. Held until the guard has read that session since. */
type Claim = { micros: number; at: number; session?: string };
/** What the proxy holds of a start: let it go (it didn't happen), or name its session (a new one, once OpenAI answers). */
export type Start = { release: () => void; session: (id: string) => void };
const starting = new Map<string, Set<Claim>>();
/** Each session's latest stop, kept a while after it's decided, for the Mac's stream. */
const stops = new Map<string, Stop>();
/** How many Mac streams follow each session right now. */
const following = new Map<string, number>();
/** Users being guarded right now. */
const inFlight = new Set<string>();

const isObject = (v: unknown): v is Record<string, unknown> => !!v && typeof v === "object" && !Array.isArray(v);
const secs = (v: unknown) => (typeof v === "number" && v > 0 ? v : null);
const dollars = (micros: number) => `$${(Math.max(0, micros) / 1e6).toFixed(2)}`;
const turnsIn = (json: unknown): Seen[] => (isObject(json) && Array.isArray(json.data) ? (json.data as Turn[]) : []).filter((t): t is Seen => typeof t?.id === "string");
const lead = () => (guardTiming.everyMs + guardTiming.stopMs) / 1000;

const emptyVerdict = (): Verdict => ({ code: AI_CREDIT_EMPTY, message: OUT_OF_CREDIT });
// No amounts in these: an app before 0.0.16 sends a task's failure on by email, text or channel too.
const lowVerdict = (): Verdict => ({ code: AI_CREDIT_LOW, message: "It needs more AI credit than you have left, so it's stopped. Upgrade in Settings to keep it going." });
/** When it couldn't be decided in time (or something failed on the way). */
const unsureVerdict = (): Verdict => ({ code: AI_CREDIT_LOW, message: "It was stopped while your AI credit was checked. Ask again to pick it up." });

const usersWatched = (userId: string) => [...(byUser.get(userId) ?? [])];
const startingFor = (userId: string) => [...(starting.get(userId) ?? [])];

function release(userId: string, claim: Claim) {
  const mine = starting.get(userId);
  if (!mine?.delete(claim)) return;
  if (!mine.size) starting.delete(userId);
}

/**
 * Let a turn start for the user (a new task, or work for one): they must have room for its first
 * seconds (startReserve) on top of what's held for their running turns and what's starting, and fewer
 * than `perUser` sessions watched or starting (a session already watched doesn't count again). The
 * reserve is taken at once, before anything is awaited, so starts at the same moment each see the
 * others'. 402 with none left, 403 with too little, 429 past the count. The reserve lapses once the
 * guard has read the start's session (it holds the turn itself then), or a minute on.
 */
export async function admitTurn(userId: string, session: string | undefined, model: string | null | undefined): Promise<Start> {
  if (!creditsOn()) return { release: () => {}, session: () => {} };
  const known = !!session && watched.has(session);
  const unwatched = startingFor(userId).filter((c) => !c.session || !watched.has(c.session)).length;
  if (!known && usersWatched(userId).length + unwatched >= guardTiming.perUser)
    throw new HttpError(429, "Too many tasks are running at once. Wait for one to finish.");
  const claim: Claim = { micros: startReserve(session, model), at: guardClock.now(), session };
  starting.set(userId, (starting.get(userId) ?? new Set()).add(claim));
  setTimeout(() => release(userId, claim), 60_000).unref?.();
  try {
    const left = await creditLeft(userId);
    if (left <= 0) throw outOfCredit();
    const held = usersWatched(userId).reduce((sum, w) => sum + w.held, 0) + startingFor(userId).reduce((sum, c) => sum + c.micros, 0);
    if (held > left) throw shortOfCredit();
  } catch (e) {
    release(userId, claim);
    throw e;
  }
  return { release: () => release(userId, claim), session: (id) => (claim.session ??= id) };
}

/** A session that got work: its turns are held to the user's credit until it's been idle a while. */
export function watchSession(userId: string, session: string, model: string | null | undefined, botId: string | null | undefined) {
  if (!creditsOn()) return;
  const w = watched.get(session);
  if (w) {
    w.idle = 0;
    // New work: read it at the next sweep, even while waiting out failed reads or a waiting turn.
    w.nextLookAt = 0;
    w.model ??= model ?? null;
    w.botId ??= botId ?? null;
    return;
  }
  const fresh: Watched = {
    userId,
    session,
    model: model ?? null,
    botId: botId ?? null,
    since: guardClock.now() / 1000,
    rate: turnHold(model).most,
    spent: { micros: 0, secs: 0 },
    counted: new Set(),
    open: new Set(),
    ran: new Map(),
    looked: false,
    held: 0,
    idle: 0,
    errors: 0,
    nextLookAt: 0,
    userStoppedAt: 0,
    resumedAt: [],
  };
  watched.set(session, fresh);
  byUser.set(userId, (byUser.get(userId) ?? new Set()).add(fresh));
}

/** The user cancelled the session themselves (the app's Stop): a stop of the cloud's under way is theirs now, and it's never set going again. */
export function userStopped(session: string) {
  const w = watched.get(session);
  if (!w) return;
  w.userStoppedAt = guardClock.now();
  const s = w.stop;
  w.stop = undefined;
  s?.settle(null);
}

/** A Mac stream following the session (its events): the returned call says it stopped following. */
export function follow(session: string): () => void {
  following.set(session, (following.get(session) ?? 0) + 1);
  let on = true;
  return () => {
    if (!on) return;
    on = false;
    const n = (following.get(session) ?? 1) - 1;
    if (n > 0) following.set(session, n);
    else following.delete(session);
  };
}

/** What a new turn of `session` (at `model`) needs to start: what it's held at until the first sweep can stop it. */
export function startReserve(session: string | undefined, model: string | null | undefined): number {
  const rate = (session && watched.get(session)?.rate) || turnHold(model).most;
  return Math.ceil(rate * lead());
}

/** How long the Mac's stream waits on a stop to be decided before it's told the task stopped anyway. */
const verdictWaitMs = () => guardTiming.stopMs + guardTiming.settleMs + 3 * guardTiming.everyMs + 15_000;

/**
 * What the Mac's stream is told about a cancelled turn of `session` (null: nothing, it passes as it
 * came): the cloud's verdict when its stop cancelled the turn, or the turn was cancelled while its
 * cancel was on its way. Waits until that's decided.
 */
export async function verdict(session: string, turnId: string): Promise<Verdict | null> {
  const s = stops.get(session);
  if (!s || (!s.turns.has(turnId) && guardClock.now() - s.at > guardTiming.stopMs + guardTiming.settleMs)) return null;
  let timer: NodeJS.Timeout | undefined;
  const late = new Promise<void>((resolve) => (timer = setTimeout(resolve, verdictWaitMs())));
  try {
    await Promise.race([s.done, late]);
  } finally {
    clearTimeout(timer);
  }
  // Not decided in time: it stays stopped (the stop's decision, if it comes now, can't set it going).
  s.settle(unsureVerdict());
  return s.done;
}

function newStop(turns: string[]): Stop {
  let settle!: (v: Verdict | null) => void;
  const done = new Promise<Verdict | null>((resolve) => (settle = resolve));
  const stop: Stop = {
    at: guardClock.now(),
    turns: new Set(turns),
    settled: false,
    done,
    settle: (v) => {
      if (stop.settled) return;
      stop.settled = true;
      settle(v);
    },
  };
  return stop;
}

/** One call to OpenAI with the cloud's key. */
async function openai(method: string, path: string, body?: unknown): Promise<{ status: number; json: unknown }> {
  const res = await fetch(`${config.upstream.openai().replace(/\/+$/, "")}${path}`, {
    method,
    headers: {
      authorization: `Bearer ${config.openaiKey()}`,
      "openai-beta": "agents=v1",
      accept: "application/json",
      ...(body === undefined ? {} : { "content-type": "application/json" }),
    },
    body: body === undefined ? undefined : JSON.stringify(body),
    signal: AbortSignal.timeout(15_000),
  });
  const text = await res.text();
  let json: unknown = null;
  try {
    json = text ? JSON.parse(text) : null;
  } catch {
    // Not JSON: only the status matters.
  }
  return { status: res.status, json };
}

const turnsPath = (session: string) => `/v1/agents/sessions/${encodeURIComponent(session)}/turns`;
const eventsPath = (session: string) => `/v1/agents/sessions/${encodeURIComponent(session)}/events`;

/** A finished turn, once: paid (unless it finished well before the cloud watched it), and learned from. */
async function count(w: Watched, t: Seen) {
  const start = secs(t.started_at) ?? secs(t.created_at);
  const end = secs(t.completed_at);
  if ((end ?? guardClock.now() / 1000) >= w.since - 600) await recordTokens(w.userId, t.id, t.usage, { model: w.model ?? undefined, source: "agent", botId: w.botId });
  w.counted.add(t.id);
  if (!start || !end || end <= start || !isObject(t.usage)) return;
  const u = t.usage as { input_tokens?: number; output_tokens?: number; input_tokens_details?: { cached_tokens?: number; cache_write_tokens?: number } | null };
  w.spent.micros += tokenCost({
    model: w.model ?? undefined,
    source: "agent",
    input: u.input_tokens,
    output: u.output_tokens,
    cached: u.input_tokens_details?.cached_tokens,
    cacheWrite: u.input_tokens_details?.cache_write_tokens,
  });
  w.spent.secs += end - start;
  // Half again what its turns cost a second, within its model's bounds, once there's enough to go by.
  if (w.spent.secs < 20) return;
  const { most, least } = turnHold(w.model);
  w.rate = Math.min(2 * most, Math.max(least, (1.5 * w.spent.micros) / w.spent.secs));
}

type Look = { byId: Map<string, Seen>; held: number; busy: boolean; running: string[]; unfinished: string[] };

/** Read one session's turns: the finished ones counted, and what's held for the rest. Null when it's gone. */
async function look(w: Watched, now: number): Promise<Look | null> {
  const byId = new Map<string, Seen>();
  let after: string | undefined;
  const pages = w.looked ? 1 : guardTiming.firstPages;
  for (let i = 0; i < pages; i++) {
    const r = await openai("GET", `${turnsPath(w.session)}?${new URLSearchParams({ limit: String(guardTiming.page), order: "desc", ...(after ? { after } : {}) })}`);
    if (r.status === 404 && !i) return null;
    if (r.status >= 300) throw new Error(`OpenAI answered ${r.status} for its turns`);
    const data = turnsIn(r.json);
    for (const t of data) byId.set(t.id, t);
    const last = data.at(-1)?.id;
    if (!isObject(r.json) || !r.json.has_more || !last) break;
    after = last;
  }
  w.looked = true;
  // A turn not over that's no longer among the newest (a long main turn behind its helpers'): on its own.
  // One that can't be read is taken as it was last seen (still running, if it was), not as gone.
  for (const id of w.open) {
    if (byId.has(id)) continue;
    const r = await openai("GET", `${turnsPath(w.session)}/${encodeURIComponent(id)}`).catch(() => undefined);
    if (r?.status === 404) {
      w.open.delete(id);
      w.ran.delete(id);
      continue;
    }
    if (r && r.status < 300 && isObject(r.json) && r.json.id === id) byId.set(id, r.json as Seen);
    else byId.set(id, { id, status: w.ran.get(id)?.running === false ? "waiting" : "in_progress" });
  }
  let held = 0;
  let busy = false;
  const running: string[] = [];
  const unfinished: string[] = [];
  for (const t of byId.values()) {
    const status = String(t.status);
    const start = secs(t.started_at) ?? secs(t.created_at);
    const seen = w.ran.get(t.id);
    if (TERMINAL.has(status) && t.usage) {
      if (!w.counted.has(t.id)) await count(w, t);
      w.open.delete(t.id);
      w.ran.delete(t.id);
      continue;
    }
    if (TERMINAL.has(status)) {
      // Over, its use not in yet: held for the time it ran, until it comes in (or long after, for reconcile.ts).
      const end = secs(t.completed_at) ?? now;
      if (now - end < guardTiming.settleMs / 1000) {
        const ran = seen?.s ?? Math.max(0, end - (start ?? end));
        w.ran.set(t.id, { s: ran, at: now, running: false });
        held += ran * w.rate;
        busy = true;
        w.open.add(t.id);
      } else {
        w.open.delete(t.id);
        w.ran.delete(t.id);
      }
      continue;
    }
    busy = true;
    w.open.add(t.id);
    unfinished.push(t.id);
    if (status === "in_progress") {
      // Its running time as seen here: all of it since it started the first time it's seen, then each
      // sweep's worth while it runs (at most one sweep too many after a wait).
      const s = seen ? seen.s + Math.max(0, now - seen.at) : Math.max(0, now - (start ?? now));
      w.ran.set(t.id, { s, at: now, running: true });
      held += (s + lead()) * w.rate;
      running.push(t.id);
    } else {
      // Waiting on the user, or queued: what it ran so far is still held, but the wait isn't.
      w.ran.set(t.id, { s: seen?.s ?? 0, at: now, running: false });
      held += (seen?.s ?? 0) * w.rate;
    }
  }
  return { byId, held, busy, running, unfinished };
}

/** Let a session go. A stop of it still to be decided is decided as it is: stopped. */
function drop(w: Watched) {
  if (watched.get(w.session) === w) watched.delete(w.session);
  const mine = byUser.get(w.userId);
  mine?.delete(w);
  if (mine && !mine.size) byUser.delete(w.userId);
  const s = w.stop;
  w.stop = undefined;
  s?.settle(unsureVerdict());
}

/** What a session's open turns come to now, as last seen: one running then has run on since (a read that fails can't say otherwise). */
function heldAsLastSeen(w: Watched, now: number) {
  let held = 0;
  for (const r of w.ran.values()) held += (r.running ? r.s + Math.max(0, now - r.at) + lead() : r.s) * w.rate;
  return held;
}

/** Cancel a session's turns not over: what's held for the user's turns reached what they have left. */
async function stop(w: Watched, turns: string[], held: number, left: number) {
  // Kept before the cancel is sent: its cancelled turn may reach the Mac's stream before the answer does.
  const s = newStop(turns);
  w.stop = s;
  stops.set(w.session, s);
  void s.done.then(() => setTimeout(() => stops.get(w.session) === s && stops.delete(w.session), 10 * 60_000).unref?.());
  let r: { status: number } | undefined;
  try {
    r = await openai("POST", eventsPath(w.session), { events: [{ type: "agent.session.input.cancel" }] });
  } catch (e) {
    // No answer: the cancel may well have landed. The stop stands, and is decided on what the turns do.
    console.warn(`[guard] ${w.userId}'s task ${w.session}: cancel sent, no answer (${(e as Error).message})`);
    return;
  }
  if (r.status >= 300) {
    if (w.stop === s) w.stop = undefined;
    s.settle(null);
    throw new Error(`OpenAI answered ${r.status} to the cancel`);
  }
  console.log(`[guard] ${w.userId}'s task ${w.session}: ${dollars(held)} held against ${dollars(left)} of AI credit left, so it's stopped`);
}

/**
 * A stop whose turns are over and paid (or that has waited long enough): set it going again, or tell
 * the Mac why it stays stopped. What it set aside of `room` for going again.
 */
async function decide(w: Watched, got: Look, left: number, room: number): Promise<number> {
  const s = w.stop!;
  const mine = [...s.turns].map((id) => got.byId.get(id)).filter((t): t is Seen => !!t);
  const over = mine.length === s.turns.size && mine.every((t) => TERMINAL.has(String(t.status)) && t.usage);
  if (!over && guardClock.now() - s.at < guardTiming.settleMs) return 0;
  w.stop = undefined;
  let why: Verdict | null = unsureVerdict();
  try {
    if (s.settled) return 0;
    // Only a helper was cancelled (the main turn ended on its own, and the Mac moved on): nothing to tell or pick up.
    if (!mine.some((t) => t.status === "cancelled" && !t.subagent_id)) {
      why = null;
      return 0;
    }
    why = left <= 0 ? emptyVerdict() : lowVerdict();
    const need = w.rate * guardTiming.resumeS;
    const recent = w.resumedAt.filter((at) => guardClock.now() - at < guardTiming.resumeWindowMs);
    const userStopped = w.userStoppedAt >= s.at - guardTiming.stopMs;
    if (userStopped || !following.get(w.session) || recent.length >= guardTiming.resumes || room < need) return 0;
    const r = await openai("POST", eventsPath(w.session), {
      events: [{ type: "agent.session.input.message", input: [{ role: "user", content: [{ type: "input_text", text: KEEP_GOING }] }] }],
    });
    if (r.status >= 300) throw new Error(`OpenAI answered ${r.status} to keep it going`);
    why = null;
    w.resumedAt = [...recent, guardClock.now()];
    w.idle = 0;
    await sessionUsed(w.session).catch(() => {});
    // The user stopped it, the Mac stopped following it, or the Mac was told it stopped, while that was on its way: undone.
    if (w.userStoppedAt >= s.at - guardTiming.stopMs || !following.get(w.session) || s.settled) {
      await openai("POST", eventsPath(w.session), { events: [{ type: "agent.session.input.cancel" }] }).catch(() => undefined);
      return 0;
    }
    console.log(`[guard] ${w.userId}'s task ${w.session}: ${dollars(left)} of AI credit left after all, so it keeps going`);
    return need;
  } finally {
    s.settle(why);
  }
}

/** Run `fn` over `items`, at most `n` at once. */
async function eachAtMost<T, R>(items: T[], n: number, fn: (item: T) => Promise<R>): Promise<R[]> {
  const out: R[] = [];
  let next = 0;
  await Promise.all(
    Array.from({ length: Math.min(n, items.length) }, async () => {
      while (next < items.length) {
        const i = next++;
        out[i] = await fn(items[i]);
      }
    }),
  );
  return out;
}

/** One user's watched sessions, in one sweep: read, held to their credit, stopped, and decided. */
async function guardUser(userId: string) {
  const sweepAt = guardClock.now();
  const due = usersWatched(userId).filter((w) => w.nextLookAt <= sweepAt);
  const looked = await eachAtMost(due, guardTiming.parallel, async (w) => {
    try {
      return { w, got: await look(w, sweepAt / 1000) };
    } catch (e) {
      w.errors++;
      w.nextLookAt = guardClock.now() + Math.min(60_000, guardTiming.everyMs * 2 ** Math.min(w.errors, 4));
      // What it can't be read for, it's held at as last seen, still running.
      w.held = heldAsLastSeen(w, sweepAt / 1000);
      console.warn(`[guard] ${userId}'s task ${w.session}: ${(e as Error).message}`);
      // Kept, read every minute, while a turn of it was last seen not over or it was never read: when reads
      // come back, it's held for all the time since. Let go after that only once it's old.
      const old = sweepAt / 1000 - w.since > guardTiming.seedMs / 1000;
      if (w.errors >= guardTiming.maxErrors && ((w.looked && !w.open.size) || old)) {
        console.warn(`[guard] ${userId}'s task ${w.session}: let go after ${w.errors} failed reads`);
        drop(w);
      }
      return { w, got: undefined };
    }
  });
  const fresh: { w: Watched; got: Look }[] = [];
  for (const { w, got } of looked) {
    if (got === undefined) continue;
    w.errors = 0;
    if (got === null) {
      drop(w);
      continue;
    }
    w.held = got.held;
    // Nothing running, only turns waiting on the user or queued: read less often (new work reads it at once).
    w.nextLookAt = got.busy && !got.running.length && !w.stop ? guardClock.now() + guardTiming.waitingMs : 0;
    w.idle = got.busy || w.stop ? 0 : w.idle + 1;
    if (w.idle >= guardTiming.idleSweeps) drop(w);
    fresh.push({ w, got });
  }
  // A start's reserve gives way to the hold of its turn once its session has been read since.
  const read = new Set(fresh.map((x) => x.w.session));
  for (const c of startingFor(userId)) if (c.session && read.has(c.session) && c.at < sweepAt) release(userId, c);
  const running = fresh.filter((x) => x.got.running.length && !x.w.stop);
  // Ones that couldn't be read but had a turn running: stopped too when it comes to that (the cancel may well go through).
  const unread = looked.filter((x) => x.got === undefined && !x.w.stop && [...x.w.ran.values()].some((r) => r.running)).map((x) => x.w);
  const deciding = fresh.filter((x) => x.w.stop && x.w.stop.at < sweepAt);
  if (!running.length && !unread.length && !deciding.length) return;
  // Every watched session of theirs counts, read this sweep or not, and every start in the last few seconds.
  const held = usersWatched(userId).reduce((sum, w) => sum + w.held, 0) + startingFor(userId).reduce((sum, c) => sum + c.micros, 0);
  const left = await creditLeft(userId);
  if ((running.length || unread.length) && held >= left)
    await Promise.all(
      [...running.map((x) => ({ w: x.w, turns: x.got.unfinished })), ...unread.map((w) => ({ w, turns: [...w.open] }))].map((x) =>
        stop(x.w, x.turns, held, left).catch((e: Error) => console.warn(`[guard] ${userId}'s task ${x.w.session}: ${e.message}`)),
      ),
    );
  let room = left - held;
  for (const x of deciding) room -= await decide(x.w, x.got, left, room).catch((e: Error) => (console.warn(`[guard] ${userId}'s task ${x.w.session}: ${e.message}`), 0));
}

/** One sweep: each user not already being guarded, each on their own (each user's credit is one balance). */
export async function guardSweep(): Promise<void> {
  if (!creditsOn() || !config.openaiKey()) return;
  const users = [...byUser.keys()].filter((u) => !inFlight.has(u));
  await Promise.all(
    users.map(async (userId) => {
      inFlight.add(userId);
      try {
        await guardUser(userId);
      } catch (e) {
        console.warn(`[guard] ${userId}: ${(e as Error).message}`);
      } finally {
        inFlight.delete(userId);
      }
    }),
  );
}

/** Whether a session is being watched (for tests). */
export const isWatched = (session: string) => watched.has(session);

/**
 * The sessions that got work lately and may not be over: watched again after a restart. That's any
 * reconcile.ts hasn't seen finish, and any it saw finish before its latest work (a reply on a finished
 * thread reuses its session, and isn't read back for a few minutes).
 */
export async function seed(): Promise<number> {
  const r = await query<{ object_id: string; user_id: string; model: string | null; bot_id: string | null }>(
    `SELECT object_id, user_id, model, bot_id FROM bops.cloud_objects
     WHERE provider = 'openai' AND kind = 'agent_session' AND (settled_at IS NULL OR settled_at < used_at)
       AND used_at > now() - $1 * interval '1 millisecond'`,
    [guardTiming.seedMs],
  );
  for (const s of r.rows) watchSession(s.user_id, s.object_id, s.model, s.bot_id);
  if (r.rows.length) console.log(`[guard] watching ${r.rows.length} task(s) that got work lately`);
  return r.rows.length;
}

/** Sweep every few seconds (from the start, after watching again what got work lately). Returns the stop. */
export function startGuard(): () => void {
  if (!creditsOn()) return () => {};
  void seed().catch((e: Error) => console.warn(`[guard] watching tasks again: ${e.message}`));
  const every = setInterval(() => void guardSweep(), guardTiming.everyMs);
  every.unref();
  return () => clearInterval(every);
}
