import { appsOpen } from "@/lib/apps-access";
import { HostedAppError, listApps } from "@/lib/server/hosted-apps";
import { notReady } from "@/lib/server/ready";
import { getState } from "@/lib/server/store";
import { MAIN_WORKSPACE } from "@/lib/types";

export const dynamic = "force-dynamic";

/**
 * The workspace's apps that run on the web (lib/server/hosted-apps.ts): each Ingot repo it keeps
 * (Workspace.hostedApps), with its newest changeset as Ingot says (no computer is asked), its newest
 * deploy, and whether deploying can work here (HostedAppsAnswer). `?ws=` names the workspace (the
 * current one by default).
 */
export async function GET(request: Request) {
  const unready = notReady();
  if (unready) return unready;
  // Only an @orgo.ai account has apps on the web for now (lib/apps-access.ts).
  if (!appsOpen(getState())) return Response.json({ error: "Not found" }, { status: 404 });
  const wsId = new URL(request.url).searchParams.get("ws") ?? getState().workspace ?? MAIN_WORKSPACE;
  try {
    return Response.json(await listApps(wsId));
  } catch (e) {
    return e instanceof HostedAppError ? Response.json({ error: e.message }, { status: e.status }) : Response.json({ error: (e as Error).message }, { status: 500 });
  }
}
