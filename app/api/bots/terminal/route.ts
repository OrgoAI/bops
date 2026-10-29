import { brainsOff } from "@/lib/server/brains";
import { notReady } from "@/lib/server/ready";
import { openBotTerminal } from "@/lib/server/sessions";
import { fromBopsWindow } from "@/lib/server/ui-token";

export const dynamic = "force-dynamic";

/**
 * Open a bot's own terminal on a free screen of its computer (its profile's Open its terminal): its shell, as its
 * Default CLI agent, where claude, codex and opencode are the bot's. Only from the Bops window. Returns the screen.
 */
export async function POST(request: Request) {
  const unready = brainsOff() ?? notReady() ?? (fromBopsWindow(request) ? null : Response.json({ error: "A bot's terminal can only be opened in the Bops app." }, { status: 403 }));
  if (unready) return unready;
  const b = (await request.json().catch(() => ({}))) as { botId?: unknown };
  if (typeof b.botId !== "string") return Response.json({ error: "which bot?" }, { status: 400 });
  try {
    return Response.json({ ok: true, ...openBotTerminal(b.botId) });
  } catch (e) {
    return Response.json({ error: (e as Error).message }, { status: 400 });
  }
}
