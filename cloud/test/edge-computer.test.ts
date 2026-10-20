import assert from "node:assert/strict";
import { createServer, type IncomingMessage, type ServerResponse } from "node:http";
import { after, before, test } from "node:test";
import { WebSocket } from "ws";
import { clearAuthCache, userForKey } from "../auth.ts";
import { closeDb } from "../db.ts";
import { deviceIdOf } from "../device.ts";
import { COMPUTER_NOT_ALLOWED, type CloudStateHead } from "../protocol.ts";
import { routes, upgrades } from "../server.ts";
import { dropUsers, keyOf, listen, newUserId, prepareDb, startCloud, type Listening } from "./edge-fakes.ts";

/**
 * A computer's runner signing in as its computer (cloud/auth.ts, server.ts): an `orgo_vm_` token is a
 * computer whatever Orgo says (and refused everywhere without the principal Orgo names it by), a
 * computer's own key is one too, each kept 30 seconds at most and never past the token's end; a computer
 * calls only the routes its runner needs (its state, its threads, its session, the models and tools its
 * own tasks use) and is refused on phone, mail, Slack, numbers, backups, notices, usage, the iPhone's
 * agent and the tunnel; its device is Bops Cloud's to set, and another one it sends is refused; Orgo's
 * code for turning a token down is passed on.
 */

let orgo: Listening;
let cloud: Listening;
const users: string[] = [];
const user = (what: string) => {
  const id = newUserId(what);
  users.push(id);
  return id;
};
const D1 = "c1c1c1c1-0000-4000-8000-0000000000aa";
const D2 = "c2c2c2c2-0000-4000-8000-0000000000bb";
/** Profile asks, by key. */
const asked = new Map<string, number>();

const json = (res: ServerResponse, status: number, body: unknown) => res.writeHead(status, { "content-type": "application/json" }).end(JSON.stringify(body));

/**
 * Orgo's GET /api/user/profile, faked: `key-<user>` is the user's own key; `orgo_vm_<user>~<desktop>` a
 * computer's identity token (its principal ends in an hour, or `orgo_vm_soon-…` in 1.5 seconds);
 * `orgo_vm_bare-<user>` a token whose profile names no computer; `ck-<user>~<desktop>` a computer's own
 * key; `orgo_vm_stale-…` and `orgo_vm_notready-…` turned down with Orgo's code.
 */
function profile(req: IncomingMessage, res: ServerResponse) {
  const key = /^Bearer (.+)$/.exec(req.headers.authorization ?? "")?.[1] ?? "";
  asked.set(key, (asked.get(key) ?? 0) + 1);
  if (req.url !== "/api/user/profile") return json(res, 404, {});
  let m: RegExpExecArray | null;
  if ((m = /^key-(.+)$/.exec(key))) return json(res, 200, { id: m[1], email: `${m[1]}@example.com` });
  if (key.startsWith("orgo_vm_stale-")) return json(res, 401, { error: "stale", code: "identity_stale" });
  if (key.startsWith("orgo_vm_notready-")) return json(res, 403, { error: "not yet", code: "bops_cloud_not_ready" });
  if ((m = /^orgo_vm_bare-(.+)$/.exec(key))) return json(res, 200, { id: m[1] });
  if ((m = /^orgo_vm_(soon-)?(.+)~(.+)$/.exec(key)))
    return json(res, 200, { id: m[2], api_key: null, principal: { kind: "vm_identity", desktop_id: m[3], expires_at: new Date(Date.now() + (m[1] ? 1500 : 3600_000)).toISOString() } });
  if ((m = /^ck-(.+)~(.+)$/.exec(key))) return json(res, 200, { id: m[1], api_key: { id: "k1", scope: "computer", computer_id: m[2], computer_key: true } });
  json(res, 401, { error: "no" });
}

before(async () => {
  await prepareDb();
  orgo = await listen(createServer(profile));
  process.env.BOPS_ORGO_ORIGIN = orgo.url;
  cloud = await startCloud();
});

after(async () => {
  await cloud.close();
  await orgo.close();
  await dropUsers(users);
  await closeDb();
});

const vm = (u: string, d = D1) => `orgo_vm_${u}~${d}`;
const ck = (u: string, d = D1) => `ck-${u}~${d}`;

/** A call to the cloud with `key`, as a newer build makes it (its user named, protocol 2). */
function call(key: string, userId: string, path: string, init: { method?: string; body?: unknown; device?: string } = {}) {
  const headers: Record<string, string> = { Authorization: `Bearer ${key}`, "x-bops-user": userId, "x-bops-protocol": "2" };
  if (init.device) headers["x-bops-device"] = init.device;
  if (init.body !== undefined) headers["content-type"] = "application/json";
  return fetch(`${cloud.url}${path}`, { method: init.method ?? "GET", headers, body: init.body === undefined ? undefined : JSON.stringify(init.body) });
}

test("an identity token is a computer by Orgo's principal, a computer's key by its scope, and an account key is its user", async () => {
  clearAuthCache();
  const u = user("who");
  const a = await userForKey(vm(u, D1.toUpperCase()));
  assert.equal(a?.id, u);
  assert.deepEqual([a?.computer?.kind, a?.computer?.desktopId, a?.computer?.device], ["vm_identity", D1, deviceIdOf(u, D1)], "lowercased, and its device is the runner's (persist-cloud.ts deviceIdFor of its computer id)");
  assert.ok(a!.computer!.expiresAt > Date.now() + 3500_000);
  const k = await userForKey(ck(u));
  assert.deepEqual([k?.computer?.kind, k?.computer?.desktopId, k?.computer?.expiresAt], ["computer_key", D1, Infinity]);
  const bare = await userForKey(`orgo_vm_bare-${u}`);
  assert.deepEqual([bare?.id, bare?.computer?.kind, bare?.computer?.desktopId], [u, "vm_identity", ""], "an orgo_vm_ token is a computer whatever Orgo says");
  assert.equal((await userForKey(keyOf(u)))?.computer, undefined, "the user's own key: the user");
});

test("a computer's answer is kept 30 seconds at most, and never past its token's end; the user's, 5 minutes", async () => {
  clearAuthCache();
  const u = user("cache");
  const token = vm(u);
  await userForKey(token);
  await userForKey(token);
  assert.equal(asked.get(token), 1, "kept");
  const real = Date.now;
  try {
    Date.now = () => real() + 31_000;
    await userForKey(token);
    assert.equal(asked.get(token), 2, "asked again after 30 seconds");
    await userForKey(keyOf(u));
    Date.now = () => real() + 31_000 + 60_000;
    await userForKey(keyOf(u));
    assert.equal(asked.get(keyOf(u)), 1, "a user's key: still kept");
  } finally {
    Date.now = real;
  }
  const soon = `orgo_vm_soon-${u}~${D1}`;
  await userForKey(soon);
  await userForKey(soon);
  assert.equal(asked.get(soon), 1);
  await new Promise((r) => setTimeout(r, 1600));
  await userForKey(soon);
  assert.equal(asked.get(soon), 2, "its token ended: asked again");
});

test("a computer calls its state, its threads and its session; everything else of its user's is 403", async () => {
  clearAuthCache();
  const u = user("routes");
  for (const key of [vm(u), ck(u)]) {
    const head = await call(key, u, "/v1/state/head");
    assert.equal(head.status, 200, `${key}: its state`);
    assert.equal((await call(key, u, "/v1/messages?after=0&limit=10")).status, 200, "its threads");
    for (const [method, path] of [
      ["GET", "/v1/notices"],
      ["POST", "/v1/notices/dismiss"],
      ["POST", "/v1/state/backups"],
      ["GET", "/v1/phone/lines"],
      ["PUT", "/v1/phone/lines"],
      ["POST", "/v1/phone/lines/unlink"],
      ["GET", "/v1/mail/handles"],
      ["POST", "/v1/mail/handle"],
      ["PUT", "/v1/slack/links"],
      ["POST", "/v1/verify/start"],
      ["GET", "/v1/usage"],
      ["GET", "/v1/agent"],
      ["GET", "/proxy/agentphone/v1/numbers"],
    ]) {
      const r = await call(key, u, path, { method, body: method === "GET" ? undefined : {} });
      assert.equal(r.status, 403, `${key}: ${method} ${path}`);
      const body = (await r.json()) as { error?: string; code?: string };
      assert.deepEqual([body.code, body.error], [COMPUTER_NOT_ALLOWED, "A computer's identity can't do this."]);
    }
  }
  // Its user, on their own key: not refused for being a computer.
  const n = await call(keyOf(u), u, "/v1/notices");
  assert.notEqual(n.status, 403);
});

test("a token Orgo named no computer for is refused on every route, its state too", async () => {
  clearAuthCache();
  const u = user("bare");
  const r = await call(`orgo_vm_bare-${u}`, u, "/v1/state/head");
  assert.equal(r.status, 403);
  assert.equal(((await r.json()) as { code?: string }).code, COMPUTER_NOT_ALLOWED);
});

test("the route table: computers on the runner's routes only, the models' socket yes, the tunnel never", () => {
  const forComputers = routes()
    .filter((r) => r.computer)
    .map((r) => `${r.method} ${r.path}`);
  for (const want of ["GET /v1/state", "PUT /v1/state", "GET /v1/state/head", "GET /v1/messages", "POST /v1/messages", "POST /v1/session", "POST /proxy/openai/*", "GET /proxy/honcho/*", "POST /v3/*", "POST /proxy/composio/*", "POST /proxy/typesafe/*", "POST /proxy/treg/*"])
    assert.ok(forComputers.includes(want), want);
  for (const p of forComputers) assert.ok(/^(GET|PUT|POST|PATCH|DELETE) (\/v1\/(state|state\/head|messages|session)|\/proxy\/(openai|honcho|composio|typesafe|treg)\/\*|\/v3\/\*)$/.test(p), `only the runner's: ${p}`);
  const ups = upgrades();
  assert.equal(ups.find((x) => x.path === "/proxy/openai/*")?.computer, true);
  assert.ok(!ups.find((x) => x.path === "/v1/connect")?.computer);
});

test("the tunnel (one per user) refuses a computer: its upgrade is 403", async () => {
  clearAuthCache();
  const u = user("tunnel");
  const status = await new Promise<number>((resolve) => {
    const ws = new WebSocket(`${cloud.url.replace(/^http/, "ws")}/v1/connect`, { headers: { Authorization: `Bearer ${vm(u)}` } });
    ws.on("unexpected-response", (_req, res) => resolve(res.statusCode ?? 0));
    ws.on("open", () => {
      ws.close();
      resolve(101);
    });
    ws.on("error", () => resolve(-1));
  });
  assert.equal(status, 403);
});

test("a computer writes as its own device, which Bops Cloud sets: another device header is 403", async () => {
  clearAuthCache();
  const u = user("device");
  const token = vm(u);
  const mine = deviceIdOf(u, D1);
  const other = await call(token, u, "/v1/state", { method: "PUT", body: { base: 0, state: { bots: [] } }, device: deviceIdOf(u, D2) });
  assert.equal(other.status, 403, "another computer's device");
  assert.equal((await call(token, u, "/v1/state/head", { device: "mac-a" })).status, 403, "a Mac's");
  const put = await call(token, u, "/v1/state", { method: "PUT", body: { base: 0, state: { bots: [] } } });
  assert.equal(put.status, 200, "no header: its own");
  let head = (await (await call(token, u, "/v1/state/head")).json()) as CloudStateHead;
  assert.equal(head.writer, mine, "written as the computer's device, set here");
  const again = await call(token, u, "/v1/state", { method: "PUT", body: { base: head.version, state: { bots: [] } }, device: mine });
  assert.equal(again.status, 200, "its own, said: taken");
  head = (await (await call(token, u, "/v1/state/head")).json()) as CloudStateHead;
  assert.equal(head.writer, mine);
});

test("Orgo's code for turning a token down is passed on with the 401", async () => {
  clearAuthCache();
  const u = user("codes");
  const stale = await call(`orgo_vm_stale-${u}`, u, "/v1/state/head");
  assert.equal(stale.status, 401);
  assert.equal(((await stale.json()) as { code?: string }).code, "identity_stale");
  const notReady = await call(`orgo_vm_notready-${u}`, u, "/v1/state/head");
  assert.equal(notReady.status, 401);
  assert.equal(((await notReady.json()) as { code?: string }).code, "bops_cloud_not_ready");
  const plain = await call("nobody", u, "/v1/state/head");
  assert.equal(plain.status, 401);
  assert.equal(((await plain.json()) as { code?: string }).code, undefined);
});
