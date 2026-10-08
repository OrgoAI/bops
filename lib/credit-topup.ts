/**
 * Adding AI credit once, from the account sheet (components/app/account.tsx AddCredit): $20, $50, $100
 * or any whole-dollar amount from $5 to $1,000, the way Orgo's own Add credit works (orgo-web
 * app/(app)/account/CreditAddon.tsx CreditTopUp and lib/credit-reload.ts, which this follows step for
 * step). With a card on file it asks once ("Add $50 of AI credit? Charged once to Visa ending 4242.")
 * and charges that card; without one, or when the card can't be charged, Stripe Checkout opens in the
 * browser. Never monthly, never an automatic reload: every top-up is someone pressing Pay.
 *
 * The sheet asks its own route (app/api/account/credit/route.ts), which asks orgo-web with the user's
 * Orgo key (lib/server/plan.ts): GET for the card and the payments whose credit is on its way, POST to
 * pay. Its answers keep orgo-web's shapes (amount_cents, card.handle, code). Shared by the route and the
 * sheet: no server imports.
 */

/** The amounts offered as buttons, in cents. Any whole-dollar amount from $5 to $1,000 sells too. */
export const TOPUP_PRESETS = [2000, 5000, 10000] as const;
export const TOPUP_MIN_CENTS = 500;
export const TOPUP_MAX_CENTS = 100_000;

/** A whole-dollar amount from $5 to $1,000, in cents (orgo-web's isBopsCreditAmount). */
export function isTopUpAmount(value: unknown): value is number {
  return typeof value === "number" && Number.isSafeInteger(value) && value >= TOPUP_MIN_CENTS && value <= TOPUP_MAX_CENTS && value % 100 === 0;
}

export const TOPUP_AMOUNT_RULE = "Choose $20, $50, $100, or a whole-dollar amount from $5 to $1,000.";

/** "$50", "$1,000": credit is sold at face value, so the cents are the price. */
export const dollars = (cents: number) => `$${(cents / 100).toLocaleString("en-US")}`;

/** The amount typed in the Other field (dollars, digits only), in cents; null when it isn't one that sells. */
export function typedCents(text: string): number | null {
  if (!/^\d{1,4}$/.test(text)) return null;
  const cents = Number(text) * 100;
  return isTopUpAmount(cents) ? cents : null;
}

/** What the Other field keeps of what's typed: digits, no leading zeros, $1,000 at most. */
export const tidyDollars = (text: string) => text.replace(/\D/g, "").replace(/^0+/, "").slice(0, 4);

/* ---------------- The card on file ---------------- */

/**
 * The card a top-up is charged to, as orgo-web shows it: never its Stripe id. `handle` names it back to
 * Orgo, which charges it only while it's still the card on file.
 */
export type SavedCard = { handle: string; brand: string; last4: string; exp_month: number; exp_year: number };

const BRANDS: Record<string, string> = {
  amex: "American Express",
  cartes_bancaires: "Cartes Bancaires",
  diners: "Diners Club",
  discover: "Discover",
  eftpos_au: "eftpos",
  interac: "Interac",
  jcb: "JCB",
  mastercard: "Mastercard",
  unionpay: "UnionPay",
  visa: "Visa",
};

/** "Visa ending 4242". */
export const cardName = (card: Pick<SavedCard, "brand" | "last4">) => `${BRANDS[card.brand] ?? "Card"} ending ${card.last4}`;

/** A card from an answer, only when it's whole. */
export function savedCardFrom(value: unknown): SavedCard | null {
  const c = value as Partial<SavedCard> | null | undefined;
  if (
    !c ||
    typeof c.handle !== "string" ||
    !/^[A-Za-z0-9_-]{16,128}$/.test(c.handle) ||
    typeof c.brand !== "string" ||
    typeof c.last4 !== "string" ||
    !/^\d{4}$/.test(c.last4) ||
    !Number.isInteger(c.exp_month) ||
    !Number.isInteger(c.exp_year)
  )
    return null;
  return { handle: c.handle, brand: c.brand, last4: c.last4, exp_month: c.exp_month!, exp_year: c.exp_year! };
}

/** A top-up paid, or still paying, whose credit isn't in the balance yet. */
export type PendingTopUp = {
  cents: number;
  /** payment_processing: the card payment hasn't cleared. credit_pending: it was paid, and the credit is on its way. */
  code: "payment_processing" | "credit_pending";
};

/** An answer's pending top-ups (orgo-web's {amount_cents, code}). Null when it couldn't say: keep what's shown. */
export function pendingFrom(list: unknown): PendingTopUp[] | null {
  if (!Array.isArray(list)) return null;
  return list.flatMap((p: { amount_cents?: unknown; code?: unknown } | null) =>
    p && Number.isSafeInteger(p.amount_cents) && (p.amount_cents as number) > 0 && (p.code === "payment_processing" || p.code === "credit_pending")
      ? [{ cents: p.amount_cents as number, code: p.code }]
      : [],
  );
}

/** The line under Add credit while a paid top-up's credit is on its way. */
export function pendingNote(pending: readonly PendingTopUp[]): string | null {
  if (!pending.length) return null;
  const total = dollars(pending.reduce((sum, p) => sum + p.cents, 0));
  const several = pending.length > 1;
  if (pending.some((p) => p.code === "payment_processing"))
    return several ? `Your ${total} of payments are processing. The credit is added when they clear.` : `Your ${total} payment is processing. The credit is added when it clears.`;
  return several ? `Your ${total} of payments went through. The credit is added shortly.` : `Your ${total} payment went through. The credit is added shortly.`;
}

/**
 * GET /api/account/credit, read: no adding credit here (`off`: Orgo doesn't sell it yet, so the sheet
 * shows no way to), or the card a top-up would charge (null: none, so Checkout) and the payments whose
 * credit is on its way (null: couldn't say). `unknown`: the card couldn't be looked up just now, so
 * Add credit asks again first.
 */
export type TopUpInfo = { off: true } | { off: false; card: SavedCard | null; pending: PendingTopUp[] | null; unknown: boolean };

export function topUpFrom(httpStatus: number, body: unknown): TopUpInfo {
  const b = (body && typeof body === "object" ? body : {}) as { off?: unknown; card?: unknown; pending?: unknown };
  if (b.off === true) return { off: true };
  if (httpStatus !== 200) return { off: false, card: null, pending: null, unknown: true };
  return { off: false, card: savedCardFrom(b.card), pending: pendingFrom(b.pending), unknown: false };
}

/** A new read over what's shown: one that couldn't look the card up keeps what was known, and one that couldn't say what's pending keeps that. */
export function mergeTopUp(was: TopUpInfo | null, next: TopUpInfo): TopUpInfo {
  if (next.off || !was || was.off) return next;
  if (next.unknown) return was;
  return next.pending === null ? { ...next, pending: was.pending } : next;
}

/* ---------------- A purchase on the card ---------------- */

/** What Add credit does next, after POST /api/account/credit answered a purchase on the card. */
export type TopUpNext =
  /** Paid and credited. */
  | { kind: "credited" }
  /** Paid or paying: the credit lands when the payment clears, or once it's saved. */
  | { kind: "pending"; code: PendingTopUp["code"] }
  /** Nothing was charged: offer Checkout for the same amount. no_card is Orgo's own look, the others Stripe's. */
  | { kind: "checkout"; code: string; message: string }
  /** The card on file isn't the one confirmed any more. Nothing was charged. */
  | { kind: "card_changed"; card: SavedCard }
  /** Orgo doesn't sell AI credit yet. Nothing was charged. */
  | { kind: "off" }
  /**
   * Not done. `sameKey`: a retry sends the same Idempotency-Key, which can never charge twice; else the
   * purchase is over and a retry is a new one. `maybeCharged`: the answer never came, or another try
   * under this key is still running, so the card may have been charged.
   */
  | { kind: "error"; message: string; sameKey: boolean; maybeCharged: boolean };

/** Whether it charged isn't known. orgo_unreachable is the route's own: Orgo didn't answer it. */
const MAYBE_CHARGED = new Set(["payment_unconfirmed", "idempotency_in_progress", "orgo_unreachable"]);
/** Turned down before any charge, and fine to try again under the same key. */
const RETRY_SAFE = new Set(["idempotency_unavailable", "card_unavailable", "rate_limited"]);

/** The card couldn't do it, by Orgo's code, when Orgo's answer had no words for it. */
const DECLINED: Record<string, string> = {
  no_card: "There's no card on file.",
  authentication_required: "Your bank wants to confirm this payment.",
  card_declined: "Your card was declined.",
  payment_failed: "Your card couldn't be charged.",
};

const UNCONFIRMED_TRY_AGAIN = "Couldn't confirm the payment. Try again: you won't be charged twice.";

/** Read POST /api/account/credit's answer to a purchase on the card (orgo-web's, passed through). */
export function topUpNext(httpStatus: number, body: unknown): TopUpNext {
  const reply = (body && typeof body === "object" ? body : {}) as { status?: unknown; code?: unknown; error?: unknown; card?: unknown };
  const message = typeof reply.error === "string" && reply.error ? reply.error : null;
  const code = typeof reply.code === "string" ? reply.code : "";
  if (httpStatus === 200 && reply.status === "succeeded") return { kind: "credited" };
  if (httpStatus === 202 && reply.status === "pending") return { kind: "pending", code: code === "credit_pending" ? "credit_pending" : "payment_processing" };
  if (reply.status === "checkout") return { kind: "checkout", code, message: message ?? DECLINED[code] ?? DECLINED.payment_failed };
  const changed = code === "card_changed" ? savedCardFrom(reply.card) : null;
  if (changed) return { kind: "card_changed", card: changed };
  if (code === "bops_credit_off") return { kind: "off" };
  // A 5xx with no code is a server falling over mid-request: whether Stripe was reached isn't known.
  const maybeCharged = MAYBE_CHARGED.has(code) || (httpStatus >= 500 && !code);
  const sameKey = maybeCharged || RETRY_SAFE.has(code) || code === "card_changed";
  return { kind: "error", message: message ?? (maybeCharged ? UNCONFIRMED_TRY_AGAIN : "Couldn't add credit. Try again."), sameKey, maybeCharged };
}

/** The request itself failed (offline, the window's server went away): it may have charged. */
export const TOPUP_UNREACHABLE: TopUpNext = { kind: "error", message: "Couldn't reach Orgo. Try again: you won't be charged twice.", sameKey: true, maybeCharged: true };

/** A purchase on the card on file, from Add credit until a definite answer. */
export type CardPurchase = {
  cents: number;
  /** Its Idempotency-Key: one per purchase, sent again on each retry of it. */
  key: string;
  /** When the key was made (ms). */
  startedAt: number;
  /** The card the confirm names; its handle goes with the purchase. */
  card: SavedCard;
  /** Why the card couldn't do it. Nothing was charged; Checkout is next. */
  fallback: string | null;
  /** The last answer's problem. */
  error: string | null;
  /** Something to know before confirming (the card changed). */
  notice: string | null;
  /**
   * An answer under this key never came back, so the card may have been charged. Until a definite answer
   * the purchase keeps its key, outlives Cancel (and the sheet closing), is what Add credit opens again,
   * and Checkout isn't offered: it would be a second payment.
   */
  unresolved: boolean;
};

/** How long an unresolved purchase is tried again under its key: Orgo keeps its answers a day, Stripe its keys about as long. */
export const PURCHASE_KEY_REUSE_MS = 12 * 3_600_000;

/** One purchase's Idempotency-Key. */
export function newPurchaseKey(): string {
  const c = globalThis.crypto;
  if (typeof c.randomUUID === "function") return c.randomUUID();
  return Array.from(c.getRandomValues(new Uint8Array(16)), (b) => b.toString(16).padStart(2, "0")).join("");
}

export function newPurchase(cents: number, card: SavedCard, now: number = Date.now()): CardPurchase {
  return { cents, key: newPurchaseKey(), startedAt: now, card, fallback: null, error: null, notice: null, unresolved: false };
}

const CARD_CHANGED = "Your card on file changed.";
const unconfirmed = (cents: number) => `Your ${dollars(cents)} payment wasn't confirmed. Check your balance before adding more.`;

/** A purchase on its way to Orgo, as it's kept meanwhile: it may charge, so it's tried again under its key, never started over. */
export const beingSent = (p: CardPurchase): CardPurchase => ({ ...p, unresolved: true, error: UNCONFIRMED_TRY_AGAIN, notice: null });

/** What a purchase becomes after an answer. */
export type PurchaseStep =
  /** Still open: show the confirm with this purchase. */
  | { kind: "open"; purchase: CardPurchase }
  /** Paid and credited. */
  | { kind: "credited" }
  /** Paid or paying; the credit is on its way. */
  | { kind: "pending"; pending: PendingTopUp }
  /** Orgo doesn't sell AI credit yet; nothing was charged. */
  | { kind: "off" }
  /** Over, with nothing charged that the sheet can show. Say this and start over. */
  | { kind: "stop"; message: string };

export function afterAnswer(purchase: CardPurchase, next: TopUpNext): PurchaseStep {
  switch (next.kind) {
    case "credited":
      return { kind: "credited" };
    case "pending":
      return { kind: "pending", pending: { cents: purchase.cents, code: next.code } };
    case "checkout":
      // no_card is Orgo's own look at the account, before Stripe: it says nothing about an earlier try
      // under this key that may have charged. Stripe's refusals answer for the key, earlier tries
      // included, so after one the purchase is settled: nothing was charged.
      if (purchase.unresolved && next.code === "no_card") return { kind: "stop", message: unconfirmed(purchase.cents) };
      return { kind: "open", purchase: { ...purchase, fallback: next.message, error: null, notice: null, unresolved: false } };
    case "card_changed":
      // Same key: if an earlier try charged the other card, Stripe refuses this one rather than charge twice.
      return { kind: "open", purchase: { ...purchase, card: next.card, error: null, notice: CARD_CHANGED } };
    case "off":
      // Turned away before Orgo looks at the key: an earlier try under it may still have charged.
      return purchase.unresolved ? { kind: "stop", message: unconfirmed(purchase.cents) } : { kind: "off" };
    case "error":
      if (!next.sameKey) return { kind: "stop", message: next.message };
      return { kind: "open", purchase: { ...purchase, error: next.message, notice: null, unresolved: purchase.unresolved || next.maybeCharged } };
  }
}

/** Cancel: an unresolved purchase is kept for Add credit to open again. */
export function afterCancel(purchase: CardPurchase | null): CardPurchase | null {
  return purchase?.unresolved ? purchase : null;
}

/** Add credit, with a purchase kept from before: open it again, or, once its key is too old to try again safely, stop and say so. */
export function resumePurchase(purchase: CardPurchase, now: number = Date.now()): PurchaseStep {
  if (now - purchase.startedAt > PURCHASE_KEY_REUSE_MS) return { kind: "stop", message: unconfirmed(purchase.cents) };
  return { kind: "open", purchase };
}

/** The confirm read the card on file again: name the one the purchase will charge. */
export function cardRechecked(purchase: CardPurchase, card: SavedCard | null): CardPurchase {
  if (purchase.fallback !== null) return purchase;
  // No card now. Unresolved, the next try's answer decides; else Checkout.
  if (!card) return purchase.unresolved ? purchase : { ...purchase, fallback: DECLINED.no_card, error: null, notice: null };
  if (card.handle === purchase.card.handle) return purchase;
  // The change is what to see now; the key is kept, so an unresolved purchase still can't charge twice.
  return { ...purchase, card, error: null, notice: CARD_CHANGED };
}

/** A sentence, ending in a full stop. */
const sentence = (text: string) => (/[.!?]$/.test(text.trim()) ? text.trim() : `${text.trim()}.`);

/** The confirm: pay with the card, or, once the card couldn't, in the browser. */
export function confirmCopy(purchase: CardPurchase): {
  title: string;
  line: string;
  /** Said in red under the line. */
  error: string | null;
  confirmLabel: string;
  /** Offer "Pay another way" (Checkout) beside paying with the card. */
  otherWay: boolean;
} {
  const title = `Add ${dollars(purchase.cents)} of AI credit?`;
  if (purchase.fallback !== null) return { title, line: `${sentence(purchase.fallback)} Nothing was charged.`, error: null, confirmLabel: "Pay in browser", otherWay: false };
  const charged = `Charged once to ${cardName(purchase.card)}.`;
  return {
    title,
    line: purchase.notice ? `${purchase.notice} ${charged}` : charged,
    error: purchase.error,
    confirmLabel: purchase.error ? "Try again" : `Pay ${dollars(purchase.cents)}`,
    otherWay: !purchase.unresolved,
  };
}

/* ---------------- After paying ---------------- */

/** How long the sheet reads the plan again after a purchase, until the new credit shows. */
export const POLL_FOR_MS = 2 * 60_000;

/** The wait before the plan's next read: soon at first, then every 5 seconds. */
export const pollDelay = (reads: number) => Math.min(5000, 1500 + 1000 * reads);

/** The balance shows credit added since `from`, the balance when the purchase started: only added credit raises it. */
export const creditLanded = (from: number | undefined, left: number | undefined) => typeof from === "number" && typeof left === "number" && left > from;
