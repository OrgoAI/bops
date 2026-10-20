import "server-only";
import { brainOf, sharesComputer, workBot, workspaceOf, type AppState } from "@/lib/types";
import { targetNameOf } from "./access-sync";
import { onRunner } from "./persist";
import { cleanText, fit } from "./routine-sync";
import { getState, stateReady, stateTooNew, watchChanges } from "./store";

/**
 * A map of each workspace's Bops in its Orgo project (orgo-web public.bops_bots, bops_resources and
 * bops_watches), so Orgo knows who the bots are and what's whose: each bot and the computer it works on
 * (workBot: its own, or its main bot's), what it owns (its phone line, its inbox, the channels it's in)
 * and what the workspace has (its Connected App accounts, the logins its bots may use, its phone line),
 * and the watches. Orgo wakes the computer of the bot whose routine comes due by it (runner.ts). Names
 * and ids only: no key, password or token is ever in it. Each bot carries the names of the vault keys it
 * may use (Bot.keys: `keys`, orgo-web's bops_bots.secret_names), never a value.
 *
 * The same rules as routine-sync.ts: Bops stays the source and nothing waits on Orgo. A workspace whose
 * map changed sends the whole of it SYNC_DEBOUNCE_MS after the last change in a burst (PUT
 * /api/projects/{id}/bops), and the first look after start sends every one. A map Orgo didn't take for
 * now (no answer, 401, 403, 408, 429, 5xx) is sent again after a backoff; one it refused (a 400) waits for
 * the next change. One flush per workspace at a time. An Orgo without the route (404 or 405) is asked
 * again at most once every 6 hours. Runs on the signed-in Orgo key; signed out, nothing is sent. The map
 * is the Mac's: a computer's Bops runner never sends it. orgo-web takes at most CAPS of each list in one
 * PUT and replaces the whole map with it: past a cap the rest is cut (said in the log; orgo-web's follow-up
 * is a paged PUT), so the same ones are cut each time.
 */

export const SYNC_DEBOUNCE_MS = 2_000;
export const MISSING_RETRY_MS = 6 * 60 * 60_000;
export const RETRY_MS = 60_000;
const RETRY_MAX_MS = 30 * 60_000;
const TIMEOUT_MS = 15_000;
/** orgo-web's caps (lib/bops-map/body.ts MAP_LIMITS): the most of each one PUT sends, and the longest text in each field. */
const CAPS = { bots: 200, resources: 2000, watches: 500 };
const MAX = { id: 128, name: 200, role: 500, ref: 256, app: 128, lookFor: 2000, url: 2048, everyMin: 10080, keys: 200, keyName: 128 };
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

export type MapBot = { bopsId: string; name: string; role: string; isMain: boolean; computer: "own" | "shared"; desktopId: string | null; brain?: string; keys: string[] };
export type MapResource = { kind: "app" | "login" | "phone" | "inbox" | "channel"; ref: string; name: string; app?: string; status?: string; ownerBotId?: string };
export type MapWatch = { bopsId: string; botId: string; kind: "screen" | "page" | "mac"; site: string; lookFor: string; url?: string; everyMin?: number; paused: boolean };
export type BopsMap = { bots: MapBot[]; resources: MapResource[]; watches: MapWatch[] };

type Pending = { timer?: ReturnType<typeof setTimeout>; tries?: number };

const g = globalThis as unknown as {
  __bopsMapSync?: Map<string, Pending>;
  __bopsMapSyncMissing?: Map<string, number>;
  __bopsMapSyncInFlight?: Map<string, Promise<void>>;
  __bopsMapSeen?: Map<string, string>;
  __bopsMapSoon?: ReturnType<typeof setTimeout>;
  __bopsMapStarted?: boolean;
  __bopsMapCutSaid?: Set<string>;
};
const pending = (g.__bopsMapSync ??= new Map());
const missing = (g.__bopsMapSyncMissing ??= new Map());
const inFlight = (g.__bopsMapSyncInFlight ??= new Map());
/** Each workspace's map as last queued, with its project, so only a real change is sent. */
const seen = (g.__bopsMapSeen ??= new Map());

/* ---------------- The map ---------------- */

/** An id Orgo keeps as it is: one cut or cleaned would no longer be the one Bops has, so it isn't sent. */
const keeps = (s: string | undefined, max: number): s is string => !!s && s.length <= max && cleanText(s, max) === s;

/**
 * A workspace's whole map, as orgo-web takes it. Bots with the computer each works on (none when the bots
 * work in browsers on this Mac, state.host "mac"), what's the workspace's (its accounts, the logins one of
 * its bots may use, its phone line) and each bot's own (its line, its inbox, its channels: ownerBotId),
 * each once, and the watches of its bots.
 */
export function bopsMapPayload(wsId: string, s: AppState = getState()): BopsMap {
  const team = s.bots.filter((b) => workspaceOf(b) === wsId && keeps(b.id, MAX.id));
  const ids = new Set(team.map((b) => b.id));
  const bots = team.slice(0, CAPS.bots).map((b): MapBot => {
    const desktop = s.host === "mac" ? undefined : workBot(b, s.bots).computerId;
    const brain = brainOf(b, s)?.id;
    return {
      bopsId: b.id,
      name: fit(b.name ?? "", MAX.name),
      role: fit(b.role ?? "", MAX.role),
      isMain: !!b.isMain,
      computer: sharesComputer(b) ? "shared" : "own",
      desktopId: desktop && UUID.test(desktop) ? desktop.toLowerCase() : null,
      ...(keeps(brain, MAX.id) ? { brain } : {}),
      // Always said, so a key taken away goes from Orgo's copy too (an empty list is none).
      keys: [...new Set(b.keys ?? [])].filter((k) => keeps(k, MAX.keyName)).sort().slice(0, MAX.keys),
    };
  });

  const resources: MapResource[] = [];
  const had = new Set<string>();
  const add = (kind: MapResource["kind"], ref: string | undefined, name: string, more: { app?: string; status?: string; owner?: string } = {}) => {
    if (!keeps(ref, MAX.ref) || had.has(`${kind}:${ref}`)) return;
    had.add(`${kind}:${ref}`);
    resources.push({
      kind,
      ref,
      name: fit(name, MAX.name),
      ...(keeps(more.app, MAX.app) ? { app: more.app } : {}),
      ...(more.status ? { status: more.status } : {}),
      ...(more.owner && ids.has(more.owner) ? { ownerBotId: more.owner } : {}),
    });
  };
  // The workspace's: accounts connected in it, logins one of its bots may use (one only one bot may use is that bot's), its line.
  for (const a of s.accounts ?? []) if (workspaceOf(a) === wsId) add("app", a.id, targetNameOf(a), { app: a.app, status: a.status });
  for (const l of s.vault ?? []) {
    if (l.bots !== "all" && !l.bots.some((b) => ids.has(b))) continue;
    add("login", l.id, `${l.site}, ${l.username}`, { owner: l.bots !== "all" && l.bots.length === 1 ? l.bots[0] : undefined });
  }
  const line = s.workspaces?.find((w) => w.id === wsId)?.line;
  if (line) add("phone", line.numberId, line.phone, { status: "active" });
  // Each bot's own.
  for (const b of team) {
    if (b.phoneLine) add("phone", b.phoneLine.numberId, b.phone ?? "", { status: b.phoneLine.paused ? "paused" : "active", owner: b.id });
    if (b.mail) add("inbox", b.mail.inboxId, b.email ?? "", { status: b.mail.paused ? "paused" : "active", owner: b.id });
  }
  for (const c of s.channels ?? []) if (ids.has(c.botId)) add("channel", c.id, c.handle, { app: c.kind, status: c.status, owner: c.botId });

  const watches: MapWatch[] = [];
  const watched = new Set<string>();
  for (const w of s.watches ?? []) {
    if (!ids.has(w.botId) || !keeps(w.id, MAX.id) || watched.has(w.id)) continue;
    watched.add(w.id);
    const every = w.page && Number.isFinite(w.page.everyMin) ? Math.min(MAX.everyMin, Math.max(1, Math.round(w.page.everyMin))) : undefined;
    watches.push({
      bopsId: w.id,
      botId: w.botId,
      kind: w.mac ? "mac" : w.page ? "page" : "screen",
      site: fit(w.site ?? "", MAX.name),
      lookFor: fit(w.lookFor ?? "", MAX.lookFor),
      // Only a web page has an address and how often it's read.
      ...(!w.mac && w.page && keeps(w.page.url, MAX.url) ? { url: w.page.url } : {}),
      ...(!w.mac && every !== undefined ? { everyMin: every } : {}),
      paused: !!w.paused,
    });
  }
  const cut = [team.length > CAPS.bots && `${team.length} bots (Orgo takes ${CAPS.bots})`, resources.length > CAPS.resources && `${resources.length} resources (${CAPS.resources})`, watches.length > CAPS.watches && `${watches.length} watches (${CAPS.watches})`].filter(Boolean);
  if (cut.length) warnCut(wsId, cut.join(", "));
  return { bots, resources: resources.slice(0, CAPS.resources), watches: watches.slice(0, CAPS.watches) };
}

/** Said once per workspace and run of Bops (the map is built on every look). */
function warnCut(wsId: string, what: string) {
  const said = (g.__bopsMapCutSaid ??= new Set());
  if (said.has(`${wsId}:${what}`)) return;
  said.add(`${wsId}:${what}`);
  console.warn(`[bops-sync] ${wsId}: ${what}; the rest isn't in Orgo's copy`);
}

/* ---------------- Sending ---------------- */

const projectOf = (wsId: string) => getState().workspaces?.find((w) => w.id === wsId)?.orgoProjectId;
const routesMissing = (projectId: string, now = Date.now()) => (missing.get(projectId) ?? 0) > now;
/** Orgo didn't answer, answered 5xx, or for now (signed out, a timeout, too many at once): worth sending again. */
const retryable = (status: number | null) => status === null || status >= 500 || status === 401 || status === 403 || status === 408 || status === 429;

async function send(path: string, body: unknown): Promise<{ status: number } | null> {
  const { apiKey, callOrgo } = await import("./orgo");
  const key = await apiKey().catch(() => "");
  if (!key) return null;
  return callOrgo(key, path, { method: "PUT", body, timeoutMs: TIMEOUT_MS });
}

/** Send a workspace's map as it is now. */
async function flush(wsId: string): Promise<void> {
  const p = pending.get(wsId);
  if (!p) return;
  if (p.timer) clearTimeout(p.timer);
  pending.delete(wsId);
  const projectId = projectOf(wsId);
  // Not sent now: looked at again on the next change, as if never sent (look's `seen`).
  if (!projectId || routesMissing(projectId) || onRunner() || !stateReady() || stateTooNew()) return void seen.delete(wsId);
  const res = await send(`/api/projects/${encodeURIComponent(projectId)}/bops`, bopsMapPayload(wsId));
  const status = res?.status ?? null;
  if (status === 404 || status === 405) {
    missing.set(projectId, Date.now() + MISSING_RETRY_MS);
    // Sent again once Orgo may have the route, on the first change after that.
    seen.delete(wsId);
    return;
  }
  if (status === null || status >= 300) {
    if (status !== null) console.warn(`[bops-sync] ${wsId}: Orgo answered ${status} to the map`);
    if (retryable(status)) queue(wsId, (p.tries ?? 0) + 1);
    return;
  }
  missing.delete(projectId);
}

/** Flush a workspace, one flush at a time: what's queued meanwhile goes right after. */
function start(wsId: string): Promise<void> {
  const going = inFlight.get(wsId);
  if (going) return going;
  const done = flush(wsId)
    .catch((e: Error) => console.warn(`[bops-sync] ${wsId}: ${e.message}`))
    .finally(() => {
      inFlight.delete(wsId);
      const next = pending.get(wsId);
      if (next && !next.timer) void start(wsId);
    });
  inFlight.set(wsId, done);
  return done;
}

/** Send a workspace's map SYNC_DEBOUNCE_MS after the last change, or after a backoff once `tries` didn't get through. */
function queue(wsId: string, tries = 0) {
  const p: Pending = pending.get(wsId) ?? {};
  p.tries = Math.max(p.tries ?? 0, tries);
  if (p.timer) clearTimeout(p.timer);
  p.timer = setTimeout(
    () => {
      p.timer = undefined;
      void start(wsId);
    },
    tries ? Math.min(RETRY_MS * 2 ** (tries - 1), RETRY_MAX_MS) : SYNC_DEBOUNCE_MS,
  );
  p.timer.unref?.();
  pending.set(wsId, p);
}

/** Look for a change in each workspace's map (a bot made, moved or renamed, a line, an inbox, an account, a watch): one that changed is sent shortly. */
function look() {
  if (onRunner() || !stateReady() || stateTooNew()) return;
  const s = getState();
  for (const w of s.workspaces ?? []) {
    if (!w.orgoProjectId || routesMissing(w.orgoProjectId)) continue;
    const sig = `${w.orgoProjectId}\n${JSON.stringify(bopsMapPayload(w.id, s))}`;
    if (seen.get(w.id) === sig) continue;
    seen.set(w.id, sig);
    queue(w.id);
  }
}

/** Start mirroring the map (the state route, on the Mac): every workspace's now, then each one that changes. Never on a runner. */
export function startBopsSync() {
  if (g.__bopsMapStarted || onRunner()) return;
  g.__bopsMapStarted = true;
  // Any change might be one to a map: looked at a moment later, once for a burst of changes.
  watchChanges("bops-sync", () => {
    if (g.__bopsMapSoon) return;
    g.__bopsMapSoon = setTimeout(() => {
      g.__bopsMapSoon = undefined;
      try {
        look();
      } catch (e) {
        console.warn(`[bops-sync] ${(e as Error).message}`);
      }
    }, 500);
    g.__bopsMapSoon.unref?.();
  });
  try {
    look();
  } catch (e) {
    console.warn(`[bops-sync] ${(e as Error).message}`);
  }
}

/** Tests: look now, send what's waiting now, and forget what was learned. */
export const bopsSyncForTests = {
  look,
  flushAll: async () => {
    for (const wsId of [...inFlight.keys()]) await inFlight.get(wsId);
    for (const wsId of [...pending.keys()]) await start(wsId);
  },
  pendingCount: () => pending.size,
  reset: () => {
    for (const p of pending.values()) if (p.timer) clearTimeout(p.timer);
    pending.clear();
    missing.clear();
    inFlight.clear();
    seen.clear();
    if (g.__bopsMapSoon) clearTimeout(g.__bopsMapSoon);
    g.__bopsMapSoon = undefined;
    g.__bopsMapStarted = false;
  },
};
