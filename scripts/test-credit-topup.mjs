// Tests for adding AI credit once from the account sheet: the route the window calls
// (app/api/account/credit/route.ts) against a fake orgo-web (its /api/bops/credit routes), and the steps the
// sheet takes with each answer (lib/credit-topup.ts, the same as orgo-web's lib/credit-reload.ts). Hidden when
// Orgo doesn't sell credit yet (404, 503 bops_credit_off); on the card: 200 added, 202 processing, 402 on to
// Checkout, 409 card changed, an answer that never came tried again under the same Idempotency-Key; Checkout
// without a card; amounts checked here too; and nothing secret in the logs. Orgo is a fake fetch on a made-up
// origin and the state a throwaway file store in a temporary folder: nothing reaches Orgo or Stripe.
// Usage: node --conditions=react-server scripts/test-credit-topup.mjs
import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { registerHooks } from "node:module";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { pathToFileURL } from "node:url";

// A file store, loaded at once and always ready (lib/server/persist.ts); the Mac app's ways (Bops Cloud's AI
// credit, cloud.ts cloudOn) once it's loaded, below.
process.env.BOPS_SELF_HOSTED = "1";
for (const k of ["ORGO_API_KEY", "BOPS_ORGO_WORKSPACE", "BOPS_ORGO_TEMPLATE", "BOPS_DATABASE_URL", "AGENTMAIL_API_KEY", "BOPS_MAIL_DOMAIN", "OPENAI_API_KEY", "TAILSCALE_AUTH_KEY"]) delete process.env[k];
process.env.BOPS_ORGO_ORIGIN = "https://orgo.test";
const root = new URL("..", import.meta.url).pathname.replace(/\/$/, "");
// Modules that would start processes when loaded are stand-ins whose exports do nothing (as in test-plan.mjs).
const STAND_INS = new Set(["mac", "relay", "desktop", "mirror"]);
registerHooks({
  resolve(specifier, context, next) {
    if (specifier.startsWith("@/")) specifier = pathToFileURL(`${root}/${specifier.slice(2)}`).href;
    try {
      return next(specifier, context);
    } catch (e) {
      if (/^(\.{1,2}\/|\/|file:)/.test(specifier))
        for (const ext of [".ts", ".tsx"])
          try {
            return next(specifier + ext, context);
          } catch {}
      throw e;
    }
  },
  load(url, context, next) {
    const name = url.match(/\/lib\/server\/([a-z-]+)\.ts$/)?.[1];
    if (!name || !STAND_INS.has(name)) return next(url, context);
    const names = [...readFileSync(new URL(url), "utf8").matchAll(/^export (?:async )?(?:function\*? |const |let |class )([A-Za-z_$][\w$]*)/gm)].map((m) => m[1]);
    return { format: "module", shortCircuit: true, source: names.map((n) => `export const ${n} = function () { return Promise.resolve(); };`).join("\n") };
  },
});
const scratch = mkdtempSync(join(tmpdir(), "bops-test-credit-"));
process.chdir(scratch);
const KEY = "sk_test_credit_key_0123456789";
globalThis.bopsOrgoKey = KEY;

/* ---------------- A fake orgo-web, and the logs ---------------- */

const calls = [];
/** orgo-web's answers by "METHOD /path"; anything else is a 404, like an orgo-web without top-ups. */
let replies = {};
globalThis.fetch = async (input, init = {}) => {
  const req = new Request(input, init);
  const url = new URL(req.url);
  if (url.origin !== "https://orgo.test") throw new TypeError(`fetch failed (not the fake Orgo: ${url})`);
  const call = { method: req.method, path: url.pathname, headers: Object.fromEntries(req.headers), body: req.body ? JSON.parse(await req.text()) : undefined };
  calls.push(call);
  const reply = replies[`${call.method} ${call.path}`];
  return (reply && (await reply(call))) ?? json(404, { error: "Not found" });
};
const json = (status, obj) => new Response(JSON.stringify(obj), { status, headers: { "content-type": "application/json" } });
const offline = () => {
  throw new TypeError("fetch failed");
};
/** Everything logged, to check nothing secret is; the route's own "[credit]" lines are expected here, so not shown. */
const logged = [];
for (const level of ["log", "info", "warn", "error"]) {
  const real = console[level].bind(console);
  console[level] = (...args) => {
    const line = args.map(String).join(" ");
    logged.push(line);
    if (!line.startsWith("[credit]")) real(...args);
  };
}

const C = await import(`${root}/lib/credit-topup.ts`);
const R = await import(`${root}/app/api/account/credit/route.ts`);
const L = await import(`${root}/lib/server/plan.ts`);
// Loaded: now it's the Mac app, whose AI credit is Bops Cloud's.
delete process.env.BOPS_SELF_HOSTED;

const noDashes = (text) => assert.ok(!/[–—]/.test(text), `no dashes: ${text}`);
const get = async () => {
  const res = await R.GET();
  return { status: res.status, body: await res.json() };
};
const post = async (body) => {
  const res = await R.POST(new Request("http://localhost:3210/api/account/credit", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(body) }));
  return { status: res.status, body: await res.json() };
};
const HANDLE = "hAnDlE_0123456789abcdefghijklmnopqrstuvwxyz".slice(0, 43);
const HANDLE2 = "OtHeRcArD_0123456789abcdefghijklmnopqrstuvw".slice(0, 43);
const VISA = { handle: HANDLE, brand: "visa", last4: "4242", exp_month: 12, exp_year: 2030 };
const MASTERCARD = { handle: HANDLE2, brand: "mastercard", last4: "4444", exp_month: 1, exp_year: 2031 };
const IDEM = "6f1d2c3b-aaaa-4bbb-8ccc-0123456789ab";
let n;

/* ---------------- Amounts ---------------- */

for (const ok of [2000, 5000, 10000, 500, 100000, 12300]) assert.equal(C.isTopUpAmount(ok), true, `${ok} sells`);
for (const no of [0, 400, 499, 2050, 100100, 2000.5, "2000", NaN, null, undefined, -500]) assert.equal(C.isTopUpAmount(no), false, `${no} doesn't`);
assert.deepEqual([...C.TOPUP_PRESETS], [2000, 5000, 10000]);
assert.deepEqual(["50", "5", "1000", "4", "1001", "", "12a"].map(C.typedCents), [5000, 500, 100000, null, null, null, null]);
assert.deepEqual(["$1,000", "0050", "12345", "abc"].map(C.tidyDollars), ["1000", "50", "1234", ""]);
assert.deepEqual([500, 5000, 100000].map(C.dollars), ["$5", "$50", "$1,000"]);
assert.equal(C.cardName(VISA), "Visa ending 4242");
assert.equal(C.cardName({ brand: "something_new", last4: "1111" }), "Card ending 1111");

/* ---------------- Hidden when Orgo doesn't sell credit yet ---------------- */

// An orgo-web before top-ups (no such route): off, so the sheet shows no way to add credit.
replies = {};
let r = await get();
assert.deepEqual(r, { status: 200, body: { off: true } });
assert.deepEqual(C.topUpFrom(r.status, r.body), { off: true });
assert.equal(calls.at(-1).path, "/api/bops/credit/card-on-file");
assert.equal(calls.at(-1).headers.authorization, `Bearer ${KEY}`, "asked with the user's own key");
// One that says so (a database without the top-ups migration).
replies = { "GET /api/bops/credit/card-on-file": () => json(503, { code: "bops_credit_off", error: "Buying Bops AI credit isn't available yet." }) };
r = await get();
assert.deepEqual(r, { status: 200, body: { off: true } });
assert.equal(C.topUpFrom(r.status, r.body).off, true);
// Self-hosted: no Bops Cloud credit to add to, and Orgo isn't asked.
process.env.BOPS_SELF_HOSTED = "1";
n = calls.length;
assert.deepEqual(await get(), { status: 200, body: { off: true } });
assert.equal((await post({ amount_cents: 5000 })).body.code, "bops_credit_off");
assert.equal(calls.length, n, "self-hosted: nothing asked of Orgo");
delete process.env.BOPS_SELF_HOSTED;

/* ---------------- The card on file ---------------- */

replies = {
  "GET /api/bops/credit/card-on-file": () =>
    json(200, { card: { ...VISA, payment_method: "pm_secret" }, pending: [{ amount_cents: 2000, code: "payment_processing", payment_intent: "pi_x" }, { amount_cents: -5, code: "x" }] }),
};
r = await get();
assert.deepEqual(r, { status: 200, body: { card: VISA, pending: [{ amount_cents: 2000, code: "payment_processing" }] } }, "only the card's public fields and well-formed pending ones");
let info = C.topUpFrom(r.status, r.body);
assert.deepEqual(info, { off: false, card: VISA, pending: [{ cents: 2000, code: "payment_processing" }], unknown: false });
assert.equal(C.pendingNote(info.pending), "Your $20 payment is processing. The credit is added when it clears.");
// No card: Add credit goes to Checkout.
replies = { "GET /api/bops/credit/card-on-file": () => json(200, { card: null, pending: null }) };
info = C.topUpFrom(...Object.values(await get()));
assert.deepEqual(info, { off: false, card: null, pending: null, unknown: false });
// Orgo couldn't look: the row stays (the card is asked about again on Add credit), and what was known is kept.
replies = { "GET /api/bops/credit/card-on-file": () => json(502, { code: "card_unavailable", error: "Couldn't check the card on file." }) };
r = await get();
assert.deepEqual(r, { status: 502, body: { error: "Couldn't check the card on file." } });
assert.deepEqual(C.topUpFrom(r.status, r.body), { off: false, card: null, pending: null, unknown: true });
const known = { off: false, card: VISA, pending: [{ cents: 2000, code: "credit_pending" }], unknown: false };
assert.deepEqual(C.mergeTopUp(known, C.topUpFrom(r.status, r.body)), known, "a failed read keeps the card shown");
assert.deepEqual(C.mergeTopUp(known, { off: false, card: MASTERCARD, pending: null, unknown: false }).pending, known.pending, "pending unknown: kept");
replies = { "GET /api/bops/credit/card-on-file": offline };
assert.equal((await get()).status, 502);
replies = { "GET /api/bops/credit/card-on-file": () => json(401, { error: "Invalid API key" }) };
assert.deepEqual(await get(), { status: 401, body: { error: "Orgo didn't accept this Mac's sign-in. Sign out, then sign in again." } });

/* ---------------- Amounts are checked here too ---------------- */

n = calls.length;
for (const body of [{}, { amount_cents: 0 }, { amount_cents: 499 }, { amount_cents: 2050 }, { amount_cents: 100100 }, { amount_cents: "5000" }, { amount_cents: 50.5 }]) {
  r = await post(body);
  assert.deepEqual(r, { status: 400, body: { error: C.TOPUP_AMOUNT_RULE, code: "invalid_amount" } }, JSON.stringify(body));
}
r = await R.POST(new Request("http://localhost:3210/api/account/credit", { method: "POST", body: "not json" }));
assert.equal(r.status, 400);
// On the card: its handle and the purchase's own Idempotency-Key are needed.
assert.deepEqual(await post({ amount_cents: 5000, card_handle: HANDLE }), { status: 400, body: { error: "Send an idempotency_key, one per purchase.", code: "idempotency_key_required" } });
assert.equal((await post({ amount_cents: 5000, card_handle: HANDLE, idempotency_key: "short" })).body.code, "idempotency_key_required");
assert.equal((await post({ amount_cents: 5000, card_handle: "no", idempotency_key: IDEM })).body.code, "card_handle_required");
assert.equal((await post({ amount_cents: 5000, card_handle: 42, idempotency_key: IDEM })).body.code, "card_handle_required");
assert.equal(calls.length, n, "nothing asked of Orgo for a purchase that isn't one");

/* ---------------- On the card ---------------- */

/** orgo-web's card-on-file POST: `answer(call)` decides; every call is kept. */
const charges = [];
const onCard = (answer) => (replies = { "POST /api/bops/credit/card-on-file": (c) => (charges.push(c), answer(c)) });
const buy = (cents, card = VISA, key = IDEM) => post({ amount_cents: cents, card_handle: card.handle, idempotency_key: key });

// 200: paid and added. The charge goes with the purchase's key as the Idempotency-Key header, and only
// the amount and the card's handle in the body.
onCard(() => json(200, { status: "succeeded", amount_cents: 5000 }));
r = await buy(5000);
assert.deepEqual(r, { status: 200, body: { status: "succeeded", amount_cents: 5000 } });
let c = charges.at(-1);
assert.equal(c.headers["idempotency-key"], IDEM, "the Idempotency-Key passed through");
assert.equal(c.headers.authorization, `Bearer ${KEY}`);
assert.deepEqual(c.body, { amount_cents: 5000, card_handle: HANDLE });
let purchase = C.newPurchase(5000, VISA);
assert.match(purchase.key, /^[\x21-\x7e]{8,255}$/, "a key Orgo takes");
assert.notEqual(C.newPurchase(5000, VISA).key, purchase.key, "one key per purchase");
// The sheet's purchase is the one sent above: its key is IDEM.
purchase = { ...purchase, key: IDEM };
assert.deepEqual(C.confirmCopy(purchase), { title: "Add $50 of AI credit?", line: "Charged once to Visa ending 4242.", error: null, confirmLabel: "Pay $50", otherWay: true });
assert.deepEqual(C.afterAnswer(purchase, C.topUpNext(r.status, r.body)), { kind: "credited" });

// 202: paid or paying, the credit on its way.
onCard(() => json(202, { status: "pending", code: "payment_processing", amount_cents: 2000 }));
r = await buy(2000);
assert.deepEqual(r, { status: 202, body: { status: "pending", code: "payment_processing", amount_cents: 2000 } });
assert.deepEqual(C.afterAnswer(C.newPurchase(2000, VISA), C.topUpNext(r.status, r.body)), { kind: "pending", pending: { cents: 2000, code: "payment_processing" } });
onCard(() => json(202, { status: "pending", code: "credit_pending", amount_cents: 2000 }));
r = await buy(2000);
assert.deepEqual(C.topUpNext(r.status, r.body), { kind: "pending", code: "credit_pending" });
assert.equal(C.pendingNote([{ cents: 2000, code: "credit_pending" }]), "Your $20 payment went through. The credit is added shortly.");

// 402: declined, nothing charged. The confirm turns into the way to Checkout, for the same amount.
onCard(() => json(402, { status: "checkout", code: "card_declined", error: "Your card was declined." }));
r = await buy(5000);
assert.deepEqual(r, { status: 402, body: { status: "checkout", code: "card_declined", error: "Your card was declined." } });
let step = C.afterAnswer(purchase, C.topUpNext(r.status, r.body));
assert.equal(step.kind, "open");
assert.deepEqual(C.confirmCopy(step.purchase), { title: "Add $50 of AI credit?", line: "Your card was declined. Nothing was charged.", error: null, confirmLabel: "Pay in browser", otherWay: false });
// No words from Orgo: the sheet's own, by the code.
assert.equal(C.topUpNext(402, { status: "checkout", code: "authentication_required" }).message, "Your bank wants to confirm this payment.");
// ...then Checkout: a page for the browser, asked with only the amount (it returns to Orgo's own page).
replies = { "POST /api/bops/credit/checkout": () => json(200, { url: "https://checkout.stripe.com/c/pay/cs_test_1" }) };
r = await post({ amount_cents: 5000 });
assert.deepEqual(r, { status: 200, body: { url: "https://checkout.stripe.com/c/pay/cs_test_1" } });
assert.deepEqual([calls.at(-1).method, calls.at(-1).path, calls.at(-1).body, calls.at(-1).headers["idempotency-key"]], ["POST", "/api/bops/credit/checkout", { amount_cents: 5000 }, undefined]);

// 409 card_changed: the new card is shown and asked about again, under the same key; nothing was charged.
onCard(() => json(409, { code: "card_changed", error: "The card on file changed. Nothing was charged. Confirm the purchase with this card.", card: { ...MASTERCARD, payment_method: "pm_x" } }));
r = await buy(5000);
assert.deepEqual(r.body.card, MASTERCARD, "only the new card's public fields");
step = C.afterAnswer(purchase, C.topUpNext(r.status, r.body));
assert.equal(step.kind, "open");
assert.equal(step.purchase.key, purchase.key, "the same key");
assert.deepEqual(step.purchase.card, MASTERCARD);
assert.equal(C.confirmCopy(step.purchase).line, "Your card on file changed. Charged once to Mastercard ending 4444.");
assert.equal(C.confirmCopy(step.purchase).confirmLabel, "Pay $50");
onCard(() => json(200, { status: "succeeded", amount_cents: 5000 }));
await buy(5000, step.purchase.card, step.purchase.key);
assert.deepEqual([charges.at(-1).body.card_handle, charges.at(-1).headers["idempotency-key"]], [HANDLE2, IDEM], "asked again with the new card, the same key");

// An answer that never came: tried again under the same key (Orgo answers with the first result), never
// as a new purchase, and no Checkout meanwhile (it would be a second payment). Cancel keeps it.
onCard(offline);
r = await buy(5000);
assert.deepEqual(r, { status: 502, body: { code: "orgo_unreachable", error: "Couldn't reach Orgo. Try again: you won't be charged twice." } });
step = C.afterAnswer(purchase, C.topUpNext(r.status, r.body));
assert.equal(step.kind, "open");
assert.equal(step.purchase.unresolved, true);
assert.deepEqual(C.confirmCopy(step.purchase), { title: "Add $50 of AI credit?", line: "Charged once to Visa ending 4242.", error: "Couldn't reach Orgo. Try again: you won't be charged twice.", confirmLabel: "Try again", otherWay: false });
assert.equal(C.afterCancel(step.purchase), step.purchase, "kept through Cancel");
assert.equal(C.afterCancel(purchase), null, "a settled one isn't");
assert.equal(C.resumePurchase(step.purchase, step.purchase.startedAt + 60_000).kind, "open");
assert.equal(C.resumePurchase(step.purchase, step.purchase.startedAt + 13 * 3_600_000).kind, "stop", "too old to try again safely");
const kept = step.purchase;
onCard((c) => json(200, { status: "succeeded", amount_cents: c.body.amount_cents }));
r = await buy(kept.cents, kept.card, kept.key);
assert.equal(charges.at(-1).headers["idempotency-key"], IDEM, "the retry sends the same key");
assert.deepEqual(C.afterAnswer(kept, C.topUpNext(r.status, r.body)), { kind: "credited" });
// The window's own request lost: the same.
assert.equal(C.afterAnswer(purchase, C.TOPUP_UNREACHABLE).purchase.unresolved, true);
assert.equal(C.beingSent(purchase).unresolved, true, "kept as unconfirmed while it's out");
// Unresolved, then no card at all: that says nothing of the earlier try, so it stops and says to check.
assert.deepEqual(C.afterAnswer(kept, C.topUpNext(402, { status: "checkout", code: "no_card" })), { kind: "stop", message: "Your $50 payment wasn't confirmed. Check your balance before adding more." });

// Orgo's other answers, passed through with their codes, and what the sheet does with each.
for (const [status, body, kind, extra] of [
  [502, { code: "payment_unconfirmed", error: "Couldn't confirm the payment. Try again: you won't be charged twice." }, "open", { unresolved: true }],
  [409, { code: "idempotency_in_progress", error: "This payment is still going through. Try again in a few seconds." }, "open", { unresolved: true }],
  [429, { code: "rate_limited", error: "Too many requests. Try again shortly." }, "open", { unresolved: false }],
  [502, { code: "card_unavailable", error: "Couldn't check the card on file. Nothing was charged. Try again shortly." }, "open", { unresolved: false }],
  [500, {}, "open", { unresolved: true }],
  [409, { code: "idempotency_unfinished", error: "This payment didn't finish. Check your balance before buying again." }, "stop"],
  [422, { code: "idempotency_key_reused", error: "This Idempotency-Key was already used for a different purchase." }, "stop"],
  [400, { code: "invalid_amount", error: "Choose $20, $50, $100, or any whole-dollar amount from $5 to $1,000." }, "stop"],
]) {
  onCard(() => json(status, body));
  r = await buy(5000);
  assert.equal(r.status, status, JSON.stringify(body));
  assert.deepEqual(r.body, body);
  step = C.afterAnswer(purchase, C.topUpNext(r.status, r.body));
  assert.equal(step.kind, kind, JSON.stringify(body));
  if (extra) assert.equal(step.purchase.unresolved, extra.unresolved, JSON.stringify(body));
  if (kind === "open") assert.equal(step.purchase.key, purchase.key);
}
// Orgo stopped selling credit meanwhile, or never had the route: off, nothing charged.
onCard(() => json(503, { code: "bops_credit_off", error: "Buying Bops AI credit isn't available yet." }));
r = await buy(5000);
assert.deepEqual(C.afterAnswer(purchase, C.topUpNext(r.status, r.body)), { kind: "off" });
replies = {};
r = await buy(5000);
assert.deepEqual(r, { status: 503, body: { error: "Adding credit opens soon.", code: "bops_credit_off" } });
// Orgo turned the key down: over, in plain words.
onCard(() => json(401, { error: "Invalid API key" }));
r = await buy(5000);
assert.deepEqual(r, { status: 401, body: { error: "Orgo didn't accept this Mac's sign-in. Sign out, then sign in again.", code: "signed_out" } });
assert.equal(C.afterAnswer(purchase, C.topUpNext(r.status, r.body)).kind, "stop");

// The confirm reads the card again as it opens: a new card is named, none means Checkout.
assert.equal(C.cardRechecked(purchase, VISA), purchase);
assert.equal(C.cardRechecked(purchase, MASTERCARD).notice, "Your card on file changed.");
assert.equal(C.cardRechecked(purchase, null).fallback, "There's no card on file.");
assert.equal(C.cardRechecked(kept, null), kept, "unresolved: the next answer decides");

/* ---------------- Checkout ---------------- */

for (const [status, body, want] of [
  [503, { code: "bops_credit_off", error: "x" }, { status: 503, body: { error: "Adding credit opens soon.", code: "bops_credit_off" } }],
  [404, { error: "Not found" }, { status: 503, body: { error: "Adding credit opens soon.", code: "bops_credit_off" } }],
  [400, { code: "invalid_amount", error: "Choose $20, $50, $100, or any whole-dollar amount from $5 to $1,000." }, { status: 400, body: { code: "invalid_amount", error: "Choose $20, $50, $100, or any whole-dollar amount from $5 to $1,000." } }],
  [502, { code: "checkout_unavailable", error: "Checkout could not be opened." }, { status: 502, body: { code: "checkout_unavailable", error: "Checkout could not be opened." } }],
  [200, { url: "http://not-https.example" }, { status: 502, body: { error: "Orgo couldn't open checkout (200). Try again in a minute." } }],
]) {
  replies = { "POST /api/bops/credit/checkout": () => json(status, body) };
  assert.deepEqual(await post({ amount_cents: 2000 }), want, JSON.stringify(body));
}
replies = { "POST /api/bops/credit/checkout": offline };
assert.deepEqual(await post({ amount_cents: 2000 }), { status: 502, body: { error: "Couldn't reach Orgo. Check your internet connection and try again.", code: "orgo_unreachable" } });
// A custom amount goes as typed, in cents.
replies = { "POST /api/bops/credit/checkout": () => json(200, { url: "https://checkout.stripe.com/c/pay/cs_test_2" }) };
await post({ amount_cents: C.typedCents("75") });
assert.deepEqual(calls.at(-1).body, { amount_cents: 7500 });

/* ---------------- After paying ---------------- */

assert.equal(C.creditLanded(3_000_000, 3_000_000), false);
assert.equal(C.creditLanded(3_000_000, 52_900_000), true, "added, less what bots spent meanwhile");
assert.equal(C.creditLanded(-25_000, 19_975_000), true, "an overrun paid back");
assert.equal(C.creditLanded(undefined, 10), false, "no balance known: the poll runs its 2 minutes");
assert.equal(C.POLL_FOR_MS, 120_000);
assert.ok([0, 1, 2, 3, 10].map(C.pollDelay).every((d, i, a) => d <= 5000 && (i === 0 || d >= a[i - 1])), "soon at first, then every 5 seconds");

// The balance's words once credit was added: it's in the credit that never expires, with the one-time $5.
replies = {
  "GET /api/bops/plan": () =>
    json(200, { tier: "pro_bops", credit: { left_micros: 70_000_000, plan_left_micros: 20_000_000, free_left_micros: 50_000_000 }, grants: [{ kind: "plan" }, { kind: "topup" }] }),
};
assert.equal((await L.readBopsPlan(KEY)).credit.topUps, true);
replies = { "GET /api/bops/plan": () => json(200, { tier: "pro_bops", credit: { left_micros: 20_000_000, plan_left_micros: 20_000_000, free_left_micros: 0 }, grants: [{ kind: "plan" }] }) };
assert.equal((await L.readBopsPlan(KEY)).credit.topUps, undefined);

/* ---------------- Free's computer: its hours this month, and saying when it's in use ---------------- */

// Read as Orgo says it (orgo-web lib/bops-free-hours.ts); not at all when it says nothing or not all of it (Pro, Max, an older Orgo).
replies = {
  "GET /api/bops/plan": () =>
    json(200, { tier: "free_bops", credit: { left_micros: 1_000_000, plan_left_micros: 0, free_left_micros: 1_000_000 }, computer_time: { used_seconds: 7200, limit_seconds: 36000, resets_at: "2026-11-01T00:00:00.000Z" } }),
};
const time = { usedSeconds: 7200, limitSeconds: 36000, resetsAt: Date.parse("2026-11-01T00:00:00.000Z") };
assert.deepEqual((await L.readBopsPlan(KEY)).computerTime, time);
for (const t of [null, undefined, { used_seconds: 1 }, { used_seconds: 1, limit_seconds: 36000, resets_at: "soon" }]) {
  replies = { "GET /api/bops/plan": () => json(200, { tier: "pro_bops", credit: { left_micros: 1, plan_left_micros: 1, free_left_micros: 0 }, computer_time: t }) };
  assert.equal((await L.readBopsPlan(KEY)).computerTime, undefined, JSON.stringify(t));
}
// The account sheet's words for it: 10 hours a month, used of them, and the day they start over as Orgo names it
// (the UTC day, Nov 1, in any time zone: west of UTC the hours are back the evening before).
const PI = await import(`${root}/lib/plan-includes.ts`);
assert.deepEqual(PI.freeHoursWords(time), {
  note: "Free includes 10 hours a month on your Bops computer. It sleeps when nothing's using it, so only the time it works counts. Your hours start over Nov 1.",
  amount: "2 of 10 hours used",
  label: "Computer time this month",
});
assert.equal(PI.freeHoursWords({ ...time, usedSeconds: 9000 }).amount, "2.5 of 10 hours used");
assert.equal(PI.freeHoursWords({ ...time, usedSeconds: 0 }).amount, "0 of 10 hours used");
// The figure is rounded down: it reads all used only once they are, with the words that say so.
for (const usedSeconds of [35_821, 35_999]) {
  const w = PI.freeHoursWords({ ...time, usedSeconds });
  assert.equal(w.amount, "9.9 of 10 hours used", String(usedSeconds));
  assert.match(w.note, /^Free includes 10 hours a month/);
}
const allUsed = { ...time, usedSeconds: 36_060 };
assert.deepEqual(PI.freeHoursWords(allUsed), {
  note: "Your Bops computer has used its 10 hours this month. It's back Nov 1, or upgrade to Pro to keep it on.",
  amount: "10 of 10 hours used",
  label: "Computer time this month",
});
assert.equal(PI.freeHoursWords({ ...time, usedSeconds: 36_000 }).note, PI.freeHoursWords(allUsed).note);
assert.equal(PI.freeHoursOutLine(allUsed), PI.freeHoursWords(allUsed).note);
assert.equal(PI.freeHoursWords({ ...time, resetsAt: Date.parse("2027-01-01T00:00:00.000Z") }).label, "Computer time this month", "December's start over on Jan 1");
// From an Orgo that still counts by the week (its hours start over on a Monday, Oct 12), the words name no period:
// never "a month" for hours that are a week's.
replies = {
  "GET /api/bops/plan": () =>
    json(200, { tier: "free_bops", credit: { left_micros: 1_000_000, plan_left_micros: 0, free_left_micros: 1_000_000 }, computer_time: { used_seconds: 7200, limit_seconds: 36000, resets_at: "2026-10-12T00:00:00.000Z" } }),
};
const weekly = (await L.readBopsPlan(KEY)).computerTime;
assert.deepEqual(weekly, { ...time, resetsAt: Date.parse("2026-10-12T00:00:00.000Z") });
assert.deepEqual(PI.freeHoursWords(weekly), {
  note: "Your Bops computer sleeps when nothing's using it, so only the time it works counts. Your hours start over Oct 12.",
  amount: "2 of 10 hours used",
  label: "Computer time",
});
const weeklyUsed = { ...weekly, usedSeconds: 36_000 };
assert.deepEqual(PI.freeHoursWords(weeklyUsed), {
  note: "Your Bops computer has used its 10 hours. It's back Oct 12, or upgrade to Pro to keep it on.",
  amount: "10 of 10 hours used",
  label: "Computer time",
});
for (const w of [PI.freeHoursWords(weekly), PI.freeHoursWords(weeklyUsed)]) for (const text of Object.values(w)) assert.doesNotMatch(text, /month|week/i, text);
for (const w of [PI.freeHoursWords(time), PI.freeHoursWords(allUsed), PI.freeHoursWords(weekly), PI.freeHoursWords(weeklyUsed)]) for (const text of Object.values(w)) noDashes(text);
// Orgo's "10 hours used" is told apart from any other refusal, in Orgo's own words (orgo-web lib/bops-free-hours.ts
// freeHoursMessage): this month's, or this week's from an Orgo that still counts by the week.
const FH = await import(`${root}/lib/server/free-hours.ts`);
const O = await import(`${root}/lib/server/orgo.ts`);
const S = await import(`${root}/lib/server/store.ts`);
const usedUp = "Your free Bops computer has used its 10 hours this month. It's back on November 1, or upgrade to Pro to keep it on.";
const usedUpWeek = "Your free Bops computer has used its 10 hours this week. It's back Monday, Oct 12, or upgrade to Pro to keep it on.";
assert.equal(FH.freeHoursUsed(new O.OrgoError("x", 402, "bops_free_hours", usedUp)), usedUp);
for (const said of [usedUp, usedUpWeek]) assert.equal(FH.freeHoursUsed(new O.OrgoError("x", 402, undefined, said)), said, "by its words when the code didn't come");
assert.equal(FH.freeHoursUsed(new O.OrgoError("x", 402, "upgrade_required", "Your plan does not include running computers.")), undefined);
assert.equal(FH.freeHoursUsed(new O.OrgoError("x", 402, undefined, "Your plan does not include running computers.")), undefined);
assert.equal(FH.freeHoursUsed(new Error(usedUp)), undefined);
noDashes(usedUp);
// Bops says the computer is in use: once for the sign-in (Orgo then knows this app says so), then only while a task
// works on a computer in the cloud or the user drives one of its screens.
replies = { "POST /api/bops/computer/active": () => json(200, { ok: true }) };
const beats = () => calls.filter((c) => c.method === "POST" && c.path === "/api/bops/computer/active");
const b0 = beats().length;
await FH.sayInUse();
assert.equal(beats().length, b0 + 1, "once as it opens");
assert.equal(beats().at(-1).headers.authorization, `Bearer ${KEY}`);
await FH.sayInUse();
assert.equal(beats().length, b0 + 1, "nothing using it: nothing said");
S.update((s) => s.sessions.push({ id: "ses_free_hours", botId: s.bots[0].id, chatId: "chat_x", title: "t", goal: "g", status: "running", runsOn: "cloud", steps: [], replies: [], createdAt: Date.now() }));
await FH.sayInUse();
assert.equal(beats().length, b0 + 2, "a task working in the cloud");
S.update((s) => {
  s.sessions = s.sessions.filter((x) => x.id !== "ses_free_hours");
  s.sessions.push({ id: "ses_free_hours_mac", botId: s.bots[0].id, chatId: "chat_x", title: "t", goal: "g", status: "running", runsOn: "mac", steps: [], replies: [], createdAt: Date.now() });
});
await FH.sayInUse();
assert.equal(beats().length, b0 + 2, "a task on the Mac doesn't use the computer");
S.update((s) => {
  s.sessions = s.sessions.filter((x) => x.id !== "ses_free_hours_mac");
  s.takeover = { botId: s.bots[0].id, display: 100, since: Date.now() };
});
await FH.sayInUse();
assert.equal(beats().length, b0 + 3, "the user driving one of its screens");
S.update((s) => (s.takeover = undefined));

/* ---------------- The words, and the logs ---------------- */

for (const text of [
  C.TOPUP_AMOUNT_RULE,
  C.TOPUP_UNREACHABLE.message,
  ...Object.values(C.confirmCopy(purchase)).filter((v) => typeof v === "string"),
  ...Object.values(C.confirmCopy({ ...purchase, fallback: "Your card was declined." })).filter((v) => typeof v === "string"),
  C.pendingNote([{ cents: 2000, code: "payment_processing" }, { cents: 5000, code: "credit_pending" }]),
  C.pendingNote([{ cents: 2000, code: "credit_pending" }, { cents: 5000, code: "credit_pending" }]),
  C.resumePurchase(kept, kept.startedAt + 13 * 3_600_000).message,
])
  noDashes(text);
for (const line of logged) for (const secret of [KEY, IDEM, HANDLE, HANDLE2]) assert.ok(!line.includes(secret), `nothing secret in the logs: ${line}`);
assert.ok(logged.some((l) => l.includes("[credit]")), "Orgo's failures are logged, by status and code");

console.log(`all credit top-up tests passed (${calls.length} fake Orgo calls, none to the network)`);
rmSync(scratch, { recursive: true, force: true });
process.exit(0);
