import { appsOpen } from "@/lib/apps-access";
import { cloudflareApply, cloudflarePlan, HostedAppError } from "@/lib/server/hosted-apps";
import { notReady } from "@/lib/server/ready";
import { getState } from "@/lib/server/store";
import { fromBopsWindow } from "@/lib/server/ui-token";
import { MAIN_WORKSPACE } from "@/lib/types";

export const dynamic = "force-dynamic";

/** A domain's records in the user's Cloudflare are read and set only from the Bops window (ui-token.ts), never a page a bot's browser reached. */
const notFromWindow = (request: Request) => (fromBopsWindow(request) ? null : Response.json({ error: "Domains can only be changed in the Bops app." }, { status: 403 }));

const answer = (e: unknown) =>
  e instanceof HostedAppError ? Response.json({ error: e.message, ...e.extra }, { status: e.status }) : Response.json({ error: (e as Error).message }, { status: 500 });

const wsOf = (b: Record<string, unknown>) => (typeof b.ws === "string" && b.ws.trim()) || getState().workspace || MAIN_WORKSPACE;

/** What Bops would set in Cloudflare for one of the app's domains (?ws=&site=): CloudflarePlan. Nothing is written. */
export async function GET(request: Request, ctx: { params: Promise<{ name: string; domainId: string }> }) {
  const unready = notReady() ?? notFromWindow(request);
  if (unready) return unready;
  // Only an @orgo.ai account has apps on the web for now (lib/apps-access.ts).
  if (!appsOpen(getState())) return Response.json({ error: "Not found" }, { status: 404 });
  const { name, domainId } = await ctx.params;
  const q = new URL(request.url).searchParams;
  try {
    return Response.json(await cloudflarePlan(q.get("ws") ?? getState().workspace ?? MAIN_WORKSPACE, name, domainId, q.get("site") ?? undefined));
  } catch (e) {
    return answer(e);
  }
}

/** The plan the user saw written in Cloudflare ({ ws, site?, plan, replace? }), then the domain checked: CloudflareApplied, or why not. */
export async function POST(request: Request, ctx: { params: Promise<{ name: string; domainId: string }> }) {
  const unready = notReady() ?? notFromWindow(request);
  if (unready) return unready;
  if (!appsOpen(getState())) return Response.json({ error: "Not found" }, { status: 404 });
  const { name, domainId } = await ctx.params;
  const b = (await request.json().catch(() => ({}))) as Record<string, unknown>;
  try {
    return Response.json(await cloudflareApply(wsOf(b), name, domainId, { plan: b.plan, replace: b.replace }, b.site));
  } catch (e) {
    return answer(e);
  }
}
