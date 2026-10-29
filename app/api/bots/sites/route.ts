import { appsOpen } from "@/lib/apps-access";
import { botSiteDomains } from "@/lib/server/bot-groups";
import { notReady } from "@/lib/server/ready";
import { sharedOpen } from "@/lib/server/shared";
import { getState } from "@/lib/server/store";
import { MAIN_WORKSPACE } from "@/lib/types";

export const dynamic = "force-dynamic";

/**
 * The domain each bot of the workspace (`?ws=`, the current one by default) that works on a site shows under its name
 * in the sidebar (lib/server/bot-groups.ts botSiteDomains): { domains: { [botId]: domain | null } }, null for a site
 * with none (the sidebar says the site's name then). From Orgo alone, kept a few minutes: reading it never wakes a
 * computer. Nothing while a workspace shared with the user is open (Bops Cloud sends its own), or apps aren't open here.
 */
export async function GET(request: Request) {
  const unready = notReady();
  if (unready) return unready;
  if (!appsOpen(getState()) || sharedOpen()) return Response.json({ domains: {} });
  const wsId = new URL(request.url).searchParams.get("ws") ?? getState().workspace ?? MAIN_WORKSPACE;
  return Response.json({ domains: await botSiteDomains(wsId).catch(() => ({})) });
}
