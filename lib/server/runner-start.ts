import "server-only";
import { checkIdentity, IDENTITY_EVERY_MS, runnerComputer, startRunsOn, watchIdentity, WHO_AM_I_EVERY_MS } from "./runner";

/**
 * A computer's Bops runner starting (instrumentation.ts, BOPS_RUNNER=1; runner.ts says what it is). It
 * has no window to poll /api/state, which is what starts the Mac's loops, so it starts its own here, and
 * only those a runner runs (persist.ts RUNNER_LOOPS): its credential (its computer's Orgo identity, else
 * its own ORGO_API_KEY, which Orgo writes when the computer is made from a template that asks for it, or
 * when the Mac sets the runner up on one without it: orgo-auth.ts runnerKey; none yet, it waits for one),
 * a look that it's on its own computer (again while a task of its own runs, and before it runs anything:
 * runner.ts checkIdentity; on identity, its VMM asked every minute too), the user's state from Bops
 * Cloud, then the routines timer, asking Orgo where the bots work, and saying its computer is in use
 * while a task of its own runs. Its threads and the mirror of its own routines
 * start from the timer, as they do on the Mac. The look comes before the state: a copy of the computer
 * (a clone starts its runner as the original's) that loaded the state would take the original runner's
 * live threads for its own and fail them (store.ts migrate), and save that.
 */

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const LOOPBACK = /^(127(?:\.\d{1,3}){3}|::1|localhost)$/i;

/**
 * Why a runner won't start with these settings, or null when it may. It answers on loopback only, with
 * a window token (nothing has it: no request but the open ones gets in), keeps the state in Bops Cloud
 * (never a file or Postgres), knows its computer, and is that computer as a device. Its key isn't a
 * setting: startRunner reads it from its computer.
 */
export function runnerRefusal(env: Record<string, string | undefined>): string | null {
  if ((env.BOPS_UI_TOKEN ?? "").length < 16) return "BOPS_UI_TOKEN isn't set";
  if (!LOOPBACK.test(env.HOSTNAME ?? "")) return "HOSTNAME isn't this computer's loopback (127.0.0.1)";
  if (env.BOPS_LISTEN_ALL === "1") return "BOPS_LISTEN_ALL is set: a runner answers on loopback only";
  if (env.BOPS_DATABASE_URL || env.BOPS_SELF_HOSTED === "1") return "a runner keeps the state in Bops Cloud, not in Postgres or a file";
  if (!UUID.test(env.BOPS_RUNNER_COMPUTER ?? "")) return "BOPS_RUNNER_COMPUTER isn't a computer's id";
  if ((env.BOPS_DEVICE_SEED ?? "").toLowerCase() !== env.BOPS_RUNNER_COMPUTER!.toLowerCase()) return "BOPS_DEVICE_SEED isn't the computer's id";
  return null;
}

const RETRY_MIN_MS = 2000;
const RETRY_MAX_MS = 60_000;
/** A runner with no credential yet asks its computer's identity and reads its key files this often. */
const NO_AUTH_EVERY_MS = 30_000;
const g = globalThis as unknown as {
  __bopsRunnerStarted?: boolean;
  __bopsRunnerIdentity?: ReturnType<typeof setInterval>;
  __bopsRunnerWhoAmI?: ReturnType<typeof setInterval>;
  /** Tests: how long a runner with no credential waits between looks. */
  __bopsRunnerNoAuthMs?: number;
};

/**
 * Start the runner, or stop the process when it mustn't run (runnerRefusal, its computer's identity
 * refused, a copy of its computer): supervisord tries a few times, then leaves it stopped. With no
 * credential at all (no identity here and no key file) it stays up and runs nothing, asking again every
 * 30 seconds, and starts once one is there: stopping would only have supervisord start it again forever,
 * which no look from the Mac could tell from a runner that runs (its log says `[runner] auth: none`, and
 * the Mac gives its computer a key when it looks: runner-install.ts stillRuns). The look at its computer,
 * then the state, are tried again until they're in (Orgo or Bops Cloud down for now), waiting longer
 * each time.
 */
export async function startRunner() {
  if (g.__bopsRunnerStarted) return;
  g.__bopsRunnerStarted = true;
  const refused = runnerRefusal(process.env);
  if (refused) {
    console.error(`[runner] not starting: ${refused}`);
    process.exit(1);
  }
  const [{ loadOrgoKey, lookForRunnerKey }, { authStatus }, { getState, ownSession, stateReady }] = await Promise.all([import("./orgo-auth"), import("./orgo-sign-in"), import("./store")]);
  if (!(await loadOrgoKey())) {
    console.warn("[runner] waiting: no Orgo identity and no ORGO_API_KEY on this computer yet (Orgo writes the key when the computer is made, or when the Mac sets the runner up)");
    do await new Promise((r) => setTimeout(r, g.__bopsRunnerNoAuthMs ?? NO_AUTH_EVERY_MS));
    while (!(await lookForRunnerKey()));
  }
  // A copy of another computer stops here (checkIdentity takes its runner off), before it reads the state; no answer from Orgo asks again.
  for (let wait = RETRY_MIN_MS; ; wait = Math.min(RETRY_MAX_MS, wait * 2)) {
    const look = await checkIdentity();
    if (look === "same") break;
    if (look === "copy") process.exit(1);
    await new Promise((r) => setTimeout(r, wait));
  }
  for (let wait = RETRY_MIN_MS; !stateReady(); wait = Math.min(RETRY_MAX_MS, wait * 2)) {
    await authStatus({ retry: true }).catch((e: Error) => console.warn(`[runner] signing in: ${e.message}`));
    if (!stateReady()) await new Promise((r) => setTimeout(r, wait));
  }
  // Again while a task of its own runs (its computer is in use then anyway): never while it's idle, nor while a
  // run of its only waits for the user's OK (queued: lib/server/permission.ts), as a command on its computer counts
  // as using it and would keep it from sleeping.
  g.__bopsRunnerIdentity ??= setInterval(() => {
    if (getState().sessions.some((s) => (s.status === "starting" || s.status === "running") && ownSession(s) && s.runsOn !== "mac")) void checkIdentity();
  }, IDENTITY_EVERY_MS);
  // On its computer's identity, its VMM asked which computer and VM this is, every minute (nothing goes
  // through Orgo, so it never keeps the computer from sleeping): a copy leaves, a new VM gets a new token.
  g.__bopsRunnerWhoAmI ??= setInterval(() => void watchIdentity(), WHO_AM_I_EVERY_MS);
  startRunsOn();
  await import("./routines");
  const { startActivityBeat } = await import("./free-hours");
  startActivityBeat();
  // The Mac's health check waits for this line (runner-install.ts HEALTH_SCRIPT): it has the state and runs.
  console.log(`[runner] running the routines of the bots on ${runnerComputer()}`);
}
