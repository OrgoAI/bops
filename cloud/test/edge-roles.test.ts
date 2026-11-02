import assert from "node:assert/strict";
import { after, before, test } from "node:test";
import { closeDb, query } from "../db.ts";
import { closeAll } from "../live.ts";
import { resetMembers } from "../members.ts";
import type { MemberActPayload, SharedWsState } from "../protocol.ts";
import { dropUsers, fakeOrgo, keyOf, newUserId, pending, prepareDb, startCloud, until, type Listening } from "./edge-fakes.ts";

/**
 * Owner, Admin and Member over the real Bops Cloud path: the owner's Mac uploads its state as the real app does
 * (toShared, which drops `account`), orgo-web's bops-role says each caller's role and the owner's email, and each GETs
 * /v1/ws/<project>/state. In a workspace of Orgo's team both get Your Apps (the bug was: nobody did); an Admin with no
 * entry at all gets every bot, its computer and Your Apps at Write; an Admin's act carries the role for the owner's
 * Mac; and an Admin made a member mid stream stops hearing Admin things, with no notice from orgo-web. Every name,
 * email and id is made up.
 */

/** The owner's Mac's own upload (lib/server/state-merge.ts), loaded by URL: it's the app's, not the cloud's to typecheck. */
const { toShared } = (await import(new URL("../../lib/server/state-merge.ts", import.meta.url).href)) as { toShared: (state: unknown, device: string) => Record<string, unknown> };

let orgo: Listening;
let cloud: Listening;
const owner = newUserId("owner");
const staff = newUserId("orgo"); // fakeOrgo gives an "edge-orgo-..." id an @orgo.ai email
const plain = newUserId("member"); // ...and anyone else @example.com
const PROJECT = "13131313-3434-5656-7878-909090909090";
const roles: Record<string, unknown> = {};
const role = (r: "admin" | "member", more: Record<string, unknown> = {}) => ({ role: r, ownerUserId: owner, bopsWsId: "ws_brand", name: "Brand", ownerEmail: "owner@orgo.ai", ...more });

before(async () => {
  await prepareDb();
  // The Admin has no entry in the owner's state at all, and orgo-web from before this change says its column (false).
  roles[`${staff} ${PROJECT}`] = role("admin", { computerUse: false });
  roles[`${plain} ${PROJECT}`] = role("member", { computerUse: true });
  orgo = await fakeOrgo(roles);
  cloud = await startCloud();
  resetMembers();
});

after(async () => {
  closeAll();
  await cloud.close();
  await orgo.close();
  await query("DELETE FROM bops.cloud_limits WHERE key = ANY($1::text[])", [[`member:act:${staff}`, `member:act:${plain}`]]);
  await dropUsers([owner, staff, plain]);
  await closeDb();
});

const entry = { others: "none", bots: { max: "write" }, apps: "write", computer: "use", at: Date.now() };
/** The owner's state on their Mac (lib/server/store.ts): account included, as it is in memory. */
const ownerState = () => ({
  account: { user: { id: owner, email: "owner@orgo.ai", name: "Owner" } },
  workspaces: [
    { id: "ws_main", name: "Main" },
    {
      id: "ws_brand",
      name: "Brand",
      createdAt: 1,
      memberAccess: { [`${plain}@example.com`]: entry },
      hostedApps: { shop: { botId: "max", computerId: "comp-1", projectId: "proj-1", url: "https://shop.example.dev", sites: [{ name: "shop" }] } },
      appsForMembers: { at: 10, apps: { shop: { head: null, sites: [{ name: "shop", url: "https://shop.example.dev", serving: null, live: null }], commits: [], deploys: [] } } },
    },
  ],
  bots: [
    { id: "boppy", name: "Boppy", isMain: true },
    { id: "max", name: "Max", isMain: true, workspaceId: "ws_brand", computerId: "comp-max", computer: "own" },
    { id: "ivy", name: "Ivy", workspaceId: "ws_brand" },
  ],
  chats: [
    { id: "bot:max", kind: "bot", botIds: ["max"], workspaceId: "ws_brand" },
    { id: "bot:ivy", kind: "bot", botIds: ["ivy"], workspaceId: "ws_brand" },
  ],
});

const headers = { Authorization: `Bearer ${keyOf(owner)}`, "x-bops-user": owner, "x-bops-protocol": "2", "x-bops-device": "mac-o", "content-type": "application/json" };
async function put(state: Record<string, unknown>, base: number) {
  const r = await fetch(`${cloud.url}/v1/state`, { method: "PUT", headers, body: JSON.stringify({ base, state }) });
  assert.equal(r.status, 200, await r.clone().text());
  return ((await r.json()) as { version: number }).version;
}
const read = async (who: string) => {
  const r = await fetch(`${cloud.url}/v1/ws/${PROJECT}/state`, { headers: { Authorization: `Bearer ${keyOf(who)}` } });
  assert.equal(r.status, 200, await r.clone().text());
  return ((await r.json()) as SharedWsState).state;
};
const act = (who: string, key: string, a: unknown) =>
  fetch(`${cloud.url}/v1/ws/${PROJECT}/act`, { method: "POST", headers: { Authorization: `Bearer ${keyOf(who)}`, "content-type": "application/json" }, body: JSON.stringify({ key, act: a }) }).then(async (r) => ({ status: r.status, json: (await r.json()) as Record<string, unknown> }));

test("Your Apps reaches an Admin and a member of a workspace of Orgo's team from the state a real Mac uploads", async () => {
  const real = toShared(ownerState(), "mac-o");
  assert.equal("account" in real, false, "toShared drops account (NEVER_SYNCED)");
  await put(real, 0);
  const a = await read(staff);
  assert.deepEqual(a.bots.map((b) => b.id), ["max", "ivy"], "the Admin: every bot, with no entry");
  assert.deepEqual(a.levels, { max: "write", ivy: "write" });
  assert.equal(a.computer, "use", "and Use its computer, whatever orgo-web's column says");
  assert.equal(a.apps?.level, "write", "and Your Apps at Write");
  assert.deepEqual(a.screens, { max: "comp-max", ivy: "comp-max" }, "and which computer to stream");
  const m = await read(plain);
  assert.deepEqual(m.bots.map((b) => b.id), ["max"], "the member: only what the owner gave");
  assert.equal(m.apps?.level, "write");
  assert.equal(m.computer, "use");
  assert.equal(m.screens, undefined, "never a member");
});

test("an Admin's acts are taken with no entry, and carry the role for the owner's Mac; a member's never do", async () => {
  await query("DELETE FROM bops.cloud_pending WHERE user_id = $1", [owner]);
  assert.equal((await act(staff, "edge_role_001", { act: "chat", chatId: "bot:ivy", text: "Plan the week" })).status, 202);
  assert.equal((await act(staff, "edge_role_002", { act: "deploy", app: "shop" })).status, 202);
  assert.equal((await act(plain, "edge_role_003", { act: "chat", chatId: "bot:ivy", text: "Hi" })).status, 404, "Ivy isn't the member's");
  assert.equal((await act(plain, "edge_role_004", { act: "deploy", app: "shop" })).status, 202);
  const rows = (await pending(owner)).map((r) => r.payload as MemberActPayload);
  assert.deepEqual(
    rows.map((p) => [p.member.userId, p.act.act, p.role ?? null, p.computer ?? null]),
    [
      [staff, "chat", "admin", true],
      [staff, "deploy", "admin", true],
      [plain, "deploy", null, true],
    ],
  );
});

test("an Admin made a member on orgo.ai: their open stream ends at the next look, with no notice from orgo-web, and they're held to their entry", async () => {
  resetMembers({ every: 100 });
  const ctl = new AbortController();
  const res = await fetch(`${cloud.url}/v1/live?project=${PROJECT}`, { headers: { Authorization: `Bearer ${keyOf(staff)}` }, signal: ctl.signal });
  assert.equal(res.status, 200);
  let closed = false;
  let text = "";
  void (async () => {
    try {
      for await (const chunk of res.body!) text += new TextDecoder().decode(chunk as Uint8Array);
    } catch {}
    closed = true;
  })();
  await until(() => text.includes("event: reset"), "the stream to start");
  roles[`${staff} ${PROJECT}`] = role("member", { computerUse: false });
  await until(() => closed, "the stream to end", 5_000);
  assert.ok(!text.includes("event: revoked"), "plainly: they're still in, and reconnect");
  const now = await read(staff);
  assert.deepEqual(now.bots, [], "no entry: no bot as a member");
  assert.equal(now.apps, undefined);
  assert.equal(now.computer, undefined);
  ctl.abort();
  resetMembers();
});
