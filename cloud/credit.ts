import type pg from "pg";
import { config } from "./config.ts";
import { query } from "./db.ts";
import { HttpError } from "./http.ts";
import { AI_CREDIT_EMPTY } from "./protocol.ts";

/**
 * AI credit: what a user's bots may spend on OpenAI, AgentPhone, Typesafe and texted codes, at what
 * Orgo pays for it (pricing.ts), in micro-dollars. The balance lives in orgo-web's database
 * (public.bops_ai_credit, with every grant in public.bops_ai_credit_grants), next to Bops' own schema:
 * orgo-web grants Pro's and Max's monthly credit when Stripe says an invoice is paid, and the cloud
 * reads the balance here and takes each use from it (usage.ts). The money math is orgo-web's three SQL
 * functions (its migration 20261022_bops_plans.sql); bops_app may use those two tables and nothing
 * else of orgo-web's.
 *
 * - bops_ai_credit_balance(user): what's left. The first time it's asked about a user it gives them
 *   Free's one-time $5, once ever (POST /v1/session asks, and so does the gate, whichever is first).
 * - bops_ai_credit_spend(user, micros): takes a use, from this month's plan credit first (it runs out
 *   at the month's end), then the rest. The rest may go below 0: a turn already under way when the
 *   credit ran out isn't cut off, and the next grant covers what it overran.
 *
 * Off unless BOPS_AI_CREDITS=1: then nothing is taken and nothing is refused (a self-hosted or local
 * cloud). On, the cloud won't start without access to the two tables (checkCreditAccess).
 */

export const creditsOn = () => config.aiCredits();

const MESSAGE = "You're out of AI credit, so your bots have stopped. Upgrade in Settings to keep them going.";

/** What the user has left, in micro-dollars (Free's $5 given first, if they never had it). */
export async function creditLeft(userId: string): Promise<number> {
  const r = await query<{ left: string | null }>("SELECT public.bops_ai_credit_balance($1::uuid) AS left", [userId]);
  return Number(r.rows[0]?.left ?? 0);
}

/** Take `micros` from the user's credit, inside the caller's transaction (with the usage row it pays for). What's left after. */
export async function spend(c: pg.PoolClient, userId: string, micros: number): Promise<number> {
  const r = await c.query<{ left: string | null }>("SELECT public.bops_ai_credit_spend($1::uuid, $2::bigint) AS left", [userId, Math.ceil(micros)]);
  return Number(r.rows[0]?.left ?? 0);
}

/** The 402 a call that would spend gets when the credit's used up: the app shows it with Upgrade. */
export const outOfCredit = () => new HttpError(402, MESSAGE, { code: AI_CREDIT_EMPTY, upgrade: true });

/**
 * Refuse (402) a call that would spend when the user has nothing left, or less than it costs at the
 * least (`minCost`: a number's month). Read fresh every time, so an upgrade counts at once. Nothing
 * when AI credit is off.
 */
export async function requireCredit(userId: string, minCost = 0): Promise<void> {
  if (!creditsOn()) return;
  const left = await creditLeft(userId);
  if (left <= 0 || left < minCost) throw outOfCredit();
}

/** Whether the user has any credit left; true when AI credit is off. */
export async function hasCredit(userId: string): Promise<boolean> {
  return !creditsOn() || (await creditLeft(userId)) > 0;
}

/** Give a new user Free's $5 (once ever; nothing if they've had it). Best effort: the gate gives it too. */
export async function welcome(userId: string): Promise<void> {
  if (!creditsOn()) return;
  await creditLeft(userId).catch((e: Error) => console.warn(`[credit] ${userId}'s first AI credit: ${e.message}`));
}

/**
 * With AI credit on, the cloud must be able to read and change the balance (orgo-web's migration
 * grants bops_app the two tables; db/provision.sql grants them again for a database set up after it).
 * Without that every use would go unpaid, so the cloud refuses to start instead.
 */
export async function checkCreditAccess(): Promise<void> {
  if (!creditsOn()) return;
  // One privilege per check: a list ("SELECT, UPDATE") is true when any one of them is held.
  const r = await query<{ ok: boolean | null }>(
    `SELECT has_schema_privilege('public', 'USAGE')
        AND COALESCE(has_table_privilege(to_regclass('public.bops_ai_credit'), 'SELECT'), false)
        AND COALESCE(has_table_privilege(to_regclass('public.bops_ai_credit'), 'INSERT'), false)
        AND COALESCE(has_table_privilege(to_regclass('public.bops_ai_credit'), 'UPDATE'), false)
        AND COALESCE(has_table_privilege(to_regclass('public.bops_ai_credit_grants'), 'SELECT'), false)
        AND COALESCE(has_table_privilege(to_regclass('public.bops_ai_credit_grants'), 'INSERT'), false)
        AND COALESCE(has_sequence_privilege(to_regclass('public.bops_ai_credit_grants_id_seq'), 'USAGE'), false)
        AND COALESCE(has_function_privilege(to_regprocedure('public.bops_ai_credit_balance(uuid)'), 'EXECUTE'), false)
        AND COALESCE(has_function_privilege(to_regprocedure('public.bops_ai_credit_spend(uuid, bigint)'), 'EXECUTE'), false) AS ok`,
  );
  if (!r.rows[0]?.ok)
    throw new Error(
      "BOPS_AI_CREDITS=1, but this login can't use public.bops_ai_credit and its functions. Apply orgo-web's 20261022_bops_plans.sql (and db/provision.sql's grant) first, or turn AI credit off.",
    );
}
