import assert from "node:assert/strict";
import { randomBytes } from "node:crypto";
import { after, before, test } from "node:test";
import { open } from "../crypto.ts";
import { closeDb, query } from "../db.ts";
import { accountFor, honchoPrefix, ownsWorkspace } from "../session.ts";
import { call, dropUsers, fakeOrgo, fakeProvider, keyOf, newUserId, prepareDb, startCloud, type Got, type Listening } from "./core-fakes.ts";

/** POST /v1/session: a pod, one pod key and a sub-account (and a SIP trunk only when trunks are on), made once per user however often it's called. */

const SIP = "sip:proj_test@sip.api.openai.com;transport=tls";
const users: string[] = [];
let orgo: Listening, cloud: Listening;
let agentmail: Awaited<ReturnType<typeof fakeProvider>>, agentphone: Awaited<ReturnType<typeof fakeProvider>>;

/** AgentMail as the cloud uses it: pods (a second one with the same client id is refused), and pod keys. */
const pods: { pod_id: string; client_id: string }[] = [];
let keysMade = 0;
/** AgentPhone: sub-accounts, and trunks per sub-account (it ignores the destination on create, as the real one does). */
const subAccounts: { id: string; name: string }[] = [];
const trunks: { sub: string; id: string; name: string; originationUris: { sip_uri: string }[] }[] = [];
let failSubAccounts = false;

const posts = (p: { got: Got[] }, path: RegExp) => p.got.filter((g) => g.method === "POST" && path.test(g.path));

before(async () => {
  await prepareDb();
  orgo = await fakeOrgo();
  agentmail = await fakeProvider((g) => {
    if (g.method === "POST" && g.path === "/v0/pods") {
      if (pods.some((p) => p.client_id === g.json.client_id)) return { status: 409, json: { name: "AlreadyExistsError" } };
      const pod = { pod_id: `pod_${pods.length + 1}`, client_id: g.json.client_id, name: g.json.name };
      pods.push(pod);
      return { json: pod };
    }
    if (g.method === "GET" && g.path === "/v0/domains") return { json: { domains: [{ domain: "bops.bot", status: "VERIFIED", subdomains_enabled: true }] } };
    if (g.method === "GET" && g.path === "/v0/pods") {
      // Pages of one, to walk the pages.
      const at = Number(g.query.get("page_token") ?? 0);
      return { json: { count: 1, pods: pods.slice(at, at + 1), next_page_token: at + 1 < pods.length ? String(at + 1) : null } };
    }
    const key = /^\/v0\/pods\/([^/]+)\/api-keys$/.exec(g.path);
    if (g.method === "POST" && key) return { json: { api_key_id: `ak_${++keysMade}`, api_key: `am_secret_${keysMade}`, pod_id: key[1], name: g.json.name } };
    return { status: 418 };
  });
  agentphone = await fakeProvider((g) => {
    if (g.path === "/v1/sub-accounts" && g.method === "GET") {
      const offset = Number(g.query.get("offset") ?? 0);
      return { json: { data: subAccounts.slice(offset, offset + Number(g.query.get("limit") ?? 100)) } };
    }
    if (g.path === "/v1/sub-accounts" && g.method === "POST") {
      if (failSubAccounts) return { status: 500 };
      const sub = { id: `sub_${subAccounts.length + 1}`, name: g.json.name };
      subAccounts.push(sub);
      return { json: sub };
    }
    const sub = String(g.headers["x-sub-account-id"] ?? "");
    if (g.path === "/v1/sip-trunks" && g.method === "GET") return { json: { data: trunks.filter((t) => t.sub === sub) } };
    if (g.path === "/v1/sip-trunks" && g.method === "POST") {
      const trunk = { sub, id: `tr_${trunks.length + 1}`, name: g.json.name, originationUris: [], credentials: [{ username: "u", password: "p" }] };
      trunks.push(trunk);
      return { json: trunk };
    }
    const patch = /^\/v1\/sip-trunks\/([^/]+)$/.exec(g.path);
    if (patch && g.method === "PATCH") {
      const trunk = trunks.find((t) => t.id === patch[1] && t.sub === sub);
      if (!trunk) return { status: 404 };
      trunk.originationUris = g.json.origination.uris;
      return { json: trunk };
    }
    return { status: 418 };
  });
  Object.assign(process.env, {
    BOPS_UPSTREAM_AGENTMAIL: agentmail.url,
    BOPS_UPSTREAM_AGENTPHONE: agentphone.url,
    AGENTMAIL_API_KEY: "am-test-not-a-real-key",
    AGENTPHONE_API_KEY: "ap-test-not-a-real-key",
    HONCHO_API_KEY: "honcho-test",
    COMPOSIO_API_KEY: "composio-test",
    OPENAI_API_KEY: "sk-test-main",
    OPENAI_EXECUTOR_API_KEY: "sk-test-executor",
    OPENAI_SIP_URI: SIP,
    TYPESAFE_API_KEY: "typesafe-test",
    BOPS_SLACK_APP_ID: "A0TESTAPP",
    BOPS_SLACK_SIGNING_SECRET: "slack-signing-test",
    TWILIO_VERIFY_SERVICE_SID: "VA_test",
    TWILIO_API_KEY_SID: "SK_test",
    TWILIO_API_KEY_SECRET: "secret",
  });
  cloud = await startCloud();
});

after(async () => {
  await dropUsers(users);
  await Promise.all([cloud?.close(), orgo?.close(), agentmail?.close(), agentphone?.close()]);
  await closeDb();
});

const session = (userId: string) => call(cloud.url, "POST", "/v1/session", { key: keyOf(userId) });
const user = (what: string) => {
  const id = newUserId(what);
  users.push(id);
  return id;
};

test("the first session makes a pod, one pod key and a sub-account, and no SIP trunk; the next makes nothing", async () => {
  const alice = user("alice");
  const r = await session(alice);
  assert.equal(r.status, 200, r.text);
  const pod = pods.find((p) => p.client_id === `bops-${alice}`)!;
  const sub = subAccounts.find((s) => s.name === `bops-${alice}`)!;
  assert.ok(pod && sub);
  assert.deepEqual(r.json, {
    userId: alice,
    email: `${alice}@example.com`,
    publicUrl: "https://bops-api.test",
    agentmail: { podId: pod.pod_id, apiKey: r.json.agentmail.apiKey, domain: "bops.bot" },
    agentphone: { subAccountId: sub.id, hookUrl: "https://bops-api.test/hooks/agentphone" },
    honcho: { workspacePrefix: honchoPrefix(alice) },
    composio: { userId: `bops-${alice}` },
    openai: { executorKey: "sk-test-executor" },
    typesafe: true,
    verify: { sms: true, email: false },
    slack: { appId: "A0TESTAPP" },
  });
  // The pod key reaches only mail in that pod: no keys, pods, domains, webhooks or apps.
  const [keyCall] = posts(agentmail, new RegExp(`^/v0/pods/${pod.pod_id}/api-keys$`));
  assert.equal(keyCall.headers.authorization, "Bearer am-test-not-a-real-key");
  for (const p of ["message_send", "inbox_create", "message_read"]) assert.equal(keyCall.json.permissions[p], true);
  for (const p of ["api_key_create", "pod_create", "domain_create", "webhook_create", "app_connect", "app_share_owner", "account_update"]) assert.equal(keyCall.json.permissions[p], undefined);
  // Calls go to each number's agent now: no trunk is made or even looked for (BOPS_SIP_TRUNKS isn't set).
  assert.equal(trunks.filter((t) => t.sub === sub.id).length, 0);
  assert.equal(agentphone.got.filter((g) => g.path.startsWith("/v1/sip-trunks")).length, 0);
  // The key is kept sealed, never as it is.
  const row = (await query("SELECT agentmail_pod_id, agentmail_key_sealed, agentphone_sub_account FROM bops.cloud_accounts WHERE user_id = $1", [alice])).rows[0];
  assert.equal(row.agentmail_pod_id, pod.pod_id);
  assert.ok(!row.agentmail_key_sealed.includes(r.json.agentmail.apiKey));
  assert.equal(open(row.agentmail_key_sealed), r.json.agentmail.apiKey);
  assert.deepEqual(await accountFor(alice), { userId: alice, email: `${alice}@example.com`, agentmailPodId: pod.pod_id, agentphoneSubAccount: sub.id });

  const before = { am: agentmail.got.length, ap: agentphone.got.length };
  const again = await session(alice);
  assert.equal(again.status, 200);
  assert.deepEqual(again.json, r.json);
  assert.equal(agentmail.got.length, before.am, "nothing new at AgentMail");
  assert.equal(agentphone.got.length, before.ap, "nothing new at AgentPhone");
});

test("with SIP trunks on (BOPS_SIP_TRUNKS=1), the first session also makes a trunk to OpenAI in the user's sub-account", async () => {
  const erin = user("erin");
  process.env.BOPS_SIP_TRUNKS = "1";
  try {
    const r = await session(erin);
    assert.equal(r.status, 200, r.text);
    const trunk = trunks.find((t) => t.sub === r.json.agentphone.subAccountId)!;
    assert.deepEqual(trunk.originationUris.map((o) => o.sip_uri), [SIP]);
  } finally {
    delete process.env.BOPS_SIP_TRUNKS;
  }
});

test("two sessions at once make one of everything", async () => {
  const bob = user("bob");
  const all = await Promise.all([session(bob), session(bob), session(bob)]);
  for (const r of all) assert.equal(r.status, 200, r.text);
  assert.equal(new Set(all.map((r) => r.json.agentmail.apiKey)).size, 1);
  assert.equal(new Set(all.map((r) => r.json.agentphone.subAccountId)).size, 1);
  assert.equal(posts(agentmail, /^\/v0\/pods$/).filter((g) => g.json.client_id === `bops-${bob}`).length, 1);
  const pod = pods.find((p) => p.client_id === `bops-${bob}`)!;
  assert.equal(posts(agentmail, new RegExp(`^/v0/pods/${pod.pod_id}/api-keys$`)).length, 1);
  assert.equal(posts(agentphone, /^\/v1\/sub-accounts$/).filter((g) => g.json.name === `bops-${bob}`).length, 1);
});

test("a pod or sub-account left by a setup cut short is found again, not made twice", async () => {
  const carol = user("carol");
  pods.push({ pod_id: "pod_left_behind", client_id: `bops-${carol}` });
  subAccounts.push({ id: "sub_left_behind", name: `bops-${carol}` });
  const r = await session(carol);
  assert.equal(r.status, 200, r.text);
  assert.equal(r.json.agentmail.podId, "pod_left_behind");
  assert.equal(r.json.agentphone.subAccountId, "sub_left_behind");
  assert.equal(posts(agentphone, /^\/v1\/sub-accounts$/).filter((g) => g.json.name === `bops-${carol}`).length, 0);
});

test("a provider that fails answers 502, keeps what was made, and the next session finishes", async () => {
  const dave = user("dave");
  failSubAccounts = true;
  try {
    const r = await session(dave);
    assert.equal(r.status, 502);
    assert.match(r.json.error, /phone/);
  } finally {
    failSubAccounts = false;
  }
  const kept = (await query("SELECT agentmail_pod_id, agentmail_key_sealed, agentphone_sub_account FROM bops.cloud_accounts WHERE user_id = $1", [dave])).rows[0];
  assert.ok(kept.agentmail_pod_id && kept.agentmail_key_sealed);
  assert.equal(kept.agentphone_sub_account, null);
  const keys = keysMade;
  const r = await session(dave);
  assert.equal(r.status, 200, r.text);
  assert.equal(keysMade, keys, "the pod key made before is handed back, not a new one");
  assert.equal(r.json.agentmail.apiKey, open(kept.agentmail_key_sealed));
});

test("a pod key that can't be opened any more (BOPS_CLOUD_SECRET changed) is replaced, not handed out broken", async () => {
  const frank = user("frank");
  const first = await session(frank);
  assert.equal(first.status, 200, first.text);
  const secret = process.env.BOPS_CLOUD_SECRET;
  process.env.BOPS_CLOUD_SECRET = randomBytes(32).toString("base64");
  try {
    const keys = keysMade;
    const r = await session(frank);
    assert.equal(r.status, 200, r.text);
    assert.equal(keysMade, keys + 1);
    assert.notEqual(r.json.agentmail.apiKey, first.json.agentmail.apiKey);
    assert.equal(r.json.agentmail.podId, first.json.agentmail.podId);
    const sealed = (await query("SELECT agentmail_key_sealed FROM bops.cloud_accounts WHERE user_id = $1", [frank])).rows[0].agentmail_key_sealed;
    assert.equal(open(sealed), r.json.agentmail.apiKey);
  } finally {
    process.env.BOPS_CLOUD_SECRET = secret;
  }
});

test("a provider whose key the cloud lacks comes back null, and the executor key is never the main key", async () => {
  const erin = user("erin");
  const saved = { ...process.env };
  try {
    for (const k of ["AGENTMAIL_API_KEY", "AGENTPHONE_API_KEY", "HONCHO_API_KEY", "COMPOSIO_API_KEY", "TYPESAFE_API_KEY", "TWILIO_API_KEY_SECRET"]) delete process.env[k];
    process.env.OPENAI_EXECUTOR_API_KEY = process.env.OPENAI_API_KEY;
    const r = await session(erin);
    assert.equal(r.status, 200, r.text);
    assert.equal(r.json.agentmail, null);
    assert.equal(r.json.agentphone, null);
    assert.equal(r.json.honcho, null);
    assert.equal(r.json.composio, null);
    assert.equal(r.json.typesafe, false);
    assert.deepEqual(r.json.openai, { executorKey: null });
    assert.deepEqual(r.json.verify, { sms: false, email: false });
    assert.equal(r.json.slack, null, "Slack's events need Composio to know where they go");
    delete process.env.OPENAI_API_KEY;
    assert.equal((await session(erin)).json.openai, null);
  } finally {
    Object.assign(process.env, saved);
  }
});

test("Slack comes back only when this cloud can check Slack's events and route them", async () => {
  const gail = user("gail");
  const saved = { ...process.env };
  try {
    assert.deepEqual((await session(gail)).json.slack, { appId: "A0TESTAPP" });
    delete process.env.BOPS_SLACK_SIGNING_SECRET;
    assert.equal((await session(gail)).json.slack, null);
    process.env.BOPS_SLACK_SIGNING_SECRET = "slack-signing-test";
    delete process.env.BOPS_SLACK_APP_ID;
    assert.equal((await session(gail)).json.slack, null);
  } finally {
    Object.assign(process.env, saved);
  }
});

test("without an Orgo key there's no session", async () => {
  assert.equal((await call(cloud.url, "POST", "/v1/session")).status, 401);
  assert.equal((await call(cloud.url, "POST", "/v1/session", { key: "not-an-orgo-key" })).status, 401);
});

test("Honcho prefixes: one per user, never the start of another user's", () => {
  assert.equal(honchoPrefix("abc123"), "u-abc123");
  assert.equal(honchoPrefix("a.b"), "u-a_2eb");
  assert.notEqual(honchoPrefix("a.b"), honchoPrefix("a_b"));
  assert.equal(honchoPrefix("1f9c4e2a-0b1c-4d5e-8f90-123456789abc"), "u-1f9c4e2a_2d0b1c_2d4d5e_2d8f90_2d123456789abc");
  assert.ok(!honchoPrefix("x-y é").slice(2).includes("-"));
  assert.ok(ownsWorkspace("12", "u-12"));
  assert.ok(ownsWorkspace("12", "u-12-bops"));
  assert.ok(ownsWorkspace("12", "u-12-bops-ws_main"));
  assert.ok(!ownsWorkspace("12", "u-123-bops"), "12 isn't the start of 123's");
  assert.ok(!ownsWorkspace("1f9c4e2a", honchoPrefix("1f9c4e2a-0b1c") + "-bops"), "a user id isn't the start of a longer one");
  assert.ok(!ownsWorkspace("a.b", "u-a_b-bops"));
  assert.ok(!ownsWorkspace("12", "u-12x"));
});
