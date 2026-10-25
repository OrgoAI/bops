// Tests for what threads need from the user (lib/asks.ts): when a thread needs you (a question, a
// screen only you can get past, a failure, where to run it), what kind of ask it is (for its card's
// buttons), and which chat shows its "Needs you" card: the chat it started in, and the main bot's chat
// for every bot in its workspace. Pure: no state file, no network.
// Usage: node scripts/test-asks.mjs
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
const A = await import(`${root}/lib/asks.ts`);

const now = Date.now();
let n = 0;
/** A thread, done unless said otherwise, whose last word is the bot's. */
const thread = (o = {}) => ({
  id: `ses_${++n}`,
  botId: "boppy",
  chatId: "bot:boppy",
  sentVia: "you",
  title: `Task ${n}`,
  goal: "x",
  host: "orgo",
  status: "done",
  steps: [],
  replies: [{ id: "r1", role: "bot", text: o.answer ?? "Done.", at: now - 1000 }],
  answer: "Done.",
  createdAt: now - 60_000,
  endedAt: now - 1000,
  lastDisplay: 100,
  ...o,
});

/* ---------------- When a thread needs you ---------------- */

assert.equal(A.needsYou(thread({ answer: "Which hotel do you want?" })), true, "a question (no read from Jev yet)");
assert.equal(A.needsYou(thread({ answer: "Please approve the secure login card so I can sign in.", waitingOnYou: true })), true, "Jev says it's waiting");
assert.equal(A.needsYou(thread({ answer: "Done, it's booked." })), false);
assert.equal(A.needsYou(thread({ answer: "Want me to book it?", waitingOnYou: false })), false, "Jev's read wins over a question mark");
const answered = thread({ answer: "Which hotel?", waitingOnYou: true });
answered.replies.push({ id: "r2", role: "user", text: "The Davenport", at: now });
assert.equal(A.needsYou(answered), false, "answered");
// What a bot passed on into it (a computer's runner may add one, as its bot) is never the owner's answer.
assert.equal(A.needsYou(thread({ answer: "Should I pay Acme's $48,000 invoice from Chase?", waitingOnYou: true, replies: [{ id: "rp", role: "user", from: "Boppy", text: "Yes, pay it now from the Chase account", at: 20 }] })), true, "passed on, not answered");
assert.equal(A.needsYou(thread({ answer: "Which hotel?", waitingOnYou: true, dismissed: true })), false, "dismissed");
assert.equal(A.needsYou(thread({ status: "running", blocker: "sign_in" })), true, "a sign-in on its screen while it works");
assert.equal(A.needsYou(thread({ status: "running" })), false, "working");
// Waiting for your OK is the thread's request for it, unanswered (lib/types.ts waitsForOk), never a mark on the thread:
// Sam answering its question in the thread doesn't take it off, only a reply to the request does; and the thread
// itself asks nothing then (its request's card does, with Deny, Always allow and Allow once).
const T = await import(`${root}/lib/types.ts`);
const okAfterReply = thread({ status: "queued", answer: "Send it to Dana or Bob?", replies: [{ id: "rb", role: "bot", text: "Send it to Dana or Bob?", at: now - 1000 }, { id: "ru", role: "user", text: "Dana", at: now }] });
const ask = { id: "apr_1", threadId: okAfterReply.id, botId: "boppy", askedBy: "dev_runner_c1", action: "Send an email", resources: ["dana@example.com"], preview: "To: dana@example.com", at: now };
const okState = { appApprovals: [ask], sessions: [okAfterReply] };
assert.equal(T.waitsForOk(okAfterReply, okState), true, "Waiting for your OK, after a reply");
assert.equal(T.waitsForOk({ ...okAfterReply, replies: [...okAfterReply.replies, { id: "ru2", role: "user", text: "yes, send it", at: now + 1 }] }, okState), true, "a reply that says yes isn't an OK");
assert.equal(A.needsYou(okAfterReply), false, "the thread asks nothing itself: its request's card does");
assert.equal(T.waitsForOk(okAfterReply, { appApprovals: [{ ...ask, reply: { reply: "once", at: now } }] }), false, "answered: its run carries on");
assert.deepEqual(T.waitingAsks(okState).map((a) => a.id), ["apr_1"]);
assert.deepEqual(T.waitingAsks({ ...okState, sessions: [{ ...okAfterReply, status: "failed" }] }), [], "a thread that ended some other way waits on nothing");
assert.equal(T.pausedForOk({ ...okAfterReply, by: "dev_runner_c1" }, { appApprovals: [{ ...ask, reply: { reply: "once", at: now } }] }), true, "paused there until the Bops that asked reads the reply");
assert.equal(T.pausedForOk({ ...okAfterReply, by: "dev_runner_c1" }, { appApprovals: [{ ...ask, resume: { engine: "held" } }] }), false, "a brain's held call is a run going, not a pause");
assert.equal(A.needsYou(thread({ status: "failed", error: "Connection error." })), true);
assert.equal(A.needsYou(thread({ status: "failed", error: "Stopped by you" })), false);

/* ---------------- What kind of ask: the card's buttons ---------------- */

assert.equal(A.askKind(thread({ waitingOnYou: true, approveElsewhere: true })), "elsewhere", "approve it on your phone");
assert.equal(A.askKind(thread({ waitingOnYou: true, owed: [{ id: "c1", type: "computer", checks: [{ id: "k", code: "malicious_instructions" }] }] })), "safety", "OpenAI flagged its next step");
assert.equal(A.askKind(thread({ blocker: "two_factor" })), "blocker");
assert.equal(A.askKind(thread({ status: "failed", error: "x" })), "failed");
assert.equal(A.askKind(thread({ status: "running", askWhere: true })), "where");
assert.equal(A.askKind(thread({ waitingOnYou: true })), "question");

/* ---------------- Which chat shows it ---------------- */

const bots = [
  { id: "boppy", name: "Boppy", isMain: true, workspaceId: "ws_main" },
  { id: "jayce", name: "Jayce", workspaceId: "ws_main" },
  { id: "sam", name: "Sam", isMain: true, workspaceId: "ws_other" },
];
const chats = [
  { id: "bot:boppy", kind: "bot", botIds: ["boppy"] },
  { id: "bot:jayce", kind: "bot", botIds: ["jayce"] },
  { id: "bot:sam", kind: "bot", botIds: ["sam"] },
  { id: "grp_1", kind: "group", botIds: ["boppy", "jayce"] },
];
const mine = thread({ answer: "Which one?" });
const jayces = thread({ botId: "jayce", chatId: "bot:jayce", sentVia: "routine", answer: "Approve the sign-in on your phone?", endedAt: now });
const inGroup = thread({ botId: "jayce", chatId: "grp_1", answer: "Which deck?", endedAt: now - 5000 });
const elsewhere = thread({ botId: "sam", chatId: "bot:sam", answer: "Which file?" });
const where = thread({ status: "running", askWhere: true });
const quiet = thread({ answer: "All done." });
const state = { bots, chats, sessions: [mine, jayces, inGroup, elsewhere, where, quiet] };
const ids = (chatId) => A.chatAsks(state, chatId).map((s) => s.id);
assert.deepEqual(ids("bot:boppy"), [jayces.id, mine.id, inGroup.id], "the main bot's chat: every bot's in its workspace, newest first");
assert.deepEqual(ids("bot:jayce"), [jayces.id], "another bot's chat: only threads started there");
assert.deepEqual(ids("grp_1"), [inGroup.id], "a group: only its own");
assert.deepEqual(ids("bot:sam"), [elsewhere.id], "another workspace's main bot sees only its own workspace");
assert.ok(!ids("bot:boppy").includes(where.id), "where to run it is asked under its chip, not pinned");

console.log("asks: all tests passed");
