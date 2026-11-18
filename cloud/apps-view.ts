import type { IncomingMessage, ServerResponse } from "node:http";
import type pg from "pg";
import { appHomeHere, hostingScope } from "./computer-scope.ts";
import { query, tx } from "./db.ts";
import { HttpError, readJson, type Route } from "./http.ts";
import { viewsWritten } from "./live.ts";
import { APPS_VIEW_PATH, type AppsViewPost } from "./protocol.ts";
import { checkUser, lockedState, lockUser } from "./state.ts";
import { canonical, COMMIT_SEEN, DEPLOY_SEEN, HOSTNAME, keep, LEFT_OVER_SEEN, SETTINGS_SEEN, SITE_SEEN, vouchedSites, type AppViews } from "./ws-slice.ts";

/**
 * What each app's own computer sees of its apps for the workspace's members (bops.app_views), so Your Apps stays fresh
 * with the owner's Mac shut: the owner's Mac reads Ingot and Orgo for members only while it's on (Workspace.appsForMembers,
 * lib/server/apps-for-members.ts), and a computer can't write that (computer-scope.ts writeDenials).
 *
 * The app's computer's runner posts its own apps' view (POST /v1/apps/view, lib/server/apps-view-share.ts) after a job,
 * after a bot's deploy there, while a deploy runs, and when Bops Cloud nudges it (turns.ts nudgeAppViews). Only a
 * computer on its own identity may post, and only for apps whose home is that computer (computer-scope.ts appHomeHere,
 * the rule its writes of the app's record are held to); every field is an allow list (cleanAppView: no Preview
 * passwords, members' acts, ids of projects or computers, variables, logs or error text), and every link one the app's
 * record vouches for (ws-slice.ts vouchedSites: a Preview link of the site's own sealed label, an address and domains
 * that are bare hostnames; appsFor holds it to the record again as it is when shown). Kept in its own table, never in
 * the owner's state, so a look never bumps its version: `view` and `view_at` only when it changed, `seen_at` each time.
 * ws-slice.ts appsFor shows, per app, the newer of this and the owner's Mac's read. The answer is 204 with nothing in
 * it; every refusal has fixed words.
 */

/** The most a post may be. */
export const APPS_VIEW_MAX_BYTES = 256 * 1024;
/** The most apps one post keeps (lib/hosted-apps.ts MEMBER_APPS). */
const MAX_APPS = 30;
const MAX_SITES = 5;
const MAX_COMMITS = 20;
const MAX_DEPLOYS = 50;
const MAX_LEFT_OVERS = 20;
const MAX_OWNED = 50;

const WS_ID = /^[A-Za-z0-9_-]{1,64}$/;
const APP_NAME = /^(?=.{1,64}$)[a-z0-9]+(-[a-z0-9]+)*$/;
const OPAQUE = /^[A-Za-z0-9_-]{1,80}$/;
const BAD = "Send {ws, apps}: a workspace and its apps' views.";
const NOT_A_COMPUTER = "Only an app's own computer tells Bops Cloud what it sees of its apps.";
const NOT_YOURS = "A computer tells only its own apps.";

const isObject = (v: unknown): v is Record<string, unknown> => !!v && typeof v === "object" && !Array.isArray(v);
const cut = (v: unknown, max: number) => (typeof v === "string" ? v.slice(0, max) : v);
const port = (v: unknown) => (typeof v === "number" && Number.isInteger(v) && v > 0 && v < 65536 ? v : null);

/**
 * One app's view as members may be shown it, from what a computer posted (lib/hosted-apps.ts AppView), or null for none:
 * its head; at most MAX_SITES sites (ws-slice.ts SITE_SEEN, never a password); MAX_COMMITS commits (messages to 200
 * characters, authors to 80); MAX_DEPLOYS deploys; each site's settings; MAX_LEFT_OVERS left overs (name to 80, port,
 * whether it's a web address alone); MAX_OWNED of the workspace's bought domains (id and name, a bare hostname). `host`:
 * the app's record, which its sites are held to (vouchedSites); none, its sites as kept.
 */
export function cleanAppView(v: unknown, name?: string, host?: Record<string, unknown>): Record<string, unknown> | null {
  if (!isObject(v)) return null;
  const out: Record<string, unknown> = {};
  if (v.head === null) out.head = null;
  else if (isObject(v.head)) out.head = { ...(keep(v.head, { id: true, message: true, at: true }) as Record<string, unknown>), ...(typeof v.head.message === "string" ? { message: v.head.message.slice(0, 200) } : {}) };
  const sites = Array.isArray(v.sites) ? (keep(v.sites.slice(0, MAX_SITES), [SITE_SEEN]) as unknown[]) : [];
  out.sites = name && host ? vouchedSites(name, host, sites) : sites;
  out.commits = Array.isArray(v.commits)
    ? (keep(v.commits.slice(0, MAX_COMMITS), [COMMIT_SEEN]) as Record<string, unknown>[]).map((c) => ({ ...c, ...(c.message !== undefined ? { message: cut(c.message, 200) } : {}), ...(c.author !== undefined ? { author: cut(c.author, 80) } : {}) }))
    : [];
  out.deploys = Array.isArray(v.deploys) ? keep(v.deploys.slice(0, MAX_DEPLOYS), [DEPLOY_SEEN]) : [];
  if (isObject(v.settings)) {
    const settings = Object.fromEntries(
      Object.entries(v.settings)
        .filter(([site, x]) => APP_NAME.test(site) && isObject(x))
        .slice(0, MAX_SITES)
        .map(([site, x]) => [site, keep(x, SETTINGS_SEEN)]),
    );
    if (Object.keys(settings).length) out.settings = settings;
  }
  if (Array.isArray(v.leftOver)) {
    const left = (keep(v.leftOver.slice(0, MAX_LEFT_OVERS), [LEFT_OVER_SEEN]) as Record<string, unknown>[]).flatMap((l) =>
      typeof l.name === "string" && l.name ? [{ name: l.name.slice(0, 80), port: port(l.port), ...(l.link === true ? { link: true } : {}) }] : [],
    );
    if (left.length) out.leftOver = left;
  }
  if (Array.isArray(v.owned)) {
    const owned = v.owned
      .filter((d): d is Record<string, unknown> => isObject(d) && typeof d.id === "string" && OPAQUE.test(d.id) && typeof d.domain === "string" && HOSTNAME.test(d.domain))
      .slice(0, MAX_OWNED)
      .map((d) => ({ id: d.id as string, domain: d.domain as string }));
    out.owned = owned;
  }
  return out;
}

/** The body as a runner sends it, or a 400 with fixed words. */
function postOf(body: unknown): AppsViewPost {
  if (!isObject(body) || typeof body.ws !== "string" || !WS_ID.test(body.ws) || !isObject(body.apps)) throw new HttpError(400, BAD);
  if (Object.keys(body.apps).some((name) => !APP_NAME.test(name))) throw new HttpError(400, BAD);
  return { ws: body.ws, apps: body.apps };
}

/** What every app's own computer last said of workspace `ws`'s apps (bops.app_views): ws-slice.ts AppViews, by app. `c`: the transaction to read in, if any. */
export async function readAppViews(c: pg.PoolClient | null, account: string, ws: string): Promise<AppViews> {
  const sql = "SELECT app, view, seen_at FROM bops.app_views WHERE user_id = $1 AND ws_id = $2";
  type Raw = { app: string; view: Record<string, unknown>; seen_at: Date };
  const rows = (c ? await c.query<Raw>(sql, [account, ws]) : await query<Raw>(sql, [account, ws])).rows;
  const out: AppViews = {};
  for (const r of rows) if (APP_NAME.test(r.app) && isObject(r.view)) out[r.app] = { view: r.view, at: r.seen_at.getTime() };
  return out;
}

/**
 * POST /v1/apps/view (AppsViewPost): a computer's own apps as it sees them for members. Under the owner's row lock, so the
 * apps' homes are checked on their state as it is (nothing of it is written). Each of its apps kept (cleanAppView), each
 * row of an app the workspace no longer has gone, then 204; every viewer watching the workspace is told (live.ts
 * viewsWritten), so a member's window reads it within seconds.
 */
const post: Route = {
  method: "POST",
  path: APPS_VIEW_PATH,
  auth: "user",
  computer: true,
  handle: async (req: IncomingMessage, res: ServerResponse, { user }) => {
    const desktop = user?.computer?.desktopId;
    if (!desktop) throw new HttpError(403, NOT_A_COMPUTER);
    checkUser(req, user!, false);
    const p = postOf(await readJson<unknown>(req, APPS_VIEW_MAX_BYTES));
    const out = await tx(async (c) => {
      await lockUser(c, user!.id);
      const blob = await lockedState(c, user!.id);
      const ws = (Array.isArray(blob.workspaces) ? blob.workspaces : []).find((w) => isObject(w) && w.id === p.ws) as Record<string, unknown> | undefined;
      const hosted = ws && isObject(ws.hostedApps) ? ws.hostedApps : null;
      if (!hosted) return null;
      const scope = hostingScope(blob, desktop);
      const mine = Object.keys(p.apps).filter((name) => Object.hasOwn(hosted, name) && appHomeHere(p.ws, hosted[name], scope)).slice(0, MAX_APPS);
      if (!mine.length) return null;
      const was = await readAppViews(c, user!.id, p.ws);
      for (const name of mine) {
        const view = cleanAppView(p.apps[name], name, isObject(hosted[name]) ? hosted[name] : undefined);
        if (!view) continue;
        if (Object.hasOwn(was, name) && canonical(was[name].view) === canonical(view))
          await c.query("UPDATE bops.app_views SET seen_at = now() WHERE user_id = $1 AND ws_id = $2 AND app = $3", [user!.id, p.ws, name]);
        else
          await c.query(
            `INSERT INTO bops.app_views (user_id, ws_id, app, view, view_at, seen_at) VALUES ($1, $2, $3, $4::jsonb, now(), now())
             ON CONFLICT (user_id, ws_id, app) DO UPDATE SET view = $4::jsonb, view_at = now(), seen_at = now()`,
            [user!.id, p.ws, name, JSON.stringify(view)],
          );
      }
      // An app the workspace no longer has: its view goes too.
      const gone = Object.keys(was).filter((name) => !Object.hasOwn(hosted, name));
      if (gone.length) await c.query("DELETE FROM bops.app_views WHERE user_id = $1 AND ws_id = $2 AND app = ANY($3::text[])", [user!.id, p.ws, gone]);
      return { blob, views: await readAppViews(c, user!.id, p.ws) };
    });
    if (!out) throw new HttpError(403, NOT_YOURS);
    res.writeHead(204, { "cache-control": "no-store" });
    res.end();
    viewsWritten(user!.id, p.ws, out.blob, out.views);
  },
};

export const routes: Route[] = [post];
