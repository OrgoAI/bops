// Tests for chat answered on a bot's computer (lib/server/runner-chat.ts, turn-context.ts): a runner claims each turn
// Bops Cloud owes its computer (only once it's sure it's on its own computer; a 409 or 410 does nothing more), reads the
// state until it has the message, answers it in the turn's context (its rows carry the turn and Bops Cloud's clock,
// never before the message), beats while it runs (at once, as "tools", the first time it does something that can't be
// done twice; a 409 stops it and nothing more is said), and says it's done with its tapback, or paused for an OK, from
// which the turn goes on as itself. A message it can't read fails with a note. Its stream (GET /v1/runner/live) gives it
// turns, "turn-cancel" stops one, and "state" reads the state now. Nothing on the Mac.
//
// Bops Cloud, the store and the model are fakes (below): the turn's own run is a stand-in for chat.ts answerMessage
// (test-chat-tools.mjs runs the real one in a turn's context).
// Usage: node --conditions=react-server scripts/test-runner-chat.mjs
import assert from "node:assert/strict";
import { registerHooks } from "node:module";
import { pathToFileURL } from "node:url";
import { unfaked } from "./fake-exports.mjs";

for (const k of Object.keys(process.env)) if (/^(BOPS|ORGO)_/.test(k)) delete process.env[k];
process.env.BOPS_RUNNER = "1";
const root = new URL("..", import.meta.url).pathname.replace(/\/$/, "");

const FAKES = { store: ["getState", "pullState", "stateReady"], cloud: ["cloudFetch"], "free-hours": ["sayInUse"] };
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
    if (!name || !FAKES[name]) return next(url, context);
    return { format: "module", shortCircuit: true, source: FAKES[name].map((n) => `export const ${n} = (...a) => globalThis.__fake[${JSON.stringify(name)}].${n}(...a);`).join("\n") + unfaked(name, url, FAKES[name]) };
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
    console.error(`FAIL ${name}\n  ${e.stack?.split("\n").slice(0, 6).join("\n  ") ?? e.message}`);
  }
}
const until = async (ok, what, ms = 3000) => {
  const end = Date.now() + ms;
  while (!(await ok())) {
    if (Date.now() > end) throw new Error(`timed out waiting for ${what}`);
    await new Promise((r) => setTimeout(r, 5));
  }
};

/* ---------------- Fakes: the state, Bops Cloud ---------------- */

const state = { messages: [], appApprovals: [] };
let pulls = 0;
/** What a pull brings in (a message Bops Cloud wrote, the first time it's read). */
let onPull = () => {};
/** Every call this runner made to Bops Cloud, and what each path answers (status, body). */
const sent = [];
const answers = new Map();
/** The runner's stream: what Bops Cloud sends down it. */
let stream = null;
const enc = new TextEncoder();
globalThis.__fake = {
  store: { getState: () => state, pullState: async () => (pulls++, onPull()), stateReady: () => true },
  "free-hours": { sayInUse: async () => {} },
  cloud: {
    cloudFetch: async (path, init = {}) => {
      if (path === "/v1/runner/live") {
        return new Response(
          new ReadableStream({
            start(c) {
              stream = { send: (type, data) => c.enqueue(enc.encode(`event: ${type}\ndata: ${JSON.stringify(data)}\n\n`)), close: () => c.close() };
              init.signal?.addEventListener("abort", () => c.error(new Error("aborted")));
              stream.send("hello", { now: Date.now() });
            },
          }),
          { headers: { "content-type": "text/event-stream" } },
        );
      }
      const body = init.body ? JSON.parse(init.body) : undefined;
      sent.push({ path, body });
      const kind = path.split("/").pop();
      const a = answers.get(path) ?? answers.get(kind) ?? { status: 200, body: { ok: true } };
      const out = typeof a === "function" ? a(body) : a;
      return new Response(JSON.stringify(out.body), { status: out.status, headers: { "content-type": "application/json" } });
    },
  },
};

const TC = await import(`${root}/lib/server/turn-context.ts`);
const R = await import(`${root}/lib/server/runner-chat.ts`);

/** Bops Cloud's answer to a claim: its clock `ahead` ms ahead of this computer's. */
const claimed = (id, messageId, humanAt, ahead = 0, member) => ({
  status: 200,
  body: { ok: true, now: Date.now() + ahead, turn: { id, messageId, chatId: "bot:max", botId: "max", humanAt, seq: 1, ...(member ? { member } : {}) } },
});
const reset = () => {
  sent.length = 0;
  answers.clear();
  state.messages = [];
  state.appApprovals = [];
  pulls = 0;
  onPull = () => {};
};
const paths = () => sent.map((x) => x.path.split("/").slice(-1)[0]);
const ev = (id, messageId = `m_${id}`) => ({ id, messageId, chatId: "bot:max", botId: "max", seq: 1 });

/* ---------------- One turn ---------------- */

await check("a turn is claimed, answered in its context on Bops Cloud's clock, and done with its tapback", async () => {
  reset();
  const T = Date.now() + 60_000;
  state.messages.push({ id: "m1", chatId: "bot:max", role: "user", text: "hi", at: T });
  answers.set("claim", claimed("t1", "m1", T, 60_000, { userId: "u2", email: "u2@example.com", name: "Wren", ref: "k1", projectId: "p1" }));
  let seen;
  R.runnerChatForTests({
    identity: async () => "same",
    answer: async (chatId, messageId, member) => {
      seen = { chatId, messageId, member, turn: TC.currentTurn()?.id };
      const row = TC.stamp({ id: "a1", chatId, role: "bot", botId: "max", text: "hello", at: Date.now() });
      state.messages.push(row);
      // Its tapback on the message, as chat.ts's react leaves it here: Bops Cloud writes it.
      state.messages[0].reactions = [{ by: "max", type: "like", at: Date.now() }];
      return { text: "hello" };
    },
  });
  await R.answerTurn(ev("t1", "m1"));
  assert.deepEqual(seen, { chatId: "bot:max", messageId: "m1", member: { userId: "u2", email: "u2@example.com", name: "Wren", ref: "k1" }, turn: "t1" });
  const row = state.messages.find((m) => m.id === "a1");
  assert.equal(row.turn, "t1");
  assert.ok(row.at >= Date.now() + 50_000, "on Bops Cloud's clock, a minute ahead of this computer's");
  assert.ok(row.at > T);
  assert.deepEqual(paths(), ["claim", "done"]);
  assert.deepEqual(sent[1].body, { state: "done", react: "like" });
  assert.equal(TC.turnsRunning(), false);
});

await check("a reply being answered is marked on its computer (so an upgrade waits for it), and the mark goes when it ends, failed or not", async () => {
  const { mkdtempSync, readdirSync } = await import("node:fs");
  const { tmpdir } = await import("node:os");
  const dir = `${mkdtempSync(`${tmpdir()}/bops-turns-`)}/turns`;
  for (const [id, fails] of [["t_mark", false], ["t_mark_fail", true]]) {
    reset();
    const T = Date.now();
    state.messages.push({ id: `m_${id}`, chatId: "bot:max", role: "user", text: "hi", at: T });
    answers.set("claim", claimed(id, `m_${id}`, T));
    let during;
    R.runnerChatForTests({
      identity: async () => "same",
      turnsDir: dir,
      answer: async () => {
        during = readdirSync(dir);
        if (fails) throw new Error("the model call failed");
        return { text: "hello" };
      },
    });
    await R.answerTurn(ev(id, `m_${id}`));
    assert.deepEqual(during, [id], "marked while it runs");
    assert.deepEqual(readdirSync(dir), [], "gone once it ends");
  }
});

await check("an Admin's turn (TurnMember.role, as Bops Cloud found it taking their words) is answered as an Admin's: the role goes down to the turn", async () => {
  reset();
  const T = Date.now();
  state.messages.push({ id: "m_admin", chatId: "bot:max", role: "user", text: "hi", at: T });
  answers.set("claim", claimed("t_admin", "m_admin", T, 0, { userId: "u3", email: "u3@example.com", name: "Ivy", ref: "k3", projectId: "p1", role: "admin" }));
  let seen;
  R.runnerChatForTests({
    identity: async () => "same",
    answer: async (chatId, messageId, member) => {
      seen = member;
      return { text: null };
    },
  });
  await R.answerTurn(ev("t_admin", "m_admin"));
  assert.deepEqual(seen, { userId: "u3", email: "u3@example.com", name: "Ivy", ref: "k3", role: "admin" });
  // Any other role Bops Cloud might send is no role: a member's turn, by their entry.
  reset();
  state.messages.push({ id: "m_other", chatId: "bot:max", role: "user", text: "hi", at: T });
  answers.set("claim", claimed("t_other", "m_other", T, 0, { userId: "u3", name: "Ivy", ref: "k4", role: "owner" }));
  await R.answerTurn(ev("t_other", "m_other"));
  assert.deepEqual(seen, { userId: "u3", name: "Ivy", ref: "k4" });
});

await check("a row of another chat or bot, or one added with no turn, is as it was", () => {
  const plain = { id: "x", chatId: "bot:max", role: "bot", botId: "max", text: "x", at: 5 };
  assert.deepEqual(TC.stamp(plain), plain);
});

await check("not on its own computer, or Bops Cloud says no: nothing is run or said", async () => {
  reset();
  let ran = 0;
  R.runnerChatForTests({ identity: async () => "unknown", answer: async () => (ran++, null) });
  await R.answerTurn(ev("t2"));
  assert.deepEqual([paths(), ran], [[], 0], "no claim from a computer that isn't sure it's itself");
  R.runnerChatForTests({ identity: async () => "same", answer: async () => (ran++, null) });
  for (const status of [409, 410, 404]) {
    sent.length = 0;
    answers.set("claim", { status, body: { error: "no", code: "busy" } });
    await R.answerTurn(ev(`t2_${status}`));
    assert.deepEqual([paths(), ran], [["claim"], 0], `nothing after a ${status}`);
  }
});

await check("the message is read before it's answered; one it never reads fails with a note", async () => {
  reset();
  const T = Date.now();
  answers.set("claim", claimed("t3", "m3", T));
  onPull = () => pulls === 2 && state.messages.push({ id: "m3", chatId: "bot:max", role: "user", text: "hi", at: T });
  let ran = 0;
  R.runnerChatForTests({ identity: async () => "same", answer: async () => (ran++, {}) });
  await R.answerTurn(ev("t3", "m3"));
  assert.deepEqual([pulls, ran, paths()], [2, 1, ["claim", "done"]]);
  reset();
  answers.set("claim", claimed("t4", "m4", T));
  await R.answerTurn(ev("t4", "m4"));
  assert.equal(pulls, 5);
  assert.deepEqual(sent.at(-1).body, { state: "failed", note: "This computer couldn't read that message. Send it again." });
});

await check("what can't be done twice is said at once as a beat with tools; a beat answered 409 stops the turn and nothing more is said", async () => {
  reset();
  const T = Date.now();
  state.messages.push({ id: "m5", chatId: "bot:max", role: "user", text: "send it", at: T });
  answers.set("claim", claimed("t5", "m5", T));
  R.runnerChatForTests({
    identity: async () => "same",
    beatMs: 20,
    answer: async () => {
      TC.noteActing();
      TC.noteActing();
      await until(() => sent.filter((x) => x.path.endsWith("/beat")).length >= 2, "a beat on its timer");
      return {};
    },
  });
  await R.answerTurn(ev("t5", "m5"));
  const beats = sent.filter((x) => x.path.endsWith("/beat"));
  assert.deepEqual(beats[0].body, { phase: "tools" }, "said at once");
  assert.ok(beats.every((b) => b.body.phase === "tools"));
  assert.equal(paths().at(-1), "done");

  reset();
  state.messages.push({ id: "m6", chatId: "bot:max", role: "user", text: "x", at: T });
  answers.set("claim", claimed("t6", "m6", T));
  answers.set("beat", { status: 409, body: { code: "over" } });
  let cancelledSeen = false;
  R.runnerChatForTests({
    identity: async () => "same",
    beatMs: 10,
    answer: async () => {
      await until(() => TC.currentTurn()?.cancelled, "taken back");
      cancelledSeen = true;
      return {};
    },
  });
  await R.answerTurn(ev("t6", "m6"));
  assert.ok(cancelledSeen);
  assert.ok(!paths().includes("done"), "nothing said for a turn taken back");
});

await check("a turn paused for an OK says so with its request, which carries the turn, and goes on as itself only through Bops Cloud's resume", async () => {
  reset();
  const T = Date.now();
  state.messages.push({ id: "m7", chatId: "bot:max", role: "user", text: "pay it", at: T });
  answers.set("claim", claimed("t7", "m7", T, 30_000));
  R.runnerChatForTests({
    identity: async () => "same",
    answer: async () => {
      // An older ask of the same bot and chat, from no turn, is never taken for this turn's.
      state.appApprovals.push({ id: "ask0", botId: "max", chatId: "bot:max", at: Date.now() + 5, resume: { engine: "chat" } });
      state.appApprovals.push({ id: "ask1", botId: "max", chatId: "bot:max", at: Date.now(), resume: { engine: "chat", cloudTurn: TC.currentTurn().id } });
      return { paused: true };
    },
  });
  await R.answerTurn(ev("t7", "m7"));
  assert.deepEqual(sent.at(-1).body, { state: "paused", approvalId: "ask1" });
  // A restart (or an upgrade) here since: nothing kept in memory is needed, Bops Cloud gives its clock and the message's time.
  R.runnerChatForTests({ identity: async () => "same" });
  sent.length = 0;
  answers.set("resume", { status: 200, body: { ok: true, now: Date.now() + 30_000, humanAt: T } });
  let inTurn;
  const ask = { id: "ask1", botId: "max", chatId: "bot:max", resume: { engine: "chat", cloudTurn: "t7" } };
  const out = await R.resumeAsTurn(ask, async () => {
    inTurn = TC.currentTurn();
    state.messages.push(TC.stamp({ id: "a7", chatId: "bot:max", role: "bot", botId: "max", text: "Paid.", at: Date.now() }));
    return { text: "Paid." };
  });
  assert.equal(out.text, "Paid.");
  assert.equal(inTurn?.id, "t7");
  const a7 = state.messages.find((m) => m.id === "a7");
  assert.equal(a7.turn, "t7");
  assert.ok(a7.at >= Date.now() + 20_000, "on Bops Cloud's clock");
  assert.deepEqual(paths(), ["resume", "done"]);
  assert.deepEqual(sent[0].body, { approvalId: "ask1" });
  // One not asked on a turn of Bops Cloud's (from before this build) goes on as it is.
  sent.length = 0;
  let plain;
  await R.resumeAsTurn({ id: "ask_unknown", botId: "max", chatId: "bot:max", resume: { engine: "chat" } }, async () => ((plain = TC.currentTurn()), {}));
  assert.deepEqual([plain, sent.length], [undefined, 0]);
});

await check("a paused turn Bops Cloud ended meanwhile (its member's access taken away, past its day), or that it never answers about, never runs the approved action", async () => {
  reset();
  R.runnerChatForTests({ identity: async () => "same", retryMs: [1, 1] });
  const ask = { id: "ask9", botId: "max", chatId: "bot:max", resume: { engine: "chat", cloudTurn: "t9" } };
  for (const [status, tries] of [[409, 1], [410, 1], [0, 3], [503, 3]]) {
    sent.length = 0;
    answers.set("resume", { status, body: { code: "over" } });
    if (status === 0) answers.set("resume", () => ({ status: 0 }));
    let ran = 0;
    const out = await R.resumeAsTurn(ask, async () => (ran++, { text: "Paid." }));
    assert.deepEqual([ran, out.paused, sent.filter((x) => x.path.endsWith("/resume")).length], [0, false, tries], `after a ${status}`);
    assert.ok(!paths().includes("done"));
  }
});

await check("a beat on its way when the turn pauses lands first; a done Bops Cloud didn't answer is sent again", async () => {
  reset();
  const T = Date.now();
  state.messages.push({ id: "m10", chatId: "bot:max", role: "user", text: "x", at: T });
  answers.set("claim", claimed("t10", "m10", T));
  let release;
  const held = new Promise((r) => (release = r));
  const order = [];
  const real = globalThis.__fake.cloud.cloudFetch;
  globalThis.__fake.cloud.cloudFetch = async (path, init) => {
    if (path.endsWith("/beat")) {
      await held;
      order.push("beat");
    }
    if (path.endsWith("/done")) order.push("done");
    return real(path, init);
  };
  R.runnerChatForTests({
    identity: async () => "same",
    answer: async () => {
      TC.noteActing();
      state.appApprovals.push({ id: "ask10", botId: "max", chatId: "bot:max", at: Date.now(), resume: { engine: "chat", cloudTurn: "t10" } });
      setTimeout(release, 30);
      return { paused: true };
    },
  });
  await R.answerTurn(ev("t10", "m10"));
  globalThis.__fake.cloud.cloudFetch = real;
  assert.deepEqual(order, ["beat", "done"], "the pause after the beat");

  reset();
  state.messages.push({ id: "m11", chatId: "bot:max", role: "user", text: "x", at: T });
  answers.set("claim", claimed("t11", "m11", T));
  let n = 0;
  answers.set("done", () => (++n < 3 ? { status: n === 1 ? 0 : 502, body: null } : { status: 200, body: { ok: true } }));
  R.runnerChatForTests({ identity: async () => "same", retryMs: [1, 1], answer: async () => ({ text: "hi" }) });
  await R.answerTurn(ev("t11", "m11"));
  assert.equal(sent.filter((x) => x.path.endsWith("/done")).length, 3, "until Bops Cloud answers it");
});

/* ---------------- The stream ---------------- */

await check("the stream gives it turns, turn-cancel stops one, and state reads the state now", async () => {
  reset();
  const T = Date.now();
  state.messages.push({ id: "m8", chatId: "bot:max", role: "user", text: "x", at: T });
  answers.set("claim", claimed("t8", "m8", T));
  let started = false;
  R.runnerChatForTests({
    identity: async () => "same",
    answer: async () => {
      started = true;
      await until(() => TC.currentTurn()?.cancelled, "turn-cancel");
      return {};
    },
  });
  R.startRunnerChat();
  await until(() => stream, "the stream to open");
  stream.send("turn", ev("t8", "m8"));
  await until(() => started, "the turn to start");
  stream.send("turn-cancel", { id: "t8" });
  await until(() => !TC.turnsRunning(), "the turn to stop");
  assert.ok(!paths().includes("done"));
  const before = pulls;
  stream.send("state", {});
  await until(() => pulls > before, "a read of the state");
  R.stopRunnerChat();
});

console.log(`runner chat: ${passed} passed, ${failures} failed`);
process.exit(failures ? 1 : 0);
