import "server-only";
import { execFile, spawn, type ChildProcess } from "node:child_process";
import { accessSync, constants, readFileSync } from "node:fs";
import { hostname } from "node:os";
import { delimiter, join } from "node:path";
import { live, workBot, type RelayRoute } from "@/lib/types";
import { getSecret, setSecret } from "./keychain";
import { loadOrgoKey, orgoKey, signedInUser } from "./orgo-auth";
import { egress, orgo, orgoUnavailable } from "./orgo";
import { onPostgres } from "./persist";
import { getState, stateEpoch, stateReady, update } from "./store";

/**
 * Route the bots' computers through this Mac. Orgo's personal-device egress: this Mac is paired with
 * the user's Orgo account as a device, the relay agent (orgo-relay) runs here and holds one outbound
 * connection to Orgo's rendezvous, and each Bops computer's browser goes out through it, so the sites
 * the bots visit see the user's own internet address.
 *
 * - Pairing: POST /api/egress-devices once per Orgo user on this Mac. The pairing code it returns is
 *   a credential: it lives in the Keychain (never in state, logs or the agent's argv; the agent reads
 *   it from ORGO_RELAY_CODE), and the device id in state.relay.
 * - The agent is a child of this server, restarted with backoff if it dies, stopped when routing is
 *   turned off (once every computer is switched back) and on sign-out.
 * - Switching a computer: POST egress/upstream {mode: "device"}. Orgo applies it right away. When the
 *   computer's proxy was off that restarts its Chrome (every screen); when it was already on, only the
 *   route underneath changes, and Bops restarts Chrome itself, so pages already open and the
 *   connections Chrome keeps go out the new way too. Either way a computer switches only while no task
 *   runs on it and the user isn't driving it, and Bops puts each screen's page back afterwards
 *   (vm/bin/bops-keep-screens). How it was before is kept in state.relayRoutes, and put back when
 *   routing stops (Chrome restarts then too).
 * - On by default: once Orgo offers routing to the signed-in user (and this copy of Bops has the
 *   relay), it turns on by itself after sign-in and every bot computer, new ones too, goes through
 *   this Mac, unless the user turned it off. Their "off" stays (state.relay.turnedOff), across
 *   restarts and sign-ins, until they turn it on again.
 *
 * Orgo answers 403 where the feature isn't available yet (production today): then it's "not
 * available", stays off without a word, and Orgo is asked again every 10 minutes.
 */

/** Where the agent's loopback status API listens (not orgo-relay's default 8898, which a separately installed agent may hold). */
const CONTROL = process.env.BOPS_RELAY_CONTROL || "127.0.0.1:8897";
const TICK_MS = 20_000;
const MAX_BACKOFF_MS = 60_000;

export type RelayStatus = {
  available: boolean;
  /** Routing is on: turned on, or on by default (available, and the user hasn't turned it off). */
  on: boolean;
  reason?: string;
  device?: { id: string; name: string };
  running: boolean;
  online?: boolean;
  routedComputers: string[];
};

type Supervisor = {
  child?: ChildProcess;
  /** Whether the agent should be running (it's restarted while this is true). */
  want: boolean;
  /** The secret the agent runs on, so a log line that ever carried it is redacted. */
  code?: string;
  failures: number;
  startedAt?: number;
  restartTimer?: ReturnType<typeof setTimeout>;
  lastError?: string;
  tick?: ReturnType<typeof setInterval>;
  reconciling?: Promise<void>;
  /** Signing out: stopRelay puts the computers back itself, so reconcile stays out of its way. */
  stopping?: boolean;
  starting?: Promise<void>;
  /** Orgo's answer on availability, and until when it stands (availability()). */
  avail?: { until: number; ok: boolean; reason?: string; online?: boolean | null; rendezvous?: string | null };
  /** When turning routing on by default last failed: pairing makes a device on Orgo, so it isn't tried on every tick. */
  defaultFailedAt?: number;
  /**
   * The user just flipped the switch: the computers switch now, even one in use (its Chrome restarts,
   * with its pages kept), rather than waiting for it to come free. Until this time.
   */
  nowUntil?: number;
};
const g = globalThis as unknown as { bopsRelay?: Supervisor };
const sup: Supervisor = (g.bopsRelay ??= { want: false, failures: 0 });

// ── The binary ──────────────────────────────────────────────────────────────────────────────

const runnable = (p: string) => {
  try {
    accessSync(p, constants.X_OK);
    return true;
  } catch {
    return false;
  }
};

/** BOPS_RELAY_BIN (the packaged app's bundled copy), else vendor/ (scripts/fetch-relay.sh), else one on PATH. */
export function relayBin(): string | null {
  if (process.env.BOPS_RELAY_BIN) return runnable(process.env.BOPS_RELAY_BIN) ? process.env.BOPS_RELAY_BIN : null;
  const vendored = join(process.cwd(), "vendor/orgo-relay/orgo-relay");
  if (runnable(vendored)) return vendored;
  for (const dir of (process.env.PATH ?? "").split(delimiter)) if (dir && runnable(join(dir, "orgo-relay"))) return join(dir, "orgo-relay");
  return null;
}

// ── Pairing ─────────────────────────────────────────────────────────────────────────────────

/** This Mac's name, as the user named it (System Settings → General → About). */
function macName() {
  return new Promise<string>((resolve) =>
    execFile("scutil", ["--get", "ComputerName"], (e, out) => resolve((!e && out.trim()) || hostname().replace(/\.local$/, "") || "Mac")),
  );
}

/** The Keychain item for this Orgo user's pairing on this Mac: { deviceId, code }. */
const codeAccount = (userId: string) => `orgo-relay:${userId}`;

async function savedPairing(userId: string): Promise<{ deviceId: string; code: string } | null> {
  try {
    const p = JSON.parse((await getSecret(codeAccount(userId))) ?? "");
    return typeof p?.deviceId === "string" && typeof p?.code === "string" ? p : null;
  } catch {
    return null;
  }
}

/**
 * This Mac's device on the user's Orgo account: the one paired before (its code still in the Keychain
 * and the device still on Orgo), else a new pairing. A device whose code was lost can't be run again
 * (Orgo shows a code only once), so then this Mac pairs afresh; the old one stays on Orgo, offline.
 */
async function ensurePaired(): Promise<{ deviceId: string; name: string; code: string; rendezvous?: string | null }> {
  const user = signedInUser();
  if (!user) throw new Error("Sign in to Orgo first.");
  // Signed out, or another account in, while Orgo answered: this Mac's device is the last user's, not theirs.
  const epoch = stateEpoch();
  const stillTheirs = () => {
    if (epoch !== stateEpoch()) throw new Error("Signed out meanwhile.");
  };
  const { devices = [], rendezvous } = await egress.devices();
  const saved = await savedPairing(user.id);
  const known = saved && devices.find((d) => d.id === saved.deviceId);
  stillTheirs();
  if (saved && known) {
    update((s) => (s.relay = { ...s.relay, on: s.relay?.on ?? false, deviceId: known.id, deviceName: known.name }));
    return { deviceId: known.id, name: known.name, code: saved.code, rendezvous };
  }
  const paired = await egress.pair(`${await macName()} (Bops)`);
  await setSecret(codeAccount(user.id), JSON.stringify({ deviceId: paired.id, code: paired.pairing_code }));
  stillTheirs();
  update((s) => (s.relay = { ...s.relay, on: s.relay?.on ?? false, deviceId: paired.id, deviceName: paired.name }));
  sup.avail = undefined;
  return { deviceId: paired.id, name: paired.name, code: paired.pairing_code, rendezvous: paired.rendezvous ?? rendezvous };
}

// ── The agent ───────────────────────────────────────────────────────────────────────────────

const running = () => !!sup.child && sup.child.exitCode === null && sup.child.signalCode === null;

/** One line of the agent's output, for the server log. The code never shows (the agent doesn't print it; this makes sure). */
function logLine(line: string) {
  const text = sup.code ? line.split(sup.code).join("[code]") : line;
  if (text.trim()) console.log(`[relay] ${text.trim()}`);
}

/** Start the agent (once, however many callers ask at the same time). */
function startAgent(): Promise<void> {
  if (running() || sup.restartTimer) return Promise.resolve();
  return (sup.starting ??= spawnAgent().finally(() => (sup.starting = undefined)));
}

async function spawnAgent() {
  const bin = relayBin();
  if (!bin) {
    sup.lastError = "not installed";
    return;
  }
  const { code, name, rendezvous } = await ensurePaired();
  if (!sup.want || running()) return;
  sup.code = code;
  // The code goes in the environment (orgo-relay reads ORGO_RELAY_CODE), never on the command line, which any process can read.
  // Only what the agent needs: none of this server's own keys go to it.
  const env: Record<string, string> = { ORGO_RELAY_CODE: code };
  for (const k of ["PATH", "HOME", "TMPDIR", "ORGO_RELAY_URL"]) {
    const v = process.env[k];
    if (v) env[k] = v;
  }
  const child = spawn(/*turbopackIgnore: true*/ bin, ["agent", "--name", name, "--control-addr", CONTROL, ...(rendezvous ? ["--rendezvous", rendezvous] : [])], {
    env: env as NodeJS.ProcessEnv,
    stdio: ["ignore", "pipe", "pipe"],
  });
  sup.child = child;
  sup.startedAt = Date.now();
  sup.lastError = undefined;
  for (const stream of [child.stdout, child.stderr]) stream?.setEncoding("utf8").on("data", (d: string) => d.split("\n").forEach(logLine));
  let gone = false;
  const onGone = (why: string) => {
    if (gone) return;
    gone = true;
    if (sup.child === child) sup.child = undefined;
    if (!sup.want) return;
    // A run that lasted a while starts the backoff over.
    if (Date.now() - (sup.startedAt ?? 0) > MAX_BACKOFF_MS) sup.failures = 0;
    const wait = Math.min(MAX_BACKOFF_MS, 1000 * 2 ** sup.failures++);
    sup.lastError = why;
    logLine(`agent stopped (${why}); starting it again in ${Math.round(wait / 1000)}s`);
    sup.restartTimer = setTimeout(() => {
      sup.restartTimer = undefined;
      if (sup.want) void startAgent().catch((e: Error) => (sup.lastError = e.message));
    }, wait);
  };
  // A binary that can't start at all reports only an error, no exit.
  child.on("error", (e) => onGone(e.message));
  child.on("exit", (codeOut, signal) => onGone(String(signal ?? codeOut)));
}

function stopAgent() {
  sup.want = false;
  if (sup.restartTimer) clearTimeout(sup.restartTimer);
  sup.restartTimer = undefined;
  sup.failures = 0;
  const child = sup.child;
  sup.child = undefined;
  if (child && child.exitCode === null) {
    child.kill("SIGTERM");
    setTimeout(() => child.exitCode === null && child.signalCode === null && child.kill("SIGKILL"), 3000).unref();
  }
}

/** Whether the agent here is connected to Orgo, from its loopback status API (null: no answer). */
async function agentConnected(): Promise<boolean | null> {
  if (!running()) return null;
  try {
    const res = await fetch(`http://${CONTROL}/v1/status`, { signal: AbortSignal.timeout(1500), cache: "no-store" });
    return res.ok ? !!((await res.json()) as { connected?: boolean }).connected : null;
  } catch {
    return null;
  }
}

/** Whether the agent is connected, giving one that just started a few seconds to get there. */
async function connectedWithin(ms: number) {
  for (const until = Date.now() + ms; ; await new Promise((r) => setTimeout(r, 1000))) {
    if (await agentConnected()) return true;
    if (!running() || Date.now() - (sup.startedAt ?? 0) > ms || Date.now() > until) return false;
  }
}

// ── Availability ────────────────────────────────────────────────────────────────────────────

/**
 * Whether Orgo offers routing to this user. A yes stands 30 seconds (the settings page polls whether
 * the relay is online), a no 10 minutes (it's asked again later, quietly), and no answer 5 seconds.
 */
async function availability(fresh = false) {
  if (!fresh && sup.avail && Date.now() < sup.avail.until) return sup.avail;
  const deviceId = getState().relay?.deviceId;
  try {
    const { devices = [], rendezvous } = await egress.devices();
    sup.avail = { until: Date.now() + 30_000, ok: true, online: devices.find((d) => d.id === deviceId)?.online ?? null, rendezvous };
  } catch (e) {
    sup.avail = orgoUnavailable(e)
      ? { until: Date.now() + 10 * 60_000, ok: false, reason: "Routing through your Mac isn't available on your Orgo account yet." }
      : { until: Date.now() + 5_000, ok: false, reason: "Couldn't reach Orgo just now. Try again in a moment." };
  }
  return sup.avail;
}

const routed = () =>
  Object.entries(getState().relayRoutes ?? {})
    .filter(([, r]) => r.applied)
    .map(([id]) => id);

/** Where routing stands. `fresh` asks Orgo again rather than going by its last answer (availability). */
export async function relayStatus(fresh = false): Promise<RelayStatus> {
  const relay = getState().relay;
  const base = { on: !!relay?.on, running: running(), routedComputers: routed(), ...(relay?.deviceId ? { device: { id: relay.deviceId, name: relay.deviceName ?? "This Mac" } } : {}) };
  if (onPostgres()) return { ...base, available: false, reason: "Routing through your Mac works in the Bops app on your Mac." };
  if (!(await loadOrgoKey())) return { ...base, available: false, reason: "Sign in to Orgo first." };
  if (!relayBin()) return { ...base, available: false, reason: "This copy of Bops doesn't include the relay yet." };
  const a = await availability(fresh);
  if (!a.ok) return { ...base, available: false, reason: a.reason };
  const here = await agentConnected();
  const online = here ?? a.online ?? undefined;
  const reason = relay?.on && !running() && sup.lastError ? `The relay on this Mac stopped (${sup.lastError}). Bops is starting it again.` : undefined;
  return { ...base, on: !!relay?.on || !relay?.turnedOff, available: true, ...(online === undefined ? {} : { online }), ...(reason ? { reason } : {}) };
}

// ── Switching computers ─────────────────────────────────────────────────────────────────────

/** Every Bops computer: the ones the bots in state have (a bot that shares has none of its own). */
const computers = () => [...new Set(getState().bots.flatMap((b) => (b.computerId && b.computerStatus === "ready" ? [b.computerId] : [])))];

/** Whether something is using a computer right now: a task on it, or the user driving one of its screens. */
function inUse(computerId: string) {
  // Right after the user flips the switch, nothing waits: they asked for it now.
  if (sup.nowUntil && Date.now() < sup.nowUntil) return false;
  const st = getState();
  const on = (botId: string) => {
    const b = st.bots.find((x) => x.id === botId);
    return !!b && workBot(b, st.bots).computerId === computerId;
  };
  return st.sessions.some((s) => live(s) && s.runsOn !== "mac" && on(s.botId)) || (st.takeover?.display !== undefined && on(st.takeover.botId));
}

const keepScreens = () => Buffer.from(readFileSync(join(process.cwd(), "vm/bin/bops-keep-screens"))).toString("base64");

/** Note each screen's page before Orgo restarts the computer's Chrome. */
async function saveScreens(computerId: string) {
  await orgo.bash(computerId, `echo ${keepScreens()} | base64 -d > /usr/local/bin/bops-keep-screens && chmod 0755 /usr/local/bin/bops-keep-screens && bops-keep-screens save`, 30);
}

/**
 * Start each screen's own Chrome again, on the page it had. `ifDown`: only if a screen's browser went
 * away (a change Orgo turned down most likely left Chrome as it was, and restarting it would lose pages).
 */
async function restoreScreens(computerId: string, ifDown = false) {
  const out = await orgo.bash(computerId, `bops-keep-screens restore${ifDown ? " --if-down" : ""}`, 90);
  if (!/restored|untouched/.test(out.output)) throw new Error(`the screens didn't come back: ${out.output.slice(-200)}`);
}

/**
 * A change to how a computer's browsing goes out, with its Chrome restarted around it and each
 * screen's page kept: Orgo restarts Chrome itself when the proxy goes on or off, and when only the
 * route underneath changes, the restart here makes open pages go out the new way. Never throws: says
 * what went wrong with the change, and whether the screens are up again. `saved`: the screens are down
 * from an earlier change, so the pages noted then are the ones to put back (noting them again now
 * would find no browser on those screens and forget them).
 */
async function withScreensKept(computerId: string, change: () => Promise<unknown>, saved = false): Promise<{ error?: unknown; back: boolean }> {
  if (!saved)
    try {
      await saveScreens(computerId);
    } catch (error) {
      // Nothing was changed yet.
      return { error, back: true };
    }
  let error: unknown;
  try {
    await change();
  } catch (e) {
    error = e;
  }
  const back = await restoreScreens(computerId, error !== undefined).then(
    () => true,
    (e: Error) => (console.warn(`[relay] ${computerId}: ${e.message}`), false),
  );
  return error === undefined ? { back } : { error, back };
}

const setRoute = (computerId: string, route: RelayRoute | undefined) =>
  update((s) => {
    s.relayRoutes ??= {};
    if (route) s.relayRoutes[computerId] = route;
    else delete s.relayRoutes[computerId];
  });

/**
 * Orgo answered about a computer as if it's gone (deleted on its site since): the bot on it moves on to
 * another (healIfGone, which asks Orgo first). Imported only then, as sessions.ts imports this file.
 */
const maybeGone = (computerId: string, e: unknown) =>
  void import("./sessions").then((m) => m.healIfGone(computerId, e)).catch((err: Error) => console.warn(`[relay] ${computerId}: ${err.message}`));

/** The HTTP status in an Orgo error (0: not an answer from Orgo). */
const statusOf = (e: unknown) => Number(/ → (\d{3}):/.exec((e as Error)?.message ?? "")?.[1] ?? 0);
const MAX_TRIES = 6;
const SCREENS_DOWN = "Its screens' browsers didn't come back. Bops is starting them again.";

/**
 * A route after a try that went wrong: it waits longer before each next try (20s, 40s, ... up to
 * 10 minutes). `canGiveUp`: switching a computer to this Mac is given up on when Orgo turns it down
 * (400, 403, 404) or after MAX_TRIES; putting one back never is, since until then it needs this Mac.
 */
function failed(route: RelayRoute, e: unknown, canGiveUp: boolean): RelayRoute {
  const failures = (route.failures ?? 0) + 1;
  const error = (e as Error)?.message ?? String(e);
  if (canGiveUp && ([400, 403, 404].includes(statusOf(e)) || failures >= MAX_TRIES)) {
    return { before: route.before, applied: route.applied, ...(route.screensDown ? { screensDown: true } : {}), error, failures, stuck: true };
  }
  return { ...route, error, failures, retryAt: Date.now() + Math.min(600_000, TICK_MS * 2 ** (failures - 1)) };
}

/** Put this computer on this Mac's route. */
async function routeOne(computerId: string, deviceId: string) {
  let route = getState().relayRoutes?.[computerId];
  if (!route) {
    const now = await egress.upstream(computerId);
    // A proxy the user set up themselves is theirs: leave it be.
    if (now.mode === "custom") return;
    if (now.mode === "device" && now.device_id === deviceId && now.proxy_on) {
      // Already on this Mac (state was lost): when routing stops, it goes back to going out directly.
      setRoute(computerId, { before: { proxyOn: false, mode: "residential" }, applied: true });
      return;
    }
    route = { before: { proxyOn: now.proxy_on, mode: now.mode, ...(now.mode === "device" && now.device_id ? { deviceId: now.device_id } : {}) }, applied: false };
    // Kept before the switch, so a server that stops halfway still knows how to put it back.
    setRoute(computerId, route);
  }
  const before = route.before;
  // Chrome restarts either way: by Orgo when the proxy was off, else by Bops (see withScreensKept).
  const r = await withScreensKept(computerId, () => egress.setUpstream(computerId, "device", deviceId), !!route.screensDown);
  const down = r.back ? {} : { screensDown: true };
  if (!("error" in r)) setRoute(computerId, { before, applied: true, ...down, ...(r.back ? {} : { error: SCREENS_DOWN }) });
  else {
    setRoute(computerId, failed({ ...route, applied: false, ...down }, r.error, true));
    maybeGone(computerId, r.error);
  }
}

/** Start the screens' browsers of a computer whose route changed but whose screens didn't come back. */
async function bringScreensBack(computerId: string, route: RelayRoute, canGiveUp: boolean) {
  try {
    await restoreScreens(computerId);
    return { before: route.before, applied: route.applied };
  } catch (e) {
    return failed(route, e, canGiveUp);
  }
}

/** Put this computer's route back the way it was before. */
async function unrouteOne(computerId: string) {
  const route = getState().relayRoutes?.[computerId];
  if (!route) return;
  let down = !!route.screensDown;
  try {
    if (!route.applied) {
      // A switch that failed with no clear answer from Orgo may have gone through all the same: look.
      const deviceId = getState().relay?.deviceId;
      const now = route.failures && deviceId ? await egress.upstream(computerId) : null;
      if (!(now?.mode === "device" && now.device_id === deviceId && now.proxy_on)) {
        if (route.screensDown) await restoreScreens(computerId);
        return setRoute(computerId, undefined);
      }
    }
    const { before } = route;
    const off = async () => {
      const r = await withScreensKept(
        computerId,
        async () => {
          await egress.proxyOff(computerId);
          // With the proxy off this only records the choice (nothing restarts again).
          await egress.setUpstream(computerId, "residential");
        },
        down,
      );
      down = !r.back;
      if ("error" in r) throw r.error;
    };
    if (before.proxyOn) {
      // Only the route underneath changes, and Chrome restarts so open pages go out the old way again.
      // If the device it went through before is gone (removed on Orgo since), there's nothing to go back
      // to: turn the proxy off. Anything else is tried again later.
      const r = await withScreensKept(computerId, () => egress.setUpstream(computerId, before.mode, before.deviceId), down);
      down = !r.back;
      if ("error" in r) {
        if (!/ → 404: Device not found/.test((r.error as Error)?.message ?? "")) throw r.error;
        await off();
      }
    } else await off();
    // Its route is back; screens that didn't come back are started again on a later try.
    setRoute(computerId, down ? { before, applied: false, screensDown: true, error: SCREENS_DOWN, failures: 1, retryAt: Date.now() + TICK_MS } : undefined);
  } catch (e) {
    // A computer that's gone has nothing to put back (and a bot still on it moves on).
    if (statusOf(e) === 404) {
      maybeGone(computerId, e);
      return setRoute(computerId, undefined);
    }
    setRoute(computerId, failed({ ...route, ...(down ? { screensDown: true } : {}) }, e, false));
  }
}

/** Whether a route that went wrong is due for another try. */
const due = (r?: RelayRoute) => !r?.retryAt || Date.now() >= r.retryAt;

/**
 * Bring the computers in line with the switch: while it's on and the agent is connected, route every
 * computer not in use; while it's off, put each one back as it comes free, then stop the agent. Right
 * after the user flips it, in use doesn't count (inUse): each computer switches now. The
 * switch is read again before each computer, and a run that finds it flipped runs once more after.
 */
export function reconcile(): Promise<void> {
  if (sup.stopping || !stateReady()) return Promise.resolve();
  if (sup.reconciling) return sup.reconciling;
  const wasOn = !!getState().relay?.on;
  const stillOn = () => !!getState().relay?.on && !sup.stopping;
  const stillOff = () => !getState().relay?.on && !sup.stopping;
  return (sup.reconciling = (async () => {
    if (onPostgres() || !orgoKey()) return;
    const relay = getState().relay;
    if (wasOn) {
      sup.want = true;
      if (!running()) await startAgent().catch((e: Error) => (sup.lastError = e.message));
      if (!relay?.deviceId || !(await connectedWithin(10_000))) return;
      // Orgo stopped offering it, or can't be reached: leave the computers be until it does.
      if (!(await availability()).ok) return;
      for (const id of computers()) {
        if (!stillOn()) return;
        const r = getState().relayRoutes?.[id];
        if (r?.stuck || !due(r) || inUse(id)) continue;
        if (r?.screensDown && r.applied) setRoute(id, await bringScreensBack(id, r, true));
        else if (!r?.applied)
          await routeOne(id, relay.deviceId).catch((e: Error) => {
            console.warn(`[relay] ${id}: ${e.message}`);
            maybeGone(id, e);
          });
      }
      // Computers that were deleted since.
      for (const id of Object.keys(getState().relayRoutes ?? {})) if (!getState().bots.some((b) => b.computerId === id)) setRoute(id, undefined);
      return;
    }
    // Off, but on by default: once it can, it turns on by itself, and the run after this one routes the computers.
    if (await turnOnByDefault()) return;
    for (const id of Object.keys(getState().relayRoutes ?? {})) {
      if (!stillOff()) return;
      const r = getState().relayRoutes?.[id];
      // A switch that never went through is just forgotten; the rest wait their turn after a failure.
      if (!r || ((r.applied || r.screensDown) && !due(r)) || inUse(id)) continue;
      await unrouteOne(id);
    }
    if (!stillOff()) return;
    // Until every computer is back, they still go out through this Mac: keep the agent up for them.
    if (routed().length && getState().relay?.deviceId) {
      sup.want = true;
      if (!running()) await startAgent().catch((e: Error) => (sup.lastError = e.message));
    } else if (sup.want || running()) stopAgent();
  })()
    .catch((e: Error) => console.warn(`[relay] ${e.message}`))
    .finally(() => {
      sup.reconciling = undefined;
      // The switch flipped while this ran: catch up now rather than on the next tick.
      if (!sup.stopping && !!getState().relay?.on !== wasOn) void reconcile();
    }));
}

/** A new computer while routing is on (ensureComputer): switch it now rather than on the next tick. */
export function relayNewComputer() {
  if (getState().relay?.on) void reconcile();
}

/** After a sign-in: Orgo is asked afresh whether this user has routing, which then turns on by default. */
export function relayAfterSignIn() {
  sup.avail = undefined;
  sup.defaultFailedAt = undefined;
  void reconcile();
}

// ── The switch ──────────────────────────────────────────────────────────────────────────────

/** Pair this Mac if it isn't, turn the switch on, and start the agent (reconcile then switches the computers). */
async function switchOn() {
  await ensurePaired();
  update((s) => (s.relay = { ...s.relay, on: true }));
  sup.want = true;
  sup.failures = 0;
  await startAgent();
}

/** How long a failed try at turning routing on by default holds off the next. */
const DEFAULT_RETRY_MS = 10 * 60_000;

/**
 * On by default: once Orgo offers routing to the signed-in user and this copy of Bops has the relay,
 * it turns on by itself, unless the user turned it off. Says whether it did.
 */
async function turnOnByDefault() {
  const relay = getState().relay;
  if (relay?.on || relay?.turnedOff || !signedInUser() || !relayBin()) return false;
  if (sup.defaultFailedAt && Date.now() - sup.defaultFailedAt < DEFAULT_RETRY_MS) return false;
  if (!(await availability()).ok) return false;
  try {
    await switchOn();
  } catch (e) {
    sup.defaultFailedAt = Date.now();
    throw e;
  }
  return true;
}

/** The user turns routing through this Mac on (pair if needed, start the agent, switch computers) or off, which stays off until they turn it on. */
export async function setRelay(on: boolean): Promise<RelayStatus> {
  if (on) {
    const status = await relayStatus(true);
    if (!status.available) return status;
    update((s) => {
      if (s.relay) delete s.relay.turnedOff;
    });
    await switchOn();
  } else update((s) => (s.relay = { ...s.relay, on: false, turnedOff: true }));
  sup.avail = undefined;
  sup.nowUntil = Date.now() + 2 * 60_000;
  void reconcile();
  return relayStatus();
}

/**
 * Before signing out: put every computer back (whatever it's doing: the key that drives them is
 * leaving), stop the agent, and forget this user's device here (the pairing stays in the Keychain
 * for when they sign in again). Waits for a run of reconcile already going (it stops at the next
 * computer), then for the computers, at most `ms` in all. A computer not back by then keeps its
 * route in state (with what's left to do), so the next sign-in finishes putting it back.
 */
export async function stopRelay(ms = 150_000) {
  if (onPostgres()) return;
  sup.stopping = true;
  const deadline = Date.now() + ms;
  const until = (p: Promise<unknown>) => Promise.race([p, new Promise((r) => setTimeout(r, Math.max(0, deadline - Date.now())))]);
  try {
    update((s) => (s.relay = { ...s.relay, on: false }));
    if (sup.reconciling) await until(sup.reconciling);
    const routes = Object.keys(getState().relayRoutes ?? {});
    if (routes.length && orgoKey() && Date.now() < deadline) await until(Promise.allSettled(routes.map(unrouteOne)));
  } finally {
    stopAgent();
    sup.code = undefined;
    sup.avail = undefined;
    // The device goes with the user; their own "off" stays for the next sign-in.
    update((s) => (s.relay = { on: false, ...(s.relay?.turnedOff ? { turnedOff: true } : {}) }));
    sup.stopping = false;
  }
}

// Keep at it: resume after a restart of the server, retry computers that were busy or failed.
if (!sup.tick) {
  sup.tick = setInterval(() => void reconcile(), TICK_MS);
  // The agent goes with this server.
  process.once("exit", () => sup.child?.kill("SIGTERM"));
}
setTimeout(() => void loadOrgoKey().then(() => reconcile()), 3000).unref?.();
