import { replyToSession } from "@/lib/server/sessions";
import { watchInstead } from "@/lib/server/watches";
import { session } from "@/lib/server/store";

/** The user replies inside a thread; the bot takes it as its next turn. */
export async function POST(request: Request, ctx: RouteContext<"/api/sessions/[sessionId]/reply">) {
  const { sessionId } = await ctx.params;
  const { text } = (await request.json()) as { text?: string };
  if (!session(sessionId)) return Response.json({ error: "no such thread" }, { status: 404 });
  if (!text?.trim()) return Response.json({ error: "empty reply" }, { status: 400 });
  // "Keep an eye on this" becomes a watch on the thread's screen instead of the thread checking itself.
  const watch = await watchInstead(sessionId, text.trim()).catch(() => null);
  if (!watch) replyToSession(sessionId, text.trim());
  return Response.json({ ok: true, watch });
}
