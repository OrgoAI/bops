import { offerMove, replyToSession } from "@/lib/server/sessions";
import { watchInstead } from "@/lib/server/watches";
import { getState, session } from "@/lib/server/store";
import { mentionsMac } from "@/lib/server/where";
import { notReady } from "@/lib/server/ready";

/** The user replies inside a thread; the bot takes it in as it works, or as its next turn (sessions.ts replyToSession). */
export async function POST(request: Request, ctx: RouteContext<"/api/sessions/[sessionId]/reply">) {
  const unready = notReady();
  if (unready) return unready;
  const { sessionId } = await ctx.params;
  const { text } = (await request.json()) as { text?: string };
  const s = session(sessionId);
  if (!s) return Response.json({ error: "no such thread" }, { status: 404 });
  if (!text?.trim()) return Response.json({ error: "empty reply" }, { status: 400 });
  // "Keep an eye on this" becomes a watch on the thread's screen instead of the thread checking itself.
  // Not one of the thread's own next steps the user picked: it offered to do that, so it does it.
  const picked = s.options?.includes(text.trim());
  const watch = picked ? null : await watchInstead(sessionId, text.trim()).catch(() => null);
  if (!watch) replyToSession(sessionId, text.trim());
  // Words about their Mac in a cloud thread ("do it on my Mac", "do it locally") offer the move ("Move to your Mac?"),
  // and the user taps it: words alone also match "anywhere but on my Mac" or "a sleeve for my MacBook Air".
  // The Mac thread starts with what they told this one (sessions.ts cloudRecord).
  if (!watch && mentionsMac(text) && s.runsOn !== "mac" && getState().mac?.ready) offerMove(sessionId);
  return Response.json({ ok: true, watch });
}
