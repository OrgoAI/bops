import { createRoutine, deleteRoutine, setRoutineEnabled } from "@/lib/server/routines";
import { InvalidRoutineScheduleError } from "@/lib/server/routine-schedule";
import type { Schedule } from "@/lib/types";
import { notReady } from "@/lib/server/ready";

export async function POST(request: Request) {
  const unready = notReady();
  if (unready) return unready;
  let body;
  try {
    body = await request.json();
  } catch {
    return Response.json({ error: "Invalid JSON" }, { status: 400 });
  }
  const { botId, title, goal, schedule } = (body ?? {}) as { botId?: string; title?: string; goal?: string; schedule?: Schedule };
  if (!botId || !goal || !schedule) return Response.json({ error: "botId, goal and schedule required" }, { status: 400 });
  try {
    return Response.json(createRoutine(botId, title || goal.slice(0, 40), goal, schedule));
  } catch (e) {
    if (e instanceof InvalidRoutineScheduleError) return Response.json({ error: e.message }, { status: 400 });
    throw e;
  }
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
