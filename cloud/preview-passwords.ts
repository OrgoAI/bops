import type { IncomingMessage, ServerResponse } from "node:http";
import type { CloudUser } from "./auth.ts";
import { appHomeHere, hostingScope } from "./computer-scope.ts";
import { tx } from "./db.ts";
import { HttpError, readJson, type Route } from "./http.ts";
import { stateWritten } from "./live.ts";
import { PREVIEW_PASSWORD, PREVIEW_PASSWORD_PATH, type PreviewPasswordPost } from "./protocol.ts";
import { announce, checkUser, lockedState, lockUser, toJson } from "./state.ts";

/**
 * Each site's Preview password, kept by Bops Cloud for the people with Your Apps at Write (Workspace.previewPasswords).
 *
 * Whoever sets a Preview's password tells Bops Cloud the password it just sent to Orgo (lib/server/preview-password-share.ts):
 * the owner's Bops, on the owner's own key, or the app's own computer's runner, on its identity (its home is that computer:
 * computer-scope.ts appHomeHere, the rule its writes of the app's record are held to). A computer can set a Preview's
 * password on Orgo but never read one back (orgo-web lets one computer PATCH a public URL's password, never GET it), so
 * this is how what a runner set reaches anyone: nothing waits on the owner's Mac being on. Bops Cloud keeps the newest
 * on the owner's state, by "<app>/<site>", with the link it's for and when it took it, by its own clock: posts land in
 * the order they reach the owner's row lock, never by a sender's clock. ws-slice.ts appsFor shows it beside that link,
 * only to viewers at Write (an Admin always), and only while the link is the one the owner's Mac read for members, or,
 * where the owner's Mac read none (a new app a bot made on its computer while the Mac was off), the one the app's record
 * names by its label copy (ws-slice.ts sitesFilled): that link, and that it asks for a password, at Read too.
 * A share can miss (Bops Cloud away for longer than its sender keeps trying, an older Bops that never shares): the
 * owner's Mac, as it reads Orgo for members, tells it what Orgo has (lib/server/apps-for-members.ts), with the entry it
 * saw (`seen`), so that never lands over a share that came after it looked.
 *
 * Never said back: the answer is 204 with nothing in it, the same for a password that was there already, and every
 * refusal has fixed words. Never read by a computer (computer-scope.ts forComputer leaves it out, and a computer's write
 * that carries it is refused), never in a bot's prompt, never logged.
 */

/** A workspace's id, and an app's or a site's name (lib/hosted-apps.ts isAppName; the app's own site is named as the app). */
const WS_ID = /^[A-Za-z0-9_-]{1,64}$/;
const APP_NAME = /^(?=.{1,64}$)[a-z0-9]+(-[a-z0-9]+)*$/;
/** How long a link can be. */
const MAX_URL = 2048;

const BAD = "Send {ws, app, site, url, password}: a workspace, an app and its site, its https link, and its Preview password or null.";
const NOT_YOURS = "Only the owner or the app's own computer can set its Preview password.";

const isObject = (v: unknown): v is Record<string, unknown> => !!v && typeof v === "object" && !Array.isArray(v);
const list = (v: unknown): Record<string, unknown>[] => (Array.isArray(v) ? v.filter(isObject) : []);

/** An https link, as a Preview's is (https://<label>.orgo.dev): no spaces or control characters, MAX_URL at most. */
function httpsLink(v: unknown): v is string {
  if (typeof v !== "string" || v.length > MAX_URL || !v.startsWith("https://") || /[\s\x00-\x1f\x7f]/.test(v)) return false;
  try {
    return new URL(v).protocol === "https:";
  } catch {
    return false;
  }
}

/** The body as Bops sends it, or a 400 with fixed words (nothing of what was sent is said back). */
function postOf(body: unknown): PreviewPasswordPost {
  if (!isObject(body)) throw new HttpError(400, BAD);
  const { ws, app, site, url, password, seen } = body;
  if (typeof ws !== "string" || !WS_ID.test(ws)) throw new HttpError(400, BAD);
  if (typeof app !== "string" || !APP_NAME.test(app) || typeof site !== "string" || !APP_NAME.test(site)) throw new HttpError(400, BAD);
  if (!httpsLink(url)) throw new HttpError(400, BAD);
  if (password !== null && (typeof password !== "string" || !PREVIEW_PASSWORD.test(password))) throw new HttpError(400, BAD);
  if (seen !== undefined && (typeof seen !== "number" || !Number.isSafeInteger(seen) || seen < 0)) throw new HttpError(400, BAD);
  return { ws, app, site, url, password, ...(seen !== undefined ? { seen } : {}) };
}

/**
 * The owner's state with `p` kept (or the site's entry gone, for null), or null when the caller may not: the workspace
 * or the app isn't there, the site isn't the app's, or a computer is telling another computer's app's (or one whose
 * computer is gone). `unchanged`: nothing to write (null for a site with no entry, or one sent `seen` an entry that
 * isn't the one kept now: another share landed since the owner's Mac looked, and that one stands).
 */
function stateWith(blob: Record<string, unknown>, p: PreviewPasswordPost, user: CloudUser): { next: Record<string, unknown> } | { unchanged: true } | null {
  const spaces = list(blob.workspaces);
  const ws = spaces.find((w) => w.id === p.ws);
  const apps = ws && isObject(ws.hostedApps) ? ws.hostedApps : undefined;
  const h = apps && Object.hasOwn(apps, p.app) ? apps[p.app] : undefined;
  if (!ws || !isObject(h)) return null;
  if (p.site !== p.app && !list(h.sites).some((s) => s.name === p.site)) return null;
  if (user.computer && !appHomeHere(p.ws, h, hostingScope(blob, user.computer.desktopId))) return null;
  const key = `${p.app}/${p.site}`;
  const kept = isObject(ws.previewPasswords) ? ws.previewPasswords : {};
  if (p.seen !== undefined) {
    const was = Object.hasOwn(kept, key) ? kept[key] : undefined;
    if (!isObject(was) || was.at !== p.seen) return { unchanged: true };
  }
  if (p.password === null && !Object.hasOwn(kept, key)) return { unchanged: true };
  const map: Record<string, unknown> = { ...kept };
  if (p.password === null) delete map[key];
  else map[key] = { url: p.url, password: p.password, at: Date.now() };
  const nextWs: Record<string, unknown> = { ...ws, previewPasswords: map };
  if (!Object.keys(map).length) delete nextWs.previewPasswords;
  return { next: { ...blob, workspaces: (blob.workspaces as unknown[]).map((w) => (w === ws ? nextWs : w)) } };
}

/**
 * POST /v1/apps/preview-password (PreviewPasswordPost): a site's Preview password as whoever set it just now, kept for the
 * people at Write. Under the owner's row lock, as the cloud's other writes of the owner's state (members.ts answerOnComputer):
 * one more version, written by "cloud", then the owner's Mac hears of it (announce) and every viewer watching the
 * workspace whose part changed (stateWritten), so a Write viewer's window reads the new one within seconds.
 */
const post: Route = {
  method: "POST",
  path: PREVIEW_PASSWORD_PATH,
  auth: "user",
  computer: true,
  handle: async (req: IncomingMessage, res: ServerResponse, { user }) => {
    checkUser(req, user!, false);
    const p = postOf(await readJson<unknown>(req, 16 * 1024));
    const out = await tx(async (c) => {
      await lockUser(c, user!.id);
      const blob = await lockedState(c, user!.id);
      const r = stateWith(blob, p, user!);
      if (!r || "unchanged" in r) return r;
      await c.query("UPDATE bops.app_state SET state = $2::jsonb, version = version + 1, writer = 'cloud', updated_at = now() WHERE user_id = $1", [user!.id, toJson(r.next)]);
      return r;
    });
    if (!out) throw new HttpError(403, NOT_YOURS);
    res.writeHead(204, { "cache-control": "no-store" });
    res.end();
    if ("unchanged" in out) return;
    announce(user!.id);
    stateWritten(user!.id, out.next, "cloud");
  },
};

export const routes: Route[] = [post];
