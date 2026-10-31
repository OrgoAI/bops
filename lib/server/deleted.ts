import "server-only";
import { copyFileSync, existsSync, linkSync, mkdirSync, readdirSync, readFileSync, renameSync, rmSync, writeFileSync } from "node:fs";
import { basename, dirname, join } from "node:path";
import { DAY_MS, inUse, keepCutoff, pageIdsOf, privacyOf, threadAt, uploadIdsOf, type DeletedItem } from "@/lib/privacy";
import { botChatId, workspaceOf, type AppState, type Chat, type DeletedDays, type KeepDays, type Message, type Session } from "@/lib/types";
import { framePath } from "./frames";
import { dropPages, pagePath, pagesDir } from "./pages";
import { getState, id, update, userDir } from "./store";
import { refold } from "./chat-summary";
import { dropUploads, uploadPath, uploadsDir } from "./uploads";

/**
 * Recently deleted (Settings → Your data, AppState.privacy.deletedDays): with a number of days set, what the
 * user deletes (a message or several, a chat's every message, a finished thread with what it said in the chat,
 * a group chat, or Delete now's messages and threads as one) still goes from
 * the chat and from Bops Cloud at once, as a delete always did, but a copy stays on the Mac it was deleted
 * on, and only there, in the user's folder (.data/users/<id>/deleted/): one JSON file per delete, with a
 * folder beside it for the images its messages showed, the pages they linked to and its threads' last frames,
 * moved there (what a message still in the chats shows stays where it is too, linked, not copied). Orgo never has it. The
 * sweep (lib/server/privacy.ts) deletes each one for good once its days are up, or once the user's Keep chats
 * and calls would have taken it from the chats (a message older than that, a thread that last did anything
 * before it; a group chat's copy keeps the chat, as the chats do, and loses only those messages), but only by
 * choices this Mac knows are the user's latest (purgeExpiredDeleted: offline, they wait); Delete now does at
 * once, and choosing Gone at once deletes them all. What the user kept "between us" (Message.secret,
 * and a thread started for it, Session.secret) is never in a copy: it goes for good at once (remove.ts
 * leaveBehind), and so does everything on a hosted server, which is no one's Mac.
 *
 * Restore puts it back where it was, under the ids it had: Bops Cloud takes a message it holds as removed
 * (its row kept, json NULL, for other Macs to hear it went) as written again, with a new seq (cloud/state.ts
 * upsertMessages: NULL is distinct from anything), so every Mac and the iPhone read it as new and show it
 * again, and a reply to it, a tapback or a routine's report still finds it. A row swept since (after 30
 * days) is a new row, the same way. It goes back only to the chat and the bots it was with: each copy says
 * who they were then (Entry.chats, Entry.bots), and while it names a bot id, no new bot made on this Mac gets
 * that id (bots.ts freeBotId); one made since under it elsewhere is another bot, and Restore refuses.
 */

export type DeletedKind = DeletedItem["kind"];
/**
 * What a delete took: its messages (as they were), and for a thread the thread and the messages it left in the
 * chat with its chip taken off; for a group chat, the chat; for Delete now (kind "many"), its threads, each with
 * the messages it left with its chip taken off. `label`: what Settings lists it as, when its first message's
 * words wouldn't say it ("5 messages in Boppy's chat").
 */
export type Deleted = { messages: Message[]; session?: Session; stripped?: string[]; chat?: Chat; threads?: { session: Session; stripped: string[] }[]; label?: string };
/**
 * Which chat or bot it was: a chat by when it was made and its workspace, a bot by when its own chat was made
 * (a bot made later under the same id has a new one) and its workspace. Null: a bot already gone then.
 */
type Was = { createdAt: number; workspaceId: string } | null;
type Entry = Deleted & {
  id: string;
  kind: DeletedKind;
  /** When it was deleted. */
  at: number;
  /** The images' files in its folder (as uploads names them), and whether its thread's last frame is there. */
  files: string[];
  frame?: true;
  /** The pages its messages linked to, in its folder as <id>.html; and Delete now's threads' last frames there, as frame-<thread id>.jpg. */
  pages?: string[];
  frames?: string[];
  /** The chats its messages and thread were in, and every bot it names (namedBy), as they were when it was deleted. */
  chats: Record<string, Was>;
  bots: Record<string, Was>;
};

const ENTRY_ID = /^del_[a-z0-9]+$/i;
export const deletedDir = () => {
  const dir = userDir();
  return dir ? join(dir, "deleted") : null;
};

/** A file moved (another volume: copied, then the old one deleted). */
function move(from: string, to: string) {
  mkdirSync(dirname(to), { recursive: true });
  try {
    renameSync(/*turbopackIgnore: true*/ from, to);
  } catch {
    copyFileSync(/*turbopackIgnore: true*/ from, to);
    rmSync(/*turbopackIgnore: true*/ from, { force: true });
  }
}
/** A second name for a file (no second copy on disk), or a copy where a link can't be made. */
function link(from: string, to: string) {
  try {
    linkSync(/*turbopackIgnore: true*/ from, to);
  } catch {
    copyFileSync(/*turbopackIgnore: true*/ from, to);
  }
}

function read(dir: string, entryId: string): Entry | null {
  if (!ENTRY_ID.test(entryId)) return null;
  try {
    const e = JSON.parse(readFileSync(/*turbopackIgnore: true*/ join(dir, `${entryId}.json`), "utf8")) as Entry;
    return e && e.id === entryId && Array.isArray(e.messages) ? e : null;
  } catch {
    return null;
  }
}

/** A copy written whole or not at all: to a file beside it, then put in its place. */
function write(dir: string, e: Entry) {
  const file = join(dir, `${e.id}.json`);
  writeFileSync(/*turbopackIgnore: true*/ `${file}.tmp`, JSON.stringify(e), { mode: 0o600 });
  renameSync(/*turbopackIgnore: true*/ `${file}.tmp`, file);
}

/** Every copy in Recently deleted, newest first (the user's folder is theirs alone: user-paths.ts; anything unreadable is left alone). */
function entries(): Entry[] {
  const dir = deletedDir();
  if (!dir || !existsSync(dir)) return [];
  const out: Entry[] = [];
  for (const f of readdirSync(dir)) {
    if (!f.endsWith(".json")) continue;
    const e = read(dir, f.slice(0, -5));
    if (e) out.push(e);
  }
  return out.sort((a, b) => b.at - a.at);
}

/**
 * The bot ids a copy names: whoever wrote its messages, handed work on in them, answered in them or tapped
 * back on them, held a line in them (what bots.ts namedInHistory reads in the chats), its thread's bot and
 * whoever handed it on, and its group chat's bots.
 */
function namedBy(what: Deleted): Set<string> {
  const out = new Set<string>();
  for (const m of what.messages) {
    if (m.botId) out.add(m.botId);
    if (m.from) out.add(m.from);
    for (const a of m.asked ?? []) out.add(a.botId);
    for (const r of m.reactions ?? []) out.add(r.by);
    for (const h of m.held ?? []) out.add(h.botId);
  }
  for (const s of [what.session, ...(what.threads ?? []).map((t) => t.session)]) {
    if (!s) continue;
    out.add(s.botId);
    out.add(s.sentVia);
  }
  for (const b of what.chat?.botIds ?? []) out.add(b);
  // Two bots' talk with each other has no chat of its own: it's theirs.
  for (const m of what.messages) for (const b of pairOf(m.chatId) ?? []) out.add(b);
  return out;
}

/** The two bots of their talk with each other (lib/types.ts pairChatId), or null for any other chat. */
const pairOf = (chatId: string) => (chatId.startsWith("pair:") ? chatId.slice(5).split(":") : null);

const chatWas = (c: Chat | undefined): Was => (c ? { createdAt: c.createdAt, workspaceId: workspaceOf(c) } : null);
function botWas(st: Pick<AppState, "bots" | "chats">, botId: string): Was {
  const b = st.bots.find((x) => x.id === botId);
  const own = st.chats.find((c) => c.id === botChatId(botId));
  return b && own ? { createdAt: own.createdAt, workspaceId: workspaceOf(b) } : null;
}
/**
 * Whether the chat `chatId` here now is the one a copy was in (`was`): made then, in that workspace. Two bots'
 * talk with each other has no chat of its own: it's there while both its bots are the ones the copy names (`bots`).
 */
function sameChat(st: Pick<AppState, "chats" | "bots">, chatId: string, was: Was | undefined, bots: Record<string, Was> = {}): boolean {
  const pair = pairOf(chatId);
  if (pair) return pair.every((b) => sameBot(st, b, bots[b]));
  const c = st.chats.find((x) => x.id === chatId);
  return !!c && !!was && c.createdAt === was.createdAt && workspaceOf(c) === was.workspaceId;
}
/** Whether the bot `botId` here now is the one a copy names (`was`), not one made since under its id. */
function sameBot(st: Pick<AppState, "bots" | "chats">, botId: string, was: Was | undefined): boolean {
  const now = botWas(st, botId);
  return !!now && !!was && now.createdAt === was.createdAt && now.workspaceId === was.workspaceId;
}

/** Who the chats and bots a delete names were, now, while it's being kept (a group chat's own: it left the state already). */
function whereOf(what: Deleted): Pick<Entry, "chats" | "bots"> {
  const st = getState();
  const chats: Record<string, Was> = {};
  for (const chatId of new Set([...what.messages.map((m) => m.chatId), ...(what.session ? [what.session.chatId] : []), ...(what.threads ?? []).map((t) => t.session.chatId)]))
    chats[chatId] = what.chat?.id === chatId ? chatWas(what.chat) : chatWas(st.chats.find((c) => c.id === chatId));
  if (what.chat) chats[what.chat.id] = chatWas(what.chat);
  const bots: Record<string, Was> = {};
  for (const b of namedBy(what)) bots[b] = botWas(st, b);
  return { chats, bots };
}

/**
 * Keep a copy of what the user just deleted (it's gone from the state already), if they keep one
 * (deletedDays): its images go into its folder, but those a message still in the chats shows stay too
 * (linked); its thread's frame goes there. The copy is written whole before anything leaves where it was:
 * the images and the frame are linked in first, and only once its file is in place do they leave uploads
 * and the frames. The entry's id, or null when nothing was kept (signed out: no folder to keep it in), so the
 * caller deletes the images as with no copy; and when the copy can't be written (a full disk), nothing of it
 * is left, its folder neither, and it throws, for the caller to delete as with no copy too.
 */
export function keepDeleted(kind: DeletedKind, what: Deleted, now = Date.now()): string | null {
  const dir = deletedDir();
  if (!dir) return null;
  const entryId = id("del");
  const folder = join(dir, entryId);
  const pics = uploadIdsOf(what.messages);
  const linked = pageIdsOf(what.messages);
  const fp = what.session ? framePath(what.session.id) : null;
  const frame = !!fp && existsSync(/*turbopackIgnore: true*/ fp);
  // Delete now's threads' frames, each by its thread's id.
  const shots = (what.threads ?? []).map((t) => ({ id: t.session.id, path: framePath(t.session.id) })).filter((x): x is { id: string; path: string } => !!x.path && existsSync(/*turbopackIgnore: true*/ x.path));
  try {
    mkdirSync(folder, { recursive: true, mode: 0o700 });
    const files: string[] = [];
    for (const upId of pics) {
      const f = uploadPath(upId);
      if (!f) continue;
      link(f.path, join(folder, basename(f.path)));
      files.push(basename(f.path));
    }
    const pages: string[] = [];
    for (const pageId of linked) {
      const f = pagePath(pageId);
      if (!f) continue;
      link(f, join(folder, `${pageId}.html`));
      pages.push(pageId);
    }
    if (frame) link(fp!, join(folder, "frame.jpg"));
    for (const x of shots) link(x.path, join(folder, `frame-${x.id}.jpg`));
    write(dir, {
      id: entryId,
      kind,
      at: now,
      files,
      frame: frame || undefined,
      pages: pages.length ? pages : undefined,
      frames: shots.length ? shots.map((x) => x.id) : undefined,
      ...whereOf(what),
      ...structuredClone(what),
    });
  } catch (e) {
    rmSync(/*turbopackIgnore: true*/ folder, { recursive: true, force: true });
    rmSync(/*turbopackIgnore: true*/ join(dir, `${entryId}.json.tmp`), { force: true });
    throw e;
  }
  // The copy has them now: the images and pages nothing left shows any more leave where they were, and the frames the frames.
  try {
    const used = inUse(getState());
    dropUploads(pics, used.images);
    dropPages(linked, used.pages);
    if (frame) rmSync(/*turbopackIgnore: true*/ fp!, { force: true });
    for (const x of shots) rmSync(/*turbopackIgnore: true*/ x.path, { force: true });
  } catch (e) {
    console.warn(`[deleted] what the copy holds, where it was: ${(e as Error).message}`);
  }
  return entryId;
}

/** Every bot id a copy in Recently deleted on this Mac names (namedBy): no new bot made here gets one while it's kept (bots.ts freeBotId). */
export function botsNamedInDeleted(): Set<string> {
  const out = new Set<string>();
  try {
    for (const e of entries()) for (const b of Object.keys(e.bots ?? {})) out.add(b);
  } catch (e) {
    console.warn(`[deleted] reading Recently deleted for the bots it names: ${(e as Error).message}`);
  }
  return out;
}

/** Delete a copy for good: its file and its folder (the images and frame in it). Whether there was one. */
export function purgeDeleted(entryId: string): boolean {
  const dir = deletedDir();
  if (!dir || !read(dir, entryId)) return false;
  rmSync(/*turbopackIgnore: true*/ join(dir, entryId), { recursive: true, force: true });
  rmSync(/*turbopackIgnore: true*/ join(dir, `${entryId}.json`), { force: true });
  return true;
}

type Choices = { keepDays: KeepDays; deletedDays: DeletedDays };
/** What a copy keeps once the sweep takes the older part of it (fateOf). */
type Kept = { messages: Message[]; threads?: { session: Session; stripped: string[] }[] };

/** The thread a message of Delete now's copy went with (its result, or a note that only pointed at threads in it), if one. */
function threadOfMessage(m: Message, threads: ReadonlySet<string>): string | null {
  if (m.resultOf && threads.has(m.resultOf)) return m.resultOf;
  const ids = m.sessionIds ?? [];
  return ids.length && ids.every((x) => threads.has(x)) ? ids[0] : null;
}

/**
 * What the user's choices do to a copy now: "goes" for good when it's been kept deletedDays (at once with 0,
 * Gone at once), or when the Keep chats and calls sweep would have taken it from the chats: a message older
 * than keepDays, a thread that last did anything before it (lib/privacy.ts expiredThreads), all of Delete now's
 * messages and threads. Else, when some of its messages are older than that (a group chat's, a thread's
 * result, some of Delete now's, with the threads among them that did nothing since and what went with them),
 * the part it keeps: the sweep takes those from the chats and never the chat itself, nor a thread that did
 * something since. Null: as it is.
 */
function fateOf(e: Entry, { keepDays, deletedDays }: Choices, now: number): "goes" | Kept | null {
  if (e.at + deletedDays * DAY_MS <= now) return "goes";
  const cutoff = keepCutoff(keepDays, now);
  if (cutoff === null) return null;
  if (e.kind === "thread" ? !!e.session && threadAt(e.session) < cutoff : e.kind === "message" && e.messages.every((m) => (m.at ?? 0) < cutoff)) return "goes";
  if (e.kind === "many") {
    const threads = (e.threads ?? []).filter((t) => threadAt(t.session) >= cutoff);
    const all = new Set((e.threads ?? []).map((t) => t.session.id));
    const left = new Set(threads.map((t) => t.session.id));
    // A thread's result goes with it, and stays with it, whatever its own age.
    const messages = e.messages.filter((m) => {
      const t = threadOfMessage(m, all);
      return t ? left.has(t) : (m.at ?? 0) >= cutoff;
    });
    if (!messages.length && !threads.length) return "goes";
    return messages.length < e.messages.length || threads.length < (e.threads ?? []).length ? { messages, threads } : null;
  }
  const kept = e.messages.filter((m) => (m.at ?? 0) >= cutoff);
  return kept.length < e.messages.length ? { messages: kept } : null;
}

/** When a copy goes for good by the user's choices, as Settings says it: the sooner of its days and their keep (fateOf). */
function untilOf(e: Entry, { keepDays, deletedDays }: Choices): number {
  const until = e.at + deletedDays * DAY_MS;
  if (keepDays === null) return until;
  if (e.kind === "thread" && e.session) return Math.min(until, threadAt(e.session) + keepDays * DAY_MS);
  if ((e.kind === "message" || e.kind === "many") && (e.messages.length || e.threads?.length))
    return Math.min(until, Math.max(...e.messages.map((m) => m.at ?? 0), ...(e.threads ?? []).map((t) => threadAt(t.session))) + keepDays * DAY_MS);
  return until;
}

/** The files in a copy's folder that `messages` and `threads` still need: the images they show, the pages they link to, the threads' frames. */
function filesFor(e: Entry, messages: readonly Message[], threads: readonly { session: Session }[]) {
  const pics = uploadIdsOf(messages);
  const linked = pageIdsOf(messages);
  const ids = new Set(threads.map((t) => t.session.id));
  return {
    files: (e.files ?? []).filter((f) => pics.has(f.replace(/\.[a-z]+$/i, ""))),
    pages: (e.pages ?? []).filter((x) => linked.has(x)),
    frames: (e.frames ?? []).filter((x) => ids.has(x)),
  };
}

/** A copy without what the user keeps no longer (its older messages, Delete now's older threads): written again, and the files only they needed leave its folder. */
function trim(dir: string, e: Entry, kept: Kept) {
  const threads = kept.threads ?? e.threads;
  const need = filesFor(e, kept.messages, threads ?? []);
  write(dir, { ...e, messages: kept.messages, threads, files: need.files, pages: need.pages.length ? need.pages : undefined, frames: need.frames.length ? need.frames : undefined });
  dropFolderFiles(dir, e, need);
}

/** The files of a copy's folder no longer needed (`need`, as filesFor says), off it. */
function dropFolderFiles(dir: string, e: Entry, need: ReturnType<typeof filesFor>) {
  for (const f of e.files ?? []) if (!need.files.includes(f)) rmSync(/*turbopackIgnore: true*/ join(dir, e.id, basename(f)), { force: true });
  for (const x of e.pages ?? []) if (!need.pages.includes(x)) rmSync(/*turbopackIgnore: true*/ join(dir, e.id, `${basename(x)}.html`), { force: true });
  for (const x of e.frames ?? []) if (!need.frames.includes(x)) rmSync(/*turbopackIgnore: true*/ join(dir, e.id, `frame-${basename(x)}.jpg`), { force: true });
}

/** What a copy that was never written whole left (a full disk mid write): a folder with no file beside it, a file half written. */
function dropStrays(dir: string) {
  const names = new Set(readdirSync(/*turbopackIgnore: true*/ dir));
  for (const f of names)
    if (f.endsWith(".json.tmp") || (ENTRY_ID.test(f) && !names.has(`${f}.json`))) rmSync(/*turbopackIgnore: true*/ join(dir, f), { recursive: true, force: true });
}

/**
 * The copies whose time is up by the user's choices (fateOf), deleted for good, and the messages of the rest
 * that are older than they keep chats; and anything a copy never written whole left. How many went. Only ever
 * by choices known to be the user's latest, as a Mac offline may hold days or a keep they've since changed on
 * another Mac: the sweep's and an arrival's (privacy.ts choicesCurrent, heardChoices), Settings' when this Mac
 * is current (listDeleted, restoreDeleted with `current`: privacy.ts choicesFresh), and the days the user just
 * chose here, with no keep beside them (`choices`: privacy.ts setPrivacy).
 */
export function purgeExpiredDeleted(now = Date.now(), choices: Choices = privacyOf(getState())): number {
  const dir = deletedDir();
  if (!dir || !existsSync(/*turbopackIgnore: true*/ dir)) return 0;
  let n = 0;
  for (const e of entries()) {
    const fate = fateOf(e, choices, now);
    if (fate === "goes") n += purgeDeleted(e.id) ? 1 : 0;
    else if (fate) trim(dir, e, fate);
  }
  dropStrays(dir);
  return n;
}

/**
 * How many copies in Recently deleted on this Mac a change of the user's choices would delete now, whole or in
 * part (fateOf), as Settings says before it saves; after the ones whose time is up went, when this Mac is
 * current (listDeleted). Fewer days count by the days alone (`keepDays: null`), as setPrivacy deletes by them.
 */
export function deletedGoing(change: Partial<Choices>, now = Date.now()): number {
  const choices = { ...privacyOf(getState()), ...change };
  return entries().filter((e) => fateOf(e, choices, now) !== null).length;
}

/** "5 messages", "1 thread", "214 messages and 3 threads". */
const countOf = (messages: number, threads = 0) =>
  [messages ? `${messages} message${messages === 1 ? "" : "s"}` : "", threads ? `${threads} thread${threads === 1 ? "" : "s"}` : ""].filter(Boolean).join(" and ") || "Nothing";

/** What it was, in a line: its label, else the message's words (or its images, or how many when there are several), the thread's title, the group chat's name. */
function whatOf(e: Entry): string {
  if (e.label) return e.label;
  if (e.kind === "thread") return e.session?.title || e.session?.goal.slice(0, 48) || "A thread";
  if (e.kind === "chat") return e.chat?.title || "A group chat";
  if (e.kind === "many" || e.messages.length > 1) return countOf(e.messages.length, e.threads?.length);
  const m = e.messages[0];
  const words = m?.text?.replace(/\s+/g, " ").trim() ?? "";
  if (words) return words.length > 90 ? `${words.slice(0, 89)}…` : words;
  const pics = m?.images?.length ?? 0;
  return pics > 1 ? `${pics} images` : pics ? "An image" : "A message";
}

/**
 * Recently deleted as Settings lists it, newest first, each with when it goes by the choices this Mac has.
 * With `current` (they're known to be the user's latest: privacy.ts choicesFresh), the ones whose time is up
 * by them go first. Without, nothing goes, and each is listed as it is: one past its time by them says it goes
 * today, and goes, or stays, by what the user chose last once this Mac is current again (its sweep, or the
 * choices arriving: privacy.ts heardChoices). A Mac offline that still holds 7 days, when the user has since
 * chosen 30 on another Mac, never deletes a copy by the 7 as Settings opens.
 */
export function listDeleted(now = Date.now(), { current = false }: { current?: boolean } = {}): DeletedItem[] {
  if (current) purgeExpiredDeleted(now);
  const choices = privacyOf(getState());
  return entries().map((e) => ({
    id: e.id,
    kind: e.kind,
    what: whatOf(e),
    messages: e.messages.length,
    ...(e.threads?.length ? { threads: e.threads.length } : {}),
    at: e.at,
    until: untilOf(e, choices),
  }));
}

/** Delete every copy (the user chose Gone at once). */
export function purgeAllDeleted(): number {
  let n = 0;
  for (const e of entries()) if (purgeDeleted(e.id)) n++;
  return n;
}

/** A message into the list in time order (almost always near the end). */
function insertInOrder(list: Message[], m: Message) {
  let i = list.length;
  while (i > 0 && (list[i - 1].at ?? 0) > (m.at ?? 0)) i--;
  list.splice(i, 0, m);
}

/**
 * Many messages into the list, each where insertInOrder would put it, in one pass from the end (Delete now's
 * thousands back into a long list), the list's own order kept as it is.
 */
function insertAll(list: Message[], add: readonly Message[]) {
  if (add.length < 50) {
    for (const m of add) insertInOrder(list, m);
    return;
  }
  const coming = [...add].sort((a, b) => (a.at ?? 0) - (b.at ?? 0));
  const out: Message[] = [];
  let i = list.length;
  for (let j = coming.length - 1; j >= 0; j--) {
    const m = coming[j];
    while (i > 0 && (list[i - 1].at ?? 0) > (m.at ?? 0)) out.push(list[--i]);
    out.push(m);
  }
  while (i > 0) out.push(list[--i]);
  out.reverse();
  list.length = 0;
  for (const m of out) list.push(m);
}

/** Put back, `left`: how many of Delete now's messages and threads couldn't (their chat or bot is gone), still in Recently deleted. */
export type RestoreResult = { ok: true; left?: number } | { ok: false; status: number; error: string };

/**
 * A copy's files back where they were (uploads, pages, frames), for `messages` and `threads` going back: moved,
 * or, when what stays in the copy (`staying`) needs one too, linked, so it's in both.
 */
function filesBack(dir: string, e: Entry, going: ReturnType<typeof filesFor>, staying: ReturnType<typeof filesFor>) {
  const folder = join(dir, e.id);
  const put = (from: string, to: string, both: boolean) => {
    if (!existsSync(/*turbopackIgnore: true*/ from) || existsSync(/*turbopackIgnore: true*/ to)) return;
    if (both) {
      mkdirSync(dirname(to), { recursive: true });
      link(from, to);
    } else move(from, to);
  };
  const uploads = uploadsDir();
  if (uploads) for (const name of going.files) put(join(folder, name), join(uploads, name), staying.files.includes(name));
  const pages = pagesDir();
  if (pages) for (const x of going.pages) put(join(folder, `${x}.html`), join(pages, `${x}.html`), staying.pages.includes(x));
  for (const x of going.frames) {
    const fp = framePath(x);
    if (fp) put(join(folder, `frame-${x}.jpg`), fp, false);
  }
}

/** The state with a copy's sessions, chips and messages back (whatever of them is there already isn't doubled), and its group chat. */
function putBack(e: Entry, messages: readonly Message[], threads: readonly { session: Session; stripped: string[] }[]) {
  const bots = e.bots ?? {};
  update((s) => {
    if (e.chat && !s.chats.some((c) => c.id === e.chat!.id))
      s.chats.push({ ...e.chat, botIds: e.chat.botIds.filter((b) => sameBot(s, b, bots[b])), typing: [], asking: undefined });
    for (const t of threads) {
      if (!s.sessions.some((x) => x.id === t.session.id)) s.sessions.push(t.session);
      for (const m of s.messages) if (t.stripped.includes(m.id) && !m.sessionIds?.includes(t.session.id)) m.sessionIds = [...(m.sessionIds ?? []), t.session.id];
    }
    const have = new Set(s.messages.map((m) => m.id));
    const open = new Set(s.chats.map((c) => c.id));
    insertAll(
      s.messages,
      messages.filter((m) => !have.has(m.id) && (open.has(m.chatId) || pairOf(m.chatId))),
    );
  });
  // Back in their chat's summary too, when it had moved past them (chat-summary.ts): written again with them.
  refold(messages);
}

/**
 * Delete now's copy back (kind "many"): every message and thread whose chat and bots are still the ones it was
 * with, as restoreDeleted checks one; the rest stay in Recently deleted, with what they need of its files (a
 * thread's result stays or goes with its thread). Refused, all kept, when none can go back.
 */
function restoreMany(dir: string, e: Entry): RestoreResult {
  const st = getState();
  const bots = e.bots ?? {};
  const chats = e.chats ?? {};
  const remade = (b: string) => st.bots.some((x) => x.id === b) && !sameBot(st, b, bots[b]);
  const fits = (what: Deleted) => ![...namedBy(what)].some(remade);
  const all = e.threads ?? [];
  const threads = all.filter((t) => sameBot(st, t.session.botId, bots[t.session.botId]) && sameChat(st, t.session.chatId, chats[t.session.chatId], bots) && fits({ messages: [], session: t.session }));
  const allIds = new Set(all.map((t) => t.session.id));
  const back = new Set(threads.map((t) => t.session.id));
  const messages = e.messages.filter((m) => {
    const t = threadOfMessage(m, allIds);
    return (t ? back.has(t) : true) && sameChat(st, m.chatId, chats[m.chatId], bots) && fits({ messages: [m] });
  });
  if (!messages.length && !threads.length) return { ok: false, status: 409, error: "Their chats or bots are gone, so they can't go back." };
  const going = new Set(messages);
  const leftMessages = e.messages.filter((m) => !going.has(m));
  const leftThreads = all.filter((t) => !back.has(t.session.id));
  const staying = filesFor(e, leftMessages, leftThreads);
  // The files first, so the messages show them as they come back.
  filesBack(dir, e, filesFor(e, messages, threads), staying);
  putBack(e, messages, threads);
  const left = leftMessages.length + leftThreads.length;
  if (!left) {
    purgeDeleted(e.id);
    return { ok: true };
  }
  write(dir, { ...e, messages: leftMessages, threads: leftThreads, files: staying.files, pages: staying.pages.length ? staying.pages : undefined, frames: staying.frames.length ? staying.frames : undefined });
  dropFolderFiles(dir, e, staying);
  return { ok: true, left };
}

/**
 * Put a copy back where it was, and it leaves Recently deleted. A message goes back into its chat; a thread
 * back with its bot, its words back in the chat and its chip back on the messages that had it; a group chat
 * back with the bots of it that are still here; Delete now's, as much of it as can (restoreMany). Only to the
 * very chat and bots it was with (sameChat, sameBot): refused, and kept, when where it goes is gone or is
 * another one now: its chat (a bot deleted since takes its chat; one made since under its id has another), the
 * thread's bot or its chat, all but one of a group's bots, or any bot it names, made again since under the same
 * id (its lines would read as that one's, and show to whoever has it in a shared workspace). One whose time is
 * up isn't there to restore (purgeExpiredDeleted first), but only by choices known to be the user's latest
 * (`current`: privacy.ts choicesFresh): on a Mac that isn't current, a copy past its time by what this Mac holds
 * goes back as the user asks, as it would if they'd since kept copies longer on another Mac, and nothing goes by
 * those choices (back in the chats, the sweep takes it, once current, only if the keep the user chose last
 * does). Whatever of it is in the chats already isn't doubled. Back in the state, it goes up to Bops Cloud with
 * the next save as written again (its removed row, a new seq), so every Mac and the iPhone show it again.
 */
export function restoreDeleted(entryId: string, { current = false }: { current?: boolean } = {}): RestoreResult {
  const dir = deletedDir();
  if (dir && current) purgeExpiredDeleted();
  const e = dir ? read(dir, entryId) : null;
  if (!dir || !e) return { ok: false, status: 404, error: "That isn't in Recently deleted anymore." };
  if (e.kind === "many") return restoreMany(dir, e);
  const st = getState();
  const bots = e.bots ?? {};
  const chats = e.chats ?? {};
  const chatGone = { ok: false, status: 409, error: "Its chat is gone, so it can't go back." } as const;
  if (e.kind === "chat") {
    const left = (e.chat?.botIds ?? []).filter((b) => sameBot(st, b, bots[b]));
    if (!e.chat || (left.length < 2 && !sameChat(st, e.chat.id, chats[e.chat.id]))) return { ok: false, status: 409, error: "Its bots are gone, so it can't go back." };
  } else if (e.kind === "thread") {
    if (!e.session || !sameBot(st, e.session.botId, bots[e.session.botId])) return { ok: false, status: 409, error: "Its bot is gone, so it can't go back." };
    if (![e.session.chatId, ...e.messages.map((m) => m.chatId)].every((c) => sameChat(st, c, chats[c], bots))) return chatGone;
  } else if (!e.messages.length || !e.messages.every((m) => sameChat(st, m.chatId, chats[m.chatId], bots))) return chatGone;
  // A bot it names that's here now under that id, but made since: what it holds would read as that bot's.
  if (Object.keys(bots).some((b) => st.bots.some((x) => x.id === b) && !sameBot(st, b, bots[b]))) return { ok: false, status: 409, error: "A bot in it is gone, so it can't go back." };
  // The images, pages and the frame first, so the messages show them as they come back.
  const none = { files: [], pages: [], frames: [] };
  filesBack(dir, e, { files: e.files ?? [], pages: e.pages ?? [], frames: [] }, none);
  const fp = e.session ? framePath(e.session.id) : null;
  const folder = join(dir, entryId);
  if (e.frame && fp && existsSync(/*turbopackIgnore: true*/ join(folder, "frame.jpg")) && !existsSync(/*turbopackIgnore: true*/ fp)) move(join(folder, "frame.jpg"), fp);
  putBack(e, e.messages, e.session ? [{ session: e.session, stripped: e.stripped ?? [] }] : []);
  purgeDeleted(entryId);
  return { ok: true };
}
