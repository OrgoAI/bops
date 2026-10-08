import "server-only";
import { MAIN_WORKSPACE, workspaceOf, type Bot } from "@/lib/types";
import { cloudOn, cloudSessionNow } from "./cloud";
import { getState } from "./store";

/**
 * What the user's Bops plan holds now, for the plan's limits on phone numbers and emails
 * (lib/plan-includes.ts): the plan as Bops Cloud said it at the session, and how many numbers and
 * inboxes the user's bots have. Null where Bops Cloud doesn't hold plans to what they include
 * (self-hosted, BOPS_PLAN_LIMITS off, or an older cloud): then numbers and emails are as before.
 */
export function planRoom() {
  const plan = cloudOn() ? cloudSessionNow()?.plan : undefined;
  if (!plan?.limits) return null;
  return { tier: plan.tier, numbers: numbersHeld(), emails: emailsHeld(plan.tier !== "free_bops") };
}

/** The bot a paid plan brings a number and an inbox to: the default workspace's main bot. */
export const isPlanBot = (b: Pick<Bot, "isMain" | "workspaceId">) => !!b.isMain && workspaceOf(b) === MAIN_WORKSPACE;

/** A number's last 10 digits, as Bops Cloud keeps lines (cloud/lines.ts lineDigits), else the number as it is. */
const digitsOf = (n: string) => /^\+?1?(\d{10})$/.exec(n.replace(/[^\d+]/g, ""))?.[1] ?? n;

/** The user's numbers: every bot's and every workspace's, each counted once (Bops Cloud counts the same lines). */
export function numbersHeld() {
  const s = getState();
  const all = [...s.bots.map((b) => b.phone), ...(s.workspaces ?? []).map((w) => w.line?.phone)];
  return new Set(all.flatMap((n) => (n ? [digitsOf(n)] : []))).size;
}

/**
 * The user's inboxes: every bot that has one, and the plan's main bot's whether or not it has it yet
 * (`paid`: Bops Cloud is making it, and it's one of the plan's).
 */
export function emailsHeld(paid: boolean) {
  return getState().bots.filter((b) => b.mail || (paid && isPlanBot(b))).length;
}
