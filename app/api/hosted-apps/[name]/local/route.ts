import { appsOpen } from "@/lib/apps-access";
import { HostedAppError, localAct, localStatus } from "@/lib/server/hosted-apps";
import { notReady } from "@/lib/server/ready";
import { getState } from "@/lib/server/store";
import { fromBopsWindow } from "@/lib/server/ui-token";
import { MAIN_WORKSPACE } from "@/lib/types";

export const dynamic = "force-dynamic";

const answer = (e: unknown) =>
  e instanceof HostedAppError ? Response.json({ error: e.message, ...e.extra }, { status: e.status }) : Response.json({ error: (e as Error).message }, { status: 500 });

/**
 * An app's Local (LocalAnswer in lib/hosted-apps.ts): each site's dev server on its computer, as the computer
 * says now; never asked of one asleep (it says so). `fresh`: not the answer of a few seconds ago.
 */
export async function GET(request: Request, ctx: { params: Promise<{ name: string }> }) {
  const unready = notReady();
  if (unready) return unready;
  // Only an @orgo.ai account has apps on the web for now (lib/apps-access.ts).
  if (!appsOpen(getState())) return Response.json({ error: "Not found" }, { status: 404 });
  const { name } = await ctx.params;
  const q = new URL(request.url).searchParams;
  const wsId = q.get("ws") ?? getState().workspace ?? MAIN_WORKSPACE;
  try {
    return Response.json(await localStatus(wsId, name, { fresh: q.get("fresh") === "1" }));
  } catch (e) {
    return answer(e);
  }
}

/**
 * Start, stop or open a site's Local ({ ws, action, site?, command? }): it runs commands on the app's computer,
 * so only from the Bops window (ui-token.ts). Answers LocalAnswer.
 */
export async function POST(request: Request, ctx: { params: Promise<{ name: string }> }) {
  const unready = notReady() ?? (fromBopsWindow(request) ? null : Response.json({ error: "An app's Local can only be started in the Bops app." }, { status: 403 }));
  if (unready) return unready;
  if (!appsOpen(getState())) return Response.json({ error: "Not found" }, { status: 404 });
  const { name } = await ctx.params;
  const b = (await request.json().catch(() => ({}))) as Record<string, unknown>;
  const wsId = (typeof b.ws === "string" && b.ws.trim()) || getState().workspace || MAIN_WORKSPACE;
  try {
    return Response.json(await localAct(wsId, name, { action: b.action, site: b.site, command: b.command }));
  } catch (e) {
    return answer(e);
  }
}
