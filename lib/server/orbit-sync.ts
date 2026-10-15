import "server-only";
import { createHash } from "node:crypto";
import { orbitApply, orbitForgetFacts, orbitItemsOf, orbitMerged, orbitOutbox, orbitPushed, orbitRemote, orbitRemoteAt, orbitSent, type OrbitEntry, type OrbitRemoteItem } from "./memory-categories";
import { orbitIssuesApply, orbitIssuesFlush } from "./orbit-issues";
import { cleanText } from "./routine-sync";
import { getState } from "./store";

/**
 * Orbit's metadata in the workspace's Orgo project (orgo-web /api/projects/{id}/orbit), so every Mac of
 * the user's sees the same Orbit. The facts, the card and the chats stay in memory (Honcho); what Orgo
 * keeps is what each Mac's index kept: the items, the ids of the facts and sessions each was learned
 * from, the issues (their history stays in their session), and the keyed hashes of what was forgotten.
 * Private lines never go: an item learned only from them stays on the Mac, and a line that came from one
 * is sent empty.
 *
 * For a workspace with an Orgo project (Workspace.orgoProjectId), after Orbit sorts or changes something
 * (memory-categories.ts save), the items that changed since they were last sent go (PUT …/orbit/items,
 * debounced PUSH_DEBOUNCE_MS, 500 a call); Orgo merges one whose category and key another id has, and
 * the same happens here. When Orbit is opened, and every PULL_EVERY_MS after, what changed there comes
 * (GET …/orbit?since=): items deleted there go first, then the items, the hashes, and the issues
 * (orbit-issues.ts). A Forget sends the delete (DELETE …/orbit/items) and the new hashes (POST
 * …/orbit/tombstones): Orgo answers the facts the items were learned from, and memory deletes them too,
 * besides the ones this Mac knew. Delete everywhere asks Orgo which sessions the item came from
 * (orbitPreview), so the other Macs' chats are listed too.
 *
 * Never in the way: nothing the window or a bot does waits on it (the preview waits PREVIEW_MS at most),
 * every failure is a warning, and Orbit works the same without it. One sync per workspace at a time; a
 * batch Orgo didn't take (no answer, 5xx) is sent again after a backoff (RETRY_MS, doubling). An Orgo
 * without the routes (404 or 405) is asked again at most once every 6 hours. Runs on the signed-in Orgo
 * key; signed out, nothing is sent.
 */

export const PUSH_DEBOUNCE_MS = 5_000;
export const PULL_EVERY_MS = 10 * 60_000;
export const MISSING_RETRY_MS = 6 * 60 * 60_000;
export const RETRY_MS = 60_000;
const RETRY_MAX_MS = 30 * 60_000;
const TIMEOUT_MS = 15_000;
const PREVIEW_MS = 4_000;
/** orgo-web's limits (lib/orbit/body.ts ORBIT_LIMITS). */
const BULK = 500;
const TOMBS = 1000;
const SOURCES = 100;

type Space = { timer?: ReturnType<typeof setTimeout>; push: boolean; pull: boolean; tries: number; opened?: boolean; pulledAt?: number };

const g = globalThis as unknown as {
  __bopsOrbitSync?: Map<string, Space>;
  __bopsOrbitSyncMissing?: Map<string, number>;
  __bopsOrbitSyncInFlight?: Map<string, Promise<void>>;
  __bopsOrbitSyncTimer?: ReturnType<typeof setInterval>;
};
const spaces = (g.__bopsOrbitSync ??= new Map());
/** Orgo projects whose Orgo answered without the routes, and when it may be asked again. */
const missing = (g.__bopsOrbitSyncMissing ??= new Map());
/** The sync going for a workspace: one at a time. */
const inFlight = (g.__bopsOrbitSyncInFlight ??= new Map());

const space = (ws: string): Space => {
  let s = spaces.get(ws);
  if (!s) spaces.set(ws, (s = { push: false, pull: false, tries: 0 }));
  return s;
};

/** The workspace's Orgo project, when it has one and Orgo has the routes (as far as is known). */
export function orbitProject(ws: string): string | null {
  try {
    const p = getState().workspaces?.find((w) => w.id === ws)?.orgoProjectId;
    return p && (missing.get(p) ?? 0) <= Date.now() ? p : null;
  } catch {
    return null;
  }
}

/** Codes orgo-web answers 404 with that are about the thing asked for, not a missing route. */
const FOUND_ROUTE = new Set(["issue_not_found", "item_not_found"]);

/**
 * One call to the workspace's Orbit routes on the signed-in key: its status and JSON; null when Orgo
 * didn't answer or no one is signed in; "off" without an Orgo project or the routes (a 404 or 405 that
 * isn't about the thing asked for, or a workspace that isn't a Bops one there: left alone 6 hours).
 */
export async function orbitCall(
  ws: string,
  method: "GET" | "POST" | "PUT" | "PATCH" | "DELETE",
  path: string,
  body?: unknown,
  timeoutMs = TIMEOUT_MS,
): Promise<{ status: number; json: Record<string, unknown> } | null | "off"> {
  const project = orbitProject(ws);
  if (!project) return "off";
  const { apiKey, callOrgo } = await import("./orgo");
  const key = await apiKey().catch(() => "");
  if (!key) return null;
  const res = await callOrgo<Record<string, unknown>>(key, `/api/projects/${encodeURIComponent(project)}/orbit${path}`, { method, body, timeoutMs });
  if (!res) return null;
  const code = typeof res.json?.code === "string" ? res.json.code : "";
  if (res.status === 405 || (res.status === 404 && !FOUND_ROUTE.has(code)) || (res.status === 409 && code === "not_bops_workspace")) {
    missing.set(project, Date.now() + MISSING_RETRY_MS);
    return "off";
  }
  if (res.status < 300) missing.delete(project);
  return { status: res.status, json: res.json ?? {} };
}

type Reply = { status: number; json: Record<string, unknown> };
const ok = (r: Awaited<ReturnType<typeof orbitCall>>): r is { status: number; json: Record<string, unknown> } => !!r && r !== "off" && r.status < 300;
/** Worth sending again: no answer, or 5xx. */
const retryable = (r: Awaited<ReturnType<typeof orbitCall>>) => r === null || (r !== "off" && r.status >= 500);

const iso = (ms: number | undefined) => (ms !== undefined && Number.isFinite(ms) && ms >= 0 ? new Date(ms).toISOString() : null);
const WHEN = /^\d{4}-\d{2}-\d{2}([T ]\d{2}:\d{2}(:\d{2}(\.\d{1,9})?)?(Z|[+-]\d{2}(:?\d{2})?)?)?$/;
const txt = (s: string | undefined | null, max: number) => (s ? cleanText(s, max) : "");

/**
 * An item as orgo-web takes it, or null for one that stays on this Mac: learned only from private lines,
 * hidden by the user, or not one of Bops's ids. A line from a private line goes empty, and a private
 * fact's source never goes. Sources newest first, 100 at most.
 */
export function itemPayload(bank: string, e: OrbitEntry) {
  const i = e.item;
  if (!/^[0-9a-f]{10}$/.test(i.id) || i.hidden) return null;
  if (i.sources.length > 0 && i.sources.every((s) => s.private)) return null;
  const title = txt(i.title, 300).trim();
  const key = txt(i.key, 300);
  if (!title || !key) return null;
  const sources = e.facts
    .filter((f) => !f.private && f.id.length <= 200)
    .sort((a, b) => b.at - a.at || (a.id < b.id ? -1 : 1))
    .slice(0, SOURCES)
    .map((f) => ({
      honchoConclusionId: f.id,
      honchoSessionId: f.session && f.session.length <= 200 ? f.session : null,
      ...(f.said ? { said: txt(f.said, 500) } : {}),
      ...(iso(f.at) ? { at: iso(f.at) } : {}),
    }));
  const detail = i.detailPrivate ? "" : txt(i.detail, 1000);
  return {
    bopsId: i.id,
    category: i.category,
    key,
    title,
    detail: detail || null,
    whenAt: i.when && WHEN.test(i.when) ? i.when : null,
    done: !!i.done,
    marked: !!i.marked,
    who: txt(i.who, 300) || null,
    honchoBank: bank.slice(0, 200),
    firstSeen: iso(i.first),
    lastSeen: iso(i.last),
    sources,
  };
}

/** What an item is as it would be sent, hashed (what Orgo has of it, when they're the same), or null when it isn't sent. */
export function payloadHash(bank: string, e: OrbitEntry): string | null {
  const p = itemPayload(bank, e);
  if (!p) return null;
  const sorted = { ...p, sources: [...p.sources].sort((a, b) => (a.honchoConclusionId < b.honchoConclusionId ? -1 : 1)) };
  return createHash("sha256").update(JSON.stringify(sorted)).digest("hex").slice(0, 24);
}

/** The forgotten items' deletes and the new hashes: Orgo answers the facts the items came from, and memory deletes those too. */
async function sendOutbox(ws: string): Promise<"off" | "retry" | "ok"> {
  const out = orbitOutbox(ws);
  if (!out) return "ok";
  for (let i = 0; i < out.del.length; i += BULK) {
    const ids = out.del.slice(i, i + BULK);
    const r = await orbitCall(ws, "DELETE", "/items", { bopsIds: ids });
    if (r === "off") return "off";
    if (retryable(r)) return "retry";
    if (ok(r)) {
      const facts = Array.isArray(r.json.honchoConclusionIds) ? r.json.honchoConclusionIds.filter((x): x is string => typeof x === "string") : [];
      if (facts.length) orbitForgetFacts(ws, facts);
    } else console.warn(`[orbit-sync] ${ws}: Orgo answered ${(r as unknown as Reply).status} to a delete`);
    orbitSent(ws, { del: ids });
  }
  for (const kind of ["item", "fact"] as const) {
    const all = kind === "item" ? out.items : out.facts;
    for (let i = 0; i < all.length; i += TOMBS) {
      const hashes = all.slice(i, i + TOMBS).filter((h) => /^[0-9a-f]{64}$/.test(h));
      if (hashes.length) {
        const r = await orbitCall(ws, "POST", "/tombstones", { hashes, kind });
        if (r === "off") return "off";
        if (retryable(r)) return "retry";
        if (!ok(r)) console.warn(`[orbit-sync] ${ws}: Orgo answered ${(r as unknown as Reply).status} to the forgotten hashes`);
      }
      orbitSent(ws, kind === "item" ? { items: all.slice(i, i + TOMBS) } : { facts: all.slice(i, i + TOMBS) });
    }
  }
  return "ok";
}

/** The items that changed since they were last sent. A batch Orgo refuses (400) is sent in halves, so one item can't hold up the rest. */
async function push(ws: string): Promise<"off" | "retry" | "ok"> {
  const ex = orbitItemsOf(ws);
  if (!ex) return "ok";
  const changed: { p: NonNullable<ReturnType<typeof itemPayload>>; h: string }[] = [];
  for (const e of ex.entries) {
    const p = itemPayload(ex.bank, e);
    const h = p && payloadHash(ex.bank, e);
    if (p && h && ex.pushed[p.bopsId] !== h) changed.push({ p, h });
  }
  let merged = false;
  const send = async (batch: typeof changed): Promise<"off" | "retry" | "ok"> => {
    const r = await orbitCall(ws, "PUT", "/items", { items: batch.map((x) => x.p) });
    if (r === "off") return "off";
    if (retryable(r)) return "retry";
    if (ok(r)) {
      orbitPushed(ws, Object.fromEntries(batch.map((x) => [x.p.bopsId, x.h])));
      const m = Array.isArray(r.json.merged) ? r.json.merged.filter((x): x is { bopsId: string; intoBopsId: string } => typeof x?.bopsId === "string" && typeof x?.intoBopsId === "string") : [];
      if (m.length) {
        orbitMerged(ws, m);
        merged = true;
      }
      return "ok";
    }
    if ((r as unknown as Reply).status === 400 && batch.length > 1) {
      const mid = Math.ceil(batch.length / 2);
      const a = await send(batch.slice(0, mid));
      return a === "ok" ? send(batch.slice(mid)) : a;
    }
    // Refused (one item Orgo won't take, or the workspace is full): not sent again until it changes.
    console.warn(`[orbit-sync] ${ws}: Orgo answered ${(r as unknown as Reply).status}${typeof (r as unknown as Reply).json.code === "string" ? ` (${(r as unknown as Reply).json.code})` : ""} to ${batch.length} item${batch.length === 1 ? "" : "s"}`);
    if ((r as unknown as Reply).status === 400) orbitPushed(ws, Object.fromEntries(batch.map((x) => [x.p.bopsId, x.h])));
    return "ok";
  };
  for (let i = 0; i < changed.length; i += BULK) {
    const r = await send(changed.slice(i, i + BULK));
    if (r !== "ok") return r;
  }
  // Merged there: what the item it went into has (another Mac's facts) comes next, before it's sent again.
  if (merged) space(ws).pull = true;
  return "ok";
}

/** What changed in Orgo since the last read (all of it the first time): deleted first, then items, hashes and issues. */
async function pull(ws: string, project: string): Promise<"off" | "retry" | "ok"> {
  const remote = orbitRemote(ws, project);
  const r = await orbitCall(ws, "GET", remote?.at ? `?since=${encodeURIComponent(remote.at)}` : "");
  if (r === "off") return "off";
  if (retryable(r)) return "retry";
  if (!ok(r)) {
    console.warn(`[orbit-sync] ${ws}: Orgo answered ${(r as unknown as Reply).status} to a read`);
    return "ok";
  }
  const j = r.json;
  const arr = (v: unknown) => (Array.isArray(v) ? v : []);
  const deleted = arr(j.deleted) as { kind?: string; bopsId?: string; id?: string }[];
  const full = j.full === true;
  if (remote) {
    const bank = orbitItemsOf(ws)?.bank ?? "";
    orbitApply(
      ws,
      {
        items: arr(j.items) as OrbitRemoteItem[],
        tombstones: arr(j.tombstones) as { hash: string; kind: string; createdAt: string | null }[],
        deleted: deleted.filter((d) => d?.kind === "item" && typeof d.bopsId === "string").map((d) => d.bopsId!),
        full,
      },
      (e) => payloadHash(bank, e),
    );
  }
  await orbitIssuesApply(ws, {
    issues: arr(j.issues) as Record<string, unknown>[],
    deleted: deleted.filter((d) => d?.kind === "issue" && typeof d.id === "string").map((d) => d.id!),
    full,
  });
  if (remote && typeof j.at === "string") orbitRemoteAt(ws, project, j.at);
  space(ws).pulledAt = Date.now();
  return "ok";
}

/** One sync of a workspace: what's forgotten, the issues waiting, what changed there (when due), then what changed here. */
async function flush(ws: string): Promise<void> {
  const sp = space(ws);
  if (sp.timer) clearTimeout(sp.timer);
  sp.timer = undefined;
  const wantPull = sp.pull;
  const wantPush = sp.push;
  sp.pull = sp.push = false;
  const project = orbitProject(ws);
  if (!project) return;
  const again = (pullToo: boolean) => {
    sp.tries++;
    sp.push = true;
    sp.pull ||= pullToo;
    schedule(ws, Math.min(RETRY_MS * 2 ** (sp.tries - 1), RETRY_MAX_MS));
  };
  let r = await sendOutbox(ws);
  if (r === "off") return;
  if (r === "retry") return again(wantPull);
  const issues = await orbitIssuesFlush(ws).catch((e: Error) => (console.warn(`[orbit-sync] ${ws}: issues: ${e.message}`), "retry" as const));
  if (issues === "off") return;
  if (wantPull) {
    r = await pull(ws, project);
    if (r === "off") return;
    if (r === "retry") return again(true);
  }
  if (wantPush || wantPull) {
    r = await push(ws);
    if (r === "off") return;
    if (r === "retry") return again(false);
  }
  if (issues === "retry") return again(false);
  sp.tries = 0;
  // Merged there: read again now, so the next send has what the other Mac knew.
  if (sp.pull) schedule(ws, 0);
}

function start(ws: string): Promise<void> {
  const going = inFlight.get(ws);
  if (going) return going;
  const done = flush(ws)
    .catch((e: Error) => console.warn(`[orbit-sync] ${ws}: ${e.message}`))
    .finally(() => {
      inFlight.delete(ws);
      const sp = spaces.get(ws);
      // Asked for meanwhile and its wait is over: it goes now.
      if (sp && (sp.push || sp.pull) && !sp.timer) void start(ws);
    });
  inFlight.set(ws, done);
  return done;
}

function schedule(ws: string, wait: number) {
  const sp = space(ws);
  if (sp.timer) clearTimeout(sp.timer);
  sp.timer = setTimeout(() => {
    sp.timer = undefined;
    void start(ws);
  }, wait);
  sp.timer.unref?.();
}

/** Something in the workspace's Orbit changed here (memory-categories.ts save): sent to Orgo shortly. */
export function orbitChanged(ws: string) {
  try {
    if (!orbitProject(ws)) return;
    const sp = space(ws);
    sp.push = true;
    // Waiting out a backoff: the change goes with it.
    if (sp.tries > 0 && sp.timer) return;
    schedule(ws, PUSH_DEBOUNCE_MS);
  } catch (e) {
    console.warn(`[orbit-sync] ${(e as Error).message}`);
  }
}

/** The window opened the workspace's Orbit: what changed on the other Macs comes now, then every 10 minutes. */
export function orbitOpened(ws: string) {
  try {
    if (!orbitProject(ws)) return;
    const sp = space(ws);
    ensureTimer();
    if (sp.opened) return;
    sp.opened = true;
    pullSoon(ws);
  } catch (e) {
    console.warn(`[orbit-sync] ${(e as Error).message}`);
  }
}

/** A read of Orgo soon (an issue list, or a workspace opened). */
export function pullSoon(ws: string) {
  if (!orbitProject(ws)) return;
  const sp = space(ws);
  sp.pull = true;
  if (sp.tries > 0 && sp.timer) return;
  schedule(ws, 0);
}

function ensureTimer() {
  if (g.__bopsOrbitSyncTimer) return;
  g.__bopsOrbitSyncTimer = setInterval(() => {
    for (const [ws, sp] of spaces) if (sp.opened && Date.now() - (sp.pulledAt ?? 0) >= PULL_EVERY_MS - 30_000) pullSoon(ws);
  }, PULL_EVERY_MS);
  g.__bopsOrbitSyncTimer.unref?.();
}

/**
 * The sessions Orgo says an item's facts came from, for Delete everywhere (with how many other items
 * each taught, and how many issues keep their history in it). Null when Orgo didn't answer in time or
 * hasn't the item: the preview is then this Mac's alone.
 */
export async function orbitPreview(ws: string, bopsId: string): Promise<{ honchoSessionId: string; otherItems: number; issues: number }[] | null> {
  try {
    const r = await orbitCall(ws, "POST", "/items/delete-everywhere-preview", { bopsId }, PREVIEW_MS);
    if (!ok(r) || !Array.isArray(r.json.sessions)) return null;
    return (r.json.sessions as Record<string, unknown>[])
      .filter((s) => typeof s?.honchoSessionId === "string")
      .map((s) => ({ honchoSessionId: s.honchoSessionId as string, otherItems: Number(s.otherItems) || 0, issues: Number(s.issues) || 0 }));
  } catch {
    return null;
  }
}

/** Tests: run what's waiting now, and forget what was learned. */
export const orbitSyncForTests = {
  flushAll: async () => {
    for (let n = 0; n < 5; n++) {
      for (const ws of [...inFlight.keys()]) await inFlight.get(ws);
      const waiting = [...spaces.entries()].filter(([, sp]) => sp.push || sp.pull);
      if (!waiting.length) return;
      for (const [ws] of waiting) await start(ws);
    }
  },
  start: (ws: string) => start(ws),
  pendingCount: () => [...spaces.values()].filter((sp) => sp.push || sp.pull).length,
  missingUntil: (project: string) => missing.get(project),
  reset: () => {
    for (const sp of spaces.values()) if (sp.timer) clearTimeout(sp.timer);
    spaces.clear();
    missing.clear();
    inFlight.clear();
  },
};
