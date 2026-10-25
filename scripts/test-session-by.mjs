// Tests for whose threads are whose (Session.by, lib/server/store.ts ownSession): a Bops that starts
// (or signs in) marks only its own threads failed, "Bops restarted while this was running", and leaves
// another Mac's and a computer's runner's going, but for one another Mac left behind (no sign of work from
// that Mac on any of its threads for ten minutes: it ends here, as this Mac's), never one paused for the owner's OK at
// that Mac's own request; a run of this Mac's paused for the OK stays paused, its request kept, answered or not (the
// request and OpenAI are enough to go on); a thread from before Session.by is the Mac's, never a
// runner's. Also what the store tells the routines timer (lib/server/persist-cloud.ts): which device this
// is, when the state was last read, and that a newer Bops wrote the state (426 state_too_new), which
// stops the timer until a read or a write lands again.
//
// Bops Cloud is a fake on localhost (below), and the working folder a throwaway one, so nothing reaches
// the real cloud or the user's files.
// Usage: node --conditions=react-server scripts/test-session-by.mjs
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { createServer } from "node:http";
import { registerHooks } from "node:module";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { pathToFileURL } from "node:url";

for (const k of Object.keys(process.env)) if (/^(BOPS|ORGO)_/.test(k)) delete process.env[k];
const root = new URL("..", import.meta.url).pathname.replace(/\/$/, "");
const scratch = mkdtempSync(join(tmpdir(), "bops-test-session-by-"));
process.chdir(scratch);
process.env.HOME = scratch;
process.env.BOPS_DEVICE_SEED = "mac-a";

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

let failures = 0;
let passed = 0;
async function check(name, fn) {
  try {
    await fn();
    passed++;
  } catch (e) {
    failures++;
    console.error(`FAIL ${name}\n  ${e.message.split("\n").join("\n  ")}${process.env.STACK ? `\n${e.stack}` : ""}`);
  }
}

// Bops Cloud, faked: one user's blob, no messages. `refuse` answers 426 state_too_new to every call.
const cloud = { version: 1, state: {}, refuse: false, puts: 0 };
const server = createServer((req, res) => {
  let body = "";
  req.on("data", (c) => (body += c));
  req.on("end", () => {
    const send = (status, json) => {
      res.writeHead(status, { "content-type": "application/json" });
      res.end(JSON.stringify(json));
    };
    if (cloud.refuse) return send(426, { error: "Another of your Macs is on a newer Bops. Update Bops on this Mac to keep your chats in sync.", code: "state_too_new" });
    const path = req.url.split("?")[0];
    if (req.method === "GET" && path === "/v1/state") return send(200, { version: cloud.version, seq: 0, protocol: 4, writer: "mac-b", state: cloud.state });
    if (req.method === "GET" && path === "/v1/state/head") return send(200, { version: cloud.version, seq: 0, writer: "mac-b" });
    if (req.method === "GET" && path === "/v1/messages") return send(200, { messages: [], seq: 0, more: false });
    if (req.method === "POST" && path === "/v1/messages") return send(200, { seq: 0 });
    if (req.method === "PUT" && path === "/v1/state") {
      cloud.puts++;
      cloud.state = JSON.parse(body).state;
      return send(200, { version: ++cloud.version });
    }
    send(404, { error: "no such route" });
  });
});
await new Promise((r) => server.listen(0, "127.0.0.1", r));
process.env.BOPS_CLOUD_URL = `http://127.0.0.1:${server.address().port}`;

const quiet = { info: console.info, warn: console.warn };
console.info = () => {};
console.warn = () => {};

const S = await import(`${root}/lib/server/store.ts`);
const P = await import(`${root}/lib/server/persist-cloud.ts`);
const USER = "u_session_by";
const ME = P.deviceIdFor(USER);
const RUNNER = P.deviceIdFor(USER, "c1c1c1c1-0000-4000-8000-000000000001");
const OTHER_MAC = P.deviceIdFor(USER, "mac-b");
const QUIET_MAC = P.deviceIdFor(USER, "mac-c");
const thread = (id, status, by) => ({ id, botId: "boppy", chatId: "bot:boppy", sentVia: "you", title: id, goal: id, host: "orgo", status, steps: [], replies: [], createdAt: 1, ...(by ? { by } : {}) });
const seed = () => {
  cloud.state = {
    bots: [{ id: "boppy", name: "Boppy", role: "Chief of Staff", color: "#000", isMain: true, computerStatus: "ready" }],
    sessions: [
      thread("mine", "running", ME),
      thread("runner", "running", RUNNER),
      // Another Mac at work (a step a moment ago), with one queued behind it since long ago (its bot's screens all busy).
      { ...thread("other_mac_busy", "running", OTHER_MAC), steps: [{ at: Date.now(), tool: "note", detail: "Typing the reply" }] },
      thread("other_mac", "queued", OTHER_MAC),
      // A Mac with no sign of work on any of its threads for ten minutes.
      thread("other_mac_quiet", "running", QUIET_MAC),
      thread("other_mac_quiet_queued", "queued", QUIET_MAC),
      thread("before", "starting"),
      thread("done", "done", RUNNER),
    ],
    macs: { [OTHER_MAC]: { mac: { ready: true, rules: [] } }, [QUIET_MAC]: { mac: { ready: true, rules: [] } } },
  };
  cloud.version++;
};
const statusOf = (id) => S.getState().sessions.find((s) => s.id === id);

try {
  await check("a device id per Bops: this Mac's, and a runner's from its computer's id", () => {
    assert.match(ME, /^[0-9a-f]{16}$/);
    assert.notEqual(ME, RUNNER);
    assert.equal(P.deviceIdFor(USER, "mac-a"), ME, "BOPS_DEVICE_SEED stands in for the hardware id");
    assert.equal(S.stateDevice(), null, "signed out: none");
  });

  await check("the Mac signing in fails its own threads and those from before, and leaves the others' going", async () => {
    seed();
    await S.bindSignIn(USER, "sk_test");
    assert.equal(S.stateDevice(), ME);
    assert.deepEqual([statusOf("mine").status, statusOf("mine").error], ["failed", "Bops restarted while this was running"]);
    assert.equal(statusOf("before").status, "failed", "from before Session.by: the Mac's");
    assert.equal(statusOf("runner").status, "running", "a runner's thread runs on there");
    assert.equal(statusOf("other_mac").status, "queued", "another Mac's waits for it there, however long, while that Mac is at work");
    assert.equal(statusOf("other_mac_busy").status, "running");
    // Another Mac's with no sign of work from that Mac for ten minutes: left behind there (closed, asleep or quit), so
    // it ends here, as this Mac's (a computer's runner's quiet one is left to the Mac's look at its runner).
    assert.deepEqual([statusOf("other_mac_quiet").status, statusOf("other_mac_quiet").error, statusOf("other_mac_quiet").by], ["failed", S.LEFT_BEHIND, ME]);
    assert.deepEqual([statusOf("other_mac_quiet_queued").status, statusOf("other_mac_quiet_queued").error], ["failed", S.LEFT_BEHIND], "one queued there too");
    assert.equal(statusOf("runner").createdAt, 1, "the runner's is as quiet");
    assert.equal(statusOf("done").status, "done");
    assert.equal(S.ownSession(statusOf("mine")), true);
    assert.equal(S.ownSession({}), true, "unset: the Mac's");
    assert.equal(S.ownSession(statusOf("runner")), false);
    assert.equal(S.ownSession(statusOf("other_mac")), false);
    assert.ok(S.statePulledAt() > 0, "read at sign-in");
    assert.equal(S.stateTooNew(), false);
    // What the sweep changed goes up before the next sign-in, so nothing is kept aside for it.
    assert.equal(await S.flushState(3000), true);
  });

  await check("signing in, a run paused for the OK is never over: its request and its thread stay as they are, here (answered or not) and on another Mac; a left-behind thread ends without touching a request; requests from before, or held by a run that's gone, go", async () => {
    await S.releaseSignOut();
    const D_MAC = P.deviceIdFor(USER, "mac-d");
    const resume = { engine: "responses", responseId: "resp_1", callId: "call_1", call: { name: "use_app", arguments: "{}" } };
    const ask = (id, o) => ({ id, botId: "boppy", chatId: "bot:boppy", action: "Send Email in Gmail", resources: ["dana@example.com"], preview: "to: dana@example.com", at: 2, resume, ...o });
    cloud.state = {
      bots: [{ id: "boppy", name: "Boppy", role: "Chief of Staff", color: "#000", isMain: true, computerStatus: "ready" }],
      sessions: [
        // Quiet for hours on Mac C, paused for the owner's OK at what it asked there: a pause, not a Mac gone.
        thread("waits_on_ok", "queued", QUIET_MAC),
        // Quiet on Mac C with a request of another Mac's (one from an earlier Mac it ran on): left behind.
        thread("left_with_ask", "running", QUIET_MAC),
        // This Mac's own, paused: one unanswered, one answered while this Mac was down.
        thread("mine_waits", "queued", ME),
        thread("mine_answered", "queued", ME),
        // This Mac's own, working when it stopped: restarted.
        thread("mine_working", "running", ME),
      ],
      appApprovals: [
        ask("apr_waits", { threadId: "waits_on_ok", askedBy: QUIET_MAC }),
        ask("apr_older", { threadId: "left_with_ask", askedBy: D_MAC }),
        ask("apr_mine", { threadId: "mine_waits", askedBy: ME }),
        ask("apr_answered", { threadId: "mine_answered", askedBy: ME, reply: { reply: "once", by: OTHER_MAC, at: 3 } }),
        // A brain's call held by a run of this Mac's, gone with it.
        ask("apr_held", { threadId: "mine_working", askedBy: ME, resume: { engine: "held" } }),
        // From before requests: an ask with a status and no record of what resumes it.
        { id: "apr_old", botId: "boppy", app: "gmail", action: "GMAIL_SEND_EMAIL", title: "Send email in Gmail", detail: "d", at: 1, status: "allowed", by: ME },
      ],
      macs: { [OTHER_MAC]: { mac: { ready: true, rules: [] } }, [QUIET_MAC]: { mac: { ready: true, rules: [] } } },
    };
    cloud.version++;
    await S.bindSignIn(USER, "sk_test");
    const askOf = (id) => S.getState().appApprovals.find((a) => a.id === id);
    assert.deepEqual([statusOf("waits_on_ok").status, statusOf("waits_on_ok").by, askOf("apr_waits")?.reply], ["queued", QUIET_MAC, undefined], "still waiting on Mac C, its card up");
    assert.equal(S.leftBehind(statusOf("waits_on_ok")), false);
    assert.deepEqual([statusOf("left_with_ask").status, statusOf("left_with_ask").error], ["failed", S.LEFT_BEHIND], "left behind: over here");
    assert.deepEqual(askOf("apr_older"), ask("apr_older", { threadId: "left_with_ask", askedBy: D_MAC }), "a request is never touched by a sweep: it waits on nothing now its thread is over");
    assert.deepEqual([statusOf("mine_waits").status, askOf("apr_mine")?.reply], ["queued", undefined], "this Mac's own pause: kept, still waiting");
    assert.deepEqual([statusOf("mine_answered").status, askOf("apr_answered")?.reply?.reply], ["queued", "once"], "answered while this Mac was down: kept, to go on from");
    assert.deepEqual([statusOf("mine_working").status, statusOf("mine_working").error], ["failed", "Bops restarted while this was running"], "working when it stopped: restarted");
    assert.equal(askOf("apr_held"), undefined, "a call its run held is gone with that run");
    assert.equal(askOf("apr_old"), undefined, "from before requests: gone");
    assert.deepEqual(S.getState().messages.filter((m) => m.chatId === "bot:boppy" && m.role === "system"), [], "nothing to say: nothing was lost");
    assert.equal(await S.flushState(3000), true);
    assert.deepEqual(cloud.state.appApprovals.map((a) => a.id), ["apr_waits", "apr_older", "apr_mine", "apr_answered"], "and so for every Bops of the owner's");
  });

  await check("a runner starting fails only its own threads, never one from before (the Mac's)", async () => {
    await S.releaseSignOut();
    process.env.BOPS_RUNNER = "1";
    seed();
    await S.bindSignIn(USER, "sk_test");
    assert.equal(statusOf("mine").status, "failed", "this device's own");
    assert.equal(statusOf("before").status, "starting", "from before: the Mac's, so the runner leaves it");
    assert.equal(statusOf("other_mac_quiet").status, "running", "a Mac's left behind: never a runner's to end");
    assert.equal(statusOf("runner").status, "running");
    assert.equal(S.ownSession({}), false, "unset: never a runner's");
    delete process.env.BOPS_RUNNER;
  });

  await check("a newer Bops wrote the state: the store says so until a read lands again", async () => {
    cloud.refuse = true;
    await S.pullState();
    assert.equal(S.stateTooNew(), true, "a read refused");
    cloud.refuse = false;
    const before = S.statePulledAt();
    await new Promise((r) => setTimeout(r, 5));
    await S.pullState();
    assert.equal(S.stateTooNew(), false, "a read that landed");
    assert.ok(S.statePulledAt() > before, "and when");
    // A write refused too.
    cloud.refuse = true;
    S.update((s) => (s.owner = { name: "Sam" }));
    assert.equal(await S.flushState(3000), false);
    assert.equal(S.stateTooNew(), true, "a write refused");
    cloud.refuse = false;
    assert.equal(await S.flushState(3000), true);
    assert.equal(S.stateTooNew(), false, "a write that landed");
  });
} finally {
  console.info = quiet.info;
  console.warn = quiet.warn;
  server.close();
  process.chdir(tmpdir());
  rmSync(scratch, { recursive: true, force: true });
}

console.log(`session by: ${passed} passed, ${failures} failed`);
process.exit(failures ? 1 : 0);
