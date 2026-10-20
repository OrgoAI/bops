import type { CloudConvo, CloudConvoMessage, PeopleSync } from "@/cloud/protocol";
import type { AppState, Chat, Message, Person } from "@/lib/types";

/**
 * Conversations with people on Bops, as this Mac keeps them (lib/server/people.ts): how what Bops Cloud
 * sends goes into the state. No server-only imports, so scripts/test-people.mjs runs it as is.
 */

const CHAT_PREFIX = "people:";
export const peopleChatId = (convoId: string) => `${CHAT_PREFIX}${convoId}`;
export const nameOf = (p: Pick<Person, "name" | "email">) => p.name?.trim() || p.email?.split("@")[0] || "Someone";

/** A conversation's name for this user: its own, or who else is in it (and who was asked in). */
export function convoTitle(c: Pick<CloudConvo, "title" | "members" | "invited">, myId: string) {
  if (c.title) return c.title;
  const others = c.members.filter((m) => m.userId !== myId).map(nameOf);
  const asked = c.invited.map((e) => e.split("@")[0]);
  return [...others, ...asked].join(", ") || "Just you";
}

/**
 * Put what the cloud sent into the state: each conversation as a chat (made, or brought up to date), each
 * message once (one already here, the user's own sent from this Mac, gets its number and loses notSent).
 * `catchingUp`: the first read after a start, whose messages don't chime.
 */
export function applySync(s: Pick<AppState, "chats" | "messages">, sync: PeopleSync, catchingUp: boolean) {
  const myId = sync.me.userId;
  for (const c of sync.convos) {
    const chatId = peopleChatId(c.id);
    const people: NonNullable<Chat["people"]> = {
      convoId: c.id,
      kind: c.kind,
      members: c.members.map((m) => ({ userId: m.userId, name: m.name, email: m.email, readSeq: m.readSeq })),
      invited: c.invited,
      createdBy: c.createdBy,
      ...(c.left ? { left: true } : {}),
    };
    const there = s.chats.find((x) => x.id === chatId);
    if (there) Object.assign(there, { title: convoTitle(c, myId), people });
    else s.chats.push({ id: chatId, kind: "people", botIds: [], title: convoTitle(c, myId), createdAt: Date.now(), typing: [], people });
  }
  const known = new Map(s.messages.filter((m) => m.chatId.startsWith(CHAT_PREFIX)).map((m) => [m.id, m]));
  const names = new Map<string, string>();
  for (const ch of s.chats) for (const m of ch.people?.members ?? []) names.set(m.userId, nameOf(m));
  for (const m of sync.messages) {
    const had = known.get(m.id);
    if (had) {
      had.peopleSeq = m.seq;
      delete had.notSent;
      continue;
    }
    const added = fromCloud(m, myId, names.get(m.author) ?? "Someone", !catchingUp);
    s.messages.push(added);
    known.set(added.id, added);
  }
}

function fromCloud(m: CloudConvoMessage, myId: string, name: string, chime: boolean): Message {
  const mine = m.author === myId;
  const replyTo = typeof m.json?.replyTo === "string" ? m.json.replyTo : undefined;
  return {
    id: m.id,
    chatId: peopleChatId(m.convoId),
    role: mine ? "user" : "person",
    text: m.text,
    at: m.at,
    peopleSeq: m.seq,
    ...(mine ? {} : { from: { userId: m.author, name } }),
    ...(replyTo ? { replyTo } : {}),
    // Someone else's message that came in just now: a chime, and a notification if Bops is behind.
    ...(!mine && chime ? { ping: true } : {}),
  };
}
