import type { IncomingMessage } from "node:http";
import { query } from "./db.ts";
import { HttpError } from "./http.ts";
import { APP_CLIENT_HEADER, APP_UPDATE_REQUIRED, APP_VERSION_HEADER, IOS_CLIENT } from "./protocol.ts";

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
 *
 * Bops for iPhone says so (APP_CLIENT_HEADER "ios") with its own version numbers. Those never touch the
 * Mac's: they're kept in cloud_accounts.ios_version and ios_seen_at (only for a user the cloud has set up
 * from a Mac: the phone never makes the account row, whose making counts a new Bops user), and held to
 * app_policy.ios_block_below instead of block_below. The phone's calls are only its chat's (cloud/agent.ts).
 */

const VERSION = /^\d{1,4}\.\d{1,4}\.\d{1,6}$/;

/** The version a call says it's from, or null (none, or not one). */
export function appVersionOf(req: IncomingMessage): string | null {
  const h = req.headers[APP_VERSION_HEADER];
  const v = (Array.isArray(h) ? h[0] : h)?.trim();
  return v && VERSION.test(v) ? v : null;
}

/** Whether a call (or a socket) is from Bops for iPhone: it says x-bops-client: ios. */
export function fromIphone(req: IncomingMessage): boolean {
  const h = req.headers[APP_CLIENT_HEADER];
  return (Array.isArray(h) ? h[0] : h)?.trim().toLowerCase() === IOS_CLIENT;
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
  note(`mac:${userId}`, version, "UPDATE bops.cloud_accounts SET app_version = $2, app_seen_at = now() WHERE user_id = $1", userId);
}

/** The same for Bops for iPhone: its own columns, so the Mac's version stays the Mac's. */
export function noteIphoneVersion(userId: string, version: string | null): void {
  note(`ios:${userId}`, version, "UPDATE bops.cloud_accounts SET ios_version = $2, ios_seen_at = now() WHERE user_id = $1", userId);
}

/** Written when it changes, and otherwise at most every few minutes. */
function note(key: string, version: string | null, sql: string, userId: string) {
  const last = noted.get(key);
  if (last && last.version === version && Date.now() - last.at < NOTE_MS) return;
  if (noted.size > 50_000) noted.clear();
  noted.set(key, { version, at: Date.now() });
  void query(sql, [userId, version]).catch((e: Error) => {
    noted.delete(key);
    console.warn(`[cloud] app version: ${e.message}`);
  });
}

export const UPDATE_BOPS = "This version of Bops is too old to keep working. Update it from bops.bot to keep going.";
/** What an iPhone app too old for the cloud is told (it shows its own words, with a way to the App Store). */
export const UPDATE_BOPS_IPHONE = "This version of Bops for iPhone is too old to keep working. Update it to keep going.";

/** Calls an old app still makes: its state's, so nothing it holds is lost. */
const OPEN_TO_OLD_APPS = /^\/v1\/(state|messages)(\/|$)/;

/** The oldest app the cloud serves (bops.app_policy.block_below), as last read; null: every app. */
let blockBelow: string | null = null;
/** The oldest iPhone app it serves (ios_block_below); null: every one. */
let iphoneBlockBelow: string | null = null;

const versionIn = (x: string | null | undefined) => {
  const v = x?.trim();
  return v && VERSION.test(v) ? v : null;
};

/** Read which apps the cloud serves again (every minute: startAppPolicy). Answers the Mac's oldest. */
export async function refreshAppPolicy(): Promise<string | null> {
  const r = await query<{ block_below: string | null; ios_block_below: string | null }>("SELECT block_below, ios_block_below FROM bops.app_policy WHERE id");
  blockBelow = versionIn(r.rows[0]?.block_below);
  iphoneBlockBelow = versionIn(r.rows[0]?.ios_block_below);
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

/** 426 when an iPhone app is older than ios_block_below (or doesn't say). block_below never applies to it. */
export function requireIphoneVersion(version: string | null): void {
  const min = iphoneBlockBelow;
  if (!min) return;
  if (version && !olderThan(version, min)) return;
  throw new HttpError(426, UPDATE_BOPS_IPHONE, { code: APP_UPDATE_REQUIRED });
}

/** For tests: forget which versions were kept. */
export const forgetNotedVersions = () => noted.clear();
