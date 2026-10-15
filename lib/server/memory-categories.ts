import "server-only";
import { createHash, createHmac, randomBytes } from "node:crypto";
import { existsSync, mkdirSync, readdirSync, readFileSync, renameSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { CATEGORIES, CATEGORY_IDS, categoriesOpen, type CategoryId, type ItemSource, type MemoryItem, type MemorySnapshot } from "@/lib/memory-categories";
import { creditsOut, noteOutOfCredit } from "./cloud";
import { MAIN_WORKSPACE } from "@/lib/types";
import { bankOf, bankOwner, bindingOf, cardOf, dream as askToDream, existingFacts, factSource, factsByIds, memoryOn, privateLines, purgeMemory, saidSince, scanFacts, sessionWorkspace, type FactRow } from "./memory";
import { openaiClient } from "./openai-client";
import { orbitChanged, orbitOpened, orbitPreview } from "./orbit-sync";
import { onPostgres } from "./persist";
import { getState, ownerName, sameState, stateEpoch, update, userDir } from "./store";
import { recordTokens, usageTags } from "./usage";
import { currentWorkspaceId } from "./workspaces";

/*
 * The categories (lib/memory-categories.ts), filled from the workspace's memory. Honcho learns about
 * the user from every chat and finished task (memory.ts saveToMemory), and keeps what it learns as
 * plain sentences ("Tiger's sister Ana lives in Lisbon"), with no kinds. Here, on the Mac, those
 * sentences are sorted into People, Events, To-dos and the rest: a small model reads the new ones
 * (25 a call, one call after another, each told the known items the facts may be about, so mentions of
 * the same person or meeting get the same key and merge). Each item keeps the facts it came from, so
 * the app can say where it was learned, and forgetting it forgets them in memory too.
 *
 * When: while Bops is open (its server runs only then). A look reads the newest facts (free) and
 * stops at the first page it has seen all of. It runs on opening and every 15 minutes, 4 and 10
 * minutes after a chat or task is saved (Honcho needs that long to work out new facts), seconds after a
 * fact is saved by hand or by a bot, and on Refresh. Sorting costs AI credit, so other new facts wait
 * to be sorted together: when 10 are waiting, or the oldest has waited 30 minutes (what a chat taught,
 * a fact saved by hand, Refresh and the first look sort at once). Every 6 hours, on Refresh and after Tidy up, a sweep also
 * checks that what was sorted is still in memory (deleted facts leave their items).
 *
 * The first look sorts the card and the newest 300 facts; older ones are counted, and sorted 300 at a
 * time when the user asks (Sort older).
 *
 * Orbit lives in memory (Honcho): this index is only a cache of how its facts were sorted, kept per
 * workspace in the user's folder on this Mac, never in the app state (which goes to the window every few
 * seconds and to Bops Cloud): <userDir>/memory-categories/ws-<workspace>.json. Workspaces can share a
 * bank; each one's Orbit sorts only what was learned in its own chats, calls and tasks (and the facts it
 * saved), and the bank's card and what came from no Bops chat go to the workspace whose bank it is. An
 * index kept per bank before is moved to that workspace on first load.
 *
 * Forget deletes the facts and card lines an item was learned from in memory, for good, and checks that
 * memory no longer has them (tried again until it doesn't). What's kept of a forgotten item is hashes
 * only, never its text: of its key, and of its key with each fact's words, so that a fact memory works
 * out again from the old chats is deleted when it comes in, and the item stays gone. Delete everywhere
 * also deletes the memory copy of the chats and calls in Bops its facts came from (never a session
 * Bops has no copy of: the user's other agents', a chat deleted from Bops).
 *
 * The hashes are keyed: HMAC-SHA256 under the workspace's own secret (Workspace.orbitKey, made once and
 * synced to the user's other Macs with the state, never sent to Orgo), so a list of names can't reverse
 * them. Plain sha256 hashes kept by an index from before still match here; new ones are never plain.
 *
 * With an Orgo project (Workspace.orgoProjectId), the index is also the workspace's Orbit in Orgo
 * (orbit-sync.ts): items, their facts' ids and the hashes of what was forgotten go there, and what the
 * user's other Macs sorted or forgot comes back here. The facts themselves stay in memory.
 */

/** A sweep reads this many of the newest facts; anything sorted that isn't among them is checked with memory by id. */
const SWEEP_SCAN = 1500;
/** How many of the newest facts are sorted at first, and how many more each Sort older adds. */
const FIRST_DEPTH = 300;
const OLDER_STEP = 300;
/** How many facts one look sorts at most (the rest in the next), and how many go in one model call. */
const PER_RUN = 150;
const BATCH = 25;
/** New facts are sorted together: when this many wait, or the oldest has waited this long. */
const WAIT_FOR = 10;
const WAIT_MS = 30 * 60_000;
/** A look when the last was this long ago (the window asking, or the timer), and a sweep this often. */
const STALE_MS = 15 * 60_000;
const SWEEP_MS = 6 * 60 * 60_000;
/** Deleting from memory again after a try that left something there: after 5 seconds, then 30, 2 minutes, 10, then every 30. */
const PURGE_RETRY_MS = [5_000, 30_000, 2 * 60_000, 10 * 60_000, 30 * 60_000];
/** Said once deleting has failed this many times in a row. */
const PURGE_SAY_AFTER = 3;
const PURGE_ERROR = "Some of what you forgot is still in memory. Bops keeps trying to delete it.";
/** Forgotten items and facts kept (hashes), the newest. */
const TOMB_ITEMS = 2000;
const TOMB_FACTS = 10_000;
/** Tidying up (dreaming) on request, at most this often. */
const DREAM_EVERY_MS = 60 * 60_000;

const MODEL = process.env.BOPS_MEMORY_MODEL ?? process.env.BOPS_CHAT_MODEL ?? process.env.BOPS_SAM_MODEL ?? "gpt-6.1-sol";

/** What one fact said about one item, kept so the item can be worked out again when a fact goes: its name, line, date, who, done, how it was learned, private. */
type Said = { t: string; d: string; w?: string; o?: string; x?: boolean; h: ItemSource["how"]; p?: boolean; at: number };

/** An item as kept here: what the app sees, and whether its line came from a private fact. */
type Item = MemoryItem & { detailPrivate?: boolean };

type Index = {
  v: 1;
  /** The workspace whose Orbit this is, and the bank (Honcho workspace) its memory is in. */
  ws?: string;
  bank: string;
  /** The user's peer in that bank: what's still to delete there can be, after the workspace moved to another bank. */
  peer?: string;
  /** The categories it was sorted into: when they change, items in one that's gone go, and facts that made nothing are sorted again. */
  cats?: string;
  /**
   * Every fact (and card line, "card:<line>") already sorted, the items it went into, and what it said
   * about each; `s`: the session it was learned in (null: none); `h`: the hash of its words.
   */
  facts: Record<string, Fact>;
  items: Record<string, Item>;
  /**
   * What the user forgot, as hashes only (and when). items: an item's key (only something the user says in
   * a chat after the forget, or a fact saved after it, brings it back: bringsBack). facts: an item's key with a fact's words (memory working that fact out again: it's
   * deleted as it comes in), or a fact's id (a fact worked out from it goes too).
   */
  tomb: { items: Record<string, number>; facts: Record<string, number> };
  /**
   * Still to delete from memory (Forget, Delete everywhere), tried until memory no longer has it: facts by
   * id, card lines by the hash of their words, sessions by id. `need`: facts forgotten before their words'
   * hash was kept, with the items' key hashes, for their tombstones (read from memory before they go).
   */
  purge?: { facts: string[]; cards: string[]; sessions: string[]; need: Record<string, string[]>; tries: number; at: number };
  /**
   * The workspace's secrets the hashes were made with, the one in use first (a key another Mac made at the
   * same time may take its place: what was hashed with the old one still matches). Only on this Mac.
   */
  keys?: string[];
  /** The secret of a workspace not in the state's list (a test, a bank's old index): kept here. */
  localKey?: string;
  /**
   * Orbit in the workspace's Orgo project (orbit-sync.ts): what's still to send (items forgotten here, by
   * id, and the keyed hashes of what was forgotten), what each item was when last sent (a hash of it), and
   * the project and the time of the last read (the next read asks for what changed since).
   */
  out?: { del: string[]; items: Record<string, number>; facts: Record<string, number> };
  pushed?: Record<string, string>;
  /**
   * Items Orgo refused (400), as the hash of what was refused: not sent again until they change. Kept apart
   * from `pushed`, which says Orgo has them (a full read drops what was pushed and isn't there any more).
   */
  refused?: Record<string, string>;
  remote?: { project: string; at?: string };
  /** Before tombstones: forgotten keys in plain text (read once, then hashed). */
  forgotten?: Record<string, number>;
  /** How many of the newest facts are sorted (Sort older adds to it), and the date of the oldest of them. */
  depth?: number;
  floorAt?: number;
  /** Facts whose sorting failed: how often and when last. Tried again later, given up after three. */
  failures?: Record<string, { n: number; at: number }>;
  syncedAt?: number;
  /** When the last look started, whether or not it got through (one that fails isn't retried at every ask). */
  triedAt?: number;
  sweptAt?: number;
  dreamAt?: number;
  /** Facts older than the sorted ones, not sorted. */
  behind?: number;
  /** New facts waiting to be sorted together. */
  waiting?: number;
  /** A look left sorting to do (more than one look takes): the next one reads the sorted depth, not just the newest page. */
  more?: boolean;
  error?: string;
};

/** quick: the newest page. look: pages until one was all seen. fill: the sorted depth. sweep: fill, and check what was sorted is still there. */
type Mode = "quick" | "look" | "fill" | "sweep";
const RANK: Record<Mode, number> = { quick: 0, look: 1, fill: 2, sweep: 3 };
/** `now`: sort what's new right away (a fact saved by hand, Refresh, the first look) instead of waiting for more. */
type SyncOpts = { mode?: Mode; now?: boolean };

type Fact = { items: string[]; at: number; wrote?: Record<string, Said>; s?: string | null; h?: string };

/** One workspace's Orbit while Bops runs. */
type Space = {
  index?: Index;
  /** The file the index was read from: an index is only ever written back there (another account's sign-in has another folder). */
  file?: string;
  running?: Promise<void>;
  /** A look asked for while one runs: it runs once that one is done. */
  again?: SyncOpts;
  timers: Map<string, ReturnType<typeof setTimeout>>;
  /** Deleting what was forgotten from memory, one run at a time; `purgeAgain`: more was forgotten meanwhile. */
  purging?: Promise<void>;
  purgeAgain?: boolean;
  /** The facts last read to the sorted depth, for the next look that continues sorting them (not read again for 10 minutes). */
  rows?: { at: number; depth: number; rows: FactRow[]; total: number };
  /** Changes with anything a snapshot shows, so the window's polls can be answered "unchanged". */
  rev: number;
};
type Live = { spaces: Map<string, Space>; timer?: ReturnType<typeof setInterval> };
const g = globalThis as unknown as { bopsCategories?: Live };
const live: Live = (g.bopsCategories ??= { spaces: new Map() });

const openai = openaiClient();

/** On this Mac (not a hosted server), signed in, with memory set up, for an account they're open to. */
export const categoriesOn = () => !onPostgres() && userDir() !== null && memoryOn() && categoriesOpen(getState());

const space = (ws: string) => {
  let b = live.spaces.get(ws);
  if (!b) live.spaces.set(ws, (b = { timers: new Map(), rev: Date.now() }));
  return b;
};

/** Ids are letters, digits, _ and -: safe as a file name as they are. */
const safe = (id: string) => id.replace(/[^A-Za-z0-9_-]/g, "-");
const dirOf = () => {
  const dir = userDir();
  return dir ? join(/*turbopackIgnore: true*/ dir, "memory-categories") : null;
};
const fileOf = (ws: string) => {
  const dir = dirOf();
  return dir ? join(/*turbopackIgnore: true*/ dir, `ws-${safe(ws)}.json`) : null;
};
/** A workspace's index for a bank it used before: kept when it moves to another bank, and back when it returns. */
const stashOf = (ws: string, bank: string) => {
  const dir = dirOf();
  return dir ? join(/*turbopackIgnore: true*/ dir, `ws-${safe(ws)}@${safe(bank)}.json`) : null;
};
/** Where a bank's index was kept before Orbit was per workspace. */
const legacyFileOf = (bank: string) => {
  const dir = dirOf();
  return dir ? join(/*turbopackIgnore: true*/ dir, `${safe(bank)}.json`) : null;
};

/** The categories as they are now, for Index.cats. */
const CATS = CATEGORY_IDS.join(",");

const empty = (ws: string, bank: string): Index => ({ v: 1, ws, bank, cats: CATS, facts: {}, items: {}, tomb: { items: {}, facts: {} } });

/* Hashes for what's forgotten: never its words. */
const sha = (s: string) => createHash("sha256").update(s).digest("hex");
/** A fact's words as memory may write them again: lowercase, accents and punctuation gone. */
const normal = (t: string) =>
  t
    .toLowerCase()
    .normalize("NFKD")
    .replace(/\p{M}+/gu, "")
    .replace(/[^\p{L}\p{N}]+/gu, " ")
    .trim();
const wordsHash = (text: string) => sha(`text|${normal(text)}`);
const mac = (k: string, s: string) => createHmac("sha256", k).update(s).digest("hex");
/**
 * The hashes of a forgotten item's key, of an item's key with a fact's words, and of a fact's id: under each
 * of the workspace's secrets (the one in use first: new hashes are made with it), then the plain sha256 an
 * index from before kept (matched, never made again).
 */
const itemTombs = (keys: string[], key: string) => [...keys.map((k) => mac(k, `item|${key}`)), sha(`item|${key}`)];
const factTombs = (keys: string[], key: string, words: string) => [...keys.map((k) => mac(k, `fact|${mac(k, `item|${key}`)}|${words}`)), sha(`fact|${sha(`item|${key}`)}|${words}`)];
const idTombs = (keys: string[], id: string) => [...keys.map((k) => mac(k, `id|${id}`)), sha(`id|${id}`)];
/** When any of these hashes was kept (forgotten), or undefined. */
const tombAt = (m: Record<string, number>, hashes: string[]) => {
  for (const h of hashes) if (Object.hasOwn(m, h)) return m[h];
  return undefined;
};
const CARD = "card:";

/**
 * A workspace's secret for its hashes (Workspace.orbitKey), made once and kept in the state, so the user's
 * other Macs (the state syncs) hash the same way. Never sent to Orgo. Null for a workspace not in the list.
 */
function workspaceSecret(ws: string): string | null {
  const w = getState().workspaces?.find((x) => x.id === ws);
  if (!w) return null;
  if (w.orbitKey) return w.orbitKey;
  const made = randomBytes(32).toString("base64url");
  update((s) => {
    const x = s.workspaces?.find((y) => y.id === ws);
    if (x && !x.orbitKey) x.orbitKey = made;
  });
  return getState().workspaces?.find((x) => x.id === ws)?.orbitKey ?? made;
}

/** The secrets this index's hashes are made with and matched under (Index.keys), the workspace's own first. */
function secretsOf(ws: string, index: Index): string[] {
  const k = workspaceSecret(ws) ?? (index.localKey ??= randomBytes(32).toString("base64url"));
  if (index.keys?.[0] !== k) index.keys = [k, ...(index.keys ?? []).filter((x) => x !== k)].slice(0, 8);
  return index.keys;
}
const keysIn = (index: Index) => index.keys ?? [];

/** What's still to send to the workspace's Orbit in Orgo (Index.out): items forgotten here, and the new hashes. */
function sendLater(index: Index, what: { del?: string[]; items?: string[]; facts?: string[] }, at = Date.now()) {
  const o = (index.out ??= { del: [], items: {}, facts: {} });
  for (const id of what.del ?? []) if (!o.del.includes(id)) o.del.push(id);
  if (o.del.length > 2000) o.del = o.del.slice(-2000);
  for (const h of what.items ?? []) o.items[h] = at;
  for (const h of what.facts ?? []) o.facts[h] = at;
  o.items = newest(o.items, TOMB_ITEMS);
  o.facts = newest(o.facts, TOMB_FACTS);
}

/** An index as read from a file: null when it isn't one (a damaged file starts over: everything in it can be sorted again). */
function readIndex(file: string | null, what: string): Index | null {
  if (!file || !existsSync(/*turbopackIgnore: true*/ file)) return null;
  try {
    const read = JSON.parse(readFileSync(/*turbopackIgnore: true*/ file, "utf8")) as Index;
    return read?.v === 1 && read.items && read.facts ? read : null;
  } catch (e) {
    console.warn(`[categories] ${what}: unreadable index, starting over (${(e as Error).message})`);
    return null;
  }
}

/**
 * The workspace's index for the account signed in, from its file once. The first time, the index kept per
 * bank before moves to the workspace whose bank it is, and is swept soon (what other workspaces sharing
 * the bank taught it goes); its forgotten list, hashed, goes to every workspace on the bank, and the
 * old file keeps only that. A workspace now on another bank starts over, or from the index it had there:
 * the one for the bank it leaves is kept (its forgotten list, and what's still to delete there).
 */
function load(ws: string): Index {
  const b = space(ws);
  const file = fileOf(ws);
  const bank = bankOf(ws);
  if (b.index && b.file === (file ?? undefined) && b.index.bank === bank) {
    secretsOf(ws, b.index);
    return b.index;
  }
  let index = empty(ws, bank);
  let read = readIndex(file, ws);
  let moved: string | null = null;
  let restored: string | null = null;
  let legacyTomb: Index | null = null;
  if (read && read.bank !== bank) {
    keep(stashOf(ws, read.bank), read);
    read = null;
    void drainStashes(ws);
  }
  if (!read) {
    const st = stashOf(ws, bank);
    read = readIndex(st, ws);
    if (read?.bank === bank) restored = st;
    else read = null;
  }
  if (!read && file && !existsSync(/*turbopackIgnore: true*/ file)) {
    const old = legacyFileOf(bank);
    const legacy = readIndex(old, bank);
    if (legacy?.bank === bank && bankOwner(bank) === ws) {
      read = legacy;
      moved = old;
    } else if (legacy?.bank === bank) legacyTomb = legacy;
  }
  // Forgotten keys kept in plain text (an index from before) are hashed for every workspace on the bank: a
  // bank's old index is shared by them, each with its own secret.
  const secrets = () => [...new Set([secretsOf(ws, index)[0], ...workspacesIn(bank).map(workspaceSecret).filter((k): k is string => !!k)])];
  if (read) {
    index = { ...empty(ws, bank), ...read, ws };
    index.tomb ??= { items: {}, facts: {} };
    hashForgotten(index, secrets());
    // Moved from the bank's index: swept at the window's next poll.
    if (moved) index.sweptAt = index.syncedAt = index.triedAt = undefined;
    // Sorted into other categories: items in one that's gone go with it, and what made nothing may fit
    // one now. That's sorted again at the window's next poll, not 15 minutes after the last look (an
    // update, then a restart).
    if (read.cats !== CATS) {
      for (const [id, item] of Object.entries(index.items)) if (!CATEGORY_IDS.includes(item.category)) delete index.items[id];
      const before = Object.keys(index.facts).length;
      for (const [id, f] of Object.entries(index.facts)) {
        f.items = f.items.filter((i) => Object.hasOwn(index.items, i));
        if (f.wrote) for (const i of Object.keys(f.wrote)) if (!Object.hasOwn(index.items, i)) delete f.wrote[i];
        if (!f.items.length) delete index.facts[id];
      }
      if (Object.keys(index.facts).length < before) index.syncedAt = index.triedAt = undefined;
    }
    index.cats = CATS;
  }
  // Another workspace on the bank: what was forgotten in the bank's index stays forgotten here too.
  if (legacyTomb) {
    hashForgotten(legacyTomb, secrets());
    Object.assign(index.tomb.items, legacyTomb.tomb?.items);
    Object.assign(index.tomb.facts, legacyTomb.tomb?.facts);
  }
  index.peer = bindingOf(ws).peer;
  secretsOf(ws, index);
  b.index = index;
  b.file = file ?? undefined;
  b.rows = undefined;
  b.rev++;
  if (moved || restored || legacyTomb) save(ws, index);
  // The bank's old file keeps only the hashes of what was forgotten, for the other workspaces on it.
  if (moved) keep(moved, { ...empty("", bank), ws: undefined, tomb: index.tomb });
  if (restored) {
    rmSync(/*turbopackIgnore: true*/ restored, { force: true });
    // What was still to delete there: on with it.
    if (index.purge) void purge(ws);
  }
  return index;
}

/** Forgotten keys kept in plain text before: hashed (under each of `secrets`), and the text dropped. */
function hashForgotten(index: Index, secrets: string[]) {
  index.tomb ??= { items: {}, facts: {} };
  const was = Array.isArray(index.forgotten) ? Object.fromEntries((index.forgotten as unknown as string[]).map((k) => [k, Date.now()])) : (index.forgotten ?? {});
  for (const [k, at] of Object.entries(was)) {
    for (const s of secrets) index.tomb.items[mac(s, `item|${k}`)] = at;
    if (secrets[0] && index.keys?.[0] === secrets[0]) sendLater(index, { items: [mac(secrets[0], `item|${k}`)] }, at);
  }
  delete index.forgotten;
}

/** An index written whole to a file other than the workspace's own (a bank's kept index), readable by this user only. */
function keep(file: string | null, index: Index) {
  if (!file) return;
  mkdirSync(/*turbopackIgnore: true*/ join(/*turbopackIgnore: true*/ file, ".."), { recursive: true, mode: 0o700 });
  const tmp = `${file}.${randomBytes(4).toString("hex")}.tmp`;
  try {
    writeFileSync(/*turbopackIgnore: true*/ tmp, JSON.stringify(index), { mode: 0o600 });
    renameSync(/*turbopackIgnore: true*/ tmp, file);
  } catch (e) {
    rmSync(/*turbopackIgnore: true*/ tmp, { force: true });
    console.warn(`[categories] keeping an index: ${(e as Error).message}`);
  }
}

/**
 * What's still to delete in a bank the workspace no longer uses (forgotten there, then it moved): deleted
 * there, with that bank's peer, at the move and at every sweep, until nothing is left.
 */
async function drainStashes(ws: string) {
  const dir = dirOf();
  if (!dir || !existsSync(/*turbopackIgnore: true*/ dir)) return;
  const ours = sameState();
  const mine = readdirSync(/*turbopackIgnore: true*/ dir).filter((n) => n.startsWith(`ws-${safe(ws)}@`) && n.endsWith(".json"));
  for (const name of mine) {
    const file = join(/*turbopackIgnore: true*/ dir, name);
    const kept = readIndex(file, ws);
    const p = kept?.purge;
    if (!kept || !p || !kept.peer || kept.bank === bankOf(ws) || (!p.facts.length && !p.cards.length && !p.sessions.length)) continue;
    const cards = new Set(p.cards);
    const left = await purgeMemory(ws, { facts: p.facts, cardLine: cards.size ? (l) => cards.has(wordsHash(l)) : undefined, sessions: p.sessions }, { bank: kept.bank, peer: kept.peer }).catch(() => null);
    // Back on that bank meanwhile (the file is the workspace's own again), or another account: left as it is.
    if (!left || !ours() || !existsSync(/*turbopackIgnore: true*/ file)) continue;
    p.facts = left.facts;
    p.sessions = left.sessions;
    if (!left.card) p.cards = [];
    if (!p.facts.length && !p.cards.length && !p.sessions.length && !Object.keys(p.need).length) kept.purge = undefined;
    keep(file, kept);
  }
}

/**
 * Written whole, to a temp file then renamed, readable by this user only. Only into the file it was
 * read from, and only while that's still the signed-in account's: work that outlived a sign-out never
 * writes one account's categories into another's folder.
 */
function save(ws: string, index: Index, opts: { quiet?: boolean } = {}) {
  const b = space(ws);
  const file = fileOf(ws);
  if (!file || b.index !== index || b.file !== file) return;
  b.rev++;
  // What changed goes to the workspace's Orbit in Orgo soon (orbit-sync.ts; only what it hasn't got).
  if (!opts.quiet) orbitChanged(ws);
  mkdirSync(/*turbopackIgnore: true*/ join(/*turbopackIgnore: true*/ file, ".."), { recursive: true, mode: 0o700 });
  const tmp = `${file}.${randomBytes(4).toString("hex")}.tmp`;
  try {
    writeFileSync(/*turbopackIgnore: true*/ tmp, JSON.stringify(index), { mode: 0o600 });
    renameSync(/*turbopackIgnore: true*/ tmp, file);
  } catch (e) {
    rmSync(/*turbopackIgnore: true*/ tmp, { force: true });
    throw e;
  }
}

/** Long and short dashes (the user's copy has none): between numbers "to" (9 to 5), anywhere else a comma. */
const DASHES = String.fromCharCode(0x2013, 0x2014);
const RANGE = new RegExp(`(\\d)\\s*[${DASHES}]\\s*(\\d)`, "g");
const DASH = new RegExp(`\\s*[${DASHES}]\\s*`, "g");

/** Text for an item, one line, at most `n` long. What the model wrote loses a full stop at its end; what the user typed keeps it. */
const clip = (s: unknown, n: number, typed = false) => {
  const t = String(s ?? "")
    .replace(RANGE, "$1 to $2")
    .replace(DASH, ", ")
    .replace(/\s+/g, " ")
    .trim();
  return (typed ? t : t.replace(/\.$/, "")).slice(0, n);
};

/** The same for every mention: lowercase, accents on Latin letters and punctuation gone (other alphabets kept as they are), and for names what's around them ("Project Atlas" is Atlas, "Acme Corp." is Acme). */
function keyOf(category: CategoryId, key: string, title: string) {
  let k = (key || title)
    .toLowerCase()
    .normalize("NFKD")
    .replace(/(\p{Script=Latin})\p{M}+/gu, "$1")
    .normalize("NFC")
    .replace(/\.(?=\s|$)/g, "")
    .replace(/[^\p{L}\p{M}\p{N}@.+:\s-]/gu, " ")
    .replace(/\s+/g, " ")
    .trim();
  if (category === "projects") k = k.replace(/^the /, "").replace(/^project /, "").replace(/ project$/, "");
  if (category === "companies") k = k.replace(/^the /, "").replace(/ (inc|llc|ltd|corp|corporation|company|gmbh|plc)$/, "");
  return k ? `${category}:${k.slice(0, 120)}` : null;
}

/** A date or a date and time the app can read, or nothing. */
const whenOf = (s: string) => (/^\d{4}-\d{2}-\d{2}(T\d{2}:\d{2})?$/.test(s.trim()) && !Number.isNaN(Date.parse(s.trim())) ? s.trim() : undefined);

/**
 * How a fact was learned: from what the user said in a chat, saved as a fact with no chat to point to
 * (by them, a bot, or from a task: it may not be their own words), worked out by memory, or the card.
 */
const howOf = (level: string, session: string | null): ItemSource["how"] =>
  level === "card" ? "card" : level !== "explicit" ? "figured" : session?.startsWith("bops-chat-") ? "said" : "saved";

type Raw = { category: string; title: string; detail: string; key: string; when: string; who: string; done: boolean };

/**
 * One mention's part in an item. A newer mention says how things stand now (its line, its date, done
 * or not); an older one, or a card line about something chats already said, only fills in what's
 * missing. `chats`: when the chat mentions already in were learned. A fuller name ("Priya" to "Priya
 * Shah") wins from any mention. What the user set (edited, marked done) stays.
 */
function mention(item: Item, said: Said, chats: number[]) {
  const newer = said.h === "card" ? !chats.length && said.at >= item.last : said.at >= Math.max(0, ...chats);
  if (!item.edited && said.d && (newer || !item.detail)) {
    item.detail = said.d;
    item.detailPrivate = said.p || undefined;
  }
  if (!item.edited && said.t.length > item.title.length && said.t.toLowerCase().startsWith(`${item.title.toLowerCase()} `)) item.title = said.t;
  if (said.w && (newer || !item.when)) item.when = said.w;
  if (said.o && (newer || !item.who)) item.who = said.o;
  if (newer && !item.marked && (item.category === "todos" || item.category === "promises")) item.done = said.x || undefined;
  item.first = Math.min(item.first, said.at);
  item.last = Math.max(item.last, said.at);
}

/** Locked when it's known only from private lines, or its line came from one. */
const lockOf = (item: Item) => (item.sources.length > 0 && item.sources.every((s) => s.private)) || !!item.detailPrivate || undefined;

/**
 * Add what a fact says about one item: a new item, or one more mention of a known one. Returns the
 * item's id and what the fact said about it (kept with the fact).
 */
/** The key an item the model gave has ("people:dana reyes"), or null when it isn't one. */
function keyOfRaw(raw: Raw) {
  if (!CATEGORY_IDS.includes(raw.category as CategoryId)) return null;
  const title = clip(raw.title, 90);
  return title ? keyOf(raw.category as CategoryId, raw.key, title) : null;
}

/**
 * A fact memory worked out again from what was forgotten: sorted as nothing, and deleted from memory (a
 * card line comes off the card: kept as the hash of its words only, never as "card:<line>").
 */
function bury(index: Index, f: { id: string; text: string; at: number; session: string | null }) {
  const words = wordsHash(f.text);
  if (index.failures?.[f.id]) delete index.failures[f.id];
  if (f.id.startsWith(CARD)) return toPurge(index, { cards: [words] });
  index.facts[f.id] = { items: [], at: f.at || Date.now(), s: f.session, h: words };
  toPurge(index, { facts: [f.id] });
}

/**
 * A fact about a forgotten item that may bring it back: something the user said in that chat after the
 * forget (their messages, by this Mac's clock: not when memory worked the fact out, which can be minutes
 * after the chat), or a fact saved after it (by hand or a bot's remember). Never a card line, what memory
 * works out, or a fact from a task or another agent.
 */
const bringsBack = (f: { at: number; session: string | null; how: ItemSource["how"] }, forgotAt: number) =>
  f.how === "said" ? saidSince(f.session, forgotAt) : f.how === "saved" && (!f.session || f.session.startsWith("bops-notes-")) && (f.at || 0) > forgotAt;

function upsert(index: Index, byKey: Map<string, string>, raw: Raw, src: ItemSource): { id: string; said: Said } | null {
  const key = keyOfRaw(raw);
  if (!key) return null;
  const category = raw.category as CategoryId;
  const title = clip(raw.title, 90);
  // Forgotten, and brought back by something new (bringsBack: apply buries everything else about it).
  for (const h of itemTombs(keysIn(index), key)) if (Object.hasOwn(index.tomb.items, h)) delete index.tomb.items[h];
  const known = byKey.get(key);
  let item = known && Object.hasOwn(index.items, known) ? index.items[known] : undefined;
  if (!item) {
    item = { id: randomBytes(5).toString("hex"), category, key, title, detail: "", sources: [], first: src.at, last: src.at };
    index.items[item.id] = item;
    byKey.set(key, item.id);
  }
  const said: Said = { t: title, d: clip(raw.detail, 160), h: src.how, at: src.at };
  const when = whenOf(raw.when);
  const who = clip(raw.who, 90);
  if (when) said.w = when;
  if (who) said.o = who;
  if (raw.done) said.x = true;
  if (src.private) said.p = true;
  mention(
    item,
    said,
    item.sources.filter((s) => s.how !== "card").map((s) => s.at),
  );
  item.sources = [src, ...item.sources.filter((s) => s.fact !== src.fact)].sort((a, b) => b.at - a.at).slice(0, 12);
  item.private = lockOf(item);
  return { id: item.id, said };
}

/**
 * An item worked out again from the facts still behind it, oldest first, as if they came in now: what
 * a deleted fact said (a line, an address, a date) goes with it. Left as it is when some fact behind it
 * was sorted before facts kept what they said.
 */
function rebuild(index: Index, item: Item) {
  const behind = Object.values(index.facts).filter((f) => f.items.includes(item.id));
  if (!behind.length || behind.some((f) => !f.wrote?.[item.id])) return;
  const said = behind.map((f) => f.wrote![item.id]).sort((a, b) => a.at - b.at);
  if (!item.edited) {
    item.title = said[0].t;
    item.detail = "";
    item.detailPrivate = undefined;
  }
  item.when = undefined;
  item.who = undefined;
  if (!item.marked) item.done = undefined;
  item.first = said[0].at;
  item.last = said[0].at;
  const chats: number[] = [];
  for (const x of said) {
    mention(item, x, chats);
    if (x.h !== "card") chats.push(x.at);
  }
}

/**
 * Facts gone from memory (deleted, or dropped as out of date): their items lose them, and an item no
 * sorted fact backs any more goes, unless the user changed or hid it (a fact that comes back reworded
 * merges into it by its key). Says whether anything changed.
 */
function dropMany(index: Index, facts: string[]) {
  const gone = new Set(facts.filter((f) => Object.hasOwn(index.facts, f)));
  if (!gone.size) return false;
  const touched = new Set<string>();
  for (const f of gone) {
    for (const id of index.facts[f].items) touched.add(id);
    delete index.facts[f];
  }
  const backed = new Set<string>();
  for (const f of Object.values(index.facts)) for (const id of f.items) if (touched.has(id)) backed.add(id);
  for (const id of touched) {
    if (!Object.hasOwn(index.items, id)) continue;
    const item = index.items[id];
    item.sources = item.sources.filter((s) => !gone.has(s.fact));
    if (!backed.has(id)) {
      if (!item.edited && !item.marked && !item.hidden) {
        delete index.items[id];
        continue;
      }
      // Kept for the user's sake (hidden, marked, renamed): what the facts said goes with them.
      if (!item.edited) {
        item.detail = "";
        item.detailPrivate = undefined;
      }
      item.when = undefined;
      item.who = undefined;
    } else rebuild(index, item);
    item.private = lockOf(item);
  }
  return true;
}

/** The user's workspaces whose memory is in this bank. */
const workspacesIn = (bank: string) => [...new Set([MAIN_WORKSPACE, ...(getState().workspaces ?? []).map((w) => w.id)])].filter((ws) => bankOf(ws) === bank);

/** Facts deleted from memory on this Mac (memory.ts: Delete, Undo, Fix, the review's Delete all, Forget): out of the categories of every workspace on that bank at once. */
export function dropFacts(bank: string, ids: string[]) {
  if (!categoriesOn()) return;
  for (const ws of workspacesIn(bank)) {
    const index = load(ws);
    // A fact not sorted yet mustn't be sorted from rows read before it went.
    space(ws).rows = undefined;
    if (dropMany(index, ids)) save(ws, index);
  }
}

/**
 * Which facts a workspace's Orbit sorts: those learned in its own chats, calls and tasks, and what it
 * saved; the bank's own workspace also gets what came from no Bops chat of a workspace on this bank (the
 * user's other agents, a fact saved by hand) and the card. An issue's session (orbit-issues.ts) makes no facts.
 */
function scopeOf(ws: string, bank: string) {
  const owner = bankOwner(bank) === ws;
  const known = new Map<string, string | null>();
  const mine = (session: string | null | undefined) => {
    if (session?.startsWith("issue-")) return false;
    if (!session) return owner;
    if (!known.has(session)) known.set(session, sessionWorkspace(session));
    const w = known.get(session);
    // A workspace's session in a bank it doesn't use (its bot moved, it shares another's now): the bank's own.
    return w && bankOf(w) === bank ? w === ws : owner;
  };
  return { owner, mine };
}

const SCHEMA = {
  type: "object",
  additionalProperties: false,
  required: ["facts"],
  properties: {
    facts: {
      type: "array",
      items: {
        type: "object",
        additionalProperties: false,
        required: ["i", "items"],
        properties: {
          i: { type: "integer" },
          items: {
            type: "array",
            items: {
              type: "object",
              additionalProperties: false,
              required: ["category", "title", "detail", "key", "when", "who", "done"],
              properties: {
                category: { type: "string", enum: CATEGORY_IDS },
                title: { type: "string" },
                detail: { type: "string" },
                key: { type: "string" },
                when: { type: "string" },
                who: { type: "string" },
                done: { type: "boolean" },
              },
            },
          },
        },
      },
    },
  },
};

/** A day on this Mac's calendar ("today", and when a fact was learned, as the user would say them). */
const localDay = (ms: number) => {
  const d = new Date(ms);
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(d.getDate()).padStart(2, "0")}`;
};

type Fresh = FactRow & { how: ItemSource["how"] };

/**
 * What each fact says about which items, by one call of a small model: a map from each fact's place in
 * the batch to its items. "unusable" when the model answered but not usably (no JSON, a refusal, a
 * place outside the batch: one of these facts may be why), "down" when it couldn't be asked (down,
 * slow, rate limited, not allowed: no fact's fault, the look stops and tries again later), "credit"
 * when the AI credit ran out, "gone" when another account signed in before it was asked.
 */
async function sortFacts(facts: Fresh[], known: Record<string, unknown>, epoch: number, ours: () => boolean): Promise<Map<number, Raw[]> | "unusable" | "refused" | "down" | "credit" | "gone"> {
  const owner = ownerName();
  const bots = getState().bots.map((b) => b.name).filter(Boolean);
  const instructions = [
    `You sort what an AI memory system learned about ${owner} into the categories of their app. Each fact below was learned from ${owner}'s chats with their AI assistants, saved as a fact, worked out by the memory system, or is a line of ${owner}'s profile card. Turn each fact into zero or more items in these categories:`,
    ...CATEGORIES.map((c) => `- ${c.id}: ${c.about}`),
    "Rules:",
    "- Only what the fact says. Never guess, never add.",
    "- Most facts give zero or one item. One fact can give several: a meeting with Dana from Acme on Friday is an event, Dana in people and Acme in companies.",
    `- Never an item in people for ${owner} themselves${bots.length ? `, or for their AI assistants (${bots.join(", ")})` : ""}.`,
    "- Known lists items already in the categories that these facts may be about, with their keys and what they are. When a fact is about one of them (the same person, company, project, meeting or to-do, even in other words or by a fuller name), use its key exactly. Two people who only share a first name are not the same; a first name at the same company or in the same role is the same person (\"Dana, your contact at Acme\" and \"Dana Brooks of Acme\").",
    `- people, companies and projects: title is the name, the fullest one known. detail: who or what they are to ${owner}, a few words addressed to ${owner} ("Your sister", "Your accountant at Acme", "Your customer, wants a quote"); empty when the fact doesn't say who they are.`,
    "- events: title is a short name (\"Dentist\", \"Flight to Denver\", \"Call with Dana\"). when: its date as YYYY-MM-DD, or YYYY-MM-DDTHH:MM with a time. For a fact that was said or saved, work out words like Friday or tomorrow from the day it was learned; for one worked out by the memory system or a card line, only a date written out in it. Empty when there's no date. who: who it's with.",
    `- todos: what ${owner} has to do, including what ${owner} said they would do for someone, as a short instruction ("Renew the passport", "Send Priya the receipts"). who: for whom. when: the due date, if any. done: true only when the fact says it's done. What ${owner} asked an AI assistant to do is that assistant's work, not a todo.`,
    `- promises: what someone other than ${owner} said they would do, naming them ("Dana sends Priya the quote", "Dana signs the contract"). who: who it's for. when: by when. done: true when it was kept. What ${owner} said they would do is a todo, not a promise.`,
    "- decisions: title is what was decided, detail why. preferences: title is the preference or rule (\"Aisle seats\", \"Sign emails as Tiger\").",
    "- key: the same for every mention of the same thing: the lowercase name for people, companies and projects; the name and date for events (\"dentist 2026-10-17\"); a few lowercase words for the rest.",
    "- detail: plain words, no full stop at the end. Empty strings for what isn't known. No dashes.",
    `- No item for a passing moment, small talk, checking that a call or the app works ("can you hear me"), what an AI assistant did or how it works, or anything else about the AI system itself. A rule ${owner} set for their bots ("keep replies short") is a preference.`,
  ].join("\n");
  const input = JSON.stringify({
    today: localDay(Date.now()),
    facts: facts.map((f, i) => ({ i, fact: f.text.slice(0, 600), learned: localDay(f.at || Date.now()), how: f.how === "card" ? "profile card" : f.how === "figured" ? "worked out" : f.how })),
    known,
  });
  if (!ours()) return "gone";
  try {
    const res = await openai.responses.create(
      { model: MODEL, reasoning: { effort: "low" }, store: false, instructions, input, text: { format: { type: "json_schema", name: "memory_items", strict: true, schema: SCHEMA } } },
      { ...usageTags("memory"), timeout: 90_000, maxRetries: 1 },
    );
    recordTokens("memory", res.model, res.usage, undefined, epoch);
    const out = JSON.parse(res.output_text) as { facts: { i: number; items: Raw[] }[] };
    // A place that isn't in the batch: the answer can't be trusted, the batch is tried again.
    const map = new Map<number, Raw[]>();
    for (const f of out.facts) {
      if (!Number.isInteger(f.i) || f.i < 0 || f.i >= facts.length) return "unusable";
      map.set(f.i, [...(map.get(f.i) ?? []), ...f.items]);
    }
    return map;
  } catch (e) {
    if (noteOutOfCredit(e)) return "credit";
    console.warn(`[categories] sort: ${(e as Error).message}`);
    const status = (e as { status?: unknown }).status;
    // An answer that isn't JSON, or a request refused for what's in it: maybe a fact's doing ("refused";
    // a refused request can also be a wrong setting: see apply). Anything else: the model couldn't be reached.
    return e instanceof SyntaxError || status === 422 ? "unusable" : status === 400 ? "refused" : "down";
  }
}

/** Words that say nothing about who or what a fact is about. */
const COMMON = new Set("the and for with from that this have has had was were are his her hers their them they you your our its not but all any can will would about into over after before when what who".split(" "));
const wordsOf = (s: string) => (s.toLowerCase().match(/[\p{L}\p{N}]{3,}/gu) ?? []).filter((w) => !COMMON.has(w));

/**
 * The known items these facts may be about, so a new mention of Dana or of the same meeting gets the
 * same key: those whose name shares a word with the facts, and events within two weeks of when they
 * were learned (at most 40, the latest first). A small index goes whole. Each says what it is (its
 * line, unless that's private), or "Dana" can't be told from Dana Brooks at the same company.
 */
function knownFor(index: Index, batch: Fresh[]) {
  let items = Object.values(index.items);
  if (items.length > 40) {
    const words = new Set(batch.flatMap((f) => wordsOf(f.text)));
    const days = batch.map((f) => f.at || Date.now());
    const near = (i: MemoryItem) => !!i.when && days.some((d) => Math.abs(new Date(`${i.when!.slice(0, 10)}T12:00`).getTime() - d) < 14 * 86_400_000);
    items = items
      .filter((i) => wordsOf(i.title).some((w) => words.has(w)) || (i.category === "events" && near(i)))
      .sort((a, b) => b.last - a.last)
      .slice(0, 40);
  }
  return Object.fromEntries(
    CATEGORY_IDS.map((c) => [c, items.filter((i) => i.category === c).map((i) => ({ title: i.title, key: i.key.slice(c.length + 1), ...(i.detail && !lockOf(i) ? { detail: i.detail.slice(0, 80) } : {}), ...(i.when ? { when: i.when } : {}) }))]).filter(([, list]) => list.length),
  );
}

/**
 * One look at the workspace's memory (see the modes above). One look per bank at a time; one asked
 * for meanwhile runs after it (the more thorough of the two).
 */
export function sync(ws: string, opts: SyncOpts = {}): Promise<void> {
  if (!categoriesOn()) return Promise.resolve();
  const b = space(ws);
  if (b.running) {
    const mode = b.again?.mode && RANK[b.again.mode] > RANK[opts.mode ?? "look"] ? b.again.mode : (opts.mode ?? "look");
    b.again = { mode, now: !!opts.now || !!b.again?.now };
    return b.running;
  }
  const ours = sameState();
  const epoch = stateEpoch();
  const index = load(ws);
  const bank = index.bank;
  b.rev++;
  b.running = run(ws, bank, index, opts, ours, epoch)
    .catch((e: Error) => {
      console.warn(`[categories] ${ws}: ${e.message}`);
      if (!ours()) return;
      index.error = "Couldn't reach memory just now. It tries again on its own.";
      save(ws, index);
    })
    .finally(() => {
      b.running = undefined;
      b.rev++;
      const again = b.again;
      b.again = undefined;
      if (again && ours()) void sync(ws, again);
    });
  return b.running;
}

async function run(ws: string, bank: string, index: Index, opts: SyncOpts, ours: () => boolean, epoch: number) {
  const b = space(ws);
  const { owner, mine } = scopeOf(ws, bank);
  // What's still to delete from memory, if nothing is deleting it now or is set to try again.
  if (index.purge && !b.purging && !b.timers.has("purge")) void purge(ws);
  const first = !index.syncedAt && !Object.keys(index.facts).length;
  let mode: Mode = opts.mode ?? "look";
  // A sweep every 6 hours (never on the first look: nothing to check yet).
  if (!first && mode !== "quick" && (!index.sweptAt || Date.now() - index.sweptAt > SWEEP_MS)) mode = "sweep";
  if (first && RANK[mode] < RANK.fill) mode = "fill";
  // The last look left sorting to do: this one reads as deep as the sorting goes.
  if (index.more && mode === "look") mode = "fill";
  const now = !!opts.now || first;
  if (mode !== "quick") index.triedAt = Date.now();
  const depth = index.depth ?? FIRST_DEPTH;

  // Read: the newest page; or until a page was all seen; or the sorted depth (kept for 10 minutes, so
  // the looks that continue sorting it don't read it again); or, for a sweep, deeper.
  let rows: FactRow[];
  let total: number;
  const kept = b.rows && Date.now() - b.rows.at < 10 * 60_000 && b.rows.depth >= depth ? b.rows : undefined;
  if (mode === "fill" && kept) ({ rows, total } = kept);
  else {
    // Another workspace's facts (sharing the bank), and what's being deleted, count as seen.
    const deleting = new Set(index.purge?.facts ?? []);
    const seen = (r: FactRow) => !mine(r.session) || deleting.has(r.id) || Object.hasOwn(index.facts, r.id) || (!!index.floorAt && r.at < index.floorAt);
    const read = await scanFacts(ws, mode === "quick" ? 100 : mode === "look" ? SWEEP_SCAN : mode === "sweep" ? Math.max(depth, SWEEP_SCAN) : depth, mode === "look" ? (page) => page.every(seen) : undefined);
    if (!ours()) return;
    // Only this workspace's (the total too, as near as the rows read can tell), and not what's being deleted.
    rows = read.rows.filter((r) => mine(r.session) && !deleting.has(r.id));
    const theirs = read.rows.filter((r) => !mine(r.session)).length;
    total = theirs && read.rows.length ? Math.round(read.total * (1 - theirs / read.rows.length)) : read.total;
    // Where each sorted fact was learned, for Delete everywhere (indexes from before didn't keep it).
    for (const r of rows) if (Object.hasOwn(index.facts, r.id) && index.facts[r.id].s === undefined) index.facts[r.id].s = r.session;
    if (mode === "fill" || mode === "sweep") {
      b.rows = { at: Date.now(), depth, rows: rows.slice(0, depth), total };
      // Facts older than the sorted depth aren't sorted (Sort older adds 300).
      index.floorAt = rows.length >= depth ? rows[depth - 1].at : 0;
      // Older and not sorted: beyond the depth, less what was sorted when it was newer.
      const sortedOlder = Object.entries(index.facts).filter(([id, f]) => !id.startsWith("card:") && !!index.floorAt && f.at < index.floorAt).length;
      index.behind = Math.max(0, total - depth - sortedOlder) || undefined;
    }
  }
  // The card is the bank's own workspace's.
  const lines = mode === "quick" || !owner ? null : await cardOf(ws).catch(() => null);
  if (!ours()) return;
  if (index.error === "Couldn't reach memory just now. It tries again on its own.") index.error = undefined;
  const failing = (id: string) => {
    const f = index.failures?.[id];
    return !!f && Date.now() - f.at < WAIT_MS * 2 ** (f.n - 1);
  };

  // A sweep: what was sorted and isn't among the newest is checked with memory itself (free, by id: a
  // listing that missed a fact doesn't mean it's gone), and card lines no longer on the card go.
  if (first) index.sweptAt = Date.now();
  if (mode === "sweep") {
    const listed = new Map(rows.map((r) => [r.id, r.at]));
    // Sorted facts, and facts waiting to be tried again, that the listing didn't show: asked for by id.
    const failed = Object.keys(index.failures ?? {});
    const unlisted = [...new Set([...Object.keys(index.facts), ...failed])].filter((id) => !id.startsWith("card:") && !listed.has(id));
    const still = await existingFacts(ws, unlisted);
    if (!ours()) return;
    // Gone from memory, or another workspace's (an index moved from the bank's, which held both).
    dropMany(index, unlisted.filter((id) => !still.has(id) || !mine(still.get(id))));
    const onCard = lines ? new Set(lines.map((l) => `card:${l}`)) : null;
    if (onCard) dropMany(index, Object.keys(index.facts).filter((id) => id.startsWith("card:") && !onCard.has(id)));
    // A failing fact that's gone, off the card, or now older than what's sorted won't come up again.
    for (const id of failed) {
      const gone = id.startsWith("card:") ? !!onCard && !onCard.has(id) : listed.has(id) ? !!index.floorAt && listed.get(id)! < index.floorAt : !still.has(id);
      if (gone) delete index.failures![id];
    }
    index.sweptAt = Date.now();
    b.rows = undefined;
    void drainStashes(ws);
  }

  // New: card lines first (who the user is, their people), then the newest facts not sorted yet. A fact
  // that failed waits longer each time (30 minutes, then an hour) before it's tried again.
  const inScope = (r: FactRow) => !index.floorAt || r.at >= index.floorAt;
  const fresh: Fresh[] = [
    ...(lines ?? []).filter((l) => !Object.hasOwn(index.facts, `card:${l}`) && !failing(`card:${l}`) && !index.purge?.cards.includes(wordsHash(l))).map((l) => ({ id: `card:${l}`, text: l, at: Date.now(), session: null, level: "card", how: "card" as const })),
    ...rows.filter((r) => !Object.hasOwn(index.facts, r.id) && inScope(r) && !failing(r.id)).map((r) => ({ ...r, how: howOf(r.level, r.session) })),
  ];
  // Worked out by memory from a fact that was forgotten: deleted, without asking the model.
  const derived = (f: Fresh) => (f.from ?? []).some((id) => tombAt(index.tomb.facts, idTombs(keysIn(index), id)) !== undefined);
  const pending = fresh.filter((f) => !derived(f));
  if (pending.length < fresh.length) {
    for (const f of fresh) if (derived(f)) bury(index, f);
    if (!b.purging && !b.timers.has("purge")) void purge(ws);
  }

  // Sorted together: now when asked, when the card changed (a few lines, and what the user is), when
  // enough wait, or when the oldest has waited long enough.
  const oldest = Math.min(...pending.map((f) => f.at || Date.now()));
  const card = pending.some((f) => f.how === "card");
  if (pending.length && !now && !card && pending.length < WAIT_FOR && Date.now() - oldest < WAIT_MS) {
    index.waiting = pending.length;
    if (mode !== "quick") index.syncedAt = Date.now();
    save(ws, index);
    later(ws, "waiting", Math.max(60_000, WAIT_MS - (Date.now() - oldest)), { mode: "look", now: true }, true);
    return;
  }
  const todo = pending.slice(0, PER_RUN);
  if (todo.length && (await creditsOut())) {
    index.error = "Out of AI credit: new things wait until there's more.";
    if (ours()) save(ws, index);
    return;
  }
  if (!ours()) return;

  const byKey = new Map(Object.values(index.items).map((i) => [i.key, i.id] as [string, string]));
  let failed = false;
  let stopped = false;
  /** A call this look was answered: a refused one after that is about its facts, not a wrong setting. */
  let answered = false;
  /**
   * One batch's facts, sorted into items. An answer that can't be used is asked again in halves, down to
   * single facts, so one fact the model can't handle doesn't hold up (or give up) the rest. A model that
   * can't be reached stops the look: no fact is counted against, it's all tried again on the next look.
   */
  const apply = async (batch: Fresh[]): Promise<void> => {
    // Which lines memory keeps out of prompts (asked per batch: Jev reads up to 80 lines a call).
    const priv = await privateLines(batch.map((f) => f.text)).catch(() => new Set<string>());
    if (!ours()) return void (stopped = true);
    const got = await sortFacts(batch, knownFor(index, batch), epoch, ours);
    if (got === "gone" || !ours()) return void (stopped = true);
    if (got === "credit") {
      index.error = "Out of AI credit: new things wait until there's more.";
      return void (stopped = true);
    }
    if (got === "down") {
      index.error = "Couldn't sort new things just now. Bops tries again on its own.";
      return void (stopped = true);
    }
    // Refused with nothing answered this look, down to a single fact: a wrong setting (every request is
    // refused), not the fact. Stopped, nothing counted against it, tried again later.
    if (got === "refused" && batch.length === 1 && !answered) {
      index.error = "Couldn't sort new things just now. Bops tries again on its own.";
      return void (stopped = true);
    }
    if (got === "unusable" || got === "refused") {
      if (batch.length > 1) {
        const mid = Math.ceil(batch.length / 2);
        await apply(batch.slice(0, mid));
        if (!stopped) await apply(batch.slice(mid));
        return;
      }
      failed = true;
      // Tried again later, and given up after three times (sorted as nothing).
      index.failures ??= {};
      for (const f of batch) {
        const n = (index.failures[f.id]?.n ?? 0) + 1;
        if (n >= 3) {
          index.facts[f.id] = { items: [], at: f.at || Date.now() };
          delete index.failures[f.id];
        } else index.failures[f.id] = { n, at: Date.now() };
      }
      return;
    }
    answered = true;
    batch.forEach((f, j) => {
      const raws = got.get(j) ?? [];
      const words = wordsHash(f.text);
      // About something forgotten, in a forgotten fact's words, or not brought back by something new (worked
      // out again from the old chats, a card line, what memory works out): deleted, and its item stays gone.
      // Kept and hidden instead, it would still reach the bots with nothing in Orbit to forget again.
      const buried = raws.some((raw) => {
        const key = keyOfRaw(raw);
        if (!key) return false;
        const keys = keysIn(index);
        if (tombAt(index.tomb.facts, factTombs(keys, key, words)) !== undefined) return true;
        const forgotAt = tombAt(index.tomb.items, itemTombs(keys, key));
        return forgotAt !== undefined && !bringsBack(f, forgotAt);
      });
      if (buried) {
        bury(index, f);
        if (!b.purging && !b.timers.has("purge")) void purge(ws);
        return;
      }
      const src: ItemSource = {
        fact: f.id,
        text: clip(f.text, 600, true),
        at: f.at || Date.now(),
        from: f.how === "card" ? "Your card" : clip(factSource(f.session), 90, true),
        how: f.how,
        ...(priv.has(f.text) ? { private: true } : {}),
      };
      const made = raws.map((raw) => upsert(index, byKey, raw, src)).filter((x) => !!x);
      index.facts[f.id] = { items: [...new Set(made.map((m) => m.id))], at: src.at, wrote: Object.fromEntries(made.map((m) => [m.id, m.said])), s: f.session, h: words };
      if (index.failures?.[f.id]) delete index.failures[f.id];
    });
  };
  // One batch after another: each sees what the ones before it found (Dana, the demo), so mentions merge.
  for (let i = 0; i < todo.length && !stopped; i += BATCH) {
    await apply(todo.slice(i, i + BATCH));
    if (ours()) save(ws, index);
  }
  if (!ours()) return;
  const left = pending.length - todo.length;
  // What was waiting is sorted (a quick look that found nothing on the newest page leaves the count to the full looks).
  if (mode !== "quick" || pending.length) {
    index.waiting = undefined;
    clearTimeout(b.timers.get("waiting"));
    b.timers.delete("waiting");
  }
  // Sorting left for the next look (more than one look takes, or it stopped).
  index.more = left > 0 || (stopped && pending.some((f) => !Object.hasOwn(index.facts, f.id))) || (mode === "quick" && index.more) || undefined;
  if (mode !== "quick" && !stopped) index.syncedAt = Date.now();
  // Said while facts wait to be tried again (a fact given up after three tries no longer counts).
  if (!stopped) index.error = failed || Object.keys(index.failures ?? {}).length ? "Some new things couldn't be sorted yet. They're tried again later." : undefined;
  save(ws, index);
  // More to sort than one look takes: the next look soon (not after a failure: that waits).
  if (left > 0 && !failed && !stopped) later(ws, "more", 60_000, { mode: "fill", now: true });
}

/** A look later, once per reason: a newer ask replaces it, or (`keep`) leaves one already set. Never for an account that signed in since. */
function later(ws: string, why: string, ms: number, opts: SyncOpts, keep = false) {
  const b = space(ws);
  if (keep && b.timers.has(why)) return;
  clearTimeout(b.timers.get(why));
  const ours = sameState();
  const t = setTimeout(() => {
    b.timers.delete(why);
    if (ours() && wsOrCurrent(ws) === ws) void sync(ws, opts);
  }, ms);
  t.unref?.();
  b.timers.set(why, t);
}

/** While Bops is open: every 15 minutes, a look at the workspace in use, unless one ran meanwhile. */
function ensureTimer() {
  if (live.timer) return;
  live.timer = setInterval(() => {
    if (!categoriesOn()) return;
    const ws = currentWorkspaceId();
    const index = load(ws);
    if (Date.now() - Math.max(index.syncedAt ?? 0, index.triedAt ?? 0) >= STALE_MS - 30_000) void sync(ws, { mode: "look" });
  }, STALE_MS);
  live.timer.unref?.();
}

/**
 * Memory changed (memory.ts): a fact was saved just now (sorted in a few seconds); a chat or task was
 * saved (Honcho works out its facts over the next minutes, about 4 when measured: quick looks in 4 and
 * in 10 sort what they find at once, which is what fills the sections as the user chats); or Bops
 * noted a fact on its own (a quick look in 3 that leaves it waiting for the next few). The next message
 * saved doesn't set a look again or push it back.
 */
export function nudge(ws: string, why: "chat" | "saved" | "learned" | "card") {
  if (!categoriesOn()) return;
  ensureTimer();
  if (why === "learned") later(ws, "learned", 4_000, { mode: "quick", now: true });
  // A card line fixed or pinned: a look that reads the card, in a few seconds.
  else if (why === "card") later(ws, "card", 4_000, { mode: "look", now: true });
  else if (why === "chat") {
    later(ws, "chat", 4 * 60_000, { mode: "quick", now: true }, true);
    later(ws, "chat-late", 10 * 60_000, { mode: "quick", now: true }, true);
  } else later(ws, "saved", 3 * 60_000, { mode: "quick" }, true);
}

/** An item as the window gets it: at most 6 sources, each up to 300 characters, and nothing kept only for the engine. */
function forWindow(item: Item): MemoryItem {
  const out: Item = { ...item, sources: item.sources.slice(0, 6).map((s) => ({ ...s, text: s.text.slice(0, 300) })) };
  delete out.detailPrivate;
  return out;
}

/**
 * A workspace's categories for the app, as sorted so far. Asking starts a look when the last one is
 * old. `since`: the rev the window has; when nothing changed it gets {unchanged: true}.
 */
export function snapshot(ws: string, since?: number): MemorySnapshot | { unchanged: true; rev: number } {
  if (!categoriesOn()) return { on: false, ws, items: [], syncing: false };
  ensureTimer();
  const index = load(ws);
  const b = space(ws);
  const last = Math.max(index.syncedAt ?? 0, index.triedAt ?? 0);
  if (!b.running && Date.now() - last > STALE_MS) void sync(ws, { mode: "look" });
  // Opened: what the user's other Macs changed comes from Orgo (once now, then every 10 minutes).
  orbitOpened(ws);
  if (since === b.rev) return { unchanged: true, rev: b.rev };
  const all = Object.values(index.items);
  return {
    on: true,
    ws,
    rev: b.rev,
    items: all.filter((i) => !i.hidden).map(forWindow),
    hidden: all.filter((i) => i.hidden).map((i) => ({ id: i.id, category: i.category, title: i.title })),
    syncing: !!b.running,
    syncedAt: index.syncedAt,
    behind: index.behind,
    waiting: index.waiting,
    dreamAt: index.dreamAt,
    dreamReadyAt: index.dreamAt ? index.dreamAt + DREAM_EVERY_MS : undefined,
    error: index.error ?? ((index.purge?.tries ?? 0) >= PURGE_SAY_AFTER ? PURGE_ERROR : undefined),
  };
}

/** Look now, and sort what's new now (Refresh): a sweep, so what was deleted goes too. */
export const refresh = (ws: string) => sync(ws, { mode: "sweep", now: true });

/** Sort 300 more of the older facts (each 25 a model call). */
export function sortOlder(ws: string) {
  if (!categoriesOn()) throw new Error("Memory isn't set up.");
  const index = load(ws);
  if (!index.behind) return Promise.resolve();
  index.depth = (index.depth ?? FIRST_DEPTH) + OLDER_STEP;
  save(ws, index);
  return sync(ws, { mode: "fill", now: true });
}

/** Ask memory to tidy up now (memory.ts dream), at most once an hour; sweeps again as its results come in. */
export async function tidyUp(ws: string) {
  if (!categoriesOn()) throw new Error("Memory isn't set up.");
  const ours = sameState();
  const index = load(ws);
  if (index.dreamAt && Date.now() - index.dreamAt < DREAM_EVERY_MS) {
    const mins = Math.ceil((index.dreamAt + DREAM_EVERY_MS - Date.now()) / 60_000);
    throw new Error(`Memory tidied up a little while ago. Try again in ${mins} minute${mins === 1 ? "" : "s"}.`);
  }
  // Noted before asking, so a second press meanwhile doesn't ask (and pay) twice.
  const before = index.dreamAt;
  index.dreamAt = Date.now();
  save(ws, index);
  try {
    await askToDream(ws);
  } catch (e) {
    console.warn(`[categories] tidy up: ${(e as Error).message}`);
    if (ours()) {
      index.dreamAt = before;
      save(ws, index);
    }
    throw new Error("Couldn't reach memory to tidy up. Try again in a moment.");
  }
  if (!ours()) return;
  later(ws, "dream-soon", 4 * 60_000, { mode: "sweep", now: true });
  later(ws, "dream-later", 15 * 60_000, { mode: "sweep", now: true });
}

/** The user changed an item: its name or line (kept from then on), done or not, hidden or shown. */
export function editItem(ws: string, id: string, patch: { title?: string; detail?: string; done?: boolean; hidden?: boolean }) {
  if (!categoriesOn()) throw new Error("Memory isn't set up.");
  const index = load(ws);
  if (!Object.hasOwn(index.items, id)) throw new Error("That's gone already.");
  const item = index.items[id];
  if (patch.title !== undefined) {
    const t = clip(patch.title, 90, true);
    if (!t) throw new Error("Give it a name.");
    item.title = t;
    item.edited = true;
  }
  if (patch.detail !== undefined) {
    item.detail = clip(patch.detail, 160, true);
    item.edited = true;
    item.detailPrivate = undefined;
    item.private = lockOf(item);
  }
  if (patch.done !== undefined) {
    item.done = patch.done || undefined;
    item.marked = true;
  }
  if (patch.hidden !== undefined) item.hidden = patch.hidden || undefined;
  save(ws, index);
  return item;
}

/** Add to what's still to delete from memory (deleted by the next purge). */
function toPurge(index: Index, what: { facts?: string[]; cards?: string[]; sessions?: string[]; need?: Record<string, string[]> }) {
  const p = (index.purge ??= { facts: [], cards: [], sessions: [], need: {}, tries: 0, at: Date.now() });
  const add = (list: string[], more: string[] = []) => {
    for (const x of more) if (!list.includes(x)) list.push(x);
  };
  add(p.facts, what.facts);
  add(p.cards, what.cards);
  add(p.sessions, what.sessions);
  for (const [id, keys] of Object.entries(what.need ?? {})) p.need[id] = [...new Set([...(p.need[id] ?? []), ...keys])];
  // Something new to delete: tried at once, from the first try again.
  p.tries = 0;
}

/** The newest `n` of a tombstone list. */
const newest = (m: Record<string, number>, n: number) => (Object.keys(m).length > n ? Object.fromEntries(Object.entries(m).sort((a, b) => b[1] - a[1]).slice(0, n)) : m);

/**
 * Forget items: gone from Orbit at once, and deleted from memory, for good: every fact they were learned
 * from (about other things too: their words are in it) and their card lines, checked with memory after
 * and tried again until it doesn't have them (purge). Other items that were learned from those facts too
 * lose them (and go, when nothing else backs them and the user didn't change them). What's kept is
 * hashes only (Index.tomb). `sessions`: whole sessions to delete too (Delete everywhere). Answers the
 * names of what was forgotten.
 */
export function forgetItems(ws: string, ids: string[], sessions: string[] = []): string[] {
  if (!categoriesOn()) throw new Error("Memory isn't set up.");
  const index = load(ws);
  const items = [...new Set(ids)].filter((id) => Object.hasOwn(index.items, id)).map((id) => index.items[id]);
  if (!items.length && !sessions.length) return [];
  const now = Date.now();
  const facts = new Set<string>();
  const cards: string[] = [];
  const need: Record<string, string[]> = {};
  const [k] = secretsOf(ws, index);
  const sent = { del: items.map((i) => i.id), items: [] as string[], facts: [] as string[] };
  for (const item of items) {
    const ih = mac(k, `item|${item.key}`);
    index.tomb.items[ih] = now;
    sent.items.push(ih);
    const text = new Map(item.sources.map((x) => [x.fact, x.text]));
    // Every fact sorted into it (its sources are only the newest 12).
    for (const [id, f] of Object.entries(index.facts)) {
      if (!f.items.includes(item.id)) continue;
      facts.add(id);
      const card = id.startsWith(CARD);
      const words = f.h ?? (card ? wordsHash(id.slice(CARD.length)) : text.has(id) ? wordsHash(text.get(id)!) : undefined);
      if (words) {
        const fh = mac(k, `fact|${ih}|${words}`);
        index.tomb.facts[fh] = now;
        sent.facts.push(fh);
      }
      // Words not kept here (sorted before they were): read from memory before it goes ("h:", made with the secret).
      else (need[id] ??= []).push(`h:${ih}`);
      if (card) cards.push(words!);
      else {
        const dh = mac(k, `id|${id}`);
        index.tomb.facts[dh] = now;
        sent.facts.push(dh);
      }
    }
    delete index.items[item.id];
  }
  index.tomb.items = newest(index.tomb.items, TOMB_ITEMS);
  index.tomb.facts = newest(index.tomb.facts, TOMB_FACTS);
  sendLater(index, sent, now);
  const all = [...facts];
  dropMany(index, all);
  // Sorted as nothing until memory no longer has them, so a look meanwhile doesn't sort them again.
  for (const id of all) if (!id.startsWith(CARD)) index.facts[id] = { items: [], at: now, s: null };
  toPurge(index, { facts: all.filter((id) => !id.startsWith(CARD)), cards, sessions, need });
  space(ws).rows = undefined;
  save(ws, index);
  void purge(ws);
  return items.map((i) => i.title);
}

/** Forget one item (the bots' orbit_forget, and the route's old shape). */
export function forgetItem(ws: string, id: string) {
  return Promise.resolve().then(() => void forgetItems(ws, [id]));
}

/**
 * Delete what's still to delete from memory (Index.purge), then check memory no longer has it; what it
 * still has is tried again: in 5 seconds, then 30, 2 minutes, 10, then every 30 (and at every look).
 * One run at a time per workspace; one asked for meanwhile runs after it.
 */
export function purge(ws: string): Promise<void> {
  const b = space(ws);
  if (b.purging) {
    b.purgeAgain = true;
    return b.purging;
  }
  clearTimeout(b.timers.get("purge"));
  b.timers.delete("purge");
  const ours = sameState();
  b.purging = (async () => {
    do {
      b.purgeAgain = false;
      if (!categoriesOn() || !ours()) return;
      const index = load(ws);
      const p = index.purge;
      if (!p) return;
      const take = { facts: [...p.facts], cards: [...p.cards], sessions: [...p.sessions], need: { ...p.need } };
      // Facts forgotten before their words were kept: read first, for their tombstones.
      const needed = Object.keys(take.need);
      if (needed.length) {
        const rows = await factsByIds(ws, needed).catch(() => null);
        if (!ours()) return;
        if (rows) {
          for (const r of rows)
            for (const ih of take.need[r.id] ?? []) {
              // Made with the secret ("h:"), or an item hash from before it (plain, matched only here, never sent).
              const fh = ih.startsWith("h:") ? mac(keysIn(index)[0], `fact|${ih.slice(2)}|${wordsHash(r.text)}`) : sha(`fact|${ih}|${wordsHash(r.text)}`);
              index.tomb.facts[fh] = Date.now();
              if (ih.startsWith("h:")) sendLater(index, { facts: [fh] });
            }
          for (const id of needed) delete p.need[id];
        }
      }
      const cards = new Set(take.cards);
      const left = await purgeMemory(ws, { facts: take.facts, cardLine: cards.size ? (l) => cards.has(wordsHash(l)) : undefined, sessions: take.sessions }).catch((e: Error) => {
        console.warn(`[categories] ${ws}: deleting from memory: ${e.message}`);
        return { facts: take.facts, card: cards.size > 0, sessions: take.sessions };
      });
      if (!ours()) return;
      // What was deleted comes off the list; what was added meanwhile stays on it.
      const gone = (list: string[], tried: string[], still: string[]) => list.filter((x) => !tried.includes(x) || still.includes(x));
      p.facts = gone(p.facts, take.facts, left.facts);
      p.sessions = gone(p.sessions, take.sessions, left.sessions);
      if (!left.card) p.cards = p.cards.filter((h) => !cards.has(h));
      // Deleted for good: no longer kept as sorted.
      for (const id of take.facts) if (!left.facts.includes(id) && Object.hasOwn(index.facts, id) && !index.facts[id].items.length) delete index.facts[id];
      const failed = left.facts.length > 0 || left.card || left.sessions.length > 0 || Object.keys(p.need).length > 0;
      if (!p.facts.length && !p.cards.length && !p.sessions.length && !Object.keys(p.need).length) index.purge = undefined;
      else if (failed && !b.purgeAgain) {
        p.tries++;
        p.at = Date.now();
        const t = setTimeout(() => {
          b.timers.delete("purge");
          if (ours()) void purge(ws);
        }, PURGE_RETRY_MS[Math.min(p.tries, PURGE_RETRY_MS.length) - 1]);
        t.unref?.();
        b.timers.set("purge", t);
      }
      save(ws, index);
    } while (b.purgeAgain);
  })().finally(() => {
    b.purging = undefined;
    b.rev++;
  });
  return b.purging;
}

/** A chat or call in memory that Delete everywhere would delete, and the other items it also taught Orbit. */
export type DeleteSession = { id: string; name: string; at: number; facts: number; alsoFor: string[] };

/** Only these sessions are ever deleted everywhere: a chat or call, or a task, in Bops. */
const deletable = (s: string | null | undefined): s is string => !!s && (s.startsWith("bops-chat-") || s.startsWith("bops-task-"));

/**
 * What Delete everywhere would delete with an item: the sessions in memory its facts came from that Bops
 * still has the chat or task of (its copy there, every message in it), each with the other items in this Orbit learned from it
 * too, so none goes unsaid. Where a fact was learned is asked of memory for facts sorted before that was kept.
 */
export async function deletePreview(ws: string, id: string): Promise<DeleteSession[]> {
  if (!categoriesOn()) throw new Error("Memory isn't set up.");
  const ours = sameState();
  const index = load(ws);
  if (!Object.hasOwn(index.items, id)) throw new Error("That's gone already.");
  const unknown = Object.entries(index.facts)
    .filter(([fid, f]) => !fid.startsWith(CARD) && f.s === undefined && f.items.length)
    .map(([fid]) => fid);
  for (let i = 0; i < unknown.length; i += 100) {
    const chunk = unknown.slice(i, i + 100);
    const rows = await factsByIds(ws, chunk);
    if (!ours()) throw new Error("Another account signed in.");
    const got = new Map(rows.map((r) => [r.id, r.session]));
    for (const fid of chunk) if (Object.hasOwn(index.facts, fid)) index.facts[fid].s = got.get(fid) ?? null;
  }
  if (unknown.length) save(ws, index);
  const out = new Map<string, DeleteSession>();
  for (const f of Object.values(index.facts)) {
    // Only a chat, a call or a task still in Bops (its copy in memory goes, the chat stays): never the
    // user's other agents' sessions or a chat deleted from Bops, whose only copy is memory's. Not an issue,
    // not a workspace's saved facts.
    if (!f.items.includes(id) || !deletable(f.s) || !sessionWorkspace(f.s)) continue;
    const x = out.get(f.s) ?? { id: f.s, name: factSource(f.s), at: 0, facts: 0, alsoFor: [] };
    x.at = Math.max(x.at, f.at);
    x.facts++;
    out.set(f.s, x);
  }
  for (const f of Object.values(index.facts)) {
    const x = f.s ? out.get(f.s) : undefined;
    if (!x) continue;
    for (const other of f.items) {
      const title = other !== id && Object.hasOwn(index.items, other) ? index.items[other].title : null;
      if (title && !x.alsoFor.includes(title)) x.alsoFor.push(title);
    }
  }
  // The workspace's Orbit in Orgo knows the sessions the user's other Macs learned it from too (the same
  // rule: a chat, call or task still in Bops), and how many other items they taught.
  const theirs = await orbitPreview(ws, id);
  if (!ours()) throw new Error("Another account signed in.");
  for (const s of theirs ?? []) {
    if (!deletable(s.honchoSessionId) || !sessionWorkspace(s.honchoSessionId)) continue;
    const x = out.get(s.honchoSessionId) ?? { id: s.honchoSessionId, name: factSource(s.honchoSessionId), at: 0, facts: 0, alsoFor: [] };
    const more = s.otherItems - x.alsoFor.length;
    if (more > 0) x.alsoFor.push(`${more} more item${more === 1 ? "" : "s"}`);
    out.set(s.honchoSessionId, x);
  }
  return [...out.values()].sort((a, b) => b.at - a.at);
}

/**
 * Delete everywhere: Forget, and delete from memory the sessions its facts came from (deletePreview, all
 * of them, or of `only` those the user was shown: never one deletePreview leaves out). The chats stay in Bops; their copy in memory goes.
 * Answers what was deleted.
 */
export async function deleteEverywhere(ws: string, id: string, only?: string[]) {
  const shown = await deletePreview(ws, id);
  const sessions = shown.filter((x) => !only || only.includes(x.id));
  forgetItems(ws, [id], sessions.map((x) => x.id));
  return sessions;
}

/** The workspace asked for when it's one of the user's, else the one in use. */
export const wsOrCurrent = (ws: string | null | undefined) => (ws && (getState().workspaces ?? []).some((w) => w.id === ws) ? ws : currentWorkspaceId());

/* ---------------- The workspace's Orbit in Orgo (orbit-sync.ts) ---------------- */

/** An item and the facts behind it (every one, not only the newest 12 it shows), as orbit-sync.ts sends it. */
export type OrbitEntry = { item: MemoryItem & { detailPrivate?: boolean }; facts: { id: string; session: string | null; at: number; said?: string; private?: boolean }[] };

/** An item as Orgo answers it (app/api/projects/[id]/orbit). */
export type OrbitRemoteItem = {
  bopsId: string;
  category: string;
  key: string;
  title: string;
  detail: string | null;
  whenAt: string | null;
  done: boolean;
  marked: boolean;
  who: string | null;
  firstSeen: string | null;
  lastSeen: string | null;
  sources: { honchoConclusionId: string; honchoSessionId: string | null; said: string | null; at: string | null }[];
};

const ITEM_ID = /^[0-9a-f]{10}$/;

function entryOf(index: Index, item: Item, byItem?: Map<string, OrbitEntry["facts"]>): OrbitEntry {
  let facts = byItem?.get(item.id);
  if (!byItem) {
    facts = [];
    for (const [id, f] of Object.entries(index.facts)) if (!id.startsWith(CARD) && f.items.includes(item.id)) facts.push({ id, session: f.s ?? null, at: f.at, private: f.wrote?.[item.id]?.p });
  }
  const shown = new Map(item.sources.map((s) => [s.fact, s]));
  return {
    item,
    facts: (facts ?? []).map((f) => {
      const s = shown.get(f.id);
      return { ...f, at: s?.at ?? f.at, ...(s && !s.private ? { said: s.text } : {}), ...(f.private || s?.private ? { private: true } : {}) };
    }),
  };
}

/** The workspace's items and the facts behind each, and what each was when last sent (orbit-sync.ts push). */
export function orbitItemsOf(ws: string): { bank: string; entries: OrbitEntry[]; pushed: Record<string, string>; refused: Record<string, string> } | null {
  if (!categoriesOn()) return null;
  const index = load(ws);
  const byItem = new Map<string, OrbitEntry["facts"]>();
  for (const [id, f] of Object.entries(index.facts)) {
    if (id.startsWith(CARD)) continue;
    for (const it of f.items) {
      const list = byItem.get(it) ?? [];
      list.push({ id, session: f.s ?? null, at: f.at, private: f.wrote?.[it]?.p });
      byItem.set(it, list);
    }
  }
  // An item whose key is forgotten is never sent (it can be here a moment, from another Mac's copy before its forget arrived).
  const keys = keysIn(index);
  const live = Object.values(index.items).filter((i) => tombAt(index.tomb.items, itemTombs(keys, i.key)) === undefined);
  return { bank: index.bank, entries: live.map((i) => entryOf(index, i, byItem)), pushed: { ...(index.pushed ?? {}) }, refused: { ...(index.refused ?? {}) } };
}

/**
 * The Orgo project the workspace's Orbit was last read from and sent to, and when it was read. Another
 * project (the workspace was tied to another): read whole again, and everything is sent again.
 */
export function orbitRemote(ws: string, project: string): { at?: string } | null {
  if (!categoriesOn()) return null;
  const index = load(ws);
  if (index.remote?.project !== project) {
    index.remote = { project };
    index.pushed = {};
    index.refused = undefined;
    save(ws, index, { quiet: true });
  }
  return { at: index.remote.at };
}

export function orbitRemoteAt(ws: string, project: string, at: string) {
  if (!categoriesOn()) return;
  const index = load(ws);
  if (index.remote?.project !== project) return;
  index.remote.at = at;
  save(ws, index, { quiet: true });
}

/** These items are as Orgo has them now (the hash of what was sent, by id). */
export function orbitPushed(ws: string, hashes: Record<string, string>) {
  if (!categoriesOn()) return;
  const index = load(ws);
  index.pushed = { ...(index.pushed ?? {}), ...hashes };
  save(ws, index, { quiet: true });
}

/** Orgo refused these items as they are now (the hash of each, by id): not sent again until they change. */
export function orbitRefused(ws: string, hashes: Record<string, string>) {
  if (!categoriesOn()) return;
  const index = load(ws);
  index.refused = { ...(index.refused ?? {}), ...hashes };
  for (const id of Object.keys(hashes)) if (index.pushed) delete index.pushed[id];
  save(ws, index, { quiet: true });
}

/** What's still to send: items forgotten here and the hashes of what was forgotten. */
export function orbitOutbox(ws: string): { del: string[]; items: string[]; facts: string[] } | null {
  if (!categoriesOn()) return null;
  const o = load(ws).out;
  return { del: [...(o?.del ?? [])], items: Object.keys(o?.items ?? {}), facts: Object.keys(o?.facts ?? {}) };
}

/** Sent (or given up on): off the list. */
export function orbitSent(ws: string, what: { del?: string[]; items?: string[]; facts?: string[] }) {
  if (!categoriesOn()) return;
  const index = load(ws);
  const o = index.out;
  if (!o) return;
  if (what.del) o.del = o.del.filter((x) => !what.del!.includes(x));
  for (const h of what.items ?? []) delete o.items[h];
  for (const h of what.facts ?? []) delete o.facts[h];
  if (!o.del.length && !Object.keys(o.items).length && !Object.keys(o.facts).length) index.out = undefined;
  save(ws, index, { quiet: true });
}

/**
 * Facts Orgo said the forgotten items were learned from that this Mac didn't sort (the user's other Macs
 * did): deleted from memory too, and hashed (a fact worked out from one goes as well).
 */
export function orbitForgetFacts(ws: string, ids: string[]) {
  if (!categoriesOn()) return;
  const index = load(ws);
  const fresh = [...new Set(ids)].filter((id) => typeof id === "string" && id && !id.startsWith(CARD) && !index.purge?.facts.includes(id));
  if (!fresh.length) return;
  dropMany(index, fresh);
  const [k] = secretsOf(ws, index);
  const now = Date.now();
  const sent: string[] = [];
  for (const id of fresh) {
    index.facts[id] = { items: [], at: now, s: null };
    const h = mac(k, `id|${id}`);
    index.tomb.facts[h] = now;
    sent.push(h);
  }
  sendLater(index, { facts: sent }, now);
  toPurge(index, { facts: fresh });
  space(ws).rows = undefined;
  save(ws, index);
  void purge(ws);
}

/** One item into another (the same thing, sorted on two Macs): its facts, sources and what the user set go with it. */
function mergeInto(index: Index, from: string, into: string) {
  if (from === into || !Object.hasOwn(index.items, from)) return;
  const a = index.items[from];
  delete index.items[from];
  if (!Object.hasOwn(index.items, into)) {
    a.id = into;
    index.items[into] = a;
  } else {
    const b = index.items[into];
    const seen = new Set(b.sources.map((s) => s.fact));
    b.sources = [...b.sources, ...a.sources.filter((s) => !seen.has(s.fact))].sort((x, y) => y.at - x.at).slice(0, 12);
    b.first = Math.min(b.first, a.first);
    b.last = Math.max(b.last, a.last);
    if (!b.detail && a.detail) {
      b.detail = a.detail;
      b.detailPrivate = a.detailPrivate;
    }
    b.when ??= a.when;
    b.who ??= a.who;
    if (a.edited) b.edited = true;
    if (a.hidden) b.hidden = true;
    if (a.marked && !b.marked) {
      b.marked = true;
      b.done = a.done;
    }
    b.private = lockOf(b);
  }
  for (const f of Object.values(index.facts)) {
    if (!f.items.includes(from)) continue;
    f.items = [...new Set(f.items.map((x) => (x === from ? into : x)))];
    if (f.wrote?.[from]) {
      f.wrote[into] ??= f.wrote[from];
      delete f.wrote[from];
    }
  }
  if (index.pushed) delete index.pushed[from];
}

/** Orgo merged items into others (the same category and key from another Mac): the same here. */
export function orbitMerged(ws: string, merged: { bopsId: string; intoBopsId: string }[]) {
  if (!categoriesOn() || !merged.length) return;
  const index = load(ws);
  for (const m of merged) if (ITEM_ID.test(m.intoBopsId)) mergeInto(index, m.bopsId, m.intoBopsId);
  save(ws, index);
}

/** An item gone in Orgo (forgotten on another Mac): gone here, its facts kept as sorted into nothing (they're being deleted there). */
function dropRemote(index: Index, id: string) {
  if (!Object.hasOwn(index.items, id)) return false;
  delete index.items[id];
  for (const f of Object.values(index.facts)) {
    if (!f.items.includes(id)) continue;
    f.items = f.items.filter((x) => x !== id);
    if (f.wrote) delete f.wrote[id];
  }
  if (index.pushed) delete index.pushed[id];
  if (index.refused) delete index.refused[id];
  return true;
}

/**
 * Whether an item from Orgo whose key was forgotten here comes back: only by what brings a forgotten item
 * back on this Mac (bringsBack: something the user said in that chat after the forget, or a note saved
 * after it), read from the facts Orgo knows it from. Another Mac that hadn't heard of the forget yet may
 * have sorted a fact into it and sent it again; that alone doesn't.
 */
function remoteBringsBack(x: OrbitRemoteItem, forgotAt: number) {
  return (x.sources ?? []).some((s) => {
    if (typeof s?.honchoConclusionId !== "string") return false;
    const session = typeof s.honchoSessionId === "string" ? s.honchoSessionId : null;
    // Orgo doesn't say how a fact was learned: a chat's is "said", a notes one "saved", any other can't bring it back.
    const how = session?.startsWith("bops-chat-") ? "said" : session?.startsWith("bops-notes-") ? "saved" : "figured";
    return bringsBack({ at: msOf(s.at) ?? 0, session, how }, forgotAt);
  });
}

const msOf = (s: string | null | undefined) => (s && Number.isFinite(Date.parse(s)) ? Date.parse(s) : undefined);

/**
 * What Orgo has of the workspace's Orbit (all of it when `full`, else what changed since the last read):
 * the hashes of what was forgotten join this Mac's, items deleted there go here (first), and each item
 * comes in. An item this Mac changed since it last sent it keeps its own name, line and the rest (it's
 * sent next), and either way gets the facts Orgo knows it from, so the next send has them all. One with
 * the same key as an item here under another id takes the place of that one. With `full`, an item sent
 * from here before that Orgo no longer has is gone (deleted there long ago). `hashOf`: what an item is as
 * it would be sent (orbit-sync.ts), to tell what this Mac changed.
 */
export function orbitApply(
  ws: string,
  r: { items: OrbitRemoteItem[]; tombstones: { hash: string; kind: string; createdAt: string | null }[]; deleted: string[]; full: boolean },
  hashOf: (e: OrbitEntry) => string | null,
) {
  if (!categoriesOn()) return;
  const index = load(ws);
  const now = Date.now();
  const newItemTombs = new Set<string>();
  for (const t of r.tombstones) {
    if (typeof t?.hash !== "string" || !/^[0-9a-f]{64}$/.test(t.hash)) continue;
    const m = t.kind === "fact" ? index.tomb.facts : index.tomb.items;
    if (!Object.hasOwn(m, t.hash)) {
      m[t.hash] = msOf(t.createdAt) ?? now;
      if (t.kind !== "fact") newItemTombs.add(t.hash);
    }
  }
  index.tomb.items = newest(index.tomb.items, TOMB_ITEMS);
  index.tomb.facts = newest(index.tomb.facts, TOMB_FACTS);
  for (const id of r.deleted) dropRemote(index, id);
  const keys = keysIn(index);
  // Forgotten on another Mac while this one sorted something into it (and sent it before the forget came):
  // gone here too, and deleted in Orgo again, unless something new here brings it back.
  if (newItemTombs.size)
    for (const item of Object.values(index.items)) {
      const h = itemTombs(keys, item.key).find((x) => newItemTombs.has(x));
      if (!h) continue;
      const forgotAt = index.tomb.items[h];
      if (item.sources.some((src) => bringsBack({ at: src.at, session: index.facts[src.fact]?.s ?? null, how: src.how }, forgotAt))) continue;
      dropRemote(index, item.id);
      sendLater(index, { del: [item.id] });
    }
  const byKey = new Map(Object.values(index.items).map((i) => [i.key, i.id] as [string, string]));
  const deleting = new Set(index.purge?.facts ?? []);
  const forgotten = new Set(index.out?.del ?? []);
  const seen = new Set<string>();
  for (const x of r.items) {
    if (!x || !ITEM_ID.test(x.bopsId) || !CATEGORY_IDS.includes(x.category as CategoryId) || typeof x.key !== "string" || !x.key || typeof x.title !== "string") continue;
    seen.add(x.bopsId);
    // Forgotten here, its delete not sent yet: it stays gone.
    if (forgotten.has(x.bopsId)) continue;
    // Its key forgotten (here, or on a Mac whose hashes came): made again there by a Mac that hadn't heard
    // of the forget. It stays gone, and its delete goes again, unless something new brings it back.
    const forgotAt = tombAt(index.tomb.items, itemTombs(keys, x.key));
    if (forgotAt !== undefined) {
      if (!remoteBringsBack(x, forgotAt)) {
        dropRemote(index, x.bopsId);
        sendLater(index, { del: [x.bopsId] });
        forgotten.add(x.bopsId);
        continue;
      }
      for (const h of itemTombs(keys, x.key)) if (Object.hasOwn(index.tomb.items, h)) delete index.tomb.items[h];
    }
    const other = byKey.get(x.key);
    if (other && other !== x.bopsId && Object.hasOwn(index.items, other)) mergeInto(index, other, x.bopsId);
    let item = Object.hasOwn(index.items, x.bopsId) ? index.items[x.bopsId] : undefined;
    const clean = !item || (index.pushed?.[x.bopsId] !== undefined && hashOf(entryOf(index, item)) === index.pushed[x.bopsId]);
    const first = msOf(x.firstSeen) ?? now;
    const last = msOf(x.lastSeen) ?? first;
    if (!item) {
      item = { id: x.bopsId, category: x.category as CategoryId, key: x.key, title: "", detail: "", sources: [], first, last };
      index.items[x.bopsId] = item;
    }
    byKey.set(x.key, x.bopsId);
    if (clean) {
      item.category = x.category as CategoryId;
      item.key = x.key;
      item.title = clip(x.title, 90, true) || item.title || "Untitled";
      item.detail = clip(x.detail ?? "", 160, true);
      item.detailPrivate = undefined;
      item.when = (x.whenAt && whenOf(x.whenAt.slice(0, 16).replace(" ", "T"))) || whenOf((x.whenAt ?? "").slice(0, 10)) || undefined;
      item.who = x.who ? clip(x.who, 90, true) : undefined;
      item.done = x.done || undefined;
      item.marked = x.marked || undefined;
      item.first = first;
      item.last = last;
    }
    // The facts Orgo knows it from (another Mac's too): this Mac's sorting knows them, and the next send has them all.
    for (const s of x.sources ?? []) {
      const id = s?.honchoConclusionId;
      if (typeof id !== "string" || !id || id.startsWith(CARD) || deleting.has(id)) continue;
      const at = msOf(s.at) ?? last;
      const session = typeof s.honchoSessionId === "string" ? s.honchoSessionId : null;
      if (!Object.hasOwn(index.facts, id)) index.facts[id] = { items: [x.bopsId], at, s: session };
      else if (!index.facts[id].items.includes(x.bopsId)) index.facts[id].items.push(x.bopsId);
      if (!item.sources.some((y) => y.fact === id))
        item.sources.push({ fact: id, text: clip(s.said ?? "", 600, true), at, from: clip(factSource(session), 90, true), how: session?.startsWith("bops-chat-") ? "said" : "saved" });
    }
    item.sources = item.sources.sort((a, b) => b.at - a.at).slice(0, 12);
    item.private = lockOf(item);
    // As Orgo has it: sent only when this Mac has more (or other) to say.
    if (clean) {
      const theirs = hashOf({
        item: { ...item, title: clip(x.title, 90, true), sources: [] },
        facts: (x.sources ?? []).filter((s) => typeof s?.honchoConclusionId === "string").map((s) => ({ id: s.honchoConclusionId, session: s.honchoSessionId ?? null, at: msOf(s.at) ?? last, ...(s.said ? { said: s.said } : {}) })),
      });
      if (theirs) (index.pushed ??= {})[x.bopsId] = theirs;
    }
  }
  // Read whole: what was sent from here before and isn't there any more was deleted there.
  if (r.full) for (const id of Object.keys(index.pushed ?? {})) if (!seen.has(id)) dropRemote(index, id);
  space(ws).rows = undefined;
  save(ws, index);
}
