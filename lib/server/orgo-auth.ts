import "server-only";
import { deleteSecret, getSecret, setSecret } from "./keychain";
import { onRunner } from "./persist";
import { readRunnerKey } from "./runner-key";
import { bindSignIn, getState, releaseSignOut, update } from "./store";

/**
 * Signing in with Orgo. A Bops user is an Orgo user: the app signs in through Orgo's device-code
 * flow (the same one the Orgo CLI and Orgo for Mac use), and the Orgo API key it gets back lives in
 * the Mac's Keychain. Everything Bops does on Orgo (the "bops" workspace, the bots' computers, the
 * account page) runs on that key, so it all lands in the user's own Orgo account and plan.
 *
 * A computer's runner (lib/server/runner.ts) never signs in: its key is its computer's own, which Orgo
 * wrote there as ORGO_API_KEY (runner-key.ts: /root/.orgo-secrets.env, then /root/.env, root's alone),
 * and is read from there, again when Orgo turns it down (Orgo may have written a new one since).
 *
 * BOPS_ORGO_ORIGIN points Bops at another Orgo (staging, local); the default is production.
 */

export const orgoOrigin = () => (process.env.BOPS_ORGO_ORIGIN || "https://www.orgo.ai").replace(/\/+$/, "");

const KEY_ACCOUNT = "orgo-api-key";

export type OrgoUser = { id: string; email?: string; name?: string };

// bopsOrgoWorkspace is orgo.ts's cache of the user's "bops" workspace id; a change of user clears it.
const g = globalThis as unknown as {
  bopsOrgoKey?: string | null;
  bopsOrgoKeyLoad?: Promise<string | null>;
  /** When the Keychain last had no key for us (Infinity after a sign-out: there's none until the next sign-in). */
  bopsOrgoKeyMissAt?: number;
  bopsOrgoWorkspace?: unknown;
  /** A runner: when its computer's files are read again for its key, how long the wait after that is, the key Orgo turned down, and the read under way. */
  bopsRunnerKeyRead?: { next: number; wait: number; rejected?: string; reading?: Promise<string | null> };
};

/** How long a failed Keychain read stands before it's tried again (it may have been locked, or a prompt turned down). */
const RETRY_MS = 10_000;

/** A runner's files read again for its key at most this often after Orgo turned it down, twice as long each time it's the same (or none). */
const REREAD_MIN_MS = 5_000;
const REREAD_MAX_MS = 5 * 60_000;

/**
 * A runner's key: its computer's own (runner-key.ts readRunnerKey), read once and kept, and read again
 * when Orgo turned it down (orgoKeyRejected: a restore in place or a copy has Orgo write a new one), at
 * most every REREAD_MIN_MS and twice as long each time the files have the same one or none. A new one
 * goes to Bops Cloud too (the user's state is the same account's). None there: none, so it runs nothing.
 */
function runnerKey(): Promise<string | null> {
  const r = (g.bopsRunnerKeyRead ??= { next: 0, wait: REREAD_MIN_MS });
  const had = g.bopsOrgoKey ?? null;
  if (had && r.rejected !== had) return Promise.resolve(had);
  if (r.reading) return r.reading;
  if (Date.now() < r.next) return Promise.resolve(had);
  const reading = readRunnerKey()
    .catch(() => null)
    .then((k) => {
      r.rejected = undefined;
      if (k && k !== had) {
        r.next = 0;
        r.wait = REREAD_MIN_MS;
        g.bopsOrgoKey = k;
        g.bopsOrgoKeyMissAt = undefined;
        const user = getState().account?.user.id;
        if (had) console.info("[runner] the Orgo key on this computer is a new one: using it");
        if (had && user) void bindSignIn(user, k).catch((e: Error) => console.warn(`[runner] the new key for Bops Cloud: ${e.message}`));
      } else {
        r.next = Date.now() + r.wait;
        r.wait = Math.min(REREAD_MAX_MS, r.wait * 2);
        if (!k) {
          g.bopsOrgoKey = null;
          g.bopsOrgoKeyMissAt = Date.now();
        }
      }
      return g.bopsOrgoKey ?? null;
    })
    .finally(() => {
      if (r.reading === reading) r.reading = undefined;
    });
  r.reading = reading;
  return reading;
}

/**
 * Orgo answered 401 to `key` (orgo.ts, orgo-sign-in.ts whoIs). On a runner, its computer's key may have
 * been written again since it was read (runnerKey): the next load reads the files again. On the Mac,
 * nothing: a sign-in that's turned down is the user's to make again.
 */
export function orgoKeyRejected(key: string) {
  if (!onRunner() || !key || key !== g.bopsOrgoKey) return;
  (g.bopsRunnerKeyRead ??= { next: 0, wait: REREAD_MIN_MS }).rejected = key;
}

/** Read the signed-in key from the Keychain (a runner: its computer's, runnerKey): once per server process, and again a little later if it wasn't there. */
export function loadOrgoKey(): Promise<string | null> {
  if (onRunner()) return runnerKey();
  if (g.bopsOrgoKey) return Promise.resolve(g.bopsOrgoKey);
  if (g.bopsOrgoKey === null && Date.now() - (g.bopsOrgoKeyMissAt ?? 0) < RETRY_MS) return Promise.resolve(null);
  const load = (g.bopsOrgoKeyLoad ??= getSecret(KEY_ACCOUNT).then((k) => {
    // A sign-in or sign-out while this read was out has the last word.
    if (g.bopsOrgoKeyLoad !== load) return g.bopsOrgoKey ?? null;
    g.bopsOrgoKeyLoad = undefined;
    g.bopsOrgoKey = k || null;
    if (!k) g.bopsOrgoKeyMissAt = Date.now();
    return g.bopsOrgoKey;
  }));
  return load;
}

function setKey(key: string | null) {
  g.bopsOrgoKey = key;
  g.bopsOrgoKeyLoad = undefined;
  g.bopsOrgoKeyMissAt = key ? undefined : Infinity;
  g.bopsOrgoWorkspace = undefined;
}

/** The signed-in user's Orgo API key, if it's been loaded (call loadOrgoKey() first on a cold start). */
export const orgoKey = (): string | null => g.bopsOrgoKey ?? null;

/** Who's signed in (kept in state so the UI can show it without a round trip). */
export const signedInUser = (): OrgoUser | null => getState().account?.user ?? null;

export async function signIn(apiKey: string, user: OrgoUser) {
  if (onRunner()) throw new Error("Sign in from the Bops app on your Mac.");
  const before = signedInUser();
  const was = keyNow();
  // First this user's own state is loaded (from Bops Cloud, their file, or Postgres): the sign-in is refused if it can't be.
  await bindSignIn(user.id, apiKey);
  // Their key comes in with their state, at once, before the Keychain is written: background work (the
  // 10-minute look at the bots' computers, routing through this Mac, a screen's view) never runs on the
  // last user's key over this one's state. A computer of theirs that the last key can't see would look
  // deleted, and be let go.
  setKey(apiKey);
  try {
    await setSecret(KEY_ACCOUNT, apiKey);
  } catch (e) {
    // The key that's still in use is the one before; so must the state be, or one user's key would run over another's state.
    await giveBack(before, was);
    throw e;
  }
  update((s) => {
    s.account = { user, signedInAt: Date.now() };
    // Running out of AI credit was the last account's.
    s.credits = undefined;
  });
}

/** The key in memory as it stands (to put back as it was: giveBack). */
const keyNow = () => ({ key: g.bopsOrgoKey, missAt: g.bopsOrgoKeyMissAt });

/** Undo a sign-in's swap of the state: back to whoever was signed in, or to nobody's. */
async function giveBack(before: OrgoUser | null, was: ReturnType<typeof keyNow>) {
  const beforeKey = was.key ?? null;
  try {
    await releaseSignOut();
    // Nobody's state is in memory now: the key before comes back with it, before theirs loads.
    setKey(beforeKey);
    g.bopsOrgoKey = was.key;
    g.bopsOrgoKeyMissAt = was.missAt;
    if (before) {
      await bindSignIn(before.id, beforeKey ?? undefined);
      update((s) => (s.account = { user: before, signedInAt: s.account?.signedInAt ?? Date.now() }));
    }
  } catch (e) {
    // Couldn't put it back: drop the old key from memory too, so nothing runs on it over the wrong state.
    // It's read again later (authStatus then binds its user's state first).
    console.error(`[sign-in] couldn't go back to the state before: ${(e as Error).message}`);
    setKey(null);
    g.bopsOrgoKeyMissAt = Date.now();
  }
}

export async function signOut() {
  if (onRunner()) throw new Error("Sign out from the Bops app on your Mac.");
  await releaseSignOut();
  await deleteSecret(KEY_ACCOUNT);
  setKey(null);
  update((s) => {
    s.account = undefined;
    s.credits = undefined;
  });
}
