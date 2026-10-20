import assert from "node:assert/strict";
import { createServer, type IncomingMessage, type ServerResponse } from "node:http";
import { after, before, test } from "node:test";
import { clearAuthCache, userForKey } from "../auth.ts";
import { seal } from "../crypto.ts";
import { closeDb, query } from "../db.ts";
import { deviceIdOf } from "../device.ts";
import { COMPUTER_NOT_ALLOWED } from "../protocol.ts";
import { computerWatch, watchComputer } from "../server.ts";
import { honchoPrefix } from "../session.ts";
import { call, dropUsers, fakeProvider, listen, newUserId, prepareDb, startCloud, type Got, type Listening } from "./core-fakes.ts";

/**
 * What a computer's runner may touch of its user's Bops (computer-scope.ts, state.ts, proxy.ts, session.ts,
 * server.ts): a state write only of its runner's own work (its threads, its bots' routines' runs and how
 * they're doing), never a state its user hasn't got or a whole one; messages only in its bots' chats,
 * and only those read; no mail key in its session, its mail through Bops Cloud in its bots' inboxes
 * only; texts only from its bots' lines to the user's verified numbers; Composio only in its bots'
 * accounts (read-only ones read only), never connecting or deleting one; Honcho only in its bots'
 * memory banks; its sockets and long answers held to it while they're open.
 */

const D1 = "c1c1c1c1-0000-4000-8000-0000000000aa";
const D2 = "c2c2c2c2-0000-4000-8000-0000000000bb";
const POD_KEY = "am_pod_key_not_real";
const OWNER = "+14155550199";

let orgo: Listening;
let cloud: Listening;
let mail: Awaited<ReturnType<typeof fakeProvider>>;
let phone: Awaited<ReturnType<typeof fakeProvider>>;
let composio: Awaited<ReturnType<typeof fakeProvider>>;
let honcho: Awaited<ReturnType<typeof fakeProvider>>;
const users: string[] = [];
/** Keys Orgo turns down from now on (a computer deleted, its token stale). */
const turnedDown = new Set<string>();

const json = (res: ServerResponse, status: number, body: unknown) => res.writeHead(status, { "content-type": "application/json" }).end(JSON.stringify(body));

/** Orgo's profile: `key-<u>` the user's key, `orgo_vm_<u>~<d>` (or `orgo_vm_soon-…`, ending in 1.5 s) a computer's token, `ck-<u>~<d>` its key, `ck-unbound-<u>` a computer key Orgo never bound. */
function profile(req: IncomingMessage, res: ServerResponse) {
  const key = /^Bearer (.+)$/.exec(req.headers.authorization ?? "")?.[1] ?? "";
  if (req.url !== "/api/user/profile" || turnedDown.has(key)) return json(res, 401, { error: "no" });
  let m: RegExpExecArray | null;
  if ((m = /^key-(.+)$/.exec(key))) return json(res, 200, { id: m[1], email: `${m[1]}@example.com`, api_key: { id: "k0", scope: "account" } });
  if ((m = /^orgo_vm_(soon-)?(.+)~(.+)$/.exec(key)))
    return json(res, 200, { id: m[2], api_key: null, principal: { kind: "vm_identity", desktop_id: m[3], expires_at: new Date(Date.now() + (m[1] ? 1500 : 3600_000)).toISOString() } });
  if ((m = /^ck-unbound-(.+)$/.exec(key))) return json(res, 200, { id: m[1], api_key: { id: "k2", scope: "account", computer_key: true } });
  if ((m = /^ck-(.+)~(.+)$/.exec(key))) return json(res, 200, { id: m[1], api_key: { id: "k1", scope: "computer", computer_id: m[2], computer_key: true } });
  json(res, 401, { error: "no" });
}

before(async () => {
  await prepareDb();
  orgo = await listen(createServer(profile));
  process.env.BOPS_ORGO_ORIGIN = orgo.url;
  mail = await fakeProvider((g) => (g.path === "/v0/domains" ? { json: { domains: [] } } : { json: { ok: true, path: g.path } }));
  phone = await fakeProvider((g) => (g.method === "POST" && g.path === "/v1/messages" ? { json: { id: `ap_${phone.got.length}`, status: "queued" } } : { json: { data: [] } }));
  composio = await fakeProvider((g) => {
    const tool = /^\/api\/v3\.1\/tools\/([A-Z_]+)$/.exec(g.path)?.[1];
    if (g.method === "GET" && tool) return { json: { slug: tool, toolkit: { slug: tool.split("_")[0].toLowerCase() }, tags: tool.endsWith("_SEARCH") ? ["readOnlyHint"] : [] } };
    if (g.path === "/api/v3.1/tool_router/session") return { json: { session_id: `trs_${composio.got.length}` } };
    if (g.path === "/api/v3.1/connected_accounts") return { json: { items: ["acct_gmail", "acct_notion", "acct_slack"].map((id) => ({ id, user_id: `bops-${g.query.get("user_ids")?.slice(5)}`, status: "ACTIVE" })) } };
    return { json: { data: { ok: true }, successful: true } };
  });
  honcho = await fakeProvider((g) => (g.path === "/v3/workspaces/list" ? { json: { items: [{ id: g.json?.mine }, { id: g.json?.theirs }] } } : { json: {} }));
  Object.assign(process.env, {
    AGENTMAIL_API_KEY: "am_cloud_key_not_real",
    BOPS_UPSTREAM_AGENTMAIL: mail.url,
    AGENTPHONE_API_KEY: "ap_cloud_key_not_real",
    BOPS_UPSTREAM_AGENTPHONE: phone.url,
    COMPOSIO_API_KEY: "composio_cloud_key_not_real",
    BOPS_UPSTREAM_COMPOSIO: composio.url,
    HONCHO_API_KEY: "honcho_cloud_key_not_real",
    BOPS_UPSTREAM_HONCHO: honcho.url,
  });
  cloud = await startCloud();
});

after(async () => {
  await cloud.close();
  for (const f of [orgo, mail, phone, composio, honcho]) await f.close();
  await query("DELETE FROM bops.cloud_accounts WHERE user_id = ANY($1::text[])", [users]);
  await query("DELETE FROM bops.chat_messages WHERE user_id = ANY($1::text[])", [users]);
  await dropUsers(users);
  await closeDb();
});

const vm = (u: string, d = D1) => `orgo_vm_${u}~${d}`;
const ck = (u: string, d = D1) => `ck-${u}~${d}`;
const asNew = (u: string) => ({ "x-bops-user": u, "x-bops-protocol": "2" });

/**
 * The user's state: Boppy (main) and Max (sharing Boppy's computer, D1) in the default workspace, Iris on
 * a computer of her own (D2) in a second workspace; Gmail open to the default workspace's bots, Notion
 * given to Max to read only, Slack to nobody.
 */
function stateOf() {
  return {
    owner: { name: "Ann" },
    bots: [
      { id: "main", name: "Boppy", isMain: true, computerId: D1, computerStatus: "ready", keys: ["OPENAI_KEY"], mail: { inboxId: "inbox-main", podId: "pod1" } },
      { id: "helper", name: "Max", isMain: false, computerStatus: "ready", access: { acct_notion: "read" } },
      { id: "iris", name: "Iris", isMain: false, computer: "own", computerId: D2, computerStatus: "ready", workspaceId: "ws_two", mail: { inboxId: "inbox-iris", podId: "pod1" }, phone: "+14155550111", phoneLine: { numberId: "num-iris", agentId: "agent-iris" } },
    ],
    chats: [
      { id: "bot:main", kind: "bot", botIds: ["main"], createdAt: 1, typing: [] },
      { id: "bot:iris", kind: "bot", botIds: ["iris"], createdAt: 1, typing: [] },
      { id: "group1", kind: "group", botIds: ["helper", "iris"], createdAt: 1, typing: [] },
    ],
    sessions: [{ id: "s-mac", botId: "main", by: "mac-device", goal: "x", status: "done" }],
    routines: [
      { id: "r-main", botId: "main", title: "Daily", goal: "Do it", schedule: { kind: "daily", times: ["09:00"] }, enabled: true, nextRunAt: 100, skips: [50, 150] },
      { id: "r-iris", botId: "iris", title: "Iris's", goal: "Hers", schedule: { kind: "daily", times: ["10:00"] }, enabled: true, nextRunAt: 100 },
    ],
    accounts: [
      { id: "acct_gmail", app: "gmail", appName: "Gmail", status: "active", at: 1, workspaceId: "ws_main" },
      { id: "acct_notion", app: "notion", appName: "Notion", status: "active", at: 1, workspaceId: "ws_main", onlyGiven: true },
      { id: "acct_slack", app: "slack", appName: "Slack", status: "active", at: 1, onlyGiven: true },
    ],
    workspaces: [
      { id: "ws_main", name: "Acme", createdAt: 1, line: { numberId: "num-main", agentId: "agent-main", phone: "+14155550100", type: "sms", scope: "sub" } },
      { id: "ws_two", name: "Side", createdAt: 2 },
    ],
    ownerPhones: [{ number: OWNER, consentAt: 1, verifiedAt: 2 }],
    usage: [{ kind: "model.tokens", at: 1 }],
  };
}

/** A user whose Mac wrote their state (version 1), with their cloud account and Composio accounts as the cloud saw them made. */
async function seeded(what: string) {
  const u = newUserId(what);
  users.push(u);
  const r = await call(cloud.url, "PUT", "/v1/state", { key: `key-${u}`, headers: asNew(u), json: { base: 0, state: stateOf() } });
  assert.equal(r.status, 200, r.text);
  await query("INSERT INTO bops.cloud_accounts (user_id, agentmail_pod_id, agentmail_key_sealed, agentphone_sub_account) VALUES ($1, 'pod1', $2, $3) ON CONFLICT (user_id) DO NOTHING", [u, seal(POD_KEY), `sub-${u}`]);
  for (const id of ["acct_gmail", "acct_notion", "acct_slack"])
    // The same ids for every test user: this one's now.
    await query("INSERT INTO bops.cloud_objects (object_id, provider, kind, user_id) VALUES ($1, 'composio', 'connected_account', $2) ON CONFLICT (provider, object_id) DO UPDATE SET user_id = EXCLUDED.user_id", [id, u]);
  return u;
}

const stateNow = async (u: string) => (await call(cloud.url, "GET", "/v1/state", { key: `key-${u}`, headers: asNew(u) })).json as { version: number; state: ReturnType<typeof stateOf> };

/** A computer's write over the state as it is now, changed by `change`. */
async function computerPut(u: string, key: string, change: (s: ReturnType<typeof stateOf>) => void) {
  const now = await stateNow(u);
  const next = structuredClone(now.state);
  change(next);
  return call(cloud.url, "PUT", "/v1/state", { key, headers: asNew(u), json: { base: now.version, state: next } });
}

test("a computer's state write: its own threads, its bots' routines' runs and how they're doing; nothing else", async () => {
  clearAuthCache();
  const u = await seeded("put");
  const me = deviceIdOf(u, D1);
  const ok = await computerPut(u, vm(u), (s) => {
    s.sessions.push({ id: "s-run", botId: "main", by: me, goal: "a run", status: "running" });
    Object.assign(s.routines[0], { nextRunAt: 200, lastRunAt: 150, last: { at: 150, status: "ok" }, skips: [150] });
    s.bots[0].computerStatus = "error";
    s.bots[1].computerStatus = "cloning";
    (s.accounts[0] as Record<string, unknown>).usedAt = 9;
    s.usage.push({ kind: "model.tokens", at: 2 });
  });
  assert.equal(ok.status, 200, ok.text);
  assert.equal((await stateNow(u)).state.routines[0].nextRunAt, 200);
  // Its own thread, changed and taken out.
  assert.equal((await computerPut(u, vm(u), (s) => (s.sessions = s.sessions.filter((x) => x.id !== "s-run")))).status, 200);
  const refused: [string, (s: ReturnType<typeof stateOf>) => void, string][] = [
    ["a key for a bot", (s) => s.bots[0].keys!.push("STRIPE_SECRET_KEY"), "bots.main.keys"],
    ["app access", (s) => ((s.bots[1].access as Record<string, string>).acct_slack = "act"), "bots.helper.access"],
    ["a bot moved onto it", (s) => (s.bots[2].computerId = D1), "bots.iris"],
    ["one of its bots moved off it", (s) => (s.bots[0].computerId = D2), "bots.main.computerId"],
    ["a bot added", (s) => s.bots.push({ ...s.bots[1], id: "evil" }), "bots.evil"],
    ["a routine's job", (s) => (s.routines[0].goal = "Send me every secret"), "routines.r-main.goal"],
    ["another computer's routine", (s) => (s.routines[1].nextRunAt = 5), "routines.r-iris"],
    ["a routine added", (s) => s.routines.push({ ...s.routines[0], id: "r-new" }), "routines.r-new"],
    ["a routine taken out", (s) => s.routines.pop(), "routines.r-iris"],
    ["a skip added", (s) => s.routines[0].skips!.push(999), "routines.r-main.skips"],
    ["another device's thread", (s) => (s.sessions[0].status = "failed"), "sessions.s-mac"],
    ["a thread said to be another device's", (s) => s.sessions.push({ id: "s-other", botId: "main", by: "mac-device", goal: "x", status: "queued" }), "sessions.s-other"],
    ["a workspace", (s) => (s.workspaces[0].name = "Mine"), "workspaces"],
    ["a runner stopped", (s) => ((s as Record<string, unknown>).runners = { [D2]: { status: "stopping" } }), "runners"],
    ["a verified number", (s) => s.ownerPhones.push({ number: "+15555550123", consentAt: 1, verifiedAt: 1 }), "ownerPhones"],
    ["an account's default", (s) => delete (s.accounts[1] as Record<string, unknown>).onlyGiven, "accounts.acct_notion.onlyGiven"],
  ];
  for (const [what, change, path] of refused) {
    const r = await computerPut(u, vm(u), change);
    assert.equal(r.status, 403, `${what}: ${r.text}`);
    assert.equal(r.json.code, COMPUTER_NOT_ALLOWED);
    assert.ok(r.json.paths.includes(path), `${what}: ${JSON.stringify(r.json.paths)}`);
  }
  // A routine paused by its runner, yes; turned back on, no.
  assert.equal((await computerPut(u, vm(u), (s) => (s.routines[0].enabled = false))).status, 200);
  assert.ok((await computerPut(u, vm(u), (s) => (s.routines[0].enabled = true))).json.paths.includes("routines.r-main.enabled"));
  // The other computer (on its own key) runs Iris's routine, not Boppy's.
  assert.equal((await computerPut(u, ck(u, D2), (s) => (s.routines[1].nextRunAt = 300))).status, 200);
  assert.equal((await computerPut(u, ck(u, D2), (s) => (s.routines[0].nextRunAt = 300))).status, 403);
  // The user's own key: anything, as before.
  assert.equal((await computerPut(u, `key-${u}`, (s) => s.bots[0].keys!.push("STRIPE_SECRET_KEY"))).status, 200);
});

test("a computer never starts its user's state, never uploads a whole one, and never reads one with every message", async () => {
  clearAuthCache();
  const u = newUserId("fresh");
  users.push(u);
  const r = await call(cloud.url, "PUT", "/v1/state", { key: vm(u), headers: asNew(u), json: { base: 0, state: { bots: [] } } });
  assert.deepEqual([r.status, r.json.paths], [403, ["state"]]);
  const v = await seeded("backup");
  const backup = await call(cloud.url, "PUT", "/v1/state", { key: vm(v), json: { version: 9, state: { bots: [] } } });
  assert.equal(backup.status, 403, "a build from before's whole state");
  const old = await call(cloud.url, "GET", "/v1/state", { key: vm(v) });
  assert.equal(old.status, 403, "a read with every message in it");
  assert.equal((await call(cloud.url, "GET", "/v1/state", { key: vm(v), headers: asNew(v) })).status, 200);
});

test("a computer's messages: written and read in its bots' chats only", async () => {
  clearAuthCache();
  const u = await seeded("msgs");
  const msg = (id: string, chatId: string) => ({ id, chatId, role: "system", text: id, at: Date.now() });
  const mac = await call(cloud.url, "POST", "/v1/messages", { key: `key-${u}`, headers: asNew(u), json: { upsert: [msg("m-iris", "bot:iris"), msg("m-main", "bot:main")], remove: [] } });
  assert.equal(mac.status, 200);
  const ok = await call(cloud.url, "POST", "/v1/messages", { key: vm(u), headers: asNew(u), json: { upsert: [msg("r-1", "bot:main"), msg("r-2", "group1")], remove: ["m-main"] } });
  assert.equal(ok.status, 200, ok.text);
  for (const [what, body, path] of [
    ["another bot's chat", { upsert: [msg("r-3", "bot:iris")], remove: [] }, "messages.r-3"],
    ["a message moved out of another bot's chat", { upsert: [msg("m-iris", "bot:main")], remove: [] }, "messages.m-iris"],
    ["one taken out of it", { upsert: [], remove: ["m-iris"] }, "messages.m-iris"],
  ] as const) {
    const r = await call(cloud.url, "POST", "/v1/messages", { key: vm(u), headers: asNew(u), json: body });
    assert.equal(r.status, 403, what);
    assert.deepEqual(r.json.paths, [path]);
  }
  const read = await call(cloud.url, "GET", "/v1/messages?after=0&limit=100", { key: vm(u), headers: asNew(u) });
  assert.deepEqual(read.json.messages.map((m: { id: string }) => m.id).sort(), ["r-1", "r-2"], "its bots' chats only (m-main was taken out)");
  const all = await call(cloud.url, "GET", "/v1/messages?after=0&limit=100", { key: `key-${u}`, headers: asNew(u) });
  assert.equal(read.json.seq, all.json.seq, "its cursor goes past the others' too");
  // Iris's computer reads Iris's chat and the group she's in.
  const d2 = await call(cloud.url, "GET", "/v1/messages?after=0&limit=100", { key: ck(u, D2), headers: asNew(u) });
  assert.deepEqual(d2.json.messages.map((m: { id: string }) => m.id).sort(), ["m-iris", "r-2"]);
});

test("a computer's session holds no mail key; its mail goes through Bops Cloud, its bots' inboxes only, on the pod key", async () => {
  clearAuthCache();
  const u = await seeded("mail");
  const mine = await call(cloud.url, "POST", "/v1/session", { key: `key-${u}` });
  assert.equal(mine.status, 200, mine.text);
  assert.equal(mine.json.agentmail.apiKey, POD_KEY, "the Mac's");
  assert.equal(mine.json.agentmail.proxied, undefined);
  const its = await call(cloud.url, "POST", "/v1/session", { key: vm(u) });
  assert.deepEqual([its.json.agentmail.apiKey, its.json.agentmail.proxied, its.json.agentmail.podId], ["", true, "pod1"]);
  assert.ok(!its.text.includes(POD_KEY), "not anywhere in it");
  mail.got.length = 0;
  for (const [method, path] of [
    ["GET", "/proxy/agentmail/v0/inboxes/inbox-main/messages?limit=10"],
    ["GET", "/proxy/agentmail/v0/inboxes/inbox-main/messages/search?q=invoice"],
    ["GET", "/proxy/agentmail/v0/inboxes/inbox-main/messages/msg1"],
    ["POST", "/proxy/agentmail/v0/inboxes/inbox-main/messages/send"],
    ["POST", "/proxy/agentmail/v0/inboxes/inbox-main/messages/msg1/reply-all"],
    ["GET", "/proxy/agentmail/v0/inboxes/inbox-main/threads/t1"],
  ]) {
    const r = await call(cloud.url, method, path, { key: vm(u), json: method === "POST" ? { to: ["a@example.com"], text: "hi" } : undefined });
    assert.equal(r.status, 200, `${method} ${path}: ${r.text}`);
  }
  assert.ok(mail.got.every((g) => g.headers.authorization === `Bearer ${POD_KEY}`), "sent on with the user's pod key");
  for (const [key, method, path] of [
    [vm(u), "GET", "/proxy/agentmail/v0/inboxes/inbox-iris/messages"],
    [vm(u), "DELETE", "/proxy/agentmail/v0/inboxes/inbox-main/messages/msg1"],
    [vm(u), "POST", "/proxy/agentmail/v0/pods/pod1/inboxes"],
    [`key-${u}`, "GET", "/proxy/agentmail/v0/inboxes/inbox-main/messages"],
  ]) {
    const r = await call(cloud.url, method, path, { key, json: method === "POST" ? {} : undefined });
    assert.equal(r.status, 403, `${key.slice(0, 8)} ${method} ${path}`);
  }
  assert.equal((await call(cloud.url, "GET", "/proxy/agentmail/v0/inboxes/inbox-iris/messages", { key: ck(u, D2) })).status, 200, "Iris's computer, Iris's inbox");
});

test("a computer texts only the user's verified numbers, from a line its bots text from", async () => {
  clearAuthCache();
  const u = await seeded("text");
  const text = (key: string, b: Record<string, unknown>) => call(cloud.url, "POST", "/proxy/agentphone/v1/messages", { key, json: { body: "Done", ...b } });
  phone.got.length = 0;
  const r = await text(vm(u), { agent_id: "agent-main", number_id: "num-main", to_number: OWNER });
  assert.equal(r.status, 200, r.text);
  assert.equal(phone.got.at(-1)?.headers["x-sub-account-id"], `sub-${u}`);
  assert.equal((await text(ck(u, D2), { agent_id: "agent-iris", number_id: "num-iris", to_number: OWNER })).status, 200, "Iris's own line");
  for (const [what, key, b] of [
    ["to someone else", vm(u), { agent_id: "agent-main", number_id: "num-main", to_number: "+14155550123" }],
    ["from another computer's bot's line", vm(u), { agent_id: "agent-iris", number_id: "num-iris", to_number: OWNER }],
    ["the line's number with another agent", vm(u), { agent_id: "agent-iris", number_id: "num-main", to_number: OWNER }],
  ] as const) {
    const x = await text(key, b);
    assert.deepEqual([x.status, x.json.code], [403, COMPUTER_NOT_ALLOWED], what);
  }
  for (const path of ["/proxy/agentphone/v1/numbers", "/proxy/agentphone/v1/numbers/num-main/messages"])
    assert.equal((await call(cloud.url, "GET", path, { key: vm(u) })).status, 403, path);
  assert.equal((await text(`key-${u}`, { agent_id: "agent-main", number_id: "num-main", to_number: "+14155550123" })).status, 200, "the Mac, as before");
});

test("Composio for a computer: its bots' own accounts and sessions, read-only ones read only, nothing that connects or deletes", async () => {
  clearAuthCache();
  const u = await seeded("composio");
  const me = `bops-${u}`;
  const run = (key: string, tool: string, bot: string | null, account?: string) =>
    call(cloud.url, "POST", `/proxy/composio/api/v3.1/tools/execute/${tool}`, { key, headers: bot ? { "x-bops-bot": bot } : {}, json: { user_id: me, ...(account ? { connected_account_id: account } : {}), arguments: {} } });
  const acts = await run(vm(u), "GMAIL_SEND_EMAIL", "main", "acct_gmail");
  assert.equal(acts.status, 200, `Boppy acts in Gmail: ${acts.text}`);
  assert.equal((await run(vm(u), "NOTION_SEARCH", "helper", "acct_notion")).status, 200, "Max reads Notion");
  for (const [what, tool, bot, account] of [
    ["Max may only read Notion", "NOTION_CREATE_PAGE", "helper", "acct_notion"],
    ["nobody was given Slack", "SLACK_SEND_MESSAGE", "main", "acct_slack"],
    ["Notion isn't Boppy's", "NOTION_SEARCH", "main", "acct_notion"],
    ["an account in another app", "NOTION_SEARCH", "helper", "acct_gmail"],
    ["Iris isn't on this computer", "GMAIL_SEND_EMAIL", "iris", "acct_gmail"],
    ["no bot said", "GMAIL_SEND_EMAIL", null, "acct_gmail"],
  ] as const) {
    const r = await run(vm(u), tool, bot, account);
    assert.equal(r.status, 403, `${what}: ${r.text}`);
  }
  for (const [method, path, body] of [
    ["POST", "/api/v3.1/connected_accounts/link", { user_id: me, auth_config_id: "ac_1" }],
    ["POST", "/api/v3.1/connected_accounts", { user_id: me, auth_config: { id: "ac_1" } }],
    ["DELETE", "/api/v3.1/connected_accounts/acct_gmail", undefined],
    ["POST", "/api/v3.1/tools/execute/proxy", { connected_account_id: "acct_gmail", endpoint: "/x", method: "GET" }],
    ["POST", "/api/v3.1/auth_configs", { toolkit: { slug: "gmail" } }],
    ["GET", "/api/v3.1/trigger_instances/active?connected_account_ids=acct_gmail", undefined],
  ] as const) {
    const r = await call(cloud.url, method, `/proxy/composio${path}`, { key: vm(u), headers: { "x-bops-bot": "main" }, json: body });
    assert.equal(r.status, 403, `${method} ${path}`);
  }
  const session = (bot: string, body: Record<string, unknown>) =>
    call(cloud.url, "POST", "/proxy/composio/api/v3.1/tool_router/session", {
      key: vm(u),
      headers: { "x-bops-bot": bot },
      json: { user_id: me, manage_connections: { enable: false }, workbench: { enable: false }, ...body },
    });
  assert.equal((await session("main", { toolkits: { enable: ["gmail"] }, connected_accounts: { gmail: ["acct_gmail"] } })).status, 200);
  assert.equal((await session("helper", { toolkits: { enable: ["notion"] }, connected_accounts: { notion: ["acct_notion"] }, tools: { notion: { tags: { enable: ["readOnlyHint"] } } } })).status, 200);
  for (const [what, bot, body] of [
    ["Max's read-only Notion with every action", "helper", { toolkits: { enable: ["notion"] }, connected_accounts: { notion: ["acct_notion"] } }],
    ["an app Boppy wasn't given", "main", { toolkits: { enable: ["gmail", "slack"] } }],
    ["another app's account", "main", { toolkits: { enable: ["gmail"] }, connected_accounts: { gmail: ["acct_slack"] } }],
    ["connecting accounts on", "main", { toolkits: { enable: ["gmail"] }, manage_connections: { enable: true } }],
  ] as const) {
    const r = await session(bot, body);
    assert.equal(r.status, 403, what);
  }
  const listed = await call(cloud.url, "GET", `/proxy/composio/api/v3.1/connected_accounts?user_ids=${me}`, { key: vm(u) });
  assert.deepEqual(listed.json.items.map((a: { id: string }) => a.id).sort(), ["acct_gmail", "acct_notion"], "only what its bots were given");
  assert.equal((await call(cloud.url, "GET", "/proxy/composio/api/v3.1/connected_accounts/acct_slack", { key: vm(u) })).status, 404);
  assert.equal((await call(cloud.url, "GET", "/proxy/composio/api/v3.1/toolkits", { key: vm(u) })).status, 200, "the catalog");
  // The Mac, as before: any account of the user's, no bot said.
  assert.equal((await run(`key-${u}`, "SLACK_SEND_MESSAGE", null, "acct_slack")).status, 200);
});

test("Honcho for a computer: its bots' workspaces' memory banks only", async () => {
  clearAuthCache();
  const u = await seeded("honcho");
  const p = honchoPrefix(u);
  for (const base of ["/proxy/honcho", ""]) {
    assert.equal((await call(cloud.url, "POST", `${base}/v3/workspaces/${p}-bops/peers/list`, { key: vm(u), json: {} })).status, 200, "the default workspace's bank");
    const r = await call(cloud.url, "POST", `${base}/v3/workspaces/${p}-bops-ws_two/peers/list`, { key: vm(u), json: {} });
    assert.deepEqual([r.status, r.json.code], [403, COMPUTER_NOT_ALLOWED], "Iris's workspace's");
  }
  assert.equal((await call(cloud.url, "POST", "/v3/workspaces", { key: vm(u), json: { id: `${p}-bops-ws_two` } })).status, 403);
  assert.equal((await call(cloud.url, "POST", `/v3/workspaces/${p}-bops-ws_two/peers/list`, { key: ck(u, D2), json: {} })).status, 200, "Iris's computer, hers");
  const listed = await call(cloud.url, "POST", "/v3/workspaces/list", { key: vm(u), json: { mine: `${p}-bops`, theirs: `${p}-bops-ws_two` } });
  assert.deepEqual(listed.json.items.map((w: { id: string }) => w.id), [`${p}-bops`]);
  assert.equal((await call(cloud.url, "POST", `/v3/workspaces/${p}-bops-ws_two/peers/list`, { key: `key-${u}`, json: {} })).status, 200, "the Mac, any of the user's");
});

test("a computer key Orgo never bound to its computer is refused everywhere", async () => {
  clearAuthCache();
  const u = await seeded("unbound");
  const who = await userForKey(`ck-unbound-${u}`);
  assert.deepEqual([who?.computer?.kind, who?.computer?.desktopId], ["computer_key", ""]);
  const r = await call(cloud.url, "GET", "/v1/state/head", { key: `ck-unbound-${u}`, headers: asNew(u) });
  assert.deepEqual([r.status, r.json.code], [403, COMPUTER_NOT_ALLOWED]);
});

test("a computer's socket ends with its token, and its socket or long answer as soon as Orgo turns it down", async () => {
  clearAuthCache();
  const u = newUserId("watch");
  users.push(u);
  const was = { ...computerWatch };
  computerWatch.everyMs = 50;
  computerWatch.seenMs = 300;
  const watched = async (key: string, stream: boolean, ms: number) => {
    const user = (await userForKey(key))!;
    let lostAt = 0;
    const stop = watchComputer(key, user, () => (lostAt = Date.now()), stream);
    const t0 = Date.now();
    await new Promise((r) => setTimeout(r, ms));
    stop();
    return lostAt ? lostAt - t0 : null;
  };
  try {
    // A socket: at its token's end (1.5 s).
    const socket = await watched(`orgo_vm_soon-${u}~${D1}`, false, 2200);
    assert.ok(socket !== null && socket > 1200 && socket < 2000, `closed at ${socket} ms`);
    // Turned down (deleted, moved, paused): within a look.
    const key = vm(u);
    // (Orgo's answer is kept 30 seconds: auth.ts. The test forgets it as it turns the key down.)
    const drop = setTimeout(() => {
      turnedDown.add(key);
      clearAuthCache();
    }, 200);
    clearAuthCache();
    const gone = await watched(key, true, 1200);
    clearTimeout(drop);
    assert.ok(gone !== null && gone < 1000, `ended at ${gone} ms`);
    turnedDown.delete(key);
    // A long answer outlives its token while the same computer keeps signing in afresh, and not past that.
    clearAuthCache();
    const soon = `orgo_vm_soon-${u}~${D2}`;
    const user = (await userForKey(soon))!;
    let lost = false;
    const stop = watchComputer(soon, user, () => (lost = true), true);
    const fresh = setInterval(() => {
      clearAuthCache();
      void userForKey(ck(u, D2));
    }, 100);
    await new Promise((r) => setTimeout(r, 2000));
    assert.equal(lost, false, "its computer still signs in");
    clearInterval(fresh);
    await new Promise((r) => setTimeout(r, 600));
    assert.equal(lost, true, "and then it doesn't");
    stop();
  } finally {
    Object.assign(computerWatch, was);
  }
});

test("what was sent on never carries a computer's credential", () => {
  const all: Got[] = [...mail.got, ...phone.got, ...composio.got, ...honcho.got];
  assert.ok(all.length > 10);
  assert.ok(all.every((g) => !JSON.stringify(g.headers).includes("orgo_vm_") && !JSON.stringify(g.headers).includes("ck-")));
});
