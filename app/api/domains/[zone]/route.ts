import { askedOf, domainsAnswer, domainsGate, wsFrom } from "@/lib/server/domain-routes";
import { autoRenewIn, workspaceZone } from "@/lib/server/workspace-domains";

export const dynamic = "force-dynamic";

type Ctx = { params: Promise<{ zone: string }> };

const WORDS = "Domains can only be changed in the Bops app.";

/** GET ?ws= : one of the workspace's domains (its id at Orgo): its zone, renewal, and what points at it (WorkspaceZoneAnswer). */
export async function GET(request: Request, ctx: Ctx) {
  const gate = domainsGate(request, "Domains can only be seen in the Bops app.");
  if (gate) return gate;
  const { zone } = await ctx.params;
  try {
    return Response.json(await workspaceZone(wsFrom(new URL(request.url).searchParams.get("ws")), zone));
  } catch (e) {
    return domainsAnswer(e);
  }
}

/** PATCH { ws, autoRenew }: its auto-renew on (its renewals are paid from the user's Orgo credits) or off. Answers { renewal }. */
export async function PATCH(request: Request, ctx: Ctx) {
  const gate = domainsGate(request, WORDS);
  if (gate) return gate;
  const { zone } = await ctx.params;
  const b = await askedOf(request);
  try {
    return Response.json(await autoRenewIn(wsFrom(b.ws), zone, b.autoRenew));
  } catch (e) {
    return domainsAnswer(e);
  }
}
