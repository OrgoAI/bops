import { appsOpen } from "@/lib/apps-access";
import { addSite, deployApp, HostedAppError, promoteApp, removeApp, removeSite, rollbackApp } from "@/lib/server/hosted-apps";
import { notReady } from "@/lib/server/ready";
import { getState } from "@/lib/server/store";
import { fromBopsWindow } from "@/lib/server/ui-token";
import { MAIN_WORKSPACE } from "@/lib/types";

export const dynamic = "force-dynamic";

/**
 * Put an app on the web (HostedAppAction in lib/hosted-apps.ts): "deploy" changeset `at` (the newest on
 * main by default) on the computer it's worked on, or on `botId`'s the first time, every site of it or the
 * one `site` names; "rollback" one of its (or that site's) earlier deploys, put live again without a build;
 * "addSite" and "removeSite" one more site of it. Deploy and rollback take `env` ("staging": its Staging
 * project beside Prod's on the same computer; none is Prod, as before); "promote" { site?, at? } puts on Prod
 * the changeset Staging serves. Answers { app }. A deploy makes the site public, so it's done only from the
 * Bops window (ui-token.ts): never from a page a bot's browser reached this server with.
 */
const notFromWindow = (request: Request, words = "Apps can only be deployed in the Bops app.") => (fromBopsWindow(request) ? null : Response.json({ error: words }, { status: 403 }));

const str = (v: unknown) => (typeof v === "string" && v.trim() ? v.trim() : undefined);

const answer = (e: unknown) =>
  e instanceof HostedAppError ? Response.json({ error: e.message, ...e.extra }, { status: e.status }) : Response.json({ error: (e as Error).message }, { status: 500 });

export async function POST(request: Request, ctx: { params: Promise<{ name: string }> }) {
  const unready = notReady() ?? notFromWindow(request);
  if (unready) return unready;
  // Only an @orgo.ai account has apps on the web for now (lib/apps-access.ts).
  if (!appsOpen(getState())) return Response.json({ error: "Not found" }, { status: 404 });
  const { name } = await ctx.params;
  const b = (await request.json().catch(() => ({}))) as Record<string, unknown>;
  const wsId = str(b.ws) ?? getState().workspace ?? MAIN_WORKSPACE;
  try {
    const env = b.env === "staging" ? ("staging" as const) : undefined;
    if (b.action === "deploy") return Response.json({ app: (await deployApp(wsId, name, { at: str(b.at), botId: str(b.botId), ...(str(b.site) ? { site: str(b.site) } : {}), ...(env ? { env } : {}) })).app });
    if (b.action === "promote") {
      const r = await promoteApp(wsId, name, { ...(str(b.site) ? { site: str(b.site) } : {}), ...(str(b.at) ? { at: str(b.at) } : {}) });
      return Response.json({ app: r.app, ...(r.said ? { said: r.said } : {}) });
    }
    if (b.action === "rollback") return Response.json(await rollbackApp(wsId, name, b.deployment, str(b.site), env));
    if (b.action === "addSite") return Response.json(await addSite(wsId, name, b.site));
    if (b.action === "removeSite") return Response.json(await removeSite(wsId, name, b.site));
    return Response.json({ error: "What should happen to it?" }, { status: 400 });
  } catch (e) {
    return answer(e);
  }
}

/**
 * Remove an app from the workspace ({ ws, repo }): its sites and their domains off its computer, its record
 * dropped, and its Ingot repo deleted too only when `repo` is true. Only from the Bops window, where it's
 * asked once more first. Answers RemoveAppAnswer.
 */
export async function DELETE(request: Request, ctx: { params: Promise<{ name: string }> }) {
  const unready = notReady() ?? notFromWindow(request, "Apps can only be removed in the Bops app.");
  if (unready) return unready;
  if (!appsOpen(getState())) return Response.json({ error: "Not found" }, { status: 404 });
  const { name } = await ctx.params;
  const b = (await request.json().catch(() => ({}))) as Record<string, unknown>;
  const wsId = str(b.ws) ?? getState().workspace ?? MAIN_WORKSPACE;
  try {
    return Response.json(await removeApp(wsId, name, { repo: b.repo }));
  } catch (e) {
    return answer(e);
  }
}
