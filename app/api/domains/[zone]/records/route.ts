import { askedOf, domainsAnswer, domainsGate, wsFrom } from "@/lib/server/domain-routes";
import { addWorkspaceRecord } from "@/lib/server/workspace-domains";

export const dynamic = "force-dynamic";

/**
 * POST { ws, type, name, value, priority?, weight?, port? }: a record added to the zone of one of the
 * workspace's domains, whether an app uses it or not. Answers the zone's records as written (AppDnsWritten).
 */
export async function POST(request: Request, ctx: { params: Promise<{ zone: string }> }) {
  const gate = domainsGate(request, "DNS can only be changed in the Bops app.");
  if (gate) return gate;
  const { zone } = await ctx.params;
  const b = await askedOf(request);
  try {
    return Response.json(await addWorkspaceRecord(wsFrom(b.ws), zone, b));
  } catch (e) {
    return domainsAnswer(e);
  }
}
