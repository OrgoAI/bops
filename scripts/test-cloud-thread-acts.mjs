// Tests for a teammate's acts on the owner's threads and asks as Bops Cloud does them itself in a workspace where
// everything goes through the cloud (cloud/thread-acts.ts, called by cloud/members.ts cloudAct): a reply kept by its key and
// left where the thread runs (the bot's computer, or the owner's Mac while it's on), else queued again for the bot's own
// computer, a thread the Mac ran handed over with a line that says what's lost, a bot with no computer noted, a runner
// that isn't there or is too old refused, a brain's limit picks and the router's bump as the Mac does them; Stop by where
// the thread runs (asked, asked and woken, or over now as Bops Cloud's), a run paused at an OK ended with its asks
// rejected, its parts too; Nothing to add; Compact on a thread; where a thread runs; what a refused wake leaves; and
// answers, Always allow saving a rule. The state is made up; nothing reads a file or the network.
// Usage: node scripts/test-cloud-thread-acts.mjs
import assert from "node:assert/strict";

const root = new URL("..", import.meta.url).pathname.replace(/\/$/, "");
const T = await import(`${root}/cloud/thread-acts.ts`);

let passed = 0;
let failed = 0;
const test = (name, f) => {
  try {
    f();
    passed++;
    console.log(`ok - ${name}`);
  } catch (e) {
    failed++;
    console.error(`FAIL ${name}\n  ${e.stack?.split("\n").slice(0, 4).join("\n  ")}`);
  }
};
const refused = (f, status, words, code) =>
  assert.throws(f, (e) => {
    assert.equal(e.status, status);
    if (words) assert.equal(e.message, words);
    if (code) assert.equal(e.extra?.code, code);
    return true;
  });

const NOW = 1_800_000_000_000;
const R = "dev-r-max";
const MAC = "mac-o";
const SAM = { userId: "u_sam", email: "sam@example.com", name: "Sam" };
/** Max's computer: its runner's device R, listening unless said, and ready unless said. */
const maxComputer = (o = {}) => ({ desktop: "c-max", devices: [R, "dev-r-max-raw"], listening: o.listening ?? true, runner: o.runner ?? "ok" });
const env = (o = {}) => ({
  now: NOW,
  macOn: o.macOn ?? false,
  owner: "Alex",
  computerOf: (id) => (id === "max" ? (o.max === null ? null : maxComputer(o.max)) : id === "ivy" ? null : null),
});
const state = (sessions, extra = {}) => ({
  owner: { name: "Alex" },
  macs: { [MAC]: { name: "Alex's Mac" } },
  bots: [
    { id: "max", name: "Max", workspaceId: "ws_acme", computerId: "c-max", permissions: [{ action: "Call Stripe", resource: "*", effect: "ask" }] },
    { id: "ivy", name: "Ivy", workspaceId: "ws_acme" },
  ],
  sessions,
  appApprovals: [],
  ...extra,
});
const thread = (o = {}) => ({ id: "t1", botId: "max", chatId: "bot:max", title: "Book it", host: "orgo", status: "done", by: R, steps: [], replies: [], ...o });
const only = (blob, id = "t1") => blob.sessions.find((s) => s.id === id);

/* ---------------- Reply ---------------- */

test("a reply is kept by its key as theirs, and a thread running on the bot's computer is left to it (its poll takes it)", () => {
  const s = state([thread({ status: "running" })]);
  const d = T.replyIn(s, "t1", "Use the window seat", SAM, "key-reply-1", env());
  const t = only(d.blob);
  assert.deepEqual(t.replies, [{ id: "rep_m_u_sam_key-reply-1", role: "user", text: "Use the window seat", at: NOW, delivered: false, member: { ...SAM, ref: "key-reply-1" } }]);
  assert.deepEqual([t.status, t.by], ["running", R], "nothing else changes");
  assert.deepEqual(d.wakes, [], "it listens: nothing to wake");
  assert.equal(only(s).replies.length, 0, "the state in is never changed");
  // Its runner asleep with it live (a run between its turns): woken for the reply.
  assert.deepEqual(T.replyIn(s, "t1", "Use the window seat", SAM, "key-reply-1", env({ max: { listening: false } })).wakes, [{ desktop: "c-max", botId: "max", threadId: "t1", then: "step" }]);
});

test("the same act again changes nothing (its key, or a reply of theirs by that key)", () => {
  const s = state([thread({ status: "running" })]);
  const once = T.replyIn(s, "t1", "Go", SAM, "key-reply-2", env()).blob;
  assert.deepEqual(T.replyIn(once, "t1", "Go", SAM, "key-reply-2", env()), { blob: null, notes: [], wakes: [] });
  const byRef = state([thread({ status: "running", replies: [{ id: "rep_x", role: "user", text: "Go", at: 1, member: { ...SAM, ref: "key-reply-3" } }] })]);
  assert.equal(T.replyIn(byRef, "t1", "Go", SAM, "key-reply-3", env()).blob, null);
});

test("a thread running on the owner's Mac while it's on stays there; with the Mac off it's handed to the bot's computer, saying what's lost", () => {
  const onMac = thread({ status: "running", by: MAC, runsOn: "mac", host: "mac" });
  const kept = T.replyIn(state([onMac]), "t1", "Also check prices", SAM, "key-mac-01", env({ macOn: true }));
  assert.deepEqual([only(kept.blob).status, only(kept.blob).by, kept.wakes], ["running", MAC, []]);
  const off = T.replyIn(state([onMac]), "t1", "Also check prices", SAM, "key-mac-02", env({ macOn: false }));
  const t = only(off.blob);
  assert.deepEqual([t.status, t.by, t.runsOn, t.host], ["queued", R, "cloud", "orgo"], "the runner's queue takes it (pickUpQueued: host orgo, its device)");
  assert.deepEqual(t.steps.at(-1), { at: NOW, tool: "note", detail: "This thread moved to Max's computer. What it was doing on Alex's Mac isn't there." });
  // A thread from before Session.by on a Mac host is the Mac's too.
  const old = T.replyIn(state([thread({ status: "running", by: undefined, host: "mac" })]), "t1", "More", SAM, "key-mac-03", env({ macOn: false }));
  assert.equal(only(old.blob).by, R);
  // Paused at an OK on the Mac: nothing of it runs anywhere, and the Mac carries it on as it reads the reply.
  const paused = state([onMac], { appApprovals: [{ id: "ask-1", botId: "max", threadId: "t1", askedBy: MAC, action: "Send an email", resume: { engine: "agents" } }] });
  assert.equal(only(T.replyIn(paused, "t1", "More", SAM, "key-mac-04", env({ macOn: false })).blob).by, MAC);
});

test("an ended thread is queued again for the bot's computer (by its runner, what ended it cleared), woken when it isn't listening", () => {
  const s = state([thread({ status: "failed", error: "Stopped by you", endedAt: 5, stopAsked: "x", by: "dev-other" })]);
  const d = T.replyIn(s, "t1", "Try once more", SAM, "key-again-1", env({ max: { listening: false } }));
  const t = only(d.blob);
  assert.deepEqual([t.status, t.by, t.error, t.endedAt, t.stopAsked], ["queued", R, undefined, undefined, undefined]);
  assert.ok(!("error" in t) && !("endedAt" in t), "cleared, not left as undefined");
  assert.equal(t.steps.length, 0, "a computer's thread says nothing of a move");
  assert.deepEqual(d.wakes, [{ desktop: "c-max", botId: "max", threadId: "t1", then: "step" }]);
  assert.deepEqual(T.replyIn(s, "t1", "Try once more", SAM, "key-again-2", env()).wakes, [], "listening: it hears the state change");
  // An ended thread the Mac ran: handed over too.
  const mac = T.replyIn(state([thread({ status: "done", by: MAC, runsOn: "mac", host: "mac" })]), "t1", "And book it", SAM, "key-again-3", env({ macOn: true }));
  assert.deepEqual([only(mac.blob).by, only(mac.blob).runsOn, only(mac.blob).steps.at(-1).detail], [R, "cloud", "This thread moved to Max's computer. What it was doing on Alex's Mac isn't there."]);
});

test("a bot with no computer: the reply stays, with a note, and nothing is queued; no runner or an old one is refused, nothing kept", () => {
  const s = state([thread({ botId: "ivy", status: "done", by: MAC })]);
  const d = T.replyIn(s, "t1", "Hello", SAM, "key-nocomp1", env());
  const t = only(d.blob);
  assert.deepEqual([t.status, t.replies.length, d.wakes.length], ["done", 1, 0]);
  assert.equal(t.steps.at(-1).detail, "Ivy has no computer, so this can't go on in the cloud. Give Ivy a computer in Ivy's settings.");
  const ended = state([thread({ status: "done" })]);
  refused(() => T.replyIn(ended, "t1", "Hi", SAM, "key-norun-01", env({ max: { runner: "none" } })), 409, "Max's computer isn't set up yet. Alex's Bops sets it up the next time it opens.", "computer_not_ready");
  refused(() => T.replyIn(ended, "t1", "Hi", SAM, "key-oldrun-1", env({ max: { runner: "old" } })), 409, "Max's computer needs a newer Bops before it can do this. It updates the next time Alex opens Bops.", "computer_not_ready");
  // Live on the bot's computer, its runner's age doesn't matter: it's running there.
  assert.ok(T.replyIn(state([thread({ status: "running" })]), "t1", "Hi", SAM, "key-oldrun-2", env({ max: { runner: "old" } })).blob);
  refused(() => T.replyIn(ended, "t-none", "Hi", SAM, "key-nothread", env()), 404);
});

test("a brain's limit picks (Wait, Try again, Finish on Bops agent), the router's bump, and its app's Preview, as the owner's Mac does them", () => {
  const limit = (o = {}) => thread({ status: "done", options: ["Finish on Bops agent", "Wait", "Try again"], waitingOnYou: true, brainRun: { brainId: "b1", kind: "claude", computerId: "c-max", cli: "claude", waits: "limit", ...o } });
  const wait = T.replyIn(state([limit()]), "t1", "Wait", SAM, "key-wait-001", env());
  const w = only(wait.blob);
  assert.deepEqual([w.status, w.options, w.waitingOnYou, w.replies[0].delivered, w.brainRun.waits], ["done", undefined, false, true, "limit"], "Wait: kept as it is, waiting on no one");
  const retry = only(T.replyIn(state([limit({ started: true })]), "t1", "Try again", SAM, "key-retry-01", env()).blob);
  assert.deepEqual([retry.status, retry.replies[0].text, retry.replies[0].note, retry.replies[0].delivered, retry.brainRun.waits], ["queued", T.CARRY_ON, "Try again", false, undefined]);
  const bops = only(T.replyIn(state([limit()]), "t1", "finish on bops agent.", SAM, "key-bops-001", env()).blob);
  assert.deepEqual([bops.status, bops.onBopsAgent, bops.replies[0].delivered], ["queued", true, true]);
  // The router's route thinks a tier harder after a failure or "that's wrong".
  const routed = (status) => state([thread({ status, route: { by: "router", tier: "fast" } })]);
  assert.equal(only(T.replyIn(routed("failed"), "t1", "Go on", SAM, "key-bump-001", env()).blob).route.bumps, 1);
  assert.equal(only(T.replyIn(routed("done"), "t1", "That's wrong, redo it", SAM, "key-bump-002", env()).blob).route.bumps, 1);
  assert.equal(only(T.replyIn(routed("done"), "t1", "Thanks, and the next one", SAM, "key-bump-003", env()).blob).route.bumps, undefined);
  // A task on an app that put a change on its Preview puts this one there too, unless they say not to.
  const app = (o = {}) => state([thread({ status: "running", app: { wsId: "ws_acme", name: "demo-app", from: "abc", ...o } })]);
  assert.equal(only(T.replyIn(app(), "t1", "Make the title bigger", SAM, "key-app-0001", env()).blob).app.deployAfter, true);
  assert.equal(only(T.replyIn(app(), "t1", "Make it bigger but don't deploy yet", SAM, "key-app-0002", env()).blob).app.deployAfter, undefined);
  assert.equal(only(T.replyIn(app({ from: undefined }), "t1", "Bigger", SAM, "key-app-0003", env()).blob).app.deployAfter, undefined);
});

test("a thread waiting on where it runs keeps the reply for whoever picks", () => {
  const d = T.replyIn(state([thread({ status: "queued", askWhere: true, by: undefined })]), "t1", "Either is fine", SAM, "key-where-r1", env());
  assert.deepEqual([only(d.blob).askWhere, only(d.blob).by, d.wakes], [true, undefined, []]);
});

/* ---------------- Stop and Dismiss ---------------- */

test("Stop on the bot's computer while its runner listens: asked to stop, which it does as it hears; on the owner's Mac while it's on, the same", () => {
  const d = T.stopIn(state([thread({ status: "running" })]), ["t1"], "Stopped by Sam", env());
  assert.deepEqual([only(d.blob).status, only(d.blob).stopAsked, d.wakes], ["running", "Stopped by Sam", []]);
  const mac = T.stopIn(state([thread({ status: "running", by: MAC, runsOn: "mac" })]), ["t1"], "Stopped by Sam", env({ macOn: true }));
  assert.equal(only(mac.blob).stopAsked, "Stopped by Sam");
  // Asked already: nothing more.
  assert.equal(T.stopIn(d.blob, ["t1"], "Stopped by Sam", env()).blob, null);
});

test("Stop with the bot's computer asleep: asked and woken; it ends now only when the wake is refused (afterWake)", () => {
  const s = state([thread({ status: "running" })]);
  const d = T.stopIn(s, ["t1"], "Stopped by Sam", env({ max: { listening: false } }));
  assert.deepEqual([only(d.blob).stopAsked, d.wakes], ["Stopped by Sam", [{ desktop: "c-max", botId: "max", threadId: "t1", then: "end" }]]);
  const ended = T.afterWake(d.blob, d.wakes[0], "Max's computer is stopped.", "Stopped by Sam", env());
  const t = only(ended);
  assert.deepEqual([t.status, t.error, t.endedAt, t.by, t.stopAsked], ["failed", "Stopped by Sam", NOW, "cloud", undefined]);
  // Picked up somewhere else meanwhile (or over): nothing.
  assert.equal(T.afterWake(state([thread({ status: "done" })]), d.wakes[0], "x", "Stopped by Sam", env()), null);
});

test("Stop with the owner's Mac off, or a runner gone: over now as Bops Cloud's, its asks rejected as Stop rejects them", () => {
  const asks = [
    { id: "ask-1", botId: "max", threadId: "t1", askedBy: MAC, action: "Send an email", reply: { reply: "once", at: 1 } },
    { id: "ask-2", botId: "max", threadId: "t1", askedBy: "dev-x", action: "Call Stripe" },
  ];
  const d = T.stopIn(state([thread({ status: "running", by: MAC, runsOn: "mac", display: 99, blocker: "x", stopAsked: "Stopped by Kim" })], { appApprovals: asks }), ["t1"], "Stopped by Sam", env({ macOn: false }));
  const t = only(d.blob);
  assert.deepEqual([t.status, t.error, t.by, t.display, t.blocker, t.stopAsked], ["failed", "Stopped by Kim", "cloud", undefined, undefined, undefined], "a stop asked before it is the one it ends with");
  assert.deepEqual(d.blob.appApprovals[0].reply, { reply: "once", at: 1 }, "an answered one stays");
  assert.deepEqual(d.blob.appApprovals[1].reply, { reply: "reject", reason: "stopped", by: "cloud", at: NOW });
  const gone = T.stopIn(state([thread({ status: "running" })]), ["t1"], "Stopped by Sam", env({ max: { listening: false, runner: "none" } }));
  assert.deepEqual([only(gone.blob).status, gone.wakes], ["failed", []]);
});

test("Stop on a run paused at an OK nobody answered ends it here and now (endPaused), and its parts stop too", () => {
  const s = state(
    [thread({ status: "running", display: 100, offerMac: true }), thread({ id: "t2", partOf: "t1", status: "running", by: MAC }), thread({ id: "t3", partOf: "t1", status: "done" })],
    { appApprovals: [{ id: "ask-1", botId: "max", threadId: "t1", askedBy: R, action: "Send an email", resume: { engine: "agents" } }] },
  );
  const d = T.stopIn(s, ["t1"], "Stopped by Sam", env({ macOn: false }));
  const t = only(d.blob);
  assert.deepEqual([t.status, t.error, t.by, t.display, t.offerMac], ["failed", "Stopped by Sam", R, undefined, undefined], "its runner keeps it: it has nothing of it running");
  assert.deepEqual(d.blob.appApprovals[0].reply, { reply: "reject", reason: "stopped", by: "cloud", at: NOW });
  assert.equal(only(d.blob, "t2").status, "failed", "a live part, on a Mac that's off, ends too");
  assert.equal(only(d.blob, "t3").status, "done");
});

test("Nothing to add: stopped as Stop does, then marked dismissed with nothing waiting on anyone; an ended one is only marked", () => {
  const d = T.dismissIn(state([thread({ status: "running", waitingOnYou: true, blocker: "x", options: ["a"] })]), "t1", SAM, env());
  const t = only(d.blob);
  assert.deepEqual([t.stopAsked, t.dismissed, t.waitingOnYou, t.blocker, t.options], ["Dismissed by Sam", true, false, undefined, undefined]);
  const done = T.dismissIn(state([thread({ status: "done", waitingOnYou: true })]), "t1", SAM, env());
  assert.deepEqual([only(done.blob).status, only(done.blob).dismissed], ["done", true]);
  assert.equal(T.dismissIn(done.blob, "t1", SAM, env()).blob, null, "again: nothing");
});

/* ---------------- Compact and Where ---------------- */

test("Compact on a thread: kept as theirs and queued for the bot's computer; its brain must compact, not while it runs, nothing new refused, once by key", () => {
  const claude = { brainId: "b1", kind: "claude", computerId: "c-max", cli: "claude", started: true };
  const s = state([thread({ status: "done", brainRun: claude, endedAt: 7 })]);
  const d = T.compactIn(s, "t1", SAM, "key-compact1", env({ max: { listening: false } }));
  const t = only(d.blob);
  assert.deepEqual(t.compact, { at: NOW, by: { ...SAM, ref: "key-compact1" }, was: { status: "done", endedAt: 7 } });
  assert.deepEqual([t.status, t.by, d.wakes.length], ["queued", R, 1]);
  assert.deepEqual(T.compactIn(d.blob, "t1", SAM, "key-compact1", env()), { blob: null, notes: [], wakes: [] }, "the same act again");
  refused(() => T.compactIn(d.blob, "t1", SAM, "key-compact2", env()), 409, "Wait for it to finish.");
  refused(() => T.compactIn(state([thread({ status: "done" })]), "t1", SAM, "key-compact3", env()), 400);
  const nothingNew = state([thread({ status: "done", brainRun: claude, steps: [{ at: 10, tool: "compacted", detail: "" }], replies: [{ id: "r", role: "user", text: "x", at: 5 }] })]);
  refused(() => T.compactIn(nothingNew, "t1", SAM, "key-compact4", env()), 409, "Nothing new to compact.");
  refused(() => T.compactIn(s, "t1", SAM, "key-compact5", env({ max: { runner: "old" } })), 409, undefined, "computer_not_ready");
  // Bops agent on the computer tool compacts too.
  assert.ok(T.compactIn(state([thread({ status: "done", responseId: "resp_1" })]), "t1", SAM, "key-compact6", env()).blob);
});

test("Where: the bot's computer, run by its runner, said in the chat as theirs; picked already changes nothing; no computer refused", () => {
  const s = state([thread({ status: "queued", askWhere: true, by: undefined, host: "mac" })]);
  const d = T.whereIn(s, "t1", SAM, "key-where-01", env({ max: { listening: false } }));
  const t = only(d.blob);
  assert.deepEqual([t.askWhere, t.runsOn, t.by, t.host], [false, "cloud", R, "orgo"]);
  assert.deepEqual(d.notes, [{ id: "msg_where_u_sam_key-where-01", chatId: "bot:max", role: "system", botId: "max", text: "Sam picked Max's computer for “Book it”", sessionIds: ["t1"], at: NOW }]);
  assert.equal(d.wakes.length, 1);
  assert.equal(T.whereIn(d.blob, "t1", SAM, "key-where-01", env()).blob, null);
  refused(() => T.whereIn(state([thread({ botId: "ivy", status: "queued", askWhere: true })]), "t1", SAM, "key-where-02", env()), 409, "Ivy has no computer to run this on.", "computer_not_ready");
});

test("a refused wake on a thread queued for it leaves the Mac's step line", () => {
  const d = T.replyIn(state([thread({ status: "done" })]), "t1", "Again", SAM, "key-wake-001", env({ max: { listening: false } }));
  const next = T.afterWake(d.blob, d.wakes[0], "Max's computer is out of Free hours for today.", "x", env());
  assert.equal(only(next).steps.at(-1).detail, "Waiting for its computer to wake: Max's computer is out of Free hours for today.");
});

/* ---------------- Answers ---------------- */

test("an answer: Allow once and Deny written by Bops Cloud as theirs; Always allow saves the rule and answers the bot's other asks for it, the same person's", () => {
  const asks = [
    { id: "ask-1", botId: "max", threadId: "t1", action: "Call Stripe", kind: "api" },
    { id: "ask-2", botId: "max", chatId: "bot:max", action: "Call Stripe", kind: "api" },
    { id: "ask-3", botId: "max", chatId: "bot:max", action: "Call Stripe", kind: "api", askedFor: "Kim" },
    { id: "ask-4", botId: "max", chatId: "bot:max", action: "Send an email", kind: "email" },
    { id: "ask-5", botId: "max", chatId: "bot:max", action: "Call GitHub", kind: "key" },
  ];
  const s = state([thread({ status: "running" })], { appApprovals: asks });
  const once = T.answerIn(s, "ask-4", "once", undefined, SAM, NOW);
  assert.deepEqual(once.blob.appApprovals[3].reply, { reply: "once", by: "cloud", at: NOW, member: SAM });
  assert.equal(once.blob.bots, s.bots, "no rule");
  const no = T.answerIn(s, "ask-4", "reject", "  Ask Kim first  ", SAM, NOW);
  assert.deepEqual(no.blob.appApprovals[3].reply, { reply: "reject", message: "Ask Kim first", by: "cloud", at: NOW, member: SAM });
  // Always allow on ask-2 (a chat's: ask-1 is a task's write, which waits for its own card).
  const always = T.answerIn(s, "ask-2", "always", undefined, SAM, NOW);
  assert.deepEqual(always.blob.bots[0].permissions.at(-1), { action: "Call Stripe", resource: "*", effect: "allow" });
  assert.deepEqual(always.answered.map((a) => a.id), ["ask-2"], "a task's write and another person's ask stay");
  refused(() => T.answerIn(s, "ask-1", "always", undefined, SAM, NOW), 400, "A task's change is allowed once at a time: Allow once or Deny.");
  refused(() => T.answerIn(s, "ask-5", "always", undefined, SAM, NOW), 400, "Save the key on its card.");
  refused(() => T.answerIn(once.blob, "ask-4", "once", undefined, SAM, NOW), 409, "That's been answered.");
  // Another of the bot's asks for that action answered too, by the rule.
  const two = T.answerIn(state([], { appApprovals: [asks[1], { ...asks[1], id: "ask-6" }] }), "ask-2", "always", undefined, SAM, NOW);
  assert.deepEqual(two.answered.map((a) => [a.id, a.reply.reply]), [["ask-2", "always"], ["ask-6", "always"]]);
});

console.log(`\ncloud thread acts: ${passed} passed, ${failed} failed`);
process.exit(failed ? 1 : 0);
