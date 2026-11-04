import "server-only";
import { randomBytes } from "node:crypto";
import { changeRouteOf, isChange, powersFor, THIS_WS } from "@/cloud/change-routes";
import { POWER_WORDS, type Power } from "@/lib/member-access";
import { actShared, sharedChangesOpen } from "./shared";
import { fromBopsWindow } from "./ui-token";

/**
 * A change the window makes in a workspace shared with the user, through the same route the owner's window calls: sent to
 * the owner's Mac as a "change" act (cloud/change-routes.ts) for someone with the power it needs (an Admin has every one,
 * a Member the ones turned on for them in Team), instead of being done here on the user's own state. Null when it isn't
 * one: no shared workspace open, or a call that changes nothing of it (the user's own favorites, which workspace is open),
 * which the route then does as before. The route answers `{ ok, sent }` at once; the owner's Mac does it in a moment, and
 * the window sees it as the copy has it (or why not: SharedWsSlice.changed).
 */
export async function relayChange(request: Request): Promise<Response | null> {
  const open = sharedChangesOpen();
  if (!open) return null;
  const url = new URL(request.url);
  const found = changeRouteOf(request.method, url.pathname);
  if (!found) return null;
  const raw = (await request.clone().json().catch(() => null)) as unknown;
  const body: Record<string, unknown> = raw && typeof raw === "object" && !Array.isArray(raw) ? { ...(raw as Record<string, unknown>) } : {};
  // Of the shared workspace: a change, with its id where the route names one and one of its bots where it names a bot.
  // Anything else is the user's own where the route has those (their own workspace renamed while this one is open, its
  // favorites), done here as before; elsewhere it's refused, never done on the user's own bot of that id.
  const ours = isChange(found.route, body) && !(found.route.ws ?? []).some((k) => body[k] !== open.wsId) && (!found.route.bot || open.botIds.includes(String(body[found.route.bot])));
  if (!ours) return found.route.ownCalls ? null : Response.json({ error: "Only the owner changes this.", code: "view_only" }, { status: 403 });
  // Only from the Bops window, as every change of the owner's own is.
  if (!fromBopsWindow(request)) return Response.json({ error: "Only from the Bops window." }, { status: 403 });
  // This workspace, as the window calls it: the owner's Mac puts its own id back.
  for (const k of found.route.ws ?? []) if (body[k] === open.wsId) body[k] = THIS_WS;
  const query: Record<string, string> = {};
  for (const [k, v] of url.searchParams) query[k] = (found.route.wsQuery ?? []).includes(k) && v === open.wsId ? THIS_WS : v;
  const powers = powersFor(found.route, body);
  if (typeof powers === "string") return Response.json({ error: powers }, { status: 403 });
  const missing = powers.find((p: Power) => !open.can.includes(p));
  if (missing) return Response.json({ error: `The owner or an Admin can let you change ${POWER_WORDS[missing].name} in Team.` }, { status: 403 });
  if (!open.changes) return Response.json({ error: "The owner's Bops needs an update first." }, { status: 409 });
  const key = `chg_${randomBytes(9).toString("base64url")}`;
  const method = request.method as "POST" | "PATCH" | "PUT" | "DELETE";
  const r = await actShared({ act: "change", method, path: url.pathname, ...(Object.keys(query).length ? { query } : {}), body }, key);
  if (!r.ok) return Response.json({ error: r.error, ...(r.code ? { code: r.code } : {}) }, { status: r.status });
  return Response.json({ ok: true, sent: true, key });
}
