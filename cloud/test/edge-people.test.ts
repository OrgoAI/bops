import assert from "node:assert/strict";
import { after, before, test } from "node:test";
import { closeDb, query } from "../db.ts";
import { deviceIdOf } from "../device.ts";
import { closeAll } from "../live.ts";
import { resetMembers } from "../members.ts";
import type { SharedWsState } from "../protocol.ts";
import { dropUsers, fakeOrgo, keyOf, newUserId, prepareDb, startCloud, type Listening } from "./edge-fakes.ts";

/**
 * An Admin's powers that don't wait for the owner's Mac, over the real Bops Cloud path and Postgres: the bots a Member has
 * (GET and POST /v1/ws/<project>/people), written into the owner's state as a new version the owner's Mac merges in;
 * where chat is answered (PATCH /v1/ws/<project>/routing); and waking a bot's computer (POST /v1/ws/<project>/wake).
 * Who's who comes from orgo-web's list with the Admin's own key. Every name, email and id is made up.
 */

const { merge3 } = (await import(new URL("../../lib/server/state-merge.ts", import.meta.url).href)) as { merge3: (base: unknown, mine: unknown, theirs: unknown) => Record<string, unknown> };

let orgo: Listening;
let cloud: Listening;
const owner = newUserId("owner");
const admin = newUserId("admin");
const member = newUserId("member");
// A member whose bots are still kept by their user id, from before Orgo gave their email.
const legacy = newUserId("legacy");
const PROJECT = "24242424-3535-4646-5757-686868686868";
const roles: Record<string, unknown> = {};
const role = (r: "admin" | "member" | "owner", more: Record<string, unknown> = {}) => ({ role: r, ownerUserId: owner, bopsWsId: "ws_studio", name: "Studio", ...more });
const memberEmail = `${member}@example.com`;
const people = {
  [PROJECT]: {
    members: [
      { id: owner, email: `${owner}@example.com`, role: "owner" },
      { id: admin, email: `${admin}@example.com`, role: "admin", joined_at: 1_700_000_000_000 },
      { id: member, email: memberEmail, role: "member", joined_at: 1_700_000_000_000 },
      { id: legacy, email: `${legacy}@example.com`, role: "member", joined_at: 1_700_000_000_000 },
    ],
    invites: [
      { email: "new.member@example.com", role: "viewer", status: "pending" },
      { email: "new.admin@example.com", role: "admin", status: "pending" },
    ],
  },
};

before(async () => {
  await prepareDb();
  roles[`${admin} ${PROJECT}`] = role("admin");
  roles[`${member} ${PROJECT}`] = role("member", { joinedAt: 1_700_000_000_000, computerUse: false });
  roles[`${owner} ${PROJECT}`] = role("owner");
  orgo = await fakeOrgo(roles, people);
  cloud = await startCloud();
  resetMembers();
});

after(async () => {
  closeAll();
  await cloud.close();
  await orgo.close();
  await query("DELETE FROM bops.cloud_limits WHERE key = ANY($1::text[])", [[`member:act:${admin}`, `member:act:${member}`]]);
  await query("DELETE FROM bops.chat_routing WHERE user_id = $1", [owner]);
  await dropUsers([owner, admin, member, legacy]);
  await closeDb();
});

/**
 * The owner's state: Ivy at Read for the member, Max at Read kept for the Admin from when they were a Member, Ivy at
 * Write for a member by their user id, and an entry kept for someone orgo-web no longer lists.
 */
const ownerState = () => ({
  workspaces: [
    { id: "ws_main", name: "Main" },
    {
      id: "ws_studio",
      name: "Studio",
      createdAt: 1,
      memberAccess: {
        [memberEmail]: { others: "none", bots: { ivy: "read" }, at: 1_700_000_100_000 },
        [`${admin}@example.com`]: { others: "none", bots: { max: "read" }, at: 1_700_000_100_000 },
        [`user:${legacy}`]: { others: "none", bots: { ivy: "write" }, at: 1_700_000_100_000 },
        "gone@example.com": { others: "write", bots: {}, at: 1_700_000_100_000 },
      },
    },
  ],
  bots: [
    { id: "boppy", name: "Boppy", isMain: true },
    { id: "max", name: "Max", isMain: true, workspaceId: "ws_studio", computerId: "comp-max", computer: "own" },
    { id: "ivy", name: "Ivy", workspaceId: "ws_studio" },
  ],
  chats: [
    { id: "bot:max", kind: "bot", botIds: ["max"], workspaceId: "ws_studio" },
    { id: "bot:ivy", kind: "bot", botIds: ["ivy"], workspaceId: "ws_studio" },
  ],
});

const headers = { Authorization: `Bearer ${keyOf(owner)}`, "x-bops-user": owner, "x-bops-protocol": "2", "x-bops-device": "mac-o", "content-type": "application/json" };
async function put(state: Record<string, unknown>, base: number) {
  const r = await fetch(`${cloud.url}/v1/state`, { method: "PUT", headers, body: JSON.stringify({ base, state }) });
  return { status: r.status, json: (await r.json()) as { version?: number; state?: Record<string, unknown> } };
}
const call = (who: string, method: string, path: string, body?: unknown) =>
  fetch(`${cloud.url}/v1/ws/${PROJECT}/${path}`, { method, headers: { Authorization: `Bearer ${keyOf(who)}`, "content-type": "application/json" }, ...(body !== undefined ? { body: JSON.stringify(body) } : {}) }).then(async (r) => ({
    status: r.status,
    json: (await r.json().catch(() => ({}))) as Record<string, unknown>,
  }));
const slice = async (who: string) => {
  const r = await fetch(`${cloud.url}/v1/ws/${PROJECT}/state`, { headers: { Authorization: `Bearer ${keyOf(who)}` } });
  assert.equal(r.status, 200, await r.clone().text());
  return ((await r.json()) as SharedWsState).state;
};
const version = async () => Number((await query<{ v: string }>("SELECT version AS v FROM bops.app_state WHERE user_id = $1", [owner])).rows[0]?.v);
const kept = async () => {
  const s = (await query<{ state: Record<string, unknown> }>("SELECT state FROM bops.app_state WHERE user_id = $1", [owner])).rows[0].state;
  return ((s.workspaces as Record<string, unknown>[]).find((w) => w.id === "ws_studio")!.memberAccess ?? {}) as Record<string, Record<string, unknown>>;
};

test("an Admin reads the bots each Member has, only for people orgo-web lists to them now; a Member can't", async () => {
  const v1 = (await put(ownerState(), 0)).json.version!;
  assert.ok(v1 > 0);
  const r = await call(admin, "GET", "people");
  assert.equal(r.status, 200, JSON.stringify(r.json));
  const entries = r.json.entries as Record<string, { bots: unknown }>;
  assert.deepEqual(Object.keys(entries).sort(), [`${admin}@example.com`, `${legacy}@example.com`, memberEmail].sort(), "never someone orgo-web no longer lists");
  assert.deepEqual(entries[memberEmail].bots, { ivy: "read" });
  assert.deepEqual(entries[`${admin}@example.com`].bots, { max: "read" }, "an Admin's, as they'd have it made a Member again");
  assert.deepEqual(entries[`${legacy}@example.com`].bots, { ivy: "write" }, "one kept by user id, under the key the sheet uses");
  assert.deepEqual([(await call(member, "GET", "people")).status, (await call(member, "GET", "people")).json.code], [403, "admin_only"]);
  assert.deepEqual((await call(owner, "GET", "people")).json.code, "own_workspace");
});

test("orgo-web says the Admin may not change people (its scope or kill switch): Bops Cloud neither reads nor writes them", async () => {
  const list = people[PROJECT] as Record<string, unknown>;
  list.can = { managePeople: false };
  try {
    const v = await version();
    for (const r of [await call(admin, "GET", "people"), await call(admin, "POST", "people", { who: { memberId: member }, access: { others: "write", bots: {}, apps: "write", computer: "use" } })]) assert.deepEqual([r.status, r.json.code], [403, "admin_only"]);
    assert.equal(await version(), v, "nothing written");
    // One from before (no `can`) says nothing, which is no.
    list.can = {};
    assert.equal((await call(admin, "GET", "people")).status, 403);
  } finally {
    delete list.can;
  }
});

test("an Admin gives a Member bots with every Mac closed: a new version of the owner's state, the Member's slice has it, and the owner's Mac merges it in", async () => {
  const base = await version();
  const baseState = (await query<{ state: Record<string, unknown> }>("SELECT state FROM bops.app_state WHERE user_id = $1", [owner])).rows[0].state;
  assert.deepEqual((await slice(member)).levels, { ivy: "read" });
  const r = await call(admin, "POST", "people", { who: { memberId: member }, access: { others: "none", bots: { max: "write", ivy: "read" }, computer: "use" } });
  assert.equal(r.status, 200, JSON.stringify(r.json));
  assert.equal(await version(), base + 1, "written once, by Bops Cloud");
  const e = (await kept())[memberEmail];
  assert.deepEqual([e.bots, e.computer, typeof e.at], [{ max: "write", ivy: "read" }, "use", "number"]);
  assert.deepEqual((await slice(member)).levels, { max: "write", ivy: "read" }, "the Member sees Max at Write at their next read");
  // The same again: nothing written.
  await call(admin, "POST", "people", { who: { memberId: member }, access: { others: "none", bots: { max: "write", ivy: "read" }, computer: "use" } });
  assert.equal(await version(), base + 1);
  // The owner's Mac, on the version before, changes its own name: refused (409), merges, and its next PUT keeps the Admin's entry.
  const mine = { ...ownerState(), owner: { name: "Owner" } };
  const stale = await put(mine, base);
  assert.equal(stale.status, 409);
  const merged = merge3(baseState, mine, stale.json.state!);
  const again = await put(merged, base + 1);
  assert.equal(again.status, 200, JSON.stringify(again.json));
  assert.deepEqual((await kept())[memberEmail].bots, { max: "write", ivy: "read" }, "the Admin's change stands");
});

test("an Admin's invite entry, and what they can't change: the owner, an Admin, someone not listed, Use its computer on an invite", async () => {
  const r = await call(admin, "POST", "people", { who: { invite: "New.Member@example.com" }, access: { others: "read", bots: {}, computer: "use" } });
  assert.equal(r.status, 200, JSON.stringify(r.json));
  const e = (await kept())["new.member@example.com"];
  assert.deepEqual([e.others, e.invite, e.computer], ["read", true, "none"], "an invite's, never Use its computer");
  assert.deepEqual([(await call(admin, "POST", "people", { who: { memberId: owner }, access: null })).json.code], ["admin_has_all"]);
  assert.deepEqual([(await call(admin, "POST", "people", { who: { memberId: admin }, access: null })).json.code], ["admin_has_all"]);
  assert.deepEqual([(await call(admin, "POST", "people", { who: { invite: "new.admin@example.com" }, access: { others: "read", bots: {} } })).json.code], ["admin_has_all"]);
  const gone = await call(admin, "POST", "people", { who: { memberId: "user-nobody" }, access: null });
  assert.deepEqual([gone.status, gone.json.code], [404, "gone"]);
  assert.equal((await call(member, "POST", "people", { who: { memberId: member }, access: { others: "write", bots: {} } })).json.code, "admin_only", "a Member never gives themselves more");
  assert.equal((await call(admin, "POST", "people", { who: { memberId: member, invite: "x@example.com" }, access: null })).status, 400);
  // Removing them: their entry goes.
  assert.equal((await call(admin, "POST", "people", { who: { invite: "new.member@example.com" }, access: null })).status, 200);
  assert.equal("new.member@example.com" in (await kept()), false);
});

test("an Admin says where chat is answered (kept as an Admin's choice); waking a computer billed by the hour stays the owner's", async () => {
  const r = await call(admin, "PATCH", "routing", { mode: "mac" });
  assert.equal(r.status, 200, JSON.stringify(r.json));
  const row = (await query<{ mode: string; set_by: string }>("SELECT mode, set_by FROM bops.chat_routing WHERE user_id = $1 AND ws_id = 'ws_studio'", [owner])).rows[0];
  assert.deepEqual(row, { mode: "mac", set_by: "admin" });
  assert.deepEqual([(await call(admin, "PATCH", "routing", { allowHourly: true })).status, (await call(admin, "PATCH", "routing", { mode: "mac", allowHourly: true })).json.code], [403, "owner_only_always"]);
  assert.equal((await call(member, "PATCH", "routing", { mode: "auto" })).json.code, "admin_only");
  assert.equal((await call(admin, "PATCH", "routing", { mode: "moon" })).status, 400);
});

test("waking a bot's computer: an Admin may (as a message would, with the owner's say on the hourly bill); a member without Use its computer or at Read may not", async () => {
  const r = await call(admin, "POST", "wake", { botId: "max" });
  assert.equal(r.status, 200, JSON.stringify(r.json));
  // (No wake secret in the tests: waking isn't set up, said plainly.)
  assert.deepEqual([r.json.ok, r.json.state], [false, "unset"]);
  assert.equal((await call(member, "POST", "wake", { botId: "max" })).json.code, "member_no_computer");
  assert.equal((await call(member, "POST", "wake", { botId: "ivy" })).json.code, "member_read_only");
  assert.equal((await call(admin, "POST", "wake", { botId: "ivy" })).status, 200, "a bot sharing the main bot's computer wakes that one");
  assert.equal((await call(admin, "POST", "wake", { botId: "nobody" })).status, 404);
});

test("an Allow once or Deny to an ask of a bot's computer's runner, with the owner's Mac away: Bops Cloud writes it there now, named as theirs; Always allow, a routine's, or an ask of the owner's Mac, waits for the Mac", async () => {
  // Its computer can't be woken (billed by the hour, and the owner hasn't let messages wake it): the chat says why.
  const woken: string[] = [];
  resetMembers({ wake: async (_u, desktop) => (woken.push(desktop), { ok: false, state: "hourly", why: "Max's computer is paid by the hour, and Owner hasn't let messages wake it, so Max can't answer this." }) });
  const runner = deviceIdOf(owner, "comp-max");
  const ask = (id: string, askedBy: string, more: Record<string, unknown> = {}) => ({ id, botId: "max", chatId: "bot:max", action: "Send an email", kind: "email", resources: [], at: 1, askedBy, ...more });
  const state = { ...ownerState(), appApprovals: [ask("ask-run-1", runner), ask("ask-run-2", runner), ask("ask-mac-1", "mac-o"), ask("ask-run-3", runner, { routineId: "r-daily", threadId: undefined })] };
  const put1 = await put(state, await version());
  assert.equal(put1.status, 200, JSON.stringify(put1.json));
  const before = await version();
  const act = (key: string, a: unknown) => call(admin, "POST", "act", { key, act: a });
  const r = await act("k_cloud_answer_1", { act: "answer", askId: "ask-run-1", reply: "reject", message: "Not that one" });
  assert.deepEqual([r.status, r.json.macOn], [202, true]);
  assert.equal(await version(), before + 1, "written by Bops Cloud at once");
  const kept = (await query<{ state: Record<string, unknown> }>("SELECT state FROM bops.app_state WHERE user_id = $1", [owner])).rows[0].state;
  const reply = (kept.appApprovals as Record<string, unknown>[]).find((x) => x.id === "ask-run-1")!.reply as Record<string, unknown>;
  assert.deepEqual([reply.reply, reply.message, reply.by, (reply.member as { userId: string }).userId], ["reject", "Not that one", "cloud", admin]);
  assert.equal(((await slice(admin)).approvals ?? []).some((x) => x.id === "ask-run-1"), false, "no longer waiting, for anyone watching");
  // Woken for it, and as it can't be, said once in its chat.
  let note: Record<string, unknown> | undefined;
  for (let i = 0; i < 50 && !note; i++) {
    note = (await query<{ json: Record<string, unknown> }>("SELECT json FROM bops.chat_messages WHERE user_id = $1 AND id = 'ask-run-1_wake'", [owner])).rows[0]?.json;
    if (!note) await new Promise((r) => setTimeout(r, 20));
  }
  assert.deepEqual(woken, ["comp-max"]);
  assert.deepEqual([note?.chatId, note?.role, note?.botId], ["bot:max", "system", "max"], JSON.stringify(note));
  assert.match(String(note?.text), /^Max's computer couldn't wake for this answer\. Max's computer is paid by the hour.* Max goes on once the computer is up\.$/);
  // A routine's run: only the owner's Mac sends Orgo its next time again, so it waits for it (queued, nothing written here).
  const v0 = await version();
  assert.equal((await act("k_cloud_answer_5", { act: "answer", askId: "ask-run-3", reply: "once" })).status, 202);
  assert.equal(await version(), v0, "a routine's ask waits for the owner's Mac");
  // Answered already: not again.
  assert.equal((await act("k_cloud_answer_2", { act: "answer", askId: "ask-run-1", reply: "once" })).json.code, "not_waiting");
  // Always allow saves a rule on the owner's Mac; an ask of the owner's Mac is its own: both wait for it, nothing written here.
  const v = await version();
  const always = await act("k_cloud_answer_3", { act: "answer", askId: "ask-run-2", reply: "always" });
  const mac = await act("k_cloud_answer_4", { act: "answer", askId: "ask-mac-1", reply: "once" });
  // (An Admin's answer waits for the owner's Bops to take an Admin's acts: here it doesn't say its version, so 409.)
  assert.ok([202, 409].includes(always.status) && [202, 409].includes(mac.status), `${always.status} ${mac.status}`);
  assert.equal(await version(), v, "nothing written for them");
  await query("DELETE FROM bops.cloud_pending WHERE user_id = $1", [owner]);
  await query("DELETE FROM bops.chat_messages WHERE user_id = $1", [owner]);
  resetMembers();
});

test("an Admin's chat switch refused for the owner's own reasons says it in the Admin's words", async () => {
  // (Answering every chat by itself isn't on for this owner: turns.ts chatAutoFor.)
  const r = await call(admin, "PATCH", "routing", { mode: "auto" });
  if (r.status === 409) assert.deepEqual([r.json.code, r.json.error], ["chat_auto_off", "Bops Cloud can't answer this workspace by itself yet, so the owner's Mac keeps answering it."]);
  else assert.equal(r.status, 200, JSON.stringify(r.json));
});
