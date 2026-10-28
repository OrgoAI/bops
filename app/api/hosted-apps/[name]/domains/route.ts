import { appsOpen } from "@/lib/apps-access";
import { buyDomain, connectDomain, domainOptions, HostedAppError, setAutoRenew } from "@/lib/server/hosted-apps";
import { notReady } from "@/lib/server/ready";
import { getState } from "@/lib/server/store";
import { fromBopsWindow } from "@/lib/server/ui-token";
import { MAIN_WORKSPACE } from "@/lib/types";

export const dynamic = "force-dynamic";

/** Domains are bought and pointed only from the Bops window (ui-token.ts), never a page a bot's browser reached. */
const notFromWindow = (request: Request) => (fromBopsWindow(request) ? null : Response.json({ error: "Domains can only be added in the Bops app." }, { status: 403 }));

const answer = (e: unknown) =>
  e instanceof HostedAppError ? Response.json({ error: e.message, ...e.extra }, { status: e.status }) : Response.json({ error: (e as Error).message }, { status: 500 });

const wsOf = (b: Record<string, unknown>) => (typeof b.ws === "string" && b.ws.trim()) || getState().workspace || MAIN_WORKSPACE;

/**
 * What a domain can be added to the app from (AppDomainOptions in lib/hosted-apps.ts): whether one can be
 * bought, the workspace's bought domains nothing points at yet, and who the user registered their last one to.
 * That's the user's own address and phone: the window only.
 */
export async function GET(request: Request, ctx: { params: Promise<{ name: string }> }) {
  const unready = notReady() ?? notFromWindow(request);
  if (unready) return unready;
  // Only an @orgo.ai account has apps on the web for now (lib/apps-access.ts).
  if (!appsOpen(getState())) return Response.json({ error: "Not found" }, { status: 404 });
  const { name } = await ctx.params;
  const wsId = new URL(request.url).searchParams.get("ws") ?? getState().workspace ?? MAIN_WORKSPACE;
  try {
    return Response.json(await domainOptions(wsId, name, new URL(request.url).searchParams.get("site") ?? undefined));
  } catch (e) {
    return answer(e);
  }
}

/**
 * Add a domain to the app (AppDomainAdd): "buy" one at the price the user saw, then point it here, or
 * "connect" one the user owns, or one the workspace bought. Answers AppDomainAdded, or why not.
 */
export async function POST(request: Request, ctx: { params: Promise<{ name: string }> }) {
  const unready = notReady() ?? notFromWindow(request);
  if (unready) return unready;
  if (!appsOpen(getState())) return Response.json({ error: "Not found" }, { status: 404 });
  const { name } = await ctx.params;
  const b = (await request.json().catch(() => ({}))) as Record<string, unknown>;
  try {
    if (b.action === "buy") return Response.json(await buyDomain(wsOf(b), name, { domain: b.domain, registrant: b.registrant, price: b.price }, b.site));
    if (b.action === "connect") return Response.json(await connectDomain(wsOf(b), name, { domain: b.domain, ...(b.zone !== undefined ? { zone: b.zone } : {}) }, b.site));
    return Response.json({ error: "What should happen to it?" }, { status: 400 });
  } catch (e) {
    return answer(e);
  }
}

/** A bought domain's auto-renew, on or off ({ ws, zone, autoRenew }): its renewals are paid from the user's credits. Answers { renewal }. */
export async function PATCH(request: Request, ctx: { params: Promise<{ name: string }> }) {
  const unready = notReady() ?? notFromWindow(request);
  if (unready) return unready;
  if (!appsOpen(getState())) return Response.json({ error: "Not found" }, { status: 404 });
  const { name } = await ctx.params;
  const b = (await request.json().catch(() => ({}))) as Record<string, unknown>;
  try {
    return Response.json(await setAutoRenew(wsOf(b), name, b.zone, b.autoRenew, b.site));
  } catch (e) {
    return answer(e);
  }
}
