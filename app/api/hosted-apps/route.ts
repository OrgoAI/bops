import { appsOpen } from "@/lib/apps-access";
import { addApp, HostedAppError, listApps } from "@/lib/server/hosted-apps";
import { seeAppsFromPage } from "@/lib/server/apps-for-members";
import { notReady } from "@/lib/server/ready";
import { getState } from "@/lib/server/store";
import { fromBopsWindow } from "@/lib/server/ui-token";
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
    const answer = await listApps(wsId);
    // What people with Your Apps see of them, from what was just read (lib/server/apps-for-members.ts), now and then.
    void seeAppsFromPage(wsId, answer.apps).catch((e: Error) => console.warn(`[hosted-apps] members' view: ${e.message}`));
    return Response.json(answer);
  } catch (e) {
    return e instanceof HostedAppError ? Response.json({ error: e.message }, { status: e.status }) : Response.json({ error: (e as Error).message }, { status: 500 });
  }
}

/**
 * Add app (AddAppAsk in lib/hosted-apps.ts): a new app the workspace's main bot builds on its computer, put
 * live once it's built when `deploy`. Answers AddAppAnswer (the task, in that bot's chat), or { error, field? }
 * (409 for a name another app has). It starts work on a computer, so it's done only from the Bops window.
 */
export async function POST(request: Request) {
  const unready = notReady() ?? (fromBopsWindow(request) ? null : Response.json({ error: "Apps can only be added in the Bops app." }, { status: 403 }));
  if (unready) return unready;
  // Only an @orgo.ai account has apps on the web for now (lib/apps-access.ts).
  if (!appsOpen(getState())) return Response.json({ error: "Not found" }, { status: 404 });
  const b = (await request.json().catch(() => ({}))) as Record<string, unknown>;
  const wsId = (typeof b.ws === "string" && b.ws.trim()) || getState().workspace || MAIN_WORKSPACE;
  try {
    return Response.json(await addApp(wsId, { name: b.name, what: b.what, deploy: b.deploy }));
  } catch (e) {
    return e instanceof HostedAppError ? Response.json({ error: e.message, ...e.extra }, { status: e.status }) : Response.json({ error: (e as Error).message }, { status: 500 });
  }
}
