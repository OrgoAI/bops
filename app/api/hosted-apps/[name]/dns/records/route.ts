import { appsOpen } from "@/lib/apps-access";
import { addRecord, HostedAppError } from "@/lib/server/hosted-apps";
import { notReady } from "@/lib/server/ready";
import { getState } from "@/lib/server/store";
import { fromBopsWindow } from "@/lib/server/ui-token";
import { MAIN_WORKSPACE } from "@/lib/types";

export const dynamic = "force-dynamic";

/**
 * Add a DNS record to the zone of a domain bought through Orgo that points at the app ({ ws, zone, type,
 * name, value, priority?, weight?, port? }). Answers the zone's records as written. A record changes where
 * a domain's visitors and mail go, so it's done only from the Bops window (ui-token.ts), as a deploy is.
 */
export async function POST(request: Request, ctx: { params: Promise<{ name: string }> }) {
  const unready = notReady() ?? (fromBopsWindow(request) ? null : Response.json({ error: "DNS can only be changed in the Bops app." }, { status: 403 }));
  if (unready) return unready;
  // Only an @orgo.ai account has apps on the web for now (lib/apps-access.ts).
  if (!appsOpen(getState())) return Response.json({ error: "Not found" }, { status: 404 });
  const { name } = await ctx.params;
  const b = (await request.json().catch(() => ({}))) as Record<string, unknown>;
  const wsId = (typeof b.ws === "string" && b.ws.trim()) || getState().workspace || MAIN_WORKSPACE;
  try {
    return Response.json(await addRecord(wsId, name, b.zone, b, b.site));
  } catch (e) {
    return e instanceof HostedAppError ? Response.json({ error: e.message, ...e.extra }, { status: e.status }) : Response.json({ error: (e as Error).message }, { status: 500 });
  }
}
