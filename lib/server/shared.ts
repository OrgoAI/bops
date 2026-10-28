import "server-only";
import { BOPS_DEVICE_HEADER, type MemberAct, type SharedWsState } from "@/cloud/protocol";
import type { SharedOpen, SharedWorkspace } from "@/lib/shared";
import type { AppState } from "@/lib/types";
import { appHeaders } from "./app-version";
import { cloudOn, cloudUrl } from "./cloud";
import { LiveSubscriber, RemoteMoods } from "./live-core";
import { sharedWorkspaces } from "./orgo";
import { orgoKey } from "./orgo-auth";
import { onExit } from "./persist";
import { deviceIdFor } from "./persist-cloud";
import { actWith, SharedCopy, viewState, type ActResult, type ReadResult } from "./shared-core";
import { getState, getVersion, stateUser, touchState } from "./store";

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

/** Whether a workspace shared with the user is open now: the window shows its owner's state, where nothing is the user's to do (a Send among them). */
export const sharedOpen = () => !!openNow();

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
