import "server-only";
import { readlinkSync } from "node:fs";
import { trackServerEvent } from "./analytics";
import { botChatId, live, procedureNamed, workspaceOf, type Bot, type Delivery, type Message, type Routine, type RoutineRun, type Schedule, type Session } from "@/lib/types";
import { clampEvery, describeSchedule as describe, nextRun, parseClock, resolveOnce, whenText } from "@/cloud/schedule";
import { plainLinks } from "@/cloud/style";
import { pingIfWorthIt } from "./attention";
import { onPostgres } from "./persist";
import { startSession } from "./sessions";
import { addMessage, bot, getState, id, ownerName, patchSession, session, stateReady, update } from "./store";

/**
 * Routines and scheduled asks. Each one belongs to a bot. When one comes due it's a reminder (a message
 * from the bot), a chat run (a turn in the bot's chat with its tools and no computer), or a task (a
 * thread on a computer). A quiet routine that finds nothing for the user posts nothing; a routine's
 * result can also go to the user by text, email, or Slack, Telegram or Discord (deliverTo), and how its
 * last run went (and whether its result arrived) is kept on it (Routine.last).
 *
 * Times are the user's local time: Owner.timeZone, which this Mac keeps current, else this Mac's zone.
 * The math is in cloud/schedule.ts, so Bops Cloud can run the same schedules later.
 */

/** The zone Node's dates and Intl use right now. */
const nodeZone = () => Intl.DateTimeFormat().resolvedOptions().timeZone || "UTC";

/**
 * This Mac's time zone as macOS has it now. Node reads the zone once, at launch, and never follows a
 * change (travel), so the system's own setting (/etc/localtime, a link into the zone files) is read
 * fresh each time; Node's own is the fallback (another system, a link Bops can't read). A TZ that was
 * set before Bops started (someone's own setting) is the zone, as Node has it. Tests only:
 * BOPS_LOCALTIME_PATH stands in for /etc/localtime.
 */
function macZone(): string {
  if (process.env.TZ && process.env.TZ !== g.__bopsTzSet) return nodeZone();
  try {
    const zone = /zoneinfo\/(.+)$/.exec(readlinkSync(process.env.BOPS_LOCALTIME_PATH || "/etc/localtime"))?.[1];
    if (zone && /^[A-Za-z0-9_+-]+(\/[A-Za-z0-9_+-]+)*$/.test(zone)) return zone;
  } catch {}
  return nodeZone();
}

/** The zone routines run in: the user's, as this Mac last saw it, else this Mac's own. */
export const routineZone = () => getState().owner?.timeZone || macZone();

/** A schedule in a few plain words, in the user's zone: "Weekdays at 9 AM", "Every 2 hours, 8 AM to 10 PM". */
export const describeSchedule = (schedule: Schedule) => describe(schedule, routineZone());

/** A quiet run's answer when nothing needs the user. */
export const isNothing = (text: string) => /^\s*NOTHING\.?\s*$/i.test(text);

/**
 * What a chat run fails with while the user's AI credit is used up (chat.ts backgroundTurn). Said in the
 * bot's chat once, never sent by text, email or a channel: like a task's (sessions.ts).
 */
export const NO_CREDIT_FOR_ROUTINES = "Out of AI credit. Upgrade in Settings to keep routines running.";

/** A text is kept to this many characters; the rest is in Bops. */
const TEXT_MAX = 600;

const KIND_NAME = { slack: "Slack", telegram: "Telegram", discord: "Discord" } as const;

/** Chat runs going right now, so one doesn't start while the last is still going. */
const g = globalThis as unknown as {
  __bopsRoutines?: NodeJS.Timeout;
  __bopsRoutineTick?: typeof tick;
  __bopsRoutineRuns?: Set<string>;
  __bopsRanNow?: Map<string, { routineId: string; askedIn: string }>;
  __bopsZoneSeen?: string;
  __bopsTzSet?: string;
};
const running = (g.__bopsRoutineRuns ??= new Set());
/** Threads a run someone asked for (Run now) started, by thread: the routine's id, and where it was asked for (RunOpts.manual). */
const ranNowThreads = (g.__bopsRanNow ??= new Map());

const routine = (routineId: string) => getState().routines.find((x) => x.id === routineId);

/** whenText inside a sentence: "due today 9 AM", "next tomorrow 8 AM" (weekdays and months keep their capitals). */
const inSentence = (when: string) => when.replace(/^(Today|Tomorrow|Yesterday)\b/, (w) => w.toLowerCase());

/** Set how the routine's last run went. */
function record(routineId: string, run: RoutineRun): RoutineRun {
  update((s) => {
    const r = s.routines.find((x) => x.id === routineId);
    if (r) r.last = run;
  });
  return run;
}

/** Where its result went, once it got there (or didn't), on the run it belongs to. */
function recordDelivery(routineId: string, at: number, delivery: RoutineRun["delivery"]) {
  if (!delivery) return;
  update((s) => {
    const r = s.routines.find((x) => x.id === routineId);
    if (r?.last && r.last.at === at) r.last.delivery = delivery;
  });
}

/* ---------------- Making and changing them ---------------- */

/**
 * A schedule as kept: times of day written "HH:MM", an "every" gap of at least MIN_EVERY_MINUTES, days
 * of the week that are days. Undefined, with what's wrong, when it can't run.
 */
function tidy(schedule: Schedule): { schedule?: Schedule; error?: string } {
  const hhmm = (time: string) => {
    const m = parseClock(time);
    return m === undefined ? undefined : `${String(Math.floor(m / 60)).padStart(2, "0")}:${String(m % 60).padStart(2, "0")}`;
  };
  const badTime = (time: unknown) => `"${String(time)}" isn't a time of day. Use 24 hour time, like 09:00.`;
  if (!schedule || typeof schedule !== "object") return { error: "That isn't a schedule." };
  if (schedule.kind === "once") return Number.isFinite(schedule.at) ? { schedule: { kind: "once", at: schedule.at } } : { error: "That isn't a time Bops can read." };
  if (schedule.kind === "daily" || schedule.kind === "weekdays") {
    const time = hhmm(schedule.time);
    return time ? { schedule: { kind: schedule.kind, time } } : { error: badTime(schedule.time) };
  }
  if (schedule.kind === "weekly") {
    const time = hhmm(schedule.time);
    if (!time) return { error: badTime(schedule.time) };
    if (!Number.isInteger(schedule.day) || schedule.day < 0 || schedule.day > 6) return { error: "The day of the week runs from 0 (Sunday) to 6 (Saturday)." };
    return { schedule: { kind: "weekly", day: schedule.day, time } };
  }
  if (schedule.kind === "every") {
    const out: Extract<Schedule, { kind: "every" }> = { kind: "every", minutes: clampEvery(schedule.minutes) };
    if (schedule.hours) {
      const from = hhmm(schedule.hours.from);
      const to = hhmm(schedule.hours.to);
      if (!from) return { error: badTime(schedule.hours.from) };
      if (!to) return { error: badTime(schedule.hours.to) };
      if (from !== to) out.hours = { from, to };
    }
    const days = [...new Set((schedule.days ?? []).filter((d) => Number.isInteger(d) && d >= 0 && d <= 6))].sort();
    if (schedule.days?.length && !days.length) return { error: "The days of the week run from 0 (Sunday) to 6 (Saturday)." };
    if (days.length && days.length < 7) out.days = days;
    return { schedule: out };
  }
  return { error: "That isn't a schedule Bops knows." };
}

/** A procedure of the bot's, by id or name (found the way read_procedure finds one: procedureNamed): its id. */
const procedureOf = (botId: string, nameOrId: string): string | undefined =>
  procedureNamed(
    (getState().procedures ?? []).filter((p) => p.botId === botId),
    nameOrId,
  )?.id;

/** A delivery the routine can use: a channel link that's there. */
function checkDelivery(d: Delivery | undefined): string | undefined {
  if (!d) return undefined;
  if (d.kind === "text" || d.kind === "email") return undefined;
  if (d.kind === "channel") return (getState().channels ?? []).some((l) => l.id === d.linkId) ? undefined : "That Slack, Telegram or Discord link isn't there anymore.";
  return "Results go by text, by email, or to Slack, Telegram or Discord.";
}

/** What createRoutine and editRoutine take besides the schedule. */
type RoutineOpts = {
  where?: Routine["where"];
  reminder?: string;
  textTo?: Routine["textTo"];
  run?: "chat" | "task";
  quiet?: boolean;
  deliverTo?: Delivery;
  procedure?: string;
  /** Set up on a turn someone else started: who it came from (Routine.fromOutside). */
  fromOutside?: string;
};

/**
 * A new routine for a bot. A "once" time that passed earlier today (up to a day ago) is moved to the
 * same time tomorrow, and `moved` says so; one further back is refused, and nothing is made. A schedule
 * that never comes due is refused too: no routine is left on with no next time.
 *
 * Set up on someone else's say (`fromOutside`): a reminder, or a task in the cloud, at most once a day,
 * never quiet and never sent anywhere but the chat. A stranger can't set up silent work through the day,
 * a chat run with the user's data and the web, or messages to the user's phone or inbox. (A turn someone
 * else started no longer sets up routines at all: chat.ts NOT_FROM_OUTSIDE. Ones from before keep these
 * limits when they run.)
 */
export function createRoutine(botId: string, title: string, goal: string, schedule: Schedule, opts: RoutineOpts = {}): { routine?: Routine; error?: string; moved?: boolean } {
  if (!bot(botId)) return { error: "No such bot." };
  const owner = ownerName();
  const outside = opts.fromOutside?.trim() || undefined;
  if (outside && schedule?.kind === "every") return { error: `Only ${owner} can set up a routine that repeats through the day.` };
  if (outside && opts.deliverTo) return { error: `Only ${owner} can have a routine's results sent by text, email, Slack, Telegram or Discord. Its results stay in this chat.` };
  const tz = routineZone();
  const now = Date.now();
  const tidied = tidy(schedule);
  if (!tidied.schedule) return { error: tidied.error };
  let s = tidied.schedule;
  let moved = false;
  if (s.kind === "once") {
    const at = resolveOnce(s.at, now, tz);
    if ("refused" in at) return { error: at.refused };
    s = { kind: "once", at: at.at };
    moved = at.moved;
  }
  const nextRunAt = s.kind === "once" ? s.at : nextRun(s, now, tz);
  if (nextRunAt === undefined) return { error: "That schedule never comes due." };
  const bad = checkDelivery(opts.deliverTo);
  if (bad) return { error: bad };
  const procedure = opts.procedure?.trim() ? procedureOf(botId, opts.procedure) : undefined;
  if (opts.procedure?.trim() && !procedure) return { error: `No procedure called "${opts.procedure.trim()}".` };
  const reminder = opts.reminder?.trim() || undefined;
  const r: Routine = {
    id: id("rtn"),
    botId,
    title: title.trim() || goal.trim().slice(0, 40),
    goal,
    schedule: s,
    enabled: true,
    nextRunAt,
    // Someone else's: in the cloud, as a task, posting every run (never quiet).
    ...(outside ? { where: "cloud" as const } : opts.where ? { where: opts.where } : {}),
    ...(reminder ? { reminder } : {}),
    ...(opts.textTo ? { textTo: opts.textTo } : {}),
    // A reminder is the message itself: it doesn't run, so it's never quiet.
    ...(!reminder && (outside || opts.run) ? { run: outside ? ("task" as const) : opts.run } : {}),
    ...(!reminder && !outside && opts.quiet ? { quiet: true } : {}),
    ...(opts.deliverTo ? { deliverTo: opts.deliverTo } : {}),
    ...(procedure ? { procedure } : {}),
    ...(outside ? { fromOutside: outside.slice(0, 200) } : {}),
  };
  update((st) => st.routines.push(r));
  trackServerEvent("bops_routine_created", {});
  return { routine: r, ...(moved ? { moved: true } : {}) };
}

/**
 * Change a routine. A new schedule is checked like a new routine's ("once" times that passed are moved
 * or refused) and sets the next time; a field given as undefined clears it (deliverTo, procedure).
 */
export function editRoutine(
  routineId: string,
  patch: Partial<Pick<Routine, "title" | "goal" | "schedule" | "quiet" | "deliverTo" | "run" | "procedure" | "where">>,
): { routine?: Routine; error?: string; moved?: boolean } {
  const r = routine(routineId);
  if (!r) return { error: "No such routine." };
  // Someone else's routine stays a task in the cloud: a chat run would have the user's data and the web on a stranger's say.
  if (r.fromOutside && patch.run === "chat") return { error: `It was set up by ${r.fromOutside}, so it runs as a task in the cloud. Make a new routine to run it as a chat.` };
  // And in the cloud: its thread is marked as theirs, which never runs on the user's Mac (sessions.ts StartOptions.outside).
  if (r.fromOutside && patch.where === "mac") return { error: outsideStaysInCloud(r) };
  const tz = routineZone();
  const now = Date.now();
  let schedule: Schedule | undefined;
  let nextRunAt = r.nextRunAt;
  let moved = false;
  if (patch.schedule) {
    const tidied = tidy(patch.schedule);
    if (!tidied.schedule) return { error: tidied.error };
    schedule = tidied.schedule;
    if (schedule.kind === "once") {
      const at = resolveOnce(schedule.at, now, tz);
      if ("refused" in at) return { error: at.refused };
      schedule = { kind: "once", at: at.at };
      moved = at.moved;
    }
    if (r.enabled) {
      nextRunAt = schedule.kind === "once" ? schedule.at : nextRun(schedule, now, tz, r.lastRunAt);
      if (nextRunAt === undefined) return { error: "That schedule never comes due." };
    }
  }
  if ("deliverTo" in patch) {
    const bad = checkDelivery(patch.deliverTo);
    if (bad) return { error: bad };
  }
  let procedure: string | undefined;
  if ("procedure" in patch && patch.procedure?.trim()) {
    procedure = procedureOf(r.botId, patch.procedure);
    if (!procedure) return { error: `No procedure called "${patch.procedure.trim()}".` };
  }
  if (patch.title !== undefined && !patch.title.trim()) return { error: "A routine needs a title." };
  if (patch.goal !== undefined && !patch.goal.trim()) return { error: "A routine needs something to do." };
  update(() => {
    if (patch.title !== undefined) r.title = patch.title.trim();
    if (patch.goal !== undefined) r.goal = patch.goal;
    if (schedule) {
      r.schedule = schedule;
      r.nextRunAt = nextRunAt;
    }
    if ("quiet" in patch) r.quiet = patch.quiet && !r.reminder ? true : undefined;
    if ("run" in patch) r.run = patch.run;
    if ("where" in patch) r.where = patch.where;
    if ("deliverTo" in patch) r.deliverTo = patch.deliverTo ?? undefined;
    if ("procedure" in patch) r.procedure = procedure;
  });
  return { routine: r, ...(moved ? { moved: true } : {}) };
}

/**
 * Pause or resume a routine. Resuming works out its next time from now (an "every" one keeps its beat);
 * a "once" routine whose time has passed (it ran, or it was missed) can't resume: it needs a new time.
 */
export function setRoutineEnabled(routineId: string, enabled: boolean): { error?: string } {
  const r = routine(routineId);
  if (!r) return { error: "No such routine." };
  if (!enabled) {
    update(() => {
      r.enabled = false;
      r.nextRunAt = undefined;
    });
    return {};
  }
  const now = Date.now();
  const next = r.schedule.kind === "once" ? (r.schedule.at > now ? r.schedule.at : undefined) : nextRun(r.schedule, now, routineZone(), r.lastRunAt);
  if (next === undefined) return { error: r.schedule.kind === "once" ? "Its time has passed. Give it a new time to run it again." : "That schedule never comes due." };
  update(() => {
    r.enabled = true;
    r.nextRunAt = next;
  });
  return {};
}

/** Why a routine can't run on the user's Mac: someone else set it up (Routine.fromOutside), so its runs stay in the cloud. */
const outsideStaysInCloud = (r: Routine) => `It was set up by ${r.fromOutside}, so it runs in the cloud. Make a new routine to run it on ${ownerName()}'s Mac.`;

/** Where a routine's task runs from now on: the user's Mac (not for someone else's routine), the cloud, or decided each time (auto). */
export function setRoutineWhere(routineId: string, where: "auto" | "cloud" | "mac"): { error?: string } {
  const r = routine(routineId);
  if (!r) return { error: "No such routine." };
  if (r.fromOutside && where === "mac") return { error: outsideStaysInCloud(r) };
  update(() => (r.where = where));
  return {};
}

export function deleteRoutine(routineId: string) {
  update((s) => (s.routines = s.routines.filter((x) => x.id !== routineId)));
}

/* ---------------- Running them ---------------- */

/**
 * How a run came: on its time (`due`, when it was due), or asked for now (`manual`, Run now): "app" for the
 * button in the Bops app, else the id of the chat message that asked for it (manage_routine), so its result
 * goes back only where that message came from (ranNow).
 */
type RunOpts = { manual?: string; due?: number };

/** The timer ran it well after it was due (the Mac was asleep, or Bops closed). */
const isLate = (opts: RunOpts, at: number) => !opts.manual && opts.due !== undefined && at - opts.due > 2 * 60_000;

/** "Routine · Every day at 9 AM", with "run now" when the user asked, or "late" and when it was due. */
function chipText(r: Routine, opts: RunOpts) {
  const now = Date.now();
  const tz = routineZone();
  const how = opts.manual ? " · run now" : isLate(opts, now) ? ` · late, it was due ${inSentence(whenText(opts.due!, now, tz))}` : "";
  return `Routine · ${describe(r.schedule, tz)}${how}`;
}

/**
 * Run a routine now: its time came (the timer), or the user asked (`manual`, Run now). Returns how the
 * run went so far: a task is "running" until its thread ends (onRoutineTaskEnd).
 * - A reminder: the message, from the bot, in its chat (and by text or wherever it's delivered).
 * - "chat": one turn of the bot with its tools and no computer (chat.ts backgroundTurn). Its answer is
 *   posted in the bot's chat and delivered, unless the routine is quiet and nothing needed the user.
 * - "task" (or unset): a new thread, unless the last one is still going.
 */
export function runRoutine(routineId: string, opts: { manual?: string } = {}): Promise<RoutineRun> {
  return run(routineId, { manual: opts.manual });
}

async function run(routineId: string, opts: RunOpts): Promise<RoutineRun> {
  const r = routine(routineId);
  const at = Date.now();
  if (!r) return { at, status: "skipped", error: "No such routine." };
  const b = bot(r.botId);
  if (!b) return record(r.id, { at, status: "skipped", error: "Its bot isn't there anymore." });
  if (opts.manual) update(() => (r.lastRunAt = at));
  if (r.reminder) return remind(r, b, at, opts);
  // Someone else's routine is never a chat run (createRoutine, editRoutine), whatever its state says.
  if (r.run === "chat" && !r.fromOutside) return chatRun(r, b, at, opts);
  return taskRun(r, b, at, opts);
}

/**
 * The routine whose Run now started this thread, when the chat message `askedIn` (its id) asked for it;
 * else undefined (a run on its time, one asked for in the app or by another message, or another thread).
 * A Run now asked for by text or in Slack, Telegram or Discord brings the thread's result back there
 * (phone.ts and channels.ts give it textBack or channelBack); any other run goes only where the routine
 * sends its results (deliverTo). Without `askedIn`, a Run now asked for by any chat message counts, never
 * one from the app.
 */
export function ranNow(sessionId: string, askedIn?: string): Routine | undefined {
  const x = ranNowThreads.get(sessionId);
  if (!x || x.askedIn === "app" || (askedIn !== undefined && x.askedIn !== askedIn)) return undefined;
  return routine(x.routineId);
}

/** A thread a Run now started, kept with where it was asked for (ranNow). */
const keepRanNow = (sessionId: string, r: Routine, opts: RunOpts) => {
  if (opts.manual) ranNowThreads.set(sessionId, { routineId: r.id, askedIn: String(opts.manual) });
};

/**
 * What a run posts in the chat carries its routine, and whether a chat message asked for it (Run now), so a
 * turn by text or in a channel sends it back (types.ts turnsOwn). One asked for in the app is no turn's.
 */
const tagOf = (r: Routine, opts: RunOpts): NonNullable<Message["routine"]> => ({ id: r.id, ...(opts.manual && opts.manual !== "app" ? { manual: true as const } : {}) });

async function remind(r: Routine, b: Bot, at: number, opts: RunOpts): Promise<RoutineRun> {
  const chatId = botChatId(b.id);
  // Late: said first, so "call Bob at 9" read at 11 isn't taken for on time.
  if (isLate(opts, at)) addMessage({ chatId, role: "system", text: chipText(r, opts) });
  // Someone else's words are a note saying whose they are, never the bot's own (which it would later read as what it said).
  if (r.fromOutside) {
    addMessage({ chatId, role: "system", text: `Reminder set up by ${r.fromOutside}: ${r.reminder}`, routine: tagOf(r, opts) });
    return record(r.id, { at, status: "ok" });
  }
  const m = addMessage({ chatId, role: "bot", botId: b.id, text: r.reminder!, routine: tagOf(r, opts) });
  record(r.id, { at, status: "ok" });
  recordDelivery(r.id, at, await sendOut(r, r.reminder!, m.id));
  return routine(r.id)?.last ?? { at, status: "ok" };
}

/**
 * A chat run. When the job needed a computer the turn starts a thread (chat.ts backgroundTurn returns
 * its `sessionId`): that thread is this run, recorded as running, and its result is posted (or kept
 * quiet) and sent on when it ends (onRoutineTaskEnd); the turn's own words then stay in the chat only,
 * and a quiet run's are dropped. A run while that thread is still going is skipped.
 */
async function chatRun(r: Routine, b: Bot, at: number, opts: RunOpts): Promise<RoutineRun> {
  if (running.has(r.id)) return record(r.id, { at, status: "skipped", error: "The last run was still going." });
  const thread = r.last?.sessionId ? session(r.last.sessionId) : undefined;
  if (thread && live(thread)) return record(r.id, { at, status: "skipped", error: "The last run was still going.", sessionId: thread.id });
  const before = r.last;
  running.add(r.id);
  record(r.id, { at, status: "running" });
  try {
    const { backgroundTurn } = await import("./chat");
    const out = await backgroundTurn(b.id, { routineId: r.id, title: r.title, goal: r.goal, quiet: !!r.quiet, ...(r.procedure ? { procedureId: r.procedure } : {}) });
    if (out.error) return failed(r, at, out.error, before);
    const answer = out.text?.trim() ?? "";
    const text = isNothing(answer) || (out.sessionId && r.quiet) ? "" : answer;
    const chatId = botChatId(b.id);
    let posted: string | undefined;
    if (text) {
      if (isLate(opts, at)) addMessage({ chatId, role: "system", text: chipText(r, opts) });
      const m = addMessage({ chatId, role: "bot", botId: b.id, text, routine: tagOf(r, opts) });
      // Words that only start a thread aren't news: its result is asked about when it comes.
      if (!out.sessionId) pingIfWorthIt(m.id, r.title, text);
      posted = m.id;
    }
    // The thread is this run; how the run before failed goes with it, so the same failure isn't said again.
    if (out.sessionId) {
      keepRanNow(out.sessionId, r, opts);
      return record(r.id, { at, status: "running", sessionId: out.sessionId, ...prevError(before) });
    }
    if (!posted) return record(r.id, { at, status: "quiet" });
    record(r.id, { at, status: "ok" });
    recordDelivery(r.id, at, await sendOut(r, text, posted));
    return routine(r.id)?.last ?? { at, status: "ok" };
  } catch (e) {
    return failed(r, at, (e as Error).message, before);
  } finally {
    running.delete(r.id);
  }
}

/**
 * A run that failed: said in the bot's chat, recorded, and sent where its results go (a broken run isn't
 * silent). Failing the same way as the run before (an app still disconnected, the credit still used up)
 * is recorded, not said or sent again, so a routine every 15 minutes doesn't repeat it all day. Out of AI
 * credit stays in the chat.
 */
async function failed(r: Routine, at: number, error: string, before?: RoutineRun): Promise<RoutineRun> {
  const again = before?.status === "failed" && before.error === error;
  if (!again) addMessage({ chatId: botChatId(r.botId), role: "system", text: `"${r.title}" didn't run: ${error}`, routine: { id: r.id } });
  record(r.id, { at, status: "failed", error });
  if (!again && error !== NO_CREDIT_FOR_ROUTINES) recordDelivery(r.id, at, await sendOut(r, `"${r.title}" didn't run: ${error}`));
  return routine(r.id)?.last ?? { at, status: "failed", error };
}

/** How the run before failed, for a new run's running record (RoutineRun.prevError). */
const prevError = (before?: RoutineRun) => (before?.status === "failed" && before.error ? { prevError: before.error } : before?.status === "running" && before.prevError ? { prevError: before.prevError } : {});

function taskRun(r: Routine, b: Bot, at: number, opts: RunOpts): RoutineRun {
  const last = r.last;
  const before = last?.sessionId ? session(last.sessionId) : undefined;
  if (before && live(before)) return record(r.id, { at, status: "skipped", error: "The last run was still going.", sessionId: before.id });
  const chatId = botChatId(b.id);
  const goal = r.quiet ? `${r.goal}\n\nIf nothing needs ${ownerName()} this time, answer exactly NOTHING and nothing else.` : r.goal;
  try {
    // Someone else's routine: its thread is marked as theirs (Session.fromOutside), as when they start one directly.
    const s = startSession({
      botId: b.id,
      goal,
      title: r.title,
      chatId,
      sentVia: "routine",
      where: r.where ?? "auto",
      fresh: true,
      routineId: r.id,
      ...(r.procedure ? { procedure: r.procedure } : {}),
      ...(r.fromOutside ? { outside: r.fromOutside } : {}),
    });
    // Set up by text, before results could go elsewhere: the result is texted back when the thread ends.
    if (r.textTo && !r.deliverTo) patchSession(s.id, { textBack: r.textTo });
    keepRanNow(s.id, r, opts);
    // A quiet routine's chip comes with its result, when there is one (onRoutineTaskEnd).
    if (!r.quiet) addMessage({ chatId, role: "system", text: chipText(r, opts), sessionIds: [s.id] });
    return record(r.id, { at, status: "running", sessionId: s.id, ...prevError(last) });
  } catch (e) {
    return record(r.id, { at, status: "failed", error: (e as Error).message });
  }
}

/**
 * A routine's thread ended (sessions.ts, before it posts the result). Failed: recorded, and a short note
 * goes where the results go. Quiet with nothing for the user (NOTHING): recorded, and `suppress` tells
 * sessions.ts to post, ping, email, text and remember nothing. Otherwise recorded, and the answer is
 * delivered (after the chat has it). `chatOnly`: a failure for want of AI credit, said in the chat only
 * (sessions.ts), never sent by text, email or a channel. A quiet routine's chip shows once per thread:
 * not again when a reply picks the thread up and it ends again. A thread that failed the same way as the
 * run before it (the Mac still not set up) is recorded, not said or sent again (`again`): a routine every
 * 15 minutes doesn't repeat it all day, as a chat run doesn't (failed).
 */
export async function onRoutineTaskEnd(s: Session, answer: string | undefined, failure?: string, opts: { chatOnly?: boolean } = {}): Promise<{ suppress: boolean; again?: boolean }> {
  const r = s.routineId ? routine(s.routineId) : undefined;
  if (!r) return { suppress: false };
  const mine = r.last?.sessionId === s.id ? r.last : undefined;
  const at = mine ? mine.at : Date.now();
  const chip = () => {
    if (r.quiet && !getState().messages.some((m) => m.chatId === s.chatId && m.sessionIds?.includes(s.id)))
      addMessage({ chatId: s.chatId, role: "system", text: `Routine · ${describeSchedule(r.schedule)}`, sessionIds: [s.id] });
  };
  if (failure) {
    const again = mine?.prevError === failure;
    record(r.id, { at, status: "failed", error: failure, sessionId: s.id });
    if (again) return { suppress: false, again: true };
    chip();
    // Stopped by the user: they know. Set up by text before deliverTo: the thread texts its failure back itself (textBack).
    if (r.deliverTo && !opts.chatOnly && !/^(Stopped by you|Paused while you took over)/.test(failure))
      void deliver(r, `"${r.title}" didn't finish: ${failure}`).then((d) => recordDelivery(r.id, at, d));
    return { suppress: false };
  }
  if (r.quiet && (!answer?.trim() || isNothing(answer))) {
    record(r.id, { at, status: "quiet", sessionId: s.id });
    return { suppress: true };
  }
  record(r.id, { at, status: "ok", sessionId: s.id });
  chip();
  // The thread's own text back (textBack) covers routines set up by text before deliverTo.
  if (r.deliverTo) void deliver(r, answer?.trim() || "Done.").then((d) => recordDelivery(r.id, at, d));
  return { suppress: false };
}

/** A run's words to wherever the routine's results go: deliverTo, else (set up by text before that) the number it was set up from. */
async function sendOut(r: Routine, text: string, tag?: string): Promise<RoutineRun["delivery"]> {
  if (r.deliverTo) return deliver(r, text);
  if (!r.textTo) return undefined;
  const to = r.textTo.to;
  try {
    const { isOwner, sendText } = await import("./phone");
    // Texted only while the number is still one of the user's verified ones.
    if (!isOwner(to)) throw new Error("that number isn't one of your verified numbers anymore");
    await sendText(r.textTo.botId, to, forText(text), { tag });
    return { status: "sent", to, at: Date.now() };
  } catch (e) {
    return notSent(r, "by text", to, (e as Error).message);
  }
}

/** A long result, cut for a text message: the rest is in Bops. Markdown links read as words and an address. */
function forText(text: string) {
  const t = plainLinks(text).trim();
  if (t.length <= TEXT_MAX) return t;
  const cut = t.slice(0, TEXT_MAX - 30);
  const at = Math.max(cut.lastIndexOf("\n"), cut.lastIndexOf(". "), cut.lastIndexOf(" "));
  return `${(at > TEXT_MAX / 2 ? cut.slice(0, at) : cut).trimEnd()}… (the rest is in Bops)`;
}

/** It couldn't be sent: said in the bot's chat, and returned to be recorded (`to` is a short name the window shows: "Text", "Email", "Slack #sales"). */
function notSent(r: Routine, how: string, to: string, error: string): NonNullable<RoutineRun["delivery"]> {
  addMessage({ chatId: botChatId(r.botId), role: "system", text: `Couldn't send "${r.title}" ${how}: ${error}`, routine: { id: r.id } });
  return { status: "failed", to, error, at: Date.now() };
}

/**
 * Send a routine's result where it goes besides the chat (Routine.deliverTo): a text to the user's phone
 * from the bot's number (or its team's), an email to the user from the bot's inbox (or its team's; to the
 * user's own address it goes without asking), or a post in Slack, Telegram or Discord, where markdown
 * links read as words and an address. Undefined when it goes nowhere else. A failure is said in the bot's
 * chat too.
 */
export async function deliver(r: Routine, text: string): Promise<RoutineRun["delivery"]> {
  const d = r.deliverTo;
  if (!d || !text.trim()) return undefined;
  const b = bot(r.botId);
  if (d.kind === "text") {
    try {
      const { ownerPhone, sendText, textingLine } = await import("./phone");
      const via = b && textingLine(b);
      if (!b || !via) throw new Error(`${b?.name ?? "The bot"} has no phone number to text from yet`);
      const to = ownerPhone();
      if (!to) throw new Error(`${ownerName()} hasn't added a verified mobile number yet (Settings, How your bots reach you)`);
      const body = forText(text);
      await sendText(via.from.id, to, via.from.id === b.id ? body : `${b.name}: ${body}`);
      return { status: "sent", to, at: Date.now() };
    } catch (e) {
      return notSent(r, "by text", "Text", (e as Error).message);
    }
  }
  if (d.kind === "email") {
    try {
      const { ownerAddresses, sendEmail } = await import("./mail");
      const from = b?.mail ? b : b && getState().bots.find((x) => x.isMain && x.mail && workspaceOf(x) === workspaceOf(b));
      if (!b || !from) throw new Error(`${b?.name ?? "The bot"} has no email inbox yet`);
      const to = ownerAddresses()[0];
      if (!to) throw new Error(`Bops doesn't know ${ownerName()}'s email address yet`);
      const said = await sendEmail(from.id, { to: [to], subject: r.title, text: from.id === b.id ? text : `${b.name}:\n\n${text}` }, { chatId: botChatId(r.botId) });
      if (!/^Sent to /.test(said)) throw new Error(said.replace(/\s*Nothing was sent\.?$/, "").replace(/\.$/, ""));
      return { status: "sent", to, at: Date.now() };
    } catch (e) {
      return notSent(r, "by email", "Email", (e as Error).message);
    }
  }
  const link = (getState().channels ?? []).find((l) => l.id === d.linkId);
  const place = link ? (link.kind === "slack" && d.chat ? `Slack #${link.slack?.channels.find((c) => c.id === d.chat)?.name ?? d.chat}` : `${KIND_NAME[link.kind]}${d.chat ? "" : " DM"}`) : "a channel";
  try {
    const { postTo } = await import("./channels");
    // Markdown shows as typed there: links read as words and an address.
    const words = plainLinks(text);
    await postTo(d.linkId, link && b && link.botId !== b.id ? `${b.name}: ${words}` : words, d.chat);
    return { status: "sent", to: place, at: Date.now() };
  } catch (e) {
    return notSent(r, `to ${place}`, place, (e as Error).message);
  }
}

/* ---------------- The timer ---------------- */

/**
 * This Mac's zone is the user's (Owner.timeZone), kept current so routines (and Bops Cloud later) run
 * at their local times. A move to another zone (travel) works out the routines' next times again. Not
 * on a hosted server: its zone isn't the user's.
 */
function keepZone() {
  const o = getState().owner;
  if (!o || onPostgres()) return;
  const zone = macZone();
  // Node keeps the zone it launched with until TZ is set: set, its dates and Intl (the time the bots are told) follow the Mac's zone now.
  if (nodeZone() !== zone) {
    process.env.TZ = zone;
    g.__bopsTzSet = zone;
  }
  // Written when this Mac's zone changes, not every time: two Macs in two zones on one account don't take turns.
  if (o.timeZone === zone || (o.timeZone && g.__bopsZoneSeen === zone)) return;
  g.__bopsZoneSeen = zone;
  const moved = !!o.timeZone;
  const now = Date.now();
  update((s) => {
    if (s.owner) s.owner.timeZone = zone;
    // Times worked out in the old zone move to the new one; what's already due runs as it is.
    if (moved)
      for (const r of s.routines)
        if (r.enabled && r.schedule.kind !== "once" && r.nextRunAt !== undefined && r.nextRunAt > now) r.nextRunAt = nextRun(r.schedule, now, zone, r.lastRunAt) ?? r.nextRunAt;
  });
}

/** An enabled routine with no next time never runs (a "once" from before that was set in the past): it's paused, and the chat says why. */
function pauseStuck(r: Routine, why: string) {
  update(() => {
    r.enabled = false;
    r.nextRunAt = undefined;
  });
  addMessage({ chatId: botChatId(r.botId), role: "system", text: `Paused "${r.title}": ${why}`, routine: { id: r.id } });
}

/** A missed daily, weekdays or weekly run whose next time comes within this waits for that instead of running late. */
const LATE_NEXT_MS = 60 * 60_000;

/**
 * Whether a run missed while the Mac slept waits for its next time instead of running late. It waits when
 * that next time is close: within an hour for a daily, weekdays or weekly run (a 9 AM digest missed over the
 * weekend, with the Mac opened at 8:50 on Monday, runs once at 9, not twice), and less than half its gap
 * away for an "every" run (missed beats of a check every 15 minutes aren't made up). But never twice in a
 * row: when its last run was skipped too, it runs late, so a Mac that sleeps through 9 AM every day still
 * gets it. A one-off, and anything with its next time further off, runs once, late, and says so.
 */
function skipLate(r: Routine, due: number, next: number | undefined, now: number) {
  if (r.schedule.kind === "once" || next === undefined || now - due <= 2 * 60_000) return false;
  if (r.last?.status === "skipped") return false;
  return next - now < (r.schedule.kind === "every" ? (r.schedule.minutes * 60_000) / 2 : LATE_NEXT_MS);
}

/**
 * Run everything that's due. Called on a timer; waits while there's no account's state to run. A run
 * missed while the Mac slept runs once, late, and says so, unless it waits for its next time, which is
 * close (skipLate), where a thread of the routine's still going stays its run. Each run's next time is set before it
 * starts, so a slow run never runs twice.
 */
function tick() {
  if (!stateReady()) return;
  keepZone();
  const now = Date.now();
  const tz = routineZone();
  for (const r of getState().routines.filter((x) => x.enabled)) {
    if (r.nextRunAt === undefined) {
      const next = r.schedule.kind === "once" ? (r.schedule.at > now ? r.schedule.at : undefined) : nextRun(r.schedule, now, tz, r.lastRunAt);
      if (next === undefined) pauseStuck(r, r.schedule.kind === "once" ? "its time had already passed when it was set, so it never ran. Give it a new time." : "its schedule never comes due.");
      else update(() => (r.nextRunAt = next));
      continue;
    }
    if (r.nextRunAt > now) continue;
    const due = r.nextRunAt;
    const next = r.schedule.kind === "once" ? undefined : nextRun(r.schedule, now, tz, r.schedule.kind === "every" ? due : undefined);
    if (skipLate(r, due, next, now)) {
      update(() => (r.nextRunAt = next));
      // A thread of the routine's still going (a login it waits on) stays its run: the next run waits for it, and its end is the routine's.
      const t = r.last?.sessionId ? session(r.last.sessionId) : undefined;
      const still = t && live(t) ? { sessionId: t.id } : {};
      record(r.id, { at: now, status: "skipped", error: `Missed while Bops was off or this Mac was asleep (it was due ${inSentence(whenText(due, now, tz))}); runs next ${inSentence(whenText(next!, now, tz))}`, ...still });
      continue;
    }
    update(() => {
      r.lastRunAt = now;
      r.nextRunAt = next;
      if (r.schedule.kind === "once") r.enabled = false;
    });
    void run(r.id, { due }).catch((e: Error) => console.warn(`[routines] ${r.id}: ${e.message}`));
    if (r.schedule.kind !== "once" && next === undefined) pauseStuck(r, "its schedule never comes due.");
  }
}

/** What a run's status says, in a few words. */
function lastText(l: RoutineRun, now: number, tz: string) {
  const when = whenText(l.at, now, tz);
  const clip = (t?: string) => (t && t.length > 80 ? `${t.slice(0, 80)}…` : (t ?? ""));
  const how =
    l.status === "running"
      ? "still running"
      : l.status === "ok"
        ? "ran"
        : l.status === "quiet"
          ? "had nothing for the user"
          : l.status === "failed"
            ? `failed (${clip(l.error)})`
            : `skipped (${clip(l.error)})`;
  const sent = l.delivery ? (l.delivery.status === "sent" ? `, sent to ${l.delivery.to}` : `, but sending to ${l.delivery.to} failed (${clip(l.delivery.error)})`) : "";
  return `last run ${inSentence(when)}: ${how}${sent}`;
}

/** Where a routine's results go besides the chat, in a few words. */
function deliverText(r: Routine) {
  const d = r.deliverTo;
  if (!d) return r.textTo ? "results texted to the number it was set up from" : "";
  if (d.kind === "text") return "results texted to the user";
  if (d.kind === "email") return "results emailed to the user";
  const link = (getState().channels ?? []).find((l) => l.id === d.linkId);
  return `results posted to ${link ? KIND_NAME[link.kind] : "a channel that's gone"}${d.chat ? "" : " (DM)"}`;
}

/** A bot's routines, as it sees them (to change, run or delete them when the user asks). */
export function routinesNote(botIds: string[]) {
  const mine = getState().routines.filter((r) => botIds.includes(r.botId));
  if (!mine.length) return "Routines: none yet.";
  const owner = ownerName();
  const now = Date.now();
  const tz = routineZone();
  const procedures = getState().procedures ?? [];
  const line = (r: Routine) =>
    [
      `${r.id}: "${r.title}"${botIds.length > 1 ? ` (${bot(r.botId)?.name ?? r.botId})` : ""}`,
      describe(r.schedule, tz),
      r.reminder
        ? "reminder message"
        : r.run === "chat"
          ? "chat run (tools, no computer)"
          : `task, runs ${r.where && r.where !== "auto" ? `on ${r.where === "mac" ? `${owner}'s Mac` : "the cloud computer"}` : "where Bops picks"}`,
      r.quiet ? "quiet (posts only when something needs the user)" : "",
      deliverText(r),
      r.procedure ? `follows procedure "${procedures.find((p) => p.id === r.procedure)?.name ?? r.procedure}"` : "",
      r.fromOutside ? `set up by ${r.fromOutside}, not ${owner}` : "",
      // A one-off is done once its time has passed (Run now before then doesn't finish it).
      r.enabled ? (r.nextRunAt ? `next ${inSentence(whenText(r.nextRunAt, now, tz))}` : "") : r.schedule.kind === "once" && r.schedule.at <= now ? "done" : "paused",
      r.last ? lastText(r.last, now, tz) : "",
    ]
      .filter(Boolean)
      .join(" · ");
  return `Routines (change them with manage_routine):\n${mine.map(line).join("\n")}`;
}

// The timer calls whatever version of tick was loaded last, so edits apply without a restart.
g.__bopsRoutineTick = tick;
// One timer: a reload replaces the old one (an older version's timer called its own tick directly).
if (g.__bopsRoutines) clearInterval(g.__bopsRoutines);
g.__bopsRoutines = setInterval(() => g.__bopsRoutineTick?.(), 20_000);
