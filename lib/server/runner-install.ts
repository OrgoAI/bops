import "server-only";
import { createHash } from "node:crypto";
import { readdirSync, readFileSync, statSync } from "node:fs";
import { readFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { workBot, type RunnerState } from "@/lib/types";
import { cloudUrl } from "./cloud-url";
import { othersWithFullAccess } from "./members";
import { apiKey, callOrgo, orgo } from "./orgo";
import { orgoOrigin } from "./orgo-auth";
import { loopHere } from "./persist";
import { deviceIdFor } from "./persist-cloud";
import { heardRunsOn, RUNNER_CONF, RUNNER_KEY_FILE, RUNNER_WRAPPER, runsOnMissing } from "./runner";
import { computerGone, endSessionsOf } from "./sessions";
import { flushState, getState, stateDevice, stateInCloud, stateReady, stateTooNew, update } from "./store";

/**
 * Bops runners on the bots' computers (runner.ts says what one is), set up and stopped from the Mac and
 * only from there. While the bots work in the Cloud (Orgo's word, runner.ts), each computer some bot
 * works on gets one: a computer as Orgo's map of the workspace has it (GET /api/projects/{id}/bops, which
 * answers only live Bops computers of the user's) and as this Mac has it too. Each step is in
 * AppState.runners, which every Mac and runner of the user's reads: Setting up, then Running once its
 * health check passed (only then does the Mac leave that computer's routines to it), or Couldn't start
 * and why (they stay on the Mac).
 *
 * Setting one up: the server bundle this app ships (scripts/server-bundle.sh: in the app's Resources, or
 * on a dev Mac the newest in dist-runner) goes up through Orgo's file uploads into the computer's
 * /opt/bops/runner/incoming; one command then checks it, unpacks it beside the others and points
 * `current` at it, under a lock, and writes its supervisord program (Orgo computers have no systemd)
 * and the script that starts it, which makes a fresh window token each time. Its key is one Orgo makes
 * and writes on the computer itself (PUT /api/computers/{id}/bops-runner-key): this Mac never has it,
 * and no command sent carries a key or a token. Never on a computer whose workspace has someone else
 * with Full access (root there; the key is the whole account's). A newer Bops is never replaced by an
 * older one; the same version built again replaces it only when this Mac set it up last (a dev Mac).
 *
 * Stopping one (the bots work on This Mac now, or in browsers on the Mac; its computer was deleted; no
 * bot works on it): its program is stopped and taken off with its key, its key revoked (by the Mac that
 * had it made: other Macs use it too, and only that one revokes it), its threads end, and it's taken out
 * of the state. A computer asleep isn't woken for that: its runner can't run anything without its key,
 * and it's taken off the next time the computer is up.
 *
 * Looked at once a minute; a full look (and a change: where the bots work, which computers they're on)
 * goes through each computer. Nothing here asks a computer that's asleep anything unless it sets a
 * runner up, which wakes it once.
 */

const ROOT = "/opt/bops/runner";
const PORT = 3210;
const NO_BUNDLE = "no server bundle";
const FULL_ACCESS = "someone else has Full access to this workspace";
/** Why its threads ended, in each case. */
const STOPPED = {
  mac: "Stopped: routines run on your Mac now.",
  host: "Stopped: your bots work in browsers on your Mac now.",
  gone: "Stopped: its computer was deleted.",
  moved: "Stopped: no bot works on this computer anymore.",
  full: `Stopped: ${FULL_ACCESS}.`,
};

/** A look at what changed every minute; every computer at least every 10 minutes. */
const CHECK_MS = 60_000;
const LOOK_EVERY_MS = 10 * 60_000;
/** A set-up that didn't work is tried again after this, twice as long each time it doesn't. */
const RETRY_MIN_MS = 30 * 60_000;
const RETRY_MAX_MS = 12 * 60 * 60_000;
/** Another Mac setting one up this long is taken to have stopped (quit mid-way). */
const INSTALLING_STALE_MS = 20 * 60_000;

/* ---------------- The bundle ---------------- */

export type Bundle = { file: string; name: string; version: string; buildId: string; sha256: string };
/** bops-server-<version>-<BUILD_ID>.tgz (Bops versions are x.y.z; Next's BUILD_ID is letters, digits, _ and -). */
const BUNDLE_NAME = /^bops-server-(\d+\.\d+\.\d+)-([A-Za-z0-9_-]{1,64})\.tgz$/;

/** The sha256 in a bundle's .sha256 file (`<hash>  <name>`, as shasum and sha256sum write it), when it's for that file. */
function shaOf(file: string, name: string): string | null {
  try {
    const m = /^([0-9a-f]{64})\s+\*?(\S+)\s*$/.exec(readFileSync(file, "utf8").trim());
    return m && m[2] === name ? m[1] : null;
  } catch {
    return null;
  }
}

/**
 * The server bundle this app sets runners up with: the one it ships (Resources/runner, beside its
 * server), or on a dev Mac (no packaged server) the newest in dist-runner. Null: none, so no runner.
 */
export function findBundle(): Bundle | null {
  const packaged = process.env.BOPS_SERVER_JS;
  const dir = packaged ? join(dirname(dirname(packaged)), "runner") : join(process.cwd(), "dist-runner");
  let names: string[];
  try {
    names = readdirSync(dir);
  } catch {
    return null;
  }
  const found = names
    .flatMap((name) => {
      const m = BUNDLE_NAME.exec(name);
      if (!m) return [];
      try {
        return [{ name, version: m[1], buildId: m[2], at: statSync(join(dir, name)).mtimeMs }];
      } catch {
        return [];
      }
    })
    .sort((a, b) => b.at - a.at);
  for (const f of found) {
    const sha256 = shaOf(join(dir, `${f.name}.sha256`), f.name);
    if (sha256) return { file: join(dir, f.name), name: f.name, version: f.version, buildId: f.buildId, sha256 };
  }
  return null;
}

/** x.y.z against x.y.z: below 0 when `a` is older. */
export function compareVersions(a: string, b: string): number {
  const pa = a.split(".").map((n) => Number(n) || 0);
  const pb = b.split(".").map((n) => Number(n) || 0);
  for (let i = 0; i < Math.max(pa.length, pb.length); i++) if ((pa[i] ?? 0) !== (pb[i] ?? 0)) return (pa[i] ?? 0) - (pb[i] ?? 0);
  return 0;
}

/**
 * What to do about a computer's runner `x` with this app's bundle: set it up (none there, being stopped,
 * an older one, one that didn't start, or the same version built again when this Mac set it up last),
 * keep it (the same, or a newer one: never downgraded), or wait (another Mac is setting it up now).
 */
export function installPlan(x: RunnerState | undefined, mine: Pick<Bundle, "version" | "buildId">, me: string, now = Date.now()): "install" | "keep" | "wait" {
  if (!x || x.status === "stopping") return "install";
  const cmp = compareVersions(mine.version, x.version);
  if (cmp < 0) return "keep";
  if (x.status === "installing" && x.by !== me && now - x.at < INSTALLING_STALE_MS) return "wait";
  if (cmp > 0) return "install";
  if (mine.buildId === x.buildId) return x.status === "running" ? "keep" : "install";
  return x.by === me ? "install" : "keep";
}

/* ---------------- On the computer ---------------- */

const q = (s: string) => `'${s.replace(/'/g, `'\\''`)}'`;
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const ZONE = /^[A-Za-z0-9_+/-]{1,64}$/;
const ORIGIN = /^https?:\/\/[A-Za-z0-9.-]+(?::\d+)?(?:\/[A-Za-z0-9._~/-]*)?$/;
const LOOPBACK_URL = /^https?:\/\/(?:localhost|127\.|\[::1\]|0\.0\.0\.0)/i;

/** Where it stands on the computer: the build `current` points at, whether its key and this build are there, and supervisord. */
const probeScript = (dirName: string) =>
  [
    `c=$(readlink ${ROOT}/current 2>/dev/null | sed 's#.*/##')`,
    `echo "current=$c"`,
    `[ -s ${RUNNER_KEY_FILE} ] && echo key=yes || echo key=no`,
    `[ -f ${ROOT}/${dirName}/server.js ] && echo have=yes || echo have=no`,
    `command -v supervisorctl >/dev/null 2>&1 && echo sup=yes || echo sup=no`,
  ].join("; ");

/** The script supervisord starts: the runner's settings (none of them secret), a window token made fresh, then the server. */
export function wrapperScript(o: { computerId: string; timeZone?: string; orgo: string; cloud: string }): string {
  return [
    "#!/bin/sh",
    "# The Bops runner on this computer, set up by the Bops app on the user's Mac (lib/server/runner-install.ts).",
    "# Its window token is made fresh each start and kept nowhere: nothing on this computer needs it.",
    "BOPS_UI_TOKEN=$(od -An -N32 -tx1 /dev/urandom | tr -d ' \\n')",
    "export BOPS_UI_TOKEN",
    `export HOME=/root HOSTNAME=127.0.0.1 PORT=${PORT} NODE_ENV=production NEXT_MANUAL_SIG_HANDLE=true`,
    `export BOPS_RUNNER=1 BOPS_RUNNER_COMPUTER=${q(o.computerId)} BOPS_DEVICE_SEED=${q(o.computerId)} BOPS_ORGO_KEY_FILE=${RUNNER_KEY_FILE}`,
    `export BOPS_ORGO_ORIGIN=${q(o.orgo)} BOPS_CLOUD_URL=${q(o.cloud)}`,
    ...(o.timeZone ? [`export TZ=${q(o.timeZone)}`] : []),
    `cd ${ROOT}/current || exit 1`,
    "exec /usr/bin/node server.js",
    "",
  ].join("\n");
}

/** Its supervisord program: started with the computer, again whenever it stops, its log in /var/log/bops. */
export const SUPERVISOR_CONF = [
  "[program:bops-runner]",
  `command=${RUNNER_WRAPPER}`,
  `directory=${ROOT}`,
  "user=root",
  "autostart=true",
  "autorestart=true",
  "startsecs=10",
  "startretries=5",
  "stopsignal=TERM",
  "stopwaitsecs=15",
  "redirect_stderr=true",
  "stdout_logfile=/var/log/bops/runner.log",
  "stdout_logfile_maxbytes=5MB",
  "stdout_logfile_backups=2",
  "",
].join("\n");

/**
 * One command, under the runners' lock: the bundle checked against its sha256, unpacked beside the other
 * builds, `current` switched to it in one rename, older builds gone, the program and its script written,
 * and it (re)started. Says __BOPS_INSTALLED__ when it got that far.
 */
export function installScript(b: Pick<Bundle, "name" | "sha256" | "version" | "buildId">, wrapper: string): string {
  const dirName = `${b.version}-${b.buildId}`;
  return [
    "set -e",
    `d=${ROOT}`,
    `mkdir -p "$d/incoming" /var/log/bops /etc/supervisor/conf.d`,
    `exec 9>"$d/.lock"`,
    "flock -w 120 9",
    `cd "$d/incoming"`,
    `printf '%s  %s\\n' ${q(b.sha256)} ${q(b.name)} | sha256sum -c --status`,
    `rm -rf "$d/${dirName}.part"`,
    `mkdir "$d/${dirName}.part"`,
    `tar -xzf ${q(b.name)} -C "$d/${dirName}.part" --no-same-owner`,
    `test -f "$d/${dirName}.part/server.js"`,
    `rm -rf "$d/${dirName}"`,
    `mv "$d/${dirName}.part" "$d/${dirName}"`,
    `ln -sfn ${q(dirName)} "$d/current.next"`,
    `mv -Tf "$d/current.next" "$d/current"`,
    `rm -f ${q(b.name)}`,
    `for v in "$d"/*/; do v="\${v%/}"; case "\${v##*/}" in incoming|current|${dirName}) ;; *) rm -rf "$v" ;; esac; done`,
    `cat > ${RUNNER_WRAPPER} <<'BOPS_EOF'\n${wrapper}BOPS_EOF`,
    `chmod 700 ${RUNNER_WRAPPER}`,
    `cat > ${RUNNER_CONF} <<'BOPS_EOF'\n${SUPERVISOR_CONF}BOPS_EOF`,
    // Its log starts over, so the health check reads this start's.
    ": > /var/log/bops/runner.log",
    "supervisorctl reread >/dev/null 2>&1 || true",
    "supervisorctl update >/dev/null 2>&1 || true",
    "supervisorctl restart bops-runner >/dev/null 2>&1 || true",
    "echo __BOPS_INSTALLED__",
  ].join("\n");
}

/**
 * The health check: the runner answers on 127.0.0.1:PORT within a minute or so, listens there only
 * (never on an address another computer could reach), and has the user's state (its log says it's
 * running the routines: runner-start.ts). Nothing of the log is sent back, only whether it says so.
 */
export const HEALTH_SCRIPT = [
  "command -v ss >/dev/null 2>&1 || { echo __BOPS_NO_SS__; exit 0; }",
  'up=""',
  "for i in $(seq 1 45); do",
  `  if curl -fsS --max-time 3 -o /dev/null http://127.0.0.1:${PORT}/api/health; then`,
  "    up=1",
  `    l=$(ss -ltnH 'sport = :${PORT}' | awk '{print $4}')`,
  '    if [ -z "$l" ]; then echo __BOPS_NO_SS__; exit 0; fi',
  "    if printf '%s\\n' \"$l\" | grep -qv '^127\\.0\\.0\\.1:'; then echo __BOPS_EXPOSED__; exit 0; fi",
  "    if grep -q '^\\[runner\\] running the routines' /var/log/bops/runner.log 2>/dev/null; then echo __BOPS_HEALTHY__; exit 0; fi",
  "  fi",
  "  sleep 2",
  "done",
  'if [ -n "$up" ]; then echo __BOPS_NO_STATE__; else echo __BOPS_DOWN__; fi',
].join("\n");

/** Taking it off a computer: its program stopped and gone, its script, its key file and its builds, under the lock. */
export const UNINSTALL_SCRIPT = [
  "supervisorctl stop bops-runner >/dev/null 2>&1",
  `rm -f ${RUNNER_CONF} ${RUNNER_WRAPPER} ${RUNNER_KEY_FILE}`,
  "supervisorctl update >/dev/null 2>&1",
  `mkdir -p ${ROOT}`,
  `exec 9>${ROOT}/.lock`,
  "flock -w 120 9",
  `find ${ROOT} -mindepth 1 -maxdepth 1 ! -name .lock -exec rm -rf {} +`,
  "echo __BOPS_OFF__",
].join("\n");

/* ---------------- The state ---------------- */

type Box = {
  timer?: ReturnType<typeof setInterval>;
  looking?: Promise<void>;
  again?: boolean;
  soon?: ReturnType<typeof setTimeout>;
  lookedAt: number;
  seen?: string;
  /** Set-ups that didn't work: when each is tried again, and how long the next wait is. */
  retry: Map<string, { at: number; wait: number }>;
  /** Computers this server is setting up right now. */
  busy: Set<string>;
};
const g = globalThis as unknown as { __bopsRunnerInstall?: Box };
const box: Box = (g.__bopsRunnerInstall ??= { lookedAt: 0, retry: new Map(), busy: new Set() });

const userNow = () => getState().account?.user.id;
const runnerOf = (id: string) => getState().runners?.[id];
function mark(id: string, x: RunnerState) {
  update((s) => void ((s.runners ??= {})[id] = x));
}
function forget(id: string) {
  update((s) => {
    if (!s.runners?.[id]) return;
    delete s.runners[id];
    if (!Object.keys(s.runners).length) s.runners = undefined;
  });
}

/** Couldn't start, and why; tried again later (a wait that grows), but at once when it was the bundle or Full access. */
function failed(id: string, error: string, b: Pick<Bundle, "version" | "buildId"> | null, me: string, backoff = true) {
  const x = runnerOf(id);
  mark(id, { status: "failed", version: b?.version ?? x?.version ?? "", buildId: b?.buildId ?? x?.buildId ?? "", by: me, error, at: Date.now(), ...keyOf(x) });
  if (!backoff) return;
  const wait = Math.min(RETRY_MAX_MS, (box.retry.get(id)?.wait ?? RETRY_MIN_MS / 2) * 2);
  box.retry.set(id, { at: Date.now() + wait, wait });
}
const keyOf = (x: RunnerState | undefined) => (x?.keyId ? { keyId: x.keyId, ...(x.keyBy ? { keyBy: x.keyBy } : {}) } : {});

/* ---------------- Which computers ---------------- */

type Wanted = { projects: Set<string>; botName: string };

/**
 * The computers that should have a runner, each with the Orgo workspaces whose map lists it and the bot
 * that owns it: one some bot works on as Orgo's map says (only the user's live Bops computers) and as
 * this Mac says too. Null when Orgo didn't answer for every workspace: then nothing is set up or stopped.
 */
async function wantedComputers(key: string): Promise<Map<string, Wanted> | null> {
  const s = getState();
  const local = new Map<string, string>();
  for (const b of s.bots) {
    const w = workBot(b, s.bots);
    if (w.computerId && w.computerStatus !== "cloning") local.set(w.computerId.toLowerCase(), w.name);
  }
  const out = new Map<string, Wanted>();
  for (const ws of s.workspaces ?? []) {
    if (!ws.orgoProjectId) continue;
    const got = await callOrgo<{ bots?: { desktopId?: unknown }[] }>(key, `/api/projects/${encodeURIComponent(ws.orgoProjectId)}/bops`, { timeoutMs: 15_000 });
    if (got?.status === 404 || got?.status === 405) continue;
    if (got?.status !== 200) return null;
    for (const b of Array.isArray(got.json.bots) ? got.json.bots : []) {
      const id = typeof b?.desktopId === "string" && UUID.test(b.desktopId) ? b.desktopId.toLowerCase() : null;
      const name = id && local.get(id);
      if (!id || !name) continue;
      const w = out.get(id) ?? { projects: new Set<string>(), botName: name };
      w.projects.add(ws.orgoProjectId);
      out.set(id, w);
    }
  }
  return out;
}

/* ---------------- The look ---------------- */

/** Every computer: each that should have a runner set up (or kept), each that shouldn't stopped. One look at a time. */
export function lookAtRunners(): Promise<void> {
  if (box.looking) {
    box.again = true;
    return box.looking;
  }
  box.looking = look()
    .catch((e: Error) => console.warn(`[runner-install] ${e.message}`))
    .finally(() => {
      box.looking = undefined;
      box.lookedAt = Date.now();
      if (box.again) {
        box.again = false;
        void lookAtRunners();
      }
    });
  return box.looking;
}

async function look() {
  if (!loopHere("runner-install") || !stateInCloud() || !stateReady() || stateTooNew()) return;
  const me = stateDevice();
  const mode = heardRunsOn();
  // Until Orgo says where the bots work, nothing is set up or stopped.
  if (!me || !userNow() || !mode) return;
  const key = await apiKey().catch(() => "");
  if (!key) return;
  const host = getState().host === "mac";
  const cloud = mode === "cloud" && !runsOnMissing() && !host;
  const wanted = cloud ? await wantedComputers(key) : new Map<string, Wanted>();
  if (!wanted) return;
  for (const id of Object.keys(getState().runners ?? {}))
    if (!wanted.has(id.toLowerCase())) await stop(id, key, !cloud ? (host ? STOPPED.host : STOPPED.mac) : STOPPED.moved);
  for (const [id, w] of wanted) await keepUp(id, w, key, me);
}

/** One computer that should have a runner: set up, kept as it is, or (someone else has Full access there) stopped. */
async function keepUp(id: string, w: Wanted, key: string, me: string) {
  if (box.busy.has(id)) return;
  for (const p of w.projects) {
    const full = await othersWithFullAccess(key, p);
    if (full === null) return;
    if (!full) continue;
    // Stopped (and its key revoked, when it's this Mac's to revoke), then said why. Once: a computer isn't asked again for nothing.
    const x = runnerOf(id);
    if (x && (x.status !== "failed" || (x.keyId && (x.keyBy ?? x.by) === me))) await stop(id, key, STOPPED.full);
    if (runnerOf(id)?.error !== FULL_ACCESS) failed(id, FULL_ACCESS, null, me, false);
    return;
  }
  const x = runnerOf(id);
  const bundle = findBundle();
  if (!bundle) {
    if ((!x || x.status === "stopping" || x.by === me) && x?.error !== NO_BUNDLE) failed(id, NO_BUNDLE, null, me, false);
    return;
  }
  const plan = installPlan(x, bundle, me);
  if (plan !== "install") return;
  // One that didn't start waits its turn (not when it was Full access or the bundle, which are looked at each time).
  const retry = box.retry.get(id);
  if (x?.status === "failed" && x.error !== FULL_ACCESS && x.error !== NO_BUNDLE && retry && retry.at > Date.now()) return;
  box.busy.add(id);
  try {
    await install(id, w, bundle, key, me);
  } finally {
    box.busy.delete(id);
  }
}

/** Set a runner up on computer `id` (this wakes it, if it's asleep: once, for this). */
async function install(id: string, w: Wanted, bundle: Bundle, key: string, me: string) {
  const s = getState();
  const orgoAt = orgoOrigin();
  const cloudAt = cloudUrl();
  const fail = (error: string) => failed(id, error, bundle, me);
  // A runner reaches what this Mac does: an Orgo or a Bops Cloud on this Mac it never could.
  if (!ORIGIN.test(orgoAt) || !ORIGIN.test(cloudAt) || LOOPBACK_URL.test(orgoAt) || LOOPBACK_URL.test(cloudAt)) return fail("Orgo or Bops Cloud runs on this Mac, which the computer can't reach");
  mark(id, { status: "installing", version: bundle.version, buildId: bundle.buildId, by: me, at: Date.now(), ...keyOf(runnerOf(id)) });
  const dirName = `${bundle.version}-${bundle.buildId}`;
  const probe = await orgo.bash(id, probeScript(dirName), 60).catch(() => null);
  if (!probe) return fail("its computer didn't answer");
  const said = (k: string) => new RegExp(`^${k}=(.*)$`, "m").exec(probe.output)?.[1]?.trim() ?? "";
  if (said("sup") !== "yes") return fail("its computer can't keep a runner going (no supervisord)");
  // A newer one is there already (another Mac's): never replaced by this older one.
  const there = /^(\d+\.\d+\.\d+)-([A-Za-z0-9_-]+)$/.exec(said("current"));
  if (there && compareVersions(there[1], bundle.version) > 0) {
    const up = await health(id);
    const x = runnerOf(id);
    if (up === "ok") mark(id, { status: "running", version: there[1], buildId: there[2], by: x?.by ?? me, at: Date.now(), ...keyOf(x) });
    else fail(UNHEALTHY[up]);
    return;
  }
  // Its key: the one made for it before while its file is there (another Mac's too), else a new one.
  let x = runnerOf(id);
  if (!x?.keyId || said("key") !== "yes") {
    const old = x?.keyId && (x.keyBy ?? x.by) === me ? x.keyId : undefined;
    const got = await callOrgo<{ keyId?: unknown; code?: unknown }>(key, `/api/computers/${encodeURIComponent(id)}/bops-runner-key`, {
      method: "PUT",
      body: { name: w.botName },
      timeoutMs: 120_000,
    });
    if (got?.status === 409 && got.json.code === "full_access_member") return failed(id, FULL_ACCESS, bundle, me, false);
    if (got?.status === 404 || got?.status === 405) return fail("Orgo can't set up a runner on it yet");
    if (got?.status === 422) return fail("a runner needs a Linux computer");
    const keyId = got?.status === 200 && typeof got.json.keyId === "string" ? got.json.keyId : null;
    if (!keyId) return fail("Orgo didn't make its key");
    x = { ...(x ?? { status: "installing", version: bundle.version, buildId: bundle.buildId, by: me, at: Date.now() }), keyId, keyBy: me };
    mark(id, x);
    if (old && old !== keyId) await revoke(id, old, key);
  }
  if (said("have") !== "yes") {
    const sent = await upload(id, bundle, key);
    if (sent) return fail(sent);
  }
  const wrapper = wrapperScript({ computerId: id, timeZone: ZONE.test(s.owner?.timeZone ?? "") ? s.owner?.timeZone : undefined, orgo: orgoAt, cloud: cloudAt });
  const put = await orgo.bash(id, installScript(bundle, wrapper), 240).catch(() => null);
  if (!put?.output.includes("__BOPS_INSTALLED__")) return fail("its files couldn't be put in place");
  const up = await health(id);
  if (up !== "ok") {
    // Never left half up: a runner that answered beyond its computer, or not at all, is stopped (its routines stay on the Mac).
    await orgo.bash(id, "supervisorctl stop bops-runner >/dev/null 2>&1; true", 30).catch(() => null);
    return fail(UNHEALTHY[up]);
  }
  box.retry.delete(id);
  mark(id, { status: "running", version: bundle.version, buildId: bundle.buildId, by: me, at: Date.now(), ...keyOf(runnerOf(id)) });
  // The runner goes by the state: it starts on that computer's routines once it reads this.
  void flushState().catch(() => {});
}

const UNHEALTHY = {
  down: "it didn't answer on its computer",
  nostate: "it couldn't sign in on its computer",
  exposed: "it listened beyond its own computer",
  unknown: "its computer can't say what it listens on",
  lost: "its computer didn't answer",
} as const;

async function health(id: string): Promise<"ok" | keyof typeof UNHEALTHY> {
  const out = await orgo.bash(id, HEALTH_SCRIPT, 240).catch(() => null);
  if (!out) return "lost";
  if (out.output.includes("__BOPS_HEALTHY__")) return "ok";
  if (out.output.includes("__BOPS_EXPOSED__")) return "exposed";
  if (out.output.includes("__BOPS_NO_STATE__")) return "nostate";
  if (out.output.includes("__BOPS_NO_SS__")) return "unknown";
  return "down";
}

/**
 * The bundle onto the computer (Orgo's file uploads: a link to put it at, then Orgo has the computer
 * fetch it into /opt/bops/runner/incoming), first checked against its sha256 here. Says what went
 * wrong, or nothing when it's there. Nothing of the link or its token ever goes in a message.
 */
async function upload(id: string, bundle: Bundle, key: string): Promise<string | undefined> {
  let bytes: Buffer;
  try {
    bytes = await readFile(bundle.file);
  } catch {
    return NO_BUNDLE;
  }
  if (createHash("sha256").update(bytes).digest("hex") !== bundle.sha256) return "the server bundle is damaged";
  const start = await callOrgo<{ upload_url?: unknown; upload_token?: unknown }>(key, "/api/files/uploads", {
    method: "POST",
    body: { desktopId: id, filename: bundle.name, size_bytes: bytes.length, destPath: `${ROOT}/incoming` },
    timeoutMs: 30_000,
  });
  const url = typeof start?.json.upload_url === "string" ? start.json.upload_url : "";
  const token = typeof start?.json.upload_token === "string" ? start.json.upload_token : "";
  if (start?.status !== 200 || !url.startsWith("https://") || !token) return "Orgo didn't take its files";
  try {
    // Straight to storage, with nothing of Orgo's (no key): the link carries its own signature.
    const res = await fetch(url, { method: "PUT", body: new Uint8Array(bytes), cache: "no-store", signal: AbortSignal.timeout(10 * 60_000) });
    if (!res.ok) return "its files didn't upload";
  } catch {
    return "its files didn't upload";
  }
  const done = await callOrgo(key, "/api/files/uploads/complete", { method: "POST", body: { desktopId: id, upload_token: token }, timeoutMs: 320_000 });
  return done?.status === 200 ? undefined : "its files didn't reach its computer";
}

/** Revoke a runner's key (Orgo also takes the file off a computer that's up). Gone already counts. */
async function revoke(id: string, keyId: string, key: string): Promise<boolean> {
  const got = await callOrgo(key, `/api/computers/${encodeURIComponent(id)}/bops-runner-key?keyId=${encodeURIComponent(keyId)}`, { method: "DELETE", timeoutMs: 60_000 });
  return got?.status === 200 || got?.status === 404;
}

/**
 * Stop computer `id`'s runner, saying `why` in its threads (they end). It's taken off a computer that's
 * up or gone; one asleep keeps it until it's up again (it can't run without its key). Its key is revoked
 * by the Mac that had it made; it goes from the state once both are done.
 */
async function stop(id: string, key: string, why: string) {
  const user = userNow();
  const me = stateDevice();
  let x = runnerOf(id);
  if (!x || !user || !me) return;
  if (x.status !== "stopping") {
    x = { ...x, status: "stopping", at: Date.now() };
    mark(id, x);
    endSessionsOf(deviceIdFor(user, id), why);
  }
  let off = false;
  const c = await orgo.computer(id).catch((e: unknown) => (computerGone(e) ? ("gone" as const) : null));
  if (c === "gone") off = true;
  else if (c?.status === "running") off = !!(await orgo.bash(id, UNINSTALL_SCRIPT, 180).catch(() => null))?.output.includes("__BOPS_OFF__");
  if (x.keyId && (x.keyBy ?? x.by) === me && (await revoke(id, x.keyId, key))) {
    x = { ...x, keyId: undefined, keyBy: undefined };
    mark(id, Object.fromEntries(Object.entries(x).filter(([, v]) => v !== undefined)) as RunnerState);
  }
  if (off && !x.keyId) forget(id);
}

/* ---------------- When ---------------- */

/** What a look depends on, besides the time: where the bots work, which computers they're on, each runner's state. */
function signature() {
  const s = getState();
  const on = [...new Set(s.bots.map((b) => workBot(b, s.bots).computerId).filter(Boolean))].sort().join(",");
  const runners = Object.entries(s.runners ?? {})
    .map(([id, x]) => `${id}:${x.status}:${x.version}:${x.buildId}`)
    .sort()
    .join(",");
  return `${heardRunsOn() ?? ""}|${runsOnMissing()}|${s.host ?? ""}|${on}|${runners}`;
}

/** A look in a moment (the switch in Settings), unless one is coming sooner. */
export function runnersSoon(ms = 2000) {
  if (!loopHere("runner-install") || box.soon) return;
  box.soon = setTimeout(() => {
    box.soon = undefined;
    void lookAtRunners();
  }, ms);
  box.soon.unref?.();
}

/** Started by the state route on the Mac: a look now, then each minute when something it depends on changed, and every 10 minutes anyway. Never on a runner. */
export function startRunnerInstalls() {
  if (box.timer || !loopHere("runner-install") || !stateInCloud()) return;
  box.timer = setInterval(() => {
    if (!stateReady()) return;
    const sig = signature();
    if (sig === box.seen && Date.now() - box.lookedAt < LOOK_EVERY_MS) return;
    box.seen = sig;
    void lookAtRunners();
  }, CHECK_MS);
  box.timer.unref?.();
}

/** Tests: forget what was looked at and tried. */
export const runnerInstallForTests = {
  reset: () => {
    if (box.timer) clearInterval(box.timer);
    if (box.soon) clearTimeout(box.soon);
    box.timer = box.soon = box.looking = box.seen = undefined;
    box.again = false;
    box.lookedAt = 0;
    box.retry.clear();
    box.busy.clear();
  },
  retryAt: (id: string) => box.retry.get(id)?.at,
};
