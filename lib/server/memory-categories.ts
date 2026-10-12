import "server-only";
import { randomBytes } from "node:crypto";
import { existsSync, mkdirSync, readFileSync, renameSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { CATEGORIES, CATEGORY_IDS, categoriesOpen, type CategoryId, type ItemSource, type MemoryItem, type MemorySnapshot } from "@/lib/memory-categories";
import { creditsOut } from "./cloud";
import { bankOf, cardOf, dream as askToDream, factSource, forgetFact, memoryOn, privateLines, scanFacts, type FactRow } from "./memory";
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
 * (25 a call, one call after another, each told what's already known so mentions of the same person
 * or meeting get the same key and merge). Each item keeps the facts it came from, so the app can say
 * where it was learned, and forgetting it forgets them in memory too.
 *
 * When: while Bops is open (its server runs only then). On opening, every 15 minutes, a few minutes
 * after a chat or task is saved to memory (Honcho needs that long to work out new facts), right away
 * when a fact is saved by hand or by a bot, and when the user asks (Refresh). Each look lists the
 * newest facts (free) and sorts only the ones not seen yet, so a look with nothing new costs nothing.
 *
 * Kept per bank (workspaces can share one) in the user's folder on this Mac, never in the app state
 * (which goes to the window every few seconds and to Bops Cloud): <userDir>/memory-categories/<bank>.json.
 */

/** How many of the newest facts a look reads, how many it sorts (the rest wait for the next look), and how many go in one model call. */
const SCAN = 1500;
const QUICK_SCAN = 100;
const PER_RUN = 150;
const BATCH = 25;
/** Another look when the last one was this long ago (the window asking; a look that failed waits as long), and on a timer while Bops is open. */
const STALE_MS = 10 * 60_000;
const TIMER_MS = 15 * 60_000;
/** Tidying up (dreaming) on request, at most this often. */
const DREAM_EVERY_MS = 60 * 60_000;

const MODEL = process.env.BOPS_MEMORY_MODEL ?? process.env.BOPS_CHAT_MODEL ?? process.env.BOPS_SAM_MODEL ?? "gpt-6.1-sol";

type Index = {
  v: 1;
  bank: string;
  /** Every fact (and card line, "card:<line>") already sorted, and the items it went into. */
  facts: Record<string, { items: string[]; at: number }>;
  items: Record<string, MemoryItem>;
  /** Items the user forgot ("<category>:<key>", and when): not made again from what memory knew before then. */
  forgotten: Record<string, number>;
  syncedAt?: number;
  /** When the last full look started, whether or not it got through (a failing one isn't retried at every ask). */
  triedAt?: number;
  dreamAt?: number;
  behind?: number;
  error?: string;
};

type Bank = {
  index?: Index;
  /** The file the index was read from: an index is only ever written back there (another account's sign-in has another folder). */
  file?: string;
  running?: Promise<void>;
  /** A look asked for while one runs: it runs once that one is done. */
  again?: { quick: boolean };
  timers: Map<string, ReturnType<typeof setTimeout>>;
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

/** Long and short dashes, written as commas (the user's copy has none). */
const DASH = new RegExp(`\\s*[${String.fromCharCode(0x2013, 0x2014)}]\\s*`, "g");

/** Text for an item, one line, at most `n` long. What the model wrote loses a full stop at its end; what the user typed keeps it. */
const clip = (s: unknown, n: number, typed = false) => {
  const t = String(s ?? "")
    .replace(DASH, ", ")
    .replace(/\s+/g, " ")
    .trim();
  return (typed ? t : t.replace(/\.$/, "")).slice(0, n);
};

/** The same for every mention: lowercase, accents on Latin letters and punctuation gone (other alphabets kept as they are), and for names what's around them ("Project Atlas" is Atlas, "Acme Corp" is Acme). */
function keyOf(category: CategoryId, key: string, title: string) {
  let k = (key || title)
    .toLowerCase()
    .normalize("NFKD")
    .replace(/(\p{Script=Latin})\p{M}+/gu, "$1")
    .normalize("NFC")
    .replace(/[^\p{L}\p{M}\p{N}@.+:\s-]/gu, " ")
    .replace(/\s+/g, " ")
    .trim();
  if (category === "projects") k = k.replace(/^(the )?project /, "").replace(/ project$/, "");
  if (category === "companies") k = k.replace(/^the /, "").replace(/ (inc|llc|ltd|corp|corporation|company|gmbh|plc)$/, "");
  return k ? `${category}:${k.slice(0, 120)}` : null;
}

/** A date or a date and time the app can read, or nothing. */
const whenOf = (s: string) => (/^\d{4}-\d{2}-\d{2}(T\d{2}:\d{2})?$/.test(s.trim()) && !Number.isNaN(Date.parse(s.trim())) ? s.trim() : undefined);

const howOf = (level: string): ItemSource["how"] => (level === "card" ? "card" : level === "explicit" ? "said" : "figured");

type Raw = { category: string; title: string; detail: string; key: string; when: string; who: string; done: boolean };

/**
 * Add what a fact says about one item: a new item, or one more mention of a known one. A newer
 * mention says how things stand now (its line, its date, done or not); an older one only fills in
 * what's missing. Returns the item's id.
 */
function upsert(index: Index, byKey: Map<string, string>, raw: Raw, src: ItemSource): string | null {
  if (!CATEGORY_IDS.includes(raw.category as CategoryId)) return null;
  const category = raw.category as CategoryId;
  const title = clip(raw.title, 90);
  const key = title ? keyOf(category, raw.key, title) : null;
  if (!key) return null;
  const forgot = index.forgotten[key];
  if (forgot && src.at <= forgot) return null;
  const known = byKey.get(key);
  let item = known ? index.items[known] : undefined;
  if (!item) {
    item = { id: randomBytes(5).toString("hex"), category, key, title, detail: clip(raw.detail, 160), sources: [], first: src.at, last: src.at };
    index.items[item.id] = item;
    byKey.set(key, item.id);
  }
  const newer = src.at >= item.last;
  if (newer && !item.edited) {
    if (clip(raw.detail, 160)) item.detail = clip(raw.detail, 160);
    // "Priya" becomes "Priya Shah" when a later mention has the fuller name.
    if (title.length > item.title.length && title.toLowerCase().startsWith(item.title.toLowerCase())) item.title = title;
  }
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

/** Whether any fact still sorted into it backs an item (it keeps only its newest 12 as sources). */
const backed = (index: Index, id: string) => Object.values(index.facts).some((f) => f.items.includes(id));

/** A fact gone from memory (deleted, or dropped as out of date): its items lose it, and an item nothing backs any more goes, unless the user changed it. */
function drop(index: Index, fact: string) {
  const items = index.facts[fact]?.items ?? [];
  delete index.facts[fact];
  for (const id of items) {
    const item = index.items[id];
    if (!item) continue;
    item.sources = item.sources.filter((s) => s.fact !== fact);
    item.private = (item.sources.length > 0 && item.sources.every((s) => s.private)) || undefined;
    if (!backed(index, id) && !item.edited && !item.marked) delete index.items[id];
  }
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

/** What each fact says about which items, by one call of a small model. Null when it can't answer (tried again next look). */
async function sortFacts(facts: (FactRow & { how: ItemSource["how"] })[], known: Record<string, unknown>, epoch: number): Promise<Map<number, Raw[]> | null> {
  const owner = ownerName();
  const bots = getState().bots.map((b) => b.name).filter(Boolean);
  const instructions = [
    `You sort what an AI memory system learned about ${owner} into the categories of their app. Each fact below was learned from ${owner}'s chats with their AI assistants, or is a line of ${owner}'s profile card. Turn each fact into zero or more items in these categories:`,
    ...CATEGORIES.map((c) => `- ${c.id}: ${c.about}`),
    "Rules:",
    "- Only what the fact says. Never guess, never add.",
    "- Most facts give zero or one item. One fact can give several: a meeting with Dana from Acme on Friday is an event, Dana in people and Acme in companies.",
    `- Never an item for ${owner} themselves${bots.length ? `, or for their AI assistants (${bots.join(", ")})` : ""}.`,
    "- Known lists what's already in each category, with its key. When a fact is about one of them (the same person, company, project, meeting or to-do, even in other words), use its key exactly. Two people who only share a first name are not the same.",
    `- people, companies and projects: title is the name, the fullest one known. detail: who or what they are to ${owner}, a few words addressed to ${owner} ("Your sister", "Your accountant at Acme", "Your customer, wants a quote"); empty when the fact doesn't say who they are.`,
    "- events: title is a short name (\"Dentist\", \"Flight to Denver\", \"Call with Dana\"). when: its date as YYYY-MM-DD, or YYYY-MM-DDTHH:MM with a time, worked out from the date the fact was learned for words like Friday or tomorrow; empty when there's no date. who: who it's with.",
    `- todos: what ${owner} has to do, including what ${owner} said they would do for someone, as a short instruction ("Renew the passport", "Send Priya the receipts"). who: for whom. when: the due date, if any. done: true only when the fact says it's done.`,
    `- promises: what someone other than ${owner} said they would do, naming them ("Max sends Sam the quote", "Dana signs the contract"). who: who it's for. when: by when. done: true when it was kept. What ${owner} said they would do is a todo, not a promise.`,
    "- decisions: title is what was decided, detail why. preferences: title is the preference or rule (\"Aisle seats\", \"Sign emails as Tiger\").",
    "- key: the same for every mention of the same thing: the lowercase name for people, companies and projects; the name and date for events (\"dentist 2026-10-17\"); a few lowercase words for the rest.",
    "- detail: plain words, no full stop at the end. Empty strings for what isn't known. No dashes.",
    "- No item for a passing moment, small talk, an AI assistant's own instructions or behavior, or anything about the AI system itself.",
  ].join("\n");
  const input = JSON.stringify({
    today: localDay(Date.now()),
    facts: facts.map((f, i) => ({ i, fact: f.text.slice(0, 600), learned: localDay(f.at || Date.now()), ...(f.how === "card" ? { from: "profile card" } : {}) })),
    known,
  });
  try {
    const res = await openai.responses.create(
      { model: MODEL, reasoning: { effort: "low" }, instructions, input, text: { format: { type: "json_schema", name: "memory_items", strict: true, schema: SCHEMA } } },
      usageTags("memory"),
    );
    recordTokens("memory", res.model, res.usage, undefined, epoch);
    const out = JSON.parse(res.output_text) as { facts: { i: number; items: Raw[] }[] };
    return new Map(out.facts.map((f) => [f.i, f.items]));
  } catch (e) {
    console.warn(`[categories] sort: ${(e as Error).message}`);
    return null;
  }
}

/** What's already known in each category (the latest ones), so a new mention of Dana or of the same meeting gets the same key. */
const knownItems = (index: Index) =>
  Object.fromEntries(
    CATEGORY_IDS.map((c) => [
      c,
      Object.values(index.items)
        .filter((i) => i.category === c)
        .sort((a, b) => b.last - a.last)
        .slice(0, c === "people" || c === "companies" ? 60 : 30)
        .map((i) => ({ title: i.title, key: i.key.slice(c.length + 1), ...(i.when ? { when: i.when } : {}) })),
    ]).filter(([, list]) => list.length),
  );

/**
 * One look at the workspace's memory: facts gone are dropped, new facts and card lines are sorted.
 * `quick` reads only the newest page (after a fact was just saved). One look per bank at a time; one
 * asked for meanwhile runs after it.
 */
export function sync(ws: string, opts: { quick?: boolean } = {}): Promise<void> {
  if (!categoriesOn()) return Promise.resolve();
  const bank = bankOf(ws);
  const b = bankState(bank);
  if (b.running) {
    b.again = { quick: !!opts.quick && (b.again?.quick ?? true) };
    return b.running;
  }
  const ours = sameState();
  const epoch = stateEpoch();
  const index = load(bank);
  b.running = run(ws, bank, index, !!opts.quick, ours, epoch)
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

async function run(ws: string, bank: string, index: Index, quick: boolean, ours: () => boolean, epoch: number) {
  if (!quick) index.triedAt = Date.now();
  const rows = await scanFacts(ws, quick ? QUICK_SCAN : SCAN);
  if (!ours()) return;
  const lines = quick ? null : await cardOf(ws).catch(() => null);
  if (!ours()) return;

  // Gone from memory: within what was read (the newest facts), anything sorted before that isn't there now.
  if (!quick) {
    const seen = new Set(rows.map((r) => r.id));
    const oldest = rows.length >= SCAN ? rows[rows.length - 1].at : -1;
    for (const [id, f] of Object.entries(index.facts)) if (!id.startsWith("card:") && !seen.has(id) && f.at > oldest) drop(index, id);
    if (lines) {
      const now = new Set(lines.map((l) => `card:${l}`));
      for (const id of Object.keys(index.facts)) if (id.startsWith("card:") && !now.has(id)) drop(index, id);
    }
  }

  // New: the newest facts not sorted yet, then card lines.
  const fresh: (FactRow & { how: ItemSource["how"] })[] = rows.filter((r) => !index.facts[r.id]).map((r) => ({ ...r, how: howOf(r.level) }));
  for (const l of lines ?? []) if (!index.facts[`card:${l}`]) fresh.push({ id: `card:${l}`, text: l, at: Date.now(), session: null, level: "card", how: "card" });
  const todo = fresh.slice(0, PER_RUN);
  // A quick look reads one page: what's behind is the full looks' to say.
  if (!quick) index.behind = fresh.length - todo.length || undefined;

  if (todo.length && (await creditsOut())) {
    index.error = "Out of AI credit: new things wait until there's more.";
    if (ours()) save(bank, index);
    return;
  }
  // Every key an item goes by, so a new mention finds it.
  const byKey = new Map(Object.values(index.items).map((i) => [i.key, i.id] as [string, string]));
  let failed = false;
  // One batch after another: each sees what the ones before it found (Dana, the demo), so mentions merge.
  for (let i = 0; i < todo.length; i += BATCH) {
    const batch = todo.slice(i, i + BATCH);
    // Which lines memory keeps out of prompts (asked per batch: Jev reads up to 80 lines a call).
    const priv = await privateLines(batch.map((f) => f.text)).catch(() => new Set<string>());
    const got = await sortFacts(batch, knownItems(index), epoch);
    if (!ours()) return;
    if (!got) failed = true;
    else
      batch.forEach((f, j) => {
        const src: ItemSource = { fact: f.id, text: clip(f.text, 600, true), at: f.at || Date.now(), from: f.how === "card" ? "Your card" : clip(factSource(f.session), 90, true), how: f.how, ...(priv.has(f.text) ? { private: true } : {}) };
        const ids = (got.get(j) ?? []).map((raw) => upsert(index, byKey, raw, src)).filter((x): x is string => !!x);
        index.facts[f.id] = { items: [...new Set(ids)], at: src.at };
      });
    save(bank, index);
  }
  if (!quick) index.syncedAt = Date.now();
  index.error = failed ? "Some new things couldn't be sorted. They're tried again next time." : undefined;
  if (ours()) save(bank, index);
  // More than one look takes: the next one soon.
  if (index.behind && ours()) later(ws, bank, "behind", 60_000, false);
}

/** A look later, once per reason (a newer ask replaces it). */
function later(ws: string, bank: string, why: string, ms: number, quick: boolean) {
  const b = bankState(bank);
  clearTimeout(b.timers.get(why));
  const t = setTimeout(() => {
    b.timers.delete(why);
    void sync(ws, { quick });
  }, ms);
  t.unref?.();
  b.timers.set(why, t);
}

/** While Bops is open: a look every 15 minutes at the workspace in use. */
function ensureTimer() {
  if (live.timer) return;
  live.timer = setInterval(() => {
    if (categoriesOn()) void sync(currentWorkspaceId());
  }, TIMER_MS);
  live.timer.unref?.();
}

/**
 * Memory changed (memory.ts): a fact was saved just now (sorted in a few seconds), or a chat or task
 * was saved (Honcho works out its facts over the next minutes: looks then).
 */
export function nudge(ws: string, why: "saved" | "learned") {
  if (!categoriesOn()) return;
  ensureTimer();
  const bank = bankOf(ws);
  if (why === "learned") later(ws, bank, "learned", 4_000, true);
  else {
    later(ws, bank, "saved-soon", 3 * 60_000, true);
    later(ws, bank, "saved-later", 12 * 60_000, false);
  }
}

/** A workspace's categories for the app, as sorted so far. Asking starts a look when the last one is old. */
export function snapshot(ws: string): MemorySnapshot {
  if (!categoriesOn()) return { on: false, ws, items: [], syncing: false };
  ensureTimer();
  const bank = bankOf(ws);
  const index = load(bank);
  const b = bankState(bank);
  const last = Math.max(index.syncedAt ?? 0, index.triedAt ?? 0);
  if (!b.running && Date.now() - last > STALE_MS) void sync(ws);
  const all = Object.values(index.items);
  return {
    on: true,
    ws,
    items: all.filter((i) => !i.hidden),
    hidden: all.filter((i) => i.hidden).map((i) => ({ id: i.id, category: i.category, title: i.title })),
    syncing: !!b.running,
    syncedAt: index.syncedAt,
    behind: index.behind,
    dreamAt: index.dreamAt,
    dreamReadyAt: index.dreamAt ? index.dreamAt + DREAM_EVERY_MS : undefined,
    error: index.error,
  };
}

/** Ask memory to tidy up now (memory.ts dream), at most once an hour; looks again as its results come in. */
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
  later(ws, bank, "dream-soon", 4 * 60_000, false);
  later(ws, bank, "dream-later", 15 * 60_000, false);
}

/** The user changed an item: its name or line (kept from then on), done or not, hidden or shown. */
export function editItem(ws: string, id: string, patch: { title?: string; detail?: string; done?: boolean; hidden?: boolean }) {
  if (!categoriesOn()) throw new Error("Memory isn't set up.");
  const bank = bankOf(ws);
  const index = load(bank);
  const item = index.items[id];
  if (!item) throw new Error("That's gone already.");
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
 * Forget an item: memory forgets the facts it was learned from that aren't about anything else
 * (the rest stay, for the other items they fed), and it isn't made again from what memory knew before.
 * When memory can't be reached, nothing changes and the user is told.
 */
export async function forgetItem(ws: string, id: string) {
  if (!categoriesOn()) throw new Error("Memory isn't set up.");
  const ours = sameState();
  const bank = bankOf(ws);
  const index = load(bank);
  const item = index.items[id];
  if (!item) return;
  // Every fact sorted into it (its sources are only the newest 12).
  const facts = Object.entries(index.facts)
    .filter(([, f]) => f.items.includes(id))
    .map(([fact]) => fact);
  for (const fact of facts.filter((f) => index.facts[f].items.every((x) => x === id))) {
    try {
      await forgetFact(ws, fact);
    } catch (e) {
      // Already gone from memory is fine; anything else, and the item stays (what's forgotten so far stays forgotten).
      if ((e as { status?: number }).status !== 404) {
        console.warn(`[categories] forget ${fact}: ${(e as Error).message}`);
        if (ours()) save(bank, index);
        throw new Error("Couldn't reach memory to forget it. Try again in a moment.");
      }
    }
    if (!ours()) return;
    delete index.facts[fact];
  }
  for (const fact of facts) if (index.facts[fact]) index.facts[fact].items = index.facts[fact].items.filter((x) => x !== id);
  delete index.items[id];
  index.forgotten[item.key] = Date.now();
  // The 500 latest are kept.
  const keep = Object.entries(index.forgotten).sort((a, b) => b[1] - a[1]).slice(0, 500);
  index.forgotten = Object.fromEntries(keep);
  save(bank, index);
}

/** The workspace asked for when it's one of the user's, else the one in use. */
export const wsOrCurrent = (ws: string | null | undefined) => (ws && (getState().workspaces ?? []).some((w) => w.id === ws) ? ws : currentWorkspaceId());
