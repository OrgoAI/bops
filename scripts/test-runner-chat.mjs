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

const FAKES = { store: ["getState", "pullState", "stateReady", "addMessage"], cloud: ["cloudFetch"], "free-hours": ["sayInUse"] };
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
  // addMessage as the store's own: its row stamped with the turn it's added in (turn-context.ts stamp).
  store: { getState: () => state, pullState: async () => (pulls++, onPull()), stateReady: () => true, addMessage: (m) => (state.messages.push(globalThis.__stamp({ id: `msg_${state.messages.length}`, at: Date.now(), ...m })), state.messages.at(-1)) },
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
globalThis.__stamp = TC.stamp;
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

await check("a reply is marked on its computer from before its claim until its end is said to Bops Cloud, failed or not; an upgrade's hold stops a new one before its claim, unless it's stale", async () => {
  const { mkdtempSync, readdirSync, writeFileSync, utimesSync } = await import("node:fs");
  const { tmpdir } = await import("node:os");
  const base = mkdtempSync(`${tmpdir()}/bops-turns-`);
  const dir = `${base}/turns`;
  const hold = `${base}/upgrading`;
  for (const [id, fails] of [["t_mark", false], ["t_mark_fail", true]]) {
    reset();
    const T = Date.now();
    state.messages.push({ id: `m_${id}`, chatId: "bot:max", role: "user", text: "hi", at: T });
    let atClaim, during, atDone;
    answers.set("claim", () => ((atClaim = readdirSync(dir)), claimed(id, `m_${id}`, T)));
    answers.set("done", () => ((atDone = readdirSync(dir)), { status: 200, body: { ok: true } }));
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
    assert.deepEqual([atClaim, during, atDone], [[id], [id], [id]], `${id}: marked at its claim, while it runs, and as its end is said`);
    assert.deepEqual(readdirSync(dir), [], `${id}: gone after`);
  }
  // An upgrade holds the runner: a new reply isn't claimed (Bops Cloud gives it again), and leaves no mark.
  reset();
  writeFileSync(hold, "");
  let ran = 0;
  answers.set("claim", claimed("t_held", "m_held", Date.now()));
  state.messages.push({ id: "m_held", chatId: "bot:max", role: "user", text: "hi", at: Date.now() });
  R.runnerChatForTests({ identity: async () => "same", turnsDir: dir, answer: async () => (ran++, { text: "hi" }) });
  await R.answerTurn(ev("t_held", "m_held"));
  assert.deepEqual([paths(), ran, readdirSync(dir)], [[], 0, []], "held: nothing claimed, run or left marked");
  // A hold from an upgrade that died (over 5 minutes old) holds nothing.
  const old = new Date(Date.now() - 6 * 60_000);
  utimesSync(hold, old, old);
  await R.answerTurn(ev("t_held", "m_held"));
  assert.deepEqual([paths(), ran], [["claim", "done"], 1]);
  // The same turn delivered twice at once: the second claim is refused, and the first's mark stays while it runs.
  reset();
  const { rmSync } = await import("node:fs");
  rmSync(hold, { force: true });
  state.messages.push({ id: "m_twice", chatId: "bot:max", role: "user", text: "hi", at: Date.now() });
  let claims = 0;
  answers.set("claim", () => (claims++ === 0 ? claimed("t_twice", "m_twice", Date.now()) : { status: 409, body: { code: "taken" } }));
  let release;
  const running = new Promise((r) => (release = r));
  let midway;
  R.runnerChatForTests({ identity: async () => "same", turnsDir: dir, answer: async () => { await running; midway = readdirSync(dir); return { text: "hi" }; } });
  const first = R.answerTurn(ev("t_twice", "m_twice"));
  await until(() => claims === 1, "the first claim");
  await R.answerTurn(ev("t_twice", "m_twice"));
  release();
  await first;
  assert.deepEqual(midway, ["t_twice"], "the first reply keeps its mark after the second delivery ends");
  assert.deepEqual(readdirSync(dir), []);
  // A resume under an upgrade's hold waits for the hold to go (its OK is already taken out), marked all the while.
  reset();
  writeFileSync(hold, "");
  answers.set("resume", { status: 200, body: { ok: true, now: Date.now(), humanAt: Date.now() } });
  R.runnerChatForTests({ identity: async () => "same", turnsDir: dir, holdPollMs: 5 });
  let resumedAt = 0;
  const waited = R.resumeAsTurn({ id: "ask_h", botId: "max", chatId: "bot:max", resume: { engine: "chat", cloudTurn: "t_res" } }, async () => ((resumedAt = Date.now()), { text: "Paid." }));
  await new Promise((r) => setTimeout(r, 40));
  assert.deepEqual([resumedAt, readdirSync(dir)], [0, ["t_res"]], "waiting, marked");
  const gone = Date.now();
  rmSync(hold);
  await waited;
  assert.ok(resumedAt >= gone, "went on once the hold was gone");
  assert.deepEqual(readdirSync(dir), []);
  R.runnerChatForTests({});
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

/* ---------------- An app's GitHub job ---------------- */

await check("a turn that's an app's GitHub job runs the job, never the model: it says at once it's acting, its words go in the chat as Bops' own, and its result goes with its end", async () => {
  reset();
  const T = Date.now();
  // Its message is Bops Cloud's note of who asked (role system): the job needs none of it.
  state.messages.push({ id: "m_job", chatId: "bot:max", role: "system", botId: "max", text: "Ada asked Max's computer to bring in GitHub's changes to site.", at: T });
  answers.set("claim", claimed("t_job", "m_job", T, 0, { userId: "u-ada", name: "Ada", ref: "k_job", projectId: "p1", role: "admin", job: { act: "githubPull", app: "site" } }));
  let answered = 0;
  let asked;
  R.runnerChatForTests({
    identity: async () => "same",
    answer: async () => (answered++, { text: "never" }),
    job: async (botId, job, by) => {
      asked = { botId, job, by, turn: TC.currentTurn()?.id, beats: paths().filter((p) => p === "beat").length };
      return { ok: true, said: "Brought 2 changes from GitHub into Ingot. Deploy the newest to the preview to see them there." };
    },
  });
  await R.answerTurn(ev("t_job", "m_job"));
  assert.equal(answered, 0, "no model saw it");
  assert.deepEqual(asked, { botId: "max", job: { act: "githubPull", app: "site" }, by: "Ada", turn: "t_job", beats: 1 }, "in Ada's name, as the turn, once it said it's acting");
  assert.deepEqual(sent.find((x) => x.path.endsWith("/beat"))?.body, { phase: "tools" });
  const rows = state.messages.filter((m) => m.role === "bot");
  assert.equal(rows.length, 1);
  assert.deepEqual([rows[0].text, rows[0].appNote, rows[0].bops, rows[0].turn, rows[0].botId], ["Brought 2 changes from GitHub into Ingot. Deploy the newest to the preview to see them there.", true, true, "t_job", "max"]);
  assert.ok(rows[0].at > T, "after the note that asked");
  assert.deepEqual(sent.at(-1), { path: "/v1/runner/turns/t_job/done", body: { state: "done", job: { ok: true, said: "Brought 2 changes from GitHub into Ingot. Deploy the newest to the preview to see them there." } } });
  assert.equal(TC.turnsRunning(), false);
});

await check("a job that doesn't go says why in the chat and with its end; one taken back before it starts does nothing, and says nothing more", async () => {
  reset();
  const T = Date.now();
  answers.set("claim", claimed("t_job2", "m_job2", T, 0, { userId: "u-sam", name: "Sam", ref: "k_job2", job: { act: "githubLink", app: "site" } }));
  R.runnerChatForTests({ identity: async () => "same", job: async () => ({ ok: false, said: "Ingot and GitHub differ in lib/look.ts. Make them the same first (or add them to the files left alone), then link." }) });
  await R.answerTurn(ev("t_job2", "m_job2"));
  const row = state.messages.find((m) => m.role === "bot");
  assert.equal(row.text, "Couldn't link site to GitHub: Ingot and GitHub differ in lib/look.ts. Make them the same first (or add them to the files left alone), then link.");
  assert.ok(!/[\u2013\u2014]| - /.test(row.text), "no dashes");
  assert.deepEqual(sent.at(-1).body, { state: "done", job: { ok: false, said: "Ingot and GitHub differ in lib/look.ts. Make them the same first (or add them to the files left alone), then link." } });
  // Taken back (its member's access changed) before it acts: nothing runs, and its end isn't said (Bops Cloud said it).
  reset();
  let ran = 0;
  answers.set("claim", claimed("t_job3", "m_job3", T, 0, { userId: "u-sam", name: "Sam", ref: "k_job3", job: { act: "githubPull", app: "site" } }));
  answers.set("beat", { status: 409, body: { code: "over" } });
  R.runnerChatForTests({ identity: async () => "same", job: async () => (ran++, { ok: true, said: "x" }) });
  await R.answerTurn(ev("t_job3", "m_job3"));
  assert.deepEqual([ran, paths(), state.messages.length], [0, ["claim", "beat"], 0]);
});

console.log(`runner chat: ${passed} passed, ${failures} failed`);
process.exit(failures ? 1 : 0);
