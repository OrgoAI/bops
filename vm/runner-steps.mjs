// The steps that set a Bops runner up on a bot's computer, stop it, and check it: the one copy of them, run by the
// Bops app on the owner's Mac (lib/server/runner-install.ts, through Orgo's bash) and by the computer's own keeper
// (vm/bin/bops-runner-keeper.mjs, on the computer itself). Plain Node ESM with no dependencies: the keeper runs it as
// a file beside it (/opt/bops/keeper/runner-steps.mjs), with nothing of the app's around it. Types in runner-steps.d.mts.
//
// A few names here are copies of the app's own, as this file can import nothing (the tests check each pair is equal):
// RUNNER_TURNS_DIR and RUNNER_HOLD (cloud/protocol.ts), RUNNER_CONF and RUNNER_WRAPPER (lib/server/runner.ts),
// RUNNER_AUTH_FILE, ORGO_KEY_FILES and ORGO_KEY_LINE (lib/server/runner-key.ts), and RELEASE_KEYS and verifyRelease's
// checks (cloud/runner-release.ts).
import { createPublicKey, verify } from "node:crypto";

/* ---------------- Where a runner lives ---------------- */

export const ROOT = "/opt/bops/runner";
export const PORT = 3210;
/** Its supervisord program and the script that starts it (lib/server/runner.ts). */
export const RUNNER_CONF = "/etc/supervisor/conf.d/bops-runner.conf";
export const RUNNER_WRAPPER = "/opt/bops/runner/run.sh";
/** What the runner last said it signs in with (lib/server/runner-key.ts). */
export const RUNNER_AUTH_FILE = "/opt/bops/runner/auth";
/** Where the runner marks each reply it's answering, and an upgrade's hold (cloud/protocol.ts). */
export const RUNNER_TURNS_DIR = "/var/run/bops/turns";
export const RUNNER_HOLD = "/var/run/bops/upgrading";
/** Touched by the runner every 30 seconds while a thread of its own runs that isn't paused for an OK (runner-chat.ts startWorkingBeat). */
export const RUNNER_WORKING = "/var/run/bops/working";
/** Touched by the runner when Bops Cloud says a new release is out (its stream's "update"): the keeper looks at once. */
export const RUNNER_KEEPER_LOOK = "/var/run/bops/keeper-look";

/* ---------------- The keeper ---------------- */

/** The keeper's files: keeper.mjs, this file, keeper.json, its state, and the markers `pin` and `off`. */
export const KEEPER_DIR = "/opt/bops/keeper";
/** Touched by the keeper while it sets the runner up or updates it: the Mac's look waits (runner-install.ts probeScript). */
export const KEEPER_HOLD = "/var/run/bops/keeper-hold";
/** The keeper's supervisord program, and where it goes. */
export const KEEPER_CONF_FILE = "/etc/supervisor/conf.d/bops-keeper.conf";
export const KEEPER_CONF = [
  "[program:bops-keeper]",
  `command=/usr/bin/node ${KEEPER_DIR}/keeper.mjs`,
  "user=root",
  "autostart=true",
  "autorestart=true",
  "startsecs=5",
  "redirect_stderr=true",
  "stdout_logfile=/var/log/bops/keeper.log",
  "stdout_logfile_maxbytes=1MB",
  "stdout_logfile_backups=1",
  "",
].join("\n");

/* ---------------- The bundle ---------------- */

/** bops-server-<version>-<BUILD_ID>.tgz (Bops versions are x.y.z; Next's BUILD_ID is letters, digits, _ and -). */
export const BUNDLE_NAME = /^bops-server-(\d+\.\d+\.\d+)-([A-Za-z0-9_-]{1,64})\.tgz$/;
/** A build's folder under ROOT: <version>-<BUILD_ID>. */
const BUILD_DIR = /^\d+\.\d+\.\d+-[A-Za-z0-9_-]{1,64}$/;

/* ---------------- On the computer ---------------- */

export const q = (s) => `'${s.replace(/'/g, `'\\''`)}'`;

/**
 * A computer's own Orgo key, as Orgo writes it (lib/server/runner-key.ts): the files, and a line in them that sets a
 * non-empty ORGO_API_KEY, as extended grep reads it. Only whether one is there is ever asked; it's never printed.
 */
export const ORGO_KEY_FILES = ["/root/.orgo-secrets.env", "/root/.env"];
export const ORGO_KEY_LINE = `^[[:space:]]*(export[[:space:]]+)?ORGO_API_KEY=['"]?[^'"[:space:]]`;
export const KEY_LINE = `grep -qsE ${q(ORGO_KEY_LINE)} ${ORGO_KEY_FILES.join(" ")} && echo key=yes || echo key=no`;

/**
 * What the runner last said it signs in with: the word in its auth file (RUNNER_AUTH_FILE, written at each
 * change), else its log's last `[runner] auth:` line (a runner from before the file; the log rotates at
 * 5 MB and the word is said only when it changes). The word only, as orgo-web logs a command's output.
 */
export const AUTH_LINE = `echo "auth=$( (grep -sxE '(identity|key|none)' ${RUNNER_AUTH_FILE} || grep -E '^\\[runner\\] auth: (identity|key|none)$' /var/log/bops/runner.log 2>/dev/null | sed 's/^.*: //') | tail -n 1)"`;

/** In the install script: a reply the runner marks (RUNNER_TURNS_DIR, touched in the last 2 minutes) ends it as busy. */
export const BUSY_EXIT = `if [ -n "$(find ${RUNNER_TURNS_DIR} -type f -mmin -2 2>/dev/null | head -1)" ]; then echo __BOPS_BUSY__; exit 0; fi`;
/** The same for a thread of the runner's own that's going (RUNNER_WORKING, touched in the last 2 minutes): restarting it would cut it off. */
export const WORKING_EXIT = `if [ -n "$(find ${RUNNER_WORKING} -mmin -2 2>/dev/null)" ]; then echo __BOPS_BUSY__; exit 0; fi`;
/** busy=yes while the runner there marks a reply it's answering (RUNNER_TURNS_DIR, touched in the last 2 minutes). */
export const BUSY_LINE = `[ -n "$(find ${RUNNER_TURNS_DIR} -type f -mmin -2 2>/dev/null | head -1)" ] && echo busy=yes || echo busy=no`;

/**
 * The script supervisord starts: the runner's settings (none of them secret), a window token made fresh,
 * then the server. Never its key: the runner reads that from its computer's files itself (runner-key.ts),
 * again when Orgo has written a new one. TZ is the user's zone when it's set up; it follows the user's
 * zone after that (routines.ts keepZone).
 */
export function wrapperScript(o) {
  return [
    "#!/bin/sh",
    "# The Bops runner on this computer, set up by Bops: the app on the user's Mac (lib/server/runner-install.ts) or this computer's keeper (vm/bin/bops-runner-keeper.mjs), both with vm/runner-steps.mjs.",
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
 * __BOPS_INSTALLED__ when it got that far, __BOPS_NO_FILES__ when neither the upload nor the build is there,
 * __BOPS_BUSY__ when the runner there is answering a reply or running a thread of its own (nothing swapped).
 *
 * `keep`: a build left in place with this one (the keeper's previous build, which it rolls back to when this one
 * fails its health check). `pin`: the Mac set up a build of its own (a dev Mac): the keeper never replaces a pinned
 * runner, so true writes KEEPER_DIR/pin and false (a packaged build) takes it off. Left out, neither.
 */
export function installScript(b, wrapper, opts = {}) {
  const dirName = `${b.version}-${b.buildId}`;
  if (opts.keep !== undefined && !BUILD_DIR.test(opts.keep)) throw new Error("keep isn't a build's folder");
  const kept = opts.keep !== undefined && opts.keep !== dirName ? `|${q(opts.keep)}` : "";
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
    // The runner is held (RUNNER_HOLD: it starts no new reply; a resume waits), then a reply it's answering stops the
    // upgrade before any file of the runner is swapped (restarting it would cut the reply off); tried again later. From
    // here to the restart is only the swap and the program's files, kept short. The hold goes when the script ends.
    `mkdir -p ${RUNNER_TURNS_DIR} && touch ${RUNNER_HOLD} && trap 'rm -f ${RUNNER_HOLD}' EXIT`,
    BUSY_EXIT,
    // So does a thread of its own that's going (a routine's run, a task): it beats RUNNER_WORKING while one runs.
    WORKING_EXIT,
    // Pinned (a dev build the Mac set up: the keeper leaves it alone) or not, before `current` changes.
    ...(opts.pin === true ? [`mkdir -p ${KEEPER_DIR} && date +%s > ${KEEPER_DIR}/pin`] : opts.pin === false ? [`rm -f ${KEEPER_DIR}/pin`] : []),
    `ln -sfn ${q(dirName)} "$d/current.next"`,
    `mv -Tf "$d/current.next" "$d/current"`,
    `cat > ${RUNNER_WRAPPER} <<'BOPS_EOF'\n${wrapper}BOPS_EOF`,
    `chmod 700 ${RUNNER_WRAPPER}`,
    `cat > ${RUNNER_CONF} <<'BOPS_EOF'\n${SUPERVISOR_CONF}BOPS_EOF`,
    // Its log and its auth file start over, so the health check reads this start's.
    ": > /var/log/bops/runner.log",
    `rm -f ${RUNNER_AUTH_FILE}`,
    "supervisorctl reread >/dev/null 2>&1 || true",
    "supervisorctl update >/dev/null 2>&1 || true",
    "supervisorctl restart bops-runner >/dev/null 2>&1 || true",
    // The builds before this one go only once it runs: the one restarted may have read its own files till then.
    `for v in "$d"/*/; do v="\${v%/}"; case "\${v##*/}" in incoming|current|${dirName}${kept}) ;; *) rm -rf "$v" ;; esac; done`,
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
 * with is the computer's. The keeper stays (its own program, and its files in KEEPER_DIR), told first that
 * the Mac took the runner off (KEEPER_DIR/off), so it doesn't set one up again on its own for a while.
 */
export const UNINSTALL_SCRIPT = [
  `mkdir -p ${KEEPER_DIR} && printf '{"at":%s,"why":"mac"}\\n' "$(date +%s)" > ${KEEPER_DIR}/off`,
  "supervisorctl stop bops-runner >/dev/null 2>&1",
  `rm -f ${RUNNER_CONF} ${RUNNER_WRAPPER}`,
  "supervisorctl update >/dev/null 2>&1",
  `mkdir -p ${ROOT}`,
  `exec 9>${ROOT}/.lock`,
  "flock -w 120 9",
  `find ${ROOT} -mindepth 1 -maxdepth 1 ! -name .lock -exec rm -rf {} +`,
  "echo __BOPS_OFF__",
].join("\n");

/* ---------------- Signed releases ---------------- */

/**
 * The keys a runner release is signed with (ed25519, SPKI PEM), by keyId: built in, and only here. Nothing in the
 * environment, a setting or a file adds one or changes one. A next key ships here a release before anything is
 * signed with it.
 */
export const RELEASE_KEYS = Object.freeze({
  // r2 replaces r1, which is retired. No release ever shipped r1, so there is no time when both are trusted.
  r2: "-----BEGIN PUBLIC KEY-----\nMCowBQYDK2VwAyEA7wTlC4TstXeDzpvruOw3kO3cilAogIIaAQLCl7qfiqA=\n-----END PUBLIC KEY-----\n",
});
/** The largest runner bundle a release may name. */
export const RELEASE_MAX_SIZE = 400 * 1024 * 1024;
/** The largest latest.json read. */
export const RELEASE_MAX_TEXT = 64 * 1024;

const VERSION = /^\d{1,4}\.\d{1,4}\.\d{1,6}$/;
const BUILD_ID = /^[A-Za-z0-9_-]{1,64}$/;
const SHA256 = /^[0-9a-f]{64}$/;
/** An ed25519 signature (64 bytes), base64. */
const SIG = /^[A-Za-z0-9+/]{86}==$/;
/** When it was signed: ISO 8601, UTC. */
const RELEASED = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d{1,3})?Z$/;

/**
 * A runner release (runner/latest.json, `{payload, sig, keyId}`), when it's one: its signature checks out with the
 * built in key it names (ed25519 over the payload's exact bytes), and the payload is a bops-runner release whose name
 * is its version and build, with a sha256, a size up to RELEASE_MAX_SIZE, when it was signed (ISO 8601, UTC), and the
 * state level it writes (a whole number from 1 to 9999). Null for anything else. The same checks as Bops Cloud's
 * (cloud/runner-release.ts verifyRelease, scripts/test-runner-keeper.mjs checks they agree), but for how far ahead of
 * its clock a release may say it was signed, which only Bops Cloud minds. `keys` is for tests: the keeper never passes it.
 */
export function verifyRelease(text, keys = RELEASE_KEYS) {
  if (typeof text !== "string" || text.length > RELEASE_MAX_TEXT) return null;
  let outer;
  try {
    outer = JSON.parse(text);
  } catch {
    return null;
  }
  if (!outer || typeof outer !== "object" || Array.isArray(outer)) return null;
  const { payload, sig, keyId } = outer;
  if (typeof payload !== "string" || typeof sig !== "string" || typeof keyId !== "string" || !SIG.test(sig)) return null;
  if (!Object.prototype.hasOwnProperty.call(keys, keyId)) return null;
  try {
    const key = createPublicKey(keys[keyId]);
    if (key.asymmetricKeyType !== "ed25519") return null;
    if (!verify(null, Buffer.from(payload, "utf8"), key, Buffer.from(sig, "base64"))) return null;
  } catch {
    return null;
  }
  let p;
  try {
    p = JSON.parse(payload);
  } catch {
    return null;
  }
  if (!p || typeof p !== "object" || Array.isArray(p)) return null;
  const { kind, version, buildId, name, sha256, size, released, stateLevel } = p;
  if (kind !== "bops-runner") return null;
  if (typeof version !== "string" || !VERSION.test(version) || typeof buildId !== "string" || !BUILD_ID.test(buildId)) return null;
  const m = typeof name === "string" ? BUNDLE_NAME.exec(name) : null;
  if (!m || m[1] !== version || m[2] !== buildId) return null;
  if (typeof sha256 !== "string" || !SHA256.test(sha256)) return null;
  if (typeof size !== "number" || !Number.isSafeInteger(size) || size < 1 || size > RELEASE_MAX_SIZE) return null;
  if (typeof released !== "string" || !RELEASED.test(released) || !Number.isFinite(Date.parse(released))) return null;
  if (typeof stateLevel !== "number" || !Number.isInteger(stateLevel) || stateLevel < 1 || stateLevel > 9999) return null;
  return { kind, version, buildId, name, sha256, size, released, stateLevel };
}
