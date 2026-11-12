import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { createServer, type IncomingMessage, type ServerResponse } from "node:http";
import { after, before, test } from "node:test";
import WebSocket from "ws";
import { clearAuthCache } from "../auth.ts";
import { closeDb, query } from "../db.ts";
import { deviceIdOf } from "../device.ts";
import { hub } from "../live.ts";
import { COMPUTER_NOT_ALLOWED, PREVIEW_PASSWORD_PATH, WRONG_USER } from "../protocol.ts";
import { fullHash, sharedHash, sharedSlice, type SliceViewer } from "../ws-slice.ts";
import { call, dropUsers, listen, newUserId, prepareDb, startCloud, until, type Listening } from "./core-fakes.ts";

/**
 * Each site's Preview password as whoever set it tells Bops Cloud (preview-passwords.ts, POST /v1/apps/preview-password),
 * and who is shown it (ws-slice.ts appsFor): the owner's own key and the app's own computer may tell it, never another
 * computer or a member's key; only a Preview password's shape (or null, which clears it), at an https link; kept on the
 * owner's state by Bops Cloud's clock, one more version written by "cloud"; never said back in any answer. A Write
 * member and an Admin see it beside its link (over the owner's Mac's copy, which stays where Bops Cloud has none), a Read
 * member never, nor a link it wasn't set for; and a computer never reads it, can't write one, and keeps it when it
 * writes back what it read. The owner's Mac's check (`seen`) lands only over the entry it saw. Each one kept is heard
 * at once: the owner's Mac on the tunnel, and every stream watching the workspace. orgo-web is a fake on localhost; the
 * database is the tests' own.
 */

const D1 = "d1d1d1d1-0000-4000-8000-0000000000aa";
const D2 = "d2d2d2d2-0000-4000-8000-0000000000bb";
const LINK = "https://k7p2qxm4wr3d.orgo.dev";
const ADMIN_LINK = "https://m3q8zt5kw2pd.orgo.dev";
const NOTES_LINK = "https://w9r4tq2xk7mb.orgo.dev";
/** What the owner's Mac read for members at Write (appsForMembers): the fallback where Bops Cloud has none. */
const MAC_PASS = "Mac4pas";
const MAC_ADMIN = "Mac5adm";

let orgo: Listening;
let cloud: Listening;
const users: string[] = [];
/** Every password sent in this file, so no answer carries one (checked at the end). */
const sent = new Set<string>();
const answers: string[] = [];

const json = (res: ServerResponse, status: number, body: unknown) => res.writeHead(status, { "content-type": "application/json" }).end(JSON.stringify(body));

/** Orgo's profile: `key-<u>` the user's key, `orgo_vm_<u>~<d>` a computer's token. */
function profile(req: IncomingMessage, res: ServerResponse) {
  const key = /^Bearer (.+)$/.exec(req.headers.authorization ?? "")?.[1] ?? "";
  if (req.url !== "/api/user/profile") return json(res, 401, { error: "no" });
  let m: RegExpExecArray | null;
  if ((m = /^key-(.+)$/.exec(key))) return json(res, 200, { id: m[1], email: `${m[1]}@example.com`, api_key: { id: "k0", scope: "account" } });
  if ((m = /^orgo_vm_([^~]+)~([^~]+)$/.exec(key)))
    return json(res, 200, { id: m[1], api_key: null, principal: { kind: "vm_identity", desktop_id: m[2], expires_at: new Date(Date.now() + 3600_000).toISOString() } });
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

type Site = Record<string, unknown>;
/**
 * The owner's state: Boppy (main) on D1 working on "shop" (its own site and "admin"), Iris on D2 working on "notes";
 * Sam has Your Apps at Write, Rae at Read; the owner's Mac read each Preview for members, with its own copy of the
 * passwords at Write.
 */
function stateOf() {
  const site = (name: string, preview: string, password?: string): Site => ({ name, url: null, preview, previewProtected: true, ...(password ? { previewPassword: password } : {}), serving: null, live: null });
  return {
    owner: { name: "Ann" },
    bots: [
      { id: "main", name: "Boppy", isMain: true, computerId: D1, computerStatus: "ready" },
      { id: "iris", name: "Iris", isMain: false, computer: "own", computerId: D2, computerStatus: "ready" },
    ],
    chats: [
      { id: "bot:main", kind: "bot", botIds: ["main"], createdAt: 1, typing: [] },
      { id: "bot:iris", kind: "bot", botIds: ["iris"], createdAt: 1, typing: [] },
    ],
    sessions: [] as Record<string, unknown>[],
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
            shop: { head: null, sites: [site("shop", LINK, MAC_PASS), site("admin", ADMIN_LINK, MAC_ADMIN)], commits: [], deploys: [] },
            notes: { head: null, sites: [site("notes", NOTES_LINK)], commits: [], deploys: [] },
          },
        },
      } as Record<string, unknown>,
    ],
  };
}

/** A user whose Mac wrote their state (version 1), with `edit` made to it first. */
async function seeded(what: string, edit?: (s: ReturnType<typeof stateOf>) => void) {
  const u = newUserId(what);
  users.push(u);
  const state = stateOf();
  edit?.(state);
  const r = await call(cloud.url, "PUT", "/v1/state", { key: `key-${u}`, headers: asNew(u), json: { base: 0, state } });
  assert.equal(r.status, 200, r.text);
  return u;
}

/** The owner's state as kept, and its row's version and writer. */
async function row(u: string) {
  const r = await query<{ state: ReturnType<typeof stateOf>; version: string; writer: string | null }>("SELECT state, version, writer FROM bops.app_state WHERE user_id = $1", [u]);
  return { state: r.rows[0].state, version: Number(r.rows[0].version), writer: r.rows[0].writer };
}
const kept = async (u: string) => (await row(u)).state.workspaces[0].previewPasswords as Record<string, { url: string; password: string; at: number }> | undefined;

/** A post as Bops sends it (`key`: whose). Every answer is kept, to be checked for a password at the end. */
async function post(key: string, body: Record<string, unknown>) {
  if (typeof body.password === "string") sent.add(body.password);
  const r = await call(cloud.url, "POST", PREVIEW_PASSWORD_PATH, { key, json: body });
  answers.push(r.text);
  return r;
}
const body = (o: Record<string, unknown> = {}) => ({ ws: "ws_main", app: "shop", site: "shop", url: LINK, password: "Kq7mZ3x", ...o });

const OWNER_EMAIL = "owner@orgo.ai";
const SAM: SliceViewer = { role: "member", email: "sam@example.com", id: "u-sam", ownerEmail: OWNER_EMAIL };
const RAE: SliceViewer = { role: "member", email: "rae@example.com", id: "u-rae", ownerEmail: OWNER_EMAIL };
const ADA: SliceViewer = { role: "admin", email: "ada@example.com", id: "u-ada", ownerEmail: OWNER_EMAIL };
/** A site of an app as `viewer`'s slice shows it. */
const shown = (blob: unknown, viewer: SliceViewer, app = "shop", site = app) =>
  sharedSlice(blob as Record<string, unknown>, "ws_main", viewer).apps?.list.find((a) => a.name === app)?.sites?.find((s) => s.name === site);

test("the owner's own key: the password kept on the workspace by Bops Cloud's clock, one more version by \"cloud\", 204 with nothing in it; null clears it", T, async () => {
  clearAuthCache();
  const u = await seeded("owner");
  const was = await row(u);
  const t0 = Date.now();
  const r = await post(`key-${u}`, body());
  assert.equal(r.status, 204, r.text);
  assert.equal(r.text, "");
  const now = await row(u);
  assert.equal(now.version, was.version + 1);
  assert.equal(now.writer, "cloud");
  const p = (await kept(u))!["shop/shop"];
  assert.deepEqual({ ...p, at: 0 }, { url: LINK, password: "Kq7mZ3x", at: 0 });
  assert.ok(p.at >= t0 && p.at <= Date.now(), "Bops Cloud's own clock");
  // The admin site, by its own name; another one after it lands over the first, in the order they came.
  assert.equal((await post(`key-${u}`, body({ site: "admin", url: ADMIN_LINK, password: "Wq4tY7p" }))).status, 204);
  assert.equal((await post(`key-${u}`, body({ password: "Zr8uV3n" }))).status, 204);
  assert.deepEqual(Object.fromEntries(Object.entries((await kept(u))!).map(([k, v]) => [k, v.password])), { "shop/shop": "Zr8uV3n", "shop/admin": "Wq4tY7p" });
  // Turned off (null): that site's goes, the other stays; the last one gone, the field goes too.
  assert.equal((await post(`key-${u}`, body({ password: null }))).status, 204);
  assert.deepEqual(Object.keys((await kept(u))!), ["shop/admin"]);
  assert.equal((await post(`key-${u}`, body({ site: "admin", url: ADMIN_LINK, password: null }))).status, 204);
  assert.equal(await kept(u), undefined);
  // Null for a site with none: nothing to write, no new version.
  const v = (await row(u)).version;
  assert.equal((await post(`key-${u}`, body({ password: null }))).status, 204);
  assert.equal((await row(u)).version, v);
  // The rest of the state as the Mac wrote it.
  const st = (await row(u)).state;
  assert.deepEqual(st.workspaces[0].hostedApps, stateOf().workspaces[0].hostedApps);
  assert.deepEqual(st.workspaces[0].appsForMembers, stateOf().workspaces[0].appsForMembers);
});

test("the app's own computer may tell its app's; another computer's app is refused with nothing kept; so is a member's key", T, async () => {
  clearAuthCache();
  const u = await seeded("computer");
  // D1 is shop's home (its bot Boppy works there).
  assert.equal((await post(vm(u), body({ password: "Hn6pQ2w" }))).status, 204);
  assert.equal((await kept(u))!["shop/shop"].password, "Hn6pQ2w");
  assert.equal((await post(vm(u), body({ site: "admin", url: ADMIN_LINK, password: "Bt3kM9x" }))).status, 204);
  // notes lives on D2: D1 can't tell its password, D2 can.
  const v = (await row(u)).version;
  const no = await post(vm(u), body({ app: "notes", site: "notes", url: NOTES_LINK, password: "Gx5rT8c" }));
  assert.equal(no.status, 403, no.text);
  assert.equal(no.json.error, "Only the owner or the app's own computer can set its Preview password.");
  assert.equal((await row(u)).version, v, "nothing written");
  assert.equal((await kept(u))!["notes/notes"], undefined);
  assert.equal((await post(vm(u, D2), body({ app: "notes", site: "notes", url: NOTES_LINK, password: "Gx5rT8c" }))).status, 204);
  // A computer whose app moved off it, or lost its computer: refused.
  const st = (await row(u)).state;
  (st.workspaces[0].hostedApps as Record<string, Record<string, unknown>>).shop.lost = 7;
  const r = await call(cloud.url, "PUT", "/v1/state", { key: `key-${u}`, headers: asNew(u), json: { base: (await row(u)).version, state: st } });
  assert.equal(r.status, 200, r.text);
  assert.equal((await post(vm(u), body({ password: "Lp2dW6s" }))).status, 403, "lost its computer");
  assert.equal((await kept(u))!["shop/shop"].password, "Hn6pQ2w");
  // A member of the owner's workspace, on their own key: it's their own Bops they'd be telling, which has no such app.
  const member = newUserId("member");
  users.push(member);
  const m = await post(`key-${member}`, body({ password: "Mm7kR4v" }));
  assert.equal(m.status, 403, m.text);
  assert.equal(m.json.error, "Only the owner or the app's own computer can set its Preview password.");
  assert.notEqual((await kept(u))!["shop/shop"].password, "Mm7kR4v");
  // A site the app hasn't, an app the workspace hasn't, a workspace the owner hasn't: refused the same way.
  for (const b of [body({ site: "nope", password: "Np3qR5t" }), body({ app: "nope", site: "nope", password: "Np3qR5t" }), body({ ws: "ws_other", password: "Np3qR5t" })]) {
    const x = await post(`key-${u}`, b);
    assert.equal(x.status, 403, JSON.stringify(b));
  }
  // No sign in at all.
  assert.equal((await call(cloud.url, "POST", PREVIEW_PASSWORD_PATH, { json: body() })).status, 401);
  // Bops names the account each post is for (preview-password-share.ts): one sent on another account's sign in is 409, nothing kept.
  const v2 = (await row(u)).version;
  const named = async (key: string, who: string, password: string) => {
    sent.add(password);
    const r = await call(cloud.url, "POST", PREVIEW_PASSWORD_PATH, { key, json: body({ app: "notes", site: "notes", url: NOTES_LINK, password }), headers: { "x-bops-user": who } });
    answers.push(r.text);
    return r;
  };
  const wrong = await named(vm(u, D2), member, "Wr5ngac");
  assert.equal(wrong.status, 409, wrong.text);
  assert.equal(wrong.json.code, WRONG_USER);
  assert.equal((await named(`key-${member}`, u, "Wr6ngac")).status, 409);
  assert.equal((await row(u)).version, v2, "nothing written");
  assert.equal((await named(vm(u, D2), u, "Rt7acct")).status, 204);
  assert.equal((await kept(u))!["notes/notes"].password, "Rt7acct");
});

test("only a Preview password's shape, or null, at an https link: 6 or 8 characters, a 0, long text, an http link and the rest are refused with fixed words", T, async () => {
  clearAuthCache();
  const u = await seeded("shape");
  const v = (await row(u)).version;
  const bad: Record<string, unknown>[] = [
    body({ password: "Ab3cde" }),
    body({ password: "Ab3cdefg" }),
    body({ password: "Ab3cde0" }),
    body({ password: "AbOcde3" }),
    body({ password: "abcdefg" }),
    body({ password: "2345678" }),
    body({ password: "Kq7mZ3x".repeat(40) }),
    body({ password: 1234567 }),
    body({ password: undefined }),
    body({ url: "http://k7p2qxm4wr3d.orgo.dev" }),
    body({ url: `https://${"a".repeat(2050)}.orgo.dev` }),
    body({ url: "https://k7p2qxm4wr3d.orgo.dev/ space" }),
    body({ url: "javascript:alert(1)" }),
    body({ url: null }),
    body({ ws: "ws main" }),
    body({ app: "Shop" }),
    body({ site: "../shop" }),
    body({ site: undefined }),
  ];
  for (const b of bad) {
    const r = await post(`key-${u}`, b);
    assert.equal(r.status, 400, `${JSON.stringify(b).slice(0, 120)}: ${r.text}`);
    assert.equal(r.json.error, "Send {ws, app, site, url, password}: a workspace, an app and its site, its https link, and its Preview password or null.");
  }
  for (const raw of ["[]", "null", "\"Kq7mZ3x\""]) {
    const res = await fetch(`${cloud.url}${PREVIEW_PASSWORD_PATH}`, { method: "POST", headers: { authorization: `Bearer key-${u}`, "content-type": "application/json" }, body: raw });
    const text = await res.text();
    answers.push(text);
    assert.equal(res.status, 400, raw);
  }
  // A body far too big: refused before it's read whole.
  const big = await fetch(`${cloud.url}${PREVIEW_PASSWORD_PATH}`, { method: "POST", headers: { authorization: `Bearer key-${u}`, "content-type": "application/json" }, body: JSON.stringify(body({ pad: "x".repeat(40_000) })) });
  answers.push(await big.text());
  assert.equal(big.status, 413);
  assert.equal((await row(u)).version, v, "nothing written");
  assert.equal(await kept(u), undefined);
});

test("who is shown it: a Write member and an Admin see the new one beside its link, over the owner's Mac's copy; a Read member never; a link it wasn't set for never; their fingerprints say so", T, async () => {
  clearAuthCache();
  const u = await seeded("slice");
  const before = (await row(u)).state;
  // Before Bops Cloud has any: the owner's Mac's copy, at Write only.
  assert.equal(shown(before, SAM)?.previewPassword, MAC_PASS);
  assert.equal(shown(before, ADA)?.previewPassword, MAC_PASS);
  assert.equal(shown(before, RAE)?.previewPassword, undefined);
  const samWas = sharedHash(sharedSlice(before as unknown as Record<string, unknown>, "ws_main", SAM));
  const raeWas = sharedHash(sharedSlice(before as unknown as Record<string, unknown>, "ws_main", RAE));
  const fullWas = fullHash(before as unknown as Record<string, unknown>, "ws_main");
  // A runner set a new one as its deploy went live, and told Bops Cloud.
  assert.equal((await post(vm(u), body({ password: "Ny4bH7k" }))).status, 204);
  const now = (await row(u)).state;
  for (const v of [SAM, ADA]) {
    assert.equal(shown(now, v)?.previewPassword, "Ny4bH7k", v.email);
    assert.equal(shown(now, v)?.previewProtected, true);
    // A site Bops Cloud has none for: the owner's Mac's copy still.
    assert.equal(shown(now, v, "shop", "admin")?.previewPassword, MAC_ADMIN, v.email);
  }
  assert.equal(shown(now, RAE)?.previewProtected, true, "Read: that it asks for one");
  assert.ok(!JSON.stringify(sharedSlice(now as unknown as Record<string, unknown>, "ws_main", RAE)).includes("Ny4bH7k"), "Read never sees it");
  // Their windows hear of it: the workspace's part changed (stateWritten publishes), Sam's slice is another, Rae's the same.
  assert.notEqual(fullHash(now as unknown as Record<string, unknown>, "ws_main"), fullWas);
  assert.notEqual(sharedHash(sharedSlice(now as unknown as Record<string, unknown>, "ws_main", SAM)), samWas);
  assert.equal(sharedHash(sharedSlice(now as unknown as Record<string, unknown>, "ws_main", RAE)), raeWas);
  // No fingerprint is worked out from a password: only a password changed gives the same ones; only its time, new ones.
  const nowBlob = now as unknown as Record<string, unknown>;
  const wsIn = (b: Record<string, unknown>) => (b.workspaces as Record<string, unknown>[]).find((w) => w.id === "ws_main")!;
  const twin = structuredClone(nowBlob);
  const entry = (wsIn(twin).previewPasswords as Record<string, { password: string; at: number }>)["shop/shop"];
  entry.password = "Wm6pL3d";
  const macSite = ((wsIn(twin).appsForMembers as { apps: Record<string, { sites: { name: string; previewPassword?: string }[] }> }).apps.shop.sites).find((x) => x.name === "admin")!;
  macSite.previewPassword = "Hd8rK2v";
  for (const v of [SAM, ADA]) assert.equal(sharedHash(sharedSlice(twin, "ws_main", v)), sharedHash(sharedSlice(nowBlob, "ws_main", v)), v.email);
  assert.equal(fullHash(twin, "ws_main"), fullHash(nowBlob, "ws_main"));
  entry.at += 1;
  assert.notEqual(sharedHash(sharedSlice(twin, "ws_main", SAM)), sharedHash(sharedSlice(nowBlob, "ws_main", SAM)), "Bops Cloud's time");
  assert.notEqual(fullHash(twin, "ws_main"), fullHash(nowBlob, "ws_main"));
  const macTwin = structuredClone(nowBlob);
  (wsIn(macTwin).appsForMembers as { at: number }).at += 1;
  assert.notEqual(sharedHash(sharedSlice(macTwin, "ws_main", SAM)), sharedHash(sharedSlice(nowBlob, "ws_main", SAM)), "the owner's Mac's time");
  assert.notEqual(fullHash(macTwin, "ws_main"), fullHash(nowBlob, "ws_main"));
  // One kept for a link the site no longer has (it moved, its link made again): never shown; the owner's Mac's copy is.
  assert.equal((await post(`key-${u}`, body({ site: "admin", url: "https://zz9yxw8vu7ts.orgo.dev", password: "Qs5cX2m" }))).status, 204);
  const stale = (await row(u)).state;
  assert.equal(shown(stale, SAM, "shop", "admin")?.previewPassword, MAC_ADMIN);
  assert.ok(!JSON.stringify(sharedSlice(stale as unknown as Record<string, unknown>, "ws_main", SAM)).includes("Qs5cX2m"));
  // Turned off (null): the owner's Mac's copy, until it reads again.
  assert.equal((await post(`key-${u}`, body({ password: null }))).status, 204);
  assert.equal(shown((await row(u)).state, SAM)?.previewPassword, MAC_PASS);
  // The owner's own view never carries apps (their page reads Orgo itself); a slice never names previewPasswords.
  for (const v of [SAM, ADA, RAE]) assert.ok(!JSON.stringify(sharedSlice((await row(u)).state as unknown as Record<string, unknown>, "ws_main", v)).includes("previewPasswords"));
});

/** A Preview label sealed for an app's site, as lib/server/app-labels.ts newLabel makes one from `head` (8 letters and digits): what computer-scope.ts sealedFor lets a computer keep. */
function sealedLabel(repo: string, site: string, head: string): string {
  const h = createHash("sha256").update(`bops:preview:${repo.toLowerCase()}:${site}:${head}`).digest();
  return head + Array.from({ length: 4 }, (_, i) => "abcdefghijklmnopqrstuvwxyz0123456789"[h[i] % 36]).join("");
}

test("with the owner's Mac off, a new app a bot made on its computer shows its Preview's link to everyone with Your Apps and its password at Write, from the runner's own writes alone; another computer's share never does", T, async () => {
  clearAuthCache();
  const u = await seeded("new-app", (s) => void (s.workspaces[0].orgoProjectId = "proj-acme"));
  const label = sealedLabel("proj-acme/client-x", "client-x", "q4m8x2kz");
  const link = `https://${label}.orgo.dev`;
  const app = (blob: unknown, v: SliceViewer) => sharedSlice(blob as Record<string, unknown>, "ws_main", v).apps?.list.find((a) => a.name === "client-x");
  // The runner on D1 gives it its first home there and keeps its label copy (lib/server/hosted-apps.ts appWork, ensurePreview).
  const read = (await call(cloud.url, "GET", "/v1/state", { key: vm(u), headers: asNew(u) })).json;
  const next = structuredClone(read.state) as ReturnType<typeof stateOf>;
  (next.workspaces[0].hostedApps as Record<string, unknown>)["client-x"] = { botId: "main", computerId: D1, preview: label, passwordSet: { at: 5, live: null } };
  const put = await call(cloud.url, "PUT", "/v1/state", { key: vm(u), headers: asNew(u), json: { base: read.version, state: next } });
  assert.equal(put.status, 200, put.text);
  const before = (await row(u)).state;
  assert.equal(app(before, ADA)?.sites, undefined, "by name only, before its password is shared");
  const hashes = (blob: unknown) => [SAM, ADA, RAE].map((v) => sharedHash(sharedSlice(blob as Record<string, unknown>, "ws_main", v)));
  const was = hashes(before);
  // Another computer (D2, Iris's) telling a password for it: refused, nothing kept.
  assert.equal((await post(vm(u, D2), body({ app: "client-x", site: "client-x", url: link, password: "Pt5hR3c" }))).status, 403);
  assert.equal(app((await row(u)).state, ADA)?.sites, undefined);
  // Its own computer sets its password on Orgo and shares it, with its link.
  assert.equal((await post(vm(u), body({ app: "client-x", site: "client-x", url: link, password: "Nw5pR8t" }))).status, 204);
  const now = (await row(u)).state;
  for (const v of [SAM, ADA]) {
    const site = app(now, v)?.sites?.[0];
    assert.deepEqual({ ...site, previewPasswordAt: 0 }, { name: "client-x", url: null, preview: link, previewProtected: true, previewPassword: "Nw5pR8t", previewPasswordAt: 0, serving: null }, v.email);
  }
  assert.deepEqual(app(now, RAE)?.sites, [{ name: "client-x", url: null, preview: link, previewProtected: true, serving: null }], "Read: its link, and that it asks for a password");
  assert.ok(!JSON.stringify(sharedSlice(now as unknown as Record<string, unknown>, "ws_main", RAE)).includes("Nw5pR8t"), "Read never sees it");
  // Everyone shown it is told: each one's fingerprint is another.
  hashes(now).forEach((h, i) => assert.notEqual(h, was[i], [SAM, ADA, RAE][i].email));
  // The runner's own read never has it.
  const again = await call(cloud.url, "GET", "/v1/state", { key: vm(u), headers: asNew(u) });
  answers.push(again.text);
  assert.ok(!again.text.includes("Nw5pR8t"));
  // The owner's Mac back on reads it from Orgo: its row stands, the newest password beside it.
  const mac = structuredClone(now);
  ((mac.workspaces[0].appsForMembers as { apps: Record<string, unknown> }).apps)["client-x"] = { head: { id: "cs-1", message: "First", at: 6 }, sites: [{ name: "client-x", url: null, preview: link, previewLive: { id: "dep-1", state: "succeeded", when: 6 }, previewServing: "cs-1", previewProtected: true, serving: null, live: null }], commits: [], deploys: [] };
  const back = await call(cloud.url, "PUT", "/v1/state", { key: `key-${u}`, headers: asNew(u), json: { base: (await row(u)).version, state: mac } });
  assert.equal(back.status, 200, back.text);
  const read2 = app((await row(u)).state, ADA)!;
  assert.deepEqual(read2.sites?.map((s) => [s.preview, s.previewLive?.state, s.previewPassword]), [[link, "succeeded", "Nw5pR8t"]]);
});

test("a computer never reads it, can't write one (even the right one), and keeps it when it writes back what it read", T, async () => {
  clearAuthCache();
  const u = await seeded("runner");
  assert.equal((await post(`key-${u}`, body({ password: "Rk3mT8w" }))).status, 204);
  // Its read: no password, no field for it.
  const read = await call(cloud.url, "GET", "/v1/state", { key: vm(u), headers: asNew(u) });
  assert.equal(read.status, 200, read.text);
  answers.push(read.text);
  assert.ok(!read.text.includes("previewPasswords"));
  assert.ok(!read.text.includes("Rk3mT8w"));
  // Its write of what it read, with a thread of its own: taken, the password as it was.
  const mine = structuredClone(read.json.state) as ReturnType<typeof stateOf>;
  mine.sessions.push({ id: "s-run", botId: "main", by: deviceIdOf(u, D1), goal: "a run", status: "running" });
  const put = await call(cloud.url, "PUT", "/v1/state", { key: vm(u), headers: asNew(u), json: { base: read.json.version, state: mine } });
  assert.equal(put.status, 200, put.text);
  assert.equal((await kept(u))!["shop/shop"].password, "Rk3mT8w", "kept");
  assert.equal((await row(u)).state.sessions.at(-1)?.id, "s-run");
  // A write carrying one, its own or the right one: refused before it's compared.
  const again = (await call(cloud.url, "GET", "/v1/state", { key: vm(u), headers: asNew(u) })).json;
  for (const password of ["Zz9yXw8", "Rk3mT8w"]) {
    const next = structuredClone(again.state) as ReturnType<typeof stateOf>;
    next.workspaces[0].previewPasswords = { "shop/shop": { url: LINK, password, at: 1 } };
    const r = await call(cloud.url, "PUT", "/v1/state", { key: vm(u), headers: asNew(u), json: { base: again.version, state: next } });
    answers.push(r.text);
    assert.equal(r.status, 403, r.text);
    assert.equal(r.json.code, COMPUTER_NOT_ALLOWED);
    assert.deepEqual(r.json.paths, ["workspaces"]);
  }
  assert.equal((await kept(u))!["shop/shop"].password, "Rk3mT8w");
  // A write over an older version: the state it's handed back has none either.
  const stale = await call(cloud.url, "PUT", "/v1/state", { key: vm(u), headers: asNew(u), json: { base: read.json.version, state: mine } });
  answers.push(stale.text);
  assert.equal(stale.status, 409, stale.text);
  assert.ok(!stale.text.includes("previewPasswords") && !stale.text.includes("Rk3mT8w"));
  // The owner's own read has it (their Mac carries it along).
  assert.equal((await call(cloud.url, "GET", "/v1/state", { key: `key-${u}`, headers: asNew(u) })).json.state.workspaces[0].previewPasswords["shop/shop"].password, "Rk3mT8w");
});

test("the owner's Mac's check (seen) lands only over the entry it saw: another share since stands, as does no entry; a seen that isn't a time is refused", T, async () => {
  clearAuthCache();
  const u = await seeded("seen");
  assert.equal((await post(vm(u), body({ password: "Ru5nnr2" }))).status, 204);
  const at = (await kept(u))!["shop/shop"].at;
  // Seen something else (a share landed after the Mac looked): nothing changes, no new version, the same answer.
  const v = (await row(u)).version;
  const stale = await post(`key-${u}`, body({ password: "Mc6chk3", seen: at - 1 }));
  assert.equal(stale.status, 204, stale.text);
  assert.equal(stale.text, "");
  assert.equal((await row(u)).version, v);
  assert.equal((await kept(u))!["shop/shop"].password, "Ru5nnr2");
  // Seen for a site with none: nothing either.
  assert.equal((await post(`key-${u}`, body({ site: "admin", url: ADMIN_LINK, password: "Mc7chk4", seen: at }))).status, 204);
  assert.equal((await kept(u))!["shop/admin"], undefined);
  // Seen the one kept: it lands (a password, or none).
  assert.equal((await post(`key-${u}`, body({ password: "Mc8chk5", seen: at }))).status, 204);
  const now = (await kept(u))!["shop/shop"];
  assert.equal(now.password, "Mc8chk5");
  assert.ok(now.at >= at);
  assert.equal((await post(`key-${u}`, body({ password: null, seen: now.at }))).status, 204);
  assert.equal(await kept(u), undefined);
  for (const seen of [-1, 1.5, "1", null, Number.MAX_SAFE_INTEGER + 2]) {
    const r = await post(`key-${u}`, body({ seen }));
    assert.equal(r.status, 400, `${String(seen)}: ${r.text}`);
  }
});

test("each one kept is heard at once: the owner's Mac on the tunnel is told to read, and a stream watching the workspace gets its new state", T, async () => {
  clearAuthCache();
  const u = await seeded("heard");
  // The owner's Mac on the tunnel.
  const mac = new WebSocket(`${cloud.url.replace(/^http/, "ws")}/v1/connect`, { headers: { authorization: `Bearer key-${u}`, "x-bops-version": "99.0.0", "x-bops-state-level": "3" } });
  const frames: { t: string; version?: number }[] = [];
  mac.on("message", (data) => {
    const f = JSON.parse(String(data)) as { t: string; version?: number };
    frames.push(f);
    if (f.t === "ping") mac.send(JSON.stringify({ t: "pong" }));
  });
  mac.on("error", () => {});
  await new Promise<void>((resolve, reject) => {
    mac.once("open", () => resolve());
    mac.once("unexpected-response", (_req, res) => reject(new Error(`refused ${res.statusCode}`)));
  });
  // A stream watching the owner's workspace (as each Write member's is, held to their own slice).
  const ctl = new AbortController();
  const res = await fetch(`${cloud.url}/v1/live?ws=ws_main`, { headers: { authorization: `Bearer key-${u}` }, signal: ctl.signal });
  assert.equal(res.status, 200);
  const events: { type: string; data: Record<string, unknown> }[] = [];
  void (async () => {
    const dec = new TextDecoder();
    let text = "";
    try {
      for await (const chunk of res.body!) {
        text += dec.decode(chunk as Uint8Array, { stream: true });
        for (let i = text.indexOf("\n\n"); i >= 0; i = text.indexOf("\n\n")) {
          const block = text.slice(0, i);
          text = text.slice(i + 2);
          const field = (name: string) => block.split("\n").find((l) => l.startsWith(`${name}: `))?.slice(name.length + 2);
          if (field("event")) events.push({ type: field("event")!, data: JSON.parse(field("data") ?? "{}") });
        }
      }
    } catch {}
  })();
  try {
    await until(() => events.some((e) => e.type === "reset"), "the stream to start");
    const written = hub.written;
    const before = events.length;
    assert.equal((await post(vm(u), body({ password: "Hd4rd7x" }))).status, 204);
    const version = (await row(u)).version;
    const told = await until(() => frames.find((f) => f.t === "state" && f.version === version), "the owner's Mac told to read");
    assert.equal(told.version, version);
    const heard = await until(() => events.slice(before).find((e) => e.type === "state"), "the stream's new state");
    assert.equal(heard.data.by, "cloud");
    assert.ok(hub.written > written);
    // Nothing to write (none for a site with none): nobody told.
    const n = frames.length;
    const m = events.length;
    assert.equal((await post(`key-${u}`, body({ site: "admin", url: ADMIN_LINK, password: null }))).status, 204);
    await new Promise((r) => setTimeout(r, 150));
    assert.equal(frames.slice(n).filter((f) => f.t === "state").length, 0);
    assert.equal(events.slice(m).filter((e) => e.type === "state").length, 0);
    // Never the password, on either.
    assert.ok(!JSON.stringify(frames).includes("Hd4rd7x") && !JSON.stringify(events).includes("Hd4rd7x"));
  } finally {
    ctl.abort();
    mac.close();
  }
});

test("no answer in this file carried a password it was sent", T, () => {
  assert.ok(sent.size >= 10 && answers.length >= 30);
  for (const a of answers) for (const p of sent) assert.ok(!a.includes(p), a.slice(0, 200));
});
