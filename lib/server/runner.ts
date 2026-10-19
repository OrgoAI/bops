import "server-only";
import { workBot, type Bot, type Routine, type RunnerState } from "@/lib/types";
import { sleptSince } from "./awake";
import { onRunner } from "./persist";
import { getState, pullState, statePulledAt } from "./store";

/**
 * Where the user's bots work, and which Bops runs each routine. Where they work is the user's to pick
 * (Settings: Cloud, the default, or This Mac), and Orgo keeps it (GET and PUT /api/bops/settings). In
 * Cloud, a computer of the bots' with a Bops runner of its own (AppState.runners, set up from the Mac)
 * runs the routines of the bots that work on it, so they keep running while the Mac is closed: Orgo
 * wakes that computer when one comes due (orgo-web lib/bops-routine-wake.ts, from the routines mirror,
 * routine-sync.ts). The Mac runs the rest: routines that need the Mac (pinnedToMac), those of bots with
 * no computer yet, and those of a computer whose runner isn't up. On This Mac, the Mac runs them all.
 *
 * A runner is this same server on that computer (BOPS_RUNNER=1; BOPS_RUNNER_COMPUTER is the computer's
 * Orgo id, and so is BOPS_DEVICE_SEED, which makes its device id: persist-cloud.ts deviceIdFor). It
 * runs nothing it isn't sure of: where the bots work as Orgo said under a minute ago, and the state as
 * read under 40 seconds ago, neither from before a nap (its computer suspended in between). No routine
 * runs on two Bops at once: each decides from the same shared state, and after a switch to This Mac the
 * Mac takes a computer's routines only once its runner's stop is confirmed, or HANDOVER_MS after it
 * heard of the switch (a runner asks again at least every minute).
 */

/** The computer this runner is on (BOPS_RUNNER_COMPUTER, its Orgo id): it runs the routines of the bots that work there. */
export const runnerComputer = () => process.env.BOPS_RUNNER_COMPUTER || undefined;
export { onRunner };

/** A new task's words that put it on the user's Mac (where.ts chooseWhere), and a routine's (pinnedToMac). */
export const MAC_WORDS = /\b(on|from|using|use|with) my (mac|macbook|laptop|computer)\b|\blocally\b|\bon this mac\b/i;

/**
 * Whether a routine's runs need the user's Mac, from what every Bops of theirs sees alike (never a Mac's
 * own rules, state.mac): a task set to run there, or one left to Bops whose bot works on the Mac or whose
 * job says so ("on my Mac", "locally"). Reminders and chat runs use no computer, so never. The Mac runs
 * these (runsHere), and Orgo never wakes a computer for them (the routines mirror's onMac).
 */
export function pinnedToMac(r: Pick<Routine, "where" | "goal" | "reminder" | "run">, b: Pick<Bot, "runsOn"> | undefined): boolean {
  if (r.reminder || r.run === "chat") return false;
  return r.where === "mac" || (r.where !== "cloud" && (b?.runsOn === "mac" || MAC_WORDS.test(r.goal)));
}

type RunsOn = "cloud" | "mac";

/** Orgo's setting for where the user's bots work. */
const SETTINGS = "/api/bops/settings";
const TIMEOUT_MS = 15_000;
/** How often the Mac asks Orgo where the bots work (a switch on another Mac), and a runner. */
const ASK_EVERY_MS = 60_000;
const RUNNER_ASK_EVERY_MS = 30_000;
/** A runner runs routines only on Orgo's word this fresh, and on the state read this recently. */
const MODE_FRESH_MS = 60_000;
const PULL_FRESH_MS = 40_000;
/** After a switch to This Mac, how long the Mac leaves a computer's routines to its runner while its stop isn't confirmed. */
export const HANDOVER_MS = 90_000;
/** An Orgo without the setting (404 or 405) is asked again after this: until then the bots work on the Mac. */
const MISSING_RETRY_MS = 60 * 60_000;

/** What Orgo last said, for whom, and when. */
type Heard = {
  user: string;
  runsOn: RunsOn;
  at: number;
  /** When this server heard the bots work on This Mac: the Mac waits HANDOVER_MS from here for a runner whose stop isn't confirmed. */
  macSince?: number;
  /** Orgo hasn't the setting: not asked again until then. */
  missingUntil?: number;
};
const g = globalThis as unknown as {
  __bopsRunsOn?: { heard?: Heard; asking?: Promise<void>; claimed?: string; timer?: ReturnType<typeof setInterval>; freshening?: Promise<unknown> };
};
const box = (g.__bopsRunsOn ??= {});

const userNow = () => getState().account?.user.id;
/** What Orgo said for the user signed in now, if it said anything yet. */
const heard = () => (box.heard && box.heard.user === userNow() ? box.heard : undefined);

function hear(user: string, runsOn: RunsOn, missingUntil?: number) {
  const now = Date.now();
  const before = box.heard?.user === user ? box.heard : undefined;
  const macSince = runsOn === "mac" ? (before?.runsOn === "mac" && before.macSince !== undefined ? before.macSince : now) : undefined;
  box.heard = { user, runsOn, at: now, ...(macSince !== undefined ? { macSince } : {}), ...(missingUntil ? { missingUntil } : {}) };
}

/**
 * Where the user's bots work, as this server last heard from Orgo: "cloud", or "mac" when it hasn't
 * heard (or Orgo has no such setting, or the user never set it and Orgo hasn't taken the default yet).
 */
export const runsOn = (): RunsOn => heard()?.runsOn ?? "mac";

/** Orgo can't keep where the bots work yet (an Orgo from before the setting): Settings says so. */
export const runsOnMissing = () => !!heard()?.missingUntil;

/**
 * Ask Orgo where the user's bots work. It never set (an app from before this one wrote nothing): the Mac
 * sets the default, Cloud, once, and goes by it only once Orgo took it. A runner never sets it, and an
 * answer it didn't get leaves it running nothing once what it heard is a minute old.
 */
async function ask(): Promise<void> {
  const user = userNow();
  if (!user) return;
  const h = heard();
  if (h?.missingUntil && h.missingUntil > Date.now()) return;
  const { apiKey, callOrgo } = await import("./orgo");
  const key = await apiKey().catch(() => "");
  if (!key || userNow() !== user) return;
  const res = await callOrgo<{ runsOn?: unknown }>(key, SETTINGS, { timeoutMs: TIMEOUT_MS });
  if (userNow() !== user) return;
  const status = res?.status ?? null;
  if (status === 404 || status === 405) return hear(user, "mac", Date.now() + MISSING_RETRY_MS);
  if (!res || status !== 200) return;
  const said = res.json?.runsOn;
  if (said === "cloud" || said === "mac") return hear(user, said);
  if (!onRunner() && box.claimed !== user) {
    const put = await callOrgo(key, SETTINGS, { method: "PUT", body: { runsOn: "cloud" }, timeoutMs: TIMEOUT_MS });
    // Answered (taken or refused): not asked again. No answer, or 5xx: the next ask tries again.
    if (put && put.status < 500) box.claimed = user;
    if (put?.status === 200 && userNow() === user) return hear(user, "cloud");
  }
  hear(user, "mac");
}

/** Ask Orgo now (one ask at a time). Never throws. */
export function askRunsOn(): Promise<void> {
  box.asking ??= ask()
    .catch((e: Error) => console.warn(`[runner] where the bots work: ${e.message}`))
    .finally(() => (box.asking = undefined));
  return box.asking;
}

/** Ask now, then every minute (a runner, every 30 seconds). Started by the state route on the Mac, and by a runner's routines timer. */
export function startRunsOn() {
  if (box.timer) return;
  box.timer = setInterval(() => void askRunsOn(), onRunner() ? RUNNER_ASK_EVERY_MS : ASK_EVERY_MS);
  box.timer.unref?.();
  void askRunsOn();
}

/** Settings: where the user's bots work from now on. Never from a runner. */
export async function setRunsOn(to: RunsOn): Promise<{ error?: string; missing?: true }> {
  const user = userNow();
  if (onRunner() || !user) return { error: "Sign in to Bops first." };
  const { apiKey, callOrgo } = await import("./orgo");
  const key = await apiKey().catch(() => "");
  if (!key) return { error: "Sign in to Bops first." };
  const res = await callOrgo(key, SETTINGS, { method: "PUT", body: { runsOn: to }, timeoutMs: TIMEOUT_MS });
  if (res?.status === 404 || res?.status === 405) {
    hear(user, "mac", Date.now() + MISSING_RETRY_MS);
    return { error: "Cloud isn't available yet.", missing: true };
  }
  if (res?.status !== 200) return { error: "Couldn't reach Orgo. Try again in a moment." };
  if (userNow() === user) hear(user, to);
  return {};
}

/** Fresh enough to go by: younger than `ms`, and no nap since (the computer was suspended, or the Mac slept). */
const fresh = (at: number, ms: number, now: number) => at > 0 && now - at < ms && !sleptSince(at);

/**
 * On a runner: whether it may run routines now. It goes by where the bots work as Orgo said under a
 * minute ago and by the state as read under 40 seconds ago, neither from before a nap: while its
 * computer was suspended anything may have changed (a routine paused, set to This Mac, its bot moved).
 * When either is older it reads both again, runs nothing meanwhile, and then calls `again` (the tick)
 * if they're fresh now.
 */
export function runnerReady(again?: () => void): boolean {
  startRunsOn();
  const now = Date.now();
  const ready = (t: number) => fresh(heard()?.at ?? 0, MODE_FRESH_MS, t) && fresh(statePulledAt(), PULL_FRESH_MS, t);
  if (ready(now)) return true;
  box.freshening ??= Promise.all([fresh(statePulledAt(), PULL_FRESH_MS, now) ? undefined : pullState(), fresh(heard()?.at ?? 0, MODE_FRESH_MS, now) ? undefined : askRunsOn()]).finally(() => {
    box.freshening = undefined;
    if (ready(Date.now())) again?.();
  });
  return false;
}

/** The computer the routine's bot works on (its own, or its main bot's when it shares), if it has one. */
function computerOf(r: Pick<Routine, "botId">): string | undefined {
  const s = getState();
  const b = s.bots.find((x) => x.id === r.botId);
  return b ? workBot(b, s.bots).computerId : undefined;
}

/**
 * Whether a computer's runner may be running its routines: it's up, and the bots work in the Cloud (or
 * the switch to This Mac is under HANDOVER_MS old), or it's being stopped and that began under
 * HANDOVER_MS ago. Set up, couldn't start, or none: no.
 */
function runnerMayRun(x: RunnerState | undefined, now: number): boolean {
  if (x?.status === "running") {
    const since = heard()?.macSince;
    return since === undefined || now - since < HANDOVER_MS;
  }
  if (x?.status === "stopping") return now - x.at < HANDOVER_MS;
  return false;
}

/** On a runner: the routine is this one's, its bot working on this computer and the Mac not needed (whether or not it may run it right now). */
export function runnerRoutine(r: Routine): boolean {
  const here = runnerComputer();
  return !!here && computerOf(r) === here && !pinnedToMac(r, getState().bots.find((x) => x.id === r.botId));
}

/**
 * Whether this server runs the routine when it comes due (the routines timer, routines.ts tick).
 * - A runner: one of its own (runnerRoutine), while the bots work in the Cloud as Orgo said under a
 *   minute ago and its computer's runner is marked up (the Mac has stopped taking its routines).
 * - The Mac: the rest. One that needs the Mac, one whose bot has no computer, and one whose computer has
 *   no runner up (none, being set up, couldn't start, or stopped, or the switch to This Mac is
 *   HANDOVER_MS old). Until Orgo answers, a computer whose runner is up keeps its routines.
 */
export function runsHere(r: Routine, now = Date.now()): boolean {
  const s = getState();
  const computer = computerOf(r);
  if (onRunner()) {
    const h = heard();
    return !!computer && runnerRoutine(r) && h?.runsOn === "cloud" && fresh(h.at, MODE_FRESH_MS, now) && s.runners?.[computer]?.status === "running";
  }
  if (!computer || pinnedToMac(r, s.bots.find((x) => x.id === r.botId))) return true;
  return !runnerMayRun(s.runners?.[computer], now);
}

/** Tests: what Orgo said, as if it said it (`at` back in time to make it older), and forgetting it. */
export const runnerForTests = {
  hear: (user: string, to: RunsOn, opts: { ago?: number; macAgo?: number } = {}) => {
    hear(user, to);
    if (box.heard && opts.ago) box.heard.at -= opts.ago;
    if (box.heard?.macSince !== undefined && opts.macAgo !== undefined) box.heard.macSince = Date.now() - opts.macAgo;
  },
  reset: () => {
    if (box.timer) clearInterval(box.timer);
    for (const k of Object.keys(box) as (keyof typeof box)[]) delete box[k];
  },
};
