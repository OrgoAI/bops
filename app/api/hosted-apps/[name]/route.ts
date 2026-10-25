import { appsOpen } from "@/lib/apps-access";
import { deployApp, HostedAppError } from "@/lib/server/hosted-apps";
import { notReady } from "@/lib/server/ready";
import { getState } from "@/lib/server/store";
import { fromBopsWindow } from "@/lib/server/ui-token";
import { MAIN_WORKSPACE } from "@/lib/types";

export const dynamic = "force-dynamic";

/**
 * Put an app on the web (HostedAppAction in lib/hosted-apps.ts): "deploy" changeset `at` (the newest on
 * main by default) on the computer it's worked on, or on `botId`'s the first time. Answers { app }. A
 * deploy makes the site public, so it's done only from the Bops window (ui-token.ts): never from a page a
 * bot's browser reached this server with.
 */
const notFromWindow = (request: Request) => (fromBopsWindow(request) ? null : Response.json({ error: "Apps can only be deployed in the Bops app." }, { status: 403 }));

const str = (v: unknown) => (typeof v === "string" && v.trim() ? v.trim() : undefined);

export async function POST(request: Request, ctx: { params: Promise<{ name: string }> }) {
  const unready = notReady() ?? notFromWindow(request);
  if (unready) return unready;
  // Only an @orgo.ai account has apps on the web for now (lib/apps-access.ts).
  if (!appsOpen(getState())) return Response.json({ error: "Not found" }, { status: 404 });
  const { name } = await ctx.params;
  const b = (await request.json().catch(() => ({}))) as Record<string, unknown>;
  const wsId = str(b.ws) ?? getState().workspace ?? MAIN_WORKSPACE;
  try {
    if (b.action === "deploy") return Response.json({ app: (await deployApp(wsId, name, { at: str(b.at), botId: str(b.botId) })).app });
    return Response.json({ error: "What should happen to it?" }, { status: 400 });
  } catch (e) {
    return e instanceof HostedAppError ? Response.json({ error: e.message }, { status: e.status }) : Response.json({ error: (e as Error).message }, { status: 500 });
  }
}
