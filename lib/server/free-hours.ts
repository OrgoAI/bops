import "server-only";
import { live } from "@/lib/types";
import { cloudOn } from "./cloud";
import { orgo, OrgoError } from "./orgo";
import { orgoKey } from "./orgo-auth";
import { onPostgres } from "./persist";
import { postOrgo } from "./plan";
import { getState } from "./store";

/**
 * Free's Bops computer runs 10 hours a month, and Orgo suspends it after 15 minutes nobody uses it
 * (orgo-web lib/bops-free-hours.ts), so the hours are the ones it's used. Bops says when it's in use
 * (POST /api/bops/computer/active): once as it opens for each sign-in (which also tells Orgo this app
 * says so at all: an app that never has isn't suspended when idle, so its computer runs its 10 hours
 * straight), the moment a task starts on a computer in the cloud or the user takes over one of its
 * screens, then every few minutes while either goes on. A task waking it brings it back, while its
 * hours last. Asleep for want of use, Orgo may leave it asleep for a read of its screens (the app's
 * views, a task's first look) until it's said to be in use again; an action always wakes it.
 */
const EVERY_MS = 4 * 60_000;
/** How long a task or a takeover waits, as it starts, for Orgo to hear the computer is in use. */
export const START_SAY_MS = 5000;
const g = globalThis as unknown as { bopsActivityBeat?: NodeJS.Timeout; bopsActivitySaid?: string };

/** Something is using the bots' computer in the cloud right now: a task working there, or the user driving one of its screens. */
function inUse(): boolean {
  const s = getState();
  return s.sessions.some((x) => live(x) && x.runsOn !== "mac" && (x.status === "starting" || x.status === "running")) || s.takeover?.display !== undefined;
}

/**
 * One beat: say it's in use if it is (or this sign-in hasn't said so yet). The timer's step, and what a
 * task or a takeover calls as it starts (`timeoutMs`: how long it waits for Orgo then); the tests call it too.
 */
export async function sayInUse(timeoutMs?: number) {
  const key = orgoKey();
  if (!key || !cloudOn()) return;
  if (g.bopsActivitySaid === key && !inUse()) return;
  await postOrgo(key, "/api/bops/computer/active", {}, undefined, timeoutMs).then(
    () => void (g.bopsActivitySaid = key),
    () => {},
  );
}

/**
 * The user took over one of a computer's screens: Orgo hears at once that it's in use, and a computer
 * that's asleep (suspended) wakes for them (orgo.resume), since the live view only streams it, which
 * never wakes it. A status Orgo didn't answer for is no proof it's up, so it's resumed then too (orgo-web
 * answers 200 for one that's running, and 409 "not suspended" for one on its way up). Says why it
 * couldn't be woken (Orgo's own words for a 402: Free's 10 hours this month used, a plan without running
 * computers), or undefined when it's up or on its way. Never throws.
 */
export async function wakeForUser(computerId: string): Promise<string | undefined> {
  await sayInUse(START_SAY_MS).catch(() => {});
  const c = await orgo.computer(computerId).catch(() => null);
  if (c && c.status !== "suspended") return undefined;
  try {
    await orgo.resume(computerId);
    return undefined;
  } catch (e) {
    if (e instanceof OrgoError && e.status === 409 && /not suspended/i.test(e.said ?? "")) return undefined;
    return freeHoursUsed(e) ?? (e instanceof OrgoError && e.status === 402 && e.said ? e.said : "Try again in a moment.");
  }
}

/** Started by the state route, like the computer checks. Not on a hosted server, where users' states come and go. */
export function startActivityBeat() {
  if (g.bopsActivityBeat || onPostgres()) return;
  g.bopsActivityBeat = setInterval(() => void sayInUse().catch(() => {}), EVERY_MS);
  void sayInUse().catch(() => {});
}

/**
 * Orgo's words when Free's computer has used its 10 hours this month (402 bops_free_hours), or undefined
 * for any other error. Without the code, told by the words: this month's, or this week's from an Orgo
 * that still counts by the week.
 */
export function freeHoursUsed(e: unknown): string | undefined {
  if (!(e instanceof OrgoError) || e.status !== 402) return undefined;
  return e.code === "bops_free_hours" || /used its \d+ hours this (?:month|week)\b/.test(e.said ?? "") ? e.said : undefined;
}
