import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { after, before, test } from "node:test";
import { closeDb, query } from "../db.ts";
import { call, dropUsers, fakeOrgo, fakeProvider, keyOf, newNumber, newUserId, prepareDb, seedUser, startCloud, until, type Listening } from "./core-fakes.ts";

/** /v1/verify/start and /check against a fake Twilio Verify: limits, holds, owners. */

const tag = randomUUID().slice(0, 8);
const users: string[] = [];
let orgo: Listening, cloud: Listening, twilio: Awaited<ReturnType<typeof fakeProvider>>;
let n = 0;
const refusedNumber = newNumber();
const busyNumber = newNumber();

const user = (what: string) => {
  const id = newUserId(what);
  users.push(id);
  return id;
};
const start = (userId: string, to: string, channel = "sms") => call(cloud.url, "POST", "/v1/verify/start", { key: keyOf(userId), json: { to, channel } });
const check = (userId: string, to: string, code: string) => call(cloud.url, "POST", "/v1/verify/check", { key: keyOf(userId), json: { to, code } });
const sends = () => twilio.got.filter((g) => g.path.endsWith("/Verifications"));
const form = (i: number) => new URLSearchParams(twilio.got[i].body.toString());
/** "(415) 555-0101" for "+14155550101": the cloud takes numbers as people type them. */
const typed = (e164: string) => `(${e164.slice(2, 5)}) ${e164.slice(5, 8)}-${e164.slice(8)}`;
/** Let the next send to this number skip the 30 s between texts, as if they'd passed. */
const later = (userId: string, to: string) =>
  query("UPDATE bops.cloud_limits SET window_start = window_start - interval '1 minute' WHERE key = $1", [`verify:last:sms:${userId}:${to}`]);

before(async () => {
  await prepareDb();
  // The whole cloud's count is shared: start this run with it empty.
  await query("DELETE FROM bops.cloud_limits WHERE key = 'verify:cloud'");
  orgo = await fakeOrgo();
  twilio = await fakeProvider((g) => {
    const f = new URLSearchParams(g.body.toString());
    if (g.path === "/v2/Services/VA_test/Verifications") {
      if (f.get("To") === refusedNumber) return { status: 400, json: { code: 60200, message: "Invalid parameter `To`" } };
      if (f.get("To") === busyNumber) return { status: 429, json: { code: 60203, message: "Max send attempts reached" }, headers: { "retry-after": "120" } };
      return { status: 201, json: { sid: `VE${tag}${++n}`, status: "pending", to: f.get("To"), channel: f.get("Channel") } };
    }
    if (g.path === "/v2/Services/VA_test/VerificationCheck") {
      if (f.get("Code") === "123456") return { json: { sid: `VE${tag}ok${++n}`, status: "approved" } };
      if (f.get("Code") === "999999") return { status: 404, json: { code: 20404, message: "The requested resource was not found" } };
      return { json: { sid: `VE${tag}${n}`, status: "pending" } };
    }
    return { status: 418 };
  });
  Object.assign(process.env, { TWILIO_VERIFY_SERVICE_SID: "VA_test", TWILIO_API_KEY_SID: "SK_test", TWILIO_API_KEY_SECRET: "shh", BOPS_UPSTREAM_TWILIO_VERIFY: twilio.url });
  delete process.env.BOPS_VERIFY_EMAIL;
  cloud = await startCloud();
});

after(async () => {
  await query("DELETE FROM bops.cloud_limits WHERE key = 'verify:cloud' OR key LIKE 'verify:to:%' OR key LIKE ANY($1::text[])", [users.map((u) => `%${u}%`)]);
  await dropUsers(users);
  await Promise.all([cloud?.close(), orgo?.close(), twilio?.close()]);
  await closeDb();
});

test("a code is texted through Twilio Verify with the cloud's key, and counted", async () => {
  const u = user("text");
  const to = newNumber();
  const r = await start(u, typed(to));
  assert.equal(r.status, 200, r.text);
  assert.deepEqual(r.json, { sid: `VE${tag}${n}`, status: "pending" });
  const sent = twilio.got.at(-1)!;
  assert.equal(sent.headers.authorization, `Basic ${Buffer.from("SK_test:shh").toString("base64")}`);
  assert.deepEqual(Object.fromEntries(form(twilio.got.length - 1)), { To: to, Channel: "sms" });
  const counted = await until(async () => (await query("SELECT cost_micros::float8 AS cost FROM bops.cloud_usage WHERE user_id = $1 AND kind = 'verify.sms'", [u])).rows[0]);
  assert.deepEqual(counted, { cost: 58_300 });
});

test("codes are texted to US and Canadian numbers only", async () => {
  const u = user("abroad");
  const before = sends().length;
  assert.equal((await start(u, "+44 20 7946 0958")).status, 400);
  const jamaica = await start(u, "+1 876 555 0123");
  assert.equal(jamaica.status, 400);
  assert.equal(jamaica.json.code, 60605);
  assert.equal((await start(u, "not a number")).status, 400);
  assert.equal(sends().length, before);
});

test("a second text to the same number waits 30 seconds", async () => {
  const u = user("resend");
  const to = newNumber();
  assert.equal((await start(u, to)).status, 200);
  const again = await start(u, to);
  assert.equal(again.status, 429);
  assert.ok(again.json.retryAfter >= 1 && again.json.retryAfter <= 30, String(again.json.retryAfter));
});

test("five codes an hour per user and number", async () => {
  const u = user("five");
  const to = newNumber();
  for (let i = 0; i < 5; i++) {
    assert.equal((await start(u, to)).status, 200, `send ${i + 1}`);
    await later(u, to);
  }
  const sixth = await start(u, to);
  assert.equal(sixth.status, 429);
  assert.match(sixth.json.error, /a lot of codes for one number/);
  assert.ok(sixth.json.retryAfter > 0 && sixth.json.retryAfter <= 3600);
});

test("the whole cloud sends at most 30 codes an hour", async () => {
  const u = user("cap");
  const hour = new Date(Math.floor(Date.now() / 3_600_000) * 3_600_000);
  await query("INSERT INTO bops.cloud_limits (key, window_start, count) VALUES ('verify:cloud', $1, 30) ON CONFLICT (key, window_start) DO UPDATE SET count = 30", [hour]);
  try {
    const r = await start(u, newNumber());
    assert.equal(r.status, 429);
    assert.match(r.json.error, /Too many codes sent in the last hour/);
  } finally {
    await query("DELETE FROM bops.cloud_limits WHERE key = 'verify:cloud'");
  }
});

test("while one user has a code out for a number, nobody else can start or check one for it", async () => {
  const [mine, theirs] = [user("holder"), user("other")];
  const to = newNumber();
  assert.equal((await start(mine, to)).status, 200);
  const before = sends().length;
  const r = await start(theirs, to);
  assert.equal(r.status, 409);
  assert.ok(r.json.retryAfter > 0 && r.json.retryAfter <= 600);
  assert.equal((await check(theirs, to, "123456")).status, 404);
  assert.equal(sends().length, before);
});

test("a code that checks out makes the number the user's, and nobody else's", async () => {
  const [first, second, third] = [user("owner"), user("second"), user("third")];
  const to = newNumber();
  assert.equal((await start(first, to)).status, 200);
  const ok = await check(first, typed(to), "123456");
  assert.equal(ok.status, 200, ok.text);
  assert.equal(ok.json.status, "approved");
  const row = (await query("SELECT verified_at, consent_at, verification_ref FROM bops.owner_phones WHERE orgo_user_id = $1 AND phone_e164 = $2", [first, to])).rows[0];
  assert.ok(row.verified_at && row.consent_at);
  assert.equal(row.verification_ref, ok.json.sid);
  assert.equal((await query("SELECT 1 FROM bops.cloud_objects WHERE provider = 'twilio' AND object_id = $1", [`sms:${to}`])).rowCount, 0, "the number is free again");
  // Refused before a text is paid for.
  const before = sends().length;
  const r = await start(second, to);
  assert.equal(r.status, 409);
  assert.match(r.json.error, /already verified on another Bops account/);
  assert.equal(sends().length, before);
  // And at the check, when someone else verified it while this code was out.
  const other = newNumber();
  assert.equal((await start(third, other)).status, 200);
  await query("INSERT INTO bops.app_state (user_id, state, version) VALUES ($1, '{}'::jsonb, 1) ON CONFLICT DO NOTHING", [second]);
  await query("INSERT INTO bops.owner_phones (orgo_user_id, phone_e164, consent_at, verified_at) VALUES ($1, $2, now(), now())", [second, other]);
  const late = await check(third, other, "123456");
  assert.equal(late.status, 409);
  assert.equal((await query("SELECT 1 FROM bops.owner_phones WHERE orgo_user_id = $1", [third])).rowCount, 0);
});

test("a code that checks out links the user's phone lines that have no owner yet (and leaves an owned one alone)", async () => {
  const u = user("lines");
  await seedUser(u, { subAccount: `sub_${u}` });
  const [open, owned] = [newNumber(), newNumber()];
  const claimed = newNumber();
  await query("INSERT INTO bops.phone_lines (digits, user_id, e164, claim_until) VALUES ($1, $2, $3, now() + interval '15 minutes')", [open.slice(-10), u, open]);
  await query("INSERT INTO bops.phone_lines (digits, user_id, e164, owner_number, claimed_at, claimed_via) VALUES ($1, $2, $3, $4, now(), 'call')", [owned.slice(-10), u, owned, claimed]);
  const to = newNumber();
  assert.equal((await start(u, to)).status, 200);
  assert.equal((await check(u, to, "123456")).status, 200);
  const rows = (await query("SELECT e164, owner_number, claimed_via FROM bops.phone_lines WHERE user_id = $1 ORDER BY e164", [u])).rows;
  assert.deepEqual(
    Object.fromEntries(rows.map((r) => [r.e164, [r.owner_number, r.claimed_via]])),
    { [open]: [to, "sms_code"], [owned]: [claimed, "call"] },
  );
});

test("a wrong code stays pending; one Twilio has finished with can't be checked again", async () => {
  const u = user("wrong");
  const to = newNumber();
  assert.equal((await start(u, to)).status, 200);
  const wrong = await check(u, to, "000000");
  assert.deepEqual([wrong.status, wrong.json.status], [200, "pending"]);
  const gone = await check(u, to, "999999");
  assert.equal(gone.status, 404);
  assert.equal(gone.json.code, 20404);
  const after = await check(u, to, "123456");
  assert.equal(after.status, 404);
  assert.match(after.json.error, /Send a code to this number first/);
});

test("Twilio's refusals come back with its code and when to try again, and leave the number free", async () => {
  const [u, other] = [user("refused"), user("next")];
  const bad = await start(u, refusedNumber);
  assert.deepEqual([bad.status, bad.json.code], [400, 60200]);
  const busy = await start(u, busyNumber);
  assert.deepEqual([busy.status, busy.json.code, busy.json.retryAfter], [429, 60203, 120]);
  // The failed send didn't keep the number held.
  assert.notEqual((await start(other, busyNumber)).status, 409);
});

test("emailed codes are off unless BOPS_VERIFY_EMAIL=1; a checked address is the user's", async () => {
  const u = user("email");
  const address = `me-${tag}@example.com`;
  assert.equal((await start(u, address, "email")).status, 503);
  process.env.BOPS_VERIFY_EMAIL = "1";
  try {
    assert.equal((await start(u, "sam@acme.bops.bot", "email")).status, 400);
    const r = await start(u, ` Me-${tag}@Example.com `, "email");
    assert.equal(r.status, 200, r.text);
    assert.deepEqual(Object.fromEntries(form(twilio.got.length - 1)), { To: address, Channel: "email" });
    const ok = await check(u, address, "123456");
    assert.equal(ok.json.status, "approved");
    const row = (await query("SELECT verification_ref FROM bops.owner_emails WHERE orgo_user_id = $1 AND email = $2", [u, address])).rows[0];
    assert.equal(row.verification_ref, ok.json.sid);
  } finally {
    delete process.env.BOPS_VERIFY_EMAIL;
  }
});

test("asking without signing in, or without a channel or a code, is refused", async () => {
  const u = user("bad");
  assert.equal((await call(cloud.url, "POST", "/v1/verify/start", { json: { to: newNumber(), channel: "sms" } })).status, 401);
  assert.equal((await call(cloud.url, "POST", "/v1/verify/start", { key: keyOf(u), json: { to: newNumber() } })).status, 400);
  assert.equal((await call(cloud.url, "POST", "/v1/verify/start", { key: keyOf(u), json: { to: newNumber(), channel: "voice" } })).status, 400);
  assert.equal((await check(u, newNumber(), "abc")).status, 400);
});
