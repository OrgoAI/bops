import { appsOpen } from "@/lib/apps-access";
import { allow, buildApp, codeFor, deleteApp, draftOf, goBack, madeApp } from "@/lib/server/made-apps";
import { getState } from "@/lib/server/store";

/** An app a bot made: its code now (or what a build is writing), for the tab's Code view; fetched from Orgo first when it was made on another Mac. */
export async function GET(_request: Request, ctx: RouteContext<"/api/made-apps/[appId]">) {
  // Only an @orgo.ai account has apps for now (lib/apps-access.ts).
  if (!appsOpen(getState())) return Response.json({ error: "Not found" }, { status: 404 });
  const { appId } = await ctx.params;
  if (!madeApp(appId)) return Response.json({ error: "No such app." }, { status: 404 });
  return Response.json({ code: await codeFor(appId), draft: draftOf(appId) });
}

/** Go back to a version (and Undo), ask its bot to fix a problem it hit, let it ask its bot, or delete it. */
export async function POST(request: Request, ctx: RouteContext<"/api/made-apps/[appId]">) {
  // Only an @orgo.ai account has apps for now (lib/apps-access.ts).
  if (!appsOpen(getState())) return Response.json({ error: "Not found" }, { status: 404 });
  const { appId } = await ctx.params;
  const app = madeApp(appId);
  if (!app) return Response.json({ error: "No such app." }, { status: 404 });
  const body = (await request.json().catch(() => ({}))) as { action?: string; version?: number; problem?: string; on?: boolean };
  try {
    if (body.action === "back" && typeof body.version === "number") {
      // The version gone back to may have been made on another Mac: its code is fetched first.
      await codeFor(appId, body.version);
      goBack(appId, body.version);
    } else if (body.action === "fix" && body.problem) buildApp(app.botId, app.chatId, { appId, change: `It shows this problem when it runs; fix it: ${body.problem.slice(0, 1500)}` });
    else if (body.action === "delete") deleteApp(appId);
    // Let it ask its bot (bops.bot), or stop it.
    else if (body.action === "allow-bot") allow(appId, "bot", body.on !== false);
    else return Response.json({ error: "What should happen?" }, { status: 400 });
    return Response.json({ ok: true });
  } catch (e) {
    return Response.json({ error: (e as Error).message }, { status: 400 });
  }
}
