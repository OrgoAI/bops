import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { after, before, beforeEach, test } from "node:test";
import { closeDb, query } from "../db.ts";
import * as voice from "../voice.ts";
import { dropUsers, fakeOpenAi, newNumber, newUserId, pending, prepareDb, seedUser, until } from "./edge-fakes.ts";

/** A call's turns answered in the cloud while the Mac is away (cloud/voice.ts), against a fake OpenAI Responses API. */

let openai: Awaited<ReturnType<typeof fakeOpenAi>>;
const users: string[] = [];
const saved = { ...voice.timing };

/** A user whose main bot Sam has the workspace's number (on agent `agentId`), with Alex as the owner and Gmail connected for Sam. */
async function setUp() {
  const userId = newUserId("voice");
  users.push(userId);
  const agentId = `agt_${randomUUID()}`;
  const line = { phone: newNumber(), numberId: `num_${randomUUID()}`, agentId, type: "sms", scope: "sub", at: 1 };
  const state = {
    owner: { name: "Alex", about: "Lives in Oakland." },
    bots: [{ id: "sam", name: "Sam", isMain: true, access: { ca_1: "act" } }],
    workspaces: [{ id: "ws_main", name: "Main", createdAt: 1, line }],
    accounts: [{ id: "ca_1", app: "gmail", appName: "Gmail", name: "alex@example.com", status: "active" }],
  };
  await seedUser(userId, { state });
  return { userId, agentId, line };
}

const turn = (agentId: string, to: string, from: string, callId: string, transcript: string) => ({ event: "agent.message", channel: "voice", agentId, data: { callId, from, to, transcript } });

before(async () => {
  await prepareDb();
  openai = await fakeOpenAi();
});

beforeEach(() => {
  Object.assign(voice.timing, saved);
  openai.responses.length = 0;
  openai.state.respond = () => ({ text: "Hi there." });
});

after(async () => {
  await openai.close();
  await dropUsers(users);
  await closeDb();
});

test("the owner's bot knows the computer is offline and what it can use, keeps the call's turns, and takes a note", async () => {
  const { userId, agentId, line } = await setUp();
  const callId = `call_${randomUUID()}`;
  const from = newNumber();
  openai.state.respond = () => ({ text: "Hi Alex, it's Sam. My computer's offline, but I can take a note." });
  assert.deepEqual(await voice.cloudVoiceTurn(userId, turn(agentId, line.phone, from, callId, ""), { owner: true }), { text: "Hi Alex, it's Sam. My computer's offline, but I can take a note." });
  const first = openai.responses[0].body;
  assert.match(String(first.instructions), /on a phone call with Alex, who you work for/);
  assert.match(String(first.instructions), /When it's back you can use Alex's apps again: Gmail \(alex@example\.com: read & act\)\./);
  assert.match(String(first.instructions), /no markdown/);
  assert.deepEqual(first.input, [{ role: "user", content: "(The call just connected; the caller hasn't said anything yet. Say hello.)" }]);
  assert.deepEqual((first.tools as { name: string }[]).map((t) => t.name), ["take_message", "end_call"]);

  openai.state.respond = () => ({ tools: [{ name: "take_message", args: { name: null, text: "Email the landlord about the lease", callback: null, say: "Got it, I'll email the landlord when the computer's back." } }] });
  const second = await voice.cloudVoiceTurn(userId, turn(agentId, line.phone, from, callId, "Email the landlord about the lease."), { owner: true });
  assert.deepEqual(second, { text: "Got it, I'll email the landlord when the computer's back." });
  assert.deepEqual(openai.responses[1].body.input, [
    { role: "assistant", content: "Hi Alex, it's Sam. My computer's offline, but I can take a note." },
    { role: "user", content: "Email the landlord about the lease." },
  ]);

  openai.state.respond = () => ({ tools: [{ name: "end_call", args: { say: "Bye Alex!" } }] });
  assert.deepEqual(await voice.cloudVoiceTurn(userId, turn(agentId, line.phone, from, callId, "That's all, thanks."), { owner: true }), { text: "Bye Alex!", hangup: true });
  const [kept] = await until(async () => {
    const p = await pending(userId);
    return p.length ? p : null;
  }, "the call to be kept for the Mac");
  assert.equal(kept.kind, "call");
  assert.deepEqual(
    { botId: kept.payload.botId, from: kept.payload.from, owner: kept.payload.owner, message: kept.payload.message },
    { botId: "sam", from, owner: true, message: { text: "Email the landlord about the lease" } },
  );
  assert.equal(
    kept.payload.transcript,
    [
      "Bot: Hi Alex, it's Sam. My computer's offline, but I can take a note.",
      "Caller: Email the landlord about the lease.",
      "Bot: Got it, I'll email the landlord when the computer's back.",
      "Caller: That's all, thanks.",
      "Bot: Bye Alex!",
    ].join("\n"),
  );
  // Each turn's tokens, metered as the phone's, and the call's minutes.
  const usage = await until(async () => {
    const r = await query<{ kind: string; detail: { source?: string; answeredBy?: string } }>("SELECT kind, detail FROM bops.cloud_usage WHERE user_id = $1 ORDER BY id", [userId]);
    return r.rows.length === 4 ? r.rows : null;
  }, "the usage rows");
  assert.deepEqual(
    usage.map((u) => [u.kind, u.detail.source ?? u.detail.answeredBy]),
    [
      ["openai.tokens", "phone"],
      ["openai.tokens", "phone"],
      ["openai.tokens", "phone"],
      ["call.minutes", "cloud"],
    ],
  );
});

test("anyone else gets a bot that knows nothing about the owner and takes a message, which reaches the Mac", async () => {
  const { userId, agentId, line } = await setUp();
  const callId = `call_${randomUUID()}`;
  const from = newNumber();
  openai.state.respond = () => ({
    text: "Sure.",
    tools: [
      { name: "take_message", args: { name: "Jordan", text: "Wants to talk about the quote", callback: "+1 415 555 0199", say: "I'll pass that on." } },
      { name: "end_call", args: { say: "Bye!" } },
    ],
  });
  const reply = await voice.cloudVoiceTurn(userId, turn(agentId, line.phone, from, callId, "Hi, this is Jordan, can you tell Alex to call me back about the quote?"), { owner: false });
  assert.deepEqual(reply, { text: "Sure. I'll pass that on. Bye!", hangup: true });
  const instructions = String(openai.responses[0].body.instructions);
  assert.match(instructions, /^You are Sam, an AI assistant who answers this phone number for the person you work for\./);
  for (const secret of ["Alex", "Oakland", "Gmail", "alex@example.com"]) assert.ok(!instructions.includes(secret), `the stranger's bot isn't told "${secret}"`);
  const [kept] = await until(async () => {
    const p = await pending(userId);
    return p.length ? p : null;
  }, "the message to be kept for the Mac");
  assert.deepEqual(
    { owner: kept.payload.owner, from: kept.payload.from, message: kept.payload.message },
    { owner: false, from, message: { name: "Jordan", text: "Wants to talk about the quote", callback: "+1 415 555 0199" } },
  );
});

test("a first call that claimed the line is told so once, and reaches the Mac as claimed", async () => {
  const { userId, agentId, line } = await setUp();
  const callId = `call_${randomUUID()}`;
  const from = newNumber();
  await voice.cloudVoiceTurn(userId, turn(agentId, line.phone, from, callId, ""), { owner: true, claimed: "call" });
  assert.match(String(openai.responses[0].body.instructions), /just linked their phone to you/);
  openai.state.respond = () => ({ tools: [{ name: "end_call", args: { say: "Bye!" } }] });
  await voice.cloudVoiceTurn(userId, turn(agentId, line.phone, from, callId, "Great, bye."), { owner: true });
  assert.doesNotMatch(String(openai.responses[1].body.instructions), /just linked/, "said once");
  const [kept] = await until(async () => {
    const p = await pending(userId);
    return p.length ? p : null;
  }, "the call to be kept for the Mac");
  assert.deepEqual([kept.payload.owner, kept.payload.claimed], [true, "call"]);
});

test("a call nobody speaks on for a while ends by itself and reaches the Mac", async () => {
  const { userId, agentId, line } = await setUp();
  voice.timing.idleMs = 50;
  const callId = `call_${randomUUID()}`;
  await voice.cloudVoiceTurn(userId, turn(agentId, line.phone, newNumber(), callId, "Hello?"), { owner: true });
  assert.equal(voice.callOpen(userId, callId), true);
  await until(async () => (await pending(userId)).length === 1, "the call to end by itself");
  assert.equal(voice.callOpen(userId, callId), false);
});

test("OpenAI failing mid-call asks the caller again instead of hanging up; a call past its time says goodbye", async () => {
  const { userId, agentId, line } = await setUp();
  const callId = `call_${randomUUID()}`;
  openai.state.respond = () => ({ status: 500 });
  assert.deepEqual(await voice.cloudVoiceTurn(userId, turn(agentId, line.phone, newNumber(), callId, "Hello?"), { owner: true }), { text: "Sorry, I didn't catch that. Could you say it again?" });
  voice.timing.maxCallMs = 0;
  openai.state.respond = () => ({ text: "never said" });
  await new Promise((r) => setTimeout(r, 5));
  assert.deepEqual(await voice.cloudVoiceTurn(userId, turn(agentId, line.phone, newNumber(), callId, "Still there?"), { owner: true }), { text: "I have to go now. Bye!", hangup: true });
  assert.equal(openai.responses.length, 1, "no model call for the goodbye");
});
