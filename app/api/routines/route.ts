import { createRoutine, deleteRoutine, setRoutineEnabled } from "@/lib/server/routines";
import type { Schedule } from "@/lib/types";
import { notReady } from "@/lib/server/ready";

export async function POST(request: Request) {
  const unready = notReady();
  if (unready) return unready;
  const { botId, title, goal, schedule } = (await request.json()) as { botId?: string; title?: string; goal?: string; schedule?: Schedule };
  if (!botId || !goal || !schedule) return Response.json({ error: "botId, goal and schedule required" }, { status: 400 });
  return Response.json(createRoutine(botId, title || goal.slice(0, 40), goal, schedule));
}

export async function PATCH(request: Request) {
  const unready = notReady();
  if (unready) return unready;
  const { id, enabled } = (await request.json()) as { id?: string; enabled?: boolean };
  if (!id || enabled === undefined) return Response.json({ error: "id and enabled required" }, { status: 400 });
  setRoutineEnabled(id, enabled);
  return Response.json({ ok: true });
}

export async function DELETE(request: Request) {
  const unready = notReady();
  if (unready) return unready;
  const { id } = (await request.json()) as { id?: string };
  if (id) deleteRoutine(id);
  return Response.json({ ok: true });
}
