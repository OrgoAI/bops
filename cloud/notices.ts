import { appVersionOf, olderThan } from "./app-version.ts";
import { query } from "./db.ts";
import { HttpError, readJson, sendJson, type Route } from "./http.ts";
import type { CloudNotice } from "./protocol.ts";
import { stateTooNew } from "./state.ts";

/**
 * What Orgo tells Bops users: notices in bops.notices, each shown once to each user as a pop-up in the
 * app (0.0.19 on: components/app/notice-popup.tsx) until they put it away, on whichever Mac. A notice can
 * be for apps older than a version only (below_version: "update Bops"), and runs from starts_at until
 * ends_at. Posted and ended with Orgo's scripts/notices.sh (OrgoAI/bops-secrets).
 *
 * A Mac older than the one that wrote the user's state (state.ts stateTooNew) gets one more, first, from
 * the cloud itself: update Bops on this Mac. Its state's calls are refused, and otherwise nothing would
 * say so while it runs. It's in no table, so putting it away lasts until the app asks again.
 */

/** The cloud's own notice for a Mac that can't be given the user's state any more. Its id names no notice in bops.notices. */
export const UPDATE_THIS_MAC: CloudNotice = {
  id: "0",
  title: "Update Bops on this Mac",
  body: "Another of your Macs is on a newer Bops, so this one can't keep your chats, bots and routines in sync any more. Update it to keep going: what you do here meanwhile goes up once it's updated.",
  link: { url: "https://bops.bot", label: "Get the update" },
};

type Row = { id: string; title: string; body: string; link_url: string | null; link_label: string | null; below_version: string | null };

/** The notices for this user on this app (its version, or null when it didn't say), newest first, but those they put away. */
export async function noticesFor(userId: string, version: string | null): Promise<CloudNotice[]> {
  const r = await query<Row>(
    `SELECT n.id::text AS id, n.title, n.body, n.link_url, n.link_label, n.below_version
     FROM bops.notices n
     WHERE n.starts_at <= now() AND (n.ends_at IS NULL OR n.ends_at > now())
       AND NOT EXISTS (SELECT 1 FROM bops.notice_dismissals d WHERE d.user_id = $1 AND d.notice_id = n.id)
     ORDER BY n.id DESC
     LIMIT 20`,
    [userId],
  );
  return r.rows
    .filter((n) => !n.below_version || !version || olderThan(version, n.below_version))
    .map((n) => ({ id: n.id, title: n.title, body: n.body, ...(n.link_url ? { link: { url: n.link_url, label: n.link_label || "Open" } } : {}) }));
}

/** GET /v1/notices: { notices }. */
const list: Route = {
  method: "GET",
  path: "/v1/notices",
  auth: "user",
  handle: async (req, res, { user }) => {
    const notices = await noticesFor(user!.id, appVersionOf(req));
    sendJson(res, 200, { notices: (await stateTooNew(req, user!.id)) ? [UPDATE_THIS_MAC, ...notices] : notices });
  },
};

/** POST /v1/notices/dismiss { id }: the user put it away. */
const dismiss: Route = {
  method: "POST",
  path: "/v1/notices/dismiss",
  auth: "user",
  handle: async (req, res, { user }) => {
    const { id } = await readJson<{ id?: unknown }>(req);
    if (typeof id !== "string" || !/^\d{1,18}$/.test(id)) throw new HttpError(400, "Name the notice: { id }.");
    await query("INSERT INTO bops.notice_dismissals (user_id, notice_id) SELECT $1, id FROM bops.notices WHERE id = $2::bigint ON CONFLICT DO NOTHING", [user!.id, id]);
    sendJson(res, 200, { ok: true });
  },
};

export const routes: Route[] = [list, dismiss];
