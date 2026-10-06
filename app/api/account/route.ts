import type { AccountInfo, OrgoBilling, TokenSource, UsageTotals } from "@/lib/account";
import { bopsComputers, planName, planShort, planShortText, planUp } from "@/lib/orgo-plans";
import { cloudOn } from "@/lib/server/cloud";
import { loadOrgoKey, orgoKey, signedInUser } from "@/lib/server/orgo-auth";
import { prettyPhone } from "@/lib/server/phone";
import { askOrgo, orgoPages, orgoPlan, readBopsPlan } from "@/lib/server/plan";
import { getState } from "@/lib/server/store";
import { usageSince } from "@/lib/server/usage";
import { MAIN_WORKSPACE, workspaceOf, type UsageEvent } from "@/lib/types";

export const dynamic = "force-dynamic";

/**
 * The account page (components/app/account.tsx), assembled here so the Orgo key stays on the
 * server: who's signed in, their Bops plan and AI credit, their Orgo plan with its computers in use,
 * credits and compute (read from Orgo with their key), Bops' own usage this month and last (the
 * ledger, lib/server/usage.ts), and the inboxes and numbers their bots have.
 */
export async function GET() {
  const state = getState();
  const user = signedInUser();
  const key = user ? await loadOrgoKey().then(() => orgoKey()) : null;
  const now = new Date();
  // Months on the user's own clock: this server runs on their Mac.
  const monthStart = new Date(now.getFullYear(), now.getMonth(), 1).getTime();
  const lastMonthStart = new Date(now.getFullYear(), now.getMonth() - 1, 1).getTime();
  const events = usageSince(lastMonthStart);
  const pages = orgoPages();
  // AI credit is Bops Cloud's: only when the app works through it.
  const [orgo, bops] = await Promise.all([key ? readOrgo(key) : null, key && cloudOn() ? readBopsPlan(key) : undefined]);
  const info: AccountInfo = {
    user,
    signedInAt: state.account?.signedInAt,
    // Signed in per state.json but no key in the Keychain (locked, or it refused this build): say so, not "sign in".
    orgo: orgo ?? (user ? { status: "no-key" } : null),
    ...(bops !== undefined ? { bops } : {}),
    links: { billing: pages.plan, usage: pages.usage },
    usage: {
      thisMonth: totals(events.filter((e) => e.at >= monthStart), monthStart),
      lastMonth: totals(events.filter((e) => e.at < monthStart), lastMonthStart),
      monthStart,
      lastMonthStart,
    },
    reach: (state.workspaces?.length ? state.workspaces : [{ id: MAIN_WORKSPACE, name: "Main" }]).map((w) => {
      const bots = state.bots.filter((b) => workspaceOf(b) === w.id);
      const line = "line" in w ? w.line : undefined;
      return {
        id: w.id,
        name: w.name,
        line: line ? { phone: prettyPhone(line.phone), imessage: line.type === "imessage", main: bots.find((b) => b.isMain)?.name } : undefined,
        bots: bots
          .sort((a, b) => Number(b.isMain) - Number(a.isMain))
          .map((b) => ({ id: b.id, name: b.name, color: b.color, isMain: b.isMain, email: b.email, phone: b.phone ? prettyPhone(b.phone) : undefined })),
      };
    }),
  };
  return Response.json(info);
}

/* ---------------- Orgo ---------------- */

type Summary = {
  tier?: string;
  /** The plan the account is held to, which its computers count against (`tier` is the live subscription's). */
  entitledTier?: string;
  interval?: "month" | "year" | null;
  renewalDate?: number | null;
  cancelAtPeriodEnd?: boolean;
  amountCents?: number | null;
  currency?: string | null;
  comped?: boolean;
  compExpiresAt?: number | null;
  hasActiveSubscription?: boolean;
};
type Credits = { balanceCents?: number; tier?: string };
type Quota = { allocated?: { vms?: number }; usage_mtd?: { cpu_seconds?: number; running_seconds?: number } };

/**
 * Plan, credits and compute, as Orgo for Mac reads them, all with an account API key (validateAuth's
 * Bearer sk_ path), and the plan's computers as Orgo counts them for a new one (lib/server/plan.ts).
 * Each can fail on its own; the page shows what came back and says what didn't.
 */
async function readOrgo(key: string): Promise<OrgoBilling> {
  const [summary, credits, quota, plan] = await Promise.all([
    askOrgo<Summary>(key, "/api/billing/summary"),
    askOrgo<Credits>(key, "/api/credits"),
    askOrgo<Quota>(key, "/api/billing/quota"),
    orgoPlan({ fresh: true }),
  ]);
  const reads = [summary, credits, quota];
  const failed = reads.filter((r) => !r.ok);
  if (failed.length === reads.length && !plan) return { status: failed.some((r) => !r.ok && r.denied) ? "expired" : "unreachable" };

  const out: OrgoBilling = { status: failed.length || !plan ? "partial" : "ok" };
  const s = summary.ok ? summary.json : undefined;
  // The plan the account is held to, which its computers count against; else the live subscription's.
  const tier = plan?.tier ?? s?.entitledTier ?? (s?.hasActiveSubscription ? s.tier : undefined) ?? (credits.ok ? credits.json.tier : undefined) ?? s?.tier;
  if (tier)
    out.plan = {
      tier,
      name: planName(tier),
      amountCents: s?.hasActiveSubscription ? (s.amountCents ?? undefined) : undefined,
      currency: s?.currency ?? undefined,
      interval: s?.interval ?? undefined,
      renewsAt: s?.renewalDate ? s.renewalDate * 1000 : undefined,
      cancelsAtPeriodEnd: s?.cancelAtPeriodEnd || undefined,
      comped: s?.comped || undefined,
      compEndsAt: s?.compExpiresAt ? s.compExpiresAt * 1000 : undefined,
    };
  if (plan) {
    const bops = bopsComputers(getState().bots);
    out.computers = { allowed: plan.computers, inUse: plan.inUse, outsideBops: plan.inUse === undefined ? undefined : Math.max(0, plan.inUse - bops) };
    // No room for another computer: why, in plain words, under the plan's name as shown. Either way, the next plan up Orgo sells.
    const short = planShort(plan);
    if (short) out.full = planShortText(short, { ...plan, name: out.plan?.name ?? plan.name }, { bops });
    out.upgradeTo = planUp(plan)?.name;
  }
  if (credits.ok && typeof credits.json.balanceCents === "number") out.creditsCents = credits.json.balanceCents;
  if (quota.ok) {
    const q = quota.json;
    out.compute = {
      runningHours: (Number(q.usage_mtd?.running_seconds) || 0) / 3600,
      vcpuHours: (Number(q.usage_mtd?.cpu_seconds) || 0) / 3600,
      computers: Number(q.allocated?.vms) || 0,
    };
  }
  return out;
}

/* ---------------- Bops usage ---------------- */

/** One month of the ledger, totalled. Bots that are gone keep their usage, under "Removed bot". */
function totals(events: UsageEvent[], monthStart: number): UsageTotals {
  const start = new Date(monthStart);
  const days = new Date(start.getFullYear(), start.getMonth() + 1, 0).getDate();
  const t: UsageTotals = { computersCreated: 0, computersRemoved: 0, phoneNumbers: 0, inboxes: 0, callMinutes: 0, tokens: 0, tokensBySource: {}, tokensByDay: Array(days).fill(0), byBot: [] };
  const bots = new Map<string, UsageTotals["byBot"][number]>();
  const botRow = (botId: string) => {
    let row = bots.get(botId);
    if (!row) {
      const b = getState().bots.find((x) => x.id === botId);
      row = { botId, name: b?.name ?? "Removed bot", color: b?.color, tokens: 0, callMinutes: 0, computers: 0 };
      bots.set(botId, row);
    }
    return row;
  };
  for (const e of events) {
    const qty = Number(e.qty) || 0;
    if (e.kind === "computer.create") {
      t.computersCreated++;
      if (e.botId) botRow(e.botId).computers++;
    } else if (e.kind === "computer.remove") t.computersRemoved++;
    else if (e.kind === "phone.number") t.phoneNumbers++;
    else if (e.kind === "mail.inbox") t.inboxes++;
    else if (e.kind === "call.minutes") {
      t.callMinutes += qty;
      if (e.botId) botRow(e.botId).callMinutes += qty;
    } else if (e.kind === "model.tokens") {
      const tokens = qty || (Number(e.inputTokens) || 0) + (Number(e.outputTokens) || 0);
      t.tokens += tokens;
      const source: TokenSource = e.source ?? "other";
      t.tokensBySource[source] = (t.tokensBySource[source] ?? 0) + tokens;
      const day = new Date(e.at).getDate() - 1;
      if (day >= 0 && day < days) t.tokensByDay[day] += tokens;
      if (e.botId) botRow(e.botId).tokens += tokens;
    }
  }
  t.callMinutes = Math.round(t.callMinutes * 10) / 10;
  t.byBot = [...bots.values()].sort((a, b) => b.tokens - a.tokens || b.callMinutes - a.callMinutes);
  return t;
}
