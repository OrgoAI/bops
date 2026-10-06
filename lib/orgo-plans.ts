/**
 * Orgo's plans, as Bops shows them. A Bops user is an Orgo user. Every user has one free Bops computer
 * (the main bot's, made by Bops from the Bops template, off their Orgo plan, whatever the plan); any
 * more come out of their Orgo plan: Hacker includes 1 computer, Startup 4, Scale 16, and Free none.
 * Bops' own plans (Free, Pro, Max: BOPS_TIERS in cloud/protocol.ts) are only AI credit, and give
 * nothing on Orgo. Shared by the server (lib/server/plan.ts reads the user's plan from Orgo) and the
 * app, so both say the same thing in the same words.
 */
import { workBot, workspaceOf, type Bot } from "./types";

/** The user's plan, as Orgo answered it (lib/server/plan.ts). */
export type OrgoPlan = {
  /** Orgo's key for it: hacker_v2, startup_v2 or scale_v2 today, free, or an older one (hacker, team…). Unknown when Orgo didn't say. */
  tier?: string;
  /** Orgo's own name for it. Older plans keep theirs, some the same as today's: an older Hacker allows 5 computers. */
  name?: string;
  /** The computers it allows: Orgo's own count (computers bought on top and a custom deal included), else the plan's. */
  computers: number;
  /** Computers in use across the whole Orgo account, as Orgo counts them against the plan. Unknown when Orgo didn't say. */
  inUse?: number;
  /**
   * The plan's memory in GB, as Orgo counts it for a new computer: all of it (memory bought on top
   * included), what the account's computers use, and the most one new computer can have now (the
   * plan's limit for one computer, or what's left, if less). Unknown when Orgo didn't say.
   */
  memory?: { total: number; used: number; newMax: number };
  /** A custom deal with Orgo sets the plan's computers or memory: moving up a plan Orgo sells doesn't change them. */
  deal?: boolean;
  /**
   * The user's one free Bops computer (orgo-web's bops_free, not counted in `inUse`): its id, or null
   * while there's none (Bops makes it next, for a main bot). Unknown when Orgo didn't say (an Orgo
   * from before free Bops computers): then every computer is on the plan, as before.
   */
  freeComputerId?: string | null;
};

/** The free Bops computer's memory in GB: the Bops template's, which it's made at whatever the plan. */
export const FREE_COMPUTER_RAM = 16;

/** Bops makes the free computer next: Orgo offers free Bops computers, and the user's isn't made yet. */
export const freeComputerOpen = (plan: OrgoPlan | null | undefined) => plan?.freeComputerId === null;

/** Every plan key Orgo has, with Orgo's name for it and the computers it allows (orgo-web lib/subscription-tiers.ts). */
const TIERS: Record<string, { name: string; computers: number }> = {
  free: { name: "Free", computers: 0 },
  hacker_v2: { name: "Hacker", computers: 1 },
  startup_v2: { name: "Startup", computers: 4 },
  scale_v2: { name: "Scale", computers: 16 },
  // Older plans, kept by the people on them. Orgo no longer sells them.
  hacker: { name: "Hacker", computers: 5 },
  developer: { name: "Developer", computers: 5 },
  team: { name: "Team", computers: 10 },
  startup: { name: "Startup", computers: 25 },
  scale: { name: "Scale", computers: 25 },
  max: { name: "Max", computers: 25 },
  // A custom deal usually sets its own count, which Orgo's count already has.
  enterprise: { name: "Enterprise", computers: 1000 },
};

/** The plans Orgo sells today, smallest first. */
const SOLD_PLANS = [
  { name: "Hacker", computers: 1 },
  { name: "Startup", computers: 4 },
  { name: "Scale", computers: 16 },
];

/** Orgo's name for a plan key. A key Bops doesn't know shows as itself. */
export const planName = (tier: string) => TIERS[tier.toLowerCase()]?.name ?? tier.charAt(0).toUpperCase() + tier.slice(1).replace(/_v\d+$/, "");

/** The computers a plan key allows, when Bops knows the key. */
export const planComputers = (tier: string): number | undefined => TIERS[tier.toLowerCase()]?.computers;

/**
 * Why the plan can't take another computer: it includes none ("none"), they're all in use ("count"),
 * one computer can't be that big ("size"), the plan's memory is used up ("memory"), or one computer
 * can't have that much disk ("disk"). Bops sees all but the last in the plan's numbers; that one only
 * when Orgo turns a computer down (planRefusal in lib/server/plan.ts).
 */
export type PlanShort = "none" | "count" | "size" | "memory" | "disk";

/** Memory sizes Orgo makes computers in, in GB, largest first: from the Bops template's 16 down (orgo-web lib/computer-sizes.ts). */
const RAM_SIZES = [16, 8, 4];

/**
 * The memory Bops makes the main bot's computer with, in GB: the plan's memory split evenly across the
 * computers it includes, in one of Orgo's sizes. That's 8 GB on Hacker, Startup and Scale, and every
 * copy of it is as big, so the plan runs out of computers before memory: Startup fits 4 (of the
 * template's 16 GB it would fit 2). Less when a new computer can't have that much now (the plan's
 * memory is nearly used up, or a deal allows less per computer), and 0 when it can't have even the
 * smallest. Undefined leaves the size to Orgo, which fits the template's to the plan: when Orgo didn't
 * say, or when the split is below the smallest size (Enterprise's thousand computers), where memory
 * runs out first whatever the size.
 */
export function computerRam(plan: OrgoPlan | null | undefined): number | undefined {
  if (!plan?.memory || plan.computers <= 0) return undefined;
  const { total, newMax } = plan.memory;
  const each = RAM_SIZES.find((gb) => gb <= total / plan.computers);
  if (each === undefined) return undefined;
  return RAM_SIZES.find((gb) => gb <= Math.min(each, newMax)) ?? 0;
}

/**
 * What keeps the plan from taking `more` computers now, by its numbers: null when nothing does. `ram`
 * is the memory each of them needs in GB, when known (0: none of Orgo's sizes fits): then the plan's
 * memory left must hold them all, and one computer must be allowed that much. Undefined when Orgo
 * didn't say what's in use: then nothing here stands in the way, and Orgo decides when the computer is
 * made.
 */
export function planShort(plan: OrgoPlan | null | undefined, more = 1, ram?: number): Exclude<PlanShort, "disk"> | null | undefined {
  if (plan?.inUse === undefined) return undefined;
  if (plan.computers <= 0) return "none";
  if (plan.inUse + more > plan.computers) return "count";
  const m = plan.memory;
  if (!m || ram === undefined) return null;
  const left = m.total - m.used;
  // The plan's memory has room, but one computer may have less than that (a deal's limit per computer).
  if (ram > 0 && ram > m.newMax && m.newMax < left) return "size";
  return ram > 0 && ram <= m.newMax && ram * more <= left ? null : "memory";
}

/**
 * Computers the user's bots have on their Orgo plan, each counted once: the free Bops computer isn't
 * (Orgo doesn't count it in use either). The rest of those in use are elsewhere in their Orgo account.
 */
export const bopsComputers = (bots: Pick<Bot, "computerId" | "freeComputer">[]) => new Set(bots.flatMap((b) => (b.computerId && !b.freeComputer ? [b.computerId] : []))).size;

/**
 * The smallest plan Orgo sells with more computers than this one (more memory comes with them). None
 * for Enterprise or a custom deal: the deal sets the computers and memory, whatever the plan.
 */
export const planUp = (plan: OrgoPlan | null | undefined) =>
  plan?.deal || plan?.tier?.toLowerCase() === "enterprise" ? undefined : SOLD_PLANS.find((p) => p.computers > (plan?.computers ?? 0));

/** The plan that fixes it, if moving up one does: not for a computer too big or with too much disk, nor for a plan Orgo didn't name. */
const upFor = (short: PlanShort, plan: OrgoPlan | null | undefined) => (short === "size" || short === "disk" || (!plan && short !== "none") ? undefined : planUp(plan));

/**
 * Why, in plain words with the numbers, and the plan that has room: "Your Orgo Hacker plan includes 1
 * computer, and it's in use. Orgo Startup includes 4." `bops` is how many computers the bots have (the rest
 * in use are outside Bops). `main` is the main bot's name: every other computer is a copy of its
 * computer, so a bot can't have its own until the main bot has one.
 */
export function planShortText(short: PlanShort, plan: OrgoPlan | null | undefined, opts: { bops?: number; main?: string } = {}) {
  // Always "Orgo" by name: an Orgo plan is never the user's Bops plan (Free, Pro or Max).
  const name = plan?.name ? `Orgo ${plan.name}` : "Orgo";
  const main = opts.main ?? "the main bot";
  const up = upFor(short, plan);
  // A custom deal is changed by asking Orgo, not on its own.
  const ask = plan?.deal ? "ask Orgo to change your plan" : undefined;
  // With the free Bops computer, "none" is about any more than that one.
  if (short === "none")
    return `Your ${name} plan doesn't include ${plan?.freeComputerId !== undefined ? "computers besides your free Bops one" : "cloud computers"}.${up ? ` Orgo ${up.name} includes ${up.computers}.` : ""}`;
  if (short === "memory") return `Your ${name} plan doesn't have the memory left for another computer.${up ? ` Orgo ${up.name} has more.` : ` Delete a computer, or ${ask ?? "add memory on Orgo"}.`}`;
  // Only a copy can be too big: the main bot's computer is made to fit the plan (computerRam). Not its disk, though.
  if (short === "size") return `Your ${name} plan doesn't allow another computer as big as ${main}'s.`;
  if (short === "disk") return `Your ${name} plan doesn't allow a computer with as much disk as ${main}'s.`;
  const then = up ? ` Orgo ${up.name} includes ${up.computers}.` : ` Delete one, or ${ask ?? "add computers on Orgo"}.`;
  if (!plan || plan.inUse === undefined) return `Every computer your ${name} plan includes is in use.${then}`;
  const n = plan.computers;
  const u = plan.inUse;
  const outside = opts.bops === undefined ? 0 : Math.max(0, u - opts.bops);
  const where = !outside ? "" : outside >= u ? " outside Bops" : `, ${outside} of them outside Bops`;
  const all = n === 1 ? "it's" : n === 2 ? "both are" : `all ${n} are`;
  const used =
    u === n
      ? `${all} in use${where}`
      : u > n
        ? `${u} are in use${where}`
        : // Room for one more, which the main bot's computer needs first.
          `${u ? `${u} ${u === 1 ? "is" : "are"} in use${where}, so ` : ""}${main}'s computer needs ${u ? "the last one" : "it"}`;
  return `Your ${name} plan includes ${n} computer${n === 1 ? "" : "s"}, and ${used}.${then}`;
}

/**
 * Where to fix it on Orgo's account page: its Plan tab to move up a plan, or its Usage tab to add to
 * this one (or, on a custom deal, to see what it allows).
 */
export function planFix(short: PlanShort, plan: OrgoPlan | null | undefined): { label: string; tab: "plan" | "usage" } {
  const up = upFor(short, plan);
  if (up) return { label: `Upgrade to Orgo ${up.name}`, tab: "plan" };
  if (plan?.deal) return { label: "See your plan on Orgo", tab: "usage" };
  return short === "size" ? { label: "See Orgo's plans", tab: "plan" } : { label: "Add capacity on Orgo", tab: "usage" };
}

/**
 * Why the main bot's computer can't be made now, in plain words, or null when it can (or Orgo didn't
 * say). The bots that share it can't work in the cloud without it. Never with free Bops computers: the
 * main bot gets the free one, or one on the plan when it has room, else it shares the free one with the
 * main bot that has it (lib/server/plan.ts makeMainComputer).
 */
export function mainComputerShort(plan: OrgoPlan | null | undefined, bots: Bot[], workspaceId: string) {
  if (plan?.freeComputerId !== undefined) return null;
  const short = planShort(plan, 1, computerRam(plan));
  return short ? { short, text: planShortText(short, plan, { bops: bopsComputers(bots), main: mainBot(bots, workspaceId)?.name }) } : null;
}

/**
 * Why a main bot that works on the free Bops computer (another workspace's main bot has it) can't have
 * one of its own on the plan now, in plain words, or null when it can (or Orgo didn't say).
 */
export function mainOwnShort(plan: OrgoPlan | null | undefined, bots: Bot[], main: Pick<Bot, "name">) {
  const short = planShort(plan, 1, computerRam(plan));
  return short ? { short, text: planShortText(short, plan, { bops: bopsComputers(bots), main: main.name }) } : null;
}

/**
 * Why a bot in this workspace can't have a computer of its own now, in plain words, or null when it can
 * (or Orgo didn't say). It takes one more computer, as big as the computer it's copied from (the main
 * bot's, or the free Bops computer the main bot shares), and the main bot's first when that has none:
 * the free one when that's next (it takes no room on the plan), else one at computerRam's size.
 */
export function ownComputerShort(plan: OrgoPlan | null | undefined, bots: Bot[], workspaceId: string) {
  const ws = mainBot(bots, workspaceId);
  const main = ws && workBot(ws, bots);
  const short = main?.computerId
    ? planShort(plan, 1, main.computerRam ?? (main.freeComputer ? FREE_COMPUTER_RAM : undefined))
    : freeComputerOpen(plan)
      ? planShort(plan, 1, FREE_COMPUTER_RAM)
      : planShort(plan, 2, computerRam(plan));
  return short ? { short, text: planShortText(short, plan, { bops: bopsComputers(bots), main: main?.name }) } : null;
}

/**
 * Why the computer `host` works on (the main bot's, or a bot's own) can't be set up now, or null when it
 * can. One that's made already, but whose setup didn't finish, is set up again: that takes no more room.
 */
export function setupShort(plan: OrgoPlan | null | undefined, bots: Bot[], host: Bot) {
  if (host.computerId) return null;
  return (host.isMain ? mainComputerShort : ownComputerShort)(plan, bots, workspaceOf(host));
}

const mainBot = (bots: Bot[], workspaceId: string) => bots.find((b) => b.isMain && workspaceOf(b) === workspaceId);
