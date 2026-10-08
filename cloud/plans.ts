import { trackCloudEvent } from "./analytics.ts";
import { createHmac, timingSafeEqual } from "node:crypto";
import { config } from "./config.ts";
import { db, ensureUserRow, query } from "./db.ts";
import { currentHandle, MAIN_WORKSPACE } from "./handles.ts";
import { HttpError, readBody, sendJson, type Route } from "./http.ts";
import { lineDigits } from "./lines.ts";
import { BOPS_TIERS, PLAN_LIMIT, PLAN_REQUIRED, type BopsTier, type CloudPlanPayload } from "./protocol.ts";
import { ensurePlanInbox, ensurePlanPhone, mainBotOf, pausePlanItems, releaseAfterPause } from "./provision.ts";
import { queueForMac } from "./tunnel.ts";

/**
 * Each user's Bops plan in the cloud, and what changes with it. orgo-web keeps the plan
 * (profiles.bops_tier, written by its Stripe webhook), which bops_app can't read, so:
 *
 * - **orgo-web tells the cloud** (POST /v1/internal/plan-changed {userId, tier, at}, signed with
 *   BOPS_CLOUD_PLAN_SECRET: HMAC-SHA256 of "{x-bops-timestamp}.{raw body}" as "sha256=<hex>" in
 *   x-bops-signature, at most 5 minutes off). Best effort on its side: it sends again on the plan's
 *   next Stripe event, so the route is idempotent and `at` orders the notices (an older one never
 *   undoes a newer one).
 * - **The cloud asks orgo-web too**, at each session start (GET /api/bops/plan with the user's own
 *   Orgo key, as the app does), so a notice that never came is made up for the next time the app opens.
 *
 * Kept in bops.plans. Then settle() makes the user's things match the plan:
 *
 * - **Pro or Max:** the main bot gets its number and inbox (provision.ts), whether or not the Mac
 *   is open; a paused one comes back. The Mac hears about them (a "plan" event, CloudPlanPayload)
 *   and takes them into its state.
 * - **Free:** the plan's number and inbox are paused: calls and texts to the number aren't answered
 *   (hooks.ts asks lineStopped) and the Mac stops reading the inbox. 30 days later, still on Free,
 *   they're given back (sweep).
 * - **Limits** (BOPS_PLAN_LIMITS=1, off by default): each plan's phone numbers (BOPS_TIERS: Free
 *   none, Pro 1, Max up to 5) are all the user can hold; proxy.ts asks requireRoomForNumber before a
 *   purchase. The app holds each plan to its emails the same way (CloudSession.plan). Beyond the
 *   main bot's, which the plan brings, Max's numbers and emails come only when the user asks.
 */

const isTier = (x: unknown): x is BopsTier => typeof x === "string" && Object.hasOwn(BOPS_TIERS, x);
export const paidTier = (t: BopsTier) => t !== "free_bops";

/** The user's plan as the cloud last heard it; Free until it hears otherwise. */
export async function tierOf(userId: string): Promise<BopsTier> {
  const r = await query<{ tier: BopsTier }>("SELECT tier FROM bops.plans WHERE user_id = $1", [userId]);
  return r.rows[0]?.tier ?? "free_bops";
}

/**
 * Keep what orgo-web said at `at`, unless something it said later is kept already. `kept`: this was
 * newer, and stands now; `before`: the tier before it.
 */
export async function recordTier(userId: string, tier: BopsTier, at: Date, source: "notice" | "session"): Promise<{ kept: boolean; before: BopsTier }> {
  await ensureUserRow(userId);
  const r = await query<{ before: BopsTier | null; kept: boolean }>(
    `WITH before AS (SELECT tier FROM bops.plans WHERE user_id = $1),
          kept AS (
            INSERT INTO bops.plans AS p (user_id, tier, changed_at, source) VALUES ($1, $2, $3, $4)
            ON CONFLICT (user_id) DO UPDATE SET tier = EXCLUDED.tier, changed_at = EXCLUDED.changed_at, source = EXCLUDED.source, updated_at = now()
            WHERE p.changed_at < EXCLUDED.changed_at
            RETURNING 1)
     SELECT (SELECT tier FROM before) AS before, EXISTS (SELECT 1 FROM kept) AS kept`,
    [userId, tier, at, source],
  );
  const kept = r.rows[0].kept;
  const before = r.rows[0].before ?? "free_bops";
  if (kept && before !== tier)
    trackCloudEvent(userId, "bops_plan_changed", { from_plan: before, to_plan: tier, heard_via: source }, { once: `${before}>${tier}@${at.toISOString()}`, set: { bops_plan: tier } });
  return { kept, before };
}

/* ---------------- Asking orgo-web ---------------- */

/** When the cloud last asked orgo-web about each user (when the question went out), and what it said, so a burst of calls doesn't ask again each time. */
const asked = new Map<string, { at: number; tier: BopsTier | null }>();
const ASK_EVERY_MS = 60_000;

/**
 * The user's plan as orgo-web says it (GET /api/bops/plan with their Orgo key), or null when it
 * doesn't say (not there yet, or down), with `at`, when the question went out. Asked again only after
 * a minute, unless `fresh`: an answer from that minute comes back with its own `at`, so keeping it
 * (recordTier) never undoes a notice orgo-web sent after it was read.
 */
export async function askOrgoForTier(userId: string, key: string, fresh = false): Promise<{ tier: BopsTier | null; at: Date }> {
  const last = asked.get(userId);
  if (!fresh && last && Date.now() - last.at < ASK_EVERY_MS) return { tier: last.tier, at: new Date(last.at) };
  const at = Date.now();
  let tier: BopsTier | null = null;
  try {
    const res = await fetch(`${config.orgoOrigin()}/api/bops/plan`, { headers: { Authorization: `Bearer ${key}`, Accept: "application/json" }, signal: AbortSignal.timeout(8_000) });
    const body = res.ok ? ((await res.json().catch(() => null)) as { tier?: unknown } | null) : null;
    tier = isTier(body?.tier) ? body.tier : null;
  } catch {}
  asked.set(userId, { at, tier });
  if (asked.size > 10_000) for (const [k, v] of asked) if (Date.now() - v.at > ASK_EVERY_MS) asked.delete(k);
  return { tier, at: new Date(at) };
}

/**
 * At each session start (session.ts): ask orgo-web for the plan, keep it, and make the user's things
 * match it. In the background: the session never waits on it. The time kept is when the question
 * went out, so an answer read before a change orgo-web was writing never undoes that change's notice.
 */
export async function atSession(userId: string, key: string): Promise<void> {
  const said = key ? await askOrgoForTier(userId, key, true) : null;
  const r = said?.tier ? await recordTier(userId, said.tier, said.at, "session") : null;
  const changed = !!r?.kept && r.before !== said?.tier;
  await settle(userId, { force: changed, tierChanged: changed });
}

/* ---------------- Making things match the plan ---------------- */

/** Users whose plan is waiting for the Mac's first state upload (the main bot isn't known before it). */
const waitingForState = new Set<string>();
const running = new Map<string, Promise<void>>();
const settledAt = new Map<string, number>();
/** How often the same user's things are checked when nothing changed (a session start, a repeated notice). Tests shorten it. */
export const planTiming = { settleGapMs: 60_000, sweepEveryMs: 3600_000 };

/**
 * Make the user's things match their plan (see the top), one run at a time per user (and across
 * cloud processes, a lock in Postgres). `force`: the plan changed, so it runs however recently it
 * ran; otherwise at most once a minute. Never throws: a failure is logged, and the next session start
 * or notice tries again.
 */
export function settle(userId: string, opts: { force?: boolean; tierChanged?: boolean } = {}): Promise<void> {
  const last = settledAt.get(userId) ?? 0;
  if (!opts.force && Date.now() - last < planTiming.settleGapMs) return running.get(userId) ?? Promise.resolve();
  settledAt.set(userId, Date.now());
  const next = (running.get(userId) ?? Promise.resolve())
    .then(() => locked(userId, () => settleNow(userId, !!opts.tierChanged)))
    .catch((e: Error) => console.warn(`[plans] ${userId}: ${e.message}`));
  running.set(userId, next);
  void next.finally(() => {
    if (running.get(userId) === next) running.delete(userId);
  });
  return next;
}

/**
 * How many users' plan work runs at once. Each holds a pool connection for its lock while its own
 * queries need others (db.ts keeps 10), so without a cap a burst (every Mac reconnecting after a
 * restart) could take every connection for locks and stall the whole cloud, calls and texts included.
 */
const AT_ONCE = 3;
let holding = 0;
const queued: (() => void)[] = [];

async function oneOfFew<T>(work: () => Promise<T>): Promise<T> {
  // A place is handed straight to the next one waiting, so the count never goes over.
  if (holding < AT_ONCE) holding++;
  else await new Promise<void>((resolve) => queued.push(resolve));
  try {
    return await work();
  } finally {
    const next = queued.shift();
    if (next) next();
    else holding--;
  }
}

/** Run `work` holding the user's plan lock in Postgres (a second cloud process, or the sweep, waits for it). */
function locked<T>(userId: string, work: () => Promise<T>): Promise<T> {
  return oneOfFew(async () => {
    const c = await db().connect();
    try {
      await c.query("SELECT pg_advisory_lock(hashtextextended($1, 0))", [`bops-plan:${userId}`]);
      return await work();
    } finally {
      await c.query("SELECT pg_advisory_unlock(hashtextextended($1, 0))", [`bops-plan:${userId}`]).catch(() => {});
      c.release();
    }
  });
}

async function settleNow(userId: string, tierChanged: boolean) {
  const tier = await tierOf(userId);
  if (!paidTier(tier)) {
    waitingForState.delete(userId);
    const paused = await pausePlanItems(userId);
    if (tierChanged || paused.phone || paused.email) await tellMac(userId, { tier, botId: (await mainBotOf(userId))?.bot.id ?? null, workspaceId: MAIN_WORKSPACE, ...paused });
    return;
  }
  const main = await mainBotOf(userId);
  if (!main) {
    // Nothing to set up for until the Mac says who the main bot is: its next state upload does it.
    waitingForState.add(userId);
    if (tierChanged) await tellMac(userId, { tier, botId: null, workspaceId: MAIN_WORKSPACE });
    return;
  }
  waitingForState.delete(userId);
  const phone = await ensurePlanPhone(userId, main);
  const email = await ensurePlanInbox(userId, main);
  if (!tierChanged && !phone?.changed && !email?.changed) return;
  const claimed = email?.handle ?? (await currentHandle(userId, MAIN_WORKSPACE));
  const handle = claimed ? { handle: claimed.handle, auto: claimed.auto, changesLeft: claimed.changesLeft } : null;
  await tellMac(userId, {
    tier,
    botId: main.bot.id,
    workspaceId: MAIN_WORKSPACE,
    ...(phone?.phone.numberId ? { phone: phone.phone } : {}),
    ...(email?.email.inboxId ? { email: email.email } : {}),
    ...(handle ? { handle } : {}),
  });
}

/** The Mac takes it into its state when it's connected, or when it next connects (bops.cloud_pending). */
async function tellMac(userId: string, payload: CloudPlanPayload) {
  await queueForMac(userId, "plan", payload);
}

/** After a state upload (state.ts): a paid plan that was waiting for the main bot is set up now. */
export function afterStateUpload(userId: string) {
  if (waitingForState.has(userId)) void settle(userId, { force: true });
}

/**
 * Every hour: give back what was paused 30 days ago (provision.ts releaseAfterPause, each under the
 * user's lock, so an upgrade at that moment never has its number given back under it), telling each
 * user's Mac; and try again a paid plan's number or inbox that a provider failed on (broken, or cut
 * short while it was set up), so it doesn't wait for the app to open.
 */
export async function sweep(): Promise<number> {
  const released = await releaseAfterPause(
    async (userId, item) => tellMac(userId, { tier: await tierOf(userId), botId: (await mainBotOf(userId))?.bot.id ?? null, workspaceId: MAIN_WORKSPACE, ...item }),
    locked,
  );
  const stuck = await query<{ user_id: string }>(
    `SELECT DISTINCT x.user_id FROM (
       SELECT user_id FROM bops.phone_lines WHERE plan AND status IN ('setting_up', 'broken') AND updated_at < now() - interval '5 minutes'
       UNION SELECT user_id FROM bops.mail_inboxes WHERE plan AND status IN ('setting_up', 'broken') AND updated_at < now() - interval '5 minutes'
     ) x JOIN bops.plans p ON p.user_id = x.user_id AND p.tier <> 'free_bops'
     LIMIT 100`,
  );
  for (const s of stuck.rows) await settle(s.user_id, { force: true });
  return released;
}

/** Release paused things every hour (server.ts starts it; tests call sweep directly). */
export function startSweeps(): () => void {
  const run = () => void sweep().catch((e: Error) => console.warn(`[plans] sweep: ${e.message}`));
  const first = setTimeout(run, 60_000);
  const every = setInterval(run, planTiming.sweepEveryMs);
  first.unref();
  every.unref();
  return () => {
    clearTimeout(first);
    clearInterval(every);
  };
}

/* ---------------- What the plan allows ---------------- */

/** How many phone numbers the user holds against their plan: every line of theirs not given back. */
export async function numbersHeld(userId: string): Promise<number> {
  const r = await query<{ n: number }>("SELECT count(*)::int AS n FROM bops.phone_lines WHERE user_id = $1 AND status <> 'released'", [userId]);
  return r.rows[0]?.n ?? 0;
}

/** Whether the plan has room for one more number with `held` already. */
export const roomForNumber = (tier: BopsTier, held: number) => held < BOPS_TIERS[tier].phoneNumbers;

/**
 * The refusal for one number more than the plan includes, in the plan's words: Free and Pro are
 * offered the plan that has room (402 PLAN_REQUIRED, `upgrade`, `upgradeTo`); Max is at its most.
 */
export function numberRefusal(tier: BopsTier): HttpError {
  const pro = BOPS_TIERS.pro_bops.phoneNumbers;
  const max = BOPS_TIERS.max_bops.phoneNumbers;
  if (tier === "max_bops") return new HttpError(402, `Max includes up to ${max} phone numbers, and you have ${max}.`, { code: PLAN_LIMIT });
  if (tier === "pro_bops") return new HttpError(402, `Pro includes ${pro} phone number. Max includes up to ${max}.`, { code: PLAN_REQUIRED, upgrade: true, upgradeTo: "max_bops" });
  return new HttpError(402, `Free doesn't include a phone number. Pro includes ${pro}, and Max up to ${max}.`, { code: PLAN_REQUIRED, upgrade: true, upgradeTo: "pro_bops" });
}

/**
 * With plan limits on (BOPS_PLAN_LIMITS=1), a number is bought only while the user holds fewer than
 * their plan includes (Free none, Pro 1, Max 5; the main bot's from the plan counts), else refused
 * (numberRefusal) before anything is bought. When the cloud's word leaves no room, orgo-web is asked
 * first (with the caller's key), so a notice that hasn't come yet doesn't stop someone who just paid.
 */
export async function requireRoomForNumber(userId: string, key?: string): Promise<void> {
  if (!config.planLimits()) return;
  let tier = await tierOf(userId);
  const held = await numbersHeld(userId);
  if (!roomForNumber(tier, held) && tier !== "max_bops" && key) {
    const said = await askOrgoForTier(userId, key);
    if (said.tier && said.tier !== tier && roomForNumber(said.tier, held)) {
      // Kept as of when it was read (it may be the minute's answer): a later notice still stands.
      const r = await recordTier(userId, said.tier, said.at, "session");
      if (r.kept) {
        void settle(userId, { force: true, tierChanged: r.before !== said.tier });
        tier = said.tier;
      }
    }
  }
  if (!roomForNumber(tier, held)) throw numberRefusal(tier);
}

/**
 * A number bought through the proxy for the main bot (the app's ensurePhone, with its tag
 * bops-<install>-<bot>) while the plan has one for it, or is getting one right now: refused (409), so
 * the bot never ends up with two. The plan's number reaches the app with the plan's event.
 */
export async function refuseSecondPlanNumber(userId: string, externalId: unknown): Promise<void> {
  if (typeof externalId !== "string" || !externalId.startsWith("bops-")) return;
  const main = await mainBotOf(userId);
  if (!main || externalId !== `bops-${main.installId}-${main.bot.id}`) return;
  const kept = (await query<{ e164: string; status: string }>("SELECT e164, status FROM bops.phone_lines WHERE user_id = $1 AND plan AND status <> 'released' ORDER BY created_at DESC LIMIT 1", [userId])).rows[0];
  const settingUp = !kept && running.has(userId) && paidTier(await tierOf(userId));
  if (!kept && !settingUp) return;
  const said = !kept
    ? `${main.bot.name}'s number is being set up with your plan. It shows up in a moment.`
    : kept.status === "paused"
      ? `${main.bot.name}'s number from your plan, ${kept.e164}, is paused while you're on Free. Upgrade to use it again.`
      : `${main.bot.name}'s number comes with your plan: ${kept.e164}.`;
  throw new HttpError(409, said, { code: "plan_number" });
}

/**
 * A plan line on this agent is stopped (paused or given back) and none on it still works: a number
 * given back leaves its agent behind, and the plan's next number goes on that same agent (found by its tag).
 */
const AGENT_STOPPED = `SELECT 1 FROM bops.phone_lines WHERE user_id = $1 AND agent_id = $2 AND plan AND status IN ('paused', 'released')
  AND NOT EXISTS (SELECT 1 FROM bops.phone_lines WHERE user_id = $1 AND agent_id = $2 AND status NOT IN ('paused', 'released')) LIMIT 1`;

/**
 * Whether a text out from one of the user's numbers is refused: the number is a plan's that's paused
 * (the plan ended) or given back. By its AgentPhone id when the text says it (the app always does),
 * else by its agent.
 */
export async function sendingStopped(userId: string, numberId: string, agentId: string): Promise<boolean> {
  const r = numberId
    ? await query("SELECT 1 FROM bops.phone_lines WHERE user_id = $1 AND number_id = $2 AND plan AND status IN ('paused', 'released') LIMIT 1", [userId, numberId])
    : agentId
      ? await query(AGENT_STOPPED, [userId, agentId])
      : null;
  return !!r?.rowCount;
}

/**
 * Whether a call or text to one of the user's numbers goes unanswered: the number is a plan's that's
 * paused (the plan ended) or given back. By the number called when the delivery says it, else by its
 * agent (AGENT_STOPPED).
 */
export async function lineStopped(userId: string, agentId: string, to: string): Promise<boolean> {
  const digits = lineDigits(to);
  const r = digits
    ? await query("SELECT 1 FROM bops.phone_lines WHERE user_id = $1 AND digits = $2 AND status IN ('paused', 'released')", [userId, digits])
    : await query(AGENT_STOPPED, [userId, agentId || "-"]);
  return !!r.rowCount;
}

/* ---------------- orgo-web's notice ---------------- */

const one = (v: string | string[] | undefined) => (Array.isArray(v) ? (v[0] ?? "") : (v ?? ""));

/** HMAC-SHA256 of "{timestamp}.{raw body}" with BOPS_CLOUD_PLAN_SECRET, as "sha256=<hex>", at most 5 minutes off. */
export function planSigned(secret: string, timestamp: string, body: Buffer, signature: string, now = Date.now()): boolean {
  if (!/^\d{9,11}$/.test(timestamp) || Math.abs(now / 1000 - Number(timestamp)) > 300) return false;
  const want = Buffer.from(`sha256=${createHmac("sha256", secret).update(`${timestamp}.`).update(body).digest("hex")}`);
  const got = Buffer.from(signature);
  return got.length === want.length && timingSafeEqual(got, want);
}

const USER_ID = /^[A-Za-z0-9._-]{1,128}$/;

export const routes: Route[] = [
  {
    method: "POST",
    path: "/v1/internal/plan-changed",
    auth: "public",
    handle: async (req, res) => {
      const secret = config.planSecret();
      if (!secret) throw new HttpError(404, "Not found");
      const body = await readBody(req, 16 * 1024);
      if (!planSigned(secret, one(req.headers["x-bops-timestamp"]), body, one(req.headers["x-bops-signature"]))) throw new HttpError(401, "Bad signature");
      let n: { userId?: unknown; tier?: unknown; at?: unknown };
      try {
        n = JSON.parse(body.toString("utf8")) as typeof n;
      } catch {
        throw new HttpError(400, "Body isn't JSON");
      }
      const at = typeof n?.at === "string" ? new Date(n.at) : new Date(NaN);
      if (typeof n?.userId !== "string" || !USER_ID.test(n.userId) || !isTier(n.tier) || Number.isNaN(at.getTime()) || at.getTime() > Date.now() + 5 * 60_000)
        throw new HttpError(400, "Send {userId, tier, at}");
      const { kept, before } = await recordTier(n.userId, n.tier, at, "notice");
      // Answered at once (orgo-web waits a few seconds at most); the setting up runs after.
      if (kept) void settle(n.userId, { force: before !== n.tier, tierChanged: before !== n.tier });
      console.log(`[plans] ${n.userId}: ${n.tier} at ${at.toISOString()}${kept ? (before !== n.tier ? ` (was ${before})` : " (no change)") : " (older than what's kept: ignored)"}`);
      sendJson(res, 200, { ok: true, applied: kept });
    },
  },
];
