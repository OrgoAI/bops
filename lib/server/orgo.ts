import "server-only";
import { readFileSync } from "node:fs";
import { homedir } from "node:os";
import { orgoHeaders } from "./app-version";
import { loadOrgoKey, orgoKeyRejected, orgoOrigin } from "./orgo-auth";
import { onRunner } from "./persist";
import { RTC_SHRUNK_MS } from "@/lib/rtc";
import { recordUsage } from "./usage";
import { getState, stateEpoch, update } from "./store";
import { MAIN_WORKSPACE, WORKSPACE_APPS_SINCE, type Workspace } from "@/lib/types";
import type { DeployState } from "@/lib/hosted-apps";
import type { SharedRole, SharedWorkspace } from "@/lib/shared";
import { folderKey, moveWorkspaceFolder } from "./workspace-skills";
import { isIdentityToken } from "./vm-identity";

/** Thin Orgo REST client (the published SDKs predate screens and clone). */

const base = () => `${orgoOrigin()}/api`;

/**
 * The key Orgo calls run on: the signed-in user's (Sign in with Orgo, kept in the Keychain), else
 * ORGO_API_KEY (self-hosting), else the Orgo CLI's login in ~/.orgo/credentials.json. A computer's runner
 * uses only its computer's own credential: its Orgo identity, else its key read from the files Orgo
 * writes it in (orgo-auth.ts runnerKey): never one from its environment or a CLI login on that computer,
 * which may be anyone's.
 */
export async function apiKey(): Promise<string> {
  const signedIn = await loadOrgoKey();
  if (signedIn) return signedIn;
  if (onRunner()) throw new Error("No ORGO_API_KEY on this computer");
  if (process.env.ORGO_API_KEY) return process.env.ORGO_API_KEY;
  try {
    const creds = JSON.parse(readFileSync(`${homedir()}/.orgo/credentials.json`, "utf8"));
    const key = creds.profiles[creds.current ?? "default"].apiKey;
    if (key) return key;
  } catch {
    /* no CLI login either */
  }
  throw new Error("Not signed in to Orgo");
}

/** Orgo turned a call down: its HTTP status, its code when it sent one (VM_SLOT_ADDON, NOT_FORKABLE…), and its own words. */
export class OrgoError extends Error {
  status: number;
  code?: string;
  said?: string;
  constructor(message: string, status: number, code?: string, said?: string) {
    super(message);
    this.status = status;
    this.code = code;
    this.said = said;
  }
}

/**
 * What Orgo answers while a computer is still there but can't take an action yet (orgo-web
 * lib/computer-asleep.ts and lib/with-auto-resume.ts): it's waking from storage (409 computer_waking),
 * its memory is being saved or coming back (409 suspend_in_progress, 409 resume_in_progress, 503
 * resuming), or this wake didn't work and Orgo tries again (503 wake_failed, no_capacity,
 * saved_state_unavailable). Orgo did nothing with the call, so an action is made again when Orgo says
 * (Retry-After), for up to wakeWaitMs: a wake from storage in another city takes a few minutes. None of
 * them means the computer is gone (only 403 and 404 do: healIfGone in sessions.ts), and nothing deletes
 * a computer for one.
 */
export const WAKE_CODES: ReadonlySet<string> = new Set([
  "computer_waking",
  "suspend_in_progress",
  "resume_in_progress",
  "resuming",
  "wake_failed",
  "no_capacity",
  "saved_state_unavailable",
]);

/** Whether Orgo said the computer is waking, or will be (WAKE_CODES): wait for it, never take it for gone. */
export const computerWakingError = (e: unknown) => e instanceof OrgoError && !!e.code && WAKE_CODES.has(e.code);

/** How long an action waits on a computer that's waking: 6 minutes, or BOPS_WAKE_WAIT_MS. */
export const wakeWaitMs = () => {
  const n = Number(process.env.BOPS_WAKE_WAIT_MS);
  return Number.isFinite(n) && n >= 0 ? n : 6 * 60_000;
};

/** When Orgo says to ask again (its Retry-After, or retry_after in the answer), between 1 second and a minute; 15 seconds when it doesn't say. */
function retryAfterMs(res: Response, json: { retry_after?: unknown }) {
  const said = Number(res.headers.get("retry-after") ?? json.retry_after);
  return Math.min(Math.max(Number.isFinite(said) && said > 0 ? said * 1000 : 15_000, 1000), 60_000);
}

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

/** How long a call to Orgo may take before it counts as lost: a dropped connection otherwise waits out Node's 5 minutes. */
const CALL_MS = 60_000;
/** A screenshot, and the user's click, typing or key on a screen. */
const SHOT_MS = 20_000;
const INPUT_MS = 20_000;
/** Making a computer (create, fork, clone) or growing its disk, which Orgo answers once it's done. */
const MAKE_MS = 180_000;

/** Orgo didn't answer in time (the connection dropped, or it hung): the call may or may not have been done. */
export class OrgoTimeout extends Error {}

/** Orgo's code in an answer (a 401's says why an identity token was turned down), read from a copy so the answer itself is still unread. */
async function codeOf(res: Response): Promise<string | undefined> {
  try {
    const j = (await res.clone().json()) as { code?: unknown } | null;
    return typeof j?.code === "string" ? j.code : undefined;
  } catch {
    return undefined;
  }
}

/**
 * One request to Orgo with the signed-in key, read with `read`, within `timeoutMs` (OrgoTimeout after) or
 * until `signal` (a task stopped), which ends it as the signal says. A network error comes as Node gave it.
 * Says which key went, so a caller can tell a runner's identity token was turned down.
 */
async function answered<R>(url: string, init: RequestInit, timeoutMs: number, signal: AbortSignal | undefined, read: (res: Response) => Promise<R>) {
  if (signal?.aborted) throw signal.reason ?? new Error("Stopped");
  const timer = AbortSignal.timeout(timeoutMs);
  try {
    const key = await apiKey();
    const res = await fetch(url, {
      ...init,
      headers: { ...orgoHeaders(), ...(init.headers as Record<string, string>), Authorization: `Bearer ${key}` },
      cache: "no-store",
      signal: signal ? AbortSignal.any([timer, signal]) : timer,
    });
    // A runner's credential turned down: its computer may have a new key, or a fresh token (orgo-auth.ts).
    if (res.status === 401) orgoKeyRejected(key, await codeOf(res));
    return { res, text: await read(res), key };
  } catch (e) {
    if (signal?.aborted) throw signal.reason ?? new Error("Stopped");
    if (timer.aborted) throw new OrgoTimeout(`Orgo didn't answer within ${Math.round(timeoutMs / 1000)} seconds`);
    throw e;
  }
}

/**
 * One call to Orgo's API, saying which Bops it is (orgoHeaders). `wait`: an action on a computer that's
 * waking (WAKE_CODES) is made again once it can be, for up to wakeWaitMs; on by default for POST and
 * PATCH, off for a read and a delete. A read of a computer that's asleep answers 409 computer_asleep at
 * once, for the caller to wake it with an action (computerAsleepError); a delete is the user's, and
 * answers at once with Orgo's words.
 */
async function call<T>(
  method: string,
  path: string,
  body?: unknown,
  { wait = method === "POST" || method === "PATCH", timeoutMs = CALL_MS, signal }: { wait?: boolean; timeoutMs?: number; signal?: AbortSignal } = {},
): Promise<T> {
  const until = Date.now() + wakeWaitMs();
  let reauthed = false;
  for (let attempt = 0; ; attempt++) {
    let res: Response, text: string, key: string;
    try {
      ({ res, text, key } = await answered(`${base()}${path}`, { method, headers: { "Content-Type": "application/json" }, body: body === undefined ? undefined : JSON.stringify(body) }, timeoutMs, signal, async (r) => r.text()));
    } catch (e) {
      // A read that didn't get through is safe to make again, once; an action may have happened, so it says so instead.
      if (method === "GET" && attempt === 0 && !signal?.aborted) continue;
      throw e;
    }
    // A runner's identity token turned down (its computer woke on another VM, say): once more on the
    // credential it takes next, at once (orgo-auth.ts). A 401 is answered before anything is done.
    if (res.status === 401 && !reauthed && isIdentityToken(key)) {
      reauthed = true;
      continue;
    }
    let json: { error?: string; code?: unknown; retry_after?: unknown } = {};
    try {
      json = text ? JSON.parse(text) : {};
    } catch {
      if (res.ok) throw new Error(`Orgo ${method} ${path} sent back something that isn't JSON`);
    }
    const code = typeof json.code === "string" ? json.code : undefined;
    // Still there, not ready for it yet: the same action again when Orgo says, while there's time.
    if (!res.ok && wait && code && WAKE_CODES.has(code)) {
      const ms = retryAfterMs(res, json);
      if (Date.now() + ms <= until) {
        await sleep(ms);
        continue;
      }
    }
    // Orgo has the odd momentary 5xx; reads are safe to try again.
    else if (res.status >= 500 && method === "GET" && attempt < 2) {
      await sleep(700 * (attempt + 1));
      continue;
    }
    if (!res.ok)
      throw new OrgoError(
        `Orgo ${method} ${path} → ${res.status}: ${json.error ?? text.slice(0, 200)}`,
        res.status,
        code,
        typeof json.error === "string" ? json.error : undefined,
      );
    return json as T;
  }
}

/**
 * One call to Orgo with `key`, the key passed in and only that (never apiKey's fallbacks): its status and
 * JSON (an empty object when it had none), or null when it didn't answer within `timeoutMs`. `headers` go
 * along (an Idempotency-Key, an If-Match), never in place of the key. `raw`: a body sent as it is with its
 * own type (an app's data as the Mac wrote it, a CRM file's CSV) instead of `body` as JSON. `path` starts
 * with /api.
 */
export async function callOrgo<T>(
  key: string,
  path: string,
  {
    method = "GET",
    body,
    raw,
    headers,
    timeoutMs = 15_000,
  }: { method?: "GET" | "POST" | "PUT" | "PATCH" | "DELETE"; body?: unknown; raw?: { data: string | Uint8Array; type: string }; headers?: Record<string, string>; timeoutMs?: number } = {},
): Promise<{ status: number; json: T } | null> {
  try {
    const type: Record<string, string> = raw ? { "Content-Type": raw.type } : body === undefined ? {} : { "Content-Type": "application/json" };
    const res = await fetch(`${orgoOrigin()}${path}`, {
      method,
      headers: { ...orgoHeaders(), ...headers, Authorization: `Bearer ${key}`, ...type },
      ...(raw ? { body: raw.data as BodyInit } : body === undefined ? {} : { body: JSON.stringify(body) }),
      cache: "no-store",
      signal: AbortSignal.timeout(timeoutMs),
    });
    const json = (await res.json().catch(() => ({}))) as T;
    if (res.status === 401) orgoKeyRejected(key, typeof (json as { code?: unknown })?.code === "string" ? (json as { code: string }).code : undefined);
    return { status: res.status, json };
  } catch {
    return null;
  }
}

/** A call waiting its turn on a computer: a task's comes before the app's views. */
type LaneJob = { fn: () => Promise<unknown>; first: boolean; key?: string; done: Promise<unknown>; resolve: (v: unknown) => void; reject: (e: unknown) => void };
const lanes = new Map<string, { busy: boolean; queue: LaneJob[] }>();
/**
 * Run calls for one computer one at a time (Orgo fails overlapping screenshots of one computer). `first`:
 * a task's, which goes ahead of every view's waiting. `key`: a view's call that's the same as one already
 * waiting shares its answer instead of queueing again, so the app's tiles can't pile up in front of a task.
 */
function inLane<T>(computerId: string, fn: () => Promise<T>, { first = false, key }: { first?: boolean; key?: string } = {}): Promise<T> {
  const lane = lanes.get(computerId) ?? { busy: false, queue: [] };
  lanes.set(computerId, lane);
  const same = key && lane.queue.find((j) => j.key === key);
  if (same) return same.done as Promise<T>;
  let resolve!: (v: unknown) => void, reject!: (e: unknown) => void;
  const done = new Promise((res, rej) => ((resolve = res), (reject = rej)));
  const job: LaneJob = { fn, first, key, done, resolve, reject };
  const at = first ? lane.queue.findIndex((j) => !j.first) : -1;
  if (at < 0) lane.queue.push(job);
  else lane.queue.splice(at, 0, job);
  void drain(computerId);
  return done as Promise<T>;
}

async function drain(computerId: string) {
  const lane = lanes.get(computerId);
  if (!lane || lane.busy) return;
  lane.busy = true;
  for (let job = lane.queue.shift(); job; job = lane.queue.shift()) await job.fn().then(job.resolve, job.reject);
  lane.busy = false;
  lanes.delete(computerId);
}

/** A screen as Orgo lists it. `vnc_port`/`ws_port`: null in a list orgo-web answered from its record (a computer asleep). */
export type OrgoScreen = { id: string; display: string; width: number; height: number; default: boolean; vnc_port?: number | null; ws_port?: number | null };

export type OrgoComputer = { id: string; name: string; status: string; cpu: number; ram: number; os: string };

/**
 * Bops computers live in Bops' own Orgo workspaces; nothing outside them is ever created or deleted here.
 *
 * On an orgo-web with per workspace projects (each project says its `product`), each Bops workspace is an
 * Orgo workspace of its own, marked product "bops" and tied to the Bops one by `bops_ws_id`
 * (Workspace.orgoProjectId; lib/server/workspaces.ts binds them). On an Orgo without them (today's), every
 * Bops workspace's computers live in the one the user owns named "bops" (any case, so an older "Bops" is
 * kept), made the first time, exactly as before: nothing else is made, moved or renamed there.
 * BOPS_ORGO_WORKSPACE pins one instead, but only without a signed-in user: a pinned id belongs to the
 * self-hoster's key, not to whoever signs in.
 *
 * The ids are cached per server process; signIn() and signOut() clear the cache (orgo-auth.ts), so
 * the next user never lands in the last one's workspace.
 */
const WORKSPACE = "bops";
/**
 * A workspace as GET /api/workspaces lists it. `product` and `bops_ws_id` only from an orgo-web with per
 * workspace projects; `owner_email` is its owner's (one shared with the user names who shared it).
 */
export type OrgoWorkspace = {
  id: string;
  name: string;
  role?: string;
  product?: string | null;
  bops_ws_id?: string | null;
  owner_email?: string | null;
  created_at?: string;
  updated_at?: string | null;
  desktops?: { id: string; name?: string }[];
  member_count?: number;
};
const g = globalThis as unknown as {
  bopsOrgoWorkspace?: Promise<string>;
  bopsComputerChanges?: number;
  bopsMadeHere?: Set<string>;
  /**
   * Whether this Orgo has per workspace projects, for the key that asked (null: it couldn't tell yet).
   * `marked`: its list carries `product`, which only says the column is there, not that orgo-web's code for
   * it is live; `on` is true only once that code has answered (a project tied by bops_ws_id, or a bind or a
   * create that said it back).
   */
  bopsOrgoPerWorkspace?: { key: string; on: boolean | null; marked?: boolean };
};

/**
 * How many computers Bops has made or deleted since the server started. What's known about the plan's
 * computers in use (lib/server/plan.ts) is read again after a change.
 */
export const computerChanges = () => g.bopsComputerChanges ?? 0;
const changed = () => void (g.bopsComputerChanges = computerChanges() + 1);

/**
 * The computers this server made (a create, a fork or a clone) and hasn't had ready yet, by id. Only
 * such a computer may be deleted by a setup that fails (ensureComputer in sessions.ts, which keeps the
 * mark on the bot as computerNeverReady): one Bops didn't make (the user's free computer taken up again,
 * one from another Mac) or once had working is never deleted for a failed setup, whatever Orgo says.
 */
const madeHere = (g.bopsMadeHere ??= new Set());
/** Whether this server made the computer and hasn't had it ready since (madeReady). */
export const madeByThisServer = (computerId: string) => madeHere.has(computerId);
/** The computer is ready: from now on it may hold the user's work, so it's no longer one Bops just made. */
export const madeReady = (computerId: string) => void madeHere.delete(computerId);
const made = <C extends { id: string }>(c: C) => (madeHere.add(c.id), c);

/** The workspaces the user owns. GET /api/workspaces lists shared ones too (role "member" and up). */
export const ownedWorkspaces = async () => {
  const list = ((await call<{ workspaces?: OrgoWorkspace[] }>("GET", "/workspaces")).workspaces ?? []).filter((w) => (w.role ?? "owner") === "owner");
  notePerWorkspace(list, await apiKey().catch(() => ""));
  return list;
};

/**
 * The Bops workspaces others shared with the user (lib/shared.ts): ones they're an admin or a member of,
 * each its own Bops workspace (bops_ws_id), so being in it shows that workspace alone. An Orgo without
 * per workspace projects has none: its one "bops" project holds every workspace of its owner's.
 */
export async function sharedWorkspaces(): Promise<SharedWorkspace[]> {
  const list = (await call<{ workspaces?: OrgoWorkspace[] }>("GET", "/workspaces")).workspaces ?? [];
  return list
    .filter((w) => (w.role === "admin" || w.role === "member") && w.product === "bops" && typeof w.bops_ws_id === "string" && !!w.bops_ws_id)
    .map((w) => ({ projectId: w.id, name: w.name, owner: typeof w.owner_email === "string" ? w.owner_email : "", role: w.role as SharedRole }));
}

/**
 * What a list says about this Orgo. `product` on a project shows only the column (GET answers every column,
 * so it shows as soon as the migration is applied, before or without the code): per workspace projects are
 * on only when a project is tied by bops_ws_id, or once a bind or a create said its bops_ws_id back here
 * (confirmPerWorkspace). Nothing to go on with no projects.
 */
function notePerWorkspace(list: OrgoWorkspace[], key: string) {
  const marked = list.some((w) => w && typeof w === "object" && "product" in w);
  const tied = list.some((w) => typeof w?.bops_ws_id === "string" && !!w.bops_ws_id);
  const was = g.bopsOrgoPerWorkspace?.key === key ? g.bopsOrgoPerWorkspace : undefined;
  // A list with no projects says nothing: what was learned before stands.
  if (!list.length && was) return;
  const on = marked && (tied || was?.on === true) ? true : marked ? null : list.length ? false : null;
  g.bopsOrgoPerWorkspace = { key, on, marked };
}

/** orgo-web's code for per workspace projects answered (a bind or a create said its bops_ws_id back): it's on for this key. */
async function confirmPerWorkspace() {
  const key = await apiKey().catch(() => "");
  if (key) g.bopsOrgoPerWorkspace = { key, on: true, marked: true };
}

/** Whether Orgo's list carries `product` without anything tied yet: the move on sign-in tries a bind to find out. */
export const perWorkspaceUnconfirmed = () => g.bopsOrgoPerWorkspace?.marked === true && g.bopsOrgoPerWorkspace.on === null;

/**
 * A Bops tie orgo-web said back: true when its answer carries the bops_ws_id asked for (only the code for
 * per workspace projects does); false for a 4xx or an answer without it (an orgo-web with only the column
 * answers 400 Unsupported field, or makes a plain project), so nothing is tied here. Throws when Orgo didn't
 * answer or failed (5xx), to be tried again.
 */
const saidBack = (j: { product?: unknown; bops_ws_id?: unknown } | null | undefined, wsId: string) => j?.product === "bops" && j.bops_ws_id === wsId;
export async function tieProject(projectId: string, wsId: string): Promise<boolean> {
  try {
    const r = await call<{ product?: unknown; bops_ws_id?: unknown }>("PATCH", `/workspaces/${encodeURIComponent(projectId)}`, { bops_ws_id: wsId }, { wait: false });
    if (!saidBack(r, wsId)) return false;
    await confirmPerWorkspace();
    return true;
  } catch (e) {
    if (e instanceof OrgoError && e.status >= 400 && e.status < 500) return false;
    throw e;
  }
}

/**
 * Whether each Bops workspace is an Orgo workspace of its own here: true only once Orgo's list shows it
 * (projects carry `product`). False, or not known yet (null), and Bops works as before: one "bops" project.
 */
export async function perWorkspaceProjects({ fresh = false } = {}): Promise<boolean | null> {
  // Undone on this Mac (revertWorkspaceMigration): the one "bops" project, as before.
  if (getState().orgoMigrationRevertedAt) return false;
  const key = await apiKey().catch(() => "");
  if (!key) return false;
  if (!fresh && g.bopsOrgoPerWorkspace?.key === key) return g.bopsOrgoPerWorkspace.on;
  await ownedWorkspaces();
  return g.bopsOrgoPerWorkspace?.key === key ? g.bopsOrgoPerWorkspace.on : null;
}

/** Whether a workspace is Bops': marked product "bops" where Orgo marks them, else named "bops". */
export const isBops = (w: Pick<OrgoWorkspace, "name" | "product">) => (w.product != null ? w.product === "bops" : w.name.trim().toLowerCase() === WORKSPACE);

/**
 * The default workspace's project among the user's own: the one tied to it (bops_ws_id "ws_main"), else
 * the Bops one named "bops", else the Bops one with the most computers, else the oldest.
 */
export function pickMainProject(owned: OrgoWorkspace[], freeComputerId?: string | null): OrgoWorkspace | undefined {
  // An Orgo without per workspace projects: the first one named "bops", exactly as before.
  if (!owned.some((w) => w && typeof w === "object" && "product" in w)) return owned.find(isBops);
  const tied = owned.find((w) => w.bops_ws_id === MAIN_WORKSPACE);
  if (tied) return tied;
  const bops = owned.filter((w) => isBops(w) && !w.bops_ws_id);
  if (freeComputerId) {
    const holds = bops.find((w) => w.desktops?.some((d) => d.id === freeComputerId));
    if (holds) return holds;
  }
  return [...bops].sort(
    (a, b) =>
      Number(b.name.trim().toLowerCase() === WORKSPACE) - Number(a.name.trim().toLowerCase() === WORKSPACE) ||
      (b.desktops?.length ?? 0) - (a.desktops?.length ?? 0) ||
      (Date.parse(a.created_at ?? "") || 0) - (Date.parse(b.created_at ?? "") || 0),
  )[0];
}

/**
 * The default ("bops") workspace's project: found, or made the first time. On an orgo-web with per
 * workspace projects it's marked and tied to the default workspace as it's made (an older orgo-web
 * ignores the two fields, so the create is the same as before there).
 */
export async function bopsWorkspace(): Promise<string> {
  if (process.env.BOPS_ORGO_WORKSPACE && !(await loadOrgoKey())) return process.env.BOPS_ORGO_WORKSPACE;
  return (g.bopsOrgoWorkspace ??= (async () => {
    // Only one the user owns will do.
    const find = async () => pickMainProject(await ownedWorkspaces())?.id;
    const found = await find();
    if (found) return found;
    try {
      const made = await call<{ id: string; product?: unknown; bops_ws_id?: unknown }>("POST", "/workspaces", { name: WORKSPACE, product: "bops", bops_ws_id: MAIN_WORKSPACE });
      if (saidBack(made, MAIN_WORKSPACE) && !getState().orgoMigrationRevertedAt) await confirmPerWorkspace();
      return made.id;
    } catch (e) {
      // Orgo refuses a second workspace with the same name (any case): someone else just made it.
      const made = await find();
      if (made) return made;
      throw e;
    }
  })().catch((e: Error) => {
    g.bopsOrgoWorkspace = undefined;
    throw e;
  }));
}

const workspaceOfId = (wsId: string): Workspace | undefined => getState().workspaces?.find((w) => w.id === wsId);

/**
 * Remember a workspace's Orgo project (Workspace.orgoProjectId) and the project's name as Orgo has it
 * (Workspace.orgoName, which tells a rename on orgo.ai apart: workspaces.ts syncWorkspaceNames), and move its
 * skills' folder to the project's id (workspace-skills.ts folderKey), merging by slug with one already there.
 */
export function bindProject(wsId: string, projectId: string, orgoName?: string, orgoUpdatedAt?: string | null) {
  const w = workspaceOfId(wsId);
  if (!w) return;
  if (w.orgoProjectId === projectId) {
    if (orgoName !== undefined && w.orgoName === undefined)
      update((s) => {
        const x = s.workspaces?.find((y) => y.id === wsId);
        if (x) {
          x.orgoName = orgoName;
          if (orgoUpdatedAt) x.orgoUpdatedAt = orgoUpdatedAt;
        }
      });
    return;
  }
  const before = folderKey(w);
  update((s) => {
    const x = s.workspaces?.find((y) => y.id === wsId);
    if (x) {
      x.orgoProjectId = projectId;
      if (orgoName !== undefined) x.orgoName = orgoName;
      if (orgoUpdatedAt) x.orgoUpdatedAt = orgoUpdatedAt;
    }
  });
  try {
    moveWorkspaceFolder(before, folderKey({ id: wsId, orgoProjectId: projectId }));
  } catch (e) {
    console.warn(`[workspaces] moving ${wsId}'s skills folder: ${(e as Error).message}`);
  }
}

/** Orgo said that name is taken (it refuses a second workspace with the same name, any case). */
export const nameTaken = (e: unknown) =>
  e instanceof OrgoError && e.status === 400 && (e.code === "WORKSPACE_NAME_TAKEN" || /already exists|name.*taken/i.test(e.said ?? e.message));

/** The names tried for a Bops workspace whose name the user's Orgo already has: "orgo (Bops)", then "orgo (Bops 2)", and so on. */
export const collisionNames = (name: string) => [name, `${name} (Bops)`, ...Array.from({ length: 8 }, (_, i) => `${name} (Bops ${i + 2})`)];

/**
 * A Bops workspace's own Orgo project, made now when it has none: marked product "bops" and tied to it,
 * under its own name. `interactive`: the user is naming it (New workspace), so a name the user's Orgo
 * already has is said back (OrgoError, nameTaken) for them to pick another; otherwise the next free one
 * of collisionNames is used and noted.
 */
export async function ensureProject(wsId: string, opts: { interactive?: boolean; name?: string } = {}): Promise<{ id: string; name: string; updatedAt?: string; renamed?: boolean; created?: boolean }> {
  const w = workspaceOfId(wsId);
  const local = (opts.name ?? w?.name ?? "Workspace").trim().slice(0, 80) || "Workspace";
  const owned = await ownedWorkspaces();
  const tied = owned.find((x) => x.bops_ws_id === wsId) ?? (wsId === MAIN_WORKSPACE ? pickMainProject(owned) : undefined);
  if (tied) {
    // Tied here only once Orgo tied it too (a refusal, a 409 taken by another, or an orgo-web without the code: nothing).
    if (tied.bops_ws_id !== wsId && !(await tieProject(tied.id, wsId))) throw new Error(`Orgo didn't tie ${tied.id.slice(0, 8)} to this workspace`);
    bindProject(wsId, tied.id, tied.name, tied.updated_at);
    return { id: tied.id, name: tied.name, ...(tied.updated_at ? { updatedAt: tied.updated_at } : {}) };
  }
  const name = wsId === MAIN_WORKSPACE && /^main$/i.test(local) ? WORKSPACE : local;
  const tries = opts.interactive ? [name] : collisionNames(name);
  const taken = new Set(owned.map((x) => x.name.trim().toLowerCase()));
  // "bops" is the default's name for the apps before WORKSPACE_APPS_SINCE, even renamed away from it: they
  // take the first project by that name (orgo-web refuses it for any other).
  if (wsId !== MAIN_WORKSPACE) taken.add(WORKSPACE.toLowerCase());
  for (const n of tries) {
    if (!opts.interactive && taken.has(n.toLowerCase())) continue;
    try {
      const made = await call<{ id: string; name?: string; product?: unknown; bops_ws_id?: unknown; created_at?: string | null; updated_at?: string | null }>("POST", "/workspaces", { name: n, product: "bops", bops_ws_id: wsId }, { wait: false });
      if (!saidBack(made, wsId)) {
        // An orgo-web without the code made a plain Orgo project: it goes again, and this workspace stays on the "bops" project.
        if (g.bopsOrgoPerWorkspace) g.bopsOrgoPerWorkspace.on = null;
        await deleteProject(made.id).catch((e: Error) => console.warn(`[workspaces] deleting the plain project ${made.id.slice(0, 8)}: ${e.message}`));
        throw new Error("Orgo didn't make it a Bops workspace");
      }
      await confirmPerWorkspace();
      // orgo-web's create answers created_at, not updated_at: a project just made was last changed then.
      const at = made.updated_at ?? made.created_at ?? undefined;
      bindProject(wsId, made.id, made.name ?? n, at);
      return { id: made.id, name: made.name ?? n, created: true, ...(at ? { updatedAt: at } : {}), ...(n !== name ? { renamed: true } : {}) };
    } catch (e) {
      if (!nameTaken(e) || opts.interactive) throw e;
      // Made meanwhile (another Mac): that's it, if it's tied to this workspace.
      const again = (await ownedWorkspaces()).find((x) => x.bops_ws_id === wsId);
      if (again) {
        bindProject(wsId, again.id, again.name, again.updated_at);
        return { id: again.id, name: again.name, ...(again.updated_at ? { updatedAt: again.updated_at } : {}) };
      }
    }
  }
  throw new Error(`no free name for ${local} in Orgo`);
}

/**
 * Where a workspace's computers go: its own Orgo project when Orgo has per workspace projects (made now
 * if it has none yet), else the one "bops" project, as before.
 */
export async function orgoProjectFor(wsId: string = MAIN_WORKSPACE): Promise<string> {
  if (process.env.BOPS_ORGO_WORKSPACE && !(await loadOrgoKey())) return process.env.BOPS_ORGO_WORKSPACE;
  const bound = workspaceOfId(wsId)?.orgoProjectId;
  if (bound) return bound;
  if (wsId === MAIN_WORKSPACE || (await perWorkspaceProjects()) !== true) {
    const id = await bopsWorkspace();
    if (wsId === MAIN_WORKSPACE && g.bopsOrgoPerWorkspace?.on === true) bindProject(MAIN_WORKSPACE, id);
    return id;
  }
  const made = await ensureProject(wsId);
  // The name was taken on Orgo: said in the switcher, as the move's are.
  if (made.renamed)
    update((s) => {
      const from = s.workspaces?.find((w) => w.id === wsId)?.name;
      if (s.orgoMigration && from) (s.orgoMigration.renamed ??= []).push({ wsId, from, to: made.name });
    });
  return made.id;
}

/** Every Bops project the user owns (on an Orgo without per workspace projects, the one "bops" project). */
export async function bopsProjects(): Promise<string[]> {
  if (process.env.BOPS_ORGO_WORKSPACE && !(await loadOrgoKey())) return [process.env.BOPS_ORGO_WORKSPACE];
  if ((await perWorkspaceProjects()) !== true) return [await bopsWorkspace()];
  const ids = new Set((await ownedWorkspaces()).filter(isBops).map((w) => w.id));
  for (const w of getState().workspaces ?? []) if (w.orgoProjectId) ids.add(w.orgoProjectId);
  return [...ids];
}

/**
 * A workspace the user owns, to read their plan's numbers by (Orgo counts computers against the owner,
 * across every workspace they own): the "bops" one when there is one, else any. Unlike bopsWorkspace it
 * never makes one, so reading the plan makes nothing (the "bops" one is made by bindMissingProjects at
 * sign-in or start, in workspaces.ts, or with the first computer). Null when they own none.
 */
export async function ownedWorkspace(): Promise<string | null> {
  const bops = await g.bopsOrgoWorkspace?.catch(() => undefined);
  if (bops) return bops;
  const owned = await ownedWorkspaces();
  return (pickMainProject(owned) ?? owned[0])?.id ?? null;
}

/**
 * The user's own "bops" workspace as the People sheet finds it: its id (with how many have access, the
 * user included, when Orgo said), none yet, or why Orgo couldn't say ("denied": it turned the key down).
 */
export type BopsWorkspaceFound =
  | { kind: "found"; id: string; memberCount?: number; cached?: true }
  | { kind: "none" }
  | { kind: "denied" }
  | { kind: "unreachable" }
  | { kind: "error"; status: number };

/**
 * The user's own "bops" workspace, found and never made, with `key` (theirs, signed in): the id
 * bopsWorkspace() already has for them (unless `fresh`), else the one they own named "bops" (any case,
 * spaces trimmed). Never one shared with them, never another of theirs (unlike ownedWorkspace), and
 * nothing is made (unlike bopsWorkspace): "none" until Bops made it (workspaces.ts bindMissingProjects at
 * sign-in or start, every account signed in to Bops, or a bot's first computer). The people
 * the user adds are this workspace's members (lib/server/members.ts).
 */
export async function findBopsWorkspace(key: string, { fresh = false, wsId }: { fresh?: boolean; wsId?: string } = {}): Promise<BopsWorkspaceFound> {
  // A workspace with its own Orgo project (per workspace projects): its people are that project's.
  const bound = wsId ? workspaceOfId(wsId)?.orgoProjectId : undefined;
  // Another workspace with no project of its own yet, where each has one: nobody's in it yet, never the default's people.
  if (wsId && wsId !== MAIN_WORKSPACE && !bound && (await perWorkspaceProjects().catch(() => null)) === true) return { kind: "none" };
  const known = fresh || bound ? undefined : await g.bopsOrgoWorkspace?.catch(() => undefined);
  if (bound && !fresh) return { kind: "found", id: bound, cached: true };
  if (known) return { kind: "found", id: known, cached: true };
  const got = await callOrgo<{ workspaces?: unknown }>(key, "/api/workspaces");
  if (!got) return { kind: "unreachable" };
  if (got.status === 401) return { kind: "denied" };
  if (got.status !== 200) return { kind: "error", status: got.status };
  const list = Array.isArray(got.json.workspaces) ? (got.json.workspaces as (Partial<OrgoWorkspace> & { member_count?: unknown })[]) : [];
  const owned = list.filter((w) => typeof w?.id === "string" && typeof w.name === "string" && (w.role ?? "owner") === "owner") as OrgoWorkspace[];
  // A workspace without a project of its own (an Orgo without per workspace projects): the one "bops" project's people, as before.
  const mine = bound ? owned.find((w) => w.id === bound) : pickMainProject(owned);
  if (!mine?.id) return { kind: "none" };
  return { kind: "found", id: mine.id, ...(Number.isSafeInteger(mine.member_count) ? { memberCount: mine.member_count as number } : {}) };
}

/** A member of a workspace as orgo-web lists it: the owner first, then everyone else (guests have no email). */
/** A member as orgo-web lists them (`joined_at`: when their membership began, from an orgo-web that sends it). */
export type OrgoMember = { id?: unknown; alt?: unknown; role?: unknown; email?: unknown; joined_at?: unknown };
/** An invite as orgo-web lists it (the token only for the owner; the times from an orgo-web that sends them). */
export type OrgoInvite = { email?: unknown; role?: unknown; status?: unknown; token?: unknown; created_at?: unknown; expires_at?: unknown; expired?: unknown };

/**
 * Who has access to a workspace, and changes to that (orgo-web's member routes; /api/workspaces/{id}/…
 * is its name for /api/projects/[id]/…), always with the signed-in key passed in: never ORGO_API_KEY or
 * the Orgo CLI's login. Only the owner may invite, change or remove people. Each answers Orgo's status
 * and JSON, or null when Orgo didn't answer. The workspace is findBopsWorkspace's, never one from the app.
 */
export const orgoMembers = {
  /** The members (the owner first) and the invites still waiting; orgo-web with plan rules adds `seats`. */
  list: (key: string, workspace: string) =>
    callOrgo<{ members?: unknown; invites?: unknown; seats?: unknown; seats_error?: unknown; error?: unknown; code?: unknown }>(key, `/api/workspaces/${encodeURIComponent(workspace)}/members`),
  /**
   * Invite someone by email: "viewer" (View only) or "admin" (Full access). Again for the same email,
   * Orgo replaces the invite: a new email, a new link and 7 more days, and the old link stops working.
   */
  invite: (key: string, workspace: string, email: string, permission: "viewer" | "admin") =>
    callOrgo<Record<string, unknown>>(key, `/api/workspaces/${encodeURIComponent(workspace)}/invite`, { method: "POST", body: { email, permission } }),
  /** Cancel an invite still waiting: its link stops working. */
  revoke: (key: string, workspace: string, email: string) =>
    callOrgo<Record<string, unknown>>(key, `/api/workspaces/${encodeURIComponent(workspace)}/invite`, { method: "DELETE", body: { email } }),
  /** Take someone's access away (Orgo stops their open screens within seconds). */
  remove: (key: string, workspace: string, memberId: string) =>
    callOrgo<Record<string, unknown>>(key, `/api/workspaces/${encodeURIComponent(workspace)}/members`, { method: "DELETE", body: { memberId } }),
  /** Change what someone can do. Orgo's words here: "member" (View only) or "admin" (Full access). */
  setRole: (key: string, workspace: string, memberId: string, role: "member" | "admin") =>
    callOrgo<Record<string, unknown>>(key, `/api/workspaces/${encodeURIComponent(workspace)}/members`, { method: "PATCH", body: { memberId, role } }),
};

/**
 * Sam's computer launches from this template (built from orgo/bops-base.mjs; keep the versions in
 * step): Orgo's own copy, which every account can use and which is the only one a free Bops computer
 * is made from (orgo-web lib/curated-templates.ts). BOPS_ORGO_TEMPLATE points at your own build
 * when the default isn't in your Orgo account.
 */
export const BOPS_TEMPLATE = process.env.BOPS_ORGO_TEMPLATE || "system/bops-base@0.1.8";
/**
 * Every Bops computer's disk, in GB (Orgo's plan default is 20). Copies inherit their source's disk,
 * and older computers grow to this the next time Bops gets them ready (see growDisk).
 */
export const BOPS_DISK_GB = Number(process.env.BOPS_DISK_GB) || 120;
/** Every screen on a Bops computer: 4:3, like the template's boot screen (orgo/bops-base.mjs). */
export const BOPS_SCREEN = { width: 1280, height: 960 };

const grown = new Set<string>();

/**
 * Whether Bops streams the boot screen over Orgo's WebRTC (UDP): on unless BOPS_WEBRTC=0. Only at the
 * screen's real size, though: Orgo's WebRTC gateway fits a screen inside its host's limit by shrinking
 * the screen itself (1280x720 unless the host sets ORGO_RTC_WIDTH/HEIGHT, so a 1280x960 Bops screen
 * comes out 960x720), and never sizes it back. The app sees that in the size Orgo says it streams at,
 * stops, and streams over VNC, and Bops puts the screen back (orgo.screenShrunk). Off, Bops doesn't
 * turn WebRTC on for computers and the app streams over VNC (through Orgo).
 */
export const webrtcWanted = () => process.env.BOPS_WEBRTC !== "0";

/**
 * Whether the bots' other screens (100-102) stream live through Orgo's noVNC proxy too, by ?screen=, when
 * the computer isn't on the tailnet: on unless BOPS_SCREEN_STREAM=0. Orgo serves ?screen= from
 * orgo-web's per-screen streams (on orgo.ai since 2026-10-06); an Orgo without them ignores ?screen= and
 * streams the boot screen, so point BOPS_ORGO_ORIGIN at an older Orgo only with BOPS_SCREEN_STREAM=0.
 * Off, those screens show as screenshots, as before.
 */
export const screenStreamWanted = () => process.env.BOPS_SCREEN_STREAM !== "0";

/** Computers Orgo wouldn't turn WebRTC on for, until when: they aren't asked again on every view. */
const rtcRefused = new Map<string, number>();
const RTC_REFUSED_MS = 10 * 60_000;

/** Computers whose boot screen Orgo's WebRTC shrank, until when: they stream over VNC till then. */
const rtcShrank = new Map<string, number>();
export const rtcShrunk = (computerId: string) => (rtcShrank.get(computerId) ?? 0) > Date.now();

export const orgo = {
  /**
   * A new computer in the Bops workspace, from the Bops template, with `ram` GB of memory: the plan's
   * memory per computer (computerRam in lib/orgo-plans.ts), so the plan runs out of computers before
   * memory, as every copy of this one is as big. Its vCPUs are the template's 4, as many as one computer
   * on the user's plan can have (Hacker 1, Startup 2, Scale 4). Without `ram` Orgo gives it the
   * template's 16 GB, as far as the plan allows. A computer the template's size resumes from its golden
   * snapshot; a smaller one boots fresh, which takes longer.
   *
   * `free`: the user's one free Bops computer (bops_free), off their Orgo plan, at the template's size
   * whatever the plan (Orgo sets it; no `ram` is sent). Orgo makes it only when the user has none yet,
   * in their own "bops" workspace, from Orgo's Bops template; otherwise this is an ordinary create.
   */
  create: async (name: string, opts: { ram?: number; free?: boolean; wsId?: string } = {}) => {
    const epoch = stateEpoch();
    // Never made again for a waking code: a new computer isn't a computer waking.
    const c = made(
      await call<{ id: string; name: string; status: string }>(
        "POST",
        "/computers",
        {
          workspace_id: await orgoProjectFor(opts.wsId),
          name,
          template_ref: BOPS_TEMPLATE,
          ...(opts.free ? { bops_free: true } : opts.ram ? { ram: opts.ram } : {}),
        },
        { wait: false, timeoutMs: MAKE_MS },
      ),
    );
    changed();
    recordUsage("computer.create", {}, epoch);
    return c;
  },

  /**
   * Grow a computer's disk to BOPS_DISK_GB (or the plan's most, if that's less). Disks only grow,
   * and on Linux it happens live: no restart, and the filesystem fills the new space by itself.
   */
  growDisk: async (computerId: string) => {
    if (grown.has(computerId)) return;
    const d = await call<{ current_disk_gb: number; max_disk_gb: number }>("GET", `/computers/${computerId}/resize`);
    const want = Math.min(BOPS_DISK_GB, d.max_disk_gb);
    if (d.current_disk_gb < want) await call("PATCH", `/computers/${computerId}/resize`, { disk_size_gb: want }, { timeoutMs: MAKE_MS });
    grown.add(computerId);
  },

  /**
   * What the live desktop view needs (see /api/vnc): the computer's VNC password, which also opens
   * Orgo's stream sockets (?token=), and whether Orgo's WebRTC is on for it (instance_details.webrtc:
   * true, false when someone turned it off on Orgo, null when nobody chose, which means off on
   * production), and whether it's running. Server-side only: hand the password only to the user's own
   * app on this Mac, never to anything remote. It changes when the computer restarts, so it's read
   * fresh each time.
   */
  streamInfo: async (computerId: string) => {
    const c = await call<{ vnc_password: string; status?: string; instance_details?: { webrtc?: unknown } | null }>("GET", `/computers/${computerId}`);
    const webrtc = c.instance_details?.webrtc;
    return { password: c.vnc_password, webrtc: typeof webrtc === "boolean" ? webrtc : null, running: c.status === "running" && !!c.instance_details };
  },

  /**
   * Turn on Orgo's WebRTC (UDP) video for a computer, so its screen streams over UDP rather than VNC.
   * It's one setting on Orgo's side (POST /computers/{id}/webrtc): nothing restarts. Orgo forgets it
   * when a computer stops, so Bops turns it on when it sets a computer up and again whenever the view
   * finds nobody chose (see /api/vnc). Only then: a choice someone made on Orgo (off too) stands. And
   * only while the computer runs: a stopped one has no record on Orgo (instance_details is null), and
   * saving the choice would make one, which Orgo then takes for a running computer. Orgo turns it down
   * where it can't stream (409: fewer than 4 vCPUs, or UDP streaming off on Orgo's side); that
   * computer isn't asked again for 10 minutes. `known`: what streamInfo just said, so it isn't read
   * again. Says whether it's on.
   */
  webrtc: async (computerId: string, known?: { webrtc: boolean | null; running: boolean }) => {
    if (!webrtcWanted() || (rtcRefused.get(computerId) ?? 0) > Date.now()) return false;
    const now = known ?? (await orgo.streamInfo(computerId));
    if (now.webrtc !== null) return now.webrtc;
    if (!now.running) return false;
    try {
      const r = await call<{ webrtc?: boolean | null }>("POST", `/computers/${computerId}/webrtc`, { enabled: true });
      rtcRefused.delete(computerId);
      return r.webrtc === true;
    } catch (e) {
      if (e instanceof OrgoError && e.status < 500) rtcRefused.set(computerId, Date.now() + RTC_REFUSED_MS);
      throw e;
    }
  },

  /**
   * Orgo's WebRTC gateway shrank the computer's boot screen to fit its limit (the app saw it in the
   * stream's size): it streams over VNC for a day (rtcShrunk, RTC_SHRUNK_MS), and the screen goes back to
   * BOPS_SCREEN. Orgo resizes a screen in place (xrandr on the computer), so its windows stay open.
   */
  screenShrunk: async (computerId: string) => {
    rtcShrank.set(computerId, Date.now() + RTC_SHRUNK_MS);
    await call("PATCH", `/computers/${computerId}/screens/${screenId(99)}`, BOPS_SCREEN);
  },

  /** Every computer in Bops' workspaces (and only those): every Bops project's, where each workspace has its own. */
  bopsComputers: async () => {
    const out: { id: string; name: string }[] = [];
    for (const p of await bopsProjects())
      for (const d of (await call<{ desktops?: { id: string; name: string }[] }>("GET", `/workspaces/${p}`)).desktops ?? []) if (!out.some((x) => x.id === d.id)) out.push({ id: d.id, name: d.name });
    return out;
  },

  /**
   * Delete a computer, but only one in the Bops workspace (or the one BOPS_ORGO_WORKSPACE pinned:
   * computers made there before sign-in are Bops' too, when the account that signed in can reach them).
   */
  remove: async (computerId: string) => {
    const epoch = stateEpoch();
    const c = await call<{ project_id?: string; workspace_id?: string }>("GET", `/computers/${computerId}`);
    const where = c.workspace_id ?? c.project_id;
    if ((!where || !(await bopsProjects()).includes(where)) && (!where || where !== process.env.BOPS_ORGO_WORKSPACE))
      throw new Error(`refusing to delete ${computerId}: not a Bops computer`);
    await call("DELETE", `/computers/${computerId}`);
    changed();
    recordUsage("computer.remove", {}, epoch);
  },

  /** Public facts about a computer. Never pass the raw response on: it carries the VNC password. */
  computer: async (computerId: string): Promise<OrgoComputer> => {
    const c = await call<OrgoComputer>("GET", `/computers/${computerId}`);
    return { id: c.id, name: c.name, status: c.status, cpu: c.cpu, ram: c.ram, os: c.os };
  },

  /**
   * Fork a running computer: a copy of its live memory as well as its disk, so open apps,
   * browser tabs and screens carry over. Orgo's fork takes the computer's instance id (its UUID
   * answers 404) and returns the new computer's UUID. Firecracker VMs can't be forked (QEMU ones
   * can), so callers fall back to clone. A fork or clone lands on the source's server, so it needs
   * that much free memory there.
   */
  fork: async (computerId: string, wsId?: string) => {
    const epoch = stateEpoch();
    const c = await call<{ instance_details?: { id?: string } }>("GET", `/computers/${computerId}`);
    if (!c.instance_details?.id) throw new Error("this computer can't be forked (no instance id)");
    const target = await forkTarget(wsId);
    const forked = made(await call<{ id: string; name: string; status: string }>("POST", `/computers/${c.instance_details.id}/fork`, target ? { workspace_id: target } : undefined, { wait: false, timeoutMs: MAKE_MS }));
    changed();
    recordUsage("computer.create", {}, epoch);
    return forked;
  },

  clone: async (computerId: string, name: string, wsId?: string) => {
    const epoch = stateEpoch();
    const target = await forkTarget(wsId);
    const cloned = made(await call<{ id: string; name: string; status: string }>("POST", `/computers/${computerId}/clone`, { name, ...(target ? { workspace_id: target } : {}) }, { wait: false, timeoutMs: MAKE_MS }));
    changed();
    recordUsage("computer.create", {}, epoch);
    return cloned;
  },

  screens: async (computerId: string) =>
    (await call<{ screens: OrgoScreen[] }>("GET", `/computers/${computerId}/screens`)).screens,

  /**
   * Start another screen. Bops computers are 4:3 (see BOPS_SCREEN); we pass the size because Orgo
   * still records a template computer's boot screen as 1280x720 and would size new screens to that.
   */
  createScreen: (computerId: string) => call<OrgoScreen>("POST", `/computers/${computerId}/screens`, BOPS_SCREEN),

  destroyScreen: (computerId: string, screenId: string) => call("DELETE", `/computers/${computerId}/screens/${screenId}`),

  /**
   * A command on the computer, for up to `timeout` seconds; Orgo gets 20 more to answer before it counts
   * as lost (OrgoTimeout: it may or may not have run). `signal`: the task's, so stopping it doesn't wait.
   */
  bash: async (computerId: string, command: string, timeout = 60, { signal }: { signal?: AbortSignal } = {}) =>
    await call<{ output: string; exit_code: number }>("POST", `/computers/${computerId}/bash`, { command, timeout }, { timeoutMs: (timeout + 20) * 1000, signal }),

  /** Input on one screen, for when the user takes over. Queued with screenshots so they don't collide. */
  click: (computerId: string, screen: string, x: number, y: number, double = false) =>
    inLane(computerId, () => call("POST", `/computers/${computerId}/click?screen=${screen}`, { x: Math.round(x), y: Math.round(y), double }, { timeoutMs: INPUT_MS }), { first: true }),
  type: (computerId: string, screen: string, text: string) =>
    inLane(computerId, () => call("POST", `/computers/${computerId}/type?screen=${screen}`, { text }, { timeoutMs: INPUT_MS }), { first: true }),
  key: (computerId: string, screen: string, key: string) =>
    inLane(computerId, () => call("POST", `/computers/${computerId}/key?screen=${screen}`, { key }, { timeoutMs: INPUT_MS }), { first: true }),

  /**
   * Raw screenshot bytes for one screen. Orgo fails overlapping screenshots of one computer, and the app
   * watches several screens at once, so they queue per computer and retry once (also when Orgo didn't
   * answer within SHOT_MS). JPEG for the app's views; PNG at full size for the computer tool
   * (computer-task.ts), whose `task` screenshots go ahead of the views' and stop with the task (`signal`).
   */
  screenshot: (computerId: string, screen: string, scale = 0.75, format: "jpeg" | "png" = "jpeg", { task = false, signal }: { task?: boolean; signal?: AbortSignal } = {}) =>
    inLane(
      computerId,
      async () => {
        for (let attempt = 0; ; attempt++) {
          let res: Response, bytes: ArrayBuffer;
          try {
            ({ res, text: bytes } = await answered(
              `${base()}/computers/${computerId}/screenshot?screen=${screen}&response_format=binary&format=${format}&scale=${scale}`,
              {},
              SHOT_MS,
              signal,
              (r) => (r.ok ? r.arrayBuffer() : Promise.resolve(new ArrayBuffer(0))),
            ));
          } catch (e) {
            if (attempt === 0 && !signal?.aborted) continue;
            throw e;
          }
          if (res.ok) return new Uint8Array(bytes);
          // With its status (and Orgo's code when it sent one), so a computer that's gone is told apart from
          // one that's asleep (see healIfGone in sessions.ts, and computerAsleepError).
          if (attempt === 1 || res.status < 500) {
            const said = await res.json().catch(() => null);
            throw new OrgoError(`screenshot ${res.status}`, res.status, typeof said?.code === "string" ? said.code : undefined, typeof said?.error === "string" ? said.error : undefined);
          }
        }
      },
      task ? { first: true } : { key: `${screen}:${scale}:${format}` },
    ),

  /**
   * Wake a computer that's asleep (suspended), for the user who just took over one of its screens:
   * orgo-web's explicit resume, which says so when it can't (402 bops_free_hours once Free's 10 hours
   * this month are used). A running one is left as it is. One that sleeps in storage answers at once
   * (202, `waking`) and runs a minute or a few later; the caller waits for it as it sees fit, so this
   * never waits on a waking code itself.
   */
  resume: (computerId: string) =>
    call<{ waking?: boolean; pending?: boolean; expected_seconds?: number }>("POST", `/computers/${computerId}/resume`, undefined, { wait: false }),
};

/**
 * Where a fork or a clone for a bot of `wsId` lands: on an orgo-web with per workspace projects, that
 * workspace's project (a bot that shares the free computer forks from another workspace's project);
 * elsewhere nothing is said and it lands beside its source, as before.
 */
async function forkTarget(wsId?: string): Promise<string | undefined> {
  if (!wsId || (await perWorkspaceProjects()) !== true) return undefined;
  return orgoProjectFor(wsId);
}

/** Rename one of the user's Orgo workspaces: Orgo's answer carries the name it kept (and when, from an orgo-web that says). */
export const renameProject = (projectId: string, name: string) =>
  call<{ name?: string; updated_at?: string | null }>("PATCH", `/workspaces/${encodeURIComponent(projectId)}`, { name }, { wait: false });

/**
 * Delete one of the user's Orgo workspaces with everything in it (orgo-web's POST /api/projects/{id}/delete:
 * it has no DELETE). orgo-web refuses before it deletes anything (a computer whose memory is moving, a
 * device it holds), so a refusal leaves the workspace whole. Only after the user confirmed what goes with it
 * (deletePreview), or for a Bops workspace this app just made and that is empty.
 */
export const deleteProject = (projectId: string) => call<{ success?: boolean }>("POST", `/projects/${encodeURIComponent(projectId)}/delete`, undefined, { wait: false });

/** What deleting an Orgo workspace takes with it, as orgo-web lists it (GET /api/workspaces/{id}/delete-preview). */
export type OrgoDeletePreview = {
  computers: { id: string; name: string }[];
  keys: string[];
  skills: string[];
  apps: string[];
  /** The apps its bots made and its CRM files, by name (an orgo-web that keeps them: madeApps [{ title }], crmFiles [{ name }]). */
  madeApps: string[];
  crmFiles: string[];
  /** Its routines and Orbit issues, by title, from an orgo-web that lists them (routines [{ title }], orbitIssues [{ title }]); none from one that doesn't (Bops lists its own). */
  routines: string[];
  issues: string[];
  /** An orgo-web that counted skills and apps (563ed1cf6) instead of naming them: how many it has, names unknown. */
  skillCount?: number;
  appCount?: number;
};

/**
 * What orgo-web says goes with a workspace when it's deleted: its computers, its keys (vault secrets scoped
 * to it), its skills and its apps. Each list may come as names, or as rows with a name (an id for a
 * computer); orgo-web sends skills and apps as [{ name, slug }]. One that sends a count for them instead
 * (the first build) says so in skillCount and appCount, so the confirm never reads it as none. Throws when
 * Orgo doesn't answer it: nothing is deleted without the user seeing this first.
 */
export async function deletePreview(projectId: string): Promise<OrgoDeletePreview> {
  const j = await call<Record<string, unknown>>("GET", `/workspaces/${encodeURIComponent(projectId)}/delete-preview`);
  const rows = (x: unknown) => (Array.isArray(x) ? x : []).map((r) => (typeof r === "string" ? { name: r } : r && typeof r === "object" ? (r as Record<string, unknown>) : {}));
  const names = (x: unknown) => rows(x).map((r) => String(r.name ?? r.slug ?? r.title ?? "")).filter(Boolean);
  const count = (x: unknown) => (typeof x === "number" && Number.isFinite(x) && x > 0 ? Math.floor(x) : undefined);
  return {
    computers: rows(j.computers ?? j.desktops)
      .map((r) => ({ id: String(r.id ?? r.name ?? ""), name: String(r.name ?? r.id ?? "") }))
      .filter((c) => c.id),
    keys: names(j.keys ?? j.secrets),
    skills: names(j.skills),
    apps: names(j.apps),
    madeApps: names(j.madeApps),
    crmFiles: names(j.crmFiles),
    routines: names(j.routines),
    issues: names(j.orbitIssues ?? j.issues),
    ...(count(j.skills) !== undefined && { skillCount: count(j.skills) }),
    ...(count(j.apps) !== undefined && { appCount: count(j.apps) }),
  };
}

/** The first Bops release that finds its default workspace by bops_ws_id, not by the name "bops" (lib/types.ts). */
export { WORKSPACE_APPS_SINCE };

const olderVersion = (a: string, b: string) => {
  const x = a.split(".").map(Number);
  const y = b.split(".").map(Number);
  for (let i = 0; i < 3; i++) if (x[i] !== y[i]) return x[i] < y[i];
  return false;
};

/**
 * Whether every Bops app on this account is new enough for the default's project to take the user's
 * name (DECISIONS.md: only once every Bops app on the account is the new version).
 *
 * How it can be known: orgo-web keeps, per API key (each sign-in on a Mac gets its own key, so per Mac),
 * the version each Bops app last sent while it used a Bops computer (public.bops_app_seen, the same record
 * that decides whether a Bops computer may leave its host). Bops asks for it at GET /api/bops/apps:
 * `{ apps: [{ app_version, caller, seen_at }] }`, keys seen in the last 90 days. Bops Cloud's
 * bops.cloud_accounts.app_version is not used: it is one value per account, the last app that called
 * wins, so an old Mac and a new one take turns and a new version there says nothing about the other Mac.
 *
 * Fails closed: an orgo-web that doesn't answer the route (`no_signal`, today's), no app on record
 * (`no_record`), one that sent no version (`silent_app`), one older than WORKSPACE_APPS_SINCE (`old_app`),
 * or Orgo not answering (`unreachable`) all keep the name "bops". Old apps are covered meanwhile by
 * orgo-web's legacy resolver ({name:'bops'} answers the ws_main project) and the marker.
 */
export type AppsGateReason = "all_new" | "no_signal" | "no_record" | "silent_app" | "old_app" | "unreachable";
export async function bopsAppsGate(): Promise<{ ok: boolean; reason: AppsGateReason; apps: number }> {
  const key = await apiKey().catch(() => "");
  if (!key) return { ok: false, reason: "unreachable", apps: 0 };
  const r = await callOrgo<{ apps?: unknown }>(key, "/api/bops/apps");
  if (!r || r.status >= 500) return { ok: false, reason: "unreachable", apps: 0 };
  if (r.status !== 200 || !Array.isArray(r.json.apps)) return { ok: false, reason: "no_signal", apps: 0 };
  // Bops Cloud calls for the user too; it isn't an app on a Mac.
  const apps = (r.json.apps as { app_version?: unknown; caller?: unknown }[]).filter((a) => a && typeof a === "object" && a.caller !== "cloud");
  if (!apps.length) return { ok: false, reason: "no_record", apps: 0 };
  for (const a of apps) {
    const v = typeof a.app_version === "string" ? a.app_version.trim().replace(/^v/i, "") : "";
    if (!/^\d+\.\d+\.\d+$/.test(v)) return { ok: false, reason: "silent_app", apps: apps.length };
    if (olderVersion(v, WORKSPACE_APPS_SINCE)) return { ok: false, reason: "old_app", apps: apps.length };
  }
  return { ok: true, reason: "all_new", apps: apps.length };
}
/** The computers in one Orgo workspace. */
export const projectComputers = async (projectId: string) => (await call<{ desktops?: { id: string; name: string }[] }>("GET", `/workspaces/${encodeURIComponent(projectId)}`)).desktops ?? [];

/**
 * Orgo didn't wake a computer that's asleep for a read of it (409 computer_asleep: orgo-web leaves
 * Free's computer asleep after 15 minutes nobody used it, and answers a screenshot with this). The
 * computer is still there: asleep, never gone.
 */
export const computerAsleepError = (e: unknown) => e instanceof OrgoError && e.status === 409 && e.code === "computer_asleep";

/** A device paired to route computers' browsing through it (Orgo's personal-device egress). */
export type OrgoEgressDevice = { id: string; name: string; online: boolean | null; computers?: unknown };

/**
 * Personal-device egress: a Mac paired with Orgo carries a computer's browsing out through its own
 * internet. Orgo answers 403 where it isn't available yet (see OrgoUnavailable).
 */
export const egress = {
  /** This user's paired devices, whether each is connected right now (null: Orgo couldn't tell), and where agents dial. */
  devices: () => call<{ devices?: OrgoEgressDevice[]; rendezvous?: string | null }>("GET", "/egress-devices"),
  /** Pair a new device. The pairing code comes back only here: keep it server side. */
  pair: (name: string) => call<{ id: string; name: string; pairing_code: string; rendezvous?: string | null }>("POST", "/egress-devices", { name }),
  /** Which way a computer's browsing goes out now. */
  upstream: (computerId: string) =>
    call<{ mode: "residential" | "device" | "custom"; device_id?: string | null; proxy_on: boolean }>("GET", `/computers/${computerId}/egress/upstream`),
  /**
   * Route a computer's browsing. Orgo applies it right away: when the proxy was off, turning a route
   * on restarts the computer's Chrome; when it was on, only the route underneath changes.
   */
  setUpstream: (computerId: string, mode: "residential" | "device", deviceId?: string) =>
    call<{ proxy_on?: boolean }>("POST", `/computers/${computerId}/egress/upstream`, { mode, ...(deviceId ? { device_id: deviceId } : {}) }),
  /** Turn a computer's proxy off: browsing goes out directly again (this restarts its Chrome too). */
  proxyOff: (computerId: string) => call("POST", `/computers/${computerId}/residential-proxy`, { enabled: false }),
};

/** Orgo said a feature isn't available for this account (403). */
export const orgoUnavailable = (e: unknown) => / → 403:/.test((e as Error)?.message ?? "");

/**
 * One deploy as orgo-web's deploy runner has it (DeploymentView). An app's names the Ingot changeset it
 * builds (`at`; `source_version` or `commit_sha` where orgo-web says it so).
 */
export type OrgoDeployment = {
  id: string;
  project_id: string;
  state: DeployState;
  phase?: string | null;
  error?: string | null;
  at?: string | null;
  source_version?: string | null;
  commit_sha?: string | null;
  created_at: string;
  finished_at?: string | null;
};

/** A deploy project on one computer (ProjectView): an app's has Ingot as its source (its repo there), and its public URL once it was live. */
export type OrgoDeployProject = {
  id: string;
  name: string;
  source?: string;
  /** Its GitHub repository (owner/name): null for an app's. */
  repo?: string | null;
  /** The Ingot repo it builds (source "ingot"), as "<project>/<name>". */
  ingot_repo?: string | null;
  /** The changeset every deploy that names none builds, when one is kept (Bops keeps none: those build the newest on main). */
  ingot_at?: string | null;
  url: string | null;
  /** The port its app listens on there (each project on a computer has its own). */
  port?: number;
  current?: OrgoDeployment | null;
  deployments?: OrgoDeployment[];
};

/** A deploy's build log after `after` (GET …/deployments/{id}/logs): `next` reads on from there, `more` when there's more already. */
export type OrgoDeployLog = { state: DeployState; phase?: string | null; error?: string | null; log: string; next: number; more: boolean };

/** The Ingot changeset a deploy builds, however orgo-web names it (null: it doesn't say). */
export const deployedAt = (d: Pick<OrgoDeployment, "at" | "source_version" | "commit_sha"> | null | undefined) => d?.at ?? d?.source_version ?? d?.commit_sha ?? null;

/**
 * What a deploy route answers: its answer, or `enabled` false with why, when orgo-web says hosting isn't
 * open to this account (404 DEPLOYS_DISABLED or SERVICES_DISABLED: HOSTING_ACCESS keeps it to admins, or
 * deploys are off there). Anything else Orgo turns down throws its OrgoError.
 */
export type Hosting<T> = { enabled: true; value: T } | { enabled: false; why: string };

export const HOSTING_CLOSED = "Hosting apps on the web isn't open to your Orgo account yet.";

async function hostingCall<T>(method: "GET" | "POST", path: string, body?: unknown): Promise<Hosting<T>> {
  try {
    return { enabled: true, value: await call<T>(method, path, body, { wait: false }) };
  } catch (e) {
    if (e instanceof OrgoError && e.status === 404 && (e.code === "DEPLOYS_DISABLED" || e.code === "SERVICES_DISABLED")) return { enabled: false, why: HOSTING_CLOSED };
    throw e;
  }
}

/**
 * orgo-web's deploy runner (lib/deploys), with the user's key: apps a workspace runs on the web. A project
 * is one app on one computer, built from one changeset of its Ingot repo on that computer (source "ingot":
 * the runner there exports it with `ingot export`), and reached at its public URL (<name>.orgo.dev) once
 * its first deploy is live. Nothing here calls the computer: Orgo queues a deploy and builds it once the
 * computer runs.
 */
export const deploys = {
  /** The computer's deploy projects, each with its newest deploys. */
  projects: (computerId: string) => hostingCall<{ projects?: OrgoDeployProject[] }>("GET", `/computers/${encodeURIComponent(computerId)}/deploy-projects`),
  /** One project, with its newest deploys. */
  project: (computerId: string, projectId: string) => hostingCall<OrgoDeployProject>("GET", `/computers/${encodeURIComponent(computerId)}/deploy-projects/${encodeURIComponent(projectId)}`),
  /**
   * A new project for an app (its Ingot repo, "<project>/<name>", on that computer), named for its public URL, its app listening
   * on `port` (one no other project or app on that computer has). It names no changeset: one named here
   * would be kept (ingot_at) and built by every deploy that names none after it. Nothing is deployed yet:
   * deploy queues that.
   */
  create: (computerId: string, app: { repo: string; name: string; port: number }) =>
    hostingCall<OrgoDeployProject>("POST", `/computers/${encodeURIComponent(computerId)}/deploy-projects`, { source: "ingot", repo: app.repo, name: app.name, port: app.port, deploy: false }),
  /** Queue a deploy of one changeset (none: the newest on main). A newer deploy replaces one still queued. */
  deploy: (computerId: string, projectId: string, at?: string) =>
    hostingCall<OrgoDeployment>("POST", `/computers/${encodeURIComponent(computerId)}/deploy-projects/${encodeURIComponent(projectId)}/deployments`, at ? { at } : {}),
  /** A deploy's build log after the line `after` (0: from the start). */
  logs: (computerId: string, deploymentId: string, after = 0) =>
    hostingCall<OrgoDeployLog>("GET", `/computers/${encodeURIComponent(computerId)}/deployments/${encodeURIComponent(deploymentId)}/logs?after=${Math.max(0, Math.floor(after))}`),
};

/** Screen id for an X display number: 99 is the boot screen, 100-102 are created screens. */
export const screenId = (display: number) => (display === 99 ? "default" : `screen-${display}`);
