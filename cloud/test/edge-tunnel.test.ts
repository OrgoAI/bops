import assert from "node:assert/strict";
import { after, before, test } from "node:test";
import { WebSocket } from "ws";
import { closeDb, query } from "../db.ts";
import type { CloudToMac } from "../protocol.ts";
import * as tunnel from "../tunnel.ts";
import { connectMac, dropUsers, fakeOrgo, newUserId, pending, prepareDb, startCloud, until, type Listening } from "./edge-fakes.ts";

/** The tunnel (cloud/tunnel.ts): GET /v1/connect, requests to the Mac, waiting events, pings. */

let orgo: Listening;
let cloud: Listening;
const users: string[] = [];
const user = (what: string) => {
  const id = newUserId(what);
  users.push(id);
  return id;
};
const events = (frames: CloudToMac[]) => frames.filter((f): f is Extract<CloudToMac, { t: "event" }> => f.t === "event");
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

before(async () => {
  await prepareDb();
  orgo = await fakeOrgo();
  cloud = await startCloud();
});

after(async () => {
  tunnel.closeAll();
  await cloud.close();
  await orgo.close();
  await dropUsers(users);
  await closeDb();
});

test("a Mac needs an Orgo key Orgo knows", async () => {
  const ws = new WebSocket(`${cloud.url.replace("http", "ws")}/v1/connect`, { headers: { Authorization: "Bearer not-a-key" } });
  const err = await new Promise<Error>((r) => ws.once("error", r));
  assert.match(err.message, /401/);
});

test("a request goes to the Mac and its answer comes back, body and headers intact", async () => {
  const id = user("req");
  const mac = await connectMac(cloud.url, id, {
    answer: (req) => ({
      status: 201,
      headers: { "content-type": "text/plain" },
      body: Buffer.from(`${req.method} ${req.path} ${Buffer.from(req.body, "base64").toString()} ${req.headers["x-test"]}`).toString("base64"),
    }),
  });
  assert.equal(tunnel.isConnected(id), true);
  const res = await tunnel.requestMac(id, { method: "POST", path: "/api/phone/agentphone", headers: { "x-test": "yes", "X-Bops-Cloud": "forged" }, body: Buffer.from("héllo") }, 2_000);
  assert.equal(res?.status, 201);
  assert.equal(res?.headers["content-type"], "text/plain");
  assert.equal(res?.body.toString(), "POST /api/phone/agentphone héllo yes");
  const req = mac.frames.find((f) => f.t === "req");
  assert.ok(req?.t === "req" && !Object.keys(req.headers).some((h) => h.toLowerCase() === "x-bops-cloud"), "the tunnel token header never goes to the Mac");
  mac.ws.close();
});

test("no Mac, a Mac that doesn't answer in time, or one that goes away: no answer", async () => {
  const req = { method: "POST", path: "/x", headers: {}, body: Buffer.alloc(0) };
  assert.equal(await tunnel.requestMac(user("nobody"), req, 1_000), null);

  const slow = user("slow");
  const mac = await connectMac(cloud.url, slow);
  const started = Date.now();
  assert.equal(await tunnel.requestMac(slow, req, 150), null);
  assert.ok(Date.now() - started < 1_000);

  const waiting = tunnel.requestMac(slow, req, 10_000);
  await until(() => mac.frames.filter((f) => f.t === "req").length === 2, "the second request");
  mac.ws.terminate();
  const gone = Date.now();
  assert.equal(await waiting, null);
  assert.ok(Date.now() - gone < 2_000, "a request on a connection that closes ends then, not at its timeout");
});

test("a newer connection replaces the older one", async () => {
  const id = user("replace");
  const first = await connectMac(cloud.url, id);
  const count = tunnel.connectedCount();
  const second = await connectMac(cloud.url, id, { answer: () => ({ status: 200, headers: {}, body: "" }) });
  const closed = await first.closed;
  assert.equal(closed.code, 4000);
  assert.ok(first.frames.some((f) => f.t === "replaced"));
  assert.equal(tunnel.connectedCount(), count);
  assert.equal(tunnel.isConnected(id), true);
  assert.equal((await tunnel.requestMac(id, { method: "GET", path: "/", headers: {}, body: Buffer.alloc(0) }, 2_000))?.status, 200, "requests go to the newer one");
  second.ws.close();
});

test("events wait for the Mac, go oldest first, again until acked, and once", async () => {
  const id = user("events");
  await tunnel.queueForMac(id, "agentphone", { n: 1 }, "agentphone:d1");
  await tunnel.queueForMac(id, "agentphone", { n: 1, again: true }, "agentphone:d1");
  await tunnel.queueForMac(id, "call", { n: 2 });
  assert.equal((await pending(id)).length, 2, "the same dedupe key is kept once");

  const first = await connectMac(cloud.url, id, { ack: false });
  await until(() => events(first.frames).length === 2, "both events");
  assert.deepEqual(
    events(first.frames).map((e) => [e.kind, e.payload]),
    [
      ["agentphone", { n: 1 }],
      ["call", { n: 2 }],
    ],
  );
  assert.ok(events(first.frames).every((e) => /^\d+$/.test(e.id) && !Number.isNaN(Date.parse(e.at))));
  first.ws.close();
  await first.closed;
  assert.ok((await pending(id)).every((p) => !p.delivered_at), "nothing is delivered until the Mac acks");

  const second = await connectMac(cloud.url, id);
  await until(async () => (await pending(id)).every((p) => p.delivered_at), "both acked");
  assert.deepEqual(
    events(second.frames).map((e) => e.payload),
    [{ n: 1 }, { n: 2 }],
  );

  await tunnel.queueForMac(id, "call", { n: 3 });
  await until(async () => (await pending(id)).every((p) => p.delivered_at), "the new event, sent right away and acked");
  assert.deepEqual(
    events(second.frames).map((e) => e.payload),
    [{ n: 1 }, { n: 2 }, { n: 3 }],
  );
  second.ws.close();
  await second.closed;

  const third = await connectMac(cloud.url, id);
  await sleep(150);
  assert.equal(events(third.frames).length, 0, "what was acked doesn't come again");
  third.ws.close();
});

test("a Mac can only ack its own user's events", async () => {
  const a = user("ack-a");
  const b = user("ack-b");
  await tunnel.queueForMac(a, "call", { for: "a" });
  const [row] = await pending(a);
  const macB = await connectMac(cloud.url, b, { ack: false });
  macB.send({ t: "ack", id: row.id });
  macB.send({ t: "ack", id: "1; DROP TABLE bops.cloud_pending" });
  await sleep(150);
  assert.equal((await pending(a))[0].delivered_at, null);
  macB.ws.close();
});

test("what no Mac will take is cleared out as events come in: never taken in its time, or delivered a week ago", async () => {
  const id = user("clear");
  await tunnel.queueForMac(id, "slack", { n: "stale" }, "slack:stale", new Date(Date.now() - 1_000));
  await tunnel.queueForMac(id, "slack", { n: "fresh" }, "slack:fresh", new Date(Date.now() + 60_000));
  await tunnel.queueForMac(id, "agentphone", { n: "text" }, "agentphone:text");
  await tunnel.queueForMac(id, "call", { n: "last week" }, "call:last-week");
  await tunnel.queueForMac(id, "call", { n: "yesterday" }, "call:yesterday");
  await query("UPDATE bops.cloud_pending SET delivered_at = now() - interval '8 days' WHERE user_id = $1 AND dedupe_key = 'call:last-week'", [id]);
  await query("UPDATE bops.cloud_pending SET delivered_at = now() - interval '1 day' WHERE user_id = $1 AND dedupe_key = 'call:yesterday'", [id]);
  const saved = tunnel.timing.clearEveryMs;
  tunnel.timing.clearEveryMs = 0;
  try {
    // A new event for anyone sets it off; this user's Mac never comes back.
    await tunnel.queueForMac(user("clear-other"), "call", { n: "new" });
    await until(async () => (await pending(id)).length === 3, "the old ones to go");
  } finally {
    tunnel.timing.clearEveryMs = saved;
  }
  assert.deepEqual(
    (await pending(id)).map((p) => p.dedupe_key),
    ["slack:fresh", "agentphone:text", "call:yesterday"],
    "a text with no time limit waits however long it takes",
  );
});

test("pings keep a Mac; one that stops answering is dropped", async () => {
  const saved = { ...tunnel.timing };
  tunnel.timing.pingMs = 50;
  tunnel.timing.dropMs = 400;
  try {
    const aliveId = user("alive");
    const silentId = user("silent");
    const alive = await connectMac(cloud.url, aliveId);
    const silent = await connectMac(cloud.url, silentId, { pong: false });
    const closed = await silent.closed;
    assert.equal(closed.code, 1006, "dropped without a closing handshake");
    assert.equal(tunnel.isConnected(silentId), false);
    assert.equal(tunnel.isConnected(aliveId), true);
    assert.ok(alive.frames.filter((f) => f.t === "ping").length >= 3);
    alive.ws.close();
  } finally {
    Object.assign(tunnel.timing, saved);
  }
});

test("closeAll tells every Mac the cloud is going away", async () => {
  const mac = await connectMac(cloud.url, user("close"));
  tunnel.closeAll();
  assert.equal((await mac.closed).code, 1001);
  assert.equal(tunnel.connectedCount(), 0);
});
