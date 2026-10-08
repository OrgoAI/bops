import "server-only";
import { existsSync } from "node:fs";
import type { MacState } from "@/lib/types";
import { findCodex, installCodex, installStatus } from "./codex-cli";
import { CHROME } from "./local";
import { onPostgres } from "./persist";
import { getState, stateReady, update } from "./store";

/**
 * The user's Mac as a place bots work. A task on the Mac runs the way every task runs: OpenAI's Agents
 * API runs the agent on Bops' API and the user's AI credit (through Bops Cloud, so it's counted and
 * priced), and `codex exec-server` runs its tools here, with Bops' own key (local.ts startExecutor),
 * in a Chrome of its own on this Mac, so websites see the user's home internet (sessions.ts run). The
 * executor runs in a macOS sandbox that leaves it the browser tools and nothing else: no shell, no
 * other programs, none of the user's files (executor-sandbox.ts).
 *
 * Bops never signs anyone in to ChatGPT and never starts Codex's app server: OpenAI doesn't allow its
 * app-server sign-in in a hosted or paid product. So bots don't use the Mac's own apps (Messages,
 * Notes, Finder…) for now; a task that needs one says so. The Mac is ready once the Codex CLI is here
 * (Bops installs it by itself, codex-cli.ts) and Chrome is.
 */

/** Apps and words that, named in a task, mean it belongs on the user's Mac (they can change the list). */
export const DEFAULT_MAC_RULES = process.platform === "win32"
  ? ["Notepad", "File Explorer", "Outlook", "Excel", "Word", "PowerPoint", "my desktop", "my Downloads", "my laptop", "my PC"]
  : ["Messages", "iMessage", "Notes", "Apple Mail", "Photos", "Finder", "Keynote", "Pages", "Numbers", "Xcode", "Reminders", "my desktop", "my Downloads", "my laptop", "my Mac"];

export const emptyMac = (): MacState => ({ ready: false, rules: [...DEFAULT_MAC_RULES] });

/** This server runs on the user's Mac (not a hosted one), where bots can work. */
const onTheMac = () => ["darwin", "win32"].includes(process.platform) && !onPostgres();

/**
 * Is the user's Mac ready for bots, and if not, the one thing it waits on: the Codex CLI that runs the
 * tools (Bops installs it when it's missing, once per start and again on Retry), or Chrome. Checked
 * now and then; the answer lives in state.mac.
 */
export async function checkMac() {
  // This Mac's readiness is kept in the signed-in user's state (state.mac, this Mac's own: state.macs):
  // none to keep it in signed out. A sign-in looks again once their state has loaded (orgo-sign-in.ts).
  if (!stateReady()) return false;
  let ready = false;
  let reason: string | undefined;
  let next: MacState["next"];
  if (!onTheMac()) {
    next = "elsewhere";
    reason = "Local-computer tasks require the Bops desktop app.";
  } else if (process.platform === "win32") {
    next = "elsewhere";
    reason = "Local-PC agent tasks are disabled until a restricted Windows executor is available; Orgo cloud computers are supported.";
  } else if (!findCodex()) {
    if (!installStatus()) installCodex(() => void checkMac().catch(() => {}));
    const failed = installStatus()?.state === "failed" ? installStatus()?.error : undefined;
    next = "codex";
    reason = failed !== undefined ? `Couldn't install Codex. ${failed}` : "Installing Codex";
  } else if (!existsSync(CHROME)) {
    next = "chrome";
    reason = "Install Google Chrome so bots can work on this Mac";
  } else ready = true;
  const now = { ready, reason, next, installing: next === "codex" && installStatus()?.state === "installing" };
  // Only a change goes out to the app.
  const was = getState().mac;
  if (was && (Object.keys(now) as (keyof typeof now)[]).every((k) => was[k] === now[k])) return ready;
  update((state) => {
    state.mac ??= emptyMac();
    Object.assign(state.mac, { ...now, checkedAt: Date.now() });
  });
  return ready;
}

/** Retry: install the CLI again if it's still missing (a failed install isn't retried by itself), then look again. */
export async function retryCodex() {
  if (!findCodex() && onTheMac()) installCodex(() => void checkMac().catch(() => {}));
  await checkMac();
}

const g = globalThis as typeof globalThis & { __bopsMacCheck?: ReturnType<typeof setInterval> };
g.__bopsMacCheck ??= setInterval(() => void checkMac().catch(() => {}), 5 * 60_000);
void checkMac().catch(() => {});
