import { config } from "./config.ts";
import { honchoPrefix } from "./session.ts";
import { recordUsage } from "./usage.ts";

/**
 * Long-term memory for a turn the cloud answers itself (cloud/agent.ts), from Honcho over its REST API
 * with the cloud's own key: the same bank the user's bots use on their Mac for that bot's workspace
 * (lib/server/memory.ts bindingOf), always under the user's own prefix (`u-<user>-bops`), so a turn
 * can only ever reach the user's own memory.
 *
 * - Before the turn (memoryBlock): what's known about the user, their card and what Honcho learned that
 *   matters for what they just said, in one read within 2.5 s, or nothing. Lines that look private
 *   (an address, a phone number, a key, a birth date, health) are left out by the Mac's patterns only:
 *   the Mac's second check (Jev) isn't here.
 * - After it (saveChat): the user's message and the answer go into the chat's session
 *   (bops-chat-bot-<id>, as the Mac names it), so Honcho keeps learning, without waiting. Not when the
 *   user asks to keep it from someone ("don't tell Sam"): the memory is shared by the whole team. The
 *   Mac's auto-remember of a lasting fact ("Remembered: …") isn't here.
 * - Counted as the proxy counts Honcho (honcho.calls): messages saved, by route. Reads aren't.
 * Memory never holds up or fails a turn: anything that goes wrong is one log line with its status.
 */

/** A Bops workspace's bank (a Honcho workspace) and the user's peer in it (lib/server/memory.ts Binding). */
export type Binding = { bank: string; peer: string };

/** Honcho ids allow letters, digits, _ and -. */
const clean = (s: string) => s.replace(/[^A-Za-z0-9_-]/g, "-").slice(0, 200);
const ID = /^[A-Za-z0-9_-]{1,200}$/;

/** The bank a workspace's memory lives in, as the Mac picks it: its own binding, else the default workspace's "bops", else bops-<workspace>. */
export function bindingFor(workspaceId: string, own: unknown): Binding {
  const b = own as Partial<Binding> | null | undefined;
  if (b && typeof b.bank === "string" && typeof b.peer === "string") return { bank: b.bank, peer: b.peer };
  return workspaceId === "ws_main" ? { bank: "bops", peer: "user" } : { bank: `bops-${clean(workspaceId)}`, peer: "user" };
}

/** The Honcho workspace of a bank, under the user's prefix; null for a binding that isn't made of Honcho ids. */
function workspaceOf(userId: string, b: Binding): string | null {
  return ID.test(b.bank) && ID.test(b.peer) ? `${honchoPrefix(userId)}-${b.bank}` : null;
}

class HonchoError extends Error {}

async function honcho(method: "GET" | "POST", path: string, opts: { body?: unknown; query?: Record<string, string>; timeoutMs?: number } = {}): Promise<unknown> {
  const url = new URL(`${config.upstream.honcho().replace(/\/+$/, "")}${path}`);
  for (const [k, v] of Object.entries(opts.query ?? {})) url.searchParams.set(k, v);
  const res = await fetch(url, {
    method,
    headers: { authorization: `Bearer ${config.honchoKey()}`, accept: "application/json", ...(opts.body === undefined ? {} : { "content-type": "application/json" }) },
    body: opts.body === undefined ? undefined : JSON.stringify(opts.body),
    signal: AbortSignal.timeout(opts.timeoutMs ?? 10_000),
  });
  if (!res.ok) throw new HonchoError(`Honcho answered ${res.status}`);
  const text = await res.text();
  return text ? (JSON.parse(text) as unknown) : null;
}

/** What went wrong, for the log: Honcho's status, or the kind of failure. Never what was asked or said. */
const why = (e: unknown) => (e instanceof HonchoError ? e.message : ((e as Error)?.name ?? "error"));

const enc = encodeURIComponent;
const base = (ws: string) => `/v3/workspaces/${enc(ws)}`;

/**
 * Lines kept out of prompts: home and family addresses, phone numbers, keys, birth date, account
 * numbers, health (lib/server/memory.ts PRIVATE, the patterns only).
 */
const PRIVATE = [
  /\b(?:address|resides?|phone|hex key|public key|private key|birth\s?date|born|passport|ssn|social security|password)\b/i,
  /\b\d{2,6}\s+(?:[NSEW]\.?\s+)?[A-Za-z][\w.]*(?:\s+[A-Za-z][\w.]*)*\s+(?:St|Street|Rd|Road|Ave|Avenue|Ln|Lane|Blvd|Dr|Drive|Way|Ct|Court|Pl|Place)\b/i,
  /\+?\d[\d\s().-]{8,}\d/,
  /\b[0-9a-f]{32,}\b|\bnpub1\w+/i,
];
const shareable = (line: string) => !PRIVATE.some((re) => re.test(line));

/** Asking to keep something from someone ("don't tell Sam yet", "keep this between us"): lib/server/memory.ts SECRET. */
const SECRET = /\b(don'?t|do not|never) (tell|share|mention|let)\b|\bkeep (it|this|that)? ?(from|between|private|quiet)|\bbetween (us|you and me)\b|\b(this is|it's|that's) private\b|\boff the record\b/i;
/** Whether the user asks for this to be kept from someone. An iPhone's keyboard types curly apostrophes ("Don’t"), read as straight ones. */
export const keptFromOthers = (text: string) => SECRET.test(text.replace(/[‘’]/g, "'"));

/**
 * What the bot should know about the user for what they just said (`about`), as the Mac's memoryBlock
 * writes it; "" when memory is off, empty, slow (past `ms`) or failing.
 */
export async function memoryBlock(userId: string, b: Binding, about: string, owner: string, ms = 2500): Promise<string> {
  const ws = workspaceOf(userId, b);
  if (!config.honchoKey() || !ws) return "";
  try {
    const ctx = (await honcho("GET", `${base(ws)}/peers/${enc(b.peer)}/context`, {
      query: { search_query: (about.trim() || owner).slice(0, 400), search_top_k: "10", max_conclusions: "12", include_most_frequent: "false" },
      timeoutMs: ms,
    })) as { representation?: unknown; peer_card?: unknown } | null;
    const card = (Array.isArray(ctx?.peer_card) ? ctx.peer_card : []).filter((l): l is string => typeof l === "string").map((l) => l.trim()).filter(Boolean);
    const learned = String(ctx?.representation ?? "")
      .split("\n")
      .map((l) => l.replace(/^\[[^\]]+\]\s*/, "").trim())
      .filter((l) => l && !l.startsWith("#"))
      .slice(0, 16);
    const lines = card.filter(shareable);
    const recent = learned.filter(shareable).slice(0, 12);
    if (!lines.length && !recent.length) return "";
    return [
      `What you know about ${owner}, from their long-term memory. Use it so they don't have to repeat themselves; it can be out of date or wrong, and what they say now wins. Don't recite it back to them.`,
      ...(lines.length ? [`About ${owner}:`, ...lines.map((l) => `- ${l}`)] : []),
      ...(recent.length ? ["Learned before, relevant now:", ...recent.map((l) => `- ${l}`)] : []),
    ].join("\n");
  } catch (e) {
    console.warn(`[honcho] ${userId}: memory not read for this turn (${why(e)})`);
    return "";
  }
}

/** Sessions (and their workspace and peers) made in this process, so later turns only add their messages. */
const ready = new Map<string, Promise<void>>();

/** The workspace, both peers and the session with them in it, made once (Honcho makes each only if it isn't there). */
function sessionReady(ws: string, sid: string, owner: string, botPeer: string, bot: { name: string; role: string }, chatName: string) {
  const key = `${ws} ${sid}`;
  let p = ready.get(key);
  if (!p) {
    p = (async () => {
      await honcho("POST", "/v3/workspaces", { body: { id: ws } });
      await honcho("POST", `${base(ws)}/peers`, { body: { id: owner } });
      // Bots aren't worth modelling; the user is the one Honcho learns about.
      await honcho("POST", `${base(ws)}/peers`, { body: { id: botPeer, metadata: { app: "bops", name: bot.name, role: bot.role }, configuration: { observe_me: false } } });
      await honcho("POST", `${base(ws)}/sessions`, { body: { id: sid, metadata: { app: "bops", kind: "chat", chat: chatName } } });
      await honcho("POST", `${base(ws)}/sessions/${enc(sid)}/peers`, { body: { [owner]: { observe_me: true }, [botPeer]: { observe_me: false } } });
    })();
    p.catch(() => ready.delete(key));
    if (ready.size > 10_000) ready.clear();
    ready.set(key, p);
  }
  return p;
}

/**
 * The user's message and the bot's answer, into the chat's session in the bot's workspace's bank, as
 * the Mac saves a chat (saveToMemory). Fire and forget. Nothing when memory is off.
 */
export function saveChat(userId: string, b: Binding, chat: { id: string; name: string }, bot: { id: string; name: string; role: string }, said: string, answer: string): void {
  const ws = workspaceOf(userId, b);
  if (!config.honchoKey() || !ws) return;
  const sid = `bops-chat-${clean(chat.id)}`;
  const botPeer = `bops-${clean(bot.id)}`;
  const messages = [
    { peer_id: b.peer, content: said.slice(0, 8000), metadata: { app: "bops", kind: "chat" } },
    { peer_id: botPeer, content: answer.slice(0, 8000), metadata: { app: "bops", kind: "chat" } },
  ].filter((m) => m.content.trim());
  if (!messages.length) return;
  void (async () => {
    await sessionReady(ws, sid, b.peer, botPeer, bot, chat.name);
    await honcho("POST", `${base(ws)}/sessions/${enc(sid)}/messages`, { body: { messages } });
    await recordUsage(userId, "honcho.calls", 1, { route: "messages", botId: bot.id });
  })().catch((e) => console.warn(`[honcho] ${userId}: the chat wasn't saved to memory (${why(e)})`));
}
