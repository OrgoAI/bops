import { BrainError, brainsOff, signOut } from "@/lib/server/brains";
import { notReady } from "@/lib/server/ready";
import { fromBopsWindow } from "@/lib/server/ui-token";

export const dynamic = "force-dynamic";

/** Sign a Claude Code brain out on the computer `botId` works on (Claude Code's own sign-out there). Only from the Bops window. */
export async function POST(request: Request) {
  const unready = brainsOff() ?? notReady() ?? (fromBopsWindow(request) ? null : Response.json({ error: "Brains can only be changed in the Bops app." }, { status: 403 }));
  if (unready) return unready;
  const b = (await request.json().catch(() => ({}))) as { brainId?: unknown; botId?: unknown };
  if (typeof b.brainId !== "string" || typeof b.botId !== "string") return Response.json({ error: "which brain, on which bot's computer?" }, { status: 400 });
  try {
    await signOut(b.brainId, b.botId);
    return Response.json({ ok: true });
  } catch (e) {
    return Response.json({ error: (e as Error).message }, { status: e instanceof BrainError ? e.status : 500 });
  }
}
