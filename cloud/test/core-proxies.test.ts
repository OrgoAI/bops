import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { after, before, test } from "node:test";
import { Composio } from "@composio/core";
import { Honcho } from "@honcho-ai/sdk";
import { open } from "../crypto.ts";
import { closeDb, objectOwner, query } from "../db.ts";
import { honchoPrefix } from "../session.ts";
import { call, dropUsers, fakeOrgo, fakeProvider, keyOf, newNumber, newUserId, prepareDb, rawCall, seedUser, startCloud, until, type Listening } from "./core-fakes.ts";

/** /proxy/agentphone, /proxy/honcho (and the Honcho SDK at /v3), /proxy/composio and /proxy/typesafe, against fakes. */

const tag = randomUUID().slice(0, 8);
const alice = newUserId("alice");
const bob = newUserId("bob");
const noPhone = newUserId("nophone");
/** A user whose id is the start of another's ("…" and "…-y"): neither reaches the other's Honcho workspaces. */
const short = newUserId("x");
const long = `${short}-y`;
const users = [alice, bob, noPhone, short, long];
const sub = (userId: string) => `sub_${userId}`;
const ws = (userId: string) => `${honchoPrefix(userId)}-bops`;

let orgo: Listening, cloud: Listening;
let agentphone: Awaited<ReturnType<typeof fakeProvider>>, honcho: Awaited<ReturnType<typeof fakeProvider>>;
let composio: Awaited<ReturnType<typeof fakeProvider>>, typesafe: Awaited<ReturnType<typeof fakeProvider>>;
const numbers = [newNumber(), newNumber(), newNumber()];
const agent = `ag_${tag}`;
let n = 0;
const now = new Date().toISOString();
/** A connected account as Composio answers it, with its tokens and key in it (the cloud masks them). */
const account = (id: string, userId: string) => ({
  id,
  user_id: `bops-${userId}`,
  status: "ACTIVE",
  status_reason: null,
  toolkit: { slug: "gmail" },
  auth_config: { id: "ac_1", auth_scheme: "OAUTH2", is_composio_managed: true, is_disabled: false },
  data: { access_token: `tok-${id}`, refresh_token: `ref-${id}`, id_token: `head.${Buffer.from(JSON.stringify({ email: `${userId}@mail.test` })).toString("base64url")}.sig`, email: `${userId}@mail.test` },
  state: { authScheme: "OAUTH2", val: { status: "ACTIVE", access_token: `tok-${id}`, refresh_token: `ref-${id}`, token_type: "Bearer", expires_in: 3600, secret_key: `sk-${id}` } },
  params: {
    api_key: `key-${id}`,
    authed_user: { id: "U1", access_token: `user-tok-${id}` },
    credentials_json: `{"private_key":"pk-${id}"}`,
    // Key-based sign-ins (AWS, Supabase, OAuth 1 apps) name theirs other ways; the region isn't a secret.
    secret_access_key: `sak-${id}`,
    "Access-Key-Id": `akid-${id}`,
    consumer_key: `ck-${id}`,
    service_role_key: `srk-${id}`,
    key: `bare-${id}`,
    region: "us-east-1",
  },
  is_disabled: false,
  created_at: now,
  updated_at: now,
});
const accounts = [account(`ca_${tag}_alice`, alice), account(`ca_${tag}_bob`, bob)];
/** Every secret the accounts above carry: none may reach a Mac. */
const tokensOf = (id: string) => [`tok-${id}`, `ref-${id}`, `key-${id}`, `user-tok-${id}`, `pk-${id}`, "head.", `sak-${id}`, `akid-${id}`, `ck-${id}`, `srk-${id}`, `bare-${id}`, `sk-${id}`];

/**
 * The project's sign-in setups in the fake Composio: Composio's own Gmail one, Orgo's Slack app
 * (custom, with Orgo's credentials, pinned by BOPS_COMPOSIO_AUTH_CONFIGS), one made in the dashboard
 * for something else, and whatever is made through the cloud.
 */
const signIns: Record<string, unknown>[] = [
  { id: "ac_1", name: "Gmail", type: "default", status: "ENABLED", toolkit: { slug: "gmail", logo: "" }, auth_scheme: "OAUTH2", is_composio_managed: true, no_of_connections: 9 },
  {
    id: "ac_slack",
    name: "Slack (Bops)",
    type: "custom",
    status: "ENABLED",
    toolkit: { slug: "slackbot", logo: "" },
    auth_scheme: "OAUTH2",
    is_composio_managed: false,
    credentials: { client_id: "bops-slack", client_secret: "orgo-secret" },
    proxy_config: { proxy_url: "https://proxy.test", proxy_auth_key: "orgo-proxy-key" },
    shared_credentials: { token: "orgo-shared" },
    created_by: "admin@orgo.ai",
    no_of_connections: 3,
  },
  { id: "ac_other", name: "Someone's own Gmail app", type: "custom", status: "ENABLED", toolkit: { slug: "gmail", logo: "" }, auth_scheme: "OAUTH2", is_composio_managed: false, credentials: { client_id: "theirs", client_secret: "their-secret" }, no_of_connections: 1 },
];

before(async () => {
  await prepareDb();
  for (const u of users) await seedUser(u, u === noPhone ? {} : { subAccount: sub(u) });
  orgo = await fakeOrgo();
  agentphone = await fakeProvider((g) => {
    if (g.method === "GET" && g.path === "/v1/numbers") return { json: { data: [{ id: `num_${tag}_1`, phoneNumber: numbers[0], type: "sms" }], hasMore: false, total: 1 } };
    if (g.method === "POST" && g.path === "/v1/numbers") return { json: { id: `num_${tag}_2`, phoneNumber: numbers[1], type: "sms", status: "active" } };
    if (g.method === "GET" && g.path === "/v1/agents") return { json: { data: [{ id: agent, name: "Sam", numbers: [{ id: `num_${tag}_3`, phoneNumber: numbers[2] }] }], total: 1 } };
    const hook = /^\/v1\/agents\/([^/]+)\/webhook$/.exec(g.path);
    if (hook && g.method === "POST") return { json: { id: "wh_1", url: g.json.url, secret: "whsec_agent", status: "active", contextLimit: g.json.contextLimit, timeout: 30 } };
    if (hook && g.method === "GET") return { json: { id: "wh_1", url: "https://bops-api.test/hooks/agentphone", secret: "whsec_agent", status: "active" } };
    if (g.method === "GET" && g.path === "/v1/sip-trunks")
      return {
        json: {
          data: [
            {
              id: "tr_1",
              name: "bops",
              terminationSipUri: "sip:out",
              credentials: [{ username: "u", password: "p" }],
              originationUris: [{ sip_uri: "sip:proj_secret@sip.api.openai.com;transport=tls" }],
            },
          ],
        },
      };
    // Another country's number with the same last 10 digits as one of Alice's.
    if (g.method === "GET" && g.path === "/v1/numbers/num_abroad") return { json: { id: "num_abroad", phoneNumber: `+44${numbers[0].slice(-10)}` } };
    if (g.method === "POST" && g.path === "/v1/messages") return { json: { id: "msg_1", status: "queued" } };
    if (g.method === "POST" && /^\/v1\/agents\/[^/]+\/numbers$/.test(g.path)) return { json: { id: agent, name: "Sam", numbers: [] } };
    return { status: 418 };
  });
  honcho = await fakeProvider((g) => {
    if (g.method === "POST" && g.path === "/v3/workspaces") return { json: { id: g.json.id, metadata: {}, configuration: {}, created_at: now } };
    if (g.method === "POST" && g.path === "/v3/workspaces/list")
      return { json: { items: [ws(alice), ws(bob), "someone-else"].map((id) => ({ id, metadata: {}, configuration: {}, created_at: now })), total: 3, page: 1, size: 50, pages: 1 } };
    const peers = /^\/v3\/workspaces\/([^/]+)\/peers$/.exec(g.path);
    if (peers && g.method === "POST") return { json: { id: g.json.id, workspace_id: peers[1], metadata: {}, configuration: {}, created_at: now } };
    if (g.path.startsWith("/v3/workspaces/")) return { json: { ok: true } };
    return { status: 418 };
  });
  composio = await fakeProvider((g) => {
    const p = g.path.replace(/^\/api\/v3\.1/, "");
    // The list ignores its filters: what comes back to the Mac is the cloud's doing.
    if (g.method === "GET" && p === "/connected_accounts") return { json: { items: accounts, next_cursor: null, total_pages: 1, current_page: 1 } };
    if (g.method === "POST" && p === "/connected_accounts")
      return { status: 201, json: { id: `ca_${tag}_new${++n}`, status: "INITIATED", connectionData: { authScheme: "OAUTH2", val: { status: "INITIATED", redirectUrl: "https://connect.test" } } } };
    if (g.method === "POST" && p === "/connected_accounts/link") return { status: 201, json: { connected_account_id: `ca_${tag}_link${++n}`, redirect_url: "https://connect.test" } };
    const ca = /^\/connected_accounts\/([^/]+)$/.exec(p);
    if (ca && g.method === "GET") return { json: account(ca[1], alice) };
    if (ca && g.method === "DELETE") return { json: { success: true } };
    if (g.method === "POST" && p === "/tool_router/session") return { status: 201, json: { session_id: `trs_${tag}_${++n}`, mcp: { type: "http", url: "https://mcp.test" }, config: { user_id: g.json.user_id } } };
    const s = /^\/tool_router\/session\/([^/]+)(?:\/(search|execute))?$/.exec(p);
    if (s && !s[2] && g.method === "GET") return { json: { session_id: s[1], mcp: { type: "http", url: "https://mcp.test" }, config: { user_id: `bops-${alice}` } } };
    if (s?.[2] === "search")
      return {
        json: {
          results: [],
          success: true,
          error: null,
          tool_schemas: {},
          toolkit_connection_statuses: [],
          next_steps_guidance: [],
          session: { id: s[1], generate_id: false, instructions: "" },
          time_info: { current_time_utc: now, current_time_utc_epoch_seconds: 0, message: "" },
        },
      };
    if (s?.[2] === "execute") return { json: { data: { ok: true }, error: null, log_id: "l1" } };
    // Apps Composio signs people in to itself, and apps where each person types their own key.
    const tk = /^\/toolkits\/([^/]+)$/.exec(p);
    if (g.method === "GET" && tk?.[1] === "nobody-knows") return { status: 404, json: { error: { message: "Toolkit not found" } } };
    if (g.method === "GET" && tk)
      return { json: { slug: tk[1], name: tk[1], meta: { tools_count: 3 }, composio_managed_auth_schemes: ["gmail", "notion", "linear", "slackbot"].includes(tk[1]) ? ["OAUTH2"] : [], auth_config_details: [{ name: "Key", mode: "API_KEY" }] } };
    if (g.method === "GET" && /^\/(tools|triggers_types)\/[^/]+$/.test(p)) return { json: { slug: p.split("/")[2], name: "Thing", tags: [], toolkit: { slug: "slackbot", name: "Slack", logo: "" } } };
    if (g.method === "GET" && p === "/toolkits") return { json: { items: [{ slug: "gmail", name: "Gmail" }], next_cursor: null, total_pages: 1 } };
    if (g.method === "GET" && p === "/auth_configs") return { json: { items: signIns, next_cursor: null, total_pages: 1 } };
    const signIn = /^\/auth_configs\/([^/]+)$/.exec(p);
    if (signIn && g.method === "GET") {
      const found = signIns.find((a) => a.id === signIn[1]);
      return found ? { json: found } : { status: 404, json: { error: { message: "Auth config not found" } } };
    }
    if (g.method === "POST" && p === "/auth_configs") {
      const managed = g.json.auth_config.type === "use_composio_managed_auth";
      const made = { id: `ac_${tag}_made${++n}`, name: g.json.auth_config.name ?? "", type: managed ? "default" : "custom", status: "ENABLED", toolkit: { slug: g.json.toolkit.slug, logo: "" }, auth_scheme: managed ? "OAUTH2" : g.json.auth_config.authScheme, is_composio_managed: managed, no_of_connections: 0 };
      signIns.push(made);
      return { status: 201, json: { toolkit: { slug: g.json.toolkit.slug }, auth_config: { id: made.id, auth_scheme: made.auth_scheme, is_composio_managed: managed } } };
    }
    if (g.method === "POST" && p === "/tools/execute/proxy") return { json: { data: { ok: true }, status: 200, headers: {} } };
    if (g.method === "POST" && /^\/tools\/execute\/[^/]+$/.test(p)) return { json: { data: { ok: true }, error: null, successful: true, log_id: "l2" } };
    if (g.method === "GET" && p === "/trigger_instances/active")
      return {
        json: {
          items: [alice, bob].map((u) => ({ id: `ti_${u}`, connected_account_id: `ca_${tag}_${u === alice ? "alice" : "bob"}`, user_id: `bops-${u}`, trigger_name: "SLACKBOT_CHANNEL_MESSAGE_RECEIVED", trigger_config: {} })),
          next_cursor: null,
          total_pages: 1,
        },
      };
    if (g.method === "POST" && /^\/trigger_instances\/[^/]+\/upsert$/.test(p)) return { json: { trigger_id: `ti_${tag}` } };
    return { status: 418 };
  });
  typesafe = await fakeProvider((g) => (g.method === "POST" && g.path === "/v1/systemone" ? { json: { answers: { memory: { type: "noul", noul: 0.9 } } } } : { status: 418 }));
  Object.assign(process.env, {
    AGENTPHONE_API_KEY: "ap-test-key",
    HONCHO_API_KEY: "honcho-test-key",
    COMPOSIO_API_KEY: "composio-test-key",
    BOPS_COMPOSIO_AUTH_CONFIGS: "ac_slack, ac_pinned_elsewhere",
    TYPESAFE_API_KEY: "typesafe-test-key",
    BOPS_UPSTREAM_AGENTPHONE: agentphone.url,
    BOPS_UPSTREAM_HONCHO: honcho.url,
    BOPS_UPSTREAM_COMPOSIO: composio.url,
    BOPS_UPSTREAM_TYPESAFE: typesafe.url,
  });
  cloud = await startCloud();
});

after(async () => {
  await query("DELETE FROM bops.cloud_agents WHERE agent_id = $1", [agent]);
  await dropUsers(users);
  await Promise.all([cloud, orgo, agentphone, honcho, composio, typesafe].map((s) => s?.close()));
  await closeDb();
});

const as = (userId: string, method: string, path: string, json?: unknown, headers?: Record<string, string>) => call(cloud.url, method, path, { key: keyOf(userId), json, headers });

/* ---------------- AgentPhone ---------------- */

test("AgentPhone: every call acts in the user's own sub-account, whatever the Mac sends", async () => {
  const r = await as(alice, "POST", "/proxy/agentphone/v1/messages", { agent_id: agent, to_number: "+14155550000", body: "hi" }, { "x-sub-account-id": sub(bob) });
  assert.equal(r.status, 200, r.text);
  const sent = agentphone.got.at(-1)!;
  assert.equal(sent.headers["x-sub-account-id"], sub(alice));
  assert.equal(sent.headers.authorization, "Bearer ap-test-key");
  assert.deepEqual(sent.json, { agent_id: agent, to_number: "+14155550000", body: "hi" });
});

test("AgentPhone: naming a sub-account in the query or the body is refused", async () => {
  assert.equal((await as(alice, "GET", `/proxy/agentphone/v1/numbers?sub_account_id=${sub(bob)}`)).status, 400);
  assert.equal((await as(alice, "POST", "/proxy/agentphone/v1/messages", { body: "hi", subAccountId: sub(bob) })).status, 400);
  assert.equal((await as(alice, "POST", "/proxy/agentphone/v1/messages", { body: "hi", meta: { SUB_ACCOUNT_ID: sub(bob) } })).status, 400);
});

test("AgentPhone: a webhook registration points at the cloud, and its secret stays here, sealed", async () => {
  const r = await as(alice, "POST", `/proxy/agentphone/v1/agents/${agent}/webhook`, { url: "https://somewhere.example/hook", contextLimit: 5 });
  assert.equal(r.status, 200, r.text);
  assert.deepEqual(agentphone.got.at(-1)!.json, { url: "https://bops-api.test/hooks/agentphone", contextLimit: 5 });
  assert.equal(r.json.secret, "kept-by-cloud");
  assert.ok(!r.text.includes("whsec_agent"));
  const row = (await query("SELECT user_id, secret_sealed FROM bops.cloud_agents WHERE agent_id = $1", [agent])).rows[0];
  assert.equal(row.user_id, alice);
  assert.equal(open(row.secret_sealed), "whsec_agent");
  const read = await as(alice, "GET", `/proxy/agentphone/v1/agents/${agent}/webhook`);
  assert.equal(read.json.secret, "kept-by-cloud");
});

test("AgentPhone: numbers in every answer that lists or makes them are recorded as the user's", async () => {
  assert.equal((await as(alice, "GET", "/proxy/agentphone/v1/numbers?limit=100")).status, 200);
  assert.equal((await as(alice, "POST", "/proxy/agentphone/v1/numbers", { country: "US", areaCode: "415" })).status, 200);
  assert.equal((await as(alice, "GET", "/proxy/agentphone/v1/agents?limit=100")).status, 200);
  const rows = (await query("SELECT digits, user_id, e164 FROM bops.cloud_numbers WHERE digits = ANY($1::text[]) ORDER BY e164", [numbers.map((x) => x.slice(-10))])).rows;
  assert.deepEqual(
    rows.map((r) => [r.digits, r.user_id]),
    [...numbers].sort().map((x) => [x.slice(-10), alice]),
  );
  const bought = await until(async () => (await query("SELECT units::float8 AS units, cost_micros::float8 AS cost FROM bops.cloud_usage WHERE user_id = $1 AND kind = 'agentphone.numbers'", [alice])).rows[0]);
  assert.deepEqual(bought, { units: 1, cost: 3_000_000 });
});

test("AgentPhone: a number bought is a line whose first caller in 15 minutes claims it; one attached is a line with no window", async () => {
  assert.equal((await as(alice, "POST", "/proxy/agentphone/v1/numbers", { country: "US", areaCode: "415" })).status, 200);
  const bought = (await query("SELECT user_id, number_id, owner_number, claim_until > now() + interval '14 minutes' AS open FROM bops.phone_lines WHERE digits = $1", [numbers[1].slice(-10)])).rows[0];
  assert.deepEqual(bought, { user_id: alice, number_id: `num_${tag}_2`, owner_number: null, open: true });
  // Listed first (so the cloud knows it's hers), then attached to an agent.
  assert.equal((await as(alice, "GET", "/proxy/agentphone/v1/numbers")).status, 200);
  assert.equal((await as(alice, "POST", `/proxy/agentphone/v1/agents/${agent}/numbers`, { numberId: `num_${tag}_1` })).status, 200);
  const attached = (await query("SELECT user_id, owner_number, claim_until FROM bops.phone_lines WHERE digits = $1", [numbers[0].slice(-10)])).rows[0];
  assert.deepEqual(attached, { user_id: alice, owner_number: null, claim_until: null });
  // Another user's number id attached through Bob's sub-account isn't made his line here.
  assert.equal((await as(bob, "POST", `/proxy/agentphone/v1/agents/${agent}/numbers`, { numberId: `num_${tag}_2` })).status, 200);
  assert.equal((await query("SELECT user_id FROM bops.phone_lines WHERE digits = $1", [numbers[1].slice(-10)])).rows[0].user_id, alice);
});

test("AgentPhone: routes the app doesn't use never reach AgentPhone", async () => {
  const before = agentphone.got.length;
  for (const [method, path] of [
    ["GET", "/v1/sub-accounts"],
    ["POST", "/v1/sub-accounts"],
    ["DELETE", `/v1/sub-accounts/${sub(bob)}`],
    ["POST", "/v1/sip-trunks"],
    ["PATCH", "/v1/sip-trunks/tr_1"],
    ["POST", "/v1/webhooks"],
    ["POST", "/v1/calls"],
    ["POST", "/v1/register"],
    ["DELETE", `/v1/numbers/num_${tag}_1`],
    ["GET", "/v1/usage"],
    ["POST", "/integrations/whatsapp/connect"],
  ])
    assert.equal((await as(alice, method, `/proxy/agentphone${path}`, method === "GET" ? undefined : {})).status, 403, `${method} ${path}`);
  assert.equal(agentphone.got.length, before);
});

test("AgentPhone: a SIP trunk's credentials and addresses never reach the Mac", async () => {
  const r = await as(alice, "GET", "/proxy/agentphone/v1/sip-trunks");
  assert.equal(r.status, 200);
  assert.deepEqual(r.json, { data: [{ id: "tr_1", name: "bops" }] });
});

test("AgentPhone: another country's number with the same last 10 digits never takes over a user's", async () => {
  assert.equal((await as(alice, "GET", "/proxy/agentphone/v1/numbers")).status, 200);
  assert.equal((await as(bob, "GET", "/proxy/agentphone/v1/numbers/num_abroad")).status, 200);
  const row = (await query("SELECT user_id FROM bops.cloud_numbers WHERE digits = $1", [numbers[0].slice(-10)])).rows[0];
  assert.equal(row.user_id, alice);
});

test("AgentPhone: a user without a sub-account can't use it yet", async () => {
  assert.equal((await as(noPhone, "GET", "/proxy/agentphone/v1/numbers")).status, 409);
});

/* ---------------- Honcho ---------------- */

test("Honcho: the unchanged SDK works at the cloud's root, in the user's own workspaces only", async () => {
  const mine = new Honcho({ apiKey: keyOf(alice), baseURL: cloud.url, workspaceId: ws(alice), maxRetries: 0 });
  const peer = await mine.peer("user");
  assert.equal(peer.id, "user");
  const [made, peered] = honcho.got.slice(-2);
  assert.deepEqual([made.path, made.json.id], ["/v3/workspaces", ws(alice)]);
  assert.equal(peered.path, `/v3/workspaces/${ws(alice)}/peers`);
  assert.equal(peered.headers.authorization, "Bearer honcho-test-key");
  const theirs = new Honcho({ apiKey: keyOf(alice), baseURL: cloud.url, workspaceId: ws(bob), maxRetries: 0 });
  await assert.rejects(theirs.peer("user"));
  // The same under /proxy/honcho.
  assert.equal((await as(alice, "POST", `/proxy/honcho/v3/workspaces/${ws(alice)}/peers`, { id: "user" })).status, 200);
});

test("Honcho: another user's workspace is refused in the path, the body and the query", async () => {
  const before = honcho.got.length;
  assert.equal((await as(alice, "POST", `/v3/workspaces/${ws(bob)}/peers`, { id: "user" })).status, 403);
  assert.equal((await as(alice, "GET", `/proxy/honcho/v3/workspaces/${ws(bob)}/sessions/s1/context`)).status, 403);
  assert.equal((await as(alice, "DELETE", `/proxy/honcho/v3/workspaces/${ws(bob)}`)).status, 403);
  assert.equal((await as(alice, "POST", "/proxy/honcho/v3/workspaces", { id: ws(bob) })).status, 403);
  assert.equal((await as(alice, "POST", "/proxy/honcho/v3/workspaces", {})).status, 403);
  assert.equal((await as(alice, "POST", `/proxy/honcho/v3/workspaces/${ws(alice)}/sessions/list`, { filters: { workspace_id: ws(bob) } })).status, 403);
  // A JSON body that says it's something else is still read as JSON.
  assert.equal((await as(alice, "POST", `/proxy/honcho/v3/workspaces/${ws(alice)}/sessions/list`, { filters: { workspace_id: ws(bob) } }, { "content-type": "text/plain" })).status, 403);
  assert.equal((await as(alice, "GET", `/proxy/honcho/v3/workspaces/${ws(alice)}/queue/status?workspace_id=${ws(bob)}`)).status, 403);
  assert.equal(honcho.got.length, before);
});

test("Honcho: a user id that's the start of another's never reaches the other's workspaces", async () => {
  assert.equal((await as(short, "POST", "/proxy/honcho/v3/workspaces", { id: ws(long) })).status, 403);
  assert.equal((await as(short, "POST", `/proxy/honcho/v3/workspaces/${ws(long)}/peers`, { id: "user" })).status, 403);
  assert.equal((await as(long, "POST", `/proxy/honcho/v3/workspaces/${ws(short)}/peers`, { id: "user" })).status, 403);
  assert.equal((await as(short, "POST", `/proxy/honcho/v3/workspaces/${ws(short)}/peers`, { id: "user" })).status, 200);
});

test("Honcho: the workspace list shows only the user's own", async () => {
  const r = await as(alice, "POST", "/proxy/honcho/v3/workspaces/list", { filters: {} });
  assert.equal(r.status, 200);
  assert.deepEqual(r.json.items.map((w: { id: string }) => w.id), [ws(alice)]);
  assert.equal(r.json.total, 1);
});

test("Honcho: routes outside the user's workspaces are refused", async () => {
  assert.equal((await as(alice, "POST", "/proxy/honcho/v3/keys", {})).status, 403);
  assert.equal((await as(alice, "GET", "/proxy/honcho/v3/workspaces")).status, 403);
  assert.equal((await as(alice, "GET", "/v3/workspaces/list")).status, 403);
  assert.equal((await as(alice, "POST", "/proxy/honcho/v2/apps", {})).status, 403);
  assert.equal((await rawCall(cloud.url, "GET", `/v3/workspaces/${ws(alice)}/../${ws(bob)}/peers`, keyOf(alice))).status, 400);
});

/* ---------------- Composio ---------------- */

test("Composio: the list of connected accounts is always the user's own", async () => {
  const r = await as(alice, "GET", "/proxy/composio/api/v3.1/connected_accounts?statuses=ACTIVE");
  assert.equal(r.status, 200, r.text);
  const sent = composio.got.at(-1)!;
  assert.equal(sent.query.get("user_ids"), `bops-${alice}`);
  assert.equal(sent.headers["x-api-key"], "composio-test-key");
  assert.deepEqual(r.json.items.map((a: { id: string }) => a.id), [`ca_${tag}_alice`]);
  // Its tokens and key stay with Composio; the account's own name doesn't.
  for (const secret of tokensOf(`ca_${tag}_alice`)) assert.ok(!r.text.includes(secret), secret);
  assert.equal(r.json.items[0].data.email, `${alice}@mail.test`);
  assert.equal(r.json.items[0].state.val.token_type, "Bearer");
  assert.equal(await objectOwner("composio", `ca_${tag}_alice`), alice);
  assert.equal(await objectOwner("composio", `ca_${tag}_bob`), null);
  for (const q of [`user_ids=bops-${bob}`, `user_ids=bops-${alice},bops-${bob}`, `user_ids=bops-${alice}&user_ids=bops-${bob}`, `USER_IDS=bops-${bob}`, `user_ids%5B%5D=bops-${bob}`, "account_type=SHARED"])
    assert.equal((await as(alice, "GET", `/proxy/composio/api/v3.1/connected_accounts?${q}`)).status, 403, q);
  assert.equal((await as(alice, "GET", `/proxy/composio/api/v3.1/connected_accounts?connected_account_ids=ca_${tag}_bob`)).status, 404);
});

test("Composio: a connected account made for the user is theirs, and nobody else's", async () => {
  const made = await as(alice, "POST", "/proxy/composio/api/v3.1/connected_accounts", { auth_config: { id: "ac_1" }, connection: {} });
  assert.equal(made.status, 201, made.text);
  assert.equal(composio.got.at(-1)!.json.connection.user_id, `bops-${alice}`);
  assert.equal(await objectOwner("composio", made.json.id), alice);
  const read = await as(alice, "GET", `/proxy/composio/api/v3.1/connected_accounts/${made.json.id}`);
  assert.equal(read.status, 200);
  assert.deepEqual(
    [read.json.data.access_token, read.json.data.refresh_token, read.json.data.id_token, read.json.state.val.access_token, read.json.params.api_key, read.json.params.authed_user.access_token, read.json.params.credentials_json],
    Array(7).fill("masked"),
    "every token and key masked where it is",
  );
  const { secret_access_key, "Access-Key-Id": accessKeyId, consumer_key, service_role_key, key, region } = read.json.params;
  assert.deepEqual([read.json.state.val.secret_key, secret_access_key, accessKeyId, consumer_key, service_role_key, key], Array(6).fill("masked"), "keys under other names are masked too");
  assert.equal(region, "us-east-1", "what isn't a secret stays");
  assert.equal(read.json.data.email, `${alice}@mail.test`);
  assert.equal((await as(bob, "GET", `/proxy/composio/api/v3.1/connected_accounts/${made.json.id}`)).status, 404);
  assert.equal((await as(bob, "DELETE", `/proxy/composio/api/v3.1/connected_accounts/${made.json.id}`)).status, 404);
  const linked = await as(alice, "POST", "/proxy/composio/api/v3.1/connected_accounts/link", { auth_config_id: "ac_1" });
  assert.equal(linked.status, 201, linked.text);
  assert.equal(composio.got.at(-1)!.json.user_id, `bops-${alice}`);
  assert.equal(await objectOwner("composio", linked.json.connected_account_id), alice);
});

test("Composio: a user id in any spelling must be the user's own", async () => {
  for (const body of [{ auth_config_id: "ac_1", user_id: `bops-${bob}` }, { auth_config_id: "ac_1", userId: `bops-${bob}` }, { auth_config_id: "ac_1", entity_id: `bops-${bob}` }])
    assert.equal((await as(alice, "POST", "/proxy/composio/api/v3.1/connected_accounts/link", body)).status, 403, JSON.stringify(body));
  assert.equal((await as(alice, "POST", "/proxy/composio/api/v3.1/tool_router/session", { user_id: `bops-${bob}` })).status, 403);
  assert.equal((await as(alice, "POST", "/proxy/composio/api/v3.1/connected_accounts", { auth_config: { id: "ac_1" }, connection: { user_id: `bops-${bob}` } })).status, 403);
});

test("Composio: a session names only the user's own accounts, and only its owner uses it", async () => {
  const base = { toolkits: { enable: ["gmail"] }, manage_connections: { enable: false } };
  assert.equal((await as(alice, "POST", "/proxy/composio/api/v3.1/tool_router/session", { ...base, connected_accounts: { gmail: [`ca_${tag}_bob`] } })).status, 404);
  const s = await as(alice, "POST", "/proxy/composio/api/v3.1/tool_router/session", { ...base, connected_accounts: { gmail: [`ca_${tag}_alice`] } });
  assert.equal(s.status, 201, s.text);
  assert.equal(composio.got.at(-1)!.json.user_id, `bops-${alice}`);
  const id = s.json.session_id as string;
  assert.equal(await objectOwner("composio", id), alice);
  assert.equal((await as(alice, "POST", `/proxy/composio/api/v3.1/tool_router/session/${id}/search`, { queries: [{ use_case: "find mail" }] })).status, 200);
  assert.equal((await as(bob, "POST", `/proxy/composio/api/v3.1/tool_router/session/${id}/execute`, { tool_slug: "GMAIL_FETCH_EMAILS", arguments: {} })).status, 404);
  assert.equal((await as(bob, "GET", `/proxy/composio/api/v3.1/tool_router/session/${id}`)).status, 404);
  // A tool's own arguments are the user's business: a Slack user_id isn't a Composio user.
  const slack = await as(alice, "POST", `/proxy/composio/api/v3.1/tool_router/session/${id}/execute`, { tool_slug: "SLACK_SEND_MESSAGE", arguments: { user_id: "U123", text: "hi" } });
  assert.equal(slack.status, 200, slack.text);
  assert.deepEqual(composio.got.at(-1)!.json.arguments, { user_id: "U123", text: "hi" });
  assert.equal((await as(alice, "POST", `/proxy/composio/api/v3.1/tool_router/session/${id}/execute`, { tool_slug: "GMAIL_FETCH_EMAILS", arguments: {}, account: `ca_${tag}_bob` })).status, 404);
});

test("Composio: custom sign-in setups, shared accounts, saved configs and other routes are refused", async () => {
  const before = composio.got.length;
  for (const [method, path, body] of [
    ["POST", "/api/v3.1/auth_configs", { toolkit: { slug: "gmail" }, auth_config: { type: "use_custom_auth" } }],
    ["POST", "/api/v3.1/connected_accounts", { auth_config: { id: "ac_1" }, connection: { experimental: { acl_config_for_shared: { allow_all_users: true } } } }],
    ["POST", "/api/v3.1/tool_router/session", { experimental: { session_config_id: "sc_1" } }],
    ["GET", "/api/v3/connected_accounts", undefined],
    ["PATCH", `/api/v3.1/connected_accounts/ca_${tag}_alice`, {}],
    ["POST", `/api/v3.1/tool_router/session/trs_1/proxy_execute`, {}],
    ["GET", "/api/v3.1/org/project/list", undefined],
  ] as const)
    assert.equal((await as(alice, method, `/proxy/composio${path}`, body)).status, 403, `${method} ${path}`);
  assert.equal(composio.got.length, before);
});

test("Composio: the app's SDK works through the cloud, with the Orgo key as a Bearer", async () => {
  const cx = new Composio({
    apiKey: keyOf(alice),
    baseURL: `${cloud.url}/proxy/composio`,
    defaultHeaders: { authorization: `Bearer ${keyOf(alice)}` },
    allowTracking: false,
    disableVersionCheck: true,
  } as never);
  const list = (await cx.connectedAccounts.list({ userIds: [`bops-${alice}`] } as never)) as unknown as { items: { id: string }[] };
  assert.deepEqual(list.items.map((a) => a.id), [`ca_${tag}_alice`]);
  assert.ok(composio.got.every((g) => g.headers["x-api-key"] === "composio-test-key"), "the Orgo key never reaches Composio");
  const tool = (await cx.tools.getRawComposioToolBySlug("GMAIL_SEND_EMAIL")) as unknown as { slug: string };
  assert.equal(tool.slug, "GMAIL_SEND_EMAIL");
});

test("Composio: the sign-in setups listed are only the usable ones, each without anyone's credentials", async () => {
  const list = await as(alice, "GET", "/proxy/composio/api/v3.1/auth_configs?toolkit_slug=gmail");
  assert.equal(list.status, 200, list.text);
  for (const leak of ["orgo-secret", "orgo-proxy-key", "orgo-shared", "admin@orgo.ai", "their-secret"]) assert.ok(!list.text.includes(leak), leak);
  const ids = list.json.items.map((a: { id: string }) => a.id);
  assert.ok(ids.includes("ac_1"), "Composio's own");
  assert.ok(ids.includes("ac_slack"), "Orgo's Slack app, pinned");
  assert.ok(!ids.includes("ac_other"), "one made in the dashboard for something else");
  const slack = list.json.items.find((a: { id: string }) => a.id === "ac_slack");
  assert.deepEqual(Object.keys(slack).sort(), ["auth_scheme", "id", "is_composio_managed", "name", "no_of_connections", "status", "toolkit", "type"]);
});

test("Composio: a sign-in setup is Composio's own, or one that asks each person for their own key; one made here is everyone's to use", async () => {
  const create = (who: string, slug: string, auth_config: unknown) => as(who, "POST", "/proxy/composio/api/v3.1/auth_configs", { toolkit: { slug }, auth_config });
  const managed = await create(alice, "notion", { type: "use_composio_managed_auth", name: "Notion (Bops)" });
  assert.equal(managed.status, 201, managed.text);
  assert.deepEqual(composio.got.at(-1)!.json, { toolkit: { slug: "notion" }, auth_config: { type: "use_composio_managed_auth", name: "Notion (Bops)" } });
  // An app with no sign-in of Composio's own (lib/server/composio.ts authConfigFor): each person types their own key.
  const keyed = await create(alice, "attio", { type: "use_custom_auth", authScheme: "API_KEY", name: "Attio (Bops)", credentials: {} });
  assert.equal(keyed.status, 201, keyed.text);
  assert.deepEqual(composio.got.at(-1)!.json, { toolkit: { slug: "attio" }, auth_config: { type: "use_custom_auth", authScheme: "API_KEY", credentials: {}, name: "Attio (Bops)" } });
  const keyedId = keyed.json.auth_config.id as string;
  assert.equal(await objectOwner("composio", keyedId), alice, "recorded as made through the cloud");
  // Bob sees it and connects his own account with it.
  const bobs = await as(bob, "GET", "/proxy/composio/api/v3.1/auth_configs");
  assert.ok(bobs.json.items.some((a: { id: string }) => a.id === keyedId));
  const linked = await as(bob, "POST", "/proxy/composio/api/v3.1/connected_accounts/link", { auth_config_id: keyedId });
  assert.equal(linked.status, 201, linked.text);
  assert.equal(composio.got.at(-1)!.json.user_id, `bops-${bob}`);
  // auth_scheme is read the same; anything else holds someone's secret or could catch other users' sign-ins.
  assert.equal((await create(alice, "harvest", { type: "use_custom_auth", auth_scheme: "BEARER_TOKEN", credentials: {} })).status, 201);
  const before = composio.got.length;
  for (const auth_config of [
    { type: "use_custom_auth", authScheme: "OAUTH2", credentials: { client_id: "mine", client_secret: "mine" } },
    { type: "use_custom_auth", authScheme: "OAUTH2", credentials: {} },
    { type: "use_custom_auth", authScheme: "S2S_OAUTH2", credentials: {} },
    { type: "use_custom_auth", authScheme: "API_KEY", credentials: { api_key: "a shared key" } },
    { type: "use_custom_auth", authScheme: "API_KEY", credentials: {}, tool_access_config: { tools_for_connected_account_creation: [] } },
    { type: "use_custom_auth", credentials: {} },
    { type: "use_custom_auth", authScheme: "API_KEY" },
    { type: "use_composio_managed_auth", credentials: { scopes: ["admin"] } },
    { type: "use_composio_managed_auth", proxy_config: { proxy_url: "https://catch.test" } },
    { type: "use_custom_auth", authScheme: "API_KEY", credentials: {}, proxy_config: { proxy_url: "https://catch.test" } },
  ])
    assert.equal((await create(alice, "attio", auth_config)).status, 403, JSON.stringify(auth_config));
  assert.equal(composio.got.length, before, "none of those reached Composio");
  // An app Composio signs people in to itself: one asking for a key would be picked over it for everyone.
  const notion = await create(alice, "notion", { type: "use_custom_auth", authScheme: "API_KEY", credentials: {} });
  assert.equal(notion.status, 403);
  assert.match(notion.json.error, /Composio has its own sign-in for this app/);
  assert.equal((await create(alice, "nobody-knows", { type: "use_custom_auth", authScheme: "API_KEY", credentials: {} })).status, 404);
  assert.ok(!composio.got.slice(before).some((g) => g.method === "POST"), "nothing was made");
});

test("Composio: connecting an account names a usable sign-in setup, never another one", async () => {
  const link = (body: unknown) => as(alice, "POST", "/proxy/composio/api/v3.1/connected_accounts/link", body);
  for (const id of ["ac_1", "ac_slack"]) assert.equal((await link({ auth_config_id: id, callback_url: "https://bops-api.test/connected?app=Gmail" })).status, 201, id);
  assert.equal((await link({ auth_config_id: "ac_other" })).status, 403, "made in the dashboard for something else");
  assert.equal((await link({ auth_config_id: "ac_nobody_has" })).status, 403, "Composio has no such setup");
  assert.equal((await link({ auth_config_id: "ac_pinned_elsewhere" })).status, 201, "pinned by Orgo");
  assert.equal((await link({})).status, 400);
  const initiate = (id: string) => as(alice, "POST", "/proxy/composio/api/v3.1/connected_accounts", { auth_config: { id }, connection: {} });
  assert.equal((await initiate("ac_1")).status, 201);
  assert.equal((await initiate("ac_other")).status, 403);
  // A session that could connect accounts itself may only do it with a usable setup too.
  const session = (authConfigs: unknown) => as(alice, "POST", "/proxy/composio/api/v3.1/tool_router/session", { toolkits: { enable: ["gmail"] }, auth_configs: authConfigs });
  assert.equal((await session({ gmail: "ac_1" })).status, 201);
  assert.equal((await session({ gmail: "ac_other" })).status, 403);
  // Whether Composio manages a setup is asked once.
  const lookups = composio.got.filter((g) => g.path === "/api/v3.1/auth_configs/ac_1").length;
  assert.equal(lookups, 1);
});

test("Composio: direct actions and an app's own API go through the user's own accounts only", async () => {
  const run = (who: string, slug: string, body: unknown) => as(who, "POST", `/proxy/composio/api/v3.1/tools/execute/${slug}`, body);
  const ok = await run(alice, "SLACKBOT_SEND_MESSAGE", { connected_account_id: `ca_${tag}_alice`, arguments: { channel: "C1", user_id: "U1", text: "hi" }, version: "latest" });
  assert.equal(ok.status, 200, ok.text);
  const sent = composio.got.at(-1)!.json;
  assert.equal(sent.user_id, `bops-${alice}`);
  assert.deepEqual(sent.arguments, { channel: "C1", user_id: "U1", text: "hi" });
  assert.equal((await run(alice, "SLACKBOT_SEND_MESSAGE", { connected_account_id: `ca_${tag}_bob`, arguments: {} })).status, 404);
  assert.equal((await run(alice, "SLACKBOT_SEND_MESSAGE", { user_id: `bops-${bob}`, arguments: {} })).status, 403);
  assert.equal((await run(alice, "GMAIL_SEND_EMAIL", { custom_auth_params: { base_url: "https://catch.test" }, arguments: {} })).status, 403);
  assert.equal((await run(alice, "GMAIL_SEND_EMAIL", { custom_connection_data: { access_token: "x" }, arguments: {} })).status, 403);
  // Composio's proxy to the app's own API: always naming one of the user's accounts.
  const proxied = await run(alice, "proxy", { endpoint: "/auth.test", method: "POST", connected_account_id: `ca_${tag}_alice`, body: { user_id: "U1" } });
  assert.equal(proxied.status, 200, proxied.text);
  assert.equal((await run(alice, "proxy", { endpoint: "/auth.test", method: "POST" })).status, 400);
  assert.equal((await run(alice, "proxy", { endpoint: "/auth.test", method: "POST", connected_account_id: `ca_${tag}_bob` })).status, 404);
});

test("Composio: triggers only on the user's own accounts, and their live delivery isn't passed through", async () => {
  const active = (q: string) => as(alice, "GET", `/proxy/composio/api/v3.1/trigger_instances/active${q}`);
  assert.equal((await active("")).status, 400);
  assert.equal((await active(`?connected_account_ids=ca_${tag}_bob`)).status, 404);
  const mine = await active(`?connected_account_ids=ca_${tag}_alice`);
  assert.equal(mine.status, 200, mine.text);
  assert.deepEqual(mine.json.items.map((t: { id: string }) => t.id), [`ti_${alice}`]);
  const upsert = (body: unknown) => as(alice, "POST", "/proxy/composio/api/v3.1/trigger_instances/SLACKBOT_CHANNEL_MESSAGE_RECEIVED/upsert", body);
  const made = await upsert({ connected_account_id: `ca_${tag}_alice`, trigger_config: { is_bot_message: false, user_id: "U1" } });
  assert.equal(made.status, 200, made.text);
  assert.equal(composio.got.at(-1)!.json.user_id, `bops-${alice}`);
  assert.equal((await upsert({ connectedAuthId: `ca_${tag}_bob`, triggerConfig: {} })).status, 404);
  assert.equal((await upsert({ connected_account_id: `ca_${tag}_alice`, egress_url: "https://catch.test" })).status, 403);
  assert.equal((await upsert({ trigger_config: {} })).status, 400);
  // The SDK's live delivery is a Pusher channel for the whole project: never handed to a Mac.
  assert.equal((await as(alice, "GET", "/proxy/composio/api/v3/internal/sdk/realtime/credentials")).status, 403);
  assert.equal((await as(alice, "POST", "/proxy/composio/api/v3/internal/sdk/realtime/auth", { channel_name: "private-x_triggers" })).status, 403);
});

test("Composio: the new app code's SDK calls work through the cloud", async () => {
  const cx = new Composio({
    apiKey: keyOf(alice),
    baseURL: `${cloud.url}/proxy/composio`,
    defaultHeaders: { authorization: `Bearer ${keyOf(alice)}` },
    allowTracking: false,
    disableVersionCheck: true,
  } as never);
  const account = `ca_${tag}_alice`;
  const before = composio.got.length;
  await cx.tools.execute("SLACKBOT_SEND_MESSAGE", { userId: `bops-${alice}`, connectedAccountId: account, arguments: { channel: "C1", markdown_text: "hi" }, dangerouslySkipVersionCheck: true } as never);
  await cx.tools.proxyExecute({ endpoint: "/auth.test", method: "POST", connectedAccountId: account } as never);
  await cx.triggers.listActive({ connectedAccountIds: [account] });
  await cx.triggers.create(`bops-${alice}`, "SLACKBOT_CHANNEL_MESSAGE_RECEIVED", { connectedAccountId: account, triggerConfig: { is_bot_message: false } } as never);
  const paths = composio.got.slice(before).map((g) => `${g.method} ${g.path}`);
  assert.deepEqual(paths, [
    "GET /api/v3.1/tools/SLACKBOT_SEND_MESSAGE",
    "POST /api/v3.1/tools/execute/SLACKBOT_SEND_MESSAGE",
    "POST /api/v3.1/tools/execute/proxy",
    "GET /api/v3.1/trigger_instances/active",
    "GET /api/v3.1/triggers_types/SLACKBOT_CHANNEL_MESSAGE_RECEIVED",
    "POST /api/v3.1/trigger_instances/SLACKBOT_CHANNEL_MESSAGE_RECEIVED/upsert",
  ]);
  await assert.rejects(cx.triggers.subscribe(() => {}, { userId: `bops-${alice}` } as never));
});

test("Composio: every call of the apps code (several accounts per app) works through the cloud, and no token reaches the Mac", async () => {
  const cx = new Composio({
    apiKey: keyOf(alice),
    baseURL: `${cloud.url}/proxy/composio`,
    defaultHeaders: { authorization: `Bearer ${keyOf(alice)}` },
    allowTracking: false,
    disableVersionCheck: true,
  } as never);
  const me = `bops-${alice}`;
  const before = composio.got.length;
  // authConfigFor: the app's setups, then a new one: Composio's own, or one asking for the person's own key.
  const { items } = await cx.authConfigs.list({ toolkit: "gmail" });
  assert.ok(items.some((a) => a.id === "ac_1") && !items.some((a) => a.id === "ac_other"));
  await cx.authConfigs.create("linear", { type: "use_composio_managed_auth", name: "Linear (Bops)" });
  const keyed = await cx.authConfigs.create("clay", { type: "use_custom_auth", authScheme: "API_KEY", name: "Clay (Bops)", credentials: {} } as never);
  // connectApp: a second Gmail account next to the first, landing on the cloud's own page after.
  const req = await cx.connectedAccounts.link(me, "ac_1", { allowMultiple: true, callbackUrl: "https://bops-api.test/connected?app=Gmail" });
  assert.equal(await objectOwner("composio", req.id), alice);
  const keyedLink = await cx.connectedAccounts.link(me, keyed.id, { allowMultiple: true });
  assert.ok(keyedLink.id);
  // waitForConnection and accountName read the account: its name, never its tokens.
  const ca = (await cx.connectedAccounts.get(req.id)) as unknown as { data: Record<string, unknown>; state?: { val?: Record<string, unknown> } };
  assert.equal(ca.data.email, `${alice}@mail.test`);
  assert.equal(ca.data.id_token, "masked", "an ID token isn't read for a name: whoIs asks the app");
  assert.ok(!JSON.stringify(ca).includes(`tok-${req.id}`));
  // whoIs: the app's own "who am I", through Composio's proxy, in that account.
  await cx.tools.proxyExecute({ endpoint: "/gmail/v1/users/me/profile", method: "GET", connectedAccountId: req.id });
  // syncApps: the user's accounts, a page at a time.
  const synced = (await cx.connectedAccounts.list({ userIds: [me], limit: 100 } as never)) as unknown as { items: { id: string }[] };
  assert.deepEqual(synced.items.map((a) => a.id), [`ca_${tag}_alice`]);
  // sessionFor: a bot's session over both Gmail accounts, then a search in it.
  const session = await cx.sessions.create(me, {
    toolkits: { enable: ["gmail"] },
    tools: { gmail: { tags: ["readOnlyHint"] } },
    connectedAccounts: { gmail: [`ca_${tag}_alice`, req.id] },
    multiAccount: { enable: true, maxAccountsPerToolkit: 10 },
    manageConnections: false,
    sandbox: { enable: false },
  } as never);
  await session.search({ query: "emails from Adi this week" });
  // cancelConnect and disconnectAccount.
  await cx.connectedAccounts.delete(keyedLink.id);
  const paths = composio.got.slice(before).map((g) => `${g.method} ${g.path}`);
  for (const p of [
    "GET /api/v3.1/auth_configs",
    "POST /api/v3.1/auth_configs",
    "POST /api/v3.1/connected_accounts/link",
    `GET /api/v3.1/connected_accounts/${req.id}`,
    "POST /api/v3.1/tools/execute/proxy",
    "POST /api/v3.1/tool_router/session",
    `POST /api/v3.1/tool_router/session/${session.sessionId}/search`,
    `DELETE /api/v3.1/connected_accounts/${keyedLink.id}`,
  ])
    assert.ok(paths.includes(p), p);
  const sent = composio.got.find((g) => g.path === "/api/v3.1/tool_router/session" && g.json.multi_account);
  assert.equal(sent?.json.multi_account.enable, true);
  assert.equal(sent?.json.multi_account.max_accounts_per_toolkit, 10);
  assert.deepEqual(sent?.json.connected_accounts, { gmail: [`ca_${tag}_alice`, req.id] });
});

/* ---------------- Typesafe ---------------- */

test("Typesafe: the one route the app uses goes on with the cloud's key, and is counted", async () => {
  const body = { model: "jev-latest", state: { app: "Bops" }, questions: { memory: { type: "noul", instructions: "x" } } };
  const r = await as(alice, "POST", "/proxy/typesafe/v1/systemone", body);
  assert.equal(r.status, 200, r.text);
  assert.deepEqual(r.json, { answers: { memory: { type: "noul", noul: 0.9 } } });
  const sent = typesafe.got.at(-1)!;
  assert.equal(sent.headers.authorization, "Bearer typesafe-test-key");
  assert.deepEqual(sent.json, body);
  assert.equal((await as(alice, "GET", "/proxy/typesafe/v1/systemone")).status, 403);
  assert.equal((await as(alice, "POST", "/proxy/typesafe/v1/keys", {})).status, 403);
  const counted = await until(async () => (await query("SELECT count(*)::int AS n, sum(cost_micros)::int AS cost FROM bops.cloud_usage WHERE user_id = $1 AND kind = 'typesafe.calls' HAVING count(*) > 0", [alice])).rows[0]);
  assert.deepEqual(counted, { n: 1, cost: 200 });
});
