import { appsOpen } from "@/lib/apps-access";
import { appEnvOf } from "@/lib/hosted-apps";
import { addSite, deployApp, HostedAppError, makePreview, promoteApp, reapplyApp, removeApp, removeLeftOver, removeSite, restoreApp, restoreConfirm, rollbackApp } from "@/lib/server/hosted-apps";
import { notReady } from "@/lib/server/ready";
import { sharedOpen } from "@/lib/server/shared";
import { getState } from "@/lib/server/store";
import { fromBopsWindow } from "@/lib/server/ui-token";
import { MAIN_WORKSPACE } from "@/lib/types";

export const dynamic = "force-dynamic";

/**
 * Put an app on the web (HostedAppAction in lib/hosted-apps.ts): "deploy" changeset `at` (the newest on main
 * by default) on its Preview, on the computer it's worked on (or on `botId`'s the first time), every site of it
 * or the one `site` names (Published is never deployed this way); "promote" { site?, at? } (Publish) puts on
 * Published the changeset the Preview serves; "reapply" { site? } builds Published's own changeset again with
 * its variables; "rollback" one of its (or that site's) earlier deploys, put live again without a build (`env`
 * "preview" for the Preview's; none is Published's); "addSite" and "removeSite" one more site of it;
 * "removeLeftOver" { project } one of its left overs; "preview" { site?, label? } its Preview's link made now,
 * with a name the owner chose ahead; "restore" { to } the whole app put back as it was at changeset `to`, as a new
 * changeset on main (hosted-apps.ts restoreApp: the owner's alone, never while a workspace shared with the user is
 * open). Answers { app }. A deploy makes the site public, so it's done only from the Bops window (ui-token.ts): never
 * from a page a bot's browser reached this server with.
 */
const notFromWindow = (request: Request, words = "Apps can only be deployed in the Bops app.") => (fromBopsWindow(request) ? null : Response.json({ error: words }, { status: 403 }));

const str = (v: unknown) => (typeof v === "string" && v.trim() ? v.trim() : undefined);

const answer = (e: unknown) =>
  e instanceof HostedAppError ? Response.json({ error: e.message, ...e.extra }, { status: e.status }) : Response.json({ error: (e as Error).message }, { status: 500 });

/** Restore and its question are the owner's alone: none while a workspace someone shared with the user is open (no member acts on apps' code). */
const notOwner = () => (sharedOpen() ? Response.json({ error: "Only the owner can restore an app." }, { status: 403 }) : null);

/**
 * GET ?ws=&restore=<to>: what restoring the app to changeset `to` undoes, for its question before it's sent
 * (AppRestoreConfirm: every changeset after it, newest first, and why it can't be restored now, if it can't). From
 * Ingot alone: no computer is asked.
 */
export async function GET(request: Request, ctx: { params: Promise<{ name: string }> }) {
  const unready = notReady();
  if (unready) return unready;
  if (!appsOpen(getState())) return Response.json({ error: "Not found" }, { status: 404 });
  const theirs = notOwner();
  if (theirs) return theirs;
  const { name } = await ctx.params;
  const url = new URL(request.url);
  const wsId = url.searchParams.get("ws") ?? getState().workspace ?? MAIN_WORKSPACE;
  if (!url.searchParams.has("restore")) return Response.json({ error: "What should it look at?" }, { status: 400 });
  try {
    return Response.json(await restoreConfirm(wsId, name, url.searchParams.get("restore")));
  } catch (e) {
    return answer(e);
  }
}

export async function POST(request: Request, ctx: { params: Promise<{ name: string }> }) {
  const unready = notReady() ?? notFromWindow(request);
  if (unready) return unready;
  // Only an @orgo.ai account has apps on the web for now (lib/apps-access.ts).
  if (!appsOpen(getState())) return Response.json({ error: "Not found" }, { status: 404 });
  const { name } = await ctx.params;
  const b = (await request.json().catch(() => ({}))) as Record<string, unknown>;
  const wsId = str(b.ws) ?? getState().workspace ?? MAIN_WORKSPACE;
  try {
    const env = appEnvOf(b.env) === "preview" ? ("preview" as const) : undefined;
    // (A deploy goes to the Preview: Published gets only what Publish or Apply variables put there.)
    if (b.action === "deploy") {
      const r = await deployApp(wsId, name, { at: str(b.at), botId: str(b.botId), ...(str(b.site) ? { site: str(b.site) } : {}), env: "preview" });
      return Response.json({ app: r.app, ...(r.said ? { said: r.said } : {}) });
    }
    if (b.action === "promote") {
      const r = await promoteApp(wsId, name, { ...(str(b.site) ? { site: str(b.site) } : {}), ...(str(b.at) ? { at: str(b.at) } : {}) });
      return Response.json({ app: r.app, ...(r.said ? { said: r.said } : {}) });
    }
    if (b.action === "reapply") return Response.json(await reapplyApp(wsId, name, { ...(str(b.site) ? { site: str(b.site) } : {}) }));
    if (b.action === "removeLeftOver") return Response.json(await removeLeftOver(wsId, name, b.project));
    if (b.action === "preview") return Response.json(await makePreview(wsId, name, { site: str(b.site), label: b.label }));
    if (b.action === "rollback") return Response.json(await rollbackApp(wsId, name, b.deployment, str(b.site), env));
    if (b.action === "addSite") return Response.json(await addSite(wsId, name, b.site));
    if (b.action === "removeSite") return Response.json(await removeSite(wsId, name, b.site));
    if (b.action === "restore") return notOwner() ?? Response.json(await restoreApp(wsId, name, b.to));
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
