import { appsOpen } from "@/lib/apps-access";
import { appCommits, HostedAppError } from "@/lib/server/hosted-apps";
import { notReady } from "@/lib/server/ready";
import { getState } from "@/lib/server/store";
import { MAIN_WORKSPACE } from "@/lib/types";

export const dynamic = "force-dynamic";

/**
 * An app's changesets on main, newest first (AppCommitsAnswer), from Ingot: `?before=` for the page older
 * than that one. `offline` when Ingot can't be reached: no computer is asked.
 */
export async function GET(request: Request, ctx: { params: Promise<{ name: string }> }) {
  const unready = notReady();
  if (unready) return unready;
  // Only an @orgo.ai account has apps on the web for now (lib/apps-access.ts).
  if (!appsOpen(getState())) return Response.json({ error: "Not found" }, { status: 404 });
  const { name } = await ctx.params;
  const url = new URL(request.url);
  const wsId = url.searchParams.get("ws") ?? getState().workspace ?? MAIN_WORKSPACE;
  try {
    return Response.json(await appCommits(wsId, name, url.searchParams.get("before")));
  } catch (e) {
    return e instanceof HostedAppError ? Response.json({ error: e.message }, { status: e.status }) : Response.json({ error: (e as Error).message }, { status: 500 });
  }
}
