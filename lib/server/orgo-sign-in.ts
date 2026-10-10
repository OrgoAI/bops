import "server-only";
import { execFile } from "node:child_process";
import { hostname } from "node:os";
import { trackServerEvent } from "./analytics";
import { orgoHeaders } from "./app-version";
import { stopChannels } from "./channels";
import { startCloud, stopCloud } from "./cloud-tunnel";
import { checkMac } from "./mac";
import { quitBotChromes } from "./local";
import { orgo } from "./orgo";
import { loadOrgoKey, orgoKey, orgoOrigin, signedInUser, signIn, type OrgoUser } from "./orgo-auth";
import { onPostgres, StateLoadError } from "./persist";
import { relayAfterSignIn, stopRelay } from "./relay";
import { reattachFreeComputer, stopAllSessions } from "./sessions";
import { bindSignIn, getState, stateInCloud, stateUser, update } from "./store";

/**
 * Sign in with Orgo: Orgo's device-code flow (orgo-web app/api/cli/auth), the one `orgo login` and
 * Orgo for Mac use. Start asks Orgo for a code; the user approves it on orgo.ai in their browser;
 * polling picks up the API key Orgo mints for this Mac ("CLI on <this Mac's name>", account-wide).
 * Continue with Google and Continue with email are the same flow, opening the page with a hint
 * (approvalPage below), so whichever way they come in it's an Orgo account and an Orgo key.
 *
 * The device code is the proof that collects the key, so it stays here on the server; the app only
 * ever sees the short code to compare and the page to open. One sign-in at a time per install.
 */

export type SignInStart = { userCode: string; verificationUrl: string; expiresAt: number; interval: number };
export type SignInPoll = { status: "pending" | "approved" | "denied" | "expired" | "none"; user?: OrgoUser };

/**
 * What went wrong, in the words the app shows: Orgo couldn't be reached, Orgo answered with an error,
 * the Keychain refused the key, or the user's Bops couldn't be loaded from Bops Cloud.
 */
export type SignInProblem = "offline" | "orgo" | "keychain" | "cloud";
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
type Pending = SignInStart & { deviceCode: string; polledAt: number; provider?: SignInProvider; collected?: { apiKey: string; user: OrgoUser } };

const g = globalThis as unknown as { bopsSignIn?: Pending | null; bopsSignInPoll?: Promise<SignInPoll> | null };

/**
 * Orgo sends both numbers as bare JSON. Like Orgo for Mac (DeviceCodeAuth.swift), bound them so a
 * bad value can't make the code live forever or the app poll in a tight loop.
 */
const clampSeconds = (v: unknown, lo: number, hi: number) => (typeof v === "number" && !Number.isNaN(v) ? Math.min(Math.max(v, lo), hi) : lo);

async function orgoPost<T>(path: string, body: unknown): Promise<T> {
  const res = await fetch(`${orgoOrigin()}${path}`, {
    method: "POST",
    headers: { ...orgoHeaders(), Accept: "application/json", "Content-Type": "application/json" },
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

/**
 * The ways in the app offers besides an Orgo login: Google, or an email address. Either one is
 * a new Orgo account if the user hasn't got one; Orgo sees to that on its side.
 */
export type SignInProvider = "google" | "email";

/** The way in the app asked for, if it's one there is (anything else is a plain Orgo sign-in). */
export const signInProvider = (v: unknown): SignInProvider | undefined => (v === "google" || v === "email" ? v : undefined);

/**
 * The page the browser opens: Orgo's approve page with the code already on it, so nobody types
 * one, shown as Bops (app=bops) every way. With Google or email it also goes straight to that way of
 * signing in (provider=), then comes back to approve this Mac; Sign in with Orgo names no way in.
 */
export function approvalPage(verificationUrl: string, userCode: string, provider?: SignInProvider) {
  const url = new URL(verificationUrl);
  if (url.searchParams.get("code") !== userCode) url.searchParams.set("code", userCode);
  if (provider) url.searchParams.set("provider", provider);
  else url.searchParams.delete("provider");
  url.searchParams.set("app", "bops");
  return url.toString();
}

export async function startSignIn(provider?: SignInProvider): Promise<SignInStart> {
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
    verificationUrl: approvalPage(webUrl(r.verification_uri_complete, fallback), r.user_code, provider),
    expiresAt: Date.now() + clampSeconds(r.expires_in_seconds, 1, 86_400) * 1000,
    interval: clampSeconds(r.interval_seconds, 1, 60),
    polledAt: 0,
    provider,
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
  const who = await whoIs(r.api_key);
  const user: OrgoUser = { id: r.user.id, email: r.user.email ?? undefined, name: who && who !== "denied" ? who.name : undefined };
  p.collected = { apiKey: r.api_key, user };
  return finish(p, r.api_key, user);
}

/** Save the key Orgo handed over. Until that works the sign-in stays waiting with the key, so a retry needs no new code. */
async function finish(p: Pending, apiKey: string, user: OrgoUser): Promise<SignInPoll> {
  // Another user's state is about to come in: the last one's tasks stop first, so their work doesn't
  // run on (or report into) someone else's, and their bots' Chromes (their cookies) close. As at a
  // sign-out, their computers go back to their own route and Bops Cloud's tunnel on their key
  // closes, so nothing of theirs (a webhook, a text) lands in the new account's state.
  const before = signedInUser();
  if (before && before.id !== user.id) {
    stopAllSessions("Stopped: signed out");
    stopChannels();
    await quitBotChromes();
    await stopRelay().catch((e: Error) => console.warn(`[sign-in] stopping the relay: ${e.message}`));
    await stopCloud();
  }
  try {
    await signIn(apiKey, user);
  } catch (e) {
    throw new SignInError(e instanceof StateLoadError ? "cloud" : "keychain", (e as Error).message);
  }
  if (g.bopsSignIn === p) g.bopsSignIn = null;
  trackServerEvent("bops_signed_in", { method: p.provider ?? "orgo", switched_user: !!before && before.id !== user.id });
  seedOwnerName(user);
  // This Mac, as this user's state has it (each user's state keeps its own look at it: state.mac).
  void checkMac().catch(() => {});
  // Then a main bot left with no computer takes up the free Bops computer again, if it's still on Orgo.
  void adoptComputers(user.id)
    .catch((e: Error) => console.warn(`[sign-in] checking the bots' computers: ${e.message}`))
    .then(() => reattachFreeComputer(user.id));
  // Bops Cloud starts over on this key (its session, the tunnel), and routing through this Mac turns
  // on by itself where Orgo offers it.
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

/** Who the key belongs to on Orgo (GET /api/user/profile), with their name if they've given one; "denied" when Orgo turns the key down, null when it can't say. */
async function whoIs(apiKey: string): Promise<OrgoUser | "denied" | null> {
  try {
    const res = await fetch(`${orgoOrigin()}/api/user/profile`, {
      headers: { ...orgoHeaders(), Authorization: `Bearer ${apiKey}` },
      cache: "no-store",
      signal: AbortSignal.timeout(10_000),
    });
    if (res.status === 401 || res.status === 403) return "denied";
    if (!res.ok) return null;
    const p = (await res.json()) as { id?: string; email?: string; full_name?: string };
    return p.id ? { id: p.id, email: p.email || undefined, name: p.full_name?.trim() || undefined } : null;
  } catch {
    return null;
  }
}

/** Whether a sign-in has its key from Orgo and is landing (finish): no other user's state is loaded meanwhile. */
const signingIn = () => !!g.bopsSignIn?.collected;

/** Loading the signed-in user's state for a key the Keychain had (the server starting): one try at a time, waiting longer after each failure. */
type Loading = { inFlight?: Promise<void>; nextAt: number; delay: number; failed?: boolean };
const gl = globalThis as unknown as { bopsStateLoading?: Loading };
const loading: Loading = (gl.bopsStateLoading ??= { nextAt: 0, delay: 0 });
const LOAD_RETRY_MIN_MS = 2000;
const LOAD_RETRY_MAX_MS = 60_000;

/**
 * Signed in (the key is in the Keychain), but nobody's state is loaded: the server just started, or a
 * hosted server restarted. Ask Orgo who the key is, and load that user's own state first, as a
 * sign-in does, so their work lands in (and is saved to) their own. When Bops Cloud or Orgo can't be
 * reached it's tried again, after 2 seconds, then 4… up to a minute (`now`: try now anyway).
 */
function loadForKey(key: string, now: boolean): Promise<void> {
  if (loading.inFlight) return loading.inFlight;
  if (!now && Date.now() < loading.nextAt) return Promise.resolve();
  // A sign-in is landing (Orgo handed over its key): its user's state is the one coming in, not this key's.
  if (signingIn()) return Promise.resolve();
  const run = (async () => {
    const user = await whoIs(key);
    // Orgo turned the key down (revoked): it's a sign-in.
    if (user === "denied") return;
    if (!user) throw new Error("Orgo didn't say who's signed in");
    if (signingIn() || orgoKey() !== key) return;
    await bindSignIn(user.id, key);
    // Signed out, or someone else signed in meanwhile: their state is the one in memory (or coming in), not this one's.
    if (orgoKey() !== key || signingIn() || stateUser() !== user.id) return;
    update((s) => (s.account = { user, signedInAt: Date.now() }));
    seedOwnerName(user);
    void checkMac().catch(() => {});
    void reattachFreeComputer(user.id);
    // Now that it's known who, Bops Cloud's tunnel opens for them.
    void startCloud();
  })().then(
    () => {
      loading.failed = false;
      loading.delay = 0;
      loading.nextAt = 0;
    },
    (e: Error) => {
      loading.failed = true;
      loading.delay = Math.min(LOAD_RETRY_MAX_MS, Math.max(LOAD_RETRY_MIN_MS, loading.delay * 2));
      loading.nextAt = Date.now() + loading.delay;
      console.error(`[sign-in] couldn't load the signed-in user's state (trying again in ${loading.delay / 1000}s): ${e.message}`);
    },
  );
  loading.inFlight = run.finally(() => (loading.inFlight = undefined));
  return loading.inFlight;
}

/**
 * Whether the app has to ask the user to sign in: not when they are, and not for a self-hoster
 * who runs on their own key (BOPS_SELF_HOSTED=1 with ORGO_API_KEY). `cloudProblem`: signed in, but
 * their state couldn't be loaded from Bops Cloud (offline): the app says so, and asks again (`retry`
 * tries again at once, from the app's Try again).
 */
export async function authStatus({ retry = false } = {}) {
  const key = await loadOrgoKey();
  if (key && !signedInUser()) await loadForKey(key, retry);
  // The Mac app and a hosted server are signed in only once the user's state is loaded; until then it asks for a sign-in.
  const needsState = onPostgres() || stateInCloud();
  const signedIn = !!key && (!needsState || !!signedInUser());
  const cloudProblem = !!key && stateInCloud() && !signedInUser() && !!loading.failed;
  // Signed in per the state, but the Keychain wouldn't give the key (locked, or a prompt turned down):
  // the app opens, and its account page says so (instead of a sign-in that mints yet another key).
  const keyUnreadable = !key && !!signedInUser();
  const selfHostedKey = process.env.BOPS_SELF_HOSTED === "1" && !!process.env.ORGO_API_KEY;
  return { signedIn, user: signedIn || keyUnreadable ? signedInUser() : null, needsSignIn: !signedIn && !keyUnreadable && !selfHostedKey && !cloudProblem, cloudProblem };
}
