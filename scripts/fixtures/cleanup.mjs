// Ending what a test or the two-person stack started (scripts/test-browser-relay.mjs, scripts/dev-two-person.mjs), and
// removing its temp folder only once nothing of it runs: a Chrome killed with SIGKILL is still writing its profile for
// a moment after kill() returns, and removing the folder then fails (ENOTEMPTY) or leaves it behind.
import { rmSync } from "node:fs";

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

/** Whether any process of the group `pid` leads still runs (a child started with `detached: true` leads its own). */
export function groupAlive(pid) {
  try {
    process.kill(-pid, 0);
    return true;
  } catch (e) {
    return e.code === "EPERM";
  }
}

/** SIGKILL the group `pid` leads, at once and synchronously (an "exit" handler can do no more). */
export function killGroup(pid) {
  // Only a real child's group: kill(-0) would be this process's own.
  if (!Number.isInteger(pid) || pid <= 1) return;
  try {
    process.kill(-pid, "SIGKILL");
  } catch {}
}

/** SIGKILL the group `pid` leads and resolve once none of it runs: true, or false if some of it still did after `ms`. */
export async function endGroup(pid, ms = 10_000) {
  if (!Number.isInteger(pid) || pid <= 1) return true;
  killGroup(pid);
  for (const end = Date.now() + ms; Date.now() < end; await sleep(50)) if (!groupAlive(pid)) return true;
  return !groupAlive(pid);
}

/** Remove a temp folder. Failing to is a warning naming it, never the caller's failure. */
export function removeTemp(dir) {
  try {
    rmSync(dir, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
  } catch (e) {
    console.warn(`warning: couldn't remove ${dir} (${e.code ?? e.message}); remove it by hand`);
  }
}
