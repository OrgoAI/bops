import { botChatId, live, type Chat, type Message, type Routine, type RoutineRun, type Session } from "./types";

/*
 * A routine's reports: each of its runs, newest first, with what that run said in the bot's chat. The
 * runs are Orgo's record of them (orgo-web public.routine_runs, which routine-sync.ts fills as each run
 * finishes, read through /api/routines/{id}/runs) and the routine's last run as Bops has it (Routine.last,
 * which may not be in Orgo's yet, and alone says where its result was sent). What each run said is the
 * chat's: a reminder's or a chat run's message (Message.routine), a task's result (Message.resultOf, of a
 * thread with Session.routineId). A run's message carries when its run began (Message.routine.at), so it
 * goes with that run exactly; one from before that, by time: posted from its run's start to its end (and a
 * little after, as a reminder posts after it's recorded), never into the next run's. One that fits no run
 * stays in the list as its own (fromChat), never a guess at another's, how it went as its thread says (a
 * thread that failed, or is still going); a chat run's words and the result of the thread it started are
 * one such run. With no record from Orgo (it didn't answer, a workspace with no Orgo project, a workspace
 * shared with the viewer), it's the last run and what's in the chat. Orgo's copy of what a run said
 * (RecordedRun.summary, the message text cut to 2000) stands in only for a run from before the chat here
 * goes back (its start, or its oldest message): a message deleted from the chat isn't shown again.
 */

/** A run as Orgo records it (GET /api/projects/{id}/routines/{routineId}/runs), times in epoch ms. */
export type RecordedRun = {
  startedAt: number;
  finishedAt: number | null;
  status: "ok" | "failed" | "skipped" | "waiting";
  ms: number | null;
  summary: string | null;
  error: string | null;
};

/** What a quiet run's record says (routine-sync.ts runPayload): it ran, and nothing needed the user. */
export const QUIET_SUMMARY = "Nothing needed the user.";
/** The most of a run's words Orgo keeps (orgo-web ROUTINE_LIMITS.runText, in UTF-16 units). */
export const SUMMARY_MAX = 2000;
/** The most runs one read asks Orgo for (orgo-web's cap). */
export const RUNS_MAX = 100;
/** After a run is recorded, how long a message of it without its stamp may still come (a reminder posts after its record). */
export const PAIR_GRACE_MS = 2 * 60_000;
/** A thread starts just after its run is recorded; this much before counts too (another computer's clock). */
const THREAD_SLACK_MS = 5_000;

/** One run in the list, and what it said. */
export type Report = {
  /** Unique in the list: "run:<at>", or "chat:<at>:<message id>" for words no record was found for. */
  key: string;
  /** When the run began. */
  at: number;
  status: RoutineRun["status"];
  finishedAt?: number;
  ms?: number;
  error?: string;
  /** Its words in the bot's chat, oldest first. */
  messages: Message[];
  /** Orgo's copy of its words, when the chat has none of them. */
  summary?: string;
  /** Its thread, when it ran on a computer and the thread is still there. */
  thread?: Session;
  /** Where its result was sent besides the chat (the last run only: Bops keeps it on Routine.last). */
  delivery?: RoutineRun["delivery"];
  /** The routine's last run, as Bops has it. */
  last?: true;
  /** Words in the chat that no run's record was found for: shown as a run of their own, when they were said. */
  fromChat?: true;
};

/** A run's record from Orgo's answer, or undefined for one that isn't one. */
export function recordedRun(x: unknown): RecordedRun | undefined {
  if (!x || typeof x !== "object") return undefined;
  const o = x as Record<string, unknown>;
  const num = (v: unknown) => (typeof v === "number" && Number.isFinite(v) ? v : null);
  const str = (v: unknown) => (typeof v === "string" ? v : null);
  const startedAt = num(o.startedAt);
  if (startedAt === null || !["ok", "failed", "skipped", "waiting"].includes(o.status as string)) return undefined;
  return { startedAt, finishedAt: num(o.finishedAt), status: o.status as RecordedRun["status"], ms: num(o.ms), summary: str(o.summary), error: str(o.error) };
}

/** A message that says what one of this routine's runs found: a reminder's or a chat run's words, a task's result, a reminder someone else set up. */
function reportOf(m: Message, routineId: string, threads: Map<string, Session>): "tagged" | "thread" | null {
  if (m.routine?.id === routineId) return m.role === "bot" || (m.role === "system" && m.text.startsWith("Reminder set up by ")) ? "tagged" : null;
  if (m.role === "bot" && m.resultOf && threads.has(m.resultOf)) return "thread";
  return null;
}

/** A run as it's worked out: with its record's thread, which the report then names (Report.thread). */
type Run = Report & { sessionId?: string };

/**
 * Routine `r`'s reports, newest first: its runs from Orgo (`runs`, null when there's no record to read)
 * merged with its last run, each with what it said in the chat (`messages`, `sessions`: the window's).
 * `limit`: how many runs Orgo was asked for; fewer back means Orgo has every run, so words older than all
 * of them are runs from before it kept them, shown as their own.
 */
export function routineReports({
  routine: r,
  runs,
  messages,
  sessions,
  chats,
  limit = RUNS_MAX,
}: {
  routine: Routine;
  runs: RecordedRun[] | null;
  messages: Message[];
  sessions: Session[];
  chats?: Chat[];
  limit?: number;
}): Report[] {
  // How far back the window's chat with the bot goes (its start here, else its oldest message): a run since then
  // whose words aren't in it had them deleted, so Orgo's copy isn't shown for it.
  const chatId = botChatId(r.botId);
  let chatFrom = chats?.find((c) => c.id === chatId)?.createdAt ?? Infinity;
  for (const m of messages) if (m.chatId === chatId && m.at < chatFrom) chatFrom = m.at;
  const list: Run[] = [];
  for (const x of runs ?? []) {
    const quiet = x.status === "ok" && x.summary === QUIET_SUMMARY;
    list.push({
      key: `run:${x.startedAt}`,
      at: x.startedAt,
      status: quiet ? "quiet" : x.status === "waiting" ? "running" : x.status,
      ...(x.finishedAt !== null ? { finishedAt: x.finishedAt } : {}),
      ...(x.ms !== null ? { ms: x.ms } : x.finishedAt !== null ? { ms: Math.max(0, x.finishedAt - x.startedAt) } : {}),
      ...(x.error ? { error: x.error } : {}),
      ...(x.summary && !quiet && x.startedAt < chatFrom ? { summary: x.summary } : {}),
      messages: [],
    });
  }
  // The last run as Bops has it: over Orgo's record of it (how it went is Bops' to say; where it was sent only Bops knows), else ahead of them.
  const last = r.last;
  if (last) {
    const had = list.find((x) => x.at === last.at);
    const mine = { status: last.status, ...(last.error ? { error: last.error } : {}), ...(last.sessionId ? { sessionId: last.sessionId } : {}), ...(last.delivery ? { delivery: last.delivery } : {}), last: true as const };
    if (had) Object.assign(had, mine);
    else list.push({ key: `run:${last.at}`, at: last.at, messages: [], ...mine });
    // Skipped while its thread is still going: that thread is a run still going, begun when it was (threadAt).
    const still = last.status === "skipped" && last.sessionId && last.threadAt !== undefined ? sessions.find((s) => s.id === last.sessionId) : undefined;
    if (still && live(still) && !list.some((x) => x.at === last.threadAt)) list.push({ key: `run:${last.threadAt}`, at: last.threadAt!, status: "running", sessionId: still.id, messages: [] });
  }
  list.sort((a, b) => b.at - a.at);

  // Each run's stretch, for what has no stamp: from its start to its end (and a little after), never into a newer run that could say
  // something (a skipped one says nothing). The newest such run's goes on: nothing newer has begun.
  const talks = (x: Run) => x.status !== "skipped";
  const ends = new Map<Run, number>();
  let newer: Run | undefined;
  for (const x of list) {
    if (!talks(x)) continue;
    const cap = newer ? newer.at - 1 : Infinity;
    ends.set(x, Math.min(cap, newer && x.finishedAt !== undefined ? x.finishedAt + PAIR_GRACE_MS : Infinity));
    newer = x;
  }
  const inStretch = (t: number, slack = 0) => {
    const found = list.filter((x) => talks(x) && t >= x.at - slack && t <= (ends.get(x) ?? x.at));
    return found.length === 1 ? found[0] : undefined;
  };

  // Its threads, and the run each was: by the run's record (sessionId), else when it began.
  const threads = new Map(sessions.filter((s) => s.routineId === r.id).map((s) => [s.id, s]));
  const runOfThread = new Map<string, Run>();
  for (const s of threads.values()) {
    const run = list.find((x) => x.sessionId === s.id && talks(x)) ?? inStretch(s.createdAt, THREAD_SLACK_MS);
    if (run) runOfThread.set(s.id, run);
  }
  for (const [id, run] of runOfThread) {
    const s = threads.get(id)!;
    // The one its record names; else the newest (a thread moved to the Mac goes on there).
    if (run.sessionId && run.thread?.id === run.sessionId) continue;
    if (s.id === run.sessionId || !run.thread || s.createdAt > run.thread.createdAt) run.thread = s;
  }

  // Each with its stamp, or the thread it's the result of.
  const leftover: { at: number; key: string; m: Message; stamp?: number; thread?: Session }[] = [];
  for (const m of messages) {
    const kind = reportOf(m, r.id, threads);
    if (!kind) continue;
    const stamp = kind === "tagged" ? m.routine?.at : undefined;
    const run =
      stamp !== undefined ? list.find((x) => x.at === stamp && talks(x)) : kind === "thread" ? runOfThread.get(m.resultOf!) : inStretch(m.at);
    if (run) run.messages.push(m);
    else {
      // Its own: when its run began, as far as the chat says (its stamp, its thread's start, else when it was said).
      const at = stamp ?? (kind === "thread" ? threads.get(m.resultOf!)!.createdAt : m.at);
      const thread = kind === "thread" ? threads.get(m.resultOf!) : undefined;
      leftover.push({ at, key: stamp !== undefined ? `${stamp}` : thread ? thread.id : m.id, m, stamp, thread });
    }
  }
  for (const x of list) x.messages.sort((a, b) => a.at - b.at);
  // A chat run that started a task: its words carry its stamp, the thread's result doesn't. The thread began
  // during that run's turn (from its start to when its words were posted): one run, the newest such.
  const turns = new Map<number, number>();
  for (const x of leftover) if (x.stamp !== undefined) turns.set(x.stamp, Math.max(turns.get(x.stamp) ?? -Infinity, x.m.at));
  for (const x of leftover) {
    if (!x.thread) continue;
    const began = x.thread.createdAt;
    let turn: number | undefined;
    for (const [stamp, end] of turns) if (began >= stamp - THREAD_SLACK_MS && began <= end + THREAD_SLACK_MS && (turn === undefined || stamp > turn)) turn = stamp;
    if (turn === undefined) continue;
    x.at = turn;
    x.key = `${turn}`;
  }

  // Words no record was found for: a run of their own (one per stamp or thread). With Orgo's record, only those
  // inside what it lists (or all, when it listed every run): older ones are past the runs shown.
  const oldest = list.length ? list[list.length - 1].at : -Infinity;
  const complete = runs === null || runs.length < limit;
  const own = new Map<string, Run>();
  for (const x of leftover) {
    if (!complete && x.at < oldest) continue;
    const k = `chat:${x.key}`;
    const run = own.get(k) ?? { key: `chat:${x.at}:${x.m.id}`, at: x.at, status: "ok" as const, messages: [], fromChat: true as const };
    run.messages.push(x.m);
    if (x.m.resultOf && threads.has(x.m.resultOf)) run.thread = threads.get(x.m.resultOf);
    own.set(k, run);
  }
  // How it went, with no record to say: as its thread says (it failed, or it's still going), else it ran.
  for (const x of own.values()) {
    if (x.thread?.status === "failed") {
      x.status = "failed";
      if (x.thread.error) x.error = x.thread.error;
    } else if (x.thread && live(x.thread)) x.status = "running";
  }
  const all: Run[] = [...list, ...own.values()].sort((a, b) => b.at - a.at || Number(!!a.fromChat) - Number(!!b.fromChat));
  for (const x of all) {
    // A skipped run's thread is the one still going from before it: that run's, not this one's.
    if (!x.thread && x.sessionId && talks(x)) x.thread = sessions.find((s) => s.id === x.sessionId);
    if (x.ms === undefined && x.finishedAt === undefined && x.thread?.endedAt && x.status !== "running" && x.thread.endedAt >= x.at) x.ms = x.thread.endedAt - x.at;
  }
  return all.slice(0, Math.max(limit, RUNS_MAX)).map((x) => {
    delete x.sessionId;
    return x;
  });
}

/** How long a run took, short: "12s", "4m", "1h 5m". */
export function tookWords(ms: number) {
  const s = Math.round(ms / 1000);
  if (s < 60) return `${s}s`;
  const m = Math.round(s / 60);
  if (m < 60) return `${m}m`;
  return m % 60 ? `${Math.floor(m / 60)}h ${m % 60}m` : `${m / 60}h`;
}
