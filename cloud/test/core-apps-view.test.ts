import assert from "node:assert/strict";
import { createServer, type IncomingMessage, type ServerResponse } from "node:http";
import { after, before, test } from "node:test";
import { cleanAppView, readAppViews } from "../apps-view.ts";
import { clearAuthCache } from "../auth.ts";
import { closeDb, query } from "../db.ts";
import { hub } from "../live.ts";
import { APPS_VIEW_PATH } from "../protocol.ts";
import { sharedSlice, type SliceViewer } from "../ws-slice.ts";
import { call, dropUsers, listen, newUserId, prepareDb, startCloud } from "./core-fakes.ts";

/**
 * What each app's own computer says members see of its apps (apps-view.ts, POST /v1/apps/view), kept in bops.app_views
 * and never in the owner's state, and how Your Apps shows it (ws-slice.ts appsFor): only a computer may post, and only
 * its own apps (their home is that computer); every field an allow list with its caps (no Preview passwords, members'
 * acts, ids); an unchanged view writes no view and no state version; per app the newer of it and the owner's Mac's
 * read, the members' acts always the Mac's copy's. orgo-web is a fake on localhost; the database is the tests' own.
 */

const D1 = "d1d1d1d1-0000-4000-8000-0000000000aa";
const D2 = "d2d2d2d2-0000-4000-8000-0000000000bb";
const LINK = "https://k7p2qxm4wr3d.orgo.dev";

let orgo: { url: string; close: () => Promise<void> };
let cloud: { url: string; close: () => Promise<void> };
const users: string[] = [];

const json = (res: ServerResponse, status: number, body: unknown) => res.writeHead(status, { "content-type": "application/json" }).end(JSON.stringify(body));
/** Orgo's profile: `key-<u>` the user's key, `orgo_vm_<u>~<d>` a computer's token. */
function profile(req: IncomingMessage, res: ServerResponse) {
  const key = /^Bearer (.+)$/.exec(req.headers.authorization ?? "")?.[1] ?? "";
  if (req.url !== "/api/user/profile") return json(res, 401, { error: "no" });
  let m: RegExpExecArray | null;
  if ((m = /^key-(.+)$/.exec(key))) return json(res, 200, { id: m[1], email: `${m[1]}@example.com`, api_key: { id: "k0", scope: "account" } });
  if ((m = /^orgo_vm_([^~]+)~([^~]+)$/.exec(key))) return json(res, 200, { id: m[1], api_key: null, principal: { kind: "vm_identity", desktop_id: m[2], expires_at: new Date(Date.now() + 3600_000).toISOString() } });
  json(res, 401, { error: "no" });
}

before(async () => {
  await prepareDb();
  orgo = await listen(createServer(profile));
  process.env.BOPS_ORGO_ORIGIN = orgo.url;
  cloud = await startCloud();
});

after(async () => {
  hub.closeAll();
  await cloud.close();
  await orgo.close();
  await dropUsers(users);
  await closeDb();
});

const T = { timeout: 60_000 };
const vm = (u: string, d = D1) => `orgo_vm_${u}~${d}`;
const asNew = (u: string) => ({ "x-bops-user": u, "x-bops-protocol": "2" });

/** Boppy on D1 works on "shop" (and its site "admin"); Iris on D2 on "notes". The owner's Mac read both at 10. */
function stateOf() {
  return {
    owner: { name: "Ann" },
    bots: [
      { id: "main", name: "Boppy", isMain: true, computerId: D1, computerStatus: "ready" },
      { id: "iris", name: "Iris", computer: "own", computerId: D2, computerStatus: "ready" },
    ],
    chats: [{ id: "bot:main", kind: "bot", botIds: ["main"], createdAt: 1 }],
    workspaces: [
      {
        id: "ws_main",
        name: "Acme",
        createdAt: 1,
        memberAccess: { "sam@example.com": { others: "none", bots: { main: "write" }, apps: "write" }, "rae@example.com": { others: "none", bots: { main: "read" }, apps: "read" } },
        hostedApps: { shop: { botId: "main", computerId: D1, sites: [{ name: "admin" }] }, notes: { botId: "iris", computerId: D2 } },
        appsForMembers: {
          at: 10,
          apps: {
            shop: { head: { id: "c-old", message: "old", at: 1 }, sites: [], commits: [], deploys: [], acts: [{ key: "k_1", userId: "u-sam", name: "Sam", act: "deploy", ok: true, going: true, at: 9 }] },
            notes: { head: { id: "n-old", message: "notes", at: 1 }, sites: [], commits: [], deploys: [] },
          },
        },
      } as Record<string, unknown>,
    ],
  };
}

async function seeded(what: string) {
  const u = newUserId(what);
  users.push(u);
  const r = await call(cloud.url, "PUT", "/v1/state", { key: `key-${u}`, headers: asNew(u), json: { base: 0, state: stateOf() } });
  assert.equal(r.status, 200, r.text);
  return u;
}
const version = async (u: string) => Number((await query<{ version: string }>("SELECT version FROM bops.app_state WHERE user_id = $1", [u])).rows[0].version);
const rows = async (u: string) =>
  (await query<{ app: string; view: Record<string, unknown>; view_at: Date; seen_at: Date }>("SELECT app, view, view_at, seen_at FROM bops.app_views WHERE user_id = $1 ORDER BY app", [u])).rows;
const post = (key: string, apps: Record<string, unknown>, ws = "ws_main") => call(cloud.url, "POST", APPS_VIEW_PATH, { key, json: { ws, apps } });

/** A view as a runner shares it (lib/hosted-apps.ts AppView), with things it must never carry. */
const viewOf = (head: string, more: Record<string, unknown> = {}) => ({
  head: { id: head, message: "Add the cart", at: 20 },
  sites: [{ name: "shop", url: null, preview: LINK, previewProtected: true, previewPassword: "Kq7mZ3x", serving: head, live: null, projectId: "proj-secret" }],
  commits: [{ id: head, message: "Add the cart", author: "Boppy", at: 20, changes: { added: 1, modified: 0, deleted: 0 } }],
  deploys: [{ id: "dep-1", state: "ready", at: head, rollback: false, when: 20, live: true, canRollback: false, site: "shop", env: "preview", error: "a log line" }],
  settings: { shop: { port: 3000, install: null, build: null, start: "npm start", env: { SECRET: "x" } } },
  leftOver: [{ id: "proj-9", name: "shop-old", port: 3100, url: "https://x.orgo.dev" }],
  owned: [{ id: "dom-1", domain: "example.com", registrant: "someone" }],
  acts: [{ key: "k_forged", userId: "u-x", name: "X", act: "remove", ok: true, at: 1 }],
  ...more,
});

test("cleanAppView: an allow list with its caps; no password, ids, acts, logs or variables", () => {
  const v = cleanAppView(viewOf("c-new"))!;
  // (A null deploy goes as none, as ws-slice.ts keep shows the owner's Mac's read.)
  assert.deepEqual(v.sites, [{ name: "shop", url: null, preview: LINK, previewProtected: true, serving: "c-new" }]);
  assert.deepEqual((v.deploys as Record<string, unknown>[])[0].error, undefined);
  assert.deepEqual(v.settings, { shop: { port: 3000, install: null, build: null, start: "npm start" } });
  assert.deepEqual(v.leftOver, [{ name: "shop-old", port: 3100 }]);
  assert.deepEqual(v.owned, [{ id: "dom-1", domain: "example.com" }]);
  assert.equal(v.acts, undefined);
  assert.equal(JSON.stringify(v).includes("Kq7mZ3x"), false);
  assert.equal(JSON.stringify(v).includes("proj-"), false);
  // The caps.
  const many = cleanAppView({
    head: { id: "h", message: "m".repeat(500), at: 1 },
    sites: Array.from({ length: 9 }, (_, i) => ({ name: `s${i}`, url: null, serving: null, live: null })),
    commits: Array.from({ length: 30 }, (_, i) => ({ id: `c${i}`, message: "w".repeat(300), author: "a".repeat(100), at: i, changes: { added: 0, modified: 0, deleted: 0 } })),
    deploys: Array.from({ length: 70 }, (_, i) => ({ id: `d${i}`, state: "ready", at: null, rollback: false, when: i, live: false, canRollback: false, site: "s0" })),
    leftOver: Array.from({ length: 30 }, (_, i) => ({ name: `left-${i}`.padEnd(100, "x"), port: 70000 })),
    owned: Array.from({ length: 60 }, (_, i) => ({ id: `z${i}`, domain: `d${i}.com` })),
  })!;
  assert.equal((many.head as { message: string }).message.length, 200);
  assert.equal((many.sites as unknown[]).length, 5);
  assert.equal((many.commits as unknown[]).length, 20);
  assert.equal(((many.commits as { message: string }[])[0]).message.length, 200);
  assert.equal(((many.commits as { author: string }[])[0]).author.length, 80);
  assert.equal((many.deploys as unknown[]).length, 50);
  assert.equal((many.leftOver as unknown[]).length, 20);
  assert.deepEqual([((many.leftOver as { name: string }[])[0]).name.length, ((many.leftOver as { port: unknown }[])[0]).port], [80, null]);
  assert.equal((many.owned as unknown[]).length, 50);
  assert.equal(cleanAppView("nope"), null);
});

test("a computer posts only its own apps' view: kept in bops.app_views, never in the owner's state; another computer's app is left out, and none of its own is 403", T, async () => {
  clearAuthCache();
  const u = await seeded("view");
  const v0 = await version(u);
  const r = await post(vm(u), { shop: viewOf("c-new"), notes: viewOf("n-new") });
  assert.equal(r.status, 204, r.text);
  assert.equal(r.text, "");
  assert.deepEqual((await rows(u)).map((x) => x.app), ["shop"], "notes is D2's");
  assert.equal(await version(u), v0, "the owner's state isn't written");
  // D2 tells notes'.
  assert.equal((await post(vm(u, D2), { notes: viewOf("n-new") })).status, 204);
  assert.deepEqual((await rows(u)).map((x) => x.app), ["notes", "shop"]);
  // Nothing of its own: refused, with fixed words.
  const no = await post(vm(u, D2), { shop: viewOf("c-x") });
  assert.deepEqual([no.status, no.json.error], [403, "A computer tells only its own apps."]);
  assert.equal((await rows(u)).find((x) => x.app === "shop")?.view.head && ((await rows(u)).find((x) => x.app === "shop")!.view.head as { id: string }).id, "c-new");
  // A workspace it doesn't work for, or a bad body.
  assert.equal((await post(vm(u), { shop: viewOf("c-x") }, "ws_other")).status, 403);
  assert.equal((await call(cloud.url, "POST", APPS_VIEW_PATH, { key: vm(u), json: { ws: "ws_main", apps: { "Not An App": {} } } })).status, 400);
  assert.equal((await call(cloud.url, "POST", APPS_VIEW_PATH, { key: vm(u), json: { ws: "ws_main" } })).status, 400);
});

test("a caller that is not a computer gets 403: the owner's own key and a member's", T, async () => {
  clearAuthCache();
  const u = await seeded("notcomputer");
  const r = await post(`key-${u}`, { shop: viewOf("c-new") });
  assert.deepEqual([r.status, r.json.error], [403, "Only an app's own computer tells Bops Cloud what it sees of its apps."]);
  assert.deepEqual(await rows(u), []);
});

test("an unchanged view writes no view and no state version, only when it was seen; a changed one is written; an app gone takes its row with it", T, async () => {
  clearAuthCache();
  const u = await seeded("unchanged");
  assert.equal((await post(vm(u), { shop: viewOf("c-new") })).status, 204);
  const [first] = await rows(u);
  const v0 = await version(u);
  await new Promise((r) => setTimeout(r, 20));
  assert.equal((await post(vm(u), { shop: viewOf("c-new") })).status, 204);
  const [same] = await rows(u);
  assert.equal(same.view_at.getTime(), first.view_at.getTime(), "the view as it was");
  assert.ok(same.seen_at.getTime() > first.seen_at.getTime(), "seen again");
  assert.equal(await version(u), v0, "no state version");
  assert.equal((await post(vm(u), { shop: viewOf("c-newer") })).status, 204);
  const [changed] = await rows(u);
  assert.ok(changed.view_at.getTime() > first.view_at.getTime());
  assert.equal((changed.view.head as { id: string }).id, "c-newer");
  // The owner removed shop: its row goes on the next post.
  const st = (await query<{ state: ReturnType<typeof stateOf>; version: string }>("SELECT state, version FROM bops.app_state WHERE user_id = $1", [u])).rows[0];
  const next = st.state;
  (next.workspaces[0].hostedApps as Record<string, unknown>) = { notes: { botId: "iris", computerId: D2 } };
  assert.equal((await call(cloud.url, "PUT", "/v1/state", { key: `key-${u}`, headers: asNew(u), json: { base: Number(st.version), state: next } })).status, 200);
  assert.equal((await post(vm(u, D2), { notes: viewOf("n-new") })).status, 204);
  assert.deepEqual((await rows(u)).map((x) => x.app), ["notes"]);
});

test("appsFor: per app the newer of the owner's Mac's read and its computer's view, the members' acts always the Mac's copy's; the oldest time of what's shown, the newest domains", T, async () => {
  clearAuthCache();
  const u = await seeded("newer");
  assert.equal((await post(vm(u), { shop: viewOf("c-new") })).status, 204);
  const blob = (await query<{ state: Record<string, unknown> }>("SELECT state FROM bops.app_state WHERE user_id = $1", [u])).rows[0].state;
  const views = await readAppViews(null, u, "ws_main");
  const SAM: SliceViewer = { role: "member", email: "sam@example.com", id: "u-sam", ownerEmail: "owner@orgo.ai", appActsSeen: true };
  const apps = sharedSlice(blob, "ws_main", SAM, views).apps!;
  const shop = apps.list.find((a) => a.name === "shop")!;
  assert.equal(shop.head?.id, "c-new", "the computer's, newer than the Mac's read at 10");
  assert.deepEqual(shop.acts?.map((a) => a.key), ["k_1"], "the acts the Mac's copy keeps, never the computer's");
  assert.deepEqual(shop.leftOver, [{ name: "shop-old", port: 3100 }]);
  assert.equal(apps.list.find((a) => a.name === "notes")!.head?.id, "n-old", "no view of notes: the Mac's");
  // As of the oldest of what's shown: notes is still the owner's Mac's read at 10, however fresh shop's view is.
  assert.equal(apps.at, 10, "as of the oldest read shown");
  assert.deepEqual(apps.owned, [{ id: "dom-1", domain: "example.com" }]);
  // A Read member: no left overs or domains.
  const RAE: SliceViewer = { role: "member", email: "rae@example.com", id: "u-rae", ownerEmail: "owner@orgo.ai", appActsSeen: true };
  const read = sharedSlice(blob, "ws_main", RAE, views).apps!;
  assert.deepEqual([read.list.find((a) => a.name === "shop")!.head?.id, read.list.find((a) => a.name === "shop")!.leftOver, read.owned], ["c-new", undefined, undefined]);
  // notes' computer tells it too: as of the older of the two views.
  assert.equal((await post(vm(u, D2), { notes: viewOf("n-new") })).status, 204);
  const both = await readAppViews(null, u, "ws_main");
  assert.equal(sharedSlice(blob, "ws_main", SAM, both).apps!.at, Math.min(both.shop.at, both.notes.at));
  // The owner's Mac reads again after it: its read is the newer one.
  const later = JSON.parse(JSON.stringify(blob)) as ReturnType<typeof stateOf>;
  const seen = later.workspaces[0].appsForMembers as { at: number; apps: Record<string, { head: unknown }> };
  seen.at = views.shop.at + 1;
  seen.apps.shop.head = { id: "c-mac", message: "from the Mac", at: 30 };
  assert.equal(sharedSlice(later as unknown as Record<string, unknown>, "ws_main", SAM, views).apps!.list.find((a) => a.name === "shop")!.head?.id, "c-mac");
});

test("a computer's view shows only the links the app's record vouches for: a site's Preview link only for its own label (else none, and no password asked), an address and domains that are bare hostnames, a site the record has", T, async () => {
  clearAuthCache();
  const u = newUserId("vouch");
  users.push(u);
  const st = stateOf();
  // shop's own Preview is LINK's label; its site admin has a label of its own.
  (st.workspaces[0].hostedApps as Record<string, Record<string, unknown>>).shop = { botId: "main", computerId: D1, preview: "k7p2qxm4wr3d", sites: [{ name: "admin", preview: "a1b2c3d4e5f6" }] };
  assert.equal((await call(cloud.url, "PUT", "/v1/state", { key: `key-${u}`, headers: asNew(u), json: { base: 0, state: st } })).status, 200);
  // What a prompt-injected bot on shop's computer might post: another Preview's link for admin, a login page, a site the record hasn't.
  const sites = [
    {
      name: "shop",
      url: "https://shop.example.com",
      preview: LINK,
      previewProtected: true,
      serving: "c-new",
      live: null,
      domains: [
        { domain: "shop.example.com", status: "active" },
        { domain: "evil.example/login", status: "active" },
        { domain: "https://evil.example", status: "active" },
      ],
    },
    { name: "admin", url: "https://evil.example/login", preview: "https://zz9zz9zz9zz9.orgo.dev", previewProtected: true, serving: null, live: null },
    { name: "ghost", url: "https://user:pw@evil.example", preview: "https://foo-login.evil.example/", previewProtected: true, serving: null, live: null },
  ];
  const owned = [
    { id: "dom-1", domain: "example.com" },
    { id: "dom-2", domain: "evil.example/x" },
  ];
  assert.equal((await post(vm(u), { shop: viewOf("c-new", { sites, owned }) })).status, 204);
  const SHOP = { name: "shop", url: "https://shop.example.com", preview: LINK, previewProtected: true, serving: "c-new", domains: [{ domain: "shop.example.com", status: "active" }] };
  const ADMIN = { name: "admin", url: null, preview: null, serving: null };
  // Kept so (cleanAppView with the record).
  const [kept] = await rows(u);
  assert.deepEqual(kept.view.sites, [SHOP, ADMIN]);
  assert.deepEqual(kept.view.owned, [{ id: "dom-1", domain: "example.com" }]);
  // Shown so, at Write and at Read.
  const blob = (await query<{ state: Record<string, unknown> }>("SELECT state FROM bops.app_state WHERE user_id = $1", [u])).rows[0].state;
  const views = await readAppViews(null, u, "ws_main");
  const SAM: SliceViewer = { role: "member", email: "sam@example.com", id: "u-sam", ownerEmail: "owner@orgo.ai", appActsSeen: true };
  const RAE: SliceViewer = { role: "member", email: "rae@example.com", id: "u-rae", ownerEmail: "owner@orgo.ai", appActsSeen: true };
  const shown = sharedSlice(blob, "ws_main", SAM, views).apps!;
  assert.deepEqual(shown.list.find((a) => a.name === "shop")!.sites, [SHOP, ADMIN]);
  assert.deepEqual(shown.owned, [{ id: "dom-1", domain: "example.com" }]);
  assert.deepEqual(sharedSlice(blob, "ws_main", RAE, views).apps!.list.find((a) => a.name === "shop")!.sites, [SHOP, ADMIN]);
  // Its record names another label now (a new Preview): the link the view kept isn't vouched for any more, and isn't shown.
  const later = JSON.parse(JSON.stringify(blob)) as ReturnType<typeof stateOf>;
  (later.workspaces[0].hostedApps as Record<string, Record<string, unknown>>).shop.preview = "q9q9q9q9q9q9";
  const now = sharedSlice(later as unknown as Record<string, unknown>, "ws_main", SAM, views).apps!.list.find((a) => a.name === "shop")!.sites!;
  assert.deepEqual([now[0].preview, now[0].previewProtected], [null, undefined]);
});
