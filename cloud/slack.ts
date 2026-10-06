import { createHash, createHmac, timingSafeEqual } from "node:crypto";
import type { IncomingHttpHeaders } from "node:http";
import { config } from "./config.ts";
import { ensureUserRow, query, tx } from "./db.ts";
import { HttpError, readBody, readJson, sendJson, type Route } from "./http.ts";
import type { SlackLinkIn, SlackLinksResult } from "./protocol.ts";
import { queueForMac, requestMac } from "./tunnel.ts";

/**
 * Bops' own Slack app (slack/manifest.json; at Orgo, the "Bops" app): every workspace that installed
 * it sends its events to one address, /hooks/slack, and the cloud passes each to the Macs of the
 * users whose bots it's for. Owner: edge builder.
 *
 * - Each delivery is proven by Slack's signature (BOPS_SLACK_SIGNING_SECRET), answered 200 at once
 *   and handled after. Slack wants an answer within 3 seconds and turns an app's events off when
 *   most of an hour's deliveries fail, so a Mac being away is never Slack's failure: never a 503.
 * - Who an event is for comes from bops.slack_links, which each user's Mac fills in (PUT
 *   /v1/slack/links) with where its bots are. The workspace of each of the user's Slack accounts
 *   comes only from Slack (auth.test, which the cloud runs through that account itself), so a Mac
 *   can only claim channels in a workspace it's really in. Never by workspace alone: a channel
 *   message goes to the users with a bot in that channel, a direct message to the user it's with
 *   (its channel is theirs, or it's from the person one of their bots is paired with), and a direct
 *   message nobody has yet to the users whose bots wait for their pairing code.
 * - With the Mac connected, the event is replayed there as POST /api/channels/slack/events (the raw
 *   body and Slack's headers); otherwise, or when it doesn't take it in time, it waits for the Mac a
 *   day ("slack" in bops.cloud_pending) and is dropped after that, not answered late.
 */

/** Slack's event deliveries are small; anything bigger isn't one. */
const MAX_HOOK = 1024 * 1024;
/** How long the Mac has to take a replayed event before it's kept for later (Slack has had its answer already). */
const MAC_WAIT_MS = 5_000;
/** How long an event waits for a Mac that's away. */
export const KEEP_MS = 24 * 3600_000;
/** How long an event id is remembered: Slack sends an event again within minutes when it didn't hear back. */
const SEEN_MS = 15 * 60_000;

/** Slack ids as Slack writes them: a channel ("C…", "G…"), a direct-message channel ("D…"), a person ("U…", "W…"), a workspace, a user. */
const CHANNEL = /^[CG][A-Z0-9]{2,40}$/;
const DM = /^D[A-Z0-9]{2,40}$/;
const PERSON = /^[UW][A-Z0-9]{2,40}$/;
const SLACK_ID = /^[A-Z0-9]{2,40}$/;
/** A Composio connected account id. */
const ACCOUNT = /^[A-Za-z0-9_-]{1,128}$/;

/* ---------------- Events ---------------- */

/** Slack's v0 signature: HMAC-SHA256 of "v0:{timestamp}:{raw body}" as "v0=<hex>", at most 5 minutes off. */
export function slackSigned(secret: string, timestamp: string, body: Buffer, signature: string, now = Date.now()): boolean {
  if (!/^\d{1,12}$/.test(timestamp) || Math.abs(now / 1000 - Number(timestamp)) > 300) return false;
  const want = Buffer.from(`v0=${createHmac("sha256", secret).update(`v0:${timestamp}:`).update(body).digest("hex")}`);
  const got = Buffer.from(signature);
  return got.length === want.length && timingSafeEqual(got, want);
}

type SlackEvent = { type?: string; subtype?: string; channel?: string; channel_type?: string; user?: string; bot_id?: string };
type Envelope = { type?: string; challenge?: unknown; team_id?: unknown; event_id?: unknown; event?: SlackEvent; authorizations?: unknown };

/**
 * What the app acts on (lib/server/channels.ts slackMessage): people's messages and mentions. Not
 * bots' (each bot's own posts come back as events), and not edits, deletions or joins.
 */
function forBots(e: SlackEvent | undefined): e is SlackEvent & { channel: string } {
  if (!e || (e.type !== "message" && e.type !== "app_mention")) return false;
  if (typeof e.channel !== "string" || !(CHANNEL.test(e.channel) || DM.test(e.channel))) return false;
  if (typeof e.user !== "string" || !e.user || e.bot_id) return false;
  return !e.subtype || e.subtype === "file_share" || e.subtype === "thread_broadcast";
}

/** Event ids already taken, in the order they came. */
const seen = new Map<string, number>();
function firstTime(eventId: string, now = Date.now()) {
  for (const [id, at] of seen) {
    if (now - at < SEEN_MS) break;
    seen.delete(id);
  }
  if (seen.has(eventId)) return false;
  seen.set(eventId, now);
  return true;
}

/**
 * The workspaces an event belongs to: its own (team_id), and the one of the app's installation it
 * was sent through (authorizations), which differ only in a channel shared between two workspaces.
 */
function teamsOf(envelope: Envelope): string[] {
  const through = Array.isArray(envelope.authorizations) ? envelope.authorizations.map((a) => (a as { team_id?: unknown } | null)?.team_id) : [];
  return [...new Set([envelope.team_id, ...through].filter((t): t is string => typeof t === "string" && SLACK_ID.test(t)))];
}

const userIds = (r: { rows: { user_id: string }[] }) => r.rows.map((row) => row.user_id);

/**
 * Whose bots an event is for, in its own workspaces only: the users with a bot in the channel; for a
 * direct message, the user it's with (its channel is theirs, or it's from someone their bots are
 * paired with, even before they know its channel), else (nobody has it yet) the users whose bots are pairing.
 */
export async function usersFor(teams: string[], e: SlackEvent & { channel: string }): Promise<string[]> {
  if (!(e.channel_type === "im" || DM.test(e.channel)))
    return userIds(await query<{ user_id: string }>("SELECT DISTINCT user_id FROM bops.slack_links WHERE team_id = ANY ($1::text[]) AND $2 = ANY (channels)", [teams, e.channel]));
  const withUser = userIds(
    await query<{ user_id: string }>("SELECT DISTINCT user_id FROM bops.slack_links WHERE team_id = ANY ($1::text[]) AND (dm = $2 OR $3 = ANY (owners))", [teams, e.channel, e.user ?? null]),
  );
  if (withUser.length) return withUser;
  return userIds(await query<{ user_id: string }>("SELECT DISTINCT user_id FROM bops.slack_links WHERE team_id = ANY ($1::text[]) AND pairing", [teams]));
}

/** One user's Mac gets the event now, or keeps it waiting a day. */
async function toMac(userId: string, eventId: string, envelope: Envelope, body: Buffer, headers: Record<string, string>) {
  const answer = await requestMac(userId, { method: "POST", path: "/api/channels/slack/events", headers, body }, MAC_WAIT_MS);
  if (answer && answer.status >= 200 && answer.status < 300) return;
  await queueForMac(userId, "slack", envelope, `slack:${eventId}`, new Date(Date.now() + KEEP_MS));
}

async function deliver(teams: string[], eventId: string, envelope: Envelope & { event: SlackEvent & { channel: string } }, body: Buffer, headers: Record<string, string>) {
  const users = await usersFor(teams, envelope.event);
  await Promise.all(users.map((userId) => toMac(userId, eventId, envelope, body, headers).catch((e: Error) => console.warn(`[slack] event ${eventId} for ${userId}: ${e.message}`))));
}

const one = (h: string | string[] | undefined) => (Array.isArray(h) ? (h[0] ?? "") : (h ?? ""));

/** The headers a replayed event keeps: its content type and Slack's own (timestamp, signature, retries). Nothing else crosses. */
function forwarded(headers: IncomingHttpHeaders): Record<string, string> {
  const out: Record<string, string> = {};
  for (const [name, value] of Object.entries(headers)) if ((name === "content-type" || name.startsWith("x-slack-")) && typeof value === "string") out[name] = value;
  return out;
}

function envelopeOf(body: Buffer): Envelope | null {
  try {
    const value = JSON.parse(body.toString("utf8")) as unknown;
    return value && typeof value === "object" && !Array.isArray(value) ? (value as Envelope) : null;
  } catch {
    return null;
  }
}

/** Slack's events: signature checked, url_verification answered here, everything else answered 200 at once and handled after. */
const hook: Route = {
  method: "POST",
  path: "/hooks/slack",
  auth: "public",
  handle: async (req, res) => {
    const secret = config.slackSigningSecret();
    if (!secret) return sendJson(res, 404, { error: "Slack isn't set up on this cloud" });
    const body = await readBody(req, MAX_HOOK);
    if (!slackSigned(secret, one(req.headers["x-slack-request-timestamp"]), body, one(req.headers["x-slack-signature"]))) return sendJson(res, 401, { error: "bad signature" });
    const envelope = envelopeOf(body);
    if (!envelope) return sendJson(res, 400, { error: "Body isn't JSON" });
    if (envelope.type === "url_verification") return sendJson(res, 200, { challenge: typeof envelope.challenge === "string" ? envelope.challenge : "" });
    sendJson(res, 200, { ok: true });
    const teams = teamsOf(envelope);
    if (envelope.type !== "event_callback" || !teams.length || !forBots(envelope.event)) return;
    const eventId = typeof envelope.event_id === "string" && envelope.event_id ? envelope.event_id.slice(0, 100) : createHash("sha256").update(body).digest("hex");
    if (!firstTime(eventId)) return;
    const event = envelope.event;
    void deliver(teams, eventId, { ...envelope, event }, body, forwarded(req.headers)).catch((e: Error) => console.warn(`[slack] event ${eventId}: ${e.message}`));
  },
};

/* ---------------- Where each user's bots are ---------------- */

const MAX_ACCOUNTS = 20;
const MAX_CHANNELS = 1000;
const MAX_OWNERS = 50;

type Link = Required<Omit<SlackLinkIn, "dm">> & { dm: string | null };

/** PUT /v1/slack/links's body, checked: Slack's own id formats, a sane number of each, every account once. */
function linksIn(body: unknown): Link[] {
  const list = (body as { links?: unknown } | null)?.links;
  if (!Array.isArray(list) || list.length > MAX_ACCOUNTS) throw new HttpError(400, `Send {links: [...]}, at most ${MAX_ACCOUNTS} Slack accounts.`);
  const out: Link[] = [];
  for (const raw of list as Partial<Record<keyof SlackLinkIn, unknown>>[]) {
    const accountId = raw?.accountId;
    if (typeof accountId !== "string" || !ACCOUNT.test(accountId)) throw new HttpError(400, "Each link needs the accountId of one of your Slack accounts.");
    if (out.some((l) => l.accountId === accountId)) throw new HttpError(400, "Each Slack account once.");
    const channels = raw.channels ?? [];
    if (!Array.isArray(channels) || channels.length > MAX_CHANNELS || !channels.every((c) => typeof c === "string" && CHANNEL.test(c)))
      throw new HttpError(400, `channels should be Slack channel ids ("C…" or "G…"), at most ${MAX_CHANNELS}.`);
    const dm = raw.dm ?? null;
    if (dm !== null && (typeof dm !== "string" || !DM.test(dm))) throw new HttpError(400, 'dm should be a direct-message channel id ("D…") or null.');
    const owners = raw.owners ?? [];
    if (!Array.isArray(owners) || owners.length > MAX_OWNERS || !owners.every((u) => typeof u === "string" && PERSON.test(u)))
      throw new HttpError(400, `owners should be Slack user ids ("U…" or "W…"), at most ${MAX_OWNERS}.`);
    if (raw.pairing !== undefined && typeof raw.pairing !== "boolean") throw new HttpError(400, "pairing should be true or false.");
    out.push({ accountId, channels: [...new Set(channels as string[])], dm, owners: [...new Set(owners as string[])], pairing: raw.pairing === true });
  }
  return out;
}

/** Whether a Composio connected account is one the cloud saw made for this user. */
async function ownsAccount(userId: string, accountId: string) {
  const r = await query<{ user_id: string }>("SELECT user_id FROM bops.cloud_objects WHERE provider = 'composio' AND kind = 'connected_account' AND object_id = $1", [accountId]);
  return r.rows[0]?.user_id === userId;
}

type Identity = { teamId: string; botUserId: string | null };

/**
 * Which workspace one of the user's Slack accounts is in, and the app's bot user there: Slack's own
 * answer to auth.test, asked through that account (Composio's proxy, with the cloud's key).
 */
async function slackIdentity(accountId: string): Promise<Identity> {
  const key = config.composioKey();
  if (!key) throw new HttpError(503, "Composio isn't set up on this cloud.");
  let res: Response;
  try {
    res = await fetch(`${config.upstream.composio().replace(/\/+$/, "")}/api/v3.1/tools/execute/proxy`, {
      method: "POST",
      headers: { "x-api-key": key, "content-type": "application/json", accept: "application/json" },
      body: JSON.stringify({ endpoint: "/auth.test", method: "POST", connected_account_id: accountId, parameters: [] }),
      signal: AbortSignal.timeout(20_000),
    });
  } catch {
    throw new HttpError(502, "Couldn't reach Composio to check that Slack account.");
  }
  const answer = (await res.json().catch(() => null)) as { data?: { ok?: unknown; error?: unknown; team_id?: unknown; user_id?: unknown; bot_id?: unknown } } | null;
  if (!res.ok || !answer) throw new HttpError(502, `Composio answered ${res.status} when checking that Slack account.`);
  const d = answer.data ?? {};
  if (d.ok !== true || typeof d.team_id !== "string" || !SLACK_ID.test(d.team_id)) {
    const why = typeof d.error === "string" && /^[a-z_]{1,60}$/.test(d.error) ? ` (${d.error})` : "";
    throw new HttpError(409, `Slack wouldn't say which workspace that account is in${why}. Connect Slack again.`);
  }
  // Only a bot token's answer names the app's bot (it has bot_id); a person's token would name the person.
  return { teamId: d.team_id, botUserId: d.bot_id && typeof d.user_id === "string" && SLACK_ID.test(d.user_id) ? d.user_id : null };
}

/**
 * The Mac says where its bots are in Slack: every account each time (one left out is forgotten). An
 * account must be the user's own; its workspace is asked of Slack once and kept (an account never
 * moves to another workspace), and only the channels, the direct message, who the bots are paired
 * with and pairing come from the Mac.
 */
const putLinks: Route = {
  method: "PUT",
  path: "/v1/slack/links",
  auth: "user",
  handle: async (req, res, { user }) => {
    const userId = user!.id;
    const links = linksIn(await readJson(req));
    const known = new Map(
      (await query<{ account_id: string; team_id: string; bot_user_id: string | null }>("SELECT account_id, team_id, bot_user_id FROM bops.slack_links WHERE user_id = $1", [userId])).rows.map((r) => [
        r.account_id,
        { teamId: r.team_id, botUserId: r.bot_user_id },
      ]),
    );
    const kept: (Link & Identity)[] = [];
    for (const l of links) {
      if (!(await ownsAccount(userId, l.accountId))) throw new HttpError(404, "That Slack account isn't one of yours.");
      kept.push({ ...l, ...(known.get(l.accountId) ?? (await slackIdentity(l.accountId))) });
    }
    await ensureUserRow(userId);
    await tx(async (c) => {
      // One update at a time per user: two at once never leave a mix of both.
      await c.query("SELECT 1 FROM bops.app_state WHERE user_id = $1 FOR UPDATE", [userId]);
      await c.query("DELETE FROM bops.slack_links WHERE user_id = $1 AND NOT (account_id = ANY ($2::text[]))", [userId, kept.map((l) => l.accountId)]);
      for (const l of kept)
        await c.query(
          `INSERT INTO bops.slack_links (user_id, account_id, team_id, bot_user_id, channels, dm, owners, pairing) VALUES ($1, $2, $3, $4, $5::text[], $6, $7::text[], $8)
           ON CONFLICT (user_id, account_id) DO UPDATE SET channels = EXCLUDED.channels, dm = EXCLUDED.dm, owners = EXCLUDED.owners, pairing = EXCLUDED.pairing, updated_at = now()`,
          [userId, l.accountId, l.teamId, l.botUserId, l.channels, l.dm, l.owners, l.pairing],
        );
    });
    const result: SlackLinksResult = {
      links: kept.map((l) => ({ accountId: l.accountId, teamId: l.teamId, botUserId: l.botUserId, channels: l.channels, dm: l.dm, owners: l.owners, pairing: l.pairing })),
    };
    sendJson(res, 200, result);
  },
};

export const routes: Route[] = [hook, putLinks];
