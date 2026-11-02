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
 *   computer           { size: "Large", key: "large", change: "bops", hourlyCents: 11, asleepFree: true,
 *                      creditCents } (usage.computer.running_cents_per_hour; creditCents: what the
 *                      computer may spend, usage.computer_credit_cents: a plan's monthly allowance pays
 *                      AI only). `key` is the computer's real size (usage.computer.size), `change` how it's
 *                      switched now (ComputerSizeChange), usage.computer.id whether there's one yet
 *   computerSizes      the sizes Orgo makes a Bops computer at, in order, each with its price an hour
 *                      while it works (usage.computer_sizes); missing from an orgo-web before sizes, which
 *                      makes every Bops computer Large: then the app offers no choice and sends no size
 *   defaultSize        the size a new user's computer is picked at (usage.default_size)
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

/**
 * The sizes of Bops computer this app knows, smallest first: the ones it offers, of those orgo-web lists. A
 * size added later (a "small" one for a personal agent with no screen, say) is one more value here and one
 * more row in orgo-web's list, never a change to how they talk.
 */
export const COMPUTER_SIZES = ["medium", "large"] as const;
export type ComputerSize = (typeof COMPUTER_SIZES)[number];
export const isComputerSize = (x: unknown): x is ComputerSize => typeof x === "string" && (COMPUTER_SIZES as readonly string[]).includes(x);

/** A size Orgo makes the Bops computer at: its name, cores, memory and disk in GB, and its price an hour while it works. */
export type SizeOffer = { key: ComputerSize; name: string; cpu?: number; ramGb?: number; diskGb?: number; hourlyCents: number };

/**
 * How the computer's size is switched now: "bops", Orgo's switch for a Bops computer billed by the hour
 * (POST /api/bops/computer/size); "plan", Orgo's own resize, for one that's part of the user's Orgo plan
 * (PATCH /api/computers/{id}/resize); null, not now (it's still being set up).
 */
export type ComputerSizeChange = "bops" | "plan" | null;

/** What a user billed by use pays, and has left. Money in cents, times in Unix ms. */
export type UsageTerms = {
  /** The Orgo credit left; missing when Orgo didn't say (then no balance is shown, never a made up one). */
  balanceCents?: number;
  /**
   * creditCents: what the computer may spend (missing: the balance stands in for it). `key`: its real size,
   * `id` the computer's (null: there's none yet), `change` how its size is switched now, each missing when
   * Orgo didn't say.
   */
  computer: { size: string; hourlyCents: number; asleepFree: boolean; creditCents?: number; key?: ComputerSize; id?: string | null; change?: ComputerSizeChange };
  /** The sizes Orgo makes it at that this app knows, in Orgo's order; missing when Orgo listed none (then it's Large). */
  sizes?: SizeOffer[];
  /** The size a new user's computer is picked at, one of `sizes`. */
  defaultSize?: ComputerSize;
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

/** The sizes orgo-web lists (flat computerSizes, else its nested usage.computer_sizes), only those this app knows, each once. */
function sizesIn(a: Record<string, unknown>, u: Record<string, unknown>): SizeOffer[] | undefined {
  const list = [field(a, "computerSizes"), u.computer_sizes].find(Array.isArray) as unknown[] | undefined;
  if (!list) return undefined;
  const out: SizeOffer[] = [];
  for (const x of list) {
    const o = obj(x);
    const key = o.key ?? o.size;
    const hourly = num(field(o, "hourlyCents")) ?? num(o.running_cents_per_hour);
    if (!isComputerSize(key) || out.some((s) => s.key === key) || hourly === undefined || hourly < 0) continue;
    const cpu = num(o.cpu);
    const ram = num(field(o, "ramGb"));
    const disk = num(field(o, "diskGb"));
    out.push({
      key,
      name: typeof o.name === "string" && o.name ? o.name : key[0].toUpperCase() + key.slice(1),
      ...(cpu !== undefined ? { cpu } : {}),
      ...(ram !== undefined ? { ramGb: ram } : {}),
      ...(disk !== undefined ? { diskGb: disk } : {}),
      hourlyCents: hourly,
    });
  }
  return out.length ? out : undefined;
}

/** How the size is switched now, as orgo-web said it; a plain yes (an orgo-web that switches every size by its resize) is its resize. */
function changeIn(x: unknown): ComputerSizeChange | undefined {
  if (x === "bops" || x === "plan") return x;
  if (x === true) return "plan";
  if (x === null || x === false) return null;
  return undefined;
}

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
  // Its real size: the flat key, else the nested size ("medium"), else the flat name ("Medium").
  const key = [c.key, uc.size, typeof c.size === "string" ? c.size.toLowerCase() : undefined].find(isComputerSize);
  const id = "id" in c ? c.id : uc.id;
  const change = changeIn(c.change !== undefined ? c.change : uc.change);
  const sizes = sizesIn(a, u);
  const wanted = field(a, "defaultSize") ?? u.default_size;
  const defaultSize = sizes && (sizes.find((s) => s.key === wanted) ?? sizes[0]).key;
  return {
    ...(balance !== undefined ? { balanceCents: Math.round(balance) } : {}),
    computer: {
      size: typeof c.size === "string" && c.size ? c.size : "Large",
      hourlyCents: hourly !== undefined && hourly >= 0 ? hourly : BOPS_USAGE.computerHourlyCents,
      asleepFree: c.asleepFree === undefined && c.asleep_free === undefined ? true : (c.asleepFree ?? c.asleep_free) === true,
      ...(credit !== undefined ? { creditCents: Math.round(credit) } : {}),
      ...(key ? { key } : {}),
      ...(typeof id === "string" && id ? { id } : id === null ? { id: null } : {}),
      ...(change !== undefined ? { change } : {}),
    },
    ...(sizes ? { sizes, defaultSize } : {}),
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
 * An hourly price as money, to the tenth of a cent where it has one: "$0.055", "$0.11", "$1". Cents
 * rounded to the cent (centsText) would make Medium's $0.055 "$0.06".
 */
export const rateText = (cents: number) => {
  const d = Math.max(0, cents) / 100;
  if (Number.isInteger(d)) return `$${d.toLocaleString("en-US")}`;
  const text = d.toFixed(3).replace(/0$/, "");
  return `$${text}`;
};

/**
 * About how many hours `budgetCents` of credit runs a computer that costs `hourlyCents` an hour: rounded
 * down, to 5 from 10 hours up (90, 45), so it never says more than it is.
 */
export const hoursFor = (hourlyCents: number, budgetCents: number = BOPS_USAGE.startCents) => {
  if (!(hourlyCents > 0)) return 0;
  const h = budgetCents / hourlyCents;
  return h >= 10 ? Math.floor(h / 5) * 5 : Math.floor(h);
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
