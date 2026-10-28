import { appsOpen } from "@/lib/apps-access";
import { checkDomain, HostedAppError, removeDomain } from "@/lib/server/hosted-apps";
import { notReady } from "@/lib/server/ready";
import { getState } from "@/lib/server/store";
import { fromBopsWindow } from "@/lib/server/ui-token";
import { MAIN_WORKSPACE } from "@/lib/types";

export const dynamic = "force-dynamic";

const notFromWindow = (request: Request) => (fromBopsWindow(request) ? null : Response.json({ error: "Domains can only be changed in the Bops app." }, { status: 403 }));

const answer = (e: unknown) =>
  e instanceof HostedAppError ? Response.json({ error: e.message, ...e.extra }, { status: e.status }) : Response.json({ error: (e as Error).message }, { status: 500 });

const wsOf = (b: Record<string, unknown>) => (typeof b.ws === "string" && b.ws.trim()) || getState().workspace || MAIN_WORKSPACE;

/** Check one of the app's domains now ({ ws }): Orgo turns it on once its DNS answers. Answers AppDomainChecked. */
export async function POST(request: Request, ctx: { params: Promise<{ name: string; domainId: string }> }) {
  const unready = notReady() ?? notFromWindow(request);
  if (unready) return unready;
  // Only an @orgo.ai account has apps on the web for now (lib/apps-access.ts).
  if (!appsOpen(getState())) return Response.json({ error: "Not found" }, { status: 404 });
  const { name, domainId } = await ctx.params;
  const b = (await request.json().catch(() => ({}))) as Record<string, unknown>;
  try {
    return Response.json(await checkDomain(wsOf(b), name, domainId, b.site));
  } catch (e) {
    return answer(e);
  }
}

/** Take one of its domains off the app ({ ws }). Answers its domains as they are now (AppDomainsAnswer). */
export async function DELETE(request: Request, ctx: { params: Promise<{ name: string; domainId: string }> }) {
  const unready = notReady() ?? notFromWindow(request);
  if (unready) return unready;
  if (!appsOpen(getState())) return Response.json({ error: "Not found" }, { status: 404 });
  const { name, domainId } = await ctx.params;
  const b = (await request.json().catch(() => ({}))) as Record<string, unknown>;
  try {
    return Response.json(await removeDomain(wsOf(b), name, domainId, b.site));
  } catch (e) {
    return answer(e);
  }
}
