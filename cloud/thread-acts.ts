import { HttpError } from "./http.ts";
import { alwaysRule, ruleFor, taskWrite, type PermissionRule } from "./permission-rules.ts";
import { CLOUD_BY, COMPUTER_NOT_READY, NOT_WAITING } from "./protocol.ts";

/**
 * A teammate's acts on the owner's threads and asks, done by Bops Cloud itself in a workspace where everything goes
 * through the cloud (turns.ts allCloud; members.ts cloudAct), the owner's Mac on or off. Pure: the owner's state in,
 * the state to write out, with the notes to write in the chats and the computers to wake after. Each is a port of what
 * the owner's Mac writes for a thread it doesn't run (lib/server/sessions.ts replyToSession, stopSession, endPaused,
 * endSessionOf, dismissWaiting, compactThread, setWhere; lib/server/permission.ts replyToAsk; lib/server/member-acts.ts):
 * the same fields, so the bot's computer carries on with code it has (its poll takes a reply, stopAskedHere a stop,
 * pickUpQueued a thread queued again for it), and every Bops of the owner's merges the write as another Bops's
 * (lib/server/state-merge.ts mergeSession, ASKED_ELSEWHERE; mergeApproval). What it can't know itself (whether the
 * owner's Mac is on, the bot's computer and its runner, whether that runner listens) the caller reads first (ActEnv).
 *
 * Where a thread goes on is never the owner's Mac: one the Mac ran and left (its Mac off) or that ended is handed to the
 * bot's own computer (R), saying what's lost; one still running on the Mac while it's on stays there, as it's the Mac
 * running it now. A bot with no computer keeps the teammate's words, with a note that nothing can run them here.
 *
 * The helpers marked "as lib" are copies of the app's own, which this side can't import; scripts/test-thread-acts-parity.mjs
 * checks each is the same.
 */

type Blob = Record<string, unknown>;
const isObject = (v: unknown): v is Blob => !!v && typeof v === "object" && !Array.isArray(v);
const list = (v: unknown): Blob[] => (Array.isArray(v) ? v.filter(isObject) : []);

/* ---------------- As lib ---------------- */

/** As lib/types.ts live: queued, starting or running. */
export const live = (s: { status?: unknown }) => s.status === "queued" || s.status === "starting" || s.status === "running";
/** As lib/types.ts askedByRunner. */
const askedByRunner = (a: Blob, s: Blob) => !a.askedBy || !s.by || a.askedBy === s.by;
/** As lib/types.ts waitsForOk: live, with an unanswered request of its asked by the Bops that runs it. */
export const waitsForOk = (s: Blob, state: Blob) => live(s) && list(state.appApprovals).some((a) => a.threadId === s.id && !a.reply && askedByRunner(a, s));
/** As lib/types.ts pausedForOk: paused at a request its own Bops made, answered or not, until that Bops reads the reply. */
export const pausedForOk = (s: Blob, state: Blob) =>
  list(state.appApprovals).some((a) => a.threadId === s.id && (a.askedBy ?? undefined) === (s.by ?? undefined) && (isObject(a.resume) ? a.resume.engine : undefined) !== "held");

/** As lib/types.ts threadRunner. */
function threadRunner(s: Blob): string | undefined {
  if (s.onBopsAgent || s.agentSessionId || s.responseId) return "agent";
  const b = isObject(s.brainRun) ? s.brainRun : undefined;
  return b?.started ? (typeof b.kind === "string" ? b.kind : undefined) : undefined;
}
/**
 * As lib/types.ts threadCompacts. A brain ("claude") compacts only in a build with brains (BRAINS_ON): a thread whose
 * brain ran is from such a build, so here it's taken as on.
 */
export function threadCompacts(s: Blob): boolean {
  const r = threadRunner(s);
  if (r === "claude") return s.runsOn !== "mac";
  return r === "agent" && !!s.responseId && !s.agentSessionId && s.runsOn !== "mac";
}
/** As lib/types.ts COMPACTED: the step a thread's Compact leaves. */
export const COMPACTED = "compacted";
/** As lib/types.ts threadCompactBlocked. */
export function threadCompactBlocked(s: Blob): string | null {
  if (live(s) || s.compact) return "Wait for it to finish.";
  const last = list(s.steps).findLast((x) => x.tool === COMPACTED);
  if (last && !list(s.replies).some((r) => Number(r.at) > Number(last.at))) return "Nothing new to compact.";
  return null;
}

/** As lib/server/cli-agents.ts FINISH_ON_BOPS, WAIT, TRY_AGAIN and limitPick: a brain's limit offered these replies. */
export const FINISH_ON_BOPS = "Finish on Bops agent";
export const WAIT = "Wait";
export const TRY_AGAIN = "Try again";
export function limitPick(text: string): "bops" | "wait" | "retry" | undefined {
  const t = text.trim().toLowerCase().replace(/[.!]+$/, "");
  return t === FINISH_ON_BOPS.toLowerCase() ? "bops" : t === WAIT.toLowerCase() ? "wait" : t === TRY_AGAIN.toLowerCase() ? "retry" : undefined;
}
/** As lib/server/sessions.ts CARRY_ON: what a brain that had begun is told on Try again. */
export const CARRY_ON = "(From Bops: this stopped a moment ago because the AI wasn't answering. Carry on with the task from where you got to.)";

/** As lib/server/routing.ts ASKS_AGAIN: words that say the last answer was wrong (the router's next turn thinks harder). */
export const ASKS_AGAIN = /\b(try again|that'?s (wrong|not right|incorrect)|not what i (asked|wanted)|redo|do it again|look again|wrong answer)\b/i;

/** As lib/server/hosted-apps.ts keepsOffPreview (and its NAMES_PREVIEW, HOLD_BEFORE, HOLD_AFTER). */
const NAMES_PREVIEW = /\b(?:re-?)?deploy\w*|\bpreviews?\b/gi;
const HOLD_BEFORE =
  /(?:\b(?:(?:don['’]?t|do not|dont)(?!\s+(?:forget|see|think|know)\b)|never|without|hold off(?: on)?|wait (?:to|before|until)|no need to|(?:but|and) not)\s+(?:[\w'’-]+\s+){0,4}|\boff\s+(?:of\s+)?(?:the|its|our|my)\s+|\bno\s+)$/i;
const HOLD_AFTER = /^\s+(?:(?:it|this|that|them)\s+)?later\b/i;
export function keepsOffPreview(words: string): boolean {
  for (const m of words.matchAll(NAMES_PREVIEW)) {
    const at = m.index ?? 0;
    const clause = words.slice(0, at).split(/[.?!;:\n]/).pop() ?? "";
    if (HOLD_BEFORE.test(clause) || HOLD_AFTER.test(words.slice(at + m[0].length))) return true;
  }
  return false;
}

/** A task's write with a key (permission-rules.ts taskWrite), on a request as the state keeps it. */
const isTaskWrite = (a: Blob) => taskWrite({ ...(typeof a.kind === "string" ? { kind: a.kind as Parameters<typeof taskWrite>[0]["kind"] } : {}), ...(typeof a.threadId === "string" ? { threadId: a.threadId } : {}) });

/** As lib/server/sessions.ts PAUSED: a thread paused while the owner took its screen over (not a stop). */
const PAUSED = /^Paused while you took over/;

/* ---------------- What Bops Cloud knows first ---------------- */

/** Who did it (MemberWho), as Bops Cloud vouched for them. */
export type ActWho = { userId: string; email?: string; name: string };

/**
 * A bot's own computer as Bops Cloud found it before the act (members.ts cloudAct): its id (lowercased: turns.ts
 * computerFor with `cloud`, so a bot set to the owner's Mac has its own too), its runner's device ids (`devices`, R
 * first: device.ts deviceIdOf of the id, and of the id as the state writes it), whether that runner listens now (a stream
 * on this process, or bops.runner_presence seen in the last 45 seconds), and its runner as turns.ts runnerVersionOf says
 * it: "ok" new enough for a teammate's thread (THREAD_RUNNER_MIN), "old", or "none".
 */
export type ComputerFacts = { desktop: string; devices: string[]; listening: boolean; runner: "ok" | "old" | "none" };

export type ActEnv = {
  now: number;
  /** Whether the owner's Mac is on (the tunnel: members.ts isOn). */
  macOn: boolean;
  /** The owner's name, as their state says it (turns.ts ownerOf). */
  owner: string;
  /** Each bot's own computer (ComputerFacts), or null for a bot with none. */
  computerOf: (botId: string) => ComputerFacts | null;
};

/** A computer to wake after the write, for a thread: if it won't, the thread says why (`then` "step") or ends now ("end"). */
export type Wake = { desktop: string; botId: string; threadId: string; then: "step" | "end" };
/** What an act did: the state to write (null: nothing changed), the notes for the chats, and the computers to wake. */
export type ActDone = { blob: Blob | null; notes: Blob[]; wakes: Wake[] };

/* ---------------- Words ---------------- */

/** Said on a thread the owner's Mac ran, as it moves to the bot's computer (critic 15): what the Mac had isn't there. */
export const movedWords = (bot: string, owner: string) => `This thread moved to ${bot}'s computer. What it was doing on ${owner}'s Mac isn't there.`;
/** Said on a thread whose bot has no computer: the teammate's words stay, and nothing runs them here. */
export const noComputerWords = (bot: string) => `${bot} has no computer, so this can't go on in the cloud. Give ${bot} a computer in ${bot}'s settings.`;
/** 409: a thread's act needs a computer the bot hasn't got. */
export const noComputerToRun = (bot: string) => `${bot} has no computer to run this on.`;
/** 409 COMPUTER_NOT_READY: the bot's computer has no runner yet. */
export const noRunnerWords = (bot: string, owner: string) => `${bot}'s computer isn't set up yet. ${owner}'s Bops sets it up the next time it opens.`;
/** 409 COMPUTER_NOT_READY: the bot's computer runs a Bops too old for this. */
export const oldRunnerWords = (bot: string, owner: string) => `${bot}'s computer needs a newer Bops before it can do this. It updates the next time ${owner} opens Bops.`;
/** A thread's step when its computer won't wake for it (the Mac's words: sessions.ts queueAgain). */
export const wakeWords = (why: string) => `Waiting for its computer to wake: ${why}`;
/** The chat's line when a teammate picks where a thread runs (member-acts.ts "where"). */
export const pickedWords = (name: string, bot: string, title: string) => `${name} picked ${bot}'s computer for “${title}”`;

/* ---------------- Helpers ---------------- */

const botName = (blob: Blob, botId: unknown) => {
  const n = list(blob.bots).find((b) => b.id === botId)?.name;
  return typeof n === "string" && n.trim() ? n.trim() : "The bot";
};
const threadOf = (blob: Blob, id: string) => list(blob.sessions).find((s) => s.id === id);
/** `blob` with thread `id` changed by `f` (a copy: the blob in is never changed). */
function withThread(blob: Blob, id: string, f: (s: Blob) => Blob): Blob {
  return { ...blob, sessions: list(blob.sessions).map((s) => (s.id === id ? f(s) : s)) };
}
/** A copy of `s` with these fields set, `undefined` taking a field out (as patchSession does). */
function patched(s: Blob, set: Blob): Blob {
  const out: Blob = { ...s };
  for (const [k, v] of Object.entries(set)) {
    if (v === undefined) delete out[k];
    else out[k] = v;
  }
  return out;
}
const withStep = (s: Blob, at: number, tool: string, detail: string): Blob => ({ ...s, steps: [...list(s.steps), { at, tool, detail }] });

/** Whether `device` is one of the owner's Macs (AppState.macs: a computer's runner never is). */
const isMac = (blob: Blob, device: unknown) => typeof device === "string" && isObject(blob.macs) && Object.hasOwn(blob.macs, device);
/** Whether a thread is the owner's Mac's (where it runs, or the host it began on). */
const macThread = (s: Blob) => s.runsOn === "mac" || s.host === "mac";
/** Whether a live thread is run by the owner's Mac now: a Mac's device, or no device said (a thread from before Session.by is the Mac's). */
const onMacNow = (blob: Blob, s: Blob) => isMac(blob, s.by) || (s.by === undefined && macThread(s));

/** The computer a thread's act needs, ready: else 409 (no computer, no runner, too old). */
function readyComputer(blob: Blob, env: ActEnv, botId: unknown, noneWords = noComputerToRun): ComputerFacts {
  const bot = botName(blob, botId);
  const c = typeof botId === "string" ? env.computerOf(botId) : null;
  if (!c) throw new HttpError(409, noneWords(bot), { code: COMPUTER_NOT_READY });
  if (c.runner === "none") throw new HttpError(409, noRunnerWords(bot, env.owner), { code: COMPUTER_NOT_READY });
  if (c.runner === "old") throw new HttpError(409, oldRunnerWords(bot, env.owner), { code: COMPUTER_NOT_READY });
  return c;
}

/**
 * A thread queued again for the bot's computer (lib/server/sessions.ts queueAgain), in Bops Cloud: status queued, what
 * ended it cleared, and run by that computer's runner (`by` R), which picks it up as soon as it hears (pickUpQueued), woken
 * when it isn't listening. One the owner's Mac ran is handed over (runsOn "cloud", host "orgo", which the runner's queue
 * needs: sessions.ts pump), saying what's lost. Throws 409 for a computer that isn't ready.
 */
function queueAgain(blob: Blob, s: Blob, env: ActEnv, c: ComputerFacts): ActDone {
  const handed = macThread(s);
  let next = patched(s, { status: "queued", error: undefined, endedAt: undefined, stopAsked: undefined, by: c.devices[0], ...(handed ? { runsOn: "cloud", host: "orgo" } : {}) });
  if (handed) next = withStep(next, env.now, "note", movedWords(botName(blob, s.botId), env.owner));
  return { blob: withThread(blob, String(s.id), () => next), notes: [], wakes: c.listening ? [] : [{ desktop: c.desktop, botId: String(s.botId), threadId: String(s.id), then: "step" }] };
}

/* ---------------- Reply ---------------- */

/**
 * A teammate's reply in a thread (sessions.ts replyToSession, as member-acts.ts does it: hosted-apps.ts askDeployAgain
 * first, never a watch), kept by their key (`rep_m_<userId>_<key>`: the same act again changes nothing) and named as theirs
 * (`member.ref`, which their window waits for). A brain's limit pick (limitPick) and the router's bump as the Mac does
 * them. Then:
 * - live on the bot's computer, or on the owner's Mac while it's on: that's where it runs, and its poll takes the reply;
 * - waiting for where it runs: kept, for whoever picks;
 * - ended, or left behind by a Mac that's off: queued again for the bot's computer (queueAgain), the Mac's handed over;
 * - a bot with no computer: kept, with a note that nothing runs it here.
 */
export function replyIn(blob: Blob, sessionId: string, text: string, who: ActWho, key: string, env: ActEnv): ActDone {
  const s = threadOf(blob, sessionId);
  if (!s) throw new HttpError(404, "No such thread");
  const id = `rep_m_${who.userId}_${key}`;
  if (list(s.replies).some((r) => r.id === id || (isObject(r.member) && r.member.ref === key && r.member.userId === who.userId))) return { blob: null, notes: [], wakes: [] };
  // Its app's next commit goes on its Preview too, unless they said not to (askDeployAgain).
  const app = isObject(s.app) ? s.app : undefined;
  const deploys = !!app && app.from !== undefined && !app.deployAfter && !keepsOffPreview(text);
  const brain = isObject(s.brainRun) ? s.brainRun : undefined;
  const pick = !live(s) && !!brain?.waits && brain.waits !== "sign_in" ? limitPick(text) : undefined;
  const again = pick === "retry" && !!brain?.started;
  const reply: Blob = { id, role: "user", text: again ? CARRY_ON : text, at: env.now, delivered: !!pick && !again, ...(again ? { note: text } : {}), member: { ...who, ref: key } };
  let next: Blob = { ...s, replies: [...list(s.replies), reply] };
  if (deploys) next.app = { ...app, deployAfter: true };
  if (pick) delete next.options;
  if (pick === "wait" || pick === "retry") next.waitingOnYou = false;
  if (pick === "bops") next.onBopsAgent = true;
  if ((pick === "bops" || pick === "retry") && brain) {
    const rest = { ...brain };
    delete rest.waits;
    next.brainRun = rest;
  }
  const kept = withThread(blob, sessionId, () => next);
  if (pick === "wait") return { blob: kept, notes: [], wakes: [] };
  const c = env.computerOf(String(s.botId));
  if (live(s)) {
    if (s.askWhere === true) return { blob: kept, notes: [], wakes: [] };
    if (c && typeof s.by === "string" && c.devices.includes(s.by)) return { blob: kept, notes: [], wakes: c.listening ? [] : [{ desktop: c.desktop, botId: String(s.botId), threadId: sessionId, then: "step" }] };
    // Running on the owner's Mac now (paused at an OK counts: nothing of it runs anywhere, and the Mac carries it on).
    if (onMacNow(blob, s) && (env.macOn || pausedForOk(s, blob))) return { blob: kept, notes: [], wakes: [] };
  }
  if (!c) return { blob: withThread(kept, sessionId, (x) => withStep(x, env.now, "note", noComputerWords(botName(blob, s.botId)))), notes: [], wakes: [] };
  const ready = readyComputer(blob, env, s.botId);
  // It failed, or they say it's wrong: on the router's route, the next turn thinks a tier harder (routing.ts taskConfig).
  const route = isObject(next.route) ? next.route : undefined;
  if (route?.by === "router" && (s.status === "failed" || ASKS_AGAIN.test(text))) next = { ...next, route: { ...route, bumps: (Number(route.bumps) || 0) + 1 } };
  return queueAgain(withThread(blob, sessionId, () => next), next, env, ready);
}

/* ---------------- Stop and Dismiss ---------------- */

/** A thread's requests still waiting, rejected as Stop rejects them (permission.ts stopAsks), by Bops Cloud. */
function stopAsks(blob: Blob, threadId: string, at: number): Blob {
  if (!list(blob.appApprovals).some((a) => a.threadId === threadId && !a.reply)) return blob;
  return { ...blob, appApprovals: list(blob.appApprovals).map((a) => (a.threadId === threadId && !a.reply ? { ...a, reply: { reply: "reject", reason: "stopped", by: CLOUD_BY, at } } : a)) };
}

/** A thread over now, as the Bops that stopped it ends one nobody runs (sessions.ts endSessionOf): Bops Cloud's (`by` CLOUD_BY), so no stale copy brings it back. */
function endNow(blob: Blob, s: Blob, reason: string, at: number): Blob {
  const asked = typeof s.stopAsked === "string" && s.stopAsked && !PAUSED.test(s.stopAsked) ? s.stopAsked : undefined;
  const ended = patched(s, { status: "failed", error: asked ?? reason, endedAt: at, display: undefined, stopAsked: undefined, blocker: undefined, by: CLOUD_BY });
  return stopAsks(withThread(blob, String(s.id), () => ended), String(s.id), at);
}

/**
 * Stop (sessions.ts stopSession), `reason` "Stopped by <name>", for each thread still live, and its live parts:
 * - paused at a request nobody answered: over here and now (endPaused), its requests rejected;
 * - run by a Bops that listens (the bot's computer's runner, or the owner's Mac while it's on): asked to stop (stopAsked),
 *   which it does as it hears (stopAskedHere);
 * - run by the bot's computer, asleep: asked to stop, and woken; over now only when it won't wake (Wake "end");
 * - anything else (a Mac that's off, a runner gone or failed): over now (endNow).
 */
export function stopIn(blob: Blob, ids: readonly string[], reason: string, env: ActEnv): ActDone {
  let out = blob;
  const wakes: Wake[] = [];
  const stop = (id: string, depth: number) => {
    const s = threadOf(out, id);
    if (!s || !live(s) || depth > 20) return;
    if (pausedForOk(s, out) && waitsForOk(s, out)) {
      const ended = patched(s, { status: "failed", error: reason, endedAt: env.now, display: undefined, stopAsked: undefined, blocker: undefined, offerMac: undefined });
      out = stopAsks(withThread(out, id, () => ended), id, env.now);
    } else {
      const c = env.computerOf(String(s.botId));
      const onR = !!c && typeof s.by === "string" && c.devices.includes(s.by);
      if ((onR && c!.listening) || (onMacNow(out, s) && env.macOn)) {
        if (s.stopAsked !== reason) out = withThread(out, id, (x) => ({ ...x, stopAsked: reason }));
      } else if (onR && c!.runner !== "none") {
        out = withThread(out, id, (x) => ({ ...x, stopAsked: reason }));
        wakes.push({ desktop: c!.desktop, botId: String(s.botId), threadId: id, then: "end" });
      } else out = endNow(out, s, reason, env.now);
    }
    for (const p of list(out.sessions).filter((x) => x.partOf === id && live(x))) stop(String(p.id), depth + 1);
  };
  for (const id of ids) stop(id, 0);
  return { blob: out === blob ? null : out, notes: [], wakes };
}

/** Nothing to add (sessions.ts dismissWaiting): stopped as Stop does (stopIn), then marked dismissed with nothing waiting on anyone. */
export function dismissIn(blob: Blob, sessionId: string, who: ActWho, env: ActEnv): ActDone {
  if (!threadOf(blob, sessionId)) throw new HttpError(404, "No such thread");
  const stopped = stopIn(blob, [sessionId], `Dismissed by ${who.name}`, env);
  const out = withThread(stopped.blob ?? blob, sessionId, (s) => patched(s, { dismissed: true, waitingOnYou: false, blocker: undefined, options: undefined }));
  const same = JSON.stringify(threadOf(out, sessionId)) === JSON.stringify(threadOf(blob, sessionId));
  return { blob: same ? null : out, notes: [], wakes: stopped.wakes };
}

/* ---------------- Compact and Where ---------------- */

/**
 * Compact on a thread (sessions.ts compactThread): its brain folds what it has so far, once more on the bot's computer.
 * Only for a brain that does (threadCompacts), not while it runs nor with nothing new (threadCompactBlocked), and only on
 * a computer whose runner is ready (409 otherwise; the run there checks the AI credit and says why itself). Kept as theirs
 * (`compact.by.ref`: the same act again is done already), then queued and woken as a reply is (queueAgain).
 */
export function compactIn(blob: Blob, sessionId: string, who: ActWho, key: string, env: ActEnv): ActDone {
  const s = threadOf(blob, sessionId);
  if (!s) throw new HttpError(404, "No such thread");
  const by = isObject(s.compact) && isObject(s.compact.by) ? s.compact.by : undefined;
  if (by?.ref === key && by.userId === who.userId) return { blob: null, notes: [], wakes: [] };
  if (!threadCompacts(s)) throw new HttpError(400, "This thread's agent doesn't compact on request.");
  const blocked = threadCompactBlocked(s);
  if (blocked) throw new HttpError(409, blocked, { code: NOT_WAITING });
  const c = readyComputer(blob, env, s.botId);
  const was = { status: s.status, ...(s.error ? { error: s.error } : {}), ...(s.endedAt ? { endedAt: s.endedAt } : {}) };
  const next: Blob = { ...s, compact: { at: env.now, by: { ...who, ref: key }, was } };
  return queueAgain(withThread(blob, sessionId, () => next), next, env, c);
}

/**
 * An Admin picks where a thread that waits on it runs (sessions.ts setWhere, "cloud" only): the bot's own computer, run by
 * its runner (`by` R), woken as for a reply, and said in the chat as theirs (member-acts.ts "where": its note by their key).
 * Picked already: nothing changes. A bot with no computer, or one not ready: 409.
 */
export function whereIn(blob: Blob, sessionId: string, who: ActWho, key: string, env: ActEnv): ActDone {
  const s = threadOf(blob, sessionId);
  if (!s) throw new HttpError(404, "No such thread");
  if (s.askWhere !== true) return { blob: null, notes: [], wakes: [] };
  const c = readyComputer(blob, env, s.botId);
  const next = patched(s, { askWhere: false, runsOn: "cloud", by: c.devices[0], ...(s.host === "mac" ? { host: "orgo" } : {}) });
  const note = { id: `msg_where_${who.userId}_${key}`, chatId: s.chatId, role: "system", botId: s.botId, text: pickedWords(who.name, botName(blob, s.botId), String(s.title ?? "")), sessionIds: [sessionId], at: env.now };
  return { blob: withThread(blob, sessionId, () => next), notes: typeof s.chatId === "string" ? [note] : [], wakes: c.listening ? [] : [{ desktop: c.desktop, botId: String(s.botId), threadId: sessionId, then: "step" }] };
}

/* ---------------- After a wake ---------------- */

/**
 * A computer that won't wake for a thread (`why`, the chat's words: turns.ts NOTES): one queued for it says so in its
 * steps (Wake "step"), as the Mac does; one asked to stop is over now (Wake "end"), as one nobody runs. Nothing when the
 * thread moved on meanwhile.
 */
export function afterWake(blob: Blob, w: Wake, why: string, reason: string, env: Pick<ActEnv, "now" | "computerOf">): Blob | null {
  const s = threadOf(blob, w.threadId);
  if (!s || !live(s)) return null;
  const c = env.computerOf(w.botId);
  if (!c || typeof s.by !== "string" || !c.devices.includes(s.by)) return null;
  if (w.then === "end") return endNow(blob, s, typeof s.stopAsked === "string" && s.stopAsked ? s.stopAsked : reason, env.now);
  return withThread(blob, w.threadId, (x) => withStep(x, env.now, "note", wakeWords(why)));
}

/* ---------------- Answers ---------------- */

/**
 * A teammate's answer to a request for the owner's OK (permission.ts replyToAsk), written by Bops Cloud (`by` CLOUD_BY),
 * named as theirs (`member`): Allow once, Deny with what to do instead, or Always allow, which saves a rule on the bot
 * for that action (cloud/permission-rules.ts alwaysRule) and answers the bot's other requests for it, the same person's,
 * never a task's write (taskWrite). A key's card and a task's write take no Always allow. Throws 409 when it isn't
 * waiting. Returns the state and the requests answered.
 */
export function answerIn(blob: Blob, askId: string, reply: "once" | "always" | "reject", message: string | undefined, who: ActWho, at: number): { blob: Blob; answered: Blob[] } {
  const a = list(blob.appApprovals).find((x) => x.id === askId);
  if (!a || a.reply) throw new HttpError(409, "That's been answered.", { code: NOT_WAITING });
  if (a.kind === "key" && reply === "always") throw new HttpError(400, "Save the key on its card.");
  if (isTaskWrite(a) && reply === "always") throw new HttpError(400, "A task's change is allowed once at a time: Allow once or Deny.");
  const said = reply === "reject" ? message?.trim().slice(0, 2000) : undefined;
  const answer = { reply, ...(said ? { message: said } : {}), by: CLOUD_BY, at, member: who };
  const answered: Blob[] = [{ ...a, reply: answer }];
  let bots: Blob[] | null = null;
  if (reply === "always") {
    const b = list(blob.bots).find((x) => x.id === a.botId);
    if (b) {
      const had = (Array.isArray(b.permissions) ? b.permissions : []) as PermissionRule[];
      const added = alwaysRule(String(a.action), had);
      const rules = added ? [...had, added] : had;
      if (added) bots = list(blob.bots).map((x) => (x === b ? { ...b, permissions: rules } : x));
      const allowed = { permissions: rules };
      for (const y of list(blob.appApprovals))
        if (y !== a && !y.reply && y.botId === a.botId && ruleFor(allowed, String(y.action)) === "allow" && !isTaskWrite(y) && (y.askedFor ?? null) === (a.askedFor ?? null))
          answered.push({ ...y, reply: { reply: "always", by: CLOUD_BY, at, member: who } });
    }
  }
  const byId = new Map(answered.map((x) => [x.id, x]));
  return { blob: { ...blob, ...(bots ? { bots } : {}), appApprovals: list(blob.appApprovals).map((x) => byId.get(x.id) ?? x) }, answered };
}
