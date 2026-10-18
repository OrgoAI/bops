import "server-only";
import { randomBytes } from "node:crypto";
import { existsSync, mkdirSync, readFileSync, renameSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { accessIsDefault, levelOf, workspaceOf, type AccessUse, type AppAccount, type LastUses } from "@/lib/types";
import { cleanText } from "./routine-sync";
import { bot, getState, session, stateReady, userDir, watchChanges } from "./store";

/**
 * Who may use what, and what they used. Bops keeps which bot may use which Connected App account, API key
 * and login (Bot.access, Bot.keys, VaultLogin.bots); this mirrors each workspace's whole effective set to
 * its Orgo project (orgo-web public.bops_access), so Orgo can show each agent's permissions: every bot
 * of the workspace times every account, key and login, with its level and whether it's the default.
 * Every use of an app or a key by a bot or one of its threads is logged too: the last LOG_KEEP on this
 * Mac (<userDir>/access-log.json, for the Vault's "last used" line), and each one to Orgo
 * (public.bops_access_log).
 *
 * The same rules as routine-sync.ts: Bops stays the source and nothing waits on Orgo. A change is sent
 * SYNC_DEBOUNCE_MS after the last one in a burst (PUT /api/projects/{id}/access, the whole set), and
 * logged uses go with it (POST /api/projects/{id}/access/log, LOG_BATCH at a time). A batch Orgo didn't
 * take for now (no answer, 401, 403, 408, 429, 5xx) is sent again after a backoff; one it refused (a 400)
 * is held and goes with the next change. One flush per workspace at a time. An Orgo without the routes
 * (404 or 405) is asked again at most once every 6 hours. Runs on the signed-in Orgo key; signed out,
 * nothing is sent.
 */

export const SYNC_DEBOUNCE_MS = 2_000;
export const MISSING_RETRY_MS = 6 * 60 * 60_000;
export const RETRY_MS = 60_000;
const RETRY_MAX_MS = 30 * 60_000;
const TIMEOUT_MS = 15_000;
/** The most grants one PUT sends, and logged uses one POST sends (orgo-web's caps). */
const MAX_GRANTS = 2000;
const LOG_BATCH = 200;
/** The longest text orgo-web takes in each field (lib/bops-access/body.ts ACCESS_LIMITS): a longer one fails the whole call. */
const MAX = { target: 256, name: 200, action: 200, viaId: 128 };
/** The most uses kept waiting for one workspace (the newest), and kept on this Mac. */
const MAX_USES_WAITING = 500;
export const LOG_KEEP = 500;

/** One grant as orgo-web takes it: a bot, one account, key or login, and how far it may go there. */
export type AccessGrant = { bot: string; botName: string; kind: "app" | "key" | "login"; target: string; targetName: string; level: "none" | "read" | "act"; isDefault: boolean };

/** Where a use happened, as the callers know it: a chat (and why it ran: a routine, a call) or a thread. */
export type UseWhere = { chatId?: string; sessionId?: string; via?: AccessUse["via"]; viaId?: string };

type Pending = { timer?: ReturnType<typeof setTimeout>; grants: boolean; uses: AccessUse[]; tries?: number };

const g = globalThis as unknown as {
  __bopsAccessSync?: Map<string, Pending>;
  __bopsAccessSyncMissing?: Map<string, number>;
  __bopsAccessSyncInFlight?: Map<string, Promise<void>>;
  __bopsAccessSyncHeld?: Map<string, Pick<Pending, "grants" | "uses">>;
  __bopsAccessSeen?: Map<string, string>;
  __bopsAccessSoon?: ReturnType<typeof setTimeout>;
  __bopsAccessLog?: { file: string | null; uses: AccessUse[]; timer?: ReturnType<typeof setTimeout> };
};
const pending = (g.__bopsAccessSync ??= new Map());
const missing = (g.__bopsAccessSyncMissing ??= new Map());
const inFlight = (g.__bopsAccessSyncInFlight ??= new Map());
const held = (g.__bopsAccessSyncHeld ??= new Map());
/** Each workspace's set as last queued, so only a real change is sent. */
const seen = (g.__bopsAccessSeen ??= new Map());

/* ---------------- The set ---------------- */

/** Text cut to `max` UTF-16 units, as orgo-web counts (cleanText counts characters), never leaving half an emoji. */
function fit(text: string, max: number) {
  const t = cleanText(text, max);
  if (t.length <= max) return t;
  const end = t.charCodeAt(max - 1) >= 0xd800 && t.charCodeAt(max - 1) <= 0xdbff ? max - 1 : max;
  return t.slice(0, end);
}

/** An account as the user sees it: "Gmail, tiger@orgo.ai" (its label and name), else the app's name. */
export function targetNameOf(a: AppAccount) {
  const title = [a.label, a.name].filter(Boolean).join(" · ");
  return title && title !== a.appName ? `${a.appName}, ${title}` : a.appName;
}

/**
 * A workspace's whole effective set, as orgo-web takes it: each of its bots with every account connected
 * there or that one of them may use (levelOf, the default unless the user set it), every key (`keyNames`,
 * the vault's, and any a bot has) and every login one of them may use. Keys and logins are "act" or
 * "none". A key is the default when no bot was given it; a login when it's for every bot.
 */
export function accessPayload(wsId: string, keyNames: string[] = []): AccessGrant[] {
  const s = getState();
  const team = s.bots.filter((b) => workspaceOf(b) === wsId);
  const out: AccessGrant[] = [];
  const row = (b: (typeof team)[number], kind: AccessGrant["kind"], target: string, targetName: string, level: AccessGrant["level"], isDefault: boolean) =>
    out.push({ bot: b.id, botName: fit(b.name, MAX.name), kind, target: fit(target, MAX.target), targetName: fit(targetName, MAX.name), level, isDefault });
  // Another workspace's accounts and logins (their names) stay out, unless a bot here may use one.
  for (const a of s.accounts ?? []) {
    if (workspaceOf(a) !== wsId && !team.some((b) => levelOf(b, a))) continue;
    for (const b of team) row(b, "app", a.id, targetNameOf(a), levelOf(b, a) ?? "none", accessIsDefault(b, a));
  }
  const keys = [...new Set([...keyNames, ...team.flatMap((b) => b.keys ?? [])])].sort();
  for (const k of keys)
    for (const b of team) {
      const on = !!b.keys?.includes(k);
      row(b, "key", k, k, on ? "act" : "none", !on);
    }
  for (const l of s.vault ?? []) {
    if (l.bots !== "all" && !team.some((b) => l.bots.includes(b.id))) continue;
    for (const b of team) {
      const on = l.bots === "all" || l.bots.includes(b.id);
      row(b, "login", l.id, `${l.site}, ${l.username}`, on ? "act" : "none", l.bots === "all");
    }
  }
  return out;
}

/** A logged use as orgo-web takes it. */
export const usePayload = (u: AccessUse) => ({
  bot: u.bot,
  kind: u.kind,
  target: fit(u.target, MAX.target),
  targetName: fit(u.targetName, MAX.name),
  // Never empty: orgo-web refuses that (a call_api with no method or path).
  action: fit(u.action, MAX.action) || "unknown",
  via: u.via,
  ...(u.viaId ? { viaId: fit(u.viaId, MAX.viaId) } : {}),
  outcome: u.outcome,
  ...(u.approvedBy ? { approvedBy: u.approvedBy } : {}),
  at: new Date(u.at).toISOString(),
});

/* ---------------- Sending ---------------- */

const projectOf = (wsId: string) => getState().workspaces?.find((w) => w.id === wsId)?.orgoProjectId;
const routesMissing = (projectId: string, now = Date.now()) => (missing.get(projectId) ?? 0) > now;
/** Orgo didn't answer, answered 5xx, or for now (signed out, a timeout, too many at once): worth sending again. */
const retryable = (status: number | null) => status === null || status >= 500 || status === 401 || status === 403 || status === 408 || status === 429;

async function send(method: "PUT" | "POST", path: string, body: unknown): Promise<{ status: number; json: unknown } | null> {
  const { apiKey, callOrgo } = await import("./orgo");
  const key = await apiKey().catch(() => "");
  if (!key) return null;
  return callOrgo(key, path, { method, body, timeoutMs: TIMEOUT_MS });
}

/** The vault's key names a workspace sees (keys.ts), or none when Orgo can't say: the bots' own keys still go. */
async function vaultKeys(wsId: string): Promise<string[]> {
  try {
    const { keysOf, listKeys } = await import("./keys");
    return keysOf(await listKeys(), wsId).map((k) => k.name);
  } catch {
    return [];
  }
}

function requeue(wsId: string, p: Pending, uses = p.uses, grants = p.grants) {
  const tries = (p.tries ?? 0) + 1;
  queue(
    wsId,
    (q) => {
      q.grants ||= grants;
      q.uses = [...uses, ...q.uses].slice(-MAX_USES_WAITING);
      q.tries = Math.max(q.tries ?? 0, tries);
    },
    Math.min(RETRY_MS * 2 ** (tries - 1), RETRY_MAX_MS),
  );
}

/** A batch Orgo refused: not sent again as it is, but it goes with the next change. */
function hold(wsId: string, grants: boolean, uses: AccessUse[]) {
  const h = held.get(wsId);
  held.set(wsId, { grants: grants || !!h?.grants, uses: [...(h?.uses ?? []), ...uses].slice(-MAX_USES_WAITING) });
}

/** Send what's waiting for a workspace: its set when it changed, then its logged uses. */
async function flush(wsId: string): Promise<void> {
  const p = pending.get(wsId);
  if (!p) return;
  if (p.timer) clearTimeout(p.timer);
  pending.delete(wsId);
  const projectId = projectOf(wsId);
  if (!projectId || routesMissing(projectId)) return;
  const base = `/api/projects/${encodeURIComponent(projectId)}/access`;
  if (p.grants) {
    const all = accessPayload(wsId, await vaultKeys(wsId));
    if (all.length > MAX_GRANTS) console.warn(`[access-sync] ${wsId}: ${all.length} grants, Orgo takes ${MAX_GRANTS}; the rest aren't mirrored`);
    const res = await send("PUT", base, { grants: all.slice(0, MAX_GRANTS) });
    const status = res?.status ?? null;
    if (status === 404 || status === 405) {
      missing.set(projectId, Date.now() + MISSING_RETRY_MS);
      return;
    }
    if (status === null || status >= 300) {
      if (status !== null) console.warn(`[access-sync] ${wsId}: Orgo answered ${status} to the access set`);
      if (retryable(status)) requeue(wsId, p);
      else hold(wsId, true, p.uses);
      return;
    }
    missing.delete(projectId);
  }
  for (let i = 0; i < p.uses.length; i += LOG_BATCH) {
    const res = await send("POST", `${base}/log`, { entries: p.uses.slice(i, i + LOG_BATCH).map(usePayload) });
    const status = res?.status ?? null;
    if (status === 404 || status === 405) {
      missing.set(projectId, Date.now() + MISSING_RETRY_MS);
      return;
    }
    if (status === null || status >= 300) {
      if (status !== null) console.warn(`[access-sync] ${wsId}: Orgo answered ${status} to the use log`);
      if (retryable(status)) requeue(wsId, p, p.uses.slice(i), false);
      else hold(wsId, false, p.uses.slice(i));
      return;
    }
    missing.delete(projectId);
  }
}

/** Flush a workspace, one flush at a time: what's queued meanwhile goes right after. */
function start(wsId: string): Promise<void> {
  const going = inFlight.get(wsId);
  if (going) return going;
  const done = flush(wsId)
    .catch((e: Error) => console.warn(`[access-sync] ${wsId}: ${e.message}`))
    .finally(() => {
      inFlight.delete(wsId);
      const next = pending.get(wsId);
      if (next && !next.timer) void start(wsId);
    });
  inFlight.set(wsId, done);
  return done;
}

/** Gather a change for a workspace and send it all `wait` after the last one. */
function queue(wsId: string, add: (p: Pending) => void, wait = SYNC_DEBOUNCE_MS) {
  const p: Pending = pending.get(wsId) ?? { grants: false, uses: [] };
  const h = held.get(wsId);
  if (h) {
    held.delete(wsId);
    p.grants ||= h.grants;
    p.uses = [...h.uses, ...p.uses].slice(-MAX_USES_WAITING);
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
 * Look for a change in each workspace's set (a bot made, renamed or deleted, its access, an account, a
 * login): a workspace whose set changed is sent shortly. The first look after start sends every one.
 */
function look() {
  if (!stateReady()) return;
  for (const w of getState().workspaces ?? []) {
    if (!w.orgoProjectId || routesMissing(w.orgoProjectId)) continue;
    const sig = `${w.orgoProjectId}\n${JSON.stringify(accessPayload(w.id))}`;
    if (seen.get(w.id) === sig) continue;
    seen.set(w.id, sig);
    queue(w.id, (p) => (p.grants = true));
  }
}

// Any change might be one to the set: looked at a moment later, once for a burst of changes.
watchChanges("access-sync", () => {
  if (g.__bopsAccessSoon) return;
  g.__bopsAccessSoon = setTimeout(() => {
    g.__bopsAccessSoon = undefined;
    try {
      look();
    } catch (e) {
      console.warn(`[access-sync] ${(e as Error).message}`);
    }
  }, 500);
  g.__bopsAccessSoon.unref?.();
});

/** The vault's keys changed (one saved or removed, keys.ts), which the state doesn't show: every workspace's set goes again. */
export function accessChanged() {
  try {
    for (const w of getState().workspaces ?? []) if (w.orgoProjectId && !routesMissing(w.orgoProjectId)) queue(w.id, (p) => (p.grants = true));
  } catch (e) {
    console.warn(`[access-sync] ${(e as Error).message}`);
  }
}

/* ---------------- The use log ---------------- */

const logFile = () => {
  const dir = userDir();
  return dir ? join(/*turbopackIgnore: true*/ dir, "access-log.json") : null;
};

/** The uses kept on this Mac, for the account signed in (another sign-in has another folder). */
function logOf() {
  const file = logFile();
  const had = g.__bopsAccessLog;
  if (had && had.file === file) return had;
  let uses: AccessUse[] = [];
  if (file && existsSync(/*turbopackIgnore: true*/ file)) {
    try {
      const read = JSON.parse(readFileSync(/*turbopackIgnore: true*/ file, "utf8")) as { uses?: AccessUse[] };
      if (Array.isArray(read?.uses)) uses = read.uses.slice(-LOG_KEEP);
    } catch {
      // Only a log: it starts again.
    }
  }
  if (had?.timer) clearTimeout(had.timer);
  g.__bopsAccessLog = { file, uses };
  return g.__bopsAccessLog;
}

/** Write the log a moment after a use, once for a burst. */
function saveSoon() {
  const log = logOf();
  if (!log.file || log.timer) return;
  log.timer = setTimeout(() => {
    log.timer = undefined;
    if (!log.file || g.__bopsAccessLog !== log) return;
    mkdirSync(/*turbopackIgnore: true*/ join(/*turbopackIgnore: true*/ log.file, ".."), { recursive: true, mode: 0o700 });
    const tmp = `${log.file}.${randomBytes(4).toString("hex")}.tmp`;
    try {
      writeFileSync(/*turbopackIgnore: true*/ tmp, JSON.stringify({ uses: log.uses }), { mode: 0o600 });
      renameSync(/*turbopackIgnore: true*/ tmp, log.file);
    } catch (e) {
      rmSync(/*turbopackIgnore: true*/ tmp, { force: true });
      console.warn(`[access-sync] keeping the log: ${(e as Error).message}`);
    }
  }, 1000);
  log.timer.unref?.();
}

/** Where a use ran: as the caller said (a chat turn for a routine or a call), else a routine's thread, a thread, or a chat. */
export function viaOf(w: UseWhere): Pick<AccessUse, "via" | "viaId"> {
  if (w.via) return { via: w.via, ...(w.viaId ? { viaId: w.viaId } : {}) };
  const s = w.sessionId ? session(w.sessionId) : undefined;
  if (s?.routineId) return { via: "routine", viaId: s.routineId };
  if (w.sessionId) return { via: "thread", viaId: w.sessionId };
  return { via: "chat" };
}

/** Only the chat and thread of a UseWhere, for an approval card (AppApproval). */
export const placeOf = (w: UseWhere) => ({ ...(w.chatId ? { chatId: w.chatId } : {}), ...(w.sessionId ? { sessionId: w.sessionId } : {}) });

/** A bot (or a thread of its) used an app account or a key: kept here, and sent to its workspace's Orgo project. Never throws. */
export function logUse(u: Omit<AccessUse, "at">) {
  try {
    const use: AccessUse = { ...u, targetName: cleanText(u.targetName, 300), action: cleanText(u.action, 300), at: Date.now() };
    const log = logOf();
    log.uses.push(use);
    if (log.uses.length > LOG_KEEP) log.uses.splice(0, log.uses.length - LOG_KEEP);
    saveSoon();
    const b = bot(u.bot);
    if (!b) return;
    const wsId = workspaceOf(b);
    const projectId = projectOf(wsId);
    if (!projectId || routesMissing(projectId)) return;
    queue(wsId, (p) => {
      p.uses.push(use);
      if (p.uses.length > MAX_USES_WAITING) p.uses.splice(0, p.uses.length - MAX_USES_WAITING);
    });
  } catch (e) {
    console.warn(`[access-sync] ${(e as Error).message}`);
  }
}

/** When each account or key was last used, and by which of `botIds` (one that worked), newest first. */
export function lastUses(botIds: Set<string>): LastUses {
  const out: LastUses = {};
  const uses = logOf().uses;
  for (let i = uses.length - 1; i >= 0; i--) {
    const u = uses[i];
    if (u.outcome === "ok" && botIds.has(u.bot) && !out[u.target]) out[u.target] = { bot: u.bot, at: u.at };
  }
  return out;
}

/** Tests: send what's waiting now, and forget what was learned. */
export const accessSyncForTests = {
  look,
  flushAll: async () => {
    for (const wsId of [...inFlight.keys()]) await inFlight.get(wsId);
    for (const wsId of [...pending.keys()]) await flush(wsId);
  },
  pendingCount: () => pending.size,
  reset: () => {
    for (const p of pending.values()) if (p.timer) clearTimeout(p.timer);
    pending.clear();
    missing.clear();
    inFlight.clear();
    held.clear();
    seen.clear();
  },
};
