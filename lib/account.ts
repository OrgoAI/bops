/**
 * What the account page shows (GET /api/account), shared by the route and the page. The route
 * builds it on the server, so the Orgo key never reaches the page.
 */
import type { BopsTier } from "@/cloud/protocol";

/**
 * The user's Bops plan and AI credit (orgo-web's GET /api/bops/plan, read with their Orgo key): Free
 * has $5 of AI credit once, Pro $20 and Max $200 each month, with nothing carried over; on any plan,
 * credit can be added once (lib/credit-topup.ts), and that never expires. Money in micro-dollars
 * (1 cent = 10,000), times in Unix ms.
 */
export type BopsPlan = {
  tier: BopsTier;
  name: string;
  priceCents: number;
  /** Stripe's word for a paid plan: "active", "trialing", "past_due"… Missing on Free. */
  status?: string;
  /** When the paid month ends (and renews, unless it's set to end). */
  periodEnd?: number;
  cancelAtPeriodEnd?: boolean;
  /** Missing when Orgo's answer didn't have the numbers: the page then says nothing about the balance. */
  credit?: {
    /** All that's left; below 0 when a turn overran it. */
    leftMicros: number;
    /** What's left of this month's plan credit, and when it resets (Pro and Max). */
    planLeftMicros: number;
    resetsAt?: number;
    /** The credit that never expires: what's left of the one-time $5, and of credit added once (top-ups). */
    freeLeftMicros: number;
    /** Credit was added once (lib/credit-topup.ts), so freeLeftMicros isn't only the one-time $5. */
    topUps?: true;
  };
  /** On Free, the free Bops computer's month (orgo-web lib/bops-free-hours.ts): how long it ran, of how long, and when it starts over. */
  computerTime?: { usedSeconds: number; limitSeconds: number; resetsAt: number };
};

/** Plan and billing, read from Orgo with the signed-in key. Each part is missing when Orgo didn't answer it. */
export type OrgoBilling = {
  /**
   * "ok": every part came back. "partial": some did. "expired": Orgo turned the key down. "unreachable": no answer.
   * "no-key": signed in, but this Mac couldn't read the key back from the Keychain.
   */
  status: "ok" | "partial" | "expired" | "unreachable" | "no-key";
  plan?: {
    tier: string;
    name: string;
    /** What it costs per interval, in cents, when it's a paid subscription. */
    amountCents?: number;
    currency?: string;
    interval?: "month" | "year";
    /** Unix ms. */
    renewsAt?: number;
    cancelsAtPeriodEnd?: boolean;
    /** Granted by Orgo rather than paid for. */
    comped?: boolean;
    compEndsAt?: number;
  };
  /**
   * The plan's computers: how many it allows (Orgo's count, computers bought on top and a custom deal
   * included), how many are in use across the whole Orgo account (Bops' or not), and how many of those
   * aren't the bots'. In use is missing when Orgo didn't say.
   */
  computers?: { allowed: number; inUse?: number; outsideBops?: number };
  /** The plan has no room for another computer: why, in plain words (lib/orgo-plans.ts). */
  full?: string;
  /** The next plan up that Orgo sells, with more computers. */
  upgradeTo?: string;
  creditsCents?: number;
  /** Orgo compute across the whole account, month to date, and the computers it holds now. */
  compute?: { runningHours: number; vcpuHours: number; computers: number };
};

/**
 * One month of Bops' usage. Through Bops Cloud, model use, calls and AI credit spent are the cloud's
 * own count (GET /v1/usage: the rows it charges), and the rest (computers, numbers and inboxes made)
 * this Mac's ledger; otherwise all of it is this Mac's ledger. Every way it's
 * cut adds up to the same: tokens by kind of work, by day and by bot each sum to `tokens`, and the
 * parts of `spend` to its total.
 */
export type UsageTotals = {
  computersCreated: number;
  computersRemoved: number;
  phoneNumbers: number;
  inboxes: number;
  callMinutes: number;
  /** Model tokens Bops used (its OpenAI models and Jev, tasks on the user's Mac too): what AI credit pays for. */
  tokens: number;
  tokensBySource: Partial<Record<TokenSource, number>>;
  /** Tokens per day of the month, index 0 is the 1st. */
  tokensByDay: number[];
  /** Per bot. `botId` "" is what wasn't for one bot (memory, quick checks about everything). */
  byBot: { botId: string; name: string; color?: string; tokens: number; callMinutes: number; computers: number; costMicros?: number }[];
  /**
   * What it cost, by kind (Bops Cloud's count, in micro-dollars at cost): what AI credit paid for when
   * the cloud takes it (`charged`). Missing without the cloud's answer.
   */
  spend?: { costMicros: number; charged: boolean; parts: SpendPart[] };
  /** Where model use and calls come from: Bops Cloud's count, or this Mac's ledger (self-hosted, or the cloud didn't answer). */
  from: "cloud" | "mac";
};

export type TokenSource = "chat" | "session" | "memory" | "call" | "decide" | "other";

/** A kind of thing AI credit paid for, with how much of it: tokens, searches, call minutes, texts, numbers, codes, app runs, checks. */
export type SpendPart = { id: SpendKind; costMicros: number; amount: number };
export type SpendKind = "chat" | "session" | "search" | "call" | "memory" | "decide" | "text" | "number" | "code" | "app" | "data" | "other";

export type AccountInfo = {
  user: { id: string; email?: string; name?: string } | null;
  signedInAt?: number;
  /** Null when signed out. */
  orgo: OrgoBilling | null;
  /**
   * The Bops plan and AI credit: null when Orgo didn't answer, missing when it doesn't apply (signed
   * out, self-hosted, or a hosted server: AI credit is for Bops Cloud).
   */
  bops?: BopsPlan | null;
  /** Orgo pages to open in the browser. */
  links: { billing: string; usage: string };
  usage: { thisMonth: UsageTotals; lastMonth: UsageTotals; monthStart: number; lastMonthStart: number };
  /** The inboxes and numbers the user's bots have, by workspace. */
  reach: {
    id: string;
    name: string;
    /** The workspace's number: people text and call its main bot there. */
    line?: { phone: string; imessage: boolean; main?: string };
    bots: { id: string; name: string; color: string; isMain: boolean; email?: string; phone?: string }[];
  }[];
};
