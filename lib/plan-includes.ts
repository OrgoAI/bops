/**
 * What Bops costs, in the words the app and bops.bot show, and why there's no room for one more phone
 * number, email or computer. Two ways (cloud/protocol.ts BopsBilling):
 *
 * Billing by use (USAGE_CARD; bops.bot's pricing changes to the same words at the switch date, not
 * before, so the site never advertises it while Pro and Max are still sold): no plan. The user pays for what they use from their Orgo credit, the
 * Bops computer (Medium or Large, from Medium's price) by the hour while it works and nothing while it
 * sleeps, AI at Orgo's rate; a new Orgo account starts with Orgo's $5 of credit.
 * The numbers are BOPS_USAGE's, which Bops Cloud holds them to (orgo-web's own answer wins in the
 * app: lib/bops-billing.ts).
 *
 * Bops' own plans (PLAN_CARDS), which the app shows only while orgo-web still bills by them (its
 * BOPS_USAGE_BILLING off). The numbers are BOPS_TIERS, which orgo-web and Bops Cloud hold each plan to:
 *
 * - Free: $5 of AI credit once, the one free Bops computer (10 hours a month, 4 cores, 16 GB,
 *   multi-screen), any number of bots sharing it; no phone number, no email.
 * - Pro, $20 a month: $20 of AI credit every month, the same one computer and as many bots on it,
 *   1 phone number and 1 email (the main bot's, set up with the plan); no more computers.
 * - Max, $200 a month: $200 of AI credit every month, up to 3 Bops computers, and up to 5 phone
 *   numbers and 5 emails (the main bot's with the plan, the others when the user asks).
 * - People who can see the bots' computers on Orgo (the People sheet): none on Free, 2 on Pro, up to
 *   5 on Max.
 *
 * Shared by the server and the app (no server imports).
 */
import { BOPS_TIERS, BOPS_USAGE, type BopsTier } from "@/cloud/protocol";
import { rateText } from "@/lib/bops-billing";

/** Where the plan's limits stand: one of Bops' plans, or billing by use ("usage"). */
export type RoomTier = BopsTier | "usage";

/** Cents as money: "$0.11", "$3", "$5". */
const cents = (c: number) => (c % 100 === 0 ? `$${c / 100}` : `$${(c / 100).toFixed(2)}`);

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

/**
 * Billing by use, as the account sheet and bops.bot say it: one card, no plan to pick. The computer is
 * Medium or Large, so it costs from the smaller one's price: `fromHourlyCents`, orgo-web's when it listed
 * the sizes (the app's), else BOPS_USAGE's (bops.bot's). `hourlyCents` instead: an orgo-web that makes
 * every Bops computer Large (before sizes), whose one price that is. `numberCents` is orgo-web's when it
 * said it, else BOPS_USAGE's.
 */
export function usageCard(p: { fromHourlyCents?: number; hourlyCents?: number; numberCents?: number } = {}) {
  const one = p.fromHourlyCents === undefined && p.hourlyCents !== undefined;
  const hourly = one ? cents(p.hourlyCents!) : `from ${rateText(p.fromHourlyCents ?? BOPS_USAGE.computerFromHourlyCents)}`;
  const number = cents(p.numberCents ?? BOPS_USAGE.numberMonthlyCents);
  return {
    name: "Pay only for what you use",
    price: "$0",
    per: "/month",
    computers: {
      title: "Your own Bops computer",
      detail: one ? "4 cores, 16 GB RAM, 80 GB, multi-screen. It sleeps when nothing's using it." : "Medium or Large, 80 GB, multi-screen. It sleeps when nothing's using it.",
    },
    lines: [
      { text: `Your computer: ${hourly} an hour while it works, free while it sleeps` },
      { text: "AI at Orgo's rate" },
      { text: `New Orgo accounts start with $${BOPS_USAGE.startCents / 100} of credit` },
      { text: "As many bots as you like, sharing it" },
      { text: "1 email for your main bot, free" },
      { text: `A phone number for ${number} a month` },
    ],
  } satisfies Omit<PlanCard, "tier">;
}

/** The card bops.bot shows, at BOPS_USAGE's prices. */
export const USAGE_CARD = usageCard();

/** The three plans, as the account sheet listed them before billing by use. An Orgo plan is never one of these. */
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
      { text: "No sharing with other people", no: true },
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
      { text: `Share your bots' computers with ${BOPS_TIERS.pro_bops.people} people` },
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
      { text: `Share your bots' computers with up to ${BOPS_TIERS.max_bops.people} people` },
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

/** Billing by use's limits on numbers and emails: nothing to upgrade to, so no button. */
const USAGE_NUMBERS_FULL = `You have ${BOPS_USAGE.phoneNumbers} phone numbers, the most one account can have for now.`;
const USAGE_EMAIL = "Bops includes 1 email, for your main bot.";

/**
 * Whether `bot` may have one more phone number, with `held` numbers on the account now (the main
 * bot's from the plan included): null when it may. On Pro the one number is the main bot's, which the
 * plan sets up itself. Billed by use, any bot may, up to BOPS_USAGE's, each paid from Orgo credit. The
 * words are Bops Cloud's refusal's (cloud/plans.ts numberRefusal), exactly.
 */
export function numberShort(tier: RoomTier, held: number, bot: { isPlanBot: boolean }): PlanRoomShort | null {
  if (tier === "usage") return held < BOPS_USAGE.phoneNumbers ? null : { text: USAGE_NUMBERS_FULL, upgrade: null };
  if (tier === "free_bops") return { text: `Free doesn't include a phone number. Pro includes ${BOPS_TIERS.pro_bops.phoneNumbers}, and Max up to ${MAX.phoneNumbers}.`, upgrade: "plan" };
  if (tier === "pro_bops") {
    if (bot.isPlanBot && held < BOPS_TIERS.pro_bops.phoneNumbers) return null;
    return { text: `Pro includes ${BOPS_TIERS.pro_bops.phoneNumbers} phone number. Max includes up to ${MAX.phoneNumbers}.`, upgrade: "max" };
  }
  return held < MAX.phoneNumbers ? null : { text: `Max includes up to ${MAX.phoneNumbers} phone numbers, and you have ${MAX.phoneNumbers}.`, upgrade: null };
}

/**
 * The same for an email, in the same words: `held` is how many of the user's bots have an inbox. Billed
 * by use, the main bot's is free (Bops Cloud sets it up) and is the one; a bot that has one keeps it.
 */
export function emailShort(tier: RoomTier, held: number, bot: { isPlanBot: boolean }): PlanRoomShort | null {
  if (tier === "usage") return bot.isPlanBot ? null : { text: USAGE_EMAIL, upgrade: null };
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

/* ---------------- People ---------------- */

/**
 * Where the user's plan stands on people who can see their bots' computers (lib/members.ts
 * MemberSeats): the plan, how many people it includes besides the user (null: no limit), how many
 * have access or an invite still waiting, and how many Pro and Max include.
 */
export type PeopleRoom = { plan: RoomTier; limit: number | null; used: number; caps: { pro_bops: number; max_bops: number } };

/** What Pro and Max include, from BOPS_TIERS: named in the People sheet only when orgo-web's seats leave their caps out. */
export const PEOPLE_CAPS = { pro_bops: BOPS_TIERS.pro_bops.people, max_bops: BOPS_TIERS.max_bops.people } as const;

/** "1 person", "2 people". */
export const peopleCount = (n: number) => `${n} ${n === 1 ? "person" : "people"}`;

/** The counter beside Add someone ("1 of 2 people"); null when there's no limit. */
export const peopleAside = (s: PeopleRoom) => (s.limit === null ? null : `${s.used} of ${s.limit === 1 ? "1 person" : `${s.limit} people`}`);

/**
 * Why the user can't add someone now, in the People sheet's words, and the plan that has room: null when
 * they can. `withAccess`: the people who have access now (not invites); `invited`: invites still waiting.
 * People over a limit keep their access (a plan changed after they joined): the words say so, and that
 * adding someone needs room first. `note`: a second line, when cancelling an invite would make room.
 * The numbers are orgo-web's (it holds the workspace to them), never the plan's name: Free includes
 * people too now (5 for everyone, for now), so only a limit of 0 says Free adds nobody.
 */
export function peopleShort(s: PeopleRoom, { withAccess, invited }: { withAccess: number; invited: number }): (PlanRoomShort & { note?: string }) | null {
  const max = s.caps.max_bops;
  // Billed by use, the people come with the Orgo plan (orgo-web's numbers): more is Orgo's to sell, not the app's.
  if (s.plan === "usage") {
    if (s.limit === null || s.used < s.limit) return null;
    const keep = s.used > s.limit ? ` The ${peopleCount(s.used)} with access keep it.` : "";
    return { text: `Your Orgo plan includes ${s.limit === 0 ? "no one else" : peopleCount(s.limit)}.${keep} Upgrade your Orgo plan on orgo.ai to add more.`, upgrade: null };
  }
  if (s.limit === 0) {
    const keep = withAccess === 1 ? "The 1 person who has access keeps it." : `The ${withAccess} people who have access keep it.`;
    return { text: `Free doesn't include adding people. ${withAccess > 0 ? keep : `Pro includes ${s.caps.pro_bops}, and Max up to ${max}.`}`, upgrade: "plan" };
  }
  if (s.limit === null || s.used < s.limit) return null;
  const over = s.used > s.limit;
  if (s.plan === "pro_bops")
    return over
      ? { text: `Pro includes ${peopleCount(s.limit)}, and you have ${s.used} from before. They keep access, but to add someone, upgrade to Max or remove people.`, upgrade: "max" }
      : { text: `Pro includes ${peopleCount(s.limit)}, and you have ${s.used}. Max includes up to ${max}.`, upgrade: "max", ...(invited ? { note: "Or cancel an invite below to make room." } : {}) };
  // Max, or Free with people included: no plan to buy for more, so make room instead.
  const includes = s.plan === "max_bops" ? `Max includes up to ${peopleCount(s.limit)}` : `Bops includes ${peopleCount(s.limit)}`;
  return over
    ? { text: `${includes}, and you have ${s.used} from before. They keep access, but to add someone, remove people first.`, upgrade: null }
    : { text: `${includes}, and you have ${s.used}. ${invited ? "Remove someone or cancel an invite" : "Remove someone"} to add someone else.`, upgrade: null };
}
