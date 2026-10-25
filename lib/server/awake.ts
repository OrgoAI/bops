import "server-only";
import { spawn, type ChildProcess } from "node:child_process";

/**
 * This Mac awake while a task runs. Bops' server runs on the user's Mac, so a Mac that idles to sleep
 * mid-task stops the task with it: its model call waits out its 5 minutes and the thread says it's
 * stuck. While any task holds it, `caffeinate -i` keeps the Mac from idle sleep (the display may still
 * sleep, and closing the lid on battery still sleeps it); it ends with the last task, or with this server
 * (-w). Not on a hosted server (Linux), or with BOPS_KEEP_AWAKE=0.
 */

let holders = 0;
let caffeinate: ChildProcess | undefined;

/** Hold the Mac awake; call what it returns to let go (once is enough, twice does nothing). */
export function holdAwake(): () => void {
  if (process.platform !== "darwin" || process.env.BOPS_KEEP_AWAKE === "0") return () => {};
  holders++;
  if (!caffeinate) {
    const c = spawn("/usr/bin/caffeinate", ["-i", "-w", String(process.pid)], { stdio: "ignore" });
    c.on("error", () => caffeinate === c && (caffeinate = undefined));
    c.on("exit", () => caffeinate === c && (caffeinate = undefined));
    caffeinate = c;
  }
  let held = true;
  return () => {
    if (!held) return;
    held = false;
    if (--holders > 0) return;
    caffeinate?.kill();
    caffeinate = undefined;
  };
}

/**
 * When the Mac slept anyway (lid closed, or a routine that fired in a moment's wake): a tick every 5
 * seconds that comes 30 or more late means the process was asleep in between. A model call that timed
 * out across one is the Mac's doing, not the task stalling, and is made again (computer-task.ts).
 */
const TICK_MS = 5_000;
const naps: { from: number; to: number }[] = [];
let last = Date.now();
setInterval(() => {
  const now = Date.now();
  if (now - last > TICK_MS + 25_000) naps.push({ from: last, to: now });
  if (naps.length > 20) naps.shift();
  last = now;
}, TICK_MS).unref();

/** Whether the Mac slept at any point after `since`. */
export const sleptSince = (since: number) => naps.some((n) => n.to > since);

/** When this server started: it wasn't running before (Bops was quit, or not yet open). */
const started = Date.now();

/**
 * Whether this server ran, awake, from `at` until now: it had started by then and the Mac (or a runner's
 * computer) never slept since. A routine due then that's late wasn't missed while it was off or asleep
 * (routines.ts tick).
 */
export const awakeSince = (at: number) => started <= at && !sleptSince(at);
