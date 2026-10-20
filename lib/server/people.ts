import "server-only";
import type { PeopleSync } from "@/cloud/protocol";
import { applySync, nameOf, peopleChatId } from "@/lib/people-sync";
import type { Chat, Message, Person } from "@/lib/types";
import { cloudJson, cloudOn } from "./cloud";
import { addMessage, chat, getState, id, sameState, update } from "./store";

/**
 * Conversations with other people on Bops, one to one and in groups. They live in Bops Cloud
 * (cloud/people.ts), once for everyone in them; this Mac mirrors the user's into its state as chats of
 * kind "people" (Chat.people), so they show and are written like any chat:
 *
 * - What changed comes down from where this Mac last left off (GET /v1/people/sync?after=): when it
 *   starts, when the tunnel connects, and whenever the cloud says something changed (a "people" frame,
 *   cloud-tunnel.ts). The cloud's message ids are the senders' own, so nothing comes in twice.
 * - The user's message shows at once and goes up (POST /v1/people/send); if it can't, it says so and
 *   can go again.
 * - Someone typing is told by the cloud and held here a few seconds, never kept.
 */

export { peopleChatId };
export const isPeopleChat = (c: Pick<Chat, "kind"> | undefined): c is Chat & { people: NonNullable<Chat["people"]> } => c?.kind === "people";

type Box = { user?: string; seq: number; pulling?: Promise<void>; again?: boolean; typing: Map<string, Map<string, number>>; lastTyped: Map<string, number> };
const g = globalThis as unknown as { bopsPeople?: Box };
const box: Box = (g.bopsPeople ??= { seq: 0, typing: new Map(), lastTyped: new Map() });

const me = () => getState().account?.user.id ?? "";

/**
 * Read what changed in the user's conversations and put it in the state. One read at a time; asked again
 * while one runs, it runs once more after. `chime`: messages from others that come in now ping (not the
 * first read after a start, which only catches up).
 */
export function pullPeople(): Promise<void> {
  if (!cloudOn()) return Promise.resolve();
  if (box.pulling) {
    box.again = true;
    return box.pulling;
  }
  box.pulling = (async () => {
    try {
      do {
        box.again = false;
        await pullOnce();
      } while (box.again);
    } catch (e) {
      console.warn(`[people] couldn't read conversations: ${(e as Error).message}`);
    } finally {
      box.pulling = undefined;
    }
  })();
  return box.pulling;
}

async function pullOnce() {
  const ours = sameState();
  // Another account signed in: start over from nothing.
  if (box.user !== me()) {
    box.user = me();
    box.seq = 0;
  }
  const catchingUp = box.seq === 0;
  for (let page = 0; page < 20; page++) {
    const sync = await cloudJson<PeopleSync>(`/v1/people/sync?after=${box.seq}`);
    if (!ours() || box.user !== me()) return;
    apply(sync, catchingUp);
    box.seq = sync.seq;
    if (!sync.more) return;
  }
}

/** Put what the cloud sent into the state (lib/people-sync.ts). */
function apply(sync: PeopleSync, catchingUp: boolean) {
  if (!sync.convos.length && !sync.messages.length) return;
  update((s) => applySync(s, sync, catchingUp));
}

/** Send the user's message to a conversation: it shows at once, and says so if it couldn't go (sendAgain tries again). */
export async function sendToPeople(chatId: string, text: string, replyTo?: string) {
  const c = chat(chatId);
  if (!isPeopleChat(c)) throw new Error("That isn't a conversation with people.");
  // Out of it: the message stays here, saying why it didn't go.
  if (c.people.left) return addMessage({ chatId, role: "user", text, notSent: "You left this conversation." });
  const mine = addMessage({ chatId, role: "user", text, ...(replyTo ? { replyTo } : {}) });
  await upload(mine);
  return mine;
}

/** Try a message that didn't go again. */
export async function sendAgain(messageId: string) {
  const m = getState().messages.find((x) => x.id === messageId && x.role === "user" && x.notSent);
  if (m) await upload(m);
}

async function upload(m: Message) {
  const c = chat(m.chatId);
  if (!isPeopleChat(c)) return;
  try {
    const r = await cloudJson<{ seq: number }>("/v1/people/send", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ convoId: c.people.convoId, id: m.id, text: m.text, ...(m.replyTo ? { json: { replyTo: m.replyTo } } : {}) }),
    });
    update((s) => {
      const x = s.messages.find((y) => y.id === m.id);
      if (!x) return;
      if (r.seq) x.peopleSeq = r.seq;
      delete x.notSent;
    });
  } catch (e) {
    update((s) => {
      const x = s.messages.find((y) => y.id === m.id);
      if (x) x.notSent = (e as Error).message;
    });
  }
}

/** The user read a conversation to its newest message: the others see "Seen". */
export async function readPeople(chatId: string) {
  const c = chat(chatId);
  if (!isPeopleChat(c) || c.people.left) return;
  const newest = Math.max(0, ...getState().messages.filter((m) => m.chatId === chatId && m.peopleSeq).map((m) => m.peopleSeq!));
  const mine = c.people.members.find((m) => m.userId === me());
  if (!newest || (mine?.readSeq ?? 0) >= newest) return;
  await cloudJson("/v1/people/read", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ convoId: c.people.convoId, seq: newest }) }).catch(() => {});
}

/** The user is typing here: told to the others, at most every few seconds. */
export async function typingInPeople(chatId: string) {
  const c = chat(chatId);
  if (!isPeopleChat(c) || c.people.left) return;
  if (Date.now() - (box.lastTyped.get(chatId) ?? 0) < 3000) return;
  box.lastTyped.set(chatId, Date.now());
  await cloudJson("/v1/people/typing", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ convoId: c.people.convoId }) }).catch(() => {});
}

/** Someone's typing in a conversation (the cloud said): who, for a few seconds. */
export function someoneTyping(convoId: string, userId: string) {
  const chatId = peopleChatId(convoId);
  const now = new Map(box.typing.get(chatId) ?? []);
  now.set(userId, Date.now() + 6000);
  box.typing.set(chatId, now);
  // The app reads typing with the state (/api/state): a change it hears about, now and when it runs out.
  update(() => {});
  setTimeout(() => update(() => {}), 6500).unref?.();
}

/** Who's typing in each conversation now (names), for the app; nothing older than a few seconds. */
export function typingNow(): Record<string, string[]> {
  const out: Record<string, string[]> = {};
  const t = Date.now();
  for (const [chatId, who] of box.typing) {
    const c = chat(chatId);
    const names = [...who].filter(([, until]) => until > t).map(([userId]) => nameOf(c?.people?.members.find((m) => m.userId === userId) ?? { name: null, email: null }));
    if (names.length) out[chatId] = names;
  }
  return out;
}

/** Start a conversation with people (emails, or user ids from conversations before): its chat's id. */
export async function startPeopleChat(ask: { emails?: string[]; userIds?: string[]; title?: string }) {
  const r = await cloudJson<{ convoId: string; invited: string[] }>("/v1/people/convos", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(ask),
  });
  await pullPeople();
  return { chatId: peopleChatId(r.convoId), invited: r.invited };
}

/** Add people to a group, take someone out, leave, or rename it. */
export async function changePeople(chatId: string, ask: { add?: string[]; remove?: string; leave?: boolean; title?: string }) {
  const c = chat(chatId);
  if (!isPeopleChat(c)) throw new Error("That isn't a conversation with people.");
  const r = await cloudJson<{ invited?: string[] }>("/v1/people/members", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ convoId: c.people.convoId, ...ask }),
  });
  await pullPeople();
  return r;
}

/** Someone on Bops by their email, to start a conversation with. */
export const findPerson = (email: string) =>
  cloudJson<{ person: Person | null }>("/v1/people/find", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ email }) }).then((r) => r.person);

/** People the user has conversations with: who to suggest when starting another. */
export function knownPeople(): Person[] {
  const myId = me();
  const seen = new Map<string, Person>();
  for (const c of getState().chats) for (const p of c.people?.members ?? []) if (p.userId !== myId && !seen.has(p.userId)) seen.set(p.userId, { userId: p.userId, name: p.name, email: p.email });
  return [...seen.values()];
}

export const newMessageId = () => id("msg");
