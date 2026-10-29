import "server-only";
import { LIGHT } from "./routing";
import { setting } from "./models";
import { Honcho, Session as HonchoSessionRef, type Peer, type Session as HonchoSession } from "@honcho-ai/sdk";
import { openaiClient } from "./openai-client";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { MAIN_WORKSPACE, workspaceOf, type MemoryGroup } from "@/lib/types";
import { appHeaders } from "./app-version";
import { cloudOn, cloudProxy, cloudSessionNow } from "./cloud";
import { chose, decide, yes, type Question } from "./decide";
import { addMessage, bot, getState, ownerName, sameState, stateArrivals, stateEpoch, update, userDir } from "./store";
import { recordTokens, usageTags } from "./usage";

/**
 * Long-term memory, through Honcho (honcho.dev). Each workspace has a memory bank (a Honcho
 * workspace) that its bots share: the user's card (who they are, their projects, their people) and what
 * Honcho has learned about them. The first workspace uses the user's existing bank (from .env.local,
 * maybe shared with their other agents), so bots know them from day one; a new workspace starts with
 * a fresh bank unless they share one or copy what's known about them into it. Every chat and finished task goes back into
 * Honcho, so it keeps learning. If Honcho is slow or down, a turn goes ahead without it.
 *
 * Jev (decide.ts) keeps it clean: it notices when the user says something worth remembering, checks a
 * new fact against what's known (a repeat is skipped, one that replaces an older fact offers to
 * forget it), keeps private lines out of prompts, finds facts that were learned wrong, and tells
 * personal facts from work ones when they copy memory between workspaces.
 *
 * Signed in with Orgo, Honcho is reached through Bops Cloud (lib/server/cloud.ts), and every bank
 * there carries the user's own prefix (bankFor).
 */

const on = () => (cloudOn() ? !!cloudSessionNow()?.honcho : !!process.env.HONCHO_API_KEY);
/** Facts out of a message: a small job of a fixed shape, for Luna (routing.ts LIGHT). */
const MODEL = () => setting(LIGHT(), "BOPS_MEMORY_MODEL");

/** Which Honcho workspace (bank) a Bops workspace's memory lives in, and the user's peer in it. */
export type Binding = { bank: string; peer: string };

/** Honcho ids allow letters, digits, _ and -. */
const clean = (s: string) => s.replace(/[^A-Za-z0-9_-]/g, "-").slice(0, 200);

/** The first workspace uses the user's own bank (from .env.local when self-hosting); the others get one each. */
const ownBank = (ws: string): Binding =>
  ws !== MAIN_WORKSPACE
    ? { bank: `bops-${clean(ws)}`, peer: "user" }
    : cloudOn()
      ? { bank: "bops", peer: "user" }
      : { bank: process.env.HONCHO_WORKSPACE_ID ?? "bops", peer: process.env.HONCHO_USER_PEER ?? "user" };

export function bindingOf(ws: string): Binding {
  return getState().workspaces?.find((w) => w.id === ws)?.memory ?? ownBank(ws);
}

/** The workspace uses its own bank (not one it shares from another workspace). */
export const ownsBank = (ws: string) => bindingOf(ws).bank === ownBank(ws).bank;

/**
 * The workspace a bank belongs to: the one whose own bank it is (the first workspace for the user's
 * own bank), else the first workspace using it. The bank's card and the facts from no Bops chat are its.
 */
export function bankOwner(bank: string): string {
  const all = [MAIN_WORKSPACE, ...(getState().workspaces ?? []).map((w) => w.id).filter((id) => id !== MAIN_WORKSPACE)];
  return all.find((ws) => ownBank(ws).bank === bank && bindingOf(ws).bank === bank) ?? all.find((ws) => bindingOf(ws).bank === bank) ?? MAIN_WORKSPACE;
}

/** Where a workspace that shares another's bank keeps the facts it saves (a bot's remember, Orbit's Add): a session of its own, so they stay its. */
const notesSession = (ws: string) => `bops-notes-${clean(ws)}`;

/**
 * The Bops workspace a memory session belongs to: a chat's (by its bot), a task's (by its bot), or a
 * workspace's notes; null for a session Bops doesn't know (the user's other agents, a chat since deleted).
 */
export function sessionWorkspace(sessionId: string | null): string | null {
  if (!sessionId) return null;
  const st = getState();
  if (sessionId.startsWith("bops-notes-")) return (st.workspaces ?? []).find((w) => notesSession(w.id) === sessionId)?.id ?? (notesSession(MAIN_WORKSPACE) === sessionId ? MAIN_WORKSPACE : null);
  if (sessionId.startsWith("bops-chat-")) {
    const c = st.chats.find((x) => sessionId === `bops-chat-${clean(x.id)}`);
    return c ? workspaceOf(bot(c.botIds[0])) : null;
  }
  if (sessionId.startsWith("bops-task-")) {
    const t = st.sessions.find((x) => sessionId === `bops-task-${clean(x.id)}`);
    return t ? workspaceOf(bot(t.botId)) : null;
  }
  return null;
}

/** The user said something in this Bops chat after `at` (this Mac's clock): what a forgotten item needs to come back. */
export function saidSince(sessionId: string | null, at: number): boolean {
  if (!sessionId?.startsWith("bops-chat-")) return false;
  const st = getState();
  const c = st.chats.find((x) => sessionId === `bops-chat-${clean(x.id)}`);
  return !!c && st.messages.some((m) => m.chatId === c.id && m.role === "user" && m.at > at);
}

/** The workspace a bot's memory comes from. */
export const wsOf = (botId: string) => workspaceOf(bot(botId));

type Bank = {
  client: Honcho;
  peers: Map<string, Promise<Peer>>;
  sessions: Map<string, Promise<HonchoSession>>;
  card?: { at: number; lines: string[] };
  /** Facts saved here lately, so two saves of the same thing at once still see each other. */
  recent: { id: string; text: string; at: number }[];
  /** One new fact at a time per bank (the auto-remember and a bot's remember can race). */
  queue: Promise<unknown>;
};
type Live = {
  banks: Map<string, Bank>;
  /** The key the banks' clients were made with: another sign-in makes new ones. */
  banksKey?: string;
  privacy: Map<string, boolean>;
  kinds: Map<string, Kind>;
};
const g = globalThis as unknown as { bopsMemory2?: Live };
const live: Live = (g.bopsMemory2 ??= { banks: new Map(), privacy: new Map(), kinds: new Map() });

/**
 * A bank's Honcho client. Through Bops Cloud it's on the user's Orgo key, and the bank's Honcho
 * workspace is named with the user's prefix in front (u-<user>-bops, u-<user>-bops-<workspace>), the
 * only ones the cloud lets them reach. The SDK resolves its paths ("/v3/…") against the host alone,
 * so the cloud's /proxy/honcho is put in front of each.
 */
function bankFor(b: Binding) {
  const via = cloudProxy("honcho");
  const prefix = via ? cloudSessionNow()?.honcho?.workspacePrefix : undefined;
  if (via && !prefix) throw new Error("Memory isn't available right now.");
  const key = via ? via.key : (process.env.HONCHO_API_KEY ?? "");
  if (live.banksKey !== key) {
    live.banks.clear();
    live.banksKey = key;
  }
  const workspaceId = prefix ? `${prefix}-${b.bank}` : b.bank;
  let x = live.banks.get(workspaceId);
  if (!x) {
    const client = via
      ? new Honcho({ apiKey: via.key, baseURL: new URL(via.url).origin, workspaceId, timeout: 45_000, maxRetries: 0, defaultHeaders: appHeaders() })
      : new Honcho({ apiKey: process.env.HONCHO_API_KEY, workspaceId, timeout: 45_000, maxRetries: 0 });
    if (via) {
      const http = client.http as unknown as { buildURL(path: string, query?: unknown): string };
      const build = http.buildURL.bind(http);
      const under = new URL(via.url).pathname;
      http.buildURL = (path, query) => build(`${under}${path}`, query);
    }
    x = { client, peers: new Map(), sessions: new Map(), recent: [], queue: Promise.resolve() };
    live.banks.set(workspaceId, x);
  }
  return x;
}

/**
 * Who said something, as a save into memory names the user (`who`): never a bot's id (those are letters, digits
 * and dashes: bots.ts freeBotId), so a bot from before whose id is "owner" is that bot, never the user.
 */
export const OWNER_WHO = "the owner";

/**
 * A member the owner gave Write on a bot (lib/member-access.ts MemberWho), as a save into memory names them: a peer
 * of their own, never the owner's, and never one Honcho learns about (only the owner is observed: peer), so nothing
 * they say about themselves becomes a fact about the owner. Never a bot's id: those have no colon.
 */
export const memberWho = (m: { userId: string }) => `member:${m.userId}`;

/** The user is OWNER_WHO here; in a bank they're the binding's peer. Bots are bops-<id>, members bops-member-<their Orgo id>. */
const peerId = (b: Binding, who: string) => (who === OWNER_WHO ? b.peer : who.startsWith("member:") ? `bops-member-${clean(who.slice(7))}` : `bops-${clean(who)}`);

/** The Honcho peer a save into `ws`'s bank writes `who` as (the owner's: the bank's own peer). */
export const memoryPeerOf = (ws: string, who: string) => peerId(bindingOf(ws), who);

function peer(b: Binding, who = OWNER_WHO) {
  const x = bankFor(b);
  const id = peerId(b, who);
  let p = x.peers.get(id);
  if (!p) {
    const bt = who === OWNER_WHO ? undefined : bot(who);
    // Bots aren't worth modelling; the user is the one Honcho learns about.
    p = x.client.peer(id, who === OWNER_WHO ? undefined : { metadata: { app: "bops", name: bt?.name ?? who, role: bt?.role ?? "" }, configuration: { observeMe: false } });
    p.catch(() => x.peers.delete(id));
    x.peers.set(id, p);
  }
  return p;
}

function session(b: Binding, id: string, who: string[], metadata: Record<string, unknown>) {
  const x = bankFor(b);
  let s = x.sessions.get(id);
  if (!s) {
    s = (async () => {
      const sess = await x.client.session(id, { metadata: { app: "bops", ...metadata } });
      await sess.addPeers(who.map((w) => [peerId(b, w), { observeMe: w === OWNER_WHO }] as [string, { observeMe: boolean }]));
      return sess;
    })();
    s.catch(() => x.sessions.delete(id));
    x.sessions.set(id, s);
  }
  return s;
}

const within = <T>(p: Promise<T>, ms: number) => Promise.race([p, new Promise<null>((r) => setTimeout(() => r(null), ms))]);

/**
 * Lines kept out of prompts: home and family addresses, phone numbers, keys, birth date, account
 * numbers, health. Bots work on web pages that may try to get them out; recall can still look one
 * up when a task needs it. The patterns catch the obvious ones at once; Jev reads the rest (each
 * line once, then remembered).
 */
const PRIVATE = [
  // Whole words, so a project named AgentPhone isn't taken for a phone number.
  /\b(?:address|resides?|phone|hex key|public key|private key|birth\s?date|born|passport|ssn|social security|password)\b/i,
  // A street address, a phone number, or a key, wherever it appears in the line.
  /\b\d{2,6}\s+(?:[NSEW]\.?\s+)?[A-Za-z][\w.]*(?:\s+[A-Za-z][\w.]*)*\s+(?:St|Street|Rd|Road|Ave|Avenue|Ln|Lane|Blvd|Dr|Drive|Way|Ct|Court|Pl|Place)\b/i,
  /\+?\d[\d\s().-]{8,}\d/,
  /\b[0-9a-f]{32,}\b|\bnpub1\w+/i,
];
const isPrivate = (line: string) => PRIVATE.some((re) => re.test(line));

const PRIVATE_Q = (line: string): Question => ({
  type: "noul",
  instructions: `A line from ${ownerName()}'s memory: "${line}". Is it private: something that could hurt them if a web page or a stranger got it? Private means a home or family address, a phone number, an ID or account number, a password, key or secret, their birth date, money account details, or health details. Names of people, their preferences, their job and their company are not private.`,
  criteria: { true: "Private", false: "Fine to share with their assistants while they work on the web" },
});

/** The lines that are safe to put in a prompt. If Jev can't answer, only the patterns decide (and nothing is cached). */
async function shareable(lines: string[]) {
  const unsure = [...new Set(lines.filter((l) => !isPrivate(l) && !live.privacy.has(l)))].slice(0, 80);
  if (unsure.length) {
    const a = await decide({ about: `${ownerName()}'s long-term memory` }, Object.fromEntries(unsure.map((l, i) => [`l${i}`, PRIVATE_Q(l)])));
    if (a) unsure.forEach((l, i) => live.privacy.set(l, (yes(a[`l${i}`]) ?? 0) >= 0.5));
  }
  return lines.filter((l) => !isPrivate(l) && !live.privacy.get(l));
}

async function card(b: Binding) {
  const x = bankFor(b);
  if (x.card && Date.now() - x.card.at < 10 * 60_000) return x.card.lines;
  const lines = (await (await peer(b)).getCard()) ?? [];
  x.card = { at: Date.now(), lines };
  return lines;
}

/**
 * What a bot should know about the user for this message or task: their card, plus what Honcho has
 * learned that's relevant to `about` (unless `search` is false: just the card, which is quick).
 * Empty when memory is off or too slow.
 */
export async function memoryBlock(ws: string, about: string, ms = 2500, { search = true }: { search?: boolean } = {}): Promise<string> {
  if (!on()) return "";
  const b = bindingOf(ws);
  const owner = ownerName();
  try {
    const res = await within(
      (async () => {
        // The card is cached and quick; the search is what takes time, so it's skipped when it won't help.
        const [lines, ctx] = await Promise.all([
          card(b),
          search ? (await peer(b)).context({ searchQuery: about.slice(0, 400) || owner, searchTopK: 10, maxConclusions: 12, includeMostFrequent: false }) : null,
        ]);
        const learned = String(ctx?.representation ?? "")
          .split("\n")
          .map((l) => l.replace(/^\[[^\]]+\]\s*/, "").trim())
          .filter((l) => l && !l.startsWith("#"))
          .slice(0, 16);
        const ok = new Set(await shareable([...lines, ...learned]));
        return [lines.filter((l) => ok.has(l)), learned.filter((l) => ok.has(l)).slice(0, 12)] as const;
      })(),
      ms,
    );
    if (!res) return "";
    const [lines, learned] = res;
    if (!lines.length && !learned.length) return "";
    return [
      `What you know about ${owner}, from their long-term memory. Use it so they don't have to repeat themselves; it can be out of date or wrong, and what they say now wins. Don't recite it back to them.`,
      ...(lines.length ? [`About ${owner}:`, ...lines.map((l) => `- ${l}`)] : []),
      ...(learned.length ? ["Learned before, relevant now:", ...learned.map((l) => `- ${l}`)] : []),
    ].join("\n");
  } catch {
    return "";
  }
}

/**
 * Add what was said to Honcho (so it keeps learning about the user). `kind` is chat or task; the id is
 * the Bops chat or thread. Fire and forget: memory never holds up a reply.
 */
export function saveToMemory(ws: string, kind: "chat" | "task", id: string, messages: { who: string; text: string }[], metadata: Record<string, unknown> = {}) {
  if (!on()) return;
  const msgs = messages.filter((m) => m.text.trim());
  if (!msgs.length) return;
  const b = bindingOf(ws);
  const sid = `bops-${kind}-${clean(id)}`;
  void (async () => {
    const who = [...new Set([OWNER_WHO, ...msgs.map((m) => m.who)])];
    // The workspace it's from, so a bank two workspaces share knows whose it is.
    const s = await session(b, sid, who, { kind, ws, ...metadata });
    const peers = await Promise.all(msgs.map((m) => peer(b, m.who)));
    await s.addMessages(msgs.map((m, i) => peers[i].message(m.text.slice(0, 8000), { metadata: { app: "bops", kind } })));
    // Memory works out new facts from it in the background, minutes later: the categories look again then.
    categoriesNudge(ws, "chat");
  })().catch((e: Error) => {
    // Set up again next time (the session may have been deleted in Honcho).
    bankFor(b).sessions.delete(sid);
    console.warn(`[memory] save ${kind} ${id}: ${e.message}`);
  });
}

/** How a new fact relates to one already known. */
const RELATION = (fact: string, known: string): Question => ({
  type: "choice",
  instructions: `A memory about ${ownerName()} has a saved fact, and a new fact just came in. Saved: "${known}". New: "${fact}". How does the new fact relate to the saved one?`,
  criteria: {
    same: "Says the same thing as the saved fact (a duplicate, maybe in other words).",
    replaces: "Updates or contradicts the saved fact: both can't be true now, so the saved one is out of date.",
    unrelated: "About something else, or both can be true together.",
  },
});

/** Card lines are known facts too; their id is "card:" and the line. */
const CARD = "card:";

/**
 * Save a fact about the user, after checking it against what's known: a repeat isn't saved again, and
 * one that replaces an older fact (their parents moved) says so in the chat, with a button to forget
 * the old one. The chat line has an Undo. Returns what happened, for the bot.
 */
export function learn(ws: string, fact: string, chatId?: string, opts: { auto?: boolean } = {}): Promise<string> {
  if (!on()) return Promise.resolve("Memory isn't set up.");
  const text = fact.trim().slice(0, 1000);
  if (!text) return Promise.resolve("Nothing to save.");
  // The workspace's memory is shared by every bot in it: what the user wants kept from one of them stays out.
  // (Checked on the fact, and on what the user just said in this chat: a bot saving it with `remember`.)
  const lastFromOwner = chatId ? [...getState().messages].reverse().find((m) => m.chatId === chatId && m.role === "user") : undefined;
  const keptFrom = /\bnot (to )?(tell|share with|mention to)\b|\bwants? \w+ not to\b|\bkept? (it )?from\b/i;
  if (SECRET.test(text) || keptFrom.test(text) || isSecret(lastFromOwner?.id))
    return Promise.resolve(`Not saved: ${ownerName()} wants this kept from someone, and the memory is shared by the whole team. Keep it to yourself in this conversation.`);
  const b = bindingOf(ws);
  const x = bankFor(b);
  const ours = sameState();
  const run = x.queue.then(async () => {
    if (!ours()) return "Not saved: another account signed in.";
    const p = await peer(b);
    const [near, lines] = await Promise.all([p.conclusions.query(text, 6).catch(() => []), card(b).catch(() => [] as string[])]);
    x.recent = x.recent.filter((r) => Date.now() - r.at < 10 * 60_000);
    const known = new Map<string, string>();
    for (const r of x.recent) known.set(r.id, r.text);
    for (const c of near) known.set(c.id, c.content);
    for (const l of lines) known.set(CARD + l, l);
    const ids = [...known.keys()].slice(0, 60);
    const a = ids.length ? await decide({ about: `${ownerName()}'s long-term memory` }, Object.fromEntries(ids.map((id, i) => [`k${i}`, RELATION(text, known.get(id)!)]))) : {};
    const prob = (i: number, k: string) => chose(a?.[`k${i}`])?.probabilities[k] ?? 0;
    const same = ids.findIndex((_, i) => prob(i, "same") >= 0.6);
    if (same >= 0) return `Already known: ${known.get(ids[same])}`;
    if (!ours()) return "Not saved: another account signed in.";
    // A workspace sharing another's bank saves into a session of its own: its Orbit, not the other's, shows it.
    const notes = ownsBank(ws) ? undefined : await notesFor(b, ws);
    const [made] = await p.conclusions.create([{ content: text, ...(notes ? { sessionId: notes } : {}) }]);
    x.recent.push({ id: made.id, text, at: Date.now() });
    // A fact saved by hand or by a bot is sorted into the categories in seconds; one Bops noted on its
    // own from what the user said waits to be sorted with the next few (each sort is a model call).
    categoriesNudge(ws, opts.auto ? "saved" : "learned");
    let best = -1;
    ids.forEach((_, i) => prob(i, "replaces") >= 0.7 && (best < 0 || prob(i, "replaces") > prob(best, "replaces")) && (best = i));
    const old = best >= 0 ? { id: ids[best], text: known.get(ids[best])! } : undefined;
    if (chatId && ours()) addMessage({ chatId, role: "system", text: `Remembered: ${text}`, memory: { ws, id: made.id, fact: text, old } });
    return old ? `Saved. It may replace an older fact ("${old.text}"); ${ownerName()} was asked whether to forget that one.` : "Saved.";
  });
  x.queue = run.catch(() => {});
  return run;
}

/** A workspace's notes session in a bank (made once): nothing in it is ever worked out into facts. */
async function notesFor(b: Binding, ws: string) {
  const x = bankFor(b);
  const id = notesSession(ws);
  if (!x.sessions.has(id)) {
    const s = x.client.session(id, { metadata: { app: "bops", kind: "notes", ws }, configuration: { reasoning: { enabled: false } }, peers: [[b.peer, { observeMe: false, observeOthers: false }]] });
    s.catch(() => x.sessions.delete(id));
    x.sessions.set(id, s);
  }
  await x.sessions.get(id);
  return id;
}

/** Jev: does what the user just said tell their bots something lasting about them? */
const WORTH_REMEMBERING = (said: string): Question => ({
  type: "noul",
  instructions: `${ownerName()} sent their AI assistant this message: "${said.slice(0, 1500)}". Does it tell the assistant a lasting fact about ${ownerName()} that it should remember for next time: a preference, a rule for how they want things done, a person in their life, a decision, a plan, where someone lives? A request to do something, a question, small talk, or how they feel right now is not one.`,
  criteria: { true: "States a lasting fact worth remembering", false: "A request, question, small talk, or passing state" },
});

const openai = openaiClient();

/** Asking to keep something from someone ("don't tell Sam yet", "keep this between us"): caught at once, before Jev. */
const SECRET = /\b(don'?t|do not|never) (tell|share|mention|let)\b|\bkeep (it|this|that)? ?(from|between|private|quiet)|\bbetween (us|you and me)\b|\b(this is|it's|that's) private\b|\boff the record\b/i;

/**
 * Messages the user asked to keep from someone: never sent to the shared memory, nor the bot's reply to
 * them, nor into a procedure's draft. Marked on the message itself (Message.secret), so the mark outlasts
 * a restart, is there with memory off and reaches the user's other Macs. The set is those marks, quick to
 * ask (a draft asks about every message in a chat): this server's own as they're made, and the others read
 * from the messages once each time messages come in from elsewhere (stateArrivals: a sign-in, another
 * Mac's changes).
 */
const secrets = new Set<string>();
let secretsRead = -1;
export function isSecret(messageId: string | undefined) {
  if (!messageId) return false;
  if (secretsRead !== stateArrivals()) {
    secretsRead = stateArrivals();
    for (const m of getState().messages) if (m.secret) secrets.add(m.id);
  }
  return secrets.has(messageId);
}
function markSecret(messageId: string) {
  secrets.add(messageId);
  update((s) => {
    const at = s.messages.findIndex((x) => x.id === messageId);
    const m = s.messages[at];
    if (!m) return;
    m.secret = true;
    // The threads the bots' answers to it started (marked later than they were: Jev's check takes a
    // moment), and what's said about them, are kept between us too (Session.secret).
    const threads = new Set<string>();
    for (const x of s.messages.slice(at + 1)) {
      if (x.chatId !== m.chatId) continue;
      if (x.role === "user") break;
      for (const t of x.sessionIds ?? []) threads.add(t);
    }
    if (!threads.size) return;
    for (const t of s.sessions) if (threads.has(t.id)) t.secret = true;
    for (const x of s.messages) if ((x.resultOf && threads.has(x.resultOf)) || x.sessionIds?.some((t) => threads.has(t))) x.secret = true;
  });
}

/**
 * The user's message, into the workspace's memory (which all its bots share), with two checks first
 * (one Jev call): something they want kept from someone ("don't tell Sam yet") stays with the bot
 * they told and goes nowhere near the shared memory; something worth knowing next time ("I'm
 * vegetarian now") is saved as a fact without their having to say "remember" (a small model writes
 * it; learn() checks it against what's known). Fire and forget.
 */
export function rememberMessage(ws: string, chatId: string, messageId: string, said: string, metadata: Record<string, unknown> = {}, member?: { userId: string }) {
  if (!said.trim()) return;
  // Marked with memory off too: a procedure's draft reads the chat whether or not there's a memory.
  if (SECRET.test(said)) {
    markSecret(messageId);
    return;
  }
  if (!on()) return;
  // A member's words (someone the owner gave Write on the bot): into the shared memory as theirs (memberWho), and
  // nothing more. No fact is drawn from them: what they say about themselves is never a fact about the owner.
  if (member) {
    saveToMemory(ws, "chat", chatId, [{ who: memberWho(member), text: said }], metadata);
    return;
  }
  // The account whose message this is: a sign-out or another account's sign-in meanwhile, and nothing of it goes into the new one's memory.
  const ours = sameState();
  const epoch = stateEpoch();
  void (async () => {
    const owner = ownerName();
    const a = await decide(
      { app: `Bops: ${owner}'s team of AI assistants` },
      {
        worth: WORTH_REMEMBERING(said),
        secret: {
          type: "noul",
          instructions: `${owner} sent their AI assistant: "${said.slice(0, 1500)}". Does ${owner} ask for this to be kept from someone, or kept private or between them ("don't tell Sam", "keep this between us", "this is private")?`,
          criteria: { true: "They ask to keep it from someone or private", false: "No" },
        },
      },
    );
    if ((yes(a?.secret) ?? 0) >= 0.4) {
      if (ours()) markSecret(messageId);
      return;
    }
    if (!ours()) return;
    saveToMemory(ws, "chat", chatId, [{ who: OWNER_WHO, text: said }], metadata);
    if (said.trim().length < 8 || (yes(a?.worth) ?? 0) < 0.6) return;
    const res = await openai.responses.create({
      model: MODEL(),
      reasoning: { effort: "low" },
      instructions: `${owner} told their assistant something about themselves. Write each lasting fact in it as one plain sentence in the third person, starting with "${owner}" ("${owner} is vegetarian.", "${owner}'s sister is Ana."). One per line, at most three. Only what they said, nothing guessed. If there's no lasting fact, write NONE.`,
      input: said.slice(0, 2000),
    }, usageTags("memory"));
    recordTokens("memory", res.model, res.usage, undefined, epoch);
    if (!ours()) return;
    const facts = (res.output_text ?? "")
      .split("\n")
      .map((l) => l.replace(/^[-*•\d.)\s]+/, "").trim())
      .filter((l) => l && l !== "NONE" && l.length < 400)
      .slice(0, 3);
    for (const f of facts) if (ours()) await learn(ws, f, chatId, { auto: true });
  })().catch((e: Error) => console.warn(`[memory] auto-remember: ${e.message}`));
}

/** Take back a fact the chat said was remembered, or forget the older fact it replaced. */
export async function undoMemory(messageId: string, what: "undo" | "forget-old") {
  const m = getState().messages.find((x) => x.id === messageId);
  if (!m?.memory) throw new Error("not a memory note");
  const b = bindingOf(m.memory.ws);
  const target = what === "undo" ? m.memory.id : m.memory.old?.id;
  if (!target) throw new Error("nothing to forget");
  await forget(b, target);
  update((s) => {
    const x = s.messages.find((y) => y.id === messageId);
    if (!x?.memory) return;
    if (what === "undo") x.memory.undone = true;
    else if (x.memory.old) x.memory.old.forgotten = true;
  });
}

/** Delete a fact: a conclusion by id, or a line of the card. */
async function forget(b: Binding, id: string) {
  const x = bankFor(b);
  const p = await peer(b);
  if (id.startsWith(CARD)) {
    const line = id.slice(CARD.length);
    const lines = (await p.getCard()) ?? [];
    await p.setCard(lines.filter((l) => l !== line));
    x.card = undefined;
  } else {
    await p.conclusions.delete(id);
    x.recent = x.recent.filter((r) => r.id !== id);
  }
  categoriesDropped(b.bank, [id]);
}

/** Ask the user's memory a question ("what's their shipping address?", "what did we decide about pricing?"). */
export async function recall(ws: string, question: string) {
  if (!on()) return "Memory isn't set up.";
  const b = bindingOf(ws);
  // Medium: "low" got facts wrong in testing (gave the user's own address for their parents').
  // Answers take 3 to 10 seconds (sometimes more); each one is billed, so no retries.
  const res = await within((async () => (await peer(b)).chat(question.slice(0, 1000), { reasoningLevel: "medium" }))(), 45_000);
  return res ? String(res).trim() || "Nothing on that." : "Memory took too long to answer.";
}

export const memoryOn = on;

/** Every fact Honcho has concluded about the user in a bank, newest first (up to `max`). */
async function allFacts(b: Binding, max = 3000, progress?: (n: number, total?: number) => void) {
  const p = await peer(b);
  const out: { id: string; text: string }[] = [];
  const page = await p.conclusions.list({ size: 100 });
  for await (const c of page) {
    out.push({ id: c.id, text: c.content });
    if (out.length % 500 === 0) progress?.(out.length, page.total);
    if (out.length >= max) break;
  }
  return out;
}

/** In batches, a few at a time: Jev answers many questions per call but each call has a limit. */
async function inBatches<T, R>(items: T[], size: number, fn: (batch: T[]) => Promise<R[]>, each?: (done: number) => void) {
  const batches: T[][] = [];
  for (let i = 0; i < items.length; i += size) batches.push(items.slice(i, i + size));
  const out: R[] = [];
  for (let i = 0; i < batches.length; i += 4) {
    for (const r of await Promise.all(batches.slice(i, i + 4).map(fn))) out.push(...r);
    each?.(Math.min(items.length, (i + 4) * size));
  }
  return out;
}

/** What kind of fact Honcho learned: about the user, or one it got wrong. */
const FACT_KIND = (fact: string): Question => {
  const owner = ownerName();
  return {
    type: "choice",
    instructions: `Which is this fact, learned by an AI memory system watching ${owner}'s chats with their AI agents? Fact: "${fact}"`,
    criteria: {
      about_owner: `A real, lasting fact about ${owner}: who they are, what they like or prefer, their work, their plans, their decisions and rules for their agents, or the people and companies they deal with (partner, family, friends, team, customers, vendors) and facts about them.`,
      agent_rule: `Really an AI agent's own instructions or behavior (how to reply, what tools to use, what not to say), wrongly written as if it were about ${owner}. A rule ${owner} set for their own agents is not this.`,
      someone_else: `Really a stranger's own details filed as if they were ${owner}'s (a message sender's name, age, job or likes written as ${owner}'s). A fact about someone ${owner} deals with, written as about that person ("${owner}'s accountant is Dana", "Dana wants the quote Friday"), is not this.`,
      passing: "A passing moment or task detail that won't matter later (what they asked at some time, a step in a task).",
    },
  };
};
/** Who the facts are about, for Jev. A function so it always has the current name. */
const STATE = () => ({ about: `Facts an AI memory system wrote about ${ownerName()}, from their chats with their AI agents (some of those agents reply to other people for them).` });

/**
 * Reviews live in their own file, not the app state: a big bank flags thousands of facts, and the
 * app state goes to the page every few seconds. The Memory sheet gets a summary (memoryInfo).
 */
type Review = {
  at: number;
  running?: boolean;
  error?: string;
  total?: number;
  checked: number;
  flagged: { id: string; text: string; group: MemoryGroup; sure: number }[];
  deleting?: { group: MemoryGroup; done: number; total: number };
  /** Facts the user said to keep: not flagged again. */
  kept: string[];
};
/** The reviews, in the signed-in user's folder on this Mac (null signed out: nothing kept). */
const reviewsFile = () => {
  const dir = userDir();
  return dir ? join(dir, "memory-reviews.json") : null;
};
const gr = globalThis as unknown as { bopsReviews?: { file: string | null; all: Record<string, Review> } };
function reviews() {
  const file = reviewsFile();
  if (gr.bopsReviews?.file !== file) gr.bopsReviews = { file, all: file && existsSync(file) ? (JSON.parse(readFileSync(file, "utf8")) as Record<string, Review>) : {} };
  return gr.bopsReviews.all;
}
function setReview(bank: string, patch: Partial<Review> | ((r: Review) => void), save = true) {
  const all = reviews();
  const r = (all[bank] ??= { at: 0, checked: 0, flagged: [], kept: [] });
  if (typeof patch === "function") patch(r);
  else Object.assign(r, patch);
  const file = reviewsFile();
  if (save && file) {
    mkdirSync(dirname(file), { recursive: true });
    writeFileSync(file, JSON.stringify(all));
  }
}

/**
 * Look through everything learned about the user in a workspace's bank and flag what looks wrong (an
 * agent's own rules taken for theirs, someone else's details, passing moments). Runs in the
 * background; the Memory sheet shows them grouped, to delete or keep. Jev sorts 40 facts a call.
 */
export function reviewMemory(ws: string) {
  const b = bindingOf(ws);
  const now = reviews()[b.bank];
  if (now?.running || now?.deleting) return;
  setReview(b.bank, { running: true, at: Date.now(), error: undefined, checked: 0, total: undefined });
  void (async () => {
    const kept = new Set(reviews()[b.bank]?.kept ?? []);
    const facts = (await allFacts(b, 50_000, (n, total) => setReview(b.bank, { total }, false))).filter((f) => !kept.has(f.id));
    setReview(b.bank, { total: facts.length }, false);
    const judged = await inBatches(
      facts,
      40,
      async (batch) => {
        // One retry; a batch Jev can't answer is left unchecked rather than failing the review.
        const ask = () => decide(STATE(), Object.fromEntries(batch.map((f, i) => [`f${i}`, FACT_KIND(f.text)])));
        const a = (await ask()) ?? (await ask());
        return a ? batch.map((f, i) => ({ f, c: chose(a[`f${i}`]) })) : [];
      },
      (done) => setReview(b.bank, { checked: done }, false),
    );
    const flagged = judged
      .filter(({ c }) => c && (c.choice !== "about_owner" || (c.probabilities.about_owner ?? 0) < 0.6))
      .map(({ f, c }) => {
        const sure = c!.choice === "about_owner" ? 1 - (c!.probabilities.about_owner ?? 0) : (c!.probabilities[c!.choice] ?? 0);
        // Only what Jev is sure of goes in a group that can be deleted all at once.
        const group: MemoryGroup = c!.choice !== "about_owner" && sure >= 0.8 ? (c!.choice as MemoryGroup) : "unsure";
        return { id: f.id, text: f.text, group, sure };
      })
      .sort((p, q) => q.sure - p.sure);
    setReview(b.bank, { running: false, at: Date.now(), checked: judged.length, flagged });
  })().catch((e: Error) => setReview(b.bank, { running: false, error: e.message }));
}

/** The user's call on a flagged fact: delete it, or keep it (and don't flag it again). */
export async function settleFlag(ws: string, factId: string, keep: boolean) {
  const b = bindingOf(ws);
  if (!keep) await forget(b, factId);
  setReview(b.bank, (r) => {
    r.flagged = r.flagged.filter((f) => f.id !== factId);
    if (keep) r.kept.push(factId);
  });
}

/** Delete every fact in a group (passing moments, an agent's rules…), eight at a time, in the background. */
export function deleteGroup(ws: string, group: MemoryGroup) {
  const b = bindingOf(ws);
  const r = reviews()[b.bank];
  if (!r || r.running || r.deleting || group === "unsure") return;
  const ids = r.flagged.filter((f) => f.group === group).map((f) => f.id);
  if (!ids.length) return;
  setReview(b.bank, { deleting: { group, done: 0, total: ids.length } });
  void (async () => {
    const p = await peer(b);
    for (let i = 0; i < ids.length; i += 8) {
      const chunk = ids.slice(i, i + 8);
      const gone = new Set<string>();
      await Promise.all(chunk.map((id) => p.conclusions.delete(id).then(() => gone.add(id)).catch(() => {})));
      categoriesDropped(b.bank, [...gone]);
      setReview(
        b.bank,
        (x) => {
          x.flagged = x.flagged.filter((f) => !gone.has(f.id));
          x.deleting = { group, done: Math.min(ids.length, i + 8), total: ids.length };
        },
        i % 200 === 0,
      );
    }
    bankFor(b).recent = [];
    setReview(b.bank, { deleting: undefined });
  })().catch((e: Error) => setReview(b.bank, { deleting: undefined, error: e.message }));
}

/** The review, as the Memory sheet shows it: counts per group, and the first facts in each. */
function reviewSummary(bank: string) {
  const r = reviews()[bank];
  if (!r) return null;
  const groups = (["passing", "agent_rule", "someone_else", "unsure"] as const)
    .map((key) => {
      const all = r.flagged.filter((f) => f.group === key);
      return { key, count: all.length, items: all.slice(0, 40).map(({ id, text }) => ({ id, text })) };
    })
    .filter((x) => x.count);
  return { at: r.at, running: !!r.running, error: r.error, total: r.total, checked: r.checked, flagged: r.flagged.length, deleting: r.deleting, groups };
}

type Kind = "personal" | "work" | "skip";
const PERSONAL_OR_WORK = (fact: string): Question => ({
  type: "choice",
  instructions: `A fact from ${ownerName()}'s memory: "${fact}". Is it about their personal life or their work?`,
  criteria: {
    personal: "Personal: who they are, their tastes and habits, family, friends, partner, health, home, their own plans, how they like to communicate.",
    work: "Work: their company, customers, deals, pricing, team, products, investors, work projects.",
  },
});

/** Personal, work, or skip (learned wrong), for each fact; asked once per fact. */
async function kinds(texts: string[]) {
  const unsure = [...new Set(texts.filter((t) => !live.kinds.has(t)))];
  await inBatches(unsure, 30, async (batch) => {
    const q: Record<string, Question> = {};
    batch.forEach((t, i) => {
      q[`k${i}`] = PERSONAL_OR_WORK(t);
      q[`f${i}`] = FACT_KIND(t);
    });
    const a = await decide(STATE(), q);
    if (!a) throw new Error("The memory check didn't answer");
    batch.forEach((t, i) => {
      const f = chose(a[`f${i}`]);
      const k = chose(a[`k${i}`]);
      live.kinds.set(t, f && f.choice !== "about_owner" && (f.probabilities[f.choice] ?? 0) >= 0.5 ? "skip" : (k?.probabilities.work ?? 0) >= 0.5 ? "work" : "personal");
    });
    return [];
  });
  return texts.map((t) => live.kinds.get(t) ?? "personal");
}

/** What copying `from`'s memory into `ws` would bring: how many personal and work facts, with a few of each. */
export async function previewCopy(ws: string, from: string) {
  const src = bindingOf(from);
  if (src.bank === bindingOf(ws).bank) throw new Error("These workspaces already share memory.");
  const [lines, facts] = await Promise.all([card(src), allFacts(src)]);
  const texts = [...lines, ...facts.map((f) => f.text)];
  const k = await kinds(texts);
  const pick = (kind: Kind) => texts.filter((_, i) => k[i] === kind);
  const personal = pick("personal");
  const work = pick("work");
  return { personal: personal.length, work: work.length, skipped: pick("skip").length, examples: { personal: personal.slice(0, 4), work: work.slice(0, 4) } };
}

/**
 * Copy what `from` knows about the user into `ws`'s bank, once: the kinds they picked (personal, work),
 * leaving out facts learned wrong. Card lines go on the card (it holds 40); the rest become facts.
 */
export async function copyMemory(ws: string, from: string, want: ("personal" | "work")[]) {
  const src = bindingOf(from);
  const dst = bindingOf(ws);
  if (src.bank === dst.bank) throw new Error("These workspaces already share memory.");
  const [lines, facts, p] = await Promise.all([card(src), allFacts(src), peer(dst)]);
  const [lk, fk] = await Promise.all([kinds(lines), kinds(facts.map((f) => f.text))]);
  const keep = (k: Kind) => (want as Kind[]).includes(k);
  const cardLines = lines.filter((_, i) => keep(lk[i]));
  const factTexts = facts.filter((_, i) => keep(fk[i])).map((f) => f.text);
  if (cardLines.length) {
    const had = (await p.getCard()) ?? [];
    await p.setCard([...had, ...cardLines.filter((l) => !had.includes(l))].slice(0, 40));
    bankFor(dst).card = undefined;
  }
  for (let i = 0; i < factTexts.length; i += 100) await p.conclusions.create(factTexts.slice(i, i + 100).map((content) => ({ content })));
  return { card: cardLines.length, facts: factTexts.length };
}

/** Use another workspace's memory (both read and add to the same bank), or go back to this workspace's own. */
export function shareMemory(ws: string, from: string | null) {
  update((s) => {
    const w = s.workspaces?.find((x) => x.id === ws);
    if (!w) throw new Error("no such workspace");
    if (from) w.memory = bindingOf(from);
    else delete w.memory;
  });
}

/** For the Memory sheet: the bank, who shares it, how many facts it has, and the review. */
export async function memoryInfo(ws: string) {
  const b = bindingOf(ws);
  const sharedWith = (getState().workspaces ?? []).filter((w) => w.id !== ws && bindingOf(w.id).bank === b.bank).map((w) => ({ id: w.id, name: w.name }));
  const lines = on() ? await within(card(b).catch(() => []), 8000) : [];
  const ok = new Set(lines ? await shareable(lines) : []);
  return {
    on: on(),
    bank: b.bank,
    own: b.bank === ownBank(ws).bank,
    sharedWith,
    card: (lines ?? []).map((l) => ({ text: l, private: !ok.has(l) })),
    review: reviewSummary(b.bank),
  };
}

/** Where a fact was learned, in words: a chat or task in Bops, or the user's other agents. */
function sourceOf(sessionId: string | null) {
  if (!sessionId || sessionId.startsWith("bops-notes-")) return "Saved by hand";
  const st = getState();
  for (const c of st.chats) if (sessionId === `bops-chat-${clean(c.id)}`) return c.kind === "bot" ? `Chat with ${bot(c.botIds[0])?.name ?? "a bot"}` : (c.title ?? "Group chat");
  for (const s of st.sessions) if (sessionId === `bops-task-${clean(s.id)}`) return `Task: ${s.title}`;
  return sessionId.startsWith("bops-") ? "Bops" : "Your other agents";
}

/** Facts worth showing: Jev drops what looks learned wrong (each fact asked once). If Jev can't answer, all stay. */
const good = new Map<string, boolean>();
async function worthShowing<T extends { text: string }>(facts: T[]) {
  const unsure = [...new Set(facts.map((f) => f.text).filter((t) => !good.has(t)))];
  await inBatches(unsure, 40, async (batch) => {
    const a = await decide(STATE(), Object.fromEntries(batch.map((t, i) => [`f${i}`, FACT_KIND(t)])));
    if (a) batch.forEach((t, i) => good.set(t, (chose(a[`f${i}`])?.probabilities.about_owner ?? 1) >= 0.5));
    return [];
  });
  return facts.filter((f) => good.get(f.text) !== false);
}

/** The Honcho sessions a bot's chats and tasks were saved in. */
function sessionsOf(botId: string) {
  const st = getState();
  return [
    ...st.chats.filter((c) => c.botIds.includes(botId)).map((c) => `bops-chat-${clean(c.id)}`),
    ...st.sessions.filter((s) => s.botId === botId).map((s) => `bops-task-${clean(s.id)}`),
  ].slice(-300);
}

/**
 * A bot's Memory tab: the user's card, and what's been learned about them (newest first, or what
 * matches a search), leaving out facts that look learned wrong. `mine` narrows it to what this bot
 * learned (from its chats and tasks). Memory is the workspace's: every bot on the team shares it.
 */
export async function memoryFor(botId: string, opts: { q?: string; mine?: boolean } = {}) {
  const ws = wsOf(botId);
  const b = bindingOf(ws);
  const p = await peer(b);
  const mine = opts.mine ? new Set(sessionsOf(botId)) : null;
  type Raw = { id: string; content: string; sessionId: string | null; createdAt: string };
  let raw: Raw[];
  if (opts.q?.trim()) raw = ((await p.conclusions.query(opts.q.trim().slice(0, 300), mine ? 60 : 30)) as Raw[]).filter((c) => !mine || (c.sessionId && mine.has(c.sessionId)));
  else if (mine) raw = mine.size ? ((await bankFor(b).client.conclusions.list({ size: 100, filters: { observer_id: b.peer, observed_id: b.peer, session_id: { in: [...mine] } } })).items as Raw[]) : [];
  else raw = (await p.conclusions.list({ size: 100 })).items as Raw[];
  const facts = (await worthShowing(raw.map((c) => ({ id: c.id, text: c.content, at: Date.parse(c.createdAt) || 0, source: sourceOf(c.sessionId) })))).slice(0, 40);
  const lines = opts.q || mine ? [] : await card(b).catch(() => [] as string[]);
  const ok = new Set(await shareable([...lines, ...facts.map((f) => f.text)]));
  return {
    workspace: getState().workspaces?.find((w) => w.id === ws)?.name ?? "this workspace",
    ws,
    card: lines.map((l) => ({ id: CARD + l, text: l, private: !ok.has(l) })),
    facts: facts.map((f) => ({ ...f, private: !ok.has(f.text) })),
  };
}

/** Ask memory a question, with what it's based on: the closest facts and where each was learned. */
export const askMemory = (botId: string, question: string) => askWorkspace(wsOf(botId), question);

/** The same for a workspace's memory (the Knowledge page). */
export async function askWorkspace(ws: string, question: string) {
  const b = bindingOf(ws);
  const [answer, near] = await Promise.all([recall(ws, question), (async () => (await peer(b)).conclusions.query(question.slice(0, 300), 8))().catch(() => [])]);
  // Only facts that are about what was asked (the nearest ones can still be off topic).
  const facts = await worthShowing(near.map((c) => ({ id: c.id, text: c.content, source: sourceOf(c.sessionId) })));
  const a = facts.length
    ? await decide(
        { question },
        Object.fromEntries(
          facts.map((f, i) => [`f${i}`, { type: "noul", instructions: `Question: "${question}". Fact: "${f.text}". Does this fact help answer the question?`, criteria: { true: "Helps answer it", false: "About something else" } } as Question]),
        ),
      )
    : null;
  const based = facts.filter((_, i) => !a || (yes(a[`f${i}`]) ?? 1) >= 0.3).slice(0, 4);
  return { answer, based };
}

/** Correct a fact (a card line is changed in place; a learned fact is replaced). */
export async function fixFact(ws: string, id: string, text: string) {
  const b = bindingOf(ws);
  const p = await peer(b);
  const t = text.trim().slice(0, 1000);
  if (!t) throw new Error("Write the fact.");
  if (id.startsWith(CARD)) {
    const old = id.slice(CARD.length);
    await p.setCard(((await p.getCard()) ?? []).map((l) => (l === old ? t : l)));
    bankFor(b).card = undefined;
    categoriesDropped(b.bank, [id]);
    categoriesNudge(ws, "card");
    return;
  }
  await p.conclusions.delete(id);
  categoriesDropped(b.bank, [id]);
  await p.conclusions.create([{ content: t }]);
  categoriesNudge(ws, "learned");
}

/** Put a fact on the card ("About you"), which every bot sees with every message. The card holds 40 lines. */
export async function pinFact(ws: string, text: string) {
  const b = bindingOf(ws);
  const p = await peer(b);
  const lines = (await p.getCard()) ?? [];
  if (lines.includes(text)) return;
  if (lines.length >= 40) throw new Error("About you is full (40 lines). Remove one first.");
  await p.setCard([...lines, text.trim().slice(0, 300)]);
  bankFor(b).card = undefined;
  categoriesNudge(ws, "card");
}

/** Delete a fact or a card line. */
export const forgetFact = (ws: string, id: string) => forget(bindingOf(ws), id);

/*
 * For the categories (memory-categories.ts), which sort what's in memory into People, Tasks,
 * Events and the rest. Loaded when first needed: it imports this module.
 */
function categoriesNudge(ws: string, why: "chat" | "saved" | "learned" | "card") {
  void import("./memory-categories").then((m) => m.nudge(ws, why)).catch(() => {});
}

/** Facts deleted from memory here (Delete, Undo, Fix, the review's Delete all): out of the categories at once. */
function categoriesDropped(bank: string, ids: string[]) {
  if (ids.length) void import("./memory-categories").then((m) => m.dropFacts(bank, ids)).catch(() => {});
}

/** Of these fact ids, the ones still in memory, with the session each was learned in (free: listed by id, 100 a call). */
export async function existingFacts(ws: string, ids: string[]) {
  if (!ids.length) return new Map<string, string | null>();
  const got = await (await peer(bindingOf(ws))).conclusions.getMany(ids);
  return new Map(got.map((c) => [c.id, c.sessionId] as [string, string | null]));
}

/** These facts as the categories read them (the ones still in memory). */
export async function factsByIds(ws: string, ids: string[]): Promise<FactRow[]> {
  if (!ids.length) return [];
  const got = await (await peer(bindingOf(ws))).conclusions.getMany(ids);
  return got.map(rowOf);
}

const rowOf = (c: { id: string; content: string; createdAt: string; sessionId: string | null; level?: string; sourceIds?: string[] | null }): FactRow => ({
  id: c.id,
  text: c.content,
  at: Date.parse(c.createdAt) || 0,
  session: c.sessionId,
  level: c.level ?? "explicit",
  ...(c.sourceIds?.length ? { from: c.sourceIds } : {}),
});

/** A session by its id, without asking memory for it (or making it). */
export const sessionRef = (client: Honcho, id: string) => new HonchoSessionRef(id, client.workspaceId, client.http);

const notFound = (e: unknown) => (e as { status?: number }).status === 404;

/**
 * Remove from memory for good (Orbit's Forget and Delete everywhere): facts, the card lines `cardLine`
 * picks, and whole sessions (a chat's or a call's copy in memory, all its messages). In the bank's queue,
 * with learn and the other forgets; the card written once. Then checked with memory itself: what's still
 * there (a delete that failed, or one memory didn't apply) is returned, to be tried again. Gone already is fine.
 */
export function purgeMemory(
  ws: string,
  what: { facts: string[]; cardLine?: (line: string) => boolean; sessions: string[] },
  /** Another bank than the workspace's now (one it used before: what was still to delete there). */
  on?: Binding,
): Promise<{ facts: string[]; card: boolean; sessions: string[] }> {
  const b = on ?? bindingOf(ws);
  const x = bankFor(b);
  const run = x.queue.then(async () => {
    const p = await peer(b);
    const failed = { facts: new Set<string>(), sessions: new Set<string>(), card: false };
    for (const id of what.facts) {
      try {
        await p.conclusions.delete(id);
      } catch (e) {
        if (!notFound(e)) failed.facts.add(id);
      }
      x.recent = x.recent.filter((r) => r.id !== id);
    }
    if (what.cardLine) {
      try {
        const lines = (await p.getCard()) ?? [];
        if (lines.some(what.cardLine)) await p.setCard(lines.filter((l) => !what.cardLine!(l)));
      } catch {
        failed.card = true;
      }
      x.card = undefined;
    }
    for (const id of what.sessions) {
      try {
        // By id, not get-or-create: one that's gone already isn't made again to be deleted.
        await sessionRef(x.client, id).delete();
      } catch (e) {
        if (!notFound(e)) failed.sessions.add(id);
      }
      // Saved again later, it's made anew.
      x.sessions.delete(id);
    }
    // What memory still has, asked by id: a delete it answered but didn't apply is tried again too.
    const asked = what.facts.filter((id) => !failed.facts.has(id));
    const still = asked.length ? await p.conclusions.getMany(asked).catch(() => asked.map((id) => ({ id }))) : [];
    for (const c of still) failed.facts.add(c.id);
    if (what.cardLine && !failed.card) failed.card = ((await p.getCard().catch(() => null)) ?? []).some(what.cardLine);
    const gone = new Set(what.facts.filter((id) => !failed.facts.has(id)));
    categoriesDropped(b.bank, [...gone]);
    // Nothing keeps their words: the memory review's flags go too.
    if (gone.size && reviews()[b.bank])
      setReview(b.bank, (r) => {
        r.flagged = r.flagged.filter((f) => !gone.has(f.id));
        r.kept = r.kept.filter((id) => !gone.has(id));
      });
    return { facts: [...failed.facts], card: failed.card, sessions: [...failed.sessions] };
  });
  x.queue = run.catch(() => {});
  return run;
}

/**
 * Delete facts and card lines from memory, for the categories' Forget: one after another in the bank's
 * queue (with learn and other forgets), and the card written once, so two at a time can't put a line back.
 * A fact already gone is fine.
 */
export function forgetFacts(ws: string, ids: string[]): Promise<void> {
  const b = bindingOf(ws);
  const x = bankFor(b);
  const run = x.queue.then(async () => {
    const p = await peer(b);
    for (const id of ids.filter((i) => !i.startsWith(CARD))) {
      try {
        await p.conclusions.delete(id);
      } catch (e) {
        if ((e as { status?: number }).status !== 404) throw e;
      }
      x.recent = x.recent.filter((r) => r.id !== id);
    }
    const lines = ids.filter((i) => i.startsWith(CARD)).map((i) => i.slice(CARD.length));
    if (lines.length) {
      const card = (await p.getCard()) ?? [];
      if (card.some((l) => lines.includes(l))) await p.setCard(card.filter((l) => !lines.includes(l)));
      x.card = undefined;
    }
  });
  x.queue = run.catch(() => {});
  return run;
}

/** A fact in memory as the categories read it. */
export type FactRow = { id: string; text: string; at: number; session: string | null; level: string; /** The facts it was worked out from (memory's dreaming). */ from?: string[] };

/**
 * The newest facts in a workspace's memory, newest first, up to `max` (listing is free; 100 a page).
 * `enough` can stop it early after a page: when everything on it was seen before, say.
 */
export async function scanFacts(ws: string, max: number, enough?: (page: FactRow[]) => boolean): Promise<{ rows: FactRow[]; total: number }> {
  const p = await peer(bindingOf(ws));
  const out: FactRow[] = [];
  let page: Awaited<ReturnType<typeof p.conclusions.list>> | null = await p.conclusions.list({ size: 100 });
  const total = page.total;
  while (page) {
    const rows = page.items.map(rowOf);
    out.push(...rows);
    if (out.length >= max || !rows.length || enough?.(rows)) break;
    page = page.hasNextPage ? await page.getNextPage() : null;
  }
  return { rows: out.slice(0, max), total };
}

/** The user's card (who they are, their people, their rules), as memory keeps it now. */
export async function cardOf(ws: string) {
  return card(bindingOf(ws));
}

/**
 * A workspace's bank as Knowledge's issues use it (orbit-issues.ts): the Honcho client, the user's peer id,
 * and a bot's peer (made once, never modelled). Null with memory off. Who's speaking is a bot's id, or
 * undefined for the owner (the bank's own peer): never a word that stands for them ("owner"), which a bot
 * from before may have as its id.
 */
export function bankClient(ws: string) {
  if (!on()) return null;
  const b = bindingOf(ws);
  const x = bankFor(b);
  const who = (botId: string | undefined) => botId ?? OWNER_WHO;
  return { client: x.client, bank: b.bank, owner: b.peer, peerId: (botId: string | undefined) => peerId(b, who(botId)), peer: (botId: string | undefined) => peer(b, who(botId)), forget: (id: string) => x.sessions.delete(id) };
}

/** Which bank (Honcho workspace) a workspace's memory is in: workspaces can share one. */
export const bankOf = (ws: string) => bindingOf(ws).bank;

/** Where a fact was learned, in words. */
export const factSource = (sessionId: string | null) => sourceOf(sessionId);

/** Of these lines, the ones memory keeps out of prompts (an address, a phone number, health). */
export async function privateLines(lines: string[]) {
  const ok = new Set(await shareable(lines));
  return new Set(lines.filter((l) => !ok.has(l)));
}

/**
 * Ask memory to tidy up now (Honcho's "dreaming"): it works out what follows from what it has
 * learned, drops what's out of date, and rewrites the user's card. It runs in the background on
 * Honcho's side, and on its own every so often; this only asks for it now.
 */
export async function dream(ws: string) {
  if (!on()) throw new Error("Memory isn't set up.");
  const b = bindingOf(ws);
  const x = bankFor(b);
  await peer(b);
  await x.client.scheduleDream({ observer: b.peer, observed: b.peer });
  x.card = undefined;
}

/* ---------------- A deleted workspace's memory ---------------- */

/**
 * What of a workspace's memory goes when it's deleted (remove.ts deleteWorkspace, and the confirm's list):
 * the bank it uses whole (every session, message and fact in it) when no other workspace uses that bank
 * (its own, or one it shared from a workspace deleted since); otherwise (`whole` false) only its Orbit
 * issues' sessions there. Never the user's own bank (the default's, maybe their other agents' too), nor
 * one Bops didn't name (bops-<workspace>). Null with memory off, and for the default workspace. Asked
 * while the workspace is still listed: its binding is read from it.
 */
export function memoryGoesWith(ws: string): { binding: Binding; whole: boolean } | null {
  if (!on() || ws === MAIN_WORKSPACE) return null;
  const binding = bindingOf(ws);
  const others = [MAIN_WORKSPACE, ...(getState().workspaces ?? []).map((w) => w.id)].filter((x) => x !== ws);
  const shared = others.some((x) => bindingOf(x).bank === binding.bank);
  const bops = binding.bank.startsWith("bops-") && binding.bank !== ownBank(MAIN_WORKSPACE).bank;
  return { binding, whole: bops && !shared };
}

/** Whether a workspace listed now uses this bank, or it's the user's own (the default's, never deleted whole). */
export const bankInUse = (bank: string) => bank === ownBank(MAIN_WORKSPACE).bank || [MAIN_WORKSPACE, ...(getState().workspaces ?? []).map((w) => w.id)].some((x) => bindingOf(x).bank === bank);

/** At most this many sessions are deleted one by one when memory won't delete a bank that still has them. */
const BANK_SESSIONS_MAX = 5000;

/**
 * Delete a bank from memory for good (a deleted workspace's own: memory-deletes.ts): every session,
 * message and fact in it. Memory refusing it while it still has sessions (409) has them deleted first, by
 * id, and is asked again. Gone already is fine. Its review on this Mac goes too, and its client here, so
 * nothing uses (or makes again) the bank. Throws what memory answered otherwise, to be tried again.
 */
export async function deleteBank(b: Binding): Promise<void> {
  const x = bankFor(b);
  const id = x.client.workspaceId;
  const gone = async () => {
    try {
      await x.client.deleteWorkspace(id);
    } catch (e) {
      if (!notFound(e)) throw e;
    }
  };
  try {
    await gone();
  } catch (e) {
    if ((e as { status?: number }).status !== 409) throw e;
    // Listed first, then deleted: deleting while paging would skip some.
    const ids: string[] = [];
    for await (const s of await x.client.sessions({ size: 100 })) {
      ids.push(s.id);
      if (ids.length >= BANK_SESSIONS_MAX) break;
    }
    for (const sid of ids)
      try {
        await sessionRef(x.client, sid).delete();
      } catch (err) {
        if (!notFound(err)) throw err;
      }
    await gone();
  }
  live.banks.delete(id);
  const all = reviews();
  if (all[b.bank]) {
    delete all[b.bank];
    const file = reviewsFile();
    if (file) {
      mkdirSync(dirname(file), { recursive: true });
      writeFileSync(file, JSON.stringify(all));
    }
  }
}
