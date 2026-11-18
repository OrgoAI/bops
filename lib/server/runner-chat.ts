import "server-only";
import { mkdir, stat, unlink, utimes, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import {
  APP_JOB_KINDS,
  isRemoveJob,
  jobApp,
  RUNNER_HOLD,
  RUNNER_TURNS_DIR,
  TURN_BEAT_MS,
  type AppJob,
  type RunnerAppsViewEvent,
  type RunnerClaim,
  type RunnerDone,
  type RunnerResume,
  type RunnerTurnEvent,
  type TurnJob,
  type TurnMember,
} from "@/cloud/protocol";
import { live as liveSession, pausedForOk, workspaceOf, type AppApproval, type MemberTurn } from "@/lib/types";
import { RUNNER_KEEPER_LOOK, RUNNER_WORKING } from "@/vm/runner-steps.mjs";
import { shareAppsView } from "./apps-view-share";
import { cloudFetch } from "./cloud";
import { loopHere, onRunner } from "./persist";
import { addMessage, flushState, getState, ownSession, pullState, stateReady } from "./store";
import { runInTurn, type TurnContext } from "./turn-context";

/**
 * Chat answered on a bot's computer (cloud/turns.ts, the "chat" loop of a runner: persist.ts RUNNER_LOOPS). In a
 * workspace whose chat goes through Bops Cloud, every message is written there first and its answer owed to the runner
 * on the bot's computer. This runner listens for its own (GET /v1/runner/live, while it's up; Bops Cloud wakes the
 * computer when nobody listens), and for each turn:
 *
 * 1. makes sure it's on its own computer (runner.ts checkIdentity: a copy never answers), then claims it (Bops Cloud gives
 *    it only to this computer's device, one at a time per chat, and checks again that a member still may);
 * 2. reads the state until it has the message (Bops Cloud wrote it, never this runner);
 * 3. reads the skills published in Orgo (runner-skills.ts, at most once a minute), then runs the same turn the Mac would
 *    (chat.ts answerMessage) in the turn's context (turn-context.ts): its rows carry the
 *    turn and Bops Cloud's clock, and the first thing it does that can't be done twice is said at once, so a runner that
 *    goes quiet after that never has it run again;
 * 4. beats every TURN_BEAT_MS while it runs (a 409 means Bops Cloud took it back: it stops and writes nothing more),
 *    then, once any beat on the way has landed, says it's done (with its tapback on the message, or a group's bots'
 *    tapbacks, which Bops Cloud writes), or paused for an OK (sent again when Bops Cloud didn't answer: a lost done would
 *    have it answered again).
 *    The OK request carries the turn's id (AskResume.cloudTurn), so when the answer comes the turn goes on only as
 *    itself, through Bops Cloud (resumeAsTurn): one it ended meanwhile (its member's access taken away, past its day)
 *    never runs, on this runner or after a restart or an upgrade.
 *
 * "turn-cancel" (its member removed or their access changed, its lease lost) stops a turn where it is. "state" reads
 * the state now (an OK answered, a change of who may). "update" (a new runner release is out) touches
 * RUNNER_KEEPER_LOOK, so this computer's keeper looks at once. A turn whose message it can't read fails with a note.
 * The Mac never runs this.
 *
 * A group's turn (RunnerClaim.turn.group: Bops Cloud owes one only to a computer where every bot of the group works)
 * runs as the group does (chat.ts groupTurn), each of its bots' rows carrying the turn. A bot set to work on the Mac
 * answers here as any other (a workspace in the cloud): nothing it starts waits for the Mac.
 *
 * A turn that's a job (TurnMember.job, asked from a shared workspace and checked by Bops Cloud: cloud/turns.ts
 * takeAppJob, takeChatJob) isn't words to answer: it's done here (runJob, through runnerJob: an app's job by
 * hosted-apps.ts appJob, which does its GitHub ones by githubJob; a chat's compact by chat-summary.ts compactChat), said
 * in the bot's chat as Bops' own (a chat's compact by Bops Cloud instead, stamped as the teammate's), and its result told
 * with its end. No model sees it but the compact's summary. A kind this runner doesn't do yet is said so plainly, and
 * nothing is done. A remove's end goes only once this runner's state is saved (flushState): Bops Cloud drops the app as
 * it hears it, and a save of the record after that would be one of an app that's gone. After any other app's job (a left
 * over removed too), what members see of the app is told to Bops Cloud (apps-view-share.ts), as it is when Bops Cloud
 * asks ("apps-view": a member is looking at an old one).
 */

const RECONNECT_MIN_MS = 2_000;
const RECONNECT_MAX_MS = 60_000;
/** Bops Cloud says something every 15 seconds: quiet longer than this, the stream is dead. */
const SILENT_MS = 45_000;
/** How many times it reads the state for a message it doesn't have yet. */
const READS_FOR_MESSAGE = 5;
/** How many times a call that must land (claim, done, resume) is sent when Bops Cloud doesn't answer, and the waits between. */
const TRIES = 3;
const RETRY_MS = [1_000, 4_000];

type Live = { ctl?: AbortController; retry?: ReturnType<typeof setTimeout>; failures: number; pulling?: ReturnType<typeof setTimeout> };
type Box = {
  live?: Live;
  /** Turns being answered here, by id. */
  running: Map<string, TurnContext>;
  /** Tests: what runs the turn (chat.ts answerMessage), and how this runner makes sure it's on its own computer. */
  answer?: (chatId: string, messageId: string, member?: MemberTurn) => Promise<{ paused?: boolean } | null>;
  identity?: () => Promise<"same" | "copy" | "unknown">;
  beatMs?: number;
  retryMs?: number[];
  /** Tests: where this runner marks the replies it's answering (RUNNER_TURNS_DIR); an upgrade's hold is beside it. */
  turnsDir?: string;
  /** How many runs hold each reply's mark (the same turn delivered twice at once shares one): removed by the last. */
  marks?: Map<string, number>;
  /** Tests: how often a resume looks again at an upgrade's hold. */
  holdPollMs?: number;
  /** The working beat (startWorkingBeat), and for tests how often it beats. */
  working?: ReturnType<typeof setInterval>;
  workingMs?: number;
  /** Tests: what does an app's job (hosted-apps.ts appJob), as runnerJob gives it one. */
  job?: (botId: string, job: AppJob, by: string) => Promise<JobResult>;
  /** Tests: what compacts a chat (chat-summary.ts compactChat), and whether Bops Cloud has its summary now (store.ts changeLanded). */
  compact?: (chatId: string, member: undefined, opts: { line: false }) => Promise<{ ok: true } | { ok: false; error: string }>;
  landed?: (has: (state: Record<string, unknown>) => boolean) => Promise<boolean>;
};
const g = globalThis as unknown as { __bopsRunnerChat?: Box };
const box: Box = (g.__bopsRunnerChat ??= { running: new Map() });

const answerOf = async () => box.answer ?? (await import("./chat")).answerMessage;
const appJobOf = async () => box.job ?? (await import("./hosted-apps")).appJob;
const compactOf = async () => box.compact ?? (await import("./chat-summary")).compactChat;
const landedOf = async () => box.landed ?? (await import("./store")).changeLanded;
const identityOf = async () => box.identity ?? (await import("./runner")).checkIdentity;

/** A call to Bops Cloud as this computer: the answer's status and body (status 0 when it didn't answer). */
async function post<T>(path: string, body: unknown): Promise<{ status: number; body: T | null }> {
  try {
    const res = await cloudFetch(path, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(body) });
    return { status: res.status, body: (await res.json().catch(() => null)) as T | null };
  } catch {
    return { status: 0, body: null };
  }
}

/** The same call until Bops Cloud answers it (status 0, or a 5xx), TRIES at most: a lost done or pause would have the turn owed again. */
async function postSure<T>(path: string, body: unknown): Promise<{ status: number; body: T | null }> {
  let r = await post<T>(path, body);
  for (let i = 1; i < TRIES && (r.status === 0 || r.status >= 500); i++) {
    await new Promise((done) => setTimeout(done, (box.retryMs ?? RETRY_MS)[i - 1] ?? 4_000));
    r = await post<T>(path, body);
  }
  return r;
}

/** Start listening for this computer's turns: on a runner, once its state is in. */
export function startRunnerChat() {
  if (!onRunner() || !loopHere("chat") || box.live) return;
  box.live = { failures: 0 };
  connect(box.live);
}

/** Stop listening (tests; the process going). */
export function stopRunnerChat() {
  const live = box.live;
  box.live = undefined;
  live?.ctl?.abort();
  if (live?.retry) clearTimeout(live.retry);
  if (live?.pulling) clearTimeout(live.pulling);
}

function connect(live: Live) {
  live.retry = undefined;
  if (box.live !== live) return;
  const ctl = (live.ctl = new AbortController());
  void read(live, ctl).finally(() => {
    if (box.live !== live) return;
    live.ctl = undefined;
    const wait = Math.min(RECONNECT_MAX_MS, RECONNECT_MIN_MS * 2 ** live.failures++) * (0.5 + Math.random() / 2);
    live.retry = setTimeout(() => connect(live), wait);
    live.retry.unref?.();
  });
}

async function read(live: Live, ctl: AbortController) {
  let quiet: ReturnType<typeof setTimeout> | undefined;
  const kick = () => {
    if (quiet) clearTimeout(quiet);
    quiet = setTimeout(() => ctl.abort(), SILENT_MS);
    quiet.unref?.();
  };
  try {
    kick();
    const res = await cloudFetch("/v1/runner/live", { headers: { accept: "text/event-stream" }, signal: ctl.signal });
    if (!res.ok || !res.body) {
      void res.body?.cancel().catch(() => {});
      return;
    }
    const dec = new TextDecoder();
    let text = "";
    for await (const chunk of res.body as unknown as AsyncIterable<Uint8Array>) {
      kick();
      live.failures = 0;
      text += dec.decode(chunk, { stream: true }).replace(/\r\n?/g, "\n");
      for (let i = text.indexOf("\n\n"); i >= 0; i = text.indexOf("\n\n")) {
        onBlock(live, text.slice(0, i));
        text = text.slice(i + 2);
      }
    }
  } catch {
    /* dropped or unreachable: connected again */
  } finally {
    if (quiet) clearTimeout(quiet);
  }
}

function onBlock(live: Live, block: string) {
  let type = "";
  let data = "";
  for (const line of block.split("\n")) {
    if (line.startsWith("event: ")) type = line.slice(7);
    else if (line.startsWith("data: ")) data += line.slice(6);
  }
  let body: Record<string, unknown> = {};
  try {
    body = data ? (JSON.parse(data) as Record<string, unknown>) : {};
  } catch {
    return;
  }
  if (type === "turn" && typeof body.id === "string") void answerTurn(body as unknown as RunnerTurnEvent).catch((e: Error) => console.warn(`[runner-chat] ${String(body.id)}: ${e.message}`));
  else if (type === "turn-cancel" && typeof body.id === "string") cancel(body.id);
  // Bops Cloud asks for what members see of this computer's apps (cloud/turns.ts nudgeAppViews): one share at a time per workspace.
  else if (type === "apps-view" && typeof body.ws === "string") {
    const ev = body as unknown as RunnerAppsViewEvent;
    const names = Array.isArray(ev.apps) ? ev.apps.filter((x): x is string => typeof x === "string").slice(0, 100) : undefined;
    void shareAppsView(ev.ws, names).catch(() => {});
  }
  // A new runner release is out (cloud/runner-release.ts nudgeUpdates): this computer's keeper looks at once (it watches
  // RUNNER_KEEPER_LOOK). Best effort: a touch that fails leaves the keeper to its own next look.
  else if (type === "update") void touchFile(lookOf()).catch(() => {});
  else if (type === "state" && !live.pulling) {
    live.pulling = setTimeout(() => {
      live.pulling = undefined;
      void pullState().catch(() => {});
    }, 200);
    live.pulling.unref?.();
  }
}

/** Bops Cloud took a turn back: it stops where it is, and writes nothing more. Let go at once, so the turn offered again is taken up. */
function cancel(id: string) {
  const t = box.running.get(id);
  if (t) t.cancelled = true;
  box.running.delete(id);
}

/**
 * What a member's turn tells the bot of who's talking (Message.member), and their role as Bops Cloud found it taking
 * their words (TurnMember.role: an Admin's turn has every bot and Your Apps at Write, chat.ts TurnOptions.member).
 */
const saidBy = (m: TurnMember | undefined): MemberTurn | undefined =>
  m ? { userId: m.userId, ...(m.email ? { email: m.email } : {}), name: m.name, ref: m.ref, ...(m.role === "admin" ? { role: "admin" as const } : {}) } : undefined;

const turnsDir = () => box.turnsDir ?? RUNNER_TURNS_DIR;
const holdOf = () => (box.turnsDir ? join(dirname(box.turnsDir), "upgrading") : RUNNER_HOLD);
const markOf = (id: string) => join(turnsDir(), id.replace(/[^A-Za-z0-9_-]/g, "_"));
const HOLD_STALE_MS = 5 * 60_000;

/**
 * `run` with this reply marked on its computer (RUNNER_TURNS_DIR), from before it's claimed until after its end is said
 * to Bops Cloud, so an upgrade of this runner waits for all of it. `held`: an upgrade holds this runner (RUNNER_HOLD,
 * set under 5 minutes ago), so a new reply isn't started (Bops Cloud gives it again); a resume goes on all the same.
 * The mark is made before the hold is looked at, so an upgrade never misses a reply that starts as it holds. Best
 * effort: a mark that can't be made never stops a reply.
 */
async function whileMarked<T>(id: string, run: () => Promise<T>, held?: () => T): Promise<T> {
  const mark = markOf(id);
  const marks = (box.marks ??= new Map());
  marks.set(mark, (marks.get(mark) ?? 0) + 1);
  try {
    await mkdir(turnsDir(), { recursive: true }).then(() => writeFile(mark, ""), () => {});
    if (held && (await holding())) return held();
    // A resume (its OK already taken out, so it can't be given again later) waits for the hold to go: its mark stops
    // an upgrade that hasn't swapped yet, and one that has restarts this runner (Bops Cloud keeps the turn paused).
    if (!held) for (const end = Date.now() + HOLD_STALE_MS; (await holding()) && Date.now() < end; ) await new Promise((r) => setTimeout(r, box.holdPollMs ?? 1_000));
    return await run();
  } finally {
    const left = (marks.get(mark) ?? 1) - 1;
    if (left > 0) marks.set(mark, left);
    else {
      marks.delete(mark);
      await unlink(mark).catch(() => {});
    }
  }
}
const holding = () => stat(holdOf()).then((h) => Date.now() - h.mtimeMs < HOLD_STALE_MS, () => false);

/** The runner's markers for its keeper, beside the reply marks (tests: beside theirs). */
const workingOf = () => (box.turnsDir ? join(dirname(box.turnsDir), "working") : RUNNER_WORKING);
const lookOf = () => (box.turnsDir ? join(dirname(box.turnsDir), "keeper-look") : RUNNER_KEEPER_LOOK);
/** A file made, or its time set to now (its folder made first). */
const touchFile = (file: string) => mkdir(dirname(file), { recursive: true }).then(() => writeFile(file, ""));
const WORKING_EVERY_MS = 30_000;

/**
 * Whether a thread of this runner's own is going (a routine's run, a task): live, and not paused for the user's OK (a
 * paused run holds no process here, and goes on through Bops Cloud after a restart). RUNNER_WORKING is touched then.
 */
export function workingNow(): boolean {
  const s = getState();
  return s.sessions.some((x) => liveSession(x) && ownSession(x) && !pausedForOk(x, s));
}
/** One beat: RUNNER_WORKING touched while a thread of its own is going (workingNow), else left as it is. Whether it was. */
export async function beatWorking(): Promise<boolean> {
  if (!workingNow()) return false;
  return touchFile(workingOf()).then(
    () => true,
    () => false,
  );
}
/**
 * The working beat, on a runner (runner-start.ts): every 30 seconds while a thread of its own is going, RUNNER_WORKING
 * is touched, so neither the Mac nor its keeper swaps this runner's files under it (vm/runner-steps.mjs installScript
 * is busy while it was touched in the last 2 minutes). Nothing is touched while it's idle.
 */
export function startWorkingBeat() {
  if (!onRunner() || !loopHere("sessions") || box.working) return;
  void beatWorking();
  box.working = setInterval(() => void beatWorking(), box.workingMs ?? WORKING_EVERY_MS);
  box.working.unref?.();
}

/** The turn's beats while `run` runs, then its end: done (with its tapback, or `result`: a job's), paused for an OK, or nothing (taken back). */
async function asTurn(ctx: TurnContext, run: () => Promise<{ paused?: boolean } | null>, after?: { messageId: string }, result?: () => JobResult) {
  box.running.set(ctx.id, ctx);
  // The beats on the way: the end waits for them, so one that lands after it can't say the turn runs still.
  const beats = new Set<Promise<void>>();
  const beat = () => {
    const p = post(`/v1/runner/turns/${encodeURIComponent(ctx.id)}/beat`, { phase: ctx.acting ? "tools" : "model" }).then((r) => {
      if (r.status === 409) ctx.cancelled = true;
    });
    beats.add(p);
    void p.finally(() => beats.delete(p));
  };
  ctx.onActing = beat;
  // Its mark (whileMarked) stays fresh while it runs, so an upgrade of this runner keeps waiting for it.
  const touch = () => void utimes(markOf(ctx.id), new Date(), new Date()).catch(() => {});
  const every = setInterval(() => (beat(), touch()), box.beatMs ?? TURN_BEAT_MS);
  every.unref?.();
  // Its computer is in use while it answers (free-hours.ts counts a turn running).
  void import("./free-hours").then((m) => m.sayInUse(), () => {});
  let out: { paused?: boolean } | null = null;
  try {
    out = await runInTurn(ctx, run);
  } catch (e) {
    console.warn(`[runner-chat] ${ctx.id}: ${(e as Error).message}`);
  } finally {
    clearInterval(every);
    if (box.running.get(ctx.id) === ctx) box.running.delete(ctx.id);
  }
  ctx.onActing = undefined;
  await Promise.all([...beats]);
  if (ctx.cancelled) return;
  const path = `/v1/runner/turns/${encodeURIComponent(ctx.id)}/done`;
  if (out?.paused) {
    const ask = askOf(ctx);
    if (ask) {
      await postSure(path, { state: "paused", approvalId: ask.id });
      return;
    }
  }
  const said = after ? getState().messages.find((m) => m.id === after.messageId)?.reactions : undefined;
  const react = said?.find((r) => r.by === ctx.botId)?.type;
  // A group's: each of its bots' tapback on the message (Bops Cloud writes them, after checking each is a bot of the chat here).
  const reacts = ctx.botIds ? ctx.botIds.flatMap((botId) => said?.flatMap((r) => (r.by === botId && r.type ? [{ botId, type: r.type }] : [])) ?? []).slice(0, MAX_REACTS) : [];
  await postSure(path, { state: "done", ...(react ? { react } : {}), ...(reacts.length ? { reacts } : {}), ...(result ? { job: result() } : {}) } satisfies RunnerDone);
}

/** The most tapbacks a turn's end carries (cloud/turns.ts MAX_REACTS). */
const MAX_REACTS = 8;

/**
 * The OK request a chat turn just paused for: the one asked on this turn (AskResume.cloudTurn) by its bot (a group's:
 * any of its bots), unanswered, the newest.
 */
function askOf(ctx: TurnContext): AppApproval | undefined {
  const bots = ctx.botIds ?? [ctx.botId];
  return [...(getState().appApprovals ?? [])]
    .filter((a) => a.chatId === ctx.chatId && bots.includes(a.botId) && a.resume?.engine === "chat" && a.resume.cloudTurn === ctx.id && !a.reply)
    .sort((a, b) => (b.at ?? 0) - (a.at ?? 0))[0];
}

/** One turn Bops Cloud owes this computer: claimed, read, answered, ended (see above). */
export async function answerTurn(ev: RunnerTurnEvent) {
  if (box.running.has(ev.id) || !stateReady()) return;
  // A copy of this computer never answers (it leaves); no answer from its VMM or Orgo: not now (Bops Cloud gives it again).
  if ((await (await identityOf())()) !== "same") return;
  await whileMarked(ev.id, () => claimAndAnswer(ev), () => undefined);
}

async function claimAndAnswer(ev: RunnerTurnEvent) {
  // (A claim Bops Cloud didn't answer is sent again: a second for one it took is 409 "taken" by this runner, and the
  // sweep owes it again once its lease runs out.)
  const r = await postSure<RunnerClaim>(`/v1/runner/turns/${encodeURIComponent(ev.id)}/claim`, {});
  // Taken, another of its chat first, or over: Bops Cloud sends it again when it's this one's turn.
  if (r.status !== 200 || !r.body?.turn) return;
  const t = r.body.turn;
  const offsetMs = r.body.now - Date.now();
  // An app's GitHub job: done here, never answered (its message is Bops' note of who asked, which it needs none of).
  if (t.member?.job) return runJob({ id: t.id, chatId: t.chatId, botId: t.botId, offsetMs, humanAt: t.humanAt, acting: false, cancelled: false }, t.member.job, t.member.name);
  for (let i = 0; i < READS_FOR_MESSAGE && !getState().messages.some((m) => m.id === t.messageId); i++) await pullState().catch(() => {});
  const path = `/v1/runner/turns/${encodeURIComponent(t.id)}/done`;
  if (!getState().messages.some((m) => m.id === t.messageId)) {
    await post(path, { state: "failed", note: "This computer couldn't read that message. Send it again." });
    return;
  }
  // A group's (RunnerClaim.turn.group): every bot of its chat answers here, each's rows carrying the turn.
  const botIds = t.group ? (getState().chats.find((c) => c.id === t.chatId)?.botIds ?? [t.botId]) : undefined;
  const ctx: TurnContext = { id: t.id, chatId: t.chatId, botId: t.botId, ...(botIds ? { botIds } : {}), offsetMs, humanAt: t.humanAt, acting: false, cancelled: false };
  const answer = await answerOf();
  await asTurn(
    ctx,
    async () => {
      // The skills the owner or an Admin published in Orgo, read first (runner-skills.ts, a few seconds at most): the bot
      // follows them with the owner's Mac off.
      // Never in the way: a read that fails leaves the turn as it would have been.
      try {
        const b = (getState().bots ?? []).find((x) => x.id === t.botId);
        if (b) await (await import("./runner-skills")).refreshRunnerSkills(workspaceOf(b));
      } catch (e) {
        console.warn(`[runner-chat] ${t.id}: skills from Orgo: ${(e as Error).message}`);
      }
      return answer(t.chatId, t.messageId, saidBy(t.member));
    },
    { messageId: t.messageId },
  );
}

/** How a job went, as its end tells Bops Cloud (RunnerDone.job): `removed` when a remove took the app or its site off the web. */
export type JobResult = { ok: boolean; said: string; removed?: "app" | "site"; domain?: string };
/** What a job of a kind this runner doesn't do yet says (a newer Bops Cloud owes it): nothing was done. */
export const JOB_UNKNOWN = "This computer's Bops doesn't know how to do that yet.";

/** What a job that didn't go was, in the bot's chat ("Couldn't …"), by its kind. */
function couldnt(job: TurnJob): string {
  switch (job.act) {
    case "githubLink":
      return `Couldn't link ${job.app} to GitHub`;
    case "githubPull":
      return `Couldn't bring in GitHub's changes to ${job.app}`;
    case "deploy":
      return job.env === "prod" ? `Couldn't publish ${job.app}` : `Couldn't deploy ${job.app}`;
    case "rollback":
      return `Couldn't go back to an earlier deploy of ${job.app}`;
    case "settings":
      return `Couldn't change ${job.app}'s settings`;
    case "domain":
      return `Couldn't point a domain at ${job.app}`;
    case "remove":
      return `Couldn't remove ${job.app}`;
    case "removeSite":
      return `Couldn't remove ${job.site} from ${job.app}`;
    case "removeLeftOver":
      return `Couldn't remove the left over ${job.leftOver}`;
    case "compactChat":
      return "Couldn't compact this chat";
    default:
      // A kind from a newer Bops Cloud than this runner.
      return "Couldn't do that";
  }
}

/** How a job's result reads in the bot's chat (Bops' own words, as the bot). */
export const jobLine = (job: TurnJob, r: { ok: boolean; said: string }) => (r.ok ? r.said : `${couldnt(job)}: ${r.said}`);

/**
 * Do a job (TurnMember.job) on this computer, in `by`'s name, by its kind: an app's by hosted-apps.ts appJob (its GitHub
 * ones there by githubJob); compacting a chat (its turn's chat) by chat-summary.ts compactChat (chatJob). A kind this
 * runner doesn't do yet (one a newer Bops Cloud owes it) does nothing, and says so plainly.
 */
export async function runnerJob(ctx: TurnContext, job: TurnJob, by: string): Promise<JobResult> {
  if (job.act === "compactChat") return chatJob(ctx.chatId);
  if (!(APP_JOB_KINDS as readonly string[]).includes(job.act)) return { ok: false, said: JOB_UNKNOWN };
  return (await appJobOf())(ctx.botId, job as AppJob, by);
}

/** What a chat's compact that this runner couldn't save says (chat-summary.ts's own words for one that didn't go). */
const NOT_COMPACTED = "That didn't compact. Try again.";

/**
 * Compact a chat (the compactChat job), as the owner's Compact does (chat-summary.ts compactChat), with no line of its
 * own: Bops Cloud writes it, stamped as the teammate's who asked (cloud/turns.ts finish), and it never comes from here.
 * Said done only once Bops Cloud has the summary it wrote (store.ts changeLanded: its bots read the chat afresh from
 * there), so the line never says it's compacted while nothing changed.
 */
async function chatJob(chatId: string): Promise<JobResult> {
  const r = await (await compactOf())(chatId, undefined, { line: false });
  if (!r.ok) return { ok: false, said: r.error };
  const at = getState().chats?.find((c) => c.id === chatId)?.summary?.at;
  const has = (st: Record<string, unknown>) =>
    Array.isArray(st.chats) && st.chats.some((c: { id?: unknown; summary?: { at?: unknown } }) => c?.id === chatId && c.summary?.at === at);
  if (at === undefined || !(await (await landedOf())(has))) return { ok: false, said: NOT_COMPACTED };
  return { ok: true, said: "Compacted" };
}

/**
 * A job (TurnMember.job) as this turn: said at once to be doing what can't be done twice (it writes to Ingot, or Orgo),
 * so a runner gone quiet after never has it done again; then done (runnerJob) in `by`'s name, its words in the chat as
 * the bot's, marked Bops' own (bops) and, for an app's, about an app (Message.appNote), and its result told with the
 * turn's end (with what it removed), which Bops Cloud keeps on the app for Your Apps. A chat's compact has no words of
 * the bot's: Bops Cloud writes its line, done or why not, stamped as the teammate's (a bot's line would be something
 * for the next Compact to fold in). Taken back first (409): nothing is done.
 */
async function runJob(ctx: TurnContext, job: TurnJob, by: string) {
  ctx.acting = true;
  const first = await post(`/v1/runner/turns/${encodeURIComponent(ctx.id)}/beat`, { phase: "tools" });
  if (first.status === 409) return;
  let result: JobResult = { ok: false, said: "That didn't go. Try again." };
  let ran = false;
  await asTurn(
    ctx,
    async () => {
      result = await runnerJob(ctx, job, by);
      ran = true;
      if (!ctx.cancelled && job.act !== "compactChat") addMessage({ chatId: ctx.chatId, role: "bot", botId: ctx.botId, text: jobLine(job, result), ...(jobApp(job) ? { appNote: true } : {}), bops: true });
      // A remove's end only once what it cleared here is saved: Bops Cloud drops the app (or its site) as it hears it.
      if (isRemoveJob(job)) await flushState().catch((e: Error) => console.warn(`[runner-chat] ${ctx.id}: couldn't save before its end: ${e?.message ?? e}`));
      return null;
    },
    undefined,
    () => ({ ok: result.ok, said: result.said, ...(result.removed === "app" || result.removed === "site" ? { removed: result.removed } : {}), ...(result.ok && typeof result.domain === "string" ? { domain: result.domain } : {}) }),
  );
  // What members see of the app, told afresh: never after taking the app or a site off (Bops Cloud drops that from the
  // record as it hears the end, which this runner reads only later); after a left over goes, so it's gone there too.
  const app = jobApp(job);
  const b = app && ran && job.act !== "remove" && job.act !== "removeSite" ? getState().bots?.find((x) => x.id === ctx.botId) : undefined;
  if (app && b) void shareAppsView(workspaceOf(b), [app]).catch(() => {});
}

/**
 * A chat turn that paused for an OK goes on from the answer (chat.ts resumeChat, through permission.ts settleAsks). One
 * asked on a turn Bops Cloud owed (AskResume.cloudTurn) goes on only as that turn, once Bops Cloud says it may
 * (RunnerResume: still paused on this request, on this runner, its member still may), beating and ending as one. Any
 * other answer (it ended the turn meanwhile, or never answered) and nothing runs: the approved action never happens
 * outside its turn. One not asked on such a turn (from before this build) goes on as it is.
 */
export async function resumeAsTurn<T extends { paused?: boolean }>(a: AppApproval, go: () => Promise<T>): Promise<T> {
  const id = a.resume?.engine === "chat" ? a.resume.cloudTurn : undefined;
  if (!id || !a.chatId) return go();
  return whileMarked(id, () => resumeMarked(a, id, go));
}

async function resumeMarked<T extends { paused?: boolean }>(a: AppApproval, id: string, go: () => Promise<T>): Promise<T> {
  const r = await postSure<RunnerResume>(`/v1/runner/turns/${encodeURIComponent(id)}/resume`, { approvalId: a.id });
  if (r.status !== 200 || !r.body?.ok) {
    console.warn(`[runner-chat] ${id}: not going on from ${a.id} (${r.status || "no answer"})`);
    return { paused: false } as T;
  }
  // A group's (only a group's turn runs in a group chat here): its bots' tapbacks go with its end, as they would have.
  const c = getState().chats.find((x) => x.id === a.chatId);
  const botIds = c?.kind === "group" ? c.botIds : undefined;
  const ctx: TurnContext = { id, chatId: a.chatId!, botId: a.botId, ...(botIds ? { botIds } : {}), offsetMs: r.body.now - Date.now(), humanAt: r.body.humanAt, acting: true, cancelled: false };
  let out: T | undefined;
  await asTurn(ctx, async () => (out = await go()));
  return out ?? ({ paused: false } as T);
}

/** For tests: how the turn is run and how this runner makes sure it's on its own computer (unset: the real ones), and the beat. */
export function runnerChatForTests(opts: {
  answer?: typeof box.answer;
  identity?: typeof box.identity;
  beatMs?: number;
  retryMs?: number[];
  turnsDir?: string;
  holdPollMs?: number;
  workingMs?: number;
  job?: typeof box.job;
  compact?: typeof box.compact;
  landed?: typeof box.landed;
}) {
  box.answer = opts.answer;
  box.job = opts.job;
  box.compact = opts.compact;
  box.landed = opts.landed;
  box.identity = opts.identity;
  box.beatMs = opts.beatMs;
  box.turnsDir = opts.turnsDir;
  box.holdPollMs = opts.holdPollMs;
  box.retryMs = opts.retryMs;
  box.workingMs = opts.workingMs;
  if (box.working) clearInterval(box.working);
  box.working = undefined;
  box.running.clear();
}
