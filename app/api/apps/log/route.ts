import { lastUses } from "@/lib/server/access-sync";
import { getState } from "@/lib/server/store";
import { notReady } from "@/lib/server/ready";
import { fromBopsWindow } from "@/lib/server/ui-token";
import { MAIN_WORKSPACE, workspaceOf } from "@/lib/types";

export const dynamic = "force-dynamic";

/**
 * When each Connected App account and API key was last used, and by which bot of the current workspace
 * (the use log, lib/server/access-sync.ts), for the Vault's "last used" lines. Only for the Bops window
 * (ui-token.ts), like the keys: a page a bot's Chrome reached this server with mustn't see it.
 */
export async function GET(request: Request) {
  const unready = notReady() ?? (fromBopsWindow(request) ? null : Response.json({ error: "Only the Bops app can see this." }, { status: 403 }));
  if (unready) return unready;
  const s = getState();
  const ws = s.workspace ?? s.workspaces?.[0]?.id ?? MAIN_WORKSPACE;
  return Response.json({ last: lastUses(new Set(s.bots.filter((b) => workspaceOf(b) === ws).map((b) => b.id))) });
}
