import "server-only";
import { readlinkSync } from "node:fs";
import { trackServerEvent } from "./analytics";
import { botChatId, lastWorkOf, levelIn, live, pausedForOk, workspaceOf, type Bot, type Delivery, type Message, type ReplyDraft, type Routine, type SkillProposal, type RoutineRun, type RoutineSource, type Schedule, type Session } from "@/lib/types";
import { appNameFor, CHECK_TEMPLATE, tagsOf } from "@/lib/routine-catalog";
import { draftsText } from "@/lib/reply-drafts";
import { describeSchedule as describe, EVENT_CHECK_MINUTES, eventWindow, inHours, nextRun, sameWallTime, normalizeSchedule, resolveOnce, validTimeZone, whenText } from "@/cloud/schedule";
import { cleanText, routineChanged, routineRan, syncRoutinesOnStart } from "./routine-sync";
import { liveRoutine } from "./live-core";
import { plainLinks } from "@/cloud/style";
import { pingIfWorthIt } from "./attention";
import { onPostgres } from "./persist";
import { needsMacPick, needsNoComputer, onRunner, runnerComputerOf, runnerHasWork, runnerReady, runnerRunsOn, runsHere } from "./runner";
import { awakeSince, sleptSince } from "./awake";
import { startSession } from "./sessions";
import { addMessage, bot, getState, id, LEFT_BEHIND, ownerName, ownSession, patchSession, RESTARTED, session, startLanded, stateDevice, stateEpoch, stateReady, stateTooNew, update } from "./store";
import { findSkill, skillRefId } from "./workspace-skills";

/**
 * Routines and scheduled asks. Each one belongs to a bot. When one comes due it's a reminder (a message
 * from the bot), a chat run (a turn in the bot's chat with its tools and no computer), or a task (a
 * thread on a computer). A quiet routine that finds nothing for the user posts nothing; a routine's
 * result can also go to the user by text, email, or Slack, Telegram or Discord (deliverTo), and how its
 * last run went (and whether its result arrived) is kept on it (Routine.last).
 *
 * Times are wall clock times in the routine's own zone (Routine.timeZone) when it has one, else the
 * user's: Owner.timeZone, which this Mac keeps current, else this Mac's zone. The math is in
 * cloud/schedule.ts, so Bops Cloud can run the same schedules later. Each change and each run is also
 * mirrored to the workspace's Orgo project when it has one (routine-sync.ts), never holding anything up:
 * every new next time too, which is when Orgo wakes a computer for its runner.
 *
 * Which Bops runs a routine is runner.ts's: the Mac, or the runner on the computer its bot works on
 * (where the bots work: Cloud). Each one's timer skips the others' routines.
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

/** The zone a routine's times are in: its own (Routine.timeZone), else the user's. */
export const zoneOf = (r: Pick<Routine, "timeZone">) => (r.timeZone && validTimeZone(r.timeZone) ? r.timeZone : routineZone());

/** A schedule in a few plain words, in `tz` (else the user's zone): "Weekdays at 9 AM", "Every 2 hours, 8 AM to 10 PM". */
export const describeSchedule = (schedule: Schedule, tz?: string) => describe(schedule, tz || routineZone());

/** The gap between an "every" or meeting routine's runs, in ms; undefined for the rest. */
const beatOf = (s: Schedule) => (s.kind === "every" ? s.minutes * 60_000 : s.kind === "before_event" ? EVENT_CHECK_MINUTES * 60_000 : undefined);

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
  /** When the routine timer last ran with a state to run, and since when it has without a gap (awakeThrough). */
  __bopsTickedAt?: number;
  __bopsTickingFrom?: number;
  /** Whose state the timer last ran with (stateEpoch): another account's starts a new stretch. */
  __bopsTickEpoch?: number;
  /** The Mac working out where routines' runs go (pickWhere), and when a pick came to nothing, by routine and goal. */
  __bopsPicking?: Promise<void>;
  __bopsPickTried?: Map<string, number>;
};
const running = (g.__bopsRoutineRuns ??= new Set());
/** Threads a run someone asked for (Run now) started, by thread: the routine's id, and where it was asked for (RunOpts.manual). */
const ranNowThreads = (g.__bopsRanNow ??= new Map());

const routine = (routineId: string) => getState().routines.find((x) => x.id === routineId);

/** whenText inside a sentence: "due today 9 AM", "next tomorrow 8 AM" (weekdays and months keep their capitals). */
const inSentence = (when: string) => when.replace(/^(Today|Tomorrow|Yesterday)\b/, (w) => w.toLowerCase());

/**
 * Set how the routine's last run went. On a computer's runner the record says it's that runner's
 * (RoutineRun.by): if its bot moves off the computer before the run ends, Bops Cloud still takes the run's
 * end and its words in the chat from it (cloud/computer-scope.ts runsOf, runsBy), so its result isn't lost.
 * A meeting routine's run that finished handled its window: the next one starts where it ended
 * (eventsThrough). `said`: what a run that went well said in the chat (its message), which goes to Orgo
 * with its record (routine-sync.ts runSummary), so its report is there on another Mac too.
 */
function record(routineId: string, given: RoutineRun, said?: string): RoutineRun {
  const device = onRunner() ? stateDevice() : null;
  const before = getState().routines.find((x) => x.id === routineId);
  const run: RoutineRun = { ...given, ...(device ? { by: device } : {}) };
  // A run that's said to be running twice (started, then its thread) started once.
  const started = run.status === "running" && !(before?.last?.status === "running" && before.last.at === run.at);
  if (before && (started || run.status !== "running")) liveRoutine(workspaceOf(bot(before.botId)), routineId, started ? "run-started" : "run-finished");
  update((s) => {
    const r = s.routines.find((x) => x.id === routineId);
    if (!r) return;
    const w = run.status === "ok" || run.status === "quiet" ? eventWindow(r.schedule, run.at) : undefined;
    if (w && w.to > (r.eventsThrough ?? 0)) r.eventsThrough = w.to;
    r.last = run;
  });
  routineRan(routineId, run, said);
  return run;
}

/**
 * On a computer's runner: whether Bops Cloud took the start of the run recorded at `at` (store.ts
 * startLanded), before the run reaches past this server (a text or an email, a turn on the model; a task's
 * thread waits in sessions.ts route). The Mac may have moved its bot off the computer before the start
 * landed: Bops Cloud refuses it, and the Bops that has the bot now runs it, once.
 */
const runLanded = (routineId: string, at: number) => startLanded((st) => Array.isArray(st.routines) && st.routines.some((x: Partial<Routine>) => x?.id === routineId && x.last?.at === at));
/** What a run whose start Bops Cloud didn't take says (runLanded): another Bops runs it. Nothing records it. */
const notLanded = (at: number): RoutineRun => ({ at, status: "skipped", error: "Another Bops runs it now." });

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
 * A schedule as kept (cloud/schedule.ts normalizeSchedule): times of day written "HH:MM", sorted, each
 * once, at most 6; an "every" gap of MIN_EVERY_MINUTES to a day; days of the week that are days; a
 * day of the month; a meeting lead of 5 to 240 minutes. Undefined, with what's wrong, when it can't run.
 */
function tidy(schedule: Schedule): { schedule?: Schedule; error?: string } {
  const out = normalizeSchedule(schedule);
  return "error" in out ? { error: out.error } : { schedule: out.schedule as Schedule };
}

/** A zone given for a routine: undefined (the user's), or one this runtime knows. */
function checkZone(tz: string | undefined): { timeZone?: string; error?: string } {
  const t = tz?.trim();
  if (!t) return {};
  return validTimeZone(t) ? { timeZone: t } : { error: `"${t}" isn't a time zone Bops knows. Use an IANA name, like America/New_York.` };
}

/** A skill of the bot's, by slug, its id from before as a procedure, or its name (as read_skill finds one): how the routine names it. */
const procedureOf = (botId: string, nameOrId: string): string | undefined => {
  const r = findSkill(botId, nameOrId);
  return r ? skillRefId(r) : undefined;
};

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
  /** A starter it was made from, or the account it checks (lib/server/routine-suggestions.ts), and the tags it sorts with. */
  source?: RoutineSource;
  tags?: string[];
  /** The IANA zone its times are in; unset: the user's. */
  timeZone?: string;
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
  if (outside && (schedule?.kind === "every" || schedule?.kind === "before_event" || (schedule && "times" in schedule && (schedule.times?.length ?? 0) > 1)))
    return { error: `Only ${owner} can set up a routine that repeats through the day.` };
  if (outside && opts.deliverTo) return { error: `Only ${owner} can have a routine's results sent by text, email, Slack, Telegram or Discord. Its results stay in this chat.` };
  const zone = checkZone(opts.timeZone);
  if (zone.error) return { error: zone.error };
  const tz = zone.timeZone ?? routineZone();
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
  if (opts.procedure?.trim() && !procedure) return { error: `No skill called "${opts.procedure.trim()}".` };
  const reminder = opts.reminder?.trim() || undefined;
  const r: Routine = {
    id: id("rtn"),
    botId,
    title: title.trim() || cleanText(goal.trim(), 40),
    goal,
    schedule: s,
    ...(zone.timeZone ? { timeZone: zone.timeZone } : {}),
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
    ...(!outside && opts.source ? { source: { app: opts.source.app, template: opts.source.template, ...(opts.source.account ? { account: opts.source.account } : {}) } } : {}),
    ...(!outside && opts.tags?.length ? { tags: [...new Set(opts.tags.map((t) => t.trim()).filter(Boolean))].slice(0, 12) } : {}),
  };
  update((st) => st.routines.push(r));
  trackServerEvent("bops_routine_created", {});
  routineChanged(r.botId);
  liveRoutine(workspaceOf(bot(r.botId)), r.id, "added");
  return { routine: r, ...(moved ? { moved: true } : {}) };
}

/**
 * Change a routine. A new schedule (any kind, whole) is checked like a new routine's ("once" times that
 * passed are moved or refused) and sets the next time; so does a new zone (`timeZone`, undefined or ""
 * for the user's). A field given as undefined clears it (deliverTo, procedure, timeZone).
 */
export function editRoutine(
  routineId: string,
  patch: Partial<Pick<Routine, "title" | "goal" | "schedule" | "quiet" | "deliverTo" | "run" | "procedure" | "where" | "timeZone">>,
): { routine?: Routine; error?: string; moved?: boolean } {
  const r = routine(routineId);
  if (!r) return { error: "No such routine." };
  // Someone else's routine stays a task in the cloud: a chat run would have the user's data and the web on a stranger's say.
  if (r.fromOutside && patch.run === "chat") return { error: `It was set up by ${r.fromOutside}, so it runs as a task in the cloud. Make a new routine to run it as a chat.` };
  // And in the cloud: its thread is marked as theirs, which never runs on the user's Mac (sessions.ts StartOptions.outside).
  if (r.fromOutside && patch.where === "mac") return { error: outsideStaysInCloud(r) };
  // And at most once a day: a stranger's routine never repeats through the day (createRoutine).
  if (r.fromOutside && (patch.schedule?.kind === "every" || patch.schedule?.kind === "before_event" || (patch.schedule && "times" in patch.schedule && (patch.schedule.times?.length ?? 0) > 1)))
    return { error: `Only ${ownerName()} can set up a routine that repeats through the day.` };
  const zone = "timeZone" in patch ? checkZone(patch.timeZone) : { timeZone: r.timeZone };
  if (zone.error) return { error: zone.error };
  const tz = zone.timeZone ?? routineZone();
  const now = Date.now();
  let schedule: Schedule | undefined;
  let nextRunAt = r.nextRunAt;
  let moved = false;
  if (patch.schedule || ("timeZone" in patch && zone.timeZone !== r.timeZone)) {
    const tidied = tidy(patch.schedule ?? r.schedule);
    if (!tidied.schedule) return { error: tidied.error };
    schedule = tidied.schedule;
    if (schedule.kind === "once" && patch.schedule) {
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
    if (!procedure) return { error: `No skill called "${patch.procedure.trim()}".` };
  }
  if (patch.title !== undefined && !patch.title.trim()) return { error: "A routine needs a title." };
  if (patch.goal !== undefined && !patch.goal.trim()) return { error: "A routine needs something to do." };
  update(() => {
    if (patch.title !== undefined) r.title = patch.title.trim();
    if (patch.goal !== undefined) r.goal = patch.goal;
    if (schedule) {
      r.schedule = schedule;
      r.nextRunAt = nextRunAt;
      // Its old times went with the old schedule.
      delete r.skips;
    }
    if ("timeZone" in patch) {
      if (zone.timeZone) r.timeZone = zone.timeZone;
      else delete r.timeZone;
    }
    if ("quiet" in patch) r.quiet = patch.quiet && !r.reminder ? true : undefined;
    if ("run" in patch) r.run = patch.run;
    if ("where" in patch) r.where = patch.where;
    if ("deliverTo" in patch) r.deliverTo = patch.deliverTo ?? undefined;
    if ("procedure" in patch) r.procedure = procedure;
  });
  routineChanged(r.botId);
  liveRoutine(workspaceOf(bot(r.botId)), r.id, "changed");
  return { routine: r, ...(moved ? { moved: true } : {}) };
}

/** Whether `t` is one of the times the user skipped (a minute either way). */
const skipping = (r: Routine, t: number) => !!r.skips?.some((x) => Math.abs(x - t) < 60_000);

/** The time after `t` in a routine's schedule (an "every" one keeps its beat). */
const after = (r: Routine, t: number, tz?: string) => (r.schedule.kind === "once" ? undefined : nextRun(r.schedule, t, tz, beatOf(r.schedule) !== undefined ? t : undefined));

/** The first of a routine's times from `t` on (`t` itself, then each one after) that it isn't skipping. */
function pastSkips(r: Routine, t: number | undefined, tz?: string): number | undefined {
  for (let i = 0; t !== undefined && skipping(r, t) && i <= (r.skips?.length ?? 0); i++) t = after(r, t, tz);
  return t;
}

/**
 * A routine whose run waited for the user's OK, answered or stopped now (permission.ts): the times that came while it
 * waited are past, as they'd be had its computer been up through the wait (tick: each one skipped, the last run still
 * going), and its next time is the one after now. Nothing moved it on meanwhile (its computer slept, and Orgo had no
 * next time for it: routine-sync.ts), and sent as it was, a time already gone, Orgo's waker would wake that computer
 * at once, a Stop's too, to run the routine again late right after.
 */
export function pastWait(routineId: string) {
  const r = routine(routineId);
  const now = Date.now();
  if (!r?.enabled || r.schedule.kind === "once" || r.nextRunAt === undefined || r.nextRunAt > now) return;
  const tz = zoneOf(r);
  const next = pastSkips(r, nextRun(r.schedule, now, tz, beatOf(r.schedule) !== undefined ? r.nextRunAt : undefined), tz);
  if (next !== undefined) update(() => (r.nextRunAt = next));
}

/** How far ahead a time can be skipped. */
const SKIP_AHEAD_MS = 35 * 24 * 60 * 60_000;

/**
 * Skip one of a routine's coming times (`at`, else its next): it doesn't run then, and runs at the time
 * after instead. Only a time it really has (one of its schedule's, from its next on, within 5 weeks), and
 * not for a one-off (pause or delete it instead). Skipping one again changes nothing.
 */
export function skipRoutine(routineId: string, at?: number): { error?: string; skipped?: number; nextRunAt?: number } {
  const r = routine(routineId);
  if (!r) return { error: "No such routine." };
  if (r.schedule.kind === "once") return { error: "It runs only once. Pause or delete it instead." };
  // Its next check takes in the skipped one's meetings anyway (eventWindow): skipping one would do nothing.
  if (r.schedule.kind === "before_event") return { error: "It checks before every meeting, so one check can't be skipped. Pause it to stop the prep." };
  if (!r.enabled || r.nextRunAt === undefined) return { error: "It's paused, so it has no time to skip." };
  const tz = zoneOf(r);
  const now = Date.now();
  const want = at ?? r.nextRunAt;
  if (!Number.isFinite(want) || want <= now) return { error: "That time has passed." };
  if (want - now > SKIP_AHEAD_MS) return { error: "Bops can skip a time up to 5 weeks ahead." };
  // Skipped already (it's before its next, or on its list): nothing to do.
  const already = r.skips?.find((x) => Math.abs(x - want) < 60_000);
  if (already !== undefined) return { skipped: already, nextRunAt: r.nextRunAt };
  // One of the times it will run: its next, or one after.
  let t: number | undefined = r.nextRunAt;
  for (let i = 0; t !== undefined && t < want - 60_000 && i < 5000; i++) t = after(r, t, tz);
  if (t === undefined || Math.abs(t - want) >= 60_000) return { error: "It doesn't run at that time." };
  const skipAt = t;
  const skips = [...(r.skips ?? []).filter((x) => x > now), skipAt].sort((a, b) => a - b);
  const next = pastSkips({ ...r, skips }, r.nextRunAt, tz);
  if (next === undefined) return { error: "Then it would never run again." };
  update(() => {
    r.skips = skips;
    r.nextRunAt = next;
  });
  routineChanged(r.botId);
  liveRoutine(workspaceOf(bot(r.botId)), r.id, "changed");
  return { skipped: skipAt, nextRunAt: next };
}

/** Run at a skipped time after all (`at`; else every one it's skipping): the soonest becomes its next time again. */
export function unskipRoutine(routineId: string, at?: number): { error?: string; nextRunAt?: number } {
  const r = routine(routineId);
  if (!r) return { error: "No such routine." };
  const now = Date.now();
  const back = (r.skips ?? []).filter((x) => x > now && (at === undefined || Math.abs(x - at) < 60_000));
  if (!back.length) return at !== undefined && at <= now ? { error: "That time has passed." } : { error: "It isn't skipping that time." };
  const rest = (r.skips ?? []).filter((x) => x > now && !back.includes(x));
  const soonest = Math.min(...back);
  update(() => {
    if (rest.length) r.skips = rest;
    else delete r.skips;
    if (r.enabled && (r.nextRunAt === undefined || soonest < r.nextRunAt)) r.nextRunAt = soonest;
  });
  routineChanged(r.botId);
  liveRoutine(workspaceOf(bot(r.botId)), r.id, "changed");
  return { nextRunAt: r.nextRunAt };
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
      delete r.skips;
    });
    routineChanged(r.botId);
    liveRoutine(workspaceOf(bot(r.botId)), r.id, "changed");
    return {};
  }
  // On already: nothing changes (its next time, and the times it's skipping, stay).
  if (r.enabled && r.nextRunAt !== undefined) return {};
  const now = Date.now();
  const next = r.schedule.kind === "once" ? (r.schedule.at > now ? r.schedule.at : undefined) : pastSkips(r, nextRun(r.schedule, now, zoneOf(r), r.lastRunAt), zoneOf(r));
  if (next === undefined) return { error: r.schedule.kind === "once" ? "Its time has passed. Give it a new time to run it again." : "That schedule never comes due." };
  update(() => {
    r.enabled = true;
    r.nextRunAt = next;
  });
  routineChanged(r.botId);
  liveRoutine(workspaceOf(bot(r.botId)), r.id, "changed");
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
  // Which Bops runs it may change with it (runner.ts pinnedToMac): Orgo hears.
  routineChanged(r.botId);
  return {};
}

export function deleteRoutine(routineId: string) {
  const botId = routine(routineId)?.botId;
  update((s) => (s.routines = s.routines.filter((x) => x.id !== routineId)));
  if (botId) {
    routineChanged(botId, { deleted: true });
    liveRoutine(workspaceOf(bot(botId)), routineId, "removed");
  }
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
  const tz = zoneOf(r);
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
  // A reminder or a chat run is never run on a computer (chat is the backend's: runner.ts needsNoComputer): Bops on the Mac runs it, and nothing here records it.
  if (onRunner() && needsNoComputer(r)) return { at, status: "skipped", error: "Bops on your Mac runs it." };
  const b = bot(r.botId);
  if (!b) return record(r.id, { at, status: "skipped", error: "Its bot isn't there anymore." });
  if (opts.manual) update(() => (r.lastRunAt = at));
  if (r.reminder) return remind(r, b, at, opts);
  const blocked = checkBlocked(r, b);
  if (blocked) return failed(r, at, blocked, r.last);
  // A meeting routine with no meetings left to handle (the runs before it got further, or it's outside its hours): nothing to ask.
  const w = eventWindow(r.schedule, at, r.eventsThrough, zoneOf(r));
  if (w && w.from >= w.to) return record(r.id, { at, status: "quiet" });
  // Someone else's routine is never a chat run (createRoutine, editRoutine), whatever its state says.
  if (r.run === "chat" && !r.fromOutside) return chatRun(r, b, at, opts);
  return taskRun(r, b, at, opts);
}

/**
 * Why a Connected App's check (CHECK_TEMPLATE) can't run now, else undefined: its account isn't connected
 * anymore (gone from Composio), is signed out, or its bot can't use it now. Not run then: use_app would
 * take another account the bot has in the app (its only one when the name it's given matches none) and
 * tell what's new there as this one's.
 */
function checkBlocked(r: Routine, b: Bot): string | undefined {
  if (r.source?.template !== CHECK_TEMPLATE || !r.source.account) return undefined;
  const a = getState().accounts?.find((x) => x.id === r.source!.account);
  if (!a) return `That ${appWord(r.source.app)} account isn't connected anymore. Delete this routine, or connect it again in Logins.`;
  if (a.status !== "active") return `${checkWord(r.source)} is signed out. Sign in again in Logins.`;
  if (!levelIn(getState(), b, a)) return `${b.name} can't use ${checkWord(r.source)} now. Give it access in Logins, or delete this routine.`;
  return undefined;
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
 * What a run posts in the chat carries its routine, when its run began (`at`, so its report goes with that
 * run: lib/routine-reports.ts), and whether a chat message asked for it (Run now), so a turn by text or in a
 * channel sends it back (types.ts turnsOwn). One asked for in the app is no turn's.
 */
const tagOf = (r: Routine, opts: RunOpts, at: number): NonNullable<Message["routine"]> => ({ id: r.id, at, ...(opts.manual && opts.manual !== "app" ? { manual: true as const } : {}) });

/**
 * A reminder: recorded first, and on a computer's runner posted and sent only once Bops Cloud took that
 * record (runLanded). Posted before, a reminder whose bot the Mac just moved off the computer would still
 * reach the chat (Bops Cloud takes a runner's words on a routine it last ran: computer-scope.ts runsBy)
 * while the Bops that has the bot now posts it again.
 */
async function remind(r: Routine, b: Bot, at: number, opts: RunOpts): Promise<RoutineRun> {
  const chatId = botChatId(b.id);
  const outside = r.fromOutside ? `Reminder set up by ${r.fromOutside}: ${r.reminder}` : undefined;
  record(r.id, { at, status: "ok" }, outside ?? r.reminder);
  if (onRunner() && !(await runLanded(r.id, at))) return notLanded(at);
  // Late: said first, so "call Bob at 9" read at 11 isn't taken for on time.
  if (isLate(opts, at)) addMessage({ chatId, role: "system", text: chipText(r, opts) });
  // Someone else's words are a note saying whose they are, never the bot's own (which it would later read as what it said).
  if (outside) {
    addMessage({ chatId, role: "system", text: outside, routine: tagOf(r, opts, at) });
    return routine(r.id)?.last ?? { at, status: "ok" };
  }
  const m = addMessage({ chatId, role: "bot", botId: b.id, text: r.reminder!, routine: tagOf(r, opts, at) });
  recordDelivery(r.id, at, await sendOut(r, r.reminder!, m.id, at));
  return routine(r.id)?.last ?? { at, status: "ok" };
}

/**
 * A chat run. When the job needed a computer the turn starts a thread (chat.ts backgroundTurn returns
 * its `sessionId`): that thread is this run, recorded as running, and its result is posted (or kept
 * quiet) and sent on when it ends (onRoutineTaskEnd); the turn's own words then stay in the chat only,
 * and a quiet run's are dropped. A run while that thread is still going is skipped. A turn that paused for the
 * user's OK (lib/server/permission.ts) is this run still going, recorded as running: it ends when the turn
 * goes on from their reply (chatRunResumed), and a run while its request waits is skipped.
 */
async function chatRun(r: Routine, b: Bot, at: number, opts: RunOpts): Promise<RoutineRun> {
  if (running.has(r.id) || chatPaused(r)) return record(r.id, { at, status: "skipped", error: "The last run was still going." });
  const thread = r.last?.sessionId ? session(r.last.sessionId) : undefined;
  if (thread && live(thread) && !strayRun(r, thread)) return record(r.id, { at, status: "skipped", error: "The last run was still going.", ...stillGoing(r.last, thread.id) });
  const before = r.last;
  running.add(r.id);
  record(r.id, { at, status: "running" });
  try {
    if (onRunner() && !(await runLanded(r.id, at))) return notLanded(at);
    const { backgroundTurn } = await import("./chat");
    const out = await backgroundTurn(b.id, { routineId: r.id, title: r.title, goal: goalFor(r, at), quiet: !!r.quiet, ...(r.procedure ? { procedureId: r.procedure } : {}) });
    if (out.paused) return routine(r.id)?.last ?? { at, status: "running" };
    return await endChatRun(r, b, at, opts, out, before);
  } catch (e) {
    return failed(r, at, (e as Error).message, before);
  } finally {
    running.delete(r.id);
  }
}

/** A chat run of routine `r` paused for the user's OK: its request is still there (chat.ts: no thread, its routine named). */
const chatPaused = (r: Routine) => (getState().appApprovals ?? []).some((a) => a.routineId === r.id && !a.threadId && a.resume?.engine === "chat");

/**
 * A chat run's turn that paused for the user's OK went on from their reply (chat.ts resumeChat) and ended: the run
 * ends as any chat run does, posted, recorded and sent on, as the run that began at its running record's time.
 */
export async function chatRunResumed(routineId: string, out: { text: string | null; error?: string; sessionId?: string; drafts?: ReplyDraft[]; skillProposals?: SkillProposal[] }): Promise<void> {
  const r = routine(routineId);
  const b = r && getState().bots.find((x) => x.id === r.botId);
  if (!r || !b) return;
  const at = r.last?.status === "running" ? r.last.at : Date.now();
  await endChatRun(r, b, at, {}, out).catch((e: Error) => failed(r, at, e.message));
}

/**
 * What a chat run does with its turn's answer: says it (or keeps quiet), records the run, and sends it on. Replies it
 * offered for the user to send (Message.drafts) go on its message as cards; where they can't (a text, an email, a
 * channel) and in the run's record, as words after it (lib/reply-drafts.ts draftsText). Changes it proposed to a
 * skill (Message.skillProposals, skill-proposals.ts) go on its message as cards too, for the owner to accept in Bops.
 */
async function endChatRun(r: Routine, b: Bot, at: number, opts: RunOpts, out: { text: string | null; error?: string; sessionId?: string; drafts?: ReplyDraft[]; skillProposals?: SkillProposal[] }, before?: RoutineRun): Promise<RoutineRun> {
  if (out.error) return failed(r, at, out.error, before);
  const answer = out.text?.trim() ?? "";
  const text = isNothing(answer) || (out.sessionId && r.quiet) ? "" : answer;
  const chatId = botChatId(b.id);
  let posted: string | undefined;
  if (text) {
    if (isLate(opts, at)) addMessage({ chatId, role: "system", text: chipText(r, opts), routine: tagOf(r, opts, at) });
    const m = addMessage({ chatId, role: "bot", botId: b.id, text, routine: tagOf(r, opts, at), ...(out.drafts?.length ? { drafts: out.drafts } : {}), ...(out.skillProposals?.length ? { skillProposals: out.skillProposals } : {}) });
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
  const whole = out.drafts?.length ? `${text}\n\n${draftsText(out.drafts)}` : text;
  record(r.id, { at, status: "ok" }, whole);
  recordDelivery(r.id, at, await sendOut(r, whole, posted, at));
  return routine(r.id)?.last ?? { at, status: "ok" };
}

/**
 * What a run is asked to do: the routine's goal, and for a meeting routine (before_event) the meetings
 * this run handles: those starting in its window (cloud/schedule.ts eventWindow, from where the runs
 * before it got to), with the clock times in the routine's zone, so every meeting is handled once.
 */
export function goalFor(r: Routine, at: number): string {
  const w = eventWindow(r.schedule, at, r.eventsThrough, zoneOf(r));
  if (!w) return r.goal;
  const tz = zoneOf(r);
  const clock = (ms: number) => new Intl.DateTimeFormat("en-US", { timeZone: tz, hour: "numeric", minute: "2-digit" }).format(new Date(ms));
  return [
    r.goal,
    `This run handles only the meetings in ${ownerName()}'s Google Calendar that start from ${clock(w.from)} up to but not including ${clock(w.to)} (${tz}; ${new Date(w.from).toISOString()} to ${new Date(w.to).toISOString()}). Earlier and later ones are handled by other runs.`,
    "If no meeting starts then, answer exactly NOTHING and nothing else.",
  ].join("\n\n");
}

/**
 * A run that failed: said in the bot's chat, recorded, and sent where its results go (a broken run isn't
 * silent). Failing the same way as the run before (an app still disconnected, the credit still used up)
 * is recorded, not said or sent again, so a routine every 15 minutes doesn't repeat it all day. Out of AI
 * credit stays in the chat. On a computer's runner it's said and sent only once Bops Cloud took the record
 * (runLanded), as a reminder is (remind).
 */
async function failed(r: Routine, at: number, error: string, before?: RoutineRun): Promise<RoutineRun> {
  const again = before?.status === "failed" && before.error === error;
  record(r.id, { at, status: "failed", error });
  if (onRunner() && !(await runLanded(r.id, at))) return notLanded(at);
  if (!again) addMessage({ chatId: botChatId(r.botId), role: "system", text: `"${r.title}" didn't run: ${error}`, routine: { id: r.id, at } });
  if (!again && error !== NO_CREDIT_FOR_ROUTINES) recordDelivery(r.id, at, await sendOut(r, `"${r.title}" didn't run: ${error}`, undefined, at));
  return routine(r.id)?.last ?? { at, status: "failed", error };
}

/**
 * A run skipped while the routine's thread is still going: that thread stays its run, keeping when it
 * began (RoutineRun.threadAt) and how the run before it failed (prevError) for when it ends.
 */
const stillGoing = (last: RoutineRun | undefined, sessionId: string): Partial<RoutineRun> & { sessionId: string } =>
  last?.sessionId === sessionId ? { sessionId, threadAt: last.threadAt ?? last.at, ...(last.prevError ? { prevError: last.prevError } : {}) } : { sessionId };

/** How the run before failed, for a new run's running record (RoutineRun.prevError). */
const prevError = (before?: RoutineRun) => (before?.status === "failed" && before.error ? { prevError: before.error } : before?.status === "running" && before.prevError ? { prevError: before.prevError } : {});

/** How long the Bops that has a run going (a computer's runner, the Mac) may show no sign of work (a step, a frame, a reply) on any of its live threads before that run is taken for one left behind. */
const STRAY_QUIET_MS = 10 * 60_000;

/**
 * Whether a routine's last run, still going, is one another Bops left going, with no sign of work from that
 * Bops on it or any of its live threads for STRAY_QUIET_MS (lastWorkOf: one queued there behind its bot's busy
 * screens waits on that Bops at work on them, never a stray for its own quiet), so it never holds the routine
 * ("The last run was still going") wherever it runs now:
 * - The Mac's (a Run now, a run from before its computer's runner was up), the Mac asleep or quit since: nothing
 *   ends the Mac's threads but the Mac (Bops opened again fails them: store.ts), so in Cloud the computer's
 *   runner would skip each run for as long as the Mac stays closed. Another Mac's, on this one, alike.
 * - A computer's runner's, of a routine that doesn't run on that computer anymore (its bot moved, it's set to
 *   run on the Mac or posts to a channel): that computer asleep (nothing may wake it: Free hours used up) or
 *   gone, and the Mac not looking (runner-install.ts strays ends it once one looks).
 * Never one of this Bops' own (it knows whether that one's still going), nor a runner's of a routine that still
 * runs there. The old run's end never overwrites the newer run's record (onRoutineTaskEnd).
 */
function strayRun(r: Routine, thread: Session): boolean {
  // Paused for the user's OK there is no sign it was left: it goes on once they answer (lib/types.ts pausedForOk).
  if (ownSession(thread) || pausedForOk(thread, getState())) return false;
  const c = runnerComputerOf(thread.by);
  if (c && runnerRunsOn(r, c)) return false;
  return Date.now() - lastWorkOf(thread, getState().sessions ?? []) > STRAY_QUIET_MS;
}

function taskRun(r: Routine, b: Bot, at: number, opts: RunOpts): RoutineRun {
  const last = r.last;
  const before = last?.sessionId ? session(last.sessionId) : undefined;
  if (before && live(before) && !strayRun(r, before)) return record(r.id, { at, status: "skipped", error: "The last run was still going.", ...stillGoing(last, before.id) });
  const chatId = botChatId(b.id);
  const goal = r.quiet ? `${goalFor(r, at)}\n\nIf nothing needs ${ownerName()} this time, answer exactly NOTHING and nothing else.` : goalFor(r, at);
  try {
    // Someone else's routine: its thread is marked as theirs (Session.fromOutside), as when they start one directly.
    const s = startSession({
      botId: b.id,
      goal,
      title: r.title,
      chatId,
      sentVia: "routine",
      // A runner runs only what doesn't need the Mac (runner.ts runsHere): on its computer.
      where: onRunner() ? "cloud" : (r.where ?? "auto"),
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
  // A run left behind (strayRun) ending after a newer run of its routine began: that one is the routine's last run now.
  if (!mine && r.last && r.last.sessionId !== s.id && r.last.at > (s.startedAt ?? s.createdAt ?? Infinity)) return { suppress: false };
  // A run moved to the Mac (sessions.ts moveToMac): the thread it left is no end of it; the Mac thread's is.
  if (!mine && r.last?.sessionId && session(r.last.sessionId)?.movedFrom === s.id) return { suppress: false };
  // When its run began: a skip since (the thread still going) keeps that (threadAt).
  const at = mine ? (mine.threadAt ?? mine.at) : Date.now();
  const chip = () => {
    if (r.quiet && !getState().messages.some((m) => m.chatId === s.chatId && m.sessionIds?.includes(s.id)))
      addMessage({ chatId: s.chatId, role: "system", text: `Routine · ${describeSchedule(r.schedule, zoneOf(r))}`, sessionIds: [s.id] });
  };
  if (failure) {
    const again = mine?.prevError === failure;
    record(r.id, { at, status: "failed", error: failure, sessionId: s.id });
    if (again) return { suppress: false, again: true };
    chip();
    // Stopped by the user: they know. Set up by text before deliverTo: the thread texts its failure back itself (textBack).
    if (r.deliverTo && !opts.chatOnly && !/^(Stopped by you|Paused while you took over)/.test(failure))
      void deliver(r, `"${r.title}" didn't finish: ${failure}`, at).then((d) => recordDelivery(r.id, at, d));
    return { suppress: false };
  }
  if (r.quiet && (!answer?.trim() || isNothing(answer))) {
    record(r.id, { at, status: "quiet", sessionId: s.id });
    return { suppress: true };
  }
  // What it said: its result, as sessions.ts posts it.
  record(r.id, { at, status: "ok", sessionId: s.id }, answer?.trim() || "Done.");
  chip();
  // The thread's own text back (textBack) covers routines set up by text before deliverTo.
  if (r.deliverTo) void deliver(r, answer?.trim() || "Done.", at).then((d) => recordDelivery(r.id, at, d));
  return { suppress: false };
}

/** A run's words to wherever the routine's results go: deliverTo, else (set up by text before that) the number it was set up from. `at`: when the run began. */
async function sendOut(r: Routine, text: string, tag?: string, at?: number): Promise<RoutineRun["delivery"]> {
  if (r.deliverTo) return deliver(r, text, at);
  if (!r.textTo) return undefined;
  const to = r.textTo.to;
  try {
    const { isOwner, sendText } = await import("./phone");
    // Texted only while the number is still one of the user's verified ones.
    if (!isOwner(to)) throw new Error("that number isn't one of your verified numbers anymore");
    await sendText(r.textTo.botId, to, forText(text), { tag });
    return { status: "sent", to, at: Date.now() };
  } catch (e) {
    return notSent(r, "by text", to, (e as Error).message, at);
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

/**
 * It couldn't be sent: said in the bot's chat (with when its run began, `at`), and returned to be recorded
 * (`to` is a short name the window shows: "Text", "Email", "Slack #sales").
 */
function notSent(r: Routine, how: string, to: string, error: string, at?: number): NonNullable<RoutineRun["delivery"]> {
  addMessage({ chatId: botChatId(r.botId), role: "system", text: `Couldn't send "${r.title}" ${how}: ${error}`, routine: { id: r.id, ...(at !== undefined ? { at } : {}) } });
  return { status: "failed", to, error, at: Date.now() };
}

/**
 * Send a routine's result where it goes besides the chat (Routine.deliverTo): a text to the user's phone
 * from the bot's number (or its team's), an email to the user from the bot's inbox (or its team's; to the
 * user's own address it goes without asking), or a post in Slack, Telegram or Discord, where markdown
 * links read as words and an address. Undefined when it goes nowhere else. A failure is said in the bot's
 * chat too, with when its run began (`at`).
 */
export async function deliver(r: Routine, text: string, at?: number): Promise<RoutineRun["delivery"]> {
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
      return notSent(r, "by text", "Text", (e as Error).message, at);
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
      return notSent(r, "by email", "Email", (e as Error).message, at);
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
    return notSent(r, `to ${place}`, place, (e as Error).message, at);
  }
}

/* ---------------- The timer ---------------- */

/**
 * This Mac's zone is the user's (Owner.timeZone), kept current so routines (and Bops Cloud later) run
 * at their local times. A move to another zone (travel) works out the routines' next times again. Not
 * on a hosted server, nor on a computer's runner, whose own zone isn't the user's: a runner only takes the
 * user's as the Mac keeps it (it starts in it, TZ, and follows it from then on).
 */
function keepZone() {
  const o = getState().owner;
  if (!o || onPostgres()) return;
  // A runner never reads its computer's zone nor writes the user's: it takes theirs as the Mac keeps it.
  if (onRunner()) return followZone(o.timeZone);
  const zone = macZone();
  // Node keeps the zone it launched with until TZ is set: set, its dates and Intl (the time the bots are told) follow the Mac's zone now.
  if (nodeZone() !== zone) {
    process.env.TZ = zone;
    g.__bopsTzSet = zone;
  }
  // Written when this Mac's zone changes, not every time: two Macs in two zones on one account don't take turns.
  if (o.timeZone === zone || (o.timeZone && g.__bopsZoneSeen === zone)) return;
  g.__bopsZoneSeen = zone;
  const was = o.timeZone;
  const now = Date.now();
  const moved = new Set<string>();
  update((s) => {
    if (s.owner) s.owner.timeZone = zone;
    // Times worked out in the old zone move to the new one; what's already due runs as it is. A skipped
    // time moves too: 9 AM skipped in New York is 9 AM skipped in Los Angeles.
    if (was)
      for (const r of s.routines) {
        if (!r.enabled || r.timeZone || r.schedule.kind === "once" || r.nextRunAt === undefined || r.nextRunAt <= now) continue;
        if (r.skips?.length) r.skips = r.skips.map((x) => sameWallTime(x, was, zone)).sort((a, b) => a - b);
        const next = pastSkips(r, nextRun(r.schedule, now, zone, r.lastRunAt), zone) ?? r.nextRunAt;
        if (next !== r.nextRunAt) moved.add(r.botId);
        r.nextRunAt = next;
      }
  });
  for (const botId of moved) routineChanged(botId);
}

/**
 * On a computer's runner: the user's zone as the Mac keeps it (Owner.timeZone), followed before it runs
 * anything (they travel), so its bots are told the time where the user is now (chat.ts nowLines). One that
 * isn't a zone leaves the one it has.
 */
function followZone(zone: string | undefined) {
  if (zone && validTimeZone(zone) && process.env.TZ !== zone) process.env.TZ = zone;
}

/** An enabled routine with no next time never runs (a "once" from before that was set in the past): it's paused, and the chat says why. */
function pauseStuck(r: Routine, why: string) {
  update(() => {
    r.enabled = false;
    r.nextRunAt = undefined;
  });
  routineChanged(r.botId);
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
 * gets it, and that late run takes the place of the next time when it's close (not twice minutes apart).
 * An "every" or meeting routine outside its hours or days waits for them. A one-off, and anything with its next time further off, runs once, late, and says so.
 * Only for a run this Bops was off or asleep for (tick): one late for another reason runs.
 */
function skipLate(r: Routine, due: number, next: number | undefined, now: number, tz?: string) {
  // `next` is its next time as the schedule has it, skipped or not: one the user skipped close by still means "wait".
  if (r.schedule.kind === "once" || next === undefined || now - due <= 2 * 60_000) return false;
  // Outside its hours or days now (a weekday check the Mac woke for on Saturday): it waits for them.
  if (!inHours(r.schedule, now, tz)) return true;
  if (r.last?.status === "skipped" || r.lateRun) return false;
  const beat = beatOf(r.schedule);
  return next - now < (beat !== undefined ? beat / 2 : LATE_NEXT_MS);
}

/** A routine timer tick this long after the one before means nothing ran in between (asleep, off, or signed out). */
const TICK_GAP_MS = 90_000;

/**
 * The routine timer ran this account's routines at `now`: the first time in this process it has (a state
 * loaded at last: a sign-in, Bops Cloud reached after a while), one long after the last, and one with
 * another account's state (a switch however quick) start a new stretch (awakeThrough). The timer may have
 * run all along, but never for this account's routines before.
 */
function noteTick(now: number) {
  const epoch = stateEpoch();
  if (g.__bopsTickedAt === undefined || now - g.__bopsTickedAt > TICK_GAP_MS || g.__bopsTickEpoch !== epoch) g.__bopsTickingFrom = now;
  g.__bopsTickedAt = now;
  g.__bopsTickEpoch = epoch;
}

/**
 * Whether this Bops was up and awake, running this account's routines, from `due` until now: the Mac (or
 * a runner's computer) never slept since and Bops was open then (awake.ts awakeSince), and the routine
 * timer ran them all along (noteTick). A routine due then that's late wasn't missed while it was off or asleep.
 */
const awakeThrough = (due: number) => awakeSince(due) && g.__bopsTickingFrom !== undefined && g.__bopsTickingFrom <= due;

/** How long a routine whose pick came to nothing (no Mac Bops can use yet, Jev didn't answer) waits before it's worked out again. */
const PICK_RETRY_MS = 10 * 60_000;

/**
 * In Cloud, a computer's runner runs a task left to Bops (where auto) that it can (runner.ts pinnedToMac),
 * and it has no Mac to tell one the Mac would take: the user's app rules, Jev's read of a job about an app
 * only on their Mac (Messages, Notes, Photos). So the Mac works out ahead of its runs where it would send
 * each, as for a run of its own (where.ts routinePick), and keeps it with the routine for its goal then
 * (Routine.macPick): one it would send to the Mac stays the Mac's, and runs there as it did before runners.
 * Worked out again when its goal changes. One at a time, in the background.
 */
function pickWhere() {
  if (onRunner() || g.__bopsPicking) return;
  const tried = (g.__bopsPickTried ??= new Map());
  const now = Date.now();
  const todo = getState().routines.filter((r) => needsMacPick(r) && now - (tried.get(`${r.id}\n${r.goal}`) ?? 0) >= PICK_RETRY_MS);
  if (!todo.length) return;
  const epoch = stateEpoch();
  g.__bopsPicking = (async () => {
    const { routinePick } = await import("./where");
    for (const r of todo) {
      const goal = r.goal;
      const where = await routinePick(r.botId, goal).catch(() => null);
      const x = routine(r.id);
      // Another account's state since, or the routine changed meanwhile: worked out again at a tick.
      if (stateEpoch() !== epoch || !x || x.goal !== goal || !needsMacPick(x)) continue;
      if (!where) {
        tried.set(`${r.id}\n${goal}`, Date.now());
        continue;
      }
      update(() => (x.macPick = { goal, where }));
      // Which Bops runs it changed: Orgo hears.
      if (where === "mac") routineChanged(x.botId);
    }
  })()
    .catch((e: Error) => console.warn(`[routines] where runs go: ${e.message}`))
    .finally(() => (g.__bopsPicking = undefined));
}

/**
 * Routine runs whose thread this Bops ended as it started, without a word to the routine (store.ts migrate: it
 * restarted mid-run, or another Mac left the thread behind and it's this Mac's now): recorded failed, and sent
 * where the routine's results go, as any run that dies is (sessions.ts endSessionOf), so the routine shows failed
 * with Run again (a one-off too, off since it fired) instead of Done, or "still running" for good.
 */
function endedAtStart() {
  for (const r of getState().routines) {
    const t = r.last?.status === "running" && r.last.sessionId ? session(r.last.sessionId) : undefined;
    if (t && !live(t) && ownSession(t) && t.status === "failed" && (t.error === RESTARTED || t.error === LEFT_BEHIND)) void onRoutineTaskEnd(t, undefined, t.error);
  }
}

/**
 * Run everything that's due. Called on a timer; waits while there's no account's state to run. A run
 * missed while the Mac slept (or Bops was off; on a runner, while its computer slept) runs once, late,
 * and says so, unless it waits for its next time, which is close (skipLate), where a thread of the
 * routine's still going stays its run. One late while this Bops was up and awake through its time
 * (awakeThrough), or since it became this Bops's, runs, late, whatever its next time or hours: it's late
 * because another Bops had it (a computer's runner that stopped or couldn't start: runner.ts CameHere), not
 * because this one slept, and skipping it would say so falsely and wait for a next time the same may happen
 * to. One this Mac slept through once it had it is a missed run like any other. Each run's next time is set
 * before it starts, and a one-off is turned off as it fires (one Bops runs it start to finish, so nothing runs
 * it twice; a run that fails says so, and Run now runs it again), so a slow run never runs twice. Only this
 * Bops's routines (runner.ts runsHere); a runner also
 * waits until it's sure of where the bots work, of the state and of its computer (runnerReady), only once
 * one of its own needs the timer (runnerHasWork), and a Bops whose state a newer one wrote (it can't be
 * given it now) runs none. Every new next time goes to Orgo (routineChanged).
 */
function tick() {
  if (!stateReady() || stateTooNew()) return;
  endedAtStart();
  // A runner runs its routines while none is due, or while it's sure enough to run one (runnerReady); never
  // while it isn't: that time is as if it was off.
  if (onRunner()) {
    if (!runnerHasWork()) return noteTick(Date.now());
    if (!runnerReady(() => g.__bopsRoutineTick?.())) return;
  }
  noteTick(Date.now());
  keepZone();
  syncRoutinesOnStart();
  pickWhere();
  const now = Date.now();
  for (const r of getState().routines.filter((x) => x.enabled)) {
    // A next time it's skipping that isn't due yet (a skip and a run on two Bops put together:
    // state-merge.ts): the time after it now, whichever Bops runs it, so Orgo wakes nothing for it.
    if (!onRunner() && r.nextRunAt !== undefined && r.nextRunAt > now && skipping(r, r.nextRunAt)) {
      const next = pastSkips(r, r.nextRunAt, zoneOf(r));
      update(() => (r.nextRunAt = next));
      if (next === undefined) pauseStuck(r, "its schedule never comes due.");
      else routineChanged(r.botId);
      continue;
    }
    const here = runsHere(r, now);
    if (!here) continue;
    const tz = zoneOf(r);
    if (r.nextRunAt === undefined) {
      const next = r.schedule.kind === "once" ? (r.schedule.at > now ? r.schedule.at : undefined) : pastSkips(r, nextRun(r.schedule, now, tz, r.lastRunAt), tz);
      if (next === undefined) pauseStuck(r, r.schedule.kind === "once" ? "its time had already passed when it was set, so it never ran. Give it a new time." : "its schedule never comes due.");
      else {
        update(() => (r.nextRunAt = next));
        routineChanged(r.botId);
      }
      continue;
    }
    if (r.nextRunAt > now) continue;
    const due = r.nextRunAt;
    const raw = r.schedule.kind === "once" ? undefined : nextRun(r.schedule, now, tz, beatOf(r.schedule) !== undefined ? due : undefined);
    const next = pastSkips(r, raw, tz);
    const skippedNow = skipping(r, due);
    // Skipped times that have passed are done with.
    if (r.skips?.some((x) => x <= now))
      update(() => {
        const left = r.skips?.filter((x) => x > now) ?? [];
        if (left.length) r.skips = left;
        else delete r.skips;
      });
    // A time the user skipped came due anyway (set as its next before the skip, by any way): it doesn't run.
    if (skippedNow) {
      update(() => (r.nextRunAt = next));
      if (next === undefined) pauseStuck(r, "its schedule never comes due.");
      else routineChanged(r.botId);
      continue;
    }
    // Late, but not for this Bops sleeping: it was up and awake through its time, or (it was a computer's
    // runner's then: runner.ts CameHere) through the time since it's this Mac's. Such a run runs, late,
    // whatever its next time or hours, and takes no next time's place. One this Bops slept through too, once
    // it was its own, is a missed run like any other.
    const awake = awakeThrough(typeof here === "object" ? Math.max(due, here.since) : due);
    if (!awake && skipLate(r, due, raw, now, tz)) {
      update(() => (r.nextRunAt = next));
      routineChanged(r.botId);
      // A thread of the routine's still going (a login it waits on) stays its run: the next run waits for it, and its end is the routine's.
      const t = r.last?.sessionId ? session(r.last.sessionId) : undefined;
      const still = t && live(t) ? stillGoing(r.last, t.id) : {};
      const missed = !onRunner() ? "Missed while Bops was off or this Mac was asleep" : sleptSince(due) ? "Missed while its computer was asleep" : "Missed while its computer's runner couldn't run routines";
      record(r.id, { at: now, status: "skipped", error: `${missed} (it was due ${inSentence(whenText(due, now, tz))}); runs next ${inSentence(whenText(next!, now, tz))}`, ...still });
      continue;
    }
    // A late run that ran because the last was skipped too (missed while this Bops slept), with its next time close: it takes that one's place, so it doesn't run twice minutes apart.
    const then = !awake && next !== undefined && beatOf(r.schedule) === undefined && now - due > 2 * 60_000 && next - now < LATE_NEXT_MS ? pastSkips(r, nextRun(r.schedule, next, tz), tz) : next;
    update(() => {
      r.lastRunAt = now;
      r.nextRunAt = then;
      if (then !== next) r.lateRun = true;
      else delete r.lateRun;
      // A one-off is done as it fires: the Bops that runs it runs it start to finish, so nothing runs it twice.
      if (r.schedule.kind === "once") r.enabled = false;
    });
    // Orgo hears of the next time now, not when the run ends: a runner's computer is woken for it.
    routineChanged(r.botId);
    void run(r.id, { due }).catch((e: Error) => console.warn(`[routines] ${r.id}: ${e.message}`));
    if (r.schedule.kind !== "once" && then === undefined) pauseStuck(r, "its schedule never comes due.");
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
  const line = (r: Routine) => {
    const tz = zoneOf(r);
    return [
      `${r.id}: "${r.title}"${botIds.length > 1 ? ` (${bot(r.botId)?.name ?? r.botId})` : ""}`,
      describe(r.schedule, tz),
      r.timeZone ? `times in ${r.timeZone}` : "",
      r.reminder
        ? "reminder message"
        : r.run === "chat"
          ? "chat run (tools, no computer)"
          : `task, runs ${r.where && r.where !== "auto" ? `on ${r.where === "mac" ? `${owner}'s Mac` : "the cloud computer"}` : "where Bops picks"}`,
      r.quiet ? "quiet (posts only when something needs the user)" : "",
      deliverText(r),
      r.procedure ? `follows skill "${findSkill(r.botId, r.procedure)?.name ?? r.procedure}"` : "",
      r.fromOutside ? `set up by ${r.fromOutside}, not ${owner}` : "",
      r.source ? (r.source.template === CHECK_TEMPLATE ? `checks ${checkWord(r.source)}, as ${owner} picked when connecting it` : `a starter for ${appWord(r.source.app)}`) : "",
      r.tags?.length ? `sorts with tags ${r.tags.join(", ")}` : "",
      // A one-off is done once it fired (Run now before its time doesn't finish it).
      r.enabled ? (r.nextRunAt ? `next ${inSentence(whenText(r.nextRunAt, now, tz))}` : "") : r.schedule.kind === "once" && r.schedule.at <= now ? "done" : "paused",
      r.enabled && r.skips?.some((x) => x > now) ? `skipping ${r.skips.filter((x) => x > now).map((x) => inSentence(whenText(x, now, tz))).join(", ")}` : "",
      r.last ? lastText(r.last, now, tz) : "",
    ]
      .filter(Boolean)
      .join(" · ");
  };
  // The tags its routines sort with: the defaults and each workspace's own (Workspace.tags), so "what do you do every day" can say how.
  const tagged = [...new Set(mine.filter((r) => r.tags?.length).map((r) => workspaceOf(bot(r.botId))))];
  const tags = tagged.map((wsId) => {
    const t = tagsOf(getState().workspaces?.find((w) => w.id === wsId));
    return `Tags your routines sort with${tagged.length > 1 ? ` (${getState().workspaces?.find((w) => w.id === wsId)?.name ?? wsId})` : ""}: ${t.map((x) => `${x.name} (${x.description})`).join("; ")}.`;
  });
  return [`Routines (change them with manage_routine, its schedule and time zone too with action edit; when asked what you do on your own, say these in plain words):\n${mine.map(line).join("\n")}`, ...tags].join("\n");
}

/** A Connected App's or a key's name as the user knows it. */
const appWord = (app: string) => appNameFor(app) ?? app;
/** The account a check is for, as the bot knows it: "Gmail (Work · maya@acme.com)", else the app. */
const checkWord = (src: RoutineSource) => {
  const a = getState().accounts?.find((x) => x.id === src.account);
  const title = a && [a.label, a.name].filter(Boolean).join(" · ");
  return a ? `${a.appName}${title ? ` (${title})` : ""}` : appWord(src.app);
};

// The timer calls whatever version of tick was loaded last, so edits apply without a restart.
g.__bopsRoutineTick = tick;
// One timer: a reload replaces the old one (an older version's timer called its own tick directly).
if (g.__bopsRoutines) clearInterval(g.__bopsRoutines);
g.__bopsRoutines = setInterval(() => g.__bopsRoutineTick?.(), 20_000);
