import "server-only";
import { createHash, randomBytes } from "node:crypto";
import { existsSync, readFileSync, renameSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { SAMPLE_NAME } from "@/lib/crm-csv";
import { onRunner } from "./persist";
import { getState, stateEpoch, stateReady, stateTooNew, userDir } from "./store";
import { outbox } from "./sync-outbox";

/**
 * The CRM's files (crm.ts) recorded in Orgo: orgo-web's bops_crm_files, each file's CSV in the user-apps
 * bucket (/api/projects/{project}/crm). Orgo is the record, so the user's other Macs list and open them;
 * the folder on this Mac is the copy the app and the bots work on.
 *
 * - Each create, change, rename and delete here goes to Orgo through an outbox kept with the user's folder
 *   (sync-outbox.ts), each workspace's in order, so a quit or a crash while Orgo is away loses none: a
 *   file's CSV as it is when it's sent (PUT …/crm/{name}, If-Match the contents the two last agreed on),
 *   a rename (PATCH), a delete (DELETE: Orgo keeps it in its trash 30 days). Orgo not answering, or
 *   answering for now (401, 403, 408, 429, 5xx, its storage full), keeps it, and it's tried again after a
 *   backoff (1 minute, doubling to 30).
 * - What Orgo has comes here when the CRM's list is opened (at most every 30 seconds), at start and once a
 *   workspace gets its Orgo project (GET …/crm?since= the last read): a file made or changed on another
 *   Mac is written here, one renamed there is renamed here, one deleted there goes to this folder's .trash.
 *   A file changed on both sides since they last agreed takes the later change, and the copy that lost
 *   goes to .trash. A file here that Orgo never had is sent.
 * - What the two last agreed on is kept in the folder (.orgo.json: each file's Orgo id, name, sha256, and
 *   its size and time here), so nothing is read twice that didn't change.
 * - Only the Mac, and only where there's a CRM (crm.ts crmOn); never a computer's runner.
 */

type Op = { op: "put" | "rename" | "delete"; pid: string; name: string; to?: string };
type Result = "done" | "later";
type Answer<T> = { status: number; json: T } | null;
export type RemoteFile = { id: string; name: string; columns: string[]; rows: number; bytes: number; sha256: string; sample: boolean; createdAt: string; updatedAt: string; deletedAt: string | null };
/** One file as the two last agreed on it: Orgo's id, name, sha256 and updatedAt, and the file's size and time here then. */
type Known = { id: string; name: string; sha: string; at: string; size: number; mtimeMs: number };
type Side = { pid: string; since?: string; files: Record<string, Known> };

const DEBOUNCE_MS = 2000;
const RETRY_MS = 60_000;
const RETRY_MAX_MS = 30 * 60_000;
const MISSING_RETRY_MS = 6 * 60 * 60_000;
const LIST_EVERY_MS = 30_000;
/** How long the CRM's list waits on Orgo before showing what's here. */
const LIST_WAIT_MS = 4000;
const TIMEOUT_MS = 30_000;

const g = globalThis as unknown as {
  __bopsCrmSoon?: ReturnType<typeof setTimeout>;
  __bopsCrmRetry?: ReturnType<typeof setTimeout>;
  __bopsCrmTries?: number;
  __bopsCrmFlushing?: Promise<boolean>;
  __bopsCrmAgain?: boolean;
  __bopsCrmMissing?: Map<string, number>;
  __bopsCrmPulled?: Map<string, number>;
  __bopsCrmPulling?: Map<string, Promise<boolean>>;
  __bopsCrmStarted?: string;
};
const missing = (g.__bopsCrmMissing ??= new Map());
const pulled = (g.__bopsCrmPulled ??= new Map());
const pulling = (g.__bopsCrmPulling ??= new Map());

const box = outbox<Op>("crm", 1000);
const sha256 = (b: Buffer) => createHash("sha256").update(b).digest("hex");
const fold = (name: string) => name.normalize("NFC").toLowerCase();
const projectOf = (ws: string) => getState().workspaces?.find((w) => w.id === ws)?.orgoProjectId;
const routesMissing = (pid: string) => (missing.get(pid) ?? 0) > Date.now();
const crm = () => import("./crm");

/* ---------------- What the two last agreed on ---------------- */

const sideFile = (dir: string) => join(/*turbopackIgnore: true*/ dir, ".orgo.json");

/** The folder's record of what Orgo has, for this project (another project's starts over). */
function readSide(dir: string, pid: string): Side {
  try {
    const file = sideFile(dir);
    const s = existsSync(/*turbopackIgnore: true*/ file) ? (JSON.parse(readFileSync(/*turbopackIgnore: true*/ file, "utf8")) as Side) : null;
    if (s && s.pid === pid && s.files && typeof s.files === "object") return s;
  } catch {
    // Unreadable: started over (each file is then compared with Orgo's by its contents).
  }
  return { pid, files: {} };
}

function writeSide(dir: string, side: Side) {
  const file = sideFile(dir);
  const tmp = `${file}.${randomBytes(4).toString("hex")}.tmp`;
  try {
    writeFileSync(/*turbopackIgnore: true*/ tmp, JSON.stringify(side), { mode: 0o600 });
    renameSync(/*turbopackIgnore: true*/ tmp, file);
  } catch (e) {
    rmSync(/*turbopackIgnore: true*/ tmp, { force: true });
    console.warn(`[crm] keeping what Orgo has: ${(e as Error).message}`);
  }
}

const knownOf = (side: Side, name: string) => side.files[fold(name)];

/* ---------------- What changed here, to send ---------------- */

/** A file made or changed here (`put`), renamed (`rename`), or deleted (`del`): it goes to Orgo, in order. */
export function crmChanged(ws: string, change: { put: string } | { rename: [string, string] } | { del: string }) {
  if (onRunner()) return;
  const pid = projectOf(ws);
  if (!pid || routesMissing(pid)) return;
  if ("put" in change) {
    // The file's contents go as they are when it's sent: one put waiting is enough.
    const waiting = box.waiting(ws);
    const last = waiting.filter((e) => e.item.pid === pid).at(-1);
    if (!(last?.item.op === "put" && fold(last.item.name) === fold(change.put))) box.add(ws, { op: "put", pid, name: change.put });
  } else if ("rename" in change) box.add(ws, { op: "rename", pid, name: change.rename[0], to: change.rename[1] });
  else box.add(ws, { op: "delete", pid, name: change.del });
  flushSoon();
}

/* ---------------- Sending ---------------- */

const forNow = (status: number | null) => status === null || status >= 500 || status === 401 || status === 403 || status === 408 || status === 429;
const codeOf = (r: Answer<unknown>) => (r && typeof (r.json as { code?: unknown })?.code === "string" ? (r.json as { code: string }).code : undefined);
const noRoute = (r: Answer<unknown>) => !!r && (r.status === 405 || (r.status === 404 && !codeOf(r)));
const filePath = (pid: string, name: string) => `/api/projects/${encodeURIComponent(pid)}/crm/${encodeURIComponent(name)}`;

async function orgoKey() {
  const { apiKey } = await import("./orgo");
  return apiKey().catch(() => "");
}

async function call<T>(key: string, path: string, init: { method?: "GET" | "PUT" | "PATCH" | "DELETE"; body?: unknown; raw?: { data: Uint8Array; type: string }; headers?: Record<string, string> } = {}): Promise<Answer<T>> {
  const { callOrgo } = await import("./orgo");
  return callOrgo<T>(key, path, { timeoutMs: TIMEOUT_MS, ...init });
}

const said = new Set<string>();
function warnOnce(key: string, text: string) {
  if (said.has(key)) return;
  said.add(key);
  console.warn(`[crm] ${text}`);
}

/** Bytes from a presigned GET (no key sent), checked against their sha256; null when they can't be had or don't match. */
async function fetchBlob(url: string, sha: string): Promise<Buffer | null> {
  if (!/^https?:\/\//.test(url)) return null;
  const res = await fetch(url, { signal: AbortSignal.timeout(60_000), cache: "no-store" }).catch(() => null);
  if (!res?.ok) return null;
  const buf = Buffer.from(await res.arrayBuffer());
  return sha256(buf) === sha ? buf : null;
}

/** Orgo's copy of a file, its bytes and its record; null when it can't be had. */
async function download(key: string, pid: string, name: string): Promise<{ file: RemoteFile; bytes: Buffer } | "gone" | null> {
  const r = await call<{ file?: RemoteFile; url?: string }>(key, filePath(pid, name));
  if (codeOf(r) === "file_not_found") return "gone";
  if (r?.status !== 200 || !r.json.file || typeof r.json.url !== "string") return null;
  const bytes = await fetchBlob(r.json.url, r.json.file.sha256);
  return bytes ? { file: r.json.file, bytes } : null;
}

/** Orgo's file written here as the one of its name, and noted as agreed. Only in the folder's lane. */
async function keepTheirs(dir: string, side: Side, f: RemoteFile, bytes: Buffer, oldName?: string) {
  const { crmFolder } = await crm();
  const st = crmFolder.write(dir, oldName ?? f.name, bytes);
  // Renamed there too (or only its case): the file here takes Orgo's name.
  if (oldName && oldName !== f.name) crmFolder.rename(dir, oldName, f.name);
  if (oldName) delete side.files[fold(oldName)];
  const now = crmFolder.files(dir).find((x) => fold(x.name) === fold(f.name));
  side.files[fold(f.name)] = { id: f.id, name: f.name, sha: f.sha256, at: f.updatedAt, size: now?.size ?? st.size, mtimeMs: now?.mtimeMs ?? st.mtimeMs };
}

async function sendPut(key: string, ws: string, dir: string, side: Side, pid: string, name: string): Promise<Result> {
  const { crmFolder } = await crm();
  const here = crmFolder.read(dir, name);
  // Gone since (renamed or deleted after): the op after this one says where it went.
  if (!here) return "done";
  const sha = sha256(here.bytes);
  const known = knownOf(side, here.name);
  if (known?.sha === sha && known.name === here.name) return "done";
  const sample = fold(here.name) === fold(SAMPLE_NAME) ? "?sample=1" : "";
  const put = (match?: string) =>
    call<{ file?: RemoteFile; sha256?: string | null }>(key, `${filePath(pid, here.name)}${sample}`, { method: "PUT", raw: { data: here.bytes, type: "text/csv; charset=utf-8" }, headers: match ? { "If-Match": match } : {} });
  let r = await put(known?.sha);
  if (codeOf(r) === "file_changed") {
    // Changed in Orgo too since the two last agreed (or one of that name was made on another Mac): the later change stands.
    const there = await download(key, pid, here.name);
    if (there === null) return "later";
    if (there === "gone") r = await put();
    else if ((Date.parse(there.file.updatedAt) || 0) > here.mtimeMs) {
      await crmFolder.lane(dir, async () => {
        // This Mac's copy lost: into .trash, Orgo's in its place.
        crmFolder.trash(dir, here.name);
        await keepTheirs(dir, side, there.file, there.bytes);
      });
      writeSide(dir, side);
      return "done";
    } else r = await put(there.file.sha256);
  }
  const status = r?.status ?? null;
  if (status !== null && status < 300 && r!.json.file) {
    const f = r!.json.file;
    side.files[fold(here.name)] = { id: f.id, name: f.name, sha: f.sha256, at: f.updatedAt, size: here.size, mtimeMs: here.mtimeMs };
    writeSide(dir, side);
    return "done";
  }
  if (codeOf(r) === "file_changed") return "later";
  return refused(r, pid, `${here.name} in ${ws}`);
}

function refused(r: Answer<unknown>, pid: string, what: string): Result {
  const status = r?.status ?? null;
  if (forNow(status)) return "later";
  const code = codeOf(r);
  if (code === "storage_quota") {
    warnOnce(`quota:${pid}`, "Orgo's storage is full; the CRM's changes wait until there's room");
    return "later";
  }
  if (noRoute(r)) {
    missing.set(pid, Date.now() + MISSING_RETRY_MS);
    return "done";
  }
  // The workspace isn't the user's in Orgo any more (deleted there): nothing of it to send.
  if (code === "not_found") return "done";
  warnOnce(`${status}:${code}:${what}`, `Orgo didn't take ${what} (${status}${code ? ` ${code}` : ""}); it stays on this Mac`);
  return "done";
}

async function sendRename(key: string, ws: string, dir: string, side: Side, pid: string, from: string, to: string): Promise<Result> {
  const r = await call<{ file?: RemoteFile }>(key, filePath(pid, from), { method: "PATCH", body: { name: to } });
  const status = r?.status ?? null;
  if (status !== null && status < 300 && r!.json.file) {
    const f = r!.json.file;
    const was = knownOf(side, from);
    delete side.files[fold(from)];
    if (was) side.files[fold(f.name)] = { ...was, id: f.id, name: f.name, at: f.updatedAt };
    writeSide(dir, side);
    return "done";
  }
  const code = codeOf(r);
  // Orgo hasn't `from` (never sent from here): `to` goes as it is.
  if (code === "file_not_found") {
    delete side.files[fold(from)];
    return sendPut(key, ws, dir, side, pid, to);
  }
  // Another Mac made one called `to` meanwhile: this one goes over it by the later change, and `from` goes.
  if (code === "name_taken") {
    const put = await sendPut(key, ws, dir, side, pid, to);
    if (put !== "done") return put;
    return sendDelete(key, dir, side, pid, from);
  }
  return refused(r, pid, `the rename of ${from}`);
}

async function sendDelete(key: string, dir: string, side: Side, pid: string, name: string): Promise<Result> {
  const r = await call(key, filePath(pid, name), { method: "DELETE" });
  const status = r?.status ?? null;
  if (status !== null && (status < 300 || status === 404)) {
    if (!noRoute(r)) {
      delete side.files[fold(name)];
      writeSide(dir, side);
      return "done";
    }
  }
  return refused(r, pid, `the delete of ${name}`);
}

function flushSoon(ms = DEBOUNCE_MS) {
  if (g.__bopsCrmSoon) clearTimeout(g.__bopsCrmSoon);
  g.__bopsCrmSoon = setTimeout(() => {
    g.__bopsCrmSoon = undefined;
    void flush();
  }, ms);
  g.__bopsCrmSoon.unref?.();
}

function later() {
  if (g.__bopsCrmRetry) return;
  const n = (g.__bopsCrmTries = (g.__bopsCrmTries ?? 0) + 1);
  g.__bopsCrmRetry = setTimeout(
    () => {
      g.__bopsCrmRetry = undefined;
      void flush();
    },
    Math.min(RETRY_MS * 2 ** (n - 1), RETRY_MAX_MS),
  );
  g.__bopsCrmRetry.unref?.();
}

/** Send everything waiting, each workspace's in order, one run at a time. True when nothing is left. */
export function flush(): Promise<boolean> {
  if (g.__bopsCrmFlushing) {
    g.__bopsCrmAgain = true;
    return g.__bopsCrmFlushing;
  }
  const run = (async () => {
    let ok = true;
    do {
      g.__bopsCrmAgain = false;
      ok = await flushOnce();
    } while (g.__bopsCrmAgain);
    return ok;
  })().finally(() => (g.__bopsCrmFlushing = undefined));
  g.__bopsCrmFlushing = run;
  return run;
}

async function flushOnce(): Promise<boolean> {
  if (onRunner() || !stateReady() || stateTooNew()) return true;
  const waiting = box.waiting();
  if (!waiting.length) return true;
  const key = await orgoKey();
  if (!key) {
    later();
    return false;
  }
  const { crmFolder } = await crm();
  const held = new Set<string>();
  const sides = new Map<string, Side>();
  let left = false;
  for (const e of waiting) {
    const ws = e.wsId;
    const item = e.item;
    if (held.has(ws)) {
      left = true;
      continue;
    }
    const dir = crmFolder.dirOf(ws);
    if (!dir || routesMissing(item.pid) || projectOf(ws) !== item.pid) {
      box.done([e.id]);
      continue;
    }
    const side = sides.get(dir) ?? readSide(dir, item.pid);
    sides.set(dir, side);
    let r: Result;
    try {
      r =
        item.op === "put"
          ? await sendPut(key, ws, dir, side, item.pid, item.name)
          : item.op === "rename"
            ? await sendRename(key, ws, dir, side, item.pid, item.name, item.to ?? item.name)
            : await sendDelete(key, dir, side, item.pid, item.name);
    } catch (err) {
      console.warn(`[crm] sending to Orgo: ${(err as Error).message}`);
      r = "later";
    }
    if (r === "done") box.done([e.id]);
    else {
      // A workspace's changes go in order: one left waiting holds back the ones after it.
      held.add(ws);
      left = true;
    }
  }
  if (left) later();
  else g.__bopsCrmTries = 0;
  return !left;
}

/* ---------------- Orgo's copy, here ---------------- */

/**
 * A workspace's files as Orgo has them, here (see above), and every file here Orgo hasn't got (or not as
 * it is now) sent. True when Orgo answered.
 */
export function pullCrm(ws: string): Promise<boolean> {
  const going = pulling.get(ws);
  if (going) return going;
  const run = pullOnce(ws)
    .catch((e: Error) => {
      console.warn(`[crm] reading Orgo's copy: ${e.message}`);
      return false;
    })
    .finally(() => pulling.delete(ws));
  pulling.set(ws, run);
  return run;
}

async function pullOnce(ws: string): Promise<boolean> {
  const pid = projectOf(ws);
  if (!pid || routesMissing(pid) || onRunner() || !stateReady() || stateTooNew()) return false;
  const { crmFolder } = await crm();
  const dir = crmFolder.dirOf(ws);
  if (!dir) return false;
  const key = await orgoKey();
  if (!key) return false;
  const side = readSide(dir, pid);
  const r = await call<{ files?: RemoteFile[]; at?: string; full?: boolean }>(key, `/api/projects/${encodeURIComponent(pid)}/crm${side.since ? `?since=${encodeURIComponent(side.since)}` : ""}`);
  if (noRoute(r)) {
    missing.set(pid, Date.now() + MISSING_RETRY_MS);
    return false;
  }
  if (!r || r.status !== 200 || !Array.isArray(r.json.files) || projectOf(ws) !== pid) return false;
  pulled.set(ws, Date.now());
  const remote = r.json.files;
  const full = r.json.full === true;
  // What's waiting to go from here wins for now (it settles by the later change when it's sent).
  const busy = new Set(box.waiting(ws).flatMap((e) => [fold(e.item.name), ...(e.item.to ? [fold(e.item.to)] : [])]));
  // Fetched first, outside the lane: what's newer in Orgo than the copy here.
  const fetched = new Map<string, Buffer>();
  const plan: { f: RemoteFile; oldName?: string }[] = [];
  const toTrash: string[] = [];
  const toSend: string[] = [];
  const listedIds = new Set(remote.map((f) => f.id));
  const shaHere = (name: string) => {
    const k = knownOf(side, name);
    const st = crmFolder.files(dir).find((x) => fold(x.name) === fold(name));
    if (!st) return null;
    if (k && k.size === st.size && k.mtimeMs === st.mtimeMs) return k.sha;
    const got = crmFolder.read(dir, name);
    return got ? sha256(got.bytes) : null;
  };
  for (const f of remote) {
    if (!f || typeof f.name !== "string" || busy.has(fold(f.name))) continue;
    // Renamed on another Mac: known here by its id under the old name.
    const byId = Object.values(side.files).find((k) => k.id === f.id && fold(k.name) !== fold(f.name));
    const oldName = byId && !busy.has(fold(byId.name)) ? byId.name : undefined;
    const name = oldName ?? f.name;
    const known = knownOf(side, name);
    const here = shaHere(name);
    if (f.deletedAt) {
      if (here && known && here === known.sha && known.id === f.id) toTrash.push(name);
      else if (!here && known?.id === f.id) delete side.files[fold(name)];
      continue;
    }
    if (here === f.sha256) {
      const st = crmFolder.files(dir).find((x) => fold(x.name) === fold(name));
      side.files[fold(name)] = { id: f.id, name, sha: f.sha256, at: f.updatedAt, size: st?.size ?? 0, mtimeMs: st?.mtimeMs ?? 0 };
      if (oldName || name !== f.name) plan.push({ f, oldName: name });
      continue;
    }
    const unchangedHere = !here || (known && here === known.sha);
    const mtime = crmFolder.files(dir).find((x) => fold(x.name) === fold(name))?.mtimeMs ?? 0;
    if (unchangedHere || (Date.parse(f.updatedAt) || 0) > mtime) {
      const got = await download(key, pid, f.name);
      if (got && got !== "gone") {
        fetched.set(f.id, got.bytes);
        plan.push({ f: got.file, oldName: here ? name : undefined });
      }
    } else toSend.push(name);
  }
  if (full)
    for (const k of Object.values(side.files)) {
      if (listedIds.has(k.id) || busy.has(fold(k.name))) continue;
      // Orgo had it from here and doesn't list it now: deleted there (its trash emptied too).
      if (shaHere(k.name) === k.sha) toTrash.push(k.name);
      else delete side.files[fold(k.name)];
    }
  await crmFolder.lane(dir, async () => {
    for (const name of toTrash) {
      crmFolder.trash(dir, name);
      delete side.files[fold(name)];
    }
    for (const { f, oldName } of plan) {
      const bytes = fetched.get(f.id);
      if (bytes) {
        // This Mac's copy, changed since and older than Orgo's: into .trash first.
        const k = oldName ? knownOf(side, oldName) : undefined;
        const here = oldName ? crmFolder.read(dir, oldName) : null;
        if (here && (!k || sha256(here.bytes) !== k.sha)) crmFolder.trash(dir, oldName!);
        await keepTheirs(dir, side, f, bytes, here && k && sha256(here.bytes) === k.sha ? oldName : undefined);
      } else if (oldName && oldName !== f.name && crmFolder.rename(dir, oldName, f.name)) {
        const k = knownOf(side, oldName);
        delete side.files[fold(oldName)];
        if (k) side.files[fold(f.name)] = { ...k, name: f.name, mtimeMs: crmFolder.files(dir).find((x) => fold(x.name) === fold(f.name))?.mtimeMs ?? k.mtimeMs };
      }
    }
  });
  if (typeof r.json.at === "string") side.since = r.json.at;
  writeSide(dir, side);
  // A file here Orgo never had from this Mac, or not as it is now: sent.
  for (const x of crmFolder.files(dir)) {
    if (busy.has(fold(x.name)) || toSend.includes(x.name)) continue;
    const k = knownOf(side, x.name);
    if (!k || k.name !== x.name || shaHere(x.name) !== k.sha) toSend.push(x.name);
  }
  for (const name of toSend) crmChanged(ws, { put: name });
  // Set up on another Mac already: this one doesn't write the sample.
  if (remote.length || Object.keys(side.files).length) crmFolder.seeded(dir);
  return true;
}

/** The CRM's list is opened: Orgo's copy first, at most every 30 seconds, waiting on Orgo at most a few seconds. */
export async function crmBeforeList(ws: string): Promise<void> {
  if (onRunner() || !projectOf(ws) || Date.now() - (pulled.get(ws) ?? 0) < LIST_EVERY_MS) return;
  await Promise.race([pullCrm(ws), new Promise((r) => setTimeout(r, LIST_WAIT_MS).unref?.())]);
}

/* ---------------- With workspaces ---------------- */

/** The names of a workspace's files here, for its delete's question. */
export async function crmNames(ws: string): Promise<string[]> {
  const { crmFolder } = await crm();
  const dir = crmFolder.dirIfAny(ws);
  return dir ? crmFolder.files(dir).map((f) => f.name) : [];
}

/** A workspace is deleted (its Orgo project with it, CRM files and all): its folder goes from this Mac too, nothing sent. */
export function dropWorkspaceCrm(ws: string) {
  box.done(box.waiting(ws).map((e) => e.id));
  const user = userDir();
  if (!user || !/^ws_[a-z0-9]+$/i.test(ws)) return;
  rmSync(/*turbopackIgnore: true*/ join(/*turbopackIgnore: true*/ user, "crm", ws), { recursive: true, force: true });
  pulled.delete(ws);
}

/** Once a start and sign-in (the state route, on the Mac): each bound workspace's CRM in step with Orgo, and what waited from before sent. */
export function startCrmSync() {
  if (onRunner() || !stateReady() || stateTooNew()) return;
  const key = `${userDir()}\n${stateEpoch()}`;
  if (g.__bopsCrmStarted === key) return;
  g.__bopsCrmStarted = key;
  void (async () => {
    const { crmOn } = await crm();
    if (!crmOn()) return;
    for (const w of getState().workspaces ?? []) if (w.orgoProjectId) await pullCrm(w.id);
    await flush();
  })().catch((e: Error) => console.warn(`[crm] in step with Orgo: ${e.message}`));
}

/** A workspace just got its Orgo project: its files go there (and what's there comes here). */
export function crmBound(ws: string) {
  void pullCrm(ws);
}

/** Tests: send now, read now, forget what was learned. */
export const crmSyncForTests = {
  flush,
  pullCrm,
  waiting: () => box.waiting(),
  side: (dir: string, pid: string) => readSide(dir, pid),
  reset: () => {
    for (const t of [g.__bopsCrmSoon, g.__bopsCrmRetry]) if (t) clearTimeout(t);
    g.__bopsCrmSoon = g.__bopsCrmRetry = undefined;
    g.__bopsCrmTries = 0;
    g.__bopsCrmStarted = undefined;
    missing.clear();
    pulled.clear();
    said.clear();
  },
};
