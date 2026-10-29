import { domainsAnswer, domainsGate, wsFrom } from "@/lib/server/domain-routes";
import { searchForWorkspace } from "@/lib/server/workspace-domains";

export const dynamic = "force-dynamic";

/**
 * Names to buy for the workspace, no app needed (DomainSearchAnswer in lib/hosted-apps.ts), ?ws=&q=&page=,
 * priced in Orgo credits. Each search is one of the few a minute Orgo allows the user: the Bops window only.
 * (A static folder, so it comes before [zone], whose ids are UUIDs.)
 */
export async function GET(request: Request) {
  const gate = domainsGate(request, "Domains can only be searched in the Bops app.");
  if (gate) return gate;
  const q = new URL(request.url).searchParams;
  try {
    return Response.json(await searchForWorkspace(wsFrom(q.get("ws")), q.get("q"), q.get("page") ?? "0"));
  } catch (e) {
    return domainsAnswer(e);
  }
}
