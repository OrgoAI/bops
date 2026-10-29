import { appsOpen } from "@/lib/apps-access";
import { changeEnv, HostedAppError } from "@/lib/server/hosted-apps";
import { notReady } from "@/lib/server/ready";
import { getState } from "@/lib/server/store";
import { fromBopsWindow } from "@/lib/server/ui-token";
import { MAIN_WORKSPACE } from "@/lib/types";

export const dynamic = "force-dynamic";

/**
 * Set or remove an app's variables (AppEnvChange in lib/hosted-apps.ts: { ws, env: { NAME: value | null } }),
 * only from the Bops window. The values are the user's secrets: they go on to orgo-web as they came and
 * nowhere else (never kept, logged or answered); the answer is the variables' names, { env }.
 */
export async function PATCH(request: Request, ctx: { params: Promise<{ name: string }> }) {
  const unready = notReady() ?? (fromBopsWindow(request) ? null : Response.json({ error: "An app's variables can only be changed in the Bops app." }, { status: 403 }));
  if (unready) return unready;
  // Only an @orgo.ai account has apps on the web for now (lib/apps-access.ts).
  if (!appsOpen(getState())) return Response.json({ error: "Not found" }, { status: 404 });
  const { name } = await ctx.params;
  const b = (await request.json().catch(() => ({}))) as Record<string, unknown>;
  const wsId = (typeof b.ws === "string" && b.ws.trim()) || getState().workspace || MAIN_WORKSPACE;
  try {
    return Response.json(await changeEnv(wsId, name, b.env, b.site));
  } catch (e) {
    // Never anything of what was sent: a refusal here names a variable at most.
    return e instanceof HostedAppError ? Response.json({ error: e.message, ...e.extra }, { status: e.status }) : Response.json({ error: "Couldn't save the variables. Try again." }, { status: 500 });
  }
}
