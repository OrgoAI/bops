import { startSession, stopSession } from "@/lib/server/sessions";
import { getState } from "@/lib/server/store";
import { live } from "@/lib/types";

/** Start a thread directly on a bot, bypassing chat (used for testing). */
export async function POST(request: Request) {
  const { botId, goal, title } = (await request.json()) as { botId?: string; goal?: string; title?: string };
  if (!botId || !goal?.trim()) return Response.json({ error: "botId and goal required" }, { status: 400 });
  return Response.json(startSession({ botId, goal: goal.trim(), title }));
}

/** Stop one thread, every live thread of a bot, or everything. */
export async function DELETE(request: Request) {
  const { sessionId, botId } = (await request.json().catch(() => ({}))) as { sessionId?: string; botId?: string };
  const ids = sessionId
    ? [sessionId]
    : getState()
        .sessions.filter((s) => live(s) && (!botId || s.botId === botId))
        .map((s) => s.id);
  ids.forEach((x) => stopSession(x));
  return Response.json({ stopped: ids.length });
}
