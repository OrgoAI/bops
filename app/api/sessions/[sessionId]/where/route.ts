import { moveToMac, setWhere } from "@/lib/server/sessions";

/** The user says where a thread runs: answering "Mac or cloud?", or moving a stuck cloud thread to their Mac. */
export async function POST(request: Request, ctx: RouteContext<"/api/sessions/[sessionId]/where">) {
  const { sessionId } = await ctx.params;
  const { to, move } = (await request.json()) as { to?: "mac" | "cloud"; move?: boolean };
  try {
    if (move) return Response.json({ session: moveToMac(sessionId) });
    if (to !== "mac" && to !== "cloud") return Response.json({ error: "mac or cloud?" }, { status: 400 });
    setWhere(sessionId, to);
    return Response.json({ ok: true });
  } catch (e) {
    return Response.json({ error: (e as Error).message }, { status: 409 });
  }
}
