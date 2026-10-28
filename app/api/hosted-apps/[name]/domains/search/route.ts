import { appsOpen } from "@/lib/apps-access";
import { HostedAppError, searchDomains } from "@/lib/server/hosted-apps";
import { notReady } from "@/lib/server/ready";
import { getState } from "@/lib/server/store";
import { fromBopsWindow } from "@/lib/server/ui-token";
import { MAIN_WORKSPACE } from "@/lib/types";

export const dynamic = "force-dynamic";

/**
 * Names to buy for the app (DomainSearchAnswer in lib/hosted-apps.ts), ?ws=&q=&page=, priced in Orgo
 * credits. Each search is one of the few a minute Orgo allows the user: the Bops window only.
 */
export async function GET(request: Request, ctx: { params: Promise<{ name: string }> }) {
  const unready = notReady() ?? (fromBopsWindow(request) ? null : Response.json({ error: "Domains can only be searched in the Bops app." }, { status: 403 }));
  if (unready) return unready;
  // Only an @orgo.ai account has apps on the web for now (lib/apps-access.ts).
  if (!appsOpen(getState())) return Response.json({ error: "Not found" }, { status: 404 });
  const { name } = await ctx.params;
  const q = new URL(request.url).searchParams;
  const wsId = q.get("ws") ?? getState().workspace ?? MAIN_WORKSPACE;
  try {
    return Response.json(await searchDomains(wsId, name, q.get("q"), q.get("page") ?? "0", q.get("site") ?? undefined));
  } catch (e) {
    return e instanceof HostedAppError ? Response.json({ error: e.message, ...e.extra }, { status: e.status }) : Response.json({ error: (e as Error).message }, { status: 500 });
  }
}
