"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import { createPortal } from "react-dom";
import type { AccountInfo, BopsPlan, SpendKind, TokenSource, UsageTotals } from "@/lib/account";
import type { BopsTier } from "@/cloud/protocol";
import {
  afterAnswer,
  afterCancel,
  beingSent,
  cardRechecked,
  confirmCopy,
  creditLanded,
  dollars,
  mergeTopUp,
  newPurchase,
  pendingNote,
  POLL_FOR_MS,
  pollDelay,
  resumePurchase,
  tidyDollars,
  TOPUP_PRESETS,
  TOPUP_UNREACHABLE,
  topUpFrom,
  topUpNext,
  typedCents,
  type CardPurchase,
  type PendingTopUp,
  type TopUpInfo,
  type TopUpNext,
} from "@/lib/credit-topup";
import { freeHoursWords, PLAN_CARDS } from "@/lib/plan-includes";
import type { AppState } from "@/lib/types";
import { Mascot, Spinner } from "./mascot";
import { signOutOfOrgo as signOutAsking } from "./sign-in";
import { refreshState } from "./ui";

/*
 * The account: who you are on Orgo, your Bops plan (Free, Pro or Max; an Orgo plan doesn't change it,
 * and everyone is on Free until they pay) and the AI credit left when Orgo says, with a way to add some
 * once, what your bots used this month and last, and the inboxes and numbers they have. A sheet
 * over the app, like Settings. Everything comes from GET /api/account, which reads Orgo with your key
 * on the server; paying for Pro or Max, and managing it, happen in the browser.
 */

/** The initials on the avatar: the Orgo name, else the email, else the name in Settings. */
export function initialsOf(state: AppState) {
  const u = state.account?.user;
  const from = u?.name?.trim() || state.owner?.name.trim() || u?.email?.split("@")[0] || "";
  const parts = from.split(/[\s._-]+/).filter(Boolean);
  return ((parts[0]?.[0] ?? "") + (parts.length > 1 ? parts[parts.length - 1][0] : (parts[0]?.[1] ?? ""))).toUpperCase() || "?";
}

/** Sign out of Orgo on this Mac (the route clears the key from the Keychain), asking first when changes haven't reached Bops Cloud. */
export const signOutOfOrgo = async () => {
  const res = await signOutAsking();
  await refreshState();
  return res;
};

const compact = (n: number) => new Intl.NumberFormat(undefined, { notation: "compact", maximumFractionDigits: n < 10_000 ? 0 : 1 }).format(n);
const hours = (h: number) => (h < 10 ? h.toFixed(1).replace(/\.0$/, "") : Math.round(h).toLocaleString());
const day = (t: number) => new Date(t).toLocaleDateString(undefined, { month: "short", day: "numeric" });
const money = (cents: number, currency = "usd") =>
  new Intl.NumberFormat(undefined, { style: "currency", currency: currency.toUpperCase(), minimumFractionDigits: cents % 100 ? 2 : 0 }).format(cents / 100);

export function Account({ state, onClose, onThisMac }: { state: AppState; onClose: () => void; onThisMac?: () => void }) {
  const [info, setInfo] = useState<AccountInfo | null>(null);
  const [loading, setLoading] = useState(true);
  // The route itself failed (not Orgo): the sections say so and offer a retry, not a spinner forever.
  const [failed, setFailed] = useState(false);
  const fetchInfo = useCallback(() => {
    void fetch("/api/account", { cache: "no-store" })
      .then((r) => (r.ok ? (r.json() as Promise<AccountInfo>) : Promise.reject(new Error(`account ${r.status}`))))
      .then((j) => {
        setInfo(j);
        setFailed(false);
      })
      .catch(() => setFailed(true))
      .finally(() => setLoading(false));
  }, []);
  useEffect(fetchInfo, [fetchInfo]);
  // Back from paying or managing the plan in the browser: read it again.
  useEffect(() => {
    window.addEventListener("focus", fetchInfo);
    return () => window.removeEventListener("focus", fetchInfo);
  }, [fetchInfo]);
  const load = () => {
    setLoading(true);
    fetchInfo();
  };
  // The Bops plan read again on its own (after adding credit): the balance shows it.
  const setBops = useCallback((bops: BopsPlan) => setInfo((i) => (i ? { ...i, bops } : i)), []);

  // The header shows at once from the app's state; the rest fills in when the route answers.
  const user = info?.user ?? state.account?.user ?? null;
  const name = user?.name?.trim() || state.owner?.name.trim() || user?.email?.split("@")[0] || "You";
  const signOut = async () => {
    await signOutOfOrgo();
    onClose();
  };

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/20 backdrop-blur-[2px]" onClick={onClose}>
      <div onClick={(e) => e.stopPropagation()} className="flex max-h-[90vh] w-[760px] flex-col overflow-y-auto rounded-[22px] bg-white shadow-[0_0_0_1px_#0000000F,0_30px_70px_-28px_#00000038]">
        <div className="flex items-center gap-3.5 border-b border-[#F0F0EE] px-[22px] py-[18px]">
          <span className="flex size-12 shrink-0 items-center justify-center rounded-full bg-ink text-[16px] font-semibold tracking-[0.02em] text-highlighter">{initialsOf(state)}</span>
          <div className="flex min-w-0 flex-1 flex-col gap-0.5">
            <span className="truncate text-[18px] font-semibold leading-[22px]">{name}</span>
            <span className="truncate text-[13px] leading-[17px] text-[#6B6B6B]">
              {user ? (user.email ?? "Signed in with Orgo") : "Not signed in"}
              {user && info?.signedInAt ? <span className="text-[#9A9A98]"> · on this Mac since {day(info.signedInAt)}</span> : null}
            </span>
          </div>
          <button onClick={onClose} aria-label="Close" className="flex size-8 shrink-0 items-center justify-center rounded-full shadow-[0_0_0_1px_#E6E6E3]">
            <svg width="12" height="12" viewBox="0 0 12 12">
              <path d="M2 2l8 8M10 2l-8 8" fill="none" stroke="#0A0A0A" strokeWidth="1.6" strokeLinecap="round" />
            </svg>
          </button>
        </div>

        {/* Every signed-in user has a Bops plan: Free until Orgo says Pro or Max. */}
        {user && (info || (failed && !loading) ? <YourPlan plan={info?.bops} known={!!info} onPlan={setBops} userId={user.id} /> : <Placeholder title="Your plan" />)}
        {info ? (
          <Usage info={info} />
        ) : failed && !loading ? (
          <Section title="Bops usage">
            <LoadFailed onRetry={load} />
          </Section>
        ) : (
          <Placeholder title="Bops usage" />
        )}
        {info && <Reach info={info} />}

        <div className="flex items-center justify-between gap-3 px-[22px] pb-5 pt-5">
          <span className="text-[12px] leading-4 text-[#9A9A98]">
            Your Bops computer is free. AI credit pays for what your bots do, at cost.
            {onThisMac && (
              <>
                {" "}
                <button onClick={onThisMac} className="underline underline-offset-2 hover:text-ink">
                  Permissions on this Mac
                </button>
              </>
            )}
          </span>
          {user && (
            <button onClick={() => void signOut()} className="shrink-0 rounded-full px-3 py-1.5 text-[12.5px] font-medium leading-4 text-[#3A3A38] shadow-[0_0_0_1px_#E6E6E3] hover:text-[#B42318]">
              Sign out
            </button>
          )}
        </div>
      </div>
    </div>
  );
}

function Section({ title, aside, children }: { title: string; aside?: React.ReactNode; children: React.ReactNode }) {
  return (
    <div className="flex flex-col gap-2 px-[22px] pt-[18px]">
      <div className="flex min-h-6 items-center justify-between gap-3">
        <span className="text-[13px] font-semibold">{title}</span>
        {aside}
      </div>
      {children}
    </div>
  );
}

function Placeholder({ title }: { title: string }) {
  return (
    <Section title={title}>
      <div className="flex h-[92px] items-center justify-center rounded-[14px] shadow-[0_0_0_1px_#E6E6E3]">
        <Spinner size={16} color="#9A9A98" />
      </div>
    </Section>
  );
}

/* ---------------- Your plan ---------------- */

/** Micro-dollars as money, rounded down to the cent (none below 0). */
const credit = (micros: number) => money(Math.max(0, Math.floor(micros / 10_000)));

/** Bops' three plans, as the sheet lists them (lib/plan-includes.ts, the same words as bops.bot). */
const PLANS = PLAN_CARDS;
const RANK: Record<BopsTier, number> = { free_bops: 0, pro_bops: 1, max_bops: 2 };

type Open = "pro_bops" | "max_bops" | "manage";

/**
 * The Bops plan: Free, Pro or Max, with the user's marked. AI credit pays for what the bots do (models,
 * calls, texts) at what it costs Orgo. `plan` is orgo-web's answer (GET /api/bops/plan); without one
 * (Orgo has no Bops plans yet, or didn't answer) the user is on Free, and the balance isn't shown.
 * `known` is false when the account itself didn't load: no plan is marked then. Upgrading opens
 * Stripe's checkout, and Manage plan Stripe's billing page, in the browser; the sheet reads the plan
 * again when Bops comes back to the front. On every plan, AI credit can be added once under the
 * balance (AddCredit); `onPlan` takes the plan read again after that.
 */
function YourPlan({ plan, known, onPlan, userId }: { plan: BopsPlan | null | undefined; known: boolean; onPlan: (plan: BopsPlan) => void; userId: string }) {
  const [busy, setBusy] = useState<Open | null>(null);
  // What the last button said, under it: "Upgrades open soon." is a note, anything else an error.
  const [said, setSaid] = useState<{ what: Open; text: string; soon: boolean } | null>(null);
  const current: BopsTier | null = known ? (plan?.tier ?? "free_bops") : null;
  /** Open Orgo's page for it in the browser: checkout for a plan, or the billing page. */
  const open = async (what: Open) => {
    setBusy(what);
    setSaid(null);
    try {
      const res = await fetch(what === "manage" ? "/api/account/manage" : "/api/account/checkout", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: what === "manage" ? "{}" : JSON.stringify({ tier: what }),
      });
      const j = (await res.json().catch(() => ({}))) as { url?: string; error?: string; soon?: boolean };
      if (j.url) window.open(j.url, "_blank");
      else if (j.soon) setSaid({ what, text: "Upgrades open soon.", soon: true });
      else setSaid({ what, text: j.error ?? "Couldn't open that page. Try again in a minute.", soon: false });
    } catch {
      setSaid({ what, text: "Couldn't open that page. Try again in a minute.", soon: false });
    } finally {
      setBusy(null);
    }
  };
  const pill = "rounded-full px-3 py-1.5 text-[12.5px] font-medium leading-4 disabled:opacity-50";
  /** The button on a plan's card: Upgrade above the user's plan, Manage plan on a paid one they have. */
  const action = (tier: BopsTier): { what: Open; label: string; primary: boolean } | null => {
    if (tier === "free_bops") return null;
    if (current === tier) return { what: "manage", label: "Manage plan", primary: false };
    if (current && RANK[tier] < RANK[current]) return null;
    const next = current ? RANK[tier] === RANK[current] + 1 : tier === "pro_bops";
    return { what: tier, label: `Upgrade to ${tier === "pro_bops" ? "Pro" : "Max"}`, primary: next };
  };
  return (
    <Section title="Your plan">
      {plan && <Balance plan={plan} onPlan={onPlan} userId={userId} />}
      {plan && <ComputerTime plan={plan} />}
      <div className="grid grid-cols-3 gap-2">
        {PLANS.map((p) => {
          const mine = current === p.tier;
          const a = action(p.tier);
          return (
            <div key={p.tier} className={`flex flex-col gap-3 rounded-[14px] p-4 ${mine ? "shadow-[0_0_0_1.5px_#0A0A0A]" : "shadow-[0_0_0_1px_#E6E6E3]"}`}>
              <div className="flex flex-col gap-1">
                <span className="flex min-h-5 items-center justify-between gap-2">
                  <span className="text-[13px] font-semibold leading-5">{p.name}</span>
                  {mine && <span className="rounded-full bg-[#F2F2F0] px-2 py-0.5 text-[11px] font-medium leading-4 text-[#3A3A38]">Current</span>}
                </span>
                <span className="flex items-baseline gap-0.5">
                  <span className="text-[24px] font-semibold leading-7 tracking-[-0.02em] tabular-nums">{p.price}</span>
                  {p.per && <span className="text-[12.5px] text-[#6B6B6B]">{p.per}</span>}
                </span>
              </div>
              {/* How many computers the plan includes, before anything else it does (paper, not highlighter: yellow only marks what needs you). */}
              <div className="flex items-start gap-2 rounded-[10px] bg-[#F7F7F6] px-2.5 py-2">
                <svg width="16" height="16" viewBox="0 0 20 20" className="mt-px shrink-0" aria-hidden>
                  <rect x="2" y="3" width="16" height="11" rx="2" fill="none" stroke="#0A0A0A" strokeWidth="1.6" />
                  <path d="M7 17.5h6M10 14v3.5" fill="none" stroke="#0A0A0A" strokeWidth="1.6" strokeLinecap="round" />
                </svg>
                <span className="flex min-w-0 flex-col gap-0.5">
                  <span className="text-[13px] font-semibold leading-[18px] text-ink">{p.computers.title}</span>
                  <span className="text-[12px] leading-4 text-[#3A3A38]">{p.computers.detail}</span>
                </span>
              </div>
              <ul className="flex flex-1 flex-col gap-1">
                {p.lines.map((line) => (
                  <li key={line.text} className={`flex items-start gap-1.5 text-[12.5px] leading-[18px] ${line.no ? "text-[#8A8A88]" : "text-[#3A3A38]"}`}>
                    {/* A check for what the plan includes, a dash for what it doesn't. */}
                    <svg width="12" height="12" viewBox="0 0 12 12" className="mt-[3px] shrink-0" aria-hidden>
                      {line.no ? (
                        <path d="M3 6h6" fill="none" stroke="#C9C9C6" strokeWidth="1.5" strokeLinecap="round" />
                      ) : (
                        <path d="M2.5 6.2l2.3 2.3 4.7-5" fill="none" stroke="#9A9A98" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round" />
                      )}
                    </svg>
                    {line.text}
                  </li>
                ))}
              </ul>
              {a && (
                <div className="flex flex-col gap-1.5">
                  <button
                    disabled={!!busy}
                    onClick={() => void open(a.what)}
                    className={`${pill} w-full ${a.primary ? "bg-ink text-white" : "bg-[#F2F2F0] hover:bg-[#EAEAE7]"}`}
                  >
                    {busy === a.what ? "Opening…" : a.label}
                  </button>
                  {said?.what === a.what && <span className={`text-center text-[12px] leading-4 ${said.soon ? "text-[#6B6B6B]" : "text-[#B42318]"}`}>{said.text}</span>}
                </div>
              )}
            </div>
          );
        })}
      </div>
    </Section>
  );
}

/**
 * On Free, the free Bops computer's month (orgo-web lib/bops-free-hours.ts): how long it ran of its 10 hours,
 * and when it starts over, in lib/plan-includes.ts freeHoursWords' words (no period named, from an Orgo that
 * still counts by the week). It sleeps when nothing uses it, so only the time it's used counts. Only when Orgo said.
 */
function ComputerTime({ plan }: { plan: BopsPlan }) {
  if (!plan.computerTime) return null;
  const w = freeHoursWords(plan.computerTime);
  return (
    <div className="flex items-center gap-4 rounded-[14px] p-4 shadow-[0_0_0_1px_#E6E6E3]">
      <span className="min-w-0 flex-1 text-[12.5px] leading-[18px] text-[#6B6B6B]">{w.note}</span>
      <div className="flex shrink-0 flex-col items-end gap-1">
        <span className="text-[24px] font-semibold leading-7 tracking-[-0.02em] tabular-nums">{w.amount}</span>
        <span className="text-[12.5px] leading-[18px] text-[#6B6B6B]">{w.label}</span>
      </div>
    </div>
  );
}

/**
 * The AI credit left, from Orgo's own numbers, and what to know about the paid month. Only what Orgo
 * said: no numbers, no balance. Under it, a way to add credit once (AddCredit), when Orgo sells it.
 */
function Balance({ plan, onPlan, userId }: { plan: BopsPlan; onPlan: (plan: BopsPlan) => void; userId: string }) {
  const topUp = useTopUp(onPlan);
  const canAdd = !!topUp.info && !topUp.info.off;
  const c = plan.credit;
  const paid = plan.tier !== "free_bops";
  const monthly = plan.tier === "max_bops" ? 200_000_000 : 20_000_000;
  // Credit added once is kept with what's left of the one-time $5: neither expires.
  const added = !!c && (c.topUps === true || c.freeLeftMicros > 5_000_000);
  const line =
    paid && plan.status === "past_due"
      ? "Payment failed. Update your card in Manage plan."
      : !c
        ? paid && plan.cancelAtPeriodEnd && plan.periodEnd
          ? `Your plan ends ${day(plan.periodEnd)}.`
          : ""
        : !paid
          ? added
            ? "Includes credit you added, which doesn't expire."
            : `${credit(c.freeLeftMicros)} left of your one-time $5.`
          : [
              `${credit(c.planLeftMicros)} of ${credit(monthly)} left${c.resetsAt ? `, resets ${day(c.resetsAt)}` : ""}.`,
              c.freeLeftMicros > 0 ? (added ? `Plus ${credit(c.freeLeftMicros)} that doesn't expire.` : `Plus ${credit(c.freeLeftMicros)} of your one-time $5.`) : "",
              plan.cancelAtPeriodEnd && plan.periodEnd ? `Ends ${day(plan.periodEnd)}.` : "",
            ]
              .filter(Boolean)
              .join(" ");
  if (!c && !line && !canAdd) return null;
  return (
    <div className="flex flex-col rounded-[14px] shadow-[0_0_0_1px_#E6E6E3]">
      <div className="flex items-center gap-4 p-4">
        <span className="min-w-0 flex-1 text-[12.5px] leading-[18px] text-[#6B6B6B]">{line}</span>
        {c && (
          <div className="flex shrink-0 flex-col items-end gap-1" data-tip="AI credit pays for what your bots do, at what it costs Orgo">
            <span className="text-[24px] font-semibold leading-7 tracking-[-0.02em] tabular-nums">{credit(c.leftMicros)}</span>
            <span className="text-[12.5px] leading-[18px] text-[#6B6B6B]">AI credit left</span>
          </div>
        )}
      </div>
      {c && c.leftMicros <= 0 && (
        <span className="border-t border-[#F0F0EE] px-4 py-3 text-[12.5px] leading-[18px] text-[#3A3A38]">
          You&apos;re out of AI credit, so your bots are paused.
          {canAdd ? " Add credit below to keep them going." : paid ? " It comes back when your plan renews, or upgrade for more." : " Upgrade to keep them going."}
        </span>
      )}
      {canAdd && <AddCredit plan={plan} topUp={topUp} onPlan={onPlan} userId={userId} />}
    </div>
  );
}

/* ---------------- Adding AI credit once ---------------- */

/** The Bops plan, asked of Orgo again now (GET /api/plan?fresh=1): null when it didn't say. */
async function freshPlan(): Promise<BopsPlan | null> {
  try {
    const res = await fetch("/api/plan?fresh=1", { cache: "no-store" });
    if (!res.ok) return null;
    return ((await res.json()) as { bops?: BopsPlan | null }).bops ?? null;
  } catch {
    return null;
  }
}

/**
 * What the sheet knows about adding AI credit (GET /api/account/credit): null until it answers, then
 * whether it can be added here, the card on file and the payments whose credit is on its way. While
 * one is, it's asked again now and then, and the balance is read again once the credit is in.
 */
function useTopUp(onPlan: (plan: BopsPlan) => void) {
  const [info, setInfo] = useState<TopUpInfo | null>(null);
  // Counts purchase answers: a read that started before one knows less than the sheet does, so it's dropped.
  const answers = useRef(0);
  const read = useCallback(async (): Promise<TopUpInfo | null> => {
    const since = answers.current;
    let next: TopUpInfo;
    try {
      const res = await fetch("/api/account/credit", { cache: "no-store" });
      next = topUpFrom(res.status, await res.json().catch(() => null));
    } catch {
      next = topUpFrom(0, null);
    }
    if (since !== answers.current) return null;
    setInfo((was) => mergeTopUp(was, next));
    return next;
  }, []);
  const answered = useCallback(() => void (answers.current += 1), []);
  useEffect(() => void read(), [read]);
  const pending = !!info && !info.off && !!info.pending?.length;
  useEffect(() => {
    if (!pending) return;
    const every = setInterval(() => void read(), 30_000);
    return () => clearInterval(every);
  }, [pending, read]);
  // It's in: the balance shows it.
  const hadPending = useRef(pending);
  useEffect(() => {
    if (hadPending.current && !pending) void freshPlan().then((p) => p && onPlan(p));
    hadPending.current = pending;
  }, [pending, onPlan]);
  return { info, setInfo, read, answered };
}

type TopUp = ReturnType<typeof useTopUp>;

/**
 * A purchase on the card whose answer never came (it may have charged), kept while the window is open
 * though the sheet closes: the next Add credit tries it again under its own key instead of a new one.
 */
let kept: { user: string; purchase: CardPurchase } | null = null;
const keep = (user: string, purchase: CardPurchase | null) => void (kept = purchase?.unresolved ? { user, purchase } : null);

/** The line under Add credit: what happened last. */
type Note =
  | { kind: "added"; cents: number }
  | { kind: "pending"; cents: number; code: PendingTopUp["code"]; from?: number }
  | { kind: "checkout"; cents: number; from?: number }
  | { kind: "error"; text: string }
  | { kind: "off" };

/**
 * Add AI credit once, under the balance: $20, $50, $100 or a whole-dollar amount from $5 to $1,000,
 * the way Orgo's own Add credit works (lib/credit-topup.ts). With a card on file it asks first
 * (ConfirmCredit) and charges that card; without one, or when the card can't be charged, Stripe Checkout
 * opens in the browser. Then the plan is read again until the new credit shows, for 2 minutes at most
 * (and the sheet reads it again when Bops comes back to the front). Never monthly, never an automatic
 * reload.
 */
function AddCredit({ plan, topUp, onPlan, userId }: { plan: BopsPlan; topUp: TopUp; onPlan: (plan: BopsPlan) => void; userId: string }) {
  const { info, setInfo, read, answered } = topUp;
  const [choice, setChoice] = useState<number | "other" | null>(null);
  const [other, setOther] = useState("");
  /** The purchase on the card, from Add credit until a definite answer. An unresolved one outlives Cancel. */
  const [purchase, setPurchase] = useState<CardPurchase | null>(() => {
    const k = kept;
    return k && k.user === userId ? k.purchase : null;
  });
  const [open, setOpen] = useState(false);
  const [paying, setPaying] = useState(false);
  const [opening, setOpening] = useState(false);
  const [note, setNote] = useState<Note | null>(null);
  const [checkoutError, setCheckoutError] = useState<string | null>(null);
  /** Reading the plan again after a purchase: from the balance before it. */
  const [poll, setPoll] = useState<{ from?: number } | null>(null);
  const sending = useRef(false);
  const left = plan.credit?.leftMicros;
  const cents = choice === "other" ? typedCents(other) : choice;
  const resumable = !!purchase && !open;
  const busy = paying || opening;

  // Until the new credit shows (or 2 minutes), the plan is read again: soon at first, then every 5 seconds.
  useEffect(() => {
    if (!poll) return;
    let stop = false;
    let timer: ReturnType<typeof setTimeout> | undefined;
    const until = Date.now() + POLL_FOR_MS;
    const tick = async (reads: number) => {
      const bops = await freshPlan();
      if (stop) return;
      if (bops) onPlan(bops);
      if (creditLanded(poll.from, bops?.credit?.leftMicros) || Date.now() >= until) return;
      timer = setTimeout(() => void tick(reads + 1), pollDelay(reads));
    };
    void tick(0);
    return () => {
      stop = true;
      clearTimeout(timer);
    };
  }, [poll, onPlan]);

  const pick = (c: number | "other") => {
    setChoice(c);
    if (c !== "other") setOther("");
    setNote((n) => (n?.kind === "error" ? null : n));
  };

  /** Stripe Checkout for `amount`, in the browser: without a card on file, or when the card couldn't. */
  const checkout = async (amount: number) => {
    const fromConfirm = open;
    setOpening(true);
    setCheckoutError(null);
    const from = left;
    let said: { url?: unknown; error?: unknown; code?: unknown } = {};
    try {
      const res = await fetch("/api/account/credit", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ amount_cents: amount }) });
      said = await res.json().catch(() => ({}));
    } catch {
      said = {};
    } finally {
      setOpening(false);
    }
    if (typeof said.url === "string") {
      window.open(said.url, "_blank");
      keep(userId, null);
      setPurchase(null);
      setOpen(false);
      setChoice(null);
      setOther("");
      setNote({ kind: "checkout", cents: amount, from });
      setPoll({ from });
      return;
    }
    if (said.code === "bops_credit_off") {
      keep(userId, null);
      setPurchase(null);
      setOpen(false);
      setNote({ kind: "off" });
      return;
    }
    const text = typeof said.error === "string" && said.error ? said.error : "Couldn't open checkout. Try again in a minute.";
    if (fromConfirm) setCheckoutError(text);
    else setNote({ kind: "error", text });
  };

  // The confirm names the card it charges, so the card on file is read again as it opens: it may have changed elsewhere.
  const recheck = () =>
    void read().then((got) => {
      if (got && !got.off && !got.unknown) setPurchase((p) => (p ? cardRechecked(p, got.card) : p));
    });

  // With a card on file, Add credit asks once and charges it; without one, Checkout. A purchase whose
  // answer never came opens again instead: tried again under its own key it can't charge twice, and a
  // new one could.
  const buy = async () => {
    if (purchase && !open) {
      const step = resumePurchase(purchase);
      if (step.kind === "stop") {
        keep(userId, null);
        setPurchase(null);
        setNote({ kind: "error", text: step.message });
        return;
      }
      setCheckoutError(null);
      setOpen(true);
      recheck();
      return;
    }
    if (!cents || !info || info.off) return;
    setNote((n) => (n?.kind === "error" ? null : n));
    let card = info.card;
    if (info.unknown) {
      // The card couldn't be looked up when the sheet opened: look again before choosing how to pay.
      setOpening(true);
      const got = await read();
      setOpening(false);
      if (got?.off) return;
      card = got && !got.off ? got.card : null;
    }
    if (!card) return void checkout(cents);
    setCheckoutError(null);
    setPurchase(newPurchase(cents, card));
    setOpen(true);
    if (!info.unknown) recheck();
  };

  const pay = async () => {
    if (!purchase || sending.current) return;
    if (purchase.fallback !== null) return void checkout(purchase.cents);
    sending.current = true;
    setPaying(true);
    setCheckoutError(null);
    const from = left;
    // Until it's answered it may charge: kept as unconfirmed, so a sheet closed meanwhile tries it again rather than start another.
    keep(userId, beingSent(purchase));
    let next: TopUpNext;
    try {
      const res = await fetch("/api/account/credit", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ amount_cents: purchase.cents, card_handle: purchase.card.handle, idempotency_key: purchase.key }),
      });
      next = topUpNext(res.status, await res.json().catch(() => null));
    } catch {
      next = TOPUP_UNREACHABLE;
    } finally {
      sending.current = false;
      setPaying(false);
    }
    answered();
    if (next.kind === "card_changed") {
      const card = next.card;
      setInfo((i) => (i && !i.off ? { ...i, card } : i));
    }
    const step = afterAnswer(purchase, next);
    keep(userId, step.kind === "open" ? step.purchase : null);
    if (step.kind === "open") return void setPurchase(step.purchase);
    setPurchase(null);
    setOpen(false);
    if (step.kind === "stop") return void setNote({ kind: "error", text: step.message });
    if (step.kind === "off") return void setNote({ kind: "off" });
    setChoice(null);
    setOther("");
    setNote(step.kind === "pending" ? { kind: "pending", cents: purchase.cents, code: step.pending.code, from } : { kind: "added", cents: purchase.cents });
    setPoll({ from });
  };

  const cancel = () => {
    if (busy) return;
    setOpen(false);
    setCheckoutError(null);
    setPurchase(afterCancel);
  };

  if (note?.kind === "off") return <span className="border-t border-[#F0F0EE] px-4 py-3 text-[12.5px] leading-[18px] text-[#6B6B6B]">Adding credit opens soon.</span>;

  // Credit the balance shows is in, however it was paid.
  const shown: Note | null = note && (note.kind === "pending" || note.kind === "checkout") && creditLanded(note.from, left) ? { kind: "added", cents: note.cents } : note;
  const pendingText = !info || info.off || !info.pending ? null : pendingNote(info.pending);
  const say: { text: string; tone: "muted" | "good" | "bad" } =
    resumable && purchase
      ? { text: `Your ${dollars(purchase.cents)} payment isn't confirmed yet.`, tone: "bad" }
      : choice === "other" && other !== "" && !cents
        ? { text: "Whole dollars, from $5 to $1,000.", tone: "muted" }
        : shown?.kind === "added"
          ? { text: `Added ${dollars(shown.cents)} of AI credit.`, tone: "good" }
          : shown?.kind === "pending"
            ? { text: pendingNote([{ cents: shown.cents, code: shown.code }]) ?? "", tone: "muted" }
            : shown?.kind === "checkout"
              ? { text: "Finish paying in your browser. Your credit shows up here.", tone: "muted" }
              : shown?.kind === "error"
                ? { text: shown.text, tone: "bad" }
                : { text: pendingText ?? "Charged once, not monthly.", tone: "muted" };
  const chip = "rounded-full px-3 py-1.5 text-[12.5px] font-medium leading-4 tabular-nums disabled:opacity-50";
  return (
    <div className="flex flex-col gap-2 border-t border-[#F0F0EE] px-4 py-3">
      <div className="flex flex-wrap items-center gap-2">
        <span className="mr-1 text-[12.5px] font-medium leading-4 text-[#3A3A38]">Add AI credit</span>
        {TOPUP_PRESETS.map((p) => (
          <button
            key={p}
            type="button"
            aria-pressed={choice === p}
            disabled={busy}
            onClick={() => pick(p)}
            className={`${chip} ${choice === p ? "bg-white shadow-[0_0_0_1.5px_#0A0A0A]" : "shadow-[0_0_0_1px_#E6E6E3] hover:bg-[#F7F7F6]"}`}
          >
            {dollars(p)}
          </button>
        ))}
        <label
          className={`flex h-7 w-[92px] cursor-text items-center gap-0.5 rounded-full px-3 text-[12.5px] font-medium leading-4 ${choice === "other" ? "bg-white shadow-[0_0_0_1.5px_#0A0A0A]" : "bg-[#F7F7F6] shadow-[0_0_0_1px_#E6E6E3]"}`}
        >
          <span className={choice === "other" && other ? "text-ink" : "text-[#9A9A98]"}>$</span>
          <input
            value={other}
            disabled={busy}
            onFocus={() => pick("other")}
            onChange={(e) => {
              setOther(tidyDollars(e.target.value));
              pick("other");
            }}
            onKeyDown={(e) => {
              if (e.key === "Enter" && cents && !busy) void buy();
            }}
            placeholder="Other"
            inputMode="numeric"
            autoComplete="off"
            aria-label="Other amount, in whole dollars"
            className="w-full min-w-0 bg-transparent tabular-nums text-ink outline-none placeholder:font-normal placeholder:text-[#9A9A98]"
          />
        </label>
        <span className="flex-1" />
        <button
          type="button"
          disabled={(!cents && !resumable) || busy}
          onClick={() => void buy()}
          className="rounded-full bg-ink px-3 py-1.5 text-[12.5px] font-medium leading-4 text-white disabled:opacity-40"
        >
          {opening && !open ? "Opening…" : resumable ? "Try again" : "Add credit"}
        </button>
      </div>
      <span className={`flex items-center gap-1.5 text-[12px] leading-4 ${say.tone === "bad" ? "text-[#B42318]" : say.tone === "good" ? "text-[#1F7A4D]" : "text-[#9A9A98]"}`}>
        {say.tone === "good" && <span className="size-[7px] shrink-0 rounded-full bg-[#2BB673]" />}
        {say.text}
      </span>
      {open && purchase && (
        <ConfirmCredit purchase={purchase} busy={busy} error={checkoutError} onPay={() => void pay()} onOtherWay={() => void checkout(purchase.cents)} onCancel={cancel} />
      )}
    </div>
  );
}

/**
 * "Add $50 of AI credit? Charged once to Visa ending 4242.", over everything (the sheet too), like
 * Restart Bops. Nothing is charged until Pay. A card the bank wants to confirm, or one it declines,
 * charges nothing and turns this into the way to Checkout for the same amount. While an answer is
 * missing there's no other way to pay, and Cancel keeps the purchase for Add credit.
 */
function ConfirmCredit({
  purchase,
  busy,
  error,
  onPay,
  onOtherWay,
  onCancel,
}: {
  purchase: CardPurchase;
  busy: boolean;
  error: string | null;
  onPay: () => void;
  onOtherWay: () => void;
  onCancel: () => void;
}) {
  useEffect(() => {
    // Escape cancels this alone, not the sheet under it (the app closes its sheets on Escape, on window).
    const esc = (e: KeyboardEvent) => {
      if (e.key !== "Escape") return;
      e.stopPropagation();
      if (!busy) onCancel();
    };
    document.addEventListener("keydown", esc);
    return () => document.removeEventListener("keydown", esc);
  }, [busy, onCancel]);
  const copy = confirmCopy(purchase);
  const warning = error ?? copy.error;
  const pill = "rounded-full px-3.5 py-1.5 text-[13px] font-medium leading-4 disabled:opacity-50";
  return createPortal(
    <div className="fixed inset-0 z-[70] flex items-center justify-center bg-black/20 backdrop-blur-[2px]" onClick={() => !busy && onCancel()}>
      <div
        role="alertdialog"
        aria-labelledby="add-credit-title"
        aria-describedby="add-credit-line"
        onClick={(e) => e.stopPropagation()}
        className="flex w-[340px] flex-col rounded-[18px] bg-white p-5 shadow-[0_0_0_1px_#0000000F,0_30px_70px_-28px_#00000038]"
      >
        <span id="add-credit-title" className="text-[15px] font-semibold leading-5">
          {copy.title}
        </span>
        <span id="add-credit-line" className="pt-1 text-[13px] leading-[18px] text-[#6B6B6B]">
          {copy.line}
        </span>
        {warning && (
          <span role="alert" className="pt-2 text-[12.5px] leading-[18px] text-[#B42318]">
            {warning}
          </span>
        )}
        <div className="flex items-center justify-end gap-2 pt-5">
          {copy.otherWay && (
            <button disabled={busy} onClick={onOtherWay} className="mr-auto text-[12.5px] font-medium leading-4 text-[#6B6B6B] hover:text-ink disabled:opacity-50">
              Pay another way
            </button>
          )}
          <button disabled={busy} onClick={onCancel} className={`${pill} bg-[#F2F2F0] hover:bg-[#EAEAE7]`}>
            Cancel
          </button>
          <button autoFocus disabled={busy} onClick={onPay} className={`${pill} flex min-w-[76px] items-center justify-center bg-ink text-white`}>
            {busy ? <Spinner size={12} color="#FFFFFF" /> : copy.confirmLabel}
          </button>
        </div>
      </div>
    </div>,
    document.body,
  );
}

function LoadFailed({ onRetry }: { onRetry: () => void }) {
  return (
    <Notice
      action={
        <button onClick={onRetry} className="rounded-full bg-[#F2F2F0] px-3 py-1.5 text-[12.5px] font-medium leading-4 hover:bg-[#EAEAE7]">
          Try again
        </button>
      }
    >
      Couldn&apos;t load your account.
    </Notice>
  );
}

function Notice({ children, action }: { children: React.ReactNode; action?: React.ReactNode }) {
  return (
    <div className="flex items-center gap-3 rounded-[14px] p-3.5 shadow-[0_0_0_1px_#E6E6E3]">
      <span className="flex-1 text-[12.5px] leading-[18px] text-[#3A3A38]">{children}</span>
      {action}
    </div>
  );
}

/* ---------------- Usage ---------------- */

const SOURCES: { id: TokenSource; label: string }[] = [
  { id: "chat", label: "Chats" },
  { id: "session", label: "Tasks" },
  { id: "call", label: "Calls" },
  { id: "memory", label: "Memory" },
  { id: "decide", label: "Quick checks" },
  { id: "other", label: "Other" },
];

/** What AI credit paid for, by kind, and how much of each it was. */
const SPEND: Record<SpendKind, { label: string; amount: (n: number) => string }> = {
  chat: { label: "Chats", amount: (n) => `${compact(n)} tokens` },
  session: { label: "Tasks", amount: (n) => `${compact(n)} tokens` },
  search: { label: "Web searches", amount: (n) => `${compact(n)} ${n === 1 ? "search" : "searches"}` },
  call: { label: "Calls", amount: (n) => `${hours(n)} min` },
  memory: { label: "Memory", amount: (n) => `${compact(n)} tokens` },
  decide: { label: "Quick checks", amount: (n) => `${compact(n)} ${n === 1 ? "check" : "checks"}` },
  text: { label: "Texts", amount: (n) => `${compact(n)} ${n === 1 ? "text" : "texts"}` },
  number: { label: "Numbers", amount: (n) => `${compact(n)} bought` },
  code: { label: "Codes", amount: (n) => `${compact(n)} sent` },
  app: { label: "Apps", amount: (n) => `${compact(n)} ${n === 1 ? "action" : "actions"}` },
  data: { label: "Business data", amount: (n) => `${compact(n)} ${n === 1 ? "lookup" : "lookups"}` },
  other: { label: "Other", amount: (n) => compact(n) },
};

/** Micro-dollars as money: to the cent, and a little under one cent as "<$0.01". */
const spent = (micros: number) => (micros <= 0 ? "$0" : micros < 10_000 ? "<$0.01" : money(Math.round(micros / 10_000)));

/** What Bops itself used, this month or last: totals, AI credit spent by kind, model use by day, by kind of work and by bot. */
function Usage({ info }: { info: AccountInfo }) {
  const [last, setLast] = useState(false);
  const t = last ? info.usage.lastMonth : info.usage.thisMonth;
  const start = last ? info.usage.lastMonthStart : info.usage.monthStart;
  const month = (ts: number) => new Date(ts).toLocaleDateString(undefined, { month: "long" });
  const empty = !t.tokens && !t.callMinutes && !t.computersCreated && !t.phoneNumbers && !t.inboxes && !t.spend?.costMicros;
  const tabs = (
    <div className="flex rounded-full bg-[#F2F2F0] p-0.5">
      {[false, true].map((l) => (
        <button
          key={String(l)}
          onClick={() => setLast(l)}
          className={`rounded-full px-2.5 py-1 text-[12px] font-medium leading-4 ${last === l ? "bg-white text-ink shadow-[0_0_0_1px_#E6E6E3]" : "text-[#6B6B6B] hover:text-ink"}`}
        >
          {month(l ? info.usage.lastMonthStart : info.usage.monthStart)}
        </button>
      ))}
    </div>
  );
  const tiles: [string, number, string][] = [
    ["Model use", t.tokens, "tokens"],
    ["Calls", t.callMinutes, "minutes"],
    ["Computers", t.computersCreated, t.computersRemoved ? `made, ${t.computersRemoved} removed` : "made"],
    ["Numbers", t.phoneNumbers, "added"],
    ["Inboxes", t.inboxes, "added"],
  ];
  return (
    <Section title="Bops usage" aside={tabs}>
      <div className="grid grid-cols-5 gap-2">
        {tiles.map(([label, n, unit]) => (
          <div key={label} className="flex flex-col gap-1 rounded-[14px] px-3.5 py-3 shadow-[0_0_0_1px_#E6E6E3]">
            <span className="text-[12px] leading-4 text-[#6B6B6B]">{label}</span>
            <span className={`text-[20px] font-semibold leading-6 tracking-[-0.01em] tabular-nums ${n ? "text-ink" : "text-[#C9C9C6]"}`}>{compact(n)}</span>
            <span className="truncate text-[11.5px] leading-[14px] text-[#9A9A98]">{unit}</span>
          </div>
        ))}
      </div>
      {empty ? (
        <div className="rounded-[14px] px-4 py-5 text-center text-[12.5px] leading-[18px] text-[#9A9A98] shadow-[0_0_0_1px_#E6E6E3]">
          {last ? `Nothing in ${month(start)}.` : "Nothing yet this month. It adds up here as your bots work."}
        </div>
      ) : (
        <div className="flex flex-col rounded-[14px] shadow-[0_0_0_1px_#E6E6E3]">
          {t.spend && t.spend.parts.length > 0 && <Spend spend={t.spend} />}
          {t.tokens > 0 && <Days totals={t} start={start} current={!last} />}
          <div className={`grid grid-cols-2 ${t.tokens > 0 ? "border-t border-[#F0F0EE]" : ""}`}>
            <BySource totals={t} />
            <ByBot totals={t} />
          </div>
        </div>
      )}
    </Section>
  );
}

/**
 * What the month cost, by kind: the money, and how much of each it was (Bops Cloud's own count, at
 * cost). It's what AI credit paid for once the cloud takes it; until then the sheet says so.
 */
function Spend({ spend }: { spend: NonNullable<UsageTotals["spend"]> }) {
  const top = Math.max(...spend.parts.map((p) => p.costMicros), 1);
  return (
    <div className="flex flex-col gap-2.5 border-b border-[#F0F0EE] px-4 pb-3.5 pt-3.5">
      <span className="flex items-baseline justify-between gap-3 text-[12px] leading-4 text-[#6B6B6B]">
        <span>
          {spend.charged ? "AI credit used" : "What it cost"}
          {!spend.charged && <span className="text-[#9A9A98]"> · not taken from your AI credit yet</span>}
        </span>
        <span className="text-[13px] font-semibold tabular-nums text-ink">{spent(spend.costMicros)}</span>
      </span>
      <div className="grid grid-cols-2 gap-x-6 gap-y-2.5">
        {spend.parts.map((p) => (
          <Share key={p.id} label={SPEND[p.id].label} value={`${SPEND[p.id].amount(p.amount)} · ${spent(p.costMicros)}`} share={p.costMicros / top} />
        ))}
      </div>
    </div>
  );
}

/** Model use per day, one bar a day. Today is in ink; days still to come are a faint baseline. */
function Days({ totals: t, start, current }: { totals: UsageTotals; start: number; current: boolean }) {
  const max = Math.max(...t.tokensByDay, 1);
  const today = current ? new Date().getDate() - 1 : -1;
  const s = new Date(start);
  const date = (i: number) => new Date(s.getFullYear(), s.getMonth(), i + 1).getTime();
  return (
    <div className="flex flex-col gap-1.5 px-4 pb-3 pt-3.5">
      <span className="text-[12px] leading-4 text-[#6B6B6B]">Model use by day</span>
      <div className="flex h-[64px] items-end gap-[2px]">
        {t.tokensByDay.map((n, i) => {
          const future = current && i > today;
          return (
            <div key={i} data-tip={future ? undefined : `${day(date(i))}: ${n ? `${compact(n)} tokens` : "none"}`} className="flex h-full flex-1 items-end">
              <div
                className={`w-full rounded-t-[3px] ${future ? "h-px bg-[#ECECEA]" : i === today ? "bg-ink" : n ? "bg-[#BDBDBA] hover:bg-[#6B6B6B]" : "h-px bg-[#E2E2DF]"}`}
                style={n && !future ? { height: `${Math.max(6, (n / max) * 100)}%` } : undefined}
              />
            </div>
          );
        })}
      </div>
      <div className="flex justify-between text-[11px] leading-[14px] text-[#9A9A98] tabular-nums">
        <span>{day(date(0))}</span>
        <span>{day(date(t.tokensByDay.length - 1))}</span>
      </div>
    </div>
  );
}

/** A row with a thin bar for its share. */
function Share({ label, value, share, lead }: { label: string; value: string; share: number; lead?: React.ReactNode }) {
  return (
    <div className="flex flex-col gap-1">
      <span className="flex items-center gap-2 text-[12.5px] leading-4">
        {lead}
        <span className="min-w-0 flex-1 truncate text-[#3A3A38]">{label}</span>
        <span className="shrink-0 tabular-nums text-ink">{value}</span>
      </span>
      <span className="h-[3px] overflow-hidden rounded-full bg-[#F0F0EE]">
        <span className="block h-full rounded-full bg-ink" style={{ width: `${Math.round(share * 100)}%` }} />
      </span>
    </div>
  );
}

function BySource({ totals: t }: { totals: UsageTotals }) {
  const rows = SOURCES.map((s) => ({ ...s, n: t.tokensBySource[s.id] ?? 0 })).filter((s) => s.n > 0);
  return (
    <div className="flex flex-col gap-2.5 border-r border-[#F0F0EE] px-4 py-3.5">
      <span className="text-[12px] leading-4 text-[#6B6B6B]">Model use by kind of work</span>
      {rows.length ? (
        rows.map((s) => <Share key={s.id} label={s.label} value={compact(s.n)} share={s.n / t.tokens} />)
      ) : (
        <span className="text-[12.5px] text-[#9A9A98]">None this month</span>
      )}
    </div>
  );
}

function ByBot({ totals: t }: { totals: UsageTotals }) {
  const top = Math.max(...t.byBot.map((b) => b.tokens), 1);
  return (
    <div className="flex flex-col gap-2.5 px-4 py-3.5">
      <span className="text-[12px] leading-4 text-[#6B6B6B]">By bot</span>
      {t.byBot.length ? (
        t.byBot.slice(0, 6).map((b) => (
          <Share
            key={b.botId}
            label={b.name}
            lead={b.color ? <Mascot botId={b.botId} color={b.color} size={16} /> : <span className="size-4 rounded-full bg-[#E6E6E3]" />}
            value={
              [b.tokens && `${compact(b.tokens)} tokens`, b.callMinutes && `${hours(b.callMinutes)} min`].filter(Boolean).join(", ") ||
              `${b.computers} computer${b.computers === 1 ? "" : "s"}`
            }
            share={b.tokens / top}
          />
        ))
      ) : (
        <span className="text-[12.5px] text-[#9A9A98]">Nothing by a single bot</span>
      )}
    </div>
  );
}

/* ---------------- Inboxes and numbers ---------------- */

/** Where people reach your bots: each workspace's number, and each bot's own inbox (and number, if it has one). */
function Reach({ info }: { info: AccountInfo }) {
  const groups = info.reach.filter((w) => w.line || w.bots.some((b) => b.email || b.phone));
  return (
    <Section title="Your bots' inboxes and numbers">
      {groups.length ? (
        groups.map((w) => (
          <div key={w.id} className="flex flex-col rounded-[14px] shadow-[0_0_0_1px_#E6E6E3]">
            {(info.reach.length > 1 || w.line) && (
              <div className="flex items-center gap-2 border-b border-[#F0F0EE] px-3.5 py-2.5">
                <span className="text-[13px] font-medium">{w.name}</span>
                <span className="flex-1" />
                {w.line ? (
                  <span className="flex items-center gap-1.5 text-[12.5px] text-[#3A3A38]">
                    <span className="text-[#9A9A98]">Text or call {w.line.main ?? "the main bot"} at</span>
                    <Copy text={w.line.phone} />
                  </span>
                ) : (
                  <span className="text-[12.5px] text-[#9A9A98]">No number yet</span>
                )}
              </div>
            )}
            {w.bots
              .filter((b) => b.email || b.phone)
              .map((b) => (
                <div key={b.id} className="flex items-center gap-2.5 border-b border-[#F0F0EE] px-3.5 py-2 last:border-0">
                  <Mascot botId={b.id} color={b.color} size={20} />
                  <span className="w-[130px] truncate text-[13px] font-medium">{b.name}</span>
                  <span className="min-w-0 flex-1">{b.email ? <Copy text={b.email} /> : <span className="text-[12.5px] text-[#9A9A98]">No inbox yet</span>}</span>
                  {b.phone && <Copy text={b.phone} />}
                </div>
              ))}
          </div>
        ))
      ) : (
        <Notice>Your bots get an inbox when they first need one, and a workspace gets a number to text and call its main bot.</Notice>
      )}
    </Section>
  );
}

/** A value you can click to copy, saying so for a moment. */
function Copy({ text }: { text: string }) {
  const [copied, setCopied] = useState(false);
  return (
    <button
      data-tip={copied ? undefined : "Copy"}
      onClick={() => {
        void navigator.clipboard?.writeText(text).then(() => {
          setCopied(true);
          setTimeout(() => setCopied(false), 1200);
        });
      }}
      className="max-w-full truncate rounded-md px-1 py-0.5 text-left font-mono text-[12px] text-ink hover:bg-black/[0.04]"
    >
      {copied ? "Copied" : text}
    </button>
  );
}
