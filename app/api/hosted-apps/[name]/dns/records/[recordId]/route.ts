import { appsOpen } from "@/lib/apps-access";
import { changeRecord, HostedAppError, removeRecord } from "@/lib/server/hosted-apps";
import { notReady } from "@/lib/server/ready";
import { getState } from "@/lib/server/store";
import { fromBopsWindow } from "@/lib/server/ui-token";
import { MAIN_WORKSPACE } from "@/lib/types";

export const dynamic = "force-dynamic";

/**
 * Change (PATCH, the whole record as it becomes: { ws, zone, type, name, value, priority?, weight?,
 * port? }) or remove (DELETE { ws, zone }) one DNS record of the zone of a domain bought through Orgo that
 * points at the app, by the id the records were read with. Each answers the zone's records as written.
 * Only from the Bops window (ui-token.ts), as a deploy is.
 */
type Ctx = { params: Promise<{ name: string; recordId: string }> };

const notFromWindow = (request: Request) => (fromBopsWindow(request) ? null : Response.json({ error: "DNS can only be changed in the Bops app." }, { status: 403 }));

/** What the window sent: the body, else (a DELETE without one) the query. */
async function asked(request: Request): Promise<Record<string, unknown>> {
  const b = (await request.json().catch(() => null)) as Record<string, unknown> | null;
  return b && typeof b === "object" ? b : Object.fromEntries(new URL(request.url).searchParams);
}

const wsOf = (b: Record<string, unknown>) => (typeof b.ws === "string" && b.ws.trim()) || getState().workspace || MAIN_WORKSPACE;

const failed = (e: unknown) =>
  e instanceof HostedAppError ? Response.json({ error: e.message, ...e.extra }, { status: e.status }) : Response.json({ error: (e as Error).message }, { status: 500 });

export async function PATCH(request: Request, ctx: Ctx) {
  const unready = notReady() ?? notFromWindow(request);
  if (unready) return unready;
  // Only an @orgo.ai account has apps on the web for now (lib/apps-access.ts).
  if (!appsOpen(getState())) return Response.json({ error: "Not found" }, { status: 404 });
  const { name, recordId } = await ctx.params;
  const b = await asked(request);
  try {
    return Response.json(await changeRecord(wsOf(b), name, b.zone, recordId, b));
  } catch (e) {
    return failed(e);
  }
}

export async function DELETE(request: Request, ctx: Ctx) {
  const unready = notReady() ?? notFromWindow(request);
  if (unready) return unready;
  // Only an @orgo.ai account has apps on the web for now (lib/apps-access.ts).
  if (!appsOpen(getState())) return Response.json({ error: "Not found" }, { status: 404 });
  const { name, recordId } = await ctx.params;
  const b = await asked(request);
  try {
    return Response.json(await removeRecord(wsOf(b), name, b.zone, recordId));
  } catch (e) {
    return failed(e);
  }
}
