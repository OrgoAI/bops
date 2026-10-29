import { askedOf, domainsAnswer, domainsGate, wsFrom } from "@/lib/server/domain-routes";
import { changeWorkspaceRecord, removeWorkspaceRecord } from "@/lib/server/workspace-domains";

export const dynamic = "force-dynamic";

/**
 * Change (PATCH, the whole record as it becomes: { ws, type, name, value, priority?, weight?, port? }) or
 * remove (DELETE { ws }) one record of the zone of one of the workspace's domains, by the id it was read
 * with. Each answers the zone's records as written, or when they changed since, { error, stale, records }.
 */
type Ctx = { params: Promise<{ zone: string; recordId: string }> };

const WORDS = "DNS can only be changed in the Bops app.";

export async function PATCH(request: Request, ctx: Ctx) {
  const gate = domainsGate(request, WORDS);
  if (gate) return gate;
  const { zone, recordId } = await ctx.params;
  const b = await askedOf(request);
  try {
    return Response.json(await changeWorkspaceRecord(wsFrom(b.ws), zone, recordId, b));
  } catch (e) {
    return domainsAnswer(e);
  }
}

export async function DELETE(request: Request, ctx: Ctx) {
  const gate = domainsGate(request, WORDS);
  if (gate) return gate;
  const { zone, recordId } = await ctx.params;
  const b = await askedOf(request);
  try {
    return Response.json(await removeWorkspaceRecord(wsFrom(b.ws), zone, recordId));
  } catch (e) {
    return domainsAnswer(e);
  }
}
