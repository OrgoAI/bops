import { draftStatus } from "./reply-drafts";
import { live, pausedForOk, type AppState, type DeletedDays, type KeepDays, type Message, type Session } from "./types";

/**
 * Settings → Your data (AppState.privacy): how long chats and calls are kept, what a delete leaves behind,
 * and what the window is told about where the user's things are. Shared by the window and the server; no
 * server imports. The sweep, the copies of what was deleted and this Mac's numbers are lib/server/privacy.ts
 * and lib/server/deleted.ts.
 */

export const DAY_MS = 24 * 3600_000;

/** Keep chats and calls: until the user deletes them, a year, 90 days, 30 days (the order Settings lists them in). */
export const KEEP_OPTIONS: readonly KeepDays[] = [null, 365, 90, 30];
/** When the user deletes something: gone at once, or a copy kept on this Mac 7 or 30 days. */
export const DELETED_OPTIONS: readonly DeletedDays[] = [0, 7, 30];

export const isKeepDays = (v: unknown): v is KeepDays => v === null || v === 30 || v === 90 || v === 365;
export const isDeletedDays = (v: unknown): v is DeletedDays => v === 0 || v === 7 || v === 30;
/** The longest this Bops keeps what the user deletes: what a deletedDays it doesn't know is read as. */
export const DELETED_LONGEST: DeletedDays = 30;

/**
 * The user's choices with what an unset one means: chats kept until the user deletes them, and what they
 * delete gone at once, as before there was a choice. One this Bops doesn't know (a newer Bops offers more, or
 * it was written by hand) is read as what keeps the most of the user's things, never as what deletes them:
 * chats kept until the user deletes them, and what they delete kept the longest this Bops offers (30 days),
 * so a Mac not updated yet never sweeps or purges by a choice the user didn't make.
 */
export function privacyOf(state: Pick<AppState, "privacy"> | null | undefined): { keepDays: KeepDays; deletedDays: DeletedDays } {
  const p = state?.privacy;
  const d = p?.deletedDays;
  return { keepDays: isKeepDays(p?.keepDays) ? p.keepDays : null, deletedDays: d === undefined ? 0 : isDeletedDays(d) ? d : DELETED_LONGEST };
}

/** Whether `next` keeps things for less time than `now` does (so choosing it deletes some): null is for good. */
export const keepsLess = (now: KeepDays, next: KeepDays) => next !== null && (now === null || next < now);

/** The oldest time `keepDays` keeps (anything before it goes), or null when everything is kept. */
export const keepCutoff = (keepDays: KeepDays, now = Date.now()) => (keepDays === null ? null : now - keepDays * DAY_MS);

/** The threads still going, or paused for the user's OK (lib/types.ts pausedForOk), by id: what's about them is in use. */
export const busyThreads = (state: Pick<AppState, "sessions" | "appApprovals">) => new Set(state.sessions.filter((s) => live(s) || pausedForOk(s, state)).map((s) => s.id));

/**
 * The images a busy thread works from, by upload id: a task started from a message with images is handed
 * where they are on this Mac in its goal (chat.ts withImages), so the message it was started from, and those
 * files, are in use while it is, though only the bot's reply carries the thread's chip.
 */
export function busyImages(state: Pick<AppState, "sessions">, busy: ReadonlySet<string>): Set<string> {
  return new Set(state.sessions.filter((s) => busy.has(s.id)).flatMap((s) => s.goal.match(/\bimg_[a-z0-9]+/gi) ?? []));
}

/** When a thread last did anything: its start, its steps, its replies, its end. */
export function threadAt(s: Pick<Session, "createdAt" | "startedAt" | "endedAt" | "steps" | "replies">): number {
  let at = Math.max(s.createdAt ?? 0, s.startedAt ?? 0, s.endedAt ?? 0);
  for (const x of s.steps ?? []) at = Math.max(at, x.at ?? 0);
  for (const r of s.replies ?? []) at = Math.max(at, r.at ?? 0);
  return at;
}

/**
 * Why a message older than the user keeps stays anyway this time (null: it goes). What a sweep must never
 * take:
 * - what a thread that's still going, or paused for the user's OK, started or reports on (its chips, its
 *   result, the note that it's on it; `busy`: busyThreads), and the message whose images it works from
 *   (`pics`: busyImages): the thread is in use now, and the first sweep after it ended takes them;
 * - a message whose reply draft is being sent right now (the user pressed Send on it within the minute or
 *   two a Send has: lib/reply-drafts.ts): the send writes what went back into the message once it's done.
 * A reply draft never sent goes with its message, like anything else in the chat: it's the bot's words about
 * an email or a thread read that long ago, and keeping it would keep the message past what the user chose.
 */
export function heldBack(m: Message, busy: ReadonlySet<string>, now = Date.now(), pics: ReadonlySet<string> = new Set()): string | null {
  if ((m.resultOf && busy.has(m.resultOf)) || m.sessionIds?.some((x) => busy.has(x)) || m.images?.some((i) => pics.has(i.id))) return "thread";
  if (m.drafts?.some((d) => draftStatus(d, now) === "sending")) return "sending";
  return null;
}

/** The messages a keep of `keepDays` deletes now: older than it, in time order, but none heldBack. */
export function expiredMessages(state: Pick<AppState, "messages" | "sessions" | "appApprovals">, keepDays: KeepDays, now = Date.now()): Message[] {
  const cutoff = keepCutoff(keepDays, now);
  if (cutoff === null) return [];
  const busy = busyThreads(state);
  const pics = busyImages(state, busy);
  return state.messages.filter((m) => (m.at ?? 0) < cutoff && !heldBack(m, busy, now, pics));
}

/**
 * The threads a keep of `keepDays` deletes now: finished ones (never one still going or paused for the
 * user's OK, nor one a busy thread carries on from or was split off: Session.movedFrom, partOf) that last did
 * anything before it (threadAt), with their goal, replies, steps and result, as the user's own delete of a
 * thread takes them (lib/server/remove.ts deleteThreads).
 */
export function expiredThreads(state: Pick<AppState, "sessions" | "appApprovals">, keepDays: KeepDays, now = Date.now()): Session[] {
  const cutoff = keepCutoff(keepDays, now);
  if (cutoff === null) return [];
  const busy = busyThreads(state);
  const named = new Set(state.sessions.filter((s) => busy.has(s.id)).flatMap((s) => [s.movedFrom, s.partOf].filter((x): x is string => !!x)));
  return state.sessions.filter((s) => !busy.has(s.id) && !named.has(s.id) && threadAt(s) < cutoff);
}

/** The images messages show (Message.images), by upload id. */
export const uploadIdsOf = (messages: readonly Message[]) => new Set(messages.flatMap((m) => (m.images ?? []).map((i) => i.id)));

/** The pages bots made (lib/server/pages.ts) that messages link to (/api/pages/page_…), by id. */
export const pageIdsOf = (messages: readonly Message[]) => new Set(messages.flatMap((m) => m.text?.match(/\bpage_[a-z0-9]+/gi) ?? []));

/**
 * What's still in use on this Mac, so a delete never takes it: the images the messages left show and the ones a
 * busy thread works from (busyImages), and the pages those messages or a thread's own words (its goal, its
 * replies) link to.
 */
export function inUse(state: Pick<AppState, "messages" | "sessions" | "appApprovals">): { images: Set<string>; pages: Set<string> } {
  const images = new Set([...uploadIdsOf(state.messages), ...busyImages(state, busyThreads(state))]);
  const pages = pageIdsOf(state.messages);
  for (const s of state.sessions) for (const t of [s.goal, ...(s.replies ?? []).map((r) => r.text)]) for (const p of t?.match(/\bpage_[a-z0-9]+/gi) ?? []) pages.add(p);
  return { images, pages };
}

/**
 * Delete now (Settings → Your data, beside Keep chats and calls): everything (null), or what's older than a
 * year, 90 or 30 days, in every workspace's chats, or one bot's only (`bot`: its own chat with the user, its
 * talks with the other bots, and its threads with what they said in any chat).
 */
export const CLEAR_OPTIONS: readonly KeepDays[] = [null, 365, 90, 30];
export type ClearChoice = { olderThan: KeepDays; bot?: string };
/** The time Delete now deletes before: now for everything, else as a keep of that many days would. */
export const clearCutoff = (olderThan: KeepDays, now = Date.now()) => (olderThan === null ? Infinity : now - olderThan * DAY_MS);
/** Whether a chat is one bot's own (with the user, or with another bot): what Delete now for that bot takes. */
const botsChat = (chatId: string, bot: string) => chatId === `bot:${bot}` || (chatId.startsWith("pair:") && chatId.slice(5).split(":").includes(bot));

/** The messages Delete now takes: older than its cutoff, in the bot's chats when it names one, but none heldBack (as the sweep's). */
export function clearedMessages(state: Pick<AppState, "messages" | "sessions" | "appApprovals">, choice: ClearChoice, now = Date.now()): Message[] {
  const cutoff = clearCutoff(choice.olderThan, now);
  const busy = busyThreads(state);
  const pics = busyImages(state, busy);
  return state.messages.filter((m) => (m.at ?? 0) < cutoff && (!choice.bot || botsChat(m.chatId, choice.bot)) && !heldBack(m, busy, now, pics));
}

/** The threads Delete now takes: finished ones that last did anything before its cutoff (expiredThreads' rules), the bot's when it names one. */
export function clearedThreads(state: Pick<AppState, "sessions" | "appApprovals">, choice: ClearChoice, now = Date.now()): Session[] {
  const cutoff = clearCutoff(choice.olderThan, now);
  const busy = busyThreads(state);
  const named = new Set(state.sessions.filter((s) => busy.has(s.id)).flatMap((s) => [s.movedFrom, s.partOf].filter((x): x is string => !!x)));
  return state.sessions.filter((s) => !busy.has(s.id) && !named.has(s.id) && threadAt(s) < cutoff && (!choice.bot || s.botId === choice.bot));
}

/**
 * Everything Delete now takes from the state, by id: its messages (clearedMessages) and threads (clearedThreads),
 * and with each thread its result and the note that only pointed at it ("On it."), wherever they are, as
 * lib/server/remove.ts deleteThreads takes them.
 */
export function clearPlan(state: Pick<AppState, "messages" | "sessions" | "appApprovals">, choice: ClearChoice, now = Date.now()): { messages: Set<string>; threads: Set<string> } {
  const threads = new Set(clearedThreads(state, choice, now).map((s) => s.id));
  const messages = new Set(clearedMessages(state, choice, now).map((m) => m.id));
  for (const m of state.messages) {
    if (m.resultOf && threads.has(m.resultOf)) messages.add(m.id);
    else if (m.sessionIds?.length && m.sessionIds.every((x) => threads.has(x)) && m.role === "bot" && m.text.length < 40) messages.add(m.id);
  }
  return { messages, threads };
}

/**
 * What Delete now takes, as Settings says before it asks: the messages and threads (from Bops Cloud and every
 * Mac); for every bot, this Mac's own too, as the sweep's: its files (images, pages, last screens) older than the
 * cutoff that no message left shows, and the lines of its call notes and model choices older than it.
 */
export type ClearGoes = ClearChoice & { messages: number; threads: number; files: number; lines: number };

/** A count of this Mac's files: how many (none for a single file) and their size; `more` when the count stopped at its cap. */
export type HereCount = { count?: number; bytes: number; more?: true };

/** What's in Recently deleted, as Settings lists it: what it was, when it was deleted and when it goes for good (the sooner of its days and the user's keep). */
export type DeletedItem = { id: string; kind: "message" | "thread" | "chat" | "many"; what: string; messages: number; threads?: number; at: number; until: number };

/** GET /api/privacy (app/api/privacy/route.ts): the user's choices, this Mac's numbers, and Recently deleted. */
export type PrivacyInfo = {
  keepDays: KeepDays;
  deletedDays: DeletedDays;
  /** Chat messages in every workspace, as Bops Cloud keeps them for every Mac of the user's. */
  messages: number;
  /** This Mac's own: images in chats, pages bots made, call notes, last screens, bots' browser profiles, the router's notes. */
  here: { uploads: HereCount; pages: HereCount; calls: HereCount; frames: HereCount; chrome: HereCount; routes: HereCount };
  deleted: DeletedItem[];
  /** With ?keepDays=: what choosing it deletes now (KeepGoes). */
  goes?: KeepGoes;
  /** With ?deletedDays=: what choosing it deletes now from this Mac's Recently deleted (DeletedGoes). */
  goesDeleted?: DeletedGoes;
  /** With ?clear= (and &bot=): what Delete now deletes (ClearGoes). */
  goesNow?: ClearGoes;
  /** The bots Delete now can be for, one at a time: each with its workspace's name when there are more than one. */
  bots?: { id: string; name: string; workspace?: string }[];
  /** A sweep is under way (lib/server/privacy.ts): the numbers move as it goes, so the window reads them again soon. */
  sweeping?: true;
};

/**
 * What a shorter keep deletes now: messages and threads from Bops Cloud and every Mac; from this Mac, its
 * files (images, pages, last screens), the lines of its call notes and model choices, and the copies in its
 * Recently deleted that go whole or in part. Each Mac sweeps its own files the same way at its next check.
 */
export type KeepGoes = { keepDays: KeepDays; messages: number; threads: number; files: number; lines: number; copies: number };
/** What fewer days for what the user deletes takes from this Mac's Recently deleted now (the other Macs' go at their next check). */
export type DeletedGoes = { deletedDays: DeletedDays; copies: number };

/** Whether a shorter keep deletes anything now, as far as this Mac can tell. */
export const keepGoesAny = (g: KeepGoes) => g.messages + g.threads + g.files + g.lines + g.copies > 0;

/** A size as people say it: 0 KB, 340 KB, 1.2 MB, 3.4 GB. */
export function sizeOf(bytes: number): string {
  if (bytes < 1024 * 1024) return `${Math.ceil(bytes / 1024)} KB`;
  if (bytes < 1024 * 1024 * 1024) return `${(bytes / 1024 / 1024).toFixed(bytes < 10 * 1024 * 1024 ? 1 : 0)} MB`;
  return `${(bytes / 1024 / 1024 / 1024).toFixed(1)} GB`;
}

export const num = (n: number) => n.toLocaleString("en-US");
/** "1 message", "1,240 messages". */
export const many = (n: number, one: string, more = `${one}s`) => `${num(n)} ${n === 1 ? one : more}`;

/** "a, b and c". */
const listed = (parts: string[]) => (parts.length > 1 ? `${parts.slice(0, -1).join(", ")} and ${parts[parts.length - 1]}` : (parts[0] ?? ""));
const ageOf = (keepDays: KeepDays) => `older than ${keepDays === 365 ? "a year" : `${keepDays} days`}`;

/**
 * What a shorter keep deletes now, as Settings asks before it saves: the messages and threads from
 * everywhere, this Mac's own from this Mac. With `goes` null (Bops couldn't say), it still asks, in general.
 */
export function goesLine(keepDays: KeepDays, goes: KeepGoes | null) {
  const age = ageOf(keepDays);
  if (!goes) return `Bops couldn't check what this deletes now. Everything ${age} goes from Bops Cloud and all your Macs. It can't be undone.`;
  const all = listed([goes.messages ? many(goes.messages, "message") : "", goes.threads ? many(goes.threads, "thread") : ""].filter(Boolean));
  const mine = listed(
    [goes.files ? many(goes.files, "file") : "", goes.lines ? many(goes.lines, "line of notes", "lines of notes") : "", goes.copies ? `${many(goes.copies, "copy", "copies")} in Recently deleted` : ""].filter(Boolean),
  );
  const everywhere = all ? `${all} ${age} from Bops Cloud and all your Macs` : "";
  const here = mine ? `${mine}${all ? "" : ` ${age}`} from this Mac` : "";
  return `This deletes ${everywhere}${everywhere && here ? ", and " : ""}${here}. It can't be undone.`;
}

/**
 * What fewer days for what the user deletes takes, as Settings asks before it saves: this Mac's copies now,
 * and the other Macs' at their next check (copies stay on the Mac they were made on). With `goes` null (Bops
 * couldn't say how many), it still asks.
 */
export function deletedGoesLine(deletedDays: DeletedDays, goes: DeletedGoes | null) {
  const age = deletedDays ? ` older than ${deletedDays} days` : "";
  const here = !goes
    ? `This deletes the copies${age} in Recently deleted on this Mac now.`
    : goes.copies
      ? `This deletes ${many(goes.copies, "copy", "copies")}${age} in Recently deleted on this Mac now.`
      : "Nothing in Recently deleted on this Mac goes now.";
  return `${here} Copies${age} on your other Macs go at their next check. It can't be undone.`;
}

/**
 * What Delete now takes, as Settings asks before it goes (`bot`: the name of the bot it's for): the messages and
 * threads from everywhere, this Mac's own from this Mac; whether they can come back from Recently deleted
 * (`deletedDays`), which this Mac's files and notes never can; and that Knowledge keeps what it learned. With
 * `goes` null (Bops couldn't say), it still asks, in general.
 */
export function clearLine(goes: ClearGoes | null, deletedDays: DeletedDays, bot?: string) {
  const knowledge = " Knowledge keeps what it learned from them.";
  if (!goes) return `Bops couldn't check what this deletes. It deletes ${bot ? `${bot}'s messages and threads` : "your messages and threads"} from Bops Cloud and all your Macs.${knowledge}`;
  const age = goes.olderThan === null ? "" : ` ${ageOf(goes.olderThan)}`;
  const all = listed([goes.messages ? many(goes.messages, "message") : "", goes.threads ? many(goes.threads, "thread") : ""].filter(Boolean));
  const mine = listed([goes.files ? many(goes.files, "file") : "", goes.lines ? many(goes.lines, "line of notes", "lines of notes") : ""].filter(Boolean));
  if (!all && !mine) return `${bot ? `${bot} has nothing` : "There's nothing"}${age} to delete.`;
  const everywhere = all ? `${bot ? `${bot}'s ` : ""}${all}${age} from Bops Cloud and all your Macs` : "";
  const here = mine ? `${mine}${all ? "" : age} from this Mac` : "";
  const back = !all
    ? " It can't be undone."
    : deletedDays
      ? ` You can restore the messages and threads from Recently deleted on this Mac for ${deletedDays} days.${mine ? " The files and notes can't be restored." : ""}`
      : " It can't be undone.";
  return `This deletes ${everywhere}${everywhere && here ? ", and " : ""}${here}.${back}${all ? knowledge : ""}`;
}

/** Whether Delete now deletes anything, as far as this Mac can tell. */
export const clearGoesAny = (g: ClearGoes) => g.messages + g.threads + g.files + g.lines > 0;
