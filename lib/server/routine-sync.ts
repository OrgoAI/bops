import "server-only";
import { normalizeSchedule } from "@/cloud/schedule";
import { templateById } from "@/lib/routine-catalog";
import { QUIET_SUMMARY, recordedRun, RUNS_MAX, SUMMARY_MAX, type RecordedRun } from "@/lib/routine-reports";
import { waitingAsks, workspaceOf, type Routine, type RoutineRun } from "@/lib/types";
import { onRunner, runnerRoutine, runnerRuns } from "./runner";
import { bot, getState, pullState } from "./store";
import { outbox } from "./sync-outbox";

/**
 * A copy of each workspace's routines in its Orgo project (orgo-web public.routines and
 * public.routine_runs), so Orgo can show them and, later, run them. Bops stays the source: this only
 * mirrors. A workspace with an Orgo project (Workspace.orgoProjectId) sends, after a routine is made,
 * changed, paused, resumed or deleted, the whole of its routines (PUT /api/projects/{id}/routines,
 * debounced 2 seconds so a burst of changes is one call), and each finished run right after that
 * (POST /api/projects/{id}/routines/{orgoId}/runs, the Orgo id the PUT answered for its routine).
 *
 * Never in the way: nothing here is awaited by a routine, every failure is a warning in the log, and a
 * routine runs the same whether Orgo answered or not. A batch Orgo didn't take (no answer, or 5xx) goes
 * back in the queue with its deleteMissing and runs, sent again after a backoff (RETRY_MS, doubling).
 * One flush per workspace at a time, so a slow PUT is never overtaken by a newer one. An Orgo without
 * the routes (404 or 405) is asked again at most once every 6 hours. On the first tick after start (routines.ts), each workspace sends a
 * full copy with deleteMissing, so a routine deleted while Orgo couldn't be reached goes there too.
 * Finished runs wait in an outbox kept with the user's folder (sync-outbox.ts) until Orgo took them, so a
 * quit while Orgo is away loses none: what's left goes again after the next start. Orgo takes 500
 * routines a call: a workspace with more sends them 500 at a time, and what's gone is deleted one by one
 * (GET the list, DELETE each Orgo has that Bops doesn't), so deletes reach Orgo past 500 too. A workspace
 * that gets its Orgo project only later (workspaces.ts bindMissingProjects) sends its full copy then
 * (routinesBound). Runs on the signed-in Orgo key (orgo.ts apiKey); signed out, nothing is sent. Each
 * finished run goes with what it said (its summary: the message it posted, cut to 2000), so its report
 * is there on another Mac or after the chat is cleared; the Routines page reads them back (routineRuns).
 *
 * Orgo wakes a computer for its runner by these (runner.ts): each routine says how it runs (`run`) and
 * whether the Mac runs it (`onMac`: it needs the Mac, runner.ts pinnedToMac, as a reminder and a chat run
 * always do, or its computer has no runner up: runnerRuns), and every new next time is sent (routines.ts),
 * as is every change to whether a computer's runner is up (runner-install.ts). A one-off that fired is off,
 * with no next time: nothing wakes a computer for it again; nor while its run waits for the user's OK, which
 * goes with no next time until they answer or Stop (routinePayload). A computer's runner sends only its own routines
 * (runnerRoutine), never with deleteMissing: the whole set, and what's gone from it, are the Mac's to send.
 */

/** How long changes gather before they're sent. */
export const SYNC_DEBOUNCE_MS = 2_000;
/** How long an Orgo without the routes is left alone before it's asked again. */
export const MISSING_RETRY_MS = 6 * 60 * 60_000;
/** The most routines one call sends (orgo-web's cap). */
const MAX_ROUTINES = 500;
const TIMEOUT_MS = 15_000;
/** After Orgo didn't answer (or answered 5xx), how long until the batch is sent again; it doubles up to RETRY_MAX_MS. */
export const RETRY_MS = 60_000;
const RETRY_MAX_MS = 30 * 60_000;
/** The most finished runs kept waiting for one workspace (the newest). */
const MAX_RUNS_WAITING = 200;

/** A finished run waiting to go, with what it said (`said`, cut as runSummary cuts it); `oid` is its entry in the outbox kept on disk. */
type WaitingRun = { bopsId: string; run: RoutineRun; finishedAt: number; said?: string; oid?: string };
type Pending = { timer?: ReturnType<typeof setTimeout>; deleteMissing: boolean; runs: WaitingRun[]; tries?: number };

const g = globalThis as unknown as {
  __bopsRoutineSync?: Map<string, Pending>;
  __bopsRoutineSyncMissing?: Map<string, number>;
  __bopsRoutineSyncStarted?: boolean;
  __bopsRoutineSyncInFlight?: Map<string, Promise<void>>;
  __bopsRoutineSyncHeld?: Map<string, Pick<Pending, "deleteMissing" | "runs">>;
  __bopsRoutineOrgoIds?: Map<string, string>;
};
/** What's waiting to go, by workspace. */
const pending = (g.__bopsRoutineSync ??= new Map());
/** Orgo projects whose Orgo answered 404 or 405, and when it may be asked again. */
const missing = (g.__bopsRoutineSyncMissing ??= new Map());
/** The flush going for a workspace: one at a time, so each PUT carries state at least as new as the one before. */
const inFlight = (g.__bopsRoutineSyncInFlight ??= new Map());
/** A batch Orgo refused (a 400, too big): not sent again as it is, but its deleteMissing and runs go with the next change. */
const held = (g.__bopsRoutineSyncHeld ??= new Map());
/** Each routine's Orgo id, by its Bops id, as Orgo last answered (a PUT, or its list): what its runs are read by. */
const orgoIdOf = (g.__bopsRoutineOrgoIds ??= new Map());
/** Finished runs Orgo hasn't taken yet, kept on disk until it does (the newest MAX_RUNS_WAITING per workspace). */
const runsOutbox = outbox<Omit<WaitingRun, "oid">>("routine-runs", MAX_RUNS_WAITING);

const LONE_SURROGATE = /[\uD800-\uDBFF](?![\uDC00-\uDFFF])|(?<![\uD800-\uDBFF])[\uDC00-\uDFFF]/g;
/**
 * Text Postgres can store (it refuses a NUL and half an emoji), cut to `max` characters by code point, so
 * a cut never splits an emoji. One routine with either would have Orgo refuse the workspace's whole list.
 */
export function cleanText(s: string, max: number): string {
  const t = s.replace(/\u0000/g, "").replace(LONE_SURROGATE, "");
  return t.length <= max ? t : Array.from(t).slice(0, max).join("");
}

/** Text cut to `max` UTF-16 units, as orgo-web counts (cleanText counts characters), never leaving half an emoji. */
export function fit(text: string, max: number) {
  const t = cleanText(text, max);
  if (t.length <= max) return t;
  const end = t.charCodeAt(max - 1) >= 0xd800 && t.charCodeAt(max - 1) <= 0xdbff ? max - 1 : max;
  return t.slice(0, end);
}

/** The workspace a routine's bot is in, and its Orgo project; undefined without one. */
function projectOfBot(botId: string): { wsId: string; projectId: string } | undefined {
  const wsId = workspaceOf(bot(botId));
  const projectId = getState().workspaces?.find((w) => w.id === wsId)?.orgoProjectId;
  return projectId ? { wsId, projectId } : undefined;
}

const iso = (ms: number | undefined) => (ms !== undefined && Number.isFinite(ms) ? new Date(ms).toISOString() : undefined);

/** A run's status in Orgo's words (ok, failed, skipped, waiting): quiet went fine, running is waiting on its thread. */
const orgoStatus = (status: RoutineRun["status"]) => (status === "quiet" ? "ok" : status === "running" ? "waiting" : status);

/** Whether routine `r`'s run waits for the user's OK: a request of its thread unanswered (lib/types.ts waitingAsks). */
const waitsForOk = (r: Routine) => !!r.last?.sessionId && waitingAsks(getState(), r.last.sessionId).length > 0;

/**
 * A routine as orgo-web takes it (app/api/projects/[id]/routines), or undefined for one whose schedule
 * isn't one (orgo-web would refuse the whole list for it). The schedule goes as Bops keeps it now
 * (normalizeSchedule), so one kept before today's rules (an "every" over a day) still goes. While its
 * run waits for the user's OK it goes with no next time: each time that came would only be skipped (the
 * run is still going), so nothing is due on its computer, and Orgo's waker, which goes by the next time,
 * wakes it for nothing until they answer or Stop (permission.ts sends it again then).
 */
export function routinePayload(r: Routine) {
  const s = normalizeSchedule(r.schedule);
  if ("error" in s) return undefined;
  const kind = r.source ? templateById(r.source.template)?.kind : undefined;
  const d = r.deliverTo;
  const tags = r.tags?.map((t) => cleanText(t, 64)).filter(Boolean);
  // The last run as its run POST says it (its start and status), so the PUT and the runs agree.
  const lastRunAt = iso(r.last?.at ?? r.lastRunAt);
  return {
    bopsId: r.id,
    botId: r.botId,
    kind: kind === "monitor" ? "monitor" : "schedule",
    // How it runs (routines.ts run): someone else's is never a chat run. Orgo wakes no computer for one the Mac runs, as a reminder and a chat run always are.
    run: r.reminder ? "reminder" : r.run === "chat" && !r.fromOutside ? "chat" : "task",
    onMac: !runnerRuns(r),
    title: cleanText(r.title.trim(), 200).trim() || cleanText(r.goal.trim(), 200).trim() || "Routine",
    goal: cleanText(r.goal, 8000),
    enabled: r.enabled,
    quiet: !!r.quiet,
    schedule: s.schedule,
    ...(r.timeZone ? { timeZone: r.timeZone } : {}),
    ...(r.source ? { source: { app: cleanText(r.source.app, 128), template: cleanText(r.source.template, 128) } } : {}),
    ...(tags?.length ? { tags } : {}),
    ...(d ? { delivery: d.kind === "channel" ? { kind: d.kind, linkId: cleanText(d.linkId, 200), ...(d.chat ? { chat: cleanText(d.chat, 200) } : {}) } : d } : {}),
    ...(iso(r.nextRunAt) && !waitsForOk(r) ? { nextRunAt: iso(r.nextRunAt) } : {}),
    ...(lastRunAt ? { lastRunAt } : {}),
    ...(r.last ? { lastStatus: orgoStatus(r.last.status) } : {}),
    ...(s.schedule.kind === "before_event" && iso(r.eventsThrough) ? { eventsThrough: iso(r.eventsThrough) } : {}),
  };
}

/**
 * What a run said, as its record keeps it: the message text, trimmed, never more than orgo-web takes
 * (SUMMARY_MAX, counted as it counts), cut with an ellipsis; undefined for nothing.
 */
export function runSummary(text: string | undefined): string | undefined {
  const t = cleanText(text ?? "", Infinity).trim();
  if (!t) return undefined;
  return t.length <= SUMMARY_MAX ? t : `${fit(t, SUMMARY_MAX - 1).trimEnd()}…`;
}

/**
 * A finished run as orgo-web takes it: quiet is a run that went fine with nothing to say (QUIET_SUMMARY);
 * one that said something goes with what it said (`said`, runSummary).
 */
export function runPayload(run: RoutineRun, finishedAt: number, said?: string) {
  const status = run.status === "failed" ? "failed" : run.status === "skipped" ? "skipped" : "ok";
  const summary = run.status === "quiet" ? QUIET_SUMMARY : status === "ok" ? runSummary(said) : undefined;
  return {
    startedAt: new Date(run.at).toISOString(),
    finishedAt: new Date(Math.max(finishedAt, run.at)).toISOString(),
    status,
    ms: Math.max(0, Math.round(finishedAt - run.at)),
    ...(summary ? { summary } : {}),
    ...(run.error && cleanText(run.error, 2000) ? { error: cleanText(run.error, 2000) } : {}),
  };
}

/** One call to orgo-web with the signed-in key: its status and JSON, or null when it didn't answer or no one is signed in. */
async function send(method: "GET" | "PUT" | "POST" | "DELETE", path: string, body?: unknown, timeoutMs = TIMEOUT_MS): Promise<{ status: number; json: unknown } | null> {
  const { apiKey, callOrgo } = await import("./orgo");
  const key = await apiKey().catch(() => "");
  if (!key) return null;
  return callOrgo(key, path, { method, ...(body === undefined ? {} : { body }), timeoutMs });
}

/** The Orgo id of each routine the PUT answered with, by its Bops id. */
function orgoIds(json: unknown): Map<string, string> {
  const out = new Map<string, string>();
  const list = (json as { routines?: unknown })?.routines;
  if (Array.isArray(list)) for (const x of list) if (x && typeof x.bopsId === "string" && typeof x.id === "string") out.set(x.bopsId, x.id);
  return out;
}

/** Whether Orgo is being left alone for this project (it hasn't the routes), as of `now`. */
const routesMissing = (projectId: string, now = Date.now()) => (missing.get(projectId) ?? 0) > now;

/** Orgo didn't answer, answered 5xx, or for now (signed out, a timeout, too many at once): worth sending again. */
const retryable = (status: number | null) => status === null || status >= 500 || status === 401 || status === 403 || status === 408 || status === 429;

/** A batch that didn't get through goes back in the queue (its deleteMissing and runs too), sent again after a backoff. */
function requeue(wsId: string, p: Pending, runs = p.runs, deleteMissing = p.deleteMissing) {
  const tries = (p.tries ?? 0) + 1;
  const wait = Math.min(RETRY_MS * 2 ** (tries - 1), RETRY_MAX_MS);
  queue(
    wsId,
    (q) => {
      q.deleteMissing ||= deleteMissing;
      q.runs = [...runs, ...q.runs].slice(-MAX_RUNS_WAITING);
      q.tries = Math.max(q.tries ?? 0, tries);
    },
    wait,
  );
}

/** Send what's waiting for a workspace: its routines (500 a call), what's gone from them, then its finished runs. */
async function flush(wsId: string): Promise<void> {
  const p = pending.get(wsId);
  if (!p) return;
  if (p.timer) clearTimeout(p.timer);
  pending.delete(wsId);
  const projectId = getState().workspaces?.find((w) => w.id === wsId)?.orgoProjectId;
  if (!projectId || routesMissing(projectId)) return;
  const base = `/api/projects/${encodeURIComponent(projectId)}/routines`;
  // A runner: its own routines only, and nothing deleted (the Mac's whole set says what's gone).
  const runner = onRunner();
  const all = getState()
    .routines.filter((r) => workspaceOf(bot(r.botId)) === wsId && (!runner || runnerRoutine(r)))
    .map(routinePayload)
    .filter((x) => x !== undefined);
  if (runner && !all.length) return;
  // More than Orgo takes in one call: 500 at a time, none with deleteMissing (a part isn't the whole set);
  // what's gone is then deleted one by one.
  const over = all.length > MAX_ROUTINES;
  const ids = new Map<string, string>();
  for (let i = 0; i === 0 || i < all.length; i += MAX_ROUTINES) {
    const routines = all.slice(i, i + MAX_ROUTINES);
    const res = await send("PUT", base, { routines, ...(p.deleteMissing && !over && !runner ? { deleteMissing: true } : {}) });
    const status = res?.status ?? null;
    if (status === 404 || status === 405) {
      missing.set(projectId, Date.now() + MISSING_RETRY_MS);
      return;
    }
    if (status === null || status >= 300) {
      if (status !== null) console.warn(`[routine-sync] ${wsId}: Orgo answered ${status} to the routines`);
      if (retryable(status)) requeue(wsId, p);
      else {
        const h = held.get(wsId);
        held.set(wsId, { deleteMissing: p.deleteMissing || !!h?.deleteMissing, runs: [...(h?.runs ?? []), ...p.runs].slice(-MAX_RUNS_WAITING) });
      }
      return;
    }
    for (const [bopsId, id] of orgoIds(res?.json)) {
      ids.set(bopsId, id);
      orgoIdOf.set(bopsId, id);
    }
  }
  missing.delete(projectId);
  if (over && p.deleteMissing && !runner && !(await deleteGone(wsId, base, new Set(all.map((r) => r.bopsId))))) requeue(wsId, p, [], true);
  const again: Pending["runs"] = [];
  for (const x of p.runs) {
    const orgoId = ids.get(x.bopsId);
    // Not in Orgo's copy (deleted meanwhile, or its schedule couldn't go): nothing to record it on.
    if (!orgoId) {
      runsOutbox.done([x.oid]);
      continue;
    }
    const s = await send("POST", `${base}/${encodeURIComponent(orgoId)}/runs`, runPayload(x.run, x.finishedAt, x.said));
    if (retryable(s?.status ?? null)) again.push(x);
    else runsOutbox.done([x.oid]);
    if (s && s.status >= 300 && s.status !== 404) console.warn(`[routine-sync] ${wsId}: Orgo answered ${s.status} to a run`);
  }
  if (again.length) requeue(wsId, p, again, false);
}

/**
 * A workspace with more routines than one call takes: each routine Orgo has that isn't among `keep` is
 * deleted by its Orgo id (DELETE /api/projects/{id}/routines/{routineId}), as deleteMissing does for 500 or
 * fewer. False when Orgo didn't answer the list or a delete for now (all of it goes again after a backoff).
 */
async function deleteGone(wsId: string, base: string, keep: Set<string>): Promise<boolean> {
  const listed = await send("GET", base);
  const list = (listed?.json as { routines?: unknown })?.routines;
  if (!listed || listed.status >= 300 || !Array.isArray(list)) {
    if (listed && !retryable(listed.status)) console.warn(`[routine-sync] ${wsId}: Orgo answered ${listed.status} to the routines list`);
    return !retryable(listed?.status ?? null);
  }
  let ok = true;
  for (const x of list as { id?: unknown; bopsId?: unknown }[]) {
    if (typeof x?.id !== "string" || typeof x.bopsId !== "string" || keep.has(x.bopsId)) continue;
    const d = await send("DELETE", `${base}/${encodeURIComponent(x.id)}`);
    if (retryable(d?.status ?? null)) ok = false;
    else if (d && d.status >= 300 && d.status !== 404) console.warn(`[routine-sync] ${wsId}: Orgo answered ${d.status} to a routine's delete`);
  }
  return ok;
}

/**
 * Flush a workspace, one flush at a time: while one is going, what's queued waits for it and goes right
 * after, so a slow PUT is never overtaken by a newer one (which a stale deleteMissing would then undo).
 */
function start(wsId: string): Promise<void> {
  const going = inFlight.get(wsId);
  if (going) return going;
  const done = flush(wsId)
    .catch((e: Error) => console.warn(`[routine-sync] ${wsId}: ${e.message}`))
    .finally(() => {
      inFlight.delete(wsId);
      const next = pending.get(wsId);
      // Queued meanwhile and its wait is over: it goes now.
      if (next && !next.timer) void start(wsId);
    });
  inFlight.set(wsId, done);
  return done;
}

/** Gather a change for a workspace and send it all `wait` (SYNC_DEBOUNCE_MS) after the last one. */
function queue(wsId: string, add: (p: Pending) => void, wait = SYNC_DEBOUNCE_MS) {
  restoreRuns();
  const p: Pending = pending.get(wsId) ?? { deleteMissing: false, runs: [] };
  const h = held.get(wsId);
  if (h) {
    held.delete(wsId);
    p.deleteMissing ||= h.deleteMissing;
    p.runs = [...h.runs, ...p.runs].slice(-MAX_RUNS_WAITING);
  }
  add(p);
  if (p.timer) clearTimeout(p.timer);
  p.timer = setTimeout(() => {
    p.timer = undefined;
    void start(wsId);
  }, wait);
  p.timer.unref?.();
  pending.set(wsId, p);
}

/**
 * A routine of this bot's was made, changed, paused, resumed or deleted: its workspace's routines go to
 * Orgo shortly. Each call sends the whole set; after a delete, with deleteMissing, so it goes there too.
 */
export function routineChanged(botId: string, opts: { deleted?: boolean } = {}) {
  try {
    const at = projectOfBot(botId);
    if (!at || routesMissing(at.projectId)) return;
    queue(at.wsId, (p) => (p.deleteMissing ||= !!opts.deleted));
  } catch (e) {
    console.warn(`[routine-sync] ${(e as Error).message}`);
  }
}

/**
 * Routines of this workspace went without routineChanged (their bot was deleted, remove.ts): its routines
 * go to Orgo shortly with deleteMissing, so theirs go there too. The workspace is passed, as the bot is gone.
 */
export function routinesRemovedInWorkspace(wsId: string) {
  try {
    const projectId = getState().workspaces?.find((w) => w.id === wsId)?.orgoProjectId;
    if (!projectId || routesMissing(projectId)) return;
    queue(wsId, (p) => (p.deleteMissing = true));
  } catch (e) {
    console.warn(`[routine-sync] ${(e as Error).message}`);
  }
}

/** Runs left in the outbox by a run of Bops before this one: queued again, once (queue calls this first). */
function restoreRuns() {
  const back = runsOutbox.restore();
  if (!back.length) return;
  const by = new Map<string, WaitingRun[]>();
  for (const e of back) by.set(e.wsId, [...(by.get(e.wsId) ?? []), { ...e.item, oid: e.id }]);
  for (const [wsId, runs] of by) {
    const projectId = getState().workspaces?.find((w) => w.id === wsId)?.orgoProjectId;
    // Its workspace is gone, or has no project now: nothing to record them on.
    if (!projectId) {
      runsOutbox.done(runs.map((x) => x.oid));
      continue;
    }
    queue(wsId, (p) => {
      const had = new Set(p.runs.map((x) => x.oid));
      p.runs = [...runs.filter((x) => !had.has(x.oid)), ...p.runs].slice(-MAX_RUNS_WAITING);
    });
  }
}

/**
 * A routine's run was recorded (routines.ts record): once it's finished, it goes to Orgo with the routine,
 * and with what it said in the chat (`said`: the message it posted), kept as its summary.
 */
export function routineRan(routineId: string, run: RoutineRun, said?: string) {
  try {
    if (run.status === "running") return;
    const r = getState().routines.find((x) => x.id === routineId);
    const at = r && projectOfBot(r.botId);
    if (!at || routesMissing(at.projectId)) return;
    // What an earlier run of Bops left waiting first, so this one isn't handed back with it.
    restoreRuns();
    const summary = run.status === "ok" ? runSummary(said) : undefined;
    const item = { bopsId: routineId, run: { ...run }, finishedAt: Date.now(), ...(summary ? { said: summary } : {}) };
    const oid = runsOutbox.add(at.wsId, item);
    queue(at.wsId, (p) => {
      p.runs.push({ ...item, oid });
      if (p.runs.length > MAX_RUNS_WAITING) p.runs.splice(0, p.runs.length - MAX_RUNS_WAITING);
    });
  } catch (e) {
    console.warn(`[routine-sync] ${(e as Error).message}`);
  }
}

/**
 * A workspace just got its Orgo project (workspaces.ts bindMissingProjects): its whole set goes now, with
 * deleteMissing, so what was made and deleted before it had one is there too.
 */
export function routinesBound(wsId: string) {
  try {
    const projectId = getState().workspaces?.find((w) => w.id === wsId)?.orgoProjectId;
    if (!projectId || routesMissing(projectId) || onRunner()) return;
    queue(wsId, (p) => (p.deleteMissing = true));
  } catch (e) {
    console.warn(`[routine-sync] ${(e as Error).message}`);
  }
}

/**
 * Orgo's copy of each workspace's routines put right where it went astray from this Mac's: a Mac still on
 * v0.0.29, left open beside this one, sends its whole list after each run it makes, from its copy in memory
 * and without saying how each runs or whether the Mac runs it (Orgo takes those as a computer's tasks). So
 * Orgo's waker would wake computers for routines no runner runs (using up a Free user's hours), a routine
 * deleted here would be back there, and a paused one on. At the Mac's look (runner-install.ts, every 10
 * minutes), each workspace's list in Orgo is read, and one with a routine this Mac hasn't, without one it
 * has, or saying otherwise whether one is on, how it runs or whether the Mac runs it, is sent the whole set
 * again with deleteMissing. Never on a runner (it sends only its own), and never in the way of anything.
 */
export async function mendRoutineCopies(): Promise<void> {
  if (onRunner()) return;
  try {
    // What the user's other Macs on this version changed first: a routine one just made is this Mac's too, never one to delete.
    await pullState();
    for (const w of getState().workspaces ?? []) {
      // Already on its way: that sends this Mac's set anyway.
      if (!w.orgoProjectId || routesMissing(w.orgoProjectId) || pending.has(w.id) || inFlight.has(w.id)) continue;
      const res = await send("GET", `/api/projects/${encodeURIComponent(w.orgoProjectId)}/routines`);
      const list = (res?.json as { routines?: unknown })?.routines;
      if (!res || res.status !== 200 || !Array.isArray(list)) continue;
      const mine = new Map(
        getState()
          .routines.filter((r) => workspaceOf(bot(r.botId)) === w.id)
          .map(routinePayload)
          .filter((x) => x !== undefined)
          .map((x) => [x.bopsId, x]),
      );
      const theirs = new Map((list as { bopsId?: unknown }[]).filter((x) => typeof x?.bopsId === "string").map((x) => [x.bopsId as string, x as { enabled?: unknown; run?: unknown; onMac?: unknown }]));
      const astray = theirs.size !== mine.size || [...mine].some(([id, m]) => {
        const t = theirs.get(id);
        return !t || t.enabled !== m.enabled || t.run !== m.run || t.onMac !== m.onMac;
      });
      if (astray && !pending.has(w.id)) queue(w.id, (p) => (p.deleteMissing = true), 0);
    }
  } catch (e) {
    console.warn(`[routine-sync] ${(e as Error).message}`);
  }
}

/** Once a run of the app: every workspace with an Orgo project sends a full copy, deleteMissing (routines.ts tick); a runner, its own routines. */
export function syncRoutinesOnStart() {
  if (g.__bopsRoutineSyncStarted) return;
  g.__bopsRoutineSyncStarted = true;
  try {
    for (const w of getState().workspaces ?? []) if (w.orgoProjectId && !routesMissing(w.orgoProjectId)) queue(w.id, (p) => (p.deleteMissing = true));
  } catch (e) {
    console.warn(`[routine-sync] ${(e as Error).message}`);
  }
}

/** How long the Routines page waits on Orgo for a routine's runs before it shows what Bops has. */
const READ_TIMEOUT_MS = 8_000;

/**
 * What routineRuns answers: Orgo's record of the routine's runs, newest first (`ok`); none to read (`none`: its
 * workspace has no Orgo project, so the chat is all there is); or Orgo didn't answer for now (`offline`: no
 * answer, signed out, an Orgo without the routes, or a computer's runner, whose key may only write them).
 */
export type RoutineRunsAnswer = { orgo: "ok"; runs: RecordedRun[] } | { orgo: "none" | "offline"; runs: null };

/**
 * A routine's runs as Orgo recorded them (GET /api/projects/{id}/routines/{orgoId}/runs, the newest `limit`,
 * at most 100), for its reports on the Routines page (lib/routine-reports.ts). Its Orgo id is the one the
 * last PUT answered, else Orgo's list is read for it (and an id Orgo no longer knows is looked up again,
 * once). A routine Orgo hasn't a copy of yet has no runs there. Undefined for a routine Bops hasn't.
 */
export async function routineRuns(routineId: string, limit = RUNS_MAX): Promise<RoutineRunsAnswer | undefined> {
  const r = getState().routines.find((x) => x.id === routineId);
  if (!r) return undefined;
  const at = projectOfBot(r.botId);
  if (!at) return { orgo: "none", runs: null };
  if (onRunner() || routesMissing(at.projectId)) return { orgo: "offline", runs: null };
  const n = Math.max(1, Math.min(RUNS_MAX, Math.floor(limit) || RUNS_MAX));
  const base = `/api/projects/${encodeURIComponent(at.projectId)}/routines`;
  const lookUp = async (): Promise<boolean> => {
    const res = await send("GET", base, undefined, READ_TIMEOUT_MS);
    if (!res || res.status !== 200) return false;
    for (const [bopsId, id] of orgoIds(res.json)) orgoIdOf.set(bopsId, id);
    return true;
  };
  for (let tries = 0; tries < 2; tries++) {
    if (!orgoIdOf.has(routineId) && !(await lookUp())) return { orgo: "offline", runs: null };
    const id = orgoIdOf.get(routineId);
    if (!id) return { orgo: "ok", runs: [] };
    const res = await send("GET", `${base}/${encodeURIComponent(id)}/runs?limit=${n}`, undefined, READ_TIMEOUT_MS);
    // Gone from Orgo since (deleted and sent again under a new id): looked up once more.
    if (res?.status === 404) {
      orgoIdOf.delete(routineId);
      continue;
    }
    const list = (res?.json as { runs?: unknown } | undefined)?.runs;
    if (!res || res.status !== 200 || !Array.isArray(list)) return { orgo: "offline", runs: null };
    const runs = list.map(recordedRun).filter((x) => x !== undefined);
    return { orgo: "ok", runs: runs.sort((a, b) => b.startedAt - a.startedAt) };
  }
  return { orgo: "ok", runs: [] };
}

/** Tests: send what's waiting now, without the wait, and forget what was learned. */
export const routineSyncForTests = {
  flushAll: async () => {
    for (const wsId of [...inFlight.keys()]) await inFlight.get(wsId);
    for (const wsId of [...pending.keys()]) await flush(wsId);
  },
  /** Send a workspace's batch the way its timer does (one flush at a time). */
  start: (wsId: string) => start(wsId),
  pendingCount: () => pending.size,
  reset: () => {
    for (const p of pending.values()) if (p.timer) clearTimeout(p.timer);
    pending.clear();
    missing.clear();
    inFlight.clear();
    held.clear();
    orgoIdOf.clear();
    g.__bopsRoutineSyncStarted = false;
  },
  /** The finished runs still in the outbox (on disk with the user's folder). */
  waitingRuns: () => runsOutbox.waiting(),
};
