import "server-only";
import { execFile } from "node:child_process";
import { hostname } from "node:os";
import { startCloud } from "./cloud-tunnel";
import { orgo } from "./orgo";
import { loadOrgoKey, orgoOrigin, signedInUser, signIn, type OrgoUser } from "./orgo-auth";
import { onPostgres } from "./persist";
import { relayAfterSignIn } from "./relay";
import { stopAllSessions } from "./sessions";
import { bindSignIn, getState, update } from "./store";

/**
 * Sign in with Orgo: Orgo's device-code flow (orgo-web app/api/cli/auth), the one `orgo login` and
 * Orgo for Mac use. Start asks Orgo for a code; the user approves it on orgo.ai in their browser;
 * polling picks up the API key Orgo mints for this Mac ("CLI on <this Mac's name>", account-wide).
 *
 * The device code is the proof that collects the key, so it stays here on the server; the app only
 * ever sees the short code to compare and the page to open. One sign-in at a time per install.
 */

export type SignInStart = { userCode: string; verificationUrl: string; expiresAt: number; interval: number };
export type SignInPoll = { status: "pending" | "approved" | "denied" | "expired" | "none"; user?: OrgoUser };

/** What went wrong, in the words the app shows: Orgo couldn't be reached, Orgo answered with an error, or the Keychain refused the key. */
export type SignInProblem = "offline" | "orgo" | "keychain";
export class SignInError extends Error {
  constructor(
    readonly reason: SignInProblem,
    detail: string,
  ) {
    super(detail);
  }
}

/** A failed step, for the app: only the kind of problem goes out (it picks the words); the details go to the server log. */
export function signInProblem(e: unknown) {
  console.error(`[sign-in] ${(e as Error).message}`);
  return Response.json({ error: e instanceof SignInError ? e.reason : "orgo" }, { status: 502 });
}

/** A sign-in that's waiting. Once Orgo has handed over the key it's held here until it's saved: Orgo hands it over only once. */
type Pending = SignInStart & { deviceCode: string; polledAt: number; collected?: { apiKey: string; user: OrgoUser } };

const g = globalThis as unknown as { bopsSignIn?: Pending | null; bopsSignInPoll?: Promise<SignInPoll> | null };

/**
 * Orgo sends both numbers as bare JSON. Like Orgo for Mac (DeviceCodeAuth.swift), bound them so a
 * bad value can't make the code live forever or the app poll in a tight loop.
 */
const clampSeconds = (v: unknown, lo: number, hi: number) => (typeof v === "number" && !Number.isNaN(v) ? Math.min(Math.max(v, lo), hi) : lo);

async function orgoPost<T>(path: string, body: unknown): Promise<T> {
  const res = await fetch(`${orgoOrigin()}${path}`, {
    method: "POST",
    headers: { Accept: "application/json", "Content-Type": "application/json" },
    body: JSON.stringify(body),
    cache: "no-store",
    signal: AbortSignal.timeout(15_000),
  }).catch((e: Error) => {
    throw new SignInError("offline", `${path}: ${e.message}`);
  });
  const json = (await res.json().catch(() => ({}))) as T & { error?: string };
  if (!res.ok) throw new SignInError("orgo", `${path}: ${res.status} ${json.error ?? ""}`.trim());
  return json;
}

/** This Mac's name as the user knows it ("Ana's MacBook Air"), shown on Orgo's approve page. */
const macName = () =>
  new Promise<string>((resolve) =>
    execFile("scutil", ["--get", "ComputerName"], { timeout: 2000 }, (e, out) => resolve((!e && out.trim()) || hostname().replace(/\.local$/, ""))),
  );

/** Only a web page may be opened from here (the app hands it to the system browser). */
function webUrl(u: unknown, fallback: string) {
  try {
    const url = new URL(String(u));
    return url.protocol === "https:" || url.protocol === "http:" ? url.toString() : fallback;
  } catch {
    return fallback;
  }
}

export async function startSignIn(): Promise<SignInStart> {
  const r = await orgoPost<{
    device_code?: string;
    user_code?: string;
    verification_uri_complete?: string;
    expires_in_seconds?: number;
    interval_seconds?: number;
  }>("/api/cli/auth/start", { client: "Bops", hostname: await macName() });
  if (!r.device_code || !r.user_code) throw new SignInError("orgo", "/api/cli/auth/start: no code in the answer");
  const fallback = `${orgoOrigin()}/cli/approve?code=${encodeURIComponent(r.user_code)}`;
  const pending: Pending = {
    deviceCode: r.device_code,
    userCode: r.user_code,
    verificationUrl: webUrl(r.verification_uri_complete, fallback),
    expiresAt: Date.now() + clampSeconds(r.expires_in_seconds, 1, 86_400) * 1000,
    interval: clampSeconds(r.interval_seconds, 1, 60),
    polledAt: 0,
  };
  g.bopsSignIn = pending;
  return { userCode: pending.userCode, verificationUrl: pending.verificationUrl, expiresAt: pending.expiresAt, interval: pending.interval };
}

/** Forget a sign-in that's waiting (the user pressed Cancel, or signed out). */
export const cancelSignIn = () => void (g.bopsSignIn = null);

/**
 * One look at the waiting sign-in. Calls share one poll in flight, because Orgo hands the key over
 * exactly once: a second poll racing the first would see "expired". Polls sooner than Orgo's
 * interval answer "pending" without asking.
 */
export function pollSignIn(): Promise<SignInPoll> {
  return (g.bopsSignInPoll ??= poll().finally(() => (g.bopsSignInPoll = null)));
}

async function poll(): Promise<SignInPoll> {
  const p = g.bopsSignIn;
  if (!p) {
    // Nothing waiting: say whether someone is signed in, the way the gate does (a hosted server binds their state first).
    const now = await authStatus();
    return now.signedIn ? { status: "approved", user: now.user ?? undefined } : { status: "none" };
  }
  // The key came last time but wasn't saved: try saving it again (the code may have run out since; the key hasn't).
  if (p.collected) return finish(p, p.collected.apiKey, p.collected.user);
  if (Date.now() >= p.expiresAt) {
    g.bopsSignIn = null;
    return { status: "expired" };
  }
  // (A quarter second of slack, so the app's own timer, firing on the interval, isn't turned away.)
  if (Date.now() - p.polledAt < p.interval * 1000 - 250) return { status: "pending" };
  p.polledAt = Date.now();

  const r = await orgoPost<{ status?: string; api_key?: string; user?: { id?: string; email?: string } }>("/api/cli/auth/poll", { device_code: p.deviceCode });
  if (r.status === "pending") return { status: "pending" };
  if (r.status !== "approved" || !r.api_key || !r.user?.id) {
    if (g.bopsSignIn === p) g.bopsSignIn = null;
    return { status: r.status === "denied" ? "denied" : "expired" };
  }
  const user: OrgoUser = { id: r.user.id, email: r.user.email ?? undefined, name: (await profile(r.api_key))?.name };
  p.collected = { apiKey: r.api_key, user };
  return finish(p, r.api_key, user);
}

/** Save the key Orgo handed over. Until that works the sign-in stays waiting with the key, so a retry needs no new code. */
async function finish(p: Pending, apiKey: string, user: OrgoUser): Promise<SignInPoll> {
  // A hosted server is about to swap in this user's state: the last one's tasks stop first, so their
  // work doesn't run on (or report into) someone else's.
  const before = signedInUser();
  if (onPostgres() && before && before.id !== user.id) stopAllSessions("Stopped: signed out");
  try {
    await signIn(apiKey, user);
  } catch (e) {
    throw new SignInError("keychain", (e as Error).message);
  }
  if (g.bopsSignIn === p) g.bopsSignIn = null;
  seedOwnerName(user);
  void adoptComputers(user.id).catch((e: Error) => console.warn(`[sign-in] checking the bots' computers: ${e.message}`));
  // Bops Cloud starts over on this key (its session, the tunnel, the state backup, a restore onto a
  // fresh install), and routing through this Mac turns on by itself where Orgo offers it.
  void startCloud({ signedIn: true });
  relayAfterSignIn();
  return { status: "approved", user };
}

/** Orgo answered that this key can't see the computer (gone, or another account's). */
const notTheirs = (e: Error) => /→ (401|403|404):/.test(e.message);

/**
 * The bots' computers live in the Orgo account they were made under, which may not be the one that
 * just signed in (a sign-in as someone else, or computers made before sign-in on a self-hoster's key
 * or the Orgo CLI's login). Computers the new account can't reach are forgotten, so each bot gets a
 * new one on its next task instead of failing on one it can't use. Kept in state.computersOf.
 */
async function adoptComputers(userId: string) {
  const st = getState();
  if (st.computersOf === userId) return;
  const withComputers = st.bots.filter((b) => b.computerId);
  let gone: string[];
  let sure = true;
  if (st.computersOf) gone = withComputers.map((b) => b.id);
  else {
    // From before Bops kept track: ask Orgo, on the new key, which ones it can see.
    gone = [];
    for (const b of withComputers)
      await orgo.computer(b.computerId!).catch((e: Error) => {
        if (notTheirs(e)) gone.push(b.id);
        else sure = false; // Orgo didn't answer: ask again at the next sign-in
      });
  }
  if (signedInUser()?.id !== userId) return; // signed out (or someone else in) meanwhile
  update((s) => {
    for (const b of s.bots)
      if (gone.includes(b.id)) {
        b.computerId = undefined;
        b.freeComputer = undefined;
        b.computerStatus = "none";
        b.tailnet = undefined;
        for (const key of Object.keys(s.screens ?? {})) if (key.startsWith(`${b.id}:`)) delete s.screens![key];
      }
    if (sure) s.computersOf = userId;
  });
  if (gone.length) console.info(`[sign-in] ${gone.length} bot computer(s) belong to another Orgo account; each bot gets a new one on its next task`);
}

/** First sign-in: the bots call the user by their Orgo name until they set one in Settings → You. */
function seedOwnerName(user: OrgoUser) {
  if (user.name && !getState().owner?.name.trim()) update((s) => (s.owner = { name: user.name!.slice(0, 80), about: s.owner?.about }));
}

/** Who the key belongs to on Orgo (GET /api/user/profile), with their name if they've given one. */
async function profile(apiKey: string): Promise<OrgoUser | null> {
  try {
    const res = await fetch(`${orgoOrigin()}/api/user/profile`, {
      headers: { Authorization: `Bearer ${apiKey}` },
      cache: "no-store",
      signal: AbortSignal.timeout(10_000),
    });
    if (!res.ok) return null;
    const p = (await res.json()) as { id?: string; email?: string; full_name?: string };
    return p.id ? { id: p.id, email: p.email || undefined, name: p.full_name?.trim() || undefined } : null;
  } catch {
    return null;
  }
}

/**
 * Whether the app has to ask the user to sign in: not when they are, and not for a self-hoster
 * who runs on their own key (BOPS_SELF_HOSTED=1 with ORGO_API_KEY).
 */
export async function authStatus() {
  const key = await loadOrgoKey();
  // Signed in, but the app state forgot who (it was deleted by hand, is from before sign-in, or a
  // hosted server restarted with the key still in the Keychain): ask Orgo again, and load that user's
  // own state first, as a sign-in does, so their work lands in (and is saved to) their own.
  if (key && !signedInUser()) {
    const user = await profile(key);
    if (user) {
      try {
        await bindSignIn(user.id);
        update((s) => (s.account = { user, signedInAt: Date.now() }));
        seedOwnerName(user);
        // Now that it's known who, the state backup can be checked for them.
        void startCloud();
      } catch (e) {
        console.error(`[sign-in] couldn't load ${user.id}'s state: ${(e as Error).message}`);
      }
    }
  }
  // A hosted server is signed in only once the user's state is loaded; until then it asks for a sign-in.
  const signedIn = !!key && (!onPostgres() || !!signedInUser());
  // Signed in per the state, but the Keychain wouldn't give the key (locked, or a prompt turned down):
  // the app opens, and its account page says so (instead of a sign-in that mints yet another key).
  const keyUnreadable = !key && !!signedInUser();
  const selfHostedKey = process.env.BOPS_SELF_HOSTED === "1" && !!process.env.ORGO_API_KEY;
  return { signedIn, user: signedIn || keyUnreadable ? signedInUser() : null, needsSignIn: !signedIn && !keyUnreadable && !selfHostedKey };
}
