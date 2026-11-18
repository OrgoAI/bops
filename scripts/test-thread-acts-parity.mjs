// Parity between what Bops Cloud writes for a teammate's thread acts and answers in a workspace where everything goes
// through the cloud (cloud/thread-acts.ts) and what the owner's own Bops writes for the same act (lib/server/sessions.ts
// replyToSession, stopSession, dismissWaiting, compactThread, setWhere; lib/server/permission.ts replyToAsk), run here for
// real as "another Bops": this Bops's device is none of the threads' (Session.by is a computer's runner, or another Mac),
// so it does what the owner's Mac does for a thread it doesn't run. The helpers the cloud copies from the app (live,
// waitsForOk, pausedForOk, threadCompacts, threadCompactBlocked, COMPACTED, limitPick and its words, CARRY_ON, ASKS_AGAIN,
// keepsOffPreview) are checked equal to the app's own on many fixtures first.
//
// Where the cloud is meant to differ, the difference is asserted, and why: a thread the cloud picks up or ends is its
// runner's (`by` R) or Bops Cloud's own (`by` "cloud"), where the Mac makes it its own device's; a reply's id is the
// teammate's key (rep_m_<userId>_<key>), never a random one; the cloud never queues for the Mac, so a thread a Mac left
// behind goes to the bot's own computer; and a reply to an ask is "cloud"'s.
//
// The state is a throwaway file store in a temporary folder (BOPS_SELF_HOSTED), Orgo a fake fetch that says every
// computer is running, and modules that would start processes are stand-ins: nothing reaches a real service. The people
// and bots are made up.
// Usage: node --conditions=react-server scripts/test-thread-acts-parity.mjs
import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { registerHooks } from "node:module";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { pathToFileURL } from "node:url";

for (const k of Object.keys(process.env)) if (/^(BOPS|OPENAI|AGENTPHONE|AGENTMAIL|HONCHO|COMPOSIO|TYPESAFE|TWILIO|ORGO|CODEX)_/.test(k)) delete process.env[k];
process.env.BOPS_SELF_HOSTED = "1";
process.env.BOPS_ORGO_ORIGIN = "https://orgo.test";
process.env.BOPS_RESPONSES_WS = "0";
// A build with brains (lib/types.ts BRAINS_ON): the cloud takes a thread whose brain ran as from one.
process.env.NEXT_PUBLIC_BOPS_BRAINS = "1";
const root = new URL("..", import.meta.url).pathname.replace(/\/$/, "");
const STAND_INS = new Set(["mac", "relay", "desktop", "mirror"]);
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
  load(url, context, next) {
    const name = url.match(/\/lib\/server\/([a-z-]+)\.ts$/)?.[1];
    if (!name || !STAND_INS.has(name)) return next(url, context);
    const names = [...readFileSync(new URL(url), "utf8").matchAll(/^export (?:async )?(?:function\*? |const |let |class )([A-Za-z_$][\w$]*)/gm)].map((m) => m[1]);
    return { format: "module", shortCircuit: true, source: names.map((n) => `export const ${n} = function () { return Promise.resolve(); };`).join("\n") };
  },
});
const scratch = mkdtempSync(join(tmpdir(), "bops-test-thread-parity-"));
process.chdir(scratch);
process.env.HOME = scratch;
// Signed in already: the key is in memory, so the Keychain is never asked (lib/server/orgo-auth.ts).
globalThis.bopsOrgoKey = "sk_test_parity";
// Orgo: every computer is up (a wake for a queued thread finds it running: no step is added).
globalThis.fetch = async (input, init = {}) => {
  const url = new URL(new Request(input, init).url);
  if (url.origin !== "https://orgo.test") throw new TypeError(`fetch failed (not the fake Orgo: ${url})`);
  return new Response(JSON.stringify({ id: "c-max", status: "running" }), { status: 200, headers: { "content-type": "application/json" } });
};

const L = await import(`${root}/lib/types.ts`);
const S = await import(`${root}/lib/server/store.ts`);
const X = await import(`${root}/lib/server/sessions.ts`);
const P = await import(`${root}/lib/server/permission.ts`);
const CLI = await import(`${root}/lib/server/cli-agents.ts`);
const RT = await import(`${root}/lib/server/routing.ts`);
const H = await import(`${root}/lib/server/hosted-apps.ts`);
const T = await import(`${root}/cloud/thread-acts.ts`);
const { deviceIdOf } = await import(`${root}/cloud/device.ts`);

let passed = 0;
let failed = 0;
const test = async (name, f) => {
  try {
    await f();
    passed++;
    console.log(`ok - ${name}`);
  } catch (e) {
    failed++;
    console.error(`FAIL ${name}\n  ${e.message}`);
  }
};
const later = (ms = 30) => new Promise((r) => setTimeout(r, ms));
const clone = (v) => structuredClone(v);
const pick = (o, keys) => Object.fromEntries(keys.map((k) => [k, o?.[k]]));

/* ---------------- The helpers the cloud copies ---------------- */

const statuses = ["queued", "starting", "running", "done", "failed", "stopped", undefined];
const askFixtures = [
  [],
  [{ id: "a1", threadId: "t", askedBy: "dev-r" }],
  [{ id: "a1", threadId: "t", askedBy: "dev-r", reply: { reply: "once", at: 1 } }],
  [{ id: "a1", threadId: "t", askedBy: "dev-other" }],
  [{ id: "a1", threadId: "t" }],
  [{ id: "a1", threadId: "t", askedBy: "dev-r", resume: { engine: "held" } }],
  [{ id: "a1", threadId: "t", askedBy: "dev-r", resume: { engine: "responses" } }],
  [{ id: "a1", threadId: "other", askedBy: "dev-r" }],
];

await test("live, waitsForOk and pausedForOk are the app's own, on every status, device and ask", () => {
  let n = 0;
  for (const status of statuses)
    for (const by of ["dev-r", undefined, "dev-other"])
      for (const asks of askFixtures) {
        const s = { id: "t", status, ...(by ? { by } : {}) };
        const st = { appApprovals: asks };
        assert.equal(T.live(s), L.live(s), `live ${status}`);
        assert.equal(T.waitsForOk(s, st), L.waitsForOk(s, st), `waitsForOk ${status} ${by} ${JSON.stringify(asks)}`);
        assert.equal(T.pausedForOk(s, st), L.pausedForOk(s, st), `pausedForOk ${status} ${by} ${JSON.stringify(asks)}`);
        n++;
      }
  assert.ok(n > 100);
});

await test("threadCompacts, threadCompactBlocked and COMPACTED are the app's own (a build with brains)", () => {
  assert.equal(L.BRAINS_ON, true, "set before the app's types load");
  assert.equal(T.COMPACTED, L.COMPACTED);
  const brains = [undefined, { kind: "claude", started: true }, { kind: "claude" }, { kind: "codex", started: true }, { kind: "opencode", started: true }];
  const agent = [{}, { onBopsAgent: true }, { agentSessionId: "as_1" }, { responseId: "r_1" }, { responseId: "r_1", agentSessionId: "as_1" }, { onBopsAgent: true, responseId: "r_1" }];
  for (const brainRun of brains)
    for (const a of agent)
      for (const runsOn of [undefined, "cloud", "mac"]) {
        const s = { id: "t", status: "done", steps: [], replies: [], ...(brainRun ? { brainRun } : {}), ...a, ...(runsOn ? { runsOn } : {}) };
        assert.equal(T.threadCompacts(s), L.threadCompacts(s), JSON.stringify(s));
      }
  const blocked = [
    { status: "running", steps: [], replies: [] },
    { status: "done", compact: { at: 1 }, steps: [], replies: [] },
    { status: "done", steps: [{ at: 10, tool: "compacted", detail: "" }], replies: [] },
    { status: "done", steps: [{ at: 10, tool: "compacted", detail: "" }], replies: [{ id: "r", role: "user", text: "x", at: 5 }] },
    { status: "done", steps: [{ at: 10, tool: "compacted", detail: "" }], replies: [{ id: "r", role: "user", text: "x", at: 11 }] },
    { status: "failed", steps: [{ at: 1, tool: "note", detail: "" }], replies: [] },
  ];
  for (const s of blocked) assert.equal(T.threadCompactBlocked(s), L.threadCompactBlocked(s), JSON.stringify(s));
});

await test("limitPick and its words, CARRY_ON, ASKS_AGAIN and keepsOffPreview are the app's own", () => {
  assert.deepEqual([T.FINISH_ON_BOPS, T.WAIT, T.TRY_AGAIN], [CLI.FINISH_ON_BOPS, CLI.WAIT, CLI.TRY_AGAIN]);
  for (const t of ["Wait", "wait.", " WAIT! ", "Try again", "try again.", "Finish on Bops agent", "finish on bops agent!", "Wait for it", "again", "", "Try again later"])
    assert.equal(T.limitPick(t), CLI.limitPick(t), t);
  // sessions.ts keeps CARRY_ON to itself: read from its source (and seen as the reply's words on Try again, below).
  const src = readFileSync(`${root}/lib/server/sessions.ts`, "utf8");
  assert.equal(src.match(/^const CARRY_ON = (".*");$/m)?.[1], JSON.stringify(T.CARRY_ON));
  assert.deepEqual([T.ASKS_AGAIN.source, T.ASKS_AGAIN.flags], [RT.ASKS_AGAIN.source, RT.ASKS_AGAIN.flags]);
  for (const t of ["Try again", "that's wrong", "Not what I asked", "redo it", "looks great", "wrong answer", "do it again please", "again"]) assert.equal(T.ASKS_AGAIN.test(t), RT.ASKS_AGAIN.test(t), t);
  const phrases = [
    "Make the title bigger",
    "Make it bigger but don't deploy yet",
    "don't put it on the Preview",
    "never deploy this",
    "hold off on deploying",
    "deploy it later",
    "I don't see it on the Preview",
    "It's not on the Preview yet",
    "the preview still shows the old title",
    "wait to deploy until Monday",
    "keep it off the Preview",
    "no deploy please",
    "redeploy it",
    "Deploy now. Then stop.",
    "don't forget to deploy",
    "and not on the preview",
    "without redeploying",
  ];
  for (const t of phrases) assert.equal(T.keepsOffPreview(t), H.keepsOffPreview(t), t);
});

/* ---------------- The same act, on the Mac and in the cloud ---------------- */

const OWNER = "user_owner";
// Max works on his own computer, whose runner is up; R is that runner's device (device.ts deviceIdOf, as Bops Cloud has it).
const R = deviceIdOf(OWNER, "c-max");
const MAC = "dev-mac-other";
const SAM = { userId: "u_sam", name: "Sam" };
const said = (key) => ({ ...SAM, ref: key });
const BOTS = [
  { id: "max", name: "Max", workspaceId: "ws_acme", computerId: "c-max" },
  { id: "ivy", name: "Ivy", workspaceId: "ws_acme" },
];
/** A fixture: its threads, asks, runners and the other Macs the state knows. */
const fixture = (sessions, o = {}) => ({
  account: { user: { id: OWNER, email: "alex@example.com" } },
  owner: { name: "Alex" },
  host: "orgo",
  bots: clone(BOTS),
  runners: o.runners ?? { "c-max": { status: "running", version: "0.0.54" } },
  macs: o.macs ?? {},
  sessions,
  appApprovals: o.asks ?? [],
});
const thread = (id, o = {}) => ({ id, botId: "max", chatId: "bot:max", title: "Book it", goal: "Book it", sentVia: "you", host: "orgo", status: "done", by: R, steps: [], replies: [], createdAt: 1, ...o });

/** The fixture loaded on this Bops (the owner's other Bops), `act` done there, and the state after. */
async function onMac(fx, act) {
  S.update((s) => {
    s.account = clone(fx.account);
    s.host = fx.host;
    s.runners = clone(fx.runners);
    s.macs = clone(fx.macs);
    s.bots = [...s.bots.filter((b) => !BOTS.some((x) => x.id === b.id)), ...clone(fx.bots)];
    s.sessions = clone(fx.sessions);
    s.appApprovals = clone(fx.appApprovals);
  });
  const out = await act();
  return { state: clone(S.getState()), out };
}
/** What Bops Cloud knows of Max's computer: its runner R, listening unless said, ready unless said. */
const env = (o = {}) => ({
  now: Date.now(),
  macOn: o.macOn ?? false,
  owner: "Alex",
  computerOf: (id) => (id === "max" ? { desktop: "c-max", devices: [R], listening: o.listening ?? true, runner: o.runner ?? "ok" } : null),
});
const threadOf = (st, id) => st.sessions.find((s) => s.id === id);
/** As the state is kept and synced: JSON (a field set to undefined in memory is no field). */
const asSaved = (v) => (v === undefined ? undefined : JSON.parse(JSON.stringify(v)));
/** A thread's replies as both sides keep them: everything but their id and time. */
const repliesOf = (t) =>
  asSaved(
    (t.replies ?? []).map((r) => {
      const rest = { ...r };
      delete rest.id;
      delete rest.at;
      return rest;
    }),
  );
const THREAD_FIELDS = ["status", "error", "endedAt", "stopAsked", "options", "waitingOnYou", "onBopsAgent", "askWhere", "runsOn", "dismissed", "blocker", "display", "offerMac"];
/** The thread's fields both sides must agree on, its replies, its brain's wait and route's bumps. */
const same = (t) => asSaved({ ...pick(t, THREAD_FIELDS), endedAt: t.endedAt ? "set" : undefined, replies: repliesOf(t), waits: t.brainRun?.waits, bumps: t.route?.bumps, deployAfter: t.app?.deployAfter });

await test("a reply to a thread running on the bot's computer: kept and left to its runner, on both", async () => {
  const fx = fixture([thread("t-steer", { status: "running" })]);
  const { state } = await onMac(fx, () => X.replyToSession("t-steer", "Use the window seat", undefined, undefined, said("k-steer")));
  const cloud = T.replyIn(clone(fx), "t-steer", "Use the window seat", SAM, "k-steer", env()).blob;
  const [m, c] = [threadOf(state, "t-steer"), threadOf(cloud, "t-steer")];
  assert.deepEqual(same(c), same(m));
  assert.deepEqual([m.by, c.by], [R, R]);
  // The reply's id: the teammate's key on the cloud (a retry finds it), a fresh one on the Mac.
  assert.equal(c.replies[0].id, "rep_m_u_sam_k-steer");
  assert.notEqual(m.replies[0].id, c.replies[0].id);
});

await test("a reply to an ended thread its computer ran: queued again for that runner (by R), what ended it cleared, on both", async () => {
  const fx = fixture([thread("t-again", { status: "failed", error: "It broke", endedAt: 5, stopAsked: "Stopped by Kim" })]);
  const { state } = await onMac(fx, () => X.replyToSession("t-again", "Try once more", undefined, undefined, said("k-again")));
  const cloud = T.replyIn(clone(fx), "t-again", "Try once more", SAM, "k-again", env()).blob;
  const [m, c] = [threadOf(state, "t-again"), threadOf(cloud, "t-again")];
  assert.deepEqual(same(c), same(m));
  assert.deepEqual([m.status, m.by, c.by], ["queued", R, R]);
  await later();
});

await test("a brain's limit picks: Wait, Try again on a brain that began, Finish on Bops agent, on both", async () => {
  const limit = (id, o = {}) => thread(id, { options: [T.FINISH_ON_BOPS, T.WAIT, T.TRY_AGAIN], waitingOnYou: true, brainRun: { brainId: "b1", kind: "claude", computerId: "c-max", cli: "claude", waits: "limit", ...o } });
  for (const [id, text, o] of [
    ["t-wait", "Wait", {}],
    ["t-retry", "Try again", { started: true }],
    ["t-retry0", "Try again", {}],
    ["t-bops", "Finish on Bops agent", { started: true }],
  ]) {
    const fx = fixture([limit(id, o)]);
    const { state } = await onMac(fx, () => X.replyToSession(id, text, undefined, undefined, said(`k-${id}`)));
    const cloud = T.replyIn(clone(fx), id, text, SAM, `k-${id}`, env()).blob;
    assert.deepEqual(same(threadOf(cloud, id)), same(threadOf(state, id)), id);
    assert.equal(threadOf(cloud, id).by, threadOf(state, id).by, `${id}: its runner's either way`);
  }
  await later();
});

await test("the router's bump after a failure or \"that's wrong\", and none otherwise, on both", async () => {
  for (const [id, status, text] of [
    ["t-bump1", "failed", "Go on"],
    ["t-bump2", "done", "That's wrong, redo it"],
    ["t-bump3", "done", "Thanks, and the next one"],
  ]) {
    const fx = fixture([thread(id, { status, route: { by: "router", tier: "fast" } })]);
    const { state } = await onMac(fx, () => X.replyToSession(id, text, undefined, undefined, said(`k-${id}`)));
    const cloud = T.replyIn(clone(fx), id, text, SAM, `k-${id}`, env()).blob;
    assert.deepEqual(same(threadOf(cloud, id)), same(threadOf(state, id)), id);
  }
  await later();
});

await test("a reply to a task on an app that put a change on its Preview puts this one there too, unless it says not to (askDeployAgain first, as member-acts.ts does)", async () => {
  for (const [id, text, app] of [
    ["t-app1", "Make the title bigger", { from: "abc" }],
    ["t-app2", "Make it bigger but don't deploy yet", { from: "abc" }],
    ["t-app3", "Bigger", {}],
    ["t-app4", "Bigger", { from: null }],
  ]) {
    const fx = fixture([thread(id, { status: "running", app: { wsId: "ws_acme", name: "demo-app", ...app } })]);
    const { state } = await onMac(fx, () => {
      H.askDeployAgain(id, text);
      X.replyToSession(id, text, undefined, undefined, said(`k-${id}`));
    });
    const cloud = T.replyIn(clone(fx), id, text, SAM, `k-${id}`, env()).blob;
    assert.deepEqual(same(threadOf(cloud, id)), same(threadOf(state, id)), id);
  }
});

await test("a reply to a thread a Mac left behind: the Mac picks it up itself; the cloud hands it to the bot's computer (never the Mac), saying what's lost", async () => {
  const fx = fixture([thread("t-behind", { status: "running", by: MAC, runsOn: "cloud" })], { macs: { [MAC]: {} } });
  const { state } = await onMac(fx, () => X.replyToSession("t-behind", "Carry on", undefined, undefined, said("k-behind")));
  const cloud = T.replyIn(clone(fx), "t-behind", "Carry on", SAM, "k-behind", env({ macOn: false })).blob;
  const [m, c] = [threadOf(state, "t-behind"), threadOf(cloud, "t-behind")];
  assert.deepEqual(asSaved(pick(c, ["status", "error", "stopAsked"])), asSaved(pick(m, ["status", "error", "stopAsked"])));
  assert.deepEqual(repliesOf(c), repliesOf(m));
  // The Mac makes it its own (this Bops's device, none on a self hosted store); the cloud, the bot's runner's.
  assert.equal(m.by, undefined);
  assert.equal(c.by, R);
  await later(100);
});

await test("Stop on a thread its runner runs: asked to stop (stopAsked), on both; and on its parts", async () => {
  const fx = fixture([thread("t-stop", { status: "running" }), thread("t-stop-part", { status: "running", partOf: "t-stop" }), thread("t-stop-done", { status: "done", partOf: "t-stop" })]);
  const { state } = await onMac(fx, () => X.stopSession("t-stop", "Stopped by Sam"));
  const cloud = T.stopIn(clone(fx), ["t-stop"], "Stopped by Sam", env()).blob;
  for (const id of ["t-stop", "t-stop-part", "t-stop-done"]) {
    assert.deepEqual(same(threadOf(cloud, id)), same(threadOf(state, id)), id);
    assert.equal(threadOf(cloud, id).by, threadOf(state, id).by, id);
  }
  assert.equal(threadOf(state, "t-stop").stopAsked, "Stopped by Sam");
});

await test("Stop on a run paused at an OK nobody answered: over here and now (endPaused), its asks rejected, on both", async () => {
  const asks = [{ id: "ask-p", botId: "max", threadId: "t-paused", askedBy: R, action: "Send an email", kind: "email", at: 1, resume: { engine: "responses", responseId: "resp_1", callId: "call_1" } }];
  const fx = fixture([thread("t-paused", { status: "running", display: 100, offerMac: true, blocker: "x" })], { asks });
  const { state } = await onMac(fx, () => X.stopSession("t-paused", "Stopped by Sam"));
  const cloud = T.stopIn(clone(fx), ["t-paused"], "Stopped by Sam", env()).blob;
  assert.deepEqual(same(threadOf(cloud, "t-paused")), same(threadOf(state, "t-paused")));
  assert.equal(threadOf(cloud, "t-paused").by, threadOf(state, "t-paused").by, "endPaused leaves who ran it as it was");
  const [ma, ca] = [state.appApprovals.find((a) => a.id === "ask-p"), cloud.appApprovals.find((a) => a.id === "ask-p")];
  assert.deepEqual(pick(ca.reply, ["reply", "reason"]), pick(ma.reply, ["reply", "reason"]));
  // Who rejected it: Bops Cloud's own name for itself; the Mac its device (none on a self hosted store).
  assert.deepEqual([ma.reply.by, ca.reply.by], [undefined, "cloud"]);
});

await test("Stop on a thread a Mac left behind, or a runner that failed: over now (endSessionOf), a stop asked before it the one it ends with, on both", async () => {
  const cases = [
    ["t-left", fixture([thread("t-left", { status: "running", by: MAC, stopAsked: "Stopped by Kim", display: 99 })], { macs: { [MAC]: {} } }), env({ macOn: false })],
    ["t-failed", fixture([thread("t-failed", { status: "running" })], { runners: { "c-max": { status: "failed", version: "0.0.54" } } }), env({ listening: false, runner: "none" })],
  ];
  for (const [id, fx, e] of cases) {
    fx.appApprovals = [{ id: `ask-${id}`, botId: "max", threadId: id, askedBy: "dev-x", action: "Call Stripe", kind: "api", at: 1 }];
    const { state } = await onMac(fx, () => X.stopSession(id, "Stopped by Sam"));
    const cloud = T.stopIn(clone(fx), [id], "Stopped by Sam", e).blob;
    const [m, c] = [threadOf(state, id), threadOf(cloud, id)];
    assert.deepEqual(same(c), same(m), id);
    // Ended as the Bops that stopped it: Bops Cloud's ("cloud", so no stale copy brings it back); the Mac's own device (none here).
    assert.deepEqual([m.by, c.by], [undefined, "cloud"], id);
    const [ma, ca] = [state.appApprovals[0], cloud.appApprovals[0]];
    assert.deepEqual(asSaved(pick(ca.reply, ["reply", "reason"])), asSaved(pick(ma.reply, ["reply", "reason"])), id);
    assert.deepEqual([ma.reply.by, ca.reply.by], [undefined, "cloud"]);
  }
});

await test("Nothing to add: stopped, then marked dismissed with nothing waiting on anyone, on both; an ended one only marked", async () => {
  for (const [id, status] of [
    ["t-dismiss", "running"],
    ["t-dismiss-done", "done"],
  ]) {
    const fx = fixture([thread(id, { status, waitingOnYou: true, blocker: "x", options: ["a", "b"] })]);
    const { state } = await onMac(fx, () => X.dismissWaiting(id, "Dismissed by Sam"));
    const cloud = T.dismissIn(clone(fx), id, SAM, env()).blob;
    assert.deepEqual(same(threadOf(cloud, id)), same(threadOf(state, id)), id);
  }
});

await test("Compact on a thread its computer ran: kept as theirs and queued again for that runner, on both", async () => {
  const fx = fixture([thread("t-compact", { status: "done", endedAt: 7, brainRun: { brainId: "b1", kind: "claude", computerId: "c-max", cli: "claude", started: true } })]);
  const { state, out } = await onMac(fx, () => X.compactThread("t-compact", said("k-compact")));
  assert.deepEqual(out, { ok: true });
  const cloud = T.compactIn(clone(fx), "t-compact", SAM, "k-compact", env()).blob;
  const [m, c] = [threadOf(state, "t-compact"), threadOf(cloud, "t-compact")];
  assert.deepEqual(same(c), same(m));
  assert.deepEqual([m.by, c.by], [R, R]);
  assert.deepEqual(asSaved({ ...c.compact, at: 0 }), asSaved({ ...m.compact, at: 0 }), "who pressed it and what it was, alike");
  // Refused alike: a brain that doesn't compact, and one that ran since with nothing new.
  const codex = fixture([thread("t-codex", { brainRun: { brainId: "b2", kind: "codex", computerId: "c-max", cli: "codex", started: true } })]);
  const { out: no } = await onMac(codex, () => X.compactThread("t-codex", said("k-codex")));
  assert.equal(no.status, 400);
  assert.throws(() => T.compactIn(clone(codex), "t-codex", SAM, "k-codex", env()), (e) => e.status === 400 && e.message === no.error);
  const nothing = fixture([thread("t-nothing", { responseId: "resp_1", steps: [{ at: 10, tool: "compacted", detail: "" }] })]);
  const { out: wait } = await onMac(nothing, () => X.compactThread("t-nothing", said("k-nothing")));
  assert.equal(wait.status, 409);
  assert.throws(() => T.compactIn(clone(nothing), "t-nothing", SAM, "k-nothing", env()), (e) => e.status === 409 && e.message === wait.error);
  await later();
});

await test("Where: the bot's computer, picked, on both; the cloud's run is its runner's from the start", async () => {
  const fx = fixture([thread("t-where", { status: "queued", askWhere: true, by: undefined })]);
  const { state } = await onMac(fx, () => X.setWhere("t-where", "cloud"));
  const cloud = T.whereIn(clone(fx), "t-where", SAM, "k-where", env()).blob;
  const [m, c] = [threadOf(state, "t-where"), threadOf(cloud, "t-where")];
  assert.deepEqual(asSaved(pick(c, ["askWhere", "runsOn", "status"])), asSaved(pick(m, ["askWhere", "runsOn", "status"])));
  // The Mac runs it itself (this Bops's device); Bops Cloud never runs a thread, so it's the runner's.
  assert.deepEqual([m.by, c.by], [undefined, R]);
  await later(100);
});

await test("an answer: Allow once, Deny with words, Always allow (the rule, and the bot's other asks for it, never a task's write), on both", async () => {
  const asks = () => [
    { id: "ask-1", botId: "max", chatId: "bot:max", action: "Call Stripe", kind: "api", askedBy: R, at: 1 },
    { id: "ask-2", botId: "max", chatId: "bot:max", action: "Call Stripe", kind: "api", askedBy: R, at: 2 },
    { id: "ask-3", botId: "max", threadId: "t-ans", action: "Call Stripe", kind: "api", askedBy: R, at: 3 },
    { id: "ask-4", botId: "max", chatId: "bot:max", action: "Call Stripe", kind: "api", askedBy: R, askedFor: "Kim", at: 4 },
    { id: "ask-5", botId: "max", chatId: "bot:max", action: "Send an email", kind: "email", askedBy: R, at: 5 },
  ];
  for (const [askId, reply, message] of [
    ["ask-5", "once", undefined],
    ["ask-5", "reject", "  Ask Kim first  "],
    ["ask-1", "always", undefined],
  ]) {
    const fx = fixture([thread("t-ans", { status: "running" })], { asks: asks() });
    const { state, out } = await onMac(fx, () => P.replyToAsk(askId, reply, message, SAM));
    assert.equal(out, undefined, `${askId} ${reply}: taken on the Mac`);
    const cloud = T.answerIn(clone(fx), askId, reply, message, SAM, Date.now()).blob;
    const answers = (st) => asSaved(st.appApprovals.map((a) => [a.id, a.reply ? pick(a.reply, ["reply", "message", "member", "reason"]) : null]));
    assert.deepEqual(answers(cloud), answers(state), `${askId} ${reply}`);
    // Who answered: Bops Cloud ("cloud") on its side, the Mac's device (none here) on the Mac's.
    for (const a of cloud.appApprovals.filter((x) => x.reply)) assert.equal(a.reply.by, "cloud");
    for (const a of state.appApprovals.filter((x) => x.reply)) assert.equal(a.reply.by, undefined);
    const rules = (st) => st.bots.find((b) => b.id === "max").permissions ?? [];
    assert.deepEqual(rules(cloud), rules(state), `${askId} ${reply}: the bot's rules`);
  }
  await later();
});

console.log(`\nthread acts parity: ${passed} passed, ${failed} failed`);
await later(200);
rmSync(scratch, { recursive: true, force: true });
process.exit(failed ? 1 : 0);
