import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { after, before, test } from "node:test";
import { closeDb, ownObject, query } from "../db.ts";
import type { CloudToMac } from "../protocol.ts";
import { KEEP_MS, slackSigned } from "../slack.ts";
import * as tunnel from "../tunnel.ts";
import { connectMac, dropUsers, fakeComposio, fakeOrgo, keyOf, newUserId, pending, prepareDb, seedUser, slackHeaders, startCloud, until, type FakeMac, type Listening } from "./edge-fakes.ts";

/** Bops' Slack app (cloud/slack.ts): its events at /hooks/slack, who each one goes to, and PUT /v1/slack/links. */

process.env.BOPS_SLACK_SIGNING_SECRET = "slack-signing-secret-for-tests";
process.env.COMPOSIO_API_KEY = "composio-test-not-a-real-key";

let orgo: Listening;
let cloud: Listening;
let composio: Awaited<ReturnType<typeof fakeComposio>>;
const users: string[] = [];
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
const b64 = (s: string) => Buffer.from(s).toString("base64");
const id = () => randomUUID().replace(/-/g, "").slice(0, 10).toUpperCase();
/** Workspaces of this run only, so test files and runs at once never share one. */
const team = `T${id()}`;
const otherTeam = `T${id()}`;
const requests = (frames: CloudToMac[]) => frames.filter((f): f is Extract<CloudToMac, { t: "req" }> => f.t === "req");

/** Slack's envelope for one event. */
const envelope = (teamId: string, event: Record<string, unknown>, eventId = `Ev${id()}`) =>
  JSON.stringify({
    token: "deprecated-verification-token",
    team_id: teamId,
    api_app_id: "A0TESTAPP",
    event: { ts: "1700000000.000100", ...event },
    type: "event_callback",
    event_id: eventId,
    event_time: 1_700_000_000,
    authorizations: [{ team_id: teamId, user_id: "UBOPS", is_bot: true }],
  });
const channelMessage = (teamId: string, channel: string, eventId?: string) =>
  envelope(teamId, { type: "message", channel, channel_type: "channel", user: "UPERSON", text: "<@UBOPS> can you check the deck?" }, eventId);
const directMessage = (teamId: string, channel: string, eventId?: string) => envelope(teamId, { type: "message", channel, channel_type: "im", user: "UPERSON", text: "123456" }, eventId);

const post = (body: string, headers: Record<string, string> = slackHeaders(body)) => fetch(`${cloud.url}/hooks/slack`, { method: "POST", headers, body });

/** A user with one Slack account's links, as PUT /v1/slack/links leaves them. */
async function withLinks(what: string, link: { team: string; channels?: string[]; dm?: string; owners?: string[]; pairing?: boolean }) {
  const userId = newUserId(what);
  users.push(userId);
  await seedUser(userId);
  await query("INSERT INTO bops.slack_links (user_id, account_id, team_id, bot_user_id, channels, dm, owners, pairing) VALUES ($1, $2, $3, 'UBOPS', $4::text[], $5, $6::text[], $7)", [
    userId,
    `ca_${userId}`,
    link.team,
    link.channels ?? [],
    link.dm ?? null,
    link.owners ?? [],
    link.pairing ?? false,
  ]);
  return userId;
}

/** A Mac that takes every replayed event (200). */
const takingMac = (userId: string) => connectMac(cloud.url, userId, { answer: () => ({ status: 200, headers: { "content-type": "text/plain" }, body: b64("ok") }) });

/** After a moment, which of these Macs got a replayed event. */
async function reached(macs: Record<string, FakeMac>, ms = 300) {
  await sleep(ms);
  return Object.entries(macs)
    .filter(([, mac]) => requests(mac.frames).length > 0)
    .map(([name]) => name)
    .sort();
}

before(async () => {
  await prepareDb();
  orgo = await fakeOrgo();
  composio = await fakeComposio();
  cloud = await startCloud();
});

after(async () => {
  tunnel.closeAll();
  await cloud.close();
  await orgo.close();
  await composio.close();
  await dropUsers(users);
  await closeDb();
});

/* ---------------- Events ---------------- */

test("Slack's v0 signature, as Slack documents it", () => {
  const body = Buffer.from(
    "token=xyzz0WbapA4vBCDEFasx0q6G&team_id=T1DC2JH3J&team_domain=testteamnow&channel_id=G8PSS9T3V&channel_name=foobar&user_id=U2CERLKJA&user_name=roadrunner&command=%2Fwebhook-collect&text=&response_url=https%3A%2F%2Fhooks.slack.com%2Fcommands%2FT1DC2JH3J%2F397700885554%2F96rGlfmibIGlgcZRskXaIFfN&trigger_id=398738663015.47445629121.803a0bc887a14d10d2c447fce8b6703c",
  );
  const signature = "v0=a2114d57b48eac39b9ad189dd8316235a7b4a8d21a10bd27519666489c69b503";
  const at = 1_531_420_618_000;
  assert.equal(slackSigned("8f742231b10e8888abcd99yyyzzz85a5", "1531420618", body, signature, at), true);
  assert.equal(slackSigned("8f742231b10e8888abcd99yyyzzz85a5", "1531420618", body, signature, at + 301_000), false, "more than 5 minutes later");
  assert.equal(slackSigned("another secret", "1531420618", body, signature, at), false);
  assert.equal(slackSigned("8f742231b10e8888abcd99yyyzzz85a5", "1531420618", Buffer.concat([body, Buffer.from("x")]), signature, at), false);
  assert.equal(slackSigned("8f742231b10e8888abcd99yyyzzz85a5", "1531420618.5", body, signature, at), false);
});

test("a delivery must carry Slack's signature and be fresh; Slack's URL check is answered here", async () => {
  const body = channelMessage(team, "C0SIGNED");
  assert.equal((await post(body, slackHeaders(body, { secret: "not the secret" }))).status, 401);
  assert.equal((await post(body, slackHeaders(body, { at: Date.now() - 6 * 60_000 }))).status, 401, "too old");
  assert.equal((await post(body, slackHeaders(body, { at: Date.now() + 6 * 60_000 }))).status, 401, "from the future");
  assert.equal((await post(body, { "content-type": "application/json" })).status, 401, "unsigned");
  assert.equal((await post("not json")).status, 400);
  const check = JSON.stringify({ token: "x", challenge: "3eZbrw1aBm2rZgRNFdxV2595E9CY3gmdALWMmHkvFXO7tYXAYM8P", type: "url_verification" });
  const res = await post(check);
  assert.equal(res.status, 200);
  assert.deepEqual(await res.json(), { challenge: "3eZbrw1aBm2rZgRNFdxV2595E9CY3gmdALWMmHkvFXO7tYXAYM8P" });
  const limited = JSON.stringify({ token: "x", type: "app_rate_limited", team_id: team, minute_rate_limited: 1_700_000_000, api_app_id: "A0TESTAPP" });
  assert.equal((await post(limited)).status, 200);
  const signed = slackHeaders(body);
  const saved = process.env.BOPS_SLACK_SIGNING_SECRET;
  delete process.env.BOPS_SLACK_SIGNING_SECRET;
  try {
    const status = (await post(body, signed)).status;
    assert.equal(status, 404, "not set up here: never a 503, which counts against the app");
  } finally {
    process.env.BOPS_SLACK_SIGNING_SECRET = saved;
  }
});

test("a channel message goes to the users with a bot in that channel, in that workspace only, never to the whole workspace", async () => {
  const channel = `C${id()}`;
  const inIt = await withLinks("slack-in", { team, channels: [channel, `C${id()}`] });
  const alsoInIt = await withLinks("slack-also", { team, channels: [channel] });
  const elsewhere = await withLinks("slack-elsewhere", { team, channels: [`C${id()}`], pairing: true, dm: `D${id()}` });
  const otherWorkspace = await withLinks("slack-other", { team: otherTeam, channels: [channel] });
  const macs = { inIt: await takingMac(inIt), alsoInIt: await takingMac(alsoInIt), elsewhere: await takingMac(elsewhere), otherWorkspace: await takingMac(otherWorkspace) };
  const body = channelMessage(team, channel);
  const headers = { ...slackHeaders(body), "x-slack-retry-num": "1", "x-slack-retry-reason": "http_timeout", "user-agent": "Slackbot 1.0", "x-bops-cloud": "forged" };
  const res = await post(body, headers);
  assert.equal(res.status, 200);
  await until(() => requests(macs.inIt.frames)[0] && requests(macs.alsoInIt.frames)[0], "both Macs to get it");
  assert.deepEqual(await reached(macs), ["alsoInIt", "inIt"]);
  const [req] = requests(macs.inIt.frames);
  assert.equal(req.method, "POST");
  assert.equal(req.path, "/api/channels/slack/events");
  assert.equal(Buffer.from(req.body, "base64").toString(), body, "the raw body, byte for byte");
  assert.deepEqual(Object.keys(req.headers).sort(), ["content-type", "x-slack-request-timestamp", "x-slack-retry-num", "x-slack-retry-reason", "x-slack-signature"]);
  for (const mac of Object.values(macs)) mac.ws.close();
  assert.equal((await pending(inIt)).length, 0, "taken by the Mac: nothing waits");
});

test("a direct message goes to the user it's with; one nobody has yet goes to the users pairing in that workspace", async () => {
  const dm = `D${id()}`;
  const withIt = await withLinks("slack-dm", { team, dm, channels: [`C${id()}`] });
  const pairing = await withLinks("slack-pairing", { team, pairing: true });
  const pairingElsewhere = await withLinks("slack-pairing-other", { team: otherTeam, pairing: true });
  const paired = await withLinks("slack-paired", { team, dm: `D${id()}` });
  const macs = { withIt: await takingMac(withIt), pairing: await takingMac(pairing), pairingElsewhere: await takingMac(pairingElsewhere), paired: await takingMac(paired) };
  await post(directMessage(team, dm));
  await until(() => requests(macs.withIt.frames)[0], "the Mac it's with");
  assert.deepEqual(await reached(macs), ["withIt"], "a known direct message goes to its user only, even with others pairing");
  for (const mac of Object.values(macs)) mac.frames.length = 0;
  await post(directMessage(team, `D${id()}`));
  await until(() => requests(macs.pairing.frames)[0], "the pairing Mac");
  assert.deepEqual(await reached(macs), ["pairing"]);
  for (const mac of Object.values(macs)) mac.ws.close();
  // A workspace where nobody is pairing: an unknown direct message goes nowhere.
  const lonely = `T${id()}`;
  const nobody = await withLinks("slack-nobody", { team: lonely, dm: `D${id()}` });
  await post(directMessage(lonely, `D${id()}`));
  await sleep(200);
  assert.equal((await pending(nobody)).length, 0);
});

test("a direct message from the person a bot is paired with goes to its user, even when they paired in a channel and the Mac doesn't know that DM yet", async () => {
  const owner = `U${id()}`;
  const fromOwner = (teamId: string, channel: string) => envelope(teamId, { type: "message", channel, channel_type: "im", user: owner, text: "can you check the deck?" });
  // Paired by "@Bops 123456" in a channel: the Mac knows the owner, not their direct message with the app.
  const pairedInChannel = await withLinks("slack-owner", { team, channels: [`C${id()}`], owners: [owner] });
  const pairing = await withLinks("slack-owner-pairing", { team, pairing: true });
  const sameIdElsewhere = await withLinks("slack-owner-other", { team: otherTeam, owners: [owner], pairing: true });
  const someoneElse = await withLinks("slack-owner-else", { team, owners: [`U${id()}`] });
  const macs = { pairedInChannel: await takingMac(pairedInChannel), pairing: await takingMac(pairing), sameIdElsewhere: await takingMac(sameIdElsewhere), someoneElse: await takingMac(someoneElse) };
  await post(fromOwner(team, `D${id()}`));
  await until(() => requests(macs.pairedInChannel.frames)[0], "the owner's Mac");
  assert.deepEqual(await reached(macs), ["pairedInChannel"], "only the user it's paired with: not the Macs pairing, nor the same id in another workspace");
  for (const mac of Object.values(macs)) mac.ws.close();
  // With the Mac away it waits for it, like any other event for that user.
  await until(() => !tunnel.isConnected(pairedInChannel), "the owner's Mac to be gone");
  await post(fromOwner(team, `D${id()}`));
  await until(async () => (await pending(pairedInChannel)).length === 1, "the owner's direct message to wait for the Mac");
  assert.equal((await pending(pairing)).length, 0);
});

test("with the Mac away, an event waits a day for it, once per event, and Slack has its 200 at once", async () => {
  const channel = `C${id()}`;
  const userId = await withLinks("slack-away", { team, channels: [channel] });
  const eventId = `Ev${id()}`;
  const body = channelMessage(team, channel, eventId);
  const started = Date.now();
  for (let i = 0; i < 2; i++) {
    const res = await post(body);
    assert.equal(res.status, 200);
  }
  assert.ok(Date.now() - started < 1_000);
  const [kept] = await until(async () => {
    const rows = await pending(userId);
    return rows.length ? rows : null;
  }, "the event to be kept");
  assert.equal(kept.kind, "slack");
  assert.equal(kept.dedupe_key, `slack:${eventId}`);
  assert.deepEqual(kept.payload, JSON.parse(body));
  const expires = (await query<{ expires_at: Date }>("SELECT expires_at FROM bops.cloud_pending WHERE id = $1", [kept.id])).rows[0].expires_at;
  assert.ok(Math.abs(expires.getTime() - (Date.now() + KEEP_MS)) < 60_000, "kept a day");
  await sleep(200);
  assert.equal((await pending(userId)).length, 1, "Slack sending it again adds nothing");

  const mac = await connectMac(cloud.url, userId);
  await until(async () => (await pending(userId)).every((p) => p.delivered_at), "the Mac to ack it");
  const delivered = mac.frames.filter((f): f is Extract<CloudToMac, { t: "event" }> => f.t === "event");
  assert.deepEqual(
    delivered.map((e) => [e.kind, (e.payload as { event_id: string }).event_id]),
    [["slack", eventId]],
  );
  mac.ws.close();
});

test("a Mac that turns an event down, or drops as it comes, gets it later", async () => {
  const channel = `C${id()}`;
  const declines = await withLinks("slack-declines", { team, channels: [channel] });
  const drops = await withLinks("slack-drops", { team, channels: [channel] });
  // An app that doesn't take Slack's events yet answers 403 (not one of its replayable paths).
  const declining = await connectMac(cloud.url, declines, { answer: () => ({ status: 403, headers: { "content-type": "application/json" }, body: b64('{"error":"not allowed"}') }) });
  const dropping = await connectMac(cloud.url, drops);
  dropping.ws.on("message", (data) => JSON.parse(String(data)).t === "req" && dropping.ws.terminate());
  await post(channelMessage(team, channel));
  await until(async () => (await pending(declines)).length === 1 && (await pending(drops)).length === 1, "both to be kept");
  declining.ws.close();
});

test("bots' own posts, edits and other events are left alone", async () => {
  const channel = `C${id()}`;
  const userId = await withLinks("slack-noise", { team, channels: [channel] });
  for (const event of [
    { type: "message", channel, user: "UBOPS", bot_id: "BBOPS", text: "Sam: done" },
    { type: "message", subtype: "message_changed", channel, message: { user: "UPERSON", text: "edited" } },
    { type: "message", subtype: "channel_join", channel, user: "UPERSON" },
    { type: "member_joined_channel", channel, user: "UPERSON" },
    { type: "message", channel: "not-a-channel", user: "UPERSON", text: "hi" },
  ]) {
    const body = envelope(team, event);
    assert.equal((await post(body)).status, 200);
  }
  // A file shared with a message, and a thread reply sent to the channel too, are people's messages.
  await post(envelope(team, { type: "message", subtype: "file_share", channel, user: "UPERSON", text: "the deck" }));
  await post(envelope(team, { type: "message", subtype: "thread_broadcast", channel, user: "UPERSON", text: "also here", thread_ts: "1.2" }));
  await until(async () => (await pending(userId)).length === 2, "the two people's messages");
  await sleep(200);
  assert.equal((await pending(userId)).length, 2);
});

test("what has waited longer than it may is dropped, not handed over", async () => {
  const userId = await withLinks("slack-stale", { team });
  await tunnel.queueForMac(userId, "slack", { event_id: "EvStale" }, "slack:EvStale", new Date(Date.now() - 1_000));
  await tunnel.queueForMac(userId, "slack", { event_id: "EvFresh" }, "slack:EvFresh", new Date(Date.now() + 60_000));
  await tunnel.queueForMac(userId, "agentphone", { event: "agent.message" }, "agentphone:kept");
  const mac = await connectMac(cloud.url, userId);
  await until(async () => (await pending(userId)).every((p) => p.delivered_at), "the Mac to ack what's left");
  const delivered = mac.frames.filter((f): f is Extract<CloudToMac, { t: "event" }> => f.t === "event").map((e) => e.kind + ":" + JSON.stringify(e.payload));
  assert.deepEqual(delivered, ['slack:{"event_id":"EvFresh"}', 'agentphone:{"event":"agent.message"}']);
  assert.deepEqual(
    (await pending(userId)).map((p) => p.dedupe_key),
    ["slack:EvFresh", "agentphone:kept"],
    "the stale one is gone",
  );
  mac.ws.close();
});

/* ---------------- PUT /v1/slack/links ---------------- */

/** A user and one of their Slack accounts, recorded as theirs (as /proxy/composio does when it's made), that Slack says is in `teamId`. */
async function slackAccount(what: string, teamId: string, identity: Record<string, unknown> = { user_id: "UBOPS", bot_id: "BBOPS" }) {
  const userId = newUserId(what);
  users.push(userId);
  await seedUser(userId);
  const account = `ca_${id()}`;
  await ownObject(userId, "composio", "connected_account", account);
  composio.slack.set(account, { ok: true, url: "https://acme.slack.com/", team: "Acme", team_id: teamId, user: "bops", ...identity });
  return { userId, account };
}

const putLinks = (userId: string, body: unknown) =>
  fetch(`${cloud.url}/v1/slack/links`, { method: "PUT", headers: { authorization: `Bearer ${keyOf(userId)}`, "content-type": "application/json" }, body: JSON.stringify(body) });

test("the workspace and the app's bot user come from Slack itself, through the user's own account; the Mac says only where its bots are", async () => {
  const { userId, account } = await slackAccount("links", team);
  const before = composio.got.length;
  const res = await putLinks(userId, { links: [{ accountId: account, channels: ["C0AAA1", "C0AAA2", "C0AAA1"], dm: "D0AAA1", pairing: true, teamId: "TFORGED", botUserId: "UFORGED" }] });
  assert.equal(res.status, 200, await res.clone().text());
  assert.deepEqual(await res.json(), { links: [{ accountId: account, teamId: team, botUserId: "UBOPS", channels: ["C0AAA1", "C0AAA2"], dm: "D0AAA1", owners: [], pairing: true }] });
  const asked = composio.got.slice(before);
  assert.equal(asked.length, 1);
  assert.equal(asked[0].headers["x-api-key"], "composio-test-not-a-real-key");
  assert.deepEqual(asked[0].body, { endpoint: "/auth.test", method: "POST", connected_account_id: account, parameters: [] });
  const row = (await query("SELECT team_id, bot_user_id, channels, dm, owners, pairing FROM bops.slack_links WHERE user_id = $1", [userId])).rows[0];
  assert.deepEqual(row, { team_id: team, bot_user_id: "UBOPS", channels: ["C0AAA1", "C0AAA2"], dm: "D0AAA1", owners: [], pairing: true });

  // Paired (with whoever sent the code), and in one more channel: Slack isn't asked again (an account never changes workspace).
  const again = await putLinks(userId, { links: [{ accountId: account, channels: ["C0AAA1", "C0AAA3"], dm: "D0AAA1", owners: ["U0ALEX", "W0ALEX", "U0ALEX"], pairing: false }] });
  assert.equal(again.status, 200);
  assert.deepEqual(((await again.json()) as { links: { owners: string[] }[] }).links[0].owners, ["U0ALEX", "W0ALEX"]);
  assert.equal(composio.got.length, before + 1);
  assert.deepEqual((await query("SELECT channels, owners, pairing FROM bops.slack_links WHERE user_id = $1", [userId])).rows[0], {
    channels: ["C0AAA1", "C0AAA3"],
    owners: ["U0ALEX", "W0ALEX"],
    pairing: false,
  });

  // An account left out is forgotten.
  assert.equal((await putLinks(userId, { links: [] })).status, 200);
  assert.equal((await query("SELECT 1 FROM bops.slack_links WHERE user_id = $1", [userId])).rowCount, 0);
});

test("links route the events: what the Mac said decides who gets them, Slack's workspace decides where", async () => {
  const { userId, account } = await slackAccount("links-route", team);
  const channel = `C${id()}`;
  const owner = `U${id()}`;
  assert.equal((await putLinks(userId, { links: [{ accountId: account, channels: [channel], owners: [owner] }] })).status, 200);
  const mac = await takingMac(userId);
  await post(channelMessage(team, channel));
  await until(() => requests(mac.frames)[0], "the event to reach the Mac");
  // The person its bot is paired with writes to the app directly, in a direct message the Mac hasn't seen yet.
  mac.frames.length = 0;
  await post(envelope(team, { type: "message", channel: `D${id()}`, channel_type: "im", user: owner, text: "can you check the deck?" }));
  await until(() => requests(mac.frames)[0], "the owner's direct message to reach the Mac");
  // The same channel id from another workspace isn't this user's.
  mac.frames.length = 0;
  await post(channelMessage(otherTeam, channel));
  await sleep(300);
  assert.equal(requests(mac.frames).length, 0);
  // A channel shared with another workspace: someone there wrote, and the event came through the installation in the user's.
  const shared = JSON.parse(channelMessage(otherTeam, channel)) as { authorizations: { team_id: string }[] };
  shared.authorizations = [{ team_id: team }];
  await post(JSON.stringify(shared));
  await until(() => requests(mac.frames)[0], "the shared channel's message to reach the Mac");
  mac.ws.close();
});

test("someone else's account, or one the cloud never saw, is refused; so is anything that isn't Slack's own kind of id", async () => {
  const { userId, account } = await slackAccount("links-mine", team);
  const theirs = await slackAccount("links-theirs", team);
  const before = composio.got.length;
  const status = async (body: unknown) => (await putLinks(userId, body)).status;
  assert.equal(await status({ links: [{ accountId: theirs.account, channels: [] }] }), 404);
  assert.equal(await status({ links: [{ accountId: "ca_never_seen", channels: [] }] }), 404);
  assert.equal(await status({ links: [{ accountId: account, channels: ["general"] }] }), 400);
  assert.equal(await status({ links: [{ accountId: account, channels: ["D0AAA1"] }] }), 400, "a direct message isn't a channel");
  assert.equal(await status({ links: [{ accountId: account, channels: [], dm: "C0AAA1" }] }), 400);
  assert.equal(await status({ links: [{ accountId: account, channels: [], pairing: "yes" }] }), 400);
  assert.equal(await status({ links: [{ accountId: account, channels: [], owners: "U0ALEX" }] }), 400);
  assert.equal(await status({ links: [{ accountId: account, channels: [], owners: ["alex"] }] }), 400);
  assert.equal(await status({ links: [{ accountId: account, channels: [], owners: ["C0AAA1"] }] }), 400, "a channel isn't a person");
  assert.equal(await status({ links: [{ accountId: account, channels: [], owners: Array.from({ length: 51 }, (_, i) => `U0ALEX${i}`) }] }), 400);
  assert.equal(await status({ links: [{ accountId: account }, { accountId: account }] }), 400);
  assert.equal(await status({ links: "all" }), 400);
  assert.equal(await status({ links: [{ accountId: "../x" }] }), 400);
  assert.equal(composio.got.length, before, "Slack was never asked");
  assert.equal((await fetch(`${cloud.url}/v1/slack/links`, { method: "PUT", body: "{}" })).status, 401);
});

test("an account Slack won't vouch for isn't recorded; a person's token names no bot", async () => {
  const revoked = await slackAccount("links-revoked", team);
  composio.slack.set(revoked.account, { ok: false, error: "invalid_auth" });
  const res = await putLinks(revoked.userId, { links: [{ accountId: revoked.account, channels: ["C0BBB1"] }] });
  assert.equal(res.status, 409);
  assert.match(((await res.json()) as { error: string }).error, /\(invalid_auth\)\. Connect Slack again\./);
  assert.equal((await query("SELECT 1 FROM bops.slack_links WHERE user_id = $1", [revoked.userId])).rowCount, 0);

  const person = await slackAccount("links-person", team, { user_id: "UPERSON" });
  const ok = await putLinks(person.userId, { links: [{ accountId: person.account, channels: ["C0BBB2"] }] });
  assert.equal(ok.status, 200);
  assert.equal(((await ok.json()) as { links: { botUserId: string | null }[] }).links[0].botUserId, null);
});
