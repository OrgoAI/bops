import { creditLeft, creditsOn } from "./credit.ts";
import { query } from "./db.ts";
import { locked, tellAboutLine } from "./plans.ts";
import { numberCost } from "./pricing.ts";
import { pauseUnpaidLine, resumePaidLine, resumeUnbilledLines, unpaidOut, type UnpaidLine } from "./provision.ts";
import { recordUsageFor } from "./usage.ts";

/**
 * Billing by use (protocol.ts BopsBilling "usage"): a phone number costs a month at a time from the user's
 * Orgo credit, at cost ($3 a number, pricing.ts numberCost; orgo-web's spend kind "phone_number" adds no
 * markup). The one number kept free is the plan's number a user had (the newest plan line not given
 * back: provision.ts planLine); every other line they hold is renewed here, each month.
 *
 * Run from the hourly plan sweep (plans.ts sweep), before it gives back what was paused 30 days ago. Per
 * line, bops.phone_lines.paid_until and unpaid (0018):
 * - null: first seen on billing by use. Set to the end of its first month (its purchase paid that month,
 *   proxy.ts POST v1/numbers), or now for a line older than that (one kept from a plan), so that one is
 *   charged on the next pass.
 * - due (paid_until has passed): a month charged, once (recordUsageFor's ref names the line and the month
 *   it pays from, so a pass that dies before moving paid_until never charges twice), then paid_until moves
 *   on a month.
 * - can't be paid (the credit left doesn't cover a month, or orgo-web refuses the charge): the line is
 *   paused as a plan's is (provision.ts pauseUnpaidLine: calls and texts on it go unanswered, texts out
 *   from it are refused) and the Mac is told, on the bot that has it, with the day it's given back.
 *   paid_until stays, so the same month (the same ref) is asked again each pass.
 * - paid while paused: back on at once (provision.ts resumePaidLine), paid a month from now, so it's billed
 *   monthly from that day, and the Mac is told.
 * - still unpaid 30 days after the pause: given back (provision.ts releaseAfterPause, later in the sweep).
 *
 * The free number is never charged, so it's never paused for its month. A line paused for anything else
 * (a plan's, from before) isn't charged while it is. A user moved back to Bops' plans has their numbers
 * paused for a month back on (provision.ts resumeUnbilledLines): nothing bills a number by the month there.
 * Each line is renewed under its user's plan lock (plans.ts locked), so a release at that moment never
 * gives back a number just paid for.
 *
 * Nothing while AI credit is off (a self-hosted cloud). Returns how many months were paid.
 */
export async function renewUsageNumbers(limit = 200): Promise<number> {
  if (!creditsOn()) return 0;
  for (const l of await resumeUnbilledLines()) await tell(l.user_id, l);
  const MONTH = "30 days";
  // First seen: the month it was bought with, or now.
  await query(
    `UPDATE bops.phone_lines l SET paid_until = GREATEST(l.created_at + interval '${MONTH}', now())
      FROM bops.plans p
     WHERE p.user_id = l.user_id AND p.billing = 'usage' AND l.status <> 'released' AND l.paid_until IS NULL
       AND NOT (l.plan AND l.digits = (SELECT f.digits FROM bops.phone_lines f WHERE f.user_id = l.user_id AND f.plan AND f.status <> 'released'
                                        ORDER BY f.created_at DESC LIMIT 1))`,
  );
  // paid_until as text: its microseconds kept, so the moves below match the row exactly.
  const due = await query<{ digits: string; user_id: string; paid_until: string }>(
    `SELECT l.digits, l.user_id, l.paid_until::text AS paid_until
       FROM bops.phone_lines l JOIN bops.plans p ON p.user_id = l.user_id
      WHERE p.billing = 'usage' AND ${DUE}
        AND NOT (l.plan AND l.digits = (SELECT f.digits FROM bops.phone_lines f WHERE f.user_id = l.user_id AND f.plan AND f.status <> 'released'
                                         ORDER BY f.created_at DESC LIMIT 1))
      ORDER BY l.paid_until
      LIMIT ${Math.max(1, Math.min(1000, limit))}`,
  );
  let paid = 0;
  for (const d of due.rows) {
    try {
      if (await locked(d.user_id, () => renew(d.digits, d.paid_until, MONTH))) paid++;
    } catch (e) {
      console.warn(`[numbers] ${d.user_id}'s number month wasn't charged (asked again next pass): ${(e as Error).message}`);
    }
  }
  return paid;
}

/** A line whose month is due: not given back, paid_until passed, and not paused for anything but its month. */
const DUE = `l.status <> 'released' AND l.paid_until IS NOT NULL AND l.paid_until <= now() AND (l.status <> 'paused' OR l.unpaid)`;

type DueLine = UnpaidLine & { user_id: string; from_iso: string };

/**
 * One line's month, under its user's lock: read again (another pass may have paid or paused it meanwhile),
 * paid, or paused when it can't be. Whether it was paid.
 */
async function renew(digits: string, paidUntil: string, month: string): Promise<boolean> {
  const l = (
    await query<DueLine>(
      `SELECT l.digits, l.number_id, l.e164, l.agent_id, l.status, l.problem, l.bot_id, l.workspace_id, l.paused_at, l.user_id,
              to_char(l.paid_until AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.US"Z"') AS from_iso
         FROM bops.phone_lines l WHERE l.digits = $1 AND l.paid_until = $2::timestamptz AND ${DUE}`,
      [digits, paidUntil],
    )
  ).rows[0];
  if (!l) return false;
  // A paused line here is one paused for its month (DUE).
  if (!(await payMonth(l))) {
    // Paused once (the Mac told once); while it is, the same month is asked again each pass.
    const paused = l.status === "paused" ? null : await pauseUnpaidLine(digits, paidUntil);
    if (paused) {
      console.log(`[numbers] ${l.user_id}'s ${l.e164} is paused: its month couldn't be paid from their credit`);
      await tell(l.user_id, paused);
    }
    return false;
  }
  if (l.status === "paused") {
    const back = await resumePaidLine(digits, paidUntil, month);
    if (back) await tell(l.user_id, back);
  } else {
    await query(`UPDATE bops.phone_lines SET paid_until = paid_until + $3::interval, unpaid = false, updated_at = now() WHERE digits = $1 AND paid_until = $2::timestamptz`, [
      digits,
      paidUntil,
      month,
    ]);
  }
  return true;
}

/** A number's month, as a renewal charges it (a number's price: lines aren't kept by kind). */
const MONTH_COST = numberCost({ type: "number" });

/**
 * Charge the line's month (its ref: the line and the month it pays from). True when it's paid, now or
 * by a pass that stopped before paid_until moved (never charged twice); false when the credit can't pay
 * it: less left than a month costs, or orgo-web refusing the charge (it raises when the Orgo credit
 * doesn't cover it). Anything else throws, and the line is left as it is for the next pass.
 */
async function payMonth(l: DueLine): Promise<boolean> {
  const ref = `renew:${l.digits}:${l.from_iso}`;
  const before = await query("SELECT 1 FROM bops.cloud_usage WHERE user_id = $1 AND kind = 'agentphone.numbers' AND detail->>'ref' = $2 LIMIT 1", [l.user_id, ref]);
  if (before.rowCount) return true;
  if ((await creditLeft(l.user_id)) < MONTH_COST) return false;
  try {
    await recordUsageFor(l.user_id, "agentphone.numbers", ref, 1, { numberId: l.number_id, type: "number", renewal: true });
    return true;
  } catch (e) {
    if ((await creditLeft(l.user_id).catch(() => Infinity)) < MONTH_COST) return false;
    throw e;
  }
}

/** The Mac hears about the line's month (paused, back on, given back) on the bot it's for. Never fails the renewal. */
async function tell(userId: string, l: UnpaidLine) {
  await tellAboutLine(userId, unpaidOut(l), { botId: l.bot_id, workspaceId: l.workspace_id }).catch((e: Error) =>
    console.warn(`[numbers] couldn't tell ${userId}'s Mac about ${l.e164}: ${e.message}`),
  );
}
