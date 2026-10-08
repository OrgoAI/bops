import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { after, before, test } from "node:test";
import { closeDb, query } from "../db.ts";
import { costOf } from "../pricing.ts";
import { call, dropUsers, fakeOrgo, fakeProvider, keyOf, newUserId, prepareDb, seedUser, startCloud, until, type Listening, type Reply } from "./core-fakes.ts";

/** /proxy/treg: business data (lib/server/treg.ts) against a fake treg, its catalog and its calls. */

const alice = newUserId("alice");
const users = [alice];
let orgo: Listening, cloud: Listening, treg: Awaited<ReturnType<typeof fakeProvider>>;

/** The fake catalog: a routed endpoint, a GET one, one that needs an account connected to treg, a long-running job, and a hub tool. */
const CATALOG: Record<string, Record<string, unknown>> = {
  "treg.companies.search": { method: "POST", scope: "", kind: "routed", async: null, cost: { usd: 0 } },
  "aviato.companies.funding_rounds": { method: "GET", scope: "any_account", kind: "data", async: null, cost: { usd: 0.01 } },
  "google-analytics.report": { method: "POST", scope: "own_account", kind: "data", async: null, cost: { usd: 0 } },
  "replicate.video-gen.veo-3.1-fast": { method: "POST", scope: "any_account", kind: "data", async: { id_from: "id" }, cost: { usd: 1.2 } },
  "someteam.leadlist": { method: "POST", scope: "any_account", kind: "hub", async: null, cost: { usd: 0.5 } },
  // Answered by a team's own key (no cost to the user, on Orgo's provider bill), and one replaced by another.
  "exa.people.search": { method: "POST", scope: "any_account", kind: "data", async: null, platform_eligible: false, cost: { usd: 0.01 } },
  "old.companies.search": { method: "POST", scope: "", kind: "routed", async: null, superseded_by: "treg.companies.search", cost: { usd: 0 } },
  // One that takes a while to answer, so calls overlap.
  "slow.companies.lookup": { method: "POST", scope: "any_account", kind: "data", async: null, cost: { usd: 0.01 } },
};
const callId = () => `call_${randomUUID().slice(0, 12)}`;

before(async () => {
  await prepareDb();
  for (const u of users) await seedUser(u);
  orgo = await fakeOrgo();
  treg = await fakeProvider(async (g): Promise<Reply> => {
    const entry = /^\/catalog\/endpoints\/([^/]+)$/.exec(g.path);
    if (entry && g.method === "GET") {
      const e = CATALOG[entry[1]];
      return e ? { json: { endpoint: { id: entry[1], ...e }, usd_per_call: (e.cost as { usd: number }).usd } } : { status: 404, json: { detail: "unknown endpoint" } };
    }
    if (g.path === "/call/treg.companies.search") {
      // treg's own refusals, by what the body asks for (a fake's switch).
      if (g.json?.q === "broke") return { status: 402, headers: { "x-treg-error": "1" }, json: { error: "insufficient_balance", balance_micro: 12, topup_url: "https://treg.to/billing" } };
      if (g.json?.q === "dear") return { status: 402, headers: { "x-treg-error": "1", "x-treg-call-id": callId() }, json: { detail: { error: "route_max_cost", max_cost_micro: 100000, charged_micro: 0 } } };
      return { json: { output: { companies: [{ name: "Modal" }] }, raw: {}, _treg: { served_by: "exa.companies.search" } }, headers: { "x-treg-call-id": callId(), "x-treg-cost-micro": "4834", "x-treg-served-by": "exa.companies.search" } };
    }
    if (g.path === "/call/aviato.companies.funding_rounds") return { json: { fundingRounds: [] }, headers: { "x-treg-call-id": callId(), "x-treg-cost-micro": "10000" } };
    if (g.path === "/call/slow.companies.lookup") {
      await new Promise((r) => setTimeout(r, 300));
      return { json: { companies: [] }, headers: { "x-treg-call-id": callId(), "x-treg-cost-micro": "10000" } };
    }
    return { status: 418 };
  });
  Object.assign(process.env, { TREG_TOKEN: "treg-test-token", BOPS_UPSTREAM_TREG: treg.url });
  cloud = await startCloud();
});

after(async () => {
  await dropUsers(users);
  await Promise.all([cloud, orgo, treg].map((s) => s?.close()));
  await closeDb();
});

const as = (method: string, path: string, json?: unknown, headers?: Record<string, string>) => call(cloud.url, method, path, { key: keyOf(alice), json, headers });

const rows = async () =>
  (await query<{ units: number; cost: number; detail: Record<string, unknown> }>("SELECT units::float8 AS units, cost_micros::float8 AS cost, detail FROM bops.cloud_usage WHERE user_id = $1 AND kind = 'treg.calls' ORDER BY id", [alice])).rows;

test("a session says treg is on when the cloud has a token", async () => {
  const r = await call(cloud.url, "POST", "/v1/session", { key: keyOf(alice) });
  assert.equal(r.status, 200, r.text);
  assert.equal(r.json.treg, true);
});

test("a catalog call goes on with the cloud's token, tagged with the user and bot by the cloud, capped, and counted at what treg charged", async () => {
  const before = (await rows()).length;
  const r = await as("POST", "/proxy/treg/call/treg.companies.search", { q: "AI infra in NYC", limit: 3 }, {
    "x-bops-bot": "sam",
    "x-treg-route-max-cost": "0.25",
    "x-treg-route-exclude": "tomba",
    // What the Mac must never set: the token and the tags are the cloud's.
    "x-treg-token": "mac-token",
    "x-treg-meta": "customer=someone-else",
  });
  assert.equal(r.status, 200, r.text);
  assert.deepEqual(r.json.output, { companies: [{ name: "Modal" }] });
  const sent = treg.got.filter((g) => g.path.startsWith("/call/")).at(-1)!;
  assert.equal(sent.headers["x-treg-token"], "treg-test-token");
  assert.equal(sent.headers["x-treg-meta"], `customer=${alice}, bot=sam`);
  assert.equal(sent.headers["x-treg-route-max-cost"], "0.250000");
  assert.equal(sent.headers["x-treg-route-exclude"], "tomba");
  assert.equal(sent.headers["x-bops-bot"], undefined, "who it's for stays in the cloud");
  assert.equal(sent.headers.authorization, undefined, "the user's Orgo key never goes on");
  assert.deepEqual(sent.json, { q: "AI infra in NYC", limit: 3 });
  const [row] = (await until(async () => (await rows()).length > before && (await rows()))).slice(before);
  assert.deepEqual([row.units, row.cost, row.detail.endpoint, row.detail.botId, row.detail.servedBy], [1, 4834, "treg.companies.search", "sam", "exa.companies.search"]);
});

test("the cap is at most $5, and $0.10 when the Mac doesn't say; a GET takes its inputs in the query", async () => {
  assert.equal((await as("GET", "/proxy/treg/call/aviato.companies.funding_rounds?website=modal.com&perPage=10&page=0", undefined, { "x-treg-route-max-cost": "50" })).status, 200);
  let sent = treg.got.filter((g) => g.path.startsWith("/call/")).at(-1)!;
  assert.equal(sent.headers["x-treg-route-max-cost"], "5.000000");
  assert.equal(sent.query.get("website"), "modal.com");
  assert.equal((await as("GET", "/proxy/treg/call/aviato.companies.funding_rounds?website=modal.com")).status, 200);
  sent = treg.got.filter((g) => g.path.startsWith("/call/")).at(-1)!;
  assert.equal(sent.headers["x-treg-route-max-cost"], "0.100000");
});

test("only catalog endpoints on treg's own keys: never a team's tools, an account connected to treg, a long-running job, a hub tool, or Orgo's team", async () => {
  const calls = () => treg.got.filter((g) => g.path.startsWith("/call/") || g.path.startsWith("/orgs") || g.path.startsWith("/billing")).length;
  const sent = calls();
  const refused: [string, string, number][] = [
    ["POST", "/proxy/treg/call/google-analytics.report", 403],
    ["POST", "/proxy/treg/call/replicate.video-gen.veo-3.1-fast", 403],
    ["POST", "/proxy/treg/call/someteam.leadlist", 404],
    // On a team's own key, or replaced: what the app won't call, the cloud won't pass on either.
    ["POST", "/proxy/treg/call/exa.people.search", 403],
    ["POST", "/proxy/treg/call/old.companies.search", 403],
    ["POST", "/proxy/treg/call/nope.nothing", 404],
    // The method must be the endpoint's.
    ["GET", "/proxy/treg/call/treg.companies.search", 405],
    // A team's own tool (/call/<tool>/<path>) or a URL.
    ["GET", "/proxy/treg/call/exa/search", 403],
    ["GET", "/proxy/treg/call/https:/api.exa.ai/search", 400],
    // Anything about Orgo's treg team, and the catalog itself (the Mac reads that from treg directly).
    ["GET", "/proxy/treg/orgs/1/balance", 403],
    ["POST", "/proxy/treg/billing/topup", 403],
    ["GET", "/proxy/treg/calls", 403],
    ["GET", "/proxy/treg/catalog/search", 403],
  ];
  for (const [method, path, status] of refused) assert.equal((await as(method, path, method === "POST" ? {} : undefined)).status, status, `${method} ${path}`);
  assert.equal(calls(), sent, "nothing refused reached treg");
});

test("treg's refusals about Orgo's own balance never reach the Mac; one about the call's cap does", async () => {
  const broke = await as("POST", "/proxy/treg/call/treg.companies.search", { q: "broke" });
  assert.equal(broke.status, 503);
  assert.equal(broke.json.code, "treg_unavailable");
  assert.ok(!broke.text.includes("topup") && !broke.text.includes("balance"), broke.text);
  const dear = await as("POST", "/proxy/treg/call/treg.companies.search", { q: "dear" });
  assert.equal(dear.status, 402);
  assert.equal(dear.json.detail.error, "route_max_cost");
});

test("a treg call is priced at what treg charged", () => {
  assert.equal(costOf("treg.calls", 1, { costMicro: 4834 }), 4834);
  assert.equal(costOf("treg.calls", 1, { costMicro: 0 }), 0);
  assert.equal(costOf("treg.calls", 1, {}), 0);
});

test("three lookups at a time per user, each holding its cap until it's counted; then room again", async () => {
  const sent = treg.got.filter((g) => g.path === "/call/slow.companies.lookup").length;
  const four = await Promise.all([0, 1, 2, 3].map(() => as("POST", "/proxy/treg/call/slow.companies.lookup", { domain: "modal.com" })));
  assert.deepEqual(four.map((r) => r.status).sort(), [200, 200, 200, 429]);
  assert.match(four.find((r) => r.status === 429)!.json.error, /Too many business data lookups at once/);
  assert.equal(treg.got.filter((g) => g.path === "/call/slow.companies.lookup").length, sent + 3, "the fourth never reached treg");
  // All counted and given back: a next one goes.
  assert.equal((await as("POST", "/proxy/treg/call/slow.companies.lookup", { domain: "modal.com" })).status, 200);
});

test("a replay key goes on as the user's own: one token for every user, so theirs never meet", async () => {
  assert.equal((await as("POST", "/proxy/treg/call/treg.companies.search", { q: "fintech" }, { "idempotency-key": "k-1" })).status, 200);
  const key = treg.got.filter((g) => g.path === "/call/treg.companies.search").at(-1)!.headers["idempotency-key"];
  assert.equal(key, `${alice.replace(/[^A-Za-z0-9._:-]/g, "_")}:k-1`);
});
