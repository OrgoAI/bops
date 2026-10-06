import { deleteThread } from "@/lib/server/remove";
import { dismissWaiting, suggestFor } from "@/lib/server/sessions";

/** Delete a finished thread and its result in the chat. */
export async function DELETE(_request: Request, ctx: RouteContext<"/api/sessions/[sessionId]">) {
  const { sessionId } = await ctx.params;
  try {
    deleteThread(sessionId);
    return Response.json({ ok: true });
  } catch (e) {
    return Response.json({ error: (e as Error).message }, { status: 409 });
  }
}

/** `{ dismiss: true }`: the user has nothing to add, so the thread stops asking. `{ suggest: true }`: suggest replies to its question. */
export async function PATCH(request: Request, ctx: RouteContext<"/api/sessions/[sessionId]">) {
  const { sessionId } = await ctx.params;
  const { dismiss, suggest } = (await request.json().catch(() => ({}))) as { dismiss?: boolean; suggest?: boolean };
  if (dismiss) dismissWaiting(sessionId);
  if (suggest) await suggestFor(sessionId);
  return Response.json({ ok: true });
}
