import { DISPLAYS, workspaceOf } from "@/lib/types";
import { resetScreens } from "@/lib/server/sessions";
import { bot, getState } from "@/lib/server/store";

export const dynamic = "force-dynamic";

/**
 * Put screens back the way a new computer starts. One screen (`screen`: 1-4), all of a bot's, or
 * (`team`) every screen of every bot in its workspace. Screens in use come back as skipped, with why;
 * `force` stops the task on them first.
 */
export async function POST(request: Request) {
  const { botId, screen, team, force } = (await request.json().catch(() => ({}))) as { botId?: string; screen?: number; team?: boolean; force?: boolean };
  const b = botId ? bot(botId) : undefined;
  if (!b) return Response.json({ error: "no such bot" }, { status: 404 });
  const displays = screen ? [DISPLAYS[screen - 1]].filter((d) => d !== undefined) : DISPLAYS;
  const bots = team ? getState().bots.filter((x) => workspaceOf(x) === workspaceOf(b) && x.computerId) : [b];
  const results = await Promise.all(
    bots.map(async (x) => {
      try {
        return { botId: x.id, name: x.name, ...(await resetScreens(x.id, displays, !!force)) };
      } catch (e) {
        return { botId: x.id, name: x.name, reset: [], skipped: [], error: (e as Error).message };
      }
    }),
  );
  return Response.json({ results });
}
