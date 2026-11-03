import assert from "node:assert/strict";
import { after, before, test } from "node:test";
import { closeDb, query } from "../db.ts";
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
  await dropUsers([owner, admin, member]);
  await closeDb();
});

/** The owner's state: Ivy at Read for the member, and an entry kept for someone orgo-web no longer lists. */
const ownerState = () => ({
  workspaces: [
    { id: "ws_main", name: "Main" },
    { id: "ws_studio", name: "Studio", createdAt: 1, memberAccess: { [memberEmail]: { others: "none", bots: { ivy: "read" }, at: 1_700_000_100_000 }, "gone@example.com": { others: "write", bots: {}, at: 1_700_000_100_000 } } },
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
  assert.deepEqual(Object.keys(r.json.entries as object), [memberEmail], "never someone orgo-web no longer lists");
  assert.deepEqual((r.json.entries as Record<string, { bots: unknown }>)[memberEmail].bots, { ivy: "read" });
  assert.deepEqual([(await call(member, "GET", "people")).status, (await call(member, "GET", "people")).json.code], [403, "admin_only"]);
  assert.deepEqual((await call(owner, "GET", "people")).json.code, "own_workspace");
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
