import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { after, before, test } from "node:test";
import { closeDb, query } from "../db.ts";
import { callerVerdict, linkVerifiedNumber, recordLine } from "../lines.ts";
import { CLOUD_CALLER_HEADER, type CloudToMac, type PhoneLine, type PhoneLinesResult } from "../protocol.ts";
import * as tunnel from "../tunnel.ts";
import {
  agentPhoneHeaders,
  connectMac,
  dropUsers,
  fakeOpenAi,
  fakeOrgo,
  keyOf,
  lineRow,
  newNumber,
  newUserId,
  pending,
  prepareDb,
  seedUser,
  startCloud,
  until,
  type Listening,
  type SeedLine,
} from "./edge-fakes.ts";

/** Who owns each line (cloud/lines.ts): "first caller claims it", the check on every delivery, and the app's routes. */

let orgo: Listening;
let cloud: Listening;
let openai: Awaited<ReturnType<typeof fakeOpenAi>>;
const users: string[] = [];
const b64 = (s: string) => Buffer.from(s).toString("base64");
const requests = (frames: CloudToMac[]) => frames.filter((f): f is Extract<CloudToMac, { t: "req" }> => f.t === "req");
const owners = async (userId: string) =>
  (await query<{ phone_e164: string; verification_ref: string | null }>("SELECT phone_e164, verification_ref FROM bops.owner_phones WHERE orgo_user_id = $1 ORDER BY phone_e164", [userId])).rows;

/** A user with Sam's number on an agent the cloud knows; `line` sets its owner or its claim window. */
async function setUp(line: Partial<SeedLine> = { claimForMs: 15 * 60_000 }, ownerPhones: string[] = []) {
  const userId = newUserId("lines");
  users.push(userId);
  const agentId = `agt_${randomUUID()}`;
  const secret = `whsec_ap_${randomUUID()}`;
  const phone = newNumber();
  const numberId = `num_${randomUUID()}`;
  const state = { owner: { name: "Alex" }, bots: [{ id: "sam", name: "Sam", isMain: true }], workspaces: [{ id: "ws_main", name: "Main", createdAt: 1, line: { phone, numberId, agentId, type: "sms", scope: "sub", at: 1 } }] };
  await seedUser(userId, { state, subAccount: `sub_${randomUUID()}`, agents: { [agentId]: secret }, ownerPhones, lines: [{ phone, numberId, botId: "sam", ...line }] });
  return { userId, agentId, secret, phone, numberId };
}

const as = (userId: string, method: string, path: string, json?: unknown) =>
  fetch(`${cloud.url}${path}`, { method, headers: { authorization: `Bearer ${keyOf(userId)}`, ...(json ? { "content-type": "application/json" } : {}) }, body: json ? JSON.stringify(json) : undefined });

/** The answers of the line routes, as the app reads them. */
const linesFor = async (userId: string) => (await (await as(userId, "GET", "/v1/phone/lines")).json()) as PhoneLinesResult;
const lineAnswer = async (userId: string, method: string, path: string, json: unknown) => (await (await as(userId, method, path, json)).json()) as { line: PhoneLine };

const textTo = (agentId: string, to: string, from: string, message = "Hi Sam") =>
  JSON.stringify({ event: "agent.message", channel: "sms", agentId, data: { from, to, message, direction: "inbound" } });

before(async () => {
  await prepareDb();
  orgo = await fakeOrgo();
  openai = await fakeOpenAi();
  cloud = await startCloud();
});

after(async () => {
  tunnel.closeAll();
  await cloud.close();
  await orgo.close();
  await openai.close();
  await dropUsers(users);
  await closeDb();
});

/* ---------------- First caller claims it ---------------- */

test("the first caller in a line's 15 minutes becomes its owner, and only one wins a race", async () => {
  const { userId, phone } = await setUp();
  const callers = Array.from({ length: 6 }, () => newNumber());
  const verdicts = await Promise.all(callers.map((from, i) => callerVerdict(userId, phone, from, i % 2 ? "call" : "text")));
  const won = verdicts.map((v, i) => [v, callers[i]] as const).filter(([v]) => v.owner);
  assert.equal(won.length, 1, "exactly one caller is the owner");
  const [[verdict, winner]] = won;
  assert.ok(verdict.claimed === "call" || verdict.claimed === "text");
  const row = await lineRow(phone);
  assert.equal(row.owner_number, winner);
  assert.equal(row.claimed_via, verdict.claimed);
  assert.deepEqual(await owners(userId), [{ phone_e164: winner, verification_ref: `claim:${verdict.claimed}` }], "and is one of the user's numbers");
  // From now on that number is the owner, and the others never are.
  assert.deepEqual(await callerVerdict(userId, phone, winner, "call"), { owner: true });
  for (const from of callers.filter((c) => c !== winner)) assert.deepEqual(await callerVerdict(userId, phone, from, "call"), { owner: false });
});

test("after the 15 minutes, or with no window open, a stranger claims nothing", async () => {
  const closed = await setUp({ claimForMs: -1000 });
  assert.deepEqual(await callerVerdict(closed.userId, closed.phone, newNumber(), "call"), { owner: false });
  const never = await setUp({});
  assert.deepEqual(await callerVerdict(never.userId, never.phone, newNumber(), "text"), { owner: false });
  assert.equal((await lineRow(never.phone)).owner_number, null);
  assert.deepEqual(await owners(never.userId), []);
});

test("a tapback, a withheld number, another Bops number, or a number another account verified can't claim a line", async () => {
  const { userId, phone } = await setUp();
  assert.deepEqual(await callerVerdict(userId, phone, newNumber()), { owner: false }, "no claim asked for");
  assert.deepEqual(await callerVerdict(userId, phone, "", "call"), { owner: false });
  assert.deepEqual(await callerVerdict(userId, phone, "anonymous", "call"), { owner: false });
  const other = await setUp({});
  assert.deepEqual(await callerVerdict(userId, phone, other.phone, "call"), { owner: false }, "a bot's number calling");
  const theirs = newNumber();
  await setUp({}, [theirs]);
  assert.deepEqual(await callerVerdict(userId, phone, theirs, "call"), { owner: false }, "verified on another Bops account");
  assert.equal((await lineRow(phone)).owner_number, null, "still open for its real owner");
  const mine = newNumber();
  assert.deepEqual(await callerVerdict(userId, phone, mine, "call"), { owner: true, claimed: "call" });
});

test("a number the user verified is the owner on every line of theirs; a line's owner is the owner there", async () => {
  const verified = newNumber();
  const { userId, phone } = await setUp({}, [verified]);
  assert.deepEqual(await callerVerdict(userId, phone, verified, "call"), { owner: true });
  assert.deepEqual(await callerVerdict(userId, newNumber(), verified), { owner: true }, "a number the cloud has no line for");
  const linked = newNumber();
  const second = await setUp({ owner: linked, via: "text" });
  assert.deepEqual(await callerVerdict(second.userId, second.phone, linked), { owner: true });
  assert.deepEqual(await callerVerdict(userId, phone, linked), { owner: false }, "another user's owner isn't this user's");
});

test("a number verified with a texted code links the user's lines that have no owner, closing their windows", async () => {
  const { userId, phone } = await setUp();
  const verified = newNumber();
  await linkVerifiedNumber(userId, verified);
  const row = await lineRow(phone);
  assert.deepEqual([row.owner_number, row.claimed_via], [verified, "sms_code"]);
  assert.deepEqual(await callerVerdict(userId, phone, newNumber(), "call"), { owner: false }, "nobody else can claim it now");
});

/* ---------------- Through the webhook ---------------- */

test("a text in the line's 15 minutes claims it, and the Mac is told with the replayed text; STOP and group texts don't claim", async () => {
  const { userId, agentId, secret, phone } = await setUp();
  const mac = await connectMac(cloud.url, userId, { answer: () => ({ status: 200, headers: { "content-type": "application/json" }, body: b64('{"ok":true}') }) });
  const stop = textTo(agentId, phone, newNumber(), "STOP");
  await fetch(`${cloud.url}/hooks/agentphone`, { method: "POST", headers: agentPhoneHeaders(secret, stop), body: stop });
  const group = JSON.stringify({ event: "agent.message", channel: "imessage", agentId, data: { from: newNumber(), senderIdentifier: newNumber(), to: phone, message: "hi all", group: { groupId: "g1", groupName: "Friends" } } });
  await fetch(`${cloud.url}/hooks/agentphone`, { method: "POST", headers: agentPhoneHeaders(secret, group), body: group });
  assert.equal((await lineRow(phone)).owner_number, null);
  const mine = newNumber();
  const body = textTo(agentId, phone, mine);
  assert.equal((await fetch(`${cloud.url}/hooks/agentphone`, { method: "POST", headers: agentPhoneHeaders(secret, body), body })).status, 200);
  const verdicts = requests(mac.frames).map((r) => JSON.parse(r.headers[CLOUD_CALLER_HEADER]));
  assert.deepEqual(verdicts, [{ owner: false }, { owner: false }, { owner: true, claimed: "text" }]);
  assert.equal((await lineRow(phone)).owner_number, mine);
  mac.ws.close();
  await mac.closed;
  // With the Mac away, the kept text carries who sent it.
  const again = textTo(agentId, phone, mine, "Are you there?");
  await fetch(`${cloud.url}/hooks/agentphone`, { method: "POST", headers: agentPhoneHeaders(secret, again), body: again });
  const [kept] = await pending(userId);
  assert.deepEqual(kept.payload.bopsCaller, { owner: true });
});

test("a first call in the line's 15 minutes claims it: the bot says it's linked, and the call reaches the Mac as claimed", async () => {
  const { userId, agentId, secret, phone } = await setUp();
  openai.responses.length = 0;
  openai.state.respond = () => ({ text: "You're linked. Hi Alex!", tools: [{ name: "end_call", args: { say: "Bye!" } }] });
  const mine = newNumber();
  const callId = `call_${randomUUID()}`;
  const body = JSON.stringify({ event: "agent.message", channel: "voice", agentId, data: { callId, from: mine, to: phone, transcript: "" } });
  const res = await fetch(`${cloud.url}/hooks/agentphone`, { method: "POST", headers: agentPhoneHeaders(secret, body), body });
  assert.deepEqual(await res.json(), { text: "You're linked. Hi Alex! Bye!", hangup: true });
  assert.match(String(openai.responses[0].body.instructions), /just linked their phone to you/);
  assert.equal(openai.responses.length, 1);
  const [kept] = await until(async () => {
    const p = await pending(userId);
    return p.length ? p : null;
  }, "the call to be kept for the Mac");
  assert.deepEqual([kept.payload.owner, kept.payload.claimed, kept.payload.from], [true, "call", mine]);
  openai.state.respond = () => ({ text: "Hi there." });
});

test("a call whose delivery doesn't name the number called still finds its line, by the agent", async () => {
  const { agentId, secret, phone } = await setUp();
  openai.state.respond = () => ({ text: "Hi!" });
  const mine = newNumber();
  const body = JSON.stringify({ event: "agent.message", channel: "voice", agentId, data: { callId: `call_${randomUUID()}`, from: mine, transcript: "" } });
  assert.equal((await fetch(`${cloud.url}/hooks/agentphone`, { method: "POST", headers: agentPhoneHeaders(secret, body), body })).status, 200);
  assert.equal((await lineRow(phone)).owner_number, mine);
});

/* ---------------- The app's routes ---------------- */

test("GET /v1/phone/lines lists the user's lines with their owner or open window, and only theirs", async () => {
  const a = await setUp({ owner: newNumber(), via: "call" });
  const b = await setUp();
  const mine = await linesFor(a.userId);
  assert.equal(mine.lines.length, 1);
  const [line] = mine.lines;
  assert.equal(line.number, a.phone);
  assert.equal(line.numberId, a.numberId);
  assert.equal(line.botId, "sam");
  assert.equal(line.owner?.via, "call");
  assert.equal(line.claimUntil, null);
  const theirs = await linesFor(b.userId);
  assert.equal(theirs.lines[0].owner, null);
  assert.ok(Date.parse(theirs.lines[0].claimUntil ?? "") > Date.now() + 14 * 60_000);
  assert.equal((await fetch(`${cloud.url}/v1/phone/lines`)).status, 401);
});

test("PUT /v1/phone/lines records the app's line for its bot; only a number of the user's; `open` starts 15 minutes once", async () => {
  const { userId, phone, numberId } = await setUp({});
  const other = await setUp({});
  assert.equal((await as(userId, "PUT", "/v1/phone/lines", { numberId: other.numberId, botId: "sam" })).status, 404, "another user's number");
  assert.equal((await as(userId, "PUT", "/v1/phone/lines", { numberId: "num_nobody" })).status, 404);
  const kept = await lineAnswer(userId, "PUT", "/v1/phone/lines", { numberId, botId: "iris", workspaceId: "ws_2" });
  assert.deepEqual([kept.line.botId, kept.line.workspaceId, kept.line.claimUntil], ["iris", "ws_2", null], "no window unless asked");
  const opened = await lineAnswer(userId, "PUT", "/v1/phone/lines", { numberId, open: true });
  assert.equal(opened.line.botId, "iris", "kept when not given");
  const ends = Date.parse(opened.line.claimUntil ?? "");
  assert.ok(ends > Date.now() + 14 * 60_000);
  const again = await lineAnswer(userId, "PUT", "/v1/phone/lines", { numberId, open: true });
  assert.equal(Date.parse(again.line.claimUntil ?? ""), ends, "a window that's running keeps its own end");
  assert.equal((await lineRow(phone)).user_id, userId);
});

test("unlinking a line's owner reopens 15 minutes and drops the number from the user's own, unless another line has it", async () => {
  const mine = newNumber();
  const { userId, phone, numberId } = await setUp({});
  assert.deepEqual(await callerVerdict(userId, phone, mine, "call"), { owner: false }, "no window yet");
  await as(userId, "PUT", "/v1/phone/lines", { numberId, open: true });
  assert.deepEqual(await callerVerdict(userId, phone, mine, "call"), { owner: true, claimed: "call" });
  // The same number owns a second line of this user's.
  const second = newNumber();
  await seedUser(userId, { lines: [{ phone: second, numberId: `num_${randomUUID()}`, owner: mine, via: "call" }] });
  const r = await lineAnswer(userId, "POST", "/v1/phone/lines/unlink", { numberId });
  assert.equal(r.line.owner, null);
  assert.ok(Date.parse(r.line.claimUntil ?? "") > Date.now() + 14 * 60_000);
  assert.deepEqual(await callerVerdict(userId, phone, mine), { owner: true }, "still theirs through the other line");
  await as(userId, "POST", "/v1/phone/owners/remove", { number: mine });
  assert.deepEqual(await owners(userId), []);
  assert.equal((await lineRow(second)).owner_number, null);
  assert.deepEqual(await callerVerdict(userId, phone, mine), { owner: false }, "removed: no longer the user anywhere");
  assert.equal((await as(userId, "POST", "/v1/phone/lines/unlink", { numberId: "num_nobody" })).status, 404);
  assert.equal((await as(userId, "POST", "/v1/phone/owners/remove", { number: "nope" })).status, 400);
});

test("a number that moves to another user starts over: no owner, no window", async () => {
  const { userId, phone, numberId } = await setUp({ owner: newNumber(), via: "call" });
  const next = newUserId("lines");
  users.push(next);
  await seedUser(next, { subAccount: `sub_${randomUUID()}` });
  const line = await recordLine(next, { id: numberId, phoneNumber: phone });
  assert.equal(line?.owner, null);
  assert.equal(line?.claimUntil, null);
  assert.equal((await lineRow(phone)).user_id, next);
  assert.deepEqual((await linesFor(userId)).lines, []);
});
