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

/**
 * Orgo's profile: `key-<u>` the user's key, `orgo_vm_<u>~<d>` (or `orgo_vm_soon-…`, ending in 1.5 s) a
 * computer's token, `ck-<u>~<d>` its key, `ck-unbound-<u>` a computer key Orgo never bound. `#<n>` after
 * any of them is the same one again, which Bops Cloud kept no answer for: a sign-in afresh.
 */
function profile(req: IncomingMessage, res: ServerResponse) {
  const sent = /^Bearer (.+)$/.exec(req.headers.authorization ?? "")?.[1] ?? "";
  if (req.url !== "/api/user/profile" || turnedDown.has(sent)) return json(res, 401, { error: "no" });
  const key = sent.replace(/#\d+$/, "");
  let m: RegExpExecArray | null;
  if ((m = /^key-(.+)$/.exec(key))) return json(res, 200, { id: m[1], email: `${m[1]}@example.com`, api_key: { id: "k0", scope: "account" } });
  if ((m = /^orgo_vm_(soon-)?([^~]+)~([^~]+)$/.exec(key)))
    return json(res, 200, { id: m[2], api_key: null, principal: { kind: "vm_identity", desktop_id: m[3], expires_at: new Date(Date.now() + (m[1] ? 1500 : 3600_000)).toISOString() } });
  if ((m = /^ck-unbound-(.+)$/.exec(key))) return json(res, 200, { id: m[1], api_key: { id: "k2", scope: "account", computer_key: true } });
  if ((m = /^ck-([^~]+)~([^~]+)$/.exec(key))) return json(res, 200, { id: m[1], api_key: { id: "k1", scope: "computer", computer_id: m[2], computer_key: true } });
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

/** Each test's longest: one that hangs fails instead of holding up node --test. */
const T = { timeout: 60_000 };
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
/** Whether `ok()` comes true within `ms`, looked at every 20 ms. */
async function within(ms: number, ok: () => boolean) {
  for (const end = Date.now() + ms; !ok() && Date.now() < end; ) await sleep(20);
  return ok();
}

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
    sessions: [{ id: "s-mac", botId: "main", by: "mac-device", goal: "x", status: "done" }] as { id: string; botId: string; chatId?: string; by: string; goal: string; status: string; routineId?: string }[],
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

test("a computer's state write: its own threads, its bots' routines' runs and how they're doing; nothing else", T, async () => {
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
    ["a thread of another computer's bot", (s) => s.sessions.push({ id: "s-iris", botId: "iris", chatId: "bot:iris", by: me, goal: "Confirm your bank", status: "done" }), "sessions.s-iris"],
    ["a thread of its bot in another's chat", (s) => s.sessions.push({ id: "s-away", botId: "main", chatId: "bot:iris", by: me, goal: "x", status: "done" }), "sessions.s-away"],
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

test("a computer's requests for the user's OK: its own bots', added unanswered and taken out; never a reply (its own included), never another's; the user's own Bops replies", T, async () => {
  clearAuthCache();
  const u = await seeded("asks");
  const me = deviceIdOf(u, D1);
  type Reply = { reply: string; by?: string; at: number; reason?: string };
  type Ask = { id: string; botId: string; askedBy: string; action: string; resources: string[]; preview: string; at: number; threadId?: string; reply?: Reply };
  const asks = (s: ReturnType<typeof stateOf>) => ((s as Record<string, unknown>).appApprovals ??= []) as Ask[];
  const ask = (o: Partial<Ask> & { id: string }): Ask => ({ botId: "main", askedBy: me, action: "Send an email", resources: ["dana@acme.example"], preview: "to: dana@acme.example", at: 1, ...o });
  // Its own bot's, unanswered: taken.
  assert.equal((await computerPut(u, vm(u), (s) => asks(s).push(ask({ id: "apr-1", threadId: "s-run" })))).status, 200);
  // The Mac's request is there too (the user's own key).
  assert.equal((await computerPut(u, `key-${u}`, (s) => asks(s).push(ask({ id: "apr-mac", askedBy: "mac-device" })))).status, 200);
  const refused: [string, (s: ReturnType<typeof stateOf>) => void, string][] = [
    ["its own request answered once", (s) => (asks(s)[0].reply = { reply: "once", by: me, at: 2 }), "appApprovals.apr-1"],
    ["its own request answered always", (s) => (asks(s)[0].reply = { reply: "always", by: me, at: 2 }), "appApprovals.apr-1"],
    ["its own request rejected", (s) => (asks(s)[0].reply = { reply: "reject", by: me, at: 2 }), "appApprovals.apr-1"],
    ["what it asks changed", (s) => (asks(s)[0].preview = "to: everyone@acme.example"), "appApprovals.apr-1"],
    ["one added answered", (s) => asks(s).push(ask({ id: "apr-yes", reply: { reply: "once", by: me, at: 2 } })), "appApprovals.apr-yes"],
    ["another Bops's request stopped", (s) => (asks(s)[1].reply = { reply: "reject", reason: "stopped", by: me, at: 2 }), "appApprovals.apr-mac"],
    ["another Bops's request taken out", (s) => asks(s).splice(1, 1), "appApprovals.apr-mac"],
    ["a request as another Bops", (s) => asks(s).push(ask({ id: "apr-as-mac", askedBy: "mac-device" })), "appApprovals.apr-as-mac"],
    ["a request for another computer's bot", (s) => asks(s).push(ask({ id: "apr-iris", botId: "iris" })), "appApprovals.apr-iris"],
  ];
  for (const [what, change, path] of refused) {
    const r = await computerPut(u, vm(u), change);
    assert.equal(r.status, 403, `${what}: ${r.text}`);
    assert.equal(r.json.code, COMPUTER_NOT_ALLOWED);
    assert.ok(r.json.paths.includes(path), `${what}: ${JSON.stringify(r.json.paths)}`);
  }
  assert.equal(asks((await stateNow(u)).state)[0].reply, undefined, "still waiting on the owner");
  // The owner replies from their own Bops (the user's own key): taken; and the computer takes out its own request once it read it.
  assert.equal((await computerPut(u, `key-${u}`, (s) => (asks(s)[0].reply = { reply: "once", by: "mac-device", at: 3 }))).status, 200);
  assert.equal((await computerPut(u, vm(u), (s) => ((s as Record<string, unknown>).appApprovals = asks(s).filter((a) => a.id !== "apr-1")))).status, 200);
  // Cancelled by the computer that asked (taken out unanswered): taken.
  assert.equal((await computerPut(u, vm(u), (s) => asks(s).push(ask({ id: "apr-2" })))).status, 200);
  assert.equal((await computerPut(u, vm(u), (s) => ((s as Record<string, unknown>).appApprovals = asks(s).filter((a) => a.id !== "apr-2")))).status, 200);
  assert.deepEqual(asks((await stateNow(u)).state).map((a) => a.id), ["apr-mac"]);
});

test("a computer ends the run it began of a bot moved off it meanwhile: its thread, the routine's record, its chip and result; nothing new of that bot's", T, async () => {
  clearAuthCache();
  const u = await seeded("moved");
  const me = deviceIdOf(u, D1);
  // Max (on D1, Boppy's computer) has a routine; D1's runner begins its 9:00 run.
  assert.equal((await computerPut(u, `key-${u}`, (s) => s.routines.push({ id: "r-max", botId: "helper", title: "Max's", goal: "His", schedule: { kind: "daily", times: ["09:00"] }, enabled: true, nextRunAt: 100 }))).status, 200);
  const began = await computerPut(u, vm(u), (s) => {
    s.sessions.push({ id: "s-max", botId: "helper", chatId: "bot:helper", by: me, goal: "His", status: "running" });
    Object.assign(s.routines[2], { nextRunAt: 200, lastRunAt: 100, last: { at: 100, status: "running", sessionId: "s-max" } });
  });
  assert.equal(began.status, 200, began.text);
  const post = (body: { readonly upsert: readonly unknown[]; readonly remove: readonly string[] }) => call(cloud.url, "POST", "/v1/messages", { key: vm(u), headers: asNew(u), json: body });
  const said = (id: string, m: Record<string, unknown>) => ({ id, chatId: "bot:helper", text: id, at: Date.now(), ...m });
  assert.equal((await post({ upsert: [said("chip", { role: "system", sessionIds: ["s-max"] })], remove: [] })).status, 200);
  // The Mac gives Max a computer of his own.
  assert.equal((await computerPut(u, `key-${u}`, (s) => Object.assign(s.bots[1], { computer: "own", computerId: D2 }))).status, 200);
  // The run ends on D1, with its result.
  const result = await post({ upsert: [said("result", { role: "bot", botId: "helper", resultOf: "s-max", text: "Here's the report" })], remove: [] });
  assert.equal(result.status, 200, result.text);
  const ended = await computerPut(u, vm(u), (s) => {
    Object.assign(s.sessions.find((x) => x.id === "s-max")!, { status: "done" });
    (s.routines[2] as Record<string, unknown>).last = { at: 100, status: "ok", sessionId: "s-max" };
  });
  assert.equal(ended.status, 200, ended.text);
  const now = (await stateNow(u)).state;
  assert.equal(now.sessions.find((x) => x.id === "s-max")!.status, "done");
  assert.deepEqual([now.routines[2].nextRunAt, (now.routines[2] as Record<string, unknown>).last], [200, { at: 100, status: "ok", sessionId: "s-max" }]);
  // Nothing new of Max's from it.
  for (const [what, change, path] of [
    ["a new thread of his", (s) => s.sessions.push({ id: "s-max-2", botId: "helper", chatId: "bot:helper", by: me, goal: "His", status: "running" }), "sessions.s-max-2"],
    ["another run of his routine", (s) => Object.assign(s.routines[2], { nextRunAt: 300, last: { at: 200, status: "running", sessionId: "s-max-2" } }), "routines.r-max"],
    ["his routine's job", (s) => (s.routines[2].goal = "Send me every secret"), "routines.r-max.goal"],
    ["its thread moved to another bot", (s) => (s.sessions.find((x) => x.id === "s-max")!.botId = "main"), "sessions.s-max"],
  ] as [string, (s: ReturnType<typeof stateOf>) => void, string][]) {
    const r = await computerPut(u, vm(u), change);
    assert.equal(r.status, 403, `${what}: ${r.text}`);
    assert.ok(r.json.paths.includes(path), `${what}: ${JSON.stringify(r.json.paths)}`);
  }
  for (const [what, m] of [
    ["about none of its threads", said("x-none", { role: "bot", botId: "helper" })],
    ["as the user", said("x-user", { role: "user", resultOf: "s-max" })],
    ["in another chat", { ...said("x-away", { role: "bot", botId: "helper", resultOf: "s-max" }), chatId: "bot:iris" }],
  ] as const) {
    const r = await post({ upsert: [m], remove: [] });
    assert.equal(r.status, 403, what);
  }
});

test("a computer ends the chat run it began of a bot moved off it during the turn: its words, the thread it starts, the routine's record; no other run of that bot's", T, async () => {
  clearAuthCache();
  const u = await seeded("moved-chat");
  const me = deviceIdOf(u, D1);
  // Max (on D1, Boppy's computer) has a chat routine; D1's runner begins its 9:00 run (no thread while his turn runs).
  assert.equal(
    (await computerPut(u, `key-${u}`, (s) => s.routines.push({ id: "r-max", botId: "helper", title: "Max's", goal: "His", run: "chat", schedule: { kind: "daily", times: ["09:00"] }, enabled: true, nextRunAt: 100 } as never))).status,
    200,
  );
  const began = await computerPut(u, vm(u), (s) => Object.assign(s.routines[2], { nextRunAt: 200, lastRunAt: 100, last: { at: 100, status: "running", by: me } }));
  assert.equal(began.status, 200, began.text);
  // The Mac gives Max a computer of his own while the turn runs.
  assert.equal((await computerPut(u, `key-${u}`, (s) => Object.assign(s.bots[1], { computer: "own", computerId: D2 }))).status, 200);
  const post = (body: { readonly upsert: readonly unknown[]; readonly remove: readonly string[] }) => call(cloud.url, "POST", "/v1/messages", { key: vm(u), headers: asNew(u), json: body });
  const said = (id: string, m: Record<string, unknown>) => ({ id, chatId: "bot:helper", text: id, at: Date.now(), routine: { id: "r-max" }, ...m });
  // The turn's words and its chip, then the thread it started and the run's record of it.
  const words = await post({ upsert: [said("chip", { role: "system", sessionIds: ["s-max"] }), said("note", { role: "system", text: "Read example.com" }), said("answer", { role: "bot", botId: "helper" })], remove: [] });
  assert.equal(words.status, 200, words.text);
  const thread = await computerPut(u, vm(u), (s) => {
    s.sessions.push({ id: "s-max", botId: "helper", chatId: "bot:helper", by: me, goal: "His", status: "queued", routineId: "r-max" });
    (s.routines[2] as Record<string, unknown>).last = { at: 100, status: "running", sessionId: "s-max", by: me };
  });
  assert.equal(thread.status, 200, thread.text);
  // It ends there, with its result.
  assert.equal((await post({ upsert: [said("result", { role: "bot", botId: "helper", resultOf: "s-max", routine: undefined })], remove: [] })).status, 200);
  const ended = await computerPut(u, vm(u), (s) => {
    Object.assign(s.sessions.find((x) => x.id === "s-max")!, { status: "done" });
    (s.routines[2] as Record<string, unknown>).last = { at: 100, status: "ok", sessionId: "s-max", by: me, delivery: { status: "sent", to: "email", at: 101 } };
  });
  assert.equal(ended.status, 200, ended.text);
  const now = (await stateNow(u)).state;
  assert.equal(now.sessions.find((x) => x.id === "s-max")!.status, "done");
  assert.deepEqual([now.routines[2].nextRunAt, (now.routines[2] as Record<string, unknown>).last], [200, { at: 100, status: "ok", sessionId: "s-max", by: me, delivery: { status: "sent", to: "email", at: 101 } }]);
  // Nothing new of Max's from it: no other run, no thread of none, nothing more said once the run ended.
  for (const [what, change, path] of [
    ["another run of his routine", (s) => Object.assign(s.routines[2], { nextRunAt: 300, last: { at: 200, status: "running", by: me } }), "routines.r-max"],
    ["a thread of his", (s) => s.sessions.push({ id: "s-max-2", botId: "helper", chatId: "bot:helper", by: me, goal: "His", status: "queued", routineId: "r-max" }), "sessions.s-max-2"],
    ["his routine's job", (s) => (s.routines[2].goal = "Send me every secret"), "routines.r-max.goal"],
  ] as [string, (s: ReturnType<typeof stateOf>) => void, string][]) {
    const r = await computerPut(u, vm(u), change);
    assert.equal(r.status, 403, `${what}: ${r.text}`);
    assert.ok(r.json.paths.includes(path), `${what}: ${JSON.stringify(r.json.paths)}`);
  }
  // What the run says after its end landed (a save that was already sending, a ping on its result, a "Couldn't
  // send") is still its own: posted since that run began, while the routine's last run is that runner's.
  const late = await post({ upsert: [said("answer", { role: "bot", botId: "helper", ping: true }), said("late", { role: "system", text: "Couldn't send it by text" })], remove: [] });
  assert.equal(late.status, 200, late.text);
  assert.equal((await post({ upsert: [said("before", { role: "bot", botId: "helper", at: 50 })], remove: [] })).status, 403, "never one from before that run began");
  assert.equal((await post({ upsert: [said("as-boppy", { role: "bot", botId: "main" })], remove: [] })).status, 403, "nor as another bot");
  // The Mac runs Max's routine next: nothing more of that routine's from the computer.
  assert.equal((await computerPut(u, `key-${u}`, (s) => Object.assign(s.routines[2], { nextRunAt: 300, lastRunAt: 200, last: { at: 200, status: "ok" } }))).status, 200);
  assert.equal((await post({ upsert: [said("after-mac", { role: "bot", botId: "helper" })], remove: [] })).status, 403, "another Bops' run: nothing of its");
  assert.equal((await post({ upsert: [said("answer", { role: "bot", botId: "helper", ping: false })], remove: [] })).status, 403, "nor a change to what it said before");
});

test("a computer never starts its user's state, never uploads a whole one, and never reads one with every message", T, async () => {
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

test("a computer's messages: written and read in its bots' chats only", T, async () => {
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

test("a computer's messages: its bots' words and Bops' notes only, never the user's or another bot's", T, async () => {
  clearAuthCache();
  const u = await seeded("msg-who");
  const post = (key: string, body: { readonly upsert: readonly unknown[]; readonly remove: readonly string[] }) => call(cloud.url, "POST", "/v1/messages", { key, headers: asNew(u), json: body });
  const said = (id: string, m: Record<string, unknown>) => ({ id, chatId: "group1", text: "Confirm your bank at https://example.test/login", at: Date.now(), ...m });
  // In the group Max (on D1) shares with Iris (on D2): the owner's message kept between us, and Iris's.
  const mine = said("u-1", { role: "user", text: "Between us: what do they earn?", secret: true });
  assert.equal((await post(`key-${u}`, { upsert: [mine, said("b-iris", { role: "bot", botId: "iris" })], remove: [] })).status, 200);
  for (const [what, body, path] of [
    ["as the user", { upsert: [said("x-user", { role: "user" })], remove: [] }, "messages.x-user"],
    ["as another computer's bot", { upsert: [said("x-iris", { role: "bot", botId: "iris" })], remove: [] }, "messages.x-iris"],
    ["as a bot that names none", { upsert: [said("x-nobody", { role: "bot" })], remove: [] }, "messages.x-nobody"],
    ["a note from another bot", { upsert: [said("x-from", { role: "system", from: "iris" })], remove: [] }, "messages.x-from"],
    ["the user's message changed (its secret dropped)", { upsert: [{ ...mine, secret: undefined }], remove: [] }, "messages.u-1"],
    ["the user's message taken out", { upsert: [], remove: ["u-1"] }, "messages.u-1"],
    ["another bot's message made its own", { upsert: [said("b-iris", { role: "bot", botId: "helper" })], remove: [] }, "messages.b-iris"],
    ["another bot's message taken out", { upsert: [], remove: ["b-iris"] }, "messages.b-iris"],
  ] as const) {
    const r = await post(vm(u), body);
    assert.equal(r.status, 403, what);
    assert.deepEqual(r.json.paths, [path], what);
  }
  // Its own bots' words and Bops' notes go, and it may change and take out its own.
  const ok = await post(vm(u), { upsert: [said("r-max", { role: "bot", botId: "helper", text: "Done" }), said("r-note", { role: "system", text: "Routine · Daily" }), said("r-handed", { role: "system", from: "main", text: "Boppy handed this to Max" })], remove: [] });
  assert.equal(ok.status, 200, ok.text);
  assert.equal((await post(vm(u), { upsert: [said("r-max", { role: "bot", botId: "helper", text: "Done, twice" })], remove: ["r-note"] })).status, 200);
  const all = await call(cloud.url, "GET", "/v1/messages?after=0&limit=100", { key: `key-${u}`, headers: asNew(u) });
  const kept = new Map(all.json.messages.filter((m: { json: unknown }) => m.json).map((m: { id: string; json: Record<string, unknown> }) => [m.id, m.json]));
  assert.deepEqual([...kept.keys()].sort(), ["b-iris", "r-handed", "r-max", "u-1"]);
  assert.equal((kept.get("u-1") as Record<string, unknown>).secret, true, "the user's message as they wrote it");
  assert.equal((kept.get("b-iris") as Record<string, unknown>).botId, "iris");
});

test("a computer's session holds no mail key; its mail goes through Bops Cloud, its bots' inboxes only, on the pod key", T, async () => {
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
  assert.equal((await call(cloud.url, "GET", "/proxy/agentmail/v0/inboxes/inbox-main/messages", { key: ck(u, D2) })).status, 403, "Iris has her own (and works in another workspace): never the main bot's");
});

test("a computer texts only the user's verified numbers, from a line its bots text from", T, async () => {
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

test("Composio for a computer: its bots' own accounts and sessions, read-only ones read only, nothing that connects or deletes", T, async () => {
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

test("a bot's computer is trusted with what its run sends: an action the user allowed goes as the runner sends it, an empty file input Composio dropped included, with nothing of their answer checked again here", T, async () => {
  clearAuthCache();
  const u = await seeded("trusted");
  const send = (args: Record<string, unknown>) =>
    call(cloud.url, "POST", "/proxy/composio/api/v3.1/tools/execute/GMAIL_SEND_EMAIL", { key: vm(u), headers: { "x-bops-bot": "main" }, json: { user_id: `bops-${u}`, connected_account_id: "acct_gmail", arguments: args } });
  const sent = () => composio.got.filter((g) => g.method === "POST" && g.path === "/api/v3.1/tools/execute/GMAIL_SEND_EMAIL").at(-1)?.json?.arguments;
  // The runner asked with attachment "" in its inputs; Composio's SDK drops an empty file input before it sends.
  const email = { recipient_email: "dana@acme.example", subject: "Report", body: "Here it is" };
  for (const args of [email, { ...email, attachment: "" }]) {
    const r = await send(args);
    assert.equal(r.status, 200, `${JSON.stringify(args)}: ${r.text}`);
    assert.deepEqual(sent(), args, "sent on as it came");
  }
  // An email to someone else from the bot's own inbox, as its run sends it once the user allowed it.
  const mailed = await call(cloud.url, "POST", "/proxy/agentmail/v0/inboxes/inbox-main/messages/send", { key: vm(u), json: { to: ["dana@acme.example"], subject: "Report", text: "Here it is" } });
  assert.equal(mailed.status, 200, mailed.text);
});

test("Honcho for a computer: its bots' workspaces' memory banks only", T, async () => {
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

test("a computer key Orgo never bound to its computer is refused everywhere", T, async () => {
  clearAuthCache();
  const u = await seeded("unbound");
  const who = await userForKey(`ck-unbound-${u}`);
  assert.deepEqual([who?.computer?.kind, who?.computer?.desktopId], ["computer_key", ""]);
  const r = await call(cloud.url, "GET", "/v1/state/head", { key: `ck-unbound-${u}`, headers: asNew(u) });
  assert.deepEqual([r.status, r.json.code], [403, COMPUTER_NOT_ALLOWED]);
});

test("a computer's socket ends with its token, and its socket or long answer as soon as Orgo turns it down", T, async () => {
  clearAuthCache();
  const u = newUserId("watch");
  users.push(u);
  const was = { ...computerWatch };
  computerWatch.everyMs = 50;
  // Eight of the sign-ins below in it: a moment the process is held up (a busy machine) isn't taken for the computer gone.
  computerWatch.seenMs = 800;
  const key = vm(u);
  const stops: (() => void)[] = [];
  let fresh: ReturnType<typeof setInterval> | undefined;
  /** Watch `key` as server.ts does a socket (`stream` false) or a long answer: when it ended, 0 while it hasn't. */
  const watch = async (key: string, stream: boolean) => {
    const user = (await userForKey(key))!;
    const w = { user, endedAt: 0 };
    stops.push(watchComputer(key, user, () => (w.endedAt = Date.now()), stream));
    return w;
  };
  try {
    // A socket: at its token's end (1.5 s), never before it.
    const socket = await watch(`orgo_vm_soon-${u}~${D1}`, false);
    const ends = socket.user.computer!.expiresAt;
    assert.ok(await within(ends - Date.now() + 2000, () => socket.endedAt > 0), "closed at its token's end");
    assert.ok(socket.endedAt >= ends, `closed ${ends - socket.endedAt} ms before its token's end`);
    // Turned down (deleted, moved, paused): within a look.
    clearAuthCache();
    const answer = await watch(key, true);
    await sleep(200);
    // (Orgo's answer is kept 30 seconds: auth.ts. The test forgets it as it turns the key down.)
    turnedDown.add(key);
    clearAuthCache();
    const downAt = Date.now();
    assert.ok(await within(3000, () => answer.endedAt > 0), "ended once Orgo turned it down");
    assert.ok(answer.endedAt >= downAt && answer.endedAt - downAt < 1000, `ended ${answer.endedAt - downAt} ms after`);
    // A long answer outlives its token while the same computer keeps signing in afresh (its runner on
    // its own key, every 100 ms here), and not past that. Each sign-in is one Bops Cloud kept no answer
    // for (`#<n>`), so when Orgo last said it's good never goes back to nothing in between.
    clearAuthCache();
    const long = await watch(`orgo_vm_soon-${u}~${D2}`, true);
    const expires = long.user.computer!.expiresAt;
    let n = 0;
    let signedInAt = 0;
    fresh = setInterval(() => void userForKey(`${ck(u, D2)}#${++n}`).then((x) => x?.computer?.desktopId === D2 && (signedInAt = Date.now())), 100);
    // Past its token's end by more than seenMs: it would have ended by now, signed in only at its start.
    await sleep(Math.max(0, expires - Date.now()) + computerWatch.seenMs + 400);
    assert.equal(long.endedAt, 0, "its computer still signs in");
    clearInterval(fresh);
    fresh = undefined;
    assert.ok(await within(computerWatch.seenMs + 3000, () => long.endedAt > 0), "and then it doesn't");
    assert.ok(long.endedAt - signedInAt >= computerWatch.seenMs - 50, `ended ${long.endedAt - signedInAt} ms after its last sign-in`);
  } finally {
    if (fresh) clearInterval(fresh);
    for (const stop of stops) stop();
    turnedDown.delete(key);
    Object.assign(computerWatch, was);
  }
});

test("what was sent on never carries a computer's credential", T, () => {
  const all: Got[] = [...mail.got, ...phone.got, ...composio.got, ...honcho.got];
  assert.ok(all.length > 10);
  assert.ok(all.every((g) => !JSON.stringify(g.headers).includes("orgo_vm_") && !JSON.stringify(g.headers).includes("ck-")));
});
