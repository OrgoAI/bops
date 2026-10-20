import "server-only";
import { deleteSecret, getSecret, setSecret } from "./keychain";
import { onRunner } from "./persist";
import { readRunnerKey } from "./runner-key";
import { bindSignIn, getState, releaseSignOut, update } from "./store";
import { isIdentityToken, tokenRejected, vmIdentity, vmIdentityRejected } from "./vm-identity";

/**
 * Signing in with Orgo. A Bops user is an Orgo user: the app signs in through Orgo's device-code
 * flow (the same one the Orgo CLI and Orgo for Mac use), and the Orgo API key it gets back lives in
 * the Mac's Keychain. Everything Bops does on Orgo (the "bops" workspace, the bots' computers, the
 * account page) runs on that key, so it all lands in the user's own Orgo account and plan.
 *
 * A computer's runner (lib/server/runner.ts) never signs in: it signs in as its computer, with the
 * computer's Orgo identity when it has one (vm-identity.ts: a token for that computer alone, from Orgo's
 * VMM), else its computer's own key, which Orgo wrote there as ORGO_API_KEY (runner-key.ts:
 * /root/.orgo-secrets.env, then /root/.env, root's alone), read from there, again when Orgo turns it
 * down (Orgo may have written a new one since). runnerKey says the order.
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
  /** A runner: its key file as last read (`key`), when it's read again, how long the wait after that is, the key Orgo turned down, and the read under way. */
  bopsRunnerKeyRead?: { next: number; wait: number; key?: string | null; rejected?: string; reading?: Promise<string | null> };
  /** A runner: what it signs in with now (said in its log, which the Mac reads: runner-install.ts), the identity token in use, and the pick under way. */
  bopsRunnerAuth?: { word?: RunnerAuth; identity?: { token: string; expiresAt: number; refreshAt: number; userId: string }; picking?: Promise<string | null>; leave?: (why: string) => void };
};

/** How long a failed Keychain read stands before it's tried again (it may have been locked, or a prompt turned down). */
const RETRY_MS = 10_000;

/** A runner's files read again for its key at most this often after Orgo turned it down, twice as long each time it's the same (or none). */
const REREAD_MIN_MS = 5_000;
const REREAD_MAX_MS = 5 * 60_000;

/** What a runner signs in with: its computer's identity, its key file, or nothing yet. */
export type RunnerAuth = "identity" | "key" | "none";

/**
 * A runner's key file (runner-key.ts readRunnerKey), read once and kept, and read again when Orgo turned
 * it down (orgoKeyRejected: a restore in place or a copy has Orgo write a new one), at most every
 * REREAD_MIN_MS and twice as long each time the files have the same one or none.
 */
function fileKey(): Promise<string | null> {
  const r = (g.bopsRunnerKeyRead ??= { next: 0, wait: REREAD_MIN_MS });
  const had = r.key ?? null;
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
        r.key = k;
      } else {
        r.next = Date.now() + r.wait;
        r.wait = Math.min(REREAD_MAX_MS, r.wait * 2);
        if (!k) r.key = null;
      }
      return r.key ?? null;
    })
    .finally(() => {
      if (r.reading === reading) r.reading = undefined;
    });
  r.reading = reading;
  return reading;
}

const auth = () => (g.bopsRunnerAuth ??= {});

/** Stop this runner now, saving nothing: what it would save or run isn't its to (vmIdentity refused it, or its computer is another account's). */
function leave(why: string) {
  console.error(`[runner] ${why}: stopping`);
  const a = auth();
  if (a.leave) return a.leave(why);
  process.exit(1);
}

/**
 * A runner's credential, in this order (the identity spec 4.2):
 * - its computer's identity (vm-identity.ts) when it has one: a token for this computer alone;
 * - refused (the computer doesn't qualify): nothing at all, never the key file, and the runner stops;
 * - not answering for now: the token in use while it hasn't ended and Orgo hasn't turned it down, else
 *   the key file meanwhile;
 * - none here: the key file (fileKey), as before identity.
 * A token for another user than the state's stops the runner (this computer was given to another
 * account). The credential that changes goes to Bops Cloud too (bindSignIn; for the same user that only
 * swaps the key its calls carry), and what it is now goes in the log as `[runner] auth: identity`,
 * `auth: key` or `auth: none`, at start and on every change. `again`: ask identity and read the files
 * now (a runner waiting for a credential, runner-start.ts; its VM changed, runner.ts).
 */
async function runnerKey({ again = false }: { again?: boolean } = {}): Promise<string | null> {
  const a = auth();
  if (a.picking && !again) return a.picking;
  const picking = pick(again).finally(() => {
    if (a.picking === picking) a.picking = undefined;
  });
  a.picking = picking;
  return picking;
}

async function pick(again: boolean): Promise<string | null> {
  const a = auth();
  const id = await vmIdentity(again ? { again: true } : {});
  let cred: string | null = null;
  let as: RunnerAuth;
  if (id.state === "ok") {
    a.identity = { token: id.token, expiresAt: id.expiresAt, refreshAt: id.refreshAt, userId: id.userId };
    cred = id.token;
    as = "identity";
  } else if (id.state === "refused") {
    takeUp(null, "none");
    leave(`this computer's Orgo identity was refused (${id.reason})`);
    return null;
  } else if (id.state === "transient" && a.identity && performance.now() < a.identity.expiresAt && !tokenRejected(a.identity.token)) {
    cred = a.identity.token;
    as = "identity";
  } else {
    if (again && g.bopsRunnerKeyRead && !g.bopsRunnerKeyRead.reading) g.bopsRunnerKeyRead.next = 0;
    cred = await fileKey();
    as = cred ? "key" : "none";
  }
  if (as === "identity") {
    const user = getState().account?.user.id;
    if (user && a.identity?.userId && a.identity.userId !== user) {
      takeUp(null, "none");
      leave("this computer now belongs to another Orgo account");
      return null;
    }
  }
  takeUp(cred, as);
  return cred;
}

/** The runner's credential is `cred` now: in memory for every call, in Bops Cloud's calls too, and said in the log when what it is changes. */
function takeUp(cred: string | null, as: RunnerAuth) {
  const a = auth();
  const had = g.bopsOrgoKey ?? null;
  if (cred !== had) {
    g.bopsOrgoKey = cred;
    if (cred) {
      g.bopsOrgoKeyMissAt = undefined;
      // The same kind again is a new one written on its computer (a key) or a token refreshed (said by vm-identity.ts, not here).
      if (had && as === "key" && a.word === "key") console.info("[runner] the Orgo key on this computer is a new one: using it");
      const user = getState().account?.user.id;
      if (had && user) void bindSignIn(user, cred).catch((e: Error) => console.warn(`[runner] the new key for Bops Cloud: ${e.message}`));
    } else g.bopsOrgoKeyMissAt = Date.now();
  }
  if (a.word !== as) {
    a.word = as;
    console.info(`[runner] auth: ${as}`);
  }
}

/** On a runner: what it signs in with now (undefined before its first look). */
export const runnerAuth = (): RunnerAuth | undefined => g.bopsRunnerAuth?.word;

/** On a runner waiting for a credential, or whose VM changed: identity asked and the files read now (runnerKey with `again`). */
export const lookForRunnerKey = (): Promise<string | null> => runnerKey({ again: true });

/**
 * Orgo answered 401 to `key` (orgo.ts, orgo-sign-in.ts whoIs), with its `code` when it gave one. On a
 * runner: an identity token is dropped for good and the next call takes the next credential at once
 * (vm-identity.ts vmIdentityRejected: a fresh token, or the key file while identity is off); its key file
 * may have been written again since it was read (fileKey): the next load reads the files again. On the
 * Mac, nothing: a sign-in that's turned down is the user's to make again.
 */
export function orgoKeyRejected(key: string, code?: string) {
  if (!onRunner() || !key) return;
  if (isIdentityToken(key)) return vmIdentityRejected(key, code);
  const r = (g.bopsRunnerKeyRead ??= { next: 0, wait: REREAD_MIN_MS });
  if (key === r.key) r.rejected = key;
}

/** Tests: what a runner does instead of stopping, and forgetting what it signs in with. */
export const orgoAuthForTests = {
  leave: (fn?: (why: string) => void) => void (auth().leave = fn),
  reset: () => {
    delete g.bopsRunnerAuth;
    delete g.bopsRunnerKeyRead;
    delete g.bopsOrgoKey;
  },
};

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

/**
 * The signed-in user's Orgo API key, if it's been loaded (call loadOrgoKey() first on a cold start). On
 * a runner, its credential: an identity token due for its refresh, or turned down, is replaced meanwhile
 * (the calls that read this alone, Bops Cloud's and the models', never wait on it).
 */
export function orgoKey(): string | null {
  const key = g.bopsOrgoKey ?? null;
  const id = g.bopsRunnerAuth?.identity;
  if (key && id?.token === key && (performance.now() >= id.refreshAt || tokenRejected(key)) && onRunner()) void runnerKey().catch(() => {});
  return key;
}

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
