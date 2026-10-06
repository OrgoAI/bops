"use client";

import { useCallback, useEffect, useState } from "react";
import type { AccountInfo, BopsPlan, TokenSource, UsageTotals } from "@/lib/account";
import type { BopsTier } from "@/cloud/protocol";
import type { AppState } from "@/lib/types";
import { Mascot, Spinner } from "./mascot";
import { post } from "./ui";

/*
 * The account: who you are on Orgo, your Bops plan (Free, Pro or Max; an Orgo plan doesn't change it,
 * and everyone is on Free until they pay) and the AI credit left when Orgo says, what your bots used
 * this month and last, and the inboxes and numbers they have. A sheet
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

/** Sign out of Orgo on this Mac (the route clears the key from the Keychain). */
export const signOutOfOrgo = () => post("/api/auth/signout");

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
        {user && (info || (failed && !loading) ? <YourPlan plan={info?.bops} known={!!info} /> : <Placeholder title="Your plan" />)}
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

/** Bops' three plans, as the sheet lists them. An Orgo plan is never one of these. */
const PLANS: { tier: BopsTier; name: string; price: string; per?: string; perks: string[] }[] = [
  { tier: "free_bops", name: "Free", price: "$0", perks: ["$5 of AI credit, once", "Your Bops computer, always on"] },
  { tier: "pro_bops", name: "Pro", price: "$20", per: "/month", perks: ["$20 of AI credit every month", "Your Bops computer", "1 phone number (texts and calls)", "1 email address"] },
  { tier: "max_bops", name: "Max", price: "$200", per: "/month", perks: ["$200 of AI credit every month", "Your Bops computer", "1 phone number", "1 email address"] },
];
const RANK: Record<BopsTier, number> = { free_bops: 0, pro_bops: 1, max_bops: 2 };

type Open = "pro_bops" | "max_bops" | "manage";

/**
 * The Bops plan: Free, Pro or Max, with the user's marked. AI credit pays for what the bots do (models,
 * calls, texts) at what it costs Orgo. `plan` is orgo-web's answer (GET /api/bops/plan); without one
 * (Orgo has no Bops plans yet, or didn't answer) the user is on Free, and the balance isn't shown.
 * `known` is false when the account itself didn't load: no plan is marked then. Upgrading opens
 * Stripe's checkout, and Manage plan Stripe's billing page, in the browser; the sheet reads the plan
 * again when Bops comes back to the front.
 */
function YourPlan({ plan, known }: { plan: BopsPlan | null | undefined; known: boolean }) {
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
      {plan && <Balance plan={plan} />}
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
              <ul className="flex flex-1 flex-col gap-1">
                {p.perks.map((perk) => (
                  <li key={perk} className="flex items-start gap-1.5 text-[12.5px] leading-[18px] text-[#3A3A38]">
                    <svg width="12" height="12" viewBox="0 0 12 12" className="mt-[3px] shrink-0" aria-hidden>
                      <path d="M2.5 6.2l2.3 2.3 4.7-5" fill="none" stroke="#9A9A98" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round" />
                    </svg>
                    {perk}
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
 * The AI credit left, from Orgo's own numbers, and what to know about the paid month. Only what Orgo
 * said: no numbers, no balance.
 */
function Balance({ plan }: { plan: BopsPlan }) {
  const c = plan.credit;
  const paid = plan.tier !== "free_bops";
  const monthly = plan.tier === "max_bops" ? 200_000_000 : 20_000_000;
  const line =
    paid && plan.status === "past_due"
      ? "Payment failed. Update your card in Manage plan."
      : !c
        ? paid && plan.cancelAtPeriodEnd && plan.periodEnd
          ? `Your plan ends ${day(plan.periodEnd)}.`
          : ""
        : !paid
          ? `${credit(c.freeLeftMicros)} left of your one-time $5.`
          : [
              `${credit(c.planLeftMicros)} of ${credit(monthly)} left${c.resetsAt ? `, resets ${day(c.resetsAt)}` : ""}.`,
              c.freeLeftMicros > 0 ? `Plus ${credit(c.freeLeftMicros)} of your one-time $5.` : "",
              plan.cancelAtPeriodEnd && plan.periodEnd ? `Ends ${day(plan.periodEnd)}.` : "",
            ]
              .filter(Boolean)
              .join(" ");
  if (!c && !line) return null;
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
          You&apos;re out of AI credit, so your bots are paused.{paid ? " It comes back when your plan renews, or upgrade for more." : " Upgrade to keep them going."}
        </span>
      )}
    </div>
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

/** What Bops itself used, this month or last: totals, model use by day, by kind of work and by bot. */
function Usage({ info }: { info: AccountInfo }) {
  const [last, setLast] = useState(false);
  const t = last ? info.usage.lastMonth : info.usage.thisMonth;
  const start = last ? info.usage.lastMonthStart : info.usage.monthStart;
  const month = (ts: number) => new Date(ts).toLocaleDateString(undefined, { month: "long" });
  const empty = !t.tokens && !t.callMinutes && !t.computersCreated && !t.phoneNumbers && !t.inboxes;
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
            value={[b.tokens && `${compact(b.tokens)} tokens`, b.callMinutes && `${hours(b.callMinutes)} min`].filter(Boolean).join(", ") || `${b.computers} computer${b.computers === 1 ? "" : "s"}`}
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
