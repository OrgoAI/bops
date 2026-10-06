import { returnControl, takeOver } from "@/lib/server/sessions";

/** Take control of one of a bot's screens. The thread running there pauses. */
export async function POST(request: Request) {
  const { botId, display } = (await request.json()) as { botId?: string; display?: number };
  if (!botId || display === undefined) return Response.json({ error: "botId and display required" }, { status: 400 });
  try {
    await takeOver(botId, display);
  } catch (e) {
    return Response.json({ error: (e as Error).message }, { status: 502 });
  }
  return Response.json({ ok: true });
}

/** Hand the screen back; a paused thread carries on. */
export async function DELETE() {
  returnControl();
  return Response.json({ ok: true });
}
