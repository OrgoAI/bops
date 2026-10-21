import { BrainError, brainsOff, setBotBrain } from "@/lib/server/brains";
import { notReady } from "@/lib/server/ready";
import { fromBopsWindow } from "@/lib/server/ui-token";

export const dynamic = "force-dynamic";

/** Which brain a bot's tasks run on (its profile's Brain): one of the brains it's on, or `brainId` null for Bops agent. Only from the Bops window. */
export async function POST(request: Request) {
  const unready = brainsOff() ?? notReady() ?? (fromBopsWindow(request) ? null : Response.json({ error: "Brains can only be changed in the Bops app." }, { status: 403 }));
  if (unready) return unready;
  const b = (await request.json().catch(() => ({}))) as { botId?: unknown; brainId?: unknown };
  if (typeof b.botId !== "string" || (b.brainId !== null && typeof b.brainId !== "string")) return Response.json({ error: "which bot, and which brain (or null)?" }, { status: 400 });
  try {
    setBotBrain(b.botId, b.brainId);
    return Response.json({ ok: true });
  } catch (e) {
    return Response.json({ error: (e as Error).message }, { status: e instanceof BrainError ? e.status : 500 });
  }
}
