import "server-only";
import { isOutOfCreditCode, type ComputerSize, type SizeOffer, type UsageTerms } from "@/lib/bops-billing";
import { SIZE_REFUSED, type SizeView } from "@/lib/computer-size";
import { workBot } from "@/lib/types";
import { billedByUse } from "./cloud";
import { computerWakingError, orgo, OrgoError, wakeWaitMs } from "./orgo";
import { loadOrgoKey } from "./orgo-auth";
import { forgetPlan, orgoPlan, readBopsPlan, sizeSwitch } from "./plan";
import { getState, update } from "./store";
import { turnsRunning } from "./turn-context";

/**
 * Billed by use, the size of the user's free Bops computer: Medium or Large, as Orgo's plan read lists them
 * with their prices (lib/bops-billing.ts). Pick your computer asks once per account (sizeView's `needed`),
 * and Settings switches it any time after (switchSize). A user on Bops' plans, or an orgo-web that lists no
 * sizes, is never asked and never switches: their computer stays the size Orgo makes it.
 *
 * Orgo bills the computer at its new size from the moment it changes, and keeps its disk. A switch is made
 * while the computer runs, so one asleep is woken first (unless Orgo switches it asleep); one whose memory
 * wouldn't fit the smaller size (409 RAM_IN_USE) is restarted, then switched, once, and never while a bot is
 * working on it.
 */

/** How often a switch looks whether the computer it woke or restarted is running (mutable for the tests). */
export const sizeWait = { pollMs: 3000 };

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

/** Orgo's plan read for billing by use: its terms, or null when it can't be read or the user isn't billed by use. */
async function usageNow(): Promise<UsageTerms | null> {
  const key = await loadOrgoKey();
  if (!key) return null;
  return (await readBopsPlan(key).catch(() => null))?.usage ?? null;
}

/** The free Bops computer's id: the plan read's, else Orgo's compute limits' (an orgo-web whose plan read names none). */
async function computerIdOf(u: UsageTerms): Promise<string | null> {
  if (u.computer.id !== undefined) return u.computer.id;
  return (await orgoPlan({ fresh: true }).catch(() => null))?.freeComputerId ?? null;
}

/**
 * What Pick your computer and Settings need: the sizes on offer, the computer's own, which to pick first,
 * how it's switched, and whether the card is to be shown. `needed` only for a user billed by use whose
 * account hasn't answered it, and only when Orgo lists more than one size: anything unknown shows nothing.
 * `phaseOnly` answers only how far a switch has got, without asking Orgo.
 */
export async function sizeView({ phaseOnly = false } = {}): Promise<SizeView> {
  const none: SizeView = { needed: false, sizes: [], current: null, preselect: null, change: null, ...(sizeSwitch.phase ? { switching: sizeSwitch.phase } : {}) };
  if (phaseOnly || !billedByUse()) return none;
  const u = await usageNow();
  const sizes = u?.sizes ?? [];
  if (!u || sizes.length < 2) return none;
  const st = getState();
  const id = await computerIdOf(u);
  const current = id ? (u.computer.key ?? null) : null;
  const preselect = [current, st.computerSize, u.defaultSize].find((k): k is ComputerSize => !!k && sizes.some((s) => s.key === k)) ?? sizes[0].key;
  return { ...none, needed: !st.computerSizeChosenAt, sizes, current, preselect, change: u.computer.change ?? (id ? "bops" : null) };
}

/** A switch's answer: done (`changed` false when there was nothing to change), or why not, in the app's words. */
export type SizeResult = { ok: true; size: ComputerSize; changed: boolean } | { ok: false; status: number; error: string; code?: string; topUpUrl?: string };

const refused = (status: number, error: string, more: { code?: string; topUpUrl?: string } = {}): SizeResult => ({ ok: false, status, error, ...more });

/** The size the user has now: kept in the state, answered on this account (Pick your computer asks no more). */
function keep(size: ComputerSize) {
  update((st) => {
    st.computerSize = size;
    st.computerSizeChosenAt = Date.now();
  });
}

/** Whether a task of the user's is working on the computer right now (a restart would stop it). */
function botsWorkingOn(computerId: string) {
  const st = getState();
  if (turnsRunning()) return true;
  return st.sessions.some((s) => {
    if (s.runsOn === "mac" || (s.status !== "starting" && s.status !== "running")) return false;
    const b = st.bots.find((x) => x.id === s.botId);
    return !!b && workBot(b, st.bots).computerId === computerId;
  });
}

/** Up to wakeWaitMs for the computer to run again (after a wake or a restart); whether it did. */
async function untilRunning(computerId: string) {
  const until = Date.now() + wakeWaitMs();
  for (;;) {
    const c = await orgo.computer(computerId).catch(() => null);
    if (c?.status === "running") return true;
    if (Date.now() >= until) return false;
    await sleep(sizeWait.pollMs);
  }
}

/** Wake the computer for a switch: null once it runs, else why not (Orgo's want of credit in the app's words). */
async function wake(computerId: string): Promise<SizeResult | null> {
  sizeSwitch.phase = "waking";
  try {
    await orgo.resume(computerId);
  } catch (e) {
    const notAsleep = e instanceof OrgoError && e.status === 409 && /not suspended/i.test(e.said ?? "");
    if (e instanceof OrgoError && e.status === 402) return refused(402, isOutOfCreditCode(e.code) ? SIZE_REFUSED.wakeCredit : (e.said ?? SIZE_REFUSED.wakeCredit), { code: e.code });
    if (!notAsleep && !computerWakingError(e)) return refused(502, SIZE_REFUSED.failed);
  }
  return (await untilRunning(computerId)) ? null : refused(504, SIZE_REFUSED.failed);
}

/** Orgo's code on a refusal, in lower case ("computer_not_running"). */
const codeOf = (e: unknown) => (e instanceof OrgoError ? (e.code ?? "").toLowerCase() : "");

/**
 * One try at the switch through Orgo, with what Orgo says in the way dealt with once each: asleep, it's
 * woken and asked again; its memory too full for the smaller size, it's restarted (unless a bot is working
 * on it) and asked again; part of the Orgo plan after all, Orgo's own resize is asked.
 */
async function trySwitch(id: string, offer: SizeOffer, change: "bops" | "plan", u: UsageTerms, again = { woke: false, restarted: false, plan: false }): Promise<SizeResult> {
  sizeSwitch.phase = "switching";
  try {
    await orgo.setSize(id, offer.key, change);
    return { ok: true, size: offer.key, changed: true };
  } catch (e) {
    const code = codeOf(e);
    const status = e instanceof OrgoError ? e.status : 0;
    if (code === "computer_not_running" && !again.woke) {
      const no = await wake(id);
      return no ?? trySwitch(id, offer, change, u, { ...again, woke: true });
    }
    if (code === "ram_in_use" && !again.restarted) {
      if (botsWorkingOn(id)) return refused(409, SIZE_REFUSED.working, { code: "bots_working" });
      sizeSwitch.phase = "restarting";
      try {
        await orgo.restart(id);
      } catch {
        return refused(502, SIZE_REFUSED.failed);
      }
      if (!(await untilRunning(id))) return refused(504, SIZE_REFUSED.failed);
      return trySwitch(id, offer, change, u, { ...again, restarted: true });
    }
    // Gone since the plan read: the next one is made at this size.
    if (code === "bops_no_computer") return { ok: true, size: offer.key, changed: false };
    if (code === "bops_size_on_plan" && !again.plan) return trySwitch(id, offer, "plan", u, { ...again, plan: true });
    if (status === 402) return refused(402, isOutOfCreditCode(code) ? SIZE_REFUSED.credit(offer) : (e instanceof OrgoError && e.said) || SIZE_REFUSED.credit(offer), { code, topUpUrl: u.topUpUrl });
    if (code === "bops_size_pending") return refused(409, SIZE_REFUSED.pending, { code });
    if (code === "bops_size_unavailable") return refused(409, SIZE_REFUSED.keeps, { code });
    // The plan's own refusals (its memory, its size per computer) are the plan's words.
    if (change === "plan" && e instanceof OrgoError && status >= 400 && status < 500 && status !== 404 && status !== 429 && e.said) return refused(409, e.said, { code });
    console.warn(`[size] Orgo didn't switch the computer to ${offer.key}: ${status || "no answer"}${code ? ` (${code})` : ""}`);
    return refused(502, SIZE_REFUSED.failed, code ? { code } : {});
  }
}

/**
 * Switch the user's free Bops computer to `size`, or with none yet, keep it as the size one is made at.
 * Either way the account has answered Pick your computer. Done, the plan is read again and the live views
 * stream it afresh (WebRTC needs Large's 4 cores). One switch at a time.
 */
export async function switchSize(size: ComputerSize): Promise<SizeResult> {
  if (sizeSwitch.phase) return refused(409, SIZE_REFUSED.busy, { code: "size_switching" });
  if (!billedByUse()) return refused(409, SIZE_REFUSED.keeps, { code: "bops_size_unavailable" });
  sizeSwitch.phase = "switching";
  try {
    const u = await usageNow();
    if (!u) return refused(502, SIZE_REFUSED.failed);
    const offer = u.sizes?.find((s) => s.key === size);
    if (!offer) return refused(400, SIZE_REFUSED.failed, { code: "size_not_offered" });
    const id = await computerIdOf(u);
    // None yet: made at this size (plan.ts makeFree). Already that size: nothing to change.
    if (!id || u.computer.key === size) {
      keep(size);
      return { ok: true, size, changed: false };
    }
    const change = u.computer.change === undefined ? "bops" : u.computer.change;
    if (!change) return refused(409, SIZE_REFUSED.pending, { code: "bops_size_pending" });
    const done = await trySwitch(id, offer, change, u);
    if (done.ok) {
      keep(size);
      orgo.forgetStream(id);
      forgetPlan();
    }
    return done;
  } finally {
    sizeSwitch.phase = undefined;
  }
}
