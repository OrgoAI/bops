import "server-only";
import { allows as rulesAllow, alwaysRule, ruleFor } from "@/lib/permission";
import { computerStaysDown, live, type AppApproval, type AskAnswer, type AskReply, type AskResume, type Bot } from "@/lib/types";
import type { MemberWho } from "@/lib/member-access";
import { onRunner } from "./persist";
import { addMessage, bot, changeLanded, getState, id, ownerName, pullState, session, stateDevice, update, watchArrivals, watchLoads } from "./store";

/**
 * Asking the user's OK, as OpenCode (packages/core/src/permission.ts) and Codex (approval policy, ReviewDecision)
 * do it, in Bops' state: a request is a plain record every Bops of the user's shares (AppApproval), and the pause
 * is held by OpenAI, not by a Bops process.
 *
 * Before asking, the bot's rules decide (lib/permission.ts: allows, a rule for the bot and the action, whatever its
 * recipients or details, as Claude Code's "don't ask again"): allowed, the tool just runs. Otherwise the tool
 * throws NeedsOk, and the engine running it pauses there (askFor): it opens the request with what resumes it (the
 * response or Agents API session that waits on that call's output, the call, the pending action), stops without
 * sending that call's output, and ends its turn (Paused): the thread waits, holding no screen and nothing in memory,
 * and nothing keeps its computer up. The thread's "Waiting for your OK" is the unanswered request (lib/types.ts
 * waitsForOk); nothing else marks it.
 *
 * Only two things resolve a request: the user's reply from one of their own Bops (replyToAsk: once, always, or
 * reject with a message the bot is told, like OpenCode's CorrectedError), or Stop on its thread (stopAsks: reject,
 * reason "stopped"). A bot's computer creates and takes out its own requests and never writes a reply (replyToAsk
 * refuses there, and Bops Cloud refuses its write: cloud/computer-scope.ts); someone the user shared a workspace
 * with sees the request, read only, and has none of the user's to answer. Otherwise a bot's computer is trusted for
 * its bots, as Claude Code is on the computer it runs on: its runner asks, and Bops Cloud doesn't check its calls
 * against the answers. When the reply lands on the device that asked (settleAsks), that device carries the same
 * run on from where it paused: it takes the record out as it reads
 * the reply (takeAnswer), does the action on Allow and sends its result as that call's output, or sends "Declined:
 * <the user's message>" on Deny. A restart of that device meanwhile loses nothing: the request and OpenAI's stored
 * state are enough, and a reply that came while it was down carries the run on once it has the state again
 * (settleLoaded). An answer to a request a bot's computer made gets that computer woken until its runner reads it
 * (wakeForAnswers: its run goes on there); Stop never does. A run ended for good on another Bops's behalf (its
 * computer deleted, the workspace shared, its runner failed or its program gone from the computer: runner-install.ts
 * stop and stillRuns, sessions.ts stopSession) has its requests stopped too (sessions.ts endSessionOf), and any Bops
 * takes out a resolved request of a runner that's gone (takeOutOrphans), so none is left that nobody can clear. A Stop
 * the Bops that asked hears only with the state it loads ends the run before it goes on from an answer (sessions.ts
 * pump, stopAskedHere).
 */

/** What a tool call needs the user's OK for, in the request's own words (AppApproval). */
export type AskSpec = Pick<AppApproval, "action" | "resources" | "preview" | "kind" | "api">;

/** A tool's call needs the user's OK: the engine running it pauses there (askFor). */
export class NeedsOk extends Error {
  readonly ask: AskSpec;
  constructor(ask: AskSpec) {
    super(`This needs ${ownerName()}'s OK first: ${ask.action}`);
    this.name = "NeedsOk";
    this.ask = ask;
  }
}

/** A run paused at request `askId`: its turn ends there, and its thread waits for the reply. */
export class Paused extends Error {
  readonly askId: string;
  constructor(askId: string) {
    super("Waiting for the OK");
    this.name = "Paused";
    this.askId = askId;
  }
}

/** Whether bot `b`'s rules let a request go without asking (lib/permission.ts): by its action alone. `justDoIt` false: Just do it doesn't count; `guarded`: Just do it still asks. */
export function allows(b: Pick<Bot, "autoApprove" | "permissions">, ask: Pick<AskSpec, "action">, opts: { justDoIt?: boolean; guarded?: boolean } = {}) {
  return rulesAllow(b, ask.action, opts);
}

/** Where a request is from: its bot, and the run's thread or the chat a chat turn is in. */
export type AskPlace = { botId: string; threadId?: string; chatId?: string; routineId?: string };

/**
 * Open a request (an engine pausing its run, or a held call): this Bops's (askedBy), with the thread, chat and
 * routine it's for and what resumes the run. Returns it.
 */
export function askFor(spec: AskSpec, place: AskPlace, resume: AskResume): AppApproval {
  const t = place.threadId ? session(place.threadId) : undefined;
  const routineId = t ? (t.routineId ?? (t.partOf ? session(t.partOf)?.routineId : undefined)) : place.routineId;
  const chatId = place.chatId ?? t?.chatId;
  const me = stateDevice();
  const a: AppApproval = {
    id: id("apr"),
    botId: place.botId,
    ...(place.threadId ? { threadId: place.threadId } : {}),
    ...(chatId ? { chatId } : {}),
    ...(routineId ? { routineId } : {}),
    ...(me ? { askedBy: me } : {}),
    action: spec.action,
    resources: spec.resources,
    preview: spec.preview,
    ...(spec.kind ? { kind: spec.kind } : {}),
    ...(spec.api ? { api: spec.api } : {}),
    at: Date.now(),
    resume,
  };
  update((s) => void (s.appApprovals ??= []).push(a));
  listenForAnswers();
  routinesFollow([a]);
  return a;
}

/**
 * Orgo's copy of the routines whose runs these requests are for goes again (routine-sync.ts): one whose run waits for
 * the user's OK goes with no next time, so Orgo's waker doesn't wake its computer for it meanwhile, and with its next
 * time again once they answer or Stop: the one after now, the times that came in the wait past (routines.ts pastWait).
 */
function routinesFollow(asks: AppApproval[]) {
  const theirs = asks.filter((a) => a.routineId && a.threadId);
  const bots = new Set(theirs.map((a) => a.botId));
  if (bots.size)
    void import("./routines")
      .then((m) => {
        for (const a of theirs) if (a.reply) m.pastWait(a.routineId!);
        return import("./routine-sync");
      })
      .then((m) => bots.forEach((b) => m.routineChanged(b)))
      .catch((e: Error) => console.warn(`[asks] routines: ${e.message}`));
}

/** What the bot is told when the user says no: their words (what to do instead), else that they said no. */
export function declined(a: Pick<AppApproval, "reply">): string {
  const said = a.reply?.message?.trim();
  return said ? `Declined: ${said}` : `Declined: ${ownerName()} said no. Don't do it, and don't do it another way.`;
}

const mine = (a: AppApproval, me = stateDevice()) => (a.askedBy ?? null) === (me ?? null);

/**
 * The user's reply to request `askId`, from one of their own Bops (the card's Allow once, Always allow or Deny):
 * written into the shared state, where the Bops that asked reads it and carries its run on. Always allow saves a
 * rule for the bot and the action, whatever its recipients or details (Claude Code's "don't ask again"), and answers
 * the bot's other requests for that action (as OpenCode does). Never from a bot's computer, never twice. Says why
 * when it isn't taken; undefined when it is. A request a bot's computer made wakes that computer, its run going on
 * there. `member`: answered by a member with Write on its bot, from their own Bops (member-acts.ts): the same
 * answer, named as theirs (AskAnswer.member), their Always allow saving the rule on the owner's bot as the owner's would.
 */
export function replyToAsk(askId: string, reply: AskReply, message?: string, member?: MemberWho): string | undefined {
  if (onRunner()) return "A bot's computer can't answer for you.";
  const a = getState().appApprovals?.find((x) => x.id === askId);
  if (!a || a.reply) return "That isn't waiting on you anymore.";
  const me = stateDevice();
  const at = Date.now();
  const said = reply === "reject" ? message?.trim().slice(0, 2000) : undefined;
  const answer: AskAnswer = { reply, ...(said ? { message: said } : {}), ...(me ? { by: me } : {}), at, ...(member ? { member } : {}) };
  const answered: AppApproval[] = [];
  update((s) => {
    const x = s.appApprovals?.find((y) => y.id === askId);
    if (!x || x.reply) return;
    x.reply = answer;
    answered.push(x);
    if (reply !== "always") return;
    const b = s.bots.find((y) => y.id === x.botId);
    if (!b) return;
    const added = alwaysRule(x.action, b.permissions);
    if (added) b.permissions = [...(b.permissions ?? []), added];
    for (const y of s.appApprovals ?? [])
      if (!y.reply && y.botId === x.botId && ruleFor(b, y.action) === "allow") {
        y.reply = { reply: "always", ...(me ? { by: me } : {}), at, ...(member ? { member } : {}) };
        answered.push(y);
      }
  });
  if (!answered.length) return "That isn't waiting on you anymore.";
  routinesFollow(answered);
  // The run's screen, when the user has it here, goes back to the run (sessions.ts handBackForAnswers).
  void import("./sessions")
    .then((m) => m.handBackForAnswers())
    .catch((e: Error) => console.warn(`[asks] handing the screen back: ${e.message}`));
  settleAsks();
  // A computer's runner that asked is woken for it until it reads it (wakeForAnswers), the chat told when it can't be.
  void wakeForAnswers({ tell: answered.filter((x) => !mine(x, me)).map((x) => x.id) });
  return undefined;
}

/**
 * Stop on thread `threadId`: its unanswered requests are rejected, reason "stopped", from whichever Bops pressed
 * it. Nothing is woken: the run ends where it paused (sessions.ts stopSession), and the Bops that asked takes the
 * record out once it hears, or any Bops does when that one never will (takeOutOrphans: a runner that's failed,
 * stopping or gone), one the user had answered too. Returns them.
 */
export function stopAsks(threadId: string): AppApproval[] {
  const me = stateDevice();
  const stopped: AppApproval[] = [];
  if (!getState().appApprovals?.some((a) => a.threadId === threadId)) return stopped;
  if (getState().appApprovals?.some((a) => a.threadId === threadId && !a.reply))
    update((s) => {
      for (const a of s.appApprovals ?? [])
        if (a.threadId === threadId && !a.reply) {
          a.reply = { reply: "reject", reason: "stopped", ...(me ? { by: me } : {}), at: Date.now() };
          stopped.push(a);
        }
    });
  routinesFollow(stopped);
  settleAsks();
  return stopped;
}

/** Take request `askId` out of the state: only the Bops that asked does, once it has read the reply (or its run is gone). */
function takeOut(askId: string) {
  if (getState().appApprovals?.some((a) => a.id === askId)) update((s) => void (s.appApprovals = (s.appApprovals ?? []).filter((a) => a.id !== askId)));
}

/** Why an answered request's action wasn't done: that it was read couldn't be saved (readOut). */
const NOT_READ = "Not done: Bops couldn't save that it read your answer, so it didn't act on it.";

/**
 * Take request `askId` out as its reply is read, and wait until that's saved for every Bops of the user's (in Bops
 * Cloud: store.ts changeLanded) before its action is done. A crash or restart before then loads the state with the
 * request still there, unread, and the run goes on from it then, once; a crash after, without it, so the action is
 * never done twice. Throws NOT_READ when it can't be saved (another account's state came in, a newer Bops wrote it):
 * nothing is done.
 */
async function readOut(askId: string) {
  takeOut(askId);
  if (!(await changeLanded((st) => !(Array.isArray(st.appApprovals) && st.appApprovals.some((a: { id?: unknown }) => a?.id === askId))))) throw new Error(NOT_READ);
}

/**
 * The answered request this Bops made for thread `threadId` (not a stop): its run resumes from it. That's the newest
 * of the thread's own: a run pauses at one request at a time, so it's the one the run waits at now, and an older one
 * still there is from a pause the run is past (read and taken out with it, never resumed from). Taken out as it's
 * read, and returned once that's saved (readOut), before the action is done, so a crash in between never does it
 * twice: before the save the run goes on from the same request after the restart, after it the thread ends as any
 * run does when Bops restarts, its call answered as not known to have run.
 */
export async function takeAnswer(threadId: string): Promise<AppApproval | undefined> {
  const own = (getState().appApprovals ?? []).filter((x) => x.threadId === threadId && x.resume?.engine !== "held" && mine(x));
  const now = own.reduce<AppApproval | undefined>((newest, x) => (!newest || x.at >= newest.at ? x : newest), undefined);
  for (const x of own) if (x !== now && x.reply) takeOut(x.id);
  if (!now?.reply || now.reply.reason === "stopped") return undefined;
  await readOut(now.id);
  return now;
}

/** Chat turns resuming here now (chat.ts resumeChat), by request id: each once. */
const resuming = new Set<string>();

/**
 * This Bops's own requests that were answered (here or on another of the user's Bops): a thread's run is picked up
 * again where it paused (sessions.ts pickUpAnswered: it takes the reply as it starts); a chat turn goes on (chat.ts
 * resumeChat). One stopped, or whose thread is over anyway, is taken out: nothing waits on it. Runs after every
 * change from elsewhere (store.ts watchArrivals), each time the user's state loads here (settleLoaded), and after a
 * reply or a stop here.
 */
export function settleAsks() {
  const me = stateDevice();
  let threads = false;
  for (const a of getState().appApprovals ?? []) {
    if (!a.reply || !mine(a, me) || a.resume?.engine === "held") continue;
    if (a.threadId) {
      const t = session(a.threadId);
      if (!t || !live(t) || a.reply.reason === "stopped") {
        takeOut(a.id);
        // What the paused run kept on this Bops to go on with (a Mac task's folder) goes too.
        const threadId = a.threadId;
        void import("./sessions")
          .then((m) => m.letGoOfPause(threadId))
          .catch((e: Error) => console.warn(`[asks] ${threadId}: ${e.message}`));
        // Stopped elsewhere while it waited here: over here too, if it isn't yet (the Bops that stopped it ended it).
        const at = a.reply.at;
        if (t && live(t) && a.reply.reason === "stopped") void import("./sessions").then((m) => m.endStopped(t.id, at), () => {});
      } else threads = true;
    } else if (a.resume?.engine === "chat" && !resuming.has(a.id)) {
      resuming.add(a.id);
      // Read and saved as read before the turn goes on (readOut), so a crash meanwhile never does its action twice.
      void readOut(a.id)
        .then(() => import("./chat"))
        .then((m) => m.resumeChat(a))
        .catch((e: Error) => console.warn(`[asks] ${a.id}: ${e.message}`))
        .finally(() => resuming.delete(a.id));
    } else if (!a.resume || a.resume.engine !== "chat") takeOut(a.id);
  }
  if (threads) void import("./sessions").then((m) => m.pickUpAnswered(), () => {});
  void takeOutOrphans().catch((e: Error) => console.warn(`[asks] orphans: ${e.message}`));
  void wakeForAnswers().catch((e: Error) => console.warn(`[asks] waking: ${e.message}`));
}
watchArrivals("asks", settleAsks);

/**
 * Requests of a computer's runner that's gone or being stopped, answered or stopped, whose run isn't that runner's any
 * more (its thread over, or another Bops's now: sessions.ts endSessionOf, which stops them): that runner will never
 * read them, so any Bops of the user's takes them out. Never a Mac's (state.macs: that Mac does, when it next hears),
 * nor on a runner (it takes out only its own).
 */
async function takeOutOrphans() {
  if (onRunner()) return;
  const s = getState();
  const left = (s.appApprovals ?? []).filter((a) => a.reply && a.askedBy && !mine(a) && !s.macs?.[a.askedBy]);
  if (!left.length) return;
  const { runnerComputerOf } = await import("./runner");
  for (const a of left) {
    const t = a.threadId ? session(a.threadId) : undefined;
    if (t && live(t) && t.by === a.askedBy) continue;
    const computer = runnerComputerOf(a.askedBy);
    const runner = computer ? Object.entries(getState().runners ?? {}).find(([k]) => k.toLowerCase() === computer)?.[1] : undefined;
    if (!runner || runner.status === "stopping" || runner.status === "failed") takeOut(a.id);
  }
}

/**
 * The user's state loaded here (a sign-in, Bops or a computer's runner starting): a reply that came while this Bops
 * was down or signed out came in with it, and no change from elsewhere said so. Its own answered requests carry their
 * runs on now, on their own (settleAsks), and on a computer's runner one still unanswered is listened for again
 * (listenForAnswers), as when it asked.
 */
function settleLoaded() {
  listenForAnswers();
  settleAsks();
}
watchLoads("asks", settleLoaded);

/**
 * The answered requests whose runs wait on a bot's computer, by computer: one a computer's runner made (askedBy) and
 * the user answered (Allow once, Always allow, Deny; never a Stop, which wakes nothing), still there because that
 * runner hasn't read it, of a run that's still that runner's (its thread live there). Derived from the state alone,
 * so every Mac of the user's sees the same, until the runner takes the request out.
 */
async function answersWaiting(): Promise<Map<string, AppApproval[]>> {
  const out = new Map<string, AppApproval[]>();
  const theirs = (getState().appApprovals ?? []).filter((a) => a.reply && a.reply.reason !== "stopped" && a.askedBy && !mine(a));
  if (!theirs.length) return out;
  const { runnerComputerOf } = await import("./runner");
  for (const a of theirs) {
    const computer = runnerComputerOf(a.askedBy);
    const t = a.threadId ? session(a.threadId) : undefined;
    if (!computer || (a.threadId && (!t || !live(t) || t.by !== a.askedBy))) continue;
    out.set(computer, [...(out.get(computer) ?? []), a]);
  }
  return out;
}

/** Each computer woken for an answer (wakeForAnswers): when to look at it again, how many looks it's had, and the requests it was for. */
const wakes = new Map<string, { next: number; tries: number; seen: Set<string> }>();
const waking = new Set<string>();
/** Requests answered here whose chat is told when their computer can't be woken (tellNotWoken), and those told: once each. */
const toTell = new Set<string>();
const told = new Set<string>();
const gw = globalThis as unknown as { bopsAnswerWake?: ReturnType<typeof setTimeout> };
/** How long to wait before looking at a computer again: soon while it's on its way up, longer after each look. Tests shorten it. */
export const answerWakeTiming = { firstMs: 15_000, maxMs: 5 * 60_000, upMs: 2 * 60_000 };

/**
 * The run that waits on a user's answer on a bot's computer needs that computer (answersWaiting): it's woken until its
 * runner takes the answer, from every Mac of the user's, on their answer, whenever the state loads or changes come in
 * from elsewhere, and at the Mac's look at the runners (runner-install.ts), and again later while it isn't up, as a run
 * that waits doesn't keep it up. Asleep, it's resumed (free-hours.ts wakeForUser); on its way down or up (suspending,
 * resuming) it isn't awake yet, and is looked at again; Orgo not answering, the same. Up, it's looked at again a while
 * later, in case it went back to sleep before its runner read the answer. A computer that's stopped or broken isn't
 * this to wake (runner-install.ts lookDown). Never on a runner. `tell`: requests the user just answered here, whose chat
 * says why when it can't be woken (Free's hours used up this month), once.
 */
export async function wakeForAnswers(opts: { tell?: string[] } = {}): Promise<void> {
  if (onRunner()) return;
  for (const id of opts.tell ?? []) toTell.add(id);
  const waiting = await answersWaiting();
  for (const k of wakes.keys()) if (!waiting.has(k)) wakes.delete(k);
  const ids = new Set([...waiting.values()].flat().map((a) => a.id));
  for (const id of toTell) if (!ids.has(id)) toTell.delete(id);
  const now = Date.now();
  await Promise.all(
    [...waiting].map(async ([computer, asks]) => {
      const was = wakes.get(computer);
      // An answer it wasn't looked at for yet (just answered, here or on another Mac) is looked at now.
      if (waking.has(computer) || (was && was.next > now && asks.every((a) => was.seen.has(a.id)))) return;
      waking.add(computer);
      const tries = (was?.tries ?? 0) + 1;
      try {
        const { up, why } = await wakeComputer(computer);
        const wait = up ? answerWakeTiming.upMs : Math.min(answerWakeTiming.maxMs, answerWakeTiming.firstMs * 2 ** Math.min(tries - 1, 6));
        wakes.set(computer, { next: Date.now() + wait, tries: up ? 0 : tries, seen: new Set(asks.map((a) => a.id)) });
        for (const a of asks.filter((x) => toTell.delete(x.id))) if (why) tellNotWoken(a, why);
      } catch (e) {
        console.warn(`[asks] waking ${computer}: ${(e as Error).message}`);
        wakes.set(computer, { next: Date.now() + answerWakeTiming.firstMs, tries, seen: new Set(asks.map((a) => a.id)) });
      } finally {
        waking.delete(computer);
      }
    }),
  );
  if (gw.bopsAnswerWake) clearTimeout(gw.bopsAnswerWake);
  gw.bopsAnswerWake = undefined;
  if (!wakes.size) return;
  const next = Math.min(...[...wakes.values()].map((w) => w.next));
  gw.bopsAnswerWake = setTimeout(() => void wakeForAnswers().catch(() => {}), Math.max(1000, next - Date.now()));
  gw.bopsAnswerWake.unref?.();
}

/** One look at computer `id` for an answer that waits on it: up (running), or woken if it's asleep, or why it can't be. */
async function wakeComputer(id: string): Promise<{ up: boolean; why?: string }> {
  const [{ orgo }, { wakeForUser }] = await Promise.all([import("./orgo"), import("./free-hours")]);
  const c = await orgo.computer(id).catch(() => null);
  if (c?.status === "running") return { up: true };
  // Stopped, broken or gone: nothing wakes it from here, and the look at the runners says why its runs wait.
  if (c && computerStaysDown(c.status)) return { up: false };
  // Asleep (or Orgo didn't say): resumed. On its way down or up: not awake yet, looked at again.
  if (c && c.status !== "suspended") return { up: false };
  const why = await wakeForUser(id);
  // Orgo not answering is no reason to give the user: it's tried again.
  return { up: false, ...(why && c ? { why } : {}) };
}

/** The chat of a request whose computer couldn't be woken for the user's answer says why, once. */
function tellNotWoken(a: AppApproval, why: string) {
  if (told.has(a.id)) return;
  told.add(a.id);
  const chatId = a.chatId ?? (a.threadId ? session(a.threadId)?.chatId : undefined);
  if (!chatId) return;
  const name = bot(a.botId)?.name ?? "The bot";
  addMessage({
    chatId,
    role: "system",
    text: `${name}'s computer couldn't be woken for your answer: ${why.trim().replace(/[.!]?$/, ".")} ${name} goes on with it once the computer is up.`,
    ...(a.threadId ? { sessionIds: [a.threadId] } : {}),
  });
}

/** How often a computer's runner reads the state while a request of its waits and it's up (listenForAnswers). */
const ANSWER_READ_MS = 5_000;
const g = globalThis as unknown as { bopsAskListen?: ReturnType<typeof setInterval> };

/**
 * On a computer's runner, which has no Live stream and reads the state every 30 seconds: while one of its requests
 * is unanswered, and it's up anyway, it reads it every few seconds, so a reply reaches the run within moments. A
 * read of Bops Cloud is no command on the computer, so it never keeps it up; asleep, nothing runs at all.
 */
function listenForAnswers() {
  if (!onRunner() || g.bopsAskListen) return;
  g.bopsAskListen = setInterval(() => {
    if ((getState().appApprovals ?? []).some((a) => !a.reply && mine(a))) return void pullState().catch(() => {});
    clearInterval(g.bopsAskListen);
    g.bopsAskListen = undefined;
  }, ANSWER_READ_MS);
  g.bopsAskListen.unref?.();
}

/** How often a held call looks for its reply (heldAsk). Tests shorten it. */
export const askTimingHeld = { pollMs: 1000 };

/**
 * A run that holds the call itself (a brain's tool, through the screen tools: cli-agents.ts) can't pause: it opens
 * the request and waits here for the reply, `ms` at most, while `alive` says its run goes on. The request is taken
 * out once read, or when the wait ends without one: "late" (no reply in time), "gone" (the run ended).
 */
export function heldAsk(spec: AskSpec, place: AskPlace, opts: { ms: number; alive: () => boolean }): Promise<AskAnswer | "late" | "gone"> {
  const a = askFor(spec, place, { engine: "held" });
  const until = Date.now() + opts.ms;
  return new Promise((resolve) => {
    const timer = setInterval(() => {
      const now = getState().appApprovals?.find((x) => x.id === a.id);
      const out = now?.reply ? now.reply : !now || !opts.alive() ? "gone" : Date.now() > until ? "late" : undefined;
      if (!out) return;
      clearInterval(timer);
      takeOut(a.id);
      resolve(out);
    }, askTimingHeld.pollMs);
    timer.unref?.();
  });
}
