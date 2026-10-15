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
    lastStatus: "quiet",
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

console.log(`routine sync: ${passed} passed, ${failures} failed`);
process.exit(failures ? 1 : 0);
