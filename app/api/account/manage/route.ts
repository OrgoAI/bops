import { loadOrgoKey } from "@/lib/server/orgo-auth";
import { bopsBillingLink } from "@/lib/server/plan";

export const dynamic = "force-dynamic";

/**
 * Change or cancel the paid Bops plan, update the card, see invoices: Orgo's page for it (Stripe's
 * billing portal, Bops plans only), for the app to open in the browser. Answers {url}, or {error}.
 */
export async function POST() {
  const key = await loadOrgoKey();
  if (!key) return Response.json({ error: "Sign in with Orgo first." }, { status: 401 });
  const link = await bopsBillingLink(key, "manage");
  return "url" in link ? Response.json(link) : Response.json({ error: link.error, ...(link.soon ? { soon: true } : {}) }, { status: link.status });
}
