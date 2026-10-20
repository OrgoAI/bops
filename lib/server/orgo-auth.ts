import "server-only";
import { createHash } from "node:crypto";
import { writeFileSync } from "node:fs";
import { deleteSecret, getSecret, setSecret } from "./keychain";
import { onRunner } from "./persist";
import { readRunnerKeyFile, RUNNER_AUTH_FILE } from "./runner-key";
import { bindSignIn, getState, releaseSignOut, update } from "./store";
import { cloudHeld, isIdentityToken, onTurnedDown, tokenRejected, vmIdentity, vmIdentityRejected } from "./vm-identity";

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
 * down (Orgo may have written a new one since). runnerKey says the order. A key file whose key Orgo
 * says isn't this computer's own (an account's key someone put there, an old computer key Orgo never
 * bound to it) isn't used: the runner waits, and the Mac's way back gives the computer its own
 * (runner-install.ts).
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
  /** A runner: its key file as last read (`key`, from `file`), when it's read again, how long the wait after that is, the key Orgo turned down, and the read under way. */
  bopsRunnerKeyRead?: { next: number; wait: number; key?: string | null; file?: string; rejected?: string; reading?: Promise<string | null> };
  /**
   * A runner: what it signs in with now (said in its log and its auth file, which the Mac reads:
   * runner-install.ts), the identity token in use, the key file Bops Cloud gets meanwhile (`cloud`, for
   * the credential `for`: cloudKey), and the pick under way.
   */
  bopsRunnerAuth?: {
    word?: RunnerAuth;
    identity?: { token: string; expiresAt: number; refreshAt: number; userId: string };
    cloud?: { for: string; key: string };
    picking?: Promise<string | null>;
    leave?: (why: string) => void;
    /** Tests: where the auth file is, and Orgo's profile asked (whose key it is). */
    authFile?: string;
    profile?: (key: string) => Promise<{ status: number; body: unknown } | null>;
  };
  /** A runner: whether each key file's key is this computer's own, as Orgo's profile said (by its SHA-256), or the ask under way. */
  bopsRunnerKeyOwn?: Map<string, "own" | "other" | Promise<void>>;
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
  if (had && r.rejected !== had && keyVerdict(had) !== "other") return Promise.resolve(had);
  if (r.reading) return r.reading;
  if (Date.now() < r.next) return Promise.resolve(had && keyVerdict(had) !== "other" ? had : null);
  const reading = readRunnerKeyFile()
    .catch(() => null)
    .then((found) => {
      const k = found?.key ?? null;
      r.rejected = undefined;
      if (k && k !== had && keyVerdict(k) !== "other") {
        r.next = 0;
        r.wait = REREAD_MIN_MS;
        r.key = k;
        r.file = found?.file;
      } else {
        r.next = Date.now() + r.wait;
        r.wait = Math.min(REREAD_MAX_MS, r.wait * 2);
        if (!k) r.key = null;
      }
      return r.key && keyVerdict(r.key) !== "other" ? r.key : null;
    })
    .finally(() => {
      if (r.reading === reading) r.reading = undefined;
    });
  r.reading = reading;
  return reading;
}

const auth = () => (g.bopsRunnerAuth ??= {});

const keyHash = (key: string) => createHash("sha256").update(key).digest("hex");
const keyVerdict = (key: string) => {
  const v = g.bopsRunnerKeyOwn?.get(keyHash(key));
  return typeof v === "string" ? v : undefined;
};

/**
 * What Orgo's profile says of a runner's credential (GET /api/user/profile): "own" when it's this
 * computer's (an identity token's principal, or a key's computer scope, for BOPS_RUNNER_COMPUTER),
 * "other" when it's anyone else's (an account's key, a workspace's, another computer's, a computer key
 * Orgo never bound to one: `computer_key` without the scope), and null when it can't say: an Orgo from
 * before keys were bound to their computers (no `api_key` in its answer), or no answer.
 */
export function profileSaysOurs(body: unknown): "own" | "other" | null {
  const here = process.env.BOPS_RUNNER_COMPUTER?.toLowerCase();
  const o = body && typeof body === "object" ? (body as Record<string, unknown>) : null;
  if (!here || !o) return null;
  const p = o.principal && typeof o.principal === "object" ? (o.principal as Record<string, unknown>) : null;
  if (p) return typeof p.desktop_id === "string" && p.desktop_id.toLowerCase() === here ? "own" : "other";
  if (!("api_key" in o)) return null;
  const k = o.api_key && typeof o.api_key === "object" ? (o.api_key as Record<string, unknown>) : null;
  if (!k) return null;
  return k.scope === "computer" && typeof k.computer_id === "string" && k.computer_id.toLowerCase() === here ? "own" : "other";
}

/** Orgo's profile said a runner's key isn't this computer's own (orgo-sign-in.ts whoIs too): never used, said once, and the next credential taken. */
export function orgoKeyNotOurs(key: string) {
  if (!onRunner() || isIdentityToken(key)) return;
  const own = (g.bopsRunnerKeyOwn ??= new Map());
  if (own.get(keyHash(key)) === "other") return;
  own.set(keyHash(key), "other");
  const r = g.bopsRunnerKeyRead;
  console.warn(`[runner] the ${r?.key === key && r.file ? `ORGO_API_KEY in ${r.file}` : "Orgo key"} isn't this computer's own: not using it, and waiting for its own`);
  if (r?.key === key) r.key = null;
  void runnerKey().catch(() => {});
}

/**
 * Ask Orgo, once per key and in the background, whether a key file's key is this computer's own; until
 * it says, it's used. An Orgo that can't say (from before keys were bound to computers) is taken at its
 * word for this run; no answer, or a 401 (the calls that get one see to it), is asked again next time.
 */
function checkKeyIsOurs(key: string) {
  const own = (g.bopsRunnerKeyOwn ??= new Map());
  const h = keyHash(key);
  if (own.has(h) || !process.env.BOPS_RUNNER_COMPUTER) return;
  const ask =
    auth().profile ??
    (async (k: string) => {
      const res = await fetch(`${orgoOrigin()}/api/user/profile`, { headers: { Authorization: `Bearer ${k}`, Accept: "application/json" }, cache: "no-store", signal: AbortSignal.timeout(10_000) });
      return { status: res.status, body: await res.json().catch(() => null) };
    });
  const asking = ask(key)
    .catch(() => null)
    .then((r) => {
      if (own.get(h) !== asking) return;
      own.delete(h);
      if (!r || r.status >= 300) return;
      if (profileSaysOurs(r.body) === "other") orgoKeyNotOurs(key);
      else own.set(h, "own");
    });
  own.set(h, asking);
}

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
  if (id.state === "copy") {
    // The VMM answered for another computer: a copy of this one (runner.ts takes the runner off it).
    takeUp(null, "none");
    const { leaveCopy } = await import("./runner");
    leaveCopy();
    return null;
  }
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
    if (cred) checkKeyIsOurs(cred);
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
  // Bops Cloud can't take a computer's identity yet (bops_cloud_not_ready): it (and Orgo's profile) gets
  // the key file meanwhile, while Orgo's other calls keep the token. Said as `key`: the runner needs it.
  let cloud = cred;
  if (as === "identity" && cloudHeld()) {
    const file = await fileKey();
    if (file) {
      checkKeyIsOurs(file);
      cloud = file;
    }
  }
  takeUp(cred, as, cloud);
  return cred;
}

/** Where a runner writes what it signs in with (RUNNER_AUTH_FILE), for the Mac's look, which a log rotated past can't lose. */
function writeAuthWord(as: RunnerAuth) {
  const file = auth().authFile ?? RUNNER_AUTH_FILE;
  try {
    writeFileSync(file, `${as}\n`, { mode: 0o600 });
  } catch (e) {
    // No runner's folder here (not set up by the Mac: a test, a runner run by hand): its log says it all.
    if ((e as NodeJS.ErrnoException).code !== "ENOENT") console.warn(`[runner] couldn't write ${file}: ${(e as Error).message}`);
  }
}

/**
 * The runner's credential is `cred` now: in memory for every call, and `cloud` (the same, but while Bops
 * Cloud can't take identity: cloudKey) in Bops Cloud's calls; what it is said in the log and the auth
 * file when it changes.
 */
function takeUp(cred: string | null, as: RunnerAuth, cloud: string | null = cred) {
  const a = auth();
  const had = g.bopsOrgoKey ?? null;
  const hadCloud = a.cloud && a.cloud.for === had ? a.cloud.key : had;
  if (cred !== had) {
    g.bopsOrgoKey = cred;
    if (cred) {
      g.bopsOrgoKeyMissAt = undefined;
      // The same kind again is a new one written on its computer (a key) or a token refreshed (said by vm-identity.ts, not here).
      if (had && as === "key" && a.word === "key") console.info("[runner] the Orgo key on this computer is a new one: using it");
    } else g.bopsOrgoKeyMissAt = Date.now();
  }
  a.cloud = cred && cloud && cloud !== cred ? { for: cred, key: cloud } : undefined;
  const user = getState().account?.user.id;
  if (cloud && hadCloud && cloud !== hadCloud && user) void bindSignIn(user, cloud).catch((e: Error) => console.warn(`[runner] the new key for Bops Cloud: ${e.message}`));
  const word: RunnerAuth = a.cloud ? "key" : as;
  if (a.word !== word) {
    a.word = word;
    console.info(`[runner] auth: ${word}`);
    writeAuthWord(word);
  }
}

/** On a runner: what it signs in with now (undefined before its first look). */
export const runnerAuth = (): RunnerAuth | undefined => g.bopsRunnerAuth?.word;

/** On a runner waiting for a credential, or whose VM changed: identity asked and the files read now (runnerKey with `again`). */
export const lookForRunnerKey = (): Promise<string | null> => runnerKey({ again: true });

// A token turned down anywhere (Orgo, Bops Cloud: vm-identity.ts vmIdentityRejected): the next credential now, not at the next caller's.
onTurnedDown(() => {
  if (onRunner()) void runnerKey().catch(() => {});
});

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

/** Tests: what a runner does instead of stopping, where its auth file goes, Orgo's profile, and forgetting what it signs in with. */
export const orgoAuthForTests = {
  leave: (fn?: (why: string) => void) => void (auth().leave = fn),
  authFile: (file?: string) => void (auth().authFile = file),
  profile: (fn?: (key: string) => Promise<{ status: number; body: unknown } | null>) => void (auth().profile = fn),
  reset: () => {
    const { leave, authFile, profile } = auth();
    delete g.bopsRunnerAuth;
    delete g.bopsRunnerKeyRead;
    delete g.bopsRunnerKeyOwn;
    delete g.bopsOrgoKey;
    Object.assign(auth(), { leave, authFile, profile });
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

/**
 * The credential for Bops Cloud (and Orgo's profile, which Bops Cloud asks): the signed-in key; on a
 * runner whose identity Bops Cloud can't take yet (bops_cloud_not_ready), its key file meanwhile.
 */
export function cloudKey(): string | null {
  const key = orgoKey();
  const c = g.bopsRunnerAuth?.cloud;
  if (!onRunner() || !key || c?.for !== key) return key;
  // Its 10 minutes are up: identity is tried with Bops Cloud again (the key file until that's settled).
  if (!cloudHeld()) void runnerKey().catch(() => {});
  return c.key;
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
