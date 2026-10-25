// Tests for Live on the Mac (lib/server/live-core.ts): which of this Mac's bots are busy and how
// (typing, a thread this Mac runs, a call), the publisher sending only what changed plus a refresh every
// 5 seconds while a bot isn't idle, idle when one stops, retries with backoff and a cloud without Live
// left alone; the stream reconnecting with backoff and jitter and its Last-Event-ID, reading the state
// on another device's "state" or a "reset" (never on its own), and the other devices' moods running out.
//
// Clocks and timers are fakes driven here, the cloud's answers come from fake functions, and the stream
// is a stream made here: nothing reaches a real Bops Cloud.
// Usage: node scripts/test-live.mjs
import assert from "node:assert/strict";
import { registerHooks } from "node:module";
import { pathToFileURL } from "node:url";

const root = new URL("..", import.meta.url).pathname.replace(/\/$/, "");
registerHooks({
  resolve(specifier, context, next) {
    if (specifier.startsWith("@/")) specifier = pathToFileURL(`${root}/${specifier.slice(2)}`).href;
    try {
      return next(specifier, context);
    } catch (e) {
      if (/^(\.{1,2}\/|\/|file:)/.test(specifier))
        for (const ext of [".ts", ".tsx"])
          try {
            return next(specifier + ext, context);
          } catch {}
      throw e;
    }
  },
});

const { LivePublisher, LiveSubscriber, RemoteMoods, localMoods, localSessions, liveRoutine, onLiveRoutine, MOOD_REFRESH_MS, NO_LIVE_MS, PULL_MIN_MS, REFUSED_MS, SILENT_MS } = await import(`${root}/lib/server/live-core.ts`);

let failures = 0;
let passed = 0;
async function check(name, fn) {
  try {
    await fn();
    passed++;
  } catch (e) {
    failures++;
    console.error(`FAIL ${name}\n  ${e.stack.split("\n").join("\n  ")}`);
  }
}

const settle = async () => {
  for (let i = 0; i < 10; i++) await new Promise((r) => setImmediate(r));
};

/** A clock whose time only moves when a test says, and timers that fire then. `random` is the jitter (1: the whole wait). */
function fakeClock(random = 1) {
  let t = 0;
  let timers = [];
  return {
    now: () => t,
    random: () => random,
    setTimeout: (fn, ms) => {
      const h = { at: t + ms, fn };
      timers.push(h);
      return h;
    },
    clearTimeout: (h) => (timers = timers.filter((x) => x !== h)),
    /** Move time on by `ms`, firing each timer as its time comes. */
    async advance(ms) {
      const end = t + ms;
      for (;;) {
        timers.sort((a, b) => a.at - b.at);
        const next = timers[0];
        if (!next || next.at > end) break;
        timers.shift();
        t = next.at;
        next.fn();
        await settle();
      }
      t = end;
      await settle();
    },
    waits: () => timers.map((x) => x.at - t).sort((a, b) => a - b),
  };
}

const state = () => ({
  bots: [
    { id: "boppy", isMain: true },
    { id: "max", isMain: true, workspaceId: "ws_acme" },
    { id: "otto", isMain: false },
  ],
  chats: [
    { id: "bot:boppy", kind: "bot", botIds: ["boppy"], typing: [] },
    { id: "grp", kind: "group", botIds: ["boppy", "otto"], typing: [] },
  ],
  sessions: [],
  workspaces: [
    { id: "ws_main", name: "Main" },
    { id: "ws_acme", name: "Acme" },
  ],
});

/* ---------------- What this Mac's bots are doing ---------------- */

await check("typing and asking are thinking, a thread this Mac runs is working, a call is speaking", () => {
  const s = state();
  s.chats[1].typing = ["otto"];
  s.chats[0].asking = { boppy: "otto" };
  s.sessions = [
    { id: "s_here", botId: "max", status: "running" },
    { id: "s_elsewhere", botId: "otto", status: "running" },
    { id: "s_asks", botId: "boppy", status: "running", askWhere: true },
  ];
  const got = localMoods(s, { runs: new Set(["s_here", "s_asks"]), callBot: null });
  assert.deepEqual(Object.fromEntries(got), {
    max: { ws: "ws_acme", mood: "working" },
    otto: { ws: "ws_main", mood: "thinking", chatId: "grp" },
    boppy: { ws: "ws_main", mood: "thinking", chatId: "bot:boppy" },
  });
  // A thread another Mac runs is that Mac's to say; one asking where it runs isn't working yet.
  const call = localMoods(s, { runs: new Set(["s_here"]), callBot: "max" });
  assert.deepEqual(call.get("max"), { ws: "ws_acme", mood: "speaking" });
  assert.deepEqual(localMoods(state(), { runs: new Set(), callBot: "gone" }).size, 0, "a call with a bot that isn't there says nothing");
  assert.deepEqual(Object.fromEntries(localSessions(s, new Set(["s_here"]))), { s_here: { ws: "ws_acme", botId: "max", status: "running" } });
});

/* ---------------- Publishing ---------------- */

function publisher(answer = () => 200) {
  const clock = fakeClock();
  const sent = [];
  const pub = new LivePublisher(async (ws, events) => {
    sent.push({ ws, events });
    return answer(ws, events);
  }, clock);
  return { pub, clock, sent };
}
const moods = (o) => new Map(Object.entries(o));

await check("only what changed goes, gathered for a moment; a bot that stops goes idle", async () => {
  const { pub, clock, sent } = publisher();
  pub.update(moods({ boppy: { ws: "ws_main", mood: "thinking", chatId: "bot:boppy" } }), new Map());
  pub.update(moods({ boppy: { ws: "ws_main", mood: "thinking", chatId: "bot:boppy" } }), new Map());
  assert.equal(sent.length, 0, "gathered first");
  await clock.advance(300);
  assert.deepEqual(sent, [{ ws: "ws_main", events: [{ type: "mood", botId: "boppy", mood: "thinking", chatId: "bot:boppy", ttl: 15 }] }]);
  // The same again: nothing goes.
  pub.update(moods({ boppy: { ws: "ws_main", mood: "thinking", chatId: "bot:boppy" } }), new Map());
  await clock.advance(300);
  assert.equal(sent.length, 1);
  // Thinking to working, and a second bot in another workspace: one POST per workspace.
  pub.update(moods({ boppy: { ws: "ws_main", mood: "working" }, max: { ws: "ws_acme", mood: "working" } }), new Map());
  await clock.advance(300);
  assert.deepEqual(
    sent.slice(1).map((x) => [x.ws, x.events.map((e) => `${e.botId}:${e.mood}`)]),
    [
      ["ws_main", ["boppy:working"]],
      ["ws_acme", ["max:working"]],
    ],
  );
  pub.update(moods({ max: { ws: "ws_acme", mood: "working" } }), new Map());
  await clock.advance(300);
  assert.deepEqual(sent.at(-1), { ws: "ws_main", events: [{ type: "mood", botId: "boppy", mood: "idle" }] });
});

await check("a mood that holds is said again every 5 seconds, and an idle Mac says nothing", async () => {
  const { pub, clock, sent } = publisher();
  pub.update(moods({ boppy: { ws: "ws_main", mood: "working" } }), new Map());
  await clock.advance(300);
  assert.equal(sent.length, 1);
  await clock.advance(MOOD_REFRESH_MS);
  assert.equal(sent.length, 2);
  assert.deepEqual(sent[1].events, [{ type: "mood", botId: "boppy", mood: "working", ttl: 15 }]);
  await clock.advance(MOOD_REFRESH_MS);
  assert.equal(sent.length, 3);
  pub.update(new Map(), new Map());
  await clock.advance(300);
  assert.equal(sent.at(-1).events[0].mood, "idle");
  const n = sent.length;
  await clock.advance(MOOD_REFRESH_MS * 4);
  assert.equal(sent.length, n, "nothing while every bot is idle");
});

await check("a thread goes when its status or activity changes, routines and calls as they happen", async () => {
  const { pub, clock, sent } = publisher();
  const s = (status, activity) => new Map([["s1", { ws: "ws_acme", botId: "max", status, ...(activity ? { activity } : {}) }]]);
  pub.update(new Map(), s("running", "searching"));
  pub.routine("ws_main", "rt_1", "run-started");
  pub.call("ws_main", "boppy", true);
  await clock.advance(300);
  assert.deepEqual(sent, [
    { ws: "ws_acme", events: [{ type: "session", id: "s1", botId: "max", status: "running", activity: "searching" }] },
    { ws: "ws_main", events: [{ type: "routine", id: "rt_1", change: "run-started" }, { type: "call", botId: "boppy", on: true }] },
  ]);
  pub.update(new Map(), s("running", "searching"));
  await clock.advance(300);
  assert.equal(sent.length, 2);
  pub.update(new Map(), s("done"));
  await clock.advance(300);
  assert.deepEqual(sent.at(-1).events, [{ type: "session", id: "s1", botId: "max", status: "done" }]);
});

await check("what didn't go is tried again with backoff, the newest mood winning; a cloud without Live is left alone", async () => {
  let up = false;
  const { pub, clock, sent } = publisher(() => (up ? 200 : 0));
  pub.update(moods({ boppy: { ws: "ws_main", mood: "thinking" } }), new Map());
  await clock.advance(300);
  assert.equal(sent.length, 1);
  // Meanwhile it moved on: when it's tried again, only the newest goes.
  pub.update(moods({ boppy: { ws: "ws_main", mood: "working" } }), new Map());
  await clock.advance(500);
  assert.equal(sent.length, 1, "waits out the backoff (1 second)");
  await clock.advance(600);
  assert.equal(sent.length, 2);
  assert.deepEqual(sent[1].events, [{ type: "mood", botId: "boppy", mood: "working", ttl: 15 }]);
  // The second failure (at 1.25 seconds) waits 2 seconds.
  await clock.advance(1800);
  assert.equal(sent.length, 2);
  up = true;
  await clock.advance(100);
  assert.equal(sent.length, 3);
  assert.equal(pub.waiting().length, 0);

  const old = publisher(() => 404);
  old.pub.update(moods({ boppy: { ws: "ws_main", mood: "thinking" } }), new Map());
  await old.clock.advance(300);
  assert.equal(old.sent.length, 1);
  old.pub.update(moods({ boppy: { ws: "ws_main", mood: "working" } }), new Map());
  await old.clock.advance(NO_LIVE_MS - 1000);
  assert.equal(old.sent.length, 1, "nothing for a quarter of an hour");
  await old.clock.advance(MOOD_REFRESH_MS + 2000);
  assert.ok(old.sent.length >= 2, "then it asks again");

  // A key the cloud turns down: nothing kept, and nothing more for five minutes, however busy the bot.
  const refused = publisher(() => 401);
  refused.pub.update(moods({ boppy: { ws: "ws_main", mood: "thinking" } }), new Map());
  await refused.clock.advance(300);
  assert.equal(refused.sent.length, 1);
  assert.equal(refused.pub.waiting().length, 0);
  refused.pub.update(moods({ boppy: { ws: "ws_main", mood: "working" } }), new Map());
  await refused.clock.advance(REFUSED_MS - 1000);
  assert.equal(refused.sent.length, 1, "no POST every 5 seconds on a refused key");
  await refused.clock.advance(MOOD_REFRESH_MS + 2000);
  assert.ok(refused.sent.length >= 2, "then it asks again");

  // A 400 isn't worth sending again.
  const bad = publisher(() => 400);
  bad.pub.update(moods({ boppy: { ws: "ws_main", mood: "thinking" } }), new Map());
  await bad.clock.advance(300);
  assert.equal(bad.pub.waiting().length, 0);
});

await check("stopping says every busy bot idle once, then nothing more goes", async () => {
  const { pub, clock, sent } = publisher();
  pub.update(moods({ boppy: { ws: "ws_main", mood: "working" }, max: { ws: "ws_acme", mood: "thinking" } }), new Map());
  await clock.advance(300);
  await pub.stop();
  assert.deepEqual(
    sent.slice(2).map((x) => [x.ws, x.events]),
    [
      ["ws_main", [{ type: "mood", botId: "boppy", mood: "idle" }]],
      ["ws_acme", [{ type: "mood", botId: "max", mood: "idle" }]],
    ],
  );
  pub.update(moods({ boppy: { ws: "ws_main", mood: "working" } }), new Map());
  await clock.advance(MOOD_REFRESH_MS * 3);
  assert.equal(sent.length, 4);
});

/* ---------------- The other devices' moods ---------------- */

await check("other devices' moods run out by their ttl, and this Mac's own are left out", async () => {
  const clock = fakeClock();
  let changes = 0;
  const rm = new RemoteMoods(() => changes++, clock);
  rm.snapshot({ moods: [{ botId: "boppy", mood: "working", ttl: 15, by: "mac-2" }, { botId: "otto", mood: "thinking", ttl: 15, by: "mac-1" }] }, "mac-1");
  assert.deepEqual(rm.forApp(), { boppy: { mood: "working" } });
  assert.equal(changes, 1);
  rm.apply({ botId: "max", mood: "thinking", chatId: "bot:max", ttl: 5, by: "mac-2" }, "mac-1");
  rm.apply({ botId: "otto", mood: "working", ttl: 5, by: "mac-1" }, "mac-1");
  assert.deepEqual(rm.forApp(), { boppy: { mood: "working" }, max: { mood: "thinking", chatId: "bot:max" } });
  await clock.advance(5_000);
  assert.deepEqual(rm.forApp(), { boppy: { mood: "working" } }, "max ran out");
  // Said again before it runs out: it stays.
  await clock.advance(9_000);
  rm.apply({ botId: "boppy", mood: "working", ttl: 15, by: "mac-2" }, "mac-1");
  await clock.advance(10_000);
  assert.deepEqual(rm.forApp(), { boppy: { mood: "working" } });
  rm.apply({ botId: "boppy", mood: "idle", by: "mac-2" }, "mac-1");
  assert.deepEqual(rm.forApp(), {});
  assert.deepEqual(clock.waits(), [], "no timer left once there are none");
});

/* ---------------- The stream ---------------- */

/** A fake Bops Cloud: each connect is answered by `answer(i, headers)`, a status, or an object with `push` to write events and `end`. */
function fakeCloud(answer) {
  const calls = [];
  const fetch = async (url, init) => {
    const i = calls.length;
    calls.push({ url, headers: init.headers });
    const a = answer(i, init.headers);
    if (typeof a === "number") return new Response(null, { status: a });
    if (a instanceof Error) throw a;
    let ctl;
    const body = new ReadableStream({ start: (c) => (ctl = c) });
    init.signal?.addEventListener("abort", () => {
      try {
        ctl.error(new Error("aborted"));
      } catch {}
    });
    a.push = (text) => ctl.enqueue(new TextEncoder().encode(text));
    a.end = () => ctl.close();
    return new Response(body, { status: 200, headers: { "content-type": "text/event-stream" } });
  };
  return { fetch, calls };
}

function subscriber(answer, random = 1) {
  const clock = fakeClock(random);
  const cloud = fakeCloud(answer);
  let pulls = 0;
  const rm = new RemoteMoods(() => {}, clock);
  const sub = new LiveSubscriber(
    { fetch: cloud.fetch, url: (ws) => `https://cloud.test/v1/live?ws=${ws}`, headers: () => ({ Authorization: "Bearer k" }), self: () => "mac-1", pull: () => pulls++, moods: rm },
    clock,
  );
  return { sub, clock, cloud, rm, pulls: () => pulls };
}

await check("a dropped stream comes back after 1, 2, 4… seconds with jitter; a cloud without Live is asked every 15 minutes", async () => {
  // Jitter 0: each wait is half of its step.
  const { sub, clock, cloud } = subscriber(() => new Error("offline"), 0);
  sub.start("ws_main");
  await settle();
  assert.equal(cloud.calls.length, 1);
  const waits = [];
  for (let i = 0; i < 7; i++) {
    waits.push(clock.waits().find((w) => w < SILENT_MS));
    await clock.advance(waits.at(-1));
  }
  assert.deepEqual(waits, [500, 1000, 2000, 4000, 8000, 16000, 30000], "half of 1, 2, 4… seconds, up to a minute");
  sub.stop();

  const none = subscriber(() => 404);
  none.sub.start("ws_main");
  await settle();
  assert.equal(none.clock.waits().at(-1), NO_LIVE_MS);
  await none.clock.advance(NO_LIVE_MS - 1);
  assert.equal(none.cloud.calls.length, 1);
  await none.clock.advance(1);
  assert.equal(none.cloud.calls.length, 2);
  none.sub.stop();
});

await check("the stream reads the state on another device's change or a reset, never its own, and comes back with its Last-Event-ID", async () => {
  const streams = [];
  const { sub, clock, cloud, rm, pulls } = subscriber(() => {
    const s = {};
    streams.push(s);
    return s;
  });
  sub.start("ws_main");
  await settle();
  streams[0].push(`event: snapshot\ndata: ${JSON.stringify({ moods: [{ botId: "boppy", mood: "working", ttl: 15, by: "mac-2" }] })}\n\n`);
  streams[0].push("id: b1-4\nevent: reset\ndata: {}\n\n");
  await settle();
  assert.deepEqual(rm.forApp(), { boppy: { mood: "working" } });
  await clock.advance(250);
  assert.equal(pulls(), 1, "a reset reads the state");
  streams[0].push(`id: b1-5\nevent: state\ndata: ${JSON.stringify({ type: "state", hash: "h", by: "mac-1", at: 0 })}\n\n`);
  await settle();
  await clock.advance(250);
  assert.equal(pulls(), 1, "its own write doesn't");
  // Two close together are one read; a comment is only a heartbeat.
  streams[0].push(`: hb\n\nid: b1-6\nevent: state\ndata: ${JSON.stringify({ type: "state", hash: "h2", by: "mac-2", at: 0 })}\n\n`);
  streams[0].push(`id: b1-7\nevent: state\ndata: ${JSON.stringify({ type: "state", seq: 9, by: "cloud", at: 0 })}\n\n`);
  await settle();
  await clock.advance(250);
  assert.equal(pulls(), 1, "not again within 5 seconds of the last read");
  await clock.advance(PULL_MIN_MS);
  assert.equal(pulls(), 2, "read once those 5 seconds are up");
  streams[0].push(`event: mood\ndata: ${JSON.stringify({ type: "mood", botId: "boppy", mood: "idle", by: "mac-2", at: 0 })}\n\n`);
  await settle();
  assert.deepEqual(rm.forApp(), {});
  // Dropped: back after the first wait, from where it was.
  streams[0].end();
  await settle();
  await clock.advance(1000);
  assert.equal(cloud.calls.length, 2);
  assert.equal(cloud.calls[1].headers["last-event-id"], "b1-7");
  sub.stop();
});

await check("a thread writing every second on another Mac is read at most every 5 seconds, and not again after the tunnel's read", async () => {
  const streams = [];
  const { sub, clock, pulls } = subscriber(() => {
    const s = {};
    streams.push(s);
    return s;
  });
  sub.start("ws_main");
  await settle();
  const state = (n) => streams[0].push(`id: b1-${n}\nevent: state\ndata: ${JSON.stringify({ type: "state", seq: n, by: "mac-2", at: 0 })}\n\n`);
  for (let n = 1; n <= 20; n++) {
    state(n);
    await settle();
    await clock.advance(1000);
  }
  assert.ok(pulls() >= 4 && pulls() <= 5, `${pulls()} reads in 20 seconds`);
  // The last change is read too, at the end of its 5 seconds.
  await clock.advance(PULL_MIN_MS);
  const after = pulls();
  await clock.advance(PULL_MIN_MS * 2);
  assert.equal(pulls(), after, "and then nothing while nothing changes");
  // The tunnel read the state for a write: the stream's read for the same write is dropped.
  state(21);
  await settle();
  sub.pulled();
  await clock.advance(PULL_MIN_MS * 2);
  assert.equal(pulls(), after);
  sub.stop();
});

await check("a silent stream is taken for dead, and another workspace starts over from nothing", async () => {
  const streams = [];
  const { sub, clock, cloud, rm } = subscriber(() => {
    const s = {};
    streams.push(s);
    return s;
  });
  sub.start("ws_main");
  await settle();
  streams[0].push(`id: b1-3\nevent: snapshot\ndata: ${JSON.stringify({ moods: [{ botId: "boppy", mood: "working", ttl: 60, by: "mac-2" }] })}\n\n`);
  await settle();
  await clock.advance(SILENT_MS);
  await clock.advance(1000);
  assert.equal(cloud.calls.length, 2, "reconnected after 45 silent seconds");
  // The same workspace again changes nothing; another one forgets the moods and the place.
  sub.start("ws_main");
  await settle();
  assert.equal(cloud.calls.length, 2);
  sub.start("ws_acme");
  await settle();
  assert.equal(cloud.calls.length, 3);
  assert.equal(cloud.calls[2].url, "https://cloud.test/v1/live?ws=ws_acme");
  assert.equal(cloud.calls[2].headers["last-event-id"], undefined);
  assert.deepEqual(rm.forApp(), {});
  sub.stop();
  await clock.advance(120_000);
  assert.equal(cloud.calls.length, 3, "stopped is stopped");
});

await check("a routine's change goes to Live while it runs, and nowhere when it doesn't", () => {
  const got = [];
  liveRoutine("ws_main", "rt_1", "added");
  onLiveRoutine((ws, id, change) => got.push([ws, id, change]));
  liveRoutine("ws_acme", "rt_2", "run-finished");
  onLiveRoutine(null);
  liveRoutine("ws_main", "rt_3", "removed");
  assert.deepEqual(got, [["ws_acme", "rt_2", "run-finished"]]);
});

console.log(`${passed} passed, ${failures} failed`);
process.exit(failures ? 1 : 0);
