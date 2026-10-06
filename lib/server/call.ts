import "server-only";
import { computerBriefing, teamBriefing } from "./briefing";
import { ABOUT_BOPS, SPEAKING } from "./style";
import { appsNote, placesNote } from "./skills";
import { openaiClient } from "./openai-client";
import { botChatId, live, type Bot } from "@/lib/types";
import { handleMessage } from "./chat";
import { callEnded, callStarted } from "./attention";
import { noteOutOfCredit, OUT_OF_CREDIT } from "./cloud";
import { chose, decide } from "./decide";
import { memoryBlock, saveToMemory, wsOf } from "./memory";
import { addMessage, bot, getState, ownerLine, ownerName, update } from "./store";
import { recordCallMinutes } from "./usage";
import { contactLine } from "./bots";

/**
 * Calling a bot. GPT-Live handles the conversation itself (listening, talking, interruptions) in
 * the bot's own voice; anything that needs doing is delegated to the bot's usual chat brain, so on
 * a call the bot can start threads on its computer, hand work to teammates and schedule things,
 * exactly as it would over text. What gets done shows up in its chat like any other message.
 */

const client = openaiClient({ maxRetries: 0 });

/**
 * Each bot sounds like itself, in a voice that fits its name: a woman's voice for a woman's name, a
 * man's for a man's, and a man's when the name could be either or isn't a name (Jev decides, once
 * per name). Within that, the bot's id picks the voice, so it's the same on every call.
 */
const MALE = ["cedar", "ash", "echo", "ballad", "verse"];
const FEMALE = ["marin", "coral", "shimmer", "sage"];
const genders = new Map<string, "female" | "male">();
export async function voiceFor(b: Bot) {
  const voice = await chooseVoice(b);
  // Kept on the bot, so Bops Cloud answers its calls in the same voice while the Mac is away.
  if (b.voice !== voice) update(() => void (b.voice = voice));
  return voice;
}

/** Every bot's voice, chosen and kept (the phone's catch-up runs it): a new or renamed bot gets its own before its first call. */
export async function rememberVoices() {
  for (const b of getState().bots) await voiceFor(b);
}

async function chooseVoice(b: Bot) {
  if (b.isMain && (b.name === "Boppy" || b.name === "Sam")) return "cedar";
  let g = genders.get(b.name);
  if (!g) {
    const a = await decide(
      { name: b.name },
      {
        gender: {
          type: "choice",
          instructions: `As a person's first name, is "${b.name}" usually a woman's name or a man's name?`,
          criteria: { female: "Usually a woman's name", male: "Usually a man's name", unclear: "Could be either, or not a person's name" },
        },
      },
    );
    const c = chose(a?.gender);
    g = c?.choice === "female" && (c.probabilities.female ?? 0) >= 0.6 ? "female" : "male";
    if (c) genders.set(b.name, g);
  }
  const list = g === "female" ? FEMALE : MALE;
  return list[[...b.id].reduce((n, ch) => n + ch.charCodeAt(0), 0) % list.length];
}

/**
 * What the bot is told on a call with the user. "live": a GPT-Live call (in the app, or over a SIP
 * trunk), which delegates through its client and greets with "Hello? Can you hear me?". "turns": a
 * call to its number through AgentPhone's voice agent (lib/server/phone-voice.ts), where each reply
 * is text a voice reads out, and work goes through the delegate tool.
 */
export async function voicePrompt(b: Bot, how: "live" | "turns" = "live") {
  const owner = ownerName();
  const recent = getState()
    .messages.filter((m) => m.chatId === botChatId(b.id) && m.role !== "system")
    .slice(-10)
    .map((m) => `${m.role === "user" ? owner : b.name}: ${m.text.slice(0, 300)}`)
    .join("\n");
  return [
    `You are ${b.name}, ${b.isMain ? `${owner}'s chief of staff` : `${owner}'s ${b.role} bot`} in Bops, on a phone call with ${owner}. ${ownerLine()}`,
    "Talk like a capable teammate on a call: short, warm, natural. One or two sentences at a time. No lists.",
    SPEAKING,
    ABOUT_BOPS,
    contactLine(b, true),
    // What it can use (through its delegate) and where else the user reaches it.
    appsNote(b, "call"),
    placesNote(b, "call"),
    how === "live"
      ? `You can't act on your own during the call. Whenever ${owner} asks for something to be done, looked up, checked, scheduled, or handed to another bot, delegate it, then tell them briefly what's happening while it runs. When the result comes back, say it in your own words.`
      : `You can't act on your own during the call. Whenever ${owner} asks for something to be done, looked up, checked, scheduled, or handed to another bot, call delegate with what they asked, in their words, and say in a few words that you're on it. Results come back in your chat with ${owner}, and by text to their phone when they finish after the call. When ${owner} asks how it's going, say what the notes about this call's work say.`,
    `If ${owner} asks something you don't know, or that's a teammate's area, delegate it too: your delegate can ask your teammates and tells you what they said.`,
    "For small talk or questions about the call itself, just answer.",
    how === "live"
      ? `You answered this call: your first words are "Hello? Can you hear me?", and then you let ${owner} talk.`
      : `${owner} called your phone number, and you picked up. Each of your replies is spoken aloud by a voice that reads your text: write only the words to say, one or two short sentences, plain words, no markdown, lists, links, emoji or symbols. Say numbers, times and addresses the way people say them. When ${owner} is done, call end_call with a short goodbye.`,
    `Here's your computer as of the start of this call. Use it for questions about what you're doing or what's waiting on ${owner}; for anything that may have changed since, delegate.`,
    await computerBriefing(b.id).catch(() => ""),
    b.isMain ? teamBriefing(b.id) : "",
    recent ? `Your recent text conversation with ${owner}, for context:\n${recent}` : "",
    // What's known about the user (long-term memory), so the call knows them like the chat does.
    await memoryBlock(wsOf(b.id), recent || owner),
  ]
    .filter(Boolean)
    .join("\n\n");
}

/** Start a call: exchange the browser's WebRTC offer for GPT-Live's answer. Out of AI credit, it says so (the chat shows it too). */
export async function startCall(botId: string, sdp: string) {
  const b = bot(botId);
  if (!b) throw new Error("no such bot");
  callStarted(botId);
  try {
    const result = await client.live.create({
      session: {
        model: "gpt-live-1",
        instructions: await voicePrompt(b),
        audio: { output: { voice: await voiceFor(b) } },
        delegation: { type: "client" },
      },
      transport: { type: "webrtc", sdp },
    } as never);
    return result as unknown as { session: { id: string }; transport: { sdp: string } };
  } catch (e) {
    if (noteOutOfCredit(e)) throw new Error(OUT_OF_CREDIT);
    throw e;
  }
}

/**
 * Something the user asked for on the call, run through the bot's chat like a text: it may reply,
 * start threads, hand off or schedule. Returns what the bot said, for GPT-Live to say aloud.
 */
export async function delegate(botId: string, request: string) {
  const chatId = botChatId(botId);
  const since = Date.now();
  await handleMessage(chatId, request);
  const replies = getState().messages.filter((m) => m.chatId === chatId && m.at >= since && m.role !== "user");
  const threads = getState().sessions.filter((s) => s.chatId === chatId && s.createdAt >= since);
  const said = replies.map((m) => m.text).join(" ").trim();
  // Threads the request started (or continued); the call reports their results if they finish in time.
  const touched = getState().sessions.filter((s) => s.chatId === chatId && live(s) && (s.createdAt >= since || s.replies.some((r) => r.at >= since)));
  const started = threads.length ? ` Started on the computer: ${threads.map((s) => `"${s.title}"`).join(", ")}. I'll say how it went if it finishes while we're talking.` : "";
  return { result: (said || "Done.") + started, sessionIds: touched.map((s) => s.id) };
}

/** A note in the chat once a call ends, so it reads like the rest of the conversation. */
export function endCall(botId: string, seconds: number, transcript?: { who: string; text: string }[], phone?: string) {
  callEnded();
  // A phone call's minutes were counted when it ended (runCall in phone.ts); this counts calls in the app.
  if (!phone) recordCallMinutes(botId, seconds);
  // The call goes into long-term memory like a chat, so what the user said out loud is remembered too.
  if (transcript?.length)
    saveToMemory(wsOf(botId), "chat", botChatId(botId), transcript.slice(-200).map((t) => ({ who: t.who === "owner" ? "owner" : botId, text: t.text.slice(0, 2000) })), { chat: "call" });
  const m = Math.floor(seconds / 60);
  const s = Math.round(seconds % 60);
  addMessage({ chatId: botChatId(botId), role: "system", text: `${phone ? "Phone call" : "Call"} ended · ${m ? `${m}m ` : ""}${s}s`, call: { seconds: Math.round(seconds), phone } });
}
