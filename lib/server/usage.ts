import "server-only";
import { USAGE_BOT_HEADER, USAGE_SOURCE_HEADER } from "@/cloud/protocol";
import type { UsageEvent, UsageKind } from "@/lib/types";
import { cloudProxy } from "./cloud";
import { getState, stateEpoch, updateUnseen } from "./store";

/**
 * What a user's Bops costs to run, as it happens: computers made and removed, numbers and inboxes
 * set up, call minutes, model tokens. The account page totals these by month. Orgo's own compute
 * (the bots' computers' hours) is billed by Orgo and read from Orgo on the account page; these
 * events are the parts Orgo doesn't see. Through Bops Cloud, what AI credit paid for is the cloud's
 * own count (GET /v1/usage), which the account page shows; each call says which bot and what kind
 * of work it's for (usageTags) so the cloud can count it that way. Tasks on the user's Mac are counted
 * the same way: they run on the Agents API through the cloud, like every task.
 */

/** What a call through Bops Cloud is for, for the cloud to count it (x-bops-bot, x-bops-source): an SDK call's options. Nothing when the app calls a provider directly. */
export function usageTags(source: NonNullable<UsageEvent["source"]>, botId?: string): { headers?: Record<string, string> } {
  if (!cloudProxy("openai")) return {};
  return { headers: { [USAGE_SOURCE_HEADER]: source, ...(botId ? { [USAGE_BOT_HEADER]: botId } : {}) } };
}

/** Keep the ledger bounded: the account page shows this month and last. */
const MAX_EVENTS = 20_000;

/**
 * One event, into the ledger of the state in memory. `epoch`: the state the work began on (store.ts
 * stateEpoch), when it waited on something: if another account's state came in meanwhile (a sign-out,
 * another sign-in), the event was the last account's, and isn't counted in this one's.
 */
export function recordUsage(kind: UsageKind, detail: Omit<UsageEvent, "kind" | "at"> = {}, epoch?: number) {
  if (epoch !== undefined && epoch !== stateEpoch()) return;
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

/**
 * A quick check by Jev (decide.ts): its input tokens as Typesafe counted them (output is free), or
 * estimated from the question's size when it didn't say. The model is what Typesafe answered with.
 */
export function recordDecide(model: string | undefined, inputTokens: number, botId?: string, epoch?: number) {
  // Asked for a state that has since been swapped out (a sign-out, another account in): not this one's to count.
  if (!(inputTokens > 0) || (epoch !== undefined && epoch !== stateEpoch())) return;
  recordUsage("model.tokens", { source: "decide", model, botId, qty: inputTokens, inputTokens, outputTokens: 0 });
}

/** A call's length, as minutes (to the hundredth). Calls that never connected cost nothing. */
export function recordCallMinutes(botId: string, seconds: number, epoch?: number) {
  if (!(seconds > 0)) return;
  recordUsage("call.minutes", { botId, qty: Math.round((seconds / 60) * 100) / 100 }, epoch);
}
