import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { after, before, beforeEach, test } from "node:test";
import { closeDb, objectOwner, query } from "../db.ts";
import type { CloudToMac } from "../protocol.ts";
import { CLOUD_CALLER_HEADER } from "../protocol.ts";
import * as tunnel from "../tunnel.ts";
import * as voiceCalls from "../voice.ts";
import { voiceTiming } from "../hooks.ts";
import {
  agentPhoneHeaders,
  connectMac,
  dropUsers,
  fakeAgentPhone,
  fakeOpenAi,
  fakeOrgo,
  incomingCallEvent,
  newNumber,
  newUserId,
  openAiHeaders,
  pending,
  prepareDb,
  seedUser,
  startCloud,
  until,
  type Listening,
} from "./edge-fakes.ts";

/** The public webhooks (cloud/hooks.ts): AgentPhone's texts and voice turns, OpenAI's incoming calls. */

let orgo: Listening;
let cloud: Listening;
let openai: Awaited<ReturnType<typeof fakeOpenAi>>;
let ap: Awaited<ReturnType<typeof fakeAgentPhone>>;
const users: string[] = [];
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
const b64 = (s: string) => Buffer.from(s).toString("base64");
const requests = (frames: CloudToMac[]) => frames.filter((f): f is Extract<CloudToMac, { t: "req" }> => f.t === "req");

/**
 * A user whose main bot Sam has the workspace's number, on an AgentPhone agent whose webhook secret
 * the cloud keeps, and Alex's verified mobile (in bops.owner_phones). The line has no claim window open.
 */
async function setUp() {
  const userId = newUserId("hooks");
  users.push(userId);
  const agentId = `agt_${randomUUID()}`;
  const secret = `whsec_ap_${randomUUID()}`;
  const line = { phone: newNumber(), numberId: `num_${randomUUID()}`, agentId, type: "sms", scope: "sub", at: 1 };
  const mobile = newNumber();
  const state = {
    owner: { name: "Alex" },
    bots: [{ id: "sam", name: "Sam", isMain: true }],
    workspaces: [{ id: "ws_main", name: "Main", createdAt: 1, line }],
    ownerPhones: [{ number: mobile, consentAt: 1, verifiedAt: 2, userId }],
    messages: [],
  };
  await seedUser(userId, { state, subAccount: `sub_${randomUUID()}`, agents: { [agentId]: secret }, numbers: [line.phone], ownerPhones: [mobile], lines: [{ phone: line.phone, numberId: line.numberId, botId: "sam" }] });
  return { userId, agentId, secret, line, mobile };
}

const text = (agentId: string, to: string, event = "agent.message") =>
  JSON.stringify({
    event,
    channel: "sms",
    timestamp: new Date().toISOString(),
    agentId,
    data: { conversationId: "conv_1", numberId: "num_1", from: "+15559876543", to, message: "Hi Sam, are you free at 3?", direction: "inbound", receivedAt: new Date().toISOString() },
    recentHistory: [],
  });
const voice = (agentId: string, to: string, from = "+15559876543", callId = `call_${randomUUID()}`) =>
  JSON.stringify({ event: "agent.message", channel: "voice", agentId, data: { callId, from, to, status: "in-progress", transcript: "Hello?", confidence: 0.9, direction: "inbound" } });

const post = (path: string, body: string, headers: Record<string, string>) => fetch(`${cloud.url}${path}`, { method: "POST", headers, body });

before(async () => {
  await prepareDb();
  orgo = await fakeOrgo();
  // Calls the cloud answers end right away: the caller hangs up on the greeting.
  openai = await fakeOpenAi((sb) => {
    sb.send({ type: "session.started", session: { id: sb.sessionId } });
    sb.send({ type: "session.closed", reason: "remote_hangup" });
    sb.ws.close();
  });
  ap = await fakeAgentPhone();
  cloud = await startCloud();
});

beforeEach(() => {
  openai.controls.length = 0;
});

after(async () => {
  tunnel.closeAll();
  await cloud.close();
  await orgo.close();
  await openai.close();
  await ap.close();
  await dropUsers(users);
  await closeDb();
});

/* ---------------- AgentPhone ---------------- */

test("an AgentPhone delivery must be signed with its agent's secret, and fresh", async () => {
  const { userId, agentId, secret, line } = await setUp();
  const body = text(agentId, line.phone);
  const status = async (b: string, h: Record<string, string>) => (await post("/hooks/agentphone", b, h)).status;
  assert.equal(await status(body, agentPhoneHeaders("not-the-secret", body)), 400);
  assert.equal(await status(body, agentPhoneHeaders(secret, body, { at: Date.now() - 6 * 60_000 })), 400, "too old");
  assert.equal(await status(body, agentPhoneHeaders(secret, body, { at: Date.now() + 6 * 60_000 })), 400, "from the future");
  assert.equal(await status(body, { "content-type": "application/json" }), 400, "unsigned");
  const stranger = text(`agt_${randomUUID()}`, line.phone);
  assert.equal(await status(stranger, agentPhoneHeaders(secret, stranger)), 400, "an agent the cloud doesn't know");
  assert.equal(await status("not json", agentPhoneHeaders(secret, "not json")), 400);
  assert.equal((await pending(userId)).length, 0);
  const res = await post("/hooks/agentphone", body, agentPhoneHeaders(secret, body));
  assert.equal(res.status, 200);
  assert.deepEqual(await res.json(), {});
});

test("with the Mac connected, a text is replayed to it and AgentPhone gets the Mac's answer", async () => {
  const { userId, agentId, secret, line } = await setUp();
  const mac = await connectMac(cloud.url, userId, { answer: () => ({ status: 200, headers: { "content-type": "application/json" }, body: b64(JSON.stringify({ ok: true, from: "mac" })) }) });
  const body = text(agentId, line.phone);
  const headers = { ...agentPhoneHeaders(secret, body), "user-agent": "AgentPhone/1.0", "x-bops-cloud": "forged-token" };
  const res = await post("/hooks/agentphone", body, headers);
  assert.equal(res.status, 200);
  assert.deepEqual(await res.json(), { ok: true, from: "mac" });

  const [req] = requests(mac.frames);
  assert.equal(req.method, "POST");
  assert.equal(req.path, "/api/phone/agentphone");
  assert.equal(Buffer.from(req.body, "base64").toString(), body, "the raw body, byte for byte");
  assert.deepEqual(Object.keys(req.headers).sort(), ["content-type", CLOUD_CALLER_HEADER, "x-webhook-event", "x-webhook-id", "x-webhook-signature", "x-webhook-timestamp"]);
  assert.equal(req.headers["x-webhook-id"], headers["x-webhook-id"]);
  assert.deepEqual(JSON.parse(req.headers[CLOUD_CALLER_HEADER]), { owner: false }, "who sent it, as the cloud found it: not the owner, and the line has no window to claim");
  assert.equal((await pending(userId)).length, 0);
  mac.ws.close();
});

test("with the Mac away, a text waits for it, once per delivery, and AgentPhone gets 200 {}", async () => {
  const { userId, agentId, secret, line } = await setUp();
  const body = text(agentId, line.phone);
  const headers = agentPhoneHeaders(secret, body);
  for (let i = 0; i < 2; i++) {
    const res = await post("/hooks/agentphone", body, headers);
    assert.equal(res.status, 200);
    assert.deepEqual(await res.json(), {});
  }
  const reaction = text(agentId, line.phone, "agent.reaction");
  await post("/hooks/agentphone", reaction, agentPhoneHeaders(secret, reaction));
  const ended = text(agentId, line.phone, "agent.call_ended");
  assert.equal((await post("/hooks/agentphone", ended, agentPhoneHeaders(secret, ended))).status, 200);

  const kept = await pending(userId);
  assert.deepEqual(
    kept.map((p) => [p.kind, (p.payload as { event: string }).event]),
    [
      ["agentphone", "agent.message"],
      ["agentphone", "agent.reaction"],
    ],
    "the text once, the tapback, and no call summary",
  );
  assert.equal(kept[0].dedupe_key, `agentphone:${headers["x-webhook-id"]}`);
  assert.deepEqual(kept[0].payload, { ...JSON.parse(body), bopsCaller: { owner: false } }, "the delivery as it came, with who sent it");

  const mac = await connectMac(cloud.url, userId);
  await until(async () => (await pending(userId)).every((p) => p.delivered_at), "the Mac to ack both");
  const delivered = mac.frames.filter((f) => f.t === "event");
  assert.deepEqual(
    delivered.map((e) => e.t === "event" && [e.kind, (e.payload as { event: string }).event]),
    [
      ["agentphone", "agent.message"],
      ["agentphone", "agent.reaction"],
    ],
  );
  mac.ws.close();
});

test("a text the connected Mac never answers waits for it too", async () => {
  const { userId, agentId, secret, line } = await setUp();
  // A Mac that drops as soon as a request comes (asleep mid-delivery).
  const mac = await connectMac(cloud.url, userId);
  mac.ws.on("message", (data) => JSON.parse(String(data)).t === "req" && mac.ws.terminate());
  const body = text(agentId, line.phone);
  const res = await post("/hooks/agentphone", body, agentPhoneHeaders(secret, body));
  assert.deepEqual(await res.json(), {});
  assert.equal((await pending(userId)).length, 1);
});

test("a call's turn with the Mac away is answered in the cloud: the owner gets their bot, anyone else the bot that takes a message", async () => {
  const { userId, agentId, secret, line, mobile } = await setUp();
  openai.responses.length = 0;
  openai.state.respond = () => ({ text: "Hi Alex, it's Sam. **What's up?**" });
  const turn = async (from: string) => {
    const body = voice(agentId, line.phone, from);
    const res = await post("/hooks/agentphone", body, agentPhoneHeaders(secret, body));
    assert.equal(res.status, 200);
    assert.match(res.headers.get("content-type") ?? "", /application\/json/);
    return res.json();
  };
  assert.deepEqual(await turn(mobile), { text: "Hi Alex, it's Sam. What's up?" }, "spoken words only: no markdown");
  const [owner] = openai.responses;
  assert.equal(owner.authorization, "Bearer sk-test-not-a-real-key");
  assert.match(String(owner.body.instructions), /You are Sam, an AI assistant, on a phone call with Alex, who you work for\. The computer you work on is offline/);
  assert.deepEqual(owner.body.input, [{ role: "user", content: "Hello?" }]);
  assert.deepEqual((owner.body.reasoning as { effort: string }).effort, "low");

  openai.state.respond = () => ({ text: "Hi, this is Sam. Can I take a message?" });
  assert.deepEqual(await turn(newNumber()), { text: "Hi, this is Sam. Can I take a message?" });
  const stranger = openai.responses[1];
  assert.match(String(stranger.body.instructions), /The caller is someone else/);
  assert.doesNotMatch(String(stranger.body.instructions), /Alex/, "nothing about the owner, not even their name");
  await turn("");
  assert.match(String(openai.responses[2].body.instructions), /The caller is someone else/, "a withheld number isn't the owner");
  assert.equal((await pending(userId)).length, 0, "a call's turn isn't kept: the call is, once it ends");
  const tokens = await until(async () => (await query("SELECT detail FROM bops.cloud_usage WHERE user_id = $1 AND kind = 'openai.tokens'", [userId])).rows.length === 3, "each turn's tokens to be counted");
  assert.ok(tokens);
});

test("a call's turn with the Mac connected speaks the Mac's answer, which is told who's calling; a Mac error falls back to the cloud's answer", async () => {
  const { userId, agentId, secret, line, mobile } = await setUp();
  let status = 200;
  const mac = await connectMac(cloud.url, userId, { answer: () => ({ status, headers: { "content-type": "application/json" }, body: b64(JSON.stringify({ text: "Hi, it's Sam on your Mac.", hangup: false })) }) });
  const body = voice(agentId, line.phone, mobile);
  assert.deepEqual(await (await post("/hooks/agentphone", body, agentPhoneHeaders(secret, body))).json(), { text: "Hi, it's Sam on your Mac.", hangup: false });
  const [req] = requests(mac.frames);
  assert.deepEqual(JSON.parse(req.headers[CLOUD_CALLER_HEADER]), { owner: true });
  status = 500;
  openai.state.respond = () => ({ text: "Hi Alex, the computer's offline. Want me to note something?" });
  const res = await post("/hooks/agentphone", body, agentPhoneHeaders(secret, body));
  assert.equal(res.status, 200);
  assert.deepEqual(await res.json(), { text: "Hi Alex, the computer's offline. Want me to note something?" });
  const stranger = voice(agentId, line.phone, newNumber());
  status = 200;
  await post("/hooks/agentphone", stranger, agentPhoneHeaders(secret, stranger));
  assert.deepEqual(JSON.parse(requests(mac.frames).at(-1)!.headers[CLOUD_CALLER_HEADER]), { owner: false });
  mac.ws.close();
});

test("a slow answer streams: a filler first, then the answer as the final chunk", async () => {
  const { userId, agentId, secret, line, mobile } = await setUp();
  const saved = { ...voiceTiming };
  voiceTiming.fillerAfterMs = 100;
  try {
    const mac = await connectMac(cloud.url, userId, { answer: async () => (await sleep(400), { status: 200, headers: { "content-type": "application/json" }, body: b64(JSON.stringify({ text: "Done thinking.", hangup: false })) }) });
    const body = voice(agentId, line.phone, mobile);
    const res = await post("/hooks/agentphone", body, agentPhoneHeaders(secret, body));
    assert.equal(res.headers.get("content-type"), "application/x-ndjson");
    const chunks = (await res.text()).trim().split("\n").map((l) => JSON.parse(l));
    assert.deepEqual(chunks, [{ text: "Mm-hm, one sec.", interim: true }, { text: "Done thinking.", hangup: false }]);
    mac.ws.close();
    await mac.closed;

    // The cloud's own answer, when it's slow too.
    openai.state.respond = () => ({ text: "Here I am.", delayMs: 400 });
    const away = await post("/hooks/agentphone", body, agentPhoneHeaders(secret, body));
    assert.deepEqual(
      (await away.text()).trim().split("\n").map((l) => JSON.parse(l)),
      [{ text: "Mm-hm, one sec.", interim: true }, { text: "Here I am." }],
    );
    // The hello (nothing said yet) gets no filler, however long it takes.
    const pickup = JSON.stringify({ event: "agent.message", channel: "voice", agentId, data: { callId: `call_${randomUUID()}`, from: mobile, to: line.phone, transcript: "" } });
    const hello = await post("/hooks/agentphone", pickup, agentPhoneHeaders(secret, pickup));
    assert.match(hello.headers.get("content-type") ?? "", /application\/json/);
    assert.deepEqual(await hello.json(), { text: "Here I am." });
  } finally {
    Object.assign(voiceTiming, saved);
    openai.state.respond = () => ({ text: "Hi there." });
  }
});

test("a call answered in the cloud goes to the Mac when AgentPhone says it ended", async () => {
  const { userId, agentId, secret, line, mobile } = await setUp();
  openai.state.respond = () => ({ text: "Got it.", tools: [{ name: "take_message", args: { name: null, text: "Call the dentist", callback: null, say: "Noted, I'll do it when the computer's back." } }] });
  const callId = `call_${randomUUID()}`;
  const body = voice(agentId, line.phone, mobile, callId);
  assert.deepEqual(await (await post("/hooks/agentphone", body, agentPhoneHeaders(secret, body))).json(), { text: "Got it. Noted, I'll do it when the computer's back." });
  const ended = JSON.stringify({ event: "agent.call_ended", channel: "voice", agentId, data: { callId, from: mobile, to: line.phone } });
  assert.equal((await post("/hooks/agentphone", ended, agentPhoneHeaders(secret, ended))).status, 200);
  const [kept] = await until(async () => {
    const p = await pending(userId);
    return p.length ? p : null;
  }, "the call to be kept for the Mac");
  assert.equal(kept.kind, "call");
  assert.equal(kept.dedupe_key, `call:${callId}`);
  assert.deepEqual(
    { owner: kept.payload.owner, message: kept.payload.message, transcript: kept.payload.transcript, botId: kept.payload.botId },
    { owner: true, message: { text: "Call the dentist" }, transcript: "Caller: Hello?\nBot: Got it. Noted, I'll do it when the computer's back.", botId: "sam" },
  );
  assert.equal(voiceCalls.callOpen(userId, callId), false);
  openai.state.respond = () => ({ text: "Hi there." });
});

/** A user's call seconds rows (agentphone.voice_seconds), by callId. */
const callSeconds = async (userId: string) =>
  (await query<{ units: number; cost: number; detail: Record<string, unknown> }>("SELECT units::float8 AS units, cost_micros::float8 AS cost, detail FROM bops.cloud_usage WHERE user_id = $1 AND kind = 'agentphone.voice_seconds' ORDER BY id", [userId])).rows;

test("every call's seconds are counted once, at AgentPhone's 13 cents a minute: the Mac's, the cloud's, and a paused number's", async () => {
  const { userId, agentId, secret, line, mobile } = await setUp();
  // The Mac answers this one's turns: the cloud still counts its seconds, from AgentPhone's own length when it ends.
  const mac = await connectMac(cloud.url, userId, { answer: () => ({ status: 200, headers: { "content-type": "application/json" }, body: b64(JSON.stringify({ text: "Hi, it's Sam." })) }) });
  const callId = `call_${randomUUID()}`;
  const turn = voice(agentId, line.phone, mobile, callId);
  assert.equal((await post("/hooks/agentphone", turn, agentPhoneHeaders(secret, turn))).status, 200);
  await sleep(1_100);
  assert.equal((await post("/hooks/agentphone", turn, agentPhoneHeaders(secret, turn))).status, 200);
  // While it runs: the seconds since its first turn.
  const running = await until(async () => (await callSeconds(userId)).find((r) => r.detail.ref === callId && r.units >= 1));
  assert.equal(running.detail.botId, "sam");
  const ended = JSON.stringify({ event: "agent.call_ended", channel: "voice", agentId, data: { callId, from: mobile, to: line.phone, durationSeconds: 75, startedAt: "2026-10-06T10:00:00Z", endedAt: "2026-10-06T10:01:15Z" } });
  for (let i = 0; i < 2; i++) assert.equal((await post("/hooks/agentphone", ended, agentPhoneHeaders(secret, ended))).status, 200);
  const done = await until(async () => (await callSeconds(userId)).find((r) => r.detail.ref === callId && r.units === 75));
  assert.equal(done.cost, Math.ceil((75 * 130_000) / 60));
  assert.equal((await callSeconds(userId)).filter((r) => r.detail.ref === callId).length, 1, "one row for the call, however often it's delivered");
  mac.ws.close();

  // A call to a paused plan number: nobody answers it but AgentPhone, which still bills it.
  await query("UPDATE bops.phone_lines SET status = 'paused' WHERE user_id = $1", [userId]);
  const pausedId = `call_${randomUUID()}`;
  const pausedTurn = voice(agentId, line.phone, newNumber(), pausedId);
  assert.deepEqual(await (await post("/hooks/agentphone", pausedTurn, agentPhoneHeaders(secret, pausedTurn))).json(), { text: "This number is paused right now. Goodbye.", hangup: true });
  const pausedEnd = JSON.stringify({ event: "agent.call_ended", channel: "voice", agentId, data: { callId: pausedId, to: line.phone, startedAt: "2026-10-06T10:00:00Z", endedAt: "2026-10-06T10:00:06Z" } });
  assert.equal((await post("/hooks/agentphone", pausedEnd, agentPhoneHeaders(secret, pausedEnd))).status, 200);
  const paused = await until(async () => (await callSeconds(userId)).find((r) => r.detail.ref === pausedId));
  assert.deepEqual([paused.units, paused.cost], [6, 13_000]);
  // No estimated minutes on top of the seconds, for any call.
  assert.equal((await query("SELECT 1 FROM bops.cloud_usage WHERE user_id = $1 AND kind = 'call.minutes'", [userId])).rowCount, 0);
});

/* ---------------- OpenAI ---------------- */

test("an OpenAI webhook must carry a good Standard Webhooks signature", async () => {
  const body = JSON.stringify({ id: "evt_1", object: "event", type: "response.completed", created_at: 1, data: { id: "resp_1" } });
  const status = async (h: Record<string, string>) => (await post("/hooks/openai", body, h)).status;
  assert.equal(await status({ "content-type": "application/json" }), 400);
  assert.equal(await status(openAiHeaders(body, { secret: `whsec_${Buffer.from("another secret").toString("base64")}` })), 400);
  assert.equal(await status(openAiHeaders(body, { at: Date.now() - 6 * 60_000 })), 400, "too old");
  const good = openAiHeaders(body);
  assert.equal(await status({ ...good, "webhook-signature": `v1,${b64("x".repeat(32))} ${good["webhook-signature"]}` }), 200, "any of several signatures may match");
  assert.equal(await status({ ...good, "webhook-signature": good["webhook-signature"].replace("v1,", "v2,") }), 400, "only v1 signatures count");

  const saved = process.env.OPENAI_WEBHOOK_SECRET;
  delete process.env.OPENAI_WEBHOOK_SECRET;
  try {
    assert.equal(await status(good), 503);
  } finally {
    process.env.OPENAI_WEBHOOK_SECRET = saved;
  }
  assert.equal(openai.controls.length, 0, "other events are only answered");
});

test("an incoming call is recorded as the user's and handed to their Mac, which takes it", async () => {
  const { userId, line } = await setUp();
  const mac = await connectMac(cloud.url, userId, { answer: async () => (await sleep(1_500), { status: 200, headers: { "content-type": "application/json" }, body: b64('{"ok":true}') }) });
  const sessionId = `live_${randomUUID()}`;
  const body = JSON.stringify(incomingCallEvent(sessionId, newNumber(), line.phone));
  const headers = openAiHeaders(body);
  const started = Date.now();
  const res = await post("/hooks/openai", body, headers);
  assert.equal(res.status, 200);
  assert.ok(Date.now() - started < 1_000, "OpenAI is answered before the Mac is");

  const req = await until(() => requests(mac.frames)[0], "the call to reach the Mac");
  assert.equal(req.path, "/api/phone/openai");
  assert.equal(Buffer.from(req.body, "base64").toString(), body);
  assert.deepEqual(Object.keys(req.headers).sort(), ["content-type", "webhook-id", "webhook-signature", "webhook-timestamp", CLOUD_CALLER_HEADER].sort());
  assert.equal(req.headers["webhook-signature"], headers["webhook-signature"]);
  assert.deepEqual(JSON.parse(req.headers[CLOUD_CALLER_HEADER]), { owner: false }, "who's calling, as the cloud found it");
  assert.equal(await objectOwner("openai", sessionId), userId, "recorded before the Mac got it, so the proxy lets the Mac accept it");
  const kind = await query<{ kind: string }>("SELECT kind FROM bops.cloud_objects WHERE provider = 'openai' AND object_id = $1", [sessionId]);
  assert.equal(kind.rows[0].kind, "live_session");
  await sleep(Math.max(0, started + 2_000 - Date.now()));
  assert.equal(openai.controls.length, 0, "the Mac answered in time, so the cloud left the call to it");
  mac.ws.close();
});

test("the owner's call the Mac turns down, or while it's away, is answered in the cloud, once", async () => {
  const { userId, line, mobile } = await setUp();
  const mac = await connectMac(cloud.url, userId, { answer: () => ({ status: 503, headers: {}, body: "" }) });
  const declined = `live_${randomUUID()}`;
  const body = JSON.stringify(incomingCallEvent(declined, mobile, line.phone));
  assert.equal((await post("/hooks/openai", body, openAiHeaders(body))).status, 200);
  await until(() => openai.controls.find((c) => c.sessionId === declined && c.action === "accept"), "the cloud to answer");
  mac.ws.close();
  await mac.closed;

  const away = `live_${randomUUID()}`;
  const event = JSON.stringify(incomingCallEvent(away, mobile, line.phone));
  await post("/hooks/openai", event, openAiHeaders(event));
  await post("/hooks/openai", event, openAiHeaders(event, { id: "evt_retry" }));
  await until(async () => (await pending(userId)).length === 2, "both calls to be kept for the Mac");
  assert.equal(openai.controls.filter((c) => c.sessionId === away && c.action === "accept").length, 1, "a second delivery of the same call is ignored");
  assert.deepEqual(
    (await pending(userId)).map((p) => p.dedupe_key),
    [`call:${declined}`, `call:${away}`],
  );
});

test("the owner's call the Mac doesn't take within 4 s is answered in the cloud", async () => {
  const { userId, line, mobile } = await setUp();
  const mac = await connectMac(cloud.url, userId);
  const sessionId = `live_${randomUUID()}`;
  const body = JSON.stringify(incomingCallEvent(sessionId, mobile, line.phone));
  const started = Date.now();
  await post("/hooks/openai", body, openAiHeaders(body));
  await until(() => openai.controls.find((c) => c.sessionId === sessionId && c.action === "accept"), "the cloud to answer", 8_000);
  const waited = Date.now() - started;
  assert.ok(waited >= 3_900 && waited < 6_000, `waited ${waited} ms`);
  assert.equal(requests(mac.frames).length, 1);
  await until(async () => (await pending(userId)).length === 1, "the call to be kept for the Mac");
  mac.ws.close();
});

test("anyone else's call while the Mac is away is turned away before it connects, and nothing waits for the Mac", async () => {
  const { userId, line } = await setUp();
  const sessionId = `live_${randomUUID()}`;
  const body = JSON.stringify(incomingCallEvent(sessionId, newNumber(), line.phone));
  assert.equal((await post("/hooks/openai", body, openAiHeaders(body))).status, 200);
  const turnedAway = await until(() => openai.controls.find((c) => c.sessionId === sessionId), "the call to be turned away");
  assert.deepEqual([turnedAway.action, turnedAway.body], ["reject", { status_code: 403 }]);
  await sleep(200);
  assert.equal(openai.controls.filter((c) => c.sessionId === sessionId).length, 1, "never accepted");
  assert.equal(openai.sidebands.filter((s) => s.sessionId === sessionId).length, 0);
  assert.equal((await pending(userId)).length, 0);
  assert.equal(ap.sent.length, 0, "and nobody is texted about it");
});

test("a call to a number no user has is left alone, even when the caller is a Bops number", async () => {
  const { userId, line } = await setUp();
  const mac = await connectMac(cloud.url, userId);
  const sessionId = `live_${randomUUID()}`;
  const body = JSON.stringify(incomingCallEvent(sessionId, line.phone, newNumber(), [{ name: "P-Asserted-Identity", value: `<sip:${line.phone}@carrier.example>` }]));
  assert.equal((await post("/hooks/openai", body, openAiHeaders(body))).status, 200);
  await sleep(300);
  assert.equal(openai.controls.length, 0, "not accepted or rejected");
  assert.equal(requests(mac.frames).length, 0, "and not sent to the caller's own user");
  assert.equal(await objectOwner("openai", sessionId), null);
  mac.ws.close();
});
