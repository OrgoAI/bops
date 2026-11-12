import "server-only";
import { BOPS_DEVICE_HEADER, type MemberAct, type SharedKey, type SharedWsState } from "@/cloud/protocol";
import type { SharedOpen, SharedWorkspace } from "@/lib/shared";
import type { AppState } from "@/lib/types";
import { appHeaders } from "./app-version";
import { cloudOn, cloudUrl } from "./cloud";
import { LiveSubscriber, RemoteMoods } from "./live-core";
import { sharedWorkspaces } from "./orgo";
import { orgoKey } from "./orgo-auth";
import { onExit } from "./persist";
import { deviceIdFor } from "./persist-cloud";
import { actWith, SharedCopy, switchedKeys, viewState, type ActResult, type ReadResult } from "./shared-core";
import { getState, getVersion, stateUser, touchState } from "./store";
import { changeBy } from "./change-replay";

/**
 * Workspaces shared with the user (lib/shared.ts; the parts without the server are shared-core.ts), watched,
 * and acted in for the bots the owner gave them Write on (actShared). The switcher lists them (Orgo's list: sharedWorkspaces), and opening one reads it from
 * Bops Cloud (GET /v1/ws/<project>/state) and watches its stream (GET /v1/live?project=): a change reads
 * it again (at most every 5 seconds, PULL_MIN_MS, with one more at the end), its bots' moods come as they
 * happen, and "revoked", 403 or 404 drops the copy and leaves it. Everything of it stays in this
 * process's memory, for the signed-in user and key alone: a sign-out, another sign-in or the app
 * quitting drops it, and it's never in the user's state.
 */

type Open = { user: string; key: string; copy: SharedCopy; moods: RemoteMoods; subscriber: LiveSubscriber };
const g = globalThis as unknown as { bopsShared?: Open | null };

/** The shared workspaces the switcher lists (none while the app isn't on Bops Cloud). */
export async function listShared(): Promise<SharedWorkspace[]> {
  if (!cloudOn()) return [];
  return sharedWorkspaces();
}

/**
 * A read of the workspace from Bops Cloud with `key`: `have` is the copy's hash and seq, so an unchanged one
 * comes back in a line; `older`, a page of one chat's messages before the oldest the copy has of it.
 */
function readerFor(key: string, device: string) {
  return async (projectId: string, have?: string, older?: { chat: string; before: number; beforeId: string }): Promise<ReadResult> => {
    const query = older
      ? `?chat=${encodeURIComponent(older.chat)}&before=${older.before}&beforeId=${encodeURIComponent(older.beforeId)}`
      : have
        ? `?have=${encodeURIComponent(have)}`
        : "";
    const res = await fetch(`${cloudUrl()}/v1/ws/${encodeURIComponent(projectId)}/state${query}`, {
      headers: { Authorization: `Bearer ${key}`, [BOPS_DEVICE_HEADER]: device, ...appHeaders() },
      cache: "no-store",
      signal: AbortSignal.timeout(20_000),
    }).catch(() => null);
    if (!res) return { status: 0 };
    return { status: res.status, body: (await res.json().catch(() => undefined)) as ReadResult["body"] };
  };
}

/**
 * Open a shared workspace (from the switcher), in place of the one open now. Only one of the list Orgo
 * gives the user; the copy is kept only once Bops Cloud let them read it.
 */
export async function openShared(projectId: string): Promise<{ ok: true } | { ok: false; status: number; error: string }> {
  const user = stateUser();
  const key = orgoKey();
  if (!cloudOn() || !user || !key) return { ok: false, status: 409, error: "Sign in with Orgo to open a shared workspace." };
  const w = (await listShared().catch(() => [])).find((x) => x.projectId === projectId);
  if (!w) return { ok: false, status: 404, error: "This workspace isn't shared with you." };
  closeShared();
  const device = deviceIdFor(user);
  const moods = new RemoteMoods(() => touchState());
  const copy = new SharedCopy(readerFor(key, device), {
    onChange: () => touchState(),
    // Revoked, 403 or 404: the copy went with it, and so does its stream.
    onGone: () => g.bopsShared?.copy === copy && closeShared(),
  });
  const subscriber = new LiveSubscriber({
    fetch,
    url: () => `${cloudUrl()}/v1/live?project=${encodeURIComponent(projectId)}`,
    headers: () => (stateUser() === user && orgoKey() === key ? { Authorization: `Bearer ${key}`, [BOPS_DEVICE_HEADER]: device, ...appHeaders() } : null),
    self: () => device,
    pull: () => void copy.refresh(),
    moods,
    revoked: () => copy.gone(),
    // A "state" with the fingerprint the copy has already needs no read; one for messages (seq) has none, so it's read.
    wants: (e) => copy.wants(e.hash),
  });
  const open: Open = { user, key, copy, moods, subscriber };
  const r = await copy.open(w);
  if (!r.ok) return r;
  if (stateUser() !== user || orgoKey() !== key) return { ok: false, status: 409, error: "Someone else signed in. Try again." };
  g.bopsShared = open;
  subscriber.start(projectId);
  touchState();
  return { ok: true };
}

/** A page more of a chat's older messages in the shared workspace open now ("Show earlier messages"): true when some came. */
export async function olderShared(chatId: string): Promise<boolean> {
  const open = openNow();
  return open ? open.copy.older(chatId) : false;
}

/**
 * Something the user does in the shared workspace open now, for a bot the owner gave them Write on: sent to Bops
 * Cloud (POST /v1/ws/<project>/act), which checks it with Orgo and the owner's access and hands it to the owner's
 * Bops. Shown here at once as theirs (SharedCopy.acting), until the copy has the owner's. `key` is theirs for it:
 * the same key sends it again as the same act (Try again), never twice.
 */
export async function actShared(act: MemberAct, key: string): Promise<{ ok: true; key: string; macOn: boolean } | { ok: false; status: number; error: string; code?: string }> {
  const open = openNow();
  if (!open || !open.data.you) return { ok: false, status: 409, error: "Open the workspace again." };
  const device = deviceIdFor(open.user);
  const u = getState().account?.user;
  const me = { userId: open.data.you, ...(u?.email ? { email: u.email } : {}), name: u?.name?.trim() || u?.email?.split("@")[0] || "You" };
  return actWith(open.copy, act, key, me, async (body): Promise<ActResult> => {
    const res = await fetch(`${cloudUrl()}/v1/ws/${encodeURIComponent(open.at.projectId)}/act`, {
      method: "POST",
      headers: { Authorization: `Bearer ${open.key}`, [BOPS_DEVICE_HEADER]: device, ...appHeaders(), "Content-Type": "application/json" },
      body,
      cache: "no-store",
      signal: AbortSignal.timeout(20_000),
    }).catch(() => null);
    if (!res) return { status: 0 };
    return { status: res.status, body: (await res.json().catch(() => undefined)) as ActResult["body"] };
  });
}

/** Leave the shared workspace open now (the user switched to one of their own, or signed out): its copy and stream go. */
export function closeShared() {
  const open = g.bopsShared;
  if (!open) return;
  g.bopsShared = null;
  open.subscriber.stop();
  open.copy.close();
  touchState();
}

/** The shared workspace open now, for the signed-in user and key alone (anyone else's goes). */
function openNow(): (Open & { at: SharedOpen; data: SharedWsState }) | null {
  const open = g.bopsShared;
  if (!open) return null;
  if (open.user !== stateUser() || open.key !== orgoKey()) {
    closeShared();
    return null;
  }
  const at = open.copy.openNow();
  const data = open.copy.data();
  return at && data ? { ...open, at, data } : null;
}

/**
 * Whether a workspace shared with the user is open now: the window shows its owner's state, where nothing is the user's to
 * do (a Send among them). Never while this Mac does someone's change in one of its own workspaces through its own route
 * (change-replay.ts): that's the owner's workspace, whatever the window has open.
 */
export const sharedOpen = () => !changeBy() && !!openNow();

/** The Orgo id of the shared workspace open now (its bots' browsers are asked for by it: lib/server/browser-view.ts), else null. */
export const sharedProjectId = () => openNow()?.at.projectId ?? null;

/**
 * The Orgo computer a bot of the shared workspace open works on, for an Admin (Bops Cloud names it for an Admin alone:
 * SharedWsSlice.screens); null otherwise. Streamed with the user's own Orgo key (app/api/workspaces/shared/screen).
 */
export function sharedScreen(botId: string): string | null {
  const open = openNow();
  if (!open || open.at.role !== "admin") return null;
  const id = open.data.state.screens?.[botId];
  return typeof id === "string" && /^[A-Za-z0-9_-]{1,80}$/.test(id) ? id : null;
}

/**
 * The shared workspace open now, for what an Admin changes there from this Mac (lib/server/shared-people.ts): its Orgo
 * project (never an id from a request), the user's own key and id there, its bots, and a call to its Bops Cloud routes
 * with that key. Null unless an Admin's workspace is open for the signed-in user.
 */
export function sharedAdminOpen({ anyRole = false } = {}): {
  projectId: string;
  key: string;
  you: string;
  botIds: string[];
  orgoUrl?: string;
  cloud: (method: "GET" | "POST" | "PATCH", path: "people" | "routing" | "wake" | "files", body?: unknown) => Promise<{ status: number; json: Record<string, unknown> } | null>;
  refresh: () => Promise<void>;
} | null {
  const open = openNow();
  // (`anyRole`: a Member too, for what Bops Cloud checks of them itself: waking a computer they may use, a file for it.)
  if (!open || (!anyRole && open.at.role !== "admin") || !open.data.you) return null;
  const device = deviceIdFor(open.user);
  return {
    projectId: open.at.projectId,
    key: open.key,
    you: open.data.you,
    botIds: open.data.state.bots.flatMap((b) => (typeof b.id === "string" ? [b.id] : [])),
    ...(open.at.orgoUrl ? { orgoUrl: open.at.orgoUrl } : {}),
    cloud: async (method, path, body) => {
      const res = await fetch(`${cloudUrl()}/v1/ws/${encodeURIComponent(open.at.projectId)}/${path}`, {
        method,
        headers: { Authorization: `Bearer ${open.key}`, [BOPS_DEVICE_HEADER]: device, ...appHeaders(), ...(body !== undefined ? { "Content-Type": "application/json" } : {}) },
        ...(body !== undefined ? { body: JSON.stringify(body) } : {}),
        cache: "no-store",
        signal: AbortSignal.timeout(20_000),
      }).catch(() => null);
      if (!res) return null;
      return { status: res.status, json: ((await res.json().catch(() => null)) as Record<string, unknown> | null) ?? {} };
    },
    refresh: () => open.copy.refresh(),
  };
}

/**
 * The user's role in the shared workspace open now ("admin" or "member": lib/server/bot-files.ts SharedAs, which says
 * Orgo's refusals as theirs), else null.
 */
export function sharedRole(): "admin" | "member" | null {
  const role = openNow()?.at.role;
  return role === "admin" || role === "member" ? role : null;
}

/**
 * Where a file the user adds for a bot of the shared workspace open goes (app/api/bots/files): Bops Cloud's answer to
 * POST /v1/ws/<project>/files (cloud/members.ts filesIn), which checks they may (an Admin, the bot at Write, on a
 * computer of this workspace) and names the owner's computer it works on, woken as a message would wake it
 * (lib/server/bot-files.ts sharedTarget reads it). Never a computer of the user's own bot of that id. Bops Cloud saying
 * they may no longer see the workspace drops the copy, as an act's answer does (shared-core.ts actWith). Null when Bops
 * Cloud couldn't be reached.
 */
export async function sharedFileTarget(botId: string, { screen = false } = {}): Promise<{ status: number; json: Record<string, unknown> } | null> {
  const o = sharedAdminOpen({ anyRole: true });
  if (!o) return { status: 409, json: { error: "Open the workspace again." } };
  if (!o.botIds.includes(botId)) return { status: 404, json: { error: "That bot isn't in this workspace anymore." } };
  const got = await o.cloud("POST", "files", { botId, ...(screen ? { screen: true } : {}) });
  if (got && ((got.status === 404 && got.json.error === "No such workspace") || got.status === 401)) openNow()?.copy.gone();
  return got;
}

/**
 * The shared workspace open now, for its Keys (lib/server/shared-keys.ts): its Orgo project (never an id from a request),
 * whether the user has Keys there (cloud/ws-slice.ts keysOf) and the owner's Bops takes their bots' key switches, the keys
 * its bots see as the owner's Mac last said them (names only), and each bot's keys as switched here (switchedKeys). Null
 * when none is open for the signed-in user.
 */
export function sharedKeysOpen(): {
  projectId: string;
  keys: boolean;
  /** Your Apps at Write: who may link a key to one app (lib/server/app-keys.ts). */
  appsWrite: boolean;
  keyActs: boolean;
  keyNames: SharedKey[];
  bots: { id: string; keys: string[] }[];
  refresh: () => Promise<void>;
} | null {
  const open = openNow();
  if (!open) return null;
  const s = open.data.state;
  const acts = open.copy.acts();
  return {
    projectId: open.at.projectId,
    keys: s.keys === true,
    appsWrite: s.apps?.level === "write",
    keyActs: s.keyActs === true,
    keyNames: s.keys && Array.isArray(s.keyNames) ? s.keyNames : [],
    bots: s.bots.flatMap((b) => (typeof b.id === "string" ? [{ id: b.id, keys: s.keys ? switchedKeys(b, acts) : [] }] : [])),
    refresh: () => open.copy.refresh(),
  };
}

/**
 * The shared workspace open now, for its skills (lib/server/shared-skills.ts): its Orgo project (never an id from a
 * request), the user's role and what they may change there (SharedWsSlice.can), and its bots. Null when none is open for
 * the signed-in user.
 */
export function sharedSkillsOpen(): { projectId: string; name: string; role: "admin" | "member"; can: string[]; botIds: string[] } | null {
  const open = openNow();
  if (!open || (open.at.role !== "admin" && open.at.role !== "member")) return null;
  const s = open.data?.state;
  return {
    projectId: open.at.projectId,
    name: open.at.name,
    role: open.at.role,
    can: Array.isArray(s?.can) ? s.can.filter((x): x is string => typeof x === "string") : [],
    botIds: (Array.isArray(s?.bots) ? s.bots : []).flatMap((b) => (typeof b?.id === "string" ? [b.id] : [])),
  };
}

/**
 * The shared workspace open now, for a change made there from this window (change-relay.ts): the id the window has for it,
 * its bots, what the user may change there (SharedWsSlice.can) and whether the owner's Bops takes it (SharedWsSlice.changes). Null
 * when none is open for the signed-in user.
 */
export function sharedChangesOpen(): { wsId: string; botIds: string[]; can: string[]; changes: boolean } | null {
  const open = openNow();
  if (!open) return null;
  // (What Bops Cloud sent, unchecked: an older one's, or one still loading, may lack any of it.)
  const s = open.data?.state;
  return {
    wsId: open.at.wsId,
    botIds: (Array.isArray(s?.bots) ? s.bots : []).flatMap((b) => (typeof b?.id === "string" ? [b.id] : [])),
    can: Array.isArray(s?.can) ? s.can.filter((x): x is string => typeof x === "string") : [],
    changes: s?.changes === true,
  };
}

/**
 * What the window is shown: with a shared workspace open, its state in place of the user's own
 * workspace (shared-core.ts viewState), with a version of its own (the user's own changes and the
 * copy's both change it); else null.
 */
export function sharedForApp(own: AppState): { version: number; state: AppState } | null {
  const open = openNow();
  if (!open) return null;
  return { version: 2 ** 40 + open.copy.rev * 2 ** 24 + (getVersion() % 2 ** 24), state: viewState(own, open.at, open.data, open.moods.forApp(), open.copy.acts()) };
}

// On the way out, the stream closes.
onExit("shared", async () => closeShared());
