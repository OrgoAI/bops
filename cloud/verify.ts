import { trackCloudEvent } from "./analytics.ts";
import type pg from "pg";
import type { CloudUser } from "./auth.ts";
import { config } from "./config.ts";
import { ensureUserRow, query, tx } from "./db.ts";
import { HttpError, readJson, sendJson, type Route } from "./http.ts";
import { linkVerifiedNumber } from "./lines.ts";
import type { VerifyCheckBody, VerifyResult, VerifyStartBody } from "./protocol.ts";
import { recordUsage } from "./usage.ts";

/**
 * /v1/verify/start and /v1/verify/check: texted (and emailed) codes through Twilio Verify, for the
 * user to prove a mobile number or an address is theirs. The Mac keeps what it shows (lib/server/
 * verify.ts); the cloud holds the Twilio key and keeps the rules that have to hold across users and
 * across cloud processes:
 *
 * - The app's limits, counted in bops.cloud_limits: 5 sends an hour per user and recipient, 8 per
 *   recipient from anyone, 12 per user, 30 for the whole cloud, 15 checks an hour per user and
 *   recipient, and 30 s between texts to one recipient (60 s for emails).
 * - Texts go to US and Canadian numbers only (not the Caribbean area codes that share +1).
 * - Whoever has a code out for a recipient holds it until the code expires (10 minutes, a row in
 *   bops.cloud_objects, provider "twilio"): nobody else can start or check one for it, so they can't
 *   use up its tries. A code can only be checked by the user it was sent for.
 * - A number another user already verified is refused before a text is paid for, and again when the
 *   code checks out (bops.owner_phones has one verified owner per number). A verified number is
 *   recorded there, and a verified address in bops.owner_emails. A verified number also becomes the
 *   owner of the user's phone lines that have none yet (lines.ts).
 *
 * Refusals answer VerifyErrorBody: a plain sentence, Twilio's error code when Twilio refused, and
 * retryAfter (seconds) when waiting helps.
 */

type Channel = "sms" | "email";

/** How long a Twilio verification lives (the Verify service default), and how long a recipient is held. */
const TTL_S = 600;
const RESEND_S: Record<Channel, number> = { sms: 30, email: 60 };
const PER_SLOT_HOUR = 5;
const PER_RECIPIENT_HOUR = 8;
const PER_USER_HOUR = 12;
const PER_CLOUD_HOUR = 30;
const CHECKS_HOUR = 15;

const twilioOn = () => {
  const t = config.twilio();
  return !!(t.serviceSid && t.keySid && t.keySecret);
};

/** Which kinds of codes this cloud can send (CloudSession.verify). Emailed codes need a mailer on the Verify service, so they're off unless BOPS_VERIFY_EMAIL=1. */
export const verifyChannels = () => ({ sms: twilioOn(), email: twilioOn() && config.verifyEmail() });

const noun = (channel: Channel) => (channel === "email" ? "address" : "number");
const minutes = (seconds: number) => Math.max(1, Math.ceil(seconds / 60));

/* ---------------- Recipients ---------------- */

/** NANP area codes outside the US and Canada: +1, but billed as international and a common target for SMS pumping. */
const NANP_ABROAD = new Set(["242", "246", "264", "268", "284", "345", "441", "473", "649", "658", "664", "721", "758", "767", "784", "809", "829", "849", "868", "869", "876"]);

/** "(555) 123-4567", "1 555 123 4567", "+44 20 7946 0958" → E.164, or "" (as the app's toE164). */
function toE164(input: string) {
  const d = input.replace(/[^\d+]/g, "");
  const e164 = d.startsWith("+") ? `+${d.slice(1).replace(/\+/g, "")}` : d.length === 10 ? `+1${d}` : d.length === 11 && d.startsWith("1") ? `+${d}` : "";
  return /^\+\d{10,15}$/.test(e164) ? e164 : "";
}

const textable = (e164: string) => /^\+1\d{10}$/.test(e164) && !NANP_ABROAD.has(e164.slice(2, 5));

/** " Me@Example.com " → "me@example.com", or "" when it isn't an email address (as the app's normalizeEmail). */
function normalizeEmail(input: string) {
  const a = input.trim().toLowerCase();
  if (!a || a.length > 254 || /\s/.test(a)) return "";
  const [local, domain, ...more] = a.split("@");
  if (more.length || !local || !domain) return "";
  if (!/^[a-z0-9!#$%&'*+/=?^_`{|}~.-]+$/.test(local) || !/^[a-z0-9-]+(\.[a-z0-9-]+)+$/.test(domain)) return "";
  return a;
}

/** Domains where only bots have addresses: never the user's own. */
const botDomain = (address: string) => /(^|\.)(agentmail\.to|bops\.bot)$/.test(address.slice(address.lastIndexOf("@") + 1));

function recipient(channel: Channel, raw: unknown) {
  const to = typeof raw === "string" ? (channel === "sms" ? toE164(raw) : normalizeEmail(raw)) : "";
  if (!to) throw new HttpError(400, channel === "sms" ? "That doesn't look like a phone number." : "That doesn't look like an email address.", { code: 60200 });
  return to;
}

/* ---------------- Twilio ---------------- */

/** Twilio's refusal as the answer to the Mac: its status where that means the same here (a 401 here means the Orgo key), its code, and Retry-After. */
function twilioRefused(status: number, code: unknown, retryAfter: number) {
  const extra = { ...(typeof code === "number" ? { code } : {}), ...(retryAfter > 0 ? { retryAfter } : {}) };
  if (status === 400) return new HttpError(400, "Twilio turned that down.", extra);
  if (status === 404) return new HttpError(404, "That code can't be used anymore. Send a new one.", extra);
  if (status === 429) return new HttpError(429, "Too many tries. Try again later.", extra);
  console.warn(`[verify] Twilio answered ${status}${typeof code === "number" ? ` ${code}` : ""}`);
  return new HttpError(502, "Codes aren't working on this cloud right now. Try again in a minute.", extra);
}

/** POST a form to the Verify service, with one retry on a 5xx or a dropped connection (as the app does). */
async function twilio(path: string, form: Record<string, string>, attempt = 0): Promise<VerifyResult> {
  const t = config.twilio();
  let res: Response;
  try {
    res = await fetch(`${config.upstream.twilioVerify()}/v2/Services/${encodeURIComponent(t.serviceSid)}/${path}`, {
      method: "POST",
      headers: { authorization: `Basic ${Buffer.from(`${t.keySid}:${t.keySecret}`).toString("base64")}`, "content-type": "application/x-www-form-urlencoded" },
      body: new URLSearchParams(form).toString(),
      signal: AbortSignal.timeout(15_000),
    });
  } catch {
    if (attempt < 1) return twilio(path, form, attempt + 1);
    throw new HttpError(502, "Couldn't reach Twilio right now. Try again in a minute.");
  }
  if (res.status >= 500 && attempt < 1) return twilio(path, form, attempt + 1);
  const body = (await res.json().catch(() => ({}))) as { sid?: unknown; status?: unknown; code?: unknown };
  if (!res.ok) throw twilioRefused(res.status, body.code, Number(res.headers.get("retry-after")));
  return { sid: String(body.sid ?? ""), status: String(body.status ?? "") };
}

/* ---------------- Holds and limits ---------------- */

const holdId = (channel: Channel, to: string) => `${channel}:${to}`;

/** One more in this hour's count for `key`, or a 429 when it's already at `limit`. The count goes up only when it's under. */
async function count(c: pg.PoolClient, key: string, limit: number, message: (min: number) => string) {
  const hour = 3_600_000;
  const windowStart = Math.floor(Date.now() / hour) * hour;
  const r = await c.query(
    `INSERT INTO bops.cloud_limits (key, window_start, count) VALUES ($1, to_timestamp($2::float8 / 1000), 1)
     ON CONFLICT (key, window_start) DO UPDATE SET count = cloud_limits.count + 1 WHERE cloud_limits.count < $3
     RETURNING count`,
    [key, windowStart, limit],
  );
  if (r.rowCount) return;
  const wait = Math.ceil((windowStart + hour - Date.now()) / 1000);
  throw new HttpError(429, message(minutes(wait)), { retryAfter: wait });
}

/**
 * Before a send: hold the recipient for this user (or keep holding it; another user's unexpired hold
 * wins), keep the gap since the last send, and count the send against every limit. All or nothing.
 * `fresh` is true when this call started the hold, so a send that fails can let it go.
 */
async function reserve(userId: string, channel: Channel, to: string): Promise<{ fresh: boolean }> {
  return tx(async (c) => {
    const held = await c.query<{ fresh: boolean }>(
      `INSERT INTO bops.cloud_objects (provider, object_id, kind, user_id) VALUES ('twilio', $1, 'verification', $2)
       ON CONFLICT (provider, object_id) DO UPDATE
         SET user_id = EXCLUDED.user_id,
             created_at = CASE WHEN cloud_objects.user_id = EXCLUDED.user_id AND cloud_objects.created_at > now() - make_interval(secs => $3) THEN cloud_objects.created_at ELSE now() END
         WHERE cloud_objects.user_id = EXCLUDED.user_id OR cloud_objects.created_at <= now() - make_interval(secs => $3)
       RETURNING created_at = now() AS fresh`,
      [holdId(channel, to), userId, TTL_S],
    );
    if (!held.rowCount) {
      const r = await c.query<{ left: number }>(
        "SELECT extract(epoch FROM created_at + make_interval(secs => $2) - now())::float8 AS left FROM bops.cloud_objects WHERE provider = 'twilio' AND object_id = $1",
        [holdId(channel, to), TTL_S],
      );
      throw new HttpError(409, `Someone else is checking this ${noun(channel)} right now. Try again in a few minutes.`, { retryAfter: Math.max(1, Math.ceil(r.rows[0]?.left ?? TTL_S)) });
    }
    const last = await c.query<{ ago: number | null }>("SELECT extract(epoch FROM now() - max(window_start))::float8 AS ago FROM bops.cloud_limits WHERE key = $1", [
      `verify:last:${channel}:${userId}:${to}`,
    ]);
    const ago = last.rows[0]?.ago;
    if (ago !== null && ago !== undefined && ago < RESEND_S[channel])
      throw new HttpError(429, "A code is on its way. You can send another in a moment.", { retryAfter: Math.ceil(RESEND_S[channel] - ago) });
    const lots = (min: number) => `That's a lot of codes for one ${noun(channel)}. Try again in ${min} min.`;
    const tooMany = (min: number) => `Too many codes sent in the last hour. Try again in ${min} min.`;
    await count(c, `verify:slot:${channel}:${userId}:${to}`, PER_SLOT_HOUR, lots);
    await count(c, `verify:to:${channel}:${to}`, PER_RECIPIENT_HOUR, lots);
    await count(c, `verify:user:${userId}`, PER_USER_HOUR, tooMany);
    await count(c, "verify:cloud", PER_CLOUD_HOUR, tooMany);
    return { fresh: held.rows[0].fresh };
  });
}

const release = (userId: string, channel: Channel, to: string) =>
  query("DELETE FROM bops.cloud_objects WHERE provider = 'twilio' AND object_id = $1 AND user_id = $2", [holdId(channel, to), userId]);

/** Old counts and holds, cleared now and then (every cloud process does it, at most every 10 minutes). */
let sweptAt = 0;
function sweep() {
  if (Date.now() - sweptAt < 10 * 60_000) return;
  sweptAt = Date.now();
  const fail = (e: Error) => console.warn(`[verify] sweep: ${e.message}`);
  query("DELETE FROM bops.cloud_limits WHERE key LIKE 'verify:%' AND window_start < now() - interval '2 hours'").catch(fail);
  query("DELETE FROM bops.cloud_objects WHERE provider = 'twilio' AND created_at < now() - interval '1 hour'").catch(fail);
}

/* ---------------- Owners ---------------- */

const takenByOther = async (userId: string, e164: string) =>
  ((await query("SELECT 1 FROM bops.owner_phones WHERE phone_e164 = $1 AND verified_at IS NOT NULL AND orgo_user_id <> $2 LIMIT 1", [e164, userId])).rowCount ?? 0) > 0;

/** Record a number as this user's, verified now (consent: when its code was first sent). False when another user verified it first; the unique index settles a race. */
async function claimPhone(userId: string, e164: string, consentAt: Date, ref: string) {
  await ensureUserRow(userId);
  if (await takenByOther(userId, e164)) return false;
  try {
    await query(
      `INSERT INTO bops.owner_phones (orgo_user_id, phone_e164, consent_at, verified_at, verification_ref) VALUES ($1, $2, $3, now(), $4)
       ON CONFLICT (orgo_user_id, phone_e164) DO UPDATE
         SET consent_at = EXCLUDED.consent_at, verified_at = now(), verification_ref = EXCLUDED.verification_ref, updated_at = now()`,
      [userId, e164, consentAt, ref],
    );
    return true;
  } catch (e) {
    if ((e as { code?: string }).code === "23505") return false;
    throw e;
  }
}

async function keepEmail(userId: string, email: string, ref: string) {
  await ensureUserRow(userId);
  await query(
    `INSERT INTO bops.owner_emails (orgo_user_id, email, verified_at, verification_ref) VALUES ($1, $2, now(), $3)
     ON CONFLICT (orgo_user_id, email) DO UPDATE SET verified_at = now(), verification_ref = EXCLUDED.verification_ref, updated_at = now()`,
    [userId, email, ref],
  );
}

/* ---------------- The two calls ---------------- */

function channelOn(channel: Channel) {
  if (!verifyChannels()[channel])
    throw new HttpError(503, channel === "email" ? "Adding another email by code isn't available yet." : "Checking numbers by text isn't set up on this cloud.");
}

const TAKEN = "That number is already verified on another Bops account.";

async function start(user: CloudUser, body: Partial<VerifyStartBody>): Promise<VerifyResult> {
  const channel = body.channel;
  if (channel !== "sms" && channel !== "email") throw new HttpError(400, "Say whether to text or email the code.");
  channelOn(channel);
  const to = recipient(channel, body.to);
  if (channel === "sms" && !textable(to)) throw new HttpError(400, "Codes can only be texted to US and Canadian mobile numbers for now.", { code: 60605 });
  if (channel === "email" && botDomain(to)) throw new HttpError(400, `Addresses on ${to.slice(to.lastIndexOf("@") + 1)} are for bots. Use your own email.`);
  if (channel === "sms" && (await takenByOther(user.id, to))) throw new HttpError(409, TAKEN);
  sweep();
  const { fresh } = await reserve(user.id, channel, to);
  let v: VerifyResult;
  try {
    v = await twilio("Verifications", { To: to, Channel: channel });
  } catch (e) {
    if (fresh) await release(user.id, channel, to);
    throw e;
  }
  if (v.status !== "pending" && fresh) await release(user.id, channel, to);
  await query("INSERT INTO bops.cloud_limits (key, window_start, count) VALUES ($1, now(), 1) ON CONFLICT DO NOTHING", [`verify:last:${channel}:${user.id}:${to}`]);
  recordUsage(user.id, `verify.${channel}`, 1).catch((e: Error) => console.warn(`[verify] usage: ${e.message}`));
  return v;
}

async function check(user: CloudUser, body: Partial<VerifyCheckBody>): Promise<VerifyResult> {
  const channel: Channel = typeof body.to === "string" && body.to.includes("@") ? "email" : "sms";
  channelOn(channel);
  const to = recipient(channel, body.to);
  const code = typeof body.code === "string" ? body.code.replace(/\D/g, "") : "";
  if (code.length < 4 || code.length > 10) throw new HttpError(400, `Enter the code from the ${channel === "email" ? "email" : "text"}.`, { code: 60200 });
  const hold = (
    await query<{ user_id: string; created_at: Date; expired: boolean }>(
      "SELECT user_id, created_at, created_at <= now() - make_interval(secs => $2) AS expired FROM bops.cloud_objects WHERE provider = 'twilio' AND object_id = $1",
      [holdId(channel, to), TTL_S],
    )
  ).rows[0];
  if (!hold || hold.user_id !== user.id) throw new HttpError(404, `Send a code to this ${noun(channel)} first.`);
  if (hold.expired) {
    await release(user.id, channel, to);
    throw new HttpError(404, "That code has expired. Send a new one.");
  }
  await tx((c) => count(c, `verify:check:${channel}:${user.id}:${to}`, CHECKS_HOUR, (min) => `Too many tries. Wait ${min} min and send a new code.`));
  let r: VerifyResult;
  try {
    r = await twilio("VerificationCheck", { To: to, Code: code });
  } catch (e) {
    // Finished at Twilio (expired, used up, approved before), or too many wrong codes: only a new code helps now.
    if (e instanceof HttpError && (e.status === 404 || e.extra?.code === 60202)) await release(user.id, channel, to);
    throw e;
  }
  // A wrong code leaves it pending (Twilio allows 5 tries); any other end lets the recipient go.
  if (r.status !== "pending") await release(user.id, channel, to);
  if (r.status === "approved") {
    if (channel === "sms" && !(await claimPhone(user.id, to, hold.created_at, r.sid))) throw new HttpError(409, TAKEN);
    if (channel === "sms") await linkVerifiedNumber(user.id, to).catch((e: Error) => console.warn(`[verify] couldn't link ${user.id}'s lines: ${e.message}`));
    if (channel === "email") await keepEmail(user.id, to, r.sid);
    trackCloudEvent(user.id, "bops_owner_contact_verified", { channel });
  }
  return r;
}

export const routes: Route[] = [
  {
    method: "POST",
    path: "/v1/verify/start",
    auth: "user",
    handle: async (req, res, { user }) => sendJson(res, 200, await start(user!, await readJson<Partial<VerifyStartBody>>(req))),
  },
  {
    method: "POST",
    path: "/v1/verify/check",
    auth: "user",
    handle: async (req, res, { user }) => sendJson(res, 200, await check(user!, await readJson<Partial<VerifyCheckBody>>(req))),
  },
];
