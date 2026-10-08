import type pg from "pg";
import { ensureUserRow, query, tx } from "./db.ts";
import { HttpError, readJson, sendJson, type Route } from "./http.ts";
import type { CallerVerdict, LineClaim, PhoneLine, PhoneLineIn, PhoneLineUnlink, PhoneOwnerRemove } from "./protocol.ts";

/**
 * Who owns each of a user's Bops numbers (bops.phone_lines, db/migrations/0006_phone_lines.sql), and
 * the check every call and text to one goes through. Owner: edge builder.
 *
 * - A line is written when a number is bought through the proxy (proxy.ts, which opens its 15
 *   minutes), when one is attached to an agent, and when the app says it got or assigned one
 *   (PUT /v1/phone/lines, with the bot or workspace it's for). Lines from before are backfilled by
 *   the migration.
 * - "First caller claims it": while a line has no owner and its 15 minutes run, the first phone
 *   number to call or text it becomes its owner, by one conditional UPDATE (WHERE owner_number IS
 *   NULL AND now() < claim_until), so only one caller can win. The number is also recorded in
 *   bops.owner_phones, where it can be verified for one Bops user only: a number another account
 *   already has can't claim a line here, and neither can another Bops number.
 * - Every delivery (callerVerdict): the caller is the owner when it's the line's owner_number, or
 *   one of the user's own numbers in bops.owner_phones (verified with a texted code, or claimed on
 *   another of their lines). Never from the app's uploaded state.
 * - The app reads its lines (GET /v1/phone/lines) to show "Linked to …" or "Call or text … in the
 *   next 15 minutes", can unlink an owner (a fresh 15 minutes opens), and can drop one of the user's
 *   numbers everywhere (Settings, Remove). A number verified with a texted code links the user's
 *   lines that have no owner yet (verify.ts).
 */

/** How long a new line (or one the user asked to link again) waits for its first caller. */
export const CLAIM_MINUTES = 15;

/** The last 10 digits of a US or Canadian (+1) number, or "" (lines are kept by them, as bops.cloud_numbers). */
export function lineDigits(raw: string) {
  const d = raw.replace(/[^\d+]/g, "");
  return /^\+?1?(\d{10})$/.exec(d)?.[1] ?? "";
}

/** A caller's number as E.164 ("(555) 123-4567", "15551234567" → "+15551234567"), or "" for a withheld or odd one. */
export function e164(raw: unknown) {
  if (typeof raw !== "string") return "";
  const d = raw.replace(/[^\d+]/g, "");
  const out = d.startsWith("+") ? `+${d.slice(1).replace(/\+/g, "")}` : d.length === 10 ? `+1${d}` : d.length === 11 && d.startsWith("1") ? `+${d}` : "";
  return /^\+\d{10,15}$/.test(out) ? out : "";
}

type LineRow = {
  digits: string;
  user_id: string;
  number_id: string | null;
  e164: string;
  bot_id: string | null;
  workspace_id: string | null;
  owner_number: string | null;
  claim_until: Date | null;
  claimed_at: Date | null;
  claimed_via: LineClaim | null;
};

const COLUMNS = "digits, user_id, number_id, e164, bot_id, workspace_id, owner_number, claim_until, claimed_at, claimed_via";

function lineOut(r: LineRow): PhoneLine {
  return {
    numberId: r.number_id,
    number: r.e164,
    botId: r.bot_id,
    workspaceId: r.workspace_id,
    owner: r.owner_number && r.claimed_via ? { number: r.owner_number, via: r.claimed_via, at: r.claimed_at?.toISOString() ?? null } : null,
    claimUntil: !r.owner_number && r.claim_until && r.claim_until.getTime() > Date.now() ? r.claim_until.toISOString() : null,
  };
}

/* ---------------- Writing lines ---------------- */

/**
 * Record a number as one of the user's lines. A number that moved from another user starts over (no
 * owner, no window). `open`: a line with no owner and no window running gets a fresh 15 minutes.
 * `botId` and `workspaceId` are kept when not given.
 */
export async function recordLine(userId: string, n: { id?: string | null; phoneNumber: string }, opts: { open?: boolean; botId?: string; workspaceId?: string } = {}): Promise<PhoneLine | null> {
  const digits = lineDigits(n.phoneNumber);
  if (!digits) return null;
  return tx(async (c) => {
    await c.query(
      `INSERT INTO bops.phone_lines (digits, user_id, number_id, e164, bot_id, workspace_id, claim_until)
       VALUES ($1, $2, $3, $4, $5, $6, CASE WHEN $7::boolean THEN now() + make_interval(mins => $8) END)
       ON CONFLICT (digits) DO UPDATE SET
         user_id = EXCLUDED.user_id,
         number_id = COALESCE(EXCLUDED.number_id, phone_lines.number_id),
         e164 = EXCLUDED.e164,
         bot_id = CASE WHEN phone_lines.user_id = EXCLUDED.user_id THEN COALESCE(EXCLUDED.bot_id, phone_lines.bot_id) ELSE EXCLUDED.bot_id END,
         workspace_id = CASE WHEN phone_lines.user_id = EXCLUDED.user_id THEN COALESCE(EXCLUDED.workspace_id, phone_lines.workspace_id) ELSE EXCLUDED.workspace_id END,
         owner_number = CASE WHEN phone_lines.user_id = EXCLUDED.user_id THEN phone_lines.owner_number END,
         claimed_at = CASE WHEN phone_lines.user_id = EXCLUDED.user_id THEN phone_lines.claimed_at END,
         claimed_via = CASE WHEN phone_lines.user_id = EXCLUDED.user_id THEN phone_lines.claimed_via END,
         claim_until = CASE WHEN phone_lines.user_id = EXCLUDED.user_id THEN phone_lines.claim_until END,
         -- A number given back (a plan's, 30 days after it ended) or now someone else's starts over as an ordinary line.
         status = CASE WHEN phone_lines.user_id = EXCLUDED.user_id AND phone_lines.status <> 'released' THEN phone_lines.status ELSE 'ready' END,
         plan = phone_lines.user_id = EXCLUDED.user_id AND phone_lines.status <> 'released' AND phone_lines.plan,
         agent_id = CASE WHEN phone_lines.user_id = EXCLUDED.user_id AND phone_lines.status <> 'released' THEN phone_lines.agent_id END,
         paused_at = CASE WHEN phone_lines.user_id = EXCLUDED.user_id AND phone_lines.status <> 'released' THEN phone_lines.paused_at END,
         updated_at = now()`,
      [digits, userId, n.id ?? null, `+1${digits}`, opts.botId ?? null, opts.workspaceId ?? null, !!opts.open, CLAIM_MINUTES],
    );
    if (opts.open)
      await c.query(
        `UPDATE bops.phone_lines SET claim_until = now() + make_interval(mins => $2), updated_at = now()
         WHERE digits = $1 AND owner_number IS NULL AND (claim_until IS NULL OR claim_until <= now())`,
        [digits, CLAIM_MINUTES],
      );
    return lineOut((await c.query<LineRow>(`SELECT ${COLUMNS} FROM bops.phone_lines WHERE digits = $1`, [digits])).rows[0]);
  });
}

/** The user's lines, newest first. */
export async function linesOf(userId: string): Promise<PhoneLine[]> {
  const r = await query<LineRow>(`SELECT ${COLUMNS} FROM bops.phone_lines WHERE user_id = $1 ORDER BY created_at DESC`, [userId]);
  return r.rows.map(lineOut);
}

/**
 * Drop one of the user's numbers from bops.owner_phones, unless another of their lines still has it
 * as its owner. In the transaction that unlinked or removed it.
 */
async function releaseOwnerNumber(c: pg.PoolClient, userId: string, number: string) {
  await c.query(
    `DELETE FROM bops.owner_phones WHERE orgo_user_id = $1 AND phone_e164 = $2
       AND NOT EXISTS (SELECT 1 FROM bops.phone_lines WHERE user_id = $1 AND owner_number = $2)`,
    [userId, number],
  );
}

/** The line's owner no longer counts as the user (anywhere, unless another line has them too), and a fresh 15 minutes opens. */
export async function unlinkLine(userId: string, numberId: string): Promise<PhoneLine | null> {
  return tx(async (c) => {
    const before = (await c.query<LineRow>(`SELECT ${COLUMNS} FROM bops.phone_lines WHERE user_id = $1 AND number_id = $2 FOR UPDATE`, [userId, numberId])).rows[0];
    if (!before) return null;
    const r = await c.query<LineRow>(
      `UPDATE bops.phone_lines SET owner_number = NULL, claimed_at = NULL, claimed_via = NULL, claim_until = now() + make_interval(mins => $2), updated_at = now()
       WHERE digits = $1 RETURNING ${COLUMNS}`,
      [before.digits, CLAIM_MINUTES],
    );
    if (before.owner_number) await releaseOwnerNumber(c, userId, before.owner_number);
    return lineOut(r.rows[0]);
  });
}

/** One of the user's own numbers no longer counts as them (Settings, Remove): out of bops.owner_phones and off every line of theirs it owns. */
export async function removeOwnerNumber(userId: string, number: string) {
  const n = e164(number);
  if (!n) return;
  await tx(async (c) => {
    await c.query("UPDATE bops.phone_lines SET owner_number = NULL, claimed_at = NULL, claimed_via = NULL, updated_at = now() WHERE user_id = $1 AND owner_number = $2", [userId, n]);
    await releaseOwnerNumber(c, userId, n);
  });
}

/** A number the user just verified with a texted code links their lines that have no owner yet (their windows close). */
export async function linkVerifiedNumber(userId: string, number: string) {
  const n = e164(number);
  if (!n) return;
  await query(
    `UPDATE bops.phone_lines SET owner_number = $2, claimed_at = now(), claimed_via = 'sms_code', updated_at = now()
     WHERE user_id = $1 AND owner_number IS NULL`,
    [userId, n],
  );
}

/* ---------------- Who is calling ---------------- */

/**
 * The race-safe claim: the line takes `caller` as its owner only if it still has none and its window
 * is open, and the number goes into bops.owner_phones for this user. A number another Bops user has
 * verified (the unique index there), or another Bops number, never wins; then nothing changes.
 */
async function claimLine(userId: string, digits: string, caller: string, via: "call" | "text"): Promise<boolean> {
  await ensureUserRow(userId);
  try {
    return await tx(async (c) => {
      const won = await c.query(
        `UPDATE bops.phone_lines SET owner_number = $3, claimed_at = now(), claimed_via = $4, updated_at = now()
         WHERE digits = $1 AND user_id = $2 AND owner_number IS NULL AND now() < claim_until
           AND NOT EXISTS (SELECT 1 FROM bops.cloud_numbers WHERE digits = $5)
         RETURNING digits`,
        [digits, userId, caller, via, lineDigits(caller) || "-"],
      );
      if (!won.rowCount) return false;
      await c.query(
        `INSERT INTO bops.owner_phones (orgo_user_id, phone_e164, consent_at, verified_at, verification_ref) VALUES ($1, $2, now(), now(), $3)
         ON CONFLICT (orgo_user_id, phone_e164) DO UPDATE SET verified_at = COALESCE(owner_phones.verified_at, now()), updated_at = now()`,
        [userId, caller, `claim:${via}`],
      );
      return true;
    });
  } catch (e) {
    // Another Bops user has this number verified (owner_phones_verified_once): no claim.
    if ((e as { code?: string }).code === "23505") return false;
    throw e;
  }
}

/**
 * Whether `from` is the owner of the user's line `to`, for one delivery. `claim` ("call" or "text")
 * lets a caller who isn't claim the line while its 15 minutes run; leave it out for what can't claim
 * (a tapback, a group text, a carrier keyword).
 */
export async function callerVerdict(userId: string, to: string, from: string, claim?: "call" | "text"): Promise<CallerVerdict> {
  const caller = e164(from);
  if (!caller) return { owner: false };
  const digits = lineDigits(to);
  const r = await query<{ owner_number: string | null; open: boolean | null; verified: boolean }>(
    `SELECT l.owner_number, l.claim_until > now() AS open,
            EXISTS (SELECT 1 FROM bops.owner_phones p WHERE p.orgo_user_id = $1 AND p.phone_e164 = $3 AND p.verified_at IS NOT NULL) AS verified
     FROM (SELECT 1) one LEFT JOIN bops.phone_lines l ON l.digits = $2 AND l.user_id = $1`,
    [userId, digits || "-", caller],
  );
  const row = r.rows[0];
  if (row.verified || row.owner_number === caller) return { owner: true };
  if (claim && digits && !row.owner_number && row.open && (await claimLine(userId, digits, caller, claim))) return { owner: true, claimed: claim };
  return { owner: false };
}

/* ---------------- Routes ---------------- */

const str = (x: unknown) => (typeof x === "string" && x.trim() ? x.trim().slice(0, 200) : undefined);

/** The user's number by AgentPhone's id, from bops.cloud_numbers (recorded as their numbers passed through the proxy), or 404. */
async function ownNumber(userId: string, numberId: unknown) {
  const id = str(numberId);
  const r = id ? await query<{ e164: string | null; digits: string }>("SELECT e164, digits FROM bops.cloud_numbers WHERE user_id = $1 AND number_id = $2", [userId, id]) : null;
  const row = r?.rows[0];
  if (!id || !row) throw new HttpError(404, "That number isn't one of yours.");
  return { id, phoneNumber: row.e164 ?? `+1${row.digits}` };
}

export const routes: Route[] = [
  {
    method: "GET",
    path: "/v1/phone/lines",
    auth: "user",
    handle: async (_req, res, { user }) => sendJson(res, 200, { lines: await linesOf(user!.id) }),
  },
  {
    method: "PUT",
    path: "/v1/phone/lines",
    auth: "user",
    handle: async (req, res, { user }) => {
      const body = await readJson<Partial<PhoneLineIn>>(req);
      const n = await ownNumber(user!.id, body.numberId);
      const line = await recordLine(user!.id, n, { open: body.open === true, botId: str(body.botId), workspaceId: str(body.workspaceId) });
      if (!line) throw new HttpError(400, "Only US and Canadian numbers can take calls through Bops for now.");
      sendJson(res, 200, { line });
    },
  },
  {
    method: "POST",
    path: "/v1/phone/lines/unlink",
    auth: "user",
    handle: async (req, res, { user }) => {
      const body = await readJson<Partial<PhoneLineUnlink>>(req);
      const line = await unlinkLine(user!.id, str(body.numberId) ?? "");
      if (!line) throw new HttpError(404, "That number isn't one of yours.");
      sendJson(res, 200, { line });
    },
  },
  {
    method: "POST",
    path: "/v1/phone/owners/remove",
    auth: "user",
    handle: async (req, res, { user }) => {
      const body = await readJson<Partial<PhoneOwnerRemove>>(req);
      if (!e164(body.number)) throw new HttpError(400, "That doesn't look like a phone number.");
      await removeOwnerNumber(user!.id, String(body.number));
      sendJson(res, 200, { ok: true });
    },
  },
];
