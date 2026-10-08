import { appVersionOf, olderThan } from "./app-version.ts";
import { query } from "./db.ts";
import { HttpError, readJson, sendJson, type Route } from "./http.ts";
import type { CloudNotice } from "./protocol.ts";

/**
 * What Orgo tells Bops users: notices in bops.notices, each shown once to each user as a pop-up in the
 * app (0.0.19 on: components/app/notice-popup.tsx) until they put it away, on whichever Mac. A notice can
 * be for apps older than a version only (below_version: "update Bops"), and runs from starts_at until
 * ends_at. Posted and ended with scripts/internal/notices.sh.
 */

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
  handle: async (req, res, { user }) => sendJson(res, 200, { notices: await noticesFor(user!.id, appVersionOf(req)) }),
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
