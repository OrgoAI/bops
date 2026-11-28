#!/usr/bin/env node
// The keeper on a Bops computer: it keeps this computer's Bops runner there, and on the newest signed release, when
// Bops Cloud says it may. Run by supervisord as root (program bops-keeper: vm/runner-steps.mjs KEEPER_CONF), from
// /opt/bops/keeper/keeper.mjs with its steps beside it (runner-steps.mjs): the template puts both there
// (orgo/bops-base.mjs), and so does each runner from its own bundle (lib/server/runner-start.ts ensureKeeper). Plain
// Node 24 ESM: it imports nothing but those steps and node:*.
//
// What it does, and what it never does:
// - It signs in only with this computer's own Orgo identity (its VMM, as lib/server/vm-identity.ts asks), never a key.
//   It never prints or writes that token, a query or a body, and it calls no Orgo computer route, so it never wakes the
//   computer or counts as using it. It runs only while the computer is up.
// - It installs only a release signed with a key built into runner-steps.mjs (RELEASE_KEYS): nothing in the
//   environment, keeper.json or any file adds a key or changes one. The release's bundle is checked against its sha256
//   as it downloads. Never the same or an older version over the runner there.
// - It asks Bops Cloud first (POST /v1/runner/keeper), which answers only whether it may (nothing, install, update), why,
//   and when to ask again: never a place or a version. It also refuses by itself where the account's bots work on the
//   Mac, where a key on a computer someone else can use could be read there, and on a computer Orgo doesn't count as a
//   Bops computer.
// - It updates only between turns (the install script's busy checks: a reply marked, a thread of the runner's own
//   going), holds the Mac's own look off while it works (KEEPER_HOLD), and goes back to the build before when the new one
//   fails its health check. It leaves a pinned runner alone (a dev Mac's own build: KEEPER_DIR/pin), sets none up for an
//   hour after the Mac took one off (KEEPER_DIR/off), and stops for a day after setting one up 3 times in a day.
//
// Its log lines are words only: "updated 0.0.55 to 0.0.56", "rolled back 0.0.56: it didn't answer on its computer".
// docs/cloud-runner.md "Set up and updated on its own computer" says it all for people.
import { spawn } from "node:child_process";
import { createHash } from "node:crypto";
import { createWriteStream, existsSync, realpathSync } from "node:fs";
import { mkdir, readdir, readFile, readlink, rename, rm, stat, writeFile } from "node:fs/promises";
import { Agent, request } from "node:http";
import { fileURLToPath } from "node:url";

// Its steps: beside it on a computer (KEEPER_DIR), one folder up in this repo and in a runner's bundle (vm/).
const STEPS = await import(existsSync(new URL("./runner-steps.mjs", import.meta.url)) ? "./runner-steps.mjs" : "../runner-steps.mjs");
const { KEEPER_DIR, KEEPER_HOLD, KEY_LINE, ROOT, RUNNER_CONF, RUNNER_KEEPER_LOOK, RUNNER_TURNS_DIR, RUNNER_WORKING, RUNNER_WRAPPER, HEALTH_SCRIPT, installScript, q, verifyRelease, wrapperScript } = STEPS;

/** The keeper's own version, sent with each ask (KeeperAsk.keeper): moved on when what it does changes. */
export const KEEPER_VERSION = "1";

const SEC = 1000;
const MIN = 60 * SEC;
const HOUR = 60 * MIN;
/** Its first look comes a minute after it starts, and it looks whether a look is due every 30 seconds after that. */
export const START_MS = MIN;
export const TICK_MS = 30 * SEC;
/** With no runner it looks after 2 minutes, then 4, 8 and so on up to 30; with one, every hour and a while (JITTER_MS). */
export const NO_RUNNER_MIN_MS = 2 * MIN;
export const NO_RUNNER_MAX_MS = 30 * MIN;
export const EVERY_MS = HOUR;
export const JITTER_MS = HOUR;
/** The wall clock moved this much more than the time it waited (a snapshot restored, a computer woken): it looks at once. */
export const JUMP_MS = MIN;
/** Its computer's identity refused (403), or not had otherwise: asked again after these. */
export const REFUSED_WAIT_MS = 10 * MIN;
export const NO_IDENTITY_WAIT_MS = 5 * MIN;
/** Orgo says this isn't a Bops computer: asked again after this. */
export const NOT_BOPS_WAIT_MS = 6 * HOUR;
/** The runner busy with a reply or a thread of its own: tried again after this. */
export const BUSY_WAIT_MS = 5 * MIN;
/** Bops Cloud's word on when to ask again is taken between these. */
const HINT_MIN_MS = MIN;
const HINT_MAX_MS = 6 * HOUR;
/** None set up for this long after the owner's Mac took the runner off (KEEPER_DIR/off). */
export const OFF_MS = HOUR;
/** Set up this many times in FLAP_WINDOW_MS (the Mac taking it down each time): it stops setting one up for FLAP_STOP_MS. */
export const FLAP_COUNT = 3;
export const FLAP_WINDOW_MS = 24 * HOUR;
export const FLAP_STOP_MS = 24 * HOUR;
/** A build that failed its health check here is skipped for this long, and for good after FAILED_MAX failures. */
export const FAILED_SKIP_MS = 12 * HOUR;
export const FAILED_MAX = 3;
/** How long each call may take. */
const CALL_MS = 15 * SEC;
const DOWNLOAD_MS = 30 * MIN;
const INSTALL_MS = 10 * MIN;
const HEALTH_MS = 6 * MIN;
const SHORT_MS = 30 * SEC;
/** The most of an answer it reads (but the bundle, read up to its release's size). */
const MAX_ANSWER = 64 * 1024;
/** A turn marked or the runner's working marker touched this recently: the runner is busy (as the install script says). */
const BUSY_MARK_MS = 2 * MIN;

/** The same checks as lib/server/runner-install.ts install(): where Orgo and Bops Cloud are must be reachable from here. */
const ORIGIN = /^https?:\/\/[A-Za-z0-9.-]+(?::\d+)?(?:\/[A-Za-z0-9._~/-]*)?$/;
const LOOPBACK_URL = /^https?:\/\/(?:localhost|127\.|\[::1\]|0\.0\.0\.0)/i;
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const VERSION = /^\d{1,4}\.\d{1,4}\.\d{1,6}$/;
const BUILD_DIR = /^(\d{1,4}\.\d{1,4}\.\d{1,6})-([A-Za-z0-9_-]{1,64})$/;
const ZONE = /^[A-Za-z0-9_+/-]{1,64}$/;
const DO = new Set(["nothing", "install", "update"]);

/** What a health check that didn't pass says, in the Mac's words (runner-install.ts UNHEALTHY). */
const UNHEALTHY = {
  down: "it didn't answer on its computer",
  nostate: "it couldn't sign in on its computer",
  exposed: "it listened beyond its own computer",
  unknown: "its computer can't say what it listens on",
  lost: "its computer didn't answer",
};

/* ---------------- What it runs with ---------------- */

/**
 * Everything the keeper touches, so tests can stand in for each: `at` maps a path on the computer to where it is
 * (the same path here), `sh` runs a script as `sh -c` does (its output, never logged), `fetch`, the clocks (`now`: the
 * wall clock, `mono`: one that never jumps), `vmm`: where the computer's VMM answers, `log`: a line of words, `sleep`.
 * `releaseKeys` only in tests: the keeper itself always checks releases against RELEASE_KEYS.
 */
export function defaultEnv() {
  return {
    at: (p) => p,
    sh: runSh,
    fetch: (url, init) => globalThis.fetch(url, init),
    now: () => Date.now(),
    mono: () => performance.now(),
    vmm: "http://169.254.169.254",
    log: (line) => console.log(`[keeper] ${line}`),
    sleep: (ms) => new Promise((r) => setTimeout(r, ms)),
  };
}

/** A script run as `sh -c` would: what it printed and how it ended. Never throws; never prints. */
function runSh(script, timeoutMs = INSTALL_MS) {
  return new Promise((resolve) => {
    let out = "";
    let done = false;
    const p = spawn("sh", ["-c", script], { stdio: ["ignore", "pipe", "pipe"] });
    const t = setTimeout(() => p.kill("SIGKILL"), timeoutMs);
    const finish = (code) => {
      if (done) return;
      done = true;
      clearTimeout(t);
      resolve({ code, out });
    };
    p.stdout.on("data", (c) => (out = (out + c).slice(-64 * 1024)));
    p.stderr.on("data", () => {});
    p.on("error", () => finish(-1));
    p.on("close", (code) => finish(code ?? -1));
  });
}

/* ---------------- Its files ---------------- */

const file = (env, name) => env.at(`${KEEPER_DIR}/${name}`);
const stripSlash = (s) => s.replace(/\/+$/, "");

/**
 * keeper.json: where Orgo is, where Bops Cloud is (with its /api) and where releases are (a folder: latest.json and the
 * bundles beside it). Each checked as the Mac's install() checks Orgo and Bops Cloud: an http(s) origin with an optional
 * plain path, never one on the computer itself. Anything else in it is ignored (a key, say). Null when any is missing or
 * wrong: then the keeper does nothing.
 */
export async function readConfig(env) {
  let j;
  try {
    j = JSON.parse(await readFile(file(env, "keeper.json"), "utf8"));
  } catch {
    return null;
  }
  if (!j || typeof j !== "object" || Array.isArray(j)) return null;
  const ok = (v) => typeof v === "string" && v.length <= 200 && ORIGIN.test(v) && !LOOPBACK_URL.test(v);
  if (!ok(j.orgo) || !ok(j.cloud) || !ok(j.releases)) return null;
  return { orgo: stripSlash(j.orgo), cloud: stripSlash(j.cloud), releases: `${stripSlash(j.releases)}/` };
}

/** state.json as it was, or a fresh one: the computer it's for, the builds that failed here, and when it set one up. */
export async function readState(env) {
  let j = null;
  try {
    j = JSON.parse(await readFile(file(env, "state.json"), "utf8"));
  } catch {}
  const s = { desktopId: null, failed: {}, installs: [] };
  if (!j || typeof j !== "object" || Array.isArray(j)) return s;
  if (typeof j.desktopId === "string" && UUID.test(j.desktopId)) s.desktopId = j.desktopId.toLowerCase();
  if (j.failed && typeof j.failed === "object" && !Array.isArray(j.failed))
    for (const [k, v] of Object.entries(j.failed)) if (BUILD_DIR.test(k) && v && Number.isFinite(v.at) && Number.isInteger(v.n) && v.n > 0) s.failed[k] = { at: v.at, n: v.n };
  if (Array.isArray(j.installs)) s.installs = j.installs.filter(Number.isFinite).slice(-20);
  if (Number.isFinite(j.flapUntil)) s.flapUntil = j.flapUntil;
  if (isOutcome(j.outcome)) s.outcome = j.outcome;
  if (j.unjudged && typeof j.unjudged === "object" && BUILD_DIR.test(j.unjudged.build) && (j.unjudged.prev === null || BUILD_DIR.test(j.unjudged.prev)))
    s.unjudged = { build: j.unjudged.build, prev: j.unjudged.prev, from: VERSION.test(j.unjudged.from ?? "") ? j.unjudged.from : null };
  return s;
}

const OUTCOMES = new Set(["installed", "updated", "rolledBack", "failed", "busy", "flapping", "sharedKey"]);
const isOutcome = (o) => !!o && typeof o === "object" && OUTCOMES.has(o.kind) && VERSION.test(o.version ?? "") && /^[A-Za-z0-9_-]{1,64}$/.test(o.buildId ?? "");

/** Written whole, through a file beside it, root's alone. */
export async function writeState(env, s) {
  await mkdir(env.at(KEEPER_DIR), { recursive: true });
  const to = file(env, "state.json");
  await writeFile(`${to}.next`, `${JSON.stringify(s)}\n`, { mode: 0o600 });
  await rename(`${to}.next`, to);
}

const mtimeOf = async (p) => (await stat(p).catch(() => null))?.mtimeMs ?? null;

/** The Mac took the runner off (UNINSTALL_SCRIPT writes `{"at": <epoch s>, "why": "mac"}`): when, in epoch seconds, or null. */
async function offAt(env) {
  const p = file(env, "off");
  const text = await readFile(p, "utf8").catch(() => null);
  if (text === null) return null;
  try {
    const at = JSON.parse(text).at;
    if (Number.isInteger(at) && at > 0) return at;
  } catch {}
  const m = await mtimeOf(p);
  return m === null ? null : Math.floor(m / 1000);
}

/* ---------------- Asking over the network ---------------- */

/**
 * The computer's identity token from its VMM, as the runner asks for it (lib/server/vm-identity.ts): node:http with an
 * agent of its own (no proxy, no keep alive), no redirects, 1 second to connect and 10 in all, `Metadata-Flavor: Orgo`.
 * `{ok, token, desktopId}`, or `{ok: false, status}` (0: nothing answered). The token is never logged.
 */
export function identity(env) {
  const url = new URL("/orgo/v1/identity/token", env.vmm);
  const agent = new Agent({ keepAlive: false });
  return new Promise((resolve) => {
    let connected = false;
    let done = false;
    const finish = (v) => {
      if (done) return;
      done = true;
      clearTimeout(connectTimer);
      clearTimeout(totalTimer);
      agent.destroy();
      resolve(v);
    };
    const req = request({ host: url.hostname, port: Number(url.port) || 80, path: url.pathname, method: "GET", agent, headers: { "Metadata-Flavor": "Orgo", Accept: "application/json" } }, (res) => {
      const chunks = [];
      let size = 0;
      res.on("data", (c) => {
        size += c.length;
        if (size > MAX_ANSWER) {
          req.destroy();
          finish({ ok: false, status: 0 });
        } else chunks.push(c);
      });
      res.on("end", () => {
        if (res.statusCode !== 200) return finish({ ok: false, status: res.statusCode ?? 0 });
        let b = null;
        try {
          b = JSON.parse(Buffer.concat(chunks).toString("utf8"));
        } catch {}
        const token = typeof b?.token === "string" ? b.token : "";
        const desktopId = typeof b?.desktop_id === "string" ? b.desktop_id : "";
        if (!token.startsWith("orgo_vm_") || !UUID.test(desktopId)) return finish({ ok: false, status: 0 });
        finish({ ok: true, token, desktopId: desktopId.toLowerCase() });
      });
      res.on("error", () => finish({ ok: false, status: 0 }));
    });
    req.on("socket", (s) => {
      if (!s.connecting) connected = true;
      else s.once("connect", () => (connected = true));
    });
    req.on("error", () => finish({ ok: false, status: 0 }));
    const connectTimer = setTimeout(() => {
      if (connected) return;
      req.destroy();
      finish({ ok: false, status: 0 });
    }, 1000);
    const totalTimer = setTimeout(() => {
      req.destroy();
      finish({ ok: false, status: 0 });
    }, 10_000);
    req.end();
  });
}

/** A call's answer read whole (at most `max` bytes, 200 only, no redirect followed): its text, or null. Never throws. */
async function textOf(env, url, init = {}, max = MAX_ANSWER) {
  let res;
  try {
    res = await env.fetch(url, { ...init, redirect: "manual", signal: AbortSignal.timeout(CALL_MS) });
  } catch {
    return { status: 0, text: null };
  }
  if (res.status !== 200) {
    await res.body?.cancel().catch(() => {});
    return { status: res.status, text: null };
  }
  const chunks = [];
  let n = 0;
  try {
    const reader = res.body.getReader();
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      n += value.byteLength;
      if (n > max) {
        await reader.cancel().catch(() => {});
        return { status: res.status, text: null };
      }
      chunks.push(value);
    }
  } catch {
    return { status: res.status, text: null };
  }
  return { status: 200, text: Buffer.concat(chunks).toString("utf8") };
}

const jsonOf = (text) => {
  try {
    return JSON.parse(text);
  } catch {
    return null;
  }
};

/**
 * Where Orgo says the account's bots work, and what it says of this computer (GET /api/bops/settings, on the identity):
 * `runsOn` "cloud" or "mac" (none set means the Mac), and `computer` `{shared, bops}` (someone else can use it; it's a
 * Bops computer), or null when Orgo didn't say. Both null when it didn't answer.
 */
export async function settings(env, cfg, token) {
  const got = await textOf(env, `${cfg.orgo}/api/bops/settings`, { headers: { Authorization: `Bearer ${token}`, Accept: "application/json" } });
  const j = got.text === null ? null : jsonOf(got.text);
  if (!j || typeof j !== "object") return { runsOn: null, computer: null, read: false };
  const runsOn = j.runsOn === "cloud" ? "cloud" : j.runsOn === "mac" || j.runsOn === null ? "mac" : null;
  const c = j.computer;
  const computer = c && typeof c === "object" && typeof c.shared === "boolean" && typeof c.bops === "boolean" ? { shared: c.shared, bops: c.bops } : null;
  return { runsOn, computer, read: true };
}

/** The newest signed release (`{releases}latest.json`, checked against the keys built in), or null. */
export async function latest(env, cfg) {
  const got = await textOf(env, `${cfg.releases}latest.json`, { headers: { Accept: "application/json" } });
  return got.text === null ? null : verifyRelease(got.text, ...(env.releaseKeys ? [env.releaseKeys] : []));
}

/** Whether Bops Cloud answers (its /health, 200): when it doesn't, a runner that never got the user's state isn't judged. */
async function cloudUp(env, cfg) {
  return (await textOf(env, `${cfg.cloud}/health`)).status === 200;
}

/**
 * Ask Bops Cloud (POST /v1/runner/keeper, KeeperAsk) on the identity: its answer `{do, why, retryS}`, or null when it
 * didn't give one. Nothing else in the answer is read.
 */
export async function askCloud(env, cfg, token, ask) {
  const version = ask.runner?.version ?? KEEPER_VERSION;
  const got = await textOf(env, `${cfg.cloud}/v1/runner/keeper`, {
    method: "POST",
    headers: { Authorization: `Bearer ${token}`, "content-type": "application/json", accept: "application/json", "x-bops-version": version },
    body: JSON.stringify(ask),
  });
  const j = got.text === null ? null : jsonOf(got.text);
  if (!j || !DO.has(j.do) || typeof j.why !== "string" || !Number.isFinite(j.retryS)) return null;
  return { do: j.do, why: /^[A-Za-z]{1,40}$/.test(j.why) ? j.why : "unknown", retryS: j.retryS };
}

/**
 * The release's bundle into `{ROOT}/incoming/<name>`: read up to its size, hashed as it comes, written beside it first
 * and put in place only when its size and sha256 are the release's. Anything else is deleted. Whether it's there.
 */
export async function download(env, cfg, r) {
  const dir = env.at(`${ROOT}/incoming`);
  await mkdir(dir, { recursive: true });
  const to = `${dir}/${r.name}`;
  const part = `${to}.part`;
  const drop = async () => {
    await rm(part, { force: true });
    return false;
  };
  let res;
  try {
    res = await env.fetch(`${cfg.releases}${r.name}`, { redirect: "manual", signal: AbortSignal.timeout(DOWNLOAD_MS) });
  } catch {
    return false;
  }
  if (res.status !== 200) {
    await res.body?.cancel().catch(() => {});
    return false;
  }
  const said = Number(res.headers.get("content-length"));
  if (res.headers.get("content-length") !== null && said !== r.size) {
    await res.body?.cancel().catch(() => {});
    return false;
  }
  const hash = createHash("sha256");
  const out = createWriteStream(part, { mode: 0o600 });
  let n = 0;
  try {
    const reader = res.body.getReader();
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      n += value.byteLength;
      if (n > r.size) {
        await reader.cancel().catch(() => {});
        throw new Error("too big");
      }
      hash.update(value);
      if (!out.write(value)) await new Promise((ok) => out.once("drain", ok));
    }
    await new Promise((ok, no) => out.end((e) => (e ? no(e) : ok())));
  } catch {
    out.destroy();
    return drop();
  }
  if (n !== r.size || hash.digest("hex") !== r.sha256) return drop();
  await rename(part, to);
  return true;
}

/* ---------------- On this computer ---------------- */

/**
 * The runner here: its program and script (RUNNER_CONF, RUNNER_WRAPPER) and the build `current` points at, with its
 * server.js; `up` while supervisord runs it. `have`: the build `current` points at, whether or not the rest is there
 * (a copy keeps the build when its runner was taken off: RUNNER_SCRUB). Null runner when any part is missing.
 */
export async function findRunner(env) {
  const link = await readlink(env.at(`${ROOT}/current`)).catch(() => null);
  const m = link ? BUILD_DIR.exec(link.replace(/^.*\//, "")) : null;
  const have = m && existsSync(env.at(`${ROOT}/${m[0]}/server.js`)) ? { dir: m[0], version: m[1], buildId: m[2] } : null;
  const present = !!have && existsSync(env.at(RUNNER_CONF)) && existsSync(env.at(RUNNER_WRAPPER));
  if (!present) return { runner: null, have };
  const status = await env.sh("supervisorctl status bops-runner 2>/dev/null | grep -qE 'RUNNING|STARTING' && echo running=yes || echo running=no", SHORT_MS);
  return { runner: { version: have.version, buildId: have.buildId, up: /^running=yes$/m.test(status.out) }, have };
}

/** Only whether the runner's files are there (each tick: no command run). */
async function runnerFiles(env) {
  return (await findRunner({ ...env, sh: async () => ({ code: 0, out: "" }) })).runner !== null;
}

/** Whether a line that sets ORGO_API_KEY is on the computer (KEY_LINE: grep alone, never printed). */
async function keyHere(env) {
  return /^key=yes$/m.test((await env.sh(KEY_LINE, SHORT_MS)).out);
}

/** The runner is answering a reply (a mark in RUNNER_TURNS_DIR) or running a thread of its own (RUNNER_WORKING), lately. */
export async function busyHere(env) {
  const now = env.now();
  const fresh = (m) => m !== null && now - m < BUSY_MARK_MS;
  if (fresh(await mtimeOf(env.at(RUNNER_WORKING)))) return true;
  const dir = env.at(RUNNER_TURNS_DIR);
  for (const f of await readdir(dir).catch(() => [])) if (fresh(await mtimeOf(`${dir}/${f}`))) return true;
  return false;
}

/** The time zone an earlier start script set (TZ), so a runner set up again keeps it; else none (routines.ts keepZone). */
async function zoneKept(env) {
  const text = await readFile(env.at(RUNNER_WRAPPER), "utf8").catch(() => "");
  const z = /^export TZ='([^']*)'$/m.exec(text)?.[1];
  return z && ZONE.test(z) ? z : undefined;
}

/** Touch a marker (made with its folder). */
async function touch(p, text = "") {
  await mkdir(p.replace(/\/[^/]*$/, ""), { recursive: true });
  await writeFile(p, text);
}

/**
 * Going back to the build before (`prev`), under the runners' lock: `current` swapped back in one rename, the runner
 * restarted on it, and the build that failed gone. Says __BOPS_BACK__ when it got that far.
 */
export function rollbackScript(prev, bad) {
  return [
    "set -e",
    `d=${ROOT}`,
    `exec 9>"$d/.lock"`,
    "flock -w 120 9",
    `test -f "$d/"${q(prev)}/server.js`,
    `ln -sfn ${q(prev)} "$d/current.next"`,
    `mv -Tf "$d/current.next" "$d/current"`,
    ": > /var/log/bops/runner.log",
    `rm -f ${ROOT}/auth`,
    "supervisorctl restart bops-runner >/dev/null 2>&1 || true",
    `rm -rf "$d/"${q(bad)}`,
    "echo __BOPS_BACK__",
  ].join("\n");
}

/* ---------------- Versions ---------------- */

const parts = (v) => v.split(".").map(Number);
/** Whether version `a` is older than `b` (x.y.z). */
export function olderThan(a, b) {
  const [x, y] = [parts(a), parts(b)];
  for (let i = 0; i < 3; i++) if (x[i] !== y[i]) return x[i] < y[i];
  return false;
}

/** A while from 0 to JITTER_MS, the same each time for one computer and different across copies of one. */
export function jitterOf(desktopId) {
  return createHash("sha256").update(`bops-keeper\n${desktopId}`).digest().readUInt32BE(0) % JITTER_MS;
}

/* ---------------- A look ---------------- */

/**
 * The keeper: `tick` (every TICK_MS) looks when one is due (`look`). What it keeps in memory between looks: when it last
 * looked and ticked, how long to wait with no runner, when Bops Cloud said to ask again (`hint`), and until when it
 * doesn't look at all (`hold`). Nothing about the computer: each look asks afresh.
 */
export function makeKeeper(env = defaultEnv()) {
  const k = { env, lastLook: null, lastTick: null, backoff: NO_RUNNER_MIN_MS, absent: false, hint: null, hold: 0, jitter: 0, said: "" };
  return { k, tick: () => tick(k), look: () => look(k) };
}

/** A line in its log, only when it changes (`always`: what it did, said each time). Words only. */
function say(k, line, always = false) {
  if (line === k.said && !always) return;
  k.said = line;
  k.env.log(line);
}

/** Whether a look is due now (`why`), and the look when it is. */
export async function tick(k) {
  const { env } = k;
  const now = env.now();
  const mono = env.mono();
  let jumped = false;
  if (k.lastTick) jumped = Math.abs(now - k.lastTick.now - (mono - k.lastTick.mono)) > JUMP_MS;
  k.lastTick = { now, mono };
  if (jumped) {
    // Restored from a snapshot, or woken: maybe another computer, or a long while later. Whatever it waited for is over.
    k.hold = 0;
    k.hint = null;
    return look(k, "jump");
  }
  if (now < k.hold) return null;
  const nudged = await mtimeOf(env.at(RUNNER_KEEPER_LOOK));
  if (nudged !== null && (k.lastLook === null || nudged > k.lastLook)) return look(k, "nudged");
  if (k.lastLook === null) return look(k, "first");
  if (k.hint !== null && now >= k.hint) return look(k, "hint");
  const wait = (await runnerFiles(env)) ? EVERY_MS + k.jitter : k.backoff;
  return now >= k.lastLook + wait ? look(k, "due") : null;
}

/**
 * One look, in this order: a pin means nothing; the computer's identity; another computer than state.json's starts it
 * afresh; the runner here; what Orgo says; the newest signed release; Bops Cloud's answer; then, when it says install or
 * update and nothing here says no, the install or update itself. What it did, for tests and the log.
 */
export async function look(k, why = "asked") {
  const { env } = k;
  const now = env.now();
  k.lastLook = now;
  k.hint = null;
  const out = await lookOnce(k, now).catch(() => ({ did: "error" }));
  if (out.did === "error") say(k, "a look went wrong: it looks again later");
  // With no runner it looks again in 2 minutes, then 4, 8 and so on up to 30; with one, hourly and a while.
  const present = await runnerFiles(env).catch(() => false);
  k.backoff = present || !k.absent ? NO_RUNNER_MIN_MS : Math.min(NO_RUNNER_MAX_MS, k.backoff * 2);
  k.absent = !present;
  return { ...out, why };
}

async function lookOnce(k, now) {
  const { env } = k;
  // 1. A dev Mac's own build here: never replaced.
  if (existsSync(file(env, "pin"))) {
    say(k, "the runner here is pinned (a build of the owner's own): left as it is");
    return { did: "pinned" };
  }
  const cfg = await readConfig(env);
  if (!cfg) {
    say(k, "keeper.json isn't right here: nothing done");
    return { did: "noConfig" };
  }
  // 2. The computer's own identity.
  const id = await identity(env);
  if (!id.ok) {
    const refused = id.status === 403;
    k.hold = now + (refused ? REFUSED_WAIT_MS : NO_IDENTITY_WAIT_MS);
    say(k, refused ? "this computer's identity was refused: asks again in 10 minutes" : "this computer has no identity now: asks again in 5 minutes");
    return { did: refused ? "refused" : "noIdentity" };
  }
  k.jitter = jitterOf(id.desktopId);
  // 3. Another computer than the one it kept state for (a copy, or a new VM): what it knew of the other goes.
  let st = await readState(env);
  if (st.desktopId !== id.desktopId) {
    st = { desktopId: id.desktopId, failed: {}, installs: [] };
    await writeState(env, st);
  }
  // A build put in place last time that wasn't judged (Bops Cloud didn't answer then): judged now.
  if (st.unjudged) {
    const r = await findRunner(env);
    if (r.have?.dir === st.unjudged.build) {
      return judge(k, cfg, id, st, st.unjudged, r.have);
    }
    delete st.unjudged;
    await writeState(env, st);
  }
  return askAndAct(k, cfg, id, st);
}

/** Steps 4 to 9: what's here, what Orgo and the release say, Bops Cloud's answer, and what's done with it. */
async function askAndAct(k, cfg, id, st) {
  const { env } = k;
  // 4. The runner here, a key line, and whether it's busy.
  const { runner, have } = await findRunner(env);
  const key = await keyHere(env);
  const busy = await busyHere(env);
  const off = await offAt(env);
  // 5. Orgo: where the bots work, and this computer.
  const set = await settings(env, cfg, id.token);
  // 6. The newest signed release.
  const release = await latest(env, cfg);
  // 7. Bops Cloud.
  const told = st.outcome;
  const ask = {
    keeper: KEEPER_VERSION,
    runner,
    latest: release ? { version: release.version, buildId: release.buildId } : null,
    busy,
    ...(off !== null ? { off } : {}),
    key,
    runsOn: set.runsOn,
    computer: set.computer,
    ...(told ? { outcome: told } : {}),
  };
  const answer = await askCloud(env, cfg, id.token, ask);
  if (told && answer) {
    delete st.outcome;
    await writeState(env, st);
  } else if (told && !answer) {
    st.outcome = told;
    await writeState(env, st);
  }
  if (!answer) {
    say(k, "Bops Cloud didn't answer: asks again later");
    return { did: "noAnswer", ask };
  }
  k.hint = env.now() + Math.min(HINT_MAX_MS, Math.max(HINT_MIN_MS, answer.retryS * 1000));
  // 8. Never set up here, whatever Bops Cloud said (it was still asked, so it knows why).
  const refusal = !set.read
    ? "noSettings"
    : set.runsOn !== "cloud"
      ? "accountMac"
      : key && (set.computer === null || set.computer.shared)
        ? "sharedKey"
        : set.computer?.bops === false
          ? "notOnMap"
          : null;
  if (refusal === "notOnMap") k.hold = env.now() + NOT_BOPS_WAIT_MS;
  if (answer.do === "nothing" || refusal) {
    if (refusal === "noSettings") say(k, "Orgo didn't say where the bots work: nothing set up here for now");
    else if (refusal === "accountMac") say(k, "the bots work on the Mac (Settings): nothing set up here");
    else if (refusal === "sharedKey") say(k, "a key is on this computer and someone else may use it: nothing set up here");
    else if (refusal === "notOnMap") say(k, "Orgo doesn't count this as a Bops computer: asks again in 6 hours");
    else say(k, `nothing to do (${answer.why})`);
    if (refusal === "sharedKey" && answer.do !== "nothing" && release) await report(k, cfg, id, st, { kind: "sharedKey", version: release.version, buildId: release.buildId });
    return { did: "nothing", ask, answer, refusal };
  }
  // 9. Install (no runner here) or update (an older one here), as Bops Cloud said for what this ask said.
  if (!release || (answer.do === "install") !== !runner) return { did: "nothing", ask, answer };
  return act(k, cfg, id, st, { runner, have, release, busy, off, answer });
}

/** Say how it went (the next ask's outcome, sent now), keeping it for later when Bops Cloud doesn't answer. */
async function report(k, cfg, id, st, outcome) {
  const env = k.env;
  st.outcome = outcome;
  await writeState(env, st);
  const { runner } = await findRunner(env);
  const set = await settings(env, cfg, id.token);
  const ask = { keeper: KEEPER_VERSION, runner, latest: { version: outcome.version, buildId: outcome.buildId }, busy: await busyHere(env), key: await keyHere(env), runsOn: set.runsOn, computer: set.computer, outcome };
  const off = await offAt(env);
  if (off !== null) ask.off = off;
  const answer = await askCloud(env, cfg, id.token, ask);
  if (answer) {
    delete st.outcome;
    await writeState(env, st);
    k.hint = env.now() + Math.min(HINT_MAX_MS, Math.max(HINT_MIN_MS, answer.retryS * 1000));
  }
}

/** The install or update itself, past its own guards. */
async function act(k, cfg, id, st, { runner, have, release, busy, off }) {
  const { env } = k;
  const now = env.now();
  const dir = `${release.version}-${release.buildId}`;
  // Never the same or an older version over the runner here, nor over the build its copy kept.
  if (runner && !olderThan(runner.version, release.version)) return { did: "nothing", same: true };
  if (!runner && have && olderThan(release.version, have.version)) return { did: "nothing", same: true };
  // The owner's Mac took the runner off within the hour.
  if (off !== null && now - off * 1000 < OFF_MS) {
    say(k, "the owner's Mac took the runner off: nothing set up here for an hour");
    return { did: "off" };
  }
  // Set up too often lately (something takes it down each time): stopped for a day.
  if (!runner) {
    if (st.flapUntil && now < st.flapUntil) return { did: "flapping" };
    const lately = st.installs.filter((t) => now - t < FLAP_WINDOW_MS);
    if (lately.length >= FLAP_COUNT) {
      st.flapUntil = now + FLAP_STOP_MS;
      await writeState(env, st);
      say(k, `set up ${FLAP_COUNT} times in a day: none set up here for a day`);
      await report(k, cfg, id, st, { kind: "flapping", version: release.version, buildId: release.buildId });
      return { did: "flapping" };
    }
  }
  // A build that failed here: skipped for 12 hours, and for good after 3 times (until a newer one).
  const failed = st.failed[dir];
  if (failed && (failed.n >= FAILED_MAX || now - failed.at < FAILED_SKIP_MS)) {
    say(k, `${release.version} failed here before: skipped`);
    return { did: "skipped" };
  }
  // The bundle, unless that build is here already (a copy, or one unpacked before).
  if (!existsSync(env.at(`${ROOT}/${dir}/server.js`)) && !(await download(env, cfg, release))) {
    say(k, `couldn't download ${release.version}: tries again later`);
    return { did: "noDownload" };
  }
  const busyNow = busy || (await busyHere(env));
  if (runner && busyNow) {
    say(k, "the runner is busy: tries again in 5 minutes");
    k.hold = env.now() + BUSY_WAIT_MS;
    k.hint = k.hold;
    await report(k, cfg, id, st, { kind: "busy", version: release.version, buildId: release.buildId });
    return { did: "busy" };
  }
  // Its script: this computer's id from its identity, Orgo and Bops Cloud from keeper.json, the time zone kept.
  const timeZone = await zoneKept(env);
  const wrapper = wrapperScript({ computerId: id.desktopId, orgo: cfg.orgo, cloud: cfg.cloud, ...(timeZone ? { timeZone } : {}) });
  const prev = runner ? have.dir : null;
  // Kept before the swap, so a keeper stopped halfway judges the build at its next look all the same.
  const job = { build: dir, prev, from: runner?.version ?? null };
  st.unjudged = job;
  await writeState(env, st);
  const unswapped = async () => {
    delete st.unjudged;
    await writeState(env, st);
  };
  // The Mac's look waits while this goes (KEEPER_HOLD), then the install script under the runners' lock.
  await touch(env.at(KEEPER_HOLD));
  try {
    const put = await env.sh(installScript(release, wrapper, prev ? { keep: prev } : {}), INSTALL_MS);
    if (put.out.includes("__BOPS_BUSY__")) {
      await unswapped();
      say(k, "the runner is busy: tries again in 5 minutes");
      k.hold = env.now() + BUSY_WAIT_MS;
      k.hint = k.hold;
      await report(k, cfg, id, st, { kind: "busy", version: release.version, buildId: release.buildId });
      return { did: "busy" };
    }
    if (!put.out.includes("__BOPS_INSTALLED__")) {
      // Not swapped, unless it got past the swap and failed after (then the next look judges it: `current` is the new one).
      if ((await findRunner(env)).have?.dir !== dir) await unswapped();
      say(k, `couldn't put ${release.version} in place: tries again later`);
      return { did: "notInstalled" };
    }
    if (!runner) {
      st.installs = [...st.installs.filter((t) => now - t < FLAP_WINDOW_MS), now];
      await writeState(env, st);
    }
    return await judge(k, cfg, id, st, job, { dir, version: release.version, buildId: release.buildId });
  } finally {
    await rm(env.at(KEEPER_HOLD), { force: true }).catch(() => {});
  }
}

/**
 * The health check of the build just put in place (HEALTH_SCRIPT, with KEEPER_DIR/judging there while it runs, so a
 * runner starting doesn't rewrite the keeper under it): healthy, it's reported installed or updated. Not healthy: a
 * first one is stopped and reported failed; an update goes back to the build before, which is restarted, and the new
 * one is marked failed here and reported rolled back. A runner that answered here but never got the user's state, while
 * Bops Cloud doesn't answer, isn't judged: that's Bops Cloud's outage, not the build's, and it's judged at the next look.
 */
async function judge(k, cfg, id, st, job, b) {
  const { env } = k;
  await touch(env.at(KEEPER_HOLD));
  try {
    return await judged(k, cfg, id, st, job, b);
  } finally {
    await rm(env.at(KEEPER_HOLD), { force: true }).catch(() => {});
  }
}

async function judged(k, cfg, id, st, job, b) {
  const { env } = k;
  await touch(file(env, "judging"), `${Math.floor(env.now() / 1000)}\n`);
  let health;
  try {
    health = await env.sh(HEALTH_SCRIPT, HEALTH_MS);
  } finally {
    await rm(file(env, "judging"), { force: true }).catch(() => {});
  }
  const o = health.out;
  const bad = o.includes("__BOPS_HEALTHY__") ? null : o.includes("__BOPS_EXPOSED__") ? "exposed" : o.includes("__BOPS_NO_SS__") ? "unknown" : o.includes("__BOPS_NO_STATE__") ? "nostate" : health.code === -1 ? "lost" : "down";
  if (bad && bad !== "exposed" && bad !== "unknown" && !(await cloudUp(env, cfg))) {
    say(k, `${b.version} isn't judged yet: Bops Cloud doesn't answer`);
    return { did: "unjudged" };
  }
  delete st.unjudged;
  const now = env.now();
  if (!bad) {
    await writeState(env, st);
    say(k, job.prev && job.from ? `updated ${job.from} to ${b.version}` : `set up ${b.version}`, true);
    await report(k, cfg, id, st, { kind: job.prev ? "updated" : "installed", version: b.version, buildId: b.buildId });
    return { did: job.prev ? "updated" : "installed" };
  }
  const was = st.failed[job.build];
  st.failed[job.build] = { at: now, n: (was?.n ?? 0) + 1 };
  await writeState(env, st);
  if (!job.prev) {
    await env.sh("supervisorctl stop bops-runner >/dev/null 2>&1; true", SHORT_MS);
    say(k, `couldn't set up ${b.version}: ${UNHEALTHY[bad]}`, true);
    await report(k, cfg, id, st, { kind: "failed", version: b.version, buildId: b.buildId, why: UNHEALTHY[bad] });
    return { did: "failed", bad };
  }
  const back = await env.sh(rollbackScript(job.prev, job.build), INSTALL_MS);
  say(k, back.out.includes("__BOPS_BACK__") ? `rolled back ${b.version}: ${UNHEALTHY[bad]}` : `couldn't roll back ${b.version}: ${UNHEALTHY[bad]}`, true);
  await report(k, cfg, id, st, { kind: "rolledBack", version: b.version, buildId: b.buildId, why: UNHEALTHY[bad] });
  return { did: "rolledBack", bad, back: back.out.includes("__BOPS_BACK__") };
}

/* ---------------- Running ---------------- */

/** A minute after it starts, then every TICK_MS: a look whenever one is due. Never throws. */
export async function main(env = defaultEnv()) {
  const keeper = makeKeeper(env);
  await env.sleep(START_MS);
  for (;;) {
    await keeper.tick().catch(() => say(keeper.k, "a look went wrong: it looks again later"));
    await env.sleep(TICK_MS);
  }
}

const self = fileURLToPath(import.meta.url);
const started = (() => {
  try {
    return !!process.argv[1] && realpathSync(process.argv[1]) === realpathSync(self);
  } catch {
    return false;
  }
})();
if (started) void main();
