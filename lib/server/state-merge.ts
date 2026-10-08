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

/** This Mac's own, under macs[deviceId] in the blob: routing through it, whether bots can work on it (state.mac) and its setup. */
export const PER_MAC = ["relay", "relayRoutes", "mac", "setup"] as const;
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
 *   ones after;
 * - usage is both ledgers together; macs, and any other object, key by key;
 * - anything else is this Mac's.
 */
export function merge3(base: Blob | null, mine: Blob, theirs: Blob): Blob {
  return mergeObject(base ?? {}, mine, theirs, true);
}

function mergeObject(base: Blob, mine: Blob, theirs: Blob, top = false): Blob {
  const out: Blob = {};
  for (const k of new Set([...Object.keys(mine), ...Object.keys(theirs), ...Object.keys(base)])) {
    const v = mergeValue(k, base[k], mine[k], theirs[k], top);
    if (v !== undefined) out[k] = v;
  }
  return out;
}

function mergeValue(key: string, b: unknown, m: unknown, t: unknown, top: boolean): unknown {
  if (same(m, t)) return m;
  if (same(m, b)) return t;
  if (same(t, b)) return m;
  // Both changed it.
  if (top && key === "usage" && Array.isArray(m) && Array.isArray(t)) return usageOf(m, t);
  if ((withIds(m) || withIds(t) || withIds(b)) && (Array.isArray(m) || m === undefined) && (Array.isArray(t) || t === undefined))
    return mergeById(Array.isArray(b) ? b : [], (m as { id: string }[]) ?? [], (t as { id: string }[]) ?? []);
  if (isObject(m) && isObject(t)) return mergeObject(isObject(b) ? b : {}, m, t);
  return m;
}

function mergeById(base: { id: string }[], mine: { id: string }[], theirs: { id: string }[]) {
  const b = new Map(base.map((x) => [x.id, x]));
  const t = new Map(theirs.map((x) => [x.id, x]));
  const m = new Map(mine.map((x) => [x.id, x]));
  const out: { id: string }[] = [];
  for (const x of mine) {
    const was = b.get(x.id);
    const other = t.get(x.id);
    if (other) out.push(was && same(x, was) ? other : x);
    // Gone on their side: gone here too, unless this Mac changed it since (or added it).
    else if (!was || !same(x, was)) out.push(x);
  }
  // Theirs that this Mac hasn't got: new there (kept), or removed here (gone).
  for (const x of theirs) if (!m.has(x.id) && !b.has(x.id)) out.push(x);
  return out;
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
