import { openInTerminal } from "@/lib/server/sessions";
import { notReady } from "@/lib/server/ready";
import { fromBopsWindow } from "@/lib/server/ui-token";

export const dynamic = "force-dynamic";

/**
 * Open a thread Claude Code runs in a terminal on its screen, for the user to work with it there
 * (lib/server/sessions.ts openInTerminal): only from the Bops window, which then shows that screen
 * ({ botId, display }). Their next reply in the thread, or handing the screen back, closes it.
 */
export async function POST(request: Request, ctx: RouteContext<"/api/sessions/[sessionId]/terminal">) {
  const unready = notReady();
  if (unready) return unready;
  if (!fromBopsWindow(request)) return Response.json({ error: "A thread opens in a terminal only from the Bops app." }, { status: 403 });
  const { sessionId } = await ctx.params;
  try {
    return Response.json({ ok: true, ...openInTerminal(sessionId) });
  } catch (e) {
    return Response.json({ error: (e as Error).message }, { status: 409 });
  }
}
