import { mailRule } from "@/lib/permission";
import { botChatId, type AppState, type Bot, type BotSettings, type Message } from "@/lib/types";

/**
 * A bot's sequences (its settings page, components/app/sequences.tsx): what happens when mail, a call or a text comes
 * in, as a trigger, then steps, a switch and today's count. This build has only the four built in ones, which say what
 * Bops does today (lib/server/mail.ts, chat.ts, phone.ts, phone-voice.ts); a sequence of the user's own is to come.
 * Pure: the page and the tests read them alike.
 */

export type SeqId = "mailFromYou" | "othersMail" | "youCallOrText" | "othersCalls";
export type Step = { text: string; kind?: "trigger" | "ok" };
export type Today = { mailFromYou: number; othersMail: number; mailIn: number; replied: number; held: number; mailFailed: number; calls: number; ownerCalls: number; texts: number; taken: number; textFailed: number };

export type BuiltIn = {
  id: SeqId;
  channel: "email" | "phone";
  title: string;
  /** Always on (a Fact, not a setting): the switch is drawn on and can't be turned off. */
  locked?: boolean;
  /** On, by the bot's settings (BotSettings, settingsOf). */
  on: (s: BotSettings) => boolean;
  steps: (b: Pick<Bot, "autoApprove" | "permissions">, s: BotSettings) => Step[];
  count: (t: Today) => string;
  /** What the row says while it's off. */
  offLine?: string;
};

const today = (n: number) => `${n} today`;

export const BUILT_INS: readonly BuiltIn[] = [
  {
    id: "mailFromYou",
    channel: "email",
    title: "Mail from you",
    locked: true,
    on: () => true,
    // isFromOwner (DMARC), mail.ts; emailArrived answers by email, chat.ts.
    steps: () => [{ text: "From you", kind: "trigger" }, { text: "Checks it's really you" }, { text: "Does it" }, { text: "Emails you back" }],
    count: (t) => today(t.mailFromYou),
  },
  {
    id: "othersMail",
    channel: "email",
    title: "Everyone else",
    on: (s) => !s.sequencesOff?.othersMail,
    // receive and threadSoFar, mail.ts; emailArrived, chat.ts; replyEmail answers in the thread, as Replies to others says.
    steps: (b, s) => {
      const rule = mailRule(b, s);
      return [
        { text: "From anyone else", kind: "trigger" },
        { text: "Reads the thread" },
        { text: "Tells you in chat" },
        rule === "never" ? { text: "Never replies" } : rule === "allow" ? { text: "Replies in the thread on its own" } : { text: "Replies in the thread with your OK", kind: "ok" },
      ];
    },
    count: (t) => today(t.othersMail),
    offLine: "Off · their mail only shows in chat",
  },
  {
    id: "youCallOrText",
    channel: "phone",
    title: "You call or text",
    locked: true,
    on: () => true,
    // phone.ts (texts from the user), phone-voice.ts ownerTurn (calls).
    steps: () => [{ text: "From you", kind: "trigger" }, { text: "Talks with you" }, { text: "Starts the work" }, { text: "Notes it in chat" }],
    count: (t) => `${t.ownerCalls} ${t.ownerCalls === 1 ? "call" : "calls"} · ${t.texts} ${t.texts === 1 ? "text" : "texts"} today`,
  },
  {
    id: "othersCalls",
    channel: "phone",
    title: "Someone else calls",
    on: (s) => !s.sequencesOff?.othersCalls,
    // phone-voice.ts strangerTurn (take_message), phone.ts (a stranger's text isn't answered), the finish card's chime.
    steps: () => [{ text: "Someone else", kind: "trigger" }, { text: "Call: takes a message" }, { text: "Texts: not answered" }, { text: "Tells you in chat" }],
    count: (t) => `${t.taken} ${t.taken === 1 ? "message" : "messages"} taken today`,
    offLine: "Off · callers hear a short no",
  },
];

export const builtInsFor = (channel: "email" | "phone") => BUILT_INS.filter((s) => s.channel === channel);
/** How many of a channel's sequences are on (the locked ones count). */
export const onCount = (s: BotSettings, channel: "email" | "phone") => builtInsFor(channel).filter((x) => x.on(s)).length;

/** A call's card from someone else (phone-voice.ts finish): it starts with whether they left a message. */
const strangerCall = (m: Message) => /^(Left a message|Didn't leave a message\.)/.test(m.text);

/** Today's counts, from the bot's chat since local midnight (`now`'s day). */
export function todayOf(state: Pick<AppState, "messages">, b: Pick<Bot, "id">, now = Date.now()): Today {
  const start = new Date(now);
  start.setHours(0, 0, 0, 0);
  const chatId = botChatId(b.id);
  const t: Today = { mailFromYou: 0, othersMail: 0, mailIn: 0, replied: 0, held: 0, mailFailed: 0, calls: 0, ownerCalls: 0, texts: 0, taken: 0, textFailed: 0 };
  for (const m of state.messages) {
    if (m.chatId !== chatId || m.at < start.getTime() || m.at > now) continue;
    const e = m.email;
    if (e?.dir === "in") {
      t.mailIn++;
      if (e.fromOwner) t.mailFromYou++;
      else if (!e.bulk) t.othersMail++;
      if (e.held) t.held++;
    }
    if (e?.dir === "out" || (m.role === "bot" && m.emailed)) t.replied++;
    // Bops' own notes when a send failed (chat.ts emailArrived, mail.ts sendFailed, phone.ts).
    if (m.role === "system" && /^Couldn't (email this back to you|send this email)/.test(m.text)) t.mailFailed++;
    if (m.role === "system" && /^Couldn't text this back to you/.test(m.text)) t.textFailed++;
    if (m.call && m.sms) {
      t.calls++;
      if (strangerCall(m)) {
        if (m.ping) t.taken++;
      } else t.ownerCalls++;
    }
    if (m.role === "user" && m.via === "sms") t.texts++;
  }
  return t;
}
