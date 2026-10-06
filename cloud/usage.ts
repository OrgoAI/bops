import type pg from "pg";
import { creditsOn, spend } from "./credit.ts";
import { tx } from "./db.ts";
import { costOf } from "./pricing.ts";

/**
 * Metered use per user (bops.cloud_usage), for the account page and AI credit: model tokens, call
 * seconds, numbers bought, texts, codes sent, Typesafe calls. A row is written as the use passes
 * through the cloud, with what it cost Orgo (cost_micros, pricing.ts), and with AI credit on that
 * much is taken from the user's credit in the same transaction (credit.ts). Nothing here ever holds
 * up the call it counts.
 *
 * Kinds used so far: "openai.tokens" (units: input + output tokens, with both, the cached and the
 * model in detail), "openai.live_seconds" (a call run on the Mac, from its sideband), "call.minutes"
 * (a call the cloud answered, calls.ts), "agentphone.numbers" (detail: the number's type), "agentphone.sms"
 * (units: segments, or one picture message with detail.mms; in or out), "typesafe.calls",
 * "verify.sms", "verify.email".
 */

/** A use that couldn't be recorded or paid for: who, what and how much, for the log. */
class UsageError extends Error {}

async function recorded<T>(userId: string, kind: string, micros: () => number, work: (c: pg.PoolClient) => Promise<T>): Promise<T> {
  try {
    return await tx(work);
  } catch (e) {
    throw new UsageError(`${kind} for ${userId} (${micros()} micro-dollars) wasn't recorded or paid: ${(e as Error).message}`);
  }
}

/** One more use of `kind` by this user, paid for from their AI credit. */
export async function recordUsage(userId: string, kind: string, units: number, detail?: Record<string, unknown>): Promise<void> {
  const cost = costOf(kind, units, detail);
  await recorded(
    userId,
    kind,
    () => cost,
    async (c) => {
      await c.query("INSERT INTO bops.cloud_usage (user_id, kind, units, detail, cost_micros) VALUES ($1, $2, $3, $4::jsonb, $5)", [
        userId,
        kind,
        units,
        detail ? JSON.stringify(detail) : null,
        cost,
      ]);
      if (cost > 0 && creditsOn()) await spend(c, userId, cost);
    },
  );
}

/**
 * Use that can be seen more than once (an agent turn's tokens come in its event and again when it's
 * looked up; a call's seconds grow while it runs): one row per `ref`, keeping the largest count (and
 * the detail that came with it). The row is priced again each time, and only what it costs beyond
 * what was paid for it already is taken.
 */
export async function recordUsageFor(userId: string, kind: string, ref: string, units: number, detail: Record<string, unknown> = {}): Promise<void> {
  let paid = 0;
  await recorded(
    userId,
    kind,
    () => paid,
    async (c) => {
      // Two sightings at once take turns, so neither misses the other's row.
      await c.query("SELECT pg_advisory_xact_lock(hashtext($1))", [`bops-usage:${userId}:${kind}:${ref}`]);
      const seen = (
        await c.query<{ id: string; units: string; detail: Record<string, unknown> | null; cost_micros: string }>(
          `SELECT id, units, detail, cost_micros FROM bops.cloud_usage
           WHERE user_id = $1 AND kind = $2 AND detail->>'ref' = $3 AND at > now() - interval '7 days'
           ORDER BY id LIMIT 1 FOR UPDATE`,
          [userId, kind, ref],
        )
      ).rows[0];
      const was = seen ? Number(seen.units) : 0;
      // A smaller count is an older sighting: the larger one's detail stands.
      const keep = units >= was ? { units, detail: { ...detail, ref } } : { units: was, detail: { ...(seen?.detail ?? {}), ref } };
      const before = seen ? Number(seen.cost_micros) : 0;
      const cost = Math.max(costOf(kind, keep.units, keep.detail), before);
      paid = cost - before;
      if (seen)
        await c.query("UPDATE bops.cloud_usage SET units = $2, detail = $3::jsonb, cost_micros = $4 WHERE id = $1", [seen.id, keep.units, JSON.stringify(keep.detail), cost]);
      else
        await c.query("INSERT INTO bops.cloud_usage (user_id, kind, units, detail, cost_micros) VALUES ($1, $2, $3, $4::jsonb, $5)", [
          userId,
          kind,
          keep.units,
          JSON.stringify(keep.detail),
          cost,
        ]);
      if (paid > 0 && creditsOn()) await spend(c, userId, paid);
    },
  );
}

type TokenUsage = {
  input_tokens?: number;
  output_tokens?: number;
  input_tokens_details?: { cached_tokens?: number } | null;
  output_tokens_details?: { reasoning_tokens?: number } | null;
};

/** An OpenAI answer's token use (a response's `usage`, an agent turn's), once per response or turn, priced at its model. */
export async function recordTokens(userId: string, ref: string, usage: unknown, detail: { model?: unknown; source: string }): Promise<void> {
  const u = (usage ?? {}) as TokenUsage;
  const input = Number(u.input_tokens) || 0;
  const output = Number(u.output_tokens) || 0;
  if (!input && !output) return;
  await recordUsageFor(userId, "openai.tokens", ref, input + output, {
    source: detail.source,
    ...(typeof detail.model === "string" ? { model: detail.model } : {}),
    input,
    output,
    cached: Number(u.input_tokens_details?.cached_tokens) || 0,
    reasoning: Number(u.output_tokens_details?.reasoning_tokens) || 0,
  });
}
