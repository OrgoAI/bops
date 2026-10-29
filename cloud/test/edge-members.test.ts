import assert from "node:assert/strict";
import { createHmac } from "node:crypto";
import { after, before, test } from "node:test";
import { closeDb, query } from "../db.ts";
import { closeAll } from "../live.ts";
import { resetMembers } from "../members.ts";
import { MEMBER_ACTS_A_MINUTE, type CloudToMac, type MemberActPayload, type SharedWsState, type SharedWsUnchanged } from "../protocol.ts";
import { connectMac, dropUsers, fakeOrgo, keyOf, newUserId, pending, prepareDb, startCloud, until, type Listening } from "./edge-fakes.ts";

/**
 * A shared workspace's state, read by a member (members.ts GET /v1/ws/:projectId/state): the owner's
 * workspace as the allow list shows it, with the bots the owner gave them (found by the email Orgo's
 * profile gives them; someone given none, no bot) and everything of each, its chats' newest messages
 * (the owner's own and one kept "between us" too) and none of another workspace's or of a bot they
 * weren't given, a copy that's still current answered in a line, and the stream's "state" events carrying
 * the same fingerprint the read does. orgo-web is a fake on localhost. A member with Write acts (POST
 * /v1/ws/:projectId/act): what they did waits for the owner's Mac in bops.cloud_pending, once per key, is
 * handed over on the tunnel, counted a minute at a time, and dropped when orgo-web says they're out.
 */

let orgo: Listening;
let cloud: Listening;
const owner = newUserId("owner");
const member = newUserId("member");
const outsider = newUserId("outsider");
const both = newUserId("both");
const actOwner = newUserId("act-owner");
const writer = newUserId("writer");
const other = newUserId("other-writer");
const appsOwner = newUserId("apps-owner");
const teamMember = newUserId("orgo");
const APPS_PROJECT = "77777777-8888-9999-aaaa-bbbbbbbbbbbb";
const ACT_PROJECT = "66666666-7777-8888-9999-000000000000";
const SECRET = "edge-members-plan-secret-0123456789abcdef"; // gitleaks:allow (made up for this test)
const PROJECT = "11111111-2222-3333-4444-555555555555";
const roles: Record<string, unknown> = {};

before(async () => {
  process.env.BOPS_CLOUD_PLAN_SECRET = SECRET;
  await prepareDb();
  roles[`${member} ${PROJECT}`] = { role: "member", ownerUserId: owner, bopsWsId: "ws_acme", name: "Acme" };
  orgo = await fakeOrgo(roles);
  cloud = await startCloud();
  resetMembers();
});

after(async () => {
  closeAll();
  await cloud.close();
  await orgo.close();
  await query("DELETE FROM bops.chat_messages WHERE user_id = ANY($1::text[])", [[owner, member]]);
  await query("DELETE FROM bops.cloud_limits WHERE key = ANY($1::text[])", [[`member:act:${writer}`, `member:act:${other}`]]);
  await query("DELETE FROM bops.cloud_limits WHERE key = $1", [`member:act:${teamMember}`]);
  await dropUsers([owner, member, outsider, both, actOwner, writer, other, appsOwner, teamMember]);
  await closeDb();
});

const headers = (userId: string) => ({ Authorization: `Bearer ${keyOf(userId)}`, "x-bops-user": userId, "x-bops-protocol": "2", "x-bops-device": "mac-o", "content-type": "application/json" });
const blob = (acmeStatus: string) => ({
  workspaces: [
    { id: "ws_main", name: "Main", orbitKey: "main-orbit" },
    { id: "ws_acme", name: "Acme", createdAt: 1, orbitKey: "acme-orbit", memberAccess: { [`${member}@example.com`]: { others: "none", bots: { max: "read" } } } },
  ],
  bots: [
    { id: "boppy", name: "Boppy", isMain: true },
    { id: "max", name: "Max", isMain: true, workspaceId: "ws_acme", appsKey: "apps-key-max", keys: ["STRIPE_SECRET_KEY"] },
    { id: "dana", name: "Dana", workspaceId: "ws_acme" },
  ],
  chats: [
    { id: "bot:boppy", kind: "bot", botIds: ["boppy"] },
    { id: "bot:max", kind: "bot", botIds: ["max"], workspaceId: "ws_acme", readAt: 7 },
    { id: "bot:dana", kind: "bot", botIds: ["dana"], workspaceId: "ws_acme" },
    { id: "pair", kind: "group", botIds: ["max", "dana"], workspaceId: "ws_acme", title: "Hiring" },
  ],
  sessions: [
    { id: "s1", botId: "max", title: "Leads", status: acmeStatus, env: { remoteUrl: "https://secret" } },
    { id: "s2", botId: "max", chatId: "bot:max", title: "Pricing", status: "done", answer: "Raise it 10%", secret: true },
    { id: "s3", botId: "dana", chatId: "bot:dana", title: "Shortlist", status: "running" },
  ],
  routines: [{ id: "r1", botId: "dana", title: "Dana's daily" }],
  vault: [{ id: "v1", username: "owner@example.com" }],
  usage: { events: [1, 2] },
});
const read = async (userId: string, qs = "") => {
  const res = await fetch(`${cloud.url}/v1/ws/${PROJECT}/state${qs}`, { headers: { Authorization: `Bearer ${keyOf(userId)}` } });
  return { status: res.status, body: (await res.json()) as SharedWsState & Partial<SharedWsUnchanged> };
};

test("a member reads all of the bot they were given as it's shown, the owner's own messages too, and nothing of another bot", async () => {
  assert.equal((await fetch(`${cloud.url}/v1/state`, { method: "PUT", headers: headers(owner), body: JSON.stringify({ base: 0, state: blob("running") }) })).status, 200);
  const msgs = [
    { id: "m1", chatId: "bot:max", role: "user", text: "find leads", at: 10 },
    { id: "m2", chatId: "bot:max", role: "bot", botId: "max", text: "on it", at: 11, channel: { linkId: "slack-1", chat: "C1" } },
    { id: "m3", chatId: "bot:max", role: "user", text: "between us", at: 12, secret: true },
    { id: "m3b", chatId: "bot:max", role: "bot", botId: "max", text: "I won't mention it", at: 13 },
    { id: "m4", chatId: "bot:boppy", role: "user", text: "main workspace only", at: 13 },
    { id: "d1", chatId: "bot:dana", role: "user", text: "only for the shortlist", at: 14 },
    { id: "g1", chatId: "pair", role: "user", text: "the hiring plan", at: 15 },
  ];
  assert.equal((await fetch(`${cloud.url}/v1/messages`, { method: "POST", headers: headers(owner), body: JSON.stringify({ upsert: msgs, remove: [] }) })).status, 200);

  const { status, body } = await read(member);
  assert.equal(status, 200);
  assert.equal(body.wsId, "ws_acme");
  assert.equal(body.role, "member");
  assert.deepEqual(body.state.workspace, { id: "ws_acme", name: "Acme", createdAt: 1 });
  assert.deepEqual(body.state.bots, [{ id: "max", name: "Max", isMain: true, workspaceId: "ws_acme" }]);
  assert.deepEqual(body.state.chats, [{ id: "bot:max", kind: "bot", botIds: ["max"], workspaceId: "ws_acme" }]);
  assert.deepEqual(body.state.sessions, [
    { id: "s1", botId: "max", title: "Leads", status: "running" },
    { id: "s2", botId: "max", chatId: "bot:max", title: "Pricing", status: "done", answer: "Raise it 10%" },
  ]);
  assert.deepEqual(body.state.routines, [], "Dana's routine isn't theirs");
  assert.deepEqual(
    body.messages.map((m) => m.id),
    ["m1", "m2", "m3", "m3b"],
    "all of Max's chat, the owner's own messages and the one kept between us with its answer; nothing of another workspace or of Dana",
  );
  assert.deepEqual(body.messages[1], { id: "m2", chatId: "bot:max", role: "bot", botId: "max", text: "on it", at: 11 });
  assert.deepEqual(body.messages[2], { id: "m3", chatId: "bot:max", role: "user", text: "between us", at: 12 });
  assert.deepEqual(body.more, []);
  const text = JSON.stringify(body);
  for (const secret of ["orbit", "apps-key", "STRIPE", "https://secret", "owner@example.com", "Boppy", "main workspace only", "slack-1", "usage", "memberAccess", `${member}@example.com`, "Dana", "dana", "shortlist", "Shortlist", "pair", "hiring", "Hiring"])
    assert.ok(!text.includes(secret), `"${secret}" isn't shown`);

  // Still current: answered in a line. One chat's older page: only a chat of the workspace.
  const again = await read(member, `?have=${body.hash}.${body.seq}`);
  assert.deepEqual(again.body, { hash: body.hash, seq: body.seq, unchanged: true });
  assert.equal((await read(member, "?chat=bot:max&before=11")).body.messages.length, 1);
  assert.equal((await read(member, "?chat=bot:boppy&before=99")).status, 404);
  assert.equal((await read(member, "?chat=bot:dana&before=99")).status, 404, "nor a page of Dana's chat");
  // The owner reading their own project's state: every bot and chat of it; anyone else gets 404.
  roles[`${owner} ${PROJECT}`] = { role: "owner", ownerUserId: owner, bopsWsId: "ws_acme", name: "Acme" };
  const own = await read(owner);
  assert.equal(own.status, 200);
  assert.deepEqual(own.body.messages.map((m) => m.id), ["m1", "m2", "m3", "m3b", "d1", "g1"]);
  assert.equal((await read(newUserId("stranger"))).status, 404);
  // Someone orgo-web says is in it whom the owner gave no bots: the workspace, and nothing of it.
  roles[`${outsider} ${PROJECT}`] = { role: "member", ownerUserId: owner, bopsWsId: "ws_acme", name: "Acme" };
  const none = await read(outsider);
  assert.equal(none.status, 200);
  assert.deepEqual(none.body.state.workspace, { id: "ws_acme", name: "Acme", createdAt: 1 });
  assert.deepEqual([none.body.state.bots, none.body.state.chats, none.body.state.sessions, none.body.state.routines, none.body.messages], [[], [], [], [], []]);
  assert.ok(!/@example\.com\b/.test(JSON.stringify(none.body)), "nobody's email, theirs or the member's");
});

test("read again over a copy, a member is told what the owner deleted since it (theirs to see only), so it goes from the older pages they read too; restored, it's back", async () => {
  const del = (remove: string[], upsert: unknown[] = []) => fetch(`${cloud.url}/v1/messages`, { method: "POST", headers: headers(owner), body: JSON.stringify({ upsert, remove }) });
  const first = await read(member);
  assert.equal(first.status, 200);
  assert.equal(first.body.gone, undefined, "a first read has nothing to drop");
  // The owner deletes two of Max's messages and one of Dana's (a chat this member isn't shown) at once.
  assert.equal((await del(["m1", "m2", "d1"])).status, 200);
  const again = await read(member, `?have=${first.body.hash}.${first.body.seq}`);
  assert.equal(again.status, 200);
  assert.ok(again.body.seq > first.body.seq);
  assert.deepEqual(again.body.messages.map((m) => m.id), ["m3", "m3b"]);
  assert.deepEqual([...(again.body.gone ?? [])].sort(), ["m1", "m2"], "only the chats they're shown");
  // From that read on, nothing more went: none to drop.
  const later = await read(member, `?have=x.${again.body.seq}`);
  assert.equal(later.body.gone, undefined);
  // The owner restores one: written again, it's back with a new seq, and not among what went since it.
  assert.equal((await del([], [{ id: "m1", chatId: "bot:max", role: "user", text: "find leads", at: 10 }])).status, 200);
  const back = await read(member, `?have=${again.body.hash}.${again.body.seq}`);
  assert.deepEqual(back.body.messages.map((m) => m.id), ["m1", "m3", "m3b"]);
  assert.equal(back.body.gone, undefined);
  // Put back as the first test left them, for the tests after.
  assert.equal((await del([], [{ id: "m2", chatId: "bot:max", role: "bot", botId: "max", text: "on it", at: 11 }, { id: "d1", chatId: "bot:dana", role: "user", text: "only for the shortlist", at: 14 }])).status, 200);
});

test("an owner whose state the cloud hasn't got, or that has no such workspace, gives a member nothing to open", async () => {
  const P2 = "22222222-2222-3333-4444-555555555555";
  const absent = newUserId("absent");
  roles[`${member} ${P2}`] = { role: "member", ownerUserId: absent, bopsWsId: "ws_acme", name: "Acme" };
  const get = () => fetch(`${cloud.url}/v1/ws/${P2}/state`, { headers: { Authorization: `Bearer ${keyOf(member)}` } });
  assert.equal((await get()).status, 404, "no state of the owner's");
  roles[`${member} ${P2}`] = { role: "member", ownerUserId: owner, bopsWsId: "ws_deleted", name: "Gone" };
  resetMembers();
  assert.equal((await get()).status, 404, "no such workspace in it");
  delete roles[`${member} ${P2}`];
  resetMembers();
});

test("the member's stream hears the owner's write with the fingerprint a read gives", async () => {
  const ctl = new AbortController();
  const res = await fetch(`${cloud.url}/v1/live?project=${PROJECT}`, { headers: { Authorization: `Bearer ${keyOf(member)}` }, signal: ctl.signal });
  assert.equal(res.status, 200);
  const got: { type: string; data: Record<string, unknown> }[] = [];
  void (async () => {
    let text = "";
    const dec = new TextDecoder();
    try {
      for await (const chunk of res.body!) {
        text += dec.decode(chunk as Uint8Array, { stream: true });
        for (let i = text.indexOf("\n\n"); i >= 0; i = text.indexOf("\n\n")) {
          const block = text.slice(0, i);
          text = text.slice(i + 2);
          const field = (name: string) => block.split("\n").find((l) => l.startsWith(`${name}: `))?.slice(name.length + 2);
          if (field("event")) got.push({ type: field("event")!, data: JSON.parse(field("data") ?? "{}") });
        }
      }
    } catch {}
  })();
  await until(() => got.some((g) => g.type === "reset"), "the stream to start");
  const version = (await (await fetch(`${cloud.url}/v1/state/head`, { headers: headers(owner) })).json()) as { version: number };
  assert.equal((await fetch(`${cloud.url}/v1/state`, { method: "PUT", headers: headers(owner), body: JSON.stringify({ base: version.version, state: blob("done") }) })).status, 200);
  const ev = await until(() => got.find((g) => g.type === "state"), "the state event");
  const { body } = await read(member);
  assert.equal(ev.data.hash, body.hash);
  assert.equal(body.state.sessions[0].status, "done");
  // A message in the main workspace's chat (known now), or in a chat of a bot they weren't given, doesn't
  // wake the member; one the owner keeps between us in Max's chat does.
  const before = got.filter((g) => g.type === "state").length;
  await fetch(`${cloud.url}/v1/messages`, { method: "POST", headers: headers(owner), body: JSON.stringify({ upsert: [{ id: "m5", chatId: "bot:boppy", role: "user", text: "x", at: 20 }], remove: [] }) });
  await fetch(`${cloud.url}/v1/messages`, { method: "POST", headers: headers(owner), body: JSON.stringify({ upsert: [{ id: "d2", chatId: "bot:dana", role: "user", text: "z", at: 20 }], remove: [] }) });
  await fetch(`${cloud.url}/v1/messages`, { method: "POST", headers: headers(owner), body: JSON.stringify({ upsert: [{ id: "m6", chatId: "bot:max", role: "user", text: "y", at: 21, secret: true }], remove: [] }) });
  await until(() => got.filter((g) => g.type === "state").length === before + 1, "Acme's message");
  await new Promise((r) => setTimeout(r, 100));
  assert.equal(got.filter((g) => g.type === "state").length, before + 1);
  ctl.abort();
});

test("a page of a long chat shows every message of it, the ones after a message kept between us too", async () => {
  // bot:max so far: m1, m2, m3 (between us), m3b (the answer to it), m6 (the owner's next, kept between us too). 198 more after m6.
  const more = Array.from({ length: 198 }, (_, i) => ({ id: `n${i}`, chatId: "bot:max", role: "bot", botId: "max", text: `note ${i}`, at: 30 + i }));
  assert.equal((await fetch(`${cloud.url}/v1/messages`, { method: "POST", headers: headers(owner), body: JSON.stringify({ upsert: more, remove: [] }) })).status, 200);
  // The newest 200 start at m3b, after m3.
  const { body } = await read(member);
  const ids = body.messages.map((m) => m.id);
  assert.deepEqual(body.more, ["bot:max"]);
  assert.deepEqual(ids.slice(0, 3), ["m3b", "m6", "n0"]);
  assert.equal(ids.length, 200);
  // A page picked so the answer is its oldest row: the same.
  const page = await read(member, "?chat=bot:max&before=228");
  assert.deepEqual(page.body.more, ["bot:max"]);
  assert.equal(page.body.messages[0]?.id, "m3b");
  // The page before it has the whole start of the chat.
  assert.deepEqual((await read(member, "?chat=bot:max&before=14")).body.messages.map((m) => m.id), ["m1", "m2", "m3", "m3b"]);
});

test("a member given two bots reads their conversation with each other (Max asked Dana) and its older pages; one given only one of them doesn't", async () => {
  roles[`${both} ${PROJECT}`] = { role: "member", ownerUserId: owner, bopsWsId: "ws_acme", name: "Acme" };
  const state = blob("done");
  (state.workspaces[1].memberAccess as Record<string, unknown>)[`${both}@example.com`] = { others: "none", bots: { max: "read", dana: "read" } };
  const version = (await (await fetch(`${cloud.url}/v1/state/head`, { headers: headers(owner) })).json()) as { version: number };
  assert.equal((await fetch(`${cloud.url}/v1/state`, { method: "PUT", headers: headers(owner), body: JSON.stringify({ base: version.version, state }) })).status, 200);
  const talk = [
    { id: "p1", chatId: "pair:dana:max", role: "bot", botId: "max", text: "Is the deck ready?", at: 500 },
    { id: "p2", chatId: "pair:dana:max", role: "bot", botId: "dana", text: "Yes, sent it this morning.", at: 501 },
    { id: "m9", chatId: "bot:max", role: "bot", botId: "max", text: "Dana says the deck is ready.", at: 502, asked: [{ botId: "dana", question: "Is the deck ready?", answer: "Yes, sent it this morning.", questionId: "p1" }] },
  ];
  assert.equal((await fetch(`${cloud.url}/v1/messages`, { method: "POST", headers: headers(owner), body: JSON.stringify({ upsert: talk, remove: [] }) })).status, 200);

  const { status, body } = await read(both);
  assert.equal(status, 200);
  assert.deepEqual(body.messages.filter((m) => m.chatId === "pair:dana:max").map((m) => m.id), ["p1", "p2"], "the conversation Asked ● Dana opens");
  assert.deepEqual(body.messages.find((m) => m.id === "m9")?.asked, [{ botId: "dana", question: "Is the deck ready?", answer: "Yes, sent it this morning.", questionId: "p1" }], "where in it Max asked");
  assert.deepEqual((await read(both, "?chat=pair:dana:max&before=501")).body.messages.map((m) => m.id), ["p1"], "a page of it");
  // Given Max only: none of it, nor a page.
  const one = await read(member);
  assert.ok(!one.body.messages.some((m) => String(m.chatId).startsWith("pair:")));
  assert.deepEqual(one.body.messages.find((m) => m.id === "m9")?.asked, undefined, "what Dana said isn't theirs");
  assert.equal((await read(member, "?chat=pair:dana:max&before=999")).status, 404);
  // Orgo says they joined after what's kept for them was set (removed and back since): none of it is theirs now.
  roles[`${both} ${PROJECT}`] = { role: "member", ownerUserId: owner, bopsWsId: "ws_acme", name: "Acme", joinedAt: new Date().toISOString() };
  resetMembers();
  const back = await read(both);
  assert.equal(back.status, 200);
  assert.deepEqual([back.body.state.bots, back.body.state.chats, back.body.messages], [[], [], []]);
  delete roles[`${both} ${PROJECT}`];
  resetMembers();
});

test("a page boundary between two messages of the same millisecond (a bot's answer and its note) loses neither: the next page comes before the oldest the member has, by its id too", async () => {
  // Max answers and notes what he read in one tick, then 199 more: the newest 200 start at the note.
  const tick = [
    { id: "t-answer", chatId: "bot:max", role: "bot", botId: "max", text: "Here's what I found", at: 5000 },
    { id: "t-note", chatId: "bot:max", role: "system", text: "Read example.com", at: 5000 },
  ];
  const after = Array.from({ length: 199 }, (_, i) => ({ id: `t${i}`, chatId: "bot:max", role: "bot", botId: "max", text: `later ${i}`, at: 5001 + i }));
  for (const upsert of [tick, after]) assert.equal((await fetch(`${cloud.url}/v1/messages`, { method: "POST", headers: headers(owner), body: JSON.stringify({ upsert, remove: [] }) })).status, 200);
  const { body } = await read(member);
  assert.equal(body.messages[0]?.id, "t-note");
  assert.deepEqual(body.more, ["bot:max"]);
  const page = await read(member, "?chat=bot:max&before=5000&beforeId=t-note");
  assert.equal(page.status, 200);
  assert.equal(page.body.messages.at(-1)?.id, "t-answer", "the answer the note is under is in the page before it");
  assert.ok(!page.body.messages.some((m) => m.id === "t-note"), "and the note isn't again");
  // An id of none of that chat's messages at that time (or none): the ones before that millisecond, as before.
  for (const qs of ["?chat=bot:max&before=5000", "?chat=bot:max&before=5000&beforeId=t0", "?chat=bot:max&before=5000&beforeId=d1"])
    assert.ok(!(await read(member, qs)).body.messages.some((m) => String(m.id).startsWith("t-")), qs);
});

/* ---------------- Acting, for a member with Write ---------------- */

const actBlob = () => ({
  workspaces: [{ id: "ws_act", name: "Acts", memberAccess: { [`${writer}@example.com`]: { others: "none", bots: { max: "write" } }, [`${other}@example.com`]: { others: "none", bots: { max: "write" } } } }],
  bots: [{ id: "max", name: "Max", workspaceId: "ws_act" }],
  chats: [{ id: "bot:max", kind: "bot", botIds: ["max"], workspaceId: "ws_act" }],
});
const act = (userId: string, key: string, text = "Book the 9am train") =>
  fetch(`${cloud.url}/v1/ws/${ACT_PROJECT}/act`, { method: "POST", headers: { Authorization: `Bearer ${keyOf(userId)}`, "content-type": "application/json" }, body: JSON.stringify({ key, act: { act: "chat", chatId: "bot:max", text } }) }).then(
    async (r) => ({ status: r.status, json: (await r.json()) as Record<string, unknown> }),
  );
const signedNotice = (body: unknown) => {
  const text = JSON.stringify(body);
  const ts = String(Math.floor(Date.now() / 1000));
  return fetch(`${cloud.url}/v1/internal/members-changed`, {
    method: "POST",
    headers: { "content-type": "application/json", "x-bops-timestamp": ts, "x-bops-signature": `sha256=${createHmac("sha256", SECRET).update(`${ts}.${text}`).digest("hex")}` },
    body: text,
  });
};

test("a Write member's act waits for the owner's Mac once per key, and is handed over on the tunnel when it connects", async () => {
  roles[`${writer} ${ACT_PROJECT}`] = { role: "member", ownerUserId: actOwner, bopsWsId: "ws_act", name: "Acts" };
  assert.equal((await fetch(`${cloud.url}/v1/state`, { method: "PUT", headers: headers(actOwner), body: JSON.stringify({ base: 0, state: actBlob() }) })).status, 200);
  const first = await act(writer, "edge_key_0001");
  assert.deepEqual([first.status, first.json], [202, { ok: true, macOn: false }], "the owner's Mac is away");
  assert.equal((await act(writer, "edge_key_0001")).status, 202, "sent again");
  const rows = await pending(actOwner);
  assert.equal(rows.length, 1, "the same key adds nothing");
  assert.deepEqual([rows[0].kind, rows[0].dedupe_key, rows[0].delivered_at], ["member", `member:${writer}:edge_key_0001`, null]);
  const p = rows[0].payload as MemberActPayload;
  assert.deepEqual([p.wsId, p.member.userId, p.member.email, p.act], ["ws_act", writer, `${writer}@example.com`, { act: "chat", chatId: "bot:max", text: "Book the 9am train" }]);
  const expires = (await query<{ expires_at: Date }>("SELECT expires_at FROM bops.cloud_pending WHERE id = $1", [rows[0].id])).rows[0].expires_at;
  assert.ok(Math.abs(expires.getTime() - (Date.now() + 10 * 60_000)) < 60_000, "kept ten minutes");
  // The owner's Mac connects: it gets it as a "member" event, acks it, and it's delivered.
  const mac = await connectMac(cloud.url, actOwner);
  await until(async () => (await pending(actOwner)).every((r) => r.delivered_at), "the Mac to ack it");
  const events = mac.frames.filter((f): f is Extract<CloudToMac, { t: "event" }> => f.t === "event");
  assert.deepEqual(events.map((e) => [e.kind, (e.payload as MemberActPayload).key]), [["member", "edge_key_0001"]]);
  // With the Mac on, the next one goes at once.
  assert.deepEqual((await act(writer, "edge_key_0002")).json, { ok: true, macOn: true });
  await until(() => mac.frames.filter((f) => f.t === "event").length === 2, "the second event");
  mac.ws.close();
});

test("a member's acts are counted a minute at a time: one past MEMBER_ACTS_A_MINUTE is told to slow down", async () => {
  roles[`${writer} ${ACT_PROJECT}`] = { role: "member", ownerUserId: actOwner, bopsWsId: "ws_act", name: "Acts" };
  // Not across a minute's end, so every one is in the same count.
  if (Date.now() % 60_000 > 50_000) await new Promise((r) => setTimeout(r, 60_000 - (Date.now() % 60_000) + 50));
  await query("DELETE FROM bops.cloud_limits WHERE key = $1", [`member:act:${writer}`]);
  const got: number[] = [];
  for (let i = 0; i <= MEMBER_ACTS_A_MINUTE; i++) got.push((await act(writer, `edge_rate_${String(i).padStart(4, "0")}`)).status);
  assert.deepEqual(got.slice(0, MEMBER_ACTS_A_MINUTE), Array(MEMBER_ACTS_A_MINUTE).fill(202));
  const over = await act(writer, "edge_rate_over");
  assert.equal(over.status, 429);
  assert.equal(over.json.code, "slow_down");
  assert.ok(typeof over.json.retryAfter === "number" && over.json.retryAfter > 0);
  await query("DELETE FROM bops.cloud_limits WHERE key = $1", [`member:act:${writer}`]);
});

test("orgo-web's notice that a member is out drops what they did that still waits, and nobody else's", async () => {
  roles[`${writer} ${ACT_PROJECT}`] = { role: "member", ownerUserId: actOwner, bopsWsId: "ws_act", name: "Acts" };
  roles[`${other} ${ACT_PROJECT}`] = { role: "member", ownerUserId: actOwner, bopsWsId: "ws_act", name: "Acts" };
  await query("DELETE FROM bops.cloud_pending WHERE user_id = $1", [actOwner]);
  assert.equal((await act(writer, "edge_drop_001")).status, 202);
  assert.equal((await act(other, "edge_keep_001")).status, 202);
  assert.equal((await pending(actOwner)).length, 2);
  delete roles[`${writer} ${ACT_PROJECT}`];
  assert.equal((await signedNotice({ projectId: ACT_PROJECT, userId: writer })).status, 204);
  await until(async () => (await pending(actOwner)).length === 1, "the removed member's to go");
  assert.deepEqual((await pending(actOwner)).map((r) => (r.payload as MemberActPayload).member.userId), [other]);
  assert.equal((await act(writer, "edge_drop_002")).status, 404, "and they act no more");
  delete roles[`${other} ${ACT_PROJECT}`];
});

test("Your Apps: in a workspace of Orgo's team, a member given it reads the apps as allowed, acts at Write, and is refused at Read; in one whose owner isn't Orgo's team, they're never shown", async () => {
  roles[`${teamMember} ${APPS_PROJECT}`] = { role: "member", ownerUserId: appsOwner, bopsWsId: "ws_apps", name: "Apps" };
  // Apps go by the owner's own email, in their state (ws-slice.ts ownerAppsOpen): a made-up @orgo.ai one, or another.
  const state = (level: string, owner = "owner@orgo.ai") => ({
    account: { user: { id: appsOwner, email: owner } },
    workspaces: [
      {
        id: "ws_apps",
        name: "Apps",
        createdAt: 1,
        memberAccess: { [`${teamMember}@orgo.ai`]: { others: "none", bots: { max: "read" }, apps: level } },
        hostedApps: { shop: { botId: "max", computerId: "comp-1", projectId: "proj-1", url: "https://shop.orgo.dev" } },
        ingotTokens: { "comp-1": { id: "tok-1", sum: "s", at: 1 } },
        appsForMembers: {
          at: 10,
          apps: { shop: { head: null, sites: [{ name: "shop", url: "https://shop.orgo.dev", serving: null, live: null }], commits: [], deploys: [], settings: { shop: { port: 3000, install: null, build: null, start: "npm start" } } } },
          owned: [{ id: "zone-1", domain: "acme.example" }],
        },
      },
    ],
    bots: [{ id: "max", name: "Max", workspaceId: "ws_apps" }],
    chats: [{ id: "bot:max", kind: "bot", botIds: ["max"], workspaceId: "ws_apps" }],
  });
  const put = async (level: string, base: number, owner?: string) => {
    const r = await fetch(`${cloud.url}/v1/state`, { method: "PUT", headers: headers(appsOwner), body: JSON.stringify({ base, state: state(level, owner) }) });
    assert.equal(r.status, 200);
    return ((await r.json()) as { version: number }).version;
  };
  const v = await put("read", 0);
  const res = await fetch(`${cloud.url}/v1/ws/${APPS_PROJECT}/state`, { headers: { Authorization: `Bearer ${keyOf(teamMember)}` } });
  const body = (await res.json()) as SharedWsState;
  assert.equal(body.state.apps?.level, "read");
  assert.deepEqual(body.state.apps?.list.map((a) => [a.name, a.botId, a.url]), [["shop", "max", "https://shop.orgo.dev"]]);
  assert.equal(body.state.apps?.list[0].settings, undefined);
  assert.equal(body.state.apps?.owned, undefined);
  for (const hidden of ["comp-1", "proj-1", "tok-1", "memberAccess", "appsForMembers", "owner@orgo.ai"]) assert.ok(!JSON.stringify(body).includes(hidden), `"${hidden}" isn't shown`);
  const go = (key: string) =>
    fetch(`${cloud.url}/v1/ws/${APPS_PROJECT}/act`, { method: "POST", headers: { Authorization: `Bearer ${keyOf(teamMember)}`, "content-type": "application/json" }, body: JSON.stringify({ key, act: { act: "deploy", app: "shop" } }) }).then(
      async (r) => ({ status: r.status, json: (await r.json()) as Record<string, unknown> }),
    );
  const read = await go("edge_apps_001");
  assert.deepEqual([read.status, read.json.code], [403, "member_apps_read_only"]);
  const v2 = await put("write", v);
  const w = (await (await fetch(`${cloud.url}/v1/ws/${APPS_PROJECT}/state`, { headers: { Authorization: `Bearer ${keyOf(teamMember)}` } })).json()) as SharedWsState;
  assert.deepEqual(w.state.apps?.owned, [{ id: "zone-1", domain: "acme.example" }]);
  assert.deepEqual(w.state.apps?.list[0].settings, { shop: { port: 3000, install: null, build: null, start: "npm start" } });
  assert.equal((await go("edge_apps_002")).status, 202);
  const rows = await pending(appsOwner);
  assert.deepEqual(rows.map((r) => (r.payload as MemberActPayload).act), [{ act: "deploy", app: "shop" }], "queued for the owner's Mac, as theirs");
  // The same at Write in a workspace whose owner isn't Orgo's team: no apps, and no such app to act on, for an @orgo.ai member too.
  await put("write", v2, "owner@example.com");
  const other = (await (await fetch(`${cloud.url}/v1/ws/${APPS_PROJECT}/state`, { headers: { Authorization: `Bearer ${keyOf(teamMember)}` } })).json()) as SharedWsState;
  assert.equal(other.state.apps, undefined);
  assert.equal((await go("edge_apps_003")).status, 404);
  assert.equal((await pending(appsOwner)).length, 1, "nothing more queued");
});
