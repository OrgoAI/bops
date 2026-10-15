// Tests for the routines mirror to Orgo (lib/server/routine-sync.ts): nothing is sent for a workspace
// without an Orgo project, changes are gathered for 2 seconds and sent as one PUT of the workspace's
// routines (its own only, deleteMissing after a delete), finished runs follow as POSTs (a running one
// isn't sent), an Orgo without the routes (404 or 405) is left alone for 6 hours and then asked again,
// the first sync after start sends every workspace with deleteMissing, and nothing ever throws into a
// routine (Orgo down, signed out, a broken state).
//
// The store and the Orgo client are fakes: Orgo's answers come from a fake fetch below, which records
// every call, so nothing reaches a real Orgo or the user's data.
// Usage: node --conditions=react-server scripts/test-routine-sync.mjs
import assert from "node:assert/strict";
import { registerHooks } from "node:module";
import { pathToFileURL } from "node:url";

const root = new URL("..", import.meta.url).pathname.replace(/\/$/, "");

const FAKES = { store: ["bot", "getState"], orgo: ["apiKey", "callOrgo"] };
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
  load(url, context, next) {
    const name = url.match(/\/lib\/server\/([a-z-]+)\.ts$/)?.[1];
    if (!name || !FAKES[name]) return next(url, context);
    return { format: "module", shortCircuit: true, source: FAKES[name].map((n) => `export const ${n} = (...a) => globalThis.__fake[${JSON.stringify(name)}].${n}(...a);`).join("\n") };
  },
});

let failures = 0;
let passed = 0;
async function check(name, fn) {
  try {
    await fn();
    passed++;
  } catch (e) {
    failures++;
    console.error(`FAIL ${name}\n  ${e.message.split("\n").join("\n  ")}`);
  }
}
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const PID = "11111111-2222-4333-8444-555555555555";
const PID2 = "99999999-2222-4333-8444-555555555555";

const state = {
  owner: { name: "Sam", timeZone: "America/New_York" },
  workspaces: [
    { id: "ws_main", name: "Main", createdAt: 0, orgoProjectId: PID },
    { id: "ws_acme", name: "Acme", createdAt: 0, orgoProjectId: PID2 },
    { id: "ws_local", name: "Local", createdAt: 0 },
  ],
  bots: [
    { id: "bot_main", name: "Boppy", isMain: true },
    { id: "bot_acme", name: "Ace", workspaceId: "ws_acme" },
    { id: "bot_local", name: "Lo", workspaceId: "ws_local" },
  ],
  routines: [],
};

// The fake fetch: what Orgo was asked, and what it answers (by default as orgo-web does: a PUT answers its
// routines with their Orgo ids, a run 201).
const calls = [];
const orgoId = (bopsId) => `00000000-0000-4000-8000-${Buffer.from(bopsId).toString("hex").padStart(12, "0").slice(-12)}`;
const ORGO = (method, path, body) => (method === "PUT" ? { status: 200, json: { routines: body.routines.map((r) => ({ id: orgoId(r.bopsId), bopsId: r.bopsId })) } } : { status: 201, json: {} });
let answer = ORGO;
let key = "sk_test_key";
let broken = false;
const fakeFetch = async (method, path, body) => {
  calls.push({ method, path, body: body === undefined ? undefined : JSON.parse(JSON.stringify(body)) });
  return answer(method, path, body);
};
globalThis.__fake = {
  store: {
    getState: () => {
      if (broken) throw new Error("state isn't ready");
      return state;
    },
    bot: (id) => state.bots.find((b) => b.id === id),
  },
  orgo: {
    apiKey: async () => {
      if (!key) throw new Error("Not signed in to Orgo");
      return key;
    },
    // orgo.ts callOrgo: the status and JSON, or null when Orgo didn't answer.
    callOrgo: async (k, path, init = {}) => {
      assert.equal(k, key, "the signed-in key");
      try {
        return await fakeFetch(init.method ?? "GET", path, init.body);
      } catch {
        return null;
      }
    },
  },
};

const Sync = await import("@/lib/server/routine-sync");
const T = Sync.routineSyncForTests;
const realNow = Date.now;
const reset = () => {
  T.reset();
  calls.length = 0;
  answer = ORGO;
  key = "sk_test_key";
  broken = false;
  Date.now = realNow;
};

const routine = (o) => ({
  id: `rtn_${Math.random().toString(36).slice(2, 8)}`,
  botId: "bot_main",
  title: "Morning inbox",
  goal: "Check my mail.",
  schedule: { kind: "daily", time: "08:00", times: ["08:00", "17:00"] },
  enabled: true,
  nextRunAt: Date.parse("2026-10-14T12:00:00Z"),
  ...o,
});

await check("a workspace without an Orgo project sends nothing", async () => {
  reset();
  state.routines = [routine({ botId: "bot_local" })];
  Sync.routineChanged("bot_local");
  Sync.routineRan(state.routines[0].id, { at: Date.now(), status: "ok" });
  assert.equal(T.pendingCount(), 0);
  await T.flushAll();
  assert.equal(calls.length, 0);
});

await check("debounced: three changes in a second are one PUT, 2 seconds after the last", async () => {
  reset();
  assert.equal(Sync.SYNC_DEBOUNCE_MS, 2000);
  state.routines = [routine({})];
  Sync.routineChanged("bot_main");
  await sleep(500);
  Sync.routineChanged("bot_main");
  await sleep(500);
  Sync.routineChanged("bot_main");
  await sleep(1700);
  assert.equal(calls.length, 0, "not yet: 1.7 s after the last change");
  await sleep(600);
  assert.equal(calls.length, 1, "one call");
  assert.equal(calls[0].method, "PUT");
  assert.equal(calls[0].path, `/api/projects/${PID}/routines`);
  assert.equal(calls[0].body.deleteMissing, undefined, "a change isn't a full sync");
});

await check("the payload: the workspace's own routines, in orgo-web's shape", async () => {
  reset();
  const r1 = routine({
    id: "rtn_a",
    timeZone: "Europe/London",
    quiet: true,
    source: { app: "gmail", template: "gmail-draft-replies" },
    tags: ["Customer"],
    deliverTo: { kind: "channel", linkId: "ch_1", chat: "C1" },
    lastRunAt: Date.parse("2026-10-13T12:00:00Z"),
    last: { at: Date.parse("2026-10-13T12:00:00Z"), status: "quiet" },
    // Fields orgo-web doesn't keep stay home.
    where: "cloud",
    reminder: undefined,
    procedure: "prc_1",
  });
  const r2 = routine({ id: "rtn_b", title: "  ", goal: "x".repeat(9000), schedule: { kind: "before_event", minutes: 30, source: "googlecalendar" }, enabled: false, nextRunAt: undefined });
  const other = routine({ id: "rtn_acme", botId: "bot_acme" });
  state.routines = [r1, r2, other];
  Sync.routineChanged("bot_main");
  await T.flushAll();
  assert.equal(calls.length, 1, "only Main's project");
  const body = calls[0].body;
  assert.deepEqual(
    body.routines.map((r) => r.bopsId),
    ["rtn_a", "rtn_b"],
  );
  assert.deepEqual(body.routines[0], {
    bopsId: "rtn_a",
    botId: "bot_main",
    kind: "monitor",
    title: "Morning inbox",
    goal: "Check my mail.",
    enabled: true,
    quiet: true,
    schedule: { kind: "daily", time: "08:00", times: ["08:00", "17:00"] },
    timeZone: "Europe/London",
    source: { app: "gmail", template: "gmail-draft-replies" },
    tags: ["Customer"],
    delivery: { kind: "channel", linkId: "ch_1", chat: "C1" },
    nextRunAt: "2026-10-14T12:00:00.000Z",
    lastRunAt: "2026-10-13T12:00:00.000Z",
    lastStatus: "ok",
  });
  const b = body.routines[1];
  assert.equal(b.kind, "schedule");
  assert.equal(b.title, "x".repeat(200), "a blank title takes the goal, cut to 200");
  assert.equal(b.goal.length, 8000, "the goal cut to 8000");
  assert.equal(b.enabled, false);
  assert.equal(b.quiet, false);
  assert.deepEqual(b.schedule, { kind: "before_event", minutes: 30, source: "googlecalendar" });
  for (const k of ["nextRunAt", "timeZone", "delivery", "source", "tags", "lastStatus"]) assert.ok(!(k in b), `no ${k}`);
});

await check("a delete sends deleteMissing; each workspace goes to its own project", async () => {
  reset();
  state.routines = [routine({ id: "rtn_left" }), routine({ id: "rtn_acme", botId: "bot_acme" })];
  Sync.routineChanged("bot_main");
  Sync.routineChanged("bot_main", { deleted: true });
  Sync.routineChanged("bot_acme");
  await T.flushAll();
  const main = calls.find((c) => c.path === `/api/projects/${PID}/routines`);
  const acme = calls.find((c) => c.path === `/api/projects/${PID2}/routines`);
  assert.equal(main.body.deleteMissing, true);
  assert.deepEqual(main.body.routines.map((r) => r.bopsId), ["rtn_left"]);
  assert.equal(acme.body.deleteMissing, undefined);
  assert.deepEqual(acme.body.routines.map((r) => r.bopsId), ["rtn_acme"]);
});

await check("runs: a finished one is POSTed after the PUT; running isn't sent; quiet is ok; a failure carries its error", async () => {
  reset();
  const r = routine({ id: "rtn_run" });
  state.routines = [r];
  const at = Date.now() - 4200;
  Sync.routineRan(r.id, { at, status: "running" });
  assert.equal(T.pendingCount(), 0, "running: nothing yet");
  Sync.routineRan(r.id, { at, status: "ok", sessionId: "ses_1" });
  Sync.routineRan(r.id, { at: at + 1, status: "quiet" });
  Sync.routineRan(r.id, { at: at + 2, status: "failed", error: `Gmail isn't connected. ${"x".repeat(3000)}` });
  Sync.routineRan(r.id, { at: at + 3, status: "skipped", error: "The last run was still going." });
  await T.flushAll();
  assert.deepEqual(
    calls.map((c) => `${c.method} ${c.path}`),
    [`PUT /api/projects/${PID}/routines`, ...Array(4).fill(`POST /api/projects/${PID}/routines/${orgoId("rtn_run")}/runs`)],
  );
  const [ok, quiet, failed, skipped] = calls.slice(1).map((c) => c.body);
  assert.equal(ok.status, "ok");
  assert.equal(ok.startedAt, new Date(at).toISOString());
  assert.ok(ok.ms >= 4000 && ok.ms < 10_000, `ms ${ok.ms}`);
  assert.ok(Date.parse(ok.finishedAt) >= Date.parse(ok.startedAt));
  assert.deepEqual(Object.keys(ok).sort(), ["finishedAt", "ms", "startedAt", "status"]);
  assert.equal(quiet.status, "ok");
  assert.equal(quiet.summary, "Nothing needed the user.");
  assert.equal(failed.status, "failed");
  assert.equal(failed.error.length, 2000);
  assert.ok(failed.error.startsWith("Gmail isn't connected."));
  assert.equal(skipped.status, "skipped");
  assert.equal(skipped.error, "The last run was still going.");
});

await check("the schedule goes as kept now; one that isn't a schedule stays home; a run of a routine Orgo hasn't isn't sent", async () => {
  reset();
  state.routines = [
    routine({ id: "rtn_long", schedule: { kind: "every", minutes: 2880 } }),
    routine({ id: "rtn_bad", schedule: { kind: "daily", time: "nope" } }),
    routine({ id: "rtn_old", schedule: { kind: "weekly", day: 1, time: "9:00" } }),
  ];
  Sync.routineChanged("bot_main");
  Sync.routineRan("rtn_bad", { at: Date.now(), status: "ok" });
  Sync.routineRan("rtn_long", { at: Date.now(), status: "ok" });
  await T.flushAll();
  const sent = calls[0].body.routines;
  assert.deepEqual(sent.map((r) => r.bopsId), ["rtn_long", "rtn_old"]);
  assert.deepEqual(sent[0].schedule, { kind: "every", minutes: 1440 }, "a day at most");
  assert.deepEqual(sent[1].schedule, { kind: "weekly", day: 1, time: "09:00" });
  assert.deepEqual(calls.slice(1).map((c) => c.path), [`/api/projects/${PID}/routines/${orgoId("rtn_long")}/runs`], "only the run Orgo has a routine for");
  // An answer without ids (an older orgo-web): the routines went, the runs wait for one that has them.
  reset();
  state.routines = [routine({ id: "rtn_q" })];
  answer = (m) => (m === "PUT" ? { status: 200, json: { ok: true } } : { status: 201, json: {} });
  Sync.routineRan("rtn_q", { at: Date.now(), status: "ok" });
  await T.flushAll();
  assert.deepEqual(calls.map((c) => c.method), ["PUT"]);
});

await check("an Orgo without the routes (404, 405): left alone for 6 hours, then asked again; a 500 isn't that", async () => {
  for (const status of [404, 405]) {
    reset();
    state.routines = [routine({ id: "rtn_x" })];
    answer = () => ({ status, json: { error: "Not found" } });
    Sync.routineChanged("bot_main");
    Sync.routineRan("rtn_x", { at: Date.now(), status: "ok" });
    await T.flushAll();
    assert.equal(calls.length, 1, `${status}: the PUT, and no run after it`);
    // Within 6 hours: nothing is even queued.
    Sync.routineChanged("bot_main");
    Sync.routineRan("rtn_x", { at: Date.now(), status: "ok" });
    Sync.syncRoutinesOnStart();
    assert.equal(T.pendingCount(), 1, "only the other workspace's start sync");
    await T.flushAll();
    assert.ok(!calls.slice(1).some((c) => c.path.startsWith(`/api/projects/${PID}/`)), "Main's project left alone");
    // 6 hours on: asked again, and it has the routes now.
    const start = realNow();
    Date.now = () => start + Sync.MISSING_RETRY_MS + 1000;
    answer = ORGO;
    calls.length = 0;
    Sync.routineChanged("bot_main");
    await T.flushAll();
    assert.equal(calls.length, 1, `${status}: asked again after 6 hours`);
    assert.equal(calls[0].path, `/api/projects/${PID}/routines`);
  }
  reset();
  state.routines = [routine({ id: "rtn_y" })];
  answer = () => ({ status: 500, json: {} });
  const warn = console.warn;
  console.warn = () => {};
  try {
    Sync.routineChanged("bot_main");
    await T.flushAll();
    Sync.routineChanged("bot_main");
    assert.equal(T.pendingCount(), 1, "a 500 is tried again next change");
  } finally {
    console.warn = warn;
  }
});

await check("on start: every workspace with a project, deleteMissing, once", async () => {
  reset();
  state.routines = [routine({ id: "rtn_m" }), routine({ id: "rtn_a", botId: "bot_acme" }), routine({ id: "rtn_l", botId: "bot_local" })];
  Sync.syncRoutinesOnStart();
  Sync.syncRoutinesOnStart();
  await T.flushAll();
  assert.deepEqual(calls.map((c) => c.path).sort(), [`/api/projects/${PID}/routines`, `/api/projects/${PID2}/routines`].sort());
  for (const c of calls) assert.equal(c.body.deleteMissing, true);
  assert.deepEqual(calls.find((c) => c.path.includes(PID2)).body.routines.map((r) => r.bopsId), ["rtn_a"]);
  calls.length = 0;
  Sync.syncRoutinesOnStart();
  await T.flushAll();
  assert.equal(calls.length, 0, "once per run of the app");
});

await check("never in the way: Orgo down, signed out, a broken state, a fetch that throws", async () => {
  reset();
  state.routines = [routine({ id: "rtn_z" })];
  answer = () => {
    throw new Error("ECONNREFUSED");
  };
  Sync.routineChanged("bot_main");
  Sync.routineRan("rtn_z", { at: Date.now(), status: "ok" });
  await T.flushAll();
  assert.equal(calls.length, 1, "tried once, quietly");
  reset();
  key = "";
  Sync.routineChanged("bot_main");
  await T.flushAll();
  assert.equal(calls.length, 0, "signed out: nothing sent");
  reset();
  broken = true;
  const warn = console.warn;
  let warned = 0;
  console.warn = () => warned++;
  try {
    assert.doesNotThrow(() => Sync.routineChanged("bot_main"));
    assert.doesNotThrow(() => Sync.routineRan("rtn_z", { at: Date.now(), status: "ok" }));
    assert.doesNotThrow(() => Sync.syncRoutinesOnStart());
    assert.ok(warned >= 3, "said in the log");
  } finally {
    console.warn = warn;
  }
  reset();
});

await check("text Postgres can store: no NUL, no half an emoji, cut by code point; statuses in Orgo's words; a meeting routine's cursor", async () => {
  reset();
  const emoji = "\u{1F600}";
  assert.equal(Sync.cleanText(`${"a".repeat(39)}${emoji}`, 40), `${"a".repeat(39)}${emoji}`, "an emoji across the cut stays whole");
  assert.equal(Sync.cleanText(`${"a".repeat(40)}${emoji}`, 40), "a".repeat(40));
  assert.equal(Sync.cleanText("a\u0000b\uD83Dc\uDE00d", 10), "abcd", "NUL and lone halves go");
  state.routines = [
    routine({ id: "rtn_t", title: `${"t".repeat(199)}${emoji}`, goal: `From an email\u0000 ${"g".repeat(7990)}${emoji}`, tags: ["\uD83D"], last: { at: Date.parse("2026-10-13T12:00:00Z"), status: "running" }, lastRunAt: Date.parse("2026-10-13T11:59:59Z") }),
    routine({ id: "rtn_e", schedule: { kind: "before_event", minutes: 30, source: "googlecalendar" }, eventsThrough: Date.parse("2026-10-13T13:00:00Z") }),
    routine({ id: "rtn_d", eventsThrough: Date.parse("2026-10-13T13:00:00Z") }),
  ];
  Sync.routineChanged("bot_main");
  await T.flushAll();
  const [t, e, d] = calls[0].body.routines;
  for (const x of [t.title, t.goal]) {
    assert.ok(!/\u0000/.test(x), "no NUL");
    assert.ok(!/[\uD800-\uDBFF](?![\uDC00-\uDFFF])/.test(x), "no lone half");
  }
  assert.ok(Array.from(t.title).length <= 200 && Array.from(t.goal).length <= 8000);
  assert.ok(!("tags" in t), "a tag that was only half an emoji goes");
  assert.equal(t.lastStatus, "waiting", "running is waiting");
  assert.equal(t.lastRunAt, "2026-10-13T12:00:00.000Z", "the last run's start, as its run POST says");
  assert.equal(e.eventsThrough, "2026-10-13T13:00:00.000Z");
  assert.ok(!("eventsThrough" in d), "only a meeting routine's");
});

await check("a batch Orgo didn't take (down, 5xx) goes again with its deleteMissing and runs; a 400 doesn't", async () => {
  reset();
  assert.equal(Sync.RETRY_MS, 60_000);
  state.routines = [routine({ id: "rtn_r" })];
  answer = () => ({ status: 503, json: {} });
  const warn = console.warn;
  console.warn = () => {};
  try {
    Sync.routineChanged("bot_main", { deleted: true });
    Sync.routineRan("rtn_r", { at: Date.now(), status: "ok" });
    await T.flushAll();
    assert.equal(T.pendingCount(), 1, "back in the queue");
    answer = ORGO;
    calls.length = 0;
    await T.flushAll();
    assert.equal(calls[0].body.deleteMissing, true, "the delete still goes");
    assert.deepEqual(calls.map((c) => c.method), ["PUT", "POST"], "and the run");
    assert.equal(T.pendingCount(), 0);
    reset();
    state.routines = [routine({ id: "rtn_r" })];
    answer = () => ({ status: 400, json: {} });
    Sync.routineChanged("bot_main");
    await T.flushAll();
    assert.equal(T.pendingCount(), 0, "a refusal isn't sent again as it is");
  } finally {
    console.warn = warn;
  }
});

await check("one flush per workspace at a time: a change during a slow PUT goes after it, newer", async () => {
  reset();
  state.routines = [routine({ id: "rtn_s0" })];
  let release;
  const gate = new Promise((r) => (release = r));
  answer = async (m, path, body) => {
    if (body?.deleteMissing) await gate;
    return ORGO(m, path, body);
  };
  Sync.syncRoutinesOnStart();
  const first = T.start("ws_main");
  await sleep(10);
  state.routines = [...state.routines, routine({ id: "rtn_new" })];
  Sync.routineChanged("bot_main");
  const second = T.start("ws_main");
  await sleep(10);
  assert.equal(calls.filter((c) => c.path === `/api/projects/${PID}/routines`).length, 1, "the second waits for the first");
  release();
  await first;
  await second;
  await T.flushAll();
  const puts = calls.filter((c) => c.path === `/api/projects/${PID}/routines`);
  assert.equal(puts.length, 2);
  assert.equal(puts[0].body.deleteMissing, true);
  assert.deepEqual(puts[1].body.routines.map((r) => r.bopsId), ["rtn_s0", "rtn_new"], "the newer state goes last");
});

await check("more than 500 routines: the first 500 go, without deleteMissing; ones that can't go don't count", async () => {
  reset();
  const warn = console.warn;
  console.warn = () => {};
  try {
    state.routines = [routine({ id: "rtn_bad0", schedule: { kind: "daily", time: "nope" } }), ...Array.from({ length: 500 }, (_, i) => routine({ id: `rtn_${i}` }))];
    Sync.routineChanged("bot_main", { deleted: true });
    await T.flushAll();
    assert.equal(calls[0].body.routines.length, 500);
    assert.equal(calls[0].body.deleteMissing, true, "500 that can go: a full sync");
    reset();
    state.routines = Array.from({ length: 501 }, (_, i) => routine({ id: `rtn_${i}` }));
    Sync.routineChanged("bot_main", { deleted: true });
    await T.flushAll();
    assert.equal(calls[0].body.routines.length, 500);
    assert.equal(calls[0].body.deleteMissing, undefined, "never deletes the ones past 500");
  } finally {
    console.warn = warn;
  }
});

await check("a deleted bot's routines: its workspace goes with deleteMissing", async () => {
  reset();
  state.routines = [routine({ id: "rtn_stay", botId: "bot_acme" })];
  Sync.routinesRemovedInWorkspace("ws_acme");
  Sync.routinesRemovedInWorkspace("ws_local");
  await T.flushAll();
  assert.equal(calls.length, 1);
  assert.equal(calls[0].path, `/api/projects/${PID2}/routines`);
  assert.equal(calls[0].body.deleteMissing, true);
});

console.log(`routine sync: ${passed} passed, ${failures} failed`);
process.exit(failures ? 1 : 0);
