import type { Mood } from "@/lib/mascot";
import { live, waitsForOk, type AppState } from "@/lib/types";

/**
 * What each bot is doing right now, as the app knows it, gathered once at the top of the app (BotMoods
 * in components/app/mascot.tsx) so every mascot picks its mood the same way (moodOf). Only real
 * signals: a reply comes in whole (lib/server/chat.ts), so composing one is thinking, never writing;
 * writing is a live thread whose caption says it's writing (Session.activity, sessions.ts captionSoon);
 * speaking is the bot's voice coming through on a call (CallBar's meter); shy is the user thanking or
 * praising it, for a few seconds after. A bot at work on another of the user's devices shows what it's
 * doing there (AppState.liveMoods, from Bops Cloud's live stream) while nothing here says otherwise.
 */
export type MoodSignals = {
  /** Bots with a live thread (not one waiting to be told where to run). */
  working: ReadonlySet<string>;
  /** Bots with a live thread that's writing or editing text: a message, a document, a note. */
  writing: ReadonlySet<string>;
  /** Bots composing a reply, by chat (Chat.typing). */
  typing: ReadonlyMap<string, readonly string[]>;
  /** Bots composing a reply in any chat. */
  typingAnywhere: ReadonlySet<string>;
  /** The bot on a voice call with the user, and whether its voice is coming through right now. */
  call?: { botId: string; speaking: boolean };
  /** Bots the user just thanked or praised, in a chat they're in: shy, blushing, for SHY_MS. */
  shy: ReadonlySet<string>;
  /** When the first of those blushes wears off, so the app draws again then (BotMoodsFrom), with nothing else new. */
  shyUntil?: number;
  /** What bots are doing on the user's other devices right now (thinking in a chat, writing, speaking, working). */
  elsewhere?: ReadonlyMap<string, NonNullable<AppState["liveMoods"]>[string]>;
};

export const NO_SIGNALS: MoodSignals = { working: new Set(), writing: new Set(), typing: new Map(), typingAnywhere: new Set(), shy: new Set() };

/** How long a bot stays shy after a thanks. */
export const SHY_MS = 6000;
/**
 * A thanks or praise at the start of a message, after a short opener or two ("ok, thanks", "no worries,
 * thanks!"), and what follows it. Not one inside a request ("write a thank you note", "find the
 * perfect gift"), nor "no thanks" or "not great".
 */
const PRAISE =
  /^(?:(?:ok(?:ay)?|oh|wow|aw+|yes|yay|cool|sweet|nice|great|awesome|amazing|perfect|got it|no problem|no worries|all good|haha|lol)[\s,.!]+)*(thank you|thank u|thanks|thank|thx|tysm|ty|(?:i )?(?:appreciate|love) (?:it|this|that|you)|(?:good|great|nice|amazing|awesome) (?:job|work|stuff|one)|well done|you(?:'re|’re| are) (?:the best|amazing|awesome|great|brilliant|a star)|perfect|brilliant|nailed it|bravo|kudos|you rock)\b([\s\S]*)$/i;
/** Hearts, thanks hands and happy faces on their own. */
const HEARTS = /^(?:[\s!.]*(?:❤\uFE0F?|💛|🧡|💚|💙|💜|🩷|🙏|🥰|😍|😊|👏|🙌|🫶))+[\s!.]*$/u;
/** What turns a thanks into a request: a question, a "but", or a next thing to do. */
const ASKS = /\?|\b(but|however|though|can you|could you|would you|please|pls|redo|fix|wrong|instead|also|now|next)\b/i;
/**
 * A message thanking or praising the bot: a thanks with at most a few words after it ("thanks Max",
 * "thanks for the summary", "perfect, ship it"), or hearts on their own; not one that goes on to ask
 * for something.
 */
export function isPraise(text: string) {
  const t = text.trim();
  if (HEARTS.test(t)) return true;
  const tail = PRAISE.exec(t)?.[2];
  if (tail === undefined || tail.length > 40 || ASKS.test(tail)) return false;
  const rest = tail.trim();
  return !rest || /^[,.!:;)]/.test(rest) || /^for\b/i.test(rest) || rest.split(/\s+/).length <= 4;
}

/**
 * The signals in the app's state, and the call the app has open (the bot on it, and whether it's
 * talking), at `now`: a thanks from SHY_MS ago no longer counts.
 */
export function moodSignals(
  state: Pick<AppState, "sessions" | "chats"> & { messages?: AppState["messages"]; liveMoods?: AppState["liveMoods"]; appApprovals?: AppState["appApprovals"] },
  call?: { botId: string; speaking: boolean } | null,
  now = Date.now(),
): MoodSignals {
  // A thread waiting for the user's OK (lib/types.ts waitsForOk) does nothing meanwhile: it's no work.
  const running = state.sessions.filter((s) => live(s) && !s.askWhere && !waitsForOk(s, { appApprovals: state.appApprovals }));
  const typing = new Map(state.chats.filter((c) => c.typing.length).map((c) => [c.id, c.typing] as const));
  // A thanks this recent is among the last few messages (a little of the server's clock ahead of ours is fine).
  const shy = new Set<string>();
  let shyUntil: number | undefined;
  const messages = state.messages ?? [];
  for (const m of messages.slice(-50)) {
    const age = now - m.at;
    if (m.role !== "user" || age < -2000 || age >= SHY_MS || !isPraise(m.text)) continue;
    const bots = state.chats.find((c) => c.id === m.chatId)?.botIds ?? [];
    for (const b of bots) shy.add(b);
    if (bots.length) shyUntil = Math.min(shyUntil ?? Infinity, m.at + SHY_MS);
  }
  return {
    working: new Set(running.map((s) => s.botId)),
    writing: new Set(running.filter((s) => s.activity === "writing").map((s) => s.botId)),
    typing,
    typingAnywhere: new Set([...typing.values()].flat()),
    ...(call ? { call } : {}),
    shy,
    ...(shyUntil ? { shyUntil } : {}),
    ...(state.liveMoods && Object.keys(state.liveMoods).length ? { elsewhere: new Map(Object.entries(state.liveMoods)) } : {}),
  };
}

/**
 * A bot's mood, first that fits: speaking on a call, writing in a thread, shy just after a thanks,
 * thinking over a reply (in `chatId` when given: the mascot in that chat's row, header or typing
 * line; anywhere otherwise), working (a live thread, a reply in another chat, or on a call and
 * listening), else what it's doing on another of the user's devices (thinking there over a reply in
 * another chat is working here), else idle.
 */
export function moodOf(signals: MoodSignals, botId: string, chatId?: string): Mood {
  if (signals.call?.botId === botId && signals.call.speaking) return "speaking";
  if (signals.writing.has(botId)) return "writing";
  if (signals.shy.has(botId)) return "shy";
  if (chatId ? signals.typing.get(chatId)?.includes(botId) : signals.typingAnywhere.has(botId)) return "thinking";
  if (signals.working.has(botId) || signals.typingAnywhere.has(botId) || signals.call?.botId === botId) return "working";
  const there = signals.elsewhere?.get(botId);
  if (there) return there.mood === "thinking" && chatId && there.chatId !== chatId ? "working" : there.mood;
  return "idle";
}
