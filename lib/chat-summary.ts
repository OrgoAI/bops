import type { Chat, Message } from "./types";

/*
 * A chat's summary of what its bots no longer read whole (Chat.summary) and its Compact: what the window and the
 * server agree on. Imported by both: no server imports here. Writing it is lib/server/chat-summary.ts.
 */

/** Whether a chat's bots read a message (chat.ts history): what was said, an email, a text, an app's answer, a CRM save; not Bops' other notes, nor Compact's line. */
export const heard = (m: Message) => m.role !== "system" || !!m.email || !!m.sms || !!m.appResult || !!m.crm;

/**
 * Where the chat was last compacted: when the newest message Compact folded in was said (Chat.summary.fresh), or, where
 * the window doesn't have the summary (a workspace shared with the user: only its owner's window does), when its newest
 * Compact line was left. 0: never.
 */
export function compactedAt(c: Pick<Chat, "id" | "summary">, messages: readonly Message[]): number {
  const line = messages.findLast((m) => m.chatId === c.id && m.compacted);
  return Math.max(c.summary?.fresh ?? 0, line?.at ?? 0);
}

/** Whether Compact has anything to fold in: a message the bots read whole since the chat was last compacted. */
export function toCompact(c: Pick<Chat, "id" | "summary">, messages: readonly Message[]): boolean {
  const since = compactedAt(c, messages);
  return messages.some((m) => m.chatId === c.id && heard(m) && m.at > since);
}

/** Why Compact can't go now, in the window's words, or null: a bot is answering, or there's nothing to fold in. */
export function compactBlocked(c: Pick<Chat, "id" | "summary" | "typing">, messages: readonly Message[], name: (botId: string) => string | undefined): string | null {
  if (c.typing.length) return `Wait for ${name(c.typing[0]) ?? "the bot"} to finish answering.`;
  if (!toCompact(c, messages)) return "Nothing new to compact.";
  return null;
}
