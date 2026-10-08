import { isTopUpAmount, TOPUP_AMOUNT_RULE } from "@/lib/credit-topup";
import { cloudOn } from "@/lib/server/cloud";
import { loadOrgoKey } from "@/lib/server/orgo-auth";
import { buyCreditOnCard, CREDIT_OFF, creditCheckoutLink, readCreditCard } from "@/lib/server/plan";
import { trackServerEvent } from "@/lib/server/analytics";
import { notReady } from "@/lib/server/ready";

export const dynamic = "force-dynamic";

/** The card's handle as Orgo gives it (orgo-web checks it exactly), and an Idempotency-Key as Orgo takes one. */
const CARD_HANDLE = /^[A-Za-z0-9_-]{16,128}$/;
const IDEMPOTENCY_KEY = /^[\x21-\x7e]{8,255}$/;

/**
 * Adding AI credit once, for the account sheet (components/app/account.tsx AddCredit, lib/credit-topup.ts),
 * asked of Orgo with the user's key (lib/server/plan.ts), so it stays on the server. Never monthly, never
 * an automatic reload: only when someone presses Pay.
 *
 * GET: {off: true} when there's no adding credit here (Orgo doesn't sell it yet, or the app doesn't work
 * through Bops Cloud, whose credit it is). Else {card, pending}: the card a top-up would charge (null:
 * none, so Checkout) and the payments whose credit is on its way (null: Orgo couldn't say). {error}
 * when Orgo couldn't look.
 */
export async function GET() {
  const key = await loadOrgoKey();
  if (!key) return Response.json({ error: "Sign in with Orgo first." }, { status: 401 });
  if (!cloudOn()) return Response.json({ off: true });
  const read = await readCreditCard(key);
  return "error" in read ? Response.json({ error: read.error }, { status: read.status }) : Response.json(read);
}

/**
 * POST {amount_cents, card_handle?, idempotency_key?}: $20, $50, $100 or any whole-dollar amount from $5
 * to $1,000, in cents.
 * - With card_handle (GET's, for the card the user confirmed) and idempotency_key (one per purchase, the
 *   same on a retry of it): that card is charged once, and Orgo's answer comes back as it gave it: 200
 *   {status: "succeeded"}, 202 {status: "pending", code}, 402 {status: "checkout", code} (nothing was
 *   charged: Checkout next), 409 {code: "card_changed", card}, or another refusal with its code.
 * - Without card_handle: {url}, a Stripe Checkout page for the browser.
 * 503 {code: "bops_credit_off"} when Orgo doesn't sell AI credit yet.
 */
export async function POST(request: Request) {
  const unready = notReady();
  if (unready) return unready;
  const body = (await request.json().catch(() => null)) as { amount_cents?: unknown; card_handle?: unknown; idempotency_key?: unknown } | null;
  const amount = body?.amount_cents;
  if (!isTopUpAmount(amount)) return Response.json({ error: TOPUP_AMOUNT_RULE, code: "invalid_amount" }, { status: 400 });
  const handle = body?.card_handle;
  const onCard = handle !== undefined && handle !== null;
  if (onCard && (typeof handle !== "string" || !CARD_HANDLE.test(handle)))
    return Response.json({ error: "Pick the card to charge again.", code: "card_handle_required" }, { status: 400 });
  const idempotencyKey = body?.idempotency_key;
  if (onCard && (typeof idempotencyKey !== "string" || !IDEMPOTENCY_KEY.test(idempotencyKey)))
    return Response.json({ error: "Send an idempotency_key, one per purchase.", code: "idempotency_key_required" }, { status: 400 });
  const key = await loadOrgoKey();
  if (!key) return Response.json({ error: "Sign in with Orgo first." }, { status: 401 });
  if (!cloudOn()) return Response.json(CREDIT_OFF, { status: 503 });
  if (!onCard) {
    const link = await creditCheckoutLink(key, amount);
    if ("url" in link) trackServerEvent("bops_credit_topup_started", { amount_cents: amount, method: "checkout" });
    return "url" in link ? Response.json(link) : Response.json({ error: link.error, ...(link.code ? { code: link.code } : {}) }, { status: link.status });
  }
  trackServerEvent("bops_credit_topup_started", { amount_cents: amount, method: "saved_card" }, { once: idempotencyKey as string });
  const got = await buyCreditOnCard(key, { amountCents: amount, cardHandle: handle as string, idempotencyKey: idempotencyKey as string });
  const result = ({ 200: "succeeded", 202: "pending", 402: "checkout", 409: "card_changed" } as const)[got.status as 200 | 202 | 402 | 409] ?? "refused";
  trackServerEvent("bops_credit_topup_charged", { amount_cents: amount, result }, { once: `${idempotencyKey as string}:${result}` });
  return Response.json(got.json, { status: got.status });
}
