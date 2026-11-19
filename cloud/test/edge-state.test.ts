import assert from "node:assert/strict";
import { createServer, request } from "node:http";
import { after, before, test } from "node:test";
import { gzipSync } from "node:zlib";
import { closeDb, ensureUserRow, query } from "../db.ts";
import { deviceIdOf } from "../device.ts";
import { loadState } from "../state.ts";
import { dropUsers, fakeOrgo, keyOf, listen, newUserId, prepareDb, startCloud, type Listening } from "./edge-fakes.ts";

/** Builds from before the state lived in the cloud (cloud/state.ts): their GET/PUT /v1/state backup, and loadState. The newer protocol is in edge-state-sync.test.ts. */

let orgo: Listening;
let cloud: Listening;
const users: string[] = [];
const user = (what: string) => {
  const id = newUserId(what);
  users.push(id);
  return id;
};

before(async () => {
  await prepareDb();
  orgo = await fakeOrgo();
  cloud = await startCloud();
});

after(async () => {
  await cloud.close();
  await orgo.close();
  await dropUsers(users);
  await closeDb();
});

const get = (userId: string, headers: Record<string, string> = {}) => fetch(`${cloud.url}/v1/state`, { headers: { Authorization: `Bearer ${keyOf(userId)}`, ...headers } });
const put = (userId: string, body: string | Buffer, headers: Record<string, string> = {}) =>
  fetch(`${cloud.url}/v1/state`, { method: "PUT", headers: { Authorization: `Bearer ${keyOf(userId)}`, "content-type": "application/json", ...headers }, body });

/** A PUT through node:http, which reads the answer even when the cloud stops reading a too-big body. */
function rawPut(userId: string, body: Buffer, headers: Record<string, string> = {}): Promise<number> {
  const url = new URL(`${cloud.url}/v1/state`);
  return new Promise((resolve, reject) => {
    const req = request({ host: url.hostname, port: url.port, path: url.pathname, method: "PUT", headers: { Authorization: `Bearer ${keyOf(userId)}`, "content-type": "application/json", ...headers } }, (res) => {
      res.resume();
      resolve(res.statusCode ?? 0);
    });
    req.on("error", reject);
    req.end(body);
  });
}

test("nothing saved yet is 404, and the empty row other tables need doesn't count", async () => {
  const id = user("empty");
  assert.equal((await get(id)).status, 404);
  await ensureUserRow(id);
  assert.equal((await get(id)).status, 404);
  assert.equal(await loadState(id), null);
});

test("an upload comes back as it went, and the next one replaces it", async () => {
  const id = user("roundtrip");
  const state = { owner: { name: "Alex" }, bots: [{ id: "sam", name: "Sam", isMain: true }], messages: [], note: "a\u0000b" };
  const res = await put(id, JSON.stringify({ version: 41, state }));
  assert.equal(res.status, 200);
  assert.deepEqual(await res.json(), { ok: true, version: 41 });

  const back = await get(id);
  assert.equal(back.status, 200);
  assert.deepEqual(await back.json(), { version: 41, state: { ...state, note: "ab" } }, "the same state; a NUL (which JSONB can't keep) is dropped");
  // What the cloud reads to answer calls never has the messages: they're rows of their own.
  assert.deepEqual(await loadState(id), { version: 41, state: { owner: state.owner, bots: state.bots, note: "ab" } });

  // An old build's upload is the whole state: a newer one with a lower number (the app restarted) still replaces it.
  assert.equal((await put(id, JSON.stringify({ version: 3, state: { bots: [] } }))).status, 200);
  assert.deepEqual(await loadState(id), { version: 3, state: { bots: [] } });
  assert.equal((await get(users[0])).status, 404, "each user sees only their own");
});

test("gzipped uploads are taken, and GET gzips for a client that asks", async () => {
  const id = user("gzip");
  const state = { bots: [{ id: "sam", name: "Sam", isMain: true }], messages: Array.from({ length: 500 }, (_, i) => ({ id: `m${i}`, text: "hello ".repeat(20) })) };
  const res = await put(id, gzipSync(JSON.stringify({ version: 5, state })), { "content-encoding": "gzip" });
  assert.equal(res.status, 200);

  const plain = await get(id, { "accept-encoding": "identity" });
  assert.equal(plain.headers.get("content-encoding"), null);
  assert.deepEqual(await plain.json(), { version: 5, state });

  const zipped = await get(id, { "accept-encoding": "gzip" });
  assert.equal(zipped.headers.get("content-encoding"), "gzip");
  assert.ok(Number(zipped.headers.get("content-length")) < JSON.stringify(state).length / 5);
  assert.deepEqual(await zipped.json(), { version: 5, state });
});

test("uploads that aren't a state are refused", async () => {
  const id = user("bad");
  const status = async (body: string, headers?: Record<string, string>) => (await put(id, body, headers)).status;
  assert.equal(await status("not json"), 400);
  assert.equal(await status(JSON.stringify({ state: {} })), 400, "no version");
  assert.equal(await status(JSON.stringify({ version: -1, state: {} })), 400);
  assert.equal(await status(JSON.stringify({ version: 1.5, state: {} })), 400);
  assert.equal(await status(JSON.stringify({ version: 1, state: [] })), 400);
  assert.equal(await status(JSON.stringify({ version: 1, state: null })), 400);
  assert.equal(await status(JSON.stringify({ version: 1, state: {} }), { "content-encoding": "br" }), 415);
  assert.equal(await status("not gzip", { "content-encoding": "gzip" }), 400);
  assert.equal(await loadState(id), null);
});

test("more than 20 MB is refused, as sent or once unzipped", async () => {
  const id = user("big");
  const big = Buffer.from(JSON.stringify({ version: 1, state: { blob: "x".repeat(20 * 1024 * 1024) } }));
  assert.equal(await rawPut(id, big), 413);
  const bomb = gzipSync(big);
  assert.ok(bomb.length < 1024 * 1024, "small as sent");
  assert.equal(await rawPut(id, bomb, { "content-encoding": "gzip" }), 413);
  assert.equal(await loadState(id), null);
});

test("only a signed-in user", async () => {
  assert.equal((await fetch(`${cloud.url}/v1/state`)).status, 401);
  assert.equal((await fetch(`${cloud.url}/v1/state`, { method: "PUT", body: "{}" })).status, 401);
});

test("a computer's write never raises the state's level, so a runner newer than the owner's Mac never locks that Mac out; a Mac's write still does", async () => {
  const id = user("level");
  const desktop = "c1c1c1c1-0000-4000-8000-0000000000aa";
  // orgo-web for this one: the user's key, and the computer's identity (orgo_vm_<user>~<desktop>).
  const who = await listen(
    createServer((req, res) => {
      const key = /^Bearer (.+)$/.exec(req.headers.authorization ?? "")?.[1] ?? "";
      const m = /^orgo_vm_([^~]+)~([^~]+)$/.exec(key);
      const body = key === keyOf(id) ? { id, email: `${id}@example.com` } : m ? { id: m[1], api_key: null, principal: { kind: "vm_identity", desktop_id: m[2], expires_at: new Date(Date.now() + 3600_000).toISOString() } } : null;
      res.writeHead(body ? 200 : 401, { "content-type": "application/json" }).end(JSON.stringify(body ?? { error: "no" }));
    }),
  );
  const was = process.env.BOPS_ORGO_ORIGIN;
  process.env.BOPS_ORGO_ORIGIN = who.url;
  const write = (key: string, base: number, state: unknown, level: string, device?: string) =>
    fetch(`${cloud.url}/v1/state`, {
      method: "PUT",
      headers: { Authorization: `Bearer ${key}`, "x-bops-user": id, "x-bops-protocol": "2", "x-bops-state-level": level, "content-type": "application/json", ...(device ? { "x-bops-device": device } : {}) },
      body: JSON.stringify({ base, state }),
    });
  const level = async () => (await query<{ p: number }>("SELECT protocol AS p FROM bops.app_state WHERE user_id = $1", [id])).rows[0].p;
  try {
    const bots = [{ id: "b1", name: "Max", isMain: true, computerId: desktop }];
    assert.equal((await write(keyOf(id), 0, { bots, sessions: [] }, "4", "mac-a")).status, 200);
    assert.equal(await level(), 4, "the Mac's");
    // The computer's runner on a newer Bops (level 5) writes its own thread: taken, the level as it was.
    const thread = { id: "s1", botId: "b1", by: deviceIdOf(id, desktop), status: "running" };
    const put = await write(`orgo_vm_${id}~${desktop}`, 1, { bots, sessions: [thread] }, "5");
    assert.equal(put.status, 200, await put.clone().text());
    assert.equal(await level(), 4, "never raised by a computer");
    // So the owner's Mac at level 4 still reads and writes it.
    const v = ((await put.json()) as { version: number }).version;
    assert.equal((await write(keyOf(id), v, { bots, sessions: [{ ...thread, status: "done" }] }, "4", "mac-a")).status, 200);
    // A Mac on the newer Bops raises it, as before.
    assert.equal((await write(keyOf(id), v + 1, { bots, sessions: [] }, "5", "mac-b")).status, 200);
    assert.equal(await level(), 5);
  } finally {
    process.env.BOPS_ORGO_ORIGIN = was;
    await who.close();
  }
});
