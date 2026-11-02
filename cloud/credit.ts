import { trackCloudEvent } from "./analytics.ts";
import type pg from "pg";
import { config } from "./config.ts";
import { query } from "./db.ts";
import { HttpError } from "./http.ts";
import { billingOf } from "./plans.ts";
import { AI_CREDIT_EMPTY, AI_CREDIT_LOW, type BopsBilling } from "./protocol.ts";

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
 *   at the month's end), then the rest. The rest may go below 0 by what a use cost past what was
 *   left: a model's answer already asked for, or an agent turn's last few seconds before the cloud
 *   stopped it (turn-guard.ts holds running turns to the credit). The next grant covers it.
 *
 * A user billed by use (protocol.ts BopsBilling "usage") has no Bops credit: orgo-web's two functions
 * answer for them from their Orgo credit (what's left, and each use taken from it at Orgo's rate), so
 * the cloud calls them the same way for everyone, and an older cloud spends from the right place too.
 * Only the words differ: they're told about their Orgo credit and to add some, never to upgrade
 * (creditWords). They get no Bops $5 either (welcome): Orgo's signup credit is their start.
 *
 * Off unless BOPS_AI_CREDITS=1: then nothing is taken and nothing is refused (a self-hosted or local
 * cloud). On, the cloud won't start without access to the two tables (checkCreditAccess).
 */

export const creditsOn = () => config.aiCredits();

/** What the app is told when the credit is used up (a 402, or a task the cloud stopped: turn-guard.ts). */
export const OUT_OF_CREDIT = "You're out of AI credit, so your bots have stopped. Upgrade in Settings to keep them going.";
/** The same for a user billed by use: it's their Orgo credit, and there's nothing to upgrade, only credit to add. */
export const OUT_OF_ORGO_CREDIT = "You're out of Orgo credit, so your bots have stopped. Add credit in Settings to keep them going.";

/**
 * The credit's words for how the user is billed: its name, and what a 402 (none left: `empty`) and a 403
 * or a stopped task (too little left: `low`) say. Bops' plans say AI credit and Upgrade; billing by use
 * says Orgo credit and Add credit.
 */
export function creditWords(billing: BopsBilling = "plan") {
  if (billing === "usage")
    return {
      name: "Orgo credit",
      empty: OUT_OF_ORGO_CREDIT,
      low: "There isn't enough Orgo credit left to start this task. Add credit in Settings to keep your bots going.",
      stopped: "It needs more Orgo credit than you have left, so it's stopped. Add credit in Settings to keep it going.",
    };
  return {
    name: "AI credit",
    empty: OUT_OF_CREDIT,
    low: "There isn't enough AI credit left to start this task. Upgrade in Settings to keep your bots going.",
    stopped: "It needs more AI credit than you have left, so it's stopped. Upgrade in Settings to keep it going.",
  };
}

/** How the user is billed, for the words only: "plan" when it can't be read (a refusal never fails on it). */
export const billingFor = (userId: string): Promise<BopsBilling> => billingOf(userId).catch(() => "plan" as const);

/** What the user has left, in micro-dollars (Free's $5 given first, if they never had it). */
export async function creditLeft(userId: string): Promise<number> {
  const r = await query<{ left: string | null }>("SELECT public.bops_ai_credit_balance($1::uuid) AS left", [userId]);
  return Number(r.rows[0]?.left ?? 0);
}

/**
 * Take `micros` from the user's credit, inside the caller's transaction (with the usage row it pays
 * for). What's left after, and whether this use is the one that ran the credit out (only at the
 * crossing, never after): the caller reports that once its transaction has committed (creditRanOut).
 */
export async function spend(c: pg.PoolClient, userId: string, micros: number, kind: SpendKind = "ai"): Promise<{ left: number; ranOut: boolean }> {
  const r =
    kind !== "ai" && (await atCostSpendReady(c))
      ? await c.query<{ left: string | null }>("SELECT public.bops_ai_credit_spend($1::uuid, $2::bigint, $3::text) AS left", [userId, Math.ceil(micros), kind])
      : await c.query<{ left: string | null }>("SELECT public.bops_ai_credit_spend($1::uuid, $2::bigint) AS left", [userId, Math.ceil(micros)]);
  const left = Number(r.rows[0]?.left ?? 0);
  return { left, ranOut: left <= 0 && left + Math.ceil(micros) > 0 };
}

/**
 * What a use is, for orgo-web's spend: "ai" (everything metered, at Orgo's rate for a user billed by
 * use: list price plus their markup) or "phone_number" (a number's month, at cost: $3 stays $3).
 * Bops' own plans spend both the same.
 */
export type SpendKind = "ai" | "phone_number";

/** The use kind a recorded use is spent as (usage.ts): a number's month at cost, the rest as AI. */
export const spendKindOf = (usageKind: string): SpendKind => (usageKind === "agentphone.numbers" ? "phone_number" : "ai");

/**
 * Whether orgo-web's three argument spend (its 20261149) is there and bops_app may run it, asked in the
 * caller's transaction (a missing function would abort it). Remembered once it is; asked again after a
 * minute while it isn't, so the cloud takes it up without a restart. Without it a number is spent as AI.
 */
let atCostReady = false;
let atCostAskedAt = 0;
async function atCostSpendReady(c: pg.PoolClient): Promise<boolean> {
  if (atCostReady) return true;
  if (Date.now() - atCostAskedAt < 60_000) return false;
  atCostAskedAt = Date.now();
  const r = await c.query<{ ok: boolean | null }>(
    `SELECT COALESCE(has_function_privilege(to_regprocedure('public.bops_ai_credit_spend(uuid, bigint, text)'), 'EXECUTE'), false) AS ok`,
  );
  atCostReady = r.rows[0]?.ok === true;
  return atCostReady;
}

/** The credit ran out (usage events), after the spend that did it committed. */
export const creditRanOut = (userId: string) => trackCloudEvent(userId, "bops_ai_credit_ran_out", {});

/**
 * The 402 a call that would spend gets when the credit's used up: the app shows it with Upgrade, or with
 * Add credit for a user billed by use (`billing` "usage" says so: an app that knows reads it).
 */
export const outOfCredit = (billing: BopsBilling = "plan") =>
  new HttpError(402, creditWords(billing).empty, { code: AI_CREDIT_EMPTY, upgrade: true, ...(billing === "usage" ? { billing } : {}) });

/**
 * A task that can't start on what's left, though some is (turn-guard.ts admitTurn): 403, not 402, so
 * no app takes the credit for used up (every app before 0.0.16 pauses all its bots on any 402). The
 * body is shaped like OpenAI's errors too, so the OpenAI SDK in the app keeps the code.
 */
export function shortOfCredit(billing: BopsBilling = "plan"): HttpError {
  const message = creditWords(billing).low;
  return new HttpError(403, message, { error: { message, code: AI_CREDIT_LOW }, code: AI_CREDIT_LOW, upgrade: true, ...(billing === "usage" ? { billing } : {}) });
}

/**
 * Refuse (402) a call that would spend when the user has nothing left, or less than it costs at the
 * least (`minCost`: a number's month). Read fresh every time, so an upgrade counts at once. Nothing
 * when AI credit is off.
 */
export async function requireCredit(userId: string, minCost = 0): Promise<void> {
  if (!creditsOn()) return;
  const left = await creditLeft(userId);
  if (left <= 0 || left < minCost) throw outOfCredit(await billingFor(userId));
}

/** Whether the user has any credit left; true when AI credit is off. */
export async function hasCredit(userId: string): Promise<boolean> {
  return !creditsOn() || (await creditLeft(userId)) > 0;
}

/**
 * Give a new user Free's $5 (once ever; nothing if they've had it). Best effort: the gate gives it too.
 * Not asked for a user the cloud knows is billed by use: Bops gives them nothing (Orgo's signup credit
 * is their start), and orgo-web's balance function gives them nothing either when asked.
 */
export async function welcome(userId: string): Promise<void> {
  if (!creditsOn() || (await billingFor(userId)) === "usage") return;
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
