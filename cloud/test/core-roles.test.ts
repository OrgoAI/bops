import assert from "node:assert/strict";
import * as nodeModule from "node:module";
import { test } from "node:test";
import { fileURLToPath, pathToFileURL } from "node:url";
import { adminAccess, appsOpenFor, computerUseOf, sharedSlice, sliceOf, viewerAccess, type SliceViewer } from "../ws-slice.ts";

/**
 * Owner, Admin and Member in a shared workspace, and Your Apps there, from the state a real Mac uploads (toShared,
 * which never has `account`): whether a workspace has apps is orgo-web's to say (WsAccess.ownerEmail), never the
 * owner's upload. An Admin has every bot, its computer and Your Apps at Write with no entry at all. Every name, email
 * and id is made up.
 */

// lib/apps-access.ts imports "@/cloud/apps-team": "@/" is the repo root (as scripts/test-shared.mjs maps it). The
// window's files are loaded by URL, so the cloud's typecheck doesn't take them in (they're the app's).
type Next = (spec: string, ctx: unknown) => unknown;
const hooks = nodeModule as unknown as { registerHooks: (h: { resolve: (spec: string, ctx: unknown, next: Next) => unknown }) => void };
const root = fileURLToPath(new URL("../..", import.meta.url)).replace(/\/$/, "");
hooks.registerHooks({ resolve: (spec, ctx, next) => next(spec.startsWith("@/") ? pathToFileURL(`${root}/${spec.slice(2)}.ts`).href : spec, ctx) });
const appFile = (path: string) => import(new URL(`../../${path}`, import.meta.url).href);
/** The owner's Mac's own upload (lib/server/state-merge.ts): every NEVER_SYNCED part left out. */
const { toShared } = (await appFile("lib/server/state-merge.ts")) as { toShared: (state: unknown, device: string) => Record<string, unknown> };

const STAFF_OWNER = "owner@orgo.ai";
const MEMBER_EMAIL = "member@example.com";

/** The owner's state on their Mac, account and all (lib/server/store.ts). */
const ownerState = (ws: Record<string, unknown> = {}) => ({
  account: { user: { id: "user-owner", email: STAFF_OWNER, name: "Owner" } },
  workspaces: [
    {
      id: "ws_studio",
      name: "Studio",
      createdAt: 1,
      memberAccess: { [MEMBER_EMAIL]: { others: "write", bots: {}, apps: "write", computer: "use", at: 2_000 } },
      hostedApps: { shop: { botId: "max", computerId: "comp-1", projectId: "proj-1", url: "https://shop.example.dev", sites: [{ name: "shop" }] } },
      appsForMembers: { at: 10, apps: { shop: { head: null, sites: [{ name: "shop", url: "https://shop.example.dev", serving: null, live: null }], commits: [], deploys: [] } } },
      ...ws,
    },
  ],
  bots: [
    { id: "max", name: "Max", isMain: true, workspaceId: "ws_studio", computerId: "comp-max", computer: "own" },
    { id: "ivy", name: "Ivy", workspaceId: "ws_studio", computer: "shared" },
  ],
  chats: [
    { id: "bot:max", kind: "bot", botIds: ["max"], workspaceId: "ws_studio" },
    { id: "bot:ivy", kind: "bot", botIds: ["ivy"], workspaceId: "ws_studio" },
  ],
  sessions: [{ id: "s-app", botId: "max", chatId: "bot:max", title: "Work on shop", app: { wsId: "ws_studio", name: "shop" } }],
  routines: [],
  watches: [],
});
/** What Bops Cloud keeps: the state as a real Mac uploads it. */
const uploaded = (ws?: Record<string, unknown>) => toShared(ownerState(ws), "mac-owner") as Record<string, unknown>;

const member: SliceViewer = { role: "member", email: MEMBER_EMAIL, id: "user-member", joinedAt: 1_000, computerUse: true, ownerEmail: STAFF_OWNER };
const admin: SliceViewer = { role: "admin", email: "ada@example.com", id: "user-ada", joinedAt: 1_000, ownerEmail: STAFF_OWNER };

test("the uploaded state has no account, and Your Apps still reaches a member of a workspace of Orgo's team (orgo-web says who owns it)", () => {
  const blob = uploaded();
  assert.equal("account" in blob, false, "account is never synced");
  const s = sharedSlice(blob, "ws_studio", member);
  assert.equal(s.apps?.level, "write", "fixed: the member's apps at Write");
  assert.deepEqual(s.apps?.list.map((a) => a.name), ["shop"]);
  assert.equal(s.computer, "use");
  // From an orgo-web that doesn't say the owner's email (before this change): none, as before. Never more.
  assert.equal(sharedSlice(blob, "ws_studio", { ...member, ownerEmail: undefined }).apps, undefined);
});

test("the window shows Your Apps once the slice carries them, for a viewer of Orgo's team and anyone else", async () => {
  const { appsShown } = (await appFile("lib/apps-access.ts")) as { appsShown: (s: never) => boolean };
  const s = sharedSlice(uploaded(), "ws_studio", member);
  const shared = { projectId: "p", name: "Studio", owner: STAFF_OWNER, role: "member" as const, wsId: "shared_p", ...(s.apps ? { apps: s.apps } : {}) };
  assert.equal(appsShown({ account: { user: { email: "staff@orgo.ai" } }, shared } as never), true);
  assert.equal(appsShown({ account: { user: { email: MEMBER_EMAIL } }, shared } as never), true);
  // A workspace whose owner isn't Orgo's team: a viewer of Orgo's team sees what the cloud sent (read only); anyone else nothing.
  const theirs = { ...shared, owner: "owner@example.com" };
  assert.equal(appsShown({ account: { user: { email: "staff@orgo.ai" } }, shared: theirs } as never), true);
  assert.equal(appsShown({ account: { user: { email: MEMBER_EMAIL } }, shared: theirs } as never), false);
  // Nothing sent: hidden, whoever looks.
  assert.equal(appsShown({ account: { user: { email: "staff@orgo.ai" } }, shared: { ...shared, apps: undefined } } as never), false);
});

test("a brand new workspace of Orgo's team (no apps on the web yet): Your Apps, empty, for an Admin and a member at Read", () => {
  const blob = uploaded({ hostedApps: undefined, appsForMembers: undefined, memberAccess: { [MEMBER_EMAIL]: { others: "read", bots: {}, apps: "read", at: 2_000 } } });
  assert.deepEqual(sharedSlice(blob, "ws_studio", admin).apps, { level: "write", at: 0, list: [] });
  assert.deepEqual(sharedSlice(blob, "ws_studio", member).apps, { level: "read", at: 0, list: [] });
});

test("the owner's upload never opens apps: an @orgo.ai account in a state orgo-web says a non staff account owns gives a member nothing", () => {
  const forged: Record<string, unknown> = { ...uploaded(), account: { user: { id: "user-owner", email: "anyone@orgo.ai" } } };
  const viewer = { ...member, ownerEmail: "owner@example.com" };
  assert.equal(sharedSlice(forged, "ws_studio", viewer).apps, undefined);
  assert.equal(appsOpenFor(viewer), false);
  // A viewer of Orgo's team there: read only, never Write, never settings.
  const staff = { ...viewer, email: "staff@orgo.ai" };
  assert.equal(appsOpenFor(staff), "read");
  assert.equal(sharedSlice({ ...forged, workspaces: [{ ...(forged.workspaces as Record<string, unknown>[])[0], memberAccess: { "staff@orgo.ai": { others: "read", bots: {}, apps: "write", at: 2_000 } } }] }, "ws_studio", staff).apps?.level, "read");
});

test("an Admin has every bot (a bot made later too), Your Apps at Write and Use its computer, with no entry, over None and over an entry from before", () => {
  const later = (ws: Record<string, unknown>) => ({ ...uploaded(ws), bots: [...(uploaded().bots as unknown[]), { id: "new", name: "New", workspaceId: "ws_studio" }] });
  for (const [why, memberAccess] of [
    ["no entry", {}],
    ["an entry of None", { "ada@example.com": { others: "none", bots: { max: "none" }, apps: "none", computer: "none", at: 2_000 } }],
    ["an entry from before they joined", { "ada@example.com": { others: "none", bots: {}, at: 500 } }],
  ] as const) {
    const blob = later({ memberAccess });
    const s = sharedSlice(blob, "ws_studio", admin);
    assert.deepEqual(s.bots.map((b) => b.id), ["max", "ivy", "new"], why);
    assert.deepEqual(s.levels, { max: "write", ivy: "write", new: "write" }, why);
    assert.equal(s.computer, "use", why);
    assert.equal(s.apps?.level, "write", why);
    assert.deepEqual(s.sessions.map((x) => x.id), ["s-app"], `${why}: app threads of a bot at Write, in a workspace of Orgo's team`);
    const ws = sliceOf(blob, "ws_studio").workspace;
    assert.equal(computerUseOf(ws, { ...admin, computerUse: false }), true, `${why}: Use its computer, whatever an older orgo-web's column says`);
  }
  // A fresh object each time: changing one never changes another's.
  const a = viewerAccess(null, admin);
  a.bots.max = "none";
  assert.deepEqual(viewerAccess(null, admin), adminAccess());
  assert.equal(levelsOfMember(), "member held to the entry", "a member is still held to what the owner gave");
});

test("an Admin's copy of the workspace has its switch as the owner's state has it: chatOn, chatAuto and chatAutoOff", () => {
  assert.deepEqual(sharedSlice(uploaded({ chatOn: "mac", chatAutoOff: true }), "ws_studio", admin).workspace, { id: "ws_studio", name: "Studio", createdAt: 1, chatOn: "mac", chatAutoOff: true });
  assert.equal(sharedSlice(uploaded({ chatAuto: true }), "ws_studio", admin).workspace?.chatAutoOff, undefined);
});

/** A member with Write on Max only still sees only Max: Admin changes nothing for anyone else. */
function levelsOfMember() {
  const s = sharedSlice(uploaded({ memberAccess: { [MEMBER_EMAIL]: { others: "none", bots: { max: "write" }, at: 2_000 } } }), "ws_studio", member);
  return s.bots.map((b) => b.id).join() === "max" && s.computer === "use" && s.apps === undefined ? "member held to the entry" : JSON.stringify(s);
}

test("what a shared workspace's member is shown of the computer (the diagnosis repro, now with roles)", async () => {
  const { callAllowed } = (await appFile("components/app/view-only.ts")) as { callAllowed: (method: string, url: string) => boolean };
  const joined = Date.parse("2026-10-28T12:00:00Z");
  const at = Date.parse("2026-11-01T12:00:00Z");
  const ws = { id: "ws_x", memberAccess: { "sam@example.com": { others: "write", bots: {}, apps: "write", computer: "use", at } } };
  const sam: SliceViewer = { role: "admin", email: "sam@example.com", id: "u1", joinedAt: joined, computerUse: true };
  assert.deepEqual(viewerAccess(ws, sam), adminAccess());
  assert.equal(computerUseOf(ws, sam), true);
  // The owner's computer is never streamed through the viewer's own routes (their own bot of that id)...
  for (const [m, u] of [["GET", "/api/vnc?bot=b&display=99"], ["GET", "/api/computer?bot=b"], ["GET", "/api/screen?bot=b"], ["POST", "/api/takeover"], ["POST", "/api/input"]]) assert.equal(callAllowed(m, u), false, `${m} ${u}`);
  // ...only through the shared workspace's own, which takes the computer from the shared copy (an Admin's).
  assert.equal(callAllowed("GET", "/api/workspaces/shared/screen?bot=max"), true);
  assert.equal(callAllowed("POST", "/api/workspaces/shared"), true);
});

test("an Admin's slice says which computer each bot works on (to stream it with their own Orgo key); nobody else's ever does", () => {
  const blob = uploaded();
  assert.deepEqual(sharedSlice(blob, "ws_studio", admin).screens, { max: "comp-max", ivy: "comp-max" }, "Ivy shares the main bot's");
  assert.equal(sharedSlice(blob, "ws_studio", member).screens, undefined, "a member with Use its computer: none");
  assert.ok(!JSON.stringify(sharedSlice(blob, "ws_studio", member)).includes("comp-max"));
});

test("Keys, from the state a real Mac uploads: an Admin has it unless orgo-web says no (a share link's guest), a Member only on orgo-web's yes; the names said and each bot's keys come with it, never anyone else's", () => {
  const blob = toShared(
    {
      ...ownerState({ keysForMembers: { at: 3, keys: [{ name: "STRIPE_SECRET_KEY", scope: "all" }] } }),
      bots: ownerState().bots.map((b) => ({ ...b, keys: ["STRIPE_SECRET_KEY"] })),
    },
    "mac-owner",
  ) as Record<string, unknown>;
  const of = (v: SliceViewer) => {
    const s = sharedSlice(blob, "ws_studio", v);
    return [s.keys, s.keyNames?.map((k) => k.name), s.bots.map((b) => b.keys)];
  };
  assert.deepEqual(of(admin), [true, ["STRIPE_SECRET_KEY"], [["STRIPE_SECRET_KEY"], ["STRIPE_SECRET_KEY"]]], "an orgo-web that doesn't say: an Admin has it");
  assert.deepEqual(of({ ...admin, keys: false }), [undefined, undefined, [undefined, undefined]], "orgo-web's no stands for an Admin");
  assert.deepEqual(of({ ...member, keys: true }), [true, ["STRIPE_SECRET_KEY"], [["STRIPE_SECRET_KEY"], ["STRIPE_SECRET_KEY"]]]);
  assert.deepEqual(of(member), [undefined, undefined, [undefined, undefined]]);
});
