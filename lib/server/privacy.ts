import "server-only";
import { appendFileSync, closeSync, createReadStream, createWriteStream, existsSync, lstatSync, openSync, readdirSync, readSync, renameSync, rmSync, statSync, type Dirent } from "node:fs";
import { join } from "node:path";
import { createInterface } from "node:readline";
import { pipeline } from "node:stream/promises";
import {
  busyImages,
  busyThreads,
  clearCutoff,
  clearPlan,
  expiredMessages,
  expiredThreads,
  inUse,
  keepCutoff,
  keepsLess,
  pageIdsOf,
  privacyOf,
  uploadIdsOf,
  type ClearChoice,
  type ClearGoes,
  type HereCount,
  type KeepGoes,
  type PrivacyInfo,
} from "@/lib/privacy";
import { workspaceOf, type AppState, type DeletedDays, type KeepDays, type Message } from "@/lib/types";
import { sleptSince } from "./awake";
import { deletedGoing, listDeleted, purgeAllDeleted, purgeExpiredDeleted } from "./deleted";
import { dropFrame, framesDir } from "./frames";
import { dropPages, pagesDir } from "./pages";
import { loopHere, onPostgres } from "./persist";
import { deleteChats, deleteMessages, deleteThreads } from "./remove";
import {
  flushState,
  getState,
  pullState,
  removalsUp,
  sameState,
  stateEpoch,
  stateInCloud,
  statePulledAt,
  stateReady,
  stateTooNew,
  threadsUp,
  update,
  userChrome,
  userDir,
  userHome,
  watchArrivals,
  watchGone,
} from "./store";
import { dropUploads, uploadsDir } from "./uploads";

/**
 * Settings → Your data, on the server (the window's side and the rules are lib/privacy.ts; Recently deleted
 * is deleted.ts).
 *
 * Keep chats and calls (AppState.privacy.keepDays): every hour, and once soon after Bops starts or someone
 * signs in, the Mac (never a computer's runner, a hosted server, or a Bops signed out or older than the
 * state: sweepHere) deletes the chat messages older than that in every workspace's chats, and the finished
 * threads that last did anything before it (lib/privacy.ts expiredThreads), through the deletes a user's own
 * go through (remove.ts deleteMessages, deleteThreads), so they go from Bops Cloud and every Mac and the
 * iPhone hear it; for good, never into Recently deleted. A batch at a time, each in Bops Cloud before the
 * next goes, so a first sweep over years of chats is many small writes, not one that floods it (and stops,
 * to go on at the next hour, when the cloud doesn't take one). The same sweep prunes what only this Mac
 * keeps: the call notes (phone-calls.jsonl) and the router's notes (routes.jsonl) older than that, the last
 * frames of threads, and the images and pages older than that which no message left in the chats shows.
 * What's still in use stays until it isn't (lib/privacy.ts heldBack).
 *
 * It deletes only by choices this Mac knows are the user's latest (choicesCurrent): the state read from Bops Cloud
 * under 40 seconds ago, with no sleep since, read again first when it's older. A Mac offline, or just awake
 * and not back online, could hold a keep the user has since made longer on another Mac, and what it deleted
 * by it would go from every Mac when it's back: so offline it deletes nothing, and waits for the next hour.
 * Nor does Settings as it opens or restores: Recently deleted's copies whose time is up go first only when the
 * state is current as it stands (choicesFresh), and else are listed as they are. Choices that change arrive
 * from the other Macs (watchArrivals): a shorter keep sweeps then, and Recently deleted's copies go by the new
 * days at once. A delete made on another Mac, gone at once there (deletedDays 0), takes what this Mac kept
 * beside it too: the images only it showed, and the thread's last frame here.
 *
 * Where it's kept: this Mac's numbers for Settings (how many files and how much room each kind takes),
 * walked at most every 30 seconds, and never more than a capped number of files (a bot's Chrome profile
 * alone can hold tens of thousands).
 */

/** How the sweep paces itself, and how fresh a read of the state it deletes by (freshMs: choicesCurrent); tests shorten it. */
export const privacyTiming = { batch: 500, pauseMs: 2_000, flushMs: 60_000, firstMs: 90_000, everyMs: 3600_000, freshMs: 40_000 };

/**
 * The store as the sweep asks it whether this Mac's state is current (choicesCurrent), and whether what a batch
 * deleted is in Bops Cloud (inBatches: its messages' removal, its threads gone from the cloud's copy); tests
 * stand in for it.
 */
export const privacyStore = { inCloud: stateInCloud, pulledAt: statePulledAt, pull: pullState, messagesUp: removalsUp, threadsUp };

const g = globalThis as unknown as {
  __bopsPrivacyTimer?: ReturnType<typeof setInterval>;
  __bopsPrivacyStarted?: string;
  __bopsPrivacySweep?: Promise<SweepResult>;
  __bopsPrivacyHere?: { key: string; at: number; here: PrivacyInfo["here"] };
  __bopsPrivacyHeard?: Heard;
};

export type SweepResult = { messages: number; threads: number; files: number; lines: number; deleted: number };
/** The user's choices as this Mac last knew them, and whose (their folder): what heardChoices tells a change by. */
type Heard = { dir: string | null; keepDays: KeepDays; deletedDays: DeletedDays };
const heardNow = (): Heard => ({ dir: userDir(), ...privacyOf(getState()) });

/** Whether this Bops sweeps: the Mac's (never a computer's runner, nor a hosted server), signed in, with a state no newer Bops wrote. */
const sweepHere = () => loopHere("privacy") && !onPostgres() && stateReady() && !stateTooNew() && !!getState().account;
const warn = (e: Error) => console.warn(`[privacy] ${e.message}`);
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

/**
 * Whether this Mac's state, and so the user's choices in it, is current with Bops Cloud as it stands, without
 * reading it again: read in full under freshMs ago with no sleep since. A store that keeps the state nowhere
 * else (a self-hosted install) is current. What Settings does as it opens goes by this (Recently deleted's
 * copies whose time is up go first only when it's true: privacyInfo, the route's restore): a window opened on
 * a Mac offline, holding days or a keep the user has since changed on another Mac, never deletes by them.
 */
export function choicesFresh(): boolean {
  const s = privacyStore;
  if (!s.inCloud()) return true;
  const at = s.pulledAt();
  return at > 0 && Date.now() - at < privacyTiming.freshMs && !sleptSince(at);
}

/**
 * Whether this Mac's state is current with Bops Cloud (choicesFresh), read again now when it isn't. False
 * offline (the read fails), and then the sweep deletes nothing.
 */
export async function choicesCurrent(): Promise<boolean> {
  if (!choicesFresh()) await privacyStore.pull().catch(() => {});
  return choicesFresh();
}

/** The two logs only this Mac keeps, with what was said in them. */
const callLog = () => {
  const dir = userDir();
  return dir ? join(dir, "phone-calls.jsonl") : null;
};
const routeLog = () => {
  const dir = userHome();
  return dir ? join(dir, "routes.jsonl") : null;
};

/**
 * This Mac's files older than `cutoff` that the sweep deletes: images (uploads.ts) and pages (pages.ts) no
 * message in `kept` shows or links to (nor, for images, a busy thread works from: busyImages; for pages, a
 * thread's own words), and threads' last frames (frames.ts), but a busy thread's; nor any named in `spare`. Only
 * files named as Bops names them: nothing else in those folders is ever touched.
 */
function oldFiles(cutoff: number, kept: readonly Message[], state: Pick<AppState, "sessions" | "appApprovals">, spare: ReadonlySet<string> = new Set()): string[] {
  const busy = busyThreads(state);
  const pics = new Set([...uploadIdsOf(kept), ...busyImages(state, busy)]);
  // The pages the kept messages link to, and those a thread's own words do (lib/privacy.ts inUse).
  const pages = new Set([...pageIdsOf(kept), ...inUse({ messages: [], sessions: state.sessions, appApprovals: state.appApprovals }).pages]);
  const out: string[] = [];
  const look = (dir: string | null, named: RegExp, keep: (id: string) => boolean) => {
    if (!dir || !existsSync(/*turbopackIgnore: true*/ dir)) return;
    for (const f of readdirSync(/*turbopackIgnore: true*/ dir)) {
      const m = named.exec(f);
      if (!m || keep(m[1]) || spare.has(m[1])) continue;
      const p = join(/*turbopackIgnore: true*/ dir, f);
      try {
        const st = lstatSync(/*turbopackIgnore: true*/ p);
        if (st.isFile() && st.mtimeMs < cutoff) out.push(p);
      } catch {}
    }
  };
  look(uploadsDir(), /^(img_[a-z0-9]+)\.(?:png|jpg|webp|gif)$/i, (x) => pics.has(x));
  look(pagesDir(), /^(page_[a-z0-9]+)\.html$/i, (x) => pages.has(x));
  look(framesDir(), /^(ses_[a-z0-9]+)\.jpg$/i, (x) => busy.has(x));
  return out;
}

/** When a log line was written: both logs start each line with it ({"at":"<ISO time>", …}). NaN when it doesn't. */
const timeOf = (line: string) => Date.parse(/^\{"at":"([^"]+)"/.exec(line)?.[1] ?? "");

/** A log's lines older than `cutoff`: the lines before the first newer one (or one that doesn't say when), how many and their bytes. */
async function oldLines(file: string | null, cutoff: number): Promise<{ lines: number; offset: number }> {
  if (!file || !existsSync(/*turbopackIgnore: true*/ file)) return { lines: 0, offset: 0 };
  let offset = 0;
  let lines = 0;
  const input = createReadStream(/*turbopackIgnore: true*/ file);
  const reader = createInterface({ input, crlfDelay: Infinity });
  try {
    for await (const line of reader) {
      if (line && !(timeOf(line) < cutoff)) break;
      offset += Buffer.byteLength(line) + 1;
      lines++;
    }
  } finally {
    reader.close();
    input.destroy();
  }
  return { lines, offset };
}

/**
 * A log's lines older than `cutoff` go. It's only ever appended to, in time order, so they're the lines
 * before the first newer one (or one that doesn't say when: kept, with all after it; oldLines): the rest is
 * copied to a new file that takes its place. What was appended while that copy was made goes on its end
 * before the swap, in the same tick as the swap (both logs are appended to synchronously, in this process:
 * phone.ts callLog, routing.ts logRoute). How many lines went.
 */
async function pruneLog(file: string | null, cutoff: number): Promise<number> {
  if (!file) return 0;
  const { lines, offset } = await oldLines(file, cutoff);
  if (!lines) return 0;
  const size = statSync(/*turbopackIgnore: true*/ file).size;
  if (offset >= size) {
    rmSync(/*turbopackIgnore: true*/ file, { force: true });
    return lines;
  }
  const tmp = `${file}.keep.tmp`;
  await pipeline(createReadStream(/*turbopackIgnore: true*/ file, { start: offset }), createWriteStream(/*turbopackIgnore: true*/ tmp, { mode: 0o600 }));
  // Appended since the copy read the end: onto the copy too, then the copy takes the log's place.
  const copied = offset + statSync(/*turbopackIgnore: true*/ tmp).size;
  const now = statSync(/*turbopackIgnore: true*/ file).size;
  if (now > copied) {
    const fd = openSync(/*turbopackIgnore: true*/ file, "r");
    try {
      const extra = Buffer.alloc(now - copied);
      readSync(fd, extra, 0, extra.length, copied);
      appendFileSync(/*turbopackIgnore: true*/ tmp, extra);
    } finally {
      closeSync(fd);
    }
  }
  renameSync(/*turbopackIgnore: true*/ tmp, file);
  return lines;
}

/**
 * Sweep now, by choices this Mac knows are current (choicesCurrent; else it deletes nothing this time):
 * Recently deleted's copies whose time is up, then (with a Keep chats and calls set) the messages older than
 * it and the finished threads that last did anything before it, a batch at a time, then this Mac's files and
 * log lines older than it. One sweep at a time: a second ask while one runs gets that one. Null when this
 * Bops doesn't sweep (sweepHere).
 */
export function sweepKept(now = Date.now()): Promise<SweepResult | null> {
  if (!sweepHere()) return Promise.resolve(null);
  g.__bopsPrivacySweep ??= sweep(now).finally(() => {
    g.__bopsPrivacySweep = undefined;
  });
  return g.__bopsPrivacySweep;
}

/** What a batch deleted: how many, and whether that's in Bops Cloud now (null: the store doesn't say, flushState does). */
type Dropped = { count: number; up: () => boolean | null };

/**
 * Delete a batch at a time (`next`: the next batch, by id; `drop`: deletes it for good), each in Bops Cloud
 * before the next goes. Landed is judged by what the batch itself deleted (Dropped.up), never by whether
 * anything else changed meanwhile (a bot's turn, a thread's steps: flushState says those aren't up yet).
 * When it isn't up (offline, the cloud down), it waits in the save's own retries, and the rest wait for the
 * next sweep, so nothing piles up behind them ("wait"). Before each batch, the choice it goes by must still
 * be the user's, and current: else it stops ("stop"). How many went is in `n`.
 */
async function inBatches(keepDays: KeepDays, ours: () => boolean, next: () => string[], drop: (ids: string[]) => Dropped, n: { count: number }): Promise<"done" | "wait" | "stop"> {
  for (;;) {
    if (!(await choicesCurrent()) || !ours() || privacyOf(getState()).keepDays !== keepDays) return "stop";
    const batch = next().slice(0, privacyTiming.batch);
    const gone = batch.length ? drop(batch) : { count: 0, up: () => true };
    n.count += gone.count;
    if (!gone.count || batch.length < privacyTiming.batch) return "done";
    const flushed = await flushState(privacyTiming.flushMs);
    if (!ours() || privacyOf(getState()).keepDays !== keepDays) return "stop";
    if (!(gone.up() ?? flushed)) return "wait";
    await sleep(privacyTiming.pauseMs);
  }
}

/** A batch of messages deleted for good: up once Bops Cloud took their removal. */
function dropMessages(ids: string[]): Dropped {
  return { count: deleteMessages(ids, { forGood: true }), up: () => privacyStore.messagesUp(ids) };
}

/** A batch of threads deleted for good, with their results and notes in the chats: up once the cloud's copy has none of them and took those messages' removal. */
function dropThreads(ids: string[]): Dropped {
  const had = getState().messages.map((m) => m.id);
  const count = deleteThreads(ids, { forGood: true });
  const left = new Set(getState().messages.map((m) => m.id));
  const went = had.filter((x) => !left.has(x));
  return {
    count,
    up: () => {
      const msgs = privacyStore.messagesUp(went);
      const threads = privacyStore.threadsUp(ids);
      return msgs === null || threads === null ? null : msgs && threads;
    },
  };
}

async function sweep(now: number): Promise<SweepResult> {
  const ours = sameState();
  const out: SweepResult = { messages: 0, threads: 0, files: 0, lines: 0, deleted: 0 };
  // Nothing goes by a choice this Mac may not have the latest of (choicesCurrent): offline, it waits.
  if (!(await choicesCurrent()) || !ours()) return out;
  out.deleted = purgeExpiredDeleted(now);
  const { keepDays } = privacyOf(getState());
  const cutoff = keepCutoff(keepDays, now);
  if (cutoff === null) return out;
  const messages = { count: 0 };
  const threads = { count: 0 };
  let went = await inBatches(keepDays, ours, () => expiredMessages(getState(), keepDays, now).map((m) => m.id), dropMessages, messages);
  if (went === "done") went = await inBatches(keepDays, ours, () => expiredThreads(getState(), keepDays, now).map((s) => s.id), dropThreads, threads);
  out.messages = messages.count;
  out.threads = threads.count;
  // Bops Cloud not taking them stops only what goes from it: this Mac's own still go, by the same current choice.
  if (went === "stop" || !ours()) return out;
  const st = getState();
  for (const p of oldFiles(cutoff, st.messages, st))
    try {
      rmSync(/*turbopackIgnore: true*/ p, { force: true });
      out.files++;
    } catch {}
  for (const log of [callLog(), routeLog()]) {
    if (!ours()) return out;
    out.lines += await pruneLog(log, cutoff).catch((e: Error) => (warn(e), 0));
  }
  forgetHere();
  if (out.messages || out.threads || out.files || out.lines)
    console.info(`[privacy] older than ${keepDays} days: ${out.messages} messages, ${out.threads} threads, ${out.files} files and ${out.lines} log lines deleted`);
  return out;
}

/**
 * The sweep's clock: every hour while Bops is open, and once soon after each start or sign in (a state
 * loaded whole: its hour may be far off). Started with the app's state polls (app/api/state); the Mac's
 * alone (persist.ts MAC_LOOPS), so never on a computer's runner.
 */
export function startPrivacy() {
  if (!loopHere("privacy") || onPostgres()) return;
  if (!g.__bopsPrivacyTimer) {
    g.__bopsPrivacyTimer = setInterval(() => void sweepKept().catch(warn), privacyTiming.everyMs);
    g.__bopsPrivacyTimer.unref?.();
  }
  if (!stateReady()) return;
  const key = `${userDir()}\n${stateEpoch()}`;
  if (g.__bopsPrivacyStarted === key) return;
  g.__bopsPrivacyStarted = key;
  g.__bopsPrivacyHeard = heardNow();
  const ours = sameState();
  const t = setTimeout(() => void (ours() && sweepKept().catch(warn)), privacyTiming.firstMs);
  t.unref?.();
}

/**
 * The user's choices as another Mac changed them, heard here (watchArrivals): Recently deleted's copies go by
 * them at once (fewer days, or a shorter keep), and a shorter keep sweeps now, not at the next hour. Only a
 * change from what this Mac knew (as its state loaded: startPrivacy; or as the user chose here: setPrivacy)
 * does anything; before the state's first sweep is set, what's heard is only noted.
 */
function heardChoices() {
  if (!loopHere("privacy") || !sweepHere()) return;
  const now = heardNow();
  const was = g.__bopsPrivacyHeard;
  if (was && was.dir === now.dir && was.keepDays === now.keepDays && was.deletedDays === now.deletedDays) return;
  g.__bopsPrivacyHeard = now;
  if (!was || was.dir !== now.dir) return;
  if (keepsLess(was.keepDays, now.keepDays)) void sweepKept().catch(warn);
  else
    try {
      purgeExpiredDeleted();
    } catch (e) {
      warn(e as Error);
    }
}
watchArrivals("privacy", heardChoices);

/**
 * A delete made on another Mac (watchGone): gone at once there (deletedDays 0), what this Mac kept beside it
 * goes too, as remove.ts leaveBehind does where it was made: the images and pages only those messages showed,
 * and the threads' last frames here. With days to keep what's deleted, they stay: the copy on that Mac comes back
 * with Restore, and so do they here.
 */
watchGone("privacy", ({ messages, sessions }) => {
  if (!loopHere("privacy") || onPostgres() || !stateReady() || privacyOf(getState()).deletedDays !== 0) return;
  try {
    if (messages.length) {
      const used = inUse(getState());
      dropUploads(uploadIdsOf(messages), used.images);
      dropPages(pageIdsOf(messages), used.pages);
    }
    for (const s of sessions) dropFrame(s.id);
  } catch (e) {
    warn(e as Error);
  }
});

/* ---------------- Where it's kept: this Mac's numbers ---------------- */

const HERE_MS = 30_000;
const CAP = 20_000;

/** The files in a folder (and, `deep`, its folders), how many and their size, up to CAP of them. */
function countDir(dir: string | null, deep = false): HereCount {
  const out: HereCount = { count: 0, bytes: 0 };
  if (!dir || !existsSync(/*turbopackIgnore: true*/ dir)) return out;
  const stack = [dir];
  let seen = 0;
  while (stack.length) {
    const d = stack.pop()!;
    let names: Dirent[];
    try {
      names = readdirSync(/*turbopackIgnore: true*/ d, { withFileTypes: true });
    } catch {
      continue;
    }
    for (const e of names) {
      if (++seen > CAP) return { ...out, more: true };
      const p = join(/*turbopackIgnore: true*/ d, e.name);
      if (e.isDirectory()) {
        if (deep) stack.push(p);
        continue;
      }
      if (!e.isFile()) continue;
      try {
        out.bytes += lstatSync(/*turbopackIgnore: true*/ p).size;
        out.count!++;
      } catch {}
    }
  }
  return out;
}

const fileSize = (file: string | null): HereCount => {
  try {
    return { bytes: file && existsSync(/*turbopackIgnore: true*/ file) ? statSync(/*turbopackIgnore: true*/ file).size : 0 };
  } catch {
    return { bytes: 0 };
  }
};

/** The bots' Chrome profiles on this Mac: how many (one per bot and screen), and the room they all take. */
function chromeProfiles(): HereCount {
  const dir = userChrome();
  const all = countDir(dir, true);
  let profiles = 0;
  try {
    if (dir && existsSync(/*turbopackIgnore: true*/ dir)) profiles = readdirSync(/*turbopackIgnore: true*/ dir, { withFileTypes: true }).filter((e) => e.isDirectory()).length;
  } catch {}
  return { ...all, count: profiles };
}

/** This Mac's numbers, walked again at most every 30 seconds (forgetHere: at once). */
function here(): PrivacyInfo["here"] {
  const key = `${userDir()}\n${userHome()}`;
  const c = g.__bopsPrivacyHere;
  if (c && c.key === key && Date.now() - c.at < HERE_MS) return c.here;
  const out = {
    uploads: countDir(uploadsDir()),
    pages: countDir(pagesDir()),
    calls: fileSize(callLog()),
    frames: countDir(framesDir()),
    chrome: chromeProfiles(),
    routes: fileSize(routeLog()),
  };
  g.__bopsPrivacyHere = { key, at: Date.now(), here: out };
  return out;
}
export const forgetHere = () => void (g.__bopsPrivacyHere = undefined);

/**
 * What choosing `keepDays` deletes now, everything the sweep it starts takes (lib/privacy.ts KeepGoes): the
 * messages and threads (from Bops Cloud and every Mac), and this Mac's files, the lines of its two logs, and
 * the copies in its Recently deleted that go whole or in part.
 */
async function goesWith(keepDays: KeepDays, now: number): Promise<KeepGoes> {
  const st = getState();
  const cutoff = keepCutoff(keepDays, now);
  if (cutoff === null) return { keepDays, messages: 0, threads: 0, files: 0, lines: 0, copies: 0 };
  const goes = new Set(expiredMessages(st, keepDays, now).map((m) => m.id));
  const threads = expiredThreads(st, keepDays, now);
  const gone = new Set(threads.map((s) => s.id));
  // A thread's result goes with it; the files of what's left are the ones kept.
  const kept = st.messages.filter((m) => !goes.has(m.id) && !(m.resultOf && gone.has(m.resultOf)));
  let lines = 0;
  for (const log of [callLog(), routeLog()]) lines += (await oldLines(log, cutoff).catch(() => ({ lines: 0 }))).lines;
  return { keepDays, messages: goes.size, threads: threads.length, files: oldFiles(cutoff, kept, st).length, lines, copies: deletedGoing({ keepDays }, now) };
}

/** GET /api/privacy: the user's choices, this Mac's numbers, Recently deleted, and whether a sweep is under way. */
export function privacyInfo(now = Date.now()): PrivacyInfo {
  // The copies whose time is up go first only by choices this Mac knows are current (choicesFresh): else they're listed as they are.
  const deleted = listDeleted(now, { current: choicesFresh() });
  const st = getState();
  const info: PrivacyInfo = { ...privacyOf(st), messages: st.messages.length, here: here(), deleted, bots: botsListed(st) };
  if (g.__bopsPrivacySweep) info.sweeping = true;
  return info;
}

/** The bots Delete now can be for (PrivacyInfo.bots), each with its workspace's name when there are more than one. */
function botsListed(st: AppState): NonNullable<PrivacyInfo["bots"]> {
  const spaces = st.workspaces ?? [];
  return st.bots.map((b) => {
    const w = spaces.length > 1 ? spaces.find((x) => x.id === workspaceOf(b))?.name : undefined;
    return { id: b.id, name: b.name, ...(w ? { workspace: w } : {}) };
  });
}

/**
 * What Delete now takes (lib/privacy.ts ClearGoes), all Delete now (clearNow) does: the messages and threads
 * (clearPlan); for every bot, this Mac's files older than its cutoff that no message left shows (oldFiles; with
 * days to keep what's deleted, the ones the deleted messages show go into the copy, not counted here), and the
 * lines of its two logs older than it.
 */
async function clearGoes(choice: ClearChoice, now: number): Promise<ClearGoes> {
  const st = getState();
  const plan = clearPlan(st, choice, now);
  const out: ClearGoes = { ...choice, messages: plan.messages.size, threads: plan.threads.size, files: 0, lines: 0 };
  if (choice.bot) return out;
  const cutoff = clearCutoff(choice.olderThan, now);
  const kept = st.messages.filter((m) => !plan.messages.has(m.id));
  // With days to keep what's deleted, what the deleted messages and threads show goes into their copy instead.
  const going = st.messages.filter((m) => plan.messages.has(m.id));
  const spare = privacyOf(st).deletedDays > 0 ? new Set([...uploadIdsOf(going), ...pageIdsOf(going), ...plan.threads]) : new Set<string>();
  out.files = oldFiles(cutoff, kept, { ...st, sessions: st.sessions.filter((s) => !plan.threads.has(s.id)) }, spare).length;
  for (const log of [callLog(), routeLog()]) out.lines += (await oldLines(log, cutoff).catch(() => ({ lines: 0 }))).lines;
  return out;
}

export type ClearResult = { messages: number; threads: number; files: number; lines: number; restore: string | null };

/**
 * Delete now (POST /api/privacy { clear }), as the user asked, once the window said what it takes (clearGoes):
 * the messages and threads (remove.ts deleteChats: one copy under Recently deleted when the user keeps one,
 * else for good), so from Bops Cloud and every Mac with the next save; for every bot, this Mac's own as the
 * sweep deletes them, older than its cutoff: the files no message left shows and the lines of its call notes
 * and model choices (never into a copy). Not by any choice this Mac holds, so it needs no current state: it's
 * what the user asked now, of what this Mac has (another Mac's newest, not here yet, stays).
 */
export async function clearNow(choice: ClearChoice, now = Date.now()): Promise<ClearResult> {
  const r = deleteChats(choice, { now });
  const out: ClearResult = { messages: r.messages, threads: r.threads, files: 0, lines: 0, restore: r.restore };
  if (!choice.bot) {
    const cutoff = clearCutoff(choice.olderThan, now);
    const st = getState();
    for (const p of oldFiles(cutoff, st.messages, st))
      try {
        rmSync(/*turbopackIgnore: true*/ p, { force: true });
        out.files++;
      } catch {}
    for (const log of [callLog(), routeLog()]) out.lines += await pruneLog(log, cutoff).catch((e: Error) => (warn(e), 0));
  }
  forgetHere();
  if (out.messages || out.threads || out.files || out.lines) console.info(`[privacy] Delete now: ${out.messages} messages, ${out.threads} threads, ${out.files} files and ${out.lines} log lines`);
  return out;
}

/**
 * GET /api/privacy with a choice the window means to make: privacyInfo, with what choosing it deletes now
 * (goes for a keep, goesDeleted for fewer days for what the user deletes, goesNow for Delete now), for the
 * window to ask first.
 */
export async function privacyPreview(proposed: { keepDays?: KeepDays; deletedDays?: DeletedDays; clear?: ClearChoice }, now = Date.now()): Promise<PrivacyInfo> {
  const info = privacyInfo(now);
  if (proposed.clear) info.goesNow = await clearGoes(proposed.clear, now);
  if (proposed.keepDays !== undefined) info.goes = await goesWith(proposed.keepDays, now);
  // By the days alone, as setPrivacy deletes by them: the keep's are the sweep's.
  if (proposed.deletedDays !== undefined) info.goesDeleted = { deletedDays: proposed.deletedDays, copies: deletedGoing({ deletedDays: proposed.deletedDays, keepDays: null }, now) };
  return info;
}

/**
 * The user's choice (POST /api/privacy), for every Mac of theirs. Gone at once deletes every copy in Recently
 * deleted on this Mac now, and fewer days the ones past them (the other Macs' go when they hear it:
 * heardChoices, or at their next sweep): by those days alone, the user's latest as they just chose them, never
 * by the keep this Mac holds beside them, which a Mac offline may have stale (what that takes goes by the
 * sweep, or as Settings reads it again, once current: choicesFresh). Keeping chats for less time sweeps now,
 * not at the next hour (the window asked the user first, with what it deletes, either way). The sweep it
 * starts, if any, to wait on.
 */
export function setPrivacy(change: { keepDays?: KeepDays; deletedDays?: DeletedDays }): Promise<SweepResult | null> | null {
  const was = privacyOf(getState());
  update((s) => {
    s.privacy = { ...s.privacy, ...change };
  });
  // Known here first: the same choice coming back from Bops Cloud does nothing again.
  g.__bopsPrivacyHeard = heardNow();
  if (change.deletedDays === 0) purgeAllDeleted();
  else if (change.deletedDays !== undefined) purgeExpiredDeleted(Date.now(), { deletedDays: change.deletedDays, keepDays: null });
  forgetHere();
  // After a sweep under way (it stops at its next batch, as the choice changed), one by the new choice.
  if (change.keepDays === undefined || !keepsLess(was.keepDays, change.keepDays)) return null;
  const swept = (g.__bopsPrivacySweep ?? Promise.resolve(null)).catch(() => null).then(() => sweepKept());
  void swept.catch(warn);
  return swept;
}
