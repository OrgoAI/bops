// Tests for lib/server/verify.ts (codes texted or emailed for Settings, How your bots reach you) with the
// real Twilio Verify client over a fake fetch: the request shapes, the outcomes, and the limits. Then the
// user's own email addresses on top of it (lib/server/owner-email.ts, ownerAddresses in lib/server/mail.ts),
// on a throwaway state in a temporary folder. Nothing reaches Twilio, nothing is texted or emailed.
// Usage: node --conditions=react-server scripts/test-verify.mjs
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { registerHooks } from "node:module";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { pathToFileURL } from "node:url";
// The state in a throwaway file store, as a self-hosted install keeps it (the Mac app keeps it in Bops Cloud, per user: test-profiles.mjs).
process.env.BOPS_SELF_HOSTED = "1";
for (const k of ["TWILIO_ACCOUNT_SID", "TWILIO_AUTH_TOKEN", "TWILIO_VERIFY_SERVICE_SID", "TWILIO_API_KEY_SID", "TWILIO_API_KEY_SECRET", "BOPS_VERIFY_EMAIL", "BOPS_VERIFY_COUNTRIES"]) delete process.env[k];
// The state goes to a throwaway file store, never a database, a real .data or a mail domain from the shell.
for (const k of ["BOPS_DATABASE_URL", "BOPS_OWNER_EMAILS", "BOPS_MAIL_DOMAIN", "AGENTMAIL_API_KEY"]) delete process.env[k];
const root = new URL("..", import.meta.url).pathname.replace(/\/$/, "");
// The server modules import "@/lib/…" and "./store" (no extension), the way Next resolves them.
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
});
// The file store writes to .data/ under the working folder: a temporary one, removed at the end.
const scratch = mkdtempSync(join(tmpdir(), "bops-test-verify-"));
process.chdir(scratch);
const V = await import(`${root}/lib/server/verify.ts`);

// toE164
assert.equal(V.toE164("(555) 123-4567"), "+15551234567");
assert.equal(V.toE164("1 555 123 4567"), "+15551234567");
assert.equal(V.toE164("+44 20 7946 0958"), "+442079460958");
assert.equal(V.toE164("12345"), "");

// No credentials and no stub: not set up, no call
assert.equal(V.verifyOn(), false);

// The real Twilio client over a fake fetch: checks the wire shape and error mapping.
const calls = [];
let reply = () => new Response("{}", { status: 500 });
const fakeFetch = async (url, init) => {
  calls.push({ method: init.method, url: String(url), auth: init.headers.Authorization, type: init.headers["Content-Type"], form: Object.fromEntries(new URLSearchParams(init.body)) });
  return reply(calls.at(-1));
};
process.env.TWILIO_VERIFY_SERVICE_SID = "VAtest";
process.env.TWILIO_API_KEY_SID = "SKtest";
process.env.TWILIO_API_KEY_SECRET = "secret";
const stubTwilio = () => V.setVerifyApiForTests(V.twilioVerifyApi(fakeFetch));
stubTwilio();

const json = (status, obj, headers = {}) => new Response(JSON.stringify(obj), { status, headers: { "content-type": "application/json", ...headers } });
const verification = (over = {}) => ({ sid: "VE1", status: "pending", to: "+15551234567", channel: "sms", valid: false, ...over });
const err = (status, code, headers = {}) => json(status, { code, message: "x", more_info: "x", status }, headers);

const N = "+15551234567";
const t0 = 1_000_000_000_000;

// check before any send
let r = await V.checkVerification("sms", N, "i:a", "123456", t0);
assert.equal(r.ok, false); assert.equal(r.restart, true); assert.equal(calls.length, 0);

// start: shape of the create request
reply = () => json(201, verification());
r = await V.startVerification("sms", N, "i:a", 111, t0);
assert.equal(r.ok, true, JSON.stringify(r));
const c0 = calls.at(-1);
assert.equal(c0.method, "POST");
assert.equal(c0.url, "https://verify.twilio.com/v2/Services/VAtest/Verifications");
assert.equal(c0.auth, `Basic ${Buffer.from("SKtest:secret").toString("base64")}`);
assert.equal(c0.type, "application/x-www-form-urlencoded");
assert.deepEqual(c0.form, { To: N, Channel: "sms" });
console.log("create ->", c0.url);
assert.deepEqual(V.pendingVerifications("sms", "i:a", t0).map((p) => p.recipient), [N]);
assert.deepEqual(V.pendingVerifications("sms", "i:b", t0), [], "another install doesn't see it");
assert.equal(V.pendingConsentAt(N, "i:a"), 111);

// resend within 30s refused locally (no call)
const before = calls.length;
r = await V.startVerification("sms", N, "i:a", 111, t0 + 10_000);
assert.equal(r.ok, false); assert.ok(r.retryInSec > 0 && r.retryInSec <= 20); assert.equal(calls.length, before);

// wrong code: the verification stays pending
reply = () => json(200, verification({ status: "pending", valid: false }));
r = await V.checkVerification("sms", N, "i:a", "000000", t0 + 20_000);
assert.equal(r.ok, false); assert.match(r.error, /isn't right/); assert.equal(r.restart, undefined);
const c1 = calls.at(-1);
assert.equal(c1.url, "https://verify.twilio.com/v2/Services/VAtest/VerificationCheck");
assert.deepEqual(c1.form, { To: N, Code: "000000" });

// bad code format refused locally
const n1 = calls.length;
r = await V.checkVerification("sms", N, "i:a", "12", t0 + 20_000);
assert.equal(r.ok, false); assert.match(r.error, /6-digit/); assert.equal(calls.length, n1);

// another install can't check this number's code
r = await V.checkVerification("sms", N, "i:b", "123456", t0 + 20_000);
assert.equal(r.ok, false); assert.equal(r.restart, true); assert.equal(calls.length, n1);

// right code: ref is the verification sid
reply = () => json(200, verification({ sid: "VE1", status: "approved", valid: true }));
r = await V.checkVerification("sms", N, "i:a", "12 34 56", t0 + 25_000);
assert.deepEqual(r, { ok: true, ref: "VE1", consentAt: 111 });
assert.deepEqual(calls.at(-1).form, { To: N, Code: "123456" });
assert.deepEqual(V.pendingVerifications("sms", "i:a", t0), []);

// Twilio ended it (60202 max check attempts) -> restart
reply = () => json(201, verification({ sid: "VE2" }));
assert.equal((await V.startVerification("sms", N, "i:a", 222, t0 + 60_000)).ok, true);
reply = () => err(429, 60202);
r = await V.checkVerification("sms", N, "i:a", "999999", t0 + 61_000);
assert.equal(r.ok, false); assert.equal(r.restart, true); assert.match(r.error, /Too many wrong codes/);

// status max_attempts_reached / expired -> restart
reply = () => json(201, verification({ sid: "VE3" }));
assert.equal((await V.startVerification("sms", N, "i:a", 333, t0 + 120_000)).ok, true);
reply = () => json(200, verification({ sid: "VE3", status: "expired" }));
r = await V.checkVerification("sms", N, "i:a", "999999", t0 + 121_000);
assert.equal(r.restart, true); assert.match(r.error, /expired/);

// 404 at check (final state) -> restart
reply = () => json(201, verification({ sid: "VE4" }));
assert.equal((await V.startVerification("sms", N, "i:a", 444, t0 + 180_000)).ok, true);
reply = () => err(404, 20404);
r = await V.checkVerification("sms", N, "i:a", "999999", t0 + 181_000);
assert.equal(r.ok, false); assert.equal(r.restart, true);
assert.deepEqual(V.pendingVerifications("sms", "i:a", t0 + 181_000), []);

// 5 sends per number per hour: the 6th is refused locally
reply = () => json(201, verification());
r = await V.startVerification("sms", N, "i:a", 1, t0 + 240_000);
assert.equal(r.ok, true, "5th send");
const n = calls.length;
r = await V.startVerification("sms", N, "i:a", 1, t0 + 300_000);
assert.equal(r.ok, false); assert.match(r.error, /a lot of codes/); assert.equal(calls.length, n);
// an hour later it's fine again
r = await V.startVerification("sms", N, "i:a", 1, t0 + 3_700_000);
assert.equal(r.ok, true);

// send errors
stubTwilio();
reply = () => err(429, 60203, { "retry-after": "120" });
r = await V.startVerification("sms", "+15550000001", "i:a", 1, t0);
assert.equal(r.ok, false); assert.equal(r.retryInSec, 120, JSON.stringify(r));
reply = () => err(429, 20429);
r = await V.startVerification("sms", "+15550000002", "i:a", 1, t0);
assert.equal(r.ok, false); assert.equal(r.retryInSec, 600); assert.match(r.error, /Too many codes/);
for (const [i, code] of [60200, 60605].entries()) {
  reply = () => err(400, code);
  r = await V.startVerification("sms", `+1555000010${i}`, "i:a", 1, t0);
  assert.equal(r.ok, false); assert.match(r.error, /can't get a text/, String(code));
}
reply = () => err(401, 20003);
r = await V.startVerification("sms", "+15550000003", "i:a", 1, t0);
assert.equal(r.ok, false); assert.match(r.error, /isn't working/);
reply = () => json(201, verification({ status: "canceled" }));
r = await V.startVerification("sms", "+15550000005", "i:a", 1, t0);
assert.equal(r.ok, false); assert.match(r.error, /Couldn't send a code/);
// a 5xx is retried once, then reported
const n2 = calls.length;
reply = () => err(503, 0);
r = await V.startVerification("sms", "+15550000006", "i:a", 1, t0);
assert.equal(r.ok, false); assert.match(r.error, /Couldn't send a code/); assert.equal(calls.length - n2, 2);

// the account's own SID and token work when there is no API key
stubTwilio();
delete process.env.TWILIO_API_KEY_SID; delete process.env.TWILIO_API_KEY_SECRET;
process.env.TWILIO_ACCOUNT_SID = "ACtest"; process.env.TWILIO_AUTH_TOKEN = "tok";
reply = () => json(201, verification());
assert.equal((await V.startVerification("sms", "+15550000007", "i:a", 1, t0)).ok, true);
assert.equal(calls.at(-1).auth, `Basic ${Buffer.from("ACtest:tok").toString("base64")}`);
delete process.env.TWILIO_ACCOUNT_SID; delete process.env.TWILIO_AUTH_TOKEN;
process.env.TWILIO_API_KEY_SID = "SKtest"; process.env.TWILIO_API_KEY_SECRET = "secret";

// per-install cap: 12 per hour across numbers
stubTwilio();
reply = () => json(201, verification());
let ok = 0;
for (let i = 0; i < 14; i++) if ((await V.startVerification("sms", `+1555100${String(i).padStart(4, "0")}`, "i:z", 1, t0)).ok) ok++;
assert.equal(ok, 12);

// countries: +1 only by default, not the Caribbean +1 area codes; BOPS_VERIFY_COUNTRIES widens it
stubTwilio();
assert.equal(V.textableCountry("+15551234567"), true);
assert.equal(V.textableCountry("+442079460958"), false);
assert.equal(V.textableCountry("+18765551234"), false, "Jamaica");
const n3 = calls.length;
r = await V.startVerification("sms", "+442079460958", "i:c", 1, t0);
assert.equal(r.ok, false); assert.match(r.error, /US and Canadian/); assert.equal(calls.length, n3);
process.env.BOPS_VERIFY_COUNTRIES = "1,44,1876";
assert.equal(V.textableCountry("+442079460958"), true);
assert.equal(V.textableCountry("+18765551234"), true);
assert.equal(V.textableCountry("+33612345678"), false);
delete process.env.BOPS_VERIFY_COUNTRIES;

// another install can't start (or burn the tries of) a number someone else has a code out for
stubTwilio();
reply = () => json(201, verification());
assert.equal((await V.startVerification("sms", N, "i:owner", 5, t0)).ok, true);
r = await V.startVerification("sms", N, "i:other", 5, t0 + 1000);
assert.equal(r.ok, false); assert.match(r.error, /Someone else/);
r = await V.checkVerification("sms", N, "i:other", "000000", t0 + 1000);
assert.equal(r.ok, false); assert.equal(r.restart, true);
// check tries are per install and number: the owner's own 15 don't spill to another number
reply = () => json(200, verification());
for (let i = 0; i < 15; i++) await V.checkVerification("sms", N, "i:owner", "000000", t0 + 2000);
r = await V.checkVerification("sms", N, "i:owner", "000000", t0 + 2000);
assert.match(r.error, /Too many tries/);

// consent outlives a code that ran out: a resend after expiry needs no new tick
stubTwilio();
reply = () => json(201, verification());
assert.equal((await V.startVerification("sms", N, "i:k", 777, t0)).ok, true);
r = await V.checkVerification("sms", N, "i:k", "123456", t0 + 11 * 60_000);
assert.equal(r.restart, true); assert.match(r.error, /expired/);
assert.equal(V.pendingConsentAt(N, "i:k"), 777);
V.forgetVerification("sms", N, "i:k");
assert.equal(V.pendingConsentAt(N, "i:k"), undefined);

// per-server cap: 30 an hour across installs and numbers
stubTwilio();
reply = () => json(201, verification());
ok = 0;
for (let i = 0; i < 40; i++) if ((await V.startVerification("sms", `+1555200${String(i).padStart(4, "0")}`, `i:s${i % 4}`, 1, t0)).ok) ok++;
assert.equal(ok, 30);

// no credentials and no stub: not set up, no call
V.setVerifyApiForTests(null);
for (const k of ["TWILIO_VERIFY_SERVICE_SID", "TWILIO_API_KEY_SID", "TWILIO_API_KEY_SECRET"]) delete process.env[k];
assert.equal(V.verifyOn(), false);
const n4 = calls.length;
r = await V.startVerification("sms", N, "i:a", 1, t0);
assert.equal(r.ok, false); assert.match(r.error, /isn't set up/); assert.equal(calls.length, n4);
// ...and no email codes either, without a call
assert.equal(await V.emailCodesOn(t0), false);
r = await V.startVerification("email", "me@example.com", "i:a", 0, t0);
assert.equal(r.ok, false); assert.equal(r.error, "Adding another email by code isn't available yet."); assert.equal(calls.length, n4);
assert.equal(n4, 79, "texted codes make the same 79 fake calls as before codes could be emailed");

/* ---------------- Codes by email ---------------- */

process.env.TWILIO_VERIFY_SERVICE_SID = "VAtest";
process.env.TWILIO_API_KEY_SID = "SKtest";
process.env.TWILIO_API_KEY_SECRET = "secret";
const E = "me@example.com";
const MIN = 60_000;
// GET Services/VAtest: the service, with an email sender (a mailer) attached or not.
const service = (mailer) => json(200, { sid: "VAtest", friendly_name: "Bops", ...(mailer === undefined ? {} : { mailer_sid: mailer }) });
// A service with a sender, whose sends and checks answer `then`.
const withSender = (then) => (c) => (c.method === "GET" ? service("MDtest") : then(c));
const since = (n) => calls.length - n;

// The service check: a sender attached means codes can be emailed, and the answer is kept 10 minutes.
stubTwilio();
reply = () => service("MDtest");
let n5 = calls.length;
assert.equal(await V.emailCodesOn(t0), true);
assert.deepEqual(calls.at(-1), { method: "GET", url: "https://verify.twilio.com/v2/Services/VAtest", auth: `Basic ${Buffer.from("SKtest:secret").toString("base64")}`, type: undefined, form: {} });
assert.equal(await V.emailCodesOn(t0 + 9 * MIN), true);
assert.equal(since(n5), 1, "kept: one GET");
reply = () => service(null);
assert.equal(await V.emailCodesOn(t0 + 11 * MIN), false, "no sender attached");
assert.equal(since(n5), 2, "asked again after 10 minutes");
stubTwilio();
reply = () => service(undefined);
assert.equal(await V.emailCodesOn(t0), false, "no mailer_sid at all");

// A check that fails (refused, or no connection) is a no for 10 minutes, not a GET per call.
stubTwilio();
reply = () => err(401, 20003);
n5 = calls.length;
for (const m of [0, 1, 5, 9]) assert.equal(await V.emailCodesOn(t0 + m * MIN), false);
assert.equal(since(n5), 1);
stubTwilio();
reply = () => {
  throw new TypeError("fetch failed");
};
n5 = calls.length;
for (const m of [0, 1, 9]) assert.equal(await V.emailCodesOn(t0 + m * MIN), false);
assert.equal(since(n5), 2, "one check (a dropped connection is tried twice), not one per call");
// Two asking at once share one GET.
stubTwilio();
reply = () => service("MDtest");
n5 = calls.length;
assert.deepEqual(await Promise.all([V.emailCodesOn(t0), V.emailCodesOn(t0)]), [true, true]);
assert.equal(since(n5), 1);

// BOPS_VERIFY_EMAIL=0 turns email codes off without asking the service; =1 takes a sender as given.
stubTwilio();
reply = withSender(() => json(201, verification({ channel: "email", to: E })));
n5 = calls.length;
process.env.BOPS_VERIFY_EMAIL = "0";
assert.equal(await V.emailCodesOn(t0), false);
r = await V.startVerification("email", E, "i:e", 0, t0);
assert.equal(r.ok, false); assert.equal(r.error, "Adding another email by code isn't available yet.");
assert.equal(since(n5), 0, "no GET and no send");
process.env.BOPS_VERIFY_EMAIL = "1";
assert.equal(await V.emailCodesOn(t0), true);
assert.equal(since(n5), 0, "taken as given: no GET");
delete process.env.BOPS_VERIFY_EMAIL;

// The email channel on the wire: To is the address and Channel=email; the check is the same as a text's.
stubTwilio();
reply = withSender(() => json(201, verification({ sid: "VEm1", channel: "email", to: E })));
r = await V.startVerification("email", E, "i:e", 0, t0);
assert.deepEqual(r, { ok: true, recipient: E, resendInSec: 60, expiresAt: t0 + 10 * MIN });
assert.equal(calls.at(-1).method, "POST");
assert.equal(calls.at(-1).url, "https://verify.twilio.com/v2/Services/VAtest/Verifications");
assert.deepEqual(calls.at(-1).form, { To: E, Channel: "email" });
console.log("create (email) ->", calls.at(-1).url, `Channel=${calls.at(-1).form.Channel}`);
reply = withSender(() => json(200, verification({ sid: "VEm1", status: "pending", channel: "email" })));
r = await V.checkVerification("email", E, "i:e", "000000", t0 + 5000);
assert.equal(r.ok, false); assert.equal(r.error, "That code isn't right."); assert.equal(r.restart, undefined);
assert.equal(calls.at(-1).url, "https://verify.twilio.com/v2/Services/VAtest/VerificationCheck");
assert.deepEqual(calls.at(-1).form, { To: E, Code: "000000" });
r = await V.checkVerification("email", E, "i:e", "12", t0 + 5000);
assert.equal(r.error, "Enter the 6-digit code from the email.");
r = await V.checkVerification("email", "other@example.com", "i:e", "123456", t0 + 5000);
assert.equal(r.error, "Send a code to this address first."); assert.equal(r.restart, true);
reply = withSender(() => json(200, verification({ sid: "VEm1", status: "approved" })));
r = await V.checkVerification("email", E, "i:e", "123456", t0 + 6000);
assert.deepEqual(r, { ok: true, ref: "VEm1", consentAt: 0 });
// Texts still go out as Channel=sms.
reply = withSender(() => json(201, verification()));
assert.equal((await V.startVerification("sms", N, "i:e", 9, t0)).ok, true);
assert.deepEqual(calls.at(-1).form, { To: N, Channel: "sms" });

// A code proves only where it went: an emailed code is never checked as a text's, nor the reverse,
// and one install can have both out at once.
stubTwilio();
reply = withSender(() => json(201, verification({ sid: "VEx" })));
assert.equal((await V.startVerification("email", E, "i:x", 0, t0)).ok, true);
assert.equal((await V.startVerification("sms", N, "i:x", 5, t0)).ok, true);
assert.deepEqual(V.pendingVerifications("sms", "i:x", t0).map((p) => p.recipient), [N]);
assert.deepEqual(V.pendingVerifications("email", "i:x", t0), [{ channel: "email", recipient: E, resendInSec: 60, expiresAt: t0 + 10 * MIN }], "never the code or Twilio's id");
n5 = calls.length;
for (const [channel, to] of [["sms", E], ["email", N]]) {
  r = await V.checkVerification(channel, to, "i:x", "123456", t0 + 1000);
  assert.equal(r.ok, false); assert.equal(r.restart, true, `${channel} ${to}`);
}
assert.equal(since(n5), 0, "refused here, before Twilio");
assert.equal(V.pendingConsentAt(N, "i:x"), 5);
V.forgetVerification("email", E, "i:x");
assert.deepEqual(V.pendingVerifications("email", "i:x", t0), []);
assert.deepEqual(V.pendingVerifications("sms", "i:x", t0).map((p) => p.recipient), [N], "forgetting the email leaves the text");
// Another install can't start (or burn the tries of) an address someone else has a code out for.
assert.equal((await V.startVerification("email", "held@example.com", "i:x", 0, t0)).ok, true);
r = await V.startVerification("email", "held@example.com", "i:y", 0, t0 + 1000);
assert.equal(r.ok, false); assert.equal(r.error, "Someone else is checking this address right now. Try again in a few minutes.");

// The country list is for texts: an address has no country, and a number outside the list is still refused.
stubTwilio();
reply = withSender(() => json(201, verification()));
r = await V.startVerification("email", "someone@example.co.uk", "i:w", 0, t0);
assert.equal(r.ok, true, JSON.stringify(r));
n5 = calls.length;
r = await V.startVerification("sms", "+442079460958", "i:w", 1, t0);
assert.equal(r.ok, false); assert.match(r.error, /US and Canadian/); assert.equal(since(n5), 0);

// Email limits: 60 seconds between codes to an address, 5 an hour from one install, 8 from anyone.
stubTwilio();
reply = withSender(() => json(201, verification({ sid: "VEl" })));
assert.equal((await V.startVerification("email", E, "i:l", 0, t0)).ok, true);
n5 = calls.length;
r = await V.startVerification("email", E, "i:l", 0, t0 + 30_000);
assert.equal(r.ok, false); assert.equal(r.error, "A code is on its way. You can send another in a moment."); assert.equal(r.retryInSec, 30);
assert.equal(since(n5), 0);
assert.deepEqual(V.pendingVerifications("email", "i:l", t0 + 30_000).map((p) => p.resendInSec), [30]);
for (let i = 1; i <= 4; i++) assert.equal((await V.startVerification("email", E, "i:l", 0, t0 + i * 61_000)).ok, true, `send ${i + 1}`);
n5 = calls.length;
r = await V.startVerification("email", E, "i:l", 0, t0 + 5 * 61_000);
assert.equal(r.ok, false); assert.match(r.error, /^That's a lot of codes for one address\. Try again in \d+ min\.$/); assert.equal(since(n5), 0);
stubTwilio();
let sent = 0;
for (let i = 0; i < 9; i++) {
  reply = withSender(() => json(201, verification({ sid: `VEa${i}` })));
  const s = await V.startVerification("email", "shared@example.com", `i:a${i}`, 0, t0 + i * 1000);
  if (!s.ok) {
    assert.match(s.error, /a lot of codes for one address/);
    break;
  }
  sent++;
  // Each install's code checked, so nobody holds the address for the next.
  reply = withSender(() => json(200, verification({ sid: `VEa${i}`, status: "approved" })));
  assert.equal((await V.checkVerification("email", "shared@example.com", `i:a${i}`, "123456", t0 + i * 1000 + 500)).ok, true);
}
assert.equal(sent, 8);
// Per install and per server, texts and emails count together: every send costs money.
stubTwilio();
reply = withSender(() => json(201, verification()));
ok = 0;
for (let i = 0; i < 14; i++) {
  const channel = i % 2 ? "email" : "sms";
  if ((await V.startVerification(channel, channel === "sms" ? `+1555300${String(i).padStart(4, "0")}` : `mix${i}@example.com`, "i:mix", 1, t0)).ok) ok++;
}
assert.equal(ok, 12);
stubTwilio();
reply = withSender(() => json(201, verification()));
ok = 0;
for (let i = 0; i < 40; i++) {
  const channel = i % 2 ? "email" : "sms";
  if ((await V.startVerification(channel, channel === "sms" ? `+1555400${String(i).padStart(4, "0")}` : `all${i}@example.com`, `i:t${i % 4}`, 1, t0)).ok) ok++;
}
assert.equal(ok, 30);

// A send the service refuses for its setup (no sender attached: 60217) turns email codes off for 10
// minutes, and the next start is refused without a call. A 429, a bad address or a 5xx doesn't.
stubTwilio();
reply = withSender(() => err(400, 60217));
r = await V.startVerification("email", "a@example.com", "i:f", 0, t0);
assert.equal(r.ok, false); assert.equal(r.error, "Couldn't email a code right now. Try again later, or text your bots instead.");
n5 = calls.length;
assert.equal(await V.emailCodesOn(t0 + 1000), false);
r = await V.startVerification("email", "b@example.com", "i:f", 0, t0 + 2000);
assert.equal(r.ok, false); assert.equal(r.error, "Adding another email by code isn't available yet.");
process.env.BOPS_VERIFY_EMAIL = "1";
assert.equal(await V.emailCodesOn(t0 + 3000), false, "BOPS_VERIFY_EMAIL=1 doesn't override a refused send");
delete process.env.BOPS_VERIFY_EMAIL;
assert.equal(since(n5), 0, "refused without a call");
assert.equal(await V.emailCodesOn(t0 + 10 * MIN + 1), true, "the service is asked again after 10 minutes");
assert.equal(since(n5), 1);
for (const [status, code] of [[401, 20003], [404, 20404], [400, 60218]]) {
  stubTwilio();
  reply = withSender(() => err(status, code));
  r = await V.startVerification("email", "c@example.com", "i:f", 0, t0);
  assert.equal(r.error, "Couldn't email a code right now. Try again later, or text your bots instead.", String(code));
  assert.equal(await V.emailCodesOn(t0 + 1000), false, String(code));
}
stubTwilio();
reply = withSender(() => err(429, 20429));
r = await V.startVerification("email", "d@example.com", "i:f", 0, t0);
assert.equal(r.ok, false); assert.equal(r.error, "Too many codes were sent to this address. Try again in 10 min."); assert.equal(r.retryInSec, 600);
reply = withSender(() => err(400, 60200));
r = await V.startVerification("email", "e@example.com", "i:f", 0, t0);
assert.equal(r.ok, false); assert.equal(r.error, "That doesn't look like an email address.");
reply = withSender(() => err(503, 0));
r = await V.startVerification("email", "f@example.com", "i:f", 0, t0);
assert.equal(r.error, "Couldn't send a code right now. Try again in a minute.");
n5 = calls.length;
assert.equal(await V.emailCodesOn(t0 + 1000), true, "still on");
assert.equal(since(n5), 0);

/* ---------------- The user's own addresses (lib/server/owner-email.ts, ownerAddresses in lib/server/mail.ts) ---------------- */

// Mail on (nothing here calls AgentMail), on the throwaway state in the temporary folder. The bots'
// email domain is a self-hoster's own: bots get addresses on its subdomains (sam@acme.bots-mail.com),
// and the domain itself is the self-hoster's (boss@bots-mail.com).
process.env.AGENTMAIL_API_KEY = "test-key-never-used";
process.env.BOPS_MAIL_DOMAIN = "bots-mail.com";
const S = await import(`${root}/lib/server/store.ts`);
const M = await import(`${root}/lib/server/mail.ts`);
const O = await import(`${root}/lib/server/owner-email.ts`);
const plain = (x) => JSON.parse(JSON.stringify(x));

// normalizeEmail
for (const [input, out] of [
  [" Me@Example.COM ", "me@example.com"],
  ["first.last+tag@sub.example.co.uk", "first.last+tag@sub.example.co.uk"],
  ["me@example", ""],
  ["me@@example.com", ""],
  ["me@exa mple.com", ""],
  ["Me <me@example.com>", ""],
  ["<me@example.com>", ""],
  ["a@x.com,b@y.com", ""],
  ["@example.com", ""],
  ["me@.example.com", ""],
  ["me@example..com", ""],
  ["", ""],
  [`${"a".repeat(250)}@example.com`, ""],
])
  assert.equal(O.normalizeEmail(input), out, input);

// The bots' own addresses, wherever an address comes from: every inbox they have or had, and
// agentmail.to and bops.bot (bare or a workspace's part).
S.update((s) => {
  s.bots[0].email = "sam@acme-bots.com";
  s.bots[0].mail = { inboxId: "sam@acme-bots.com", podId: "pod_test", past: ["sam.old@acme-bots.com"] };
});
for (const a of ["x@bops.bot", "boppy@team.bops.bot", "boppy.team@agentmail.to", "sam@acme-bots.com", "SAM@Acme-Bots.com", "sam.old@acme-bots.com"]) assert.equal(M.isBotAddress(a), true, a);
for (const a of ["me@example.com", "me@notbops.bot", "bops.bot@example.com", "boss@bots-mail.com", "ops@team.bots-mail.com"]) assert.equal(M.isBotAddress(a), false, a);
// A workspace's part of this server's bot domain is where its bots get addresses; the domain itself isn't.
assert.equal(M.onBotsMailDomain("ops@team.bots-mail.com"), true);
assert.equal(M.onBotsMailDomain("boss@bots-mail.com"), false);
// Why one can't be added by code, in words that fit what it is.
assert.equal(O.botAddressError("SAM@acme-bots.com"), "That's one of your bots' own addresses. Use your own email.");
assert.equal(O.botAddressError("x@team.bops.bot"), "Addresses on team.bops.bot are for bots. Use your own email.");
assert.equal(O.botAddressError("y@agentmail.to"), "Addresses on agentmail.to are for bots. Use your own email.");
assert.equal(O.botAddressError("jane@eu.bots-mail.com"), "Addresses on eu.bots-mail.com are for bots. Use your own email.");
assert.equal(O.botAddressError("boss@bots-mail.com"), null, "the self-hoster's own domain is theirs");
assert.equal(O.botAddressError("me@example.com"), null);

// ownerAddresses: the connected Gmail, BOPS_OWNER_EMAILS and verified ones, one each. The sign-in
// email is listed but counts only once the user counts it. Only a bot's inbox (or agentmail.to,
// bops.bot) is dropped from Gmail and this server's list: an address set there on the self-hoster's
// own domain still counts, even on a workspace's part of it.
S.update((s) => {
  s.account = { user: { id: "u_test", email: "Owner@Example.org" }, signedInAt: 1 };
  s.accounts = [{ id: "ca_gmail", app: "gmail", appName: "Gmail", name: "owner@gmail.com", status: "active", at: 1 }];
  s.ownerEmails = [{ address: "work@example.com", verifiedAt: 5, ref: "VEw", userId: "u_test" }];
});
process.env.BOPS_OWNER_EMAILS = "Env@Example.com, owner@gmail.com, sam@acme-bots.com, x@bops.bot, boss@bots-mail.com, ops@team.bots-mail.com";
assert.deepEqual(M.ownerAddresses(), ["owner@gmail.com", "env@example.com", "boss@bots-mail.com", "ops@team.bots-mail.com", "work@example.com"]);
assert.deepEqual(plain(M.ownerEmailSources()), [
  { address: "owner@example.org", sources: ["sign-in"], off: true },
  { address: "owner@gmail.com", sources: ["gmail", "env"] },
  { address: "env@example.com", sources: ["env"] },
  { address: "boss@bots-mail.com", sources: ["env"] },
  { address: "ops@team.bots-mail.com", sources: ["env"] },
  { address: "work@example.com", sources: ["code"], verifiedAt: 5 },
]);
O.setSignInEmailCounted(true);
assert.equal(S.getState().signInEmailCounted, "owner@example.org");
assert.ok(M.ownerAddresses().includes("owner@example.org"), "counted: it counts");
assert.deepEqual(plain(M.ownerEmailSources()[0]), { address: "owner@example.org", sources: ["sign-in"] });

// Another Orgo account signs in on this Mac: its own sign-in email starts not counted, and the last
// one's verified addresses aren't its own. Back again, everything is as the first one left it.
S.update((s) => {
  s.account = { user: { id: "u_other", email: "other@example.net" }, signedInAt: 2 };
});
assert.deepEqual(plain(M.ownerEmailSources()[0]), { address: "other@example.net", sources: ["sign-in"], off: true });
assert.ok(!M.ownerAddresses().some((a) => ["other@example.net", "owner@example.org", "work@example.com"].includes(a)));
assert.ok(!M.ownerEmailSources().some((e) => e.address === "work@example.com"), "not even listed");
S.update((s) => {
  s.account = { user: { id: "u_test", email: "Owner@Example.org" }, signedInAt: 3 };
});
assert.ok(M.ownerAddresses().includes("owner@example.org") && M.ownerAddresses().includes("work@example.com"));
// What was saved before ids were kept (or with nobody signed in, as a self-hoster) is whoever's here.
assert.equal(S.ofThisUser({}), true);
assert.equal(S.ofThisUser({ userId: "u_test" }), true);
assert.equal(S.ofThisUser({ userId: "u_other" }), false);
S.update((s) => {
  s.ownerEmails.push({ address: "old@example.com", verifiedAt: 4 });
});
assert.ok(M.ownerAddresses().includes("old@example.com"));
S.update((s) => {
  s.ownerEmails = s.ownerEmails.filter((e) => e.address !== "old@example.com");
});

O.setSignInEmailCounted(false);
assert.equal(S.getState().signInEmailCounted, undefined);
assert.ok(!M.ownerAddresses().includes("owner@example.org"), "not counted anymore");
S.update((s) => {
  s.account.user.email = "owner@gmail.com";
});
assert.ok(M.ownerAddresses().includes("owner@gmail.com"), "still counts while it's the connected Gmail too");
S.update((s) => {
  s.account.user.email = "boppy@team.bops.bot";
});
O.setSignInEmailCounted(true);
assert.equal(S.getState().signInEmailCounted, undefined, "a bot's address as the sign-in email can't be counted");
assert.ok(!M.ownerEmailSources().some((e) => e.address.endsWith("bops.bot")), "or listed");
S.update((s) => {
  s.account.user.email = "Owner@Example.org";
});

// Adding one: refused before anything is asked or sent when it isn't an address, is a bot's, already
// counts, or is the sign-in email (one tap counts that).
stubTwilio();
reply = withSender(() => json(201, verification({ sid: "VEo1" })));
n5 = calls.length;
for (const [input, error] of [
  ["not an address", "That doesn't look like an email address."],
  ["boppy@team.bops.bot", "Addresses on team.bops.bot are for bots. Use your own email."],
  ["sam@acme-bots.com", "That's one of your bots' own addresses. Use your own email."],
  ["jane@eu.bots-mail.com", "Addresses on eu.bots-mail.com are for bots. Use your own email."],
  [" Owner@Example.org", "That's your sign-in email. Tap Count it instead."],
  ["owner@gmail.com", "That address already counts as you."],
  ["env@example.com", "That address already counts as you."],
  ["work@example.com", "That address already counts as you."],
]) {
  r = await O.startOwnerEmail(input);
  assert.equal(r.ok, false); assert.equal(r.error, error, input);
}
assert.equal(since(n5), 0);
// ...and when codes can't be emailed from here (no sender, or mail off): the service is asked, nothing is sent.
reply = () => service(null);
r = await O.startOwnerEmail("new@example.com");
assert.equal(r.error, "Adding another email by code isn't available yet."); assert.equal(since(n5), 1);
assert.equal((await O.ownerEmailStatus()).codes, false);
delete process.env.AGENTMAIL_API_KEY;
stubTwilio();
reply = withSender(() => json(201, verification()));
n5 = calls.length;
r = await O.startOwnerEmail("new@example.com");
assert.equal(r.error, "Adding another email by code isn't available yet."); assert.equal(since(n5), 0);
assert.equal((await O.ownerEmailStatus()).on, false);
process.env.AGENTMAIL_API_KEY = "test-key-never-used";
// The self-hoster's own domain can be added by code.
stubTwilio();
reply = withSender(() => json(201, verification({ sid: "VEb1" })));
r = await O.startOwnerEmail("Jane@Bots-Mail.com");
assert.equal(r.ok, true, JSON.stringify(r)); assert.equal(r.recipient, "jane@bots-mail.com");
O.removeOwnerEmail("jane@bots-mail.com");

// checkOwnerEmail saves the address only when the code is approved: a wrong, used up or expired code saves nothing.
stubTwilio();
const NEW = "new@example.com";
const savedNew = () => (S.getState().ownerEmails ?? []).find((e) => e.address === NEW);
reply = withSender(() => json(201, verification({ sid: "VEo1" })));
r = await O.startOwnerEmail(" New@Example.com ");
assert.equal(r.ok, true, JSON.stringify(r)); assert.equal(r.recipient, NEW);
reply = withSender(() => json(200, verification({ sid: "VEo1", status: "pending" })));
r = await O.checkOwnerEmail(NEW, "000000");
assert.equal(r.ok, false); assert.equal(r.error, "That code isn't right.");
let st = await O.ownerEmailStatus();
assert.deepEqual(st.pending.map((p) => p.recipient), [NEW]);
assert.ok(!st.emails.some((e) => e.address === NEW) && !M.ownerAddresses().includes(NEW) && !savedNew(), "a code out isn't a verified address");
reply = withSender(() => err(429, 60202));
r = await O.checkOwnerEmail(NEW, "111111");
assert.equal(r.error, "Too many wrong codes. Send a new one."); assert.equal(r.restart, true);
assert.ok(!savedNew() && !M.ownerAddresses().includes(NEW));
reply = withSender(() => json(201, verification({ sid: "VEo2" })));
assert.equal((await O.startOwnerEmail(NEW)).ok, true);
reply = withSender(() => json(200, verification({ sid: "VEo2", status: "expired" })));
r = await O.checkOwnerEmail(NEW, "222222");
assert.equal(r.error, "That code has expired. Send a new one."); assert.equal(r.restart, true);
assert.ok(!savedNew() && !M.ownerAddresses().includes(NEW));
reply = withSender(() => json(201, verification({ sid: "VEo3" })));
assert.equal((await O.startOwnerEmail(NEW)).ok, true);
reply = withSender(() => json(200, verification({ sid: "VEo3", status: "approved" })));
r = await O.checkOwnerEmail("NEW@example.com", "333333");
assert.deepEqual(r, { ok: true });
assert.equal(savedNew().ref, "VEo3"); assert.ok(savedNew().verifiedAt > 0);
assert.equal(savedNew().userId, "u_test", "kept with the Orgo user who proved it");
assert.ok(M.ownerAddresses().includes(NEW));
assert.deepEqual(plain((await O.ownerEmailStatus()).emails.find((e) => e.address === NEW)), { address: NEW, sources: ["code"], verifiedAt: savedNew().verifiedAt });

// The status: what Settings needs, never a code or a verification's id; pending lists only where codes went.
reply = withSender(() => json(201, verification({ sid: "VEo9" })));
assert.equal((await O.startOwnerEmail("pending@example.com")).ok, true);
reply = withSender(() => json(200, verification({ sid: "VEo9", status: "pending" })));
await O.checkOwnerEmail("pending@example.com", "654321");
st = await O.ownerEmailStatus();
assert.deepEqual(Object.keys(st).sort(), ["add", "codes", "emails", "on", "pending"]);
assert.deepEqual({ on: st.on, codes: st.codes, add: st.add }, { on: true, codes: true, add: "on" });
assert.deepEqual(st.pending.map((p) => Object.keys(p).sort()), [["channel", "expiresAt", "recipient", "resendInSec"]]);
assert.equal(st.pending[0].recipient, "pending@example.com");
assert.ok(!/654321|333333|VEo|VEw/.test(JSON.stringify(st)), "no code typed, no verification id");
assert.ok(!M.ownerAddresses().includes("pending@example.com"));
// Anyone but the app on this Mac: whether mail is on, and nothing about the user, without a call to the Verify service.
n5 = calls.length;
assert.deepEqual(plain(await O.ownerEmailStatus(false)), { on: true, codes: false, add: "hosted", emails: [], pending: [] });
assert.equal(since(n5), 0);
for (const [url, ok] of [
  ["http://127.0.0.1:3210/api/owner-email", true],
  ["http://localhost:3210/api/owner-email", true],
  ["http://[::1]:3210/api/owner-email", true],
  ["http://192.168.1.20:3210/api/owner-email", false],
  ["https://bops.example.com/api/owner-email", false],
])
  assert.equal(O.fromThisMac(new Request(url)), ok, url);

// Removing: the saved address stops counting, and a code out for an address is dropped. Only the
// signed-in user's own: another account's address isn't touched from here.
O.removeOwnerEmail("NEW@example.com");
assert.ok(!savedNew() && !M.ownerAddresses().includes(NEW));
O.removeOwnerEmail("pending@example.com");
assert.deepEqual((await O.ownerEmailStatus()).pending, []);
S.update((s) => {
  s.ownerEmails.push({ address: "theirs@example.com", verifiedAt: 6, userId: "u_other" });
});
O.removeOwnerEmail("theirs@example.com");
assert.deepEqual(plain(S.getState().ownerEmails), [
  { address: "work@example.com", verifiedAt: 5, ref: "VEw", userId: "u_test" },
  { address: "theirs@example.com", verifiedAt: 6, userId: "u_other" },
]);

/* ---------------- Email from the user: DMARC (dmarcPassed, isFromOwner in lib/server/mail.ts) ---------------- */

const D = M.dmarcPassed;
// The receiving server's verdict, on one line or folded over several, with comments.
assert.equal(D(["amazonses.com; spf=pass (spfCheck: domain of gmail.com designates 1.2.3.4 as permitted sender) client-ip=1.2.3.4; envelope-from=owner@gmail.com; helo=mail-x.google.com; dkim=pass header.i=@gmail.com; dmarc=pass header.from=gmail.com;"], "gmail.com"), true);
assert.equal(D(["mx.example.net;\r\n dkim=pass header.i=@gmail.com;\r\n dmarc=pass\r\n (p=NONE sp=QUARANTINE dis=NONE) header.from=gmail.com"], "gmail.com"), true, "folded, with a comment");
assert.equal(D(["x; dmarc=PASS header.from=Gmail.com"], "gmail.com"), true, "case doesn't matter");
// Only a pass for that very domain, in one and the same result.
assert.equal(D(["x; dmarc=pass header.from=gmail.com.evil.com"], "gmail.com"), false);
assert.equal(D(["x; dmarc=pass header.from=evil.com"], "gmail.com"), false);
assert.equal(D(["x; dmarc=pass; spf=pass header.from=gmail.com"], "gmail.com"), false, "the words in two results");
assert.equal(D(["x; dmarc=bestguesspass header.from=gmail.com"], "gmail.com"), false);
assert.equal(D(["x; dmarc=none header.from=gmail.com"], "gmail.com"), false);
assert.equal(D(["x; dmarc=pass"], "gmail.com"), false, "a pass that names no domain");
assert.equal(D([], "gmail.com"), false);
// Words the sender picked, copied into the receiving server's own header, never pass: an envelope
// address or a HELO name, quoted or not. The check this replaced looked for "dmarc=pass" and
// "header.from=<domain>" anywhere in the joined headers, and would have passed this one.
const spoofed = "amazonses.com; spf=pass (spfCheck: domain of evil.com designates 5.6.7.8 as permitted sender) client-ip=5.6.7.8; envelope-from=dmarc=pass@evil.com; helo=dmarc=pass; dkim=none; dmarc=fail header.from=gmail.com;";
assert.ok(/\bdmarc=pass\b/i.test(spoofed) && /header\.from=gmail\.com\b/i.test(spoofed));
assert.equal(D([spoofed], "gmail.com"), false);
assert.equal(D(['amazonses.com; spf=pass smtp.mailfrom="x;dmarc=pass header.from=gmail.com"@evil.com; dmarc=none header.from=gmail.com'], "gmail.com"), false, "a quoted local part");
// A header the sender wrote into the email beside the receiving server's: they disagree, so no.
assert.equal(D(["x; dmarc=pass header.from=gmail.com", "amazonses.com; dmarc=fail header.from=gmail.com"], "gmail.com"), false);
assert.equal(D(["x; dmarc=pass header.from=gmail.com\namazonses.com; dmarc=fail header.from=gmail.com"], "gmail.com"), false, "joined into one value");
assert.equal(D(["x; dmarc=pass header.from=gmail.com, amazonses.com; dmarc=fail header.from=gmail.com"], "gmail.com"), false, "joined with a comma");
assert.equal(D(["x; dmarc=pass header.from=gmail.com", "y; dmarc=fail"], "gmail.com"), false, "a fail that names no domain");
// A result about another domain, or a "none" from a hop inside the sender's own network, doesn't overrule the pass.
assert.equal(D(["corp; dmarc=fail header.from=other.com", "amazonses.com; dmarc=pass header.from=gmail.com"], "gmail.com"), true);
assert.equal(D(["corp; dkim=none (message not signed) header.d=none;dmarc=none action=none header.from=gmail.com;", "amazonses.com; dmarc=pass header.from=gmail.com"], "gmail.com"), true);

// isFromOwner: one of the user's addresses (that counts), and the email proves it.
const email = (from, over = {}) => ({ inboxId: "sam@acme-bots.com", threadId: "t1", messageId: "m1", labels: ["received"], timestamp: new Date(), from, to: ["sam@acme-bots.com"], size: 1, updatedAt: new Date(), createdAt: new Date(), ...over });
const passing = (domain) => ({ "Authentication-Results": `amazonses.com; dkim=pass header.i=@${domain}; dmarc=pass header.from=${domain}` });
assert.equal(M.isFromOwner(email("Owner <owner@gmail.com>", { headers: passing("gmail.com") })), true);
assert.equal(M.isFromOwner(email("someone@gmail.com", { headers: passing("gmail.com") })), false, "not one of the user's addresses");
assert.equal(M.isFromOwner(email("owner@gmail.com", { headers: { "authentication-results": "amazonses.com; dmarc=fail header.from=gmail.com" } })), false);
assert.equal(M.isFromOwner(email("owner@gmail.com", { headers: {} })), false, "nothing proves it");
assert.equal(M.isFromOwner(email("owner@gmail.com", { headers: passing("gmail.com"), labels: ["received", "unauthenticated"] })), false, "AgentMail found nothing to check it with");
assert.equal(M.isFromOwner(email("owner@gmail.com", { headers: passing("gmail.com"), authentication_results: { dmarc: "fail" } })), false, "a verdict of AgentMail's own decides");
assert.equal(M.isFromOwner(email("owner@gmail.com", { headers: {}, authentication_results: { dmarc: "pass" } })), true);
assert.equal(M.isFromOwner(email("owner@gmail.com", { headers: { "Authentication-Results": ["x; dmarc=pass header.from=gmail.com", "amazonses.com; dmarc=fail header.from=gmail.com"] } })), false, "a repeated header kept as a list");
// The sign-in email: an email from it is the user only once it's counted.
assert.equal(M.isFromOwner(email("owner@example.org", { headers: passing("example.org") })), false);
O.setSignInEmailCounted(true);
assert.equal(M.isFromOwner(email("owner@example.org", { headers: passing("example.org") })), true);
O.setSignInEmailCounted(false);

console.log(`all verify tests passed (${calls.length} fake HTTP calls, none to the network)`);
// Gone before the store's next save could make the folder again.
rmSync(scratch, { recursive: true, force: true });
process.exit(0);
