/**
 * What each Bops plan includes, in the words the app and bops.bot show (keep site/index.html's
 * pricing in step: scripts/test-site.mjs checks it says the same words), and why a plan has no room
 * for one more phone number, email or computer. The numbers are BOPS_TIERS (cloud/protocol.ts),
 * which orgo-web and Bops Cloud hold each plan to:
 *
 * - Free: $5 of AI credit once, the one free Bops computer (10 hours a month, 4 cores, 16 GB,
 *   multi-screen), any number of bots sharing it; no phone number, no email.
 * - Pro, $20 a month: $20 of AI credit every month, the same one computer and as many bots on it,
 *   1 phone number and 1 email (the main bot's, set up with the plan); no more computers.
 * - Max, $200 a month: $200 of AI credit every month, up to 3 Bops computers, and up to 5 phone
 *   numbers and 5 emails (the main bot's with the plan, the others when the user asks).
 *
 * Shared by the server and the app (no server imports).
 */
import { BOPS_TIERS, type BopsTier } from "@/cloud/protocol";

/** One line on a plan's card: something it includes, or (`no`) something it doesn't. */
export type PlanLine = { text: string; no?: true };

/**
 * The Bops computers a plan includes, first on its card and set apart from its lines so nobody misses
 * how many: `title` the count ("1 computer included"), `detail` what each one is.
 */
export type PlanComputers = { title: string; detail: string };

export type PlanCard = { tier: BopsTier; name: string; price: string; per?: string; computers: PlanComputers; lines: PlanLine[] };

/** "1 computer included" on Free and Pro, "Up to 3 computers" on Max (one line on a card): BOPS_TIERS' count. */
const included = (tier: BopsTier) => {
  const n = BOPS_TIERS[tier].computers;
  return n === 1 ? "1 computer included" : `Up to ${n} computers`;
};

/** The three plans, as the account sheet and bops.bot list them. An Orgo plan is never one of these. */
export const PLAN_CARDS: PlanCard[] = [
  {
    tier: "free_bops",
    name: "Free",
    price: "$0",
    computers: { title: included("free_bops"), detail: "10 hours a month, 4 cores, 16 GB RAM, multi-screen" },
    lines: [
      { text: "$5 of AI credit, once" },
      { text: "As many bots as you like, sharing it" },
      { text: "No phone number or email", no: true },
    ],
  },
  {
    tier: "pro_bops",
    name: "Pro",
    price: "$20",
    per: "/month",
    computers: { title: included("pro_bops"), detail: "Always on, 4 cores, 16 GB RAM, templates, multi-screen" },
    lines: [
      { text: "$20 of AI credit every month" },
      { text: "As many bots as you like, sharing it" },
      { text: "1 phone number and 1 email" },
      { text: "No extra computers", no: true },
    ],
  },
  {
    tier: "max_bops",
    name: "Max",
    price: "$200",
    per: "/month",
    computers: { title: included("max_bops"), detail: "Always on, 4 cores, 16 GB RAM each" },
    lines: [
      { text: "$200 of AI credit every month" },
      { text: "As many bots as you like, on any of them" },
      { text: "Up to 5 phone numbers and 5 emails" },
    ],
  },
];

/**
 * Free's computer time, as Orgo counts it (orgo-web lib/bops-free-hours.ts, GET /api/bops/plan's
 * computer_time): seconds used this month, of how many, and when they start over (Unix ms).
 */
export type FreeHours = { usedSeconds: number; limitSeconds: number; resetsAt: number };

/** Seconds as hours: "2", "2.5", "10". */
const hoursOf = (seconds: number) => {
  const h = seconds / 3600;
  return h < 10 ? h.toFixed(1).replace(/\.0$/, "") : Math.round(h).toLocaleString("en-US");
};

/**
 * Whether Orgo counts Free's hours by the month: they start over on the 1st at 00:00 UTC (orgo-web
 * periodEndOf). The answer names no period, and an Orgo that still counts by the week starts them over
 * on a Monday, so then the words leave the period out instead of saying "a month".
 */
const byTheMonth = (resetsAt: number) => resetsAt % 86_400_000 === 0 && new Date(resetsAt).getUTCDate() === 1;

/**
 * The day Free's hours start over ("Nov 1"): the UTC day, the one Orgo's own words name, so the hours
 * are always back by the day it says (west of UTC they're back the evening before).
 */
const backOn = (resetsAt: number) => new Date(resetsAt).toLocaleDateString("en-US", { month: "short", day: "numeric", timeZone: "UTC" });

/** Free's computer has used its hours (this month's, when Orgo counts by the month), and when they're back. */
export const freeHoursOutLine = (t: FreeHours) =>
  `Your Bops computer has used its ${hoursOf(t.limitSeconds)} hours${byTheMonth(t.resetsAt) ? " this month" : ""}. It's back ${backOn(t.resetsAt)}, or upgrade to Pro to keep it on.`;

/**
 * Free's computer time in the account sheet's words: `amount` the figure ("2 of 10 hours used", rounded
 * down to a tenth, so it reads all used only once they are) with `label` under it, and `note` beside them:
 * what Free includes and when the hours start over, or, once they're used, when they're back. "A month"
 * and "this month" only when Orgo counts by the month (byTheMonth); otherwise no period at all.
 */
export function freeHoursWords(t: FreeHours): { note: string; amount: string; label: string } {
  const limit = hoursOf(t.limitSeconds);
  const monthly = byTheMonth(t.resetsAt);
  const sleeps = "sleeps when nothing's using it, so only the time it works counts.";
  return {
    note:
      t.usedSeconds >= t.limitSeconds
        ? freeHoursOutLine(t)
        : `${monthly ? `Free includes ${limit} hours a month on your Bops computer. It ${sleeps}` : `Your Bops computer ${sleeps}`} Your hours start over ${backOn(t.resetsAt)}.`,
    amount: `${hoursOf(Math.floor(Math.min(t.usedSeconds, t.limitSeconds) / 360) * 360)} of ${limit} hours used`,
    label: monthly ? "Computer time this month" : "Computer time",
  };
}

/**
 * Why there's no room for one more, and the plan that has room: "plan" (Free: Pro or Max both
 * would), "max" (Pro: only Max), or null (Max: nothing more to buy).
 */
export type PlanRoomShort = { text: string; upgrade: "plan" | "max" | null };

const MAX = BOPS_TIERS.max_bops;

/** The upgrade button for a short: "Purchase a plan" from Free, "Upgrade to Max" from Pro. */
export const upgradeLabel = (upgrade: "plan" | "max") => (upgrade === "plan" ? "Purchase a plan" : "Upgrade to Max");

/**
 * Whether `bot` may have one more phone number, with `held` numbers on the account now (the main
 * bot's from the plan included): null when it may. On Pro the one number is the main bot's, which the
 * plan sets up itself. The words are Bops Cloud's refusal's (cloud/plans.ts numberRefusal), exactly.
 */
export function numberShort(tier: BopsTier, held: number, bot: { isPlanBot: boolean }): PlanRoomShort | null {
  if (tier === "free_bops") return { text: `Free doesn't include a phone number. Pro includes ${BOPS_TIERS.pro_bops.phoneNumbers}, and Max up to ${MAX.phoneNumbers}.`, upgrade: "plan" };
  if (tier === "pro_bops") {
    if (bot.isPlanBot && held < BOPS_TIERS.pro_bops.phoneNumbers) return null;
    return { text: `Pro includes ${BOPS_TIERS.pro_bops.phoneNumbers} phone number. Max includes up to ${MAX.phoneNumbers}.`, upgrade: "max" };
  }
  return held < MAX.phoneNumbers ? null : { text: `Max includes up to ${MAX.phoneNumbers} phone numbers, and you have ${MAX.phoneNumbers}.`, upgrade: null };
}

/** The same for an email, in the same words: `held` is how many of the user's bots have an inbox. */
export function emailShort(tier: BopsTier, held: number, bot: { isPlanBot: boolean }): PlanRoomShort | null {
  if (tier === "free_bops") return { text: `Free doesn't include an email. Pro includes ${BOPS_TIERS.pro_bops.emails}, and Max up to ${MAX.emails}.`, upgrade: "plan" };
  if (tier === "pro_bops") {
    if (bot.isPlanBot) return null;
    return { text: `Pro includes ${BOPS_TIERS.pro_bops.emails} email. Max includes up to ${MAX.emails}.`, upgrade: "max" };
  }
  return held < MAX.emails ? null : { text: `Max includes up to ${MAX.emails} emails, and you have ${MAX.emails}.`, upgrade: null };
}

/**
 * The same for a Bops computer: `held` is how many the user has (the free one included) and `more`
 * how many a bot's own computer takes (2 when the free one isn't made yet: the main bot's comes first).
 * The words are orgo-web's create gate's refusal (BOPS_COMPUTER_LIMIT, lib/bops-max-computers.ts), exactly.
 */
export function computerShort(tier: BopsTier, held: number, more = 1): PlanRoomShort | null {
  const limit = BOPS_TIERS[tier].computers;
  if (held + more <= limit) return null;
  if (tier === "max_bops") return { text: `Max includes up to ${MAX.computers} Bops computers, and you have ${MAX.computers}.`, upgrade: null };
  return { text: `${BOPS_TIERS[tier].name} includes ${limit} Bops computer. Max includes up to ${MAX.computers}.`, upgrade: "max" };
}
