import "server-only";
import { randomBytes } from "node:crypto";
import { existsSync, mkdirSync, readFileSync, renameSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { CATEGORIES, CATEGORY_IDS, categoriesOpen, type CategoryId, type ItemSource, type MemoryItem, type MemorySnapshot } from "@/lib/memory-categories";
import { creditsOut, noteOutOfCredit } from "./cloud";
import { bankOf, cardOf, dream as askToDream, existingFacts, factSource, forgetFacts, memoryOn, privateLines, scanFacts, type FactRow } from "./memory";
import { openaiClient } from "./openai-client";
import { onPostgres } from "./persist";
import { getState, ownerName, sameState, stateEpoch, userDir } from "./store";
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
 * stops at the first page it has seen all of. It runs on opening and every 15 minutes, a few minutes
 * after a chat or task is saved (Honcho needs that long to work out new facts), seconds after a fact
 * is saved by hand or by a bot, and on Refresh. Sorting costs AI credit, so new facts wait to be
 * sorted together: when 10 are waiting, or the oldest has waited 30 minutes (a fact saved by hand,
 * Refresh and the first look sort at once). Every 6 hours, on Refresh and after Tidy up, a sweep also
 * checks that what was sorted is still in memory (deleted facts leave their items).
 *
 * The first look sorts the card and the newest 300 facts; older ones are counted, and sorted 300 at a
 * time when the user asks (Sort older).
 *
 * Kept per bank (workspaces can share one) in the user's folder on this Mac, never in the app state
 * (which goes to the window every few seconds and to Bops Cloud): <userDir>/memory-categories/<bank>.json.
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
/** Tidying up (dreaming) on request, at most this often. */
const DREAM_EVERY_MS = 60 * 60_000;

const MODEL = process.env.BOPS_MEMORY_MODEL ?? process.env.BOPS_CHAT_MODEL ?? process.env.BOPS_SAM_MODEL ?? "gpt-6.1-sol";

type Index = {
  v: 1;
  bank: string;
  /** Every fact (and card line, "card:<line>") already sorted, and the items it went into. */
  facts: Record<string, { items: string[]; at: number }>;
  items: Record<string, MemoryItem>;
  /** Items the user forgot ("<category>:<key>", and when): only something said in a chat after that makes one again. */
  forgotten: Record<string, number>;
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
  error?: string;
};

/** quick: the newest page. look: pages until one was all seen. fill: the sorted depth. sweep: fill, and check what was sorted is still there. */
type Mode = "quick" | "look" | "fill" | "sweep";
const RANK: Record<Mode, number> = { quick: 0, look: 1, fill: 2, sweep: 3 };
/** `now`: sort what's new right away (a fact saved by hand, Refresh, the first look) instead of waiting for more. */
type SyncOpts = { mode?: Mode; now?: boolean };

type Bank = {
  index?: Index;
  /** The file the index was read from: an index is only ever written back there (another account's sign-in has another folder). */
  file?: string;
  running?: Promise<void>;
  /** A look asked for while one runs: it runs once that one is done. */
  again?: SyncOpts;
  timers: Map<string, ReturnType<typeof setTimeout>>;
  /** Forgets, one at a time (each changes memory and the card). */
  forgetting?: Promise<unknown>;
  /** The facts last read to the sorted depth, for the next look that continues sorting them (not read again for 10 minutes). */
  rows?: { at: number; depth: number; rows: FactRow[]; total: number };
};
type Live = { banks: Map<string, Bank>; timer?: ReturnType<typeof setInterval> };
const g = globalThis as unknown as { bopsCategories?: Live };
const live: Live = (g.bopsCategories ??= { banks: new Map() });

const openai = openaiClient();

/** On this Mac (not a hosted server), signed in, with memory set up, for an account they're open to. */
export const categoriesOn = () => !onPostgres() && userDir() !== null && memoryOn() && categoriesOpen(getState());

const bankState = (bank: string) => {
  let b = live.banks.get(bank);
  if (!b) live.banks.set(bank, (b = { timers: new Map() }));
  return b;
};

/** Honcho ids are letters, digits, _ and -: safe as a file name as they are. */
const fileOf = (bank: string) => {
  const dir = userDir();
  return dir ? join(/*turbopackIgnore: true*/ dir, "memory-categories", `${bank.replace(/[^A-Za-z0-9_-]/g, "-")}.json`) : null;
};

const empty = (bank: string): Index => ({ v: 1, bank, facts: {}, items: {}, forgotten: {} });

/** The bank's index for the account signed in, from its file once (a damaged file starts over: everything in it can be sorted again). */
function load(bank: string): Index {
  const b = bankState(bank);
  const file = fileOf(bank);
  if (b.index && b.file === (file ?? undefined)) return b.index;
  let index = empty(bank);
  if (file && existsSync(/*turbopackIgnore: true*/ file)) {
    try {
      const read = JSON.parse(readFileSync(/*turbopackIgnore: true*/ file, "utf8")) as Index;
      if (read?.v === 1 && read.items && read.facts) {
        index = { ...empty(bank), ...read };
        if (Array.isArray(index.forgotten)) index.forgotten = Object.fromEntries((index.forgotten as unknown as string[]).map((k) => [k, Date.now()]));
      }
    } catch (e) {
      console.warn(`[categories] ${bank}: unreadable index, starting over (${(e as Error).message})`);
    }
  }
  b.index = index;
  b.file = file ?? undefined;
  b.rows = undefined;
  return index;
}

/**
 * Written whole, to a temp file then renamed, readable by this user only. Only into the file it was
 * read from, and only while that's still the signed-in account's: work that outlived a sign-out never
 * writes one account's categories into another's folder.
 */
function save(bank: string, index: Index) {
  const b = bankState(bank);
  const file = fileOf(bank);
  if (!file || b.index !== index || b.file !== file) return;
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
 * Add what a fact says about one item: a new item, or one more mention of a known one. A newer
 * mention says how things stand now (its line, its date, done or not); an older one, or a card line
 * about something chats already said more of, only fills in what's missing. Returns the item's id.
 */
function upsert(index: Index, byKey: Map<string, string>, raw: Raw, src: ItemSource): string | null {
  if (!CATEGORY_IDS.includes(raw.category as CategoryId)) return null;
  const category = raw.category as CategoryId;
  const title = clip(raw.title, 90);
  const key = title ? keyOf(category, raw.key, title) : null;
  if (!key) return null;
  // Forgotten: only something said in a chat after that brings it back, never a rewritten card line or what memory works out from before.
  const forgot = Object.hasOwn(index.forgotten, key) ? index.forgotten[key] : 0;
  if (forgot) {
    if (src.how !== "said" || src.at <= forgot) return null;
    delete index.forgotten[key];
  }
  const known = byKey.get(key);
  let item = known && Object.hasOwn(index.items, known) ? index.items[known] : undefined;
  if (!item) {
    item = { id: randomBytes(5).toString("hex"), category, key, title, detail: clip(raw.detail, 160), sources: [], first: src.at, last: src.at };
    index.items[item.id] = item;
    byKey.set(key, item.id);
  }
  const said = item.sources.filter((s) => s.how !== "card");
  const newer = src.how === "card" ? !said.length && src.at >= item.last : src.at >= Math.max(0, ...said.map((s) => s.at));
  const detail = clip(raw.detail, 160);
  if (!item.edited && detail && (newer || !item.detail)) item.detail = detail;
  // "Priya" becomes "Priya Shah" when any mention has the fuller name.
  if (!item.edited && title.length > item.title.length && title.toLowerCase().startsWith(`${item.title.toLowerCase()} `)) item.title = title;
  const when = whenOf(raw.when);
  if (when && (newer || !item.when)) item.when = when;
  const who = clip(raw.who, 90);
  if (who && (newer || !item.who)) item.who = who;
  if (newer && !item.marked && (category === "todos" || category === "promises")) item.done = raw.done || undefined;
  item.sources = [src, ...item.sources.filter((s) => s.fact !== src.fact)].sort((a, b) => b.at - a.at).slice(0, 12);
  item.private = item.sources.every((s) => s.private) || undefined;
  item.first = Math.min(item.first, src.at);
  item.last = Math.max(item.last, src.at);
  return item.id;
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
    item.private = (item.sources.length > 0 && item.sources.every((s) => s.private)) || undefined;
    if (!backed.has(id) && !item.edited && !item.marked && !item.hidden) delete index.items[id];
  }
  return true;
}

/** Facts deleted from memory on this Mac (memory.ts: Delete, Undo, Fix, the review's Delete all): out of the categories at once. */
export function dropFacts(bank: string, ids: string[]) {
  if (!categoriesOn()) return;
  const index = load(bank);
  if (dropMany(index, ids)) save(bank, index);
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
 * the batch to its items. Null when it couldn't answer (tried again later), "credit" when the AI credit
 * ran out, "gone" when another account signed in before it was asked.
 */
async function sortFacts(facts: Fresh[], known: Record<string, unknown>, epoch: number, ours: () => boolean): Promise<Map<number, Raw[]> | null | "credit" | "gone"> {
  const owner = ownerName();
  const bots = getState().bots.map((b) => b.name).filter(Boolean);
  const instructions = [
    `You sort what an AI memory system learned about ${owner} into the categories of their app. Each fact below was learned from ${owner}'s chats with their AI assistants, saved as a fact, worked out by the memory system, or is a line of ${owner}'s profile card. Turn each fact into zero or more items in these categories:`,
    ...CATEGORIES.map((c) => `- ${c.id}: ${c.about}`),
    "Rules:",
    "- Only what the fact says. Never guess, never add.",
    "- Most facts give zero or one item. One fact can give several: a meeting with Dana from Acme on Friday is an event, Dana in people and Acme in companies.",
    `- Never an item in people for ${owner} themselves${bots.length ? `, or for their AI assistants (${bots.join(", ")})` : ""}.`,
    "- Known lists items already in the categories that these facts may be about, with their keys. When a fact is about one of them (the same person, company, project, meeting or to-do, even in other words), use its key exactly. Two people who only share a first name are not the same.",
    `- people, companies and projects: title is the name, the fullest one known. detail: who or what they are to ${owner}, a few words addressed to ${owner} ("Your sister", "Your accountant at Acme", "Your customer, wants a quote"); empty when the fact doesn't say who they are.`,
    "- events: title is a short name (\"Dentist\", \"Flight to Denver\", \"Call with Dana\"). when: its date as YYYY-MM-DD, or YYYY-MM-DDTHH:MM with a time. For a fact that was said or saved, work out words like Friday or tomorrow from the day it was learned; for one worked out by the memory system or a card line, only a date written out in it. Empty when there's no date. who: who it's with.",
    `- todos: what ${owner} has to do, including what ${owner} said they would do for someone, as a short instruction ("Renew the passport", "Send Priya the receipts"). who: for whom. when: the due date, if any. done: true only when the fact says it's done. What ${owner} asked an AI assistant to do is that assistant's work, not a todo.`,
    `- promises: what someone other than ${owner} said they would do, naming them ("Dana sends Priya the quote", "Dana signs the contract"). who: who it's for. when: by when. done: true when it was kept. What ${owner} said they would do is a todo, not a promise.`,
    "- decisions: title is what was decided, detail why. preferences: title is the preference or rule (\"Aisle seats\", \"Sign emails as Tiger\").",
    "- key: the same for every mention of the same thing: the lowercase name for people, companies and projects; the name and date for events (\"dentist 2026-10-17\"); a few lowercase words for the rest.",
    "- detail: plain words, no full stop at the end. Empty strings for what isn't known. No dashes.",
    "- No item for a passing moment, small talk, an AI assistant's own instructions or behavior, or anything about the AI system itself.",
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
      if (!Number.isInteger(f.i) || f.i < 0 || f.i >= facts.length) return null;
      map.set(f.i, [...(map.get(f.i) ?? []), ...f.items]);
    }
    return map;
  } catch (e) {
    if (noteOutOfCredit(e)) return "credit";
    console.warn(`[categories] sort: ${(e as Error).message}`);
    return null;
  }
}

/** Words that say nothing about who or what a fact is about. */
const COMMON = new Set("the and for with from that this have has had was were are his her hers their them they you your our its not but all any can will would about into over after before when what who".split(" "));
const wordsOf = (s: string) => (s.toLowerCase().match(/[\p{L}\p{N}]{3,}/gu) ?? []).filter((w) => !COMMON.has(w));

/**
 * The known items these facts may be about, so a new mention of Dana or of the same meeting gets the
 * same key: those whose name shares a word with the facts, and events within two weeks of when they
 * were learned (at most 40, the latest first). A small index goes whole.
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
    CATEGORY_IDS.map((c) => [c, items.filter((i) => i.category === c).map((i) => ({ title: i.title, key: i.key.slice(c.length + 1), ...(i.when ? { when: i.when } : {}) }))]).filter(([, list]) => list.length),
  );
}

/**
 * One look at the workspace's memory (see the modes above). One look per bank at a time; one asked
 * for meanwhile runs after it (the more thorough of the two).
 */
export function sync(ws: string, opts: SyncOpts = {}): Promise<void> {
  if (!categoriesOn()) return Promise.resolve();
  const bank = bankOf(ws);
  const b = bankState(bank);
  if (b.running) {
    const mode = b.again?.mode && RANK[b.again.mode] > RANK[opts.mode ?? "look"] ? b.again.mode : (opts.mode ?? "look");
    b.again = { mode, now: !!opts.now || !!b.again?.now };
    return b.running;
  }
  const ours = sameState();
  const epoch = stateEpoch();
  const index = load(bank);
  b.running = run(ws, bank, index, opts, ours, epoch)
    .catch((e: Error) => {
      console.warn(`[categories] ${bank}: ${e.message}`);
      if (!ours()) return;
      index.error = "Couldn't reach memory just now. It tries again on its own.";
      save(bank, index);
    })
    .finally(() => {
      b.running = undefined;
      const again = b.again;
      b.again = undefined;
      if (again && ours()) void sync(ws, again);
    });
  return b.running;
}

async function run(ws: string, bank: string, index: Index, opts: SyncOpts, ours: () => boolean, epoch: number) {
  const b = bankState(bank);
  const first = !index.syncedAt && !Object.keys(index.facts).length;
  let mode: Mode = opts.mode ?? "look";
  // A sweep every 6 hours (never on the first look: nothing to check yet).
  if (!first && mode !== "quick" && (!index.sweptAt || Date.now() - index.sweptAt > SWEEP_MS)) mode = "sweep";
  if (first && RANK[mode] < RANK.fill) mode = "fill";
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
    const seen = (r: FactRow) => Object.hasOwn(index.facts, r.id) || (!!index.floorAt && r.at < index.floorAt);
    ({ rows, total } = await scanFacts(ws, mode === "quick" ? 100 : mode === "look" ? SWEEP_SCAN : mode === "sweep" ? Math.max(depth, SWEEP_SCAN) : depth, mode === "look" ? (page) => page.every(seen) : undefined));
    if (!ours()) return;
    if (mode === "fill" || mode === "sweep") {
      b.rows = { at: Date.now(), depth, rows: rows.slice(0, depth), total };
      // Facts older than the sorted depth aren't sorted (Sort older adds 300).
      index.floorAt = rows.length >= depth ? rows[depth - 1].at : 0;
      index.behind = Math.max(0, total - depth) || undefined;
    }
  }
  const lines = mode === "quick" ? null : await cardOf(ws).catch(() => null);
  if (!ours()) return;
  if (index.error === "Couldn't reach memory just now. It tries again on its own.") index.error = undefined;

  // A sweep: what was sorted and isn't among the newest is checked with memory itself (free, by id: a
  // listing that missed a fact doesn't mean it's gone), and card lines no longer on the card go.
  if (first) index.sweptAt = Date.now();
  if (mode === "sweep") {
    const listed = new Set(rows.map((r) => r.id));
    const unlisted = Object.keys(index.facts).filter((id) => !id.startsWith("card:") && !listed.has(id));
    const still = await existingFacts(ws, unlisted);
    if (!ours()) return;
    dropMany(index, unlisted.filter((id) => !still.has(id)));
    if (lines) {
      const onCard = new Set(lines.map((l) => `card:${l}`));
      dropMany(index, Object.keys(index.facts).filter((id) => id.startsWith("card:") && !onCard.has(id)));
    }
    index.sweptAt = Date.now();
    b.rows = undefined;
  }

  // New: card lines first (who the user is, their people), then the newest facts not sorted yet. A fact
  // that failed waits longer each time (30 minutes, then an hour) before it's tried again.
  const failing = (id: string) => {
    const f = index.failures?.[id];
    return !!f && Date.now() - f.at < WAIT_MS * 2 ** (f.n - 1);
  };
  const inScope = (r: FactRow) => !index.floorAt || r.at >= index.floorAt;
  const pending: Fresh[] = [
    ...(lines ?? []).filter((l) => !Object.hasOwn(index.facts, `card:${l}`) && !failing(`card:${l}`)).map((l) => ({ id: `card:${l}`, text: l, at: Date.now(), session: null, level: "card", how: "card" as const })),
    ...rows.filter((r) => !Object.hasOwn(index.facts, r.id) && inScope(r) && !failing(r.id)).map((r) => ({ ...r, how: howOf(r.level, r.session) })),
  ];

  // Sorted together: now when asked, or when enough wait, or the oldest has waited long enough.
  const oldest = Math.min(...pending.map((f) => f.at || Date.now()));
  if (pending.length && !now && pending.length < WAIT_FOR && Date.now() - oldest < WAIT_MS) {
    index.waiting = pending.length;
    if (mode !== "quick") index.syncedAt = Date.now();
    save(bank, index);
    later(ws, bank, "waiting", Math.max(60_000, WAIT_MS - (Date.now() - oldest)), { mode: "look", now: true }, true);
    return;
  }
  const todo = pending.slice(0, PER_RUN);
  if (todo.length && (await creditsOut())) {
    index.error = "Out of AI credit: new things wait until there's more.";
    if (ours()) save(bank, index);
    return;
  }
  if (!ours()) return;

  const byKey = new Map(Object.values(index.items).map((i) => [i.key, i.id] as [string, string]));
  let failed = false;
  let stopped = false;
  /** One batch's facts, sorted into items; a batch that fails is split in two and each half tried once, so one bad fact doesn't hold up the rest. */
  const apply = async (batch: Fresh[], split: boolean): Promise<void> => {
    // Which lines memory keeps out of prompts (asked per batch: Jev reads up to 80 lines a call).
    const priv = await privateLines(batch.map((f) => f.text)).catch(() => new Set<string>());
    if (!ours()) return void (stopped = true);
    const got = await sortFacts(batch, knownFor(index, batch), epoch, ours);
    if (got === "gone" || !ours()) return void (stopped = true);
    if (got === "credit") {
      index.error = "Out of AI credit: new things wait until there's more.";
      return void (stopped = true);
    }
    if (!got) {
      if (split && batch.length > 1) {
        const mid = Math.ceil(batch.length / 2);
        await apply(batch.slice(0, mid), false);
        if (!stopped) await apply(batch.slice(mid), false);
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
    batch.forEach((f, j) => {
      const src: ItemSource = {
        fact: f.id,
        text: clip(f.text, 600, true),
        at: f.at || Date.now(),
        from: f.how === "card" ? "Your card" : clip(factSource(f.session), 90, true),
        how: f.how,
        ...(priv.has(f.text) ? { private: true } : {}),
      };
      const ids = (got.get(j) ?? []).map((raw) => upsert(index, byKey, raw, src)).filter((x): x is string => !!x);
      index.facts[f.id] = { items: [...new Set(ids)], at: src.at };
      if (index.failures?.[f.id]) delete index.failures[f.id];
    });
  };
  // One batch after another: each sees what the ones before it found (Dana, the demo), so mentions merge.
  for (let i = 0; i < todo.length && !stopped; i += BATCH) {
    await apply(todo.slice(i, i + BATCH), true);
    if (ours()) save(bank, index);
  }
  if (!ours()) return;
  const left = pending.length - todo.length;
  index.waiting = undefined;
  clearTimeout(b.timers.get("waiting"));
  b.timers.delete("waiting");
  if (mode !== "quick" && !stopped) index.syncedAt = Date.now();
  // Said while facts wait to be tried again (a fact given up after three tries no longer counts).
  if (!stopped) index.error = failed || Object.keys(index.failures ?? {}).length ? "Some new things couldn't be sorted yet. They're tried again later." : undefined;
  save(bank, index);
  // More to sort than one look takes: the next look soon (not after a failure: that waits).
  if (left > 0 && !failed && !stopped) later(ws, bank, "more", 60_000, { mode: "fill", now: true });
}

/** A look later, once per reason: a newer ask replaces it, or (`keep`) leaves one already set. Never for an account that signed in since. */
function later(ws: string, bank: string, why: string, ms: number, opts: SyncOpts, keep = false) {
  const b = bankState(bank);
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
    const index = load(bankOf(ws));
    if (Date.now() - Math.max(index.syncedAt ?? 0, index.triedAt ?? 0) >= STALE_MS - 30_000) void sync(ws, { mode: "look" });
  }, STALE_MS);
  live.timer.unref?.();
}

/**
 * Memory changed (memory.ts): a fact was saved just now (sorted in a few seconds), or a chat or task
 * was saved (Honcho works out its facts over the next minutes: a quick look in 3, not pushed back by
 * the next message).
 */
export function nudge(ws: string, why: "saved" | "learned") {
  if (!categoriesOn()) return;
  ensureTimer();
  const bank = bankOf(ws);
  if (why === "learned") later(ws, bank, "learned", 4_000, { mode: "quick", now: true });
  else later(ws, bank, "saved", 3 * 60_000, { mode: "quick" }, true);
}

/** A workspace's categories for the app, as sorted so far. Asking starts a look when the last one is old. */
export function snapshot(ws: string): MemorySnapshot {
  if (!categoriesOn()) return { on: false, ws, items: [], syncing: false };
  ensureTimer();
  const bank = bankOf(ws);
  const index = load(bank);
  const b = bankState(bank);
  const last = Math.max(index.syncedAt ?? 0, index.triedAt ?? 0);
  if (!b.running && Date.now() - last > STALE_MS) void sync(ws, { mode: "look" });
  const all = Object.values(index.items);
  return {
    on: true,
    ws,
    items: all.filter((i) => !i.hidden),
    hidden: all.filter((i) => i.hidden).map((i) => ({ id: i.id, category: i.category, title: i.title })),
    syncing: !!b.running,
    syncedAt: index.syncedAt,
    behind: index.behind,
    waiting: index.waiting,
    dreamAt: index.dreamAt,
    dreamReadyAt: index.dreamAt ? index.dreamAt + DREAM_EVERY_MS : undefined,
    error: index.error,
  };
}

/** Look now, and sort what's new now (Refresh): a sweep, so what was deleted goes too. */
export const refresh = (ws: string) => sync(ws, { mode: "sweep", now: true });

/** Sort 300 more of the older facts (each 25 a model call). */
export function sortOlder(ws: string) {
  if (!categoriesOn()) throw new Error("Memory isn't set up.");
  const bank = bankOf(ws);
  const index = load(bank);
  if (!index.behind) return Promise.resolve();
  index.depth = (index.depth ?? FIRST_DEPTH) + OLDER_STEP;
  save(bank, index);
  return sync(ws, { mode: "fill", now: true });
}

/** Ask memory to tidy up now (memory.ts dream), at most once an hour; sweeps again as its results come in. */
export async function tidyUp(ws: string) {
  if (!categoriesOn()) throw new Error("Memory isn't set up.");
  const ours = sameState();
  const bank = bankOf(ws);
  const index = load(bank);
  if (index.dreamAt && Date.now() - index.dreamAt < DREAM_EVERY_MS) {
    const mins = Math.ceil((index.dreamAt + DREAM_EVERY_MS - Date.now()) / 60_000);
    throw new Error(`Memory tidied up a little while ago. Try again in ${mins} minute${mins === 1 ? "" : "s"}.`);
  }
  // Noted before asking, so a second press meanwhile doesn't ask (and pay) twice.
  const before = index.dreamAt;
  index.dreamAt = Date.now();
  save(bank, index);
  try {
    await askToDream(ws);
  } catch (e) {
    console.warn(`[categories] tidy up: ${(e as Error).message}`);
    if (ours()) {
      index.dreamAt = before;
      save(bank, index);
    }
    throw new Error("Couldn't reach memory to tidy up. Try again in a moment.");
  }
  if (!ours()) return;
  later(ws, bank, "dream-soon", 4 * 60_000, { mode: "sweep", now: true });
  later(ws, bank, "dream-later", 15 * 60_000, { mode: "sweep", now: true });
}

/** The user changed an item: its name or line (kept from then on), done or not, hidden or shown. */
export function editItem(ws: string, id: string, patch: { title?: string; detail?: string; done?: boolean; hidden?: boolean }) {
  if (!categoriesOn()) throw new Error("Memory isn't set up.");
  const bank = bankOf(ws);
  const index = load(bank);
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
  }
  if (patch.done !== undefined) {
    item.done = patch.done || undefined;
    item.marked = true;
  }
  if (patch.hidden !== undefined) item.hidden = patch.hidden || undefined;
  save(bank, index);
  return item;
}

/**
 * Forget an item: memory forgets the facts and card lines it was learned from that aren't about
 * anything else (the rest stay, for the other items they fed), and only something said in a chat
 * afterwards brings it back. One forget at a time per bank. When memory can't be reached, the item
 * stays and the user is told.
 */
export function forgetItem(ws: string, id: string) {
  if (!categoriesOn()) return Promise.reject(new Error("Memory isn't set up."));
  const bank = bankOf(ws);
  const b = bankState(bank);
  const next = (b.forgetting ?? Promise.resolve()).then(() => forgetOne(ws, bank, id));
  b.forgetting = next.catch(() => {});
  return next;
}

async function forgetOne(ws: string, bank: string, id: string) {
  if (!categoriesOn()) throw new Error("Memory isn't set up.");
  const ours = sameState();
  const index = load(bank);
  if (!Object.hasOwn(index.items, id)) return;
  const item = index.items[id];
  // Every fact sorted into it (its sources are only the newest 12).
  const facts = Object.entries(index.facts)
    .filter(([, f]) => f.items.includes(id))
    .map(([fact]) => fact);
  const only = facts.filter((f) => index.facts[f].items.every((x) => x === id));
  try {
    await forgetFacts(ws, only);
  } catch (e) {
    console.warn(`[categories] forget: ${(e as Error).message}`);
    throw new Error("Couldn't reach memory to forget it. Try again in a moment.");
  }
  if (!ours()) return;
  for (const f of only) delete index.facts[f];
  for (const f of facts) if (Object.hasOwn(index.facts, f)) index.facts[f].items = index.facts[f].items.filter((x) => x !== id);
  delete index.items[id];
  index.forgotten[item.key] = Date.now();
  // The 500 latest are kept.
  index.forgotten = Object.fromEntries(
    Object.entries(index.forgotten)
      .sort((a, b) => b[1] - a[1])
      .slice(0, 500),
  );
  save(bank, index);
}

/** The workspace asked for when it's one of the user's, else the one in use. */
export const wsOrCurrent = (ws: string | null | undefined) => (ws && (getState().workspaces ?? []).some((w) => w.id === ws) ? ws : currentWorkspaceId());
