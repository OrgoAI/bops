import "server-only";
import { deleteSecret, getSecret, setSecret } from "./keychain";
import { bindSignIn, getState, releaseSignOut, update } from "./store";

/**
 * Signing in with Orgo. A Bops user is an Orgo user: the app signs in through Orgo's device-code
 * flow (the same one the Orgo CLI and Orgo for Mac use), and the Orgo API key it gets back lives in
 * the Mac's Keychain. Everything Bops does on Orgo (the "bops" workspace, the bots' computers, the
 * account page) runs on that key, so it all lands in the user's own Orgo account and plan.
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
};

/** How long a failed Keychain read stands before it's tried again (it may have been locked, or a prompt turned down). */
const RETRY_MS = 10_000;

/** Read the signed-in key from the Keychain: once per server process, and again a little later if it wasn't there. */
export function loadOrgoKey(): Promise<string | null> {
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
  const before = signedInUser();
  // A hosted server first loads this user's own state (and refuses the sign-in if it can't).
  await bindSignIn(user.id);
  try {
    await setSecret(KEY_ACCOUNT, apiKey);
  } catch (e) {
    // The key that's still in use is the one before; so must the state be, or one user's key would run over another's state.
    await giveBack(before);
    throw e;
  }
  setKey(apiKey);
  update((s) => {
    s.account = { user, signedInAt: Date.now() };
    // Running out of AI credit was the last account's.
    s.credits = undefined;
  });
}

/** Undo a sign-in's swap of the state (hosted): back to whoever was signed in, or to nobody's. */
async function giveBack(before: OrgoUser | null) {
  try {
    await releaseSignOut();
    if (before) {
      await bindSignIn(before.id);
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
  await releaseSignOut();
  await deleteSecret(KEY_ACCOUNT);
  setKey(null);
  update((s) => {
    s.account = undefined;
    s.credits = undefined;
  });
}
