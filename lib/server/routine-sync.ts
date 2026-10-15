import "server-only";
import { normalizeSchedule } from "@/cloud/schedule";
import { templateById } from "@/lib/routine-catalog";
import { workspaceOf, type Routine, type RoutineRun } from "@/lib/types";
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
 * routine runs the same whether Orgo answered or not. An Orgo without the routes (404 or 405) is asked
 * again at most once every 6 hours. On the first tick after start (routines.ts), each workspace sends a
 * full copy with deleteMissing, so a routine deleted while Orgo couldn't be reached goes there too.
 * Runs on the signed-in Orgo key (orgo.ts apiKey); signed out, nothing is sent.
 */

/** How long changes gather before they're sent. */
export const SYNC_DEBOUNCE_MS = 2_000;
/** How long an Orgo without the routes is left alone before it's asked again. */
export const MISSING_RETRY_MS = 6 * 60 * 60_000;
/** The most routines one call sends (orgo-web's cap). */
const MAX_ROUTINES = 500;
const TIMEOUT_MS = 15_000;

type Pending = { timer?: ReturnType<typeof setTimeout>; deleteMissing: boolean; runs: { bopsId: string; run: RoutineRun; finishedAt: number }[] };

const g = globalThis as unknown as {
  __bopsRoutineSync?: Map<string, Pending>;
  __bopsRoutineSyncMissing?: Map<string, number>;
  __bopsRoutineSyncStarted?: boolean;
};
/** What's waiting to go, by workspace. */
const pending = (g.__bopsRoutineSync ??= new Map());
/** Orgo projects whose Orgo answered 404 or 405, and when it may be asked again. */
const missing = (g.__bopsRoutineSyncMissing ??= new Map());

/** The workspace a routine's bot is in, and its Orgo project; undefined without one. */
function projectOfBot(botId: string): { wsId: string; projectId: string } | undefined {
  const wsId = workspaceOf(bot(botId));
  const projectId = getState().workspaces?.find((w) => w.id === wsId)?.orgoProjectId;
  return projectId ? { wsId, projectId } : undefined;
}

const iso = (ms: number | undefined) => (ms !== undefined && Number.isFinite(ms) ? new Date(ms).toISOString() : undefined);

/**
 * A routine as orgo-web takes it (app/api/projects/[id]/routines), or undefined for one whose schedule
 * isn't one (orgo-web would refuse the whole list for it). The schedule goes as Bops keeps it now
 * (normalizeSchedule), so one kept before today's rules (an "every" over a day) still goes.
 */
export function routinePayload(r: Routine) {
  const s = normalizeSchedule(r.schedule);
  if ("error" in s) return undefined;
  const kind = r.source ? templateById(r.source.template)?.kind : undefined;
  return {
    bopsId: r.id,
    botId: r.botId,
    kind: kind === "monitor" ? "monitor" : "schedule",
    title: (r.title.trim() || r.goal.trim() || "Routine").slice(0, 200),
    goal: r.goal.slice(0, 8000),
    enabled: r.enabled,
    quiet: !!r.quiet,
    schedule: s.schedule,
    ...(r.timeZone ? { timeZone: r.timeZone } : {}),
    ...(r.source ? { source: { app: r.source.app, template: r.source.template } } : {}),
    ...(r.tags?.length ? { tags: r.tags } : {}),
    ...(r.deliverTo ? { delivery: r.deliverTo } : {}),
    ...(iso(r.nextRunAt) ? { nextRunAt: iso(r.nextRunAt) } : {}),
    ...(iso(r.lastRunAt) ? { lastRunAt: iso(r.lastRunAt) } : {}),
    ...(r.last ? { lastStatus: r.last.status } : {}),
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
    ...(run.error ? { error: run.error.slice(0, 2000) } : {}),
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

/** Send what's waiting for a workspace: its routines, then its finished runs. */
async function flush(wsId: string): Promise<void> {
  const p = pending.get(wsId);
  if (!p) return;
  pending.delete(wsId);
  const projectId = getState().workspaces?.find((w) => w.id === wsId)?.orgoProjectId;
  if (!projectId || routesMissing(projectId)) return;
  const base = `/api/projects/${encodeURIComponent(projectId)}/routines`;
  const routines = getState()
    .routines.filter((r) => workspaceOf(bot(r.botId)) === wsId)
    .slice(0, MAX_ROUTINES)
    .map(routinePayload)
    .filter((x) => x !== undefined);
  const res = await send("PUT", base, { routines, ...(p.deleteMissing ? { deleteMissing: true } : {}) });
  const status = res?.status ?? null;
  if (status === 404 || status === 405) {
    missing.set(projectId, Date.now() + MISSING_RETRY_MS);
    return;
  }
  if (status === null || status >= 300) {
    if (status !== null) console.warn(`[routine-sync] ${wsId}: Orgo answered ${status} to the routines`);
    return;
  }
  missing.delete(projectId);
  const ids = orgoIds(res?.json);
  for (const x of p.runs) {
    const orgoId = ids.get(x.bopsId);
    // Not in Orgo's copy (deleted meanwhile, or its schedule couldn't go): nothing to record it on.
    if (!orgoId) continue;
    const s = await send("POST", `${base}/${encodeURIComponent(orgoId)}/runs`, runPayload(x.run, x.finishedAt));
    if (s && s.status >= 300 && s.status !== 404) console.warn(`[routine-sync] ${wsId}: Orgo answered ${s.status} to a run`);
  }
}

/** Gather a change for a workspace and send it all SYNC_DEBOUNCE_MS after the last one. */
function queue(wsId: string, add: (p: Pending) => void) {
  const p = pending.get(wsId) ?? { deleteMissing: false, runs: [] };
  add(p);
  if (p.timer) clearTimeout(p.timer);
  p.timer = setTimeout(() => void flush(wsId).catch((e: Error) => console.warn(`[routine-sync] ${wsId}: ${e.message}`)), SYNC_DEBOUNCE_MS);
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

/** A routine's run was recorded (routines.ts record): once it's finished, it goes to Orgo with the routine. */
export function routineRan(routineId: string, run: RoutineRun) {
  try {
    if (run.status === "running") return;
    const r = getState().routines.find((x) => x.id === routineId);
    const at = r && projectOfBot(r.botId);
    if (!at || routesMissing(at.projectId)) return;
    queue(at.wsId, (p) => p.runs.push({ bopsId: routineId, run: { ...run }, finishedAt: Date.now() }));
  } catch (e) {
    console.warn(`[routine-sync] ${(e as Error).message}`);
  }
}

/** Once a run of the app: every workspace with an Orgo project sends a full copy, deleteMissing (routines.ts tick). */
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
    for (const [wsId, p] of [...pending]) {
      if (p.timer) clearTimeout(p.timer);
      await flush(wsId);
    }
  },
  pendingCount: () => pending.size,
  reset: () => {
    for (const p of pending.values()) if (p.timer) clearTimeout(p.timer);
    pending.clear();
    missing.clear();
    g.__bopsRoutineSyncStarted = false;
  },
};
