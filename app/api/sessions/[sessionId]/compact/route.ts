import { compactThread } from "@/lib/server/sessions";
import { notReady } from "@/lib/server/ready";
import { sharedOpen } from "@/lib/server/shared";

/** Compact (the thread's menu): its brain folds what it has so far into a summary of its own, now (sessions.ts compactThread). */
export async function POST(_request: Request, ctx: RouteContext<"/api/sessions/[sessionId]/compact">) {
  const unready = notReady();
  if (unready) return unready;
  if (sharedOpen()) return Response.json({ error: "In a shared workspace, it goes through its owner's Bops." }, { status: 403 });
  const { sessionId } = await ctx.params;
  const r = await compactThread(sessionId);
  return r.ok ? Response.json({ ok: true }) : Response.json({ error: r.error }, { status: r.status });
}
