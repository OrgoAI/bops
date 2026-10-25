import "server-only";
import { createHash } from "node:crypto";
import { readdirSync, readFileSync, statSync } from "node:fs";
import { readFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { computerAsleep, computerStaysDown, live, pausedForOk, RUNNER_NO_KEY, RUNNER_NO_SIGN_IN, runnerKeyMade, workBot, type RunnerState } from "@/lib/types";
import { cloudUrl } from "./cloud-url";
import { forgetGoneMembers, othersCanUse } from "./members";
import { apiKey, callOrgo, orgo } from "./orgo";
import { orgoOrigin } from "./orgo-auth";
import { loopHere } from "./persist";
import { deviceIdFor } from "./persist-cloud";
import { mendRoutineCopies, routineChanged } from "./routine-sync";
import { heardRunsOn, noteDown, overdueOn, RUNNER_CONF, RUNNER_WRAPPER, runnerRunsOn, runsOnMissing } from "./runner";
import { ORGO_KEY_FILES, ORGO_KEY_LINE, RUNNER_AUTH_FILE } from "./runner-key";
import { computerGone, endSessionOf, endSessionsOf } from "./sessions";
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
 * and the script that starts it, which makes a fresh window token each time. Its key is the computer's
 * own ORGO_API_KEY, which Orgo writes on the computer itself and the runner reads there (runner-key.ts):
 * one made with the computer (a template that asks for it: bops-base 0.1.9 on) is left as it is, and a
 * computer without one gets it from Orgo now (PUT /api/computers/{id}/orgo-key), which Bops takes back
 * when it stops the runner (RunnerState.keyMade). This Mac never has it, and no command sent carries a
 * key or a token. Never on a computer whose workspace someone else can use (root there, or able to
 * become it; the key is the whole account's): the Mac looks first (members.ts othersCanUse), and Orgo,
 * which sees share links too, has the last word. A newer Bops is never replaced by an older one; the
 * same version built again replaces it only when this Mac set it up last (a dev Mac). One that's up and
 * set up again (a new release) stays up, with its routines, until the new one starts in its place
 * (RunnerState.upgrading); a try that doesn't get that far leaves it as it was.
 *
 * Its computer's Orgo identity (vm-identity.ts) comes first on the runner, and its key is the fallback
 * wherever identity doesn't reach. This release (the identity spec's phase 1) gives every computer its
 * key as before, whatever identity says; the health check says what the runner signs in with
 * (RunnerState.auth). Phase 2 (IDENTITY_ONLY, off until every host runs identity) gives no key to a
 * computer on identity and takes back the one Bops gave once the new build runs on identity. Either
 * way a runner is never left with nothing: one with no key and no identity it can use waits
 * (runner-start.ts), its routines fall overdue, and the Mac's look gives its computer a key again
 * (stillRuns, the way back).
 *
 * Stopping one (the bots work on This Mac now, or in browsers on the Mac; its computer was deleted; no
 * bot works on it): its program is stopped and taken off, the key Bops gave its computer revoked (by
 * any Mac of the user's: DELETE /api/computers/{id}/orgo-key, which takes it off a computer that's up
 * too), its threads end, and it's taken out of the state. A key the computer came with stays: it's the
 * computer's, and Orgo revokes it with the computer. A computer asleep isn't woken for that, and it's
 * taken off the next time the computer is up.
 *
 * Looked at once a minute; a full look (and a change: where the bots work, which computers they're on)
 * goes through each computer. Nothing here asks a computer that's asleep anything, and a runner is set
 * up (or set up again) only on a computer that's up: that's never a reason to wake one. One that's up whose runner is marked up but left a routine well past
 * its time is asked whether its runner is still there (stillRuns); one asleep, or down and not coming
 * back by itself (stopped, frozen, in error), gives those routines back to the Mac. Orgo's copy of the
 * routines follows each runner going up or down (routine-sync.ts onMac), so it wakes a computer only for
 * a runner that's up.
 */

const ROOT = "/opt/bops/runner";
const PORT = 3210;
const NO_BUNDLE = "no server bundle";
/** orgo-web's 409 full_access_member says "Someone else can use this workspace." */
const FULL_ACCESS = "someone else can use this workspace";
const OWNER_ONLY = "only the workspace's owner can set a runner up there";
/** Why a runner marked up isn't any more: its program is gone or stopped on its computer (stillRuns). */
const GONE_THERE = "it stopped on its computer";
/** Why its threads ended, in each case. */
const STOPPED = {
  mac: "Stopped: routines run on your Mac now.",
  host: "Stopped: your bots work in browsers on your Mac now.",
  gone: "Stopped: its computer was deleted.",
  moved: "Stopped: no bot works on this computer anymore.",
  full: `Stopped: ${FULL_ACCESS}.`,
  /** Its computer is asleep, and the routine it was a run of doesn't run there anymore (set to run on the Mac, its result sent to a channel, its bot moved). */
  elsewhere: "Stopped: its computer was asleep, and its routine doesn't run there anymore.",
  /** Its runner stopped being up (it stopped on its computer, or can't sign in): what it was running is over. */
  runnerDown: (why: string) => `Stopped: its computer's runner is down (${why}).`,
  /** Its computer is down and doesn't come back by itself (lib/types.ts computerStaysDown): its runner is gone with it. */
  down: (status: string) => `Stopped: its computer ${status === "error" ? "broke" : status === "deleted" ? "was deleted" : `was ${status}`}.`,
};

/** A look at what changed every minute; every computer at least every 10 minutes. */
const CHECK_MS = 60_000;
const LOOK_EVERY_MS = 10 * 60_000;
/** A set-up that didn't work is tried again after this, twice as long each time it doesn't. */
const RETRY_MIN_MS = 30 * 60_000;
const RETRY_MAX_MS = 12 * 60 * 60_000;
/** Another Mac setting one up this long is taken to have stopped (quit mid-way). */
const INSTALLING_STALE_MS = 20 * 60_000;
/** How often at most a computer is asked whether its runner is still there (stillRuns): a command keeps it awake a while. */
const STILL_RUNS_EVERY_MS = 60 * 60_000;
/** The same for a runner on its computer's identity: one that lost it may be waiting with no credential at all. */
const STILL_RUNS_IDENTITY_MS = 15 * 60_000;
/**
 * Phase 2 of the identity spec (its rollout step 12): no key for a computer whose identity answers, and
 * the key Bops gave taken back once the new runner proves it runs on identity. Off until every host has
 * run identity through a full roll; until then every computer gets its key as before, whatever identity
 * says (runnerInstallForTests.identityOnly turns it on in the tests).
 */
const IDENTITY_ONLY = false;

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
  if (x.status === "running" && x.upgrading && x.upgrading.by !== me && now - x.upgrading.at < INSTALLING_STALE_MS) return "wait";
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

const KEY_LINE = `grep -qsE ${q(ORGO_KEY_LINE)} ${ORGO_KEY_FILES.join(" ")} && echo key=yes || echo key=no`;
/**
 * The computer's Orgo identity asked as a program on it would (its VMM, from inside its own network):
 * the status code only (200, 403, 404, 503, 000 when nothing answered), never the token.
 */
export const IDENT_LINE = `echo "ident=$(curl --noproxy '*' -s -m 3 -o /dev/null -w '%{http_code}' -H 'Metadata-Flavor: Orgo' http://169.254.169.254/orgo/v1/identity/token)"`;
/**
 * What the runner last said it signs in with: the word in its auth file (RUNNER_AUTH_FILE, written at each
 * change), else its log's last `[runner] auth:` line (a runner from before the file; the log rotates at
 * 5 MB and the word is said only when it changes). The word only, as orgo-web logs a command's output.
 */
export const AUTH_LINE = `echo "auth=$( (grep -sxE '(identity|key|none)' ${RUNNER_AUTH_FILE} || grep -E '^\\[runner\\] auth: (identity|key|none)$' /var/log/bops/runner.log 2>/dev/null | sed 's/^.*: //') | tail -n 1)"`;
/** The word an `auth=` line says, if it says one. */
const authIn = (output: string): RunnerState["auth"] => (/^auth=(identity|key|none)$/m.exec(output)?.[1] as RunnerState["auth"]) ?? undefined;

/**
 * Where it stands on the computer: the build `current` points at, whether the computer has its Orgo key
 * (a line that sets ORGO_API_KEY in one of the files Orgo writes it in: grep alone, never printed), whether
 * this build is there, and supervisord; in phase 2 (`ident`) what its identity answers too (IDENT_LINE).
 */
export const probeScript = (dirName: string, { ident = false }: { ident?: boolean } = {}) =>
  [
    `c=$(readlink ${ROOT}/current 2>/dev/null | sed 's#.*/##')`,
    `echo "current=$c"`,
    KEY_LINE,
    ...(ident ? [IDENT_LINE] : []),
    `[ -f ${ROOT}/${dirName}/server.js ] && echo have=yes || echo have=no`,
    `command -v supervisorctl >/dev/null 2>&1 && echo sup=yes || echo sup=no`,
  ].join("; ");

/**
 * The script supervisord starts: the runner's settings (none of them secret), a window token made fresh,
 * then the server. Never its key: the runner reads that from its computer's files itself (runner-key.ts),
 * again when Orgo has written a new one. TZ is the user's zone when it's set up; it follows the user's
 * zone after that (routines.ts keepZone).
 */
export function wrapperScript(o: { computerId: string; timeZone?: string; orgo: string; cloud: string }): string {
  return [
    "#!/bin/sh",
    "# The Bops runner on this computer, set up by the Bops app on the user's Mac (lib/server/runner-install.ts).",
    "# Its window token is made fresh each start and kept nowhere: nothing on this computer needs it.",
    "BOPS_UI_TOKEN=$(od -An -N32 -tx1 /dev/urandom | tr -d ' \\n')",
    "export BOPS_UI_TOKEN",
    `export HOME=/root HOSTNAME=127.0.0.1 PORT=${PORT} NODE_ENV=production NEXT_MANUAL_SIG_HANDLE=true`,
    `export BOPS_RUNNER=1 BOPS_RUNNER_COMPUTER=${q(o.computerId)} BOPS_DEVICE_SEED=${q(o.computerId)}`,
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
 * One command, under the runners' lock: the bundle checked against its sha256 and unpacked beside the
 * other builds (when it was just uploaded: a build already unpacked there, as on a copy of a computer
 * with a runner or a try again after it was unpacked, is used as it is), `current` switched to it in one
 * rename, older builds gone, the program and its script written, and it (re)started. Says
 * __BOPS_INSTALLED__ when it got that far, __BOPS_NO_FILES__ when neither the upload nor the build is there.
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
    `if [ -f ${q(b.name)} ]; then`,
    `  printf '%s  %s\\n' ${q(b.sha256)} ${q(b.name)} | sha256sum -c --status`,
    `  rm -rf "$d/${dirName}.part"`,
    `  mkdir "$d/${dirName}.part"`,
    `  tar -xzf ${q(b.name)} -C "$d/${dirName}.part" --no-same-owner`,
    `  test -f "$d/${dirName}.part/server.js"`,
    `  rm -rf "$d/${dirName}"`,
    `  mv "$d/${dirName}.part" "$d/${dirName}"`,
    `  rm -f ${q(b.name)}`,
    `elif [ ! -f "$d/${dirName}/server.js" ]; then`,
    "  echo __BOPS_NO_FILES__",
    "  exit 3",
    "fi",
    `ln -sfn ${q(dirName)} "$d/current.next"`,
    `mv -Tf "$d/current.next" "$d/current"`,
    `for v in "$d"/*/; do v="\${v%/}"; case "\${v##*/}" in incoming|current|${dirName}) ;; *) rm -rf "$v" ;; esac; done`,
    `cat > ${RUNNER_WRAPPER} <<'BOPS_EOF'\n${wrapper}BOPS_EOF`,
    `chmod 700 ${RUNNER_WRAPPER}`,
    `cat > ${RUNNER_CONF} <<'BOPS_EOF'\n${SUPERVISOR_CONF}BOPS_EOF`,
    // Its log and its auth file start over, so the health check reads this start's.
    ": > /var/log/bops/runner.log",
    `rm -f ${RUNNER_AUTH_FILE}`,
    "supervisorctl reread >/dev/null 2>&1 || true",
    "supervisorctl update >/dev/null 2>&1 || true",
    "supervisorctl restart bops-runner >/dev/null 2>&1 || true",
    "echo __BOPS_INSTALLED__",
  ].join("\n");
}

/**
 * The health check: the runner answers on 127.0.0.1:PORT within a minute or so, listens there only
 * (never on an address another computer could reach), and has the user's state (its log says it's
 * running the routines: runner-start.ts). Nothing of the log is sent back, only whether it says so, and
 * what it signs in with (`auth=identity`, `key` or `none`: the word alone).
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
  `    if grep -q '^\\[runner\\] running the routines' /var/log/bops/runner.log 2>/dev/null; then ${AUTH_LINE}; echo __BOPS_HEALTHY__; exit 0; fi`,
  "  fi",
  "  sleep 2",
  "done",
  'if [ -n "$up" ]; then echo __BOPS_NO_STATE__; else echo __BOPS_DOWN__; fi',
].join("\n");

/**
 * Taking it off a computer: its program stopped and gone, its script and its builds, under the lock.
 * Never the computer's Orgo key: the one Bops gave it comes off with its revoke (stop), and one it came
 * with is the computer's.
 */
export const UNINSTALL_SCRIPT = [
  "supervisorctl stop bops-runner >/dev/null 2>&1",
  `rm -f ${RUNNER_CONF} ${RUNNER_WRAPPER}`,
  "supervisorctl update >/dev/null 2>&1",
  `mkdir -p ${ROOT}`,
  `exec 9>${ROOT}/.lock`,
  "flock -w 120 9",
  `find ${ROOT} -mindepth 1 -maxdepth 1 ! -name .lock -exec rm -rf {} +`,
  "echo __BOPS_OFF__",
].join("\n");

/**
 * Whether a runner marked up is still there (stillRuns): supervisord's word, then whether its computer
 * has its key, what its identity answers and what the runner says it signs in with (none of them
 * secret), then the end marker, so a read cut short says nothing.
 */
export const STILL_RUNS_SCRIPT = `supervisorctl status bops-runner 2>&1; ${KEY_LINE}; ${IDENT_LINE}; ${AUTH_LINE}; echo __BOPS_STATUS_END__`;

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
  /** When each computer was last asked whether its runner is still there (stillRuns), and the answers of the user's it had then. */
  asked?: Map<string, number>;
  answersAsked?: Map<string, Set<string>>;
  /** Tests: phase 2 on (IDENTITY_ONLY). */
  identityOnly?: boolean;
};
const g = globalThis as unknown as { __bopsRunnerInstall?: Box };
const box: Box = (g.__bopsRunnerInstall ??= { lookedAt: 0, retry: new Map(), busy: new Set() });

const userNow = () => getState().account?.user.id;
const runnerOf = (id: string) => getState().runners?.[id];
/** Computer `id`'s runner as it is now; one going up or down has Orgo's copy of its bots' routines follow (whether Orgo wakes it for them). */
function mark(id: string, x: RunnerState) {
  const was = runnerOf(id)?.status === "running";
  update((s) => void ((s.runners ??= {})[id] = x));
  if (was !== (x.status === "running")) routinesFollow(id);
}
function forget(id: string) {
  const was = runnerOf(id)?.status === "running";
  update((s) => {
    if (!s.runners?.[id]) return;
    delete s.runners[id];
    if (!Object.keys(s.runners).length) s.runners = undefined;
  });
  if (was) routinesFollow(id);
}
function routinesFollow(id: string) {
  const s = getState();
  for (const b of s.bots) if (workBot(b, s.bots).computerId?.toLowerCase() === id.toLowerCase()) routineChanged(b.id);
}

/** Couldn't start, and why; tried again later (a wait that grows), but at once when it was the bundle or someone else in the workspace. */
function failed(id: string, error: string, b: Pick<Bundle, "version" | "buildId"> | null, me: string, backoff = true) {
  const x = runnerOf(id);
  mark(id, { status: "failed", version: b?.version ?? x?.version ?? "", buildId: b?.buildId ?? x?.buildId ?? "", by: me, error, at: Date.now(), ...keyOf(x) });
  // One that was up and isn't: the threads it was running are over (its runner is gone with them), so none holds its routine for good.
  const user = userNow();
  if (x?.status === "running" && user) endSessionsOf(deviceIdFor(user, id), STOPPED.runnerDown(error));
  if (backoff) later(id);
}
/** Tried again after a wait that grows. */
function later(id: string) {
  const wait = Math.min(RETRY_MAX_MS, (box.retry.get(id)?.wait ?? RETRY_MIN_MS / 2) * 2);
  box.retry.set(id, { at: Date.now() + wait, wait });
}
/** A runner that's up, set up again without getting as far as its computer's files: left up as it was, and tried again later. */
function keptAsIs(id: string, error: string) {
  const x = runnerOf(id);
  if (x?.status === "running") mark(id, { ...x, upgrading: undefined });
  console.warn(`[runner-install] ${id}: kept as it was (${error})`);
  later(id);
}
/** The key Bops gave the computer, carried over to its next state (an entry from before keyMade, with a keyId, counts: runnerKeyMade). */
const keyOf = (x: RunnerState | undefined): Pick<RunnerState, "keyMade" | "keyId"> => (runnerKeyMade(x) ? { keyMade: true, ...(x?.keyId ? { keyId: x.keyId } : {}) } : {});
/** The same state with no key of Bops' (it was taken back; an entry from before keyMade loses its old keyBy with it). */
const keyless = (x: RunnerState) => Object.fromEntries(Object.entries(x).filter(([k]) => k !== "keyMade" && k !== "keyId" && k !== "keyBy")) as RunnerState;
/** What the runner signs in with, when its computer said. */
const authOf = (auth: RunnerState["auth"]): Pick<RunnerState, "auth"> => (auth ? { auth } : {});
const identityOnly = () => box.identityOnly ?? IDENTITY_ONLY;

/* ---------------- Which computers ---------------- */

type Wanted = { projects: Set<string> };

/**
 * The computers that should have a runner, each with the Orgo workspaces whose map lists it: one some
 * bot works on as Orgo's map says (only the user's live Bops computers) and as this Mac says too. Null
 * when Orgo didn't answer for every workspace: then nothing is set up or stopped.
 */
async function wantedComputers(key: string): Promise<Map<string, Wanted> | null> {
  const s = getState();
  const local = new Set<string>();
  for (const b of s.bots) {
    const w = workBot(b, s.bots);
    if (w.computerId && w.computerStatus !== "cloning") local.add(w.computerId.toLowerCase());
  }
  const out = new Map<string, Wanted>();
  for (const ws of s.workspaces ?? []) {
    if (!ws.orgoProjectId) continue;
    const got = await callOrgo<{ bots?: { desktopId?: unknown }[] }>(key, `/api/projects/${encodeURIComponent(ws.orgoProjectId)}/bops`, { timeoutMs: 15_000 });
    if (got?.status === 404 || got?.status === 405) continue;
    if (got?.status !== 200) return null;
    for (const b of Array.isArray(got.json.bots) ? got.json.bots : []) {
      const id = typeof b?.desktopId === "string" && UUID.test(b.desktopId) ? b.desktopId.toLowerCase() : null;
      if (!id || !local.has(id)) continue;
      const w = out.get(id) ?? { projects: new Set<string>() };
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
  // Orgo's copy of the routines, which its waker goes by, put right where a Mac still on v0.0.29 sent its old one (in the background).
  void mendRoutineCopies();
  // A computer whose run waits on an answer the user gave is woken for it until its runner reads it (in the background).
  void import("./permission")
    .then((m) => m.wakeForAnswers())
    .catch((e: Error) => console.warn(`[runner-install] waking for answers: ${e.message}`));
  // Bot access kept for people Orgo no longer lists goes, whether or not the People sheet is opened (in the background).
  void forgetGoneMembers(key).catch((e: Error) => console.warn(`[runner-install] members: ${e.message}`));
  const host = getState().host === "mac";
  const cloud = mode === "cloud" && !runsOnMissing() && !host;
  const wanted = cloud ? await wantedComputers(key) : new Map<string, Wanted>();
  // Orgo didn't answer for every workspace: nothing is set up or stopped, but each runner's computer is
  // still looked at (lookDown), so its routines say why they wait.
  if (!wanted) {
    for (const id of Object.keys(getState().runners ?? {})) if (!box.busy.has(id)) await lookDown(id);
    return;
  }
  for (const id of Object.keys(getState().runners ?? {}))
    if (!wanted.has(id.toLowerCase())) await stop(id, key, !cloud ? (host ? STOPPED.host : STOPPED.mac) : STOPPED.moved);
  for (const [id, w] of wanted) await keepUp(id, w, key, me);
}

/** The requests computer `id`'s runner made that the user answered and it hasn't read yet: its run goes on there once it reads one (permission.ts). */
function answersFor(id: string): string[] {
  const user = userNow();
  const device = user ? deviceIdFor(user, id) : undefined;
  return (getState().appApprovals ?? []).filter((a) => device && a.askedBy === device && a.reply && a.reply.reason !== "stopped").map((a) => a.id);
}

/** Whether computer `id`'s runner has a run going (a thread of its own still live). */
function busy(id: string): boolean {
  const user = userNow();
  const device = user ? deviceIdFor(user, id) : undefined;
  return !!device && getState().sessions.some((x) => live(x) && x.by === device);
}

/**
 * The runs computer `id`'s runner (`device`) left going of routines it no longer runs (set to run on the
 * Mac since, their result sent to a channel, their bot moved): another Bops runs each of those now, and
 * skips every run of it as "The last run was still going" while that one stays live. Never one paused for
 * the user's OK there (lib/types.ts pausedForOk): nothing of it is left going, and only their reply or Stop
 * touches it; the change is for the routine's runs to come.
 */
function strays(id: string, device: string): string[] {
  const s = getState();
  const left = new Set(s.routines.filter((r) => r.last?.sessionId && !runnerRunsOn(r, id)).map((r) => r.last!.sessionId!));
  return s.sessions.filter((x) => left.has(x.id) && live(x) && x.by === device && !pausedForOk(x, s)).map((x) => x.id);
}

/**
 * A look at a computer whose runner is marked up, when one of its routines is well past its time (a runner
 * that runs advances it before it starts), one of its threads runs, or it was found down before: how Orgo
 * says it is (one call, which never wakes it or counts as using it). Its routines stay its runner's whatever
 * it says, and wait for it: they're never the Mac's for it. Down and not coming back by itself (stopped,
 * frozen, in error), or asleep with one overdue (nothing woke it: Free hours used up, paused, unfunded), is
 * kept in the state (runner.ts noteDown, RunnerState.down), so every Bops shows why they wait ("Max's
 * computer is stopped"), and they run on it once it's up again (Orgo's waker, or the user starting it); up,
 * that's cleared. A thread its runner was running when the computer went down that way is over (its runner
 * is gone with it), failed and saying why: left running, it would hold its routine's next run for good ("The
 * last run was still going"). So is, with its computer asleep, the run its runner left going of a routine it
 * no longer runs (strays): the Bops that runs that routine now would skip each run for it until the computer
 * woke, and nothing may ever wake it. A run paused for the user's OK holds nothing there, so neither ends it
 * (sessions.ts endSessionsOf), unless the computer was deleted: their answer carries it on once it's up. "up":
 * it's up with one overdue, or with an answer of the user's its runner hasn't read (answersFor: a run waits on that
 * runner), so keepUp asks whether its runner still runs; "down": it isn't up, so nothing is set up there now (that
 * would wake it).
 */
async function lookDown(id: string): Promise<"down" | "up" | undefined> {
  const overdue = overdueOn(id);
  const user = userNow();
  const device = user ? deviceIdFor(user, id) : undefined;
  const threads = !!device && getState().sessions.some((x) => live(x) && x.by === device);
  const wasDown = !!runnerOf(id)?.down;
  if (runnerOf(id)?.status !== "running" || !(overdue || threads || wasDown)) return undefined;
  const status = (await orgo.computer(id).catch(() => null))?.status;
  if (status === undefined) return undefined;
  if (threads && computerStaysDown(status)) endSessionsOf(device!, STOPPED.down(status), { gone: status === "deleted" });
  if (threads && computerAsleep(status)) for (const sessionId of strays(id, device!)) endSessionOf(sessionId, device!, STOPPED.elsewhere);
  if (status === "running") {
    noteDown(id, undefined);
    return overdue || answersFor(id).length ? "up" : undefined;
  }
  const waits = computerStaysDown(status) || (computerAsleep(status) && (overdue || wasDown));
  if (waits) noteDown(id, status);
  return waits ? "down" : undefined;
}

/** One computer that should have a runner: set up, kept as it is, or (someone else can use its workspace) stopped. */
async function keepUp(id: string, w: Wanted, key: string, me: string) {
  if (box.busy.has(id)) return;
  for (const p of w.projects) {
    const others = await othersCanUse(key, p);
    // Not known now: nothing is set up or stopped, but its computer is still looked at (lookDown).
    if (others === null) return void (await lookDown(id));
    if (!others) continue;
    // Stopped (and the key Bops gave it revoked), then said why. Once: a computer isn't asked again for nothing.
    const x = runnerOf(id);
    if (x && (x.status !== "failed" || runnerKeyMade(x))) await stop(id, key, STOPPED.full);
    // One that failed with no key of Bops' to take back isn't stopped, but its runs are over all the same, one it kept
    // paused for the user's OK too (failed keeps those): its runner never comes back while someone else can use the workspace.
    else if (x) {
      const user = userNow();
      if (user) endSessionsOf(deviceIdFor(user, id), STOPPED.full, { gone: true });
    }
    if (runnerOf(id)?.error !== FULL_ACCESS) failed(id, FULL_ACCESS, null, me, false);
    // Seen here, so looked at again each time without asking the computer anything: set up as soon as they're gone.
    box.retry.delete(id);
    return;
  }
  const down = await lookDown(id);
  if (down === "down") return;
  const x = runnerOf(id);
  // Being stopped, but kept on for a run of its paused for the user's OK (stop: nothing was taken off it yet): wanted
  // again, it's up as it was, and that run goes on there once they answer.
  if (x?.status === "stopping" && busy(id)) return void mark(id, { ...x, status: "running", at: Date.now() });
  const bundle = findBundle();
  if (!bundle) {
    if ((!x || x.status === "stopping" || x.by === me) && x?.error !== NO_BUNDLE) failed(id, NO_BUNDLE, null, me, false);
    return;
  }
  const plan = installPlan(x, bundle, me);
  // Whether it still runs, when it's to be kept as it is, or kept for now for a run of its (one waiting on the user's answer too).
  if (down === "up" && x?.status === "running" && (plan === "keep" || busy(id))) return void (await stillRuns(id, me, key));
  if (plan !== "install") return;
  // A runner that's up isn't set up again in the middle of a run of its (nor while one waits for the user's OK:
  // setting it up would wake the computer for nothing). It's set up once its runs are over.
  if (x?.status === "running" && busy(id)) return;
  // One that didn't start, or one up that wasn't set up again, waits its turn (not when it was the bundle,
  // which is looked at each time). Someone else in the workspace that only Orgo saw (a share link) waits
  // too: each try wakes the computer before Orgo says so again.
  const retry = box.retry.get(id);
  if (retry && retry.at > Date.now() && (x?.status === "running" || (x?.status === "failed" && x.error !== NO_BUNDLE))) return;
  // Only on a computer that's up (Orgo's word for it, a read that never wakes it): every command wakes one that's
  // asleep, and setting a runner up is never a reason to wake a computer (only a run's next step, or the user using
  // it, is). Asleep, a runner that's up stays as it is, and one with none, or one that didn't start, waits until the
  // computer is up for something real (a due routine Orgo wakes it for, the user opening its screen).
  if ((await orgo.computer(id).catch(() => null))?.status !== "running") return;
  box.busy.add(id);
  try {
    await install(id, bundle, key, me);
  } finally {
    box.busy.delete(id);
  }
}

/**
 * Set a runner up on computer `id`, which is up (keepUp never sets one up on a computer asleep). One that's up stays
 * up, and keeps its routines, until the new one is started in its place: a try that goes wrong before
 * that (its computer didn't answer, the files didn't upload) leaves it as it was, to be tried again later.
 */
async function install(id: string, bundle: Bundle, key: string, me: string) {
  const s = getState();
  const orgoAt = orgoOrigin();
  const cloudAt = cloudUrl();
  const before = runnerOf(id);
  const upgrade = before?.status === "running";
  // Whether the runner that was up is changed yet (its computer given a key, its files swapped): past that, one that goes wrong couldn't start.
  let touched = false;
  const fail = (error: string) => (upgrade && !touched ? keptAsIs(id, error) : failed(id, error, bundle, me));
  // A runner reaches what this Mac does: an Orgo or a Bops Cloud on this Mac it never could.
  if (!ORIGIN.test(orgoAt) || !ORIGIN.test(cloudAt) || LOOPBACK_URL.test(orgoAt) || LOOPBACK_URL.test(cloudAt)) return fail("Orgo or Bops Cloud runs on this Mac, which the computer can't reach");
  if (upgrade) mark(id, { ...before, upgrading: { version: bundle.version, buildId: bundle.buildId, by: me, at: Date.now() } });
  else mark(id, { status: "installing", version: bundle.version, buildId: bundle.buildId, by: me, at: Date.now(), ...keyOf(before) });
  const dirName = `${bundle.version}-${bundle.buildId}`;
  const phase2 = identityOnly();
  const probe = await orgo.bash(id, probeScript(dirName, { ident: phase2 }), 60).catch(() => null);
  if (!probe) return fail("its computer didn't answer");
  const said = (k: string) => new RegExp(`^${k}=(.*)$`, "m").exec(probe.output)?.[1]?.trim() ?? "";
  if (said("sup") !== "yes") return fail("its computer can't keep a runner going (no supervisord)");
  // A newer one is there already (another Mac's): never replaced by this older one.
  const there = /^(\d+\.\d+\.\d+)-([A-Za-z0-9_-]+)$/.exec(said("current"));
  if (there && compareVersions(there[1], bundle.version) > 0) {
    const up = await health(id);
    const x = runnerOf(id);
    if (up.up === "ok") mark(id, { status: "running", version: there[1], buildId: there[2], by: x?.by ?? me, at: Date.now(), ...keyOf(x), ...authOf(up.auth) });
    else failed(id, UNHEALTHY[up.up], bundle, me);
    return;
  }
  // Its key: the computer's own ORGO_API_KEY. One it has (made with it from a template that asks for it,
  // or given it before) is left as it is: the runner reads it there. One without gets it from Orgo now,
  // written on the computer by Orgo itself (nothing of it comes here), and Bops takes that back when it
  // stops the runner (keyMade). Orgo keeps one key per computer and revokes any earlier one itself.
  // Phase 2: a computer whose identity answers gets none (the runner signs in with that), and one whose
  // identity is refused (someone else can use its workspace) gets none and no runner.
  const ident = phase2 ? said("ident") : "";
  const hadKey = said("key") === "yes";
  if (ident === "403") return fail(FULL_ACCESS);
  const onIdentity = ident === "200";
  if (!hadKey && !onIdentity) {
    const given = await giveKey(id, key);
    if ("error" in given) return given.backoff ? fail(given.error) : failed(id, given.error, bundle, me, false);
    touched = true;
    const x = runnerOf(id);
    mark(id, { ...(x ?? { status: "installing", version: bundle.version, buildId: bundle.buildId, by: me, at: Date.now() }), keyMade: true, keyId: given.keyId });
  }
  if (said("have") !== "yes") {
    const sent = await upload(id, bundle, key);
    if (sent) return fail(sent);
  }
  const wrapper = wrapperScript({ computerId: id, timeZone: ZONE.test(s.owner?.timeZone ?? "") ? s.owner?.timeZone : undefined, orgo: orgoAt, cloud: cloudAt });
  touched = true;
  const put = await orgo.bash(id, installScript(bundle, wrapper), 240).catch(() => null);
  if (!put?.output.includes("__BOPS_INSTALLED__")) return fail(put?.output.includes("__BOPS_NO_FILES__") ? "its files weren't on its computer" : "its files couldn't be put in place");
  const up = await health(id);
  // Phase 2, given no key for its identity: it must say it runs on it, or it's as unhealthy as any other.
  const bad = up.up !== "ok" ? up.up : onIdentity && !hadKey && up.auth !== "identity" ? "noidentity" : null;
  if (bad) {
    // Never left half up: a runner that answered beyond its computer, or not at all, is stopped (its routines stay on the Mac).
    await orgo.bash(id, "supervisorctl stop bops-runner >/dev/null 2>&1; true", 30).catch(() => null);
    return fail(UNHEALTHY[bad]);
  }
  box.retry.delete(id);
  // Phase 2: the key Bops gave (and only that one: a key the computer came with is Orgo's), taken back
  // only now that the new build runs on its identity. A try that went wrong before this left the runner
  // that was up, and its key, as they were.
  if (onIdentity && hadKey && up.auth === "identity" && runnerKeyMade(runnerOf(id)) && (await takeKeyBack(id, key))) mark(id, keyless(runnerOf(id)!));
  mark(id, { status: "running", version: bundle.version, buildId: bundle.buildId, by: me, at: Date.now(), ...keyOf(runnerOf(id)), ...authOf(up.auth) });
  // The runner goes by the state: it starts on that computer's routines once it reads this.
  void flushState().catch(() => {});
}

const UNHEALTHY = {
  down: "it didn't answer on its computer",
  nostate: RUNNER_NO_SIGN_IN,
  noidentity: RUNNER_NO_SIGN_IN,
  exposed: "it listened beyond its own computer",
  unknown: "its computer can't say what it listens on",
  lost: "its computer didn't answer",
} as const;

/** The health check's answer, and what the runner said it signs in with when it passed. */
async function health(id: string): Promise<{ up: "ok" | Exclude<keyof typeof UNHEALTHY, "noidentity">; auth?: RunnerState["auth"] }> {
  const out = await orgo.bash(id, HEALTH_SCRIPT, 240).catch(() => null);
  if (!out) return { up: "lost" };
  if (out.output.includes("__BOPS_HEALTHY__")) return { up: "ok", auth: authIn(out.output) };
  if (out.output.includes("__BOPS_EXPOSED__")) return { up: "exposed" };
  if (out.output.includes("__BOPS_NO_STATE__")) return { up: "nostate" };
  if (out.output.includes("__BOPS_NO_SS__")) return { up: "unknown" };
  return { up: "down" };
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

/**
 * Give computer `id` its own Orgo key (PUT /api/computers/{id}/orgo-key, no body): Orgo writes it there as
 * ORGO_API_KEY and answers only its id. Refused: why, and whether to wait longer before the next try
 * (every refusal does: someone else in the workspace that only Orgo sees would otherwise have the
 * computer woken by each look).
 */
async function giveKey(id: string, key: string): Promise<{ keyId: string } | { error: string; backoff: boolean }> {
  const got = await callOrgo<{ keyId?: unknown; code?: unknown }>(key, `/api/computers/${encodeURIComponent(id)}/orgo-key`, { method: "PUT", timeoutMs: 120_000 });
  if (got?.status === 200 && typeof got.json.keyId === "string" && got.json.keyId) return { keyId: got.json.keyId };
  if (got?.status === 409 && got.json.code === "full_access_member") return { error: FULL_ACCESS, backoff: true };
  if (got?.status === 403 && got.json.code === "owner_only") return { error: OWNER_ONLY, backoff: true };
  if (got?.status === 404 || got?.status === 405) return { error: "Orgo can't set up a runner on it yet", backoff: true };
  if (got?.status === 422) return { error: "a runner needs a Linux computer", backoff: true };
  return { error: RUNNER_NO_KEY, backoff: true };
}

/** Take back the key Bops gave computer `id` (Orgo revokes it, and takes it off the computer when it's up). Gone already counts. */
async function takeKeyBack(id: string, key: string): Promise<boolean> {
  const got = await callOrgo(key, `/api/computers/${encodeURIComponent(id)}/orgo-key`, { method: "DELETE", timeoutMs: 60_000 });
  return got?.status === 200 || got?.status === 404;
}

/**
 * Stop computer `id`'s runner, saying `why` in its threads (they end; a computer deleted says so). It's
 * taken off a computer that's up or gone; one asleep keeps it until it's up again, and runs nothing
 * meanwhile (the state says it's being stopped, and a runner reads the state before it runs anything).
 * The key Bops gave the computer (keyMade) is revoked, by whichever Mac stops it; a key it came with
 * stays (the computer's: Orgo revokes it with the computer). It goes from the state once it's off and
 * that key is revoked.
 *
 * A run there paused for the user's OK (lib/types.ts pausedForOk) doesn't end with it (switching to This Mac,
 * the bots to browsers on the Mac, no bot on the computer any more): it waits on there, its request kept, and
 * the change is for the runs to come, as for a routine changed meanwhile (strays). Their answer wakes the
 * computer and carries it on to its end there (or Stop ends it), and only then is the runner taken off, and
 * its key revoked: the run needs both. Not when the computer is deleted (the run is gone with it), nor when
 * someone else can use its workspace, nor when the runner had failed, nor when its program is gone from the
 * computer, before the stop or while it was kept (asked whenever the computer is up, never waking it: stillRuns).
 * Nothing is left on the computer then to read the answer or a Stop, and no runner is set up there again for a
 * computer nobody wants: the run ends, its request resolved as Stop resolves it.
 */
async function stop(id: string, key: string, why: string) {
  const user = userNow();
  const me = stateDevice();
  let x = runnerOf(id);
  if (!x || !user || !me) return;
  const c = await orgo.computer(id).catch((e: unknown) => (computerGone(e) ? ("gone" as const) : null));
  const device = deviceIdFor(user, id);
  const gone = c === "gone" || c?.status === "deleted";
  const over = c === "gone" ? STOPPED.gone : c && computerStaysDown(c.status) ? STOPPED.down(c.status) : undefined;
  // A runner that failed is no runner to keep a run for: its program is gone or stopped on the computer, and nothing
  // sets one up again there now.
  let keep = !gone && why !== STOPPED.full && x.status !== "failed";
  if (x.status !== "stopping") {
    x = { ...x, status: "stopping", at: Date.now() };
    mark(id, x);
    endSessionsOf(device, over ?? why, { gone: !keep });
    // Being stopped already, with a run it kept (one paused for the user's OK, after a switch to This Mac or its bot
    // moved): now that it goes for good (its computer gone or down for good, or someone else can use the workspace),
    // that run ends too, its request resolved as Stop resolves it, as no runner is left to read the answer.
  } else if (over || !keep) endSessionsOf(device, over ?? why, { gone: !keep });
  // A run it keeps, with its computer up: whether its program is still there to carry that run on (stillRuns). Gone (it
  // died before the stop, before any look noticed, or while it was kept), the run ends for good, as for one that failed.
  if (keep && busy(id) && c !== "gone" && c?.status === "running" && (await stillRuns(id, me, key)) === false) {
    keep = false;
    endSessionsOf(device, STOPPED.runnerDown(GONE_THERE), { gone: true });
  }
  // A run it kept (one paused for the user's OK, or answered since and going on): the runner stays on, with its key, till it's over.
  if (keep && busy(id)) return;
  let off = false;
  if (c === "gone") off = true;
  else if (c?.status === "running") off = !!(await orgo.bash(id, UNINSTALL_SCRIPT, 180).catch(() => null))?.output.includes("__BOPS_OFF__");
  if (runnerKeyMade(x) && (await takeKeyBack(id, key))) {
    // The key's gone (and an entry from before keyMade loses its old keyBy with it).
    x = keyless(x);
    mark(id, x);
  }
  if (off && !runnerKeyMade(x)) forget(id);
}

/**
 * A computer that's up (as Orgo said just now: keepUp, stop) whose runner is marked up but left one of its
 * routines well past its time (a runner that runs advances it before it starts), or that a run waits on (one
 * the user answered, or one it's kept on for after a stop): whether its program is still there, asked at most
 * once an hour (15 minutes for a runner on its computer's identity, which may have lost it), and again for an
 * answer of the user's given since it was last asked (answersFor), which nothing else would ever notice wasn't
 * read. Gone or stopped (it left as a copy by mistake, or kept failing): one marked up couldn't start, so its
 * routines go back to the Mac before their next run, and it's set up again later. A computer asleep, or down
 * and not coming back by itself, is never asked (that would wake it): its routines wait for it (lookDown).
 * Whether it's there (true), gone (false), or not asked or not said (undefined).
 *
 * The way back: a computer with no key whose identity doesn't answer (anything but 200 or 403), or whose
 * runner says it has nothing to sign in with, gets its key from Orgo again (wayBack). A runner left
 * with no credential waits for one rather than stopping (runner-start.ts), which is why its routines
 * fell overdue.
 */
async function stillRuns(id: string, me: string, key: string): Promise<boolean | undefined> {
  const asked = (box.asked ??= new Map());
  const every = runnerOf(id)?.auth === "identity" ? STILL_RUNS_IDENTITY_MS : STILL_RUNS_EVERY_MS;
  const answers = answersFor(id);
  const seen = (box.answersAsked ??= new Map()).get(id);
  if (Date.now() - (asked.get(id) ?? 0) < every && answers.every((a) => seen?.has(a))) return undefined;
  asked.set(id, Date.now());
  box.answersAsked.set(id, new Set(answers));
  const got = await orgo.bash(id, STILL_RUNS_SCRIPT, 30).catch(() => null);
  // Only a read that ran to its end says anything.
  if (got?.exit_code !== 0 || !got.output.includes("__BOPS_STATUS_END__")) return undefined;
  const said = (k: string) => new RegExp(`^${k}=(.*)$`, "m").exec(got.output)?.[1]?.trim() ?? "";
  const up = /\b(RUNNING|STARTING|BACKOFF)\b/.test(got.output);
  const auth = authIn(got.output);
  const ident = said("ident");
  // No key and no identity it can use, or a key in its files that isn't its own (it says none: orgo-auth.ts): its own from Orgo.
  if (ident !== "403" && ((said("key") === "no" && (ident !== "200" || auth === "none")) || (said("key") === "yes" && auth === "none"))) return wayBack(id, me, key, up);
  const x = runnerOf(id);
  if (up) {
    if (x?.status === "running" && auth && x.auth !== auth) mark(id, { ...x, auth });
    return true;
  }
  if (x?.status === "running") failed(id, GONE_THERE, null, me);
  return false;
}

/**
 * A runner with no key and no identity it can use: Orgo gives its computer its key again (Bops' to take
 * back: keyMade), and supervisord starts it if it's stopped. A runner that's up and waiting picks the key
 * up within 30 seconds (runner-start.ts). Refused: it couldn't start, and why (its routines go back to
 * the Mac). Whether it has its key again (and so goes on).
 */
async function wayBack(id: string, me: string, key: string, up: boolean): Promise<boolean> {
  const given = await giveKey(id, key);
  if ("error" in given) {
    if (runnerOf(id)?.status === "running") failed(id, given.error, null, me);
    return false;
  }
  const x = runnerOf(id);
  if (x) mark(id, { ...x, keyMade: true, keyId: given.keyId, auth: undefined });
  if (!up) await orgo.bash(id, "supervisorctl start bops-runner >/dev/null 2>&1; true", 30).catch(() => null);
  console.info(`[runner-install] ${id}: its runner had nothing to sign in with: its computer has its key again`);
  return true;
}

/* ---------------- When ---------------- */

/**
 * What a look depends on, besides the time: where the bots work, which computers they're on, each
 * runner's state, and the runs a runner left going of routines it no longer runs (strays: one set to run
 * on the Mac is looked at within a minute, not at the next full look). A runner being stopped that kept a
 * run of its going (one paused for the user's OK: stop) is taken off within a minute of that run's end.
 */
function signature() {
  const s = getState();
  const on = [...new Set(s.bots.map((b) => workBot(b, s.bots).computerId).filter(Boolean))].sort().join(",");
  const runners = Object.entries(s.runners ?? {})
    .map(([id, x]) => `${id}:${x.status}:${x.version}:${x.buildId}${x.status === "stopping" && busy(id) ? ":kept" : ""}`)
    .sort()
    .join(",");
  const user = userNow();
  const left = user
    ? Object.keys(s.runners ?? {})
        .flatMap((id) => strays(id, deviceIdFor(user, id)))
        .sort()
        .join(",")
    : "";
  return `${heardRunsOn() ?? ""}|${runsOnMissing()}|${s.host ?? ""}|${on}|${runners}|${left}`;
}

/** Each minute: a full look when something it depends on changed, or every 10 minutes. */
function checkNow() {
  if (!stateReady()) return;
  const sig = signature();
  const now = Date.now();
  if (sig !== box.seen || now - box.lookedAt >= LOOK_EVERY_MS) {
    box.seen = sig;
    return void lookAtRunners();
  }
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

/** Started by the state route on the Mac: a look now, then each minute when something it depends on changed, and every 10 minutes anyway (checkNow). Never on a runner. */
export function startRunnerInstalls() {
  if (box.timer || !loopHere("runner-install") || !stateInCloud()) return;
  box.timer = setInterval(checkNow, CHECK_MS);
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
    box.asked?.clear();
    box.answersAsked?.clear();
    box.identityOnly = undefined;
  },
  retryAt: (id: string) => box.retry.get(id)?.at,
  /** One turn of the minute timer (checkNow), with the last full look `lookedAgo` ms back. */
  check: (lookedAgo?: number) => {
    if (lookedAgo !== undefined) {
      box.lookedAt = Date.now() - lookedAgo;
      box.seen = signature();
    }
    checkNow();
    return { looking: box.looking };
  },
  /** Phase 2 (IDENTITY_ONLY) on or off for the tests. */
  identityOnly: (on?: boolean) => void (box.identityOnly = on),
};
