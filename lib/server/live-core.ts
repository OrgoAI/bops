import { LIVE_MOOD_TTL, type LiveEventIn, type LiveMood, type LiveRoutineChange, type LiveSnapshot } from "@/cloud/protocol";
import { codingThread } from "@/lib/bot-mood";
import { workspaceOf, type AppState } from "@/lib/types";

/**
 * The app's side of Live (cloud/live.ts, cloud/README.md "Live"), without the server: what this Mac's
 * bots are doing and what changed (LivePublisher), the stream from Bops Cloud and what it says
 * (LiveSubscriber), and what the user's bots are doing on their other devices (RemoteMoods). Clocks,
 * timers and the network come in from outside, so the tests drive them; lib/server/live.ts wires them
 * to the store, the signed-in key and Bops Cloud.
 *
 * None of it is ever in the way: a reply never waits on it, every failure is quiet and tried again
 * later, and with the stream down the app reads the state as it always has (every 30 seconds).
 */

type Timer = ReturnType<typeof setTimeout>;
/** Clocks and timers, the real ones unless a test gives its own. */
export type Clock = { now: () => number; setTimeout: (fn: () => void, ms: number) => Timer; clearTimeout: (t: Timer) => void; random: () => number };
const realClock: Clock = { now: () => Date.now(), setTimeout: (fn, ms) => setTimeout(fn, ms), clearTimeout: (t) => clearTimeout(t), random: Math.random };
const unref = (t: Timer) => ((t as { unref?: () => void }).unref?.(), t);

/** A bot's mood as this Mac sees it, with the workspace it's in. */
export type HereMood = { ws: string; mood: Exclude<LiveMood, "idle">; chatId?: string };
/** A thread this Mac runs, as its "session" event says it. */
export type HereSession = { ws: string; botId: string; status: string; activity?: string };

const running = (status: string) => status === "queued" || status === "starting" || status === "running";

/**
 * What this Mac's bots are doing now, from the same signals the app shows (lib/bot-mood.ts): a thread
 * this Mac runs (working, or writing when its caption says so, which wins over thinking as it does in
 * the app), typing or asking a teammate in a chat (thinking), and the call the user is on (speaking,
 * which wins). Only the bots that aren't idle. Typing is this Mac's alone (never synced), and so are
 * `runs` (the threads this server runs: one another Mac runs is in the state too, and is that Mac's to say).
 * Bops Cloud knows no coding (cloud/protocol.ts LIVE_MOODS: it turns an unknown mood down), so a bot coding
 * here (codingThread) is working there, as it is whatever its caption says and whatever else it does but talk.
 */
export function localMoods(state: AppState, here: { runs: ReadonlySet<string>; callBot: string | null }): Map<string, HereMood> {
  const out = new Map<string, HereMood>();
  const wsOf = (botId: string) => workspaceOf(state.bots.find((b) => b.id === botId));
  const coding = new Set(state.sessions.filter((s) => here.runs.has(s.id) && codingThread(s, state)).map((s) => s.botId));
  // Writing, or coding (which wins over writing and thinking in the app): what a reply on the way doesn't change.
  const writesOrCodes = (botId: string) => coding.has(botId) || out.get(botId)?.mood === "writing";
  for (const s of state.sessions)
    if (here.runs.has(s.id) && running(s.status) && !s.askWhere && (!out.has(s.botId) || (s.activity === "writing" && !writesOrCodes(s.botId))))
      out.set(s.botId, { ws: wsOf(s.botId), mood: s.activity === "writing" && !coding.has(s.botId) ? "writing" : "working" });
  for (const c of state.chats) for (const b of [...(c.typing ?? []), ...Object.keys(c.asking ?? {})]) if (!writesOrCodes(b)) out.set(b, { ws: wsOf(b), mood: "thinking", chatId: c.id });
  if (here.callBot && state.bots.some((b) => b.id === here.callBot)) out.set(here.callBot, { ws: wsOf(here.callBot), mood: "speaking" });
  return out;
}

/** The threads this Mac runs, as their events say them. */
export function localSessions(state: AppState, runs: ReadonlySet<string>): Map<string, HereSession> {
  const out = new Map<string, HereSession>();
  for (const s of state.sessions)
    if (runs.has(s.id)) out.set(s.id, { ws: workspaceOf(state.bots.find((b) => b.id === s.botId)), botId: s.botId, status: s.status, ...(s.activity ? { activity: s.activity.slice(0, 120) } : {}) });
  return out;
}

/* ---------------- Publishing ---------------- */

/** How long changes gather before they go, and how often a mood that holds is said again (it lasts LIVE_MOOD_TTL). */
export const PUBLISH_DEBOUNCE_MS = 250;
export const MOOD_REFRESH_MS = 5_000;
/**
 * After a publish that didn't go: 1 second, doubling up to a minute. A cloud without Live (404) is left
 * alone a quarter of an hour, and one that turned the key down (401, 403) five minutes, as the stream is.
 */
const RETRY_MS = 1_000;
const RETRY_MAX_MS = 60_000;
export const NO_LIVE_MS = 15 * 60_000;
export const REFUSED_MS = 5 * 60_000;
/** Events per POST (the cloud takes 16 in 4 KB). */
const BATCH = 8;
/** Routine and call events waiting for one workspace at most (the newest). */
const OTHERS_MAX = 32;

/** One POST /v1/live: the HTTP status, 0 when the cloud didn't answer. */
export type Send = (ws: string, events: LiveEventIn[]) => Promise<number>;

type Pending = { moods: Map<string, LiveEventIn>; sessions: Map<string, LiveEventIn>; others: LiveEventIn[] };

/**
 * Sends this Mac's moods, threads, routines and calls to Bops Cloud: a mood when it changes (idle when
 * it ends) and again every 5 seconds while it holds, a thread when its status or activity changes and
 * once more when this Mac stops running it. Changes gather for a moment and go one POST per workspace;
 * what didn't go is merged with what came since (the newest mood or status wins) and tried again later.
 */
export class LivePublisher {
  private sent = new Map<string, HereMood>();
  private sessions = new Map<string, HereSession>();
  private pending = new Map<string, Pending>();
  private flushTimer?: Timer;
  private refreshTimer?: Timer;
  private failures = 0;
  private quietUntil = 0;
  private flushing?: Promise<void>;
  private stopped = false;
  private send: Send;
  private clock: Clock;

  constructor(send: Send, clock: Partial<Clock> = {}) {
    this.send = send;
    this.clock = { ...realClock, ...clock };
  }

  private queue(ws: string): Pending {
    let p = this.pending.get(ws);
    if (!p) this.pending.set(ws, (p = { moods: new Map(), sessions: new Map(), others: [] }));
    return p;
  }

  /** The moods and threads as they are now: what changed since last time is queued. */
  update(moods: Map<string, HereMood>, sessions: Map<string, HereSession>) {
    if (this.stopped) return;
    let changed = false;
    for (const [botId, m] of moods) {
      const was = this.sent.get(botId);
      if (was && was.mood === m.mood && was.chatId === m.chatId && was.ws === m.ws) continue;
      // A bot that moved to another workspace is idle in the one it left.
      if (was && was.ws !== m.ws) this.queue(was.ws).moods.set(botId, { type: "mood", botId, mood: "idle" });
      this.queue(m.ws).moods.set(botId, moodEvent(botId, m));
      this.sent.set(botId, m);
      changed = true;
    }
    for (const [botId, was] of this.sent)
      if (!moods.has(botId)) {
        this.queue(was.ws).moods.set(botId, { type: "mood", botId, mood: "idle" });
        this.sent.delete(botId);
        changed = true;
      }
    for (const [id, s] of sessions) {
      const was = this.sessions.get(id);
      if (was && was.status === s.status && was.activity === s.activity) continue;
      this.queue(s.ws).sessions.set(id, sessionEvent(id, s));
      this.sessions.set(id, s);
      changed = true;
    }
    for (const id of this.sessions.keys()) if (!sessions.has(id)) this.sessions.delete(id);
    if (changed) this.schedule(PUBLISH_DEBOUNCE_MS);
    this.keepRefreshing();
  }

  /** A routine of this Mac's was added, changed, removed, or its run started or finished. */
  routine(ws: string, id: string, change: LiveRoutineChange) {
    this.other(ws, { type: "routine", id, change });
  }

  /** The user's call with a bot started or ended on this Mac. */
  call(ws: string, botId: string, on: boolean) {
    this.other(ws, { type: "call", botId, on });
  }

  private other(ws: string, ev: LiveEventIn) {
    if (this.stopped) return;
    const p = this.queue(ws);
    p.others.push(ev);
    if (p.others.length > OTHERS_MAX) p.others.splice(0, p.others.length - OTHERS_MAX);
    this.schedule(PUBLISH_DEBOUNCE_MS);
  }

  /** Every 5 seconds while a bot isn't idle: its mood again, so it doesn't run out on the user's other devices. */
  private keepRefreshing() {
    if (this.refreshTimer || !this.sent.size || this.stopped) return;
    this.refreshTimer = unref(
      this.clock.setTimeout(() => {
        this.refreshTimer = undefined;
        for (const [botId, m] of this.sent) this.queue(m.ws).moods.set(botId, moodEvent(botId, m));
        if (this.sent.size) this.schedule(0);
        this.keepRefreshing();
      }, MOOD_REFRESH_MS),
    );
  }

  private schedule(ms: number) {
    if (this.flushTimer || this.flushing) return;
    const wait = Math.max(ms, this.quietUntil - this.clock.now());
    this.flushTimer = unref(
      this.clock.setTimeout(() => {
        this.flushTimer = undefined;
        void this.flush();
      }, wait),
    );
  }

  /** Send what's queued now, one workspace at a time. */
  flush(): Promise<void> {
    if (this.flushing) return this.flushing;
    if (this.flushTimer) this.clock.clearTimeout(this.flushTimer);
    this.flushTimer = undefined;
    const run = async () => {
      const batches = [...this.pending];
      this.pending.clear();
      let retry = false;
      for (const [ws, p] of batches) {
        const events = [...p.moods.values(), ...p.sessions.values(), ...p.others];
        for (let i = 0; i < events.length; i += BATCH) {
          const status = await this.send(ws, events.slice(i, i + BATCH)).catch(() => 0);
          if (status >= 200 && status < 300) continue;
          if (status === 404 || status === 405 || status === 401 || status === 403) {
            // A Bops Cloud without Live yet, or one that won't take this key: nothing goes for a while, and nothing is kept.
            this.quietUntil = this.clock.now() + (status === 401 || status === 403 ? REFUSED_MS : NO_LIVE_MS);
            this.pending.clear();
            this.failures = 0;
            return;
          }
          // Not answered, too many, or the cloud's trouble: tried again (with what came since). Anything else isn't worth sending again.
          if (status === 0 || status === 408 || status === 429 || status >= 500) {
            this.requeue(ws, events.slice(i));
            retry = true;
          }
          break;
        }
      }
      if (retry) {
        this.failures++;
        this.quietUntil = this.clock.now() + Math.min(RETRY_MAX_MS, RETRY_MS * 2 ** (this.failures - 1));
      } else this.failures = 0;
    };
    this.flushing = run().finally(() => {
      this.flushing = undefined;
      if (this.pending.size && !this.stopped) this.schedule(0);
    });
    return this.flushing;
  }

  /** What didn't go goes back in the queue, behind anything newer for the same bot or thread. */
  private requeue(ws: string, events: LiveEventIn[]) {
    const p = this.queue(ws);
    const others: LiveEventIn[] = [];
    for (const ev of events) {
      if (ev.type === "mood") {
        if (!p.moods.has(ev.botId)) p.moods.set(ev.botId, ev);
      } else if (ev.type === "session") {
        if (!p.sessions.has(ev.id)) p.sessions.set(ev.id, ev);
      } else others.push(ev);
    }
    p.others = [...others, ...p.others].slice(-OTHERS_MAX);
  }

  /** Signing out, another workspace's stream, or the app quitting: every bot this Mac said was busy is said idle, once, and it stops. */
  async stop(): Promise<void> {
    if (this.stopped) return;
    for (const [botId, m] of this.sent) this.queue(m.ws).moods.set(botId, { type: "mood", botId, mood: "idle" });
    this.sent.clear();
    this.stopped = true;
    if (this.refreshTimer) this.clock.clearTimeout(this.refreshTimer);
    this.refreshTimer = undefined;
    await this.flushing;
    if (this.quietUntil <= this.clock.now()) await this.flush();
    if (this.flushTimer) this.clock.clearTimeout(this.flushTimer);
    this.flushTimer = undefined;
    this.pending.clear();
  }

  /** For tests: what's waiting to go. */
  waiting = () => [...this.pending].flatMap(([ws, p]) => [...p.moods.values(), ...p.sessions.values(), ...p.others].map((e) => ({ ws, ...e })));
}

const moodEvent = (botId: string, m: HereMood): LiveEventIn => ({ type: "mood", botId, mood: m.mood, ...(m.chatId ? { chatId: m.chatId } : {}), ttl: LIVE_MOOD_TTL });
const sessionEvent = (id: string, s: HereSession): LiveEventIn => ({ type: "session", id, botId: s.botId, status: s.status, ...(s.activity ? { activity: s.activity } : {}) });

/* ---------------- What the user's other devices say ---------------- */

/** A bot's mood on another device, as the window gets it. */
export type RemoteMood = { mood: Exclude<LiveMood, "idle">; chatId?: string };

/**
 * What the user's bots are doing on their other devices (from the stream), each until its ttl runs
 * out unless it's said again, so a Mac that went away stops showing its bot busy here too. This Mac's
 * own are left out: it knows them already. `onChange` runs whenever what the window should show changed.
 */
export class RemoteMoods {
  private moods = new Map<string, RemoteMood & { expiresAt: number }>();
  private timer?: Timer;
  private onChange: () => void;
  private clock: Clock;

  constructor(onChange: () => void, clock: Partial<Clock> = {}) {
    this.onChange = onChange;
    this.clock = { ...realClock, ...clock };
  }

  /** A new stream's snapshot: every mood there is, replacing what was known. */
  snapshot(s: LiveSnapshot, self: string) {
    const before = this.key();
    this.moods.clear();
    for (const m of s.moods ?? []) if (m.by !== self) this.set(m.botId, m.mood, m.chatId, m.ttl);
    this.changed(before);
  }

  /** One mood event. */
  apply(e: { botId: string; mood: LiveMood; chatId?: string; ttl?: number; by: string }, self: string) {
    if (e.by === self) return;
    const before = this.key();
    if (e.mood === "idle") this.moods.delete(e.botId);
    else this.set(e.botId, e.mood, e.chatId, e.ttl ?? LIVE_MOOD_TTL);
    this.changed(before);
  }

  private set(botId: string, mood: LiveMood, chatId: string | undefined, ttl: number) {
    if (mood === "idle") return;
    this.moods.set(botId, { mood, ...(chatId ? { chatId } : {}), expiresAt: this.clock.now() + Math.min(60, Math.max(1, ttl)) * 1000 });
  }

  /** Forget them all (the stream's workspace changed, or nobody's signed in). */
  clear() {
    const before = this.key();
    this.moods.clear();
    this.changed(before);
  }

  /** Moods past their ttl go. */
  sweep() {
    const before = this.key();
    const now = this.clock.now();
    for (const [botId, m] of this.moods) if (m.expiresAt <= now) this.moods.delete(botId);
    this.changed(before);
  }

  /** What the window gets: each bot's mood on another device, by bot id. */
  forApp(): Record<string, RemoteMood> {
    return Object.fromEntries([...this.moods].map(([botId, m]) => [botId, { mood: m.mood, ...(m.chatId ? { chatId: m.chatId } : {}) }]));
  }

  private key = () => JSON.stringify(this.forApp());

  private changed(before: string) {
    if (this.key() !== before) this.onChange();
    if (this.moods.size && !this.timer)
      this.timer = unref(
        this.clock.setTimeout(() => {
          this.timer = undefined;
          this.sweep();
        }, 1000),
      );
    else if (!this.moods.size && this.timer) {
      this.clock.clearTimeout(this.timer);
      this.timer = undefined;
    }
  }
}

/* ---------------- The stream ---------------- */

/** Reconnecting: 1 second, doubling up to a minute, each wait somewhere in its upper half so every Mac doesn't come back at once after a restart. */
const RECONNECT_MS = 1_000;
const RECONNECT_MAX_MS = 60_000;
/** A connection that held this long starts the waits over. */
const HELD_MS = 60_000;
/** Nothing at all for this long (the cloud says something every 15 seconds): the connection is taken for dead. */
export const SILENT_MS = 45_000;
/** How long Bops waits before asking again a cloud without Live (404), or one that turned the key down (401, 403: REFUSED_MS). */
const NOT_THERE_MS = 15 * 60_000;
/**
 * "state" and "reset" events close together are one read of the state, and the stream reads it at most
 * once every PULL_MIN_MS (counting the tunnel's reads, pulled()): a thread on another Mac writes every
 * few seconds, and each read is a look at the shared database. A change in between is read at the end.
 */
const PULL_DEBOUNCE_MS = 200;
export const PULL_MIN_MS = 5_000;

export type SubscriberDeps = {
  fetch: typeof fetch;
  /** The stream's address for a workspace. */
  url: (ws: string) => string;
  /** The signed-in key's headers, or null when nobody's signed in (it stops). */
  headers: () => Record<string, string> | null;
  /** This device's id (BOPS_DEVICE_HEADER): its own events are left out. */
  self: () => string;
  /** Read the state from Bops Cloud now. */
  pull: () => void;
  moods: RemoteMoods;
  /**
   * A shared workspace's stream (lib/server/shared.ts): the user may no longer watch it (a "revoked"
   * event, or the stream refused with 403, 404 or 409). It stops, and isn't tried again.
   */
  revoked?: () => void;
  /** Whether a "state" event needs a read (a shared workspace's copy that has its `hash` already doesn't). Unset: every one does. */
  wants?: (event: Record<string, unknown>) => boolean;
};

/**
 * One stream from Bops Cloud for the workspace the user is in. A "state" from another device, or a
 * "reset", reads the state now; moods go into RemoteMoods. Dropped, it comes back with its
 * Last-Event-ID after a backoff with jitter; a cloud without Live is asked again only every 15 minutes.
 * Nothing changes about the regular reads meanwhile.
 */
export class LiveSubscriber {
  private ws: string | null = null;
  private lastId: string | null = null;
  private ctl?: AbortController;
  private retry?: Timer;
  private watchdog?: Timer;
  private pullTimer?: Timer;
  private failures = 0;
  private openedAt = 0;
  private pulledAt = -Infinity;
  private clock: Clock;
  /** Each connection's number: what an older one still reads is dropped. */
  private gen = 0;
  private deps: SubscriberDeps;

  constructor(deps: SubscriberDeps, clock: Partial<Clock> = {}) {
    this.deps = deps;
    this.clock = { ...realClock, ...clock };
  }

  /** Watch `ws`: the same one carries on, another starts over (its moods and its place forgotten). */
  start(ws: string) {
    if (this.ws === ws && (this.ctl || this.retry)) return;
    this.stop();
    this.ws = ws;
    this.connect();
  }

  /** Stop watching (signing out, the app quitting). */
  stop() {
    this.gen++;
    this.ws = null;
    this.lastId = null;
    this.failures = 0;
    this.ctl?.abort();
    this.ctl = undefined;
    for (const t of [this.retry, this.watchdog, this.pullTimer]) if (t) this.clock.clearTimeout(t);
    this.retry = this.watchdog = this.pullTimer = undefined;
    this.deps.moods.clear();
  }

  watching = () => this.ws;
  /** For tests: how many connections have failed in a row. */
  failuresInARow = () => this.failures;

  private connect() {
    this.retry = undefined;
    const ws = this.ws;
    const headers = this.deps.headers();
    if (!ws || !headers) return;
    const gen = ++this.gen;
    const ctl = (this.ctl = new AbortController());
    this.openedAt = this.clock.now();
    void this.read(gen, ws, ctl, { ...headers, accept: "text/event-stream", ...(this.lastId ? { "last-event-id": this.lastId } : {}) });
  }

  private async read(gen: number, ws: string, ctl: AbortController, headers: Record<string, string>) {
    let wait: number | null = null;
    try {
      this.kick(gen, ctl);
      const res = await this.deps.fetch(this.deps.url(ws), { headers, signal: ctl.signal, cache: "no-store" });
      if (gen !== this.gen) return;
      if (!res.ok || !res.body) {
        void res.body?.cancel().catch(() => {});
        if (this.deps.revoked && [403, 404, 409].includes(res.status)) return this.revoke(gen);
        wait = res.status === 404 || res.status === 405 ? NOT_THERE_MS : res.status === 401 || res.status === 403 ? REFUSED_MS : res.status === 429 ? RECONNECT_MAX_MS : null;
        throw new Error(`live: ${res.status}`);
      }
      const dec = new TextDecoder();
      let text = "";
      for await (const chunk of res.body as unknown as AsyncIterable<Uint8Array>) {
        if (gen !== this.gen) return;
        this.kick(gen, ctl);
        text += dec.decode(chunk, { stream: true }).replace(/\r\n?/g, "\n");
        for (let i = text.indexOf("\n\n"); i >= 0; i = text.indexOf("\n\n")) {
          this.onBlock(text.slice(0, i));
          text = text.slice(i + 2);
        }
      }
    } catch {
      /* dropped, refused or unreachable: tried again below */
    }
    if (gen !== this.gen) return;
    this.ctl = undefined;
    if (this.watchdog) this.clock.clearTimeout(this.watchdog);
    this.watchdog = undefined;
    if (this.clock.now() - this.openedAt > HELD_MS) this.failures = 0;
    const backoff = Math.min(RECONNECT_MAX_MS, RECONNECT_MS * 2 ** this.failures++);
    const ms = (wait ?? backoff) * (0.5 + this.clock.random() / 2);
    this.retry = unref(this.clock.setTimeout(() => this.connect(), ms));
  }

  /** Heard from the cloud: the connection isn't dead yet. */
  private kick(gen: number, ctl: AbortController) {
    if (this.watchdog) this.clock.clearTimeout(this.watchdog);
    this.watchdog = unref(this.clock.setTimeout(() => gen === this.gen && ctl.abort(), SILENT_MS));
  }

  private onBlock(block: string) {
    let type = "message";
    let data = "";
    for (const line of block.split("\n")) {
      if (!line || line.startsWith(":")) continue;
      const at = line.indexOf(":");
      const name = at < 0 ? line : line.slice(0, at);
      const value = at < 0 ? "" : line.slice(at + 1).replace(/^ /, "");
      if (name === "event") type = value;
      else if (name === "data") data += (data ? "\n" : "") + value;
      else if (name === "id") this.lastId = value || null;
    }
    let body: Record<string, unknown>;
    try {
      body = data ? JSON.parse(data) : {};
    } catch {
      return;
    }
    const self = this.deps.self();
    if (type === "snapshot") this.deps.moods.snapshot(body as LiveSnapshot, self);
    else if (type === "mood") this.deps.moods.apply(body as Parameters<RemoteMoods["apply"]>[0], self);
    else if (type === "revoked" && this.deps.revoked) this.revoke(this.gen);
    else if (type === "reset" || (type === "state" && body.by !== self && (this.deps.wants?.(body) ?? true))) this.pullSoon();
    // Threads, routines and calls on another device reach this Mac as the state they change ("state").
  }

  /** The user may no longer watch this stream: it stops for good, and whoever started it hears so. */
  private revoke(gen: number) {
    if (gen !== this.gen) return;
    this.stop();
    this.deps.revoked?.();
  }

  private pullSoon() {
    if (this.pullTimer) return;
    const wait = Math.max(PULL_DEBOUNCE_MS, this.pulledAt + PULL_MIN_MS - this.clock.now());
    this.pullTimer = unref(
      this.clock.setTimeout(() => {
        this.pullTimer = undefined;
        this.pulledAt = this.clock.now();
        this.deps.pull();
      }, wait),
    );
  }

  /**
   * The state was just read for another reason (the tunnel said it changed): a read the stream was
   * about to make for the same write is covered, and the next waits its turn.
   */
  pulled() {
    this.pulledAt = this.clock.now();
    if (this.pullTimer) this.clock.clearTimeout(this.pullTimer);
    this.pullTimer = undefined;
  }
}

/* ---------------- What other modules tell it ---------------- */

const hooks = globalThis as unknown as { bopsLiveRoutine?: (ws: string, routineId: string, change: LiveRoutineChange) => void };

/**
 * A routine of workspace `ws` was added, changed or removed, or its run started or finished, on this Mac
 * (routines.ts). Goes to Live when it runs (live.ts); nothing otherwise. Here rather than in live.ts so
 * routines.ts needn't load the server's side of it.
 */
export const liveRoutine = (ws: string, routineId: string, change: LiveRoutineChange) => hooks.bopsLiveRoutine?.(ws, routineId, change);
/** Where liveRoutine goes (live.ts while it runs; null when it stops). */
export const onLiveRoutine = (fn: ((ws: string, routineId: string, change: LiveRoutineChange) => void) | null) => void (hooks.bopsLiveRoutine = fn ?? undefined);
