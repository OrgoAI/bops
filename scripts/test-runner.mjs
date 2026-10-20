// Tests for which Bops runs each routine (lib/server/runner.ts): what needs the Mac (pinnedToMac), the
// split between the Mac and a computer's runner (runsHere: a runner's own routines while it's up, the
// Mac's the rest, the hand-over after a switch to This Mac), where the bots work as Orgo says (the Mac
// sets the default, Cloud, once, and goes by it only once Orgo took it; a runner never sets it and runs
// nothing on an answer a minute old, or from before a nap), the routines timer (routines.ts tick: each
// Bops its own, a runner only once it's read the state and Orgo again, none once a newer Bops wrote the
// state), making sure it's on its own computer (checkIdentity: a copy of the computer takes its runner
// off, its program and wrapper only, never the computer's Orgo key, which Orgo replaces) and the routines mirror (routine-sync.ts: how each runs and whether it needs the Mac; a runner
// sends only its own, never with deleteMissing).
//
// The store, Orgo, the nap detector and the modules a run talks to are fakes (below), so nothing reaches a
// real service or the user's data.
// Usage: node --conditions=react-server scripts/test-runner.mjs
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { registerHooks } from "node:module";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { pathToFileURL } from "node:url";

process.env.TZ = "America/New_York";
for (const k of Object.keys(process.env)) if (/^(BOPS|ORGO)_/.test(k)) delete process.env[k];
const root = new URL("..", import.meta.url).pathname.replace(/\/$/, "");

const FAKES = {
  store: ["addMessage", "bot", "getState", "id", "ownerName", "patchSession", "pullState", "session", "statePulledAt", "stateReady", "stateTooNew", "update"],
  orgo: ["apiKey", "callOrgo", "orgo"],
  awake: ["sleptSince"],
  sessions: ["startSession"],
  analytics: ["trackServerEvent"],
  attention: ["pingIfWorthIt"],
  phone: ["isOwner", "ownerPhone", "sendText", "textingLine"],
  mail: ["ownerAddresses", "sendEmail"],
  channels: ["postTo"],
  chat: ["backgroundTurn"],
  "workspace-skills": ["findSkill", "skillRefId"],
};
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
    // `orgo` is an object of calls (orgo.bash): each goes to the fake's of the same name.
    const one = (n) =>
      n === "orgo"
        ? `export const orgo = new Proxy({}, { get: (_, k) => (...a) => globalThis.__fake[${JSON.stringify(name)}].orgo[k](...a) });`
        : `export const ${n} = (...a) => globalThis.__fake[${JSON.stringify(name)}].${n}(...a);`;
    return { format: "module", shortCircuit: true, source: FAKES[name].map(one).join("\n") };
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
const DASHES = /[‒–—―]| - /;

const PID = "11111111-2222-4333-8444-555555555555";
const PID2 = "99999999-2222-4333-8444-555555555555";
const C1 = "c1c1c1c1-0000-4000-8000-000000000001";
const C2 = "c2c2c2c2-0000-4000-8000-000000000002";
const NOW = Date.now();
const up = (status, o = {}) => ({ status, version: "0.0.29", buildId: "b1", by: "mac-a", at: NOW, ...o });

let seq = 0;
const state = {};
/** A fresh state: Boppy (main) on C1 with Otto sharing it, Rook on C2 of its own, Penny set to work on the Mac, Nova (another workspace's main) with no computer yet; C1 has a runner up. */
function fresh() {
  for (const k of Object.keys(state)) delete state[k];
  Object.assign(state, {
    account: { user: { id: "u1" }, signedInAt: 0 },
    owner: { name: "Sam", timeZone: "America/New_York" },
    workspaces: [
      { id: "ws_main", name: "Main", createdAt: 0, orgoProjectId: PID },
      { id: "ws_two", name: "Two", createdAt: 0, orgoProjectId: PID2 },
    ],
    bots: [
      { id: "boppy", name: "Boppy", isMain: true, computerId: C1, computerStatus: "ready" },
      { id: "otto", name: "Otto", isMain: false, computer: "shared", computerStatus: "none" },
      { id: "rook", name: "Rook", isMain: false, computer: "own", computerId: C2, computerStatus: "ready" },
      { id: "penny", name: "Penny", isMain: false, computer: "shared", runsOn: "mac", computerStatus: "none" },
      { id: "nova", name: "Nova", isMain: true, workspaceId: "ws_two", computerStatus: "none" },
    ],
    routines: [],
    sessions: [],
    messages: [],
    runners: { [C1]: up("running") },
  });
}
const routine = (id, botId, o = {}) => ({ id, botId, title: id, goal: "Check the news", schedule: { kind: "daily", time: "09:00" }, enabled: true, nextRunAt: NOW + 3_600_000, ...o });

let pulledAt = 0;
let napped = false;
let tooNew = false;
const fake = { started: [], pulls: 0 };
// Orgo, faked: every call is kept, and `orgo.answer` says what it answers (null: no answer). A command
// on a computer reads back the runner's word from `nonceDir` when it's the computer `orgo.here` (the
// one this runner is really on), and says nothing from any other.
const nonceDir = mkdtempSync(join(tmpdir(), "bops-runner-nonce-"));
const orgo = { calls: [], answer: () => null, here: null, bash: [] };
globalThis.__fake = {
  store: {
    getState: () => state,
    update: (fn) => fn(state),
    addMessage: (m) => {
      const msg = { id: `msg_${++seq}`, at: Date.now(), ...m };
      state.messages.push(msg);
      return msg;
    },
    bot: (id) => state.bots.find((b) => b.id === id),
    id: (p) => `${p}_${++seq}`,
    ownerName: () => "Sam",
    patchSession: () => {},
    session: (id) => state.sessions.find((x) => x.id === id),
    stateReady: () => true,
    stateTooNew: () => tooNew,
    pullState: async () => {
      fake.pulls++;
      pulledAt = Date.now();
    },
    statePulledAt: () => pulledAt,
  },
  orgo: {
    apiKey: async () => "sk_test",
    callOrgo: async (key, path, init = {}) => {
      const c = { method: init.method ?? "GET", path, body: init.body === undefined ? undefined : JSON.parse(JSON.stringify(init.body)) };
      orgo.calls.push(c);
      if (path.endsWith("/routines")) return { status: 200, json: { routines: init.body.routines.map((r) => ({ id: `orgo-${r.bopsId}`, bopsId: r.bopsId })) } };
      return orgo.answer(c);
    },
    orgo: {
      bash: async (computer, command) => {
        orgo.bash.push({ computer, command });
        if (orgo.here === "down") throw new Error("Orgo didn't answer");
        // The guest's own time limit: Orgo answers 200 with what it said.
        if (orgo.here === "slow") return { output: "Command timed out after 20s", exit_code: 124 };
        let word = "";
        try {
          word = computer === (orgo.here ?? process.env.BOPS_RUNNER_COMPUTER) ? readFileSync(join(nonceDir, "nonce"), "utf8") : "";
        } catch {}
        return { output: `${word}\n${command.includes("echo __BOPS_NONCE_END__") ? "\n__BOPS_NONCE_END__\n" : ""}`, exit_code: 0 };
      },
    },
  },
  awake: { sleptSince: () => napped },
  sessions: {
    startSession: (o) => {
      fake.started.push(o);
      const s = { id: `ses_${++seq}`, botId: o.botId, chatId: o.chatId, title: o.title, goal: o.goal, status: "running", routineId: o.routineId };
      state.sessions.push(s);
      return s;
    },
  },
  analytics: { trackServerEvent: () => {} },
  attention: { pingIfWorthIt: () => {} },
  phone: { isOwner: () => false, ownerPhone: () => undefined, sendText: async () => {}, textingLine: () => undefined },
  mail: { ownerAddresses: () => [], sendEmail: async () => "" },
  channels: { postTo: async () => {} },
  chat: { backgroundTurn: async () => ({ text: "" }) },
  "workspace-skills": { findSkill: () => undefined, skillRefId: (r) => r.slug },
};

const R = await import(`${root}/lib/server/runner.ts`);
const Sync = await import(`${root}/lib/server/routine-sync.ts`);
await import(`${root}/lib/server/routines.ts`);
const tick = () => globalThis.__bopsRoutineTick();
const T = Sync.routineSyncForTests;

const asMac = () => {
  delete process.env.BOPS_RUNNER;
  delete process.env.BOPS_RUNNER_COMPUTER;
};
const asRunner = (computer = C1) => {
  process.env.BOPS_RUNNER = "1";
  process.env.BOPS_RUNNER_COMPUTER = computer;
};
let left = 0;
function reset() {
  asMac();
  fresh();
  R.runnerForTests.reset();
  // What a copy takes off, in a folder of the test's (never the real paths).
  R.runnerForTests.identity({ nonceDir, leave: () => void left++, copyFiles: [join(nonceDir, "bops-runner.conf"), join(nonceDir, "run.sh")] });
  left = 0;
  orgo.here = null;
  orgo.bash.length = 0;
  T.reset();
  orgo.calls.length = 0;
  orgo.answer = () => null;
  pulledAt = 0;
  napped = false;
  tooNew = false;
  fake.started.length = 0;
  fake.pulls = 0;
}
const byId = (id) => state.routines.find((r) => r.id === id);
const here = (id) => R.runsHere(byId(id));

/* ---------------- What needs the Mac ---------------- */

await check("pinnedToMac: set to the Mac, or left to Bops with a bot on the Mac or Mac words; never a reminder or a chat run", () => {
  const pin = (r, b = {}) => R.pinnedToMac({ goal: "Check the news", ...r }, b);
  assert.equal(pin({ where: "mac" }), true, "set to the Mac");
  assert.equal(pin({}), false, "left to Bops, nothing about the Mac");
  assert.equal(pin({ where: "auto" }, { runsOn: "mac" }), true, "its bot works on the Mac");
  assert.equal(pin({}, { runsOn: "cloud" }), false);
  assert.equal(pin({ goal: "Tidy the Downloads folder on my Mac" }), true, "Mac words");
  assert.equal(pin({ goal: "Back up my photos locally" }), true);
  assert.equal(pin({ where: "cloud", goal: "Tidy the files on my Mac" }, { runsOn: "mac" }), false, "set to the cloud: the cloud, whatever the bot or the words");
  assert.equal(pin({ where: "mac", reminder: "Stretch" }), false, "a reminder uses no computer");
  assert.equal(pin({ where: "mac", run: "chat" }, { runsOn: "mac" }), false, "a chat run uses no computer");
  assert.equal(pin({ where: "mac" }, undefined), true, "its bot gone: as the routine says");
});

/* ---------------- The split, on the Mac ---------------- */

function seedRoutines() {
  state.routines = [
    routine("r_boppy", "boppy"),
    routine("r_boppy_mac", "boppy", { where: "mac" }),
    routine("r_boppy_words", "boppy", { goal: "Clean up the desktop on my Mac" }),
    routine("r_otto_reminder", "otto", { reminder: "Stand up" }),
    routine("r_otto_chat", "otto", { run: "chat" }),
    routine("r_rook", "rook"),
    routine("r_penny", "penny"),
    routine("r_nova", "nova"),
  ];
}

await check("the Mac leaves a computer's routines to its runner while it's up, and runs the rest", () => {
  reset();
  seedRoutines();
  assert.equal(here("r_boppy"), false, "C1's runner is up");
  assert.equal(here("r_otto_reminder"), false, "a bot sharing C1: its runner's, reminders too");
  assert.equal(here("r_otto_chat"), false, "and chat runs");
  assert.equal(here("r_boppy_mac"), true, "set to the Mac");
  assert.equal(here("r_boppy_words"), true, "Mac words");
  assert.equal(here("r_penny"), true, "its bot works on the Mac");
  assert.equal(here("r_rook"), true, "C2 has no runner");
  assert.equal(here("r_nova"), true, "no computer yet");
  assert.equal(R.runsHere(routine("r_gone", "nobody")), true, "its bot gone: the Mac says so when it comes due");
  for (const status of ["installing", "failed"]) {
    R.runnerForTests.seen("r_boppy");
    state.runners[C1] = up(status);
    assert.equal(here("r_boppy"), true, `a runner ${status} the Mac never saw up: the Mac's`);
  }
  state.runners[C1] = up("stopping", { at: Date.now() - 10_000 });
  assert.equal(here("r_boppy"), false, "being stopped, not confirmed: still the runner's");
  state.runners[C1] = up("stopping", { at: Date.now() - R.HANDOVER_MS - 1000 });
  R.runnerForTests.seen("r_boppy", R.HANDOVER_MS + 1000);
  assert.equal(here("r_boppy"), true, "not confirmed after the hand-over time: the Mac's");
  delete state.runners[C1];
  assert.equal(here("r_boppy"), true, "stopped (no runner): the Mac's");
});

await check("a routine that leaves a runner waits the hand-over time on the Mac, while that runner hears of it", () => {
  reset();
  seedRoutines();
  const moves = [
    ["the runner set up again", () => (state.runners[C1] = up("installing"))],
    ["the runner couldn't start", () => (state.runners[C1] = up("failed", { error: "it didn't answer on its computer" }))],
    ["its bot moved to a computer with no runner", () => Object.assign(state.bots[0], { computerId: C2 })],
    ["the routine set to run on the Mac", () => (byId("r_boppy").where = "mac")],
    ["its bot set to work on the Mac", () => (state.bots[0].runsOn = "mac")],
  ];
  for (const [what, move] of moves) {
    reset();
    seedRoutines();
    assert.equal(here("r_boppy"), false, "the runner's, as the Mac last saw it");
    move();
    assert.equal(here("r_boppy"), false, `${what}: not the Mac's at once`);
    R.runnerForTests.seen("r_boppy", R.HANDOVER_MS + 1000);
    assert.equal(here("r_boppy"), true, `${what}: the Mac's after the hand-over time`);
  }
  // Never with a runner (as this Mac saw it): the Mac's at once.
  reset();
  seedRoutines();
  assert.equal(here("r_rook"), true);
});

await check("a routine due on both sides during a hand-over runs on one: the Mac waits, the runner on its last copy runs it", async () => {
  reset();
  seedRoutines();
  // As the Mac sees it: C1's runner up, then being set up again (an upgrade that marks it so) as the routine comes due.
  assert.equal(here("r_boppy"), false);
  state.runners[C1] = up("installing");
  byId("r_boppy").nextRunAt = Date.now() - 1000;
  tick();
  assert.ok(!fake.started.some((x) => x.routineId === "r_boppy"), "the Mac leaves it to the runner, which hasn't heard");
  assert.ok(byId("r_boppy").nextRunAt < Date.now(), "not advanced here");
  T.reset();
});

await check("on a runner, a routine that comes from another computer's runner waits the hand-over time", () => {
  reset();
  seedRoutines();
  asRunner(C2);
  state.runners[C2] = up("running");
  R.runnerForTests.hear("u1", "cloud");
  assert.equal(here("r_rook"), true, "its own from the start");
  // Boppy moves from C1 (its runner up) to C2.
  R.runnerHasWork();
  state.bots[0].computerId = C2;
  assert.equal(here("r_boppy"), false, "just came here: C1's runner may not have heard");
  R.runnerForTests.seen("r_boppy", R.HANDOVER_MS + 1000);
  assert.equal(here("r_boppy"), true, "after the hand-over time: this runner's");
});

await check("after a switch to This Mac the Mac waits for the runner's stop, at most the hand-over time", () => {
  reset();
  seedRoutines();
  R.runnerForTests.hear("u1", "cloud");
  assert.equal(here("r_boppy"), false, "Cloud: the runner's");
  R.runnerForTests.hear("u1", "mac");
  assert.equal(R.runsOn(), "mac");
  assert.equal(here("r_boppy"), false, "just switched, its stop not confirmed: still the runner's");
  assert.equal(here("r_rook"), true);
  R.runnerForTests.hear("u1", "mac", { macAgo: R.HANDOVER_MS + 1000 });
  R.runnerForTests.seen("r_boppy", R.HANDOVER_MS + 1000);
  assert.equal(here("r_boppy"), true, "after the hand-over time: the Mac's");
  R.runnerForTests.hear("u1", "mac", { macAgo: 5_000 });
  assert.equal(here("r_boppy"), false);
  delete state.runners[C1];
  assert.equal(here("r_boppy"), true, "its stop confirmed (the runner's gone): the Mac's at once");
});

await check("what Orgo said is the signed-in user's only", () => {
  reset();
  seedRoutines();
  R.runnerForTests.hear("u1", "mac", { macAgo: R.HANDOVER_MS + 1000 });
  assert.equal(here("r_boppy"), true);
  state.account = { user: { id: "u2" }, signedInAt: 0 };
  assert.equal(R.runsOn(), "mac", "nothing heard for them: the Mac");
  assert.equal(here("r_boppy"), false, "and until Orgo answers, a runner that's up keeps its routines");
});

/* ---------------- The split, on a runner ---------------- */

await check("a runner runs its own computer's routines while the bots work in the Cloud and it's marked up", () => {
  reset();
  seedRoutines();
  asRunner(C1);
  assert.equal(here("r_boppy"), false, "nothing heard from Orgo: nothing");
  R.runnerForTests.hear("u1", "cloud");
  assert.equal(here("r_boppy"), true);
  assert.equal(here("r_otto_reminder"), true, "a bot sharing its computer");
  assert.equal(here("r_otto_chat"), true);
  assert.equal(here("r_boppy_mac"), false, "set to the Mac");
  assert.equal(here("r_boppy_words"), false, "Mac words");
  assert.equal(here("r_penny"), false, "a bot that works on the Mac");
  assert.equal(here("r_rook"), false, "another computer's");
  assert.equal(here("r_nova"), false, "no computer");
  state.runners[C1] = up("installing");
  assert.equal(here("r_boppy"), false, "not marked up yet: the Mac still has them");
  state.runners[C1] = up("stopping");
  assert.equal(here("r_boppy"), false, "being stopped");
  state.runners[C1] = up("running");
  R.runnerForTests.hear("u1", "mac");
  assert.equal(here("r_boppy"), false, "the bots work on This Mac");
  R.runnerForTests.hear("u1", "cloud", { ago: 61_000 });
  assert.equal(here("r_boppy"), false, "Orgo's word over a minute old");
  R.runnerForTests.hear("u1", "cloud");
  napped = true;
  assert.equal(here("r_boppy"), false, "its computer slept since");
  napped = false;
  asRunner(C2);
  state.runners[C2] = up("running");
  assert.equal(here("r_rook"), true, "C2's runner: Rook's");
  assert.equal(here("r_boppy"), false);
});

/* ---------------- Where the bots work, as Orgo says ---------------- */

await check("the Mac sets the default, Cloud, once, and goes by it only once Orgo took it", async () => {
  reset();
  orgo.answer = (c) => (c.method === "GET" ? { status: 200, json: { runsOn: null } } : { status: 200, json: { runsOn: "cloud" } });
  assert.equal(R.runsOn(), "mac", "never heard: the Mac");
  await R.askRunsOn();
  assert.deepEqual(orgo.calls.map((c) => `${c.method} ${c.path}`), ["GET /api/bops/settings", "PUT /api/bops/settings"]);
  assert.deepEqual(orgo.calls[1].body, { runsOn: "cloud" });
  assert.equal(R.runsOn(), "cloud");
  // Refused: the Mac until it's set, and not asked again.
  reset();
  orgo.answer = (c) => (c.method === "GET" ? { status: 200, json: { runsOn: null } } : { status: 403, json: {} });
  await R.askRunsOn();
  assert.equal(R.runsOn(), "mac");
  orgo.calls.length = 0;
  await R.askRunsOn();
  assert.deepEqual(orgo.calls.map((c) => c.method), ["GET"], "set once: not again");
  // No answer to the PUT: tried again next time.
  reset();
  let putAnswer = null;
  orgo.answer = (c) => (c.method === "GET" ? { status: 200, json: { runsOn: null } } : putAnswer);
  await R.askRunsOn();
  assert.equal(R.runsOn(), "mac");
  putAnswer = { status: 200, json: {} };
  await R.askRunsOn();
  assert.equal(R.runsOn(), "cloud");
  assert.deepEqual(orgo.calls.map((c) => c.method), ["GET", "PUT", "GET", "PUT"]);
});

await check("Orgo's answers: the user's pick, an Orgo without the setting, no answer", async () => {
  reset();
  orgo.answer = () => ({ status: 200, json: { runsOn: "mac" } });
  await R.askRunsOn();
  assert.equal(R.runsOn(), "mac");
  assert.equal(orgo.calls.length, 1, "set: never set again");
  orgo.answer = () => ({ status: 200, json: { runsOn: "cloud" } });
  await R.askRunsOn();
  assert.equal(R.runsOn(), "cloud");
  orgo.answer = () => null;
  await R.askRunsOn();
  assert.equal(R.runsOn(), "cloud", "the Mac keeps what it heard last");
  reset();
  orgo.answer = () => ({ status: 404, json: {} });
  await R.askRunsOn();
  assert.equal(R.runsOn(), "mac");
  assert.equal(R.runsOnMissing(), true);
  orgo.calls.length = 0;
  await R.askRunsOn();
  assert.equal(orgo.calls.length, 0, "an Orgo without the setting isn't asked again for a while");
});

await check("a runner never sets it, and runs nothing on what it didn't hear", async () => {
  reset();
  seedRoutines();
  asRunner(C1);
  orgo.answer = () => ({ status: 200, json: { runsOn: null } });
  await R.askRunsOn();
  assert.deepEqual(orgo.calls.map((c) => c.method), ["GET"], "no PUT from a runner");
  assert.equal(R.runsOn(), "mac");
  assert.equal(here("r_boppy"), false);
  orgo.answer = () => null;
  await R.askRunsOn();
  assert.equal(here("r_boppy"), false, "no answer: still nothing");
  assert.deepEqual(await R.setRunsOn("cloud"), { error: "Sign in to Bops first." }, "a runner never writes it");
});

await check("Settings: where the bots work from now on", async () => {
  reset();
  orgo.answer = () => ({ status: 200, json: { runsOn: "mac" } });
  assert.deepEqual(await R.setRunsOn("mac"), {});
  assert.deepEqual(orgo.calls.at(-1), { method: "PUT", path: "/api/bops/settings", body: { runsOn: "mac" } });
  assert.equal(R.runsOn(), "mac");
  orgo.answer = () => ({ status: 405, json: {} });
  const missing = await R.setRunsOn("cloud");
  assert.deepEqual(missing, { error: "Cloud isn't available yet.", missing: true });
  orgo.answer = () => null;
  const off = await R.setRunsOn("cloud");
  assert.match(off.error, /Couldn't reach Orgo/);
  for (const e of [missing.error, off.error]) assert.ok(!DASHES.test(e), e);
});

await check("a runner reads the state and asks Orgo again before it runs, and then runs", async () => {
  reset();
  asRunner(C1);
  orgo.answer = () => ({ status: 200, json: { runsOn: "cloud" } });
  let again = 0;
  assert.equal(R.runnerReady(() => again++), false, "never read: not yet");
  await sleep(20);
  assert.equal(fake.pulls, 1, "the state read again");
  assert.ok(orgo.calls.some((c) => c.path === "/api/bops/settings"), "Orgo asked");
  assert.equal(again, 1, "and the timer goes again once both are fresh");
  assert.equal(R.runnerReady(), true);
  // A nap since: both again.
  napped = true;
  assert.equal(R.runnerReady(), false);
  await sleep(20);
  assert.equal(fake.pulls, 2);
  napped = false;
  // The state not read for 40 seconds (a read failed): not ready, and read again.
  pulledAt = Date.now() - 41_000;
  globalThis.__fake.store.pullState = async () => void fake.pulls++;
  again = 0;
  assert.equal(R.runnerReady(() => again++), false);
  await sleep(20);
  assert.equal(again, 0, "still old: the timer waits for its next turn");
  R.runnerForTests.reset();
});
globalThis.__fake.store.pullState = async () => {
  fake.pulls++;
  pulledAt = Date.now();
};

/* ---------------- The routines timer ---------------- */

await check("the Mac's timer runs its own routines and leaves the runner's", async () => {
  reset();
  seedRoutines();
  for (const r of state.routines) r.nextRunAt = Date.now() - 1000;
  tick();
  const ran = new Set(fake.started.map((s) => s.routineId));
  assert.deepEqual([...ran].sort(), ["r_boppy_mac", "r_boppy_words", "r_nova", "r_penny", "r_rook"]);
  assert.ok(byId("r_boppy").nextRunAt < Date.now(), "the runner's routine isn't advanced here");
  assert.ok(!state.messages.some((m) => m.text === "Stand up"), "nor its reminder sent");
  assert.ok(byId("r_rook").nextRunAt > Date.now(), "its own advanced");
  await sleep(10);
  T.reset();
});

await check("a next time that's a skipped one (a skip and a run on two Bops put together) is moved past it before it's due", async () => {
  reset();
  const at = Date.now() + 3_600_000;
  state.routines = [routine("r_rook", "rook", { schedule: { kind: "every", minutes: 60 }, nextRunAt: at, lastRunAt: at - 3_600_000, skips: [at] }), routine("r_boppy", "boppy", { schedule: { kind: "every", minutes: 60 }, nextRunAt: at, lastRunAt: at - 3_600_000, skips: [at] })];
  tick();
  assert.equal(byId("r_rook").nextRunAt, at + 3_600_000, "the Mac's own: the time after");
  assert.equal(byId("r_boppy").nextRunAt, at + 3_600_000, "a runner's too, so Orgo doesn't wake its computer for nothing");
  assert.equal(fake.started.length, 0, "nothing run");
  await sleep(10);
  T.reset();
});

await check("a newer Bops wrote the state: no routine runs", () => {
  reset();
  seedRoutines();
  for (const r of state.routines) r.nextRunAt = Date.now() - 1000;
  tooNew = true;
  tick();
  assert.equal(fake.started.length, 0);
  assert.ok(state.routines.every((r) => r.nextRunAt < Date.now()), "nothing advanced");
  T.reset();
});

await check("a runner's timer waits until it's sure, then runs its own in the cloud, and Orgo hears the next time", async () => {
  reset();
  seedRoutines();
  asRunner(C1);
  orgo.answer = (c) => (c.path === "/api/bops/settings" ? { status: 200, json: { runsOn: "cloud" } } : null);
  for (const r of state.routines) r.nextRunAt = Date.now() - 1000;
  tick();
  assert.equal(fake.started.length, 0, "nothing before the state is read and Orgo asked");
  assert.ok(!state.messages.length);
  await sleep(30);
  const ran = fake.started.map((s) => s.routineId).sort();
  assert.deepEqual(ran, ["r_boppy"], "its own task, once sure");
  assert.equal(fake.started[0].where, "cloud", "on its computer");
  assert.ok(state.messages.some((m) => m.text === "Stand up"), "a reminder of a bot on its computer");
  assert.ok(byId("r_rook").nextRunAt < Date.now(), "another computer's isn't touched");
  orgo.calls.length = 0;
  await T.flushAll();
  const puts = orgo.calls.filter((c) => c.method === "PUT" && c.path.endsWith("/routines"));
  assert.equal(puts.length, 1, "the main workspace's, its own routines");
  assert.deepEqual(puts[0].body.routines.map((r) => r.bopsId).sort(), ["r_boppy", "r_otto_chat", "r_otto_reminder"]);
  assert.equal(puts[0].body.deleteMissing, undefined, "a runner never sends deleteMissing");
  assert.ok(Date.parse(puts[0].body.routines.find((r) => r.bopsId === "r_boppy").nextRunAt) > Date.now(), "the next time");
  R.runnerForTests.reset();
  T.reset();
});

/* ---------------- The routines mirror ---------------- */

await check("the mirror says how each routine runs and whether it needs the Mac", () => {
  reset();
  const p = (r) => Sync.routinePayload(r);
  assert.deepEqual([p(routine("a", "boppy")).run, p(routine("a", "boppy")).onMac], ["task", false]);
  assert.deepEqual([p(routine("a", "otto", { reminder: "Stand up", where: "mac" })).run, p(routine("a", "otto", { reminder: "Stand up", where: "mac" })).onMac], ["reminder", false]);
  assert.equal(p(routine("a", "otto", { run: "chat" })).run, "chat");
  assert.equal(p(routine("a", "otto", { run: "chat", fromOutside: "an email from desk@hotel.example", where: "cloud" })).run, "task", "someone else's is never a chat run");
  assert.equal(p(routine("a", "boppy", { where: "mac" })).onMac, true);
  assert.equal(p(routine("a", "penny")).onMac, true, "its bot works on the Mac");
  assert.equal(p(routine("a", "boppy", { goal: "Sort my files locally" })).onMac, true);
  // The Mac runs it when its computer has no runner up: Orgo wakes nothing for it, a reminder or a chat run neither.
  assert.equal(p(routine("a", "rook")).onMac, true, "C2 has no runner");
  assert.equal(p(routine("a", "nova", { reminder: "Stand up" })).onMac, true, "no computer");
  for (const status of ["installing", "failed", "stopping"]) {
    state.runners[C1] = up(status);
    assert.equal(p(routine("a", "otto", { reminder: "Stand up" })).onMac, true, `C1's runner ${status}`);
  }
});

await check("a runner sends only its own routines, never deleteMissing; the Mac the whole set", async () => {
  reset();
  seedRoutines();
  asRunner(C1);
  Sync.routineChanged("boppy", { deleted: true });
  Sync.syncRoutinesOnStart();
  await T.flushAll();
  const puts = orgo.calls.filter((c) => c.method === "PUT");
  assert.deepEqual(puts.map((c) => c.path), [`/api/projects/${PID}/routines`], "nothing for a workspace with none of its routines");
  assert.deepEqual(puts[0].body.routines.map((r) => r.bopsId).sort(), ["r_boppy", "r_otto_chat", "r_otto_reminder"]);
  assert.equal(puts[0].body.deleteMissing, undefined);
  reset();
  seedRoutines();
  Sync.routineChanged("boppy", { deleted: true });
  await T.flushAll();
  const mac = orgo.calls.filter((c) => c.method === "PUT");
  assert.equal(mac.length, 1);
  assert.equal(mac[0].body.deleteMissing, true);
  assert.equal(mac[0].body.routines.length, 7, "every routine of the workspace");
});

/* ---------------- Which computer it's on ---------------- */

await check("a runner makes sure it's on its own computer: the same word back runs, another (a copy) takes it off, no answer waits", async () => {
  reset();
  asRunner(C1);
  assert.equal(await R.checkIdentity(), "same", "the word it wrote, read back from its computer");
  assert.match(orgo.bash[0].command, /cat \/run\/bops-runner\/nonce/);
  assert.equal(orgo.bash[0].computer, C1, "read from the computer it was set up on");
  assert.equal(left, 0);
  // A copy: the computer it names has another word (its own runner's), or none.
  orgo.here = C2;
  assert.equal(await R.checkIdentity(), "copy");
  assert.equal(left, 1, "a copy takes its runner off");
  orgo.here = "down";
  assert.equal(await R.checkIdentity(), "unknown", "no answer proves nothing");
  assert.equal(left, 1, "and takes nothing off");
  // A slow computer: the command timed out there (Orgo answers 200, exit 124, no word): proves nothing either.
  orgo.here = "slow";
  assert.equal(await R.checkIdentity(), "unknown");
  assert.equal(left, 1, "the real runner stays");
  assert.match(orgo.bash.at(-1).command, /echo __BOPS_NONCE_END__/, "a read that ran to its end says so");
});

await check("a copy takes off only its runner's program and the script that starts it, never the computer's Orgo key", async () => {
  reset();
  asRunner(C1);
  const [conf, wrapper, secrets, env] = ["bops-runner.conf", "run.sh", ".orgo-secrets.env", ".env"].map((f) => join(nonceDir, f));
  for (const f of [conf, wrapper, secrets, env]) writeFileSync(f, f === secrets || f === env ? "export ORGO_API_KEY=sk_the_computers_own\n" : "x");
  orgo.here = C2;
  assert.equal(await R.checkIdentity(), "copy");
  assert.equal(left, 1, "and it's gone");
  assert.ok(!existsSync(conf) && !existsSync(wrapper), "its program and its script taken off");
  assert.ok(existsSync(secrets) && existsSync(env), "the key files stay: Orgo gives a copy its own key, or takes it off");
  assert.deepEqual(R.COPY_TAKES_OFF, ["/etc/supervisor/conf.d/bops-runner.conf", "/opt/bops/runner/run.sh"]);
  // The first command on a new copy (sessions.ts ensureComputer): the same, and shell that parses.
  assert.match(R.RUNNER_SCRUB, /rm -f \/etc\/supervisor\/conf\.d\/bops-runner\.conf \/opt\/bops\/runner\/run\.sh;/);
  assert.ok(!/orgo-secrets|\/root\/\.env|ORGO_API_KEY|\/root\/\.bops\/runner\/key/.test(R.RUNNER_SCRUB), R.RUNNER_SCRUB);
  assert.equal(spawnSync("bash", ["-n"], { input: R.RUNNER_SCRUB }).status, 0);
  for (const f of [secrets, env]) rmSync(f, { force: true });
});

await check("a runner runs nothing until it's sure which computer it's on, and looks again after a nap", async () => {
  reset();
  asRunner(C1);
  orgo.answer = () => ({ status: 200, json: { runsOn: "cloud" } });
  pulledAt = Date.now();
  R.runnerForTests.hear("u1", "cloud");
  orgo.here = "down";
  let again = 0;
  assert.equal(R.runnerReady(() => again++), false, "not sure yet");
  await sleep(20);
  assert.equal(again, 0, "Orgo didn't answer: still not");
  orgo.here = null;
  assert.equal(R.runnerReady(() => again++), false);
  await sleep(20);
  assert.equal(again, 1, "sure now: the timer goes again");
  assert.equal(R.runnerReady(), true);
  // A look stands under a minute for starting a run: a live copy (a fork) carrying on from the same memory looks again first.
  R.runnerForTests.sure(Date.now() - 50_000);
  assert.equal(R.runnerReady(), false, "a look 50 seconds old: not sure enough to start a run");
  await sleep(20);
  assert.equal(R.runnerReady(), true);
  const looks = orgo.bash.length;
  napped = true;
  assert.equal(R.runnerReady(), false, "a nap since: not sure any more");
  await sleep(20);
  assert.equal(orgo.bash.length, looks + 1, "and it looks again");
  napped = false;
  R.runnerForTests.reset();
});

await check("an idle runner's timer asks nothing: no command on its computer (that would keep it up), no read of the state or Orgo", async () => {
  reset();
  asRunner(C1);
  state.routines = [routine("r_boppy", "boppy", { nextRunAt: Date.now() + 3_600_000 }), routine("r_rook", "rook", { nextRunAt: Date.now() - 1000 })];
  napped = true;
  tick();
  await sleep(20);
  assert.equal(orgo.bash.length, 0, "no look at its computer");
  assert.equal(fake.pulls, 0);
  assert.ok(!orgo.calls.some((c) => c.path === "/api/bops/settings"), "Orgo not asked");
  // One of its own comes due: then it makes sure of all three.
  byId("r_boppy").nextRunAt = Date.now() - 1000;
  napped = false;
  tick();
  await sleep(20);
  assert.equal(orgo.bash.length, 1, "its computer looked at");
  assert.equal(fake.pulls, 1);
  R.runnerForTests.reset();
});

rmSync(nonceDir, { recursive: true, force: true });
console.log(`runner: ${passed} passed, ${failures} failed`);
process.exit(failures ? 1 : 0);
