import { session } from "@/lib/server/store";
import { sessionUsage } from "@/lib/server/usage";

/** Recorded model-token totals for a task, including its helper turns. */
export async function GET(_request: Request, ctx: RouteContext<"/api/sessions/[sessionId]/usage">) {
  const { sessionId } = await ctx.params;
  if (!session(sessionId)) return Response.json({ error: "no such thread" }, { status: 404 });
  return Response.json(sessionUsage(sessionId));
}
