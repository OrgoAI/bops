import "server-only";
import { live } from "@/lib/types";
import { checkIdentity, IDENTITY_EVERY_MS, runnerComputer, startRunsOn } from "./runner";

/**
 * A computer's Bops runner starting (instrumentation.ts, BOPS_RUNNER=1; runner.ts says what it is). It
 * has no window to poll /api/state, which is what starts the Mac's loops, so it starts its own here, and
 * only those a runner runs (persist.ts RUNNER_LOOPS): its key from its file, the user's state from Bops
 * Cloud, a look that it's on its own computer (again while a task of its own runs, and before it runs
 * anything after a nap: runner.ts checkIdentity), then the routines timer, asking Orgo where the bots work,
 * and saying its computer is in use while a task of its own runs. Its threads and the mirror of its own
 * routines start from the timer, as they do on the Mac.
 */

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const LOOPBACK = /^(127(?:\.\d{1,3}){3}|::1|localhost)$/i;

/**
 * Why a runner won't start with these settings, or null when it may. It answers on loopback only, with
 * a window token (nothing has it: no request but the open ones gets in), keeps the state in Bops Cloud
 * (never a file or Postgres), knows its computer, is that computer as a device, and has its key file.
 */
export function runnerRefusal(env: Record<string, string | undefined>): string | null {
  if ((env.BOPS_UI_TOKEN ?? "").length < 16) return "BOPS_UI_TOKEN isn't set";
  if (!LOOPBACK.test(env.HOSTNAME ?? "")) return "HOSTNAME isn't this computer's loopback (127.0.0.1)";
  if (env.BOPS_LISTEN_ALL === "1") return "BOPS_LISTEN_ALL is set: a runner answers on loopback only";
  if (env.BOPS_DATABASE_URL || env.BOPS_SELF_HOSTED === "1") return "a runner keeps the state in Bops Cloud, not in Postgres or a file";
  if (!UUID.test(env.BOPS_RUNNER_COMPUTER ?? "")) return "BOPS_RUNNER_COMPUTER isn't a computer's id";
  if ((env.BOPS_DEVICE_SEED ?? "").toLowerCase() !== env.BOPS_RUNNER_COMPUTER!.toLowerCase()) return "BOPS_DEVICE_SEED isn't the computer's id";
  if (!env.BOPS_ORGO_KEY_FILE) return "BOPS_ORGO_KEY_FILE isn't set";
  return null;
}

const STATE_RETRY_MIN_MS = 2000;
const STATE_RETRY_MAX_MS = 60_000;
const g = globalThis as unknown as { __bopsRunnerStarted?: boolean; __bopsRunnerIdentity?: ReturnType<typeof setInterval> };

/**
 * Start the runner, or stop the process when it mustn't run (runnerRefusal, no key): supervisord tries
 * a few times, then leaves it stopped. The state is loaded again until it is (Bops Cloud or Orgo down
 * for now), waiting longer each time.
 */
export async function startRunner() {
  if (g.__bopsRunnerStarted) return;
  g.__bopsRunnerStarted = true;
  const refused = runnerRefusal(process.env);
  if (refused) {
    console.error(`[runner] not starting: ${refused}`);
    process.exit(1);
  }
  const [{ loadOrgoKey }, { authStatus }, { getState, ownSession, stateReady }] = await Promise.all([import("./orgo-auth"), import("./orgo-sign-in"), import("./store")]);
  if (!(await loadOrgoKey())) {
    console.error("[runner] not starting: no key in BOPS_ORGO_KEY_FILE (Orgo writes it when the Mac sets the runner up)");
    process.exit(1);
  }
  for (let wait = STATE_RETRY_MIN_MS; !stateReady(); wait = Math.min(STATE_RETRY_MAX_MS, wait * 2)) {
    await authStatus({ retry: true }).catch((e: Error) => console.warn(`[runner] signing in: ${e.message}`));
    if (!stateReady()) await new Promise((r) => setTimeout(r, wait));
  }
  // A copy of another computer stops here (checkIdentity takes its runner off); no answer from Orgo runs nothing until one comes.
  await checkIdentity();
  // Again while a task of its own runs (its computer is in use then anyway): never while it's idle, as
  // a command on its computer counts as using it and would keep it from sleeping.
  g.__bopsRunnerIdentity ??= setInterval(() => {
    if (getState().sessions.some((s) => live(s) && ownSession(s) && s.runsOn !== "mac")) void checkIdentity();
  }, IDENTITY_EVERY_MS);
  startRunsOn();
  await import("./routines");
  const { startActivityBeat } = await import("./free-hours");
  startActivityBeat();
  // The Mac's health check waits for this line (runner-install.ts HEALTH_SCRIPT): it has the state and runs.
  console.log(`[runner] running the routines of the bots on ${runnerComputer()}`);
}
