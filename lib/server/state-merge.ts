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
 * (state.mac), its setup, and the screen of a bot's computer the user drives from it (driving).
 */
export const PER_MAC = ["relay", "relayRoutes", "mac", "setup", "driving"] as const;
/**
 * Never in the cloud: who's signed in here, what's on screen right now, an account mid sign in, what the
 * bots are doing on the user's other devices (live.ts), and the apps the bots made, whose record is
 * Orgo's (made-apps-sync.ts: every Mac lists them from there, and this Mac keeps its copy in
 * made-apps/apps.json). A list from before, under macs[deviceId].madeApps, is read into that copy once
 * and goes from the blob with this Mac's next save. What a bot asks the user's OK for (appApprovals) is
 * shared, so every Bops of theirs shows it and the one whose run asked reads the reply (permission.ts).
 */
export const NEVER_SYNCED = ["account", "screens", "takeover", "connecting", "screenStream", "cloudUser", "messages", "macs", "madeApps", "liveMoods"] as const;
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
 *   a request for the user's OK keeps its reply, never back to unanswered (mergeApproval), and one taken
 *   out on either side stays out, whatever the other changed: only the Bops that asked takes one out, once
 *   it has read the reply, so a second reply or a Stop that crossed it never brings it back to be read again;
 *   a workspace goes field by field (each field changed on both is this Mac's), so a rename on one
 *   Mac and a names sync on the other (workspaces.ts noteOrgoName, which only notes when Orgo last
 *   changed its project) both stay, and the old name never comes back over the new one, and its
 *   favorites (a list of names, not of things with ids) are one field: pinned or reordered on both
 *   Macs, the list of the Mac saving now (the last to write) goes whole; anything
 *   else changed on both keeps this Mac's copy whole, as its fields go together (a watch's alert and
 *   what it was told);
 * - usage is both ledgers together; macs, and any other object, key by key;
 * - anything else is this Mac's.
 * A thread, routine or watch either side kept "between us" (secret) stays so, however it merged (keepMarks).
 * `me`: which Bops is merging (its device id, and whether it's a computer's runner), so a thread
 * changed on both sides goes by the one that runs it (Session.by); without it, by this Mac's copy. With
 * me.older, `mine` is an older Bops's copy and theirs stands where both changed something (Me.older),
 * and its routines' runs never go in (withoutRuns).
 */
export function merge3(base: Blob | null, mine: Blob, theirs: Blob, me?: Me): Blob {
  const was = base ?? {};
  return mergeObject(was, me?.older ? withoutRuns(was, mine, me) : mine, theirs, true, me);
}

type Me = {
  device: string;
  runner?: boolean;
  /**
   * `mine` is a copy an older Bops kept (persist-cloud.ts buildKept: written by an app below the level of
   * the one that wrote `theirs` since, such as a Mac Bops Cloud refused as too old while it went on in
   * memory): where both changed the same thing, theirs stands. A bot or a workspace goes field by field
   * (renamed there and woken here: the new name, and woken), anything else changed on both is theirs
   * whole, and a routine's clock is never the older copy's, even where only it changed the routine
   * (withoutRuns). What only the older copy added or changed still goes in, and a thread still goes by
   * the Bops that runs it (mergeSession).
   */
  older?: boolean;
  /**
   * A routine's next time worked out again from its schedule, zone and last run (as routines.ts does when
   * it's edited): for a routine whose clock came from a side that had another schedule (mergeRoutine).
   */
  nextRunOf?: (routine: Blob) => number | undefined;
};

function mergeObject(base: Blob, mine: Blob, theirs: Blob, top = false, me?: Me): Blob {
  const out: Blob = {};
  for (const k of new Set([...Object.keys(mine), ...Object.keys(theirs), ...Object.keys(base)])) {
    const v = mergeValue(k, base[k], mine[k], theirs[k], top, me);
    if (v !== undefined) out[k] = v;
  }
  return out;
}

/**
 * The lists whose things may carry a "between us" mark (Session.secret, Routine.secret, Watch.secret): a
 * mark either side has stays, whatever else the merge takes.
 */
const KEPT_MARKS = ["sessions", "routines", "watches"] as const;

function mergeValue(key: string, b: unknown, m: unknown, t: unknown, top: boolean, me?: Me): unknown {
  const v = mergeEither(key, b, m, t, top, me);
  return top && (KEPT_MARKS as readonly string[]).includes(key) ? keepMarks(v, [b, m, t]) : v;
}

/**
 * `merged` with the "between us" mark on every thing marked on either side (or before: `copies`, the
 * base and both sides): one way, never taken back by a merge. A thread a computer's runner runs is the
 * runner's copy (mergeSession), and one changed on one side only is that side's, but a mark the Mac put
 * on it meanwhile (a message kept between us sent to it, Jev's later check) stays, as does one the runner
 * put on it (a part it split off), whatever a Bops from before the mark wrote.
 */
function keepMarks(merged: unknown, copies: unknown[]): unknown {
  if (!Array.isArray(merged)) return merged;
  const marked = new Set(copies.flatMap((x) => (Array.isArray(x) ? x.flatMap((y) => (isObject(y) && y.secret === true && typeof y.id === "string" ? [y.id] : [])) : [])));
  if (!marked.size) return merged;
  return merged.map((x) => (isObject(x) && typeof x.id === "string" && marked.has(x.id) && x.secret !== true ? { ...x, secret: true } : x));
}

function mergeEither(key: string, b: unknown, m: unknown, t: unknown, top: boolean, me?: Me): unknown {
  if (same(m, t)) return m;
  if (same(m, b)) return t;
  if (same(t, b)) return m;
  // Both changed it.
  if (top && key === "usage" && Array.isArray(m) && Array.isArray(t)) return usageOf(m, t);
  if ((withIds(m) || withIds(t) || withIds(b)) && (Array.isArray(m) || m === undefined) && (Array.isArray(t) || t === undefined)) {
    const both = !top ? undefined
      : key === "routines" ? (was: Blob, x: Blob, y: Blob) => mergeRoutine(was, x, y, me)
      : key === "sessions" ? (was: Blob, x: Blob, y: Blob) => mergeSession(was, x, y, me)
      : key === "appApprovals" ? mergeApproval
      : key === "workspaces" || (me?.older && key === "bots") ? (was: Blob, x: Blob, y: Blob) => mergeObject(was, x, y, false, me)
      : undefined;
    return mergeById(Array.isArray(b) ? b : [], (m as { id: string }[]) ?? [], (t as { id: string }[]) ?? [], both, me?.older, top && key === "appApprovals");
  }
  if (isObject(m) && isObject(t)) return mergeObject(isObject(b) ? b : {}, m, t, false, me);
  return me?.older ? t : m;
}

/**
 * `both`: how one changed on both sides goes together; without it, this Mac's copy. `older`: this Mac's
 * is an older Bops's copy (Me.older), so theirs leads: their order, and their copy where both changed one
 * (or one side removed what the other changed). `goneWins`: one removed on either side goes, even where
 * the other changed it (a request for the user's OK the Bops that asked took out: mergeEither).
 */
function mergeById(base: { id: string }[], mine: { id: string }[], theirs: { id: string }[], both?: (was: Blob, mine: Blob, theirs: Blob) => Blob, older = false, goneWins = false): { id: string }[] {
  if (older) return mergeById(base, theirs, mine, both && ((was, x, y) => both(was, y, x)), false, goneWins);
  const b = new Map(base.map((x) => [x.id, x]));
  const t = new Map(theirs.map((x) => [x.id, x]));
  const m = new Map(mine.map((x) => [x.id, x]));
  const out: { id: string }[] = [];
  for (const x of mine) {
    const was = b.get(x.id);
    const other = t.get(x.id);
    if (other) out.push(was && same(x, was) ? other : was && both && !same(other, was) ? (both(was as Blob, x as Blob, other as Blob) as { id: string }) : x);
    // Gone on their side: gone here too, unless this Mac changed it since (or added it).
    else if (!was || (!goneWins && !same(x, was))) out.push(x);
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

/** What a routine's next time is worked out from: its schedule, its zone, and whether it's paused. */
const plan = (x: Blob) => canonical([x.schedule, x.timeZone ?? null, x.enabled === false]);

/**
 * An older Bops's kept copy (Me.older) with each routine it shares with `base` put back to how it was
 * there in all its runs changed: its clock, and a one-off its run turned off (ranOff). That Bops went on
 * running routines from memory while Bops Cloud refused it, so each run it shows failed or was never
 * seen (persist-cloud.ts refusedWork leaves out what it posted): left as it was, the newer Bops runs it,
 * late if its time has passed. What the user changed there (a title, a goal, a schedule, a pause) still
 * goes in, and a new schedule, zone or pause has its next time worked out again, as routines.ts does when
 * it's edited (a one-off's is its time). A routine only the older copy has keeps what it has.
 */
function withoutRuns(base: Blob, mine: Blob, me: Me): Blob {
  if (!Array.isArray(mine.routines) || !Array.isArray(base.routines)) return mine;
  const was = new Map((base.routines as unknown[]).filter((x): x is Blob => isObject(x) && typeof x.id === "string").map((x) => [x.id as string, x]));
  const routines = (mine.routines as unknown[]).map((r) => {
    const b = isObject(r) && typeof r.id === "string" ? was.get(r.id) : undefined;
    if (!b || !isObject(r) || same(r, b)) return r;
    const out: Blob = { ...r };
    for (const k of CLOCK) {
      if (b[k] === undefined) delete out[k];
      else out[k] = b[k];
    }
    if (ranOff(b, r)) {
      if (b.enabled === undefined) delete out.enabled;
      else out.enabled = b.enabled;
    }
    if (out.enabled === false) delete out.nextRunAt;
    else if (plan(out) !== plan(b)) {
      const s = isObject(out.schedule) ? out.schedule : {};
      const next = s.kind === "once" ? s.at : me.nextRunOf ? me.nextRunOf(out) : r.nextRunAt;
      if (typeof next === "number") out.nextRunAt = next;
      else delete out.nextRunAt;
    }
    return out;
  });
  return { ...mine, routines };
}

/** Whether a one-off went off by running (routines.ts record: its run for its time ended, and it's done; an older Bops's tick, as it fired), not by a pause. */
function ranOff(was: Blob, now: Blob): boolean {
  const s = isObject(now.schedule) ? now.schedule : {};
  const ran = now.lastRunAt;
  return (
    was.enabled !== false &&
    now.enabled === false &&
    s.kind === "once" &&
    typeof s.at === "number" &&
    typeof ran === "number" &&
    ran >= s.at &&
    !(typeof was.lastRunAt === "number" && ran <= was.lastRunAt)
  );
}

/**
 * A routine changed on both sides (a pause or an edit on this Mac while a computer's runner ran it, or
 * the other way): field by field, and the clock as one, from the side that ran it last (the later
 * lastRunAt), so the edit stays and so does the run, and an edit made offline never brings back a time
 * that already ran. The times it's skipping are the user's: one skipped on either side stays (one taken
 * back on either side goes), until it has passed; a next time that's one of them is moved past it by the
 * routines timer before it comes due (routines.ts tick). Paused on either side: no next time, nothing
 * skipped (routines.ts setRoutineEnabled). A next time at or before the other side's last run (a Run now
 * on one Bops just after the other ran that time) is never taken: the other side's next time is.
 * A copy an older Bops kept (Me.older) never gives the clock.
 * When the side the clock came from had another schedule, zone or pause than the routine has now (an
 * edit on one Bops while the other ran it), its next time was for that other schedule: it's worked out
 * again for this one (Me.nextRunOf), so the edit's time runs and the old one doesn't.
 */
function mergeRoutine(base: Blob, mine: Blob, theirs: Blob, me?: Me): Blob {
  const out = mergeObject(base, mine, theirs, false, me);
  const ran = (x: Blob) => (typeof x.lastRunAt === "number" ? x.lastRunAt : 0);
  const from = me?.older ? theirs : ran(mine) !== ran(theirs) ? (ran(theirs) > ran(mine) ? theirs : mine) : undefined;
  if (from) {
    for (const k of CLOCK) {
      if (from[k] === undefined) delete out[k];
      else out[k] = from[k];
    }
    if (me?.nextRunOf && out.enabled !== false && plan(from) !== plan(out)) {
      const next = me.nextRunOf(out);
      if (next === undefined) delete out.nextRunAt;
      else out.nextRunAt = next;
    }
    // A next time the other side already ran (its last run at or after it): a Run now here (routines.ts
    // run moves only the last run) over a run there not taken in yet. The other side's next time, as the
    // plan is the same; else one worked out again.
    const other = from === mine ? theirs : mine;
    const done = other.lastRunAt;
    if (typeof done === "number" && typeof out.nextRunAt === "number" && out.nextRunAt <= done) {
      if (plan(other) === plan(out) && typeof other.nextRunAt === "number" && other.nextRunAt > done) out.nextRunAt = other.nextRunAt;
      else if (me?.nextRunOf) {
        const next = me.nextRunOf(out);
        if (next === undefined) delete out.nextRunAt;
        else out.nextRunAt = next;
      }
    }
  } else {
    // Two records of the run that name different threads never mix: the run moved to another thread on one side
    // (a move to the Mac, sessions.ts moveToMac, which makes the run the Mac's) while the other wrote to the record
    // of the thread it left (a runner that hadn't heard of the move). The record goes whole from the side that
    // moved it, so the old thread's end never lands on the new one's run.
    const rec = (x: Blob) => (isObject(x.last) ? x.last : undefined);
    const [lb, lm, lt] = [rec(base), rec(mine), rec(theirs)];
    if (lm && lt && lm.sessionId !== lt.sessionId) {
      const moved = lt.sessionId === lb?.sessionId ? mine : lm.sessionId === lb?.sessionId ? theirs : undefined;
      if (moved) out.last = moved.last;
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

/** A request's reply (AppApproval.reply), when it has one. */
const replyOf = (x: Blob) => (isObject(x.reply) ? x.reply : undefined);

/**
 * A request for the user's OK changed on both sides (they answered it on one Mac while another answered too, or Stop
 * met an answer): the side that has a reply, so a reply never goes back to unanswered and the run that asked always
 * reads one. Both replied: the first (the earlier reply.at), the one the run that asked could have gone by; at the
 * same moment, a reject over a yes, so nothing is done that someone said not to.
 */
export function mergeApproval(base: Blob, mine: Blob, theirs: Blob): Blob {
  const [m, t] = [replyOf(mine), replyOf(theirs)];
  if (!m && !t) return mergeObject(base, mine, theirs);
  if (!m || !t) return m ? mine : theirs;
  const at = (x: Blob) => (typeof x.at === "number" ? x.at : Infinity);
  if (at(m) !== at(t)) return at(m) < at(t) ? mine : theirs;
  return m.reply !== "reject" && t.reply === "reject" ? theirs : mine;
}

/**
 * What another Bops than the one that runs a thread may change in it and keep, each while the one that
 * runs it left it as it was: a stop it asked for (sessions.ts stopSession), a move to the Mac (moveToMac:
 * the thread that took its place, and what waits on the user and the offer it clears) and a dismiss
 * (dismissWaiting: the mark, and what waits on the user and the replies it offered, cleared).
 */
const ASKED_ELSEWHERE = ["stopAsked", "replacedBy", "dismissed", "blocker", "waitingOnYou", "options", "offerMac"] as const;

/**
 * A thread changed on both sides (the user replied on the Mac while a computer's runner worked on it, or
 * the other way): the copy of the Bops that runs it (Session.by, or the side that just picked it up), as
 * its fields go together (its status and its screen, its answer, what it waits on), with the replies of
 * both, each reply field by field (the one that runs it marks them taken in), the steps of both, what
 * the user did to it from elsewhere (ASKED_ELSEWHERE: a stop, a move to the Mac, a dismiss), and a
 * "between us" mark either side has (Session.secret: keepMarks, which merge3 puts on every thread).
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
