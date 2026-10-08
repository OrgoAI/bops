import { dropOffer, moveToMac, setWhere } from "@/lib/server/sessions";
import { notReady } from "@/lib/server/ready";

/**
 * The user says where a thread runs: answering "Mac or cloud?", moving a cloud thread to their Mac
 * (`move: true`: a stuck one, or one Bops offered to move), or turning that offer down (`move: false`).
 */
export async function POST(request: Request, ctx: RouteContext<"/api/sessions/[sessionId]/where">) {
  const unready = notReady();
  if (unready) return unready;
  const { sessionId } = await ctx.params;
  const { to, move } = (await request.json()) as { to?: "mac" | "cloud"; move?: boolean };
  try {
    if (move) return Response.json({ session: moveToMac(sessionId) });
    if (move === false) {
      dropOffer(sessionId);
      return Response.json({ ok: true });
    }
    if (to !== "mac" && to !== "cloud") return Response.json({ error: "mac or cloud?" }, { status: 400 });
    setWhere(sessionId, to);
    return Response.json({ ok: true });
  } catch (e) {
    return Response.json({ error: (e as Error).message }, { status: 409 });
  }
}
