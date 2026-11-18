import assert from "node:assert/strict";
import { createServer, type IncomingMessage, type ServerResponse } from "node:http";
import { after, before, test } from "node:test";
import { freeJobLease, renewJobLease, sweepAppLeases, takeJobLease } from "../app-lease.ts";
import { closeDb, query, tx } from "../db.ts";
import { deviceIdOf } from "../device.ts";
import { hub } from "../live.ts";
import { APP_BUSY, APP_BUSY_WORDS, APP_LEASE_MS, APP_LEASE_PATH, WRONG_USER } from "../protocol.ts";
import { call, dropUsers, listen, newUserId, prepareDb, startCloud } from "./core-fakes.ts";

/**
 * One lease per app (app-lease.ts, POST /v1/apps/lease, bops.app_leases): taken, renewed and freed by the owner's Macs
 * and their computers' runners, and by Bops Cloud's own jobs (takeJobLease, from turns.ts claim). Who holds it is Bops
 * Cloud's to say (a computer's device from its sign in, "job:" never a caller's), a computer holds only its own apps,
 * one not renewed is free again, and a job holds it only while its turn is claimed. orgo-web is a fake on localhost;
 * the database is the tests' own.
 */

const D1 = "d1d1d1d1-0000-4000-8000-0000000000aa";
const D2 = "d2d2d2d2-0000-4000-8000-0000000000bb";

let orgo: { url: string; close: () => Promise<void> };
let cloud: { url: string; close: () => Promise<void> };
const users: string[] = [];

const json = (res: ServerResponse, status: number, body: unknown) => res.writeHead(status, { "content-type": "application/json" }).end(JSON.stringify(body));
/** Orgo's profile: `key-<u>` the user's key, `orgo_vm_<u>~<d>` a computer's token. */
function profile(req: IncomingMessage, res: ServerResponse) {
  const key = /^Bearer (.+)$/.exec(req.headers.authorization ?? "")?.[1] ?? "";
  if (req.url !== "/api/user/profile") return json(res, 401, { error: "no" });
  let m: RegExpExecArray | null;
  if ((m = /^key-(.+)$/.exec(key))) return json(res, 200, { id: m[1], email: `${m[1]}@example.com`, api_key: { id: "k0", scope: "account" } });
  if ((m = /^orgo_vm_([^~]+)~([^~]+)$/.exec(key))) return json(res, 200, { id: m[1], api_key: null, principal: { kind: "vm_identity", desktop_id: m[2], expires_at: new Date(Date.now() + 3600_000).toISOString() } });
  json(res, 401, { error: "no" });
}

before(async () => {
  await prepareDb();
  orgo = await listen(createServer(profile));
  process.env.BOPS_ORGO_ORIGIN = orgo.url;
  cloud = await startCloud();
});

after(async () => {
  hub.closeAll();
  await cloud.close();
  await orgo.close();
  await dropUsers(users);
  await closeDb();
});

const T = { timeout: 60_000 };
const vm = (u: string, d = D1) => `orgo_vm_${u}~${d}`;

/** Boppy on D1 works on "shop"; Iris on D2 on "notes", in workspace Acme. */
function stateOf() {
  return {
    owner: { name: "Ann" },
    bots: [
      { id: "main", name: "Boppy", isMain: true, computerId: D1, computerStatus: "ready" },
      { id: "iris", name: "Iris", computer: "own", computerId: D2, computerStatus: "ready" },
    ],
    chats: [{ id: "bot:main", kind: "bot", botIds: ["main"], createdAt: 1 }],
    workspaces: [{ id: "ws_main", name: "Acme", createdAt: 1, hostedApps: { shop: { botId: "main", computerId: D1 }, notes: { botId: "iris", computerId: D2 } } }],
  };
}

async function seeded(what: string) {
  const u = newUserId(what);
  users.push(u);
  const r = await call(cloud.url, "PUT", "/v1/state", { key: `key-${u}`, headers: { "x-bops-user": u, "x-bops-protocol": "2" }, json: { base: 0, state: stateOf() } });
  assert.equal(r.status, 200, r.text);
  return u;
}

type Op = "take" | "renew" | "free";
/** A call from one of the owner's Macs (`device`), or (`computer`) a runner on that computer. */
const fromMac = (u: string, op: Op, nonce: string, o: { app?: string; kind?: string; device?: string; holder?: string } = {}) =>
  call(cloud.url, "POST", APP_LEASE_PATH, {
    key: `key-${u}`,
    headers: { "x-bops-user": u, "x-bops-device": o.device ?? "mac0000000000001" },
    json: { op, ws: "ws_main", app: o.app ?? "shop", kind: o.kind ?? "deploy", holder: o.holder ?? `mac:${o.device ?? "mac0000000000001"}:${nonce}` },
  });
const fromRunner = (u: string, op: Op, nonce: string, o: { app?: string; kind?: string; desktop?: string; holder?: string; headers?: Record<string, string> } = {}) =>
  call(cloud.url, "POST", APP_LEASE_PATH, {
    key: vm(u, o.desktop ?? D1),
    headers: { "x-bops-user": u, ...o.headers },
    json: { op, ws: "ws_main", app: o.app ?? "shop", kind: o.kind ?? "deploy", holder: o.holder ?? `runner:here:${nonce}` },
  });
const leases = async (u: string) =>
  (await query<{ app: string; holder: string; device_id: string; kind: string; until: Date }>("SELECT app, holder, device_id, kind, until FROM bops.app_leases WHERE user_id = $1 ORDER BY app", [u])).rows;
const runOut = (u: string, app = "shop") => query("UPDATE bops.app_leases SET until = now() - interval '1 second' WHERE user_id = $1 AND app = $2", [u, app]);
/** A turn of the owner's, in `state`, for a job lease to hang off. */
const turnIn = (u: string, id: string, state: string) =>
  query(
    `INSERT INTO bops.chat_turns (user_id, id, message_id, chat_id, bot_id, ws_id, member, desktop_id, target_device, state, deadline, human_at)
     VALUES ($1, $2, $2, 'bot:main', 'main', 'ws_main', '{"job":{"act":"deploy","app":"shop"}}'::jsonb, $3, $4, $5, now() + interval '10 minutes', 1)`,
    [u, id, D1, deviceIdOf(u, D1), state],
  );

test("take, renew and free: until APP_LEASE_MS from now; the same holder again is the same lease; another can take it once it's freed", T, async () => {
  const u = await seeded("basic");
  const t = await fromMac(u, "take", "aaaa0001");
  assert.equal(t.status, 200, t.text);
  assert.equal(t.json.ok, true);
  assert.ok(Math.abs(t.json.until - (Date.now() + APP_LEASE_MS)) < 5_000, "about 90 seconds on");
  assert.deepEqual((await leases(u)).map((l) => [l.app, l.holder, l.device_id, l.kind]), [["shop", "mac:mac0000000000001:aaaa0001", "mac0000000000001", "deploy"]]);
  // Taken again by the same holder: re-entrant.
  assert.equal((await fromMac(u, "take", "aaaa0001")).status, 200);
  await query("UPDATE bops.app_leases SET until = now() + interval '5 seconds' WHERE user_id = $1", [u]);
  const r = await fromMac(u, "renew", "aaaa0001");
  assert.equal(r.status, 200, r.text);
  assert.ok((await leases(u))[0].until.getTime() > Date.now() + APP_LEASE_MS - 5_000, "renewed for another 90 seconds");
  // Another of the owner's Macs, meanwhile: refused, saying so.
  const other = await fromMac(u, "take", "bbbb0002", { device: "mac0000000000002" });
  assert.deepEqual([other.status, other.json], [409, { error: APP_BUSY_WORDS.otherMac("shop"), code: APP_BUSY, by: "mac", kind: "deploy" }]);
  assert.equal(other.json.error, "shop is being changed on another of your Macs right now. Try again once that's done.");
  // Freed by another device with the same nonce: nothing (a holder is its device's too).
  assert.equal((await fromMac(u, "free", "aaaa0001", { device: "mac0000000000002" })).status, 200);
  assert.equal((await leases(u)).length, 1);
  assert.equal((await fromMac(u, "free", "aaaa0001")).status, 200);
  assert.deepEqual(await leases(u), []);
  assert.equal((await fromMac(u, "free", "aaaa0001")).status, 200, "free is always 200");
  assert.equal((await fromMac(u, "take", "bbbb0002", { device: "mac0000000000002" })).status, 200);
});

test("expiry: one not renewed is free again; a renew of one it no longer holds is 409 and never takes it again", T, async () => {
  const u = await seeded("expiry");
  assert.equal((await fromMac(u, "take", "aaaa0001")).status, 200);
  await runOut(u);
  const runner = await fromRunner(u, "take", "cccc0003", { kind: "remove" });
  assert.equal(runner.status, 200, runner.text);
  const lost = await fromMac(u, "renew", "aaaa0001");
  assert.deepEqual([lost.status, lost.json.code, lost.json.by, lost.json.kind], [409, APP_BUSY, "runner", "remove"]);
  // Freed, then a renew on its way lands: nothing comes back.
  assert.equal((await fromRunner(u, "free", "cccc0003", { kind: "remove" })).status, 200);
  const late = await fromRunner(u, "renew", "cccc0003", { kind: "remove" });
  assert.equal(late.status, 409);
  assert.deepEqual(await leases(u), []);
});

test("409 says who holds it and what they do, in the words for the caller: a runner hears the owner's Mac by name, a Mac a runner's or a job's", T, async () => {
  const u = await seeded("busy");
  assert.equal((await fromMac(u, "take", "aaaa0001", { kind: "first" })).status, 200);
  const r = await fromRunner(u, "take", "cccc0003", { kind: "remove" });
  assert.deepEqual([r.status, r.json], [409, { error: APP_BUSY_WORDS.mac("shop", "Ann"), code: APP_BUSY, by: "mac", kind: "first" }]);
  assert.equal(r.json.error, "shop is being changed on Ann's Mac right now. Try again once that's done.");
  await fromMac(u, "free", "aaaa0001");
  assert.equal((await fromRunner(u, "take", "cccc0003", { kind: "removeSite" })).status, 200);
  const m = await fromMac(u, "take", "aaaa0001");
  assert.deepEqual([m.status, m.json], [409, { error: "shop's computer is changing it right now. Try again once that's done.", code: APP_BUSY, by: "runner", kind: "removeSite" }]);
});

test("a computer holds only its own apps (their home there, or none yet that a bot of its may give it); its device is its own, whatever it says", T, async () => {
  const u = await seeded("scope");
  // D2's app, from D1; D1's app, from D2: refused, nothing kept.
  for (const [app, desktop] of [["notes", D1], ["shop", D2]] as const) {
    const r = await fromRunner(u, "take", "cccc0003", { app, desktop });
    assert.deepEqual([r.status, r.json.error], [403, "A computer holds only its own apps."], `${app} from ${desktop}`);
  }
  // A workspace it has no bot in: refused too.
  const ws = await call(cloud.url, "POST", APP_LEASE_PATH, { key: vm(u), headers: { "x-bops-user": u }, json: { op: "take", ws: "ws_other", app: "shop", kind: "deploy", holder: "runner:x:cccc0003" } });
  assert.equal(ws.status, 403);
  assert.deepEqual(await leases(u), []);
  // An app with no record yet (a first deploy making it): one of its bots there may give it its first home.
  assert.equal((await fromRunner(u, "take", "dddd0004", { app: "new-app" })).status, 200);
  // Its own: the holder's who and device are Bops Cloud's (its sign in), only the nonce is the caller's.
  const own = await fromRunner(u, "take", "cccc0003", { holder: "mac:mac0000000000001:cccc0003" });
  assert.equal(own.status, 200, own.text);
  const dev = deviceIdOf(u, D1);
  assert.deepEqual((await leases(u)).map((l) => [l.app, l.holder, l.device_id]), [["new-app", `runner:${dev}:dddd0004`, dev], ["shop", `runner:${dev}:cccc0003`, dev]]);
  // A device header that isn't its own: refused before anything (server.ts).
  const forged = await fromRunner(u, "take", "eeee0005", { headers: { "x-bops-device": "mac0000000000001" } });
  assert.equal(forged.status, 403);
  // A person's holder is "mac" with the device it says, whatever the sent holder's who.
  await query("DELETE FROM bops.app_leases WHERE user_id = $1", [u]);
  assert.equal((await fromMac(u, "take", "ffff0006", { holder: "runner:anything:ffff0006" })).status, 200);
  assert.deepEqual((await leases(u)).map((l) => l.holder), ["mac:mac0000000000001:ffff0006"]);
});

test("refused in words: a job's holder from a caller, no nonce, no device, no user named or another's, a kind or app that can't be one", T, async () => {
  const u = await seeded("refusals");
  const job = await fromMac(u, "take", "", { holder: "job:turn_x" });
  assert.deepEqual([job.status, job.json.error], [400, "Only Bops Cloud's own jobs hold an app as a job."]);
  assert.equal((await fromRunner(u, "take", "", { holder: "JOB:turn_x:aaaa0001" })).status, 400);
  assert.equal((await fromMac(u, "take", "", { holder: "mac:mac0000000000001" })).status, 400, "no nonce");
  assert.equal((await fromMac(u, "take", "", { holder: "mac:mac0000000000001:XYZ" })).status, 400, "a nonce that isn't hex");
  assert.equal((await fromMac(u, "take", "aaaa0001", { kind: "everything" })).status, 400);
  assert.equal((await fromMac(u, "take", "aaaa0001", { app: "Not An App" })).status, 400);
  const noDevice = await call(cloud.url, "POST", APP_LEASE_PATH, { key: `key-${u}`, headers: { "x-bops-user": u }, json: { op: "take", ws: "ws_main", app: "shop", kind: "deploy", holder: "mac:x:aaaa0001" } });
  assert.deepEqual([noDevice.status, noDevice.json.error], [400, "Say which device holds it."]);
  const noUser = await call(cloud.url, "POST", APP_LEASE_PATH, { key: `key-${u}`, headers: { "x-bops-device": "mac0000000000001" }, json: { op: "take", ws: "ws_main", app: "shop", kind: "deploy", holder: "mac:x:aaaa0001" } });
  assert.equal(noUser.status, 400);
  const wrong = await call(cloud.url, "POST", APP_LEASE_PATH, { key: `key-${u}`, headers: { "x-bops-user": "someone-else", "x-bops-device": "mac0000000000001" }, json: { op: "take", ws: "ws_main", app: "shop", kind: "deploy", holder: "mac:x:aaaa0001" } });
  assert.deepEqual([wrong.status, wrong.json.code], [409, WRONG_USER]);
  const big = await call(cloud.url, "POST", APP_LEASE_PATH, { key: `key-${u}`, headers: { "x-bops-user": u, "x-bops-device": "mac0000000000001" }, json: { op: "take", ws: "ws_main", app: "shop", kind: "deploy", holder: "mac:x:aaaa0001", pad: "x".repeat(3000) } });
  assert.equal(big.status, 413, "2 KB at most");
  assert.deepEqual(await leases(u), []);
});

test("a job's lease: taken in its claim's transaction, renewed and freed by its turn; held only while its turn is claimed (a dead one counts as free), and the sweep clears dead and long run out ones", T, async () => {
  const u = await seeded("jobs");
  const dev = deviceIdOf(u, D1);
  await turnIn(u, "turn_live", "claimed");
  assert.equal(await tx((c) => takeJobLease(c, u, "ws_main", "shop", "turn_live", dev, "deploy")), true);
  assert.equal(await tx((c) => takeJobLease(c, u, "ws_main", "shop", "turn_live", dev, "deploy")), true, "re-entrant for its own turn");
  assert.deepEqual((await leases(u)).map((l) => [l.holder, l.device_id, l.kind]), [["job:turn_live", dev, "deploy"]]);
  const busy = await fromMac(u, "take", "aaaa0001", { kind: "remove" });
  assert.deepEqual([busy.status, busy.json.by, busy.json.kind, busy.json.error], [409, "job", "deploy", "A change to shop is still going on its computer. Try again once it's done."]);
  // Another job meanwhile: who holds it.
  await turnIn(u, "turn_next", "owed");
  assert.deepEqual(await tx((c) => takeJobLease(c, u, "ws_main", "shop", "turn_next", dev, "remove")), { by: "job", kind: "deploy" });
  await query("UPDATE bops.app_leases SET until = now() + interval '5 seconds' WHERE user_id = $1", [u]);
  assert.equal(await renewJobLease(null, u, "turn_live"), true);
  assert.ok((await leases(u))[0].until.getTime() > Date.now() + APP_LEASE_MS - 5_000);
  assert.equal(await renewJobLease(null, u, "turn_none"), false);
  await freeJobLease(null, u, "turn_live");
  assert.deepEqual(await leases(u), []);
  // A job's lease whose turn isn't claimed any more (it ended, or was owed again): free at once for anyone.
  assert.equal(await tx((c) => takeJobLease(c, u, "ws_main", "shop", "turn_live", dev, "deploy")), true);
  await query("UPDATE bops.chat_turns SET state = 'failed' WHERE user_id = $1 AND id = 'turn_live'", [u]);
  assert.equal((await fromMac(u, "take", "aaaa0001")).status, 200, "a dead job holder counts as free");
  // The sweep: a job's lease whose turn isn't claimed, and any run out over an hour ago; never a live one.
  await query("DELETE FROM bops.app_leases WHERE user_id = $1", [u]);
  await query("UPDATE bops.chat_turns SET state = 'claimed' WHERE user_id = $1 AND id = 'turn_live'", [u]);
  assert.equal(await tx((c) => takeJobLease(c, u, "ws_main", "shop", "turn_live", dev, "deploy")), true);
  assert.equal(await tx((c) => takeJobLease(c, u, "ws_main", "notes", "turn_next", dev, "deploy")), true);
  assert.equal((await fromMac(u, "take", "aaaa0001", { app: "old-app" })).status, 200);
  assert.equal((await fromMac(u, "take", "bbbb0002", { app: "recent-app" })).status, 200);
  await query("UPDATE bops.app_leases SET until = now() - interval '2 hours' WHERE user_id = $1 AND app = 'old-app'", [u]);
  await runOut(u, "recent-app");
  await sweepAppLeases();
  assert.deepEqual((await leases(u)).map((l) => [l.app, l.holder]), [["recent-app", "mac:mac0000000000001:bbbb0002"], ["shop", "job:turn_live"]]);
});
