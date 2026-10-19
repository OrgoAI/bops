// Tests for putting two Bops's changes to a routine together (lib/server/state-merge.ts merge3): a
// routine changed on both sides goes field by field, its clock (next and last times, the last run, a late
// run, skips, a meeting routine's progress) as one from the side that ran it last, whichever side is
// merging. A pause on the Mac during a run on a computer's runner keeps both; an edit made offline over
// a runner's advance never brings back a time that already ran. Anything else changed on both sides
// still keeps the merging side's copy whole.
//
// Pure functions: nothing reaches Bops Cloud.
// Usage: node scripts/test-state-merge.mjs
import assert from "node:assert/strict";

const root = new URL("..", import.meta.url).pathname.replace(/\/$/, "");
const M = await import(`${root}/lib/server/state-merge.ts`);

let failures = 0;
let passed = 0;
function check(name, fn) {
  try {
    fn();
    passed++;
  } catch (e) {
    failures++;
    console.error(`FAIL ${name}\n  ${e.message.split("\n").join("\n  ")}`);
  }
}

const H = 60 * 60_000;
const T0 = Date.parse("2026-10-19T13:00:00Z");
const routine = (o = {}) => ({ id: "rtn_a", botId: "boppy", title: "Inbox", goal: "Check my inbox", schedule: { kind: "every", minutes: 60 }, enabled: true, nextRunAt: T0, lastRunAt: T0 - H, last: { at: T0 - H, status: "ok" }, ...o });
const state = (r) => ({ owner: { name: "Sam" }, routines: [r] });
/** The routine as merged on each side: the Mac merging the runner's write, and the runner merging the Mac's. */
const bothWays = (base, mac, runner) => [M.merge3(state(base), state(mac), state(runner)).routines[0], M.merge3(state(base), state(runner), state(mac)).routines[0]];

check("paused on the Mac while its run went on a runner: it stays paused, and the run is kept", () => {
  const base = routine();
  const mac = { ...base, enabled: false, nextRunAt: undefined };
  delete mac.nextRunAt;
  const run = { at: T0 + 5_000, status: "running", sessionId: "ses_1" };
  const runner = { ...base, lastRunAt: T0 + 5_000, nextRunAt: T0 + H, last: run };
  for (const got of bothWays(base, mac, runner)) {
    assert.equal(got.enabled, false, "paused");
    assert.equal(got.nextRunAt, undefined, "a paused routine has no next time");
    assert.equal(got.lastRunAt, T0 + 5_000, "the runner's run");
    assert.deepEqual(got.last, run);
  }
});

check("paused with a skipped time: the skip goes with the pause, the run stays", () => {
  const base = routine({ skips: [T0 + 2 * H] });
  const mac = { ...base, enabled: false };
  delete mac.nextRunAt;
  delete mac.skips;
  const runner = { ...base, lastRunAt: T0 + 1_000, nextRunAt: T0 + H, last: { at: T0 + 1_000, status: "ok" } };
  for (const got of bothWays(base, mac, runner)) {
    assert.equal(got.skips, undefined);
    assert.equal(got.nextRunAt, undefined);
    assert.equal(got.last.status, "ok");
  }
});

check("an edit made offline over a runner's advance: the edit stays, and the time that ran isn't brought back", () => {
  const base = routine();
  const mac = { ...base, title: "Inbox, both accounts", goal: "Check both inboxes" };
  const runner = { ...base, lastRunAt: T0 + 3_000, nextRunAt: T0 + H, last: { at: T0 + 3_000, status: "quiet" }, lateRun: true };
  for (const got of bothWays(base, mac, runner)) {
    assert.equal(got.title, "Inbox, both accounts");
    assert.equal(got.goal, "Check both inboxes");
    assert.equal(got.nextRunAt, T0 + H, "the runner's next time, not the one that already ran");
    assert.equal(got.lastRunAt, T0 + 3_000);
    assert.equal(got.last.status, "quiet");
    assert.equal(got.lateRun, true);
  }
});

check("a meeting routine's progress goes with the run that made it", () => {
  const base = routine({ schedule: { kind: "before_event", minutes: 30, source: "googlecalendar" }, eventsThrough: T0 });
  const mac = { ...base, quiet: true };
  const runner = { ...base, lastRunAt: T0 + 1_000, nextRunAt: T0 + 15 * 60_000, eventsThrough: T0 + 15 * 60_000, last: { at: T0 + 1_000, status: "ok" } };
  for (const got of bothWays(base, mac, runner)) {
    assert.equal(got.quiet, true);
    assert.equal(got.eventsThrough, T0 + 15 * 60_000);
  }
});

check("the clock is one: a field the later run cleared stays cleared", () => {
  const base = routine({ lateRun: true });
  const mac = { ...base, nextRunAt: T0 + 2 * H, skips: [T0 + H] };
  const runner = { ...base, lastRunAt: T0 + 1_000, nextRunAt: T0 + H, last: { at: T0 + 1_000, status: "ok" } };
  delete runner.lateRun;
  for (const got of bothWays(base, mac, runner)) {
    assert.equal(got.lateRun, undefined, "the runner's run cleared it");
    assert.equal(got.skips, undefined, "skips are the clock's, from the later run");
    assert.equal(got.nextRunAt, T0 + H);
  }
});

check("neither ran since: field by field, each side's change kept", () => {
  const base = routine();
  const mac = { ...base, quiet: true, nextRunAt: T0 + 2 * H, skips: [T0] };
  const runner = { ...base, title: "Inbox (work)" };
  for (const got of bothWays(base, mac, runner)) {
    assert.equal(got.quiet, true);
    assert.equal(got.title, "Inbox (work)");
    assert.equal(got.nextRunAt, T0 + 2 * H, "the skip and its next time, from the side that skipped");
    assert.deepEqual(got.skips, [T0]);
  }
  // The same field changed both ways, with nothing run: this side's.
  const a = { ...base, title: "A" };
  const b = { ...base, title: "B" };
  assert.equal(M.merge3(state(base), state(a), state(b)).routines[0].title, "A");
  assert.equal(M.merge3(state(base), state(b), state(a)).routines[0].title, "B");
});

check("a routine changed on one side only, removed on one, or added on one, as before", () => {
  const base = routine();
  const runner = { ...base, lastRunAt: T0 + 1_000, nextRunAt: T0 + H };
  assert.deepEqual(M.merge3(state(base), state(base), state(runner)).routines, [runner]);
  assert.deepEqual(M.merge3(state(base), state(runner), state(base)).routines, [runner]);
  assert.deepEqual(M.merge3(state(base), { routines: [] }, state(base)).routines, []);
  const added = routine({ id: "rtn_new" });
  assert.deepEqual(M.merge3(state(base), { routines: [base, added] }, state(runner)).routines, [runner, added]);
});

check("anything else changed on both sides keeps this side's copy whole", () => {
  const was = { id: "a", name: "Boppy", runsOn: "auto", computerStatus: "ready" };
  const here = { ...was, runsOn: "mac" };
  const there = { ...was, computerStatus: "error" };
  assert.deepEqual(M.merge3({ bots: [was] }, { bots: [here] }, { bots: [there] }).bots, [here]);
  // A routine list inside something else (not the state's own routines) is a list like any other.
  const deep = { id: "w1", routines: [routine()] };
  const deepHere = { id: "w1", routines: [routine({ title: "Here" })] };
  const deepThere = { id: "w1", routines: [routine({ goal: "There" })] };
  assert.deepEqual(M.merge3({ watches: [deep] }, { watches: [deepHere] }, { watches: [deepThere] }).watches, [deepHere]);
});

console.log(`state merge: ${passed} passed, ${failures} failed`);
process.exit(failures ? 1 : 0);
