import "server-only";
import { createHash, randomBytes } from "node:crypto";
import { existsSync, mkdirSync, readFileSync, renameSync, rmSync, statSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { appsOpen } from "@/lib/apps-access";
import { botChatId, workspaceOf, type AppState, type MadeApp } from "@/lib/types";
import { onExit, onRunner } from "./persist";
import { getState, installId, stateDevice, stateEpoch, stateReady, stateTooNew, update, updateUnseen, userDir, watchChanges } from "./store";
import { outbox } from "./sync-outbox";

/**
 * The apps the bots make (made-apps.ts), recorded in Orgo: orgo-web's bops_made_apps and
 * bops_made_app_versions, each version's code and the app's data in the user-apps bucket
 * (/api/projects/{project}/bops/apps). Orgo is the record, so every Mac signed in to the same Bops lists
 * and opens them, and a lost Mac loses none; this Mac keeps a copy for speed and for when Orgo is away.
 *
 * - The copy: each version's code and the app's data are files (<userDir>/made-apps/<app>/v<n>.tsx and
 *   data.json), and the list is <userDir>/made-apps/apps.json, read into the state at start (never in Bops
 *   Cloud's shared state: state-merge.ts NEVER_SYNCED). An app another Mac made is listed from Orgo and its
 *   code is fetched the first time it's opened here (codeHere), its data the first time it reads it
 *   (dataHere), then kept.
 * - What changes here goes to Orgo through an outbox kept with the user's folder (sync-outbox.ts), so a
 *   quit or a crash while Orgo is away loses none: the app's record (PUT …/apps/{id}) when it's made or
 *   changed, a new version's code (PUT …/versions/{n}) after it, its data (PUT …/data, If-Match the last
 *   one agreed, the later change winning a conflict), a delete (DELETE …/apps/{id}). Orgo not answering,
 *   or answering for now (401, 403, 408, 429, 5xx, its storage full), keeps it, and it's tried again after
 *   a backoff (1 minute, doubling to 30), each app's in order.
 * - At start, after sign-in and once a workspace gets its Orgo project, each workspace's list is read from
 *   Orgo (?since= the last read: a delete made elsewhere goes here too, a change made elsewhere comes
 *   here) and this Mac's own apps go as a full copy (PUT …/apps), so an app from before Orgo kept them, or
 *   one made while the workspace had no project, reaches it. Never with deleteMissing: a Mac whose copy
 *   was lost (a fresh install keeps its device id) would delete its own apps in Orgo; a delete goes as its
 *   own DELETE, kept on disk until Orgo took it. An app deleted in Orgo stays deleted (409 app_deleted to
 *   a late change): it goes here too.
 * - Only the Mac: a computer's runner never makes apps, and never sends or reads them.
 * - Only for an account apps are open to (lib/apps-access.ts): for anyone else nothing is read from Orgo
 *   or sent there (synced(), at each way in).
 */

export type RemoteApp = {
  id: string;
  bopsId: string;
  botId: string;
  title: string;
  currentVersion: number;
  deviceId: string | null;
  createdAt: string;
  updatedAt: string;
  deletedAt: string | null;
  versions: { n: number; note: string; sha256: string | null; bytes: number | null; createdAt: string }[];
  data: { sha256: string; bytes: number; updatedAt: string } | null;
};

type Op = { op: "app" | "version" | "data" | "delete"; pid: string; appId: string; n?: number; at?: number };
type Result = "done" | "later";
type Answer<T> = { status: number; json: T } | null;

const APP_ID = /^app_[a-z0-9]+$/i;
const DEBOUNCE_MS = 1500;
const DATA_DEBOUNCE_MS = 3000;
const RETRY_MS = 60_000;
const RETRY_MAX_MS = 30 * 60_000;
const MISSING_RETRY_MS = 6 * 60 * 60_000;
const PULL_EVERY_MS = 10 * 60_000;
const TIMEOUT_MS = 30_000;
/** orgo-web's caps (lib/bops-made-apps/body.ts APP_LIMITS): apps in one full copy, and the longest title and note. */
const PER_COPY = 500;
const MAX = { title: 200, note: 2000, botId: 128 };

const g = globalThis as unknown as {
  __bopsAppsLocal?: { key: string; since: Record<string, string>; written: string; legacyTaken: boolean };
  __bopsAppsSave?: ReturnType<typeof setTimeout>;
  __bopsAppsSoon?: ReturnType<typeof setTimeout>;
  __bopsAppsRetry?: ReturnType<typeof setTimeout>;
  __bopsAppsTries?: number;
  __bopsAppsFlushing?: Promise<boolean>;
  __bopsAppsAgain?: boolean;
  __bopsAppsMissing?: Map<string, number>;
  __bopsAppsStarted?: string;
  __bopsAppsTick?: ReturnType<typeof setInterval>;
  __bopsAppsCopyWanted?: Set<string>;
  __bopsAppsFetching?: Map<string, Promise<boolean>>;
  __bopsAppBuilds?: Map<string, Promise<void>>;
  __bopsAppsSending?: string;
};
const missing = (g.__bopsAppsMissing ??= new Map());
const copyWanted = (g.__bopsAppsCopyWanted ??= new Set());
const fetching = (g.__bopsAppsFetching ??= new Map());

const box = outbox<Op>("made-apps", 5000);
const sha256 = (b: Buffer | string) => createHash("sha256").update(b).digest("hex");
const LONE_SURROGATE = /[\uD800-\uDBFF](?![\uDC00-\uDFFF])|(?<![\uD800-\uDBFF])[\uDC00-\uDFFF]/g;
/**
 * A title or note as orgo-web stores it (lib/bops-made-apps/body.ts storable): no NUL and no half of an
 * emoji, at most `max` UTF-16 units, never cut inside an emoji (as routine-sync.ts fit).
 */
function storable(text: string, max: number) {
  const t = text.replace(/\u0000/g, "").replace(LONE_SURROGATE, "");
  if (t.length <= max) return t;
  const c = t.charCodeAt(max - 1);
  return t.slice(0, c >= 0xd800 && c <= 0xdbff ? max - 1 : max);
}

/** An app's own folder on this Mac. */
export function appFolder(appId: string) {
  const dir = userDir();
  if (!dir) throw new Error("Sign in to Bops first.");
  if (!APP_ID.test(appId)) throw new Error("No such app.");
  return join(/*turbopackIgnore: true*/ dir, "made-apps", appId);
}

const projectOf = (wsId: string) => getState().workspaces?.find((w) => w.id === wsId)?.orgoProjectId;
/** This Mac as Orgo's record names the one that built an app: its device id (cloud/device.ts), or this install's on a server of its own. */
export const thisDevice = () => stateDevice() ?? `host_${installId()}`;
const routesMissing = (pid: string) => (missing.get(pid) ?? 0) > Date.now();
const findApp = (appId: string) => {
  loadLocalApps();
  return getState().madeApps?.find((a) => a.id === appId);
};
const mainOf = (s: AppState, wsId: string) => s.bots.find((b) => b.isMain && workspaceOf(b) === wsId);

/* ---------------- The copy on this Mac ---------------- */

const listFile = () => {
  const dir = userDir();
  return dir ? join(/*turbopackIgnore: true*/ dir, "made-apps", "apps.json") : null;
};

type LocalFile = { apps?: MadeApp[]; since?: Record<string, string>; legacyTaken?: boolean };

function readLocal(file: string): LocalFile {
  try {
    if (!existsSync(/*turbopackIgnore: true*/ file)) return {};
    const read = JSON.parse(readFileSync(/*turbopackIgnore: true*/ file, "utf8")) as LocalFile;
    return read && typeof read === "object" ? read : {};
  } catch (e) {
    console.warn(`[made-apps] the list on this Mac is unreadable, starting from Orgo's (${(e as Error).message})`);
    return {};
  }
}

const isApp = (a: unknown): a is MadeApp => !!a && typeof a === "object" && typeof (a as MadeApp).id === "string" && APP_ID.test((a as MadeApp).id) && Array.isArray((a as MadeApp).versions);

/**
 * The list kept on this Mac into the state, once per account folder and state loaded (a sign-in, a
 * start): put together with what the state has by id, the later change of each standing. The list from
 * before Orgo kept apps (this Mac's in Bops Cloud, macs[device].madeApps) comes in once too. A build the
 * list says was going on that isn't going on in this process stopped when Bops did.
 */
export function loadLocalApps() {
  // Only for an account apps are open to (lib/apps-access.ts): anyone else's list left on this Mac stays there, unread.
  if (onRunner() || !stateReady() || !appsOpen(getState())) return;
  const file = listFile();
  if (!file) return;
  const key = `${file}\n${stateEpoch()}`;
  if (g.__bopsAppsLocal?.key === key) return;
  const read = readLocal(file);
  const s = getState();
  const device = stateDevice();
  const macs = s.macs as Record<string, { madeApps?: unknown }> | undefined;
  const legacy = !read.legacyTaken && device && Array.isArray(macs?.[device]?.madeApps) ? (macs![device].madeApps as unknown[]).filter(isApp).map((a) => ({ ...a, deviceId: a.deviceId ?? device })) : [];
  g.__bopsAppsLocal = { key, since: read.since && typeof read.since === "object" ? { ...read.since } : {}, written: "", legacyTaken: true };
  const had = s.madeApps ?? [];
  const byId = new Map(had.map((a) => [a.id, a]));
  const builds = g.__bopsAppBuilds;
  let changed = false;
  for (const a of [...(Array.isArray(read.apps) ? read.apps.filter(isApp) : []), ...legacy]) {
    const now = byId.get(a.id);
    if (now && now.updatedAt >= a.updatedAt) continue;
    const taken: MadeApp = { ...a, ...(now?.building ? { building: now.building } : {}) };
    if (taken.building && !builds?.has(taken.id)) {
      delete taken.building;
      taken.error = "Bops closed before it was done. Ask again.";
    }
    byId.set(a.id, taken);
    changed = true;
  }
  if (changed) update((st) => void (st.madeApps = [...byId.values()]));
  else saveSoon();
}

/** The list written to this Mac's copy, all or nothing (never before the copy there was read in). */
function saveLocal() {
  if (onRunner() || !stateReady() || !appsOpen(getState())) return;
  const file = listFile();
  if (!file) return;
  loadLocalApps();
  const L = g.__bopsAppsLocal;
  if (!L) return;
  const text = JSON.stringify({ apps: getState().madeApps ?? [], since: L.since, legacyTaken: L.legacyTaken });
  if (text === L.written) return;
  const tmp = `${file}.${randomBytes(4).toString("hex")}.tmp`;
  try {
    mkdirSync(/*turbopackIgnore: true*/ join(/*turbopackIgnore: true*/ file, ".."), { recursive: true, mode: 0o700 });
    writeFileSync(/*turbopackIgnore: true*/ tmp, text, { mode: 0o600 });
    renameSync(/*turbopackIgnore: true*/ tmp, file);
    L.written = text;
  } catch (e) {
    rmSync(/*turbopackIgnore: true*/ tmp, { force: true });
    console.warn(`[made-apps] keeping the list on this Mac: ${(e as Error).message}`);
  }
}

function saveSoon() {
  if (g.__bopsAppsSave) return;
  g.__bopsAppsSave = setTimeout(() => {
    g.__bopsAppsSave = undefined;
    saveLocal();
  }, 400);
  g.__bopsAppsSave.unref?.();
}

// Every change might be one to the list: written a moment later, once for a burst. On the way out, now.
// Never on a computer's runner, which keeps no apps.
if (!onRunner())
  watchChanges("made-apps", () => {
    if (getState().madeApps !== undefined || g.__bopsAppsLocal) saveSoon();
  });
onExit("made-apps", async () => {
  if (g.__bopsAppsSave) clearTimeout(g.__bopsAppsSave);
  g.__bopsAppsSave = undefined;
  saveLocal();
});

/** An app off this Mac (its files and its line in the list) and nothing sent: it was deleted elsewhere, or with its workspace. */
export function removeLocal(appId: string) {
  try {
    rmSync(/*turbopackIgnore: true*/ appFolder(appId), { recursive: true, force: true });
  } catch {
    // Signed out: the list goes below, the folder with the account's.
  }
  update((s) => void (s.madeApps = s.madeApps?.filter((a) => a.id !== appId)));
  box.done(box.waiting().filter((e) => e.item.appId === appId).map((e) => e.id));
}

/* ---------------- What changed here, to send ---------------- */

/** A change to an app's record from here: later than when Orgo and this Mac last agreed, even in the same millisecond (and on a clock behind). */
export const touched = (a: MadeApp) => void (a.updatedAt = Math.max(Date.now(), a.updatedAt + 1, (a.syncedAt ?? 0) + 1));

/** Whether this server keeps apps in step with Orgo: the Mac, signed in to an account apps are open to. */
const synced = () => !onRunner() && appsOpen(getState());

function enqueue(app: Pick<MadeApp, "id" | "ws">, op: Op["op"], more: { n?: number; at?: number } = {}) {
  if (!synced()) return;
  const pid = projectOf(app.ws);
  if (!pid || routesMissing(pid)) return;
  const mine = box.waiting(app.ws).filter((e) => e.item.appId === app.id && e.item.pid === pid);
  // One waiting is enough (it reads the app as it is when it's sent), not one being sent now: it may have read it before this change.
  const queued = mine.filter((e) => e.id !== g.__bopsAppsSending);
  if (op === "app" && queued.some((e) => e.item.op === "app")) return flushSoon();
  if (op === "version" && queued.some((e) => e.item.op === "version" && e.item.n === more.n)) return flushSoon();
  if (op === "data") box.done(mine.filter((e) => e.item.op === "data").map((e) => e.id));
  // A delete: nothing else of it is worth sending any more.
  if (op === "delete") box.done(mine.map((e) => e.id));
  box.add(app.ws, { op, pid, appId: app.id, ...more });
  flushSoon(op === "data" ? DATA_DEBOUNCE_MS : DEBOUNCE_MS);
}

/** Made, renamed, moved to another bot, or a new version named: its record goes to Orgo. */
export const appSaved = (app: MadeApp) => enqueue(app, "app");
/** A new version's code is on this Mac: the record, then the code. */
export function versionSaved(app: MadeApp, n: number) {
  enqueue(app, "app");
  enqueue(app, "version", { n });
}
/** What the app keeps changed here (sent a moment after the last change of a burst). */
export const dataSaved = (app: MadeApp) => enqueue(app, "data", { at: Date.now() });
/** Deleted here: deleted in Orgo too (the delete waits on disk until Orgo took it). */
export const appDeleted = (app: Pick<MadeApp, "id" | "ws">) => enqueue(app, "delete");

/* ---------------- Sending ---------------- */

const forNow = (status: number | null) => status === null || status >= 500 || status === 401 || status === 403 || status === 408 || status === 429;
const codeOf = (r: Answer<unknown>) => (r && typeof (r.json as { code?: unknown })?.code === "string" ? (r.json as { code: string }).code : undefined);
/** An Orgo without the made apps routes: a 405, or a 404 that isn't one of orgo-web's (it always says a code). */
const noRoute = (r: Answer<unknown>) => !!r && (r.status === 405 || (r.status === 404 && !codeOf(r)));
const base = (pid: string, appId: string) => `/api/projects/${encodeURIComponent(pid)}/bops/apps/${encodeURIComponent(appId)}`;

async function orgoKey() {
  const { apiKey } = await import("./orgo");
  return apiKey().catch(() => "");
}

async function call<T>(key: string, path: string, init: { method?: "GET" | "PUT" | "DELETE"; body?: unknown; raw?: { data: Uint8Array; type: string }; headers?: Record<string, string> } = {}): Promise<Answer<T>> {
  const { callOrgo } = await import("./orgo");
  return callOrgo<T>(key, path, { timeoutMs: TIMEOUT_MS, ...init });
}

/** The record as orgo-web takes it (lib/bops-made-apps/body.ts appSchema): names, numbers and times, never code or data. */
function appBody(a: MadeApp) {
  return {
    botId: a.botId.slice(0, MAX.botId),
    title: storable(a.title, MAX.title),
    currentVersion: a.version,
    ...(a.deviceId ? { deviceId: a.deviceId } : {}),
    createdAt: a.createdAt,
    versions: a.versions.map((v) => ({ n: v.n, note: storable(v.note, MAX.note), at: v.at })),
  };
}

/** Orgo took the record: as it was sent (`sent`, its updatedAt here) and as Orgo has it now. */
function tookRecord(appId: string, sent: number, there?: RemoteApp) {
  updateUnseen((s) => {
    const a = s.madeApps?.find((x) => x.id === appId);
    if (!a) return;
    a.syncedAt = Math.max(a.syncedAt ?? 0, sent);
    if (there?.updatedAt) a.remoteAt = there.updatedAt;
    if (there) noteData(a, there.data);
  });
}

/** What Orgo holds of an app's data, as last heard. */
function noteData(a: MadeApp, data: RemoteApp["data"] | undefined) {
  if (data?.sha256) a.orgoData = { sha256: data.sha256, at: Date.parse(data.updatedAt) || 0 };
  else delete a.orgoData;
}

/** A run of sends was refused for a reason Orgo will keep giving: said in the log once (never the code, the data or a secret). */
const said = new Set<string>();
function warnOnce(key: string, text: string) {
  if (said.has(key)) return;
  said.add(key);
  console.warn(`[made-apps] ${text}`);
}

async function sendRecord(key: string, pid: string, appId: string): Promise<Result> {
  const a = findApp(appId);
  if (!a || projectOf(a.ws) !== pid) return "done";
  const sent = a.updatedAt;
  const r = await call<{ app?: RemoteApp }>(key, base(pid, appId), { method: "PUT", body: appBody(a) });
  const status = r?.status ?? null;
  if (status !== null && status < 300) {
    tookRecord(appId, sent, r!.json.app);
    return "done";
  }
  return refused(r, pid, appId, `${a.title}'s record`);
}

/** What a refusal means for the op that got it: tried again later, or done with (said in the log). */
function refused(r: Answer<unknown>, pid: string, appId: string, what: string): Result {
  const status = r?.status ?? null;
  if (forNow(status)) return "later";
  const code = codeOf(r);
  if (code === "app_deleted") {
    // Deleted in Orgo (on another Mac or orgo.ai): a delete is never undone, so it goes here too.
    removeLocal(appId);
    return "done";
  }
  if (code === "storage_quota") {
    warnOnce(`quota:${pid}`, "Orgo's storage for apps is full; what's left waits until there's room");
    return "later";
  }
  if (noRoute(r)) {
    missing.set(pid, Date.now() + MISSING_RETRY_MS);
    return "done";
  }
  // The workspace isn't the user's in Orgo any more (deleted there): nothing of it to send.
  if (code === "not_found") return "done";
  warnOnce(`${status}:${code}:${appId}:${what}`, `Orgo didn't take ${what} (${status}${code ? ` ${code}` : ""}); not sent again`);
  return "done";
}

async function sendVersion(key: string, pid: string, appId: string, n: number): Promise<Result> {
  const a = findApp(appId);
  if (!a || projectOf(a.ws) !== pid) return "done";
  const v = a.versions.find((x) => x.n === n);
  const file = join(/*turbopackIgnore: true*/ appFolder(appId), `v${n}.tsx`);
  if (!v || !existsSync(/*turbopackIgnore: true*/ file)) return "done";
  const source = readFileSync(/*turbopackIgnore: true*/ file, "utf8");
  const sourceSha = sha256(source);
  // Refused for a secret before, and the same code still: not sent again.
  if (a.refused?.[n] === sourceSha) return "done";
  const body = { code: source, note: storable(v.note, MAX.note), at: v.at };
  const put = () => call<{ problems?: unknown[] }>(key, `${base(pid, appId)}/versions/${n}`, { method: "PUT", body });
  let r = await put();
  // Its record isn't in Orgo yet (sent before it, and not taken): the record now, then the code again.
  if (codeOf(r) === "app_not_found") {
    if ((await sendRecord(key, pid, appId)) !== "done" || !findApp(appId)) return findApp(appId) ? "later" : "done";
    r = await put();
  }
  const status = r?.status ?? null;
  if (status !== null && status < 300) return "done";
  const code = codeOf(r);
  if (code === "secret_found") {
    // Kept with the app (apps.json), so no start sends it again while its code is the same.
    updateUnseen((s) => {
      const x = s.madeApps?.find((y) => y.id === appId);
      if (x) x.refused = { ...x.refused, [n]: sourceSha };
    });
    const places = Array.isArray((r!.json as { problems?: unknown[] }).problems) ? (r!.json as { problems: unknown[] }).problems.length : 0;
    warnOnce(`secret:${appId}:${n}`, `${a.title} v${n} wasn't sent to Orgo: it holds what looks like a secret (${places || "a"} place${places === 1 ? "" : "s"}); it stays on this Mac`);
    return "done";
  }
  if (code === "version_exists") {
    warnOnce(`exists:${appId}:${n}`, `${a.title} v${n} is other code in Orgo already; this Mac's stays here`);
    return "done";
  }
  return refused(r, pid, appId, `${a.title} v${n}`);
}

const dataFile = (appId: string) => join(/*turbopackIgnore: true*/ appFolder(appId), "data.json");

/** Data from Orgo written as this Mac's copy, as agreed. */
function keepData(appId: string, bytes: Buffer, sha: string, at: number) {
  const file = dataFile(appId);
  mkdirSync(/*turbopackIgnore: true*/ join(/*turbopackIgnore: true*/ file, ".."), { recursive: true });
  const tmp = `${file}.${randomBytes(4).toString("hex")}.tmp`;
  writeFileSync(/*turbopackIgnore: true*/ tmp, bytes);
  renameSync(/*turbopackIgnore: true*/ tmp, file);
  updateUnseen((s) => {
    const a = s.madeApps?.find((x) => x.id === appId);
    if (!a) return;
    a.dataSha = sha;
    a.orgoData = { sha256: sha, at };
  });
}

async function sendData(key: string, pid: string, appId: string, changedAt: number): Promise<Result> {
  const a = findApp(appId);
  if (!a || projectOf(a.ws) !== pid) return "done";
  const file = dataFile(appId);
  if (!existsSync(/*turbopackIgnore: true*/ file)) return "done";
  const bytes = readFileSync(/*turbopackIgnore: true*/ file);
  const sha = sha256(bytes);
  if (sha === a.dataSha) return "done";
  const put = (match?: string) => call<{ data?: RemoteApp["data"]; sha256?: string | null }>(key, `${base(pid, appId)}/data`, { method: "PUT", raw: { data: bytes, type: "application/json" }, headers: match ? { "If-Match": match } : {} });
  // Only over what the two last agreed on. Orgo holding data this Mac never agreed on (kept on another Mac)
  // is a conflict at once, settled by the later change, never written over unseen.
  const agreed = a.dataSha;
  const unseen = (): Answer<{ code: string }> => ({ status: 412, json: { code: "data_changed" } });
  let r: Answer<unknown> = !agreed && a.orgoData ? unseen() : await put(agreed);
  if (codeOf(r) === "app_not_found") {
    if ((await sendRecord(key, pid, appId)) !== "done" || !findApp(appId)) return findApp(appId) ? "later" : "done";
    r = await put(agreed);
  }
  if (codeOf(r) === "data_changed") {
    // Changed in Orgo too since the two last agreed (on another Mac): the later change stands.
    const there = await call<{ data?: RemoteApp["data"]; url?: string }>(key, `${base(pid, appId)}/data`);
    if (there?.status === 200 && there.json.data && typeof there.json.url === "string") {
      const at = Date.parse(there.json.data.updatedAt) || 0;
      if (at > changedAt) {
        const got = await fetchBlob(there.json.url, there.json.data.sha256);
        if (!got) return "later";
        keepData(appId, got, there.json.data.sha256, at);
        return "done";
      }
      r = await put(there.json.data.sha256);
    } else if (codeOf(there) === "data_not_found") r = await put();
    else return forNow(there?.status ?? null) ? "later" : refused(there, pid, appId, `${a.title}'s data`);
  }
  const status = r?.status ?? null;
  if (status !== null && status < 300) {
    const d = (r!.json as { data?: RemoteApp["data"] }).data;
    updateUnseen((s) => {
      const x = s.madeApps?.find((y) => y.id === appId);
      if (!x) return;
      x.dataSha = sha;
      x.orgoData = { sha256: d?.sha256 ?? sha, at: Date.parse(d?.updatedAt ?? "") || Date.now() };
    });
    return "done";
  }
  if (codeOf(r) === "data_changed") return "later";
  return refused(r, pid, appId, `${a.title}'s data`);
}

async function sendDelete(key: string, pid: string, appId: string): Promise<Result> {
  const r = await call(key, base(pid, appId), { method: "DELETE" });
  const status = r?.status ?? null;
  // 404: Orgo has no such app (never sent, or gone already): done.
  if (status !== null && (status < 300 || status === 404)) return "done";
  return refused(r, pid, appId, "a delete");
}

function send(key: string, e: { item: Op; at: number }): Promise<Result> {
  const { op, pid, appId, n, at } = e.item;
  if (op === "app") return sendRecord(key, pid, appId);
  if (op === "version") return sendVersion(key, pid, appId, n ?? 0);
  if (op === "data") return sendData(key, pid, appId, at ?? e.at);
  return sendDelete(key, pid, appId);
}

/** Send what waits, a moment after the last change. */
function flushSoon(ms = DEBOUNCE_MS) {
  if (g.__bopsAppsSoon) clearTimeout(g.__bopsAppsSoon);
  g.__bopsAppsSoon = setTimeout(() => {
    g.__bopsAppsSoon = undefined;
    void flush();
  }, ms);
  g.__bopsAppsSoon.unref?.();
}

/** What's left goes again after a backoff (1 minute, doubling to 30). */
function later() {
  if (g.__bopsAppsRetry) return;
  const n = (g.__bopsAppsTries = (g.__bopsAppsTries ?? 0) + 1);
  g.__bopsAppsRetry = setTimeout(
    () => {
      g.__bopsAppsRetry = undefined;
      void flush();
      for (const wsId of [...copyWanted]) void sendAll(wsId);
    },
    Math.min(RETRY_MS * 2 ** (n - 1), RETRY_MAX_MS),
  );
  g.__bopsAppsRetry.unref?.();
}

/** Send everything waiting, oldest first, one run at a time (a call meanwhile runs once more after). True when nothing is left. */
export function flush(): Promise<boolean> {
  if (g.__bopsAppsFlushing) {
    g.__bopsAppsAgain = true;
    return g.__bopsAppsFlushing;
  }
  const run = (async () => {
    let ok = true;
    do {
      g.__bopsAppsAgain = false;
      ok = await flushOnce();
    } while (g.__bopsAppsAgain);
    return ok;
  })().finally(() => (g.__bopsAppsFlushing = undefined));
  g.__bopsAppsFlushing = run;
  return run;
}

async function flushOnce(): Promise<boolean> {
  if (!synced() || !stateReady() || stateTooNew()) return true;
  const waiting = box.waiting();
  if (!waiting.length) return true;
  const key = await orgoKey();
  if (!key) {
    later();
    return false;
  }
  // An app's ops go in order: one left waiting holds back the rest of that app's.
  const held = new Set<string>();
  let left = false;
  for (const e of waiting) {
    if (held.has(e.item.appId)) {
      left = true;
      continue;
    }
    if (routesMissing(e.item.pid)) {
      box.done([e.id]);
      continue;
    }
    let r: Result;
    g.__bopsAppsSending = e.id;
    try {
      r = await send(key, e);
    } catch (err) {
      console.warn(`[made-apps] sending to Orgo: ${(err as Error).message}`);
      r = "later";
    } finally {
      g.__bopsAppsSending = undefined;
    }
    if (r === "done") box.done([e.id]);
    else {
      held.add(e.item.appId);
      left = true;
    }
  }
  if (left) later();
  else g.__bopsAppsTries = 0;
  return !left;
}

/* ---------------- Orgo's list, here ---------------- */

/**
 * A workspace's apps as Orgo lists them, here: one made on another Mac is listed (its code and data
 * fetched when it's opened), one changed there takes Orgo's record (unless it changed here too since the
 * two last agreed: then this Mac's goes), one deleted there goes here too, files and all. With no ?since=
 * yet (or one too old), the whole list: an app Orgo had from here that it no longer lists was deleted
 * there. True when Orgo answered.
 */
export async function pullApps(wsId: string): Promise<boolean> {
  const pid = projectOf(wsId);
  if (!pid || routesMissing(pid) || !synced() || !stateReady() || stateTooNew()) return false;
  loadLocalApps();
  const key = await orgoKey();
  if (!key) return false;
  const since = g.__bopsAppsLocal?.since[pid];
  const r = await call<{ apps?: RemoteApp[]; at?: string; full?: boolean }>(key, `/api/projects/${encodeURIComponent(pid)}/bops/apps${since ? `?since=${encodeURIComponent(since)}` : ""}`);
  if (noRoute(r)) {
    missing.set(pid, Date.now() + MISSING_RETRY_MS);
    return false;
  }
  if (!r || r.status !== 200 || !Array.isArray(r.json.apps)) return false;
  // The workspace may have moved to another project meanwhile.
  if (projectOf(wsId) !== pid) return false;
  take(wsId, r.json.apps, r.json.full === true);
  const L = g.__bopsAppsLocal;
  if (L && typeof r.json.at === "string") {
    L.since[pid] = r.json.at;
    saveSoon();
  }
  return true;
}

function take(wsId: string, remote: RemoteApp[], full: boolean) {
  const waiting = box.waiting(wsId);
  const pending = new Set(waiting.map((e) => e.item.appId));
  const deleting = new Set(waiting.filter((e) => e.item.op === "delete").map((e) => e.item.appId));
  const listed = new Set<string>();
  const gone: string[] = [];
  const toSend: string[] = [];
  update((s) => {
    s.madeApps ??= [];
    for (const r of remote) {
      if (!r || typeof r.bopsId !== "string" || !APP_ID.test(r.bopsId)) continue;
      listed.add(r.bopsId);
      if (deleting.has(r.bopsId)) continue;
      const a = s.madeApps.find((x) => x.id === r.bopsId);
      if (r.deletedAt) {
        if (a && a.ws === wsId) gone.push(a.id);
        continue;
      }
      const at = Date.parse(r.updatedAt) || Date.now();
      const versions = (Array.isArray(r.versions) ? r.versions : []).map((v) => ({ n: v.n, note: v.note ?? "", at: Date.parse(v.createdAt) || at })).sort((x, y) => x.n - y.n);
      const botId = s.bots.some((b) => b.id === r.botId) ? r.botId : (mainOf(s, wsId)?.id ?? r.botId);
      if (!a) {
        // Made on another Mac (or this Mac's copy was lost): listed, its code fetched when it's opened.
        const made: MadeApp = { id: r.bopsId, title: r.title || "App", botId, chatId: botChatId(botId), ws: wsId, version: r.currentVersion, versions, createdAt: Date.parse(r.createdAt) || at, updatedAt: at, syncedAt: at, remoteAt: r.updatedAt, ...(r.deviceId ? { deviceId: r.deviceId } : {}) };
        noteData(made, r.data);
        s.madeApps.push(made);
        continue;
      }
      if (a.ws !== wsId) continue;
      noteData(a, r.data);
      const changedHere = a.updatedAt > (a.syncedAt ?? 0);
      if (r.updatedAt === a.remoteAt) {
        if (changedHere && !pending.has(a.id)) toSend.push(a.id);
        continue;
      }
      if (changedHere || a.building) {
        if (!pending.has(a.id)) toSend.push(a.id);
        continue;
      }
      const newCode = r.currentVersion !== a.version || versions.at(-1)?.n !== a.versions.at(-1)?.n;
      a.title = r.title || a.title;
      if (botId !== a.botId) {
        a.botId = botId;
        a.chatId = botChatId(botId);
      }
      a.version = r.currentVersion;
      a.versions = versions;
      if (r.deviceId) a.deviceId = r.deviceId;
      a.updatedAt = at;
      a.syncedAt = at;
      a.remoteAt = r.updatedAt;
      // New code from elsewhere: the user is asked again before it may ask its bot.
      if (newCode) delete a.allowed;
    }
    if (full)
      for (const a of s.madeApps)
        if (a.ws === wsId && !listed.has(a.id) && a.syncedAt && a.updatedAt <= a.syncedAt && !pending.has(a.id) && !a.building) gone.push(a.id);
  });
  for (const id of gone) removeLocal(id);
  for (const id of toSend) {
    const a = findApp(id);
    if (a) appSaved(a);
  }
}

/**
 * This Mac's own apps of a workspace (the ones it built) as a full copy (PUT …/apps, 500 a call, never
 * deleteMissing): an app Orgo never had gets its record, each version Orgo has no code for whose code is
 * here is sent, and data Orgo hasn't got goes. One deleted in Orgo meanwhile goes here too. Tried again
 * after a backoff when Orgo didn't take it for now. True when it all went.
 */
export async function sendAll(wsId: string): Promise<boolean> {
  const pid = projectOf(wsId);
  if (!pid || routesMissing(pid) || !synced() || !stateReady() || stateTooNew()) return false;
  loadLocalApps();
  const key = await orgoKey();
  if (!key) {
    copyWanted.add(wsId);
    later();
    return false;
  }
  const me = thisDevice();
  // Apps from before Orgo kept them were made on this Mac (the list was this Mac's alone).
  if ((getState().madeApps ?? []).some((a) => a.ws === wsId && !a.deviceId))
    updateUnseen((s) => {
      for (const a of s.madeApps ?? []) if (a.ws === wsId && !a.deviceId) a.deviceId = me;
    });
  const mine = (getState().madeApps ?? []).filter((a) => a.ws === wsId && a.deviceId === me);
  for (let i = 0; i < mine.length; i += PER_COPY) {
    const part = mine.slice(i, i + PER_COPY);
    const sent = new Map(part.map((a) => [a.id, a.updatedAt]));
    const r = await call<{ apps?: RemoteApp[]; alreadyDeleted?: string[] }>(key, `/api/projects/${encodeURIComponent(pid)}/bops/apps`, {
      method: "PUT",
      body: { deviceId: me, apps: part.map((a) => ({ bopsId: a.id, ...appBody(a) })) },
    });
    if (noRoute(r)) {
      missing.set(pid, Date.now() + MISSING_RETRY_MS);
      copyWanted.delete(wsId);
      return false;
    }
    if (!r || r.status !== 200 || !Array.isArray(r.json.apps)) {
      if (forNow(r?.status ?? null)) {
        copyWanted.add(wsId);
        later();
      } else warnOnce(`copy:${pid}:${r?.status}`, `Orgo didn't take this Mac's apps (${r?.status} ${codeOf(r) ?? ""}); sent again at the next start`);
      return false;
    }
    for (const id of r.json.alreadyDeleted ?? []) if (typeof id === "string") removeLocal(id);
    for (const there of r.json.apps) {
      const a = findApp(there.bopsId);
      if (!a || !sent.has(a.id)) continue;
      tookRecord(a.id, sent.get(a.id)!, there);
      for (const v of there.versions ?? []) {
        const file = join(/*turbopackIgnore: true*/ appFolder(a.id), `v${v.n}.tsx`);
        if (v.sha256 || !existsSync(/*turbopackIgnore: true*/ file)) continue;
        // Refused for a secret before, and the same code still: not sent again.
        const refused = findApp(a.id)?.refused?.[v.n];
        if (refused && refused === sha256(readFileSync(/*turbopackIgnore: true*/ file, "utf8"))) continue;
        enqueue(a, "version", { n: v.n });
      }
      const file = dataFile(a.id);
      if (!existsSync(/*turbopackIgnore: true*/ file)) continue;
      const here = sha256(readFileSync(/*turbopackIgnore: true*/ file));
      const now = findApp(a.id);
      if (!now || here === now.dataSha) continue;
      // Changed here since the two last agreed (or never agreed): sent, the later change winning a conflict.
      // (Unchanged here and newer in Orgo: fetched when the app reads it, dataHere.)
      if (there.data?.sha256 === here) updateUnseen(() => void (now.dataSha = here));
      else enqueue(a, "data", { at: statSync(/*turbopackIgnore: true*/ file).mtimeMs });
    }
  }
  copyWanted.delete(wsId);
  void flush();
  return true;
}

/* ---------------- Fetched when opened ---------------- */

/** Bytes from a presigned GET (no key sent), checked against their sha256; null when they can't be had or don't match. */
async function fetchBlob(url: string, sha: string | null): Promise<Buffer | null> {
  if (!/^https?:\/\//.test(url)) return null;
  const res = await fetch(url, { signal: AbortSignal.timeout(60_000), cache: "no-store" }).catch(() => null);
  if (!res?.ok) return null;
  const buf = Buffer.from(await res.arrayBuffer());
  return sha && sha256(buf) !== sha ? null : buf;
}

/**
 * Version n's code on this Mac, fetched from Orgo the first time it's opened here (an app another Mac
 * made, or this Mac's copy lost), then kept. True when it's here.
 */
export function codeHere(appId: string, n: number): Promise<boolean> {
  if (!n || !APP_ID.test(appId)) return Promise.resolve(false);
  let file: string;
  try {
    file = join(/*turbopackIgnore: true*/ appFolder(appId), `v${n}.tsx`);
  } catch {
    return Promise.resolve(false);
  }
  if (existsSync(/*turbopackIgnore: true*/ file)) return Promise.resolve(true);
  const k = `${appId}:${n}`;
  const going = fetching.get(k);
  if (going) return going;
  const run = (async () => {
    const a = findApp(appId);
    const pid = a && projectOf(a.ws);
    if (!pid || onRunner() || routesMissing(pid)) return false;
    const key = await orgoKey();
    if (!key) return false;
    const r = await call<{ version?: { sha256?: string | null }; url?: string }>(key, `${base(pid, appId)}/versions/${n}`);
    if (r?.status !== 200 || typeof r.json.url !== "string") return false;
    const got = await fetchBlob(r.json.url, r.json.version?.sha256 ?? null);
    if (!got || !findApp(appId)) return false;
    mkdirSync(/*turbopackIgnore: true*/ join(/*turbopackIgnore: true*/ file, ".."), { recursive: true });
    const tmp = `${file}.${randomBytes(4).toString("hex")}.tmp`;
    writeFileSync(/*turbopackIgnore: true*/ tmp, got);
    renameSync(/*turbopackIgnore: true*/ tmp, file);
    return true;
  })()
    .catch(() => false)
    .finally(() => fetching.delete(k));
  fetching.set(k, run);
  return run;
}

/**
 * The app's data on this Mac as Orgo has it, fetched when Orgo holds data this Mac hasn't got (kept or
 * changed on another Mac) and this Mac's is unchanged since they last agreed. Throws when it can't be
 * fetched, so an app never starts over on data it couldn't read (and never writes that over Orgo's).
 */
export async function dataHere(appId: string): Promise<void> {
  const a = findApp(appId);
  if (!a?.orgoData || a.orgoData.sha256 === a.dataSha || onRunner()) return;
  const file = dataFile(appId);
  const here = existsSync(/*turbopackIgnore: true*/ file) ? sha256(readFileSync(/*turbopackIgnore: true*/ file)) : null;
  if (here === a.orgoData.sha256) {
    updateUnseen(() => void (a.dataSha = here));
    return;
  }
  // Changed here since: this Mac's goes to Orgo (its data op), which settles it by the later change.
  if (here && here !== a.dataSha && box.waiting(a.ws).some((e) => e.item.appId === appId && e.item.op === "data")) return;
  const pid = projectOf(a.ws);
  const fail = () => {
    throw new Error("Couldn't get this app's data from Orgo. Try again in a moment.");
  };
  if (!pid) return;
  const k = `${appId}:data`;
  const going = fetching.get(k);
  if (going) {
    if (!(await going)) fail();
    return;
  }
  const run = (async () => {
    const key = await orgoKey();
    if (!key) return false;
    const r = await call<{ data?: RemoteApp["data"]; url?: string }>(key, `${base(pid, appId)}/data`);
    if (codeOf(r) === "data_not_found") {
      updateUnseen(() => void delete a.orgoData);
      return true;
    }
    if (r?.status !== 200 || !r.json.data || typeof r.json.url !== "string") return false;
    const got = await fetchBlob(r.json.url, r.json.data.sha256);
    if (!got || !findApp(appId)) return false;
    keepData(appId, got, r.json.data.sha256, Date.parse(r.json.data.updatedAt) || Date.now());
    return true;
  })()
    .catch(() => false)
    .finally(() => fetching.delete(k));
  fetching.set(k, run);
  if (!(await run)) fail();
}

/* ---------------- With bots and workspaces ---------------- */

/** A bot is deleted: the apps it made stay, under its workspace's main bot (their builds report in its chat). How many. */
export function appsToMainBot(botId: string, wsId: string): number {
  loadLocalApps();
  const s = getState();
  const main = mainOf(s, wsId);
  const apps = (s.madeApps ?? []).filter((a) => a.botId === botId);
  if (!main || main.id === botId || !apps.length) return 0;
  update((st) => {
    for (const a of st.madeApps ?? [])
      if (a.botId === botId) {
        a.botId = main.id;
        a.chatId = botChatId(main.id);
        touched(a);
      }
  });
  for (const a of apps) {
    const now = findApp(a.id);
    if (now) appSaved(now);
  }
  return apps.length;
}

/** A workspace is deleted (its Orgo project with it, made apps and all): its apps go from this Mac too, nothing sent. */
export function dropWorkspaceApps(wsId: string) {
  loadLocalApps();
  for (const a of (getState().madeApps ?? []).filter((x) => x.ws === wsId)) removeLocal(a.id);
  box.done(box.waiting(wsId).map((e) => e.id));
}

/* ---------------- Starting ---------------- */

/** Once a start and sign-in (the state route, on the Mac): the list on this Mac read in, then each bound workspace's read from Orgo and this Mac's own sent, and what waited from before sent. */
export function startMadeAppsSync() {
  if (!synced() || !stateReady() || stateTooNew()) return;
  loadLocalApps();
  const key = g.__bopsAppsLocal?.key;
  if (!key || g.__bopsAppsStarted === key) return;
  g.__bopsAppsStarted = key;
  void everyWorkspace();
  if (!g.__bopsAppsTick) {
    g.__bopsAppsTick = setInterval(() => {
      for (const w of getState().workspaces ?? []) if (w.orgoProjectId) void pullApps(w.id).catch(() => {});
    }, PULL_EVERY_MS);
    g.__bopsAppsTick.unref?.();
  }
}

async function everyWorkspace() {
  try {
    for (const w of getState().workspaces ?? []) {
      if (!w.orgoProjectId) continue;
      await pullApps(w.id);
      await sendAll(w.id);
    }
    await flush();
  } catch (e) {
    console.warn(`[made-apps] in step with Orgo: ${(e as Error).message}`);
  }
}

/** A workspace just got its Orgo project: its list read from there, this Mac's own sent. */
export function appsBound(wsId: string) {
  void pullApps(wsId)
    .then(() => sendAll(wsId))
    .catch((e: Error) => console.warn(`[made-apps] ${wsId}'s apps to its new Orgo project: ${e.message}`));
}

/** Tests: send now, read and copy now, forget what was learned, or forget the list in memory as a restart would (the files stay). */
export const madeAppsSyncForTests = {
  flush,
  pullApps,
  sendAll,
  waiting: () => box.waiting(),
  since: (pid: string) => g.__bopsAppsLocal?.since[pid],
  saveNow: saveLocal,
  reset: () => {
    for (const t of [g.__bopsAppsSoon, g.__bopsAppsRetry, g.__bopsAppsSave]) if (t) clearTimeout(t);
    if (g.__bopsAppsTick) clearInterval(g.__bopsAppsTick);
    g.__bopsAppsSoon = g.__bopsAppsRetry = g.__bopsAppsSave = g.__bopsAppsTick = undefined;
    g.__bopsAppsTries = 0;
    g.__bopsAppsStarted = undefined;
    missing.clear();
    copyWanted.clear();
    said.clear();
  },
  restart: () => {
    saveLocal();
    madeAppsSyncForTests.reset();
    g.__bopsAppsLocal = undefined;
    update((s) => void delete s.madeApps);
  },
};
