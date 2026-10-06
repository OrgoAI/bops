import type { UsageEvent, UsageKind } from "@/lib/types";

/**
 * Totals of the usage ledger (lib/server/usage.ts) for one calendar month, for the account page.
 * Pure: safe on the server or in the app.
 */

export type UsageTotals = {
  /** How many events: computers made, numbers bought, calls, model calls. */
  count: number;
  /** Their summed `qty`: minutes for calls, tokens for models, else the count. */
  qty: number;
  /** For model.tokens, the input and output split. */
  inputTokens: number;
  outputTokens: number;
};

export type UsageByKind = Partial<Record<UsageKind, UsageTotals>>;

export type UsageSummary = {
  /** The month, as [from, to) in ms since the epoch (local time). */
  from: number;
  to: number;
  /** Every event in the month, by kind. */
  byKind: UsageByKind;
  /** The same, per bot. Events with no bot (a computer made before it had one, memory) are only in byKind. */
  byBot: Record<string, UsageByKind>;
};

/** The calendar month containing `at` (local time), or `offset` months from it (-1 is last month). */
export function monthWindow(at = Date.now(), offset = 0) {
  const d = new Date(at);
  return { from: new Date(d.getFullYear(), d.getMonth() + offset, 1).getTime(), to: new Date(d.getFullYear(), d.getMonth() + offset + 1, 1).getTime() };
}

/** Sum `events` that fall in the month containing `at` (or `offset` months from it), by kind and by bot. */
export function summarizeUsage(events: UsageEvent[], at = Date.now(), offset = 0): UsageSummary {
  const { from, to } = monthWindow(at, offset);
  const byKind: UsageByKind = {};
  const byBot: Record<string, UsageByKind> = {};
  const add = (into: UsageByKind, e: UsageEvent) => {
    const t = (into[e.kind] ??= { count: 0, qty: 0, inputTokens: 0, outputTokens: 0 });
    t.count++;
    t.qty += e.qty ?? 1;
    t.inputTokens += e.inputTokens ?? 0;
    t.outputTokens += e.outputTokens ?? 0;
  };
  for (const e of events) {
    if (e.at < from || e.at >= to) continue;
    add(byKind, e);
    if (e.botId) add((byBot[e.botId] ??= {}), e);
  }
  return { from, to, byKind, byBot };
}
