// Tests for what a computer's runner may touch of its user's Bops (cloud/computer-scope.ts): which bots
// work on a computer and what they may use, the same as lib/types.ts says (workBot, levelOf) over many
// states; that what keepAllowed keeps is never refused (writeDenials) and that it keeps every change a
// computer may make; and the store's two sides of it (lib/server/persist-cloud.ts): a runner sends only
// what its computer may change, only its bots' messages and Bops' notes in their chats, and holds back a path Bops Cloud
// refuses anyway; the Mac takes of a runner's write only what its computer may change, and puts the rest
// back. A computer's asks for the user's OK are its own to add and take back, never to answer.
//
// Bops Cloud is a fake on localhost that refuses a computer's write as the real one does, and the working
// folder a throwaway one, so nothing reaches the real cloud or the user's files.
// Usage: node --conditions=react-server scripts/test-computer-scope.mjs
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { createServer } from "node:http";
import { registerHooks } from "node:module";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { pathToFileURL } from "node:url";

for (const k of Object.keys(process.env)) if (/^(BOPS|ORGO)_/.test(k)) delete process.env[k];
const root = new URL("..", import.meta.url).pathname.replace(/\/$/, "");
const scratch = mkdtempSync(join(tmpdir(), "bops-test-computer-scope-"));
process.chdir(scratch);
process.env.HOME = scratch;

registerHooks({
  resolve(specifier, context, next) {
    if (specifier === "server-only") return { url: "data:text/javascript,", shortCircuit: true };
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

const C = await import(`${root}/cloud/computer-scope.ts`);
const T = await import(`${root}/lib/types.ts`);
const D1 = "c1c1c1c1-0000-4000-8000-000000000001";
const D2 = "c2c2c2c2-0000-4000-8000-000000000002";
const D3 = "c3c3c3c3-0000-4000-8000-000000000003";

/* ---------------- The same rules as the app's ---------------- */

/** A small random number generator, so a failure can be run again. */
function rng(seed) {
  let x = seed >>> 0 || 1;
  return () => ((x = (x * 1664525 + 1013904223) >>> 0) / 2 ** 32);
}
const pick = (r, list) => list[Math.floor(r() * list.length)];

function randomState(r) {
  const n = 1 + Math.floor(r() * 6);
  const bots = [];
  for (let i = 0; i < n; i++) {
    const b = { id: `b${i}`, name: `B${i}`, role: "", color: "#000", isMain: r() < 0.4, computerStatus: "ready" };
    const computer = pick(r, [undefined, "shared", "own"]);
    if (computer) b.computer = computer;
    const id = pick(r, [undefined, D1, D2, D1.toUpperCase()]);
    if (id) b.computerId = id;
    if (r() < 0.3) b.freeComputer = true;
    const ws = pick(r, [undefined, "ws_main", "ws_two"]);
    if (ws) b.workspaceId = ws;
    const access = {};
    for (const a of ["a1", "a2", "a3"]) {
      const v = pick(r, [undefined, "read", "act", "none"]);
      if (v) access[a] = v;
    }
    if (Object.keys(access).length) b.access = access;
    bots.push(b);
  }
  const accounts = ["a1", "a2", "a3"].map((id) => ({
    id,
    app: pick(r, ["gmail", "notion", "slackbot"]),
    appName: id,
    status: pick(r, ["active", "active", "expired"]),
    at: 1,
    ...(r() < 0.7 ? { workspaceId: pick(r, ["ws_main", "ws_two"]) } : {}),
    ...(r() < 0.3 ? { onlyGiven: true } : {}),
  }));
  // Used in (Workspace.loginsOn): some accounts switched on in a workspace, and now and then something that isn't an entry.
  const workspaces = ["ws_main", "ws_two"].map((id) => {
    const on = {};
    for (const a of ["a1", "a2", "a3"]) {
      const v = pick(r, [undefined, undefined, { at: 1 }, null, true]);
      if (v !== undefined) on[`app:${a}`] = v;
    }
    return { id, name: id, createdAt: 1, ...(Object.keys(on).length ? { loginsOn: on } : {}) };
  });
  return { bots, accounts, workspaces };
}

await check("which bot's computer each bot works on, and what it may do in each account (Used in too): as lib/types.ts says, over 2000 states", () => {
  const r = rng(7);
  for (let i = 0; i < 2000; i++) {
    const s = randomState(r);
    for (const b of s.bots) {
      assert.equal(C.workBotOf(b, s.bots).id, T.workBot(b, s.bots).id, JSON.stringify(s));
      for (const a of s.accounts) {
        assert.equal(C.levelOf(b, a), T.levelOf(b, a), JSON.stringify({ b, a }));
        assert.deepEqual(C.usedInOf(s, a.id), T.usedIn(s, T.appLoginKey(a.id)), JSON.stringify(s.workspaces));
        assert.equal(C.levelOf(b, a, C.usedInOf(s, a.id)), T.levelIn(s, b, a), JSON.stringify({ b, a, w: s.workspaces }));
      }
    }
    const on = C.botsOn(s, D1).map((b) => b.id);
    assert.deepEqual(on, s.bots.filter((b) => T.workBot(b, s.bots).computerId?.toLowerCase() === D1).map((b) => b.id), "any case of its id");
  }
});

/* ---------------- What it may write ---------------- */

const ME = "dev-runner-1";
const scope = { desktopId: D1, device: ME };

function baseState() {
  return {
    owner: { name: "Ann" },
    bots: [
      { id: "main", name: "Boppy", isMain: true, computerId: D1, computerStatus: "ready", keys: ["K1"] },
      { id: "helper", name: "Max", isMain: false, computerStatus: "ready" },
      { id: "iris", name: "Iris", isMain: false, computer: "own", computerId: D2, computerStatus: "ready" },
    ],
    chats: [{ id: "bot:main", kind: "bot", botIds: ["main"], createdAt: 1, typing: [] }],
    sessions: [{ id: "s-mac", botId: "main", by: "mac", status: "running" }],
    routines: [
      { id: "r-main", botId: "main", title: "A", goal: "a", schedule: { kind: "daily", times: ["09:00"] }, enabled: true, nextRunAt: 1, skips: [5, 9] },
      { id: "r-iris", botId: "iris", title: "B", goal: "b", schedule: { kind: "daily", times: ["09:00"] }, enabled: true, nextRunAt: 1 },
    ],
    accounts: [{ id: "a1", app: "gmail", appName: "Gmail", status: "active", at: 1 }],
    brains: [{ id: "br", kind: "claude", name: "C", auth: "plan", bots: ["main"], workspaceId: "ws_main", createdAt: 1, signIns: [{ computerId: D2, at: 1 }] }],
    screenLog: { "iris:1": { sessionId: "x", botId: "iris", title: "t", at: 1 } },
    digest: [{ botId: "iris", text: "old", at: 1 }],
    workspaces: [{ id: "ws_main", name: "Acme", createdAt: 1 }],
    usage: [],
    // Requests for the user's OK (lib/types.ts AppApproval): one of this runner's unanswered, one of the Mac's, one of its own the owner answered.
    appApprovals: [
      { id: "apr-mine", botId: "main", threadId: "s-run0", askedBy: ME, action: "Send an email", resources: ["dana@acme.example"], preview: "to: dana@acme.example", at: 1 },
      { id: "apr-done", botId: "main", askedBy: ME, action: "Use a paid lookup", resources: ["x"], preview: "d", at: 1, reply: { reply: "once", by: "mac", at: 2 } },
      { id: "apr-mac", botId: "main", chatId: "bot:main", askedBy: "mac", action: "Send an email", resources: ["max@acme.example"], preview: "to: max@acme.example", at: 1 },
    ],
  };
}
const askOf = (o) => ({ botId: "main", action: "Send an email", resources: ["sam@acme.example"], preview: "to: sam@acme.example", at: 2, ...o });
/** One of a state's asks by id (a change that finds it gone, another change having taken it out, changes nothing). */
const askIn = (s, id) => s.appApprovals.find((a) => a.id === id) ?? {};

/** Everything a runner's work changes (each allowed). */
const ALLOWED = [
  (s) => s.sessions.push({ id: "s-run", botId: "main", by: ME, status: "running" }),
  (s) => s.sessions.push({ id: "s-chat", botId: "main", chatId: "bot:main", by: ME, status: "running" }),
  (s) => Object.assign(s.routines[0], { nextRunAt: 2, lastRunAt: 2, last: { at: 2, status: "ok" }, lateRun: true, eventsThrough: 3 }),
  (s) => (s.routines[0].skips = [9]),
  (s) => (s.routines[0].enabled = false),
  (s) => Object.assign(s.bots[0], { computerStatus: "error", computerRam: 8, wakeFailed: { why: "x", at: 1 }, tailnet: { ip: "1", name: "n" }, composio: { sessionId: "trs", access: "k" } }),
  (s) => (s.bots[1].computerStatus = "cloning"),
  (s) => (s.accounts[0].usedAt = 5),
  (s) => s.brains[0].signIns.push({ computerId: D1, at: 2 }),
  (s) => (s.screenLog["main:1"] = { sessionId: "s-run", botId: "main", title: "t", at: 2 }),
  (s) => s.digest.push({ botId: "helper", text: "news", at: 2 }),
  (s) => s.usage.push({ kind: "model.tokens", at: 2 }),
  (s) => (s.credits = { out: true, at: 2 }),
  // Its own requests for the user's OK: one added unanswered (for its bot), one cancelled (taken out), one answered taken out once read.
  (s) => s.appApprovals.push(askOf({ id: "apr-new", threadId: "s-run", askedBy: ME })),
  (s) => (s.appApprovals = s.appApprovals.filter((a) => a.id !== "apr-mine")),
  (s) => (s.appApprovals = s.appApprovals.filter((a) => a.id !== "apr-done")),
];
/** What it may not (and the path refused). */
const REFUSED = [
  [(s) => s.bots[0].keys.push("STRIPE"), "bots.main.keys"],
  [(s) => (s.bots[2].computerId = D1), "bots.iris"],
  [(s) => (s.bots[1].access = { a1: "act" }), "bots.helper.access"],
  [(s) => s.bots.push({ id: "x", isMain: false }), "bots.x"],
  [(s) => (s.routines[0].goal = "z"), "routines.r-main.goal"],
  [(s) => (s.routines[1].nextRunAt = 9), "routines.r-iris"],
  [(s) => (s.routines[0].skips = [5, 9, 11]), "routines.r-main.skips"],
  [(s) => s.routines.pop(), "routines.r-iris"],
  [(s) => (s.sessions[0].status = "failed"), "sessions.s-mac"],
  [(s) => s.sessions.push({ id: "s-x", botId: "main", by: "mac", status: "queued" }), "sessions.s-x"],
  [(s) => s.sessions.push({ id: "s-iris", botId: "iris", chatId: "bot:iris", by: ME, status: "done", waitingOnYou: true }), "sessions.s-iris"],
  [(s) => s.sessions.push({ id: "s-away", botId: "main", chatId: "bot:iris", by: ME, status: "done" }), "sessions.s-away"],
  [(s) => (s.brains[0].signIns = []), "brains.br.signIns"],
  [(s) => (s.screenLog["iris:1"].title = "z"), "screenLog.iris:1"],
  [(s) => (s.digest = []), "digest"],
  [(s) => (s.workspaces[0].name = "z"), "workspaces"],
  [(s) => (s.macs = { [ME]: { relay: { on: true } } }), "macs"],
  [(s) => (s.accounts[0].onlyGiven = true), "accounts.a1.onlyGiven"],
  // Never a reply to a request, its own included: once, always and reject are the owner's, from a Bops of their own.
  [(s) => (askIn(s, "apr-mine").reply = { reply: "once", by: ME, at: 3 }), "appApprovals.apr-mine"],
  [(s) => (askIn(s, "apr-mine").reply = { reply: "always", by: ME, at: 3 }), "appApprovals.apr-mine"],
  [(s) => (askIn(s, "apr-mine").reply = { reply: "reject", by: ME, at: 3 }), "appApprovals.apr-mine"],
  [(s) => (askIn(s, "apr-mine").preview = "to: everyone@acme.example"), "appApprovals.apr-mine"],
  [(s) => delete askIn(s, "apr-done").reply, "appApprovals.apr-done"],
  [(s) => s.appApprovals.push(askOf({ id: "apr-yes", askedBy: ME, reply: { reply: "once", by: ME, at: 2 } })), "appApprovals.apr-yes"],
  // Nor anything of another Bops's request, nor one as another Bops, nor one of a bot not on it.
  [(s) => (askIn(s, "apr-mac").reply = { reply: "reject", reason: "stopped", by: ME, at: 3 }), "appApprovals.apr-mac"],
  [(s) => (s.appApprovals = s.appApprovals.filter((a) => a.id !== "apr-mac")), "appApprovals.apr-mac"],
  [(s) => s.appApprovals.push(askOf({ id: "apr-as-mac", askedBy: "mac" })), "appApprovals.apr-as-mac"],
  [(s) => s.appApprovals.push(askOf({ id: "apr-iris", botId: "iris", askedBy: ME })), "appApprovals.apr-iris"],
  // Nor a rule for what a bot does without asking (Always allow is the owner's too).
  [(s) => (s.bots[0].permissions = [{ action: "*", resource: "*", effect: "allow" }]), "bots.main.permissions"],
];

await check("a computer may make each change its runner's work makes, all at once too, and none it may not", () => {
  const base = baseState();
  for (const change of ALLOWED) {
    const next = structuredClone(base);
    change(next);
    assert.deepEqual(C.writeDenials(base, next, scope), [], change.toString());
    assert.ok(C.same(C.keepAllowed(base, next, scope).blob, next), `kept whole: ${change}`);
  }
  const all = structuredClone(base);
  for (const change of ALLOWED) change(all);
  assert.deepEqual(C.writeDenials(base, all, scope), []);
  for (const [change, path] of REFUSED) {
    const next = structuredClone(base);
    change(next);
    assert.ok(C.writeDenials(base, next, scope).includes(path), `${path}: ${JSON.stringify(C.writeDenials(base, next, scope))}`);
    const kept = C.keepAllowed(base, next, scope);
    assert.ok(kept.held.includes(path));
    assert.ok(C.same(kept.blob, base), `${path}: put back as it was`);
  }
  assert.deepEqual(C.writeDenials({}, { bots: [] }, scope), ["state"], "never a state of its own making");
});

await check("whatever a runner's state becomes, what keepAllowed keeps is never refused, and keeps each allowed change in it (3000 mixes)", () => {
  const r = rng(11);
  for (let i = 0; i < 3000; i++) {
    const base = baseState();
    const mine = structuredClone(base);
    const allowed = ALLOWED.filter(() => r() < 0.4);
    for (const change of allowed) change(mine);
    for (const [change] of REFUSED.filter(() => r() < 0.3)) change(mine);
    const kept = C.keepAllowed(base, mine, scope);
    assert.deepEqual(C.writeDenials(base, kept.blob, scope), [], `mix ${i}`);
    const only = structuredClone(base);
    for (const change of allowed) change(only);
    // Each allowed change made is in what's kept (a refused one on the same thing may have taken it back with it).
    for (const k of ["usage", "credits", "accounts"]) if (!REFUSED.length || C.same(only[k], mine[k])) assert.ok(C.same(kept.blob[k], only[k]), `mix ${i}: ${k}`);
  }
  // A path Bops Cloud refused anyway is put back too.
  const base = baseState();
  const mine = structuredClone(base);
  mine.routines[0].nextRunAt = 7;
  const held = C.keepAllowed(base, mine, scope, ["routines.r-main.nextRunAt"]);
  assert.equal(held.blob.routines[0].nextRunAt, 1);
});

await check("a bot moved off the computer while its runner ran its routine: the runner ends that run (its thread, the routine's record, its chip and result), and starts nothing else of that bot's", () => {
  // Iris works on D2 now, while D1's runner runs her routine: its thread, and the routine's record of it.
  const base = baseState();
  base.sessions.push({ id: "s-moved", botId: "iris", chatId: "bot:iris", by: ME, status: "running", steps: [] });
  base.routines[1].last = { at: 1, status: "running", sessionId: "s-moved" };
  const allowed = [
    (s) => Object.assign(s.sessions[1], { status: "done", answer: "Here's the report", steps: [{ at: 2, tool: "browse", detail: "read it" }] }),
    (s) => Object.assign(s.routines[1], { lastRunAt: 2, last: { at: 1, status: "ok", sessionId: "s-moved" } }),
    (s) => s.sessions.splice(1, 1),
  ];
  for (const change of allowed) {
    const next = structuredClone(base);
    change(next);
    assert.deepEqual(C.writeDenials(base, next, scope), [], change.toString());
    assert.ok(C.same(C.keepAllowed(base, next, scope).blob, next), `kept whole: ${change}`);
  }
  const refused = [
    [(s) => s.sessions.push({ id: "s-new", botId: "iris", chatId: "bot:iris", by: ME, status: "running" }), "sessions.s-new"],
    [(s) => Object.assign(s.routines[1], { nextRunAt: 9, last: { at: 9, status: "running", sessionId: "s-new" } }), "routines.r-iris"],
    [(s) => (s.routines[1].goal = "z"), "routines.r-iris.goal"],
    [(s) => (s.routines[1].skips = [1]), "routines.r-iris.skips"],
    [(s) => (s.routines[1].enabled = false), "routines.r-iris.enabled"],
    [(s) => (s.sessions[1].botId = "main"), "sessions.s-moved"],
    [(s) => (s.sessions[1].chatId = "bot:main"), "sessions.s-moved"],
    [(s) => (s.sessions[1].by = "mac"), "sessions.s-moved"],
  ];
  for (const [change, path] of refused) {
    const next = structuredClone(base);
    change(next);
    assert.ok(C.writeDenials(base, next, scope).includes(path), `${path}: ${JSON.stringify(C.writeDenials(base, next, scope))}`);
    assert.ok(C.same(C.keepAllowed(base, next, scope).blob, base), `${path}: put back as it was`);
  }
  // A routine whose run isn't a thread of its own stays another's.
  const theirs = structuredClone(base);
  theirs.routines[1].last = { at: 1, status: "running", sessionId: "s-mac" };
  const next = structuredClone(theirs);
  next.routines[1].last = { at: 1, status: "ok", sessionId: "s-mac" };
  assert.deepEqual(C.writeDenials(theirs, next, scope), ["routines.r-iris"]);
  // Its messages: the run's chip and its result, in Iris's chat, by Iris or Bops; nothing else there.
  const bots = C.botIdsOn(base, D1);
  const chats = C.chatsOn(base, D1);
  const threads = C.threadsOf(base, ME);
  const may = (m) => C.computersMessage({ id: "m", text: "x", at: 1, ...m }, bots, chats, threads);
  assert.equal(may({ chatId: "bot:iris", role: "bot", botId: "iris", resultOf: "s-moved" }), true, "its result");
  assert.equal(may({ chatId: "bot:iris", role: "system", sessionIds: ["s-moved"] }), true, "its chip");
  assert.equal(may({ chatId: "bot:iris", role: "bot", botId: "iris" }), false, "about none of its threads");
  assert.equal(may({ chatId: "bot:iris", role: "user", resultOf: "s-moved" }), false, "as the user");
  assert.equal(may({ chatId: "bot:iris", role: "bot", botId: "main", resultOf: "s-moved" }), false, "as another bot");
  assert.equal(may({ chatId: "bot:iris", role: "system", from: "main", sessionIds: ["s-moved"] }), false, "a note from another bot");
  assert.equal(may({ chatId: "bot:main", role: "bot", botId: "iris", resultOf: "s-moved" }), false, "in another chat");
  assert.equal(may({ chatId: "bot:iris", role: "system", sessionIds: ["s-moved", "s-mac"] }), false, "naming another device's thread too");
  assert.equal(C.computersMessage({ id: "m", chatId: "bot:iris", role: "bot", botId: "iris", resultOf: "s-moved" }, bots, chats), false, "with no threads said: its bots' chats only, as before");
});

await check("a bot moved off the computer while its runner ran its routine's chat run (recorded with no thread): the runner ends that run (the routine's record, the thread the run starts, its result and notes), and starts no other run of that bot's", () => {
  // Iris works on D2 now; D1's runner began her chat routine's run at 1, while her turn on the model runs.
  const base = baseState();
  base.routines[1].last = { at: 1, status: "running", by: ME };
  const allowed = [
    (s) => Object.assign(s.routines[1], { lastRunAt: 2, last: { at: 1, status: "ok", by: ME } }),
    (s) => (s.routines[1].last = { at: 1, status: "ok", by: ME, delivery: { status: "sent", to: "email", at: 2 } }),
    (s) => {
      s.sessions.push({ id: "s-run", botId: "iris", chatId: "bot:iris", by: ME, status: "queued", routineId: "r-iris" });
      s.routines[1].last = { at: 1, status: "running", sessionId: "s-run", by: ME };
    },
  ];
  for (const change of allowed) {
    const next = structuredClone(base);
    change(next);
    assert.deepEqual(C.writeDenials(base, next, scope), [], change.toString());
    assert.ok(C.same(C.keepAllowed(base, next, scope).blob, next), `kept whole: ${change}`);
  }
  const refused = [
    [(s) => Object.assign(s.routines[1], { nextRunAt: 9, last: { at: 9, status: "running", by: ME } }), "routines.r-iris"],
    [
      (s) => {
        s.sessions.push({ id: "s-new", botId: "iris", chatId: "bot:iris", by: ME, status: "queued", routineId: "r-iris" });
        s.routines[1].last = { at: 9, status: "running", sessionId: "s-new", by: ME };
      },
      "sessions.s-new",
    ],
    [(s) => s.sessions.push({ id: "s-hers", botId: "iris", chatId: "bot:iris", by: ME, status: "queued" }), "sessions.s-hers"],
    [(s) => s.sessions.push({ id: "s-away", botId: "iris", chatId: "bot:main", by: ME, status: "queued", routineId: "r-iris" }), "sessions.s-away"],
    [(s) => s.sessions.push({ id: "s-mac2", botId: "iris", chatId: "bot:iris", by: "mac", status: "queued", routineId: "r-iris" }), "sessions.s-mac2"],
    [(s) => (s.routines[1].goal = "z"), "routines.r-iris.goal"],
    [(s) => (s.routines[1].enabled = false), "routines.r-iris.enabled"],
  ];
  for (const [change, path] of refused) {
    const next = structuredClone(base);
    change(next);
    assert.ok(C.writeDenials(base, next, scope).includes(path), `${path}: ${JSON.stringify(C.writeDenials(base, next, scope))}`);
  }
  // Another Bops' run of it stays that Bops', and one it began that ended starts no thread.
  for (const last of [
    { at: 1, status: "running" },
    { at: 1, status: "running", by: "mac" },
  ]) {
    const theirs = structuredClone(base);
    theirs.routines[1].last = last;
    const next = structuredClone(theirs);
    next.routines[1].last = { ...last, status: "ok", by: ME };
    assert.deepEqual(C.writeDenials(theirs, next, scope), ["routines.r-iris"], JSON.stringify(last));
  }
  const ended = structuredClone(base);
  ended.routines[1].last = { at: 1, status: "ok", by: ME };
  const more = structuredClone(ended);
  more.sessions.push({ id: "s-late", botId: "iris", chatId: "bot:iris", by: ME, status: "queued", routineId: "r-iris" });
  assert.deepEqual(C.writeDenials(ended, more, scope), ["sessions.s-late"]);
  // Its messages while that run is going: its result, its notes and the chip of the thread it starts, in Iris's chat, by Iris or Bops.
  const bots = C.botIdsOn(base, D1);
  const chats = C.chatsOn(base, D1);
  const threads = C.threadsOf(base, ME);
  const runs = C.runsOf(base, ME);
  const may = (m, r = runs) => C.computersMessage({ id: "m", text: "x", at: 1, ...m }, bots, chats, threads, r);
  const run = { routine: { id: "r-iris" } };
  assert.equal(may({ chatId: "bot:iris", role: "bot", botId: "iris", ...run }), true, "its result");
  assert.equal(may({ chatId: "bot:iris", role: "system", text: "Read example.com", ...run }), true, "its note");
  assert.equal(may({ chatId: "bot:iris", role: "system", sessionIds: ["s-run"], ...run }), true, "the chip of the thread it starts");
  assert.equal(may({ chatId: "bot:iris", role: "bot", botId: "iris" }), false, "of no run");
  assert.equal(may({ chatId: "bot:iris", role: "bot", botId: "iris", routine: { id: "r-main" } }), false, "of another routine");
  assert.equal(may({ chatId: "bot:iris", role: "user", ...run }), false, "as the user");
  assert.equal(may({ chatId: "bot:iris", role: "bot", botId: "main", ...run }), false, "as another bot");
  assert.equal(may({ chatId: "bot:iris", role: "system", from: "main", ...run }), false, "a note from another bot");
  assert.equal(may({ chatId: "bot:main", role: "bot", botId: "iris", ...run }), false, "in another chat");
  assert.equal(may({ chatId: "bot:iris", role: "bot", botId: "iris", ...run }, C.runsOf(ended, ME)), false, "no run of its going once that run ended");
  assert.equal(may({ chatId: "bot:iris", role: "bot", botId: "iris", ...run }, C.runsOf(base, "mac")), false, "another Bops' run");
  // What that run says may reach Bops Cloud after its end does (a save already sending when the run ended, then
  // a ping on its result, a "Couldn't send"): still its own (runsBy), whatever the run's status, until another run is recorded.
  const by = C.runsBy(ended, ME);
  assert.deepEqual([...by], [["r-iris", { botId: "iris", chatId: "bot:iris", at: 1, status: "ok" }]]);
  assert.equal(may({ chatId: "bot:iris", role: "bot", botId: "iris", ...run }, by), true, "its result, after its end");
  assert.equal(may({ chatId: "bot:iris", role: "bot", botId: "iris", ping: true, ...run }, by), true, "a ping on it");
  assert.equal(may({ chatId: "bot:iris", role: "system", text: "Couldn't send", ...run }, by), true, "a note on it");
  assert.equal(may({ chatId: "bot:iris", role: "bot", botId: "iris", at: 0, ...run }, by), false, "from before that run began");
  assert.equal(may({ chatId: "bot:iris", role: "user", ...run }, by), false, "never as the user");
  assert.equal(may({ chatId: "bot:iris", role: "bot", botId: "main", ...run }, by), false, "nor as another bot");
  assert.equal(may({ chatId: "bot:main", role: "bot", botId: "iris", ...run }, by), false, "nor in another chat");
  const macRan = structuredClone(ended);
  macRan.routines[1].last = { at: 5, status: "ok" };
  assert.equal(may({ chatId: "bot:iris", role: "bot", botId: "iris", at: 6, ...run }, C.runsBy(macRan, ME)), false, "once another Bops recorded a run of it");
  assert.equal(C.runsBy(ended, "mac").size, 0, "another Bops' runs aren't its own");
});

await check("what its bots may use: their chats, accounts, inboxes, lines and memory banks", () => {
  const s = {
    bots: [
      { id: "main", isMain: true, computerId: D1, access: { a2: "read" }, mail: { inboxId: "in-main", past: ["in-old"] } },
      { id: "helper", isMain: false, workspaceId: "ws_main", phone: "+1", phoneLine: { numberId: "n-h", agentId: "ag-h" } },
      { id: "iris", isMain: false, computer: "own", computerId: D2, workspaceId: "ws_two", mail: { inboxId: "in-iris" } },
      { id: "sam", isMain: false, computer: "own", computerId: D3, workspaceId: "ws_main" },
      { id: "dana", isMain: false, computer: "own", computerId: D3, workspaceId: "ws_two" },
    ],
    chats: [{ id: "g", botIds: ["iris", "helper"] }, { id: "g2", botIds: ["iris"] }],
    accounts: [
      { id: "a1", app: "gmail", status: "active", workspaceId: "ws_main" },
      { id: "a2", app: "notion", status: "active", workspaceId: "ws_main", onlyGiven: true },
      { id: "a3", app: "slack", status: "expired", workspaceId: "ws_main" },
    ],
    workspaces: [{ id: "ws_main", line: { numberId: "n-ws", agentId: "ag-ws" } }, { id: "ws_two", memory: { bank: "bops", peer: "user" } }],
    ownerPhones: [{ number: "+1 (415) 555-0199", verifiedAt: 1 }, { number: "+14155550100", consentAt: 1 }, { number: "+14155550111", verifiedAt: 1, userId: "someone-else" }],
  };
  assert.deepEqual([...C.chatsOn(s, D1)].sort(), ["bot:helper", "bot:main", "g"]);
  assert.deepEqual([...C.grantsOn(s, D1)].map(([id, g]) => [id, g.level]), [["a1", "act"], ["a2", "read"]], "an expired account isn't one");
  assert.deepEqual([...C.grantsOn(s, D1, "helper")].map(([id]) => id), ["a1"]);
  assert.deepEqual([...C.grantsOn(s, D2)], [], "Iris, of ws_two, hasn't ws_main's Gmail");
  const on = structuredClone(s);
  on.workspaces[1].loginsOn = { "app:a1": { at: 1 }, "app:a2": { at: 1 } };
  assert.deepEqual([...C.grantsOn(on, D2)].map(([id, g]) => [id, g.level]), [["a1", "act"]], "switched on in ws_two (Used in): Iris has it there; one only the bots given it have, not");
  assert.deepEqual([...C.inboxesOn(s, D1)].sort(), ["in-main", "in-old"]);
  assert.deepEqual([...C.inboxesOn(s, D2)], ["in-iris"], "Iris's own, never the main bot's");
  assert.deepEqual([...C.inboxesOn(s, D3)], ["in-main"], "Sam has no inbox of its own: its workspace main bot's, which its routine's email goes from; Dana's workspace has no main bot with one");
  assert.deepEqual([...C.linesOn(s, D1).numberIds].sort(), ["n-h", "n-ws"], "the main bot's workspace line, and the helper's own");
  assert.deepEqual([...C.banksOn(s, D1)], ["bops"]);
  assert.deepEqual([...C.banksOn(s, D2)], ["bops"], "a workspace sharing the default's bank");
  assert.deepEqual([...C.ownerNumbers(s, "u1")], ["4155550199"], "verified, this user's");
});

/* ---------------- The store: a runner's side, and the Mac's ---------------- */

// Bops Cloud, faked: one user's blob and messages, a computer's write refused as cloud/state.ts does.
// `whilePosting` and `whileRefusing`: run (once) while a POST of messages, or a PUT that gets a 409, is on its way back.
const cloud = { version: 1, state: {}, writer: "mac", messages: [], refused: 0, alsoRefuse: [], puts: [], whilePosting: null, whileRefusing: null };
const once = async (k) => {
  const f = cloud[k];
  cloud[k] = null;
  await f?.();
};
const USER = "u_scope";
const server = createServer((req, res) => {
  let body = "";
  req.on("data", (c) => (body += c));
  req.on("end", async () => {
    const send = (status, json) => res.writeHead(status, { "content-type": "application/json" }).end(JSON.stringify(json));
    const device = req.headers["x-bops-device"];
    const computer = device === RUNNER ? { desktopId: D1, device: RUNNER } : null;
    const path = req.url.split("?")[0];
    if (req.method === "GET" && path === "/v1/state") return send(200, { version: cloud.version, seq: 0, protocol: 4, writer: cloud.writer, state: cloud.state });
    if (req.method === "GET" && path === "/v1/state/head") return send(200, { version: cloud.version, seq: 0, writer: cloud.writer });
    if (req.method === "GET" && path === "/v1/messages") return send(200, { messages: [], seq: 0, more: false });
    if (req.method === "POST" && path === "/v1/messages") {
      const b = JSON.parse(body);
      if (computer) {
        const chats = C.chatsOn(cloud.state, D1);
        const bots = C.botIdsOn(cloud.state, D1);
        const bad = b.upsert.filter((m) => !C.computersMessage(m, bots, chats, C.threadsOf(cloud.state, computer.device), C.runsBy(cloud.state, computer.device))).map((m) => `messages.${m.id}`);
        if (bad.length) {
          cloud.refused++;
          return send(403, { code: "computer_not_allowed", paths: bad });
        }
      }
      for (const m of b.upsert) {
        const i = cloud.messages.findIndex((x) => x.id === m.id);
        if (i >= 0) cloud.messages[i] = m;
        else cloud.messages.push(m);
      }
      await once("whilePosting");
      return send(200, { seq: 0 });
    }
    if (req.method === "PUT" && path === "/v1/state") {
      const b = JSON.parse(body);
      if (b.base !== cloud.version) {
        const conflict = { error: "changed", code: "state_conflict", version: cloud.version, state: cloud.state };
        await once("whileRefusing");
        return send(409, conflict);
      }
      if (computer) {
        // A newer Bops Cloud's rules, stricter than the runner's: these paths refused too when they change.
        const denied = [...C.writeDenials(cloud.state, b.state, computer), ...cloud.alsoRefuse.filter((x) => !C.same(x.get(cloud.state), x.get(b.state))).map((x) => x.path)];
        if (denied.length) {
          cloud.refused++;
          return send(403, { code: "computer_not_allowed", paths: denied });
        }
      }
      cloud.puts.push({ device, state: b.state });
      cloud.state = b.state;
      cloud.writer = device;
      return send(200, { version: ++cloud.version });
    }
    send(404, { error: "no such route" });
  });
});
await new Promise((r) => server.listen(0, "127.0.0.1", r));
process.env.BOPS_CLOUD_URL = `http://127.0.0.1:${server.address().port}`;

const warned = [];
const quiet = { info: console.info, warn: console.warn };
console.info = () => {};
console.warn = (...a) => void warned.push(a.join(" "));

const S = await import(`${root}/lib/server/store.ts`);
const P = await import(`${root}/lib/server/persist-cloud.ts`);
const RUNNER = P.deviceIdFor(USER, D1);

const seed = () => {
  cloud.state = {
    bots: [
      { id: "main", name: "Boppy", role: "Chief of Staff", color: "#000", isMain: true, computerId: D1, computerStatus: "ready", keys: ["K1"] },
      { id: "iris", name: "Iris", role: "Research", color: "#111", isMain: false, computer: "own", computerId: D2, computerStatus: "ready" },
    ],
    chats: [
      { id: "bot:main", kind: "bot", botIds: ["main"], createdAt: 1, typing: [] },
      { id: "bot:iris", kind: "bot", botIds: ["iris"], createdAt: 1, typing: [] },
    ],
    sessions: [],
    routines: [
      { id: "r-main", botId: "main", title: "A", goal: "a", schedule: { kind: "daily", times: ["09:00"] }, enabled: true, nextRunAt: 1 },
      { id: "r-iris", botId: "iris", title: "B", goal: "b", schedule: { kind: "daily", times: ["09:00"] }, enabled: true, nextRunAt: 1 },
    ],
  };
  cloud.version++;
  cloud.writer = "mac";
  cloud.puts.length = 0;
  cloud.messages.length = 0;
  cloud.refused = 0;
  cloud.alsoRefuse = [];
  cloud.whilePosting = null;
  cloud.whileRefusing = null;
};

try {
  await check("a runner sends only what its computer may change, and messages only in its bots' chats: Bops Cloud refuses it nothing", async () => {
    process.env.BOPS_RUNNER = "1";
    process.env.BOPS_RUNNER_COMPUTER = D1;
    process.env.BOPS_DEVICE_SEED = D1;
    delete globalThis.bopsPlatformId;
    seed();
    await S.bindSignIn(USER, "sk_runner");
    assert.equal(S.stateDevice(), RUNNER);
    // Its own work, and what it may not change (a bug, or something on the computer steering it).
    S.update((s) => {
      s.sessions.push({ id: "s-run", botId: "main", chatId: "bot:main", by: RUNNER, status: "running", title: "x", goal: "x", host: "orgo", steps: [], replies: [], createdAt: 1 });
      s.routines[0].nextRunAt = 50;
      s.bots[0].keys.push("STRIPE_SECRET_KEY");
      s.routines[1].goal = "something else";
    });
    S.addMessage({ chatId: "bot:main", role: "system", text: "ran" });
    S.addMessage({ chatId: "bot:main", role: "bot", botId: "main", text: "done" });
    S.addMessage({ chatId: "bot:iris", role: "system", text: "not mine" });
    // Never the user's words, nor another bot's, even in its bot's chat.
    S.addMessage({ chatId: "bot:main", role: "user", text: "as the user" });
    S.addMessage({ chatId: "bot:main", role: "bot", botId: "iris", text: "as Iris" });
    assert.equal(await S.flushState(3000), true);
    assert.equal(cloud.refused, 0, "nothing refused");
    const put = cloud.puts.at(-1).state;
    assert.equal(put.routines[0].nextRunAt, 50, "its routine's run went");
    assert.ok(put.sessions.some((x) => x.id === "s-run"), "its thread went");
    assert.deepEqual(put.bots[0].keys, ["K1"], "the key it gave a bot didn't");
    assert.equal(put.routines[1].goal, "b", "nor the other computer's routine's edit");
    assert.deepEqual(cloud.messages.map((m) => [m.chatId, m.text]), [["bot:main", "ran"], ["bot:main", "done"]], "its bots' words and Bops' notes in its bot's chat only");
    assert.deepEqual(S.getState().bots[0].keys, ["K1", "STRIPE_SECRET_KEY"], "kept on the runner");
    assert.ok(warned.some((l) => l.includes("kept on this runner, not sent to Bops Cloud") && l.includes("bots.main.keys")), warned.join(" | "));
    // Said once: nothing more goes for what it holds.
    const puts = cloud.puts.length;
    warned.length = 0;
    S.update((s) => (s.routines[0].nextRunAt = 60));
    assert.equal(await S.flushState(3000), true);
    assert.equal(cloud.puts.length, puts + 1);
    assert.ok(!warned.some((l) => l.includes("bots.main.keys")), "not said again");
    // A change that's all held back is no write.
    S.update((s) => s.bots[0].keys.push("ANOTHER"));
    assert.equal(await S.flushState(3000), true);
    assert.equal(cloud.puts.length, puts + 1, "nothing sent for it");
  });

  await check("a path Bops Cloud refuses a runner anyway is held from then on, and the rest goes", async () => {
    cloud.alsoRefuse = [{ path: "routines.r-main.lastRunAt", get: (st) => st.routines?.find((r) => r.id === "r-main")?.lastRunAt }];
    S.update((s) => {
      s.routines[0].lastRunAt = 70;
      s.sessions[0].status = "done";
    });
    assert.equal(await S.flushState(3000), true);
    assert.equal(cloud.refused, 1, "refused once");
    const put = cloud.puts.at(-1).state;
    assert.equal(put.routines[0].lastRunAt, undefined, "held");
    assert.equal(put.sessions.find((x) => x.id === "s-run").status, "done", "the rest went");
    await S.releaseSignOut();
  });

  await check("after a merge a runner's copy is Bops Cloud's but for its own work: a routine the Mac took out as it came due, and a bot the Mac moved off its computer, stay so on the runner", async () => {
    process.env.BOPS_RUNNER = "1";
    process.env.BOPS_RUNNER_COMPUTER = D1;
    process.env.BOPS_DEVICE_SEED = D1;
    delete globalThis.bopsPlatformId;
    seed();
    cloud.state.bots.push({ id: "helper", name: "Max", role: "Ops", color: "#222", isMain: false, computer: "shared", computerStatus: "ready" });
    cloud.version++;
    await S.bindSignIn(USER, "sk_runner");
    // After the runner read: the Mac takes out the main bot's routine, and gives Max a computer of his own.
    const mac = structuredClone(cloud.state);
    mac.routines = mac.routines.filter((r) => r.id !== "r-main");
    Object.assign(mac.bots.find((b) => b.id === "helper"), { computer: "own", computerId: D2 });
    cloud.state = mac;
    cloud.version++;
    cloud.writer = P.deviceIdFor(USER, "mac-a");
    // Meanwhile on the runner: the routine came due (its clock moved), Max's Composio session changed, and a thread of its own.
    S.update((s) => {
      s.routines.find((r) => r.id === "r-main").nextRunAt = 80;
      s.bots.find((b) => b.id === "helper").composio = { sessionId: "trs_new", access: "k" };
      s.sessions.push({ id: "s-own", botId: "main", chatId: "bot:main", by: RUNNER, status: "running", title: "x", goal: "x", host: "orgo", steps: [], replies: [], createdAt: 1 });
    });
    assert.equal(await S.flushState(3000), true);
    assert.equal(cloud.refused, 0, "nothing refused");
    assert.deepEqual(cloud.state.routines.map((r) => r.id), ["r-iris"], "the routine stays out in Bops Cloud");
    assert.ok(cloud.state.sessions.some((x) => x.id === "s-own"), "the runner's own thread went");
    const st = S.getState();
    assert.deepEqual(st.routines.map((r) => r.id), ["r-iris"], "and out on the runner, which so never runs it again");
    const max = st.bots.find((b) => b.id === "helper");
    assert.deepEqual([max.computer, max.computerId], ["own", D2], "Max works on his own computer on the runner too");
    assert.ok(st.sessions.some((x) => x.id === "s-own"), "its own thread stays");
    // Nothing is left that the runner would send and can't: a later look changes nothing.
    const puts = cloud.puts.length;
    assert.equal(await S.flushState(3000), true);
    assert.equal(cloud.puts.length, puts, "no write for nothing");
    await S.releaseSignOut();
  });

  await check("a runner whose bot the Mac moved to a computer of its own mid-run still ends that run in Bops Cloud: its thread done, the routine's record, its result in the bot's chat", async () => {
    process.env.BOPS_RUNNER = "1";
    process.env.BOPS_RUNNER_COMPUTER = D1;
    process.env.BOPS_DEVICE_SEED = D1;
    delete globalThis.bopsPlatformId;
    seed();
    // Otto shares Boppy's computer (D1), and has a routine of his own.
    cloud.state.bots.push({ id: "otto", name: "Otto", role: "Ops", color: "#222", isMain: false, computer: "shared", computerStatus: "ready" });
    cloud.state.routines.push({ id: "r-otto", botId: "otto", title: "C", goal: "c", schedule: { kind: "daily", times: ["09:00"] }, enabled: true, nextRunAt: 1 });
    cloud.version++;
    await S.bindSignIn(USER, "sk_runner");
    try {
      // The runner begins Otto's 9:00 run, and that lands.
      S.update((s) => {
        s.sessions.push({ id: "s-otto", botId: "otto", chatId: "bot:otto", by: RUNNER, status: "running", title: "C", goal: "c", host: "orgo", steps: [], replies: [], createdAt: 1 });
        Object.assign(s.routines.find((r) => r.id === "r-otto"), { nextRunAt: 90, lastRunAt: 1, last: { at: 1, status: "running", sessionId: "s-otto" } });
      });
      S.addMessage({ chatId: "bot:otto", role: "system", text: "Routine · C", sessionIds: ["s-otto"] });
      assert.equal(await S.flushState(3000), true);
      assert.equal(cloud.state.sessions.find((x) => x.id === "s-otto")?.status, "running");
      // The Mac gives Otto a computer of his own (no runner there yet).
      const mac = structuredClone(cloud.state);
      Object.assign(mac.bots.find((b) => b.id === "otto"), { computer: "own", computerId: D2 });
      cloud.state = mac;
      cloud.version++;
      cloud.writer = P.deviceIdFor(USER, "mac-a");
      // The run ends on D1, with its result.
      S.update((s) => {
        Object.assign(s.sessions.find((x) => x.id === "s-otto"), { status: "done", answer: "Here's the report" });
        s.routines.find((r) => r.id === "r-otto").last = { at: 1, status: "ok", sessionId: "s-otto" };
      });
      S.addMessage({ chatId: "bot:otto", role: "bot", botId: "otto", text: "Here's the report", resultOf: "s-otto" });
      assert.equal(await S.flushState(3000), true);
      assert.equal(cloud.refused, 0, "nothing refused");
      const otto = cloud.state.bots.find((b) => b.id === "otto");
      assert.deepEqual([otto.computer, otto.computerId], ["own", D2], "the move stands");
      assert.equal(cloud.state.sessions.find((x) => x.id === "s-otto").status, "done", "the run's thread ended in Bops Cloud");
      assert.deepEqual(cloud.state.routines.find((r) => r.id === "r-otto").last, { at: 1, status: "ok", sessionId: "s-otto" }, "and its routine's record");
      assert.equal(cloud.state.routines.find((r) => r.id === "r-otto").nextRunAt, 90, "its next time stays past the one it ran");
      assert.ok(cloud.messages.some((m) => m.resultOf === "s-otto" && m.text === "Here's the report"), "its result is in Otto's chat");
      const st = S.getState();
      assert.equal(st.sessions.find((x) => x.id === "s-otto").status, "done", "and done on the runner, not put back");
      assert.deepEqual(st.bots.find((b) => b.id === "otto").computerId, D2);
      // Nothing more of Otto's goes from it: a new thread of his stays on the runner.
      const puts = cloud.puts.length;
      S.update((s) => s.sessions.push({ id: "s-otto-2", botId: "otto", chatId: "bot:otto", by: RUNNER, status: "running", title: "C", goal: "c", host: "orgo", steps: [], replies: [], createdAt: 2 }));
      assert.equal(await S.flushState(3000), true);
      assert.equal(cloud.puts.length, puts, "nothing sent for it");
      assert.ok(!cloud.state.sessions.some((x) => x.id === "s-otto-2"));
    } finally {
      await S.releaseSignOut();
    }
  });

  await check("a runner whose bot the Mac moved to a computer of its own during chat runs' turns still ends those runs in Bops Cloud: each one's words and the thread it starts in the bot's chat, and the routine's record", async () => {
    process.env.BOPS_RUNNER = "1";
    process.env.BOPS_RUNNER_COMPUTER = D1;
    process.env.BOPS_DEVICE_SEED = D1;
    delete globalThis.bopsPlatformId;
    seed();
    // Otto shares Boppy's computer (D1), and has two chat routines (app checks, say).
    cloud.state.bots.push({ id: "otto", name: "Otto", role: "Ops", color: "#222", isMain: false, computer: "shared", computerStatus: "ready" });
    for (const id of ["r-otto", "r-otto-2"]) cloud.state.routines.push({ id, botId: "otto", title: id, goal: "c", run: "chat", schedule: { kind: "daily", times: ["09:00"] }, enabled: true, nextRunAt: 1 });
    cloud.version++;
    await S.bindSignIn(USER, "sk_runner");
    const routine = (st, id) => st.routines.find((r) => r.id === id);
    try {
      // The runner begins both 9:00 runs (routines.ts chatRun: running, no thread yet), and they land.
      S.update((s) => {
        for (const id of ["r-otto", "r-otto-2"]) Object.assign(routine(s, id), { nextRunAt: 90, lastRunAt: 1, last: { at: 1, status: "running", by: RUNNER } });
      });
      assert.equal(await S.startLanded((st) => routine(st, "r-otto-2")?.last?.at === 1), true);
      // During the turns on the model, the Mac gives Otto a computer of his own (no runner there yet).
      const mac = structuredClone(cloud.state);
      Object.assign(mac.bots.find((b) => b.id === "otto"), { computer: "own", computerId: D2 });
      cloud.state = mac;
      cloud.version++;
      cloud.writer = P.deviceIdFor(USER, "mac-a");
      // The runner hears of it (a "state" event): Otto isn't on its computer any more.
      await S.pullState();
      assert.equal(S.getState().bots.find((b) => b.id === "otto").computerId, D2);
      // One turn answers: its result, and the run recorded (chatRun, at once).
      S.addMessage({ chatId: "bot:otto", role: "bot", botId: "otto", text: "Three new orders today.", routine: { id: "r-otto" } });
      S.update((s) => (routine(s, "r-otto").last = { at: 1, status: "ok", by: RUNNER }));
      // The other starts a thread (chat.ts backgroundTurn): its chip, its words, the run's record of it.
      S.update((s) => s.sessions.push({ id: "s-otto", botId: "otto", chatId: "bot:otto", by: RUNNER, status: "queued", title: "C", goal: "c", host: "orgo", steps: [], replies: [], createdAt: 2, routineId: "r-otto-2", sentVia: "routine" }));
      S.addMessage({ chatId: "bot:otto", role: "system", text: "Routine · C", sessionIds: ["s-otto"], routine: { id: "r-otto-2" } });
      S.addMessage({ chatId: "bot:otto", role: "bot", botId: "otto", text: "Two refunds need a look, on it.", routine: { id: "r-otto-2" } });
      S.update((s) => (routine(s, "r-otto-2").last = { at: 1, status: "running", sessionId: "s-otto", by: RUNNER }));
      // That thread starts once Bops Cloud has it (sessions.ts route), and ends with the run's result.
      assert.equal(await S.startLanded((st) => st.sessions.some((x) => x.id === "s-otto")), true, "the thread the run started goes on");
      S.update((s) => {
        Object.assign(s.sessions.find((x) => x.id === "s-otto"), { status: "done", answer: "Both refunded" });
        routine(s, "r-otto-2").last = { at: 1, status: "ok", sessionId: "s-otto", by: RUNNER };
      });
      S.addMessage({ chatId: "bot:otto", role: "bot", botId: "otto", text: "Both refunded", resultOf: "s-otto" });
      assert.equal(await S.flushState(3000), true);
      assert.equal(cloud.refused, 0, "nothing refused");
      const otto = cloud.state.bots.find((b) => b.id === "otto");
      assert.deepEqual([otto.computer, otto.computerId], ["own", D2], "the move stands");
      assert.equal(cloud.state.sessions.find((x) => x.id === "s-otto")?.status, "done");
      assert.deepEqual(
        ["r-otto", "r-otto-2"].map((id) => [routine(cloud.state, id).nextRunAt, routine(cloud.state, id).last]),
        [
          [90, { at: 1, status: "ok", by: RUNNER }],
          [90, { at: 1, status: "ok", sessionId: "s-otto", by: RUNNER }],
        ],
        "each routine records its run, its next time past it",
      );
      assert.deepEqual(
        cloud.messages.filter((m) => m.chatId === "bot:otto").map((m) => m.text),
        ["Three new orders today.", "Routine · C", "Two refunds need a look, on it.", "Both refunded"],
        "all of it in Otto's chat",
      );
      // Nothing new of Otto's goes from it: another run of his routine stays on the runner.
      const puts = cloud.puts.length;
      S.update((s) => Object.assign(routine(s, "r-otto"), { nextRunAt: 120, lastRunAt: 90, last: { at: 90, status: "running", by: RUNNER } }));
      assert.equal(await S.flushState(3000), true);
      assert.equal(cloud.puts.length, puts, "nothing sent for it");
      assert.equal(routine(cloud.state, "r-otto").last.at, 1);
    } finally {
      await S.releaseSignOut();
    }
  });

  await check("a runner's chat run of a bot the Mac moved off its computer gets its result into the bot's chat even when the run's end reaches Bops Cloud first (a save already sending, or a 409 from the move itself), and a ping on it after", async () => {
    const routine = (st, id) => st.routines.find((r) => r.id === id);
    const begin = async () => {
      process.env.BOPS_RUNNER = "1";
      process.env.BOPS_RUNNER_COMPUTER = D1;
      process.env.BOPS_DEVICE_SEED = D1;
      delete globalThis.bopsPlatformId;
      seed();
      // Otto shares Boppy's computer (D1), and has a chat routine (an app check, say).
      cloud.state.bots.push({ id: "otto", name: "Otto", role: "Ops", color: "#222", isMain: false, computer: "shared", computerStatus: "ready" });
      cloud.state.routines.push({ id: "r-otto", botId: "otto", title: "Orders", goal: "c", run: "chat", schedule: { kind: "daily", times: ["09:00"] }, enabled: true, nextRunAt: 1 });
      cloud.version++;
      await S.bindSignIn(USER, "sk_runner");
      // The runner begins its 9:00 run (routines.ts chatRun), and that lands.
      S.update((s) => Object.assign(routine(s, "r-otto"), { nextRunAt: 90, lastRunAt: 1, last: { at: 1, status: "running", by: RUNNER } }));
      assert.equal(await S.startLanded((st) => routine(st, "r-otto")?.last?.at === 1), true);
    };
    const moveOtto = () => {
      const mac = structuredClone(cloud.state);
      Object.assign(mac.bots.find((b) => b.id === "otto"), { computer: "own", computerId: D2 });
      cloud.state = mac;
      cloud.version++;
      cloud.writer = P.deviceIdFor(USER, "mac-a");
    };
    /** Otto's turn answers (chatRun): its result posted, and the run recorded at once. */
    const answers = () => {
      const m = S.addMessage({ chatId: "bot:otto", role: "bot", botId: "otto", text: "Three new orders today.", routine: { id: "r-otto" } });
      S.update((s) => (routine(s, "r-otto").last = { at: 1, status: "ok", by: RUNNER }));
      return m;
    };
    const ended = async (result, how) => {
      assert.deepEqual(routine(cloud.state, "r-otto").last, { at: 1, status: "ok", by: RUNNER }, `${how}: the run recorded once, as the runner's`);
      assert.equal(await S.flushState(3000), true, `${how}: nothing left to send`);
      assert.equal(cloud.refused, 0, `${how}: nothing refused`);
      const otto = cloud.state.bots.find((b) => b.id === "otto");
      assert.deepEqual([otto.computer, otto.computerId], ["own", D2], `${how}: the move stands`);
      assert.equal(cloud.messages.find((m) => m.id === result.id)?.text, "Three new orders today.", `${how}: its result is in Otto's chat, not kept on the runner`);
      assert.ok(!warned.some((l) => l.includes("messages in bot:otto")), `${how}: ${warned.join(" | ")}`);
      // Jev finds it urgent once it's posted (attention.ts pingIfWorthIt): the ping goes too, so it chimes.
      S.update((s) => (s.messages.find((m) => m.id === result.id).ping = true));
      assert.equal(await S.flushState(3000), true);
      assert.equal(cloud.messages.find((m) => m.id === result.id)?.ping, true, `${how}: and its ping`);
      // Once the Mac runs Otto's routine next, that run's words are none of this runner's.
      const mac = structuredClone(cloud.state);
      routine(mac, "r-otto").last = { at: 90, status: "ok" };
      cloud.state = mac;
      cloud.version++;
      await S.pullState();
      const late = S.addMessage({ chatId: "bot:otto", role: "system", text: "late", routine: { id: "r-otto" } });
      warned.length = 0;
      await S.flushState(3000);
      assert.ok(!cloud.messages.some((m) => m.id === late.id), `${how}: nothing of a run that isn't its own`);
      assert.equal(cloud.refused, 0, `${how}: held on the runner, never sent to be refused`);
    };
    try {
      // A save holding Boppy's words is sending when Otto's turn answers, after the runner heard of the move:
      // the blob that save sends next records the run's end before the result goes.
      await begin();
      moveOtto();
      await S.pullState();
      warned.length = 0;
      S.addMessage({ chatId: "bot:main", role: "bot", botId: "main", text: "Morning brief is ready." });
      let result;
      cloud.whilePosting = () => void (result = answers());
      await S.flushState(3000);
      assert.ok(result, "the turn answered while the save was sending");
      await ended(result, "a save mid POST");
    } finally {
      await S.releaseSignOut();
    }
    try {
      // The runner hasn't heard of the move yet: its write gets a 409 from the Mac's move itself, while Otto's turn answers.
      await begin();
      moveOtto();
      warned.length = 0;
      // Something of its own to write: how Boppy is doing on its computer.
      S.update((s) => (s.bots.find((b) => b.id === "main").computerRam = 16));
      let result;
      cloud.whileRefusing = () => void (result = answers());
      await S.flushState(3000);
      assert.ok(result, "the turn answered while the write was refused");
      assert.equal(S.getState().bots.find((b) => b.id === "otto").computerId, D2, "the runner has the move now");
      await ended(result, "a 409 from the move write");
    } finally {
      await S.releaseSignOut();
    }
  });

  await check("a runner whose bot the Mac moved off its computer before the run's start reached Bops Cloud doesn't run it: the start is refused and taken back, and the routine stays due there for the Bops that has the bot now", async () => {
    process.env.BOPS_RUNNER = "1";
    process.env.BOPS_RUNNER_COMPUTER = D1;
    process.env.BOPS_DEVICE_SEED = D1;
    delete globalThis.bopsPlatformId;
    seed();
    // Otto shares Boppy's computer (D1), and has a routine of his own, due.
    cloud.state.bots.push({ id: "otto", name: "Otto", role: "Ops", color: "#222", isMain: false, computer: "shared", computerStatus: "ready" });
    cloud.state.routines.push({ id: "r-otto", botId: "otto", title: "C", goal: "c", schedule: { kind: "daily", times: ["09:00"] }, enabled: true, nextRunAt: 1 });
    cloud.version++;
    await S.bindSignIn(USER, "sk_runner");
    try {
      // The Mac gives Otto a computer of his own (no runner there yet), before the runner reads it.
      const mac = structuredClone(cloud.state);
      Object.assign(mac.bots.find((b) => b.id === "otto"), { computer: "own", computerId: D2 });
      cloud.state = mac;
      cloud.version++;
      cloud.writer = P.deviceIdFor(USER, "mac-a");
      // Meanwhile the runner begins Otto's 9:00 run on its last copy: its thread, the routine's clock and record, its chip.
      S.update((s) => {
        s.sessions.push({ id: "s-otto", botId: "otto", chatId: "bot:otto", by: RUNNER, status: "queued", title: "C", goal: "c", host: "orgo", steps: [], replies: [], createdAt: 1, routineId: "r-otto" });
        Object.assign(s.routines.find((r) => r.id === "r-otto"), { nextRunAt: 90, lastRunAt: 1, last: { at: 1, status: "running", sessionId: "s-otto" } });
      });
      S.addMessage({ chatId: "bot:otto", role: "system", text: "Routine · C", sessionIds: ["s-otto"] });
      const thread = (st) => Array.isArray(st.sessions) && st.sessions.some((x) => x.id === "s-otto");
      assert.equal(await S.startLanded(thread), false, "its thread never starts on the runner");
      const otto = cloud.state.bots.find((b) => b.id === "otto");
      assert.deepEqual([otto.computer, otto.computerId], ["own", D2], "the move stands");
      assert.ok(!cloud.state.sessions.some((x) => x.id === "s-otto"), "no thread of it in Bops Cloud");
      const r = cloud.state.routines.find((x) => x.id === "r-otto");
      assert.deepEqual([r.nextRunAt, r.last], [1, undefined], "the routine still due there: the Mac runs it, once");
      assert.ok(!cloud.messages.some((m) => m.sessionIds?.includes("s-otto")), "nor its chip");
      const st = S.getState();
      assert.ok(!st.sessions.some((x) => x.id === "s-otto"), "and nothing of it left going on the runner");
      assert.equal(st.routines.find((x) => x.id === "r-otto").nextRunAt, 1);
      // A run of a bot still on its computer lands, and starts.
      S.update((s) => {
        s.sessions.push({ id: "s-main", botId: "main", chatId: "bot:main", by: RUNNER, status: "queued", title: "A", goal: "a", host: "orgo", steps: [], replies: [], createdAt: 2, routineId: "r-main" });
        Object.assign(s.routines.find((x) => x.id === "r-main"), { nextRunAt: 90, lastRunAt: 2, last: { at: 2, status: "running", sessionId: "s-main" } });
      });
      assert.equal(await S.startLanded((x) => Array.isArray(x.sessions) && x.sessions.some((y) => y.id === "s-main")), true);
      assert.equal(cloud.state.sessions.find((x) => x.id === "s-main")?.by, RUNNER, "its thread is in Bops Cloud");
      // A start that reached Bops Cloud before the move is this runner's to finish (the check below this one).
    } finally {
      await S.releaseSignOut();
    }
  });

  await check("the Mac takes a runner's end of a run whose bot moved off its computer meanwhile, as it came", async () => {
    delete process.env.BOPS_RUNNER;
    delete process.env.BOPS_RUNNER_COMPUTER;
    process.env.BOPS_DEVICE_SEED = "mac-a";
    delete globalThis.bopsPlatformId;
    seed();
    // Iris works on D2; D1's runner runs her routine, begun before she moved.
    cloud.state.sessions.push({ id: "s-iris", botId: "iris", chatId: "bot:iris", by: RUNNER, status: "running", title: "B", goal: "b", host: "orgo", steps: [], replies: [], createdAt: 1 });
    cloud.state.routines[1].last = { at: 1, status: "running", sessionId: "s-iris" };
    cloud.version++;
    await S.bindSignIn(USER, "sk_mac");
    try {
      await S.flushState(3000);
      warned.length = 0;
      const next = structuredClone(cloud.state);
      Object.assign(next.sessions.find((x) => x.id === "s-iris"), { status: "done", answer: "Done" });
      next.routines[1].last = { at: 1, status: "ok", sessionId: "s-iris" };
      cloud.state = next;
      cloud.version++;
      cloud.writer = RUNNER;
      await S.pullState();
      const st = S.getState();
      assert.equal(st.sessions.find((x) => x.id === "s-iris").status, "done", "its thread's end taken");
      assert.equal(st.routines[1].last.status, "ok", "and its routine's record");
      assert.ok(!warned.some((l) => l.includes("wrote what a computer may not change")), warned.join(" | "));
    } finally {
      await S.releaseSignOut();
    }
  });

  await check("a runner never answers its own request for the user's OK: it never sends that (held on it), Bops Cloud refuses it, and the Mac puts it back; the owner's reply from the Mac reaches it", async () => {
    process.env.BOPS_RUNNER = "1";
    process.env.BOPS_RUNNER_COMPUTER = D1;
    process.env.BOPS_DEVICE_SEED = D1;
    delete globalThis.bopsPlatformId;
    seed();
    await S.bindSignIn(USER, "sk_runner");
    const ask = askOf({ id: "apr-run", threadId: "s-ask", askedBy: RUNNER, at: 5 });
    S.update((s) => {
      s.sessions.push({ id: "s-ask", botId: "main", chatId: "bot:main", by: RUNNER, status: "queued", title: "x", goal: "x", host: "orgo", steps: [], replies: [], createdAt: 1 });
      (s.appApprovals ??= []).push(structuredClone(ask));
    });
    assert.equal(await S.flushState(3000), true);
    assert.equal(cloud.refused, 0, "its request goes up, unanswered");
    assert.deepEqual(cloud.state.appApprovals, [ask]);
    // Something on the computer gets the runner to write a yes: it's held there, never sent.
    S.update((s) => (s.appApprovals[0].reply = { reply: "always", by: RUNNER, at: 6 }));
    assert.equal(await S.flushState(3000), true);
    assert.equal(cloud.refused, 0);
    assert.equal(cloud.state.appApprovals[0].reply, undefined, "Bops Cloud's copy still waits on the owner");
    // Sent anyway (a runner from before these rules): Bops Cloud refuses it.
    const res = await fetch(`${process.env.BOPS_CLOUD_URL}/v1/state`, {
      method: "PUT",
      headers: { "content-type": "application/json", "x-bops-device": RUNNER },
      body: JSON.stringify({ base: cloud.version, state: { ...cloud.state, appApprovals: [{ ...ask, reply: { reply: "once", by: RUNNER, at: 6 } }] } }),
    });
    assert.equal(res.status, 403);
    assert.deepEqual((await res.json()).paths, ["appApprovals.apr-run"]);
    await S.releaseSignOut();
    // And the Mac, reading such a write from a Bops Cloud from before the rules, puts it back as it was.
    delete process.env.BOPS_RUNNER;
    delete process.env.BOPS_RUNNER_COMPUTER;
    process.env.BOPS_DEVICE_SEED = "mac-a";
    delete globalThis.bopsPlatformId;
    await S.bindSignIn(USER, "sk_mac");
    await S.flushState(3000);
    const next = structuredClone(cloud.state);
    next.appApprovals[0].reply = { reply: "once", by: RUNNER, at: 6 };
    cloud.state = next;
    cloud.version++;
    cloud.writer = RUNNER;
    await S.pullState();
    assert.equal(S.getState().appApprovals[0].reply, undefined, "the Mac ignores a computer's reply");
    assert.equal(await S.flushState(3000), true);
    assert.equal(cloud.state.appApprovals[0].reply, undefined, "and writes it back unanswered");
    // The owner's own reply from the Mac goes up, and it's the runner's to read.
    S.update((s) => (s.appApprovals[0].reply = { reply: "once", by: S.stateDevice(), at: 7 }));
    assert.equal(await S.flushState(3000), true);
    assert.equal(cloud.state.appApprovals[0].reply?.reply, "once");
    await S.releaseSignOut();
  });

  await check("the Mac takes of a runner's write only what its computer may change, and writes the rest back as it was", async () => {
    delete process.env.BOPS_RUNNER;
    delete process.env.BOPS_RUNNER_COMPUTER;
    process.env.BOPS_DEVICE_SEED = "mac-a";
    delete globalThis.bopsPlatformId;
    seed();
    await S.bindSignIn(USER, "sk_mac");
    await S.flushState(3000);
    warned.length = 0;
    // The runner's write, right after the Mac's version (a cloud from before the computer rules let it through).
    const next = structuredClone(cloud.state);
    next.routines[0].nextRunAt = 99;
    next.bots[0].keys = ["K1", "STRIPE_SECRET_KEY"];
    next.bots[1].computerId = D1;
    cloud.state = next;
    cloud.version++;
    cloud.writer = RUNNER;
    await S.pullState();
    const st = S.getState();
    assert.equal(st.routines[0].nextRunAt, 99, "its routine's run taken");
    assert.deepEqual(st.bots[0].keys, ["K1"], "the key not");
    assert.equal(st.bots[1].computerId, D2, "nor the move");
    assert.ok(warned.some((l) => l.includes(`computer ${D1}'s runner wrote what a computer may not change`)), warned.join(" | "));
    assert.equal(await S.flushState(3000), true);
    const put = cloud.puts.at(-1);
    assert.equal(put.device, P.deviceIdFor(USER, "mac-a"), "written back by the Mac");
    assert.deepEqual([put.state.bots[0].keys, put.state.bots[1].computerId, put.state.routines[0].nextRunAt], [["K1"], D2, 99]);
    // Versions it skipped: it can't tell whose each change was, and takes them (Bops Cloud's guard is the first).
    const later = structuredClone(cloud.state);
    later.bots[0].keys = ["K1", "K2"];
    cloud.state = later;
    cloud.version += 2;
    cloud.writer = RUNNER;
    await S.pullState();
    assert.deepEqual(S.getState().bots[0].keys, ["K1", "K2"]);
    // Another Mac's write: all of it.
    const mac = structuredClone(cloud.state);
    mac.bots[0].keys = ["K3"];
    cloud.state = mac;
    cloud.version++;
    cloud.writer = P.deviceIdFor(USER, "mac-b");
    await S.pullState();
    assert.deepEqual(S.getState().bots[0].keys, ["K3"]);
    await S.releaseSignOut();
  });
} finally {
  console.info = quiet.info;
  console.warn = quiet.warn;
  server.close();
  process.chdir(tmpdir());
  rmSync(scratch, { recursive: true, force: true });
}

console.log(`computer scope: ${passed} passed, ${failures} failed`);
process.exit(failures ? 1 : 0);
