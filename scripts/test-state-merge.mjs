// Tests for putting two Bops's changes to a routine or a thread together (lib/server/state-merge.ts
// merge3): a routine changed on both sides goes field by field, its clock (next and last times, the last
// run, a late run, a meeting routine's progress) as one from the side that ran it last, whichever side is
// merging, and the times it's skipping from both. A pause on the Mac during a run on a computer's runner
// keeps both; an edit made offline over a runner's advance, or a Run now just after a runner's run, never
// brings back a time that already ran; a skip on the Mac while a runner ran it stands. A copy an older
// Bops kept never gives a routine its clock, even where only it changed the routine. Two records of one run that name
// different threads (a move to the Mac on one side, a runner's end of the thread it left on the other) never mix: the
// moved one goes whole. An ask for the user's OK is shared, and keeps the furthest it got on either side, never going
// back to waiting. A thread changed on both sides is the copy of the Bops
// that runs it (Session.by), with the replies and steps of both and a stop, a move to the Mac or a dismiss
// asked from elsewhere. A thread, routine or watch kept between us (secret) on either side stays so,
// whichever side's copy wins: a merge never takes the mark back. Anything else changed on both sides still keeps the merging side's copy whole.
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

check("Move to your Mac and Dismiss on a runner's live thread stay, whichever side merges, and so does the runner's work", () => {
  // Moved to the Mac: the Mac's new thread takes its place, while the runner writes a step.
  const base = thread({ blocker: "sign_in", waitingOnYou: true, offerMac: true });
  const moved = { ...base, replacedBy: "ses_2", stopAsked: "Moved to your Mac", blocker: undefined, waitingOnYou: false, offerMac: undefined };
  const runner = { ...base, steps: [...base.steps, { at: 7, tool: "click", detail: "Sign in" }] };
  for (const got of threadBothWays(base, moved, runner)) {
    assert.deepEqual([got.replacedBy, got.stopAsked, got.blocker, got.waitingOnYou, got.offerMac], ["ses_2", "Moved to your Mac", undefined, false, undefined], "the move stands");
    assert.equal(got.steps.length, 2, "and the runner's step");
    assert.equal(got.status, "running", "it stops there, not here");
  }
  // Dismissed on the Mac while it waited on a sign-in there.
  const asking = thread({ blocker: "sign_in", waitingOnYou: true, options: ["Use my work account", "Skip it"] });
  const dismissed = { ...asking, dismissed: true, stopAsked: "Dismissed by you", blocker: undefined, waitingOnYou: false, options: undefined };
  const still = { ...asking, activity: "waiting" };
  for (const got of threadBothWays(asking, dismissed, still)) {
    assert.deepEqual([got.dismissed, got.blocker, got.waitingOnYou, got.options], [true, undefined, false, undefined], "the dismiss stands");
    assert.equal(got.activity, "waiting");
  }
  // What the runner changed itself meanwhile is the runner's: a new question it asked stands over a dismiss of the old one.
  const askedAgain = { ...asking, blocker: "captcha", options: ["I solved it"] };
  for (const got of threadBothWays(asking, dismissed, askedAgain)) assert.deepEqual([got.dismissed, got.blocker, got.options], [true, "captcha", ["I solved it"]]);
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

check("a thread kept between us on the Mac while a runner works on it stays kept between us, both ways", () => {
  // The Mac sent it something the owner kept between us (a reply, and the mark); the runner wrote a step meanwhile.
  const base = thread();
  const reply = { id: "rep_1", role: "user", text: "Between us, also check what Sam earns", at: 5, delivered: false };
  const mac = { ...base, secret: true, replies: [reply] };
  const runner = { ...base, steps: [...base.steps, { at: 6, tool: "click", detail: "Payroll" }] };
  for (const got of threadBothWays(base, mac, runner)) {
    assert.equal(got.secret, true, "the mark stays");
    assert.deepEqual(got.replies, [reply]);
    assert.equal(got.steps.length, 2, "and the runner's work");
  }
  // Marked on the runner (a part it split off a kept thread), changed on the Mac: the same.
  for (const got of threadBothWays(base, { ...base, title: "Payroll (Q4)" }, { ...runner, secret: true })) assert.equal(got.secret, true);
  // The Mac's own thread, which the Mac's copy wins: a mark the other side put on it stays too.
  const own = thread({ by: MAC });
  for (const got of threadBothWays(own, { ...own, status: "done", answer: "Done" }, { ...own, secret: true, replies: [reply] })) {
    assert.deepEqual([got.status, got.secret], ["done", true]);
  }
});

check("a mark is never taken back by a merge: a side whose copy left it out (an older Bops) doesn't clear it", () => {
  const base = thread({ secret: true });
  const runner = { ...thread(), steps: [...base.steps, { at: 6, tool: "type", detail: "Hello" }] };
  delete runner.secret;
  // Unchanged on the Mac since: the runner's copy is taken, with the mark.
  assert.equal(M.merge3(sessions(base), sessions(base), sessions(runner), { device: MAC }).sessions[0].secret, true);
  assert.equal(M.merge3(sessions(base), sessions(runner), sessions(base), { device: RUNNER, runner: true }).sessions[0].secret, true);
  // Changed on both.
  for (const got of threadBothWays(base, { ...base, title: "Inbox (work)" }, runner)) assert.equal(got.secret, true);
  // Both sides' copies left it out (written by Bops from before the mark): the mark it had stays.
  const mac = { ...runner, title: "Inbox (work)" };
  for (const got of threadBothWays(base, mac, runner)) assert.equal(got.secret, true);
  // Nothing else is marked, and nothing gone comes back.
  const other = thread({ id: "ses_2", title: "Lunch" });
  const both = M.merge3({ sessions: [base, other] }, { sessions: [base, other] }, { sessions: [runner] }, { device: MAC }).sessions;
  assert.deepEqual(both.map((x) => [x.id, x.secret]), [["ses_1", true]]);
});

check("a routine or a watch kept between us stays kept between us when the other side changed it", () => {
  const base = routine();
  for (const got of bothWays(base, { ...base, secret: true }, { ...base, lastRunAt: T0 + 5_000, nextRunAt: T0 + H, last: { at: T0 + 5_000, status: "ok" } })) {
    assert.equal(got.secret, true);
    assert.equal(got.lastRunAt, T0 + 5_000);
  }
  // A watch changed on both keeps the merging side's copy whole: with the other side's mark.
  const w = { id: "w1", botId: "boppy", site: "X", lookFor: "a reply from Dana", since: 1 };
  const marked = { ...w, secret: true };
  const alerted = { ...w, alert: { text: "Dana replied", at: 9 } };
  for (const [mine, theirs] of [[marked, alerted], [alerted, marked]]) {
    const got = M.merge3({ watches: [w] }, { watches: [mine] }, { watches: [theirs] }).watches[0];
    assert.equal(got.secret, true);
  }
  assert.equal(M.merge3({ watches: [w] }, { watches: [w] }, { watches: [alerted] }).watches[0].secret, undefined, "nothing marked: none added");
});

check("a run moved to the Mac while the runner, not yet told, wrote the end of the thread it left: the run is the Mac's, both ways; one run's own records still merge", () => {
  const runner = "dev_runner_c1";
  const base = routine({ lastRunAt: T0 + 1_000, last: { at: T0 + 1_000, status: "running", sessionId: "ses_r", by: runner } });
  // moveToMac: the run follows the Mac's new thread, and is the Mac's now (no by).
  const mac = { ...base, last: { at: T0 + 1_000, status: "running", sessionId: "ses_mac" } };
  // The runner stopped the thread it left before it heard of the move, and wrote that.
  const ended = { ...base, last: { ...base.last, status: "failed", error: "Moved to your Mac" } };
  for (const got of bothWays(base, mac, ended)) assert.deepEqual(got.last, mac.last, "the Mac's run, not the old thread's end");
  // The same run's delivery noted on one side and its end on the other: field by field.
  const sent = { ...base, last: { ...base.last, delivery: { status: "sent", to: "Sam", at: T0 + 2_000 } } };
  const done = { ...base, last: { ...base.last, status: "ok" } };
  for (const got of bothWays(base, sent, done)) assert.deepEqual(got.last, { ...base.last, status: "ok", delivery: sent.last.delivery });
});

/* ---------------- Asks for the user's OK, shared by every Bops ---------------- */

check("asks for the user's OK are shared (never kept to one Bops): every Bops of theirs sees them in the blob", () => {
  assert.ok(!M.NEVER_SYNCED.includes("appApprovals"));
  const ask = { id: "apr_1", botId: "boppy", sessionId: "ses_r", by: "dev_runner_c1", app: "email", action: "send_email", title: "Email Dana", detail: "to: dana@acme.example", at: T0, status: "waiting" };
  const blob = M.toShared({ owner: { name: "Sam" }, appApprovals: [ask], connecting: [{ id: "c" }] }, "dev_mac");
  assert.deepEqual(blob.appApprovals, [ask], "in the blob");
  assert.equal(blob.connecting, undefined, "a sign in under way still isn't");
  assert.deepEqual(M.fromShared(blob, "dev_mac").appApprovals, [ask], "and read back on every Bops");
  // applyShared takes them from the merged blob like anything shared.
  const target = { appApprovals: [] };
  M.applyShared(target, { appApprovals: [{ ...ask, status: "allowed" }] });
  assert.equal(target.appApprovals[0].status, "allowed");
});

check("a request changed on both sides keeps its reply, never back to unanswered; two replies, the first; at once, the reject", () => {
  const ask = { id: "apr_1", botId: "boppy", threadId: "ses_r", askedBy: "dev_runner_c1", action: "Send an email", resources: ["dana@example.com"], preview: "d", at: T0, resume: { engine: "responses", responseId: "resp_1", callId: "call_1", call: { name: "use_app", arguments: "{}" } } };
  const merged = (mine, theirs) => M.merge3({ appApprovals: [ask] }, { appApprovals: [mine] }, { appApprovals: [theirs] }).appApprovals[0];
  const once = { ...ask, reply: { reply: "once", by: "dev_mac", at: T0 + 5_000 } };
  const reject = { ...ask, reply: { reply: "reject", message: "Send it to Bob instead", by: "dev_mac2", at: T0 + 6_000 } };
  const stopped = { ...ask, reply: { reply: "reject", reason: "stopped", by: "dev_mac2", at: T0 + 7_000 } };
  // Answered on a Mac while the other side's copy was still unanswered (an older copy, something else of it changed): the reply stands, both ways.
  const touched = { ...ask, preview: "d2" };
  for (const [m, t] of [[once, touched], [touched, once]]) assert.deepEqual([merged(m, t).reply?.reply, merged(m, t).reply?.by], ["once", "dev_mac"]);
  // Allowed on one Mac, stopped on another after: the reply came first.
  for (const [m, t] of [[once, stopped], [stopped, once]]) assert.equal(merged(m, t).reply?.reply, "once");
  // Two Macs answered: the first reply stands, whichever side merges.
  for (const [m, t] of [[once, reject], [reject, once]]) assert.equal(merged(m, t).reply?.reply, "once");
  // At the same moment: a reject over a yes.
  const sameNo = { ...reject, reply: { ...reject.reply, at: once.reply.at } };
  for (const [m, t] of [[once, sameNo], [sameNo, once]]) assert.deepEqual(merged(m, t).reply, sameNo.reply);
  // Taken out by the Bops that asked once it read the reply, and unchanged on the other side: gone, both ways.
  for (const [m, t] of [[[], [once]], [[once], []]]) assert.deepEqual(M.merge3({ appApprovals: [once] }, { appApprovals: m }, { appApprovals: t }).appApprovals, []);
  // Taken out by the Bops that asked once it read the first reply, while a second Mac that hadn't seen it yet answered too,
  // or Stop met it: still gone, whichever side merges, so the Bops that asked never reads that request again (it would
  // do its call a second time, or lose a later Stop).
  for (const late of [reject, stopped, { ...once, reply: { ...once.reply, by: "dev_mac3", at: T0 + 9_000 } }])
    for (const [m, t] of [[[], [late]], [[late], []]]) assert.deepEqual(M.merge3({ appApprovals: [ask] }, { appApprovals: m }, { appApprovals: t }).appApprovals, [], `${late.reply.reason ?? late.reply.reply}: not brought back`);
  // Older Bops's copy (Me.older) alike.
  assert.deepEqual(M.merge3({ appApprovals: [ask] }, { appApprovals: [once] }, { appApprovals: [] }, { device: "dev_mac", older: true }).appApprovals, []);
  // A merge never touches a request otherwise: unanswered on both sides, it stays as it is, and so does its resume.
  assert.deepEqual(M.merge3({ appApprovals: [ask] }, { appApprovals: [ask] }, { appApprovals: [ask] }).appApprovals, [ask]);
});

/* ---------------- A routine edited on one side while the other ran it ---------------- */

const Sched = await import(`${root}/cloud/schedule.ts`);
const D = Date.parse("2026-10-20T00:00:00Z");
/** The next time as persist-cloud.ts works it out, at a fixed now: 10 AM UTC that day. */
const nextRunOf = (r) => Sched.nextRun(r.schedule, D + 10 * H, r.timeZone, r.lastRunAt);
const daily = (o = {}) => routine({ id: "rtn_digest", title: "Daily digest", schedule: { kind: "daily", time: "09:00" }, timeZone: "UTC", nextRunAt: D + 9 * H, lastRunAt: D - 15 * H, last: { at: D - 15 * H, status: "ok" }, ...o });

check("moved to 5 PM on the Mac while a runner ran the 9 AM: its next time is today's 5 PM, not tomorrow's 9 AM", () => {
  const base = daily();
  const mac = { ...base, schedule: { kind: "daily", time: "17:00" }, nextRunAt: D + 17 * H };
  const runner = { ...base, lastRunAt: D + 9 * H, nextRunAt: D + 33 * H, last: { at: D + 9 * H, status: "ok" } };
  for (const [mine, theirs] of [[mac, runner], [runner, mac]]) {
    const got = M.merge3(state(base), state(mine), state(theirs), { device: MAC, nextRunOf }).routines[0];
    assert.deepEqual(got.schedule, { kind: "daily", time: "17:00" }, "the edit");
    assert.equal(got.lastRunAt, D + 9 * H, "the run");
    assert.equal(got.nextRunAt, D + 17 * H, "today's 5 PM");
  }
  // Moved to another zone: worked out in it.
  const zoned = { ...base, timeZone: "America/New_York", nextRunAt: D + 13 * H };
  const got = M.merge3(state(base), state(zoned), state(runner), { device: MAC, nextRunOf }).routines[0];
  assert.equal(got.nextRunAt, D + 13 * H, "9 AM in New York");
  // Paused on the Mac: still no next time.
  const paused = { ...base, enabled: false };
  delete paused.nextRunAt;
  assert.equal(M.merge3(state(base), state(paused), state(runner), { device: MAC, nextRunOf }).routines[0].nextRunAt, undefined);
  // The same schedule on both: the run's own next time, as before.
  const titled = { ...base, title: "Digest" };
  assert.equal(M.merge3(state(base), state(titled), state(runner), { device: MAC, nextRunOf }).routines[0].nextRunAt, D + 33 * H);
});

check("Run now on the Mac just after a runner ran the 9 AM: the 9 AM doesn't come due again", () => {
  const base = daily();
  const runner = { ...base, lastRunAt: D + 9 * H, nextRunAt: D + 33 * H, last: { at: D + 9 * H, status: "ok" } };
  // The Mac hadn't taken in the runner's run yet: Run now moves only its last run, its next time is still today's 9 AM.
  const ranNow = { at: D + 9 * H + 20_000, status: "running", sessionId: "ses_now" };
  const mac = { ...base, lastRunAt: D + 9 * H + 20_000, last: ranNow };
  for (const me of [undefined, { device: MAC, nextRunOf }]) {
    for (const [mine, theirs] of [[mac, runner], [runner, mac]]) {
      const got = M.merge3(state(base), state(mine), state(theirs), me).routines[0];
      assert.equal(got.nextRunAt, D + 33 * H, "tomorrow's 9 AM, not the one the runner ran");
      assert.equal(got.lastRunAt, D + 9 * H + 20_000, "the Run now");
      assert.deepEqual(got.last, ranNow);
    }
  }
  // A Run now before the 9 AM came due anywhere keeps the 9 AM.
  const early = { ...base, lastRunAt: D + 8 * H, last: { at: D + 8 * H, status: "ok" } };
  const renamed = { ...base, title: "Digest" };
  for (const [mine, theirs] of [[early, renamed], [renamed, early]]) {
    const got = M.merge3(state(base), state(mine), state(theirs), { device: MAC, nextRunOf }).routines[0];
    assert.equal(got.nextRunAt, D + 9 * H);
    assert.equal(got.title, "Digest");
  }
});

/* ---------------- A copy kept by an older Bops (persist-cloud.ts buildKept) ---------------- */

const OLD = { device: "dev_old_mac", older: true, nextRunOf };

check("an older Bops's kept copy never undoes a bot's rename, own computer or access made since", () => {
  const was = { id: "sam", name: "Sam", computer: "shared", access: {}, computerStatus: "ready" };
  // The newer Mac renamed Sam, gave it its own computer and Gmail; the older one only saw it go to sleep.
  const cloud = { ...was, name: "Samantha", computer: "c2", access: { ca_gmail: "act" } };
  const kept = { ...was, computerStatus: "asleep", mail: { seenAt: 5 } };
  const got = M.merge3({ bots: [was] }, { bots: [kept] }, { bots: [cloud] }, OLD).bots;
  assert.deepEqual(got, [{ id: "sam", name: "Samantha", computer: "c2", access: { ca_gmail: "act" }, computerStatus: "asleep", mail: { seenAt: 5 } }]);
  // Changed the same field both ways: the newer one's.
  const named = M.merge3({ bots: [was] }, { bots: [{ ...was, name: "Sammy" }] }, { bots: [cloud] }, OLD).bots[0];
  assert.equal(named.name, "Samantha");
  // An ordinary merge still keeps this Mac's copy whole.
  assert.deepEqual(M.merge3({ bots: [was] }, { bots: [kept] }, { bots: [cloud] }, { device: MAC }).bots, [kept]);
});

check("an older Bops's kept copy never gives a routine its clock: an edit made since runs at its time", () => {
  const base = daily();
  const cloud = { ...base, schedule: { kind: "daily", time: "17:00" }, nextRunAt: D + 17 * H };
  // The older Mac ran it from memory at 9 AM and was refused.
  const kept = { ...base, lastRunAt: D + 9 * H, nextRunAt: D + 33 * H, last: { at: D + 9 * H, status: "failed", error: "Bops Cloud answered 426 (state_too_new)" } };
  const got = M.merge3(state(base), state(kept), state(cloud), OLD).routines[0];
  assert.deepEqual(got.schedule, { kind: "daily", time: "17:00" });
  assert.equal(got.nextRunAt, D + 17 * H, "today's 5 PM still runs");
  assert.equal(got.lastRunAt, D - 15 * H);
  assert.equal(got.last.status, "ok", "and the refused run isn't its last");
  // What only the older copy changed still goes in, its next time worked out for its schedule.
  const quiet = M.merge3(state(base), state({ ...kept, quiet: true, schedule: { kind: "daily", time: "08:00" } }), state(base), OLD).routines[0];
  assert.equal(quiet.quiet, true);
});

check("an older Bops's kept copy never gives a routine its clock, even where only it changed the routine", () => {
  const base = daily();
  // The 9 AM ran on the older Mac while Bops Cloud refused it, and failed; nothing newer changed the routine.
  const kept = { ...base, lastRunAt: D + 9 * H, nextRunAt: D + 33 * H, last: { at: D + 9 * H, status: "failed", error: "Another of your Macs is on a newer Bops. Update this one." } };
  const other = routine({ id: "rtn_other", title: "Other" });
  const otherNow = { ...other, title: "Other, renamed" };
  // The routines untouched in the cloud, and the cloud having changed another one.
  for (const [was, cloud] of [[[base], [base]], [[base, other], [base, otherNow]]]) {
    const got = M.merge3({ routines: was }, { routines: [kept, ...was.slice(1)] }, { routines: cloud }, OLD).routines[0];
    assert.equal(got.nextRunAt, D + 9 * H, "today's 9 AM still runs, late, on the newer Bops");
    assert.equal(got.lastRunAt, D - 15 * H);
    assert.equal(got.last.status, "ok", "the refused run isn't its last");
  }
  // A one-off that came due on the older Mac: still on, and still due, so the newer Bops reminds.
  const once = routine({ id: "rtn_bank", title: "Call the bank before 3", reminder: true, schedule: { kind: "once", at: D + 14 * H }, nextRunAt: D + 14 * H, lastRunAt: undefined, last: undefined });
  const fired = { ...once, enabled: false, lastRunAt: D + 14 * H, last: { at: D + 14 * H, status: "ok" } };
  delete fired.nextRunAt;
  const bank = M.merge3(state(once), state(fired), state(once), OLD).routines[0];
  assert.equal(bank.enabled, true);
  assert.equal(bank.nextRunAt, D + 14 * H);
  assert.equal(bank.lastRunAt, undefined);
  assert.equal(bank.last, undefined);
  // What the user did there still goes in: an edit (its next time worked out for its new schedule)...
  const edited = M.merge3(state(base), state({ ...kept, title: "Morning digest", schedule: { kind: "daily", time: "08:00" } }), state(base), OLD).routines[0];
  assert.equal(edited.title, "Morning digest");
  assert.deepEqual(edited.schedule, { kind: "daily", time: "08:00" });
  assert.equal(edited.lastRunAt, D - 15 * H);
  assert.equal(edited.nextRunAt, D + 32 * H, "tomorrow's 8 AM");
  // ...a pause...
  const paused = { ...base, enabled: false };
  delete paused.nextRunAt;
  const off = M.merge3(state(base), state(paused), state(base), OLD).routines[0];
  assert.equal(off.enabled, false);
  assert.equal(off.nextRunAt, undefined);
  // ...and a one-off paused before its time.
  const held = { ...once, enabled: false };
  delete held.nextRunAt;
  const heldGot = M.merge3(state(once), state(held), state(once), OLD).routines[0];
  assert.equal(heldGot.enabled, false);
  assert.equal(heldGot.nextRunAt, undefined);
  // A routine only the older copy has keeps what it has.
  const added = routine({ id: "rtn_new", lastRunAt: D + 9 * H });
  assert.deepEqual(M.merge3(state(base), { routines: [base, added] }, state(base), OLD).routines[1], added);
});

check("an older Bops's kept copy: what it added goes in, what the newer one removed stays gone, the newer order stands", () => {
  const a = { id: "a", name: "Ava" };
  const b = { id: "b", name: "Max" };
  const c = { id: "c", name: "Dana" };
  const base = { bots: [a, b, c], sessions: [] };
  // The newer Mac removed Max and put Dana first; the older one changed Max and added Sam and a thread.
  const cloud = { bots: [c, a], sessions: [] };
  const added = { id: "sam", name: "Sam" };
  const t = thread({ id: "ses_new", by: "dev_old_mac", status: "failed" });
  const kept = { bots: [a, { ...b, role: "Finance" }, c, added], sessions: [t] };
  const got = M.merge3(base, kept, cloud, OLD);
  assert.deepEqual(got.bots.map((x) => x.id), ["c", "a", "sam"]);
  assert.deepEqual(got.sessions.map((x) => x.id), ["ses_new"]);
  // A thread the older Mac ran stays its copy (by who runs it), with a stop asked from the newer one.
  const run = thread({ id: "ses_old", by: "dev_old_mac", status: "running" });
  const keptRun = { ...run, status: "failed", error: "Bops Cloud answered 426" };
  const asked = { ...run, stopAsked: "Stopped by you" };
  const merged = M.merge3({ sessions: [run] }, { sessions: [keptRun] }, { sessions: [asked] }, OLD).sessions[0];
  assert.equal(merged.status, "failed");
  assert.equal(merged.stopAsked, "Stopped by you");
});

/* ---------------- A workspace's team chart (Workspace.chain) ---------------- */

check("a workspace's team chart is one field: changed on both Macs, the one saving now goes whole, never a mix; one side's change stays", () => {
  const ws = (chain, more = {}) => ({ id: "ws_acme", name: "Acme", ...(chain ? { chain } : {}), ...more });
  const base = { workspaces: [ws({ sideways: "open", bots: { juno: { lead: "max" } }, at: 1 })] };
  const here = { workspaces: [ws({ sideways: "closed", bots: { juno: { lead: "max" } }, at: 2 })] };
  const there = { workspaces: [ws({ sideways: "open", bots: { juno: { lead: "nova" } }, pairs: { "max>rex": true }, at: 3 })] };
  assert.deepEqual(M.merge3(base, here, there).workspaces[0].chain, here.workspaces[0].chain, "this Mac's, whole");
  assert.deepEqual(M.merge3(base, there, here).workspaces[0].chain, there.workspaces[0].chain);
  // Changed on one side only (a rename on the other): that side's chart, and the rename too.
  const renamed = { workspaces: [{ ...base.workspaces[0], name: "Acme Inc" }] };
  assert.deepEqual(M.merge3(base, renamed, there).workspaces[0], { ...there.workspaces[0], name: "Acme Inc" });
  // Made on one Mac where none was: kept.
  const none = { workspaces: [ws()] };
  assert.deepEqual(M.merge3(none, none, here).workspaces[0].chain, here.workspaces[0].chain);
});

check("an older Bops's kept copy keeps the team chart it doesn't know, and never undoes one made since", () => {
  const ws = (chain) => ({ id: "ws_acme", name: "Acme", ...(chain ? { chain } : {}) });
  const chain = { sideways: "closed", bots: { juno: { memory: "own" } }, at: 7 };
  // The older app read the state with the chart in it and wrote it back as it was (a field it doesn't know): it stays.
  const base = { workspaces: [ws(chain)] };
  const kept = { workspaces: [{ ...ws(chain), name: "Acme" }] };
  const newer = { workspaces: [ws({ ...chain, sideways: "open", at: 9 })] };
  assert.deepEqual(M.merge3(base, kept, newer, OLD).workspaces[0].chain, newer.workspaces[0].chain);
  // Both changed it: the newer one's, whole.
  const odd = { workspaces: [ws({ sideways: "closed", at: 8 })] };
  assert.deepEqual(M.merge3(base, odd, newer, OLD).workspaces[0].chain, newer.workspaces[0].chain);
});

/* ---------------- A bot's settings page: kept on its workspace, by bot id ---------------- */

check("a bot's settings page settings (Workspace.botSettings): two Macs setting different bots keep both, field by field", () => {
  const ws = (botSettings) => ({ id: "ws_main", name: "Main", createdAt: 1, ...(botSettings ? { botSettings } : {}) });
  const base = { workspaces: [ws({ juno: { callVoice: "sage" } })] };
  const mine = { workspaces: [ws({ juno: { callVoice: "sage", answersCalls: false }, sam: { mailNever: true } })] };
  const theirs = { workspaces: [ws({ juno: { callVoice: "ash" } })] };
  assert.deepEqual(M.merge3(base, mine, theirs).workspaces[0].botSettings, { juno: { callVoice: "ash", answersCalls: false }, sam: { mailNever: true } });
  // What v0.0.32 does with them: scripts/test-compat-0032.mjs, with its own merge3.
});

/* ---------------- Your Apps: a person's level kept, and put back where an older Bops dropped it ---------------- */

{
  const clone = (x) => JSON.parse(JSON.stringify(x));
  const AVA = "ava@acme.example";
  const JUNO = "juno@acme.example";
  const SEEN = { at: 1, apps: { shop: { head: null, sites: [], commits: [], deploys: [] } } };
  const ws = (memberAccess, extra = {}) => ({ id: "ws_main", name: "Main", createdAt: 1, memberAccess, hostedApps: { shop: { botId: "boppy", computerId: "c1" } }, ...extra });
  const entry = (apps, bots = { boppy: "read" }) => ({ others: "none", bots, at: 100, ...(apps ? { apps } : {}) });
  const blob = (map, extra) => ({ owner: { name: "Ava" }, workspace: "ws_main", workspaces: [ws(map, extra)], bots: [{ id: "boppy", isMain: true, name: "Boppy" }], chats: [] });
  const appsOf = (b, who = AVA) => b.workspaces[0].memberAccess?.[who]?.apps;
  // What an older Bops's People sheet (or its look at who's still there) keeps for a person: { ...cleanAccess, at, invite? }, its cleanAccess { others, bots }.
  const oldSet = (state, key, access, how = {}) => {
    const s = clone(state);
    s.workspaces[0].memberAccess = { ...s.workspaces[0].memberAccess, [key]: { others: access.others, bots: access.bots, at: how.at ?? 200, ...(how.invite ? { invite: true } : {}) } };
    return s;
  };
  check("Your Apps: an older Bops saving something else keeps the level", () => {
    const base = blob({ [AVA]: entry("write") });
    const mine = clone(base);
    mine.owner.name = "Ava B";
    assert.equal(appsOf(M.merge3(clone(base), mine, clone(base))), "write");
  });
  check("Your Apps: an older Bops saving while this one set the level keeps it", () => {
    const base = blob({ [AVA]: entry(undefined) });
    const mine = clone(base);
    mine.owner.name = "Ava B";
    assert.equal(appsOf(M.merge3(base, mine, blob({ [AVA]: entry("write") }))), "write");
  });
  check("Your Apps: an older sheet changing someone else keeps this person's", () => {
    const base = blob({ [AVA]: entry("write"), [JUNO]: entry("read") });
    assert.equal(appsOf(M.merge3(clone(base), oldSet(base, JUNO, { others: "read", bots: {} }), clone(base))), "write");
  });
  check("Your Apps: an older Bops deleting a bot (its entry spread) keeps it", () => {
    const base = blob({ [AVA]: entry("write", { boppy: "read", gone: "write" }) });
    const mine = clone(base);
    mine.workspaces[0].memberAccess[AVA] = { ...mine.workspaces[0].memberAccess[AVA], bots: { boppy: "read" } };
    assert.equal(appsOf(M.merge3(clone(base), mine, clone(base))), "write");
  });
  check("Your Apps: loaded and written back, the level and appsForMembers ride along", () => {
    const back = M.toShared(M.fromShared(blob({ [AVA]: entry("write") }, { appsForMembers: SEEN }), "mac_old"), "mac_old");
    assert.equal(appsOf(back), "write");
    assert.deepEqual(back.workspaces[0].appsForMembers, SEEN);
  });
  check("Your Apps: an older Bops renaming the workspace keeps appsForMembers", () => {
    const base = blob({ [AVA]: entry("read") }, { appsForMembers: SEEN });
    const mine = clone(base);
    mine.workspaces = mine.workspaces.map((w) => ({ ...w, name: "Renamed" }));
    const r = M.merge3(clone(base), mine, clone(base));
    assert.deepEqual(r.workspaces[0].appsForMembers, SEEN);
    assert.equal(r.workspaces[0].name, "Renamed");
  });
  check("Your Apps: an older sheet rewriting this person drops it; this Mac's next pull puts it back", () => {
    const base = blob({ [AVA]: { ...entry("write"), invite: true } });
    const older = oldSet(base, AVA, base.workspaces[0].memberAccess[AVA], { at: 150 });
    // Merged where the older Bops saves: the merge here puts it back from the copy before.
    const there = M.merge3(clone(base), older, clone(base));
    assert.equal(appsOf(there), "write", "even the older Bops's save keeps it when this merge3 runs it");
    // This Mac pulls what Bops Cloud kept from the older Bops (no level): put back, its new `at` kept.
    const r = M.merge3(clone(base), clone(base), older);
    assert.deepEqual(r.workspaces[0].memberAccess[AVA], { others: "none", bots: { boppy: "read" }, at: 150, apps: "write" });
  });
  check("Your Apps: removed on an older Bops stays removed", () => {
    const base = blob({ [AVA]: entry("write") });
    const mine = clone(base);
    delete mine.workspaces[0].memberAccess[AVA];
    assert.equal(M.merge3(clone(base), clone(base), mine).workspaces[0].memberAccess[AVA], undefined);
  });
  check("Your Apps: removed and invited again on an older Bops starts fresh (no level from before)", () => {
    const base = blob({ [AVA]: entry("write") });
    const older = oldSet(base, AVA, { others: "none", bots: { boppy: "read" } }, { invite: true, at: 300 });
    const r = M.merge3(clone(base), clone(base), older);
    assert.equal(appsOf(r), undefined, "reads as none");
    assert.equal(M.keepAppsLevels([{ id: "x", memberAccess: { [AVA]: { others: "none", bots: {}, invite: true } } }], [[{ id: "x", memberAccess: { [AVA]: { others: "none", bots: {}, invite: true, apps: "read" } } }]])[0].memberAccess[AVA].apps, "read", "from a copy that was an invite too");
  });
}

console.log(`state merge: ${passed} passed, ${failures} failed`);
process.exit(failures ? 1 : 0);
