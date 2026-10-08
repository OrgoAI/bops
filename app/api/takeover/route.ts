import { returnControl, takeOver, takeOverMacChrome } from "@/lib/server/sessions";
import { notReady } from "@/lib/server/ready";

/** Take control of one of a bot's screens, or with `macScreen` of a Chrome its Mac tasks use. The thread running there pauses. */
export async function POST(request: Request) {
  const unready = notReady();
  if (unready) return unready;
  const { botId, display, macScreen } = (await request.json()) as { botId?: string; display?: number; macScreen?: number };
  if (!botId || (display === undefined && macScreen === undefined)) return Response.json({ error: "botId and display (or macScreen) required" }, { status: 400 });
  if (macScreen !== undefined && ![0, 1, 2].includes(macScreen)) return Response.json({ error: "macScreen: 0, 1 or 2" }, { status: 400 });
  try {
    await (macScreen !== undefined ? takeOverMacChrome(botId, macScreen) : takeOver(botId, display!));
  } catch (e) {
    return Response.json({ error: (e as Error).message }, { status: 502 });
  }
  return Response.json({ ok: true });
}

/** Hand the screen back; a paused thread carries on. */
export async function DELETE() {
  const unready = notReady();
  if (unready) return unready;
  returnControl();
  return Response.json({ ok: true });
}
