import { randomBytes } from "node:crypto";
import type { IncomingMessage, ServerResponse } from "node:http";
import type { CloudUser } from "./auth.ts";
import { HttpError, readJson, sendJson, type Route } from "./http.ts";
import { watchProject } from "./members.ts";
import {
  BOPS_DEVICE_HEADER,
  LIVE_MOOD_TTL,
  LIVE_MOODS,
  LIVE_ROUTINE_CHANGES,
  type LiveEventIn,
  type LiveEventOut,
  type LiveMood,
  type LiveSnapshot,
  type WsAccess,
} from "./protocol.ts";
import { chatIdsOf, chatWsOf, fullHash, list, OWNER_VIEW, sharedHash, sharedSlice, wsOfBot, type SliceViewer } from "./ws-slice.ts";

/**
 * Live: what each bot of a workspace is doing right now (thinking, speaking, working…), and a nudge
 * when the workspace changed, streamed to every signed-in device that watches it (protocol.ts, "Live").
 * A mood is gone a second after it happens, so none of this touches the database: it's one hub in this
 * process's memory (Bops Cloud is one process), keyed by account and workspace.
 *
 * - Watching: GET /v1/live?ws=<workspace id>, Server-Sent Events through Caddy (flush_interval -1),
 *   with a comment every 15 seconds so nothing on the way thinks it's idle. A device has one stream
 *   per account at a time in practice; at most STREAMS_PER_ACCOUNT are open for one caller and
 *   STREAMS_TOTAL in all, past which a new one is refused (429) and the device keeps polling.
 *   A workspace member watches with GET /v1/live?project=<Orgo project id> instead (members.ts): the
 *   same stream as the owner's devices, of the owner's account and the project's workspace, while
 *   orgo-web says they're a member; it ends with "revoked" once they aren't. Anyone but the owner hears
 *   only what's of the bots the owner gave them (LiveScope), worked out from the owner's state.
 * - Catching up: every event worth replaying (a thread, a routine, a call, the state) gets an id,
 *   "<boot>-<seq>", and the last 2 minutes of them are kept for each workspace watched now or within
 *   those 2 minutes (one nobody watched has nobody to catch up). A device that comes back
 *   with a Last-Event-ID in them is sent what it missed; any other (too old, or from before the cloud
 *   restarted, whose ids start over under a new boot) gets "reset" and reads the state afresh. Moods
 *   aren't replayed: every connection starts with a snapshot of them instead.
 * - Moods: each lasts its ttl (about 15 seconds) unless it's said again, so a Mac that crashed mid-reply
 *   stops showing its bot busy; one that runs out leaves the snapshot and an idle goes out.
 * - Publishing: POST /v1/live { ws, events }, small and checked strictly, only into the caller's own
 *   account, and at most PUBLISH_BUDGET events every 10 seconds for one account. The cloud itself publishes "state" after every write of the user's state or messages
 *   (state.ts), only to the workspaces whose part of it changed, so the usage ledger's churn doesn't
 *   wake anyone.
 *
 * Who may watch or publish what goes through canWatch and canPublish alone: a device of the
 * account's own user, or (watching only) a member of the workspace's Orgo project. Members never
 * publish: a publish only ever goes into the caller's own account.
 */

/** How long events are kept for a device that comes back. */
export const REPLAY_MS = 2 * 60_000;
export const HEARTBEAT_MS = 15_000;
export const STREAMS_PER_ACCOUNT = 20;
export const STREAMS_TOTAL = 5_000;
/** The most workspaces one account has in the hub at once (each with its buffer and moods). */
const WORKSPACES_PER_ACCOUNT = 50;
/** The most events kept for one workspace, however recent, and the most text all the buffers keep together. */
const RING_MAX = 500;
const RING_BYTES_TOTAL = 64 * 1024 * 1024;
/** The most events one account may publish in PUBLISH_WINDOW_MS, past which a publish is refused (429) and tried again later. */
export const PUBLISH_BUDGET = 120;
const PUBLISH_WINDOW_MS = 10_000;
/** The most bots with a mood in one workspace. */
const MOODS_MAX = 200;
/** The most a publish's body may be, and how many events it may carry. */
export const MAX_PUBLISH_BYTES = 4096;
const MAX_EVENTS = 16;
/** A stream whose client reads slower than this much is waiting to go to it is dropped (it reconnects and catches up). */
const MAX_BUFFERED = 256 * 1024;
const MAX_TTL = 60;
const ID = /^[A-Za-z0-9_:.@-]{1,120}$/;
const WS_ID = /^[A-Za-z0-9_-]{1,64}$/;
/** One workspace of one account: whose stream it is. A member watching names the owner's account. */
export type LiveTarget = { account: string; ws: string };

/**
 * Whether `caller` may watch `target`'s stream: the account's own user (any of their devices), or someone
 * orgo-web just said is the owner, an admin or a member of the Orgo project that is this workspace
 * (`access`, members.ts accessFor).
 */
export function canWatch(caller: CloudUser, target: LiveTarget, access?: WsAccess | null): boolean {
  if (caller.id === target.account) return true;
  return !!access && access.ownerUserId === target.account && access.bopsWsId === target.ws && ["owner", "admin", "member"].includes(access.role);
}

/**
 * Whether `caller` may publish `event` into `target`: only into the user's own account. Live is for the
 * user's devices: a computer's runner never opens or publishes to it (server.ts computerCheck refuses a
 * computer's token on /v1/live before this is asked, and lib/server/persist.ts keeps "live" among the
 * Mac's loops), and its routines' work reaches the devices through the "state" event its state writes
 * send (stateWritten). Letting a runner publish would take a computer route here and a check of
 * event.botId against its bots.
 */
// eslint-disable-next-line @typescript-eslint/no-unused-vars -- each event is checked on its own, though none is looked into yet
export function canPublish(caller: CloudUser, target: LiveTarget, event: LiveEventIn): boolean {
  return caller.id === target.account;
}

/* ---------------- The hub ---------------- */

/**
 * What a stream of someone other than the owner carries (members.ts watchProject): only what's of the
 * bots they see (ws-slice.ts sharedSlice for `viewer`), worked out from the owner's state when it opens
 * and again whenever that's written (stateWritten). Anything it can't tie to one of those bots isn't sent.
 */
export type LiveScope = {
  viewer: SliceViewer;
  /** The owner's whole part of the state it was worked out from (ws-slice.ts fullHash). */
  from: string;
  bots: ReadonlySet<string>;
  /** The chats they see, and every two of their bots' conversation with each other (ws-slice.ts chatIdsOf): a mood names where it's typing only when it's one of these, and a message written in one wakes them. */
  chats: ReadonlySet<string>;
  /** The routines of the bots they see (a routine's event names only the routine). */
  routines: ReadonlySet<string>;
  /** The fingerprint of what they're shown (ws-slice.ts sharedHash): what their "state" events carry. */
  hash: string;
};

/** What `viewer` may hear of workspace `ws`, from the owner's state (`from`: its part's fullHash, when that's known already). */
export function liveScope(blob: Record<string, unknown>, ws: string, viewer: SliceViewer, from = fullHash(blob, ws)): LiveScope {
  const s = sharedSlice(blob, ws, viewer);
  const ids = (items: Record<string, unknown>[]) => new Set(items.flatMap((x) => (typeof x.id === "string" ? [x.id] : [])));
  return { viewer, from, bots: ids(s.bots), chats: new Set(chatIdsOf(s)), routines: ids(s.routines), hash: sharedHash(s) };
}

/**
 * `event` as a stream held to `scope` hears it, or null when it isn't one of theirs: a mood, thread or
 * call of a bot they don't see, a routine that isn't one of their bots' (or not in the owner's state
 * yet: the "state" that follows tells them), or a kind of event this doesn't know. Everything of a bot
 * they see is theirs to hear, every thread of it included. A "state" carries the fingerprint of their
 * own view, so a copy that's still theirs isn't read again for nothing. One that says messages were
 * written (`chats`, where: messagesWritten) goes only when one of those chats is theirs, or isn't known
 * ("": a removal), so a hidden bot's chats never wake them.
 */
export function scoped(scope: LiveScope, event: LiveEventOut, chats?: readonly string[]): LiveEventOut | null {
  switch (event.type) {
    case "mood":
      if (!scope.bots.has(event.botId)) return null;
      return event.chatId === undefined || scope.chats.has(event.chatId) ? event : { ...event, chatId: undefined };
    case "session":
    case "call":
      return scope.bots.has(event.botId) ? event : null;
    case "routine":
      return scope.routines.has(event.id) ? event : null;
    case "state":
      if (event.hash !== undefined) return { ...event, hash: scope.hash };
      return !chats || chats.some((c) => c === "" || scope.chats.has(c)) ? event : null;
    default:
      return null;
  }
}

/**
 * One open stream: where its events go, and how to end it. `caller`: whose stream it counts as (a member's: theirs, not the owner's); unset, the account's.
 * `scope`: set for anyone but the owner, and then only what it allows goes to it (unset: everything, the owner's own devices).
 */
export type LiveSub = { write: (chunk: string) => void; end: () => void; caller?: string; scope?: LiveScope };
type Mood = { mood: LiveMood; chatId?: string; by: string; expiresAt: number; ttl: number };
type Entry = {
  account: string;
  ws: string;
  subs: Set<LiveSub>;
  /** Events worth replaying, oldest first, how much of their SSE text each is, and the chats a message write's was about (never sent). */
  ring: { seq: number; at: number; event: LiveEventOut; bytes: number; chats?: readonly string[] }[];
  /** The newest seq gone from the ring (or from before this entry): a device that has seen less missed something. */
  droppedThrough: number;
  moods: Map<string, Mood>;
  touched: number;
  /** When a stream of it was last open (-Infinity: never). */
  watchedAt: number;
};
export type OpenResult = "ok" | "account_full" | "full";

/** An event as a stream carries it. */
export const sse = (type: string, data: unknown, id?: string) => `${id ? `id: ${id}\n` : ""}event: ${type}\ndata: ${JSON.stringify(data)}\n\n`;

export class LiveHub {
  /** Different every start, so an id from before a restart never passes for one of now. */
  readonly boot: string;
  /** Per account: each watched workspace's slice as last written, and which workspace each chat is in (stateWritten). Gone with the account's last workspace here. */
  readonly seen = new Map<string, { hashes: Map<string, string>; chats: Map<string, string> }>();
  private seq = 0;
  /** How many times any account's state has been written (stateWritten): a member's stream worked out over a read one landed during is worked out again (members.ts). */
  written = 0;
  /** Each account's workspaces in the hub, by workspace id. */
  private accounts = new Map<string, Map<string, Entry>>();
  private streams = new Map<string, number>();
  private total = 0;
  /** What all the buffers hold, in characters of their text. */
  private ringBytes = 0;
  /** Per account: since when it's been publishing, and how many events. */
  private budgets = new Map<string, { from: number; n: number }>();
  private now: () => number;
  private timer?: ReturnType<typeof setInterval>;
  private limits: { perAccount: number; total: number; ringBytes: number };

  constructor(opts: { now?: () => number; boot?: string; perAccount?: number; total?: number; ringBytes?: number } = {}) {
    this.now = opts.now ?? Date.now;
    this.boot = opts.boot ?? `${Date.now().toString(36)}${randomBytes(3).toString("hex")}`;
    this.limits = { perAccount: opts.perAccount ?? STREAMS_PER_ACCOUNT, total: opts.total ?? STREAMS_TOTAL, ringBytes: opts.ringBytes ?? RING_BYTES_TOTAL };
  }

  private entry(t: LiveTarget, make: boolean): Entry | undefined {
    let mine = this.accounts.get(t.account);
    let e = mine?.get(t.ws);
    if (!e && make) {
      if ((mine?.size ?? 0) >= WORKSPACES_PER_ACCOUNT) return undefined;
      if (!mine) this.accounts.set(t.account, (mine = new Map()));
      e = { account: t.account, ws: t.ws, subs: new Set(), ring: [], droppedThrough: this.seq, moods: new Map(), touched: this.now(), watchedAt: -Infinity };
      mine.set(t.ws, e);
      this.startTimer();
    }
    return e;
  }

  /** Whether someone watches `e`, or did within REPLAY_MS: only then is an event kept for a device that comes back. */
  private listening = (e: Entry, now: number) => e.subs.size > 0 || now - e.watchedAt <= REPLAY_MS;

  /** Whether one more stream for `target` would be refused, and why. Streams are counted by `caller`, so members can't use up the owner's. */
  wouldRefuse(target: LiveTarget, caller = target.account): OpenResult {
    if ((this.streams.get(caller) ?? 0) >= this.limits.perAccount) return "account_full";
    if (this.total >= this.limits.total) return "full";
    const mine = this.accounts.get(target.account);
    if (!mine?.has(target.ws) && (mine?.size ?? 0) >= WORKSPACES_PER_ACCOUNT) return "account_full";
    return "ok";
  }

  /**
   * Start a stream for `target`: the moods as they are now, then what it missed since `lastEventId` when
   * that can be told, else "reset" (with the id it goes on from).
   */
  open(target: LiveTarget, sub: LiveSub, lastEventId: string | null): OpenResult {
    const caller = sub.caller ?? target.account;
    const refused = this.wouldRefuse(target, caller);
    if (refused !== "ok") return refused;
    const e = this.entry(target, true);
    if (!e) return "account_full";
    const now = this.now();
    this.expire(e, now);
    e.subs.add(sub);
    e.touched = e.watchedAt = now;
    this.streams.set(caller, (this.streams.get(caller) ?? 0) + 1);
    this.total++;
    sub.write(sse("snapshot", this.snapshot(e, sub.scope)));
    const from = this.seqOf(lastEventId);
    if (from !== null && from >= e.droppedThrough)
      for (const x of e.ring) {
        const seen = x.seq > from && (sub.scope ? scoped(sub.scope, x.event, x.chats) : x.event);
        if (seen) sub.write(sse(seen.type, seen, `${this.boot}-${x.seq}`));
      }
    if (from === null || from < e.droppedThrough) sub.write(sse("reset", {}, `${this.boot}-${this.seq}`));
    return "ok";
  }

  /** The seq an id from this start stands for, or null (none, malformed, from before a restart, or ahead of now). */
  private seqOf(id: string | null): number | null {
    const m = /^([a-z0-9]+)-(\d{1,15})$/.exec(id?.trim() ?? "");
    if (!m || m[1] !== this.boot) return null;
    const n = Number(m[2]);
    return n <= this.seq ? n : null;
  }

  close(target: LiveTarget, sub: LiveSub) {
    const e = this.entry(target, false);
    if (!e || !e.subs.delete(sub)) return;
    e.touched = e.watchedAt = this.now();
    const caller = sub.caller ?? target.account;
    const n = (this.streams.get(caller) ?? 1) - 1;
    if (n > 0) this.streams.set(caller, n);
    else this.streams.delete(caller);
    this.total--;
  }

  /** The moods as they are now, held to `scope` when there is one: only its bots', and where they type only when it's a chat of theirs. */
  private snapshot(e: Entry, scope?: LiveScope): LiveSnapshot {
    const now = this.now();
    return {
      moods: [...e.moods]
        .filter(([botId]) => !scope || scope.bots.has(botId))
        .map(([botId, m]) => ({ botId, ...(m.chatId && (!scope || scope.chats.has(m.chatId)) ? { chatId: m.chatId } : {}), mood: m.mood, ttl: Math.max(1, Math.round((m.expiresAt - now) / 1000)), by: m.by })),
    };
  }

  /** `event` to each of `e`'s streams (its SSE text `chunk`, with `id`), each held to its own scope (`chats`: as scoped takes them). */
  private send(e: Entry, event: LiveEventOut, chunk: string, id?: string, chats?: readonly string[]) {
    for (const s of e.subs) {
      const seen = s.scope ? scoped(s.scope, event, chats) : event;
      if (!seen) continue;
      try {
        s.write(seen === event ? chunk : sse(seen.type, seen, id));
      } catch {
        /* the stream's own close takes it out */
      }
    }
  }

  /**
   * The owner's state was written: each stream of `target` held to a scope worked out from an older one
   * (`full`, its part now) is worked out again from `blob`, once for each viewer.
   */
  rescope(target: LiveTarget, blob: Record<string, unknown>, full: string) {
    const e = this.entry(target, false);
    if (!e) return;
    const done = new Map<string, LiveScope>();
    for (const s of e.subs) {
      if (!s.scope || s.scope.from === full) continue;
      const v = s.scope.viewer;
      const key = `${v.role}\0${v.email ?? ""}\0${v.id}`;
      let next = done.get(key);
      if (!next) done.set(key, (next = liveScope(blob, target.ws, v, full)));
      s.scope = next;
    }
  }

  /**
   * Whether `account` may publish `n` more events now: PUBLISH_BUDGET in each PUBLISH_WINDOW_MS (its Macs
   * say each busy bot's mood every 5 seconds, and their threads as they move). Counted when it may.
   */
  allow(account: string, n: number): boolean {
    const now = this.now();
    let b = this.budgets.get(account);
    if (!b || now - b.from >= PUBLISH_WINDOW_MS) this.budgets.set(account, (b = { from: now, n: 0 }));
    if (b.n + n > PUBLISH_BUDGET) return false;
    b.n += n;
    return true;
  }

  /**
   * Publish an event to `target`'s streams. A mood is kept for the next stream's snapshot; any other is
   * kept for replay only while someone watches the workspace or did lately, and goes nowhere otherwise.
   * `chats`: the chats a "state" for messages written is about, kept here to hold it to each stream's
   * scope and never sent. False when the account has too many workspaces in the hub already.
   */
  publish(target: LiveTarget, event: LiveEventOut, chats?: readonly string[]): boolean {
    const now = this.now();
    if (event.type !== "mood") {
      const e = this.entry(target, false);
      if (!e || !this.listening(e, now)) return true;
      e.touched = now;
      const seq = ++this.seq;
      const id = `${this.boot}-${seq}`;
      const chunk = sse(event.type, event, id);
      e.ring.push({ seq, at: now, event, bytes: chunk.length, ...(chats ? { chats } : {}) });
      this.ringBytes += chunk.length;
      let drop = Math.max(0, e.ring.length - RING_MAX);
      // Past what the hub holds in all, the buffer being added to gives up its oldest (a device coming back to it is reset).
      for (let over = this.ringBytes - this.limits.ringBytes; over > 0 && drop < e.ring.length - 1; drop++) over -= e.ring[drop].bytes;
      this.cut(e, drop);
      this.send(e, event, chunk, id, chats);
      return true;
    }
    const e = this.entry(target, true);
    if (!e) return false;
    e.touched = now;
    if (event.mood === "idle") {
      e.moods.delete(event.botId);
      const idle = { ...event, ttl: undefined };
      this.send(e, idle, sse("mood", idle));
      return true;
    }
    if (!e.moods.has(event.botId) && e.moods.size >= MOODS_MAX) return true;
    const ttl = Math.min(MAX_TTL, Math.max(1, Math.round(event.ttl ?? LIVE_MOOD_TTL)));
    e.moods.set(event.botId, { mood: event.mood, ...(event.chatId ? { chatId: event.chatId } : {}), by: event.by, ttl, expiresAt: now + ttl * 1000 });
    // A mood isn't replayed (the snapshot has it), so it carries no id.
    const said = { ...event, ttl };
    this.send(e, said, sse("mood", said));
    return true;
  }

  /** The oldest `n` events leave `e`'s buffer. */
  private cut(e: Entry, n: number) {
    if (n <= 0) return;
    const gone = e.ring.splice(0, n);
    for (const x of gone) this.ringBytes -= x.bytes;
    e.droppedThrough = gone.at(-1)!.seq;
  }

  /** `e`'s moods past their ttl go, an idle going out for each. */
  private expire(e: Entry, now: number) {
    for (const [botId, m] of e.moods)
      if (m.expiresAt <= now) {
        e.moods.delete(botId);
        const idle: LiveEventOut = { type: "mood", botId, ...(m.chatId ? { chatId: m.chatId } : {}), mood: "idle", by: m.by, at: now };
        this.send(e, idle, sse("mood", idle));
      }
  }

  /**
   * Moods past their ttl go (an idle goes out for each), events older than REPLAY_MS leave the buffer,
   * workspaces nobody's used go, and with an account's last one so does what was seen of its state.
   */
  sweep() {
    const now = this.now();
    for (const [account, mine] of this.accounts) {
      for (const [ws, e] of mine) {
        this.expire(e, now);
        let cut = 0;
        while (cut < e.ring.length && now - e.ring[cut].at > REPLAY_MS) cut++;
        this.cut(e, cut);
        if (!e.subs.size && !e.moods.size && !e.ring.length && now - e.touched > REPLAY_MS) mine.delete(ws);
      }
      if (!mine.size) {
        this.accounts.delete(account);
        this.seen.delete(account);
      }
    }
    for (const [account, b] of this.budgets) if (now - b.from >= PUBLISH_WINDOW_MS) this.budgets.delete(account);
    if (!this.accounts.size) this.stopTimer();
  }

  /** The workspaces of `account` someone watches now, or did within REPLAY_MS (a device that comes back is sent what changed meanwhile), a member included. */
  watched(account: string): string[] {
    const now = this.now();
    return [...(this.accounts.get(account)?.values() ?? [])].filter((e) => this.listening(e, now)).map((e) => e.ws);
  }

  /** The streams open as `caller`'s (their own account's, and the workspaces they watch as a member). */
  streamsOf = (caller: string) => this.streams.get(caller) ?? 0;
  openCount = () => this.total;

  private startTimer() {
    if (this.timer || this.now !== Date.now) return;
    this.timer = setInterval(() => this.sweep(), 1000);
    this.timer.unref?.();
  }
  private stopTimer() {
    if (this.timer) clearInterval(this.timer);
    this.timer = undefined;
  }

  /**
   * The account's user was deleted (delete-user.ts): every stream of its workspaces ends (the user's own
   * devices and the members watching them), so does every stream they had open of someone else's as a
   * member, and what the hub kept of the account (moods, buffered events, its state's fingerprints)
   * goes. Nobody comes back in: the user's sign-in is turned down, and a member reads no workspace of
   * theirs (there's no state). How many streams ended.
   */
  closeAccount(account: string): number {
    let ended = 0;
    for (const mine of this.accounts.values())
      for (const e of mine.values())
        for (const s of [...e.subs]) {
          if (e.account !== account && s.caller !== account) continue;
          try {
            s.end();
          } catch {}
          this.close(e, s);
          ended++;
        }
    for (const e of this.accounts.get(account)?.values() ?? []) this.cut(e, e.ring.length);
    this.accounts.delete(account);
    this.seen.delete(account);
    this.budgets.delete(account);
    return ended;
  }

  /** End every stream (the cloud stopping): each device reconnects to the next start and is reset. */
  closeAll() {
    for (const mine of this.accounts.values())
      for (const e of mine.values())
        for (const s of [...e.subs]) {
          try {
            s.end();
          } catch {}
          this.close(e, s);
        }
    this.stopTimer();
  }
}

export const hub = new LiveHub();
export const closeAll = () => hub.closeAll();

/* ---------------- Checking what's published ---------------- */

const isObject = (v: unknown): v is Record<string, unknown> => !!v && typeof v === "object" && !Array.isArray(v);
const idOk = (v: unknown): v is string => typeof v === "string" && ID.test(v);
const only = (o: Record<string, unknown>, keys: string[]) => Object.keys(o).every((k) => keys.includes(k));

/** One published event, checked: the exact shape of its type, or a 400. */
export function eventOf(v: unknown): LiveEventIn {
  const bad = (why: string): never => {
    throw new HttpError(400, `Bad live event: ${why}`);
  };
  if (!isObject(v)) return bad("not an object");
  switch (v.type) {
    case "mood":
      if (!only(v, ["type", "botId", "chatId", "mood", "ttl"])) return bad("unknown field");
      if (!idOk(v.botId)) return bad("botId");
      if (v.chatId !== undefined && !idOk(v.chatId)) return bad("chatId");
      if (!LIVE_MOODS.includes(v.mood as LiveMood)) return bad("mood");
      if (v.ttl !== undefined && !(typeof v.ttl === "number" && Number.isFinite(v.ttl) && v.ttl > 0 && v.ttl <= MAX_TTL)) return bad("ttl");
      return { type: "mood", botId: v.botId, mood: v.mood as LiveMood, ...(v.chatId !== undefined ? { chatId: v.chatId as string } : {}), ...(v.ttl !== undefined ? { ttl: v.ttl as number } : {}) };
    case "session":
      if (!only(v, ["type", "id", "botId", "status", "activity"])) return bad("unknown field");
      if (!idOk(v.id) || !idOk(v.botId)) return bad("id or botId");
      if (typeof v.status !== "string" || !/^[a-z]{1,20}$/.test(v.status)) return bad("status");
      if (v.activity !== undefined && !(typeof v.activity === "string" && v.activity.length <= 120)) return bad("activity");
      return { type: "session", id: v.id, botId: v.botId, status: v.status, ...(v.activity !== undefined ? { activity: v.activity as string } : {}) };
    case "routine":
      if (!only(v, ["type", "id", "change"])) return bad("unknown field");
      if (!idOk(v.id)) return bad("id");
      if (!LIVE_ROUTINE_CHANGES.includes(v.change as never)) return bad("change");
      return { type: "routine", id: v.id, change: v.change as (typeof LIVE_ROUTINE_CHANGES)[number] };
    case "call":
      if (!only(v, ["type", "botId", "on"])) return bad("unknown field");
      if (!idOk(v.botId) || typeof v.on !== "boolean") return bad("botId or on");
      return { type: "call", botId: v.botId, on: v.on };
    default:
      return bad("type");
  }
}

/** A publish's body, checked: a workspace id and 1 to MAX_EVENTS events. */
export function publishOf(body: unknown): { ws: string; events: LiveEventIn[] } {
  if (!isObject(body) || !only(body, ["ws", "events"])) throw new HttpError(400, "Send { ws, events }");
  if (typeof body.ws !== "string" || !WS_ID.test(body.ws)) throw new HttpError(400, "ws must be a workspace id");
  if (!Array.isArray(body.events) || !body.events.length || body.events.length > MAX_EVENTS) throw new HttpError(400, `events must be 1 to ${MAX_EVENTS} events`);
  return { ws: body.ws, events: body.events.map(eventOf) };
}

/** Which device a call came from (BOPS_DEVICE_HEADER), as an event names its publisher. */
function byOf(req: IncomingMessage): string {
  const v = req.headers[BOPS_DEVICE_HEADER];
  const s = (Array.isArray(v) ? v[0] : v)?.trim() ?? "";
  return /^[A-Za-z0-9_-]{1,64}$/.test(s) ? s : "app";
}

/** The stream a call asks for: `ws`, in the caller's own account (a member's names a project instead: members.ts watchProject). */
function targetOf(user: CloudUser, url: URL): LiveTarget {
  const ws = url.searchParams.get("ws") ?? "";
  if (!WS_ID.test(ws)) throw new HttpError(400, "ws must be a workspace id");
  return { account: user.id, ws };
}

/* ---------------- What changed in the state (state.ts) ---------------- */

/**
 * One workspace's fingerprint as "state" events carry it: of what the owner is shown of it through
 * GET /v1/ws/:projectId/state (ws-slice.ts). A stream held to a scope carries its viewer's own instead (scoped).
 */
export const sliceHash = (blob: Record<string, unknown>, ws: string) => sharedHash(sharedSlice(blob, ws, OWNER_VIEW));

/** Which workspace each chat of the blob is in, a pair of bots' own conversation ("bot:<id>") its bot's. */
function chatsOf(blob: Record<string, unknown>): Map<string, string> {
  const chats = new Map<string, string>();
  const byId = new Map(list(blob.bots).map((b) => [b.id, b]));
  const chatWs = chatWsOf(byId);
  for (const c of list(blob.chats)) if (typeof c.id === "string") chats.set(c.id, chatWs(c));
  for (const [id, b] of byId) chats.set(`bot:${String(id)}`, wsOfBot(b));
  return chats;
}

/**
 * The user's state was written (`by` the device that wrote it): every watched workspace whose part of it
 * changed hears "state", with the fingerprint of what it shows (sliceHash, and each member's stream its
 * member's own; one whose copy has it already needn't read it again). Whether it changed is told from the
 * whole part, so the owner's other Macs hear of a change members aren't shown too. First, each member's
 * stream is held to what the state now gives them (LiveHub.rescope). Nothing is worked out while nobody watches.
 */
export function stateWritten(account: string, blob: Record<string, unknown>, by: string | null, h: LiveHub = hub) {
  h.written++;
  const watched = h.watched(account);
  if (!watched.length) return void h.seen.delete(account);
  const prev = h.seen.get(account);
  const hashes = new Map<string, string>();
  for (const ws of watched) {
    const full = fullHash(blob, ws);
    hashes.set(ws, full);
    h.rescope({ account, ws }, blob, full);
    if (prev?.hashes.get(ws) !== full) h.publish({ account, ws }, { type: "state", hash: sliceHash(blob, ws), by: by ?? "cloud", at: Date.now() });
  }
  h.seen.set(account, { hashes, chats: chatsOf(blob) });
}

/**
 * A member read the owner's state (members.ts): with nothing seen of it since the cloud started, which
 * workspace each chat is in is known from here on, so a message in one goes to its workspace alone
 * (messagesWritten) and not to every watched one. Nothing is published.
 */
export function seedSeen(account: string, blob: Record<string, unknown>, h: LiveHub = hub) {
  if (h.seen.has(account) || !h.watched(account).length) return;
  h.seen.set(account, { hashes: new Map(h.watched(account).map((ws) => [ws, fullHash(blob, ws)])), chats: chatsOf(blob) });
}

/**
 * Messages were written into these chats ("" for one not known, a removal): their workspaces hear
 * "state" with the newest seq. A chat not known yet (none of the blob seen since the cloud started, or
 * two bots' own conversation) is told to every watched workspace of the account. A member's stream hears
 * it only when one of the chats is theirs (scoped).
 */
export function messagesWritten(account: string, chatIds: string[], seq: number | null, by: string | null, h: LiveHub = hub) {
  const watched = h.watched(account);
  if (!watched.length) return;
  const chats = h.seen.get(account)?.chats;
  const to = new Set<string>();
  for (const c of chatIds) {
    const ws = chats?.get(c);
    if (ws) to.add(ws);
    else for (const w of watched) to.add(w);
  }
  for (const ws of to) if (watched.includes(ws)) h.publish({ account, ws }, { type: "state", ...(seq !== null ? { seq } : {}), by: by ?? "cloud", at: Date.now() }, chatIds);
}

/** For tests: forget what was seen of each account's state. */
export const forgetSeen = () => hub.seen.clear();

/* ---------------- Routes ---------------- */

/**
 * What a member's stream has besides an owner's (members.ts): whose it counts as, a look every `every` ms
 * at whether they may still watch (false: "revoked" goes out and it ends; null: Orgo couldn't say, so it
 * carries on; "end": it ends without "revoked", and coming back asks again), and where its end is kept so orgo-web's notice can end it (`track`, which gives back its undoing).
 * `scope`: what it may carry, for anyone but the owner (LiveSub.scope).
 */
export type StreamOpts = { caller?: string; every?: number; still?: () => Promise<boolean | null | "end">; track?: (end: () => void) => () => void; scope?: LiveScope };

/** A stream for `target` on `res`, until either end closes it, and its place in the hub (undefined: gone before it opened). Exported for tests (a fake response). */
export function serveStream(req: IncomingMessage, res: ServerResponse, target: LiveTarget, h: LiveHub = hub, opts: StreamOpts = {}): LiveSub | undefined {
  // Gone while the key was being checked: its close has been and gone, so nothing would ever free its place.
  if (res.destroyed || res.socket?.destroyed) return;
  const refused = h.wouldRefuse(target, opts.caller);
  if (refused !== "ok") throw new HttpError(429, refused === "account_full" ? "Too many live streams open for this account" : "Too many live streams open", { code: "live_full" });
  res.writeHead(200, {
    "content-type": "text/event-stream; charset=utf-8",
    "cache-control": "no-cache, no-transform",
    connection: "keep-alive",
    // Nothing on the way holds the events back (Caddy flushes at once: cloud/deploy/Caddyfile.template).
    "x-accel-buffering": "no",
  });
  res.flushHeaders?.();
  let done = false;
  const sub: LiveSub = {
    write: (chunk) => {
      if (done) return;
      // A client this far behind is dropped, its connection cut (an end would wait behind what it isn't
      // reading, holding the socket and all of that): it reconnects and catches up from its last id.
      if (res.writableLength > MAX_BUFFERED) return end(true);
      res.write(chunk);
    },
    end: () => end(),
    ...(opts.caller ? { caller: opts.caller } : {}),
    ...(opts.scope ? { scope: opts.scope } : {}),
  };
  const beat = setInterval(() => sub.write(": hb\n\n"), HEARTBEAT_MS);
  beat.unref?.();
  let looking = false;
  const look = opts.still
    ? setInterval(() => {
        if (looking || done) return;
        looking = true;
        void opts.still!()
          .then((ok) => {
            if (done || ok === true || ok === null) return;
            if (ok === false) sub.write(sse("revoked", {}));
            end();
          })
          .catch(() => {})
          .finally(() => (looking = false));
      }, opts.every ?? 60_000)
    : undefined;
  look?.unref?.();
  const untrack = opts.track?.(() => end());
  function end(cut = false) {
    if (done) return;
    done = true;
    clearInterval(beat);
    if (look) clearInterval(look);
    untrack?.();
    h.close(target, sub);
    if (cut) res.destroy();
    else if (!res.writableEnded) res.end();
  }
  req.on("close", end);
  res.on("close", end);
  res.on("error", end);
  const lastId = req.headers["last-event-id"];
  h.open(target, sub, (Array.isArray(lastId) ? lastId[0] : lastId) ?? null);
  return sub;
}

const watch: Route = {
  method: "GET",
  path: "/v1/live",
  auth: "user",
  handle: async (req, res, { user, url }) => {
    if (url.searchParams.has("project")) return watchProject(req, res, user!, url);
    const target = targetOf(user!, url);
    if (!canWatch(user!, target)) throw new HttpError(403, "You can't watch this workspace");
    serveStream(req, res, target);
  },
};

const publish: Route = {
  method: "POST",
  path: "/v1/live",
  auth: "user",
  handle: async (req, res, { user }) => {
    const { ws, events } = publishOf(await readJson(req, MAX_PUBLISH_BYTES));
    const target: LiveTarget = { account: user!.id, ws };
    const by = byOf(req);
    for (const ev of events) if (!canPublish(user!, target, ev)) throw new HttpError(403, "You can't publish this here");
    if (!hub.allow(user!.id, events.length)) throw new HttpError(429, "Too many live events from this account; try again in a few seconds", { code: "live_busy" });
    const at = Date.now();
    for (const ev of events) if (!hub.publish(target, { ...ev, by, at })) throw new HttpError(429, "Too many workspaces live for this account", { code: "live_full" });
    sendJson(res, 200, { ok: true });
  },
};

export const routes: Route[] = [watch, publish];
