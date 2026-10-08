import "server-only";
import { stopCloud } from "./cloud-tunnel";
import { forgetPlan } from "./plan";
import { flushState, stateInCloud } from "./store";

/** How long Restart Bops waits for the state to be saved before it lets go anyway. */
const SAVE_MS = 10_000;

/**
 * Restart Bops (components/app/restart.tsx), the server's half: what it lets go before the Mac app
 * stops it and opens again (desktop/main.cjs), which starts a new one.
 *
 * - The state is saved first, and waited on (for at most 10 seconds): on the Mac app that's the
 *   signed-in user's state going up to Bops Cloud (persist-cloud.ts: each new or changed message, then
 *   the rest), since the new server loads it from there; self-hosted, their file.
 * - Cached sessions go: Bops Cloud's (with the keys it handed out; its tunnel closes) and the Orgo plan.
 *
 * Who's signed in stays (their key is in the Keychain, read again on start, which loads their state
 * from Bops Cloud again) and so does everything in the state. On the way out the server saves once
 * more, with whatever changed since (persist.ts onExit, hookExit); what Bops Cloud still can't take
 * then is kept in the user's folder on this Mac and goes up at the next start (persist-cloud.ts
 * keepUnsent), so a restart while offline loses nothing. Throws when the state couldn't be saved in
 * time; the rest is let go all the same, as a restart is what fixes a stuck server.
 */
export async function prepareRestart() {
  const saved = await flushState(SAVE_MS).catch(() => false);
  await stopCloud();
  forgetPlan();
  if (!saved) throw new Error(stateInCloud() ? "Some changes hadn't reached Bops Cloud yet; they're sent once more on the way out, and kept on this Mac until they're up." : "The last save didn't finish; it's tried once more on the way out.");
}
