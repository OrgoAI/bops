import "server-only";
import { normalizeSchedule } from "@/cloud/schedule";
import { templateById } from "@/lib/routine-catalog";
import { workspaceOf, type Routine, type RoutineRun } from "@/lib/types";
import { onRunner, pinnedToMac, runnerRoutine } from "./runner";
import { bot, getState } from "./store";

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
 * Runs on the signed-in Orgo key (orgo.ts apiKey); signed out, nothing is sent.
 *
 * Orgo wakes a computer for its runner by these (runner.ts): each routine says how it runs (`run`) and
 * whether it needs the Mac (`onMac`, runner.ts pinnedToMac), and every new next time is sent
 * (routines.ts). A computer's runner sends only its own routines (runnerRoutine), never with
 * deleteMissing: the whole set, and what's gone from it, are the Mac's to send.
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

type Pending = { timer?: ReturnType<typeof setTimeout>; deleteMissing: boolean; runs: { bopsId: string; run: RoutineRun; finishedAt: number }[]; tries?: number };

const g = globalThis as unknown as {
  __bopsRoutineSync?: Map<string, Pending>;
  __bopsRoutineSyncMissing?: Map<string, number>;
  __bopsRoutineSyncStarted?: boolean;
  __bopsRoutineSyncInFlight?: Map<string, Promise<void>>;
  __bopsRoutineSyncHeld?: Map<string, Pick<Pending, "deleteMissing" | "runs">>;
};
/** What's waiting to go, by workspace. */
const pending = (g.__bopsRoutineSync ??= new Map());
/** Orgo projects whose Orgo answered 404 or 405, and when it may be asked again. */
const missing = (g.__bopsRoutineSyncMissing ??= new Map());
/** The flush going for a workspace: one at a time, so each PUT carries state at least as new as the one before. */
const inFlight = (g.__bopsRoutineSyncInFlight ??= new Map());
/** A batch Orgo refused (a 400, too big): not sent again as it is, but its deleteMissing and runs go with the next change. */
const held = (g.__bopsRoutineSyncHeld ??= new Map());

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

/**
 * A routine as orgo-web takes it (app/api/projects/[id]/routines), or undefined for one whose schedule
 * isn't one (orgo-web would refuse the whole list for it). The schedule goes as Bops keeps it now
 * (normalizeSchedule), so one kept before today's rules (an "every" over a day) still goes.
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
    // How it runs (routines.ts run): someone else's is never a chat run. Orgo wakes no computer for one that needs the Mac.
    run: r.reminder ? "reminder" : r.run === "chat" && !r.fromOutside ? "chat" : "task",
    onMac: pinnedToMac(r, bot(r.botId)),
    title: cleanText(r.title.trim(), 200).trim() || cleanText(r.goal.trim(), 200).trim() || "Routine",
    goal: cleanText(r.goal, 8000),
    enabled: r.enabled,
    quiet: !!r.quiet,
    schedule: s.schedule,
    ...(r.timeZone ? { timeZone: r.timeZone } : {}),
    ...(r.source ? { source: { app: cleanText(r.source.app, 128), template: cleanText(r.source.template, 128) } } : {}),
    ...(tags?.length ? { tags } : {}),
    ...(d ? { delivery: d.kind === "channel" ? { kind: d.kind, linkId: cleanText(d.linkId, 200), ...(d.chat ? { chat: cleanText(d.chat, 200) } : {}) } : d } : {}),
    ...(iso(r.nextRunAt) ? { nextRunAt: iso(r.nextRunAt) } : {}),
    ...(lastRunAt ? { lastRunAt } : {}),
    ...(r.last ? { lastStatus: orgoStatus(r.last.status) } : {}),
    ...(s.schedule.kind === "before_event" && iso(r.eventsThrough) ? { eventsThrough: iso(r.eventsThrough) } : {}),
  };
}

/** A finished run as orgo-web takes it: quiet is a run that went fine with nothing to say. */
export function runPayload(run: RoutineRun, finishedAt: number) {
  const status = run.status === "failed" ? "failed" : run.status === "skipped" ? "skipped" : "ok";
  return {
    startedAt: new Date(run.at).toISOString(),
    finishedAt: new Date(Math.max(finishedAt, run.at)).toISOString(),
    status,
    ms: Math.max(0, Math.round(finishedAt - run.at)),
    ...(run.status === "quiet" ? { summary: "Nothing needed the user." } : {}),
    ...(run.error && cleanText(run.error, 2000) ? { error: cleanText(run.error, 2000) } : {}),
  };
}

/** One call to orgo-web with the signed-in key: its status and JSON, or null when it didn't answer or no one is signed in. */
async function send(method: "PUT" | "POST", path: string, body: unknown): Promise<{ status: number; json: unknown } | null> {
  const { apiKey, callOrgo } = await import("./orgo");
  const key = await apiKey().catch(() => "");
  if (!key) return null;
  return callOrgo(key, path, { method, body, timeoutMs: TIMEOUT_MS });
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

/** Send what's waiting for a workspace: its routines, then its finished runs. */
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
  // More than Orgo takes in one call: the first MAX_ROUTINES go, and nothing is deleted (the rest aren't missing).
  const over = all.length > MAX_ROUTINES;
  if (over) console.warn(`[routine-sync] ${wsId}: ${all.length} routines, Orgo takes ${MAX_ROUTINES}; the rest aren't mirrored`);
  const routines = all.slice(0, MAX_ROUTINES);
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
  missing.delete(projectId);
  const ids = orgoIds(res?.json);
  const again: Pending["runs"] = [];
  for (const x of p.runs) {
    const orgoId = ids.get(x.bopsId);
    // Not in Orgo's copy (deleted meanwhile, or its schedule couldn't go): nothing to record it on.
    if (!orgoId) continue;
    const s = await send("POST", `${base}/${encodeURIComponent(orgoId)}/runs`, runPayload(x.run, x.finishedAt));
    if (retryable(s?.status ?? null)) again.push(x);
    if (s && s.status >= 300 && s.status !== 404) console.warn(`[routine-sync] ${wsId}: Orgo answered ${s.status} to a run`);
  }
  if (again.length) requeue(wsId, p, again, false);
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

/** A routine's run was recorded (routines.ts record): once it's finished, it goes to Orgo with the routine. */
export function routineRan(routineId: string, run: RoutineRun) {
  try {
    if (run.status === "running") return;
    const r = getState().routines.find((x) => x.id === routineId);
    const at = r && projectOfBot(r.botId);
    if (!at || routesMissing(at.projectId)) return;
    queue(at.wsId, (p) => {
      p.runs.push({ bopsId: routineId, run: { ...run }, finishedAt: Date.now() });
      if (p.runs.length > MAX_RUNS_WAITING) p.runs.splice(0, p.runs.length - MAX_RUNS_WAITING);
    });
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
    g.__bopsRoutineSyncStarted = false;
  },
};
