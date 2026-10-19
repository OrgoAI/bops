// Tests for whose threads are whose (Session.by, lib/server/store.ts ownSession): a Bops that starts
// (or signs in) marks only its own threads failed, "Bops restarted while this was running", and leaves
// another Mac's and a computer's runner's going; a thread from before Session.by is the Mac's, never a
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
    console.error(`FAIL ${name}\n  ${e.message.split("\n").join("\n  ")}`);
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
const thread = (id, status, by) => ({ id, botId: "boppy", chatId: "bot:boppy", sentVia: "you", title: id, goal: id, host: "orgo", status, steps: [], replies: [], createdAt: 1, ...(by ? { by } : {}) });
const seed = () => {
  cloud.state = {
    bots: [{ id: "boppy", name: "Boppy", role: "Chief of Staff", color: "#000", isMain: true, computerStatus: "ready" }],
    sessions: [thread("mine", "running", ME), thread("runner", "running", RUNNER), thread("other_mac", "queued", OTHER_MAC), thread("before", "starting"), thread("done", "done", RUNNER)],
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
    assert.equal(statusOf("other_mac").status, "queued", "another Mac's waits for it there");
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

  await check("a runner starting fails only its own threads, never one from before (the Mac's)", async () => {
    await S.releaseSignOut();
    process.env.BOPS_RUNNER = "1";
    seed();
    await S.bindSignIn(USER, "sk_test");
    assert.equal(statusOf("mine").status, "failed", "this device's own");
    assert.equal(statusOf("before").status, "starting", "from before: the Mac's, so the runner leaves it");
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
