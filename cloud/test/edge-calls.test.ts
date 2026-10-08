import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { after, before, beforeEach, test } from "node:test";
import * as calls from "../calls.ts";
import { closeDb, query } from "../db.ts";
import { dropUsers, fakeAgentPhone, fakeOpenAi, incomingCallEvent, newNumber, newUserId, pending, prepareDb, seedUser, until, type FakeSideband } from "./edge-fakes.ts";

/** Answering a call in the cloud (cloud/calls.ts) against a fake OpenAI (REST + sideband) and a fake AgentPhone. */

let openai: Awaited<ReturnType<typeof fakeOpenAi>>;
let ap: Awaited<ReturnType<typeof fakeAgentPhone>>;
const users: string[] = [];

/**
 * One user with Sam (the main bot, on the workspace's number) and Iris (her own number), and Alex's
 * verified mobile. `extra` adds to the state (accounts, channels); `samAccess` and `samVoice` are Sam's.
 */
async function setUp(opts: { owner?: Record<string, unknown>[]; ownerName?: string | null; extra?: Record<string, unknown>; samAccess?: Record<string, string>; samVoice?: string } = {}) {
  const userId = newUserId("calls");
  users.push(userId);
  const line = { phone: newNumber(), numberId: `num_${randomUUID()}`, agentId: `agt_${randomUUID()}`, type: "sms", scope: "sub", at: 1 };
  const iris = { phone: newNumber(), numberId: `num_${randomUUID()}`, agentId: `agt_${randomUUID()}` };
  const mobile = newNumber();
  const subAccount = `sub_${randomUUID()}`;
  const owners = opts.owner ?? [{ number: mobile, consentAt: 1, verifiedAt: 2, userId }];
  const state = {
    owner: opts.ownerName === null ? { name: "" } : { name: opts.ownerName ?? "Alex" },
    bots: [
      { id: "sam", name: "Sam", role: "Chief of Staff", isMain: true, computerStatus: "none", ...(opts.samAccess ? { access: opts.samAccess } : {}), ...(opts.samVoice ? { voice: opts.samVoice } : {}) },
      { id: "iris", name: "Iris", role: "Inbox", isMain: false, phone: iris.phone, phoneLine: { numberId: iris.numberId, agentId: iris.agentId }, computerStatus: "none", access: { ca_iris: "act" } },
    ],
    workspaces: [{ id: "ws_main", name: "Main", createdAt: 1, line }],
    ownerPhones: owners,
    messages: [],
    ...opts.extra,
  };
  // Who the owner is comes from bops.owner_phones (the numbers this user verified), never from the state.
  const verified = owners.filter((p) => p.verifiedAt && (!p.userId || p.userId === userId)).map((p) => String(p.number));
  await seedUser(userId, { state, subAccount, numbers: [line.phone, iris.phone], ownerPhones: verified });
  return { userId, line, iris, mobile, subAccount };
}

const said = (sb: FakeSideband, who: "Caller" | "Bot", text: string) => sb.send({ type: who === "Caller" ? "session.input_transcript.delta" : "session.output_transcript.delta", delta: text });
const toolCall = (sb: FakeSideband, callId: string, name: string, args: unknown) =>
  sb.send({ type: "response.event", delegation_id: `del_${callId}`, event: { type: "response.output_item.done", item: { type: "function_call", id: `fc_${callId}`, call_id: callId, name, arguments: JSON.stringify(args), status: "completed" } } });
const answerTo = (sb: FakeSideband, callId: string) =>
  sb.receive((e) => e.type === "response.item.create" && (e.item as { call_id?: string }).call_id === callId, `the answer to ${callId}`);

/** The owner leaves a note and says goodbye; the bot ends the call. */
async function leavesANote(sb: FakeSideband) {
  sb.send({ type: "session.started", event_id: "ev_1", session: { id: sb.sessionId } });
  await sb.receive((e) => e.type === "session.commentary.append", "the greeting");
  said(sb, "Bot", "Hi Alex, it's Sam. ");
  said(sb, "Bot", "Your computer is offline, so I can only take a note right now.");
  said(sb, "Caller", "Hey Sam. ");
  said(sb, "Caller", "Remind me to send Jane the invoice.");
  sb.send({ type: "session.delegation.created", delegation: { id: "del_1", target: "responses", type: "delegation", response_id: "resp_1" }, offset_ms: 4000 });
  toolCall(sb, "call_1", "take_message", { name: "Jane", text: "Send Jane the invoice", callback: "+1 415 555 0199" });
  // The backend's answer that called it, with its tokens.
  sb.send({ type: "response.event", delegation_id: "del_1", event: { type: "response.completed", response: { id: `resp_${sb.sessionId}`, object: "response", model: "gpt-6.1-sol", usage: { input_tokens: 900, output_tokens: 40 } } } });
  await answerTo(sb, "call_1");
  said(sb, "Bot", "Got it, I'll do that when the computer's back. Bye!");
  toolCall(sb, "call_2", "end_call", {});
  await answerTo(sb, "call_2");
}

before(async () => {
  await prepareDb();
  openai = await fakeOpenAi();
  ap = await fakeAgentPhone();
  calls.timing.hangupAfterMs = 30;
});

beforeEach(() => {
  openai.controls.length = 0;
  openai.sidebands.length = 0;
  openai.state.acceptStatus = 200;
  openai.state.script = leavesANote;
  ap.sent.length = 0;
});

after(async () => {
  await openai.close();
  await ap.close();
  await dropUsers(users);
  await closeDb();
});

test("the owner calls while the Mac is away: the bot answers, takes the note, hangs up, and the Mac hears about it", async () => {
  const { userId, line, mobile } = await setUp();
  const sessionId = `live_${randomUUID()}`;
  await calls.answerInCloud(userId, incomingCallEvent(sessionId, mobile, line.phone));

  const accept = openai.controls.find((c) => c.action === "accept");
  assert.equal(accept?.sessionId, sessionId);
  assert.equal(accept?.authorization, "Bearer sk-test-not-a-real-key");
  type Accepted = {
    type: string;
    model: string;
    audio: { output: { voice: string } };
    instructions: string;
    delegation: { type: string; responses: { tools: { name: string }[] } };
  };
  const session = (accept?.body as { session: Accepted }).session;
  assert.equal(session.type, "live");
  assert.equal(session.model, "gpt-live-1");
  assert.equal(session.audio.output.voice, "cedar", "Sam sounds like Sam");
  assert.match(session.instructions, /You are Sam, an AI assistant, on a call with Alex, who you work for/);
  assert.match(session.instructions, /offline/);
  assert.equal(session.delegation.type, "responses");
  assert.deepEqual(
    session.delegation.responses.tools.map((t: { name: string }) => t.name),
    ["take_message", "end_call"],
  );
  assert.ok(!JSON.stringify(session).includes(String.fromCharCode(0x2014)), "no em dashes");

  const sb = openai.sidebands[0];
  assert.equal(sb.authorization, "Bearer sk-test-not-a-real-key");
  const greeting = sb.got.find((e) => e.type === "session.commentary.append");
  assert.equal(greeting?.delegation_id, null);
  assert.match(String(greeting?.content), /"Hi Alex, it's Sam\. Your computer is offline, so I can only take a note right now\."/);
  assert.deepEqual(
    sb.got.filter((e) => e.type === "response.item.create").map((e) => e.item),
    [
      { type: "function_call_output", call_id: "call_1", output: "Saved." },
      { type: "function_call_output", call_id: "call_2", output: "Hanging up." },
    ],
  );
  assert.equal(sb.got.filter((e) => e.type === "response.create").length, 2, "the backend goes on after each tool");
  assert.ok(openai.controls.some((c) => c.action === "hangup" && c.sessionId === sessionId), "hung up after end_call");

  const [kept] = await pending(userId);
  assert.equal(kept.kind, "call");
  assert.equal(kept.dedupe_key, `call:${sessionId}`);
  const payload = kept.payload as Record<string, unknown>;
  assert.equal(payload.botId, "sam");
  assert.equal(payload.from, mobile);
  assert.equal(payload.owner, true);
  assert.deepEqual(payload.message, { name: "Jane", text: "Send Jane the invoice", callback: "+1 415 555 0199" });
  assert.equal(
    payload.transcript,
    "Bot: Hi Alex, it's Sam. Your computer is offline, so I can only take a note right now.\nCaller: Hey Sam. Remind me to send Jane the invoice.\nBot: Got it, I'll do that when the computer's back. Bye!",
  );
  assert.ok(Date.parse(String(payload.startedAt)) <= Date.parse(String(payload.endedAt)));
  assert.equal(ap.sent.length, 0, "the owner was on the call: no text");
  // The call's audio, as OpenAI counted it at the end (session.closed), at GPT-Live's price and the SIP leg's; no estimate per minute.
  const seconds = await until(async () => (await query("SELECT units::float8 AS units, cost_micros::float8 AS cost, detail FROM bops.cloud_usage WHERE user_id = $1 AND kind = 'openai.live_seconds'", [userId])).rows[0], "the call's seconds");
  assert.deepEqual([seconds.units, seconds.cost, seconds.detail.transport, seconds.detail.botId, seconds.detail.ref], [12, Math.ceil(12 * (50_000 / 60 + 61.7)), "sip", "sam", sessionId]);
  assert.equal((await query("SELECT 1 FROM bops.cloud_usage WHERE user_id = $1 AND kind = 'call.minutes'", [userId])).rowCount, 0);
  // And the backend's tokens, once, for the bot.
  const tokens = await until(async () => (await query("SELECT units::float8 AS units, cost_micros::float8 AS cost, detail FROM bops.cloud_usage WHERE user_id = $1 AND kind = 'openai.tokens'", [userId])).rows[0], "the backend's tokens");
  assert.deepEqual([tokens.units, tokens.cost, tokens.detail.source, tokens.detail.botId], [940, 900 * 2 + 40 * 10, "phone", "sam"]);

  // A withheld From: the carrier's P-Asserted-Identity says who it is (as the app reads it).
  const withheld = incomingCallEvent(`live_${randomUUID()}`, "", line.phone, [{ name: "P-Asserted-Identity", value: `<sip:${mobile}@carrier.example>` }]);
  withheld.data.sip_headers[0] = { name: "From", value: '"Anonymous" <sip:anonymous@anonymous.invalid>;tag=x' };
  await calls.answerInCloud(userId, withheld);
  const second = (await pending(userId))[1].payload as { owner: boolean; from: string };
  assert.equal(second.owner, true);
  assert.equal(second.from, mobile);
});

test("anyone but the owner is turned away before the call connects: no bot, no message, nothing kept, no text", async () => {
  const { userId, line } = await setUp();
  const stranger = `live_${randomUUID()}`;
  await calls.answerInCloud(userId, incomingCallEvent(stranger, newNumber(), line.phone));
  const withheld = incomingCallEvent(`live_${randomUUID()}`, "", line.phone);
  withheld.data.sip_headers[0] = { name: "From", value: '"Anonymous" <sip:anonymous@anonymous.invalid>;tag=x' };
  await calls.answerInCloud(userId, withheld);
  assert.deepEqual(
    openai.controls.map((c) => [c.action, c.body]),
    [
      ["reject", { status_code: 403 }],
      ["reject", { status_code: 403 }],
    ],
  );
  assert.equal(openai.sidebands.length, 0, "never connected");
  assert.equal((await pending(userId)).length, 0);
  assert.equal(ap.sent.length, 0);
});

test("an unverified number, or one another Orgo user verified, isn't the owner", async () => {
  const unverified = newNumber();
  const theirs = newNumber();
  const verified = newNumber();
  const { userId, line } = await setUp({
    owner: [
      { number: unverified, consentAt: 1 },
      { number: theirs, consentAt: 1, verifiedAt: 2, userId: "someone-else" },
      { number: verified, consentAt: 1, verifiedAt: 2 },
    ],
  });
  for (const from of [unverified, theirs, verified]) await calls.answerInCloud(userId, incomingCallEvent(`live_${randomUUID()}`, from, line.phone));
  assert.deepEqual(
    openai.controls.filter((c) => c.action !== "hangup").map((c) => c.action),
    ["reject", "reject", "accept"],
    "only the verified number of this user's gets through",
  );
  assert.equal((await pending(userId)).length, 1);
});

test("the owner hangs up on the greeting: the call is still kept for the Mac", async () => {
  openai.state.script = async (sb) => {
    sb.send({ type: "session.started", session: { id: sb.sessionId } });
    await sb.receive((e) => e.type === "session.commentary.append", "the greeting");
    said(sb, "Bot", "Hi, it's Sam. Your computer is offline, so I can only take a note right now.");
    sb.send({ type: "session.closed", reason: "remote_hangup" });
    sb.ws.close();
  };
  const nameless = await setUp({ ownerName: null });
  const hungUp = `live_${randomUUID()}`;
  await calls.answerInCloud(nameless.userId, incomingCallEvent(hungUp, nameless.mobile, nameless.line.phone));
  const [kept] = await pending(nameless.userId);
  assert.equal((kept.payload as { transcript: string }).transcript, "Bot: Hi, it's Sam. Your computer is offline, so I can only take a note right now.");
  assert.equal((kept.payload as { message?: unknown }).message, undefined);
  assert.match(String(openai.sidebands.at(-1)?.got.find((e) => e.type === "session.commentary.append")?.content), /"Hi, it's Sam\. Your computer/, "no owner name: none in the greeting");
  assert.equal(openai.controls.filter((c) => c.action === "hangup" && c.sessionId === hungUp).length, 0, "the caller hung up: nothing to hang up");
  assert.equal(ap.sent.length, 0);
});

test("a call that runs too long is hung up", async () => {
  const saved = calls.timing.maxCallMs;
  calls.timing.maxCallMs = 200;
  openai.state.script = (sb) => {
    sb.send({ type: "session.started", session: { id: sb.sessionId } });
    said(sb, "Caller", "Let me tell you a long story.");
  };
  try {
    const { userId, line, mobile } = await setUp();
    await calls.answerInCloud(userId, incomingCallEvent(`live_${randomUUID()}`, mobile, line.phone));
    assert.equal(openai.controls.filter((c) => c.action === "hangup").length, 1);
    assert.equal((await pending(userId)).length, 1);
  } finally {
    calls.timing.maxCallMs = saved;
  }
});

test("when the sideband drops, the call is ended and the Mac still hears about it", async () => {
  openai.state.script = (sb) => {
    sb.send({ type: "session.started", session: { id: sb.sessionId } });
    said(sb, "Caller", "Hello?");
    setTimeout(() => sb.ws.terminate(), 50);
  };
  const { userId, line, mobile } = await setUp();
  const sessionId = `live_${randomUUID()}`;
  await calls.answerInCloud(userId, incomingCallEvent(sessionId, mobile, line.phone));
  assert.ok(openai.controls.some((c) => c.action === "hangup" && c.sessionId === sessionId));
  assert.equal((await pending(userId))[0]?.kind, "call");
});

test("which bot answers: the workspace's number is the main bot's, a bot's own number is its own", async () => {
  const { userId, iris, mobile } = await setUp();
  // The trunk dials OpenAI's address, so the number that was called is in another header.
  const event = incomingCallEvent(`live_${randomUUID()}`, mobile, "proj_abc123", [{ name: "X-Called-Number", value: iris.phone }]);
  await calls.answerInCloud(userId, event);
  const [kept] = await pending(userId);
  assert.equal((kept.payload as { botId: string }).botId, "iris");
  assert.ok(String(openai.sidebands[0].got.find((e) => e.type === "session.commentary.append")?.content).includes("it's Iris"));
});

test("a number none of the user's bots has is turned away; a failed accept leaves the call alone", async () => {
  const { userId, line, mobile } = await setUp();
  const nobody = `live_${randomUUID()}`;
  await calls.answerInCloud(userId, incomingCallEvent(nobody, mobile, newNumber()));
  // Iris has her own number, so exactly one bot takes calls on its own number: the app's fallback picks her.
  assert.equal(openai.controls.find((c) => c.sessionId === nobody)?.action, "accept");

  const lone = await setUp();
  await seedUser(lone.userId, {
    state: { owner: { name: "Alex" }, bots: [{ id: "sam", name: "Sam", isMain: true }], workspaces: [{ id: "ws_main", line: lone.line }], ownerPhones: [{ number: lone.mobile, consentAt: 1, verifiedAt: 2 }] },
  });
  const unknown = `live_${randomUUID()}`;
  await calls.answerInCloud(lone.userId, incomingCallEvent(unknown, lone.mobile, newNumber()));
  assert.deepEqual(
    openai.controls.filter((c) => c.sessionId === unknown).map((c) => [c.action, c.body]),
    [["reject", { status_code: 404 }]],
  );

  openai.state.acceptStatus = 409;
  const taken = `live_${randomUUID()}`;
  await calls.answerInCloud(userId, incomingCallEvent(taken, mobile, line.phone));
  assert.deepEqual(
    openai.controls.filter((c) => c.sessionId === taken).map((c) => c.action),
    ["accept"],
    "no reject: the Mac may have it",
  );
  assert.equal(openai.sidebands.filter((s) => s.sessionId === taken).length, 0);
  assert.equal((await pending(lone.userId)).length, 0);
});

test("the bot on the owner's call knows its apps, where it's in Slack, Telegram and Discord, that it's answering from Bops Cloud, and which messages wait", async () => {
  const { userId, line, iris, mobile } = await setUp({
    extra: {
      accounts: [
        { id: "ca_work", app: "gmail", appName: "Gmail", name: "alex@acme.com", label: "Work", status: "active", at: 1 },
        { id: "ca_home", app: "gmail", appName: "Gmail", name: "alex@home.com", status: "active", at: 1 },
        { id: "ca_notion", app: "notion", appName: "Notion", status: "active", at: 1 },
        { id: "ca_old", app: "hubspot", appName: "HubSpot", status: "expired", at: 1 },
        { id: "open:hackernews", app: "hackernews", appName: "Hacker News", status: "active", at: 1 },
        { id: "ca_iris", app: "linear", appName: "Linear", status: "active", at: 1 },
      ],
      channels: [
        { id: "ch_1", kind: "slack", botId: "sam", handle: "Acme", pairCode: "123456", status: "live", at: 1, slack: { accountId: "ca_slack", channels: [] } },
        { id: "ch_2", kind: "telegram", botId: "sam", handle: "@sam_acme_bot", pairCode: "654321", status: "live", at: 1 },
        { id: "ch_3", kind: "discord", botId: "iris", handle: "Iris", pairCode: "111111", status: "live", at: 1 },
      ],
    },
    samAccess: { ca_work: "act", ca_home: "read", ca_notion: "read", ca_old: "act", "open:hackernews": "read" },
    samVoice: "marin",
  });
  const samCall = `live_${randomUUID()}`;
  await calls.answerInCloud(userId, incomingCallEvent(samCall, mobile, line.phone));
  const session = (openai.controls.find((c) => c.action === "accept" && c.sessionId === samCall)?.body as { session: { instructions: string; audio: { output: { voice: string } } } }).session;
  assert.match(session.instructions, /When it's back you can use Alex's apps again: Gmail \(Work · alex@acme\.com: read & act; alex@home\.com: read only\), Notion \(Notion: read only\), Hacker News\./, "written as the app writes it (appList)");
  assert.ok(!session.instructions.includes("HubSpot"), "a signed-out account isn't one it can use");
  assert.ok(!session.instructions.includes("Linear"), "another bot's app isn't Sam's");
  assert.match(session.instructions, /You're also in Slack \(Acme\) and Telegram \(@sam_acme_bot\), where Alex can message you\./);
  assert.ok(!session.instructions.includes("Discord"), "Iris is in Discord, not Sam");
  assert.match(session.instructions, /You're answering from Bops Cloud: texts sent to you meanwhile wait there for the computer, and Slack messages for up to a day\./);
  assert.match(session.instructions, /Telegram messages wait at Telegram for up to a day\./);
  assert.match(session.instructions, /So if they want to send you something, take it as a note on this call, or ask them to text you\./);
  assert.ok(!session.instructions.includes(String.fromCharCode(0x2014)), "no em dashes");
  assert.equal(session.audio.output.voice, "marin", "the voice the app picked and kept for Sam");

  // Iris is in Discord only: what's sent there while the computer is away is never seen, and she says so.
  const irisCall = `live_${randomUUID()}`;
  await calls.answerInCloud(userId, incomingCallEvent(irisCall, mobile, iris.phone));
  const { instructions } = (openai.controls.find((c) => c.action === "accept" && c.sessionId === irisCall)?.body as { session: { instructions: string } }).session;
  assert.match(instructions, /You're also in Discord \(Iris\), where Alex can message you\./);
  assert.match(instructions, /texts sent to you meanwhile wait there for the computer\./);
  assert.match(instructions, /Discord messages sent before the computer is back are missed\./);
  assert.match(instructions, /take it as a note on this call, or ask them to text you\./);
  assert.ok(!/Slack|Telegram/.test(instructions), "Sam's places aren't Iris's");
  assert.ok(!instructions.includes(String.fromCharCode(0x2014)), "no em dashes");
});

test("a bot with no apps or channels yet is told only what's true", async () => {
  const { userId, line, mobile } = await setUp();
  await calls.answerInCloud(userId, incomingCallEvent(`live_${randomUUID()}`, mobile, line.phone));
  const { instructions } = (openai.controls.find((c) => c.action === "accept")?.body as { session: { instructions: string } }).session;
  assert.ok(!/apps again|You're also in|Slack|Telegram|Discord|send you something/.test(instructions));
  assert.match(instructions, /texts sent to you meanwhile wait there for the computer\./);
});

test("the called number comes from To first, and never from the caller's own headers", () => {
  const a = "+14155550101";
  const b = "+16285550102";
  const c = "+17185550103";
  assert.deepEqual(
    calls.calledNumbers([
      { name: "From", value: `<sip:${a}@x>` },
      { name: "P-Asserted-Identity", value: `<sip:${a}@x>` },
      { name: "Call-ID", value: "4155550104-1@10.0.0.1" },
      { name: "Diversion", value: `<sip:${c}@x>` },
      { name: "To", value: `<sip:${b}@sip.api.openai.com>` },
    ]),
    ["6285550102", "7185550103"],
  );
  assert.deepEqual(calls.calledNumbers([{ name: "To", value: '"+1 (415) 555-0105" <sip:proj_x@sip.api.openai.com>' }]), ["4155550105"]);
});

test("whose call it is: the first called number that is in someone's sub-account", async () => {
  const mine = newNumber();
  const theirs = newNumber();
  const me = newUserId("route-me");
  const them = newUserId("route-them");
  users.push(me, them);
  await seedUser(me, { numbers: [mine] });
  await seedUser(them, { numbers: [theirs] });
  assert.equal(await calls.userForCall(incomingCallEvent("live_x", theirs, mine).data.sip_headers), me, "To, not the caller's From");
  assert.equal(await calls.userForCall([{ name: "P-Asserted-Identity", value: `<sip:${theirs}@x>` }, { name: "To", value: "<sip:proj_x@sip.api.openai.com>" }]), null);
  assert.equal(await calls.userForCall([{ name: "To", value: `<sip:${newNumber()}@x>` }, { name: "X-Original-To", value: `<sip:${theirs}@x>` }]), them);
});
