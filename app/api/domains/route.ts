import { askedOf, domainsAnswer, domainsGate, wsFrom } from "@/lib/server/domain-routes";
import { buyForWorkspace, workspaceDomains } from "@/lib/server/workspace-domains";

export const dynamic = "force-dynamic";

/*
 * A workspace's domains, for Settings (WorkspaceDomainsAnswer in lib/hosted-apps.ts). Not under
 * app/api/hosted-apps: a folder there named domains would take the place of an app named so.
 */

/**
 * GET ?ws= : every domain the workspace bought through Orgo, with its renewal and what its names serve, and
 * whether one can be bought here. It carries who the user registered their last one to (their own address
 * and phone): the Bops window only.
 */
export async function GET(request: Request) {
  const gate = domainsGate(request, "Domains can only be seen in the Bops app.");
  if (gate) return gate;
  try {
    return Response.json(await workspaceDomains(wsFrom(new URL(request.url).searchParams.get("ws"))));
  } catch (e) {
    return domainsAnswer(e);
  }
}

/**
 * POST { ws, domain, registrant, price }: buy it for the workspace at `price`, the price in cents the user
 * saw (WorkspaceDomainBuy), pointed nowhere. Answers WorkspaceDomainBought, or why not ({ error, code?,
 * field?, price?, renewal?, years?, available?, topUp? }).
 */
export async function POST(request: Request) {
  const gate = domainsGate(request, "Domains can only be bought in the Bops app.");
  if (gate) return gate;
  const b = await askedOf(request);
  try {
    return Response.json(await buyForWorkspace(wsFrom(b.ws), { domain: b.domain, registrant: b.registrant, price: b.price }));
  } catch (e) {
    return domainsAnswer(e);
  }
}
