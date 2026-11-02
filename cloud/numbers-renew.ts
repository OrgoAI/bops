import { creditsOn } from "./credit.ts";
import { query } from "./db.ts";
import { recordUsageFor } from "./usage.ts";

/**
 * Billing by use (protocol.ts BopsBilling "usage"): a phone number costs a month at a time from the user's
 * Orgo credit, at cost ($3 a number, pricing.ts numberCost; orgo-web's spend kind "phone_number" adds no
 * markup). The one number kept free is the plan's number a user had (the newest plan line not given
 * back: provision.ts planLine); every other line they hold is renewed here, each month.
 *
 * Run from the hourly plan sweep (plans.ts sweep). Per line, bops.phone_lines.paid_until (0018):
 * - null: first seen on billing by use. Set to the end of its first month (its purchase paid that month,
 *   proxy.ts POST v1/numbers), or now for a line older than that (one kept from a plan), so that one is
 *   charged on the next pass.
 * - due (paid_until has passed): a month charged, once (recordUsageFor's ref names the line and the month
 *   it pays from, so a pass that dies before moving paid_until never charges twice), then paid_until moves
 *   on a month. Out of credit, the charge is refused and the line stays as it is, asked again each pass;
 *   it is never given back here (a person may have given that number out).
 *
 * Nothing while AI credit is off (a self-hosted cloud). Returns how many months were charged.
 */
export async function renewUsageNumbers(limit = 200): Promise<number> {
  if (!creditsOn()) return 0;
  const MONTH = "30 days";
  // First seen: the month it was bought with, or now.
  await query(
    `UPDATE bops.phone_lines l SET paid_until = GREATEST(l.created_at + interval '${MONTH}', now())
      FROM bops.plans p
     WHERE p.user_id = l.user_id AND p.billing = 'usage' AND l.status <> 'released' AND l.paid_until IS NULL
       AND NOT (l.plan AND l.digits = (SELECT f.digits FROM bops.phone_lines f WHERE f.user_id = l.user_id AND f.plan AND f.status <> 'released'
                                        ORDER BY f.created_at DESC LIMIT 1))`,
  );
  // paid_until as text: its microseconds kept, so the move below matches the row exactly.
  const due = await query<{ digits: string; user_id: string; number_id: string | null; paid_until: string; from_iso: string }>(
    `SELECT l.digits, l.user_id, l.number_id, l.paid_until::text AS paid_until,
            to_char(l.paid_until AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.US"Z"') AS from_iso
       FROM bops.phone_lines l JOIN bops.plans p ON p.user_id = l.user_id
      WHERE p.billing = 'usage' AND l.status <> 'released' AND l.paid_until IS NOT NULL AND l.paid_until <= now()
        AND NOT (l.plan AND l.digits = (SELECT f.digits FROM bops.phone_lines f WHERE f.user_id = l.user_id AND f.plan AND f.status <> 'released'
                                         ORDER BY f.created_at DESC LIMIT 1))
      ORDER BY l.paid_until
      LIMIT ${Math.max(1, Math.min(1000, limit))}`,
  );
  let charged = 0;
  for (const l of due.rows) {
    const from = l.from_iso;
    try {
      await recordUsageFor(l.user_id, "agentphone.numbers", `renew:${l.digits}:${from}`, 1, { numberId: l.number_id, type: "number", renewal: true });
      await query(`UPDATE bops.phone_lines SET paid_until = paid_until + interval '${MONTH}', updated_at = now() WHERE digits = $1 AND paid_until = $2::timestamptz`, [
        l.digits,
        l.paid_until,
      ]);
      charged++;
    } catch (e) {
      console.warn(`[numbers] ${l.user_id}'s number month wasn't charged (asked again next pass): ${(e as Error).message}`);
    }
  }
  return charged;
}
