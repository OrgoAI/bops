// Tests for what a bot does without asking (lib/permission.ts), as Claude Code's "don't ask again" decides it: a rule is
// for one bot and one action, whatever the recipients or details of each call; the last rule for an action wins, and none
// asks. "Just do it" allows what no rule says, except what it still asks about (what could move money) and what it never
// covers (a key's write, a paid lookup). Always allow saves one rule for the action, with "*" as its resource for a Bops
// from before, never twice. A rule saved before for an action and one resource reads as a rule for that action. No
// wildcards: an action is as it's written. And how the Bops that asked settles a routine's ask answered elsewhere
// (lib/server/permission.ts settleAsks): its routine followed once, a run stopped elsewhere recorded once.
// No network: the store, the routines and the threads are fakes.
// Usage: node scripts/test-permission.mjs
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
const P = await import(`${root}/lib/permission.ts`);

/* ---------------- A rule is for its action, whoever it's for ---------------- */

const ava = [{ action: "Send an email", resource: "*", effect: "allow" }];
assert.equal(P.allows({ permissions: ava }, "Send an email"), true, "the action Always allow saved");
assert.equal(P.allows({ permissions: ava }, "Send Email in Gmail (work)"), false, "another action asks");
assert.equal(P.allows({}, "Send an email"), false, "no rule: it asks");
// Saved before, for one recipient or for no one: a rule for that action now.
assert.equal(P.allows({ permissions: [{ action: "Send an email", resource: "dana@acme.example", effect: "allow" }] }, "Send an email"), true, "one saved for Dana");
assert.equal(P.allows({ permissions: [{ action: "Create Event in Google Calendar (work)", resource: "(no one)", effect: "allow" }] }, "Create Event in Google Calendar (work)"), true, "one saved for no one");
assert.equal(P.allows({ permissions: [{ action: "Send *", resource: "*", effect: "allow" }] }, "Send an email"), false, "no wildcards: an action is as it's written");
assert.equal(P.allows({ permissions: [{ action: "*", resource: "*", effect: "allow" }] }, "Send an email"), false, "nor * for every action");
// The last for an action wins.
const flip = [...ava, { action: "Send an email", effect: "ask" }];
assert.equal(P.ruleFor({ permissions: flip }, "Send an email"), "ask");
assert.equal(P.allows({ permissions: flip, autoApprove: true }, "Send an email"), false, "a rule that asks, over Just do it");

/* ---------------- Just do it ---------------- */

assert.equal(P.allows({ autoApprove: true }, "Create Issue in Linear"), true, "what no rule says");
assert.equal(P.allows({ autoApprove: true }, "Pay Invoice in Stripe", { guarded: true }), false, "what could move money still asks");
assert.equal(P.allows({ autoApprove: true }, "Use a paid lookup", { justDoIt: false }), false, "never where it doesn't apply (a key's write, a paid lookup)");
assert.equal(P.allows({ autoApprove: true, permissions: [{ action: "Pay Invoice in Stripe", resource: "*", effect: "allow" }] }, "Pay Invoice in Stripe", { guarded: true }), true, "an Always allow the user saved still counts");
assert.equal(P.allows({ permissions: [{ action: "Use a paid lookup", resource: "*", effect: "allow" }] }, "Use a paid lookup", { justDoIt: false }), true, "and where Just do it doesn't");

/* ---------------- Always allow ---------------- */

assert.deepEqual(P.alwaysRule("Send an email"), { action: "Send an email", resource: "*", effect: "allow" }, "one rule for the action, \"*\" for a Bops from before");
assert.equal(P.alwaysRule("Send an email", ava), null, "never twice");
assert.equal(P.alwaysRule("Send an email", [{ action: "Send an email", resource: "dana@acme.example", effect: "allow" }]), null, "one saved before covers it already");
assert.deepEqual(P.alwaysRule("Send an email", flip), { action: "Send an email", resource: "*", effect: "allow" }, "over a rule that asks");

/* ---------------- The card says what Always allow covers ---------------- */

assert.equal(P.alwaysScope("Max", { action: "Send an email", kind: "email" }), "Always allow Max to send an email, whoever it's to and whatever it says.");
assert.equal(P.alwaysScope("Max", { action: "Send Email in Gmail (work)", kind: "app" }), "Always allow Max to send Email in Gmail (work), whoever it's for and whatever it says.");
assert.equal(P.alwaysScope("Sam", { action: "Call Stripe", kind: "api" }), "Always allow Sam to call Stripe, whatever it sends.");
assert.equal(P.alwaysScope("Sam", { action: "Use Bash", kind: "brain" }), "Always allow Sam to use Bash, whatever it runs.");

/* ---------------- Replies to others: never, ask, allow ---------------- */

const ask = [{ action: "Send an email", resource: "*", effect: "ask" }];
const NEVER = { mailNever: true };
assert.equal(P.mailRule({}), "ask", "no rule, Just do it off: with your OK");
assert.equal(P.mailRule({ autoApprove: true }), "allow", "no rule, Just do it on: on its own");
assert.equal(P.mailRule({ permissions: ask, autoApprove: true }, NEVER), "never", "Never is the bot's settings (BotSettings.mailNever)");
assert.equal(P.mailRule({ permissions: ask, autoApprove: true }, {}), "ask", "without it, the ask rule");
assert.equal(P.mailRule({ permissions: [...ask, ...ava] }), "allow", "the last rule wins");
assert.equal(P.mailRule({ permissions: ask, autoApprove: true }), "ask");
const other = { action: "Call Stripe", resource: "*", effect: "allow" };
const mixed = [{ action: "Send an email", resource: "dana@acme.example", effect: "allow" }, other, ...ask];
assert.deepEqual(P.withMailRule(mixed, "never"), [other, ...ask], "Never keeps an ask rule (a Bops from before asks), others kept");
assert.deepEqual(P.withMailRule(mixed, "ask"), [other, ...ask], "With your OK: an ask rule, whatever Just do it says now");
assert.deepEqual(P.withMailRule(undefined, "ask"), ask);
assert.deepEqual(P.withMailRule(mixed, "allow"), [other, ...ava], "allow: the rule Always allow saves");
assert.deepEqual(P.withMailRule(undefined, "allow"), ava);
for (const e of ["never", "ask", "allow"])
  for (const j of [false, true]) for (const later of [false, true]) assert.equal(P.mailRule({ permissions: P.withMailRule(mixed, e), autoApprove: later }, e === "never" ? NEVER : {}), e, `${e} reads back (Just do it ${j}, then ${later})`);
// With your OK picked while Just do it was off, then Just do it on: it still asks before emailing anyone else.
assert.equal(P.allows({ permissions: P.withMailRule(undefined, "ask"), autoApprove: true }, "Send an email"), false);

/* ---------------- A routine's ask answered on another Bops (lib/server/permission.ts settleAsks) ---------------- */

// The Bops that asked follows the routine of an ask another Bops answered (Bops Cloud for a teammate), once: Orgo's copy
// gets its next time again (routines.ts pastWait, routine-sync.ts routineChanged). One stopped there whose thread that Bops
// ended has its run recorded here, once (sessions.ts routineEndedElsewhere). The store, the routines and the threads are
// fakes; nothing reaches Orgo.
const S = { state: { appApprovals: [], sessions: [], routines: [], bots: [{ id: "max", name: "Max" }], messages: [] }, runner: true, calls: [] };
const said = (name) => (...a) => void S.calls.push([name, ...a]);
const FAKED = {
  store: {
    addMessage: (m) => (S.state.messages.push(m), m),
    bot: (id) => S.state.bots.find((b) => b.id === id),
    changeLanded: async () => true,
    getState: () => S.state,
    id: (p) => `${p}_1`,
    ownerName: () => "Ann",
    pullState: async () => {},
    session: (id) => S.state.sessions.find((s) => s.id === id),
    stateDevice: () => (S.runner ? "dev_runner" : "dev_mac"),
    update: (fn) => fn(S.state),
    watchArrivals: () => {},
    watchLoads: () => {},
  },
  persist: { onRunner: () => S.runner },
  routines: { pastWait: said("pastWait") },
  "routine-sync": { routineChanged: said("routineChanged") },
  sessions: { letGoOfPause: () => {}, endStopped: said("endStopped"), pickUpAnswered: () => {}, routineEndedElsewhere: said("routineEndedElsewhere"), handBackForAnswers: () => {} },
  runner: { runnerComputerOf: () => null },
};
globalThis.__permFake = FAKED;
const { fill } = await import("./fake-exports.mjs");
registerHooks({
  resolve(specifier, context, next) {
    if (specifier === "server-only") return { url: "data:text/javascript,", shortCircuit: true };
    return next(specifier, context);
  },
  load(url, context, next) {
    const name = url.match(/\/lib\/server\/([a-z-]+)\.ts$/)?.[1];
    if (!name || !FAKED[name]) return next(url, context);
    const source = Object.keys(FAKED[name]).map((n) => `export const ${n} = (...a) => globalThis.__permFake[${JSON.stringify(name)}].${n}(...a);`).join("\n");
    return { format: "module", shortCircuit: true, source: fill(name, url, source) };
  },
});
const Asks = await import(`${root}/lib/server/permission.ts`);
/** Let what settleAsks starts in the background (its imports) run. */
const settled = async () => {
  for (let i = 0; i < 20; i++) await new Promise((r) => setImmediate(r));
};
const callsOf = (name) => S.calls.filter((c) => c[0] === name).map((c) => c.slice(1));
const member = { userId: "u-sam", name: "Sam" };
const askOn = (o) => ({ botId: "max", chatId: "bot:max", action: "Send an email", resources: ["dana@acme.example"], preview: "to: dana@acme.example", at: 1, resume: { engine: "agents", sessionId: "as_1" }, ...o });

// On the bot's computer: its routine's run paused at an ask a teammate answered through Bops Cloud.
S.state.sessions = [{ id: "s1", botId: "max", chatId: "bot:max", status: "running", by: "dev_runner", routineId: "r1", replies: [], steps: [] }];
S.state.appApprovals = [
  askOn({ id: "apr_r1", threadId: "s1", routineId: "r1", askedBy: "dev_runner", reply: { reply: "once", by: "cloud", at: 2, member } }),
  // Not a routine's, and not this Bops's: neither is followed here.
  askOn({ id: "apr_plain", threadId: "s1", askedBy: "dev_runner", reply: { reply: "once", by: "cloud", at: 2, member } }),
  askOn({ id: "apr_mac", threadId: "s9", routineId: "r9", askedBy: "dev_mac", reply: { reply: "once", by: "cloud", at: 2, member } }),
];
Asks.settleAsks();
await settled();
assert.deepEqual(callsOf("pastWait"), [["r1"]], "its routine's next time, once");
assert.deepEqual(callsOf("routineChanged"), [["max"]], "and Orgo's copy of it");
Asks.settleAsks();
Asks.settleAsks();
await settled();
assert.deepEqual([callsOf("pastWait").length, callsOf("routineChanged").length], [1, 1], "settled again: followed once, never again");

// Stopped there (Bops Cloud's Stop for a teammate), its thread ended there: the run recorded here, once, and followed.
S.calls = [];
S.state.sessions = [{ id: "s2", botId: "max", chatId: "bot:max", status: "failed", error: "Stopped by Sam", by: "cloud", routineId: "r2", replies: [], steps: [] }];
const stopped = askOn({ id: "apr_r2", threadId: "s2", routineId: "r2", askedBy: "dev_runner", reply: { reply: "reject", reason: "stopped", by: "cloud", at: 3 } });
S.state.appApprovals = [stopped];
Asks.settleAsks();
await settled();
assert.deepEqual(callsOf("routineEndedElsewhere"), [["s2"]], "its run recorded as it ended there");
assert.deepEqual(callsOf("endStopped"), [], "nothing to end here: it ended there");
assert.deepEqual(callsOf("pastWait"), [["r2"]]);
assert.deepEqual(S.state.appApprovals, [], "taken out, as read");
// The same reply seen again (a copy from before it was taken out): neither again.
S.state.appApprovals = [stopped];
Asks.settleAsks();
await settled();
assert.deepEqual([callsOf("routineEndedElsewhere").length, callsOf("pastWait").length], [1, 1], "once each");
// Stopped while it still runs here (another Bops's Stop that didn't end it): ended here, as before, not recorded twice.
S.calls = [];
S.state.sessions = [{ id: "s3", botId: "max", chatId: "bot:max", status: "running", by: "dev_runner", routineId: "r3", replies: [], steps: [] }];
S.state.appApprovals = [askOn({ id: "apr_r3", threadId: "s3", routineId: "r3", askedBy: "dev_runner", reply: { reply: "reject", reason: "stopped", by: "dev_mac", at: 4 } })];
Asks.settleAsks();
await settled();
assert.deepEqual([callsOf("endStopped").map((c) => c[0]), callsOf("routineEndedElsewhere")], [["s3"], []]);

// On the owner's Mac: its own answer follows the routine once (replyToAsk), and settling after doesn't again.
S.calls = [];
S.runner = false;
S.state.sessions = [{ id: "s4", botId: "max", chatId: "bot:max", status: "running", by: "dev_mac", routineId: "r4", replies: [], steps: [] }];
S.state.appApprovals = [askOn({ id: "apr_r4", threadId: "s4", routineId: "r4", askedBy: "dev_mac" })];
assert.equal(Asks.replyToAsk("apr_r4", "once"), undefined);
Asks.settleAsks();
await settled();
assert.deepEqual(callsOf("pastWait"), [["r4"]], "the Mac's own answer: once");

console.log("permission: all tests passed");
