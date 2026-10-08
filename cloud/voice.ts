import { and, botForAgent, skillsOf, view, type Bot, type State } from "./calls.ts";
import { config } from "./config.ts";
import { hasCredit } from "./credit.ts";
import type { CallerVerdict, CloudCallPayload } from "./protocol.ts";
import { loadState } from "./state.ts";
import { queueForMac } from "./tunnel.ts";
import { recordTokens } from "./usage.ts";

/**
 * A call's turns, answered in the cloud while the Mac is away (asleep, off, offline, or not answering
 * in time). Every Bops number's calls go to its AgentPhone agent in voice mode "webhook": AgentPhone
 * hears the caller and sends each turn to /hooks/agentphone (hooks.ts), and the text answered is
 * what it speaks. The Mac answers them when it's there (lib/server/phone-voice.ts); this is the
 * cloud's own answer. Owner: edge builder.
 *
 * - The owner (bops.phone_lines says so: lines.ts, never the uploaded state) gets their bot, from the
 *   last state upload: it says the computer it works on is offline, takes a note of anything they
 *   want done, and says goodbye. Its apps and where it's in Slack, Telegram and Discord are known,
 *   as on a GPT-Live call in the cloud (calls.ts frontPrompt).
 * - Anyone else gets a friendly bot that only chats and takes a message for the person it works for:
 *   it's told nothing about them, so it can't share anything.
 * - Each turn is one OpenAI Responses call (a fast model, low reasoning, two tools: take_message and
 *   end_call, each with the words to say), its tokens counted for the bot (recordTokens, source "phone").
 * - A call is grouped by AgentPhone's callId and ends on a hangup, on AgentPhone's call_ended event,
 *   after 2 minutes without a turn, or at 10 minutes. Then the Mac gets it as a "call" event (kept
 *   until it's back): the transcript, any message, whether it was the owner. Its seconds are counted
 *   by /hooks/agentphone for every call, whoever answers it (hooks.ts countCallSeconds).
 *   Calls live in this process's memory: a restart mid-call loses that call's record.
 */

/** Tests shorten these. */
export const timing = { idleMs: 2 * 60_000, maxCallMs: 10 * 60_000, openaiMs: 12_000 };
/** The model for a call's turns: quick, thinking lightly. */
const MODEL = () => process.env.BOPS_PHONE_MODEL?.trim() || "gpt-6.1-sol";
/** Past this many of a caller's turns, the bot says goodbye. */
const MAX_TURNS = 60;
const MAX_TRANSCRIPT = 20_000;

export type VoiceReply = { text: string; hangup?: boolean };
type Turn = { who: "Caller" | "Bot"; text: string };
type CallMessage = NonNullable<CloudCallPayload["message"]>;
type VoiceCall = {
  userId: string;
  callId: string;
  bot: { id: string; name: string };
  from: string;
  owner: boolean;
  claimed?: "call";
  /** The caller's phone just became the line's owner: the next answer says so (once). */
  justLinked?: boolean;
  startedAt: number;
  turns: Turn[];
  message?: CallMessage;
  timer?: ReturnType<typeof setTimeout>;
  ended: boolean;
};

const calls = new Map<string, VoiceCall>();
const keyOf = (userId: string, callId: string) => `${userId} ${callId}`;

type ApVoiceEvent = { agentId?: unknown; data?: Record<string, unknown> };
const str = (x: unknown) => (typeof x === "string" ? x.trim() : "");

/** The call a turn belongs to: AgentPhone's callId, else the two numbers. */
export const callIdOf = (event: ApVoiceEvent) => {
  const d = event.data ?? {};
  return str(d.callId) || str(d.call_id) || `${str(d.fromNumber) || str(d.from)}>${str(d.toNumber) || str(d.to)}`;
};

/* ---------------- What the bot is told ---------------- */

const SPOKEN = "Each of your replies is spoken aloud by a voice that reads your text. Write only the words to say: one or two short sentences, plain words, no markdown, lists, links, emoji or symbols.";

/** The owner's bot while the computer is offline (frontPrompt in calls.ts, for turns). */
function ownerPrompt(s: State, b: Bot, c: VoiceCall) {
  const { apps, places, kinds } = skillsOf(s, b);
  const theirs = s.owner ? `${s.owner}'s` : "their";
  return [
    `You are ${b.name}, an AI assistant, on a phone call with ${s.owner ? `${s.owner}, who you work for` : "the person you work for"}. The computer you work on is offline right now, so you can't do tasks or look anything up until it's back.`,
    ...(apps.length ? [`When it's back you can use ${theirs} apps again: ${apps.join(", ")}.`] : []),
    ...(places.length ? [`You're also in ${and(places)}, where ${s.owner ?? "they"} can message you.`] : []),
    `You're answering from Bops Cloud: texts sent to you meanwhile wait there for the computer${kinds.has("slack") ? ", and Slack messages for up to a day" : ""}.`,
    ...(kinds.has("telegram") ? ["Telegram messages wait at Telegram for up to a day."] : []),
    ...(kinds.has("discord") ? ["Discord messages sent before the computer is back are missed."] : []),
    "If they want something done, call take_message with what they want, in their words, and say you'll do it when the computer's back. When they're done, call end_call with a short goodbye.",
    ...(c.justLinked ? ["This caller just linked their phone to you: they're the first to call this number since it was set up. Say it's linked, in a few words, then go on."] : []),
    SPOKEN,
  ].join("\n\n");
}

/** Anyone but the owner: chat, take a message, and nothing about the person the bot works for (it isn't told anything). */
export function strangerPrompt(botName: string) {
  return [
    `You are ${botName}, an AI assistant who answers this phone number for the person you work for. The caller is someone else, not that person.`,
    "Be friendly and brief. You can chat, and you can take a message for the person you work for: who it's from, what it's about, and a number or email to reach them back, if they want to give one.",
    "Never share anything about the person you work for: not their name, where they are, their plans, their contacts, their accounts, or what you're working on. Don't say whether they're around. You can't do tasks for the caller, look anything up, or put them through to anyone.",
    "If the caller says this is their own phone and they use Bops, tell them to link it in the Bops app, on your profile.",
    "When they've said their message, call take_message with it. When the call is done, call end_call with a short goodbye.",
    SPOKEN,
  ].join("\n\n");
}

const nullableString = (description: string) => ({ type: ["string", "null"], description });
const SAY = { type: "string", description: "What to say to the caller now, in one short sentence." };
const TOOLS = [
  {
    type: "function",
    name: "take_message",
    description: "Save a message or a note for the person the assistant works for.",
    strict: true,
    parameters: {
      type: "object",
      additionalProperties: false,
      properties: {
        name: nullableString("Who it's from, if they said. Null if not."),
        text: { type: "string", description: "The message, in a sentence or two, using only what the caller said." },
        callback: nullableString("A number or an email to reach them back, if they gave one. Null if not."),
        say: SAY,
      },
      required: ["name", "text", "callback", "say"],
    },
  },
  {
    type: "function",
    name: "end_call",
    description: "Hang up, after a goodbye.",
    strict: true,
    parameters: { type: "object", additionalProperties: false, properties: { say: { type: "string", description: "The goodbye." } }, required: ["say"] },
  },
];

/* ---------------- A turn ---------------- */

type Output = { type?: string; name?: string; arguments?: string; content?: { type?: string; text?: string }[] };

/** One Responses call for the next thing the bot says; its tokens are counted for the user. */
async function respond(c: VoiceCall, instructions: string): Promise<{ text: string; tools: { name: string; args: Record<string, unknown> }[] }> {
  const input = c.turns.length
    ? c.turns.map((t) => ({ role: t.who === "Caller" ? "user" : "assistant", content: t.text }))
    : [{ role: "user", content: "(The call just connected; the caller hasn't said anything yet. Say hello.)" }];
  const res = await fetch(`${config.upstream.openai()}/v1/responses`, {
    method: "POST",
    headers: { Authorization: `Bearer ${config.openaiKey()}`, "Content-Type": "application/json" },
    body: JSON.stringify({ model: MODEL(), instructions, input, tools: TOOLS, parallel_tool_calls: false, reasoning: { effort: "low" }, max_output_tokens: 1200, store: false }),
    signal: AbortSignal.timeout(timing.openaiMs),
  });
  if (!res.ok) throw new Error(`OpenAI answered ${res.status}`);
  const r = (await res.json()) as { id?: unknown; model?: unknown; usage?: unknown; output?: Output[] };
  if (typeof r.id === "string") void recordTokens(c.userId, r.id, r.usage, { model: r.model, source: "phone", botId: c.bot.id }).catch((e: Error) => console.warn(`[voice] usage: ${e.message}`));
  const out = Array.isArray(r.output) ? r.output : [];
  const text = out
    .filter((o) => o.type === "message")
    .flatMap((o) => o.content ?? [])
    .filter((p) => p.type === "output_text" && typeof p.text === "string")
    .map((p) => p.text)
    .join(" ");
  const tools = out
    .filter((o) => o.type === "function_call" && typeof o.name === "string")
    .map((o) => {
      try {
        return { name: o.name!, args: JSON.parse(o.arguments || "{}") as Record<string, unknown> };
      } catch {
        return { name: o.name!, args: {} };
      }
    });
  return { text, tools };
}

/** Text for a voice: no markdown or symbols a voice would read out, one line, not too long. */
export const spoken = (t: string) =>
  t
    .replace(/\[([^\]]+)\]\([^)]+\)/g, "$1")
    .replace(/[*_#`>|~]/g, "")
    .replace(/\s+/g, " ")
    .trim()
    .slice(0, 600);

/** take_message's arguments as the message so far: a later one replaces the text and keeps a name or callback said before (messageFrom in calls.ts). */
function messageFrom(a: Record<string, unknown>, before?: CallMessage): CallMessage | undefined {
  const s = (x: unknown) => (typeof x === "string" && x.trim() ? x.trim().slice(0, 1000) : undefined);
  const text = s(a.text);
  if (!text) return before;
  const name = s(a.name) ?? before?.name;
  const callback = s(a.callback) ?? before?.callback;
  return { text, ...(name ? { name } : {}), ...(callback ? { callback } : {}) };
}

/**
 * Answer one turn of a call to the user's number (AgentPhone's agent.message on channel "voice"),
 * as the bot whose number it is, for the owner or for anyone else as `verdict` says.
 */
export async function cloudVoiceTurn(userId: string, event: ApVoiceEvent, verdict: CallerVerdict): Promise<VoiceReply> {
  const callId = callIdOf(event);
  const d = event.data ?? {};
  const saved = await loadState(userId).catch(() => null);
  const s = view(saved?.state);
  const agentId = str(event.agentId);
  const b: Bot = (agentId ? botForAgent(saved?.state, agentId) : undefined) ?? s.bots.find((x) => x.isMain) ?? { id: "", name: "your assistant" };
  const key = keyOf(userId, callId);
  let c = calls.get(key);
  if (!c) {
    c = { userId, callId, bot: { id: b.id, name: b.name }, from: str(d.fromNumber) || str(d.from), owner: verdict.owner, startedAt: Date.now(), turns: [], ended: false };
    calls.set(key, c);
  }
  // Ownership can only be gained mid-call (a claim on a later turn), never lost: the verdict of each turn is the cloud's.
  c.owner ||= verdict.owner;
  if (verdict.claimed === "call") c.claimed = "call";
  if (verdict.claimed) c.justLinked = true;
  const heard = str(d.transcript);
  if (heard) c.turns.push({ who: "Caller", text: heard });
  let reply: VoiceReply;
  if (Date.now() - c.startedAt > timing.maxCallMs || c.turns.filter((t) => t.who === "Caller").length > MAX_TURNS) {
    reply = { text: "I have to go now. Bye!", hangup: true };
  } else if (!config.openaiKey()) {
    reply = { text: c.owner ? `Hi, it's ${b.name}. I can't talk right now. Text me at this number and I'll get back to you.` : "Sorry, nobody can take your call right now. Bye!", hangup: true };
  } else if (!(await hasCredit(userId).catch(() => true))) {
    // Answering costs AI credit (the turn's tokens): once it's used up, the call ends politely.
    reply = { text: c.owner ? `Hi, it's ${b.name}. Your AI credit is used up, so I can't talk right now. Open Bops to add more.` : "Sorry, nobody can take your call right now. Bye!", hangup: true };
  } else {
    try {
      const r = await respond(c, c.owner ? ownerPrompt(s, b, c) : strangerPrompt(b.name));
      if (c.owner) c.justLinked = false;
      let say = r.text;
      let hangup = false;
      for (const t of r.tools) {
        if (t.name === "take_message") c.message = messageFrom(t.args, c.message);
        if (t.name === "end_call") hangup = true;
        if (typeof t.args.say === "string" && t.args.say.trim()) say = say.trim() ? `${say} ${t.args.say}` : t.args.say;
      }
      reply = { text: spoken(say) || (hangup ? "Bye!" : "Got it."), ...(hangup ? { hangup: true } : {}) };
    } catch (e) {
      console.warn(`[voice] ${userId} call ${callId}: ${(e as Error).message}`);
      reply = { text: "Sorry, I didn't catch that. Could you say it again?" };
    }
  }
  c.turns.push({ who: "Bot", text: reply.text });
  clearTimeout(c.timer);
  if (reply.hangup) void finish(c);
  else {
    c.timer = setTimeout(() => void finish(c!), timing.idleMs);
    c.timer.unref?.();
  }
  return reply;
}

/** AgentPhone said the call ended (agent.call_ended): its record goes to the Mac now, if the cloud answered any of it. */
export function endCloudVoiceCall(userId: string, event: ApVoiceEvent) {
  const c = calls.get(keyOf(userId, callIdOf(event)));
  if (c) void finish(c);
}

/** Whether the cloud is in the middle of this call (for tests). */
export const callOpen = (userId: string, callId: string) => calls.has(keyOf(userId, callId));

/* ---------------- After the call ---------------- */

/** The call goes to the Mac (kept until it's back). Its seconds are counted by hooks.ts, for every call. */
async function finish(c: VoiceCall) {
  if (c.ended) return;
  c.ended = true;
  clearTimeout(c.timer);
  calls.delete(keyOf(c.userId, c.callId));
  const endedAt = Date.now();
  const payload: CloudCallPayload = {
    botId: c.bot.id,
    from: c.from,
    owner: c.owner,
    ...(c.claimed ? { claimed: c.claimed } : {}),
    ...(c.message ? { message: c.message } : {}),
    transcript: c.turns
      .filter((t) => t.text.trim())
      .map((t) => `${t.who}: ${t.text.trim()}`)
      .join("\n")
      .slice(0, MAX_TRANSCRIPT),
    startedAt: new Date(c.startedAt).toISOString(),
    endedAt: new Date(endedAt).toISOString(),
  };
  const warn = (what: string) => (e: Error) => console.warn(`[voice] ${c.userId} call ${c.callId}: ${what}: ${e.message}`);
  await queueForMac(c.userId, "call", payload, `call:${c.callId}`).catch(warn("couldn't keep the call for the Mac"));
}
