import { appsOpen } from "@/lib/apps-access";
import { appDomains, HostedAppError } from "@/lib/server/hosted-apps";
import { notReady } from "@/lib/server/ready";
import { getState } from "@/lib/server/store";
import { MAIN_WORKSPACE } from "@/lib/types";

export const dynamic = "force-dynamic";

/**
 * An app's domains (AppDomainsAnswer in lib/hosted-apps.ts): its public URL, the domains its computer
 * serves on its port, and the DNS records of the ones bought through Orgo, each marked the user's or
 * Orgo's. From orgo-web alone: reading it never wakes the computer.
 */
export async function GET(request: Request, ctx: { params: Promise<{ name: string }> }) {
  const unready = notReady();
  if (unready) return unready;
  // Only an @orgo.ai account has apps on the web for now (lib/apps-access.ts).
  if (!appsOpen(getState())) return Response.json({ error: "Not found" }, { status: 404 });
  const { name } = await ctx.params;
  const wsId = new URL(request.url).searchParams.get("ws") ?? getState().workspace ?? MAIN_WORKSPACE;
  try {
    return Response.json(await appDomains(wsId, name));
  } catch (e) {
    return e instanceof HostedAppError ? Response.json({ error: e.message, ...e.extra }, { status: e.status }) : Response.json({ error: (e as Error).message }, { status: 500 });
  }
}
