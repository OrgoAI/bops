import type { IncomingMessage } from "node:http";
import { query } from "./db.ts";
import { HttpError } from "./http.ts";
import { APP_UPDATE_REQUIRED, APP_VERSION_HEADER } from "./protocol.ts";

/**
 * Which Bops app each user is on, and keeping old ones out. Every call from the app says its version
 * (APP_VERSION_HEADER, lib/server/app-version.ts); apps before 0.0.18 say nothing. The latest is kept
 * with the user's account: bops.cloud_accounts.app_version (NULL for an app that didn't say) and
 * app_seen_at, written when it changes and otherwise at most every few minutes.
 *
 * With bops.app_policy's block_below set (Orgo's scripts/notices.sh (OrgoAI/bops-secrets) block 0.0.18), an app older than
 * that, or one that doesn't say, is answered 426 (APP_UPDATE_REQUIRED) on every call but its state's
 * (/v1/state, /v1/messages): those still go through, so nothing the old app holds is lost, and the updated
 * app picks it up. Read again every minute, so it takes effect without a deploy.
 */

const VERSION = /^\d{1,4}\.\d{1,4}\.\d{1,6}$/;

/** The version a call says it's from, or null (none, or not one). */
export function appVersionOf(req: IncomingMessage): string | null {
  const h = req.headers[APP_VERSION_HEADER];
  const v = (Array.isArray(h) ? h[0] : h)?.trim();
  return v && VERSION.test(v) ? v : null;
}

/** Whether version `a` comes before `b`, place by place. */
export function olderThan(a: string, b: string): boolean {
  const x = a.split(".").map(Number);
  const y = b.split(".").map(Number);
  for (let i = 0; i < 3; i++) if (x[i] !== y[i]) return x[i] < y[i];
  return false;
}

const NOTE_MS = 5 * 60_000;
const noted = new Map<string, { version: string | null; at: number }>();

/** Keep the version a user's app said (and when), on the side: a failure to keep it never fails the call. */
export function noteAppVersion(userId: string, version: string | null): void {
  const last = noted.get(userId);
  if (last && last.version === version && Date.now() - last.at < NOTE_MS) return;
  if (noted.size > 50_000) noted.clear();
  noted.set(userId, { version, at: Date.now() });
  void query("UPDATE bops.cloud_accounts SET app_version = $2, app_seen_at = now() WHERE user_id = $1", [userId, version]).catch((e: Error) => {
    noted.delete(userId);
    console.warn(`[cloud] app version: ${e.message}`);
  });
}

export const UPDATE_BOPS = "This version of Bops is too old to keep working. Update it from bops.bot to keep going.";

/** Calls an old app still makes: its state's, so nothing it holds is lost. */
const OPEN_TO_OLD_APPS = /^\/v1\/(state|messages)(\/|$)/;

/** The oldest app the cloud serves (bops.app_policy.block_below), as last read; null: every app. */
let blockBelow: string | null = null;

/** Read which apps the cloud serves again (every minute: startAppPolicy). */
export async function refreshAppPolicy(): Promise<string | null> {
  const r = await query<{ block_below: string | null }>("SELECT block_below FROM bops.app_policy WHERE id");
  const v = r.rows[0]?.block_below?.trim();
  blockBelow = v && VERSION.test(v) ? v : null;
  return blockBelow;
}

/** Keep the app policy fresh while the cloud runs. Returns a stop function. */
export function startAppPolicy(): () => void {
  const read = () => void refreshAppPolicy().catch((e: Error) => console.warn(`[cloud] app policy: ${e.message}`));
  read();
  const timer = setInterval(read, 60_000);
  timer.unref?.();
  return () => clearInterval(timer);
}

/**
 * 426 when the app is older than block_below (or doesn't say), except for its state's calls. Through
 * /proxy/openai the words go as OpenAI's SDK reads them ({ error: { message } }); elsewhere as the app
 * reads the cloud's (lib/server/cloud.ts cloudJson: { error: "…" }).
 */
export function requireAppVersion(path: string, version: string | null): void {
  const min = blockBelow;
  if (!min || OPEN_TO_OLD_APPS.test(path)) return;
  if (version && !olderThan(version, min)) return;
  const extra = path.startsWith("/proxy/openai/") ? { error: { message: UPDATE_BOPS, code: APP_UPDATE_REQUIRED } } : {};
  throw new HttpError(426, UPDATE_BOPS, { code: APP_UPDATE_REQUIRED, ...extra });
}

/** For tests: forget which versions were kept. */
export const forgetNotedVersions = () => noted.clear();
