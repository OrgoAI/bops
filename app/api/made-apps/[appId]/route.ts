import { appCode, buildApp, deleteApp, draftOf, goBack, madeApp } from "@/lib/server/made-apps";

/** An app a bot made: its code now (or what a build is writing), for the tab's Code view. */
export async function GET(_request: Request, ctx: RouteContext<"/api/made-apps/[appId]">) {
  const { appId } = await ctx.params;
  if (!madeApp(appId)) return Response.json({ error: "No such app." }, { status: 404 });
  return Response.json({ code: appCode(appId), draft: draftOf(appId) });
}

/** Go back to a version (and Undo), ask its bot to fix a problem it hit, or delete it. */
export async function POST(request: Request, ctx: RouteContext<"/api/made-apps/[appId]">) {
  const { appId } = await ctx.params;
  const app = madeApp(appId);
  if (!app) return Response.json({ error: "No such app." }, { status: 404 });
  const body = (await request.json().catch(() => ({}))) as { action?: string; version?: number; problem?: string };
  try {
    if (body.action === "back" && typeof body.version === "number") goBack(appId, body.version);
    else if (body.action === "fix" && body.problem) buildApp(app.botId, app.chatId, { appId, change: `It shows this problem when it runs; fix it: ${body.problem.slice(0, 1500)}` });
    else if (body.action === "delete") deleteApp(appId);
    else return Response.json({ error: "What should happen?" }, { status: 400 });
    return Response.json({ ok: true });
  } catch (e) {
    return Response.json({ error: (e as Error).message }, { status: 400 });
  }
}
