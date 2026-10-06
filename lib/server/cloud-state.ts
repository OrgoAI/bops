import "server-only";
import { promisify } from "node:util";
import { gzip } from "node:zlib";
import type { CloudStateBody } from "@/cloud/protocol";
import type { AppState } from "@/lib/types";
import { CloudError, cloudFetch, cloudJson, cloudOn } from "./cloud";
import { signedInUser } from "./orgo-auth";
import { getState, restoreState, update, watchChanges } from "./store";

/**
 * The app's state, backed up to Bops Cloud (PUT /v1/state, gzipped) while the app works through it
 * (lib/server/cloud.ts): the cloud keeps it for the user, and reads it to answer calls while the Mac
 * is away. A change goes up 30 seconds after it happens, with whatever else changed meanwhile, and
 * the latest goes up once more when the server stops or the user signs out. Nothing goes up signed
 * out or self-hosting.
 *
 * Restoring, and whose state is whose. A state with real content is never overwritten, on either side:
 * - The cloud's copy replaces this Mac's only when this Mac is a fresh install (freshInstall: the
 *   main bot alone, nothing said to it, nothing made or set up) and the copy has real content.
 * - This Mac uploads only once it has checked the cloud for the signed-in user (state.cloudUser), so
 *   a fresh Mac that couldn't reach the cloud at sign-in doesn't replace a backup it hasn't restored.
 *   A state with real content and no owner yet is claimed by the first user it's checked for.
 * - A state checked for another Orgo account is neither uploaded for this one nor replaced by theirs:
 *   the desktop app keeps its state across sign-ins, and one person's isn't backed up as another's.
 */

const UPLOAD_AFTER_MS = 30_000;
/** After a failed upload the next try waits longer each time: 1, 2, 4 minutes, up to 10. */
const MAX_RETRY_MS = 10 * 60_000;

type Backup = {
  timer?: ReturnType<typeof setTimeout>;
  /** Changed since the last upload. */
  dirty: boolean;
  sending?: Promise<void>;
  failures: number;
  checking?: Promise<void>;
  /** How long after a change it goes up (shortened by tests). */
  delayMs: number;
};
const g = globalThis as unknown as { bopsCloudBackup?: Backup };
const backup: Backup = (g.bopsCloudBackup ??= { dirty: false, failures: 0, delayMs: UPLOAD_AFTER_MS });

const zip = promisify(gzip);

/** The signed-in user's id, when this state goes up for them (see above). */
function owner() {
  const user = signedInUser();
  return cloudOn() && user && getState().cloudUser === user.id ? user.id : null;
}

function schedule(ms: number) {
  backup.timer = setTimeout(() => {
    backup.timer = undefined;
    void upload().catch(() => {});
  }, ms);
  backup.timer.unref?.();
}

watchChanges("cloud-backup", () => {
  backup.dirty = true;
  if (!backup.timer && owner()) schedule(backup.delayMs);
});

/** The state as it's kept in the cloud: each bot's key for app actions stays on this Mac (a new one is made on a restore). */
const forBackup = (s: AppState): AppState => ({ ...s, bots: s.bots.map((b) => ({ ...b, appsKey: undefined })) });

async function upload(): Promise<void> {
  await backup.sending?.catch(() => {});
  if (!backup.dirty || !owner()) return;
  backup.dirty = false;
  // The version is when this copy was made (ms), so a later copy always has a larger one.
  const body: CloudStateBody = { version: Date.now(), state: forBackup(getState()) };
  const sending = (async () => {
    const res = await cloudFetch("/v1/state", { method: "PUT", headers: { "Content-Type": "application/json", "Content-Encoding": "gzip" }, body: new Uint8Array(await zip(JSON.stringify(body))) });
    if (!res.ok) throw new CloudError(`Bops Cloud didn't take it (${res.status})`, res.status);
  })();
  backup.sending = sending;
  try {
    await sending;
    backup.failures = 0;
  } catch (e) {
    backup.dirty = true;
    const wait = Math.min(MAX_RETRY_MS, 60_000 * 2 ** backup.failures++);
    console.warn(`[cloud] state backup: ${(e as Error).message}. Trying again in ${Math.round(wait / 60_000)} min.`);
    if (backup.timer) clearTimeout(backup.timer);
    schedule(wait);
    throw e;
  } finally {
    if (backup.sending === sending) backup.sending = undefined;
  }
  // What changed while it went up goes next.
  if (backup.dirty && !backup.timer && owner()) schedule(backup.delayMs);
}

/** Send what's changed now, not in 30 seconds: before a sign-out, and on the way out. */
export async function flushBackup() {
  if (backup.timer) clearTimeout(backup.timer);
  backup.timer = undefined;
  await upload();
}

/** For tests: how long after a change the state goes up. */
export const setBackupDelayForTests = (ms: number) => void (backup.delayMs = ms);

/**
 * Nothing the user made or said yet: the main bot alone in one workspace, no message from them, no
 * task, routine or watch, and nothing saved, connected or verified. (The name from Orgo and the
 * bots' first inboxes come by themselves, so they don't count.) Read as raw JSON too, so every field may be missing.
 */
export function freshInstall(s: Partial<AppState>) {
  return (
    (s.bots?.length ?? 0) <= 1 &&
    (s.workspaces?.length ?? 0) <= 1 &&
    !s.messages?.some((m) => m.role === "user") &&
    !s.sessions?.length &&
    !s.routines?.length &&
    !s.watches?.length &&
    !s.vault?.length &&
    // A backup from before several accounts per app still has `apps`.
    !Object.keys((s as { apps?: object }).apps ?? {}).length &&
    !s.accounts?.length &&
    !s.channels?.length &&
    !s.ownerPhones?.length &&
    !s.ownerEmails?.length &&
    !s.owner?.about?.trim() &&
    !s.bots?.some((b) => b.phone) &&
    !s.workspaces?.some((w) => w.line)
  );
}

/**
 * Once per Orgo user on this Mac, when the app starts working through the cloud for them (a sign-in,
 * the server starting, the tunnel coming back): restore the cloud's copy onto a fresh install, or
 * claim this Mac's state for them, by the rules above. When the cloud can't be reached it's asked
 * again next time, and nothing goes up until then.
 */
export function checkBackup(): Promise<void> {
  return (backup.checking ??= check().finally(() => (backup.checking = undefined)));
}

async function check() {
  const user = signedInUser();
  const st = getState();
  if (!cloudOn() || !user || st.cloudUser === user.id) return;
  if (!freshInstall(st)) {
    if (st.cloudUser) console.warn("[cloud] this Mac's state is backed up for another Orgo account, so it isn't backed up for this one");
    else update((s) => void (s.cloudUser = user.id));
    return;
  }
  const saved = await cloudJson<CloudStateBody>("/v1/state").catch((e: CloudError) => {
    if (e.status === 404) return null;
    throw e;
  });
  // Signed out, someone else signed in, or the user got started meanwhile: decided next time.
  if (!cloudOn() || signedInUser()?.id !== user.id || getState().cloudUser === user.id || !freshInstall(getState())) return;
  const copy = saved?.state && typeof saved.state === "object" ? (saved.state as Record<string, unknown>) : null;
  const restore = !!copy && !freshInstall(copy as Partial<AppState>);
  if (restore) restoreState(copy);
  update((s) => void (s.cloudUser = user.id));
  if (!restore) return;
  // What was just restored is the cloud's own copy: nothing new to send.
  console.info("[cloud] restored this Mac from its backup");
  if (backup.timer) clearTimeout(backup.timer);
  backup.timer = undefined;
  backup.dirty = false;
}
