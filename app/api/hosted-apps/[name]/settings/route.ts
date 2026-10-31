import { appsOpen } from "@/lib/apps-access";
import { appSettings, changeSettings, HostedAppError } from "@/lib/server/hosted-apps";
import { notReady } from "@/lib/server/ready";
import { getState } from "@/lib/server/store";
import { fromBopsWindow } from "@/lib/server/ui-token";
import { MAIN_WORKSPACE } from "@/lib/types";

export const dynamic = "force-dynamic";

const answer = (e: unknown) =>
  e instanceof HostedAppError ? Response.json({ error: e.message, ...e.extra }, { status: e.status }) : Response.json({ error: (e as Error).message }, { status: 500 });

/**
 * An app's settings (AppSettingsAnswer in lib/hosted-apps.ts): its address, its port and commands, its
 * variables' names and its recent deploys, from its deploy project at orgo-web (the computer is never asked):
 * Published's, or the Preview's with env=preview (with Published's variables' names too).
 */
export async function GET(request: Request, ctx: { params: Promise<{ name: string }> }) {
  const unready = notReady();
  if (unready) return unready;
  // Only an @orgo.ai account has apps on the web for now (lib/apps-access.ts).
  if (!appsOpen(getState())) return Response.json({ error: "Not found" }, { status: 404 });
  const { name } = await ctx.params;
  const wsId = new URL(request.url).searchParams.get("ws") ?? getState().workspace ?? MAIN_WORKSPACE;
  try {
    const q = new URL(request.url).searchParams;
    return Response.json(await appSettings(wsId, name, q.get("site") ?? undefined, q.get("env") ?? undefined));
  } catch (e) {
    return answer(e);
  }
}

/**
 * Change its port, its install, build and start commands and its health check's path (AppSettingsChange): what its site runs, so only
 * from the Bops window (ui-token.ts), as a deploy is. Answers its settings as they are now.
 */
export async function PATCH(request: Request, ctx: { params: Promise<{ name: string }> }) {
  const unready = notReady() ?? (fromBopsWindow(request) ? null : Response.json({ error: "An app's settings can only be changed in the Bops app." }, { status: 403 }));
  if (unready) return unready;
  if (!appsOpen(getState())) return Response.json({ error: "Not found" }, { status: 404 });
  const { name } = await ctx.params;
  const b = (await request.json().catch(() => ({}))) as Record<string, unknown>;
  const wsId = (typeof b.ws === "string" && b.ws.trim()) || getState().workspace || MAIN_WORKSPACE;
  try {
    return Response.json(await changeSettings(wsId, name, { port: b.port, install: b.install, build: b.build, start: b.start, health: b.health }, b.site, b.env));
  } catch (e) {
    return answer(e);
  }
}
