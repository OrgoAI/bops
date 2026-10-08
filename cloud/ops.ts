import { config } from "./config.ts";
import { query } from "./db.ts";
import { MAIN_WORKSPACE } from "./handles.ts";
import { HttpError, sendJson, type Route } from "./http.ts";
import { planSigned } from "./plans.ts";
import type { PlanItemStatus } from "./protocol.ts";

/**
 * What Orgo's staff page (orgo-web /ops/bops, lib/ops/bops.ts) shows about each user's bot number and
 * email. orgo-web's login can't read schema bops, so it asks here, server side:
 *
 *   GET /v1/internal/ops/handles
 *   x-bops-timestamp: <Unix seconds>
 *   x-bops-signature: sha256=<hex HMAC-SHA256 of "{timestamp}.GET /v1/internal/ops/handles",
 *                     keyed with BOPS_CLOUD_PLAN_SECRET>
 *
 * Signed as orgo-web's plan notices are (plans.ts planSigned, at most 5 minutes off), with the method
 * and path in place of the body, so a signature for this route is good for no other. 404 with no
 * secret set, 401 signed wrong. Read only.
 *
 * Where each comes from:
 * - **Numbers:** bops.phone_lines, every number the cloud bought or attached for a user, a plan's or
 *   their own (bops.cloud_numbers is only the routing table, and loses a plan's number when it's given back).
 * - **Emails:** bops.mail_inboxes (the inboxes the cloud made for a plan), and the inboxes the Mac made
 *   itself with its pod key, which only the app's state has (bots[].email, bots[].mail): a main bot
 *   that had an inbox before its plan gets none from the plan, so the table alone would miss it. An
 *   inbox the table has is judged by the table, whatever the state says.
 *
 * A released number or inbox (given back 30 days after its plan ended) counts for nothing. Paused ones
 * (the plan ended: calls, texts and mail go unanswered) and ones with a problem (`broken`) still count
 * as the user's, and are counted again on their own. Each user shows one number and one email: the
 * best standing (ready, then setting up, then broken, then paused), a plan's before the user's own,
 * then the main bot's, then the newest; `count` says how many they have.
 */

export const OPS_HANDLES_PATH = "/v1/internal/ops/handles";
/** What's signed in place of a body. */
export const OPS_HANDLES_SIGNED = `GET ${OPS_HANDLES_PATH}`;

export type HandleStatus = Exclude<PlanItemStatus, "released">;
export type OpsPhone = { e164: string; status: HandleStatus; plan: boolean; ownerClaimed: boolean; problem: string | null; count: number };
/** `source`: the cloud's table (a plan's inbox), or the app's state (one the Mac made). */
export type OpsEmail = { address: string; status: HandleStatus; plan: boolean; problem: string | null; source: "cloud" | "app"; count: number };
export type OpsHandlesUser = { userId: string; phone: OpsPhone | null; email: OpsEmail | null };
export type OpsHandlesCounts = {
  users: number;
  withPhone: number;
  withEmail: number;
  withBoth: number;
  neither: number;
  /** Users whose number (or email) shown is paused, or has a problem. Each is in withPhone (withEmail) too. */
  phonePaused: number;
  phoneProblem: number;
  emailPaused: number;
  emailProblem: number;
};
export type OpsHandles = { users: OpsHandlesUser[]; counts: OpsHandlesCounts };

/* ---------------- Reading ---------------- */

export type LineRow = { user_id: string; e164: string; status: string; plan: boolean; owner_claimed: boolean; problem: string | null; created_at: Date | null };
export type InboxRow = { user_id: string; inbox_id: string; email: string; status: string; plan: boolean; problem: string | null; created_at: Date | null };
/** One bot with an inbox in the app's state. */
export type AppInboxRow = { user_id: string; inbox_id: string | null; email: string | null; is_main: boolean; workspace_id: string | null; paused: boolean; plan: boolean };

const LIVE: HandleStatus[] = ["ready", "setting_up", "broken", "paused"];
const isLive = (s: string): s is HandleStatus => (LIVE as string[]).includes(s);
/** Lower is better. */
const standing = (s: HandleStatus) => LIVE.indexOf(s);
const when = (d: Date | null) => (d ? d.getTime() : 0);
const hasProblem = (status: HandleStatus, problem: string | null) => status === "broken" || !!problem;

/** The best of a user's numbers or emails, as the top of this file says. */
function best<T extends { status: HandleStatus; plan: boolean; rank: number; at: number }>(list: T[]): T | null {
  return [...list].sort((a, b) => standing(a.status) - standing(b.status) || Number(b.plan) - Number(a.plan) || a.rank - b.rank || b.at - a.at)[0] ?? null;
}

/** Put the rows together (exported for the tests). `accounts`: every user the cloud set up. */
export function summarize(accounts: string[], lines: LineRow[], inboxes: InboxRow[], appInboxes: AppInboxRow[]): OpsHandles {
  const ids = new Set(accounts);
  type Phone = OpsPhone & { rank: number; at: number };
  type Email = OpsEmail & { rank: number; at: number };
  const phones = new Map<string, Phone[]>();
  const emails = new Map<string, Email[]>();
  const add = <T>(m: Map<string, T[]>, userId: string, x: T) => {
    ids.add(userId);
    m.set(userId, [...(m.get(userId) ?? []), x]);
  };

  for (const l of lines) {
    if (!isLive(l.status)) continue;
    add(phones, l.user_id, { e164: l.e164, status: l.status, plan: l.plan, ownerClaimed: l.owner_claimed, problem: l.problem, count: 0, rank: 0, at: when(l.created_at) });
  }
  // Every inbox the table has, released ones too: the state's copy of one of them never counts.
  const known = new Set(inboxes.map((i) => `${i.user_id}\n${i.inbox_id}`));
  for (const i of inboxes) {
    if (!isLive(i.status)) continue;
    add(emails, i.user_id, { address: i.email, status: i.status, plan: i.plan, problem: i.problem, source: "cloud", count: 0, rank: 0, at: when(i.created_at) });
  }
  const seen = new Set<string>();
  for (const a of appInboxes) {
    const address = a.email || a.inbox_id;
    if (!address) continue;
    // A plan's inbox is the cloud's to say; one the table has, the table says.
    if (a.plan || (a.inbox_id && known.has(`${a.user_id}\n${a.inbox_id}`))) continue;
    const key = `${a.user_id}\n${a.inbox_id ?? address}`;
    if (seen.has(key)) continue;
    seen.add(key);
    const main = a.is_main && (a.workspace_id ?? MAIN_WORKSPACE) === MAIN_WORKSPACE;
    add(emails, a.user_id, { address, status: a.paused ? "paused" : "ready", plan: false, problem: null, source: "app", count: 0, rank: main ? 0 : 1, at: 0 });
  }

  const counts: OpsHandlesCounts = { users: 0, withPhone: 0, withEmail: 0, withBoth: 0, neither: 0, phonePaused: 0, phoneProblem: 0, emailPaused: 0, emailProblem: 0 };
  const users: OpsHandlesUser[] = [...ids].sort().map((userId) => {
    const ps = phones.get(userId) ?? [];
    const es = emails.get(userId) ?? [];
    const p = best(ps);
    const e = best(es);
    const phone: OpsPhone | null = p && { e164: p.e164, status: p.status, plan: p.plan, ownerClaimed: p.ownerClaimed, problem: p.problem, count: ps.length };
    const email: OpsEmail | null = e && { address: e.address, status: e.status, plan: e.plan, problem: e.problem, source: e.source, count: es.length };
    counts.users++;
    if (phone) counts.withPhone++;
    if (email) counts.withEmail++;
    if (phone && email) counts.withBoth++;
    if (!phone && !email) counts.neither++;
    if (phone?.status === "paused") counts.phonePaused++;
    if (phone && hasProblem(phone.status, phone.problem)) counts.phoneProblem++;
    if (email?.status === "paused") counts.emailPaused++;
    if (email && hasProblem(email.status, email.problem)) counts.emailProblem++;
    return { userId, phone, email };
  });
  return { users, counts };
}

/** Each bot in each user's state that has an inbox. A state that isn't the shape the app writes reads as none. */
const APP_INBOXES_SQL = `
SELECT s.user_id,
       NULLIF(b->'mail'->>'inboxId', '') AS inbox_id,
       NULLIF(b->>'email', '') AS email,
       coalesce(b->>'isMain', '') = 'true' AS is_main,
       b->>'workspaceId' AS workspace_id,
       coalesce(b->'mail'->>'paused', '') = 'true' AS paused,
       coalesce(b->'mail'->>'plan', '') = 'true' AS plan
  FROM bops.app_state s
 CROSS JOIN LATERAL jsonb_array_elements(CASE WHEN jsonb_typeof(s.state->'bots') = 'array' THEN s.state->'bots' ELSE '[]'::jsonb END) b
 WHERE jsonb_typeof(b) = 'object'
   AND (coalesce(b->>'email', '') <> '' OR coalesce(b->'mail'->>'inboxId', '') <> '')`;

export async function readHandles(): Promise<OpsHandles> {
  const [accounts, lines, inboxes, appInboxes] = await Promise.all([
    query<{ user_id: string }>("SELECT user_id FROM bops.cloud_accounts"),
    query<LineRow>("SELECT user_id, e164, status, plan, owner_number IS NOT NULL AS owner_claimed, problem, created_at FROM bops.phone_lines WHERE status <> 'released'"),
    query<InboxRow>("SELECT user_id, inbox_id, email, status, plan, problem, created_at FROM bops.mail_inboxes"),
    query<AppInboxRow>(APP_INBOXES_SQL),
  ]);
  return summarize(
    accounts.rows.map((r) => r.user_id),
    lines.rows,
    inboxes.rows,
    appInboxes.rows,
  );
}

/* ---------------- The route ---------------- */

const one = (v: string | string[] | undefined) => (Array.isArray(v) ? (v[0] ?? "") : (v ?? ""));

export const routes: Route[] = [
  {
    method: "GET",
    path: OPS_HANDLES_PATH,
    auth: "public",
    handle: async (req, res) => {
      const secret = config.planSecret();
      if (!secret) throw new HttpError(404, "Not found");
      if (!planSigned(secret, one(req.headers["x-bops-timestamp"]), Buffer.from(OPS_HANDLES_SIGNED), one(req.headers["x-bops-signature"]))) throw new HttpError(401, "Bad signature");
      sendJson(res, 200, await readHandles());
    },
  },
];
