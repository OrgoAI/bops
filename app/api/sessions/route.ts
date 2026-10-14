import { startSession, stopSession } from "@/lib/server/sessions";
import { getState } from "@/lib/server/store";
import { live, type TaskEffort, type TaskRoute } from "@/lib/types";
import { notReady } from "@/lib/server/ready";

const EFFORTS: TaskEffort[] = ["none", "low", "medium", "high", "xhigh", "max"];
const SPEEDS = ["default", "fast", "ultrafast"] as const;

/**
 * Start a thread directly on a bot, bypassing chat (used for testing). With `model` (and `effort`,
 * `speed`), it runs on that, not on what Bops would route it to: a benchmark's run of one
 * configuration (scripts/bench-tasks.mjs --grid). Then it's always a new thread.
 */
export async function POST(request: Request) {
  const unready = notReady();
  if (unready) return unready;
  const { botId, goal, title, model, effort, speed } = (await request.json()) as { botId?: string; goal?: string; title?: string; model?: string; effort?: string; speed?: string };
  if (!botId || !goal?.trim()) return Response.json({ error: "botId and goal required" }, { status: 400 });
  if (model !== undefined && (typeof model !== "string" || !/^[\w.-]{1,64}$/.test(model))) return Response.json({ error: "model isn't a model name" }, { status: 400 });
  if (effort !== undefined && !EFFORTS.includes(effort as TaskEffort)) return Response.json({ error: `effort is one of ${EFFORTS.join(", ")}` }, { status: 400 });
  if (speed !== undefined && !(SPEEDS as readonly string[]).includes(speed)) return Response.json({ error: `speed is one of ${SPEEDS.join(", ")}` }, { status: 400 });
  const route: TaskRoute | undefined = model ? { by: "forced", model, effort: (effort as TaskEffort) ?? "medium", ...(speed ? { speed: speed as (typeof SPEEDS)[number] } : {}) } : undefined;
  return Response.json(startSession({ botId, goal: goal.trim(), title, ...(route ? { route, fresh: true } : {}) }));
}

/** Stop one thread, every live thread of a bot, or everything. */
export async function DELETE(request: Request) {
  const unready = notReady();
  if (unready) return unready;
  const { sessionId, botId } = (await request.json().catch(() => ({}))) as { sessionId?: string; botId?: string };
  const ids = sessionId
    ? [sessionId]
    : getState()
        .sessions.filter((s) => live(s) && (!botId || s.botId === botId))
        .map((s) => s.id);
  ids.forEach((x) => stopSession(x));
  return Response.json({ stopped: ids.length });
}
