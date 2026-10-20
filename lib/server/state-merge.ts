import { createHash } from "node:crypto";

/**
 * The state as Bops Cloud keeps it (lib/server/persist-cloud.ts), and putting two Macs' changes
 * together. Pure functions, no server: the tests run them directly.
 *
 * In the cloud a user's state is a blob (everything but the messages, which are rows of their own)
 * shared by every Mac they sign in on. Some of it is this Mac's alone, kept in the blob under
 * `macs[deviceId]` and lifted to the top level in memory (PER_MAC); some never leaves this Mac at all
 * (NEVER_SYNCED, and each bot's appsKey and each chat's typing and asking).
 */

export type Blob = Record<string, unknown>;

/**
 * This Mac's own, under macs[deviceId] in the blob: routing through it, whether bots can work on it
 * (state.mac), its setup, and the apps the bots made on it (their code and data are files on this Mac,
 * made-apps.ts, so another Mac couldn't open them).
 */
export const PER_MAC = ["relay", "relayRoutes", "mac", "setup", "madeApps"] as const;
/** Never in the cloud: who's signed in here, what's on screen right now, what waits on a live bot. */
export const NEVER_SYNCED = ["account", "screens", "takeover", "connecting", "appApprovals", "screenStream", "cloudUser", "messages", "macs"] as const;
/** The newest usage events kept, as lib/server/usage.ts keeps them. */
const MAX_USAGE = 20_000;

/** JSON with every object's keys in order, so the same content is the same text (Postgres' JSONB reorders keys). */
export function canonical(v: unknown): string {
  return JSON.stringify(v, (_k, x) => (x && typeof x === "object" && !Array.isArray(x) ? Object.fromEntries(Object.keys(x).sort().map((k) => [k, (x as Blob)[k]])) : x));
}
export const hashOf = (v: unknown) => createHash("sha256").update(canonical(v)).digest("base64url").slice(0, 22);
export const same = (a: unknown, b: unknown) => a === b || canonical(a) === canonical(b);

const isObject = (v: unknown): v is Blob => !!v && typeof v === "object" && !Array.isArray(v);
const withIds = (v: unknown): v is { id: string }[] => Array.isArray(v) && v.length > 0 && v.every((x) => isObject(x) && typeof x.id === "string");

/** The blob for the cloud from the state in memory: no messages, nothing NEVER_SYNCED, this Mac's own under macs[device]. */
export function toShared(state: Blob, device: string): Blob {
  const out: Blob = {};
  for (const [k, v] of Object.entries(state)) if (v !== undefined && !(NEVER_SYNCED as readonly string[]).includes(k) && !(PER_MAC as readonly string[]).includes(k)) out[k] = v;
  if (Array.isArray(state.bots)) out.bots = state.bots.map((b: Blob) => strip(b, ["appsKey"]));
  if (Array.isArray(state.chats)) out.chats = state.chats.map((c: Blob) => strip(c, ["typing", "asking"]));
  const mine: Blob = {};
  for (const k of PER_MAC) if (state[k] !== undefined) mine[k] = state[k];
  // Full access is this Mac's alone, kept here (full-access.ts): never in the cloud.
  if (isObject(mine.mac)) mine.mac = strip(mine.mac, ["fullAccess"]);
  const macs: Blob = { ...(isObject(state.macs) ? state.macs : {}) };
  if (Object.keys(mine).length) macs[device] = mine;
  else delete macs[device];
  if (Object.keys(macs).length) out.macs = macs;
  // (It shares objects with the state: serialize it before anything changes.)
  return out;
}

const strip = (o: Blob, keys: string[]) => Object.fromEntries(Object.entries(o).filter(([k]) => !keys.includes(k)));

/** The state in memory from a blob: this Mac's own lifted back to the top level (the other Macs' stay under macs). */
export function fromShared(blob: Blob, device: string): Blob {
  const out: Blob = { ...blob };
  for (const k of NEVER_SYNCED) if (k !== "macs") delete out[k];
  const mine = isObject(blob.macs) && isObject(blob.macs[device]) ? blob.macs[device] : {};
  for (const k of PER_MAC) out[k] = mine[k];
  // ...and never taken from it: nothing in the cloud may turn it on.
  if (isObject(out.mac)) out.mac = strip(out.mac, ["fullAccess"]);
  return out;
}

/**
 * Two Macs' changes put together: `mine` and `theirs` both started from `base` (the last blob this
 * Mac synced; null when it has none). A key changed on one side only takes that side. Where both
 * changed it:
 * - lists of things with ids (bots, chats, sessions, routines, watches, workspaces, accounts, vault…)
 *   go thing by thing: one changed here keeps this Mac's copy, one removed on either side (and not
 *   changed on the other) goes, one added on either side stays; this Mac's order, the others' new
 *   ones after. A routine changed on both sides goes field by field, its clock as one (mergeRoutine);
 *   a thread is the copy of the Bops that runs it, with the replies and steps of both (mergeSession);
 *   anything else changed on both keeps this Mac's copy whole, as its fields go together (a watch's
 *   alert and what it was told);
 * - usage is both ledgers together; macs, and any other object, key by key;
 * - anything else is this Mac's.
 * `me`: which Bops is merging (its device id, and whether it's a computer's runner), so a thread
 * changed on both sides goes by the one that runs it (Session.by); without it, by this Mac's copy.
 */
export function merge3(base: Blob | null, mine: Blob, theirs: Blob, me?: Me): Blob {
  return mergeObject(base ?? {}, mine, theirs, true, me);
}

type Me = { device: string; runner?: boolean };

function mergeObject(base: Blob, mine: Blob, theirs: Blob, top = false, me?: Me): Blob {
  const out: Blob = {};
  for (const k of new Set([...Object.keys(mine), ...Object.keys(theirs), ...Object.keys(base)])) {
    const v = mergeValue(k, base[k], mine[k], theirs[k], top, me);
    if (v !== undefined) out[k] = v;
  }
  return out;
}

function mergeValue(key: string, b: unknown, m: unknown, t: unknown, top: boolean, me?: Me): unknown {
  if (same(m, t)) return m;
  if (same(m, b)) return t;
  if (same(t, b)) return m;
  // Both changed it.
  if (top && key === "usage" && Array.isArray(m) && Array.isArray(t)) return usageOf(m, t);
  if ((withIds(m) || withIds(t) || withIds(b)) && (Array.isArray(m) || m === undefined) && (Array.isArray(t) || t === undefined)) {
    const both = top && key === "routines" ? mergeRoutine : top && key === "sessions" ? (was: Blob, x: Blob, y: Blob) => mergeSession(was, x, y, me) : undefined;
    return mergeById(Array.isArray(b) ? b : [], (m as { id: string }[]) ?? [], (t as { id: string }[]) ?? [], both);
  }
  if (isObject(m) && isObject(t)) return mergeObject(isObject(b) ? b : {}, m, t);
  return m;
}

/** `both`: how one changed on both sides goes together; without it, this Mac's copy. */
function mergeById(base: { id: string }[], mine: { id: string }[], theirs: { id: string }[], both?: (was: Blob, mine: Blob, theirs: Blob) => Blob) {
  const b = new Map(base.map((x) => [x.id, x]));
  const t = new Map(theirs.map((x) => [x.id, x]));
  const m = new Map(mine.map((x) => [x.id, x]));
  const out: { id: string }[] = [];
  for (const x of mine) {
    const was = b.get(x.id);
    const other = t.get(x.id);
    if (other) out.push(was && same(x, was) ? other : was && both && !same(other, was) ? (both(was as Blob, x as Blob, other as Blob) as { id: string }) : x);
    // Gone on their side: gone here too, unless this Mac changed it since (or added it).
    else if (!was || !same(x, was)) out.push(x);
  }
  // Theirs that this Mac hasn't got: new there (kept), or removed here (gone).
  for (const x of theirs) if (!m.has(x.id) && !b.has(x.id)) out.push(x);
  return out;
}

/**
 * A routine's clock (routines.ts tick and record): its next and last times, how its last run went, a late
 * run, how far a meeting routine got.
 */
const CLOCK = ["nextRunAt", "lastRunAt", "last", "lateRun", "eventsThrough"] as const;

/**
 * A routine changed on both sides (a pause or an edit on this Mac while a computer's runner ran it, or
 * the other way): field by field, and the clock as one, from the side that ran it last (the later
 * lastRunAt), so the edit stays and so does the run, and an edit made offline never brings back a time
 * that already ran. The times it's skipping are the user's: one skipped on either side stays (one taken
 * back on either side goes), until it has passed; a next time that's one of them is moved past it by the
 * routines timer before it comes due (routines.ts tick). Paused on either side: no next time, nothing
 * skipped (routines.ts setRoutineEnabled).
 */
function mergeRoutine(base: Blob, mine: Blob, theirs: Blob): Blob {
  const out = mergeObject(base, mine, theirs);
  const ran = (x: Blob) => (typeof x.lastRunAt === "number" ? x.lastRunAt : 0);
  if (ran(mine) !== ran(theirs)) {
    const from = ran(theirs) > ran(mine) ? theirs : mine;
    for (const k of CLOCK) {
      if (from[k] === undefined) delete out[k];
      else out[k] = from[k];
    }
  }
  const times = (x: Blob) => new Set(Array.isArray(x.skips) ? (x.skips as unknown[]).filter((t): t is number => typeof t === "number") : []);
  const [b, m, t] = [times(base), times(mine), times(theirs)];
  const skips = [...new Set([...m, ...t])].filter((x) => !(b.has(x) && (!m.has(x) || !t.has(x))) && x > ran(out)).sort((x, y) => x - y);
  if (skips.length) out.skips = skips;
  else delete out.skips;
  if (out.enabled === false) {
    delete out.nextRunAt;
    delete out.skips;
  }
  return out;
}

/** What another Bops than the one that runs a thread may change in it and keep: a stop it asked for (sessions.ts stopSession). */
const ASKED_ELSEWHERE = ["stopAsked"] as const;

/**
 * A thread changed on both sides (the user replied on the Mac while a computer's runner worked on it, or
 * the other way): the copy of the Bops that runs it (Session.by, or the side that just picked it up), as
 * its fields go together (its status and its screen, its answer, what it waits on), with the replies of
 * both, each reply field by field (the one that runs it marks them taken in), the steps of both, and a
 * stop asked from elsewhere (stopAsked).
 */
function mergeSession(base: Blob, mine: Blob, theirs: Blob, me?: Me): Blob {
  const [runs, other] = runsIt(base, mine, theirs, me) ? [mine, theirs] : [theirs, mine];
  const out: Blob = { ...runs };
  const list = (x: Blob, k: string) => (Array.isArray(x[k]) ? (x[k] as Blob[]) : []);
  if (!same(other.replies, base.replies))
    out.replies = mergeById(list(base, "replies") as { id: string }[], list(runs, "replies") as { id: string }[], list(other, "replies") as { id: string }[], (was, a, b) => mergeObject(was, a, b));
  const seen = new Set([...list(base, "steps"), ...list(runs, "steps")].map((x) => canonical(x)));
  const added = list(other, "steps").filter((x) => !seen.has(canonical(x)));
  if (added.length) out.steps = [...list(runs, "steps"), ...added].sort((x, y) => (Number(x.at) || 0) - (Number(y.at) || 0));
  for (const k of ASKED_ELSEWHERE) {
    if (same(other[k], base[k]) || !same(runs[k], base[k])) continue;
    if (other[k] === undefined) delete out[k];
    else out[k] = other[k];
  }
  return out;
}

/** Whether this side's copy of a thread is the one that runs it: this Bops's own (store.ts ownSession), unless the other side picked it up since. */
function runsIt(base: Blob, mine: Blob, theirs: Blob, me?: Me): boolean {
  const by = (x: Blob) => (typeof x.by === "string" ? x.by : undefined);
  const [b, m, t] = [by(base), by(mine), by(theirs)];
  // Picked up again on one side since (a reply to a thread that had ended): that side runs it now.
  if (m !== b && t === b) return true;
  if (t !== b && m === b) return false;
  if (!me || m !== t) return true;
  return m ? m === me.device : !me.runner;
}

/** Both usage ledgers, each event once, oldest first, the newest MAX_USAGE kept. */
function usageOf(mine: unknown[], theirs: unknown[]) {
  const seen = new Map<string, unknown>();
  for (const e of [...theirs, ...mine]) seen.set(canonical(e), e);
  return [...seen.values()].sort((a, c) => ((a as { at?: number }).at ?? 0) - ((c as { at?: number }).at ?? 0)).slice(-MAX_USAGE);
}

/**
 * Make `target` (the state in memory) hold `source` (a merged blob, lifted by fromShared), keeping
 * what never leaves this Mac (NEVER_SYNCED, bots' appsKey, chats' typing and asking) and keeping each
 * object that stays the same object, so code holding a bot or a chat keeps working on the live one.
 */
export function applyShared(target: Blob, source: Blob) {
  const local = (k: string) => k !== "macs" && (NEVER_SYNCED as readonly string[]).includes(k);
  for (const k of Object.keys(target)) if (!(k in source) && !local(k)) delete target[k];
  for (const [k, v] of Object.entries(source)) {
    if (local(k)) continue;
    const keep = k === "bots" ? ["appsKey"] : k === "chats" ? ["typing", "asking"] : [];
    target[k] = Array.isArray(target[k]) && withIds(v) ? reconcile(target[k] as Blob[], v as Blob[], keep) : v;
  }
}

/** The list `next`, reusing `current`'s objects by id (updated in place) and keeping their `keep` fields. */
function reconcile(current: Blob[], next: Blob[], keep: string[]): Blob[] {
  const byId = new Map(current.filter(isObject).map((x) => [x.id, x]));
  return next.map((n) => {
    const old = byId.get(n.id);
    if (!old) return n;
    for (const k of Object.keys(old)) if (!(k in n) && !keep.includes(k)) delete old[k];
    for (const [k, v] of Object.entries(n)) if (!keep.includes(k)) old[k] = v;
    return old;
  });
}
