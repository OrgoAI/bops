import "server-only";
import { spawn } from "node:child_process";
import { randomBytes } from "node:crypto";
import { mkdirSync, rmSync, writeFileSync } from "node:fs";
import { workBot, type Bot, type Routine, type RunnerState } from "@/lib/types";
import { sleptSince } from "./awake";
import { onRunner } from "./persist";
import { getState, pullState, statePulledAt } from "./store";
import { identityHere, identityVmId, whoAmI } from "./vm-identity";

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
 * runs on two Bops at once: each decides from the same shared state, and a routine that leaves one Bops
 * for another (a switch to This Mac, a runner being set up again or stopped, its bot moved to another
 * computer, the routine set to run on the Mac) waits HANDOVER_MS on the one it goes to, or until the
 * runner's stop is confirmed, while the one it leaves hears of it (a runner reads the state at least
 * every 40 seconds before it runs anything). Nor on a copy of a computer: a runner makes sure it's on its
 * own (checkIdentity) right before it runs anything.
 *
 * What a runner runs at all is an allow-list (persist.ts RUNNER_LOOPS); it's set up and stopped from
 * the Mac (runner-install.ts), and docs/cloud-runner.md says the rest.
 */

/** The computer this runner is on (BOPS_RUNNER_COMPUTER, its Orgo id): it runs the routines of the bots that work there. */
export const runnerComputer = () => process.env.BOPS_RUNNER_COMPUTER || undefined;
export { onRunner };

/**
 * Where a runner lives on its computer (runner-install.ts writes them): its supervisord program and the
 * script that starts it. Its key isn't Bops': it's the computer's own ORGO_API_KEY, in the files Orgo
 * writes it in (runner-key.ts).
 */
export const RUNNER_CONF = "/etc/supervisor/conf.d/bops-runner.conf";
export const RUNNER_WRAPPER = "/opt/bops/runner/run.sh";
/**
 * What a copy of a computer with a runner takes off (RUNNER_SCRUB, leaveCopy): the runner's program and
 * the script that starts it, and never the computer's Orgo key. A copy's disk comes with its source's
 * key, and Orgo itself revokes that one and gives the copy a key of its own, or none where it may not
 * hold one (orgo-web lib/computer-orgo-key.ts), so no key is ever live on two computers.
 */
export const COPY_TAKES_OFF: readonly string[] = [RUNNER_CONF, RUNNER_WRAPPER];
/**
 * The first command on a new copy of a computer (sessions.ts ensureComputer, for a bot's own computer
 * made from its main bot's): the copied runner stopped and taken off, so the copy never runs the other
 * computer's routines as that computer. A runner is set up there afresh (runner-install.ts).
 */
export const RUNNER_SCRUB = `supervisorctl stop bops-runner >/dev/null 2>&1; rm -f ${COPY_TAKES_OFF.join(" ")}; supervisorctl update >/dev/null 2>&1; true`;

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
  __bopsRunsOn?: {
    heard?: Heard;
    asking?: Promise<void>;
    claimed?: string;
    timer?: ReturnType<typeof setInterval>;
    freshening?: Promise<unknown>;
    /** When this runner last made sure it's on its own computer (checkIdentity), and the look under way. */
    sureAt?: number;
    /** By routine: on the Mac, when it was last seen with a computer's runner, and which; on a runner, when it was last seen as not its own (handedOver). */
    seen?: Map<string, { at: number; from?: string }>;
    checking?: Promise<IdentityLook>;
    /** Tests: where the word is written, what a copy takes off (its runner's files elsewhere), and what it does instead of leaving. */
    nonceDir?: string;
    copyFiles?: readonly string[];
    leave?: () => void;
  };
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

/** What Orgo said, and only that: undefined when it hasn't answered yet (runsOn says "mac" then), "mac" too when it hasn't the setting. */
export const heardRunsOn = (): RunsOn | undefined => heard()?.runsOn;

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
 * On a runner, with one of its own routines due (runnerHasWork): whether it may run routines now. It
 * goes by where the bots work as Orgo said under a minute ago, by the state as read under 40 seconds
 * ago and by a look at which computer it's on under 45 seconds old, none from before a nap: while its
 * computer was suspended anything may have changed (a routine paused, set to This Mac, its bot moved).
 * When any is older it reads it again, runs nothing meanwhile, and then calls `again` (the tick) if
 * they're fresh now.
 */
export function runnerReady(again?: () => void): boolean {
  startRunsOn();
  const now = Date.now();
  const sure = (t: number) => fresh(box.sureAt ?? 0, SURE_FRESH_MS, t);
  const ready = (t: number) => sure(t) && fresh(heard()?.at ?? 0, MODE_FRESH_MS, t) && fresh(statePulledAt(), PULL_FRESH_MS, t);
  if (ready(now)) return true;
  box.freshening ??= Promise.all([
    fresh(statePulledAt(), PULL_FRESH_MS, now) ? undefined : pullState(),
    fresh(heard()?.at ?? 0, MODE_FRESH_MS, now) ? undefined : askRunsOn(),
    sure(now) ? undefined : checkIdentity(),
  ]).finally(() => {
    box.freshening = undefined;
    if (ready(Date.now())) again?.();
  });
  return false;
}

/* ---------------- Which computer a runner is on ---------------- */

export type IdentityLook = "same" | "copy" | "unknown";
/** How often a runner makes sure it's on its own computer while a task of its own runs. */
export const IDENTITY_EVERY_MS = 5 * 60_000;
/** How often a runner on its computer's identity asks its VMM which computer and VM it's on (watchIdentity): nothing goes through Orgo. */
export const WHO_AM_I_EVERY_MS = 60_000;
/**
 * How long one look stands for starting a run (without a nap since): a look right before each, so a live
 * copy of the computer (a fork, which carries on from the same memory) never starts one. Its computer is
 * about to be used by that run anyway, so the look doesn't keep it from sleeping.
 */
const SURE_FRESH_MS = 45_000;
const NONCE_DIR = "/run/bops-runner";
/** What the read prints after the word, so a read that was cut short (the computer's own time limit) is never taken for a copy. */
const NONCE_END = "__BOPS_NONCE_END__";

/**
 * On a runner: whether it's on the computer it was set up on (runnerComputer). A bot's own computer is
 * made as a copy of its main bot's (a fork, running, or a clone), and a copy of a computer with a runner
 * comes up with that runner, its key and its computer's id: it would run that computer's routines a
 * second time, as that computer. So at start (before it reads the state), right before it starts a run,
 * and every IDENTITY_EVERY_MS while a task of its own runs (never while idle: the read is a command on the
 * computer, which counts as using it), it writes a fresh random word here and reads it back through
 * Orgo from runnerComputer(). Its word there: it's there. Another, or none, in a read that ran to its
 * end: this is a copy, which takes its runner off (leaveCopy) and stops; its key stays, as Orgo gives a
 * copy its own or takes it off. No answer from Orgo, or a read that didn't finish (a slow computer's
 * command timing out), proves nothing either way; until a look says it's there, it runs nothing
 * (runnerReady).
 *
 * On its computer's Orgo identity (vm-identity.ts), it asks its VMM instead (whoAmI, from inside the
 * computer's own network, so only that computer can be the answer): another computer is a copy, which
 * leaves; its own is the same. Nothing goes through Orgo, so the look never counts as using the computer.
 * No answer there (its VMM restarting) is the look through Orgo above. A runner on its key file looks
 * only through Orgo, as before.
 */
export function checkIdentity(): Promise<IdentityLook> {
  box.checking ??= lookIdentity()
    .catch((e: Error) => {
      console.warn(`[runner] which computer this is: ${e.message}`);
      return "unknown" as const;
    })
    .finally(() => (box.checking = undefined));
  return box.checking;
}

async function lookIdentity(): Promise<IdentityLook> {
  const computer = runnerComputer();
  if (!onRunner() || !computer) return "unknown";
  if (identityHere()) {
    const asked = Date.now();
    const me = await whoAmI();
    if (me) {
      if (me.desktopId.toLowerCase() !== computer.toLowerCase()) {
        leaveCopy();
        return "copy";
      }
      box.sureAt = asked;
      return "same";
    }
  }
  const word = randomBytes(16).toString("hex");
  const dir = box.nonceDir ?? NONCE_DIR;
  mkdirSync(dir, { recursive: true, mode: 0o700 });
  writeFileSync(`${dir}/nonce`, word, { mode: 0o600 });
  const asked = Date.now();
  const { orgo } = await import("./orgo");
  const got = await orgo.bash(computer, `cat ${NONCE_DIR}/nonce 2>/dev/null; echo; echo ${NONCE_END}`, 20);
  const said = got.output.split(/\s+/);
  if (got.exit_code !== 0 || !said.includes(NONCE_END)) return "unknown";
  if (!said.includes(word)) {
    leaveCopy();
    return "copy";
  }
  box.sureAt = asked;
  return "same";
}

/**
 * On a runner on its computer's identity, every WHO_AM_I_EVERY_MS (runner-start.ts): which computer and VM
 * its VMM says it's on. Another computer: a copy (a fork carries the runner on from the same memory),
 * which leaves. Another VM of its own (a wake, a restore, a move): its token was the old VM's, so a new
 * one is asked for now. Nothing goes through Orgo.
 */
export async function watchIdentity(): Promise<void> {
  const computer = runnerComputer();
  if (!onRunner() || !computer || !identityHere()) return;
  const me = await whoAmI().catch(() => null);
  if (!me) return;
  if (me.desktopId.toLowerCase() !== computer.toLowerCase()) return leaveCopy();
  const tokenVm = identityVmId();
  if (tokenVm && me.vmId && tokenVm !== me.vmId) {
    const { lookForRunnerKey } = await import("./orgo-auth");
    await lookForRunnerKey().catch(() => null);
  }
}

/** A copy of a runner's computer: its runner taken off (its program and the script that starts it: COPY_TAKES_OFF), then gone, saving nothing. Also when its VMM hands it another computer's identity (orgo-auth.ts). */
export function leaveCopy() {
  console.error("[runner] this computer is a copy of the one this runner was set up on: taking the runner off it");
  for (const f of box.copyFiles ?? COPY_TAKES_OFF) rmSync(f, { force: true });
  if (box.leave) return box.leave();
  try {
    spawn("supervisorctl", ["update"], { detached: true, stdio: "ignore" }).unref();
  } catch {}
  // Straight out: no last save, which would go up as the computer it was copied from.
  process.exit(1);
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

/**
 * On a runner: whether one of its own routines needs the routines timer now (due, or its next time not
 * set yet). Only then does it make sure of the state, of Orgo's word and of its computer (runnerReady):
 * a command on its computer counts as using it (orgo-web lib/bops-free-hours.ts), so an idle runner
 * that looked every tick would keep its computer from ever sleeping. Each tick it also notes which
 * routines aren't its own (handedOver).
 */
export function runnerHasWork(now = Date.now()): boolean {
  const seen = (box.seen ??= new Map());
  for (const [id, x] of seen) if (now - x.at >= HANDOVER_MS) seen.delete(id);
  for (const r of getState().routines) if (!runnerRoutine(r)) seen.set(r.id, { at: now });
  return getState().routines.some((r) => r.enabled && (r.nextRunAt === undefined || r.nextRunAt <= now) && runnerRoutine(r));
}

/**
 * Whether a routine just came to this Bops from another that may still run it, which hasn't heard yet:
 * on the Mac, one seen with a computer's runner under HANDOVER_MS ago (that runner being set up again
 * or failing, its bot moved to a computer with none, the routine set to run on the Mac), unless that
 * runner's stop is confirmed (it's out of the state); on a runner, one seen as not its own under
 * HANDOVER_MS ago (its bot moved here from another computer's runner). It waits that long here: the
 * other reads the state again well before.
 */
function handedOver(r: Routine, now: number): boolean {
  const x = box.seen?.get(r.id);
  return !!x && now - x.at < HANDOVER_MS && (!x.from || !!getState().runners?.[x.from]);
}

/** Whether a computer's runner that's up runs the routine (its bot works there, and it doesn't need the Mac): Orgo wakes that computer for it, and for no other (routine-sync.ts onMac). */
export function runnerRuns(r: Routine): boolean {
  const s = getState();
  const computer = computerOf(r);
  return !!computer && s.runners?.[computer]?.status === "running" && !pinnedToMac(r, s.bots.find((x) => x.id === r.botId));
}

/** How long past its time a routine of a runner that's up may be before the Mac looks whether that runner still runs (runner-install.ts). */
const OVERDUE_MS = 10 * 60_000;
/** Whether a routine computer `id`'s runner runs is that long past its time: a runner that runs advances it before it starts. */
export function overdueOn(id: string, now = Date.now()): boolean {
  return getState().routines.some((r) => r.enabled && r.nextRunAt !== undefined && now - r.nextRunAt > OVERDUE_MS && computerOf(r)?.toLowerCase() === id.toLowerCase() && runnerRuns(r));
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
 * Either way, one that just came from another Bops waits HANDOVER_MS first (handedOver).
 */
export function runsHere(r: Routine, now = Date.now()): boolean {
  const s = getState();
  const computer = computerOf(r);
  if (onRunner()) {
    const h = heard();
    return !!computer && runnerRoutine(r) && h?.runsOn === "cloud" && fresh(h.at, MODE_FRESH_MS, now) && s.runners?.[computer]?.status === "running" && !handedOver(r, now);
  }
  if (computer && !pinnedToMac(r, s.bots.find((x) => x.id === r.botId)) && runnerMayRun(s.runners?.[computer], now)) {
    (box.seen ??= new Map()).set(r.id, { at: now, from: computer });
    return false;
  }
  if (handedOver(r, now)) return false;
  box.seen?.delete(r.id);
  return true;
}

/** Tests: what Orgo said, as if it said it (`at` back in time to make it older), and forgetting it; which computer this is. */
export const runnerForTests = {
  sure: (at = Date.now()) => void (box.sureAt = at),
  /** A routine seen with a runner (on the Mac), or not as its own (on a runner), `ago` ms back; undefined: never. */
  seen: (routineId: string, ago?: number) => {
    const x = box.seen?.get(routineId);
    if (ago === undefined) box.seen?.delete(routineId);
    else (box.seen ??= new Map()).set(routineId, { ...x, at: Date.now() - ago });
  },
  identity: (o: { nonceDir?: string; copyFiles?: readonly string[]; leave?: () => void }) => Object.assign(box, o),
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
