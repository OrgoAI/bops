/**
 * Billing by use, as orgo-web's GET /api/bops/plan says it: the one place the app reads that contract,
 * so lining it up with orgo-web's real answer is a change here only. Shared by the server and the app
 * (no server imports).
 *
 * orgo-web's answer, on top of the fields it has always had (tier, credit, computer_time…), flat and
 * camelCase (orgo-web lib/billing/bops-plan.ts BopsPlanView sends these; the snake_case spellings and
 * orgo-web's nested `usage` and `extension` objects are read too, so either shape lines up):
 *
 *   billing            "plan" | "usage"   missing: an orgo-web from before, which is "plan"
 *   balanceCents       the Orgo credit left, in cents (usage.balance_cents)
 *   computer           { size: "Large", hourlyCents: 11, asleepFree: true, creditCents }
 *                      (usage.computer.running_cents_per_hour; creditCents: what the computer may
 *                      spend, usage.computer_credit_cents: a plan's monthly allowance pays AI only)
 *   extensionEndsAt    when a user given a month more of their plan moves to billing by use
 *                      (ISO time or Unix seconds; extension.ends_at too). Only with billing "plan".
 *   numberMonthlyCents a phone number's month from Orgo credit (usage.phone_number_cents_per_month)
 *   topUpUrl           where to add Orgo credit (usage.add_credit.page); missing: Orgo's billing page
 *
 * Billing it doesn't know is no answer at all (null): never taken for Bops' Free plan. Numbers Orgo
 * leaves out fall back to BOPS_USAGE (cloud/protocol.ts), the same ones Bops Cloud holds a user to.
 */
import { BOPS_USAGE, isBilling, type BopsBilling } from "@/cloud/protocol";

export type { BopsBilling };

/** What a user billed by use pays, and has left. Money in cents, times in Unix ms. */
export type UsageTerms = {
  /** The Orgo credit left; missing when Orgo didn't say (then no balance is shown, never a made up one). */
  balanceCents?: number;
  /** creditCents: what the computer may spend (missing: the balance stands in for it). */
  computer: { size: string; hourlyCents: number; asleepFree: boolean; creditCents?: number };
  numberMonthlyCents: number;
  /** Where Add credit goes: Orgo's own top up, in the browser. */
  topUpUrl: string;
};

const num = (x: unknown) => (typeof x === "number" && Number.isFinite(x) ? x : undefined);
/** An ISO time or Unix seconds, as Unix ms. */
export const msOf = (t: unknown) => (typeof t === "number" && Number.isFinite(t) ? t * 1000 : typeof t === "string" && !Number.isNaN(Date.parse(t)) ? Date.parse(t) : undefined);
/** A field orgo-web may send in either case: balanceCents or balance_cents. */
const field = (a: Record<string, unknown>, camel: string) => a[camel] ?? a[camel.replace(/[A-Z]/g, (c) => `_${c.toLowerCase()}`)];
const obj = (x: unknown) => (x && typeof x === "object" && !Array.isArray(x) ? (x as Record<string, unknown>) : {});

/**
 * How orgo-web bills the user: "plan" when it doesn't say (an orgo-web from before), null when it says
 * something this app doesn't know (the answer is then not read at all).
 */
export function billingIn(a: Record<string, unknown>): BopsBilling | null {
  const b = a.billing;
  if (b === undefined || b === null) return "plan";
  return isBilling(b) ? b : null;
}

/** When a user's month more of their plan ends, from orgo-web's answer (flat, or its `extension` object). */
export const extensionEndIn = (a: Record<string, unknown>) => msOf(field(a, "extensionEndsAt") ?? obj(a.extension).ends_at);

/** Orgo's billing page, where credit is added: the fallback when orgo-web names no top up page. */
export const orgoTopUpPage = (origin: string) => `${origin.replace(/\/+$/, "")}/settings/billing`;

/** The terms of billing by use from orgo-web's answer, each number Orgo's own when it said it. */
export function usageTermsIn(a: Record<string, unknown>, origin: string): UsageTerms {
  // orgo-web's nested `usage` too: its own names, read where the flat ones are missing.
  const u = obj(a.usage);
  const uc = obj(u.computer);
  const c = obj(a.computer);
  const balance = num(field(a, "balanceCents")) ?? num(u.balance_cents);
  const hourly = num(field(c, "hourlyCents")) ?? num(uc.running_cents_per_hour);
  const credit = num(field(c, "creditCents")) ?? num(u.computer_credit_cents);
  const month = num(field(a, "numberMonthlyCents")) ?? num(u.phone_number_cents_per_month);
  const page = field(a, "topUpUrl") ?? obj(u.add_credit).page;
  return {
    ...(balance !== undefined ? { balanceCents: Math.round(balance) } : {}),
    computer: {
      size: typeof c.size === "string" && c.size ? c.size : "Large",
      hourlyCents: hourly !== undefined && hourly >= 0 ? hourly : BOPS_USAGE.computerHourlyCents,
      asleepFree: c.asleepFree === undefined && c.asleep_free === undefined ? true : (c.asleepFree ?? c.asleep_free) === true,
      ...(credit !== undefined ? { creditCents: Math.round(credit) } : {}),
    },
    numberMonthlyCents: month !== undefined && month >= 0 ? month : BOPS_USAGE.numberMonthlyCents,
    topUpUrl: typeof page === "string" && /^https:\/\//.test(page) ? page : orgoTopUpPage(origin),
  };
}

/** Cents as money: "$0.11", "$3", "$12.50". */
export const centsText = (cents: number) => {
  const d = Math.max(0, cents) / 100;
  return Number.isInteger(d) ? `$${d.toLocaleString("en-US")}` : `$${d.toFixed(2)}`;
};

/**
 * Whether the user's Orgo credit can wake their computer: Orgo wakes it only with enough for an hour
 * (its hourly funding check), from what the computer may spend (computer.creditCents, else the
 * balance). False only when Orgo said one and it's short; unknown is true.
 */
export const canWake = (u: Pick<UsageTerms, "balanceCents" | "computer">) => {
  const have = u.computer.creditCents ?? u.balanceCents;
  return have === undefined || have >= u.computer.hourlyCents;
};

/** Whether Orgo said the user has no Orgo credit left at all (unknown is not out). */
export const balanceOut = (u: Pick<UsageTerms, "balanceCents">) => u.balanceCents !== undefined && u.balanceCents <= 0;

/** The day a month more of a plan ends, as people say it: "Dec 3". */
export const dayText = (ms: number) => new Date(ms).toLocaleDateString("en-US", { month: "short", day: "numeric" });

/** What a user given a month more of their plan is told, with the day it ends. */
export const extensionLine = (endsAt: number) => `Your current plan stays as it is until ${dayText(endsAt)}, then you pay only for what you use.`;

/** What a computer that can't wake for want of Orgo credit says (its asleep screen, a task that couldn't start). */
export const OUT_OF_CREDIT_WAKE = "Your Bops computer is asleep because your Orgo credit ran out. Add credit on Orgo to wake it.";

/**
 * Orgo's codes when a wake or a start is turned down for want of credit (orgo-web: lib/billing
 * compute-live.ts INSUFFICIENT_COMPUTE_CREDIT, the wake gate's upgrade_required, the ledger's
 * insufficient_credit, and bops_out_of_credit, the one asked of it for Bops' computers).
 */
const OUT_OF_CREDIT_CODE_SET = new Set(["bops_out_of_credit", "insufficient_compute_credit", "insufficient_credit", "upgrade_required"]);
/** Whether `code` is one of those, in any case (orgo-web has sent BOPS_OUT_OF_CREDIT and INSUFFICIENT_COMPUTE_CREDIT). */
export const isOutOfCreditCode = (code: unknown) => typeof code === "string" && OUT_OF_CREDIT_CODE_SET.has(code.toLowerCase());
/** Whether `code` is the one asked of orgo-web for Bops' computers, in any case. */
export const isBopsOutOfCreditCode = (code: unknown) => typeof code === "string" && code.toLowerCase() === "bops_out_of_credit";
