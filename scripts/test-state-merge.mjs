// Tests for putting two Bops's changes to a routine or a thread together (lib/server/state-merge.ts
// merge3): a routine changed on both sides goes field by field, its clock (next and last times, the last
// run, a late run, a meeting routine's progress) as one from the side that ran it last, whichever side is
// merging, and the times it's skipping from both. A pause on the Mac during a run on a computer's runner
// keeps both; an edit made offline over a runner's advance never brings back a time that already ran; a
// skip on the Mac while a runner ran it stands. A thread changed on both sides is the copy of the Bops
// that runs it (Session.by), with the replies and steps of both and a stop asked from elsewhere. Anything
// else changed on both sides still keeps the merging side's copy whole.
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

check("the clock is one: a field the later run cleared stays cleared, and a skip made meanwhile stands", () => {
  const base = routine({ lateRun: true });
  const mac = { ...base, nextRunAt: T0 + 2 * H, skips: [T0 + H] };
  const runner = { ...base, lastRunAt: T0 + 1_000, nextRunAt: T0 + H, last: { at: T0 + 1_000, status: "ok" } };
  delete runner.lateRun;
  for (const got of bothWays(base, mac, runner)) {
    assert.equal(got.lateRun, undefined, "the runner's run cleared it");
    assert.deepEqual(got.skips, [T0 + H], "the user's skip stands");
    assert.equal(got.nextRunAt, T0 + H, "the clock's next time (the routines timer moves it past the skip before it's due)");
  }
});

check("skips: one made on either side stays, one taken back on either side goes, one that has passed goes", () => {
  const base = routine({ skips: [T0 + H, T0 + 3 * H] });
  // The Mac takes back one and skips another; the runner runs it, past a skip it had.
  const mac = { ...base, skips: [T0 + 3 * H, T0 + 5 * H] };
  const runner = { ...base, lastRunAt: T0 + 2 * H, nextRunAt: T0 + 4 * H, last: { at: T0 + 2 * H, status: "ok" }, skips: [T0 + 3 * H, T0 + 4 * H] };
  for (const got of bothWays(base, mac, runner)) assert.deepEqual(got.skips, [T0 + 3 * H, T0 + 4 * H, T0 + 5 * H]);
  // Neither ran, both skipped: both stand.
  const a = { ...base, skips: [T0 + H, T0 + 3 * H, T0 + 6 * H] };
  const b = { ...base, skips: [T0 + H, T0 + 3 * H, T0 + 7 * H], title: "Inbox (work)" };
  for (const got of bothWays(base, a, b)) assert.deepEqual(got.skips, [T0 + H, T0 + 3 * H, T0 + 6 * H, T0 + 7 * H]);
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

/* ---------------- Threads ---------------- */

const MAC = "dev_mac";
const RUNNER = "dev_runner";
const thread = (o = {}) => ({ id: "ses_1", botId: "boppy", title: "Inbox", goal: "Check my inbox", status: "running", display: 99, by: RUNNER, steps: [{ at: 1, tool: "note", detail: "Started" }], replies: [], createdAt: 1, ...o });
const sessions = (x) => ({ sessions: [x] });
/** The thread as merged on the Mac (merging the runner's write) and on the runner (merging the Mac's). */
const threadBothWays = (base, mac, runner) => [
  M.merge3(sessions(base), sessions(mac), sessions(runner), { device: MAC }).sessions[0],
  M.merge3(sessions(base), sessions(runner), sessions(mac), { device: RUNNER, runner: true }).sessions[0],
];

check("a reply on the Mac to a runner's live thread reaches the runner, and its work stands", () => {
  const base = thread();
  const reply = { id: "rep_1", role: "user", text: "Only the work inbox", at: 5, delivered: false };
  const mac = { ...base, replies: [reply] };
  const runner = { ...base, display: 100, activity: "reading", steps: [...base.steps, { at: 6, tool: "click", detail: "Inbox" }] };
  for (const got of threadBothWays(base, mac, runner)) {
    assert.deepEqual(got.replies, [reply], "the reply is kept, on both sides");
    assert.equal(got.display, 100, "its screen as the runner has it");
    assert.equal(got.activity, "reading");
    assert.equal(got.steps.length, 2);
  }
  // The runner took it in (delivered), and the Mac added another: both.
  const base2 = { ...runner, replies: [reply] };
  const runner2 = { ...base2, replies: [{ ...reply, delivered: true }] };
  const more = { id: "rep_2", role: "user", text: "And archive the rest", at: 9, delivered: false };
  const mac2 = { ...base2, replies: [reply, more] };
  for (const got of threadBothWays(base2, mac2, runner2)) assert.deepEqual(got.replies, [{ ...reply, delivered: true }, more]);
});

check("a thread's status and screen go together, from the Bops that runs it", () => {
  // Marked failed on the Mac (a sign-in from before threads said whose) while the runner worked on: the runner's stands.
  const base = thread();
  const mac = { ...base, status: "failed", error: "Bops restarted while this was running", display: undefined };
  const runner = { ...base, steps: [...base.steps, { at: 7, tool: "type", detail: "Hello" }] };
  for (const got of threadBothWays(base, mac, runner)) {
    assert.deepEqual([got.status, got.display, got.error], ["running", 99, undefined]);
    assert.equal(got.steps.length, 2);
  }
  // The Mac's own thread, the other way round: the Mac's.
  const own = thread({ by: MAC });
  const macOwn = { ...own, status: "done", answer: "All read", display: undefined };
  const elsewhere = { ...own, title: "Inbox (work)", replies: [{ id: "rep_9", role: "user", text: "Thanks", at: 9 }] };
  for (const got of threadBothWays(own, macOwn, elsewhere)) {
    assert.deepEqual([got.status, got.answer, got.display], ["done", "All read", undefined]);
    assert.equal(got.replies.length, 1, "and the reply from elsewhere");
  }
});

check("Stop on another Bops's thread is asked for, and that Bops's stop is the thread's", () => {
  const base = thread();
  const mac = { ...base, stopAsked: "Stopped by you" };
  const runner = { ...base, activity: "typing" };
  for (const got of threadBothWays(base, mac, runner)) {
    assert.equal(got.stopAsked, "Stopped by you", "the ask reaches the runner");
    assert.equal(got.status, "running", "it stops there, not here");
  }
  // The runner stopped it (and cleared the ask) while the Mac still had the ask: stopped, the ask gone.
  const runnerStopped = { ...base, status: "failed", error: "Stopped by you", display: undefined };
  const asked = { ...mac, stopAsked: "Stopped by you" };
  for (const got of threadBothWays(mac, { ...asked, title: "Inbox (now)" }, runnerStopped)) {
    assert.equal(got.status, "failed");
    assert.equal(got.stopAsked, undefined);
  }
});

check("a thread picked up again on one side (a reply after it ended) is that side's", () => {
  const base = thread({ status: "done", display: undefined, endedAt: 5 });
  const mac = { ...base, status: "queued", endedAt: undefined, by: MAC, replies: [{ id: "rep_1", role: "user", text: "One more", at: 6 }] };
  const runner = { ...base, steps: [...base.steps, { at: 7, tool: "note", detail: "Finished" }] };
  for (const got of threadBothWays(base, mac, runner)) {
    assert.deepEqual([got.status, got.by], ["queued", MAC]);
    assert.equal(got.steps.length, 2);
  }
  // Ended on the Mac as the Mac's (its runner stopped), while the runner's last save still had it running.
  const ended = { ...thread(), status: "failed", error: "Stopped: routines run on your Mac now.", display: undefined, by: MAC };
  const late = { ...thread(), steps: [...thread().steps, { at: 8, tool: "click", detail: "Send" }] };
  for (const got of threadBothWays(thread(), ended, late)) assert.deepEqual([got.status, got.by], ["failed", MAC]);
});

console.log(`state merge: ${passed} passed, ${failures} failed`);
process.exit(failures ? 1 : 0);
