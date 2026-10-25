import assert from "node:assert/strict";
import { createServer, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import { after, before, test } from "node:test";
import type { IncomingMessage, ServerResponse } from "node:http";
import { canWatch, eventOf, forgetSeen, LiveHub, messagesWritten, PUBLISH_BUDGET, publishOf, REPLAY_MS, serveStream, sliceHash, stateWritten, type LiveSub, type LiveTarget } from "../live.ts";

/**
 * Live (live.ts): the hub fans each event out to every stream of its workspace and no other, a device
 * that comes back is sent what it missed or told to start over, moods run out, publishes are checked
 * and capped, streams are capped, and "state" goes out only when a workspace's part of the state
 * changed. Then the same through the router, over HTTP: Orgo is a fake on localhost, and no database
 * is needed (nothing here touches one).
 */

type Got = { type: string; id?: string; data: Record<string, unknown> };

/** A stream that keeps what it's sent, parsed. */
function fakeSub(): LiveSub & { got: Got[]; ended: boolean; text: string } {
  const s = {
    got: [] as Got[],
    ended: false,
    text: "",
    write(chunk: string) {
      s.text += chunk;
      for (const block of chunk.split("\n\n").filter((b) => b && !b.startsWith(":"))) {
        const field = (name: string) => block.split("\n").find((l) => l.startsWith(`${name}: `))?.slice(name.length + 2);
        s.got.push({ type: field("event") ?? "", id: field("id"), data: JSON.parse(field("data") ?? "{}") });
      }
    },
    end() {
      s.ended = true;
    },
  };
  return s;
}

const A: LiveTarget = { account: "user-a", ws: "ws_main" };
const types = (s: { got: Got[] }) => s.got.map((g) => g.type);
const mood = (botId: string, m: "thinking" | "working" | "idle", ttl?: number) => ({ type: "mood" as const, botId, mood: m, ...(ttl ? { ttl } : {}), by: "mac-1", at: 0 });

test("an event reaches every stream of its workspace, and none of another workspace or account", () => {
  const hub = new LiveHub({ now: () => 1000 });
  const [one, two, otherWs, otherAccount] = [fakeSub(), fakeSub(), fakeSub(), fakeSub()];
  hub.open(A, one, null);
  hub.open(A, two, null);
  hub.open({ ...A, ws: "ws_other" }, otherWs, null);
  hub.open({ account: "user-b", ws: "ws_main" }, otherAccount, null);
  hub.publish(A, mood("boppy", "thinking"));
  hub.publish(A, { type: "routine", id: "rt_1", change: "added", by: "mac-1", at: 0 });
  for (const s of [one, two]) assert.deepEqual(types(s), ["snapshot", "reset", "mood", "routine"]);
  for (const s of [otherWs, otherAccount]) assert.deepEqual(types(s), ["snapshot", "reset"]);
  assert.equal(one.got[2].data.mood, "thinking");
  assert.equal(one.got[2].data.ttl, 15, "the default ttl goes with it");
});

test("only the account's own user may watch its workspaces", () => {
  assert.equal(canWatch({ id: "user-a" }, A), true);
  assert.equal(canWatch({ id: "user-b" }, A), false);
});

test("a new stream starts with the moods there are now", () => {
  const hub = new LiveHub({ now: () => 0 });
  hub.publish(A, { ...mood("boppy", "working"), chatId: "bot:boppy" });
  hub.publish(A, mood("otto", "thinking"));
  hub.publish(A, mood("otto", "idle"));
  const s = fakeSub();
  hub.open(A, s, null);
  assert.equal(s.got[0].type, "snapshot");
  assert.deepEqual(s.got[0].data, { moods: [{ botId: "boppy", chatId: "bot:boppy", mood: "working", ttl: 15, by: "mac-1" }] });
});

test("a device that comes back within the buffer is sent what it missed; the moods aren't replayed", () => {
  let now = 0;
  const hub = new LiveHub({ now: () => now });
  const first = fakeSub();
  hub.open(A, first, null);
  hub.publish(A, { type: "session", id: "s1", botId: "boppy", status: "running", by: "mac-1", at: 0 });
  const lastId = first.got.at(-1)!.id!;
  assert.match(lastId, new RegExp(`^${hub.boot}-\\d+$`));
  hub.close(A, first);
  now = 30_000;
  hub.publish(A, { type: "session", id: "s1", botId: "boppy", status: "done", by: "mac-1", at: 0 });
  hub.publish(A, mood("boppy", "thinking"));
  hub.publish(A, { type: "call", botId: "boppy", on: true, by: "mac-1", at: 0 });
  const back = fakeSub();
  hub.open(A, back, lastId);
  assert.deepEqual(types(back), ["snapshot", "session", "call"]);
  assert.equal(back.got[1].data.status, "done");
  // The snapshot has the mood instead.
  assert.equal((back.got[0].data.moods as unknown[]).length, 1);
});

test("an id older than the buffer, from before a restart, or made up gets reset", () => {
  let now = 0;
  const hub = new LiveHub({ now: () => now });
  const s = fakeSub();
  hub.open(A, s, null);
  hub.publish(A, { type: "routine", id: "rt_1", change: "changed", by: "mac-1", at: 0 });
  const old = s.got.at(-1)!.id!;
  hub.publish(A, { type: "routine", id: "rt_1", change: "run-started", by: "mac-1", at: 0 });
  now = REPLAY_MS + 5_000;
  hub.sweep();
  const late = fakeSub();
  hub.open(A, late, old);
  assert.deepEqual(types(late), ["snapshot", "reset"]);
  // The reset says where it goes on from: back with that id, nothing is missed.
  const resetId = late.got[1].id!;
  const again = fakeSub();
  hub.open(A, again, resetId);
  assert.deepEqual(types(again), ["snapshot"]);

  const restarted = new LiveHub({ now: () => now });
  restarted.publish(A, { type: "routine", id: "rt_1", change: "added", by: "mac-1", at: 0 });
  restarted.publish(A, { type: "routine", id: "rt_2", change: "added", by: "mac-1", at: 0 });
  const fromBefore = fakeSub();
  // The same seq under the old boot: never taken for one of now.
  restarted.open(A, fromBefore, `${hub.boot}-1`);
  assert.deepEqual(types(fromBefore), ["snapshot", "reset"]);
  for (const bogus of ["", "nonsense", `${restarted.boot}-999`, `${restarted.boot}--1`]) {
    const b = fakeSub();
    restarted.open(A, b, bogus);
    assert.deepEqual(types(b), ["snapshot", "reset"], bogus);
  }
});

test("a mood not said again runs out: it leaves the snapshot and an idle goes out", () => {
  let now = 0;
  const hub = new LiveHub({ now: () => now });
  const s = fakeSub();
  hub.open(A, s, null);
  hub.publish(A, mood("boppy", "working", 15));
  now = 10_000;
  hub.sweep();
  assert.equal(types(s).filter((t) => t === "mood").length, 1, "not yet");
  // Said again: it lasts another 15 seconds.
  hub.publish(A, mood("boppy", "working", 15));
  now = 24_000;
  hub.sweep();
  assert.equal(s.got.at(-1)!.data.mood, "working");
  now = 25_001;
  hub.sweep();
  assert.deepEqual(s.got.at(-1)!.data, { type: "mood", botId: "boppy", mood: "idle", by: "mac-1", at: 25_001 });
  const late = fakeSub();
  hub.open(A, late, null);
  assert.deepEqual(late.got[0].data, { moods: [] });
});

test("a publish is checked strictly", () => {
  assert.deepEqual(eventOf({ type: "mood", botId: "boppy", mood: "thinking", chatId: "bot:boppy", ttl: 15 }), { type: "mood", botId: "boppy", mood: "thinking", chatId: "bot:boppy", ttl: 15 });
  assert.deepEqual(eventOf({ type: "call", botId: "boppy", on: false }), { type: "call", botId: "boppy", on: false });
  assert.deepEqual(eventOf({ type: "routine", id: "rt_1", change: "run-finished" }), { type: "routine", id: "rt_1", change: "run-finished" });
  assert.deepEqual(eventOf({ type: "session", id: "s_1", botId: "boppy", status: "running", activity: "searching" }), { type: "session", id: "s_1", botId: "boppy", status: "running", activity: "searching" });
  const bad = [
    null,
    [],
    { type: "state", hash: "x" },
    { type: "mood", botId: "boppy", mood: "sleeping" },
    { type: "mood", botId: "boppy", mood: "thinking", extra: 1 },
    { type: "mood", botId: "bad id with spaces", mood: "thinking" },
    { type: "mood", botId: "boppy", mood: "thinking", ttl: 3600 },
    { type: "mood", botId: "boppy", mood: "thinking", ttl: "15" },
    { type: "session", id: "s_1", botId: "boppy", status: "RUNNING!" },
    { type: "session", id: "s_1", botId: "boppy", status: "running", activity: "x".repeat(121) },
    { type: "routine", id: "rt_1", change: "exploded" },
    { type: "call", botId: "boppy", on: "yes" },
  ];
  for (const b of bad) assert.throws(() => eventOf(b), /Bad live event/, JSON.stringify(b));
  assert.throws(() => publishOf({ ws: "ws_main", events: [] }), /events must be/);
  assert.throws(() => publishOf({ ws: "ws_main", events: Array(17).fill({ type: "call", botId: "b", on: true }) }), /events must be/);
  assert.throws(() => publishOf({ ws: "../etc", events: [{ type: "call", botId: "b", on: true }] }), /ws must be/);
  assert.throws(() => publishOf({ ws: "ws_main", events: [{ type: "call", botId: "b", on: true }], account: "user-b" }), /Send \{ ws, events \}/);
});

test("streams are capped per account and in all", () => {
  const hub = new LiveHub({ now: () => 0, perAccount: 2, total: 3 });
  assert.equal(hub.open(A, fakeSub(), null), "ok");
  const second = fakeSub();
  assert.equal(hub.open(A, second, null), "ok");
  assert.equal(hub.open(A, fakeSub(), null), "account_full");
  assert.equal(hub.open({ account: "user-b", ws: "ws_main" }, fakeSub(), null), "ok");
  assert.equal(hub.open({ account: "user-c", ws: "ws_main" }, fakeSub(), null), "full");
  // One closing makes room.
  hub.close(A, second);
  assert.equal(hub.streamsOf(A.account), 1);
  assert.equal(hub.open(A, fakeSub(), null), "ok");
  assert.equal(hub.openCount(), 3);
});

test("a write of the state wakes only the workspaces whose part changed", () => {
  forgetSeen();
  const hub = new LiveHub({ now: () => 0 });
  const main = fakeSub();
  const acme = fakeSub();
  hub.open(A, main, null);
  hub.open({ ...A, ws: "ws_acme" }, acme, null);
  const blob = {
    workspaces: [
      { id: "ws_main", name: "Main" },
      { id: "ws_acme", name: "Acme" },
    ],
    bots: [{ id: "boppy", name: "Boppy" }, { id: "max", name: "Max", workspaceId: "ws_acme" }],
    chats: [{ id: "bot:boppy", botIds: ["boppy"] }, { id: "bot:max", botIds: ["max"], workspaceId: "ws_acme" }, { id: "grp", botIds: ["max"] }],
    sessions: [{ id: "s1", botId: "max", status: "running" }],
    routines: [],
    usage: { events: [1] },
  };
  const states = (s: { got: Got[] }) => s.got.filter((g) => g.type === "state");
  // The first write after a device started watching: each workspace hears it once.
  stateWritten(A.account, blob, "mac-1", hub);
  assert.equal(states(main).length, 1);
  assert.equal(states(acme).length, 1);
  assert.equal(states(main)[0].data.by, "mac-1");
  // The same again, and the usage ledger changing: nobody hears it.
  stateWritten(A.account, { ...blob, usage: { events: [1, 2, 3] } }, "mac-1", hub);
  assert.equal(states(main).length, 1);
  assert.equal(states(acme).length, 1);
  // The same content with its keys in another order (another Mac): still nothing.
  stateWritten(A.account, { ...blob, bots: [{ name: "Boppy", id: "boppy" }, { workspaceId: "ws_acme", name: "Max", id: "max" }] }, "mac-2", hub);
  assert.equal(states(main).length + states(acme).length, 2);
  // Acme's thread moves on: only Acme hears it, with its new fingerprint.
  const next = { ...blob, sessions: [{ id: "s1", botId: "max", status: "done" }] };
  stateWritten(A.account, next, "mac-2", hub);
  assert.equal(states(main).length, 1);
  assert.equal(states(acme).length, 2);
  assert.equal(states(acme)[1].data.hash, sliceHash(next, "ws_acme"));
  // Messages: the chat's workspace hears it with the seq; one not known goes to every watched workspace.
  messagesWritten(A.account, ["bot:max"], 42, "mac-1", hub);
  assert.equal(states(acme).at(-1)!.data.seq, 42);
  assert.equal(states(main).length, 1);
  messagesWritten(A.account, ["grp"], 43, "mac-1", hub);
  assert.equal(states(acme).at(-1)!.data.seq, 43, "a chat with no workspace of its own follows its first bot");
  messagesWritten(A.account, [""], 44, "mac-1", hub);
  assert.equal(states(main).at(-1)!.data.seq, 44);
  assert.equal(states(acme).at(-1)!.data.seq, 44);
});

test("nothing is worked out for an account nobody watches", () => {
  forgetSeen();
  const hub = new LiveHub({ now: () => 0 });
  stateWritten("user-z", { bots: [] }, "mac-1", hub);
  messagesWritten("user-z", ["bot:boppy"], 1, "mac-1", hub);
  assert.deepEqual(hub.watched("user-z"), []);
});

test("a state written while a device's stream is briefly down is sent when it comes back, and not once it's been away too long", () => {
  forgetSeen();
  let now = 0;
  const hub = new LiveHub({ now: () => now });
  const blob = (status: string) => ({ bots: [{ id: "boppy" }], chats: [], sessions: [{ id: "s1", botId: "boppy", status }], routines: [] });
  const first = fakeSub();
  hub.open(A, first, null);
  stateWritten(A.account, blob("running"), "mac-1", hub);
  const lastId = first.got.at(-1)!.id!;
  hub.close(A, first);
  // Another Mac finishes the thread while this one is reconnecting.
  now = 10_000;
  stateWritten(A.account, blob("done"), "mac-2", hub);
  const back = fakeSub();
  hub.open(A, back, lastId);
  assert.deepEqual(types(back), ["snapshot", "state"]);
  assert.equal(back.got[1].data.hash, sliceHash(blob("done"), "ws_main"));
  // Away longer than the buffer: nothing is kept for it, and it's reset when it comes back.
  const id = back.got.at(-1)!.id!;
  hub.close(A, back);
  now += REPLAY_MS + 1;
  stateWritten(A.account, blob("running"), "mac-2", hub);
  assert.deepEqual(hub.watched(A.account), []);
  hub.sweep();
  const late = fakeSub();
  hub.open(A, late, id);
  assert.deepEqual(types(late), ["snapshot"], "nothing happened in its workspace since, so nothing to catch up");
});

test("an account's workspaces and what was seen of its state go once nobody's used them", () => {
  forgetSeen();
  let now = 0;
  const hub = new LiveHub({ now: () => now });
  const s = fakeSub();
  hub.open(A, s, null);
  stateWritten(A.account, { bots: [{ id: "boppy" }], chats: [{ id: "bot:boppy", botIds: ["boppy"] }] }, "mac-1", hub);
  assert.ok(hub.seen.has(A.account));
  hub.close(A, s);
  // The laptop closes for days: no write comes to clear it.
  now = REPLAY_MS + 1_000;
  hub.sweep();
  assert.equal(hub.seen.has(A.account), false);
  assert.deepEqual(hub.watched(A.account), []);
});

test("a publish into a workspace nobody watches keeps no events, and an account's publishes are budgeted", () => {
  let now = 0;
  const hub = new LiveHub({ now: () => now });
  for (let i = 0; i < 50; i++) hub.publish({ ...A, ws: `ws_made_up_${i}` }, { type: "session", id: "s1", botId: "boppy", status: "running", by: "mac-1", at: 0 });
  assert.deepEqual(hub.watched(A.account), []);
  // So a workspace opened afterwards isn't crowded out by them.
  assert.equal(hub.wouldRefuse({ ...A, ws: "ws_real" }), "ok");
  assert.equal(hub.allow(A.account, PUBLISH_BUDGET), true);
  assert.equal(hub.allow(A.account, 1), false, "past the budget");
  assert.equal(hub.allow("user-b", 1), true, "another account has its own");
  now = 10_000;
  assert.equal(hub.allow(A.account, 1), true, "the next 10 seconds start over");
});

test("past what the hub holds in all, the buffer being added to gives up its oldest", () => {
  const hub = new LiveHub({ now: () => 0, ringBytes: 1_000 });
  const s = fakeSub();
  hub.open(A, s, null);
  const ev = (i: number) => ({ type: "session" as const, id: `s${i}`, botId: "boppy", status: "running", activity: "x".repeat(100), by: "mac-1", at: 0 });
  hub.publish(A, ev(0));
  const firstId = s.got.at(-1)!.id!;
  for (let i = 1; i < 20; i++) hub.publish(A, ev(i));
  const back = fakeSub();
  hub.open(A, back, firstId);
  assert.equal(types(back).at(-1), "reset", "what it missed is gone: it reads the state afresh");
  const recent = fakeSub();
  hub.open(A, recent, s.got.at(-2)!.id!);
  assert.deepEqual(types(recent), ["snapshot", "session"], "the newest is still kept");
});

/** A response and request as serveStream uses them, with what was done to them. */
function fakeHttp(opts: { gone?: boolean } = {}) {
  const on = new Map<string, () => void>();
  const res = {
    destroyed: !!opts.gone,
    writableEnded: false,
    writableLength: 0,
    written: [] as string[],
    cut: false,
    writeHead: () => res,
    flushHeaders: () => {},
    write: (chunk: string) => (res.written.push(chunk), true),
    end: () => void (res.writableEnded = true),
    destroy: () => void ((res.cut = true), (res.destroyed = true)),
    on: (name: string, fn: () => void) => (on.set(`res:${name}`, fn), res),
  };
  const req = { headers: {}, on: (name: string, fn: () => void) => (on.set(`req:${name}`, fn), req) };
  return { req: req as unknown as IncomingMessage, res: res as typeof res & ServerResponse, fake: res };
}

test("a stream whose client left while its key was checked takes no place", () => {
  const hub = new LiveHub({ now: () => 0 });
  const { req, res, fake } = fakeHttp({ gone: true });
  serveStream(req, res, A, hub);
  assert.equal(hub.streamsOf(A.account), 0);
  assert.equal(hub.openCount(), 0);
  assert.deepEqual(fake.written, []);
});

test("a client too far behind is cut off, not just ended, and its place freed", () => {
  const hub = new LiveHub({ now: () => 0 });
  const { req, res, fake } = fakeHttp();
  serveStream(req, res, A, hub);
  assert.equal(hub.streamsOf(A.account), 1);
  fake.writableLength = 300 * 1024;
  hub.publish(A, { type: "call", botId: "boppy", on: true, by: "mac-1", at: 0 });
  assert.equal(fake.cut, true, "the socket is destroyed");
  assert.equal(fake.writableEnded, false);
  assert.equal(hub.streamsOf(A.account), 0);
});

/* ---------------- Over HTTP ---------------- */

let orgo: Server;
let cloud: Server;
let base = "";

before(async () => {
  // Orgo's profile: the key "key-<id>" is <id>'s.
  orgo = createServer((req, res) => {
    const id = /^Bearer key-(.+)$/.exec(req.headers.authorization ?? "")?.[1];
    if (req.url !== "/api/user/profile" || !id) return void res.writeHead(401).end();
    res.writeHead(200, { "content-type": "application/json" }).end(JSON.stringify({ id }));
  });
  await new Promise<void>((r) => orgo.listen(0, "127.0.0.1", r));
  process.env.BOPS_ORGO_ORIGIN = `http://127.0.0.1:${(orgo.address() as AddressInfo).port}`;
  const { makeServer } = await import("../server.ts");
  cloud = makeServer();
  await new Promise<void>((r) => cloud.listen(0, "127.0.0.1", r));
  base = `http://127.0.0.1:${(cloud.address() as AddressInfo).port}`;
});

after(async () => {
  const { closeAll } = await import("../live.ts");
  closeAll();
  cloud.closeAllConnections();
  await new Promise((r) => cloud.close(r));
  await new Promise((r) => orgo.close(r));
});

/** Open a stream and read its events as they come. */
async function stream(user: string, ws: string, lastId?: string) {
  const ctl = new AbortController();
  const res = await fetch(`${base}/v1/live?ws=${ws}`, { headers: { authorization: `Bearer key-${user}`, ...(lastId ? { "last-event-id": lastId } : {}) }, signal: ctl.signal });
  const got: Got[] = [];
  let text = "";
  if (res.ok)
    void (async () => {
      const dec = new TextDecoder();
      try {
        for await (const chunk of res.body!) {
          text += dec.decode(chunk as Uint8Array, { stream: true });
          let i: number;
          while ((i = text.indexOf("\n\n")) >= 0) {
            const block = text.slice(0, i);
            text = text.slice(i + 2);
            if (block.startsWith(":")) continue;
            const field = (name: string) => block.split("\n").find((l) => l.startsWith(`${name}: `))?.slice(name.length + 2);
            got.push({ type: field("event") ?? "", id: field("id"), data: JSON.parse(field("data") ?? "{}") });
          }
        }
      } catch {}
    })();
  return { res, got, close: () => ctl.abort() };
}

const post = (user: string, body: unknown, raw?: string) =>
  fetch(`${base}/v1/live`, { method: "POST", headers: { authorization: `Bearer key-${user}`, "content-type": "application/json", "x-bops-device": "mac-1" }, body: raw ?? JSON.stringify(body) });

async function until<T>(check: () => T | undefined | false, what: string): Promise<T> {
  for (const end = Date.now() + 3000; Date.now() < end; await new Promise((r) => setTimeout(r, 20))) {
    const v = check();
    if (v) return v;
  }
  assert.fail(`timed out waiting for ${what}`);
}

test("over HTTP: a stream with the right headers, events from the user's own devices only", async () => {
  const mine = await stream("http-a", "ws_main");
  assert.equal(mine.res.status, 200);
  assert.match(mine.res.headers.get("content-type") ?? "", /^text\/event-stream/);
  assert.equal(mine.res.headers.get("x-accel-buffering"), "no");
  assert.match(mine.res.headers.get("cache-control") ?? "", /no-transform/);
  await until(() => mine.got.length >= 2, "the snapshot and reset");
  // Another account's publish into a workspace of the same id stays in that account.
  assert.equal((await post("http-b", { ws: "ws_main", events: [{ type: "mood", botId: "boppy", mood: "thinking" }] })).status, 200);
  assert.equal((await post("http-a", { ws: "ws_main", events: [{ type: "mood", botId: "boppy", mood: "working" }] })).status, 200);
  const m = await until(() => mine.got.find((g) => g.type === "mood"), "the mood");
  assert.equal(m.data.mood, "working");
  assert.equal(m.data.by, "mac-1");
  assert.equal(mine.got.filter((g) => g.type === "mood").length, 1);
  mine.close();
});

test("over HTTP: a bad, too big or unsigned publish is refused, and so is a bad workspace id", async () => {
  assert.equal((await post("http-a", { ws: "ws_main", events: [{ type: "state", hash: "x" }] })).status, 400);
  assert.equal((await post("http-a", null, "{not json")).status, 400);
  assert.equal((await post("http-a", null, JSON.stringify({ ws: "ws_main", events: [{ type: "call", botId: "b", on: true }], pad: "x".repeat(5000) }))).status, 413);
  const unsigned = await fetch(`${base}/v1/live`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ ws: "ws_main", events: [{ type: "call", botId: "b", on: true }] }) });
  assert.equal(unsigned.status, 401);
  assert.equal((await fetch(`${base}/v1/live?ws=a%20b`, { headers: { authorization: "Bearer key-http-a" } })).status, 400);
  assert.equal((await fetch(`${base}/v1/live?ws=ws_main`)).status, 401);
});

test("over HTTP: a client that leaves before its stream starts holds no place", async () => {
  const hub = new LiveHub();
  const slow = createServer((req, res) => void setTimeout(() => serveStream(req, res, A, hub), 300));
  await new Promise<void>((r) => slow.listen(0, "127.0.0.1", r));
  for (let i = 0; i < 3; i++) {
    const ctl = new AbortController();
    void fetch(`http://127.0.0.1:${(slow.address() as AddressInfo).port}/`, { signal: ctl.signal }).catch(() => {});
    setTimeout(() => ctl.abort(), 50);
  }
  await new Promise((r) => setTimeout(r, 500));
  assert.equal(hub.openCount(), 0);
  assert.equal(hub.streamsOf(A.account), 0);
  hub.closeAll();
  slow.closeAllConnections();
  await new Promise((r) => slow.close(r));
});

test("over HTTP: past the cap a stream is refused with 429, and a closed one makes room", async () => {
  const open = [];
  for (let i = 0; i < 20; i++) open.push(await stream("http-cap", "ws_main"));
  assert.ok(open.every((s) => s.res.status === 200));
  const over = await stream("http-cap", "ws_main");
  assert.equal(over.res.status, 429);
  open.pop()!.close();
  // The cloud hears the close a moment later.
  let back: Awaited<ReturnType<typeof stream>> | null = null;
  for (let i = 0; i < 50 && !back; i++) {
    const s = await stream("http-cap", "ws_main");
    if (s.res.status === 200) back = s;
    else await new Promise((r) => setTimeout(r, 20));
  }
  assert.ok(back, "a closed stream makes room for another");
  back.close();
  for (const s of open) s.close();
});
