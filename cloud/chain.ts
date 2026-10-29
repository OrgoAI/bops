/*
 * The team chart: who answers to whom in a workspace, and who may ask whom (Workspace.chain). Kept on the
 * workspace in the synced state, so Bops Cloud, the Mac server and the window read the same rules. Imported
 * by Bops Cloud and, through lib/chain.ts, the window and the Mac server, so it imports nothing.
 *
 * The rule bots live by: up and down a line is always open; sideways is up to the owner. Each bot answers
 * to one lead, the chief of staff (the workspace's main bot) on top. A bot may ask a bot in its line (above
 * or below it, at any depth) and the chief, always; one beside it only when both talk sideways, or when the
 * owner made an exception between the two (one way). A bot hands work only to the bots under it, and the
 * chief sees what every bot is doing.
 *
 * Unset, or empty, is exactly what Bops did before: every bot answers to the chief, sideways "open", so
 * everyone may ask everyone and only the chief hands off (to everyone).
 *
 * People keep their None, Read or Write per bot (cloud/member-access.ts): `for` only names the person a bot
 * works for, and grants nothing.
 */

/** Who answers to whom in a workspace, and who may ask whom. Unset: everything as before. */
export type Chain = {
  /** For bots with no setting of their own: may they ask, and be asked by, the bots beside them? Unset: "open". */
  sideways?: Sideways;
  /** Per bot, by id. A bot with no entry follows every default below. */
  bots?: Record<string, ChainBot>;
  /**
   * Exceptions between two bots beside each other, one way: "a>b": true lets a ask b, false stops it,
   * whatever their sideways says. Never about the chief of staff or two bots in one line (always open).
   */
  pairs?: Record<string, boolean>;
  /** When the owner last changed it (ms). */
  at?: number;
};

export type Sideways = "open" | "closed";

export type ChainBot = {
  /** The bot it answers to. Unset, gone, or one that would make a loop: the chief of staff. Never set on the chief. */
  lead?: string;
  /** Talks with the bots beside it. Unset: the chain's `sideways`. */
  sideways?: Sideways;
  /** false: nobody hands it work (only the owner and its people give it work). Unset: it takes work from any bot above it. */
  takesWork?: false;
  /** false: it doesn't hand work to the bots under it. Unset: it does, once it has any. */
  handsDown?: false;
  /** "own": what it learns goes to a bank of its own (lib/server/memory.ts MemoryScope). Unset: the team's. Never on the chief. */
  memory?: "own";
  /** With memory "own": false to read only its own bank. Unset: it still reads the team's (and Knowledge). */
  readsTeam?: false;
  /**
   * Without memory "own": the bank it kept to itself before is kept apart (the owner chose Keep it apart): nothing
   * reads it until it's brought into the team's or deleted, from the bot's Memory tab.
   */
  kept?: true;
  /** The person it works for, by accessKey (cloud/member-access.ts): "Ava's bot". A label and a prompt line, not access. */
  for?: string;
  /** That person's name as the owner's People sheet showed it when they picked them (the prompt and the card say it). */
  forName?: string;
};

/** The most levels of bots under the chief. */
export const MAX_DEPTH = 4;
/** The most bot entries and exceptions a chain keeps (a workspace has far fewer bots). */
export const MAX_CHAIN_BOTS = 200;
export const MAX_CHAIN_PAIRS = 400;

/** The default workspace's id (lib/types.ts MAIN_WORKSPACE): a bot with no workspaceId is in it. */
const MAIN = "ws_main";

/** What the rules read of a bot and a workspace: the app's state, Bops Cloud's blob, or a test's. */
export type ChainBotRef = { id: string; isMain?: boolean; workspaceId?: string };
export type ChainWorkspace = { id: string; chain?: Chain; memberAccess?: Record<string, { others?: unknown; bots?: Record<string, unknown> }> };
export type ChainState = { bots: readonly ChainBotRef[]; workspaces?: readonly ChainWorkspace[] };

const wsOfBot = (b: ChainBotRef) => b.workspaceId ?? MAIN;
const isObject = (v: unknown): v is Record<string, unknown> => !!v && typeof v === "object" && !Array.isArray(v);
/** The pairs key for "a may ask b". */
export const pairKey = (a: string, b: string) => `${a}>${b}`;

/**
 * A workspace's team as the chart has it: its bots, its chief, each bot's lead (the chief when its own is
 * unset or can't be: gone, itself, under it, too deep), and how deep each is (the chief 0).
 */
export type Team = {
  ws: string;
  chain: Chain;
  chief: ChainBotRef | undefined;
  bots: readonly ChainBotRef[];
  lead: Map<string, string | undefined>;
  depth: Map<string, number>;
};

/** Each bot's lead and depth, from raw leads: loops broken (the first bot in the loop goes under the chief), too deep pulled up. */
function resolve(bots: readonly ChainBotRef[], chief: ChainBotRef | undefined, rawLead: (id: string) => string | undefined) {
  const ids = new Set(bots.map((b) => b.id));
  const lead = new Map<string, string | undefined>();
  for (const b of bots) {
    if (b.id === chief?.id) {
      lead.set(b.id, undefined);
      continue;
    }
    const raw = rawLead(b.id);
    lead.set(b.id, raw && raw !== b.id && ids.has(raw) ? raw : chief?.id);
  }
  // Loops: walk up from each bot; a bot met twice closes one, and the first of the loop (in the bots' order) goes under the chief.
  const order = new Map(bots.map((b, i) => [b.id, i]));
  for (const b of bots) {
    const seen: string[] = [];
    let at: string | undefined = b.id;
    while (at && at !== chief?.id && !seen.includes(at)) {
      seen.push(at);
      at = lead.get(at);
    }
    if (at && at !== chief?.id && seen.includes(at)) {
      const loop = seen.slice(seen.indexOf(at));
      const first = loop.reduce((x, y) => ((order.get(x) ?? 0) <= (order.get(y) ?? 0) ? x : y));
      lead.set(first, chief?.id);
    }
  }
  // Depth: the chief 0, its bots 1; one deeper than MAX_DEPTH answers to the deepest allowed lead above it.
  const depth = new Map<string, number>();
  const depthOf = (id: string, guard = 0): number => {
    const known = depth.get(id);
    if (known !== undefined) return known;
    const l = lead.get(id);
    if (!l || guard > bots.length + 1) {
      depth.set(id, id === chief?.id ? 0 : 1);
      return depth.get(id)!;
    }
    let d = depthOf(l, guard + 1) + 1;
    if (d > MAX_DEPTH) {
      let up: string | undefined = l;
      while (up && (depth.get(up) ?? 0) >= MAX_DEPTH) up = lead.get(up);
      lead.set(id, up ?? chief?.id);
      d = (depth.get(up ?? "") ?? 0) + 1;
    }
    depth.set(id, d);
    return d;
  };
  for (const b of bots) depthOf(b.id);
  return { lead, depth };
}

/** A workspace's team, by its id. */
export function teamIn(s: ChainState, ws: string): Team {
  const bots = s.bots.filter((b) => wsOfBot(b) === ws);
  const chief = bots.find((b) => b.isMain);
  const w = s.workspaces?.find((x) => x.id === ws);
  const chain: Chain = isObject(w?.chain) ? w.chain : {};
  const entries = isObject(chain.bots) ? chain.bots : {};
  const { lead, depth } = resolve(bots, chief, (id) => {
    const e = Object.hasOwn(entries, id) ? entries[id] : undefined;
    return isObject(e) && typeof e.lead === "string" ? e.lead : undefined;
  });
  return { ws, chain, chief, bots, lead, depth };
}

/** The team a bot is in (undefined: no such bot). */
export function teamOfBot(s: ChainState, id: string): Team | undefined {
  const b = s.bots.find((x) => x.id === id);
  return b ? teamIn(s, wsOfBot(b)) : undefined;
}

/** A bot's own entry in its chain (an empty one when it has none). Never the chief's: the chief has none. */
export function entryOf(t: Team, id: string): ChainBot {
  if (id === t.chief?.id) return {};
  const bots = isObject(t.chain.bots) ? t.chain.bots : {};
  const e = Object.hasOwn(bots, id) ? bots[id] : undefined;
  return isObject(e) ? e : {};
}

/** The bot it answers to: the chief when its own lead is unset or can't be. undefined for the chief (and no such bot). */
export function leadOf(s: ChainState, id: string): string | undefined {
  return teamOfBot(s, id)?.lead.get(id);
}

/** Its leads up to the chief, nearest first. */
export function lineOf(s: ChainState, id: string): string[] {
  const t = teamOfBot(s, id);
  return t ? lineIn(t, id) : [];
}
const lineIn = (t: Team, id: string) => {
  const out: string[] = [];
  for (let at = t.lead.get(id); at && !out.includes(at); at = t.lead.get(at)) out.push(at);
  return out;
};

/** The bots right under it. */
export const directOf = (t: Team, id: string) => t.bots.filter((b) => t.lead.get(b.id) === id).map((b) => b.id);

/** Every bot under it, at any depth. For the chief: every other bot in the workspace. */
export function belowOf(s: ChainState, id: string): string[] {
  const t = teamOfBot(s, id);
  return t ? belowIn(t, id) : [];
}
export const belowIn = (t: Team, id: string) => t.bots.filter((b) => b.id !== id && lineIn(t, b.id).includes(id)).map((b) => b.id);

/** One is above the other (two different bots of one workspace). */
export function inLine(s: ChainState, a: string, b: string): boolean {
  const t = teamOfBot(s, a);
  return !!t && inLineIn(t, a, b);
}
const inLineIn = (t: Team, a: string, b: string) => a !== b && t.lead.has(b) && (lineIn(t, a).includes(b) || lineIn(t, b).includes(a));

/** Whether it talks with the bots beside it: its own setting, else the chain's, else open. */
export function sidewaysOf(s: ChainState, id: string): Sideways {
  const t = teamOfBot(s, id);
  return t ? sidewaysIn(t, id) : "open";
}
export const sidewaysIn = (t: Team, id: string): Sideways => entryOf(t, id).sideways ?? (t.chain.sideways === "closed" ? "closed" : "open");

/**
 * Whether bot a may ask bot b (ask_teammate, a group chat's question, a thread of b's): two different bots
 * of one workspace, and either is the chief, or one is above the other, or an exception says (one way), or
 * both talk sideways.
 */
export function mayAsk(s: ChainState, a: string, b: string): boolean {
  const t = teamOfBot(s, a);
  return !!t && mayAskIn(t, a, b);
}
export function mayAskIn(t: Team, a: string, b: string): boolean {
  if (a === b || !t.lead.has(a) || !t.lead.has(b)) return false;
  if (a === t.chief?.id || b === t.chief?.id) return true;
  if (inLineIn(t, a, b)) return true;
  const pairs = isObject(t.chain.pairs) ? t.chain.pairs : {};
  const key = pairKey(a, b);
  if (Object.hasOwn(pairs, key) && typeof pairs[key] === "boolean") return pairs[key];
  return sidewaysIn(t, a) === "open" && sidewaysIn(t, b) === "open";
}

/** A bot knows of a teammate (its name, address, work) only when it may ask it. */
export const knows = mayAsk;
export const knowsIn = mayAskIn;

/** Whether bot a may hand work to bot b: b is under a, b takes work, and a is the chief or hands work down. */
export function mayHandOff(s: ChainState, a: string, b: string): boolean {
  const t = teamOfBot(s, a);
  return !!t && mayHandOffIn(t, a, b);
}
export function mayHandOffIn(t: Team, a: string, b: string): boolean {
  if (a === b || !t.lead.has(b) || !lineIn(t, b).includes(a)) return false;
  if (entryOf(t, b).takesWork === false) return false;
  return a === t.chief?.id || entryOf(t, a).handsDown !== false;
}

/**
 * What a turn of bot `botId` reaches, by the chart and, on a person's turn, by their level on each bot too (the
 * stricter of the two): the teammates it may ask (and so is told of) that they see at Read or Write, and the ones it
 * may hand work to that they have at Write. `levelOf` unset: the owner's turn, the chart alone.
 */
export function reachOf(s: ChainState, botId: string, levelOf?: (id: string) => "none" | "read" | "write"): { asks: string[]; handsTo: string[] } {
  const t = teamOfBot(s, botId);
  if (!t) return { asks: [], handsTo: [] };
  const asks = t.bots.filter((b) => mayAskIn(t, botId, b.id) && (!levelOf || levelOf(b.id) !== "none")).map((b) => b.id);
  const handsTo = asks.filter((id) => mayHandOffIn(t, botId, id) && (!levelOf || levelOf(id) === "write"));
  return { asks, handsTo };
}

/** Its memory is its own (never the chief's). */
export function ownMemory(s: ChainState, id: string): boolean {
  const t = teamOfBot(s, id);
  return !!t && id !== t.chief?.id && entryOf(t, id).memory === "own";
}
/** It reads the team's memory and Knowledge: every bot but one keeping its memory to itself with readsTeam false. */
export function readsTeam(s: ChainState, id: string): boolean {
  const t = teamOfBot(s, id);
  return !t || id === t.chief?.id || entryOf(t, id).memory !== "own" || entryOf(t, id).readsTeam !== false;
}

/** The person it works for (their accessKey and name), when its chain says so. A label only: their level is theirs (worksForNow). */
export function worksFor(s: ChainState, id: string): { key: string; name: string } | undefined {
  const t = teamOfBot(s, id);
  const e = t ? entryOf(t, id) : {};
  if (!e.for) return undefined;
  return { key: e.for, name: e.forName || nameFromKey(e.for) };
}

/** A person's name as a key says it, when no name was kept: "ava" for ava@example.com. */
export const nameFromKey = (key: string) => {
  const local = key.startsWith("user:") ? "Someone" : key.split("@")[0];
  return local ? local.charAt(0).toUpperCase() + local.slice(1) : key;
};

/** A person's level on a bot from the access kept on its workspace (cloud/member-access.ts levelOf, read here without importing it). */
export function levelIn(w: ChainWorkspace | undefined, key: string, botId: string): "none" | "read" | "write" {
  const a = w?.memberAccess && Object.hasOwn(w.memberAccess, key) ? w.memberAccess[key] : undefined;
  if (!isObject(a)) return "none";
  const bots = isObject(a.bots) ? a.bots : {};
  const v = Object.hasOwn(bots, botId) ? bots[botId] : a.others;
  return v === "read" || v === "write" ? v : "none";
}

/** The person it works for, while they still have Write on it (the prompt line and the card say so only then). */
export function worksForNow(s: ChainState, id: string): { key: string; name: string } | undefined {
  const who = worksFor(s, id);
  const t = teamOfBot(s, id);
  if (!who || !t) return undefined;
  return levelIn(s.workspaces?.find((w) => w.id === t.ws), who.key, id) === "write" ? who : undefined;
}

/**
 * The only way a chain gets kept: what a client sent (or another Mac synced) made safe. Ids that aren't
 * bots of this workspace go, and so does any entry on the chief; a lead that's unknown, the bot itself or
 * under it (a loop) is dropped (it answers to the chief), and one too deep answers to the deepest lead
 * allowed above it; exceptions naming the chief or two bots in one line go (always open); `for` must be a
 * person the workspace keeps access for; `readsTeam` only with `memory: "own"`. At most MAX_CHAIN_BOTS
 * entries and MAX_CHAIN_PAIRS exceptions. Entries left with nothing go. `bots`: this workspace's.
 */
export function cleanChain(input: unknown, bots: readonly ChainBotRef[], access?: Record<string, unknown>): Chain {
  if (!isObject(input)) return {};
  const chief = bots.find((b) => b.isMain);
  const ids = new Set(bots.map((b) => b.id));
  const out: Chain = {};
  if (input.sideways === "open" || input.sideways === "closed") out.sideways = input.sideways;
  const raw = isObject(input.bots) ? input.bots : {};
  const entries: Record<string, ChainBot> = {};
  for (const [id, v] of Object.entries(raw)) {
    if (Object.keys(entries).length >= MAX_CHAIN_BOTS) break;
    if (!ids.has(id) || id === chief?.id || id === "__proto__" || !isObject(v)) continue;
    const e: ChainBot = {};
    if (typeof v.lead === "string" && ids.has(v.lead) && v.lead !== id) e.lead = v.lead;
    if (v.sideways === "open" || v.sideways === "closed") e.sideways = v.sideways;
    if (v.takesWork === false) e.takesWork = false;
    if (v.handsDown === false) e.handsDown = false;
    if (v.memory === "own") e.memory = "own";
    if (e.memory === "own" && v.readsTeam === false) e.readsTeam = false;
    if (e.memory !== "own" && v.kept === true) e.kept = true;
    if (typeof v.for === "string" && access && Object.hasOwn(access, v.for) && v.for !== "__proto__") {
      e.for = v.for;
      const name = typeof v.forName === "string" ? cleanLabel(v.forName) : "";
      if (name) e.forName = name;
    }
    entries[id] = e;
  }
  // Leads as they resolve: loops broken, too deep pulled up; a lead that is the chief is kept as none (the same).
  const { lead } = resolve(bots, chief, (id) => entries[id]?.lead);
  for (const [id, e] of Object.entries(entries)) {
    const l = lead.get(id);
    if (l && l !== chief?.id) e.lead = l;
    else delete e.lead;
  }
  const kept = Object.entries(entries).filter(([, e]) => Object.keys(e).length > 0);
  if (kept.length) out.bots = Object.fromEntries(kept);
  // Exceptions: two bots beside each other only.
  const t: Team = { ws: "", chain: out, chief, bots, lead, depth: new Map() };
  const rawPairs = isObject(input.pairs) ? input.pairs : {};
  const pairs: Record<string, boolean> = {};
  for (const [key, v] of Object.entries(rawPairs)) {
    if (Object.keys(pairs).length >= MAX_CHAIN_PAIRS) break;
    if (typeof v !== "boolean") continue;
    const [a, b, more] = key.split(">");
    if (more !== undefined || !ids.has(a) || !ids.has(b) || a === b || a === chief?.id || b === chief?.id || inLineIn(t, a, b)) continue;
    pairs[key] = v;
  }
  if (Object.keys(pairs).length) out.pairs = pairs;
  if (typeof input.at === "number" && Number.isFinite(input.at) && input.at > 0) out.at = input.at;
  return out;
}

/** A name kept as a label: no control characters, brackets or quotes, spaces made one, at most 80 characters (member-access.ts cleanName's rule). */
const cleanLabel = (v: string) =>
  v
    .replace(/[\p{Cc}\p{Cf}\p{Zl}\p{Zp}]/gu, " ")
    .replace(/[[\]{}()<>"“”`]/g, "")
    .replace(/\s+/g, " ")
    .trim()
    .slice(0, 80)
    .trim();

/**
 * A deleted bot out of its workspace's chain, in place: its entry goes, the bots under it answer to its lead,
 * and exceptions naming it go. Nothing happens when the chain never named it.
 */
export function chainWithout(chain: Chain | undefined, botId: string, botLead: string | undefined): Chain | undefined {
  if (!chain) return chain;
  const bots = isObject(chain.bots) ? { ...chain.bots } : undefined;
  if (bots) {
    delete bots[botId];
    for (const [id, e] of Object.entries(bots)) {
      if (e?.lead !== botId) continue;
      const next: ChainBot = { ...e };
      if (botLead) next.lead = botLead;
      else delete next.lead;
      bots[id] = next;
    }
  }
  const pairs = isObject(chain.pairs) ? Object.fromEntries(Object.entries(chain.pairs).filter(([k]) => !k.split(">").includes(botId))) : undefined;
  const out: Chain = { ...chain };
  if (bots) {
    const kept = Object.entries(bots).filter(([, e]) => Object.keys(e).length > 0);
    if (kept.length) out.bots = Object.fromEntries(kept);
    else delete out.bots;
  }
  if (pairs) {
    if (Object.keys(pairs).length) out.pairs = pairs;
    else delete out.pairs;
  }
  return out;
}

/** Whether a workspace's chain changes anything from before (any sideways closed, a lead, an exception, a setting). */
export const chainSet = (c: Chain | undefined) =>
  !!c && (c.sideways === "closed" || Object.keys(c.pairs ?? {}).length > 0 || Object.values(c.bots ?? {}).some((e) => Object.keys(e).length > 0));
