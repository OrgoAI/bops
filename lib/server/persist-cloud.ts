import "server-only";
import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import { existsSync, mkdirSync, readFileSync, renameSync, rmSync, writeFileSync } from "node:fs";
import { homedir, hostname } from "node:os";
import { dirname, join } from "node:path";
import { promisify } from "node:util";
import { gzip } from "node:zlib";
import {
  BOPS_DEVICE_HEADER,
  BOPS_PROTOCOL_HEADER,
  BOPS_USER_HEADER,
  STATE_CONFLICT,
  STATE_PROTOCOL,
  type CloudMessageRow,
  type CloudMessagesPage,
  type CloudState,
  type CloudStateConflict,
  type CloudStateHead,
  type CloudStateSaved,
} from "@/cloud/protocol";
import type { AppState, Message } from "@/lib/types";
import { appHeaders } from "./app-version";
import { cloudUrl } from "./cloud-url";
import { hookExit, onExit, StateLoadError, type Persistence, type StateAccess } from "./persist";
import { applyShared, fromShared, merge3, same, toShared, type Blob } from "./state-merge";
import { moveLegacyState, userDataDir } from "./user-paths";

/**
 * The Mac app's state lives in Bops Cloud, under the signed-in Orgo user (cloud/state.ts). There is
 * no state file: signing in loads the user's state from the cloud, every change goes back up, and
 * signing out lets it go from memory, so the next account to sign in on this Mac starts from its own.
 * Only what the cloud couldn't take yet waits on the Mac, in the user's own folder (see below).
 *
 * - Loading (signIn, before the sign-in lands): the blob (GET /v1/state) and every message, a page at
 *   a time (GET /v1/messages). A user with nothing in the cloud starts fresh, or from this Mac's
 *   state file from before when it's surely theirs (user-paths.ts moveLegacyState: it waits in their
 *   folder as legacy-state.json, and goes once it's uploaded). If the cloud can't be reached, the
 *   sign-in is refused (StateLoadError) and the app says so.
 * - Saving: a second after a change, one save at a time. Each message is written on its own when it's
 *   new or changed (POST /v1/messages), so a long chat isn't sent again for every line; the rest of
 *   the state goes up (PUT /v1/state) only when it changed, over the version this Mac last saw. When
 *   another Mac of the user's wrote first (409), both are merged (state-merge.ts) and written again.
 *   Offline, the state keeps working in memory and the save is retried, waiting longer each time.
 * - Hearing from the user's other Macs: the tunnel says when the state changed (a "state" frame,
 *   cloud-tunnel.ts), and every 30 seconds the head is looked at anyway (only one Mac holds the tunnel).
 *   What changed is merged in, so changes not sent yet are kept.
 * - Signing out, or another account signing in: what's still unsent is kept aside with that user's key
 *   and sent in the background, never into the next user's state.
 * - The cloud out of reach when a save fails, or when Bops quits or restarts: what's unsent is also
 *   written to the user's folder on this Mac (unsent-state.json, with what it was based on), and goes
 *   up at their next sign-in here, merged over what the cloud has by then (their other Macs' changes
 *   stand beside it). It goes once it's all up.
 */

const SAVE_MS = 1000;
/**
 * The blob goes up at most this often, unless a save is waited on (a sign-out, the server stopping):
 * it holds the usage ledger, which changes with every model call, and runs to a few hundred KB gzipped.
 */
const BLOB_EVERY_MS = 5000;
const MAX_RETRY_MS = 60_000;
const ASIDE_MAX_RETRY_MS = 10 * 60_000;
const POLL_MS = 30_000;
const PAGE = 2000;
/** A batch of messages at most this big (the cloud takes 20 MB), and one message at most this big (it takes 256 KB). */
const BATCH_BYTES = 4 * 1024 * 1024;
const MAX_MESSAGE = 250 * 1024;
/** The cloud keeps a removed message's row 30 days: a Mac that hasn't looked for longer reads every message again. */
const REMOVED_KEPT_MS = 25 * 24 * 3600_000;
const REQUEST_MS = 30_000;

const zip = promisify(gzip);

type Who = { user: string; key: string; device: string };
/** What this Mac last synced for a user: where its next read and write start. */
type Sync = Who & {
  /** The blob's version, and the blob, as last read or written (the base for a merge). */
  version: number;
  base: Blob | null;
  /** A fingerprint of the blob as last read or written from this Mac; "" when it must go up. */
  blobHash: string;
  /** Each message as last synced (its fingerprint): one that's different now goes up, one that's gone is removed. */
  msgHashes: Map<string, string>;
  /** The newest message write read. */
  seq: number;
  pulledAt: number;
  /** When the blob last went up. */
  blobAt: number;
  /** The state file from before, uploaded with this state: removed once it's all up. */
  legacyFile?: string;
  /** Changes kept on this Mac while the cloud couldn't take them (keepUnsent): removed once it's all up. */
  unsentFile?: string;
  /** How many times they were kept: a save that began before the last time doesn't cover them. */
  keptCount?: number;
};
/** What's unsent, as kept on this Mac (unsent-state.json): the blob and the messages, and what they were based on. */
type Kept = {
  user: string;
  version: number;
  base: Blob | null;
  msgHashes: [string, string][];
  blob: Blob;
  messages: Message[];
  at: number;
  /** It holds the state file from before (loaded, not yet all up when it was kept). */
  legacy?: boolean;
};
type Aside = { sync: Sync; state: AppState; failures: number; timer?: ReturnType<typeof setTimeout>; sending?: Promise<boolean> };
type Box = {
  sync?: Sync;
  timer?: ReturnType<typeof setTimeout>;
  failures: number;
  /** Loads, saves, reads and sign-outs, one at a time. */
  lane: Promise<unknown>;
  aside: Map<string, Aside>;
  poll?: ReturnType<typeof setInterval>;
  hooked?: boolean;
};

class CallError extends Error {
  status: number;
  constructor(message: string, status: number) {
    super(message);
    this.status = status;
  }
}

/** A fingerprint of a value as this Mac serializes it (the same object, the same text). */
const fp = (v: unknown) => createHash("sha1").update(typeof v === "string" ? v : JSON.stringify(v)).digest("base64");
const byTime = (a: Message, b: Message) => (a.at ?? 0) - (b.at ?? 0);

/* ---------------- This Mac ---------------- */

/** This Mac's hardware id (IOPlatformUUID); BOPS_DEVICE_SEED stands in for it (a test's second Mac). */
function platformId(): string {
  const g = globalThis as unknown as { bopsPlatformId?: string };
  if (g.bopsPlatformId) return g.bopsPlatformId;
  let id = process.env.BOPS_DEVICE_SEED || "";
  if (!id)
    try {
      id = /"IOPlatformUUID"\s*=\s*"([^"]+)"/.exec(execFileSync("ioreg", ["-rd1", "-c", "IOPlatformExpertDevice"], { timeout: 3000 }).toString())?.[1] ?? "";
    } catch {
      /* not a Mac */
    }
  return (g.bopsPlatformId = id || `${hostname()}:${homedir()}`);
}

/** This Mac as the user's state knows it (state.macs): the same Mac is another device for another user. */
export const deviceIdFor = (userId: string) => createHash("sha256").update(`${userId}\n${platformId()}`).digest("hex").slice(0, 16);

/* ---------------- Calls ---------------- */

async function call<T>(who: Who, path: string, init: { method?: string; body?: unknown; text?: string } = {}): Promise<{ status: number; body: T }> {
  const headers: Record<string, string> = {
    Authorization: `Bearer ${who.key}`,
    [BOPS_USER_HEADER]: who.user,
    [BOPS_PROTOCOL_HEADER]: String(STATE_PROTOCOL),
    [BOPS_DEVICE_HEADER]: who.device,
    "Accept-Encoding": "gzip",
    ...appHeaders(),
  };
  let body: Uint8Array<ArrayBuffer> | string | undefined;
  const text = init.text ?? (init.body === undefined ? undefined : JSON.stringify(init.body));
  if (text !== undefined) {
    headers["Content-Type"] = "application/json";
    if (text.length > 32 * 1024) {
      body = new Uint8Array(await zip(text));
      headers["Content-Encoding"] = "gzip";
    } else body = text;
  }
  let res: Response;
  try {
    res = await fetch(`${cloudUrl()}${path}`, { method: init.method ?? "GET", headers, body, cache: "no-store", signal: AbortSignal.timeout(REQUEST_MS) });
  } catch {
    throw new CallError("Couldn't reach Bops Cloud", 0);
  }
  return { status: res.status, body: (await res.json().catch(() => null)) as T };
}

function refused(what: string, r: { status: number; body: unknown }): never {
  const said = (r.body as { error?: unknown } | null)?.error;
  throw new CallError(`${what}: Bops Cloud answered ${r.status}${typeof said === "string" ? ` (${said})` : ""}`, r.status);
}

/* ---------------- Loading ---------------- */

type Loaded = { got: CloudState | null; version: number; rows: CloudMessageRow[]; seq: number };

/** The user's blob and every message they have, from the cloud. */
async function fetchAll(who: Who): Promise<Loaded> {
  const r = await call<CloudState & { version?: number }>(who, "/v1/state");
  if (r.status !== 200 && r.status !== 404) refused("Loading your Bops", r);
  const got = r.status === 200 ? r.body : null;
  const rows: CloudMessageRow[] = [];
  let after = 0;
  for (;;) {
    const p = await call<CloudMessagesPage>(who, `/v1/messages?after=${after}&limit=${PAGE}`);
    if (p.status !== 200) refused("Loading your chats", p);
    rows.push(...p.body.messages.filter((m) => m.json));
    after = p.body.seq;
    if (!p.body.more) break;
  }
  return { got, version: got?.version ?? r.body?.version ?? 0, rows, seq: after };
}

const readJson = (file: string) => {
  try {
    return existsSync(file) ? (JSON.parse(readFileSync(file, "utf8")) as Record<string, unknown>) : null;
  } catch {
    return null;
  }
};

/**
 * The state to start from: the cloud's, with this Mac's state file from before put in when there is
 * one (it was this user's). Where both have something, the file's stands only while the cloud has
 * just a backup from an older build (its newest work may be only in the file); once a build like this
 * one has written the user's state (another Mac of theirs), the cloud's is newer and stands, and the
 * file only adds what the cloud never had. Either way nothing of the cloud's is lost.
 *
 * The state in memory and the base kept for merging are copies of their own: the app changes the
 * state's objects in place, and a base that shared them would change with it, so a merge would take
 * this Mac's unsent changes for ones it never made and drop them.
 */
function build(who: Who, loaded: Loaded, legacy: Record<string, unknown> | null) {
  const messages = loaded.rows.map((r) => r.json as unknown as Message).sort(byTime);
  const cloud = loaded.got?.state ?? null;
  const sync: Sync = { ...who, version: loaded.version, base: cloud ? structuredClone(cloud) : null, blobHash: "", msgHashes: new Map(messages.map((m) => [m.id, fp(m)])), seq: loaded.seq, pulledAt: Date.now(), blobAt: 0 };
  let blob: Blob | null = cloud ? structuredClone(cloud) : null;
  let all = messages;
  if (legacy) {
    const cloudNewer = (loaded.got?.protocol ?? 0) >= STATE_PROTOCOL;
    // A copy, so the file's own messages don't go up as the cloud's blob.
    const mine = JSON.parse(JSON.stringify(toShared(legacy, who.device))) as Blob;
    blob = !blob ? mine : cloudNewer ? merge3(null, blob, mine) : merge3(null, mine, blob);
    const byId = new Map(all.map((m) => [m.id, m]));
    for (const m of Array.isArray(legacy.messages) ? (legacy.messages as Message[]) : [])
      if (m && typeof m.id === "string" && !(cloudNewer && byId.has(m.id))) byId.set(m.id, m);
    all = [...byId.values()].sort(byTime);
  }
  const state = blob || all.length ? { ...fromShared(blob ?? {}, who.device), messages: all } : null;
  return { state, sync };
}

/* ---------------- Unsent, kept on this Mac ---------------- */

const unsentFileOf = (user: string) => join(userDataDir(user), "unsent-state.json");

/** The changes kept on this Mac for this user, if there are (and they're surely this user's). */
function readKept(user: string): Kept | null {
  const k = readJson(unsentFileOf(user)) as Kept | null;
  return k && k.user === user && k.blob && typeof k.blob === "object" && Array.isArray(k.messages) && Array.isArray(k.msgHashes) ? k : null;
}

/**
 * Write what's unsent to the user's folder on this Mac (Bops quitting with the cloud out of reach, or
 * a save that failed): the blob and every message, and what this Mac last synced (the base for a merge,
 * and each message's fingerprint), so the next sign-in sends exactly what changed here.
 */
function keepUnsent(sync: Sync, state: AppState) {
  const file = unsentFileOf(sync.user);
  try {
    mkdirSync(dirname(file), { recursive: true });
    const kept: Kept = {
      user: sync.user,
      version: sync.version,
      base: sync.base,
      msgHashes: [...sync.msgHashes],
      blob: toShared(state as unknown as Blob, sync.device),
      messages: state.messages,
      at: Date.now(),
      legacy: !!sync.legacyFile,
    };
    writeFileSync(`${file}.tmp`, JSON.stringify(kept), { mode: 0o600 });
    renameSync(`${file}.tmp`, file);
    sync.unsentFile = file;
    sync.keptCount = (sync.keptCount ?? 0) + 1;
  } catch (e) {
    console.warn(`[store] keeping ${sync.user}'s unsent changes on this Mac: ${(e as Error).message}`);
  }
}

/**
 * The state to start from when changes were kept on this Mac: the cloud's, with this Mac's changes
 * since its base merged over it, as a save would have (merge3 for the blob; each message new or changed
 * here stands, each removed here goes, the rest are the cloud's). The state file from before isn't
 * read with it (see load).
 */
function buildKept(who: Who, loaded: Loaded, kept: Kept) {
  const rows = loaded.rows.map((r) => r.json as unknown as Message);
  const cloud = loaded.got?.state ?? null;
  const sync: Sync = { ...who, version: loaded.version, base: cloud ? structuredClone(cloud) : null, blobHash: "", msgHashes: new Map(rows.map((m) => [m.id, fp(m)])), seq: loaded.seq, pulledAt: Date.now(), blobAt: 0 };
  const blob = cloud ? merge3(kept.base, kept.blob, structuredClone(cloud)) : kept.blob;
  const synced = new Map(kept.msgHashes);
  const byId = new Map(rows.map((m) => [m.id, m]));
  const here = new Set<string>();
  for (const m of kept.messages) {
    if (!m || typeof m.id !== "string") continue;
    here.add(m.id);
    if (synced.get(m.id) !== fp(m)) byId.set(m.id, m);
  }
  for (const id of synced.keys()) if (!here.has(id)) byId.delete(id);
  return { state: { ...fromShared(blob, who.device), messages: [...byId.values()].sort(byTime) }, sync };
}

/* ---------------- The store ---------------- */

export function cloudStore({ get, replace, touch }: StateAccess): Persistence {
  const g = globalThis as unknown as { __bopsCloudStore?: Box };
  const box: Box = (g.__bopsCloudStore ??= { failures: 0, lane: Promise.resolve(), aside: new Map() });

  /** Run `fn` after whatever is running on the store now. */
  function lane<T>(fn: () => Promise<T>): Promise<T> {
    const run = box.lane.then(fn, fn);
    box.lane = run.catch(() => {});
    return run;
  }

  const shared = (state: AppState, device: string) => JSON.stringify(toShared(state as unknown as Blob, device));

  /** Messages that differ from what was last synced (new or changed), and ids synced but gone. */
  function diff(sync: Sync, state: AppState) {
    const now = new Map<string, string>();
    const upsert: Message[] = [];
    for (const m of state.messages) {
      const h = fp(m);
      now.set(m.id, h);
      if (sync.msgHashes.get(m.id) !== h) upsert.push(m);
    }
    const remove = [...sync.msgHashes.keys()].filter((id) => !now.has(id));
    return { now, upsert, remove };
  }

  function hasUnsent(sync: Sync, state: AppState) {
    const d = diff(sync, state);
    return d.upsert.length > 0 || d.remove.length > 0 || fp(shared(state, sync.device)) !== sync.blobHash;
  }

  /** A message as it goes up: one too big for the cloud goes with its text cut. */
  function forCloud(m: Message): Message {
    let out = m;
    while (Buffer.byteLength(JSON.stringify(out)) > MAX_MESSAGE && out.text.length) out = { ...out, text: out.text.slice(0, Math.floor(out.text.length * 0.8)) };
    return out;
  }

  /** Another Mac's blob (what PUT's 409 or a read brought), merged into `state` over what was last synced. */
  function mergeIn(sync: Sync, state: AppState, theirs: { version: number; state: Blob }) {
    const mine = JSON.parse(shared(state, sync.device)) as Blob;
    const merged = merge3(sync.base, mine, theirs.state);
    // A copy into memory: the merge shares objects with theirs, which is the base from now on (see build()).
    applyShared(state as unknown as Blob, fromShared(structuredClone(merged), sync.device));
    sync.base = theirs.state;
    sync.version = theirs.version;
    // Nothing of this Mac's left to send for the blob, or it goes up next.
    sync.blobHash = same(merged, theirs.state) ? fp(shared(state, sync.device)) : "";
  }

  /**
   * Send what changed in `state` since `sync`: the messages, then the blob. `shown`: the state in
   * memory (another Mac's changes merged in show in the app); else one kept aside. `blobNow`: the blob
   * too, however soon after the last (else it waits for BLOB_EVERY_MS: the answer is how long, 0
   * when nothing waits). Throws when the cloud can't take it; what didn't go is sent next time.
   */
  async function send(sync: Sync, state: () => AppState | null, shown: boolean, blobNow = true): Promise<number> {
    const st = state();
    if (!st) return 0;
    const kept = sync.keptCount;
    const { now, upsert, remove } = diff(sync, st);
    // Batches the cloud takes: a few MB each.
    let batch: { upsert: Message[]; remove: string[] } = { upsert: [], remove };
    let size = 0;
    const flushBatch = async () => {
      if (!batch.upsert.length && !batch.remove.length) return;
      const r = await call<{ seq: number }>(sync, "/v1/messages", { method: "POST", body: { upsert: batch.upsert.map(forCloud), remove: batch.remove } });
      if (r.status !== 200) refused("Saving messages", r);
      for (const m of batch.upsert) sync.msgHashes.set(m.id, now.get(m.id)!);
      for (const id of batch.remove) sync.msgHashes.delete(id);
      batch = { upsert: [], remove: [] };
      size = 0;
    };
    for (const m of upsert) {
      const bytes = JSON.stringify(m).length;
      if (size + bytes > BATCH_BYTES || batch.upsert.length >= PAGE) await flushBatch();
      batch.upsert.push(m);
      size += bytes;
    }
    await flushBatch();

    // Whether everything this save started with is in the cloud (the messages are, by here).
    let up = false;
    for (let tries = 0; tries < 5; tries++) {
      const current = state();
      if (!current) return 0;
      const text = shared(current, sync.device);
      const h = fp(text);
      if (h === sync.blobHash) {
        up = true;
        break;
      }
      const wait = sync.blobAt + BLOB_EVERY_MS - Date.now();
      if (!blobNow && wait > 0) return wait;
      const r = await call<CloudStateSaved | CloudStateConflict>(sync, "/v1/state", { method: "PUT", text: `{"base":${sync.version},"state":${text}}` });
      if (r.status === 200) {
        sync.version = (r.body as CloudStateSaved).version;
        sync.base = JSON.parse(text) as Blob;
        sync.blobHash = h;
        sync.blobAt = Date.now();
        // The state from before is all in the cloud now (its messages went up before the blob): the file goes.
        dropLegacy(sync);
        up = true;
        break;
      }
      const conflict = r.body as CloudStateConflict | null;
      if (r.status !== 409 || conflict?.code !== STATE_CONFLICT) refused("Saving your Bops", r);
      // Another Mac wrote first: theirs and this Mac's together, then written over theirs.
      const target = state();
      if (!target) return 0;
      mergeIn(sync, target, conflict);
      if (shown) touch();
    }
    // What was kept on this Mac while the cloud couldn't take it (before this save began) is all up now:
    // the file goes, so it's never merged in again over newer changes. Changes since go with the next save.
    if (up && sync.keptCount === kept) dropUnsent(sync);
    return 0;
  }

  function dropLegacy(sync: Sync) {
    if (!sync.legacyFile) return;
    rmSync(sync.legacyFile, { force: true });
    console.info(`[store] the state from before is in Bops Cloud now; removed ${sync.legacyFile}`);
    sync.legacyFile = undefined;
  }

  function dropUnsent(sync: Sync) {
    if (!sync.unsentFile) return;
    rmSync(sync.unsentFile, { force: true });
    console.info(`[store] the changes kept on this Mac are in Bops Cloud now; removed ${sync.unsentFile}`);
    sync.unsentFile = undefined;
  }

  /** The live state's save, if it's still this user's (a sign-out or another sign-in drops it). */
  const live = (sync: Sync) => () => (box.sync === sync ? get() : null);

  function retryDelay() {
    return Math.min(MAX_RETRY_MS, 2000 * 2 ** Math.max(0, box.failures - 1));
  }

  function schedule(ms = SAVE_MS) {
    if (box.timer || !box.sync) return;
    box.timer = setTimeout(() => {
      box.timer = undefined;
      const sync = box.sync;
      if (!sync) return;
      void lane(() => send(sync, live(sync), true, false))
        .then((wait) => {
          if (box.failures) console.info(`[store] saving to Bops Cloud again after ${box.failures} failed ${box.failures === 1 ? "try" : "tries"}`);
          box.failures = 0;
          // The blob went up a moment ago: it goes again a little later.
          if (wait > 0 && box.sync === sync) schedule(wait);
        })
        .catch((e: Error) => {
          if (box.sync !== sync) return;
          box.failures++;
          // Keep working from memory; say so on the first failure and then now and then, not every retry.
          if (box.failures === 1 || box.failures % 10 === 0) console.warn(`[store] saving to Bops Cloud failed (${box.failures}x, trying again in ${retryDelay() / 1000}s): ${e.message}`);
          // Also on this Mac, until it's up: Bops may quit (or stop) before the cloud is back.
          keepUnsent(sync, get());
          schedule(retryDelay());
        });
    }, ms);
    box.timer.unref?.();
  }

  /* -------- Reading what another Mac changed -------- */

  /** A message row from the cloud, into the live state: unless this Mac changed that message and hasn't sent it yet. */
  function takeRows(sync: Sync, rows: CloudMessageRow[], seen?: Set<string>) {
    const st = get();
    const byId = new Map(st.messages.map((m) => [m.id, m]));
    const gone = new Set<string>();
    let changed = false;
    for (const row of rows) {
      seen?.add(row.id);
      const local = byId.get(row.id);
      const untouched = !!local && fp(local) === sync.msgHashes.get(row.id);
      if (!row.json) {
        if (local && untouched) {
          gone.add(row.id);
          byId.delete(row.id);
        }
        if (!local || untouched) sync.msgHashes.delete(row.id);
        continue;
      }
      if (!local) {
        const m = row.json as unknown as Message;
        // In time order: almost always at the end.
        let i = st.messages.length;
        while (i > 0 && (st.messages[i - 1].at ?? 0) > (m.at ?? 0)) i--;
        st.messages.splice(i, 0, m);
        byId.set(m.id, m);
        sync.msgHashes.set(m.id, fp(m));
        changed = true;
      } else if (untouched) {
        if (!same(local, row.json)) {
          for (const k of Object.keys(local)) if (!(k in row.json)) delete (local as Record<string, unknown>)[k];
          Object.assign(local, row.json);
          changed = true;
        }
        sync.msgHashes.set(row.id, fp(local));
      }
    }
    if (gone.size) {
      st.messages = st.messages.filter((m) => !gone.has(m.id));
      changed = true;
    }
    return changed;
  }

  /** What changed in the cloud since this Mac last looked: the blob merged in, and the messages. */
  async function pullOnce(sync: Sync) {
    if (box.sync !== sync) return;
    const h = await call<CloudStateHead>(sync, "/v1/state/head");
    if (h.status !== 200) refused("Reading your Bops", h);
    let changed = false;
    if (h.body.version !== sync.version) {
      const r = await call<CloudState>(sync, "/v1/state");
      if (box.sync !== sync) return;
      if (r.status === 200 && r.body.version !== sync.version) {
        mergeIn(sync, get(), r.body);
        changed = true;
      } else if (r.status !== 200 && r.status !== 404) refused("Reading your Bops", r);
    }
    const all = Date.now() - sync.pulledAt > REMOVED_KEPT_MS;
    if (h.body.seq !== sync.seq || all) {
      let after = all ? 0 : sync.seq;
      const seen = all ? new Set<string>() : undefined;
      for (;;) {
        const p = await call<CloudMessagesPage>(sync, `/v1/messages?after=${after}&limit=${PAGE}`);
        if (p.status !== 200) refused("Reading your chats", p);
        if (box.sync !== sync) return;
        changed = takeRows(sync, p.body.messages, seen) || changed;
        after = p.body.seq;
        if (!p.body.more) break;
      }
      if (seen) {
        // Away too long to have heard of every removal: a synced message the cloud no longer has went.
        const st = get();
        const keep = st.messages.filter((m) => seen.has(m.id) || fp(m) !== sync.msgHashes.get(m.id));
        if (keep.length !== st.messages.length) {
          const kept = new Set(keep);
          for (const m of st.messages) if (!kept.has(m)) sync.msgHashes.delete(m.id);
          st.messages = keep;
          changed = true;
        }
      }
      sync.seq = after;
    }
    sync.pulledAt = Date.now();
    if (changed) {
      touch();
      // Merged with changes of this Mac's own: those go up.
      schedule();
    }
  }

  function startPoll() {
    if (box.poll) return;
    box.poll = setInterval(() => {
      const sync = box.sync;
      if (sync && !box.timer) void lane(() => pullOnce(sync)).catch(() => {});
    }, POLL_MS);
    box.poll.unref?.();
  }

  /* -------- Users -------- */

  /** A signed-out user's unsent changes: sent in the background, with their key, until they're up. */
  function sendAside(user: string, delay = 0) {
    const a = box.aside.get(user);
    if (!a || a.timer || a.sending) return;
    a.timer = setTimeout(() => {
      a.timer = undefined;
      a.sending = send(a.sync, () => a.state, false)
        .then(() => {
          if (box.aside.get(user) === a && !hasUnsent(a.sync, a.state)) box.aside.delete(user);
          return true;
        })
        .catch((e: Error) => {
          a.failures++;
          if (a.failures === 1) console.warn(`[store] ${user}'s last changes didn't reach Bops Cloud (${e.message}); trying again`);
          if (box.aside.get(user) === a) keepUnsent(a.sync, a.state);
          return false;
        })
        .finally(() => {
          a.sending = undefined;
          if (box.aside.get(user) === a) sendAside(user, Math.min(ASIDE_MAX_RETRY_MS, 2000 * 2 ** Math.min(Math.max(0, a.failures - 1), 9)));
        });
    }, delay);
    a.timer.unref?.();
  }

  /** Let the user's state go from memory; what's unsent is kept aside and sent. */
  function unload() {
    const sync = box.sync;
    if (box.timer) clearTimeout(box.timer);
    box.timer = undefined;
    box.failures = 0;
    if (!sync) return replace(null);
    const state = get();
    box.sync = undefined;
    replace(null);
    if (hasUnsent(sync, state)) {
      box.aside.set(sync.user, { sync, state, failures: 0 });
      sendAside(sync.user);
    }
  }

  async function load(userId: string, key: string) {
    const who: Who = { user: userId, key, device: deviceIdFor(userId) };
    // Signed out with changes that hadn't gone up: they go now, or this Mac carries on from them.
    const a = box.aside.get(userId);
    if (a) {
      if (a.timer) clearTimeout(a.timer);
      a.timer = undefined;
      a.sync.key = key;
      await a.sending;
      const sent = await send(a.sync, () => a.state, false).then(
        () => !hasUnsent(a.sync, a.state),
        () => false,
      );
      box.aside.delete(userId);
      if (!sent) {
        replace(a.state as unknown as Record<string, unknown>);
        box.sync = a.sync;
        console.info(`[store] ${userId}'s Bops, with changes still to send to Bops Cloud`);
        schedule(0);
        return;
      }
    }
    let loaded: Loaded;
    try {
      loaded = await fetchAll(who);
    } catch (e) {
      throw new StateLoadError((e as Error).message);
    }
    const legacyFile = join(userDataDir(userId), "legacy-state.json");
    // Changes kept on this Mac when Bops last stopped with the cloud out of reach. When they hold the
    // file from before, it goes once they're up; one that came later (an older build run meanwhile) is
    // left for the next sign-in, read then as ever.
    const kept = readKept(userId);
    const legacy = kept ? null : readJson(legacyFile);
    const { state, sync } = kept ? buildKept(who, loaded, kept) : build(who, loaded, legacy);
    replace(state);
    box.sync = sync;
    if (kept) {
      sync.unsentFile = unsentFileOf(userId);
      if (kept.legacy && existsSync(legacyFile)) sync.legacyFile = legacyFile;
      console.info(`[store] sending the changes kept on this Mac to ${userId}'s Bops Cloud`);
    } else if (legacy) {
      sync.legacyFile = legacyFile;
      console.info(`[store] uploading this Mac's state from before to ${userId}'s Bops Cloud`);
    } else if (loaded.got) {
      // Nothing to send for the cloud's own blob, unless it was in an older shape (brought up to date here): then it goes up as it is now.
      const now = shared(get(), sync.device);
      sync.blobHash = same(JSON.parse(now), sync.base) ? fp(now) : "";
    }
    console.info(`[store] loaded ${userId}'s Bops from Bops Cloud (v${sync.version}, ${get().messages.length} messages)`);
    // A new user's first state, the file from before, or what was kept on this Mac: up now.
    schedule(loaded.got && !legacy && !kept ? SAVE_MS : 0);
  }

  async function flushLive(ms: number): Promise<boolean> {
    const sync = box.sync;
    if (!sync) return true;
    if (box.timer) clearTimeout(box.timer);
    box.timer = undefined;
    const done = lane(() => send(sync, live(sync), true)).then(
      () => box.sync !== sync || !hasUnsent(sync, get()),
      (e: Error) => {
        console.warn(`[store] saving to Bops Cloud: ${e.message}`);
        schedule(retryDelay());
        return false;
      },
    );
    return Promise.race([done, new Promise<boolean>((r) => setTimeout(() => r(false), ms).unref?.())]);
  }

  if (!box.hooked) {
    box.hooked = true;
    hookExit();
    // On the way out: the last changes go up (the exit gives this up to 5 seconds), the signed-out ones
    // too. What the cloud didn't take by then is kept on this Mac, for each user's next sign-in here.
    onExit("state", async () => {
      const asides = [...box.aside.values()];
      const sends = [flushLive(3500), ...asides.map((a) => a.sending ?? send(a.sync, () => a.state, false))];
      await Promise.race([Promise.allSettled(sends), new Promise((r) => setTimeout(r, 3500))]);
      const sync = box.sync;
      if (sync && hasUnsent(sync, get())) keepUnsent(sync, get());
      for (const a of asides) if (box.aside.get(a.sync.user) === a && hasUnsent(a.sync, a.state)) keepUnsent(a.sync, a.state);
    });
  }
  startPoll();

  return {
    initial() {
      // The one state file from before goes to its user, to be uploaded at their sign-in; nobody's for sure, it's kept aside.
      const moved = moveLegacyState("legacy-state.json", true);
      if (moved)
        console.info(
          moved.owner ? `[store] the state from before is Orgo user ${moved.owner}'s: it goes to Bops Cloud at their sign-in (${moved.to})` : `[store] the state from before isn't surely anyone's: kept aside, not uploaded (${moved.to})`,
        );
      return null;
    },
    changed: () => schedule(box.failures ? retryDelay() : SAVE_MS),
    backup: () =>
      lane(async () => {
        const sync = box.sync;
        if (!sync) return;
        // The copy is the cloud's: what's changed goes up first.
        await send(sync, live(sync), true).catch(() => {});
        const r = await call(sync, "/v1/state/backups", { method: "POST", body: {} }).catch((e: Error) => ({ status: 0, body: { error: e.message } }));
        if (r.status !== 200 && r.status !== 404) console.warn(`[store] backup before starting over: ${r.status}`);
      }),
    hydrate: async () => {},
    signIn: (userId, key) =>
      lane(async () => {
        if (box.sync?.user === userId) {
          if (key) box.sync.key = key;
          return;
        }
        if (!key) throw new StateLoadError("signing in needs the user's Orgo key to load their state");
        // Whoever's state was here goes first (their unsent changes aside): nobody works on another's.
        unload();
        await load(userId, key);
      }),
    // At once, without waiting on a save in flight: it stops when it sees the user gone, and what's
    // still unsent then is kept aside.
    signOut: async () => {
      const sync = box.sync;
      if (box.timer) clearTimeout(box.timer);
      box.timer = undefined;
      box.failures = 0;
      if (!sync) return replace(null);
      const state = get();
      box.sync = undefined;
      replace(null);
      void lane(async () => {
        if (!hasUnsent(sync, state)) return;
        box.aside.set(sync.user, { sync, state, failures: 0 });
        sendAside(sync.user);
      });
    },
    ready: () => !!box.sync,
    user: () => box.sync?.user ?? null,
    flush: flushLive,
    unsent: () => !!box.sync && (!!box.timer || hasUnsent(box.sync, get())),
    pull: () => {
      const sync = box.sync;
      return sync ? lane(() => pullOnce(sync)).catch((e: Error) => console.warn(`[store] reading from Bops Cloud: ${e.message}`)) : Promise.resolve();
    },
  };
}
