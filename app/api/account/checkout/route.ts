import { loadOrgoKey } from "@/lib/server/orgo-auth";
import { bopsBillingLink } from "@/lib/server/plan";

export const dynamic = "force-dynamic";

/**
 * Pay for Bops Pro or Max ({tier: "pro_bops" | "max_bops"}): a Stripe Checkout page from Orgo, for the
 * app to open in the browser (an upgrade from Pro is Orgo's page to confirm the change). Asked with the
 * user's Orgo key, so it stays on the server. Answers {url}, or {error} saying why not ({soon: true}
 * when Orgo can't take payment for Bops plans yet).
 */
export async function POST(request: Request) {
  const { tier } = (await request.json().catch(() => ({}))) as { tier?: unknown };
  if (tier !== "pro_bops" && tier !== "max_bops") return Response.json({ error: "Pick Pro or Max." }, { status: 400 });
  const key = await loadOrgoKey();
  if (!key) return Response.json({ error: "Sign in with Orgo first." }, { status: 401 });
  const link = await bopsBillingLink(key, { tier });
  return "url" in link ? Response.json(link) : Response.json({ error: link.error, ...(link.soon ? { soon: true } : {}) }, { status: link.status });
}
