import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { createHmac, randomUUID } from "node:crypto";
import { readFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import { after, before, test } from "node:test";
import pg from "pg";
import * as calls from "../calls.ts";
import { checkCreditAccess, creditLeft } from "../credit.ts";
import { seal } from "../crypto.ts";
import { closeDb, ownObject, query } from "../db.ts";
import { costOf, smsSegments } from "../pricing.ts";
import { recordUsage, recordUsageFor } from "../usage.ts";
import { LEDGER_IN_USE, TEST_DATABASE_URL, call, dropUsers, fakeOrgo, fakeProvider, keyOf, newNumber, prepareDb, seedUser, sse, startCloud, until, type Listening } from "./core-fakes.ts";

/**
 * AI credit (cloud/credit.ts, pricing.ts, usage.ts): each use priced at Orgo's cost and taken from the
 * user's credit, the one-time $5, and the gate that stops a user with nothing left, against orgo-web's
 * ledger as its migration makes it (fixtures/orgo-bops-credit.sql) and fake providers.
 */

const tag = randomUUID().slice(0, 8);
const users: string[] = [];
let orgo: Listening, cloud: Listening;
let openai: Awaited<ReturnType<typeof fakeProvider>>, agentphone: Awaited<ReturnType<typeof fakeProvider>>, typesafe: Awaited<ReturnType<typeof fakeProvider>>;
let treg: Awaited<ReturnType<typeof fakeProvider>>;
/** treg's calls (not its catalog, which the cloud reads to check a call). */
const tregCalls = () => treg.got.filter((g) => g.path.startsWith("/call/"));
let n = 0;

/** A user as Orgo has them (a profile; Orgo user ids are uuids) and as /v1/session leaves them. */
async function newUser() {
  const id = randomUUID();
  users.push(id);
  await query("INSERT INTO public.profiles (id) VALUES ($1)", [id]);
  await seedUser(id, { subAccount: `sub_${id}` });
  return id;
}

/** Set what the user has left: the one-time credit (after it's been given) and this month's plan credit. */
async function setCredit(userId: string, credit: { free: number; plan?: number; planEnds?: Date }) {
  await creditLeft(userId);
  await query("UPDATE public.bops_ai_credit SET free_micros = $2, plan_micros = $3, plan_expires_at = $4 WHERE user_id = $1", [
    userId,
    credit.free,
    credit.plan ?? 0,
    credit.planEnds ?? null,
  ]);
}

const row = async (userId: string) =>
  (await query<{ plan: string; free: string }>("SELECT plan_micros AS plan, free_micros AS free FROM public.bops_ai_credit WHERE user_id = $1", [userId])).rows[0];
const usageOf = async (userId: string, kind: string) =>
  (
    await query<{ units: number; cost: number; detail: Record<string, unknown> }>(
      "SELECT units::float8 AS units, cost_micros::float8 AS cost, detail FROM bops.cloud_usage WHERE user_id = $1 AND kind = $2 ORDER BY id",
      [userId, kind],
    )
  ).rows;
const as = (userId: string, method: string, path: string, json?: unknown, headers?: Record<string, string>) => call(cloud.url, method, path, { key: keyOf(userId), json, headers });
const inAMonth = () => new Date(Date.now() + 30 * 86_400_000);

/** orgo-web's ledger, in this throwaway database (made by its owner, bops_app here), one test file at a time. */
async function prepareLedger() {
  const sql = await readFile(fileURLToPath(new URL("./fixtures/orgo-bops-credit.sql", import.meta.url)), "utf8");
  const c = new pg.Client({ connectionString: TEST_DATABASE_URL });
  await c.connect();
  try {
    await c.query("SELECT pg_advisory_lock(hashtext('bops-edge-tests'))");
    await c.query(sql);
  } finally {
    await c.query("SELECT pg_advisory_unlock(hashtext('bops-edge-tests'))").catch(() => {});
    await c.end();
  }
}

before(async () => {
  await prepareDb();
  await prepareLedger();
  process.env.BOPS_AI_CREDITS = "1";
  orgo = await fakeOrgo();
  openai = await fakeProvider(async (g, res) => {
    if (g.method === "POST" && g.path === "/v1/responses") return { json: { id: `resp_${tag}_${++n}`, object: "response", model: "gpt-6.1-sol", output: [], usage: { input_tokens: 10, output_tokens: 5 } } };
    if (g.method === "POST" && g.path === "/v1/agents/sessions") return { json: { id: `asess_${tag}_${++n}`, object: "agent.session" } };
    if (g.method === "POST" && /^\/v1\/live\/sessions\/[^/]+\/(accept|reject|hangup)$/.test(g.path)) return { json: {} };
    const s = /^\/v1\/agents\/sessions\/([^/]+)\/(.+)$/.exec(g.path);
    if (s && g.method === "GET" && s[2] === "events")
      return void sse(res, [
        { type: "agent.session.turn.created", session_id: s[1], turn_id: `turn_${s[1]}_E`, turn: { id: `turn_${s[1]}_E` } },
        { type: "agent.session.turn.completed", session_id: s[1], turn_id: `turn_${s[1]}_E`, usage: { input_tokens: 2000, output_tokens: 300 } },
      ]);
    if (s && g.method === "GET" && s[2].startsWith("turns/"))
      return { json: { id: s[2].slice(6), object: "agent.session.turn", status: "completed", usage: { input_tokens: 1000, output_tokens: 100, input_tokens_details: { cached_tokens: 400 } } } };
    if (s && g.method === "GET" && s[2] === "items") return { json: { data: [], has_more: false } };
    return { status: 418, json: { error: "the fake doesn't know this" } };
  });
  agentphone = await fakeProvider((g) => {
    if (g.method === "POST" && g.path === "/v1/numbers") return { json: { id: `num_${tag}_${++n}`, phoneNumber: newNumber(), type: g.json?.type ?? "sms" } };
    if (g.method === "POST" && g.path === "/v1/messages") return { json: { id: `msg_${tag}_${++n}`, status: "queued" } };
    return { status: 418, json: { error: "the fake doesn't know this" } };
  });
  typesafe = await fakeProvider(() => ({ json: { answers: {} } }));
  treg = await fakeProvider((g) => {
    if (g.path === "/catalog/endpoints/treg.companies.search") return { json: { endpoint: { id: "treg.companies.search", method: "POST", scope: "", kind: "routed", async: null }, usd_per_call: 0 } };
    if (g.path === "/catalog/endpoints/treg.companies.slow") return { json: { endpoint: { id: "treg.companies.slow", method: "POST", scope: "", kind: "routed", async: null }, usd_per_call: 0 } };
    if (g.path === "/call/treg.companies.search") return { json: { output: { companies: [] } }, headers: { "x-treg-call-id": `call_${tag}_${++n}`, "x-treg-cost-micro": "0" } };
    // "slow": answers after a moment, so calls overlap.
    if (g.path === "/call/treg.companies.slow")
      return new Promise((r) => setTimeout(() => r({ json: { output: { companies: [] } }, headers: { "x-treg-call-id": `call_${tag}_${++n}`, "x-treg-cost-micro": "0" } }), 300));
    return { status: 418, json: { error: "the fake doesn't know this" } };
  });
  Object.assign(process.env, {
    TREG_TOKEN: "treg-test-token",
    BOPS_UPSTREAM_TREG: treg.url,
    OPENAI_API_KEY: "sk-test-main",
    BOPS_UPSTREAM_OPENAI: openai.url,
    AGENTPHONE_API_KEY: "ap-test-key",
    BOPS_UPSTREAM_AGENTPHONE: agentphone.url,
    TYPESAFE_API_KEY: "typesafe-test-key",
    BOPS_UPSTREAM_TYPESAFE: typesafe.url,
  });
  cloud = await startCloud();
});

after(async () => {
  await dropUsers(users);
  await query("DELETE FROM bops.cloud_agents WHERE user_id = ANY($1::text[])", [users]);
  await query("DELETE FROM bops.owner_phones WHERE orgo_user_id = ANY($1::text[])", [users]);
  await query("DELETE FROM public.profiles WHERE id = ANY($1::uuid[])", [users]);
  await Promise.all([cloud?.close(), orgo?.close(), openai?.close(), agentphone?.close(), typesafe?.close(), treg?.close()]);
  await closeDb();
});

/* ---------------- Prices ---------------- */

test("each kind of use is priced at what it costs Orgo, rounded up to a whole micro-dollar", () => {
  // gpt-6.1-sol: 2 per uncached input token, 0.1 per cached, 2.5 per one written to the cache, 10 per output.
  assert.equal(costOf("openai.tokens", 1100, { model: "gpt-6.1-sol", input: 1000, cached: 400, output: 100 }), 600 * 2 + 40 + 1000);
  assert.equal(costOf("openai.tokens", 1100, { model: "gpt-6.1-sol-2026-09-01", input: 1000, cached: 400, output: 100 }), 2240);
  assert.equal(costOf("openai.tokens", 1100, { model: "gpt-6.1-sol", input: 1000, cached: 400, cacheWrite: 500, output: 100 }), 100 * 2 + 40 + 500 * 2.5 + 1000);
  // gpt-6-astra: 10 / 1 / 12.5 / 50.
  assert.equal(costOf("openai.tokens", 1100, { model: "gpt-6-astra", input: 1000, cached: 400, output: 100 }), 6000 + 400 + 5000);
  assert.equal(costOf("openai.tokens", 1100, { model: "gpt-6-astra", input: 1000, cached: 400, cacheWrite: 600, output: 100 }), 400 + 600 * 12.5 + 5000);
  // A model with no price here, or none named, is priced as the dearest.
  assert.equal(costOf("openai.tokens", 1100, { model: "gpt-9-turbo", input: 1000, cached: 400, output: 100 }), 11_400);
  assert.equal(costOf("openai.tokens", 1100, { input: 1000, cached: 400, output: 100 }), 11_400);
  assert.equal(costOf("openai.tokens", 1100, { model: "gpt-6.1-sol-mini", input: 1000, cached: 400, output: 100 }), 11_400);
  // Past 272K input tokens in one response: input, cached and cache writes twice, output half again.
  assert.equal(costOf("openai.tokens", 301_000, { model: "gpt-6.1-sol", input: 300_000, cached: 0, output: 1000 }), 300_000 * 2 * 2 + 1000 * 10 * 1.5);
  assert.equal(costOf("openai.tokens", 301_000, { model: "gpt-6.1-sol", input: 300_000, cached: 200_000, cacheWrite: 50_000, output: 1000 }), (50_000 * 2 + 200_000 * 0.1 + 50_000 * 2.5) * 2 + 1000 * 10 * 1.5);
  // An agent turn sums many model requests: the long-context rule is per request, so never applied to a turn.
  assert.equal(costOf("openai.tokens", 606_000, { model: "gpt-6.1-sol", source: "agent", input: 600_000, cached: 540_000, output: 6_000 }), 60_000 * 2 + 540_000 * 0.1 + 6_000 * 10);
  // A tenth of a micro-dollar is rounded up.
  assert.equal(costOf("openai.tokens", 3, { model: "gpt-6.1-sol", input: 3, cached: 3, output: 0 }), 1);
  // GPT-Live: $0.05 a minute of audio, by the second; over a SIP trunk, its leg too (a row from before says no transport: SIP).
  assert.equal(costOf("openai.live_seconds", 60, { transport: "webrtc" }), 50_000);
  assert.equal(costOf("openai.live_seconds", 42, { transport: "webrtc" }), 35_000);
  assert.equal(costOf("openai.live_seconds", 42, { transport: "sip" }), Math.ceil(42 * (50_000 / 60 + 61.7)));
  assert.equal(costOf("openai.live_seconds", 42), Math.ceil(42 * (50_000 / 60 + 61.7)));
  // AgentPhone's webhook voice agent: 13 cents a minute, billed by the second.
  assert.equal(costOf("agentphone.voice_seconds", 60), 130_000);
  assert.equal(costOf("agentphone.voice_seconds", 61), Math.ceil((61 * 130_000) / 60));
  // The estimate a call answered in the cloud used to be priced at is gone: its seconds and tokens are counted instead.
  assert.equal(costOf("call.minutes", 2.5), 0);
  // A web search: $10 per 1K calls; opening a page or finding in one isn't a call.
  assert.equal(costOf("openai.web_search", 1, { action: "search" }), 10_000);
  assert.equal(costOf("openai.web_search", 1, {}), 10_000);
  assert.equal(costOf("openai.web_search", 1, { action: "open_page" }), 0);
  assert.equal(costOf("openai.web_search", 1, { action: "find_in_page" }), 0);
  assert.equal(costOf("agentphone.numbers", 1, { type: "sms" }), 3_000_000);
  assert.equal(costOf("agentphone.numbers", 1, {}), 3_000_000);
  assert.equal(costOf("agentphone.numbers", 1, { type: "imessage", imessageType: "inbound" }), 150_000_000);
  assert.equal(costOf("agentphone.numbers", 1, { type: "imessage", imessageType: "outbound" }), 250_000_000);
  assert.equal(costOf("agentphone.numbers", 1, { type: "imessage" }), 250_000_000);
  assert.equal(costOf("agentphone.sms", 2), 40_000);
  assert.equal(costOf("agentphone.sms", 1, { mms: true }), 30_000);
  // Jev: $0.042 per 1M input tokens, output free; jev-latest is jev-1.13.0, and a Jev model with no price here is priced as it.
  assert.equal(costOf("typesafe.tokens", 1_000, { model: "jev-1.13.0", input: 1_000, output: 0 }), 42);
  assert.equal(costOf("typesafe.tokens", 1_000_000, { model: "jev-latest", input: 1_000_000, output: 3 }), 42_000);
  assert.equal(costOf("typesafe.tokens", 100, { model: "jev-2.0.0", input: 100 }), 5);
  assert.equal(costOf("typesafe.calls", 1), 0, "the old flat per-call estimate is gone");
  assert.equal(costOf("verify.sms", 1), 58_300);
  assert.equal(costOf("verify.email", 1), 50_000);
  // Composio and Honcho: counted, at $0 for now.
  assert.equal(costOf("composio.calls", 7, { tool: "GMAIL_SEND_EMAIL" }), 0);
  assert.equal(costOf("honcho.calls", 7, { route: "chat" }), 0);
  assert.equal(costOf("agentphone.plan_numbers", 1), 0);
  assert.equal(costOf("something.new", 5), 0);
});

test("a text is counted in segments: 160 characters, 70 with an emoji, and parts of 153 or 67 past that", () => {
  assert.equal(smsSegments(""), 1);
  assert.equal(smsSegments("hi"), 1);
  assert.equal(smsSegments("a".repeat(160)), 1);
  assert.equal(smsSegments("a".repeat(161)), 2);
  assert.equal(smsSegments("a".repeat(306)), 2);
  assert.equal(smsSegments("a".repeat(307)), 3);
  assert.equal(smsSegments(`${"a".repeat(69)}🙂`), 1);
  assert.equal(smsSegments(`${"a".repeat(70)}🙂`), 2);
  // GSM-7's extension characters take two places.
  assert.equal(smsSegments("€".repeat(80)), 1);
  assert.equal(smsSegments("€".repeat(81)), 2);
});

/* ---------------- The ledger ---------------- */

test("the one-time $5 is given once, even when it's asked for at once", async () => {
  const u = await newUser();
  const left = await Promise.all(Array.from({ length: 6 }, () => creditLeft(u)));
  assert.deepEqual(left, Array(6).fill(5_000_000));
  const grants = (await query("SELECT kind, amount_micros::float8 AS amount FROM public.bops_ai_credit_grants WHERE user_id = $1", [u])).rows;
  assert.deepEqual(grants, [{ kind: "free_signup", amount: 5_000_000 }]);
  await recordUsage(u, "verify.sms", 1);
  assert.equal(await creditLeft(u), 5_000_000 - 58_300);
});

test("a use is paid from this month's plan credit first, then the rest, which may go below 0", async () => {
  const u = await newUser();
  await setCredit(u, { free: 5_000_000, plan: 1_000_000, planEnds: inAMonth() });
  await recordUsage(u, "agentphone.voice_seconds", 600);
  assert.deepEqual(await row(u), { plan: "0", free: "4700000" });
  assert.equal((await usageOf(u, "agentphone.voice_seconds"))[0].cost, 1_300_000);
  // An overrun (a turn already under way) goes below 0; the next grant covers it.
  await recordUsage(u, "agentphone.voice_seconds", 3_000);
  assert.equal(await creditLeft(u), 4_700_000 - 6_500_000);
  // A month that's over counts for nothing.
  await setCredit(u, { free: 0, plan: 9_000_000, planEnds: new Date(Date.now() - 1000) });
  assert.equal(await creditLeft(u), 0);
});

test("use seen more than once is paid once: only what it costs beyond what was paid is taken", async () => {
  const u = await newUser();
  await setCredit(u, { free: 1_000_000 });
  const ref = `rtc_${tag}_seen`;
  const webrtc = { transport: "webrtc" };
  await recordUsageFor(u, "openai.live_seconds", ref, 12, webrtc);
  assert.equal(await creditLeft(u), 1_000_000 - 10_000);
  await recordUsageFor(u, "openai.live_seconds", ref, 30, webrtc);
  assert.equal(await creditLeft(u), 1_000_000 - 25_000);
  // An older, smaller sighting changes nothing.
  await recordUsageFor(u, "openai.live_seconds", ref, 18, webrtc);
  assert.equal(await creditLeft(u), 1_000_000 - 25_000);
  // Sightings at once take turns: one row, paid for once.
  await Promise.all([42, 60, 48].map((s) => recordUsageFor(u, "openai.live_seconds", ref, s, webrtc)));
  const rows = await usageOf(u, "openai.live_seconds");
  assert.equal(rows.length, 1);
  assert.deepEqual([rows[0].units, rows[0].cost], [60, 50_000]);
  assert.equal(await creditLeft(u), 1_000_000 - 50_000);
});

/* ---------------- Through the proxies ---------------- */

test("an agent turn is priced at its session's model, from the turn's own read or its session's stream", async () => {
  const u = await newUser();
  await setCredit(u, { free: 5_000_000 });
  const made = await as(u, "POST", "/proxy/openai/v1/agents/sessions", { agent: { model: "gpt-6.1-sol", instructions: "x" } });
  assert.equal(made.status, 200, made.text);
  const session = made.json.id as string;
  assert.equal((await query("SELECT model FROM bops.cloud_objects WHERE provider = 'openai' AND object_id = $1", [session])).rows[0].model, "gpt-6.1-sol");
  const turn = `turn_${tag}_read`;
  await ownObject(u, "openai", "agent_turn", turn);
  assert.equal((await as(u, "GET", `/proxy/openai/v1/agents/sessions/${session}/turns/${turn}`)).status, 200);
  const read = await until(async () => (await usageOf(u, "openai.tokens")).find((r) => r.detail.ref === turn));
  assert.equal(read.detail.model, "gpt-6.1-sol");
  assert.equal(read.cost, 600 * 2 + 400 * 0.1 + 100 * 10);
  // The stream of the same session.
  assert.equal((await as(u, "GET", `/proxy/openai/v1/agents/sessions/${session}/events`)).status, 200);
  const streamed = await until(async () => (await usageOf(u, "openai.tokens")).find((r) => r.detail.ref === `turn_${session}_E`));
  assert.equal(streamed.cost, 2000 * 2 + 300 * 10);
  // A session whose model the cloud never saw: the dearest model's price.
  const unknown = `asess_${tag}_unknown`;
  await ownObject(u, "openai", "agent_session", unknown);
  assert.equal((await as(u, "GET", `/proxy/openai/v1/agents/sessions/${unknown}/events`)).status, 200);
  const dear = await until(async () => (await usageOf(u, "openai.tokens")).find((r) => r.detail.ref === `turn_${unknown}_E`));
  assert.equal(dear.cost, 2000 * 10 + 300 * 50);
  assert.equal(await creditLeft(u), 5_000_000 - read.cost - streamed.cost - dear.cost);
});

test("with no credit left, calls that spend are refused with 402 before they're sent; reads and hanging up still go", async () => {
  const u = await newUser();
  const session = `asess_${tag}_gate`;
  const live = `rtc_${tag}_gate`;
  await ownObject(u, "openai", "agent_session", session);
  await ownObject(u, "openai", "live_session", live);
  for (const left of [0, -25_000]) {
    await setCredit(u, { free: left });
    const sent = openai.got.length + agentphone.got.length + typesafe.got.length + tregCalls().length;
    for (const [path, body] of [
      ["/proxy/openai/v1/responses", { model: "gpt-6.1-sol", input: "hi" }],
      ["/proxy/openai/v1/agents/sessions", { agent: { model: "gpt-6.1-sol" } }],
      [`/proxy/openai/v1/agents/sessions/${session}/events`, { type: "user.message" }],
      [`/proxy/openai/v1/live/sessions/${live}/accept`, { type: "live" }],
      ["/proxy/agentphone/v1/messages", { agent_id: "a", number_id: "n", to_number: "+14155550100", body: "hi" }],
      ["/proxy/agentphone/v1/numbers", { country: "US", type: "sms" }],
      ["/proxy/typesafe/v1/systemone", { questions: {} }],
      ["/proxy/treg/call/treg.companies.search", { q: "fintech" }],
    ] as const) {
      const r = await as(u, "POST", path, body);
      assert.equal(r.status, 402, `${path}: ${r.text}`);
      assert.deepEqual(r.json, { error: "You're out of AI credit, so your bots have stopped. Upgrade in Settings to keep them going.", code: "ai_credit_empty", upgrade: true });
    }
    assert.equal(openai.got.length + agentphone.got.length + typesafe.got.length + tregCalls().length, sent, "nothing reached a provider");
    assert.equal((await as(u, "GET", `/proxy/openai/v1/agents/sessions/${session}/items`)).status, 200);
    assert.equal((await as(u, "POST", `/proxy/openai/v1/live/sessions/${live}/hangup`)).status, 200);
    assert.equal((await as(u, "POST", `/proxy/openai/v1/live/sessions/${live}/reject`, { status_code: 486 })).status, 200);
  }
  // A call that isn't allowed at all is refused for that, not for the credit.
  assert.equal((await as(u, "POST", "/proxy/openai/v1/files", {})).status, 403);
  // An upgrade counts at once: nothing is kept between calls.
  await query("SELECT public.bops_ai_credit_grant_plan($1, $2, 'pro_bops', 20000000, now(), $3)", [u, `in_${tag}_gate`, inAMonth()]);
  const after = await as(u, "POST", "/proxy/openai/v1/responses", { model: "gpt-6.1-sol", input: "hi" });
  assert.equal(after.status, 200, after.text);
});

test("a treg call may cost at most what's left of the credit", async () => {
  const u = await newUser();
  await setCredit(u, { free: 30_000 });
  assert.equal((await as(u, "POST", "/proxy/treg/call/treg.companies.search", { q: "fintech" }, { "x-treg-route-max-cost": "1" })).status, 200);
  assert.equal(tregCalls().at(-1)!.headers["x-treg-route-max-cost"], "0.030000");
});

test("treg calls at once share what's left: each holds its cap until it's counted, so together they never cost more", async () => {
  const u = await newUser();
  await setCredit(u, { free: 30_000 });
  const before = tregCalls().length;
  // Three at once, each asking for up to $1, with $0.03 left.
  const three = await Promise.all([0, 1, 2].map(() => as(u, "POST", "/proxy/treg/call/treg.companies.slow", { q: "fintech" }, { "x-treg-route-max-cost": "1" })));
  assert.deepEqual(three.map((r) => r.status).sort(), [200, 429, 429]);
  assert.match(three.find((r) => r.status === 429)!.json.error, /using what's left of your AI credit/);
  const caps = tregCalls().slice(before).map((g) => Number(g.headers["x-treg-route-max-cost"]));
  assert.deepEqual(caps, [0.03], "one went, capped at what was left");
  // Counted (at $0 here) and given back: the next one has the room again.
  assert.equal((await as(u, "POST", "/proxy/treg/call/treg.companies.slow", { q: "fintech" }, { "x-treg-route-max-cost": "1" })).status, 200);
  assert.equal(tregCalls().at(-1)!.headers["x-treg-route-max-cost"], "0.030000");
});

test("a number needs credit for its month: an iMessage line's is far more", async () => {
  const u = await newUser();
  await setCredit(u, { free: 4_000_000 });
  const line = await as(u, "POST", "/proxy/agentphone/v1/numbers", { country: "US", type: "imessage", imessageType: "outbound" });
  assert.equal(line.status, 402, line.text);
  assert.equal(line.json.code, "ai_credit_empty");
  const number = await as(u, "POST", "/proxy/agentphone/v1/numbers", { country: "US", areaCode: "415", type: "sms" });
  assert.equal(number.status, 200, number.text);
  const bought = await until(async () => (await usageOf(u, "agentphone.numbers"))[0]);
  assert.equal(bought.cost, 3_000_000);
  assert.equal(await creditLeft(u), 1_000_000);
});

test("texts are paid by segment, sent or received, and a received one once however often it's delivered", async () => {
  const u = await newUser();
  await setCredit(u, { free: 1_000_000 });
  const sent = await as(u, "POST", "/proxy/agentphone/v1/messages", { agent_id: "a", number_id: "n", to_number: "+14155550100", body: "x".repeat(200) });
  assert.equal(sent.status, 200, sent.text);
  const out = await until(async () => (await usageOf(u, "agentphone.sms"))[0]);
  assert.deepEqual([out.units, out.cost, out.detail.direction], [2, 40_000, "out"]);

  const agentId = `ag_${tag}_in`;
  await query("INSERT INTO bops.cloud_agents (agent_id, user_id, secret_sealed) VALUES ($1, $2, $3)", [agentId, u, seal("whsec_in")]);
  const body = JSON.stringify({ event: "agent.message", channel: "sms", agentId, data: { id: "m1", body: "hello there", fromNumber: "+14155550111" } });
  const ts = String(Math.floor(Date.now() / 1000));
  const headers = { "content-type": "application/json", "x-webhook-id": `whd_${tag}`, "x-webhook-timestamp": ts, "x-webhook-signature": `sha256=${createHmac("sha256", "whsec_in").update(`${ts}.${body}`).digest("hex")}` };
  for (let i = 0; i < 2; i++) assert.equal((await fetch(`${cloud.url}/hooks/agentphone`, { method: "POST", headers, body })).status, 200);
  await until(async () => (await usageOf(u, "agentphone.sms")).length === 2);
  const rows = await usageOf(u, "agentphone.sms");
  assert.deepEqual([rows[1].units, rows[1].cost, rows[1].detail.direction], [1, 20_000, "in"]);
  assert.equal(await creditLeft(u), 1_000_000 - 60_000);
});

test("POST /v1/session gives a new user their one-time $5", async () => {
  const u = await newUser();
  assert.equal((await query("SELECT 1 FROM public.bops_ai_credit_grants WHERE user_id = $1", [u])).rowCount, 0);
  const r = await as(u, "POST", "/v1/session");
  assert.equal(r.status, 200, r.text);
  assert.deepEqual((await query("SELECT kind, amount_micros::float8 AS amount FROM public.bops_ai_credit_grants WHERE user_id = $1", [u])).rows, [{ kind: "free_signup", amount: 5_000_000 }]);
  assert.equal((await as(u, "POST", "/v1/session")).status, 200);
  assert.equal(await creditLeft(u), 5_000_000);
});

test("the cloud turns the owner's call away (402) when they're out of credit, instead of answering it", async () => {
  const u = await newUser();
  const line = { phone: newNumber(), numberId: `num_${tag}`, agentId: `agt_${tag}`, type: "sms", scope: "sub", at: 1 };
  const mobile = newNumber();
  const state = {
    owner: { name: "Alex" },
    bots: [{ id: "sam", name: "Sam", role: "Chief of Staff", isMain: true, computerStatus: "none" }],
    workspaces: [{ id: "ws_main", name: "Main", createdAt: 1, line }],
    ownerPhones: [{ number: mobile, consentAt: 1, verifiedAt: 2, userId: u }],
  };
  await query("UPDATE bops.app_state SET state = $2::jsonb WHERE user_id = $1", [u, JSON.stringify(state)]);
  // The owner is who bops.owner_phones says (lines.ts), never the state.
  await query("INSERT INTO bops.owner_phones (orgo_user_id, phone_e164, consent_at, verified_at) VALUES ($1, $2, now(), now()) ON CONFLICT DO NOTHING", [u, mobile]);
  await setCredit(u, { free: 0 });
  const sessionId = `rtc_${tag}_call`;
  const event = {
    type: "live.transport.incoming",
    data: { type: "sip", session_id: sessionId, sip_headers: [{ name: "From", value: `<sip:${mobile}@sip.example.net>` }, { name: "To", value: `<sip:${line.phone}@sip.api.openai.com>` }] },
  };
  const before = openai.got.length;
  await calls.answerInCloud(u, event);
  const controls = openai.got.slice(before).filter((g) => g.path.startsWith(`/v1/live/sessions/${sessionId}/`));
  assert.deepEqual(
    controls.map((g) => [g.path.split("/").pop(), g.json]),
    [["reject", { status_code: 402 }]],
  );
});

test("with AI credit on, the cloud won't start without access to orgo-web's ledger", async () => {
  await checkCreditAccess();
  const run = () =>
    new Promise<{ code: number | null; err: string }>((resolve) => {
      const child = spawn(process.execPath, [fileURLToPath(new URL("../server.ts", import.meta.url))], {
        env: { ...process.env, BOPS_AI_CREDITS: "1", BOPS_DATABASE_URL: TEST_DATABASE_URL, BOPS_CLOUD_PORT: "0" },
        stdio: ["ignore", "ignore", "pipe"],
      });
      let err = "";
      child.stderr.on("data", (d: Buffer) => (err += d.toString()));
      const timer = setTimeout(() => child.kill(), 10_000);
      child.on("exit", (code) => {
        clearTimeout(timer);
        resolve({ code, err });
      });
    });
  // This test database's owner made the ledger, so it takes its own access away for a moment, once no
  // other test file is using the ledger (they hold LEDGER_IN_USE shared while they run).
  const lock = new pg.Client({ connectionString: TEST_DATABASE_URL });
  await lock.connect();
  await lock.query("SELECT pg_advisory_lock(hashtext($1))", [LEDGER_IN_USE]);
  await query("REVOKE UPDATE ON public.bops_ai_credit FROM CURRENT_USER");
  try {
    await assert.rejects(checkCreditAccess(), /BOPS_AI_CREDITS=1/);
    const r = await run();
    assert.equal(r.code, 1);
    assert.match(r.err, /failed to start: .*BOPS_AI_CREDITS=1, but this login can't use public\.bops_ai_credit/);
  } finally {
    await query("GRANT UPDATE ON public.bops_ai_credit TO CURRENT_USER");
    await lock.end();
  }
  await checkCreditAccess();
});
