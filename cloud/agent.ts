import { randomUUID } from "node:crypto";
import { trackCloudEvent } from "./analytics.ts";
import {
  agentView,
  chatIdOf,
  DEFAULT_BOT,
  HISTORY,
  HISTORY_STEP,
  historyInput,
  instructionsFor,
  MAIN_PICTURE,
  mainBotOf,
  nowNote,
  ownerNameOf,
  timeZoneOf,
  windowSize,
  workspaceOf,
  type InputItem,
} from "./agent-prompt.ts";
import { config } from "./config.ts";
import { requireCredit } from "./credit.ts";
import { query } from "./db.ts";
import { bindingFor, keptFromOthers, memoryBlock, saveChat } from "./honcho.ts";
import { HttpError, readJson, sendJson, type Route } from "./http.ts";
import {
  AGENT_BUSY,
  AGENT_CHANGED,
  AGENT_MAX_TEXT,
  AGENT_SENDS_A_MINUTE,
  AI_CREDIT_EMPTY,
  SLOW_DOWN,
  TIMEZONE_HEADER,
  type AgentAccepted,
  type AgentAnswered,
  type AgentInfo,
  type PhoneMessage,
  type PhoneMessagesPage,
  type PhoneRemoved,
} from "./protocol.ts";
import { answerTo, chatPage, chatSaid, checkUser, loadState, messagesById, newestSeq, rowsAfter, sendZipped, writeMessages, type MessageRow } from "./state.ts";
import { tidyAnswer } from "./style.ts";
import { recordTokens } from "./usage.ts";

/**
 * The main bot's chat from the phone (Bops for iPhone; README "The main bot's chat from the phone").
 * Owner: edge builder.
 *
 * Bops Cloud answers every message sent from the phone itself, so each one has exactly one answerer:
 * the user's Mac never answers a message it reads from the cloud (only its own chat, calls, texts and
 * channels start a turn there), so nothing is answered twice and no Mac release is needed. It answers
 * whenever the phone has a connection, whether the Mac is awake, asleep, closed, on an old build or
 * not there at all; a user who never used Bops on a Mac gets Boppy, as a new Mac install makes it.
 *
 * - GET /v1/agent: the main bot and its chat. GET /v1/agent/messages: that chat, as the phone shows it
 *   (phoneMessage). POST /v1/agent/messages: the user's message, written into the main bot's chat
 *   (bot:<id>, bops.chat_messages) so their Mac shows it and reads it as history, answered by a turn
 *   here that writes the bot's answer the same way.
 * - A turn is one OpenAI Responses call with no tools (cloud/agent-prompt.ts says what it's told and
 *   what it can't do from the phone), paid from the user's AI credit and counted for the main bot
 *   (openai.tokens, source "iphone"). It runs on after the request, so it finishes if the phone goes
 *   away; the phone polls for the answer. One turn at a time per user, in this process's memory: a
 *   restart mid-turn loses it, and the phone offers Try again (the same message id).
 * - The phone only makes short requests: never /v1/session, /v1/connect (the Mac's tunnel, one per
 *   user: server.ts refuses a phone's socket), PUT /v1/state or POST /v1/messages.
 */

/** Tests shorten these. */
export const timing = {
  /** The longest a turn waits for OpenAI. */
  openaiMs: 60_000,
  /** The longest a turn waits for memory before going on without it. */
  memoryMs: 2_500,
  /** A turn held longer than this can't still be running (its waits are all shorter): it no longer keeps the user's next one out. */
  staleMs: 3 * 60_000,
};

/** The model the main bot answers with from the phone: the Mac's chat model, thinking lightly. */
const MODEL = () => process.env.BOPS_AGENT_MODEL?.trim() || "gpt-6.1-sol";
const MAX_OUTPUT_TOKENS = 2000;

const PHONE_ID = /^msg_ios_[A-Za-z0-9_-]{1,192}$/;
const CHAT = /^bot:.{1,200}$/;

/* ---------------- One turn at a time per user ---------------- */

type Turn = { messageId: string; startedAt: number };
const turns = new Map<string, Turn>();

/** Whether a turn is answering one of the user's messages now. */
export function working(userId: string): boolean {
  const t = turns.get(userId);
  if (t && Date.now() - t.startedAt > timing.staleMs) turns.delete(userId);
  return turns.has(userId);
}

/** Hold the user's one turn, or null when one is running. Synchronous, so two sends at once can't both get it. */
function hold(userId: string, messageId: string): Turn | null {
  if (working(userId)) return null;
  const t = { messageId, startedAt: Date.now() };
  turns.set(userId, t);
  return t;
}

const letGo = (userId: string, t: Turn) => {
  if (turns.get(userId) === t) turns.delete(userId);
};

/* ---------------- Limits ---------------- */

const MINUTE = 60_000;

/** One more send in this minute's count (bops.cloud_limits, shared by every cloud process), or a 429 past AGENT_SENDS_A_MINUTE. */
async function countSend(userId: string) {
  const windowStart = Math.floor(Date.now() / MINUTE) * MINUTE;
  const r = await query(
    `INSERT INTO bops.cloud_limits (key, window_start, count) VALUES ($1, to_timestamp($2::float8 / 1000), 1)
     ON CONFLICT (key, window_start) DO UPDATE SET count = cloud_limits.count + 1 WHERE cloud_limits.count < $3
     RETURNING count`,
    [`agent:send:${userId}`, windowStart, AGENT_SENDS_A_MINUTE],
  );
  sweepLimits();
  if (r.rowCount) return;
  throw new HttpError(429, "You're sending messages too fast. Wait a moment, then try again.", { code: SLOW_DOWN, retryAfter: Math.ceil((windowStart + MINUTE - Date.now()) / 1000) });
}

/** Old counts, cleared now and then (every cloud process does it, at most every 10 minutes). */
let sweptAt = 0;
function sweepLimits() {
  if (Date.now() - sweptAt < 10 * MINUTE) return;
  sweptAt = Date.now();
  void query("DELETE FROM bops.cloud_limits WHERE key LIKE 'agent:%' AND window_start < now() - interval '10 minutes'").catch((e: Error) => console.warn(`[agent] sweep: ${e.message}`));
}

/**
 * 402 when the user's AI credit is used up, before anything is written. In the phone's own shape: no
 * upgrade flag and no words about upgrading, since the phone offers no way to buy (it says it its way).
 */
async function needCredit(userId: string) {
  try {
    await requireCredit(userId);
  } catch (e) {
    if (e instanceof HttpError && e.status === 402) throw new HttpError(402, "You're out of AI credit.", { code: AI_CREDIT_EMPTY });
    throw e;
  }
}

/* ---------------- The chat as the phone shows it ---------------- */

const VIA: Record<string, PhoneMessage["via"]> = { sms: "text", slack: "slack", telegram: "telegram", discord: "discord" };
const textOf = (x: unknown) => (typeof x === "string" ? x : "");
const isObject = (x: unknown): x is Record<string, unknown> => !!x && typeof x === "object" && !Array.isArray(x);
const strings = (x: unknown) => (Array.isArray(x) ? x.filter((v): v is string => typeof v === "string" && !!v.trim()) : []);
/** One line, at most `max` characters. */
const line = (t: string, max: number) => {
  const one = t.replace(/\s+/g, " ").trim();
  return one.length > max ? `${one.slice(0, max)}…` : one;
};

/**
 * A row of the chat as the phone shows it (PhoneMessage), never the row itself: what the user and the
 * bot said, a short note for anything else worth seeing (a call, another person's email or text, a
 * fact remembered), and nothing for the rest (an app's answer, the app's own lines). Pictures are
 * counted, not sent. Null for a row the phone doesn't show.
 */
export function phoneMessage(r: MessageRow): PhoneMessage | PhoneRemoved | null {
  if (!r.json) return { id: r.id, seq: r.seq, removed: true };
  const m = r.json;
  const base = { id: r.id, seq: r.seq, at: typeof m.at === "number" && Number.isFinite(m.at) ? Math.floor(m.at) : r.at };
  const text = textOf(m.text);
  const photos = Array.isArray(m.images) ? m.images.length : 0;
  const note = (said: string): PhoneMessage => ({ ...base, role: "note", text: said });
  // A call's note has its caller's number as a text's too: it's the call.
  if (isObject(m.call)) {
    const seconds = Number(m.call.seconds) || 0;
    return note(seconds < 60 ? "Call, under a minute" : `Call, ${Math.round(seconds / 60)} min`);
  }
  if (isObject(m.email)) {
    const e = m.email;
    if (e.dir === "in" && e.fromOwner === true) return { ...base, role: "user", text, via: "email", ...(photos ? { photos } : {}) };
    const subject = line(textOf(e.subject), 200) || "(no subject)";
    return note(e.dir === "in" ? `Email from ${line(textOf(e.from), 200)}: ${subject}` : `Emailed ${strings(e.to).join(", ")}: ${subject}`);
  }
  // Texts from or to other people (the user's own texts to the bot are theirs, with via "sms").
  if (isObject(m.sms)) return note(m.sms.dir === "in" ? `Text from ${line(textOf(m.sms.from), 120)}: ${line(text, 140)}` : `Texted ${line(textOf(m.sms.to), 120)}: ${line(text, 140)}`);
  if (m.role === "system") return isObject(m.memory) && m.memory.undone !== true && text.startsWith("Remembered:") ? note(text) : null;
  if (m.role !== "user" && m.role !== "bot") return null;
  if (!text.trim() && !photos) return null;
  const via = typeof m.via === "string" ? VIA[m.via] : undefined;
  const options = m.role === "bot" ? strings(m.options).slice(0, 4) : [];
  return {
    ...base,
    role: m.role,
    text,
    ...(m.role === "bot" && typeof m.botId === "string" ? { botId: m.botId } : {}),
    ...(via ? { via } : {}),
    ...(options.length ? { options } : {}),
    ...(photos ? { photos } : {}),
    ...(typeof m.resultOf === "string" && m.resultOf ? { taskId: m.resultOf } : {}),
    ...(typeof m.answers === "string" && m.answers ? { answers: m.answers } : {}),
  };
}

const shown = (rows: MessageRow[]) => rows.map(phoneMessage).filter((m): m is PhoneMessage | PhoneRemoved => m !== null);
/** A user or bot message as the phone shows it (always shown: it has text). */
const shownOne = (r: MessageRow) => phoneMessage(r) as PhoneMessage;

/* ---------------- Routes ---------------- */

const userOf = (u: Parameters<Route["handle"]>[2]["user"]) => u!;

/** A whole number from the query, from `min` to `max`: `fallback` when it isn't there (none: it must be), else a 400 naming it. */
function whole(url: URL, name: string, min: number, fallback: number | null, max = Number.MAX_SAFE_INTEGER): number {
  const raw = url.searchParams.get(name);
  const n = raw === null || raw === "" ? fallback : Number(raw);
  if (n === null || !Number.isSafeInteger(n) || n < min || n > max) throw new HttpError(400, `${name} must be a whole number from ${min}${max < Number.MAX_SAFE_INTEGER ? ` to ${max}` : ""}`);
  return n;
}

const info: Route = {
  method: "GET",
  path: "/v1/agent",
  auth: "user",
  handle: async (req, res, ctx) => {
    const user = userOf(ctx.user);
    checkUser(req, user, true);
    const v = agentView((await loadState(user.id))?.state);
    const { bot, isDefault } = mainBotOf(v);
    const publicUrl = config.publicUrl();
    const body: AgentInfo = {
      bot: { id: bot.id, name: bot.name, role: bot.role, color: bot.color, picture: publicUrl ? `${publicUrl}/mascot/${MAIN_PICTURE}.png` : null },
      chatId: chatIdOf(bot.id),
      owner: { name: ownerNameOf(v, user.name) },
      isDefault,
      seq: await newestSeq(user.id),
      working: working(user.id),
    };
    sendJson(res, 200, body);
  },
};

const messages: Route = {
  method: "GET",
  path: "/v1/agent/messages",
  auth: "user",
  handle: async (req, res, { user: u, url }) => {
    const user = userOf(u);
    checkUser(req, user, true);
    const chatId = url.searchParams.get("chatId") ?? "";
    if (!CHAT.test(chatId)) throw new HttpError(400, "Name the chat (chatId, bot:<id>)");
    const hasAfter = url.searchParams.has("afterSeq");
    const hasBefore = url.searchParams.has("beforeAt");
    if (hasAfter && hasBefore) throw new HttpError(400, "Ask with afterSeq or beforeAt, not both");
    // Read before the rows: a turn writes its answer before it ends, so an answer that says it's done has the reply.
    const busy = working(user.id);
    let body: PhoneMessagesPage;
    if (hasAfter) {
      const after = whole(url, "afterSeq", 0, null);
      const page = await rowsAfter(user.id, after, whole(url, "limit", 1, 200, 500));
      body = { messages: shown(page.rows.filter((r) => r.chatId === chatId)), seq: page.seq, more: page.more, working: busy };
    } else if (hasBefore) {
      const page = await chatPage(user.id, chatId, whole(url, "beforeAt", 1, null), whole(url, "limit", 1, 50, 100));
      body = { messages: shown(page.rows), seq: 0, more: page.more, working: busy };
    } else {
      // The cursor first: a message written meanwhile comes again on the next poll, never goes missing.
      const seq = await newestSeq(user.id);
      const page = await chatPage(user.id, chatId, null, whole(url, "limit", 1, 50, 100));
      body = { messages: shown(page.rows), seq, more: page.more, working: busy };
    }
    await sendZipped(req, res, 200, body);
  },
};

type SendBody = { id?: unknown; chatId?: unknown; text?: unknown };

const send: Route = {
  method: "POST",
  path: "/v1/agent/messages",
  auth: "user",
  handle: async (req, res, ctx) => {
    const user = userOf(ctx.user);
    checkUser(req, user, true);
    const body = await readJson<SendBody | null>(req, 64 * 1024);
    const id = typeof body?.id === "string" ? body.id : "";
    const chatId = typeof body?.chatId === "string" ? body.chatId : "";
    const text = typeof body?.text === "string" ? body.text.trim() : "";
    if (!PHONE_ID.test(id)) throw new HttpError(400, "Each message needs its own id (msg_ios_…)");
    if (!CHAT.test(chatId)) throw new HttpError(400, "Name the chat (chatId, bot:<id>)");
    if (!text) throw new HttpError(400, "Write a message first");
    if ([...text].length > AGENT_MAX_TEXT) throw new HttpError(413, `A message can be up to ${AGENT_MAX_TEXT} characters`);

    // Sent before (a retry): its answer, if it has one, whatever else is going on.
    const [before] = await messagesById(user.id, [id]);
    if (before && (before.json?.role !== "user" || before.chatId !== chatId)) throw new HttpError(400, "That message id is taken");
    const answered = before ? await answerTo(user.id, id) : null;
    if (before && answered) return sendJson(res, 200, { message: shownOne(before), reply: shownOne(answered) } satisfies AgentAnswered);

    const v = agentView((await loadState(user.id))?.state);
    const { bot } = mainBotOf(v);
    if (chatId !== chatIdOf(bot.id)) throw new HttpError(409, `${bot.name} isn't this chat's bot any more. Load the chat again.`, { code: AGENT_CHANGED });
    if (!config.openaiKey()) throw new HttpError(503, `${bot.name} can't answer from here right now`);
    const t = hold(user.id, id);
    if (!t) throw new HttpError(409, `${bot.name} is answering another message. Try again in a moment.`, { code: AGENT_BUSY });
    try {
      // A turn that held this message may have answered it just now: answered once, never twice.
      const late = before ? await answerTo(user.id, id) : null;
      if (before && late) {
        letGo(user.id, t);
        return sendJson(res, 200, { message: shownOne(before), reply: shownOne(late) } satisfies AgentAnswered);
      }
      await countSend(user.id);
      await needCredit(user.id);
      let message = before;
      if (!message) {
        // `sentFrom` and, on the answer, `answers` are the cloud's: the Mac keeps them and reads neither.
        await writeMessages(user.id, [{ id, chatId, role: "user", text, at: Date.now(), sentFrom: "iphone" }]);
        [message] = await messagesById(user.id, [id]);
        if (!message) throw new Error("the message wasn't written");
        trackCloudEvent(user.id, "bops_message_sent", { chat_kind: "bot", via: "iphone", image_count: 0, is_reply: false });
      }
      sendJson(res, 202, { message: shownOne(message), working: true } satisfies AgentAccepted);
      const header = req.headers[TIMEZONE_HEADER];
      void answer(t, { userId: user.id, orgoName: user.name ?? null, chatId, message: { id, text: textOf(message.json?.text), at: message.at }, tz: timeZoneOf(Array.isArray(header) ? header[0] : header) });
    } catch (e) {
      letGo(user.id, t);
      throw e;
    }
  },
};

export const routes: Route[] = [info, messages, send];

/* ---------------- The turn ---------------- */

type TurnFor = { userId: string; orgoName: string | null; chatId: string; message: { id: string; text: string; at: number }; tz: string };
type Answer = { id: string | null; model: unknown; usage: unknown; text: string };

/** What went wrong, for the log: a status, or the kind of failure. Never what was said. */
class TurnError extends Error {}
const why = (e: unknown) => (e instanceof TurnError ? e.message : ((e as Error)?.name ?? "error"));

/** One Responses call: the answer's text, and what it used (counted by the caller). */
async function respond(instructions: string, input: InputItem[]): Promise<Answer> {
  let res: Response;
  try {
    res = await fetch(`${config.upstream.openai()}/v1/responses`, {
      method: "POST",
      headers: { Authorization: `Bearer ${config.openaiKey()}`, "Content-Type": "application/json" },
      body: JSON.stringify({ model: MODEL(), instructions, input, reasoning: { effort: "low" }, max_output_tokens: MAX_OUTPUT_TOKENS, store: false }),
      signal: AbortSignal.timeout(timing.openaiMs),
    });
  } catch (e) {
    throw new TurnError(`OpenAI couldn't be reached (${(e as Error)?.name ?? "error"})`);
  }
  if (!res.ok) throw new TurnError(`OpenAI answered ${res.status}`);
  const r = (await res.json().catch(() => null)) as { id?: unknown; model?: unknown; usage?: unknown; output?: unknown } | null;
  if (!r) throw new TurnError("OpenAI's answer wasn't JSON");
  const text = (Array.isArray(r.output) ? r.output : [])
    .filter((o) => isObject(o) && o.type === "message")
    .flatMap((o) => (Array.isArray(o.content) ? o.content : []))
    .filter((p) => isObject(p) && p.type === "output_text" && typeof p.text === "string")
    .map((p) => p.text as string)
    .join("");
  return { id: typeof r.id === "string" ? r.id : null, model: r.model, usage: r.usage, text };
}

/**
 * Answer the user's message as the chat's bot: read the chat and what's known, make one call, and
 * write the answer into the chat (the Mac told). On any failure nothing is written and the phone, which
 * sees the turn end without an answer, offers Try again. The turn lets go of the user only after its
 * answer is written, so a page that says it ended has the answer.
 */
async function answer(t: Turn, c: TurnFor) {
  try {
    const v = agentView((await loadState(c.userId))?.state);
    const botId = c.chatId.slice("bot:".length);
    const b = v.bots.find((x) => x.id === botId) ?? { ...DEFAULT_BOT, id: botId };
    const owner = ownerNameOf(v, c.orgoName) ?? "the user";
    const { rows, total } = await chatSaid(c.userId, c.chatId, HISTORY + HISTORY_STEP - 1);
    const window = rows.slice(Math.max(0, rows.length - windowSize(total))).flatMap((r) => (r.json ? [r.json] : []));
    // What an inline reply in the window quotes, when it's from before the window.
    const quoted = [...new Set(window.map((m) => m.replyTo).filter((x): x is string => typeof x === "string"))].filter((x) => !window.some((m) => m.id === x));
    const roots = new Map((await messagesById(c.userId, quoted)).flatMap((r) => (r.json ? [[r.id, r.json] as const] : [])));
    const binding = bindingFor(workspaceOf(b), v.workspaces.find((w) => w.id === workspaceOf(b))?.memory);
    const memory = await memoryBlock(c.userId, binding, c.message.text, owner, timing.memoryMs);
    const input = [...historyInput(window, roots, v, b.id, owner), nowNote(v, b, owner, c.tz, memory)];
    const a = await respond(instructionsFor(v, b, c.orgoName), input);
    try {
      const tidy = tidyAnswer(a.text);
      if (!tidy.text.trim()) throw new TurnError("OpenAI answered with no text");
      const reply = { id: `msg_cloud_${randomUUID()}`, chatId: c.chatId, role: "bot", botId: b.id, text: tidy.text, at: Math.max(Date.now(), c.message.at + 1), answers: c.message.id, ...(tidy.options ? { options: tidy.options } : {}) };
      await writeMessages(c.userId, [reply]);
      // Into the memory the bot's workspace shares, unless the user wants it kept from someone there.
      if (!keptFromOthers(c.message.text)) saveChat(c.userId, binding, { id: c.chatId, name: b.name }, b, c.message.text, tidy.text);
    } finally {
      // OpenAI charged for it whether or not the answer was written.
      if (a.id) await recordTokens(c.userId, a.id, a.usage, { model: a.model, source: "iphone", botId: b.id }).catch((e: Error) => console.warn(`[agent] ${c.userId}: usage: ${e.message}`));
    }
  } catch (e) {
    console.warn(`[agent] ${c.userId}: ${c.message.id} wasn't answered (${why(e)})`);
  } finally {
    letGo(c.userId, t);
  }
}
