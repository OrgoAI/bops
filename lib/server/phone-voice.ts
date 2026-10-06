import "server-only";
import type { CallerVerdict } from "@/cloud/protocol";
import { botChatId, live, type Bot } from "@/lib/types";
import { callEnded, callStarted } from "./attention";
import { delegate, voicePrompt } from "./call";
import { saveToMemory, wsOf } from "./memory";
import { openaiClient } from "./openai-client";
import { callLog, fromOwner, isOwner, linkClaimed, routeFor, type ApEvent } from "./phone";
import { addMessage, bot, getState, ownerLine, ownerName, patchSession } from "./store";
import { SPEAKING } from "./style";
import { recordCallMinutes, recordTokens } from "./usage";

/**
 * Calls to a bot's number, answered on this Mac. Every Bops number's calls go to its AgentPhone
 * agent in voice mode "webhook" (phone.ts callsToAgent): AgentPhone hears the caller and sends each
 * turn to the webhook (on Bops Cloud, replayed here over the tunnel), and the text answered is what
 * it speaks. While this Mac is away, Bops Cloud answers the turns itself (cloud/voice.ts).
 *
 * - **Who's calling** is Bops Cloud's to say (CallerVerdict, from bops.phone_lines: the line's owner,
 *   the user's own numbers, or the first caller in a new line's 15 minutes); self-hosting, the
 *   verified numbers here. A first call that claimed the line links that phone (linkClaimed).
 * - **The owner** gets the whole bot: the prompt of a call in the app (voicePrompt, "turns"), each
 *   turn one Responses call (a fast model, thinking lightly) with two tools. `delegate` hands real work
 *   to the bot exactly as a call in the app does (delegate() in call.ts): the bot says it's on it, the
 *   work runs in its chat, and threads it starts text their results to the caller. `end_call` hangs up.
 * - **Anyone else** gets a bot that only chats and takes a message for the user: it's told nothing
 *   about them (no name, memory, apps or work), and can't delegate. The message lands in the bot's
 *   chat with a chime.
 * - **Speed:** the prompt is built once per call, from the first turn on (the hello uses a quick one
 *   meanwhile). A turn that takes long gets a filler first ("Mm-hm, one sec.": voiceResponse, or Bops
 *   Cloud does it for a turn it replays here), except the hello: nobody has said anything to wait on.
 * - **The call** is grouped by AgentPhone's callId and ends on a hangup, on AgentPhone's call_ended
 *   event, or after 2 minutes without a turn. Then the transcript goes into the bot's chat (and, for
 *   the owner, into memory as a call in the app does) and its minutes are counted.
 */

/** Tests shorten these. */
export const voiceTiming = { idleMs: 2 * 60_000, promptMs: 4_000, turnMs: 12_000, fillerAfterMs: 1_500 };
/** The model for a call's turns: quick, thinking lightly. */
const MODEL = () => process.env.BOPS_PHONE_MODEL?.trim() || process.env.BOPS_CHAT_MODEL?.trim() || "gpt-6.1-sol";
/** What the caller hears while a slow answer is on its way. */
const FILLER = "Mm-hm, one sec.";
/** Past this long, or this many of a stranger's turns, the bot says goodbye. */
const MAX_OWNER_CALL_MS = 60 * 60_000;
const MAX_STRANGER_CALL_MS = 10 * 60_000;
const MAX_STRANGER_TURNS = 30;

const client = openaiClient({ maxRetries: 0 });

export type VoiceReply = { text: string; hangup?: boolean };
type Turn = { who: "caller" | "bot"; text: string };
/** Work the owner asked for on this call, handed to the bot's chat. */
type Work = { request: string; said?: string; sessionIds: string[]; failed?: boolean };
type PhoneCall = {
  id: string;
  botId: string;
  from: string;
  to: string;
  owner: boolean;
  /** The caller's phone just became the line's owner: the next answer says so. */
  justLinked?: boolean;
  startedAt: number;
  lastAt: number;
  turns: Turn[];
  prompt?: Promise<string>;
  work: Work[];
  message?: { name?: string; text: string; callback?: string };
  timer?: ReturnType<typeof setTimeout>;
  ended?: boolean;
};

const g = globalThis as unknown as { bopsPhoneCalls?: Map<string, PhoneCall> };
// Kept across code reloads, so a call doesn't lose its turns to an edit.
const calls: Map<string, PhoneCall> = (g.bopsPhoneCalls ??= new Map());

const str = (x: unknown) => (typeof x === "string" ? x.trim() : "");
const sleep = (ms: number) => new Promise<void>((r) => setTimeout(r, ms));

/** The call a turn belongs to: AgentPhone's callId, else the two numbers. */
const callIdOf = (e: ApEvent) => {
  const d = e.data ?? {};
  return str(d.callId) || str(d.call_id) || `${str(d.fromNumber) || str(d.from)}>${str(d.toNumber) || str(d.to)}`;
};

/* ---------------- What the bot is told ---------------- */

/** For a first turn whose full prompt isn't ready yet: who it is and how to talk, nothing that takes time to gather. */
function quickPrompt(b: Bot) {
  const owner = ownerName();
  return [
    `You are ${b.name}, ${b.isMain ? `${owner}'s chief of staff` : `${owner}'s ${b.role} bot`} in Bops, on a phone call with ${owner}. ${ownerLine()}`,
    "Talk like a capable teammate on a call: short, warm, natural.",
    SPEAKING,
    `Whenever ${owner} asks for something to be done, looked up, checked, scheduled, or handed to another bot, call delegate with what they asked, in their words, and say in a few words that you're on it.`,
    `Each of your replies is spoken aloud by a voice that reads your text: write only the words to say, one or two short sentences, plain words, no markdown, lists, links, emoji or symbols. When ${owner} is done, call end_call with a short goodbye.`,
  ].join("\n\n");
}

/** Anyone but the owner: chat, take a message, and nothing about the person the bot works for (it isn't told anything). */
export function strangerPrompt(b: Bot) {
  return [
    `You are ${b.name}, an AI assistant who answers this phone number for the person you work for. The caller is someone else, not that person.`,
    "Be friendly and brief. You can chat, and you can take a message for the person you work for: who it's from, what it's about, and a number or email to reach them back, if they want to give one.",
    "Never share anything about the person you work for: not their name, where they are, their plans, their contacts, their accounts, or what you're working on. Don't say whether they're around. You can't do tasks for the caller, look anything up, or put them through to anyone.",
    "If the caller says this is their own phone and they use Bops, tell them to link it in the Bops app, on your profile.",
    "When they've said their message, call take_message with it. When the call is done, call end_call with a short goodbye.",
    "Each of your replies is spoken aloud by a voice that reads your text. Write only the words to say: one or two short sentences, plain words, no markdown, lists, links, emoji or symbols.",
  ].join("\n\n");
}

/** What the owner's work on this call has come to, for the next answer. */
function workNotes(c: PhoneCall) {
  if (!c.work.length) return "";
  const lines = c.work.map((w) => {
    const threads = w.sessionIds
      .map((id) => getState().sessions.find((s) => s.id === id))
      .filter((s) => !!s)
      .map((s) => (live(s) ? `"${s.title}" is still running` : s.status === "done" ? `"${s.title}" is done: ${(s.answer ?? "finished").slice(0, 400)}` : `"${s.title}" didn't finish: ${s.error ?? "it stopped"}`));
    const said = w.failed ? "it couldn't be started" : w.said === undefined ? "you're still handing it over" : `your chat said: "${w.said.slice(0, 400)}"`;
    return `- "${w.request.slice(0, 200)}": ${said}${threads.length ? `; ${threads.join("; ")}` : ""}`;
  });
  return `Work ${ownerName()} asked for on this call (say how it's going when they ask, or when something finished):\n${lines.join("\n")}`;
}

const SAY = { type: "string", description: "What to say to the caller now, in one short sentence." };
const tool = (name: string, description: string, properties: Record<string, unknown>) => ({
  type: "function" as const,
  name,
  description,
  strict: true,
  parameters: { type: "object", additionalProperties: false, properties, required: Object.keys(properties) },
});
const nullableString = (description: string) => ({ type: ["string", "null"], description });
const END_CALL = tool("end_call", "Hang up, after a goodbye.", { say: { type: "string", description: "The goodbye." } });
const OWNER_TOOLS = [
  tool("delegate", "Hand something the caller asked for to your own chat, where you can do it: use your computer and apps, look things up, send email, schedule, ask teammates.", {
    request: { type: "string", description: "What they asked for, in their words, with every detail they gave." },
    say: SAY,
  }),
  END_CALL,
];
const STRANGER_TOOLS = [
  tool("take_message", "Save a message for the person you work for.", {
    name: nullableString("Who it's from, if they said. Null if not."),
    text: { type: "string", description: "The message, in a sentence or two, using only what the caller said." },
    callback: nullableString("A number or an email to reach them back, if they gave one. Null if not."),
    say: SAY,
  }),
  END_CALL,
];

/* ---------------- A turn ---------------- */

/** Text for a voice: no markdown or symbols a voice would read out, one line, not too long. */
const spoken = (t: string) =>
  t
    .replace(/\[([^\]]+)\]\([^)]+\)/g, "$1")
    .replace(/[*_#`>|~]/g, "")
    .replace(/\s+/g, " ")
    .trim()
    .slice(0, 600);

/** One Responses call for what the bot says next, and the tools it called. Its tokens are counted. */
async function respond(b: Bot, c: PhoneCall, instructions: string, tools: ReturnType<typeof tool>[]) {
  const input = c.turns.length
    ? c.turns.map((t) => ({ role: t.who === "caller" ? ("user" as const) : ("assistant" as const), content: t.text }))
    : [{ role: "user" as const, content: "(The call just connected; the caller hasn't said anything yet. Say hello.)" }];
  const r = await client.responses.create({ model: MODEL(), reasoning: { effort: "low" }, instructions, input, tools, parallel_tool_calls: false, max_output_tokens: 1200, store: false });
  recordTokens("call", r.model, r.usage, b.id);
  const called = r.output.flatMap((o) => {
    if (o.type !== "function_call") return [];
    try {
      return [{ name: o.name, args: JSON.parse(o.arguments || "{}") as Record<string, unknown> }];
    } catch {
      return [{ name: o.name, args: {} as Record<string, unknown> }];
    }
  });
  return { text: r.output_text ?? "", tools: called };
}

/** The words a turn's tools said, after the model's own. */
const withSay = (text: string, args: Record<string, unknown>) => {
  const say = str(args.say);
  return say ? (text.trim() ? `${text.trim()} ${say}` : say) : text;
};

/** Real work the owner asked for: into the bot's chat as a call in the app does it; threads it starts text their results to the caller. */
function startWork(c: PhoneCall, b: Bot, request: string) {
  const w: Work = { request, sessionIds: [] };
  c.work.push(w);
  callLog({ event: "call work", call: c.id, bot: b.id, request: request.slice(0, 300) });
  void delegate(b.id, request)
    .then((r) => {
      w.said = r.result;
      w.sessionIds = r.sessionIds;
      if (isOwner(c.from)) for (const id of r.sessionIds) if (!getState().sessions.find((s) => s.id === id)?.textBack) patchSession(id, { textBack: { botId: b.id, to: c.from } });
    })
    .catch((e: Error) => {
      w.failed = true;
      callLog({ event: "call work failed", call: c.id, error: e.message });
    });
}

async function ownerTurn(c: PhoneCall, b: Bot): Promise<VoiceReply> {
  const quick = quickPrompt(b);
  c.prompt ??= voicePrompt(b, "turns").catch(() => quick);
  // The hello doesn't wait on the whole prompt (it's built meanwhile, for the turns after).
  const first = !c.turns.some((t) => t.who === "bot");
  const prompt = await Promise.race([c.prompt, sleep(first ? 0 : voiceTiming.promptMs).then(() => quick)]);
  const notes = [
    c.justLinked ? `This caller just linked their phone to you: they're the first to call this number since it was set up. Say it's linked, in a few words, then go on.` : "",
    workNotes(c),
  ].filter(Boolean);
  const r = await respond(b, c, [prompt, ...notes].join("\n\n"), OWNER_TOOLS);
  c.justLinked = false;
  let text = r.text;
  let hangup = false;
  for (const t of r.tools) {
    if (t.name === "delegate" && str(t.args.request)) startWork(c, b, str(t.args.request));
    if (t.name === "end_call") hangup = true;
    text = withSay(text, t.args);
  }
  return { text: spoken(text) || (hangup ? "Bye!" : "On it."), ...(hangup ? { hangup: true } : {}) };
}

async function strangerTurn(c: PhoneCall, b: Bot): Promise<VoiceReply> {
  const r = await respond(b, c, strangerPrompt(b), STRANGER_TOOLS);
  let text = r.text;
  let hangup = false;
  for (const t of r.tools) {
    if (t.name === "take_message") {
      const msg = str(t.args.text).slice(0, 1000);
      if (msg) c.message = { text: msg, ...(str(t.args.name) ? { name: str(t.args.name).slice(0, 200) } : c.message?.name ? { name: c.message.name } : {}), ...(str(t.args.callback) ? { callback: str(t.args.callback).slice(0, 200) } : c.message?.callback ? { callback: c.message.callback } : {}) };
    }
    if (t.name === "end_call") hangup = true;
    text = withSay(text, t.args);
  }
  return { text: spoken(text) || (hangup ? "Bye!" : "Got it."), ...(hangup ? { hangup: true } : {}) };
}

/**
 * One turn of a call to a bot's number (AgentPhone's agent.message on channel "voice"): what the bot
 * says next. `verdict`: who's calling, as Bops Cloud decided; without one, the verified numbers here.
 */
export async function voiceTurn(e: ApEvent, verdict?: CallerVerdict): Promise<VoiceReply> {
  const d = e.data ?? {};
  const from = str(d.fromNumber) || str(d.from);
  const to = str(d.toNumber) || str(d.to);
  const route = routeFor(e.agentId);
  if (!route) {
    callLog({ event: "call turn", why: "no bot has this agent", agentId: e.agentId });
    return { text: "Sorry, this number isn't set up yet. Bye!", hangup: true };
  }
  const b = route.b;
  const id = callIdOf(e);
  const owner = fromOwner(from, verdict);
  if (verdict?.claimed) linkClaimed(from, verdict.claimed, b);
  let c = calls.get(id);
  if (!c) {
    c = { id, botId: b.id, from, to, owner, startedAt: Date.now(), lastAt: Date.now(), turns: [], work: [] };
    calls.set(id, c);
    if (owner) callStarted(b.id);
    callLog({ event: "call", call: id, bot: b.id, from, owner });
  }
  // Ownership can be gained mid-call (a claim on a later turn), never lost.
  if (owner && !c.owner) {
    c.owner = true;
    callStarted(b.id);
  }
  if (verdict?.claimed) c.justLinked = true;
  const heard = str(d.transcript);
  if (heard) c.turns.push({ who: "caller", text: heard });
  const call = c;
  const tooLong = Date.now() - call.startedAt > (call.owner ? MAX_OWNER_CALL_MS : MAX_STRANGER_CALL_MS) || (!call.owner && call.turns.filter((t) => t.who === "caller").length > MAX_STRANGER_TURNS);
  const reply: VoiceReply = tooLong
    ? { text: "I have to go now. Bye!", hangup: true }
    : await Promise.race([
        (call.owner ? ownerTurn(call, b) : strangerTurn(call, b)).catch((err: Error) => {
          callLog({ event: "call turn failed", call: id, error: err.message });
          return { text: "Sorry, I didn't catch that. Could you say it again?" };
        }),
        sleep(voiceTiming.turnMs).then(() => ({ text: "Sorry, give me a second. Could you say that again?" })),
      ]);
  call.turns.push({ who: "bot", text: reply.text });
  call.lastAt = Date.now();
  clearTimeout(call.timer);
  if (reply.hangup) finish(call);
  else {
    call.timer = setTimeout(() => finish(call), voiceTiming.idleMs);
    call.timer.unref?.();
  }
  return reply;
}

/** AgentPhone said a call ended (agent.call_ended): its transcript goes into the chat now. */
export function phoneCallEnded(e: ApEvent) {
  const c = calls.get(callIdOf(e));
  if (c) finish(c);
}

/** Whether this Mac is in the middle of a call (for tests). */
export const callOpen = (id: string) => calls.has(id);

/**
 * A call's answer as AgentPhone takes it: JSON when it's quick, else NDJSON with a filler spoken at
 * once and the answer as the final chunk (`filler` false: always JSON, for the hello). Through Bops
 * Cloud the answer goes back as JSON (the cloud does the filler); this is for AgentPhone calling this
 * Mac's webhook directly.
 */
export async function voiceResponse(reply: Promise<VoiceReply>, filler = true): Promise<Response> {
  const quick = await Promise.race([reply, ...(filler ? [sleep(voiceTiming.fillerAfterMs).then(() => null)] : [])]);
  if (quick) return Response.json(quick);
  const encoder = new TextEncoder();
  const body = new ReadableStream<Uint8Array>({
    async start(controller) {
      controller.enqueue(encoder.encode(`${JSON.stringify({ text: FILLER, interim: true })}\n`));
      controller.enqueue(encoder.encode(`${JSON.stringify(await reply)}\n`));
      controller.close();
    },
  });
  return new Response(body, { headers: { "content-type": "application/x-ndjson", "cache-control": "no-store" } });
}

/* ---------------- After the call ---------------- */

/** The call is over: its minutes counted, and the transcript in the bot's chat (the owner's also into memory, as a call in the app is). */
function finish(c: PhoneCall) {
  if (c.ended) return;
  c.ended = true;
  clearTimeout(c.timer);
  calls.delete(c.id);
  const b = bot(c.botId);
  const seconds = Math.max(0, Math.round((c.lastAt - c.startedAt) / 1000));
  recordCallMinutes(c.botId, seconds);
  callLog({ event: "call ended", call: c.id, bot: c.botId, owner: c.owner, seconds, turns: c.turns.length });
  if (!b) return;
  const turns = c.turns.filter((t) => t.text.trim());
  const lines = turns.map((t) => `${t.who === "caller" ? (c.owner ? "You" : "Caller") : b.name}: ${t.text.trim()}`).join("\n");
  const chatId = botChatId(b.id);
  const card = { sms: { dir: "in" as const, from: c.from, to: c.to, id: `call:${c.id}` }, call: { seconds, phone: c.from } };
  if (c.owner) {
    callEnded();
    if (turns.length) saveToMemory(wsOf(b.id), "chat", chatId, turns.slice(-200).map((t) => ({ who: t.who === "caller" ? "owner" : b.id, text: t.text.slice(0, 2000) })), { chat: "call" });
    addMessage({ chatId, role: "system", text: (lines || "(nothing was said)").slice(0, 8000), ...card });
    return;
  }
  const m = c.message;
  const left = m ? `Left a message${m.name ? ` (${m.name})` : ""}: "${m.text}"${m.callback ? ` Reach them at ${m.callback}.` : ""}` : "Didn't leave a message.";
  addMessage({ chatId, role: "system", text: `${left}${lines ? `\n\n${lines}` : ""}`.slice(0, 8000), ...card, ...(m ? { ping: true } : {}) });
}
