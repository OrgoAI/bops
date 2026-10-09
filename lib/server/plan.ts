import "server-only";
import { BOPS_TIERS, type BopsTier } from "@/cloud/protocol";
import type { BopsPlan } from "@/lib/account";
import { pendingFrom, savedCardFrom, type PendingTopUp, type SavedCard } from "@/lib/credit-topup";
import { botChatId, freeComputerBot, type Bot } from "@/lib/types";
import { bopsComputerShort, bopsComputers, computerRam, mainOwnShort, ownComputerShort, planComputers, planFix, planName, planShort, planShortText, type OrgoPlan, type PlanShort } from "@/lib/orgo-plans";
import { cloudOn, cloudSessionNow } from "./cloud";
import { callOrgo, computerChanges, orgo, OrgoError, ownedWorkspace } from "./orgo";
import { loadOrgoKey, orgoOrigin } from "./orgo-auth";
import { addMessage, getState, stateEpoch, update } from "./store";

/**
 * The signed-in user's Orgo plan, read from Orgo with their own key: which plan it is, the computers it
 * allows (computers bought on top and a custom deal included) and how many are in use across their whole
 * Orgo account, and its memory. These are the numbers Orgo itself checks when a computer is made (GET
 * /api/billing/compute-limits, asked about a workspace the user owns), with the plan's key from GET
 * /api/user/subscription. Names and words are in lib/orgo-plans.ts.
 *
 * Kept for a minute, and read again once Bops has made or deleted a computer (orgo.ts counts those).
 * When Orgo can't be asked, nothing here stands in the way: Orgo's own limit decides when a computer is
 * made, and its refusal is put in plain words (planRefusal).
 *
 * The user's one free Bops computer (compute-limits' bops_free_computer_id) isn't on the plan: Bops
 * makes it for the first main bot that needs a computer (makeMainComputer), and Orgo counts it nowhere.
 */

/** Orgo's account page, on the tab to move up a plan, and the one to add computers, memory or disk to it. */
export const orgoPages = () => ({ plan: `${orgoOrigin()}/account?tab=plan`, usage: `${orgoOrigin()}/account?tab=usage` });

/** One read from Orgo with the user's key: its JSON, or whether Orgo turned the key down (vs. didn't answer). */
export type Got<T> = { ok: true; json: T } | { ok: false; denied: boolean };

export async function askOrgo<T>(key: string, path: string): Promise<Got<T>> {
  try {
    const res = await fetch(`${orgoOrigin()}${path}`, { headers: { Authorization: `Bearer ${key}` }, cache: "no-store", signal: AbortSignal.timeout(8000) });
    if (!res.ok) return { ok: false, denied: res.status === 401 || res.status === 403 };
    return { ok: true, json: (await res.json()) as T };
  } catch {
    return { ok: false, denied: false };
  }
}

/**
 * askOrgo's POST twin, with a JSON body (and `headers`, like an Idempotency-Key): Orgo's answer either
 * way (its status and JSON), or null when it didn't answer.
 */
export function postOrgo<T>(key: string, path: string, body: unknown, headers?: Record<string, string>, timeoutMs?: number) {
  return callOrgo<T>(key, path, { method: "POST", body, headers, timeoutMs });
}

/* ---------------- Bops' own plan: AI credit ---------------- */

/** GET /api/bops/plan as orgo-web answers it. */
type BopsPlanAnswer = {
  tier?: string;
  name?: string;
  price_cents?: number;
  status?: string | null;
  period_end?: string | number | null;
  cancel_at_period_end?: boolean;
  credit?: { left_micros?: number; plan_left_micros?: number; plan_resets_at?: string | number | null; free_left_micros?: number };
  /** The newest grants of credit; a one-time top-up's kind is "topup". */
  grants?: { kind?: unknown }[];
  /** On Free, the free computer's month: seconds used, of how many, and when it starts over (orgo-web lib/bops-free-hours.ts). */
  computer_time?: { used_seconds?: number; limit_seconds?: number; resets_at?: string | null } | null;
};

/** Free's computer time, when Orgo said all of it. */
function computerTimeOf(t: BopsPlanAnswer["computer_time"]): Pick<BopsPlan, "computerTime"> | undefined {
  const used = Number(t?.used_seconds);
  const limit = Number(t?.limit_seconds);
  const resets = msOf(t?.resets_at);
  if (!t || !Number.isFinite(used) || !(limit > 0) || !resets) return undefined;
  return { computerTime: { usedSeconds: Math.max(0, used), limitSeconds: limit, resetsAt: resets } };
}

/** An ISO time or Unix seconds, as Unix ms. */
const msOf = (t: string | number | null | undefined) => (typeof t === "number" ? t * 1000 : typeof t === "string" && !Number.isNaN(Date.parse(t)) ? Date.parse(t) : undefined);

/**
 * The user's Bops plan and AI credit, read from Orgo with their key (orgo-web's GET /api/bops/plan,
 * which also gives a new user their one-time $5). Null when Orgo didn't answer, or doesn't have Bops
 * plans yet. Credit to spend clears the app's "out of AI credit" (state.credits).
 */
export async function readBopsPlan(key: string): Promise<BopsPlan | null> {
  const got = await askOrgo<BopsPlanAnswer>(key, "/api/bops/plan");
  if (!got.ok) return null;
  const a = got.json;
  const tier: BopsTier = a.tier === "pro_bops" || a.tier === "max_bops" ? a.tier : "free_bops";
  const c = a.credit ?? {};
  // Only Orgo's own numbers: without a balance, there's no credit to show (never a made-up one).
  const known = typeof c.left_micros === "number" && Number.isFinite(c.left_micros);
  // Credit added once is in free_left_micros with what's left of the one-time $5 (it never expires either).
  const topUps = Array.isArray(a.grants) && a.grants.some((x) => x?.kind === "topup");
  const plan: BopsPlan = {
    tier,
    name: BOPS_TIERS[tier].name,
    priceCents: BOPS_TIERS[tier].priceCents,
    ...(a.status ? { status: a.status } : {}),
    ...(msOf(a.period_end) ? { periodEnd: msOf(a.period_end) } : {}),
    ...(a.cancel_at_period_end ? { cancelAtPeriodEnd: true } : {}),
    ...(known
      ? {
          credit: {
            leftMicros: Number(c.left_micros) || 0,
            planLeftMicros: Number(c.plan_left_micros) || 0,
            ...(msOf(c.plan_resets_at) ? { resetsAt: msOf(c.plan_resets_at) } : {}),
            freeLeftMicros: Number(c.free_left_micros) || 0,
            ...(topUps ? { topUps: true as const } : {}),
          },
        }
      : {}),
    ...(computerTimeOf(a.computer_time) ?? {}),
  };
  if ((plan.credit?.leftMicros ?? 0) > 0 && getState().credits?.out) update((st) => (st.credits = undefined));
  return plan;
}

/**
 * Orgo's answer to a checkout or plan page: where to send the user, or why not. `soon`: Orgo can't take
 * payment for Bops plans yet (no such route there, or plans switched off), which isn't an error.
 */
export type BopsBillingLink = { url: string } | { error: string; status: number; soon?: true };

/**
 * Where to pay for Pro or Max (Stripe Checkout, through orgo-web's POST /api/bops/checkout), or to
 * change or cancel the plan (its POST /api/bops/portal): a page for the user's browser.
 */
export async function bopsBillingLink(key: string, what: { tier: "pro_bops" | "max_bops" } | "manage"): Promise<BopsBillingLink> {
  const got = await postOrgo<{ url?: unknown; error?: unknown; code?: unknown }>(key, what === "manage" ? "/api/bops/portal" : "/api/bops/checkout", what === "manage" ? {} : what);
  if (!got) return { error: "Couldn't reach Orgo. Check your internet connection and try again.", status: 502 };
  if (got.status >= 200 && got.status < 300 && typeof got.json.url === "string" && /^https:\/\//.test(got.json.url)) return { url: got.json.url };
  if (got.status === 401 || got.status === 403) return { error: "Orgo didn't accept this Mac's sign-in. Sign out, then sign in again.", status: 401 };
  if (got.status === 404 || got.json.code === "bops_plans_off") return { error: "Upgrades open soon.", status: got.status === 404 ? 404 : 503, soon: true };
  if (got.json.code === "no_bops_plan") return { error: "You don't have a paid plan to manage yet.", status: 409 };
  return { error: typeof got.json.error === "string" ? got.json.error : `Orgo couldn't open that page (${got.status}). Try again in a minute.`, status: 502 };
}

/* ---------------- Adding AI credit once ---------------- */

/*
 * One-time AI credit top-ups (lib/credit-topup.ts), bought through orgo-web's /api/bops/credit routes
 * with the user's key: the card on file and a charge to it, or Stripe Checkout. Never monthly, never an
 * automatic reload. Nothing here is logged but Orgo's status and code: not the key, the card's handle or
 * the purchase's Idempotency-Key.
 */

const SIGNED_OUT = "Orgo didn't accept this Mac's sign-in. Sign out, then sign in again.";

/** Orgo doesn't sell AI credit yet: in its words, for the app. */
export const CREDIT_OFF = { error: "Adding credit opens soon.", code: "bops_credit_off" };

/** Orgo doesn't sell AI credit yet: no such route there (an orgo-web before top-ups), or it says so. */
const creditOff = (got: { status: number; json: { code?: unknown } }) => got.status === 404 || got.json.code === CREDIT_OFF.code;

/** The account sheet's look at adding AI credit: not offered, or the card and the payments on their way; else why Orgo couldn't say. */
export type CreditCardRead =
  | { off: true }
  | { card: SavedCard | null; pending: { amount_cents: number; code: PendingTopUp["code"] }[] | null }
  | { error: string; status: number };

/**
 * The card a one-time top-up would charge (null: none, so it's Checkout), never its Stripe id, and this
 * account's top-ups paid whose credit isn't in the balance yet (orgo-web's GET
 * /api/bops/credit/card-on-file). `off` when Orgo doesn't sell AI credit yet.
 */
export async function readCreditCard(key: string): Promise<CreditCardRead> {
  const got = await callOrgo<{ card?: unknown; pending?: unknown; code?: unknown; error?: unknown }>(key, "/api/bops/credit/card-on-file");
  if (!got) return { error: "Couldn't reach Orgo. Check your internet connection and try again.", status: 502 };
  if (creditOff(got)) return { off: true };
  if (got.status === 401 || got.status === 403) return { error: SIGNED_OUT, status: 401 };
  if (got.status !== 200) return { error: typeof got.json.error === "string" ? got.json.error : `Orgo couldn't look up your card (${got.status}).`, status: 502 };
  const pending = pendingFrom(got.json.pending);
  return { card: savedCardFrom(got.json.card), pending: pending && pending.map((p) => ({ amount_cents: p.cents, code: p.code })) };
}

/**
 * Buy `amountCents` of AI credit once, on the card the user confirmed (`cardHandle`, from
 * readCreditCard), with orgo-web's POST /api/bops/credit/card-on-file. `idempotencyKey` is the
 * purchase's own: the app makes one per purchase and sends it again on a retry of that purchase, so a
 * double click or a lost answer never charges twice. Orgo's answer for the app, its status as it was
 * (200 succeeded, 202 pending, 402 checkout, 409 card_changed…), with only the fields the app reads.
 */
export async function buyCreditOnCard(key: string, p: { amountCents: number; cardHandle: string; idempotencyKey: string }): Promise<{ status: number; json: Record<string, unknown> }> {
  // Longer than other calls: Orgo answers once Stripe has, and an answer lost here leaves the payment unconfirmed.
  const got = await postOrgo<Record<string, unknown>>(
    key,
    "/api/bops/credit/card-on-file",
    { amount_cents: p.amountCents, card_handle: p.cardHandle },
    { "Idempotency-Key": p.idempotencyKey },
    30_000,
  );
  if (!got) {
    console.warn("[credit] Orgo didn't answer a card purchase");
    // It may have charged: the app tries again under the same key, which Orgo answers with the first result.
    return { status: 502, json: { code: "orgo_unreachable", error: "Couldn't reach Orgo. Try again: you won't be charged twice." } };
  }
  if (got.status === 404) return { status: 503, json: CREDIT_OFF };
  if (got.status === 401 || got.status === 403) return { status: 401, json: { error: SIGNED_OUT, code: "signed_out" } };
  const j = got.json && typeof got.json === "object" ? got.json : {};
  const json: Record<string, unknown> = {};
  for (const f of ["status", "code", "error"]) if (typeof j[f] === "string") json[f] = j[f];
  if (Number.isSafeInteger(j.amount_cents)) json.amount_cents = j.amount_cents;
  const card = savedCardFrom(j.card);
  if (card) json.card = card;
  if (got.status >= 500) console.warn(`[credit] Orgo answered a card purchase with ${got.status}${json.code ? ` (${json.code})` : ""}`);
  return { status: got.status, json };
}

/**
 * A one-time Stripe Checkout for `amountCents` of AI credit, for the user's browser (orgo-web's POST
 * /api/bops/credit/checkout): its page, or why not. It returns to Orgo's own page for Bops billing.
 */
export async function creditCheckoutLink(key: string, amountCents: number): Promise<{ url: string } | { error: string; code?: string; status: number }> {
  const got = await postOrgo<{ url?: unknown; error?: unknown; code?: unknown }>(key, "/api/bops/credit/checkout", { amount_cents: amountCents });
  if (!got) return { error: "Couldn't reach Orgo. Check your internet connection and try again.", code: "orgo_unreachable", status: 502 };
  if (got.status >= 200 && got.status < 300 && typeof got.json.url === "string" && /^https:\/\//.test(got.json.url)) return { url: got.json.url };
  if (got.status === 401 || got.status === 403) return { error: SIGNED_OUT, code: "signed_out", status: 401 };
  if (creditOff(got)) return { ...CREDIT_OFF, status: 503 };
  const code = typeof got.json.code === "string" ? got.json.code : undefined;
  if (got.status >= 500) console.warn(`[credit] Orgo answered a checkout with ${got.status}${code ? ` (${code})` : ""}`);
  return {
    error: typeof got.json.error === "string" ? got.json.error : `Orgo couldn't open checkout (${got.status}). Try again in a minute.`,
    ...(code ? { code } : {}),
    status: got.status >= 400 && got.status < 500 ? got.status : 502,
  };
}

/* ---------------- Orgo's plan ---------------- */

type Subscription = { tier?: string; planLimits?: { maxDesktops?: number; maxRamPerUser?: number } | null };
type Limits = {
  max_computers?: number;
  computers_used?: number;
  max_ram_gb?: number;
  account_ram_budget_gb?: number;
  account_ram_used_gb?: number;
  /** The free Bops computer's id, null while there's none; missing from an Orgo before free Bops computers. */
  bops_free_computer_id?: string | null;
  /** Max's other Bops computers, and how many Bops computers the Bops plan includes (Max 3, else 1); missing from an older Orgo. */
  bops_max_computer_ids?: string[];
  bops_computers_limit?: number;
};

const KEEP_MS = 60_000;
const g = globalThis as unknown as { bopsOrgoPlan?: { key: string; changes: number; at: number; plan: Promise<OrgoPlan | null> }; bopsMaking?: Promise<unknown> };

/** The user's plan (null when nobody is signed in, or Orgo didn't answer). `fresh` asks Orgo again even within the minute. */
export async function orgoPlan({ fresh = false } = {}): Promise<OrgoPlan | null> {
  const key = await loadOrgoKey();
  if (!key) return null;
  const kept = g.bopsOrgoPlan;
  // Another user's key, or a computer made or deleted since: read again.
  if (!fresh && kept?.key === key && kept.changes === computerChanges() && Date.now() - kept.at < KEEP_MS) return kept.plan;
  const read = { key, changes: computerChanges(), at: Date.now(), plan: readPlan(key) };
  g.bopsOrgoPlan = read;
  // Nothing came back: not kept, so the next look asks again.
  void read.plan.then((p) => {
    if (!p && g.bopsOrgoPlan === read) g.bopsOrgoPlan = undefined;
  });
  return read.plan;
}

/** Forget the plan read last: its numbers are out of date (Orgo turned a computer down, or one is gone). */
export const forgetPlan = () => void (g.bopsOrgoPlan = undefined);

async function readPlan(key: string): Promise<OrgoPlan | null> {
  // Computers count against the owner of the workspace they're in, across every workspace they own,
  // so any workspace the user owns gives their numbers. None is made just to read them.
  const workspace = await ownedWorkspace().catch(() => null);
  const [sub, limits] = await Promise.all([
    askOrgo<Subscription>(key, "/api/user/subscription"),
    workspace ? askOrgo<Limits>(key, `/api/billing/compute-limits?workspace_id=${encodeURIComponent(workspace)}`) : null,
  ]);
  const s = sub.ok ? sub.json : undefined;
  const l = limits?.ok ? limits.json : undefined;
  const counted = typeof l?.max_computers === "number" && typeof l.computers_used === "number" ? { computers: l.max_computers, inUse: l.computers_used } : undefined;
  // Orgo answers "free" when it couldn't look the plan up: a plan it counts computers on isn't Free.
  const tier = s?.tier && !(s.tier.toLowerCase() === "free" && counted && counted.computers > 0) ? s.tier : undefined;
  const computers = counted?.computers ?? s?.planLimits?.maxDesktops ?? (tier ? planComputers(tier) : undefined);
  if (computers === undefined) return null;
  const memory =
    l && typeof l.account_ram_budget_gb === "number" && typeof l.account_ram_used_gb === "number" && typeof l.max_ram_gb === "number"
      ? { total: l.account_ram_budget_gb, used: l.account_ram_used_gb, newMax: l.max_ram_gb }
      : undefined;
  // A custom deal's count or memory is the plan's whatever plan it's on (orgo-web lib/plan-limits.ts).
  const deal = typeof s?.planLimits?.maxDesktops === "number" || typeof s?.planLimits?.maxRamPerUser === "number";
  const free = l && "bops_free_computer_id" in l ? { freeComputerId: typeof l.bops_free_computer_id === "string" ? l.bops_free_computer_id : null } : {};
  // The Bops plan decides a bot's own computer where Bops Cloud holds plans to what they include and
  // Orgo counts Bops computers (lib/orgo-plans.ts OrgoPlan.bops).
  const session = cloudOn() ? cloudSessionNow()?.plan : undefined;
  const bops =
    session?.limits && typeof l?.bops_computers_limit === "number"
      ? { bops: { tier: session.tier, limit: l.bops_computers_limit, extras: Array.isArray(l.bops_max_computer_ids) ? l.bops_max_computer_ids.filter((x): x is string => typeof x === "string") : [] } }
      : {};
  return { tier, name: tier ? planName(tier) : undefined, computers, inUse: counted?.inUse, ...(memory ? { memory } : {}), ...(deal ? { deal } : {}), ...free, ...bops };
}

/** Orgo's codes for a computer turned down for the plan (orgo-web lib/quota.ts validateComputerLimits, the create, fork and clone routes). */
const REFUSED: Record<string, PlanShort> = {
  UPGRADE_REQUIRED: "none",
  VM_SLOT_ADDON: "count",
  CHANGE_PLAN: "count",
  DESKTOP_LIMIT: "count",
  VCPU_ADDON: "size",
  PER_COMPUTER_RAM_CAP: "size",
  PER_COMPUTER_CPU_CAP: "size",
  DISK_QUOTA_EXCEEDED: "disk",
  disk_exceeds_quota: "disk",
};

/** Why Orgo turned a computer down, when it was for the plan. Null for anything else (a busy server, a computer that can't be forked…). */
export function planRefusal(e: unknown): PlanShort | null {
  if (!(e instanceof OrgoError) || (e.status !== 403 && e.status !== 400)) return null;
  // An older plan in its grace period is turned down without a code (a fork or clone calls that DESKTOP_LIMIT).
  if (e.status === 403 && /ram limit exceeded/i.test(e.message)) return "memory";
  // RAM_ADDON is either: one computer can't have that much memory, or the plan's memory is used up.
  if (e.code === "RAM_ADDON") return /not enough account ram/i.test(e.message) ? "memory" : "size";
  // Every limit of a custom deal is PLAN_LIMIT (orgo-web lib/plan-limits.ts): no computers at all, its
  // memory, the most for one computer, or a count (all its computers, or those of one kind).
  if (e.code === "PLAN_LIMIT")
    return /doesn't include computers/i.test(e.message) ? "none" : /RAM across your computers/i.test(e.message) ? "memory" : /per computer/i.test(e.message) ? "size" : "count";
  if (e.code) return REFUSED[e.code] ?? null;
  return e.status === 403 && /computer limit reached/i.test(e.message) ? "count" : null;
}

/**
 * A computer the plan has no room for: why, in plain words, and where to change that on Orgo. A Bops
 * plan's has no link: it's changed in the app's Settings, which its words say.
 */
export class PlanLimit extends Error {
  link?: { label: string; url: string };
  constructor(text: string, link?: { label: string; url: string }) {
    super(text);
    this.link = link;
  }
}

/** The PlanLimit for a Bops plan with no room for another Bops computer. */
function bopsLimit(s: { text: string; upgrade: "max" | null }) {
  return new PlanLimit(s.upgrade ? `${s.text} Upgrade to Max in Settings.` : s.text);
}

/** A PlanLimit in chat: its words, and its link when it has one. */
export const limitText = (e: PlanLimit) => (e.link ? `${e.message} [${e.link.label}](${e.link.url})` : e.message);

/** Orgo turned a Bops computer down for the Bops plan (orgo-web's create gate, BOPS_COMPUTER_LIMIT): its words. */
function bopsRefusal(e: unknown) {
  if (!(e instanceof OrgoError) || e.code !== "BOPS_COMPUTER_LIMIT") return null;
  forgetPlan();
  const said = e.said || e.message;
  return new PlanLimit(/^Max includes/.test(said) ? said : `${said} Upgrade to Max in Settings.`);
}

/**
 * One more Bops computer, fresh from the Bops template (orgo-web makes it one of Max's when the free
 * one is taken), when the Bops plan has room for `more` (lib/orgo-plans.ts bopsComputerShort). Null
 * with `onShort` called when it hasn't, or Orgo turns it down for the plan.
 */
async function makeBopsComputer<T>(name: string, epoch: number, onShort: (why: PlanLimit) => T): Promise<{ id: string } | T> {
  let plan = await orgoPlan();
  let short = bopsComputerShort(plan, 1);
  if (short) {
    plan = await orgoPlan({ fresh: true });
    short = bopsComputerShort(plan, 1);
  }
  if (short) return onShort(bopsLimit(short));
  sameUser(epoch);
  try {
    return await orgo.create(name, { free: true });
  } catch (e) {
    const refused = bopsRefusal(e);
    if (!refused) throw e;
    return onShort(refused);
  }
}

/** Where on Orgo to change what's short. */
function linkFor(short: PlanShort, plan: OrgoPlan | null) {
  const fix = planFix(short, plan);
  return { label: fix.label, url: orgoPages()[fix.tab] };
}

/** The PlanLimit for a shortfall, worded with the plan's numbers. */
function limitOf(short: PlanShort, plan: OrgoPlan | null, main: Bot) {
  return new PlanLimit(planShortText(short, plan, { bops: bopsComputers(getState().bots), main: main.name }), linkFor(short, plan));
}

/** Orgo turned a computer down for the plan: why, with numbers read again. Null when it was turned down for anything else. */
async function refusedFor(e: unknown, main: Bot) {
  const short = planRefusal(e);
  if (!short) return null;
  forgetPlan();
  const read = await orgoPlan();
  // PLAN_LIMIT is a custom deal's: moving up a plan doesn't change it.
  const deal = e instanceof OrgoError && e.code === "PLAN_LIMIT";
  const plan = read && deal ? { ...read, deal } : read;
  if (short === "count" && plan?.inUse !== undefined && plan.inUse < plan.computers) {
    // The numbers have room, so a deal's limit they don't show turned it down (its computers of one kind,
    // say): in Orgo's own words, where it's Orgo to ask.
    if (deal && e.said) return new PlanLimit(e.said.replace(/\b([Cc])ontact us\b/g, (_, c: string) => `${c === "C" ? "Ask" : "ask"} Orgo`), linkFor(short, plan));
    // Else Orgo's answer stands: a computer came along since it counted.
    return limitOf(short, { ...plan, inUse: plan.computers }, main);
  }
  return limitOf(short, plan, main);
}

/**
 * Bops makes computers one at a time, each after a fresh look at the plan (the last one made or deleted
 * has orgoPlan read again). Orgo counts a plan's computers and adds the new one with no lock between
 * (orgo-web lib/plan-limits.ts), so two made at once could both fit a count with room for one, and two
 * copies of one computer at once would take two live copies of its memory together.
 */
function oneAtATime<T>(make: () => Promise<T>): Promise<T> {
  const turn = (g.bopsMaking ?? Promise.resolve()).then(make);
  g.bopsMaking = turn.catch(() => {});
  return turn;
}

/**
 * The plan, and what keeps it from taking what `short` asks about. A "no" read up to a minute ago is
 * checked with Orgo before it's said: a computer may have gone, or the plan changed, since.
 */
async function planNow(short: (plan: OrgoPlan | null) => PlanShort | null | undefined) {
  let plan = await orgoPlan();
  if (short(plan)) plan = await orgoPlan({ fresh: true });
  return { plan, short: short(plan) };
}

/**
 * Work for one user's state (stateEpoch) stops once a hosted server has swapped in another's: their bots
 * have the same ids, and Orgo is asked with their key now.
 */
function sameUser(epoch: number) {
  if (epoch !== stateEpoch()) throw new Error("Another Orgo account signed in meanwhile");
}

/** A main bot's computer: its id, and whether it's the user's free Bops computer. */
export type MainComputer = { id: string; free?: boolean };

/**
 * The main bot's computer, from the Bops template:
 * - The user's one free Bops computer when they have none yet (at the template's size, off the plan),
 *   or the one they have when no bot here has it (made before this Mac's state, or on another Mac).
 * - Else one on the plan, at the plan's size (computerRam), when the plan has room for it.
 * - Else, when another workspace's main bot has the free computer, this one works there too (null,
 *   and it says so in its chat). Only one free computer is ever made.
 * Throws a PlanLimit, in plain words, when none of those can be, or Orgo turns it down for the plan.
 */
export function makeMainComputer(main: Bot, name: string, epoch = stateEpoch()): Promise<MainComputer | null> {
  return oneAtATime(async () => {
    sameUser(epoch);
    const first = await orgoPlan();
    if (first?.freeComputerId === null) return makeFree(main, name, epoch);
    const kept = first?.freeComputerId;
    if (kept && !getState().bots.some((b) => b.computerId === kept)) return holdFree(main, kept, epoch);
    // The Bops plan decides: one of Max's Bops computers, else this main bot shares the free one.
    if (first?.bops) {
      const holder = freeComputerBot(getState().bots, main.id);
      return makeBopsComputer(name, epoch, (why) => {
        if (holder) return shareFree(main, holder, why, epoch);
        throw why;
      });
    }
    const { plan, short } = await planNow((p) => planShort(p, 1, computerRam(p)));
    // Read again just now: the free one may have gone meanwhile (deleted on Orgo's site).
    if (plan?.freeComputerId === null) return makeFree(main, name, epoch);
    const holder = freeComputerBot(getState().bots, main.id);
    if (short) {
      if (holder) return shareFree(main, holder, limitOf(short, plan, main), epoch);
      throw limitOf(short, plan, main);
    }
    sameUser(epoch);
    try {
      return await orgo.create(name, { ram: computerRam(plan) });
    } catch (e) {
      const refused = await refusedFor(e, main);
      if (!refused) throw e;
      const after = freeComputerBot(getState().bots, main.id);
      if (after) return shareFree(main, after, refused, epoch);
      throw refused;
    }
  });
}

/**
 * The free Bops computer, made now. Orgo makes it free only when the user still has none; if one
 * came along meanwhile it's an ordinary create, so whether this one is free is read back from Orgo.
 */
async function makeFree(main: Bot, name: string, epoch: number): Promise<MainComputer> {
  sameUser(epoch);
  let made: { id: string };
  try {
    made = await orgo.create(name, { free: true });
  } catch (e) {
    throw (await refusedFor(e, main)) ?? e;
  }
  const after = await orgoPlan();
  return after?.freeComputerId === made.id ? holdFree(main, made.id, epoch) : { id: made.id };
}

/**
 * The main bot has the free Bops computer from now on, recorded before the next computer is looked at
 * (one at a time), so another main bot never takes it up too.
 */
function holdFree(main: Bot, id: string, epoch: number): MainComputer {
  sameUser(epoch);
  update(() => {
    main.computerId = id;
    main.freeComputer = true;
    main.computerRam = undefined;
  });
  return { id, free: true };
}

/**
 * The user's free Bops computer, given back to `main`: a main bot left with no computer while the free
 * one is still on Orgo (a sign-in as another account and back let go of it: adoptComputers in
 * orgo-sign-in.ts). Only when Orgo has it and no bot here does, and never one made. Null otherwise, and
 * when `main` has a computer by now (or a task is setting one up for it), or `ours()` says another
 * account came in meanwhile. In turn with the computers being made, so no other main bot takes it up too.
 */
export function holdFreeAgain(main: Bot, ours: () => boolean): Promise<MainComputer | null> {
  return oneAtATime(async () => {
    const without = () => ours() && getState().bots.includes(main) && !main.computerId && main.computerStatus !== "cloning";
    if (!without()) return null;
    // Asked now, not from the minute's read: a free one deleted since would be made again by its setup.
    const id = (await orgoPlan({ fresh: true }))?.freeComputerId;
    if (!id || !without() || getState().bots.some((b) => b.computerId === id)) return null;
    return holdFree(main, id, stateEpoch());
  });
}

/**
 * A main bot whose plan has no room for a computer of its own works on the free Bops computer, which
 * another workspace's main bot has: its bots with it. It says so in its chat, with where to change
 * the plan and how to give it its own (setComputer in lib/server/bots.ts) once the plan has room.
 */
function shareFree(main: Bot, holder: Bot, why: PlanLimit, epoch: number) {
  if (epoch !== stateEpoch()) return null;
  update(() => {
    main.computer = "shared";
    main.computerStatus = "none";
    main.tailnet = undefined;
  });
  addMessage({
    chatId: botChatId(main.id),
    role: "bot",
    botId: main.id,
    text: `I'll work on your free Bops computer, which ${holder.name} has, instead of one of my own. ${limitText(why)} Once your ${why.link ? "Orgo plan" : "plan"} has room, you can switch me to Its own under Computer in my Details.`,
  });
  return null;
}

/**
 * Why a main bot that works on the free Bops computer (shareFree) can't have a computer of its own on
 * the plan now, in plain words, or null when it can (or Orgo didn't say).
 */
export async function noMainComputer(main: Bot) {
  return mainOwnShort(await orgoPlan(), getState().bots, main)?.text ?? null;
}

/**
 * A computer of its own for `b`, copied from its main bot's (a fork, else a clone), when the plan has
 * room for it: one more computer, as big as the main bot's. When it hasn't, or Orgo turns the copy down
 * for the plan, `b` works on the main bot's computer instead and its chat says why: null then. Its task
 * still runs, and no copy is tried again.
 */
export async function makeOwnComputer(b: Bot, main: Bot, name: string, epoch = stateEpoch()) {
  const from = main.computerId;
  if (!from) throw new Error(`${main.name}'s computer isn't set up yet`);
  return oneAtATime(async () => {
    sameUser(epoch);
    // A copy is as big as what it copies: the main bot's computer as Orgo has it now.
    const ram = (await orgo.computer(from).catch(() => null))?.ram || main.computerRam;
    sameUser(epoch);
    if (ram && main.computerRam !== ram && main.computerId === from) update(() => (main.computerRam = ram));
    const { plan, short } = await planNow((p) => planShort(p, 1, ram));
    // The Bops plan decides: one of Max's Bops computers, fresh from the template (a copy would be an
    // Orgo plan computer), else it shares the main bot's and says why.
    if (plan?.bops) return makeBopsComputer(name, epoch, (why) => shareInstead(b, main, why, epoch));
    if (short) return shareInstead(b, main, limitOf(short, plan, main), epoch);
    try {
      sameUser(epoch);
      return await orgo.fork(from).catch((forkErr: Error) => {
        // Turned down for the plan: a clone would be too.
        if (planRefusal(forkErr)) throw forkErr;
        return orgo.clone(from, name).catch((cloneErr: Error) => {
          if (planRefusal(cloneErr)) throw cloneErr;
          throw new Error(/insufficient memory/i.test(forkErr.message) ? "the cloud server it has to share with the main bot's computer is full right now" : `${forkErr.message}; ${cloneErr.message}`);
        });
      });
    } catch (e) {
      const refused = await refusedFor(e, main);
      if (!refused) throw e;
      return shareInstead(b, main, refused, epoch);
    }
  });
}

/**
 * `b` works on its main bot's computer from now on, and says why in its chat, with where to change the
 * plan and how to give it its own again. Nothing when another user's state is in now (hosted).
 */
function shareInstead(b: Bot, main: Bot, why: PlanLimit, epoch: number) {
  if (epoch !== stateEpoch()) return null;
  update(() => {
    b.computer = "shared";
    b.computerStatus = "none";
    b.tailnet = undefined;
  });
  addMessage({
    chatId: botChatId(b.id),
    role: "bot",
    botId: b.id,
    text: `I'll work on ${main.name}'s computer instead of one of my own. ${limitText(why)} Once your ${why.link ? "Orgo plan" : "plan"} has room, you can switch me to Its own under Computer in my Details.`,
  });
  return null;
}

/**
 * Why a bot in this workspace can't have a computer of its own now, in plain words, or null when it can.
 * Null too when Orgo can't be asked: then its first task finds out, and it shares if it must.
 */
export async function noOwnComputer(workspaceId: string) {
  return ownComputerShort(await orgoPlan(), getState().bots, workspaceId)?.text ?? null;
}
