import "server-only";
import type { UsageEvent, UsageKind } from "@/lib/types";
import { getState, stateEpoch, updateUnseen } from "./store";

/**
 * What a user's Bops costs to run, as it happens: computers made and removed, numbers and inboxes
 * set up, call minutes, model tokens. The account page totals these by month. Orgo's own compute
 * (the bots' computers' hours) is billed by Orgo and read from Orgo on the account page; these
 * events are the parts Orgo doesn't see.
 */

/** Keep the ledger bounded: the account page shows this month and last. */
const MAX_EVENTS = 20_000;

export function recordUsage(kind: UsageKind, detail: Omit<UsageEvent, "kind" | "at"> = {}) {
  // The app never reads the ledger (the account page asks /api/account), so a new event doesn't make every poll fetch the state again.
  updateUnseen((s) => {
    s.usage ??= [];
    s.usage.push({ kind, at: Date.now(), ...detail });
    if (s.usage.length > MAX_EVENTS) s.usage.splice(0, s.usage.length - MAX_EVENTS);
  });
}

export const usageSince = (since: number) => (getState().usage ?? []).filter((e) => e.at >= since);

/** Token counts as OpenAI reports them: a Responses API response's `usage`, or an agent turn's. */
type Tokens = { input_tokens: number; output_tokens: number } | null | undefined;

/**
 * One model call's tokens, from what the API reported (nothing is recorded when it reported none).
 * Call it once per response: each response's usage covers only that call.
 */
export function recordTokens(source: NonNullable<UsageEvent["source"]>, model: string | undefined, usage: Tokens, botId?: string, epoch?: number) {
  // Work started on a state that has since been swapped out (another user signed in): not this state's to count.
  if (!usage || (epoch !== undefined && epoch !== stateEpoch())) return;
  const inputTokens = usage.input_tokens ?? 0;
  const outputTokens = usage.output_tokens ?? 0;
  recordUsage("model.tokens", { source, model, botId, qty: inputTokens + outputTokens, inputTokens, outputTokens });
}

/** A call's length, as minutes (to the hundredth). Calls that never connected cost nothing. */
export function recordCallMinutes(botId: string, seconds: number) {
  if (!(seconds > 0)) return;
  recordUsage("call.minutes", { botId, qty: Math.round((seconds / 60) * 100) / 100 });
}
