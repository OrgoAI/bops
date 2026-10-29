// Tests for Used in and who reaches a login (lib/types.ts levelOf, levelIn, accountIn, siteLoginIn, outsideThread,
// memberThread; lib/server/logins.ts; app/api/logins; lib/server/vault.ts on a member's or a stranger's thread):
// - a Connected App switched on in another workspace is every bot's there by default (Read & act), the per bot picker
//   narrowing it; off, no bot there has it, the grants by name there going too; its own workspace is always on;
// - a saved site login keeps nothing new: on in a workspace gives it to each bot there by name, off takes it from them;
// - the route takes a change only from the Bops window, and says plainly what it can't do;
// - on a member's thread (one they started or told something) the bot may sign in with a saved login of its own only
//   when it's set to sign in by itself; one that asks first waits for the owner's card. A stranger's thread (an email,
//   a text, a call from outside Bops) gets none of the owner's saved logins, as before.
//
// The store, the screens, the Keychain and Orgo are fakes: nothing reaches a real service or browser.
// Usage: node --conditions=react-server scripts/test-logins.mjs
import assert from "node:assert/strict";
import { registerHooks } from "node:module";
import { pathToFileURL } from "node:url";
import { fill } from "./fake-exports.mjs";

for (const k of Object.keys(process.env)) if (/^(BOPS|COMPOSIO|ORGO)_/.test(k)) delete process.env[k];
const UI = "ui-token-test-logins";
process.env.BOPS_UI_TOKEN = UI;
const root = new URL("..", import.meta.url).pathname.replace(/\/$/, "");

const forward = (mod, names) => names.map((n) => `export const ${n} = (...a) => globalThis.__fake[${JSON.stringify(mod)}].${n}(...a);`).join("\n");
const FAKES = {
  store: forward("store", ["getState", "update", "bot", "session", "patchSession", "ownerName", "stateReady", "stateUser", "id"]),
  "access-sync": "export const accessChanged = () => { globalThis.__fake.changed++; }; export const logUse = () => {}; export const viaOf = () => ({ via: 'chat' }); export const forMember = () => undefined;",
  keychain: "export const getUserSecret = async (k) => (k.endsWith(':password') ? 'pw-fake' : null); export const setUserSecret = async () => {}; export const deleteUserSecret = async () => {};",
  local: forward("local", ["openPages", "onTab"]),
  "screen-watch": forward("screenWatch", ["readScreen"]),
  screens: "export const screenEndpoint = () => 'ep-fake';",
  "sign-in": forward("signIn", ["submitSignIn"]),
  persist: "export const onRunner = () => false;",
  sessions: "export const addStep = () => {};",
  orgo: "export const apiKey = async () => 'sk_test';",
  // keysOf as lib/server/keys.ts has it: the account's, the workspace's own project's, and one switched on there.
  keys: `import { keyLoginKey, switchedOn } from "@/lib/types";
export const listKeys = async () => globalThis.__fake.keys;
export const keysOf = (all, ws) => {
  const w = globalThis.__fake.store.getState().workspaces.find((x) => x.id === ws);
  return all.filter((k) => !k.workspaceId || k.workspaceId === w?.orgoProjectId || switchedOn(w, keyLoginKey(k.workspaceId, k.name)));
};
export class KeysError extends Error {}`,
};
registerHooks({
  resolve(specifier, context, next) {
    if (specifier.startsWith("@/")) specifier = pathToFileURL(`${root}/${specifier.slice(2)}`).href;
    try {
      return next(specifier, context);
    } catch (e) {
      if (/^(\.{1,2}\/|\/|file:)/.test(specifier))
        for (const ext of [".ts", ".tsx"])
          try {
            return next(specifier + ext, context);
          } catch {}
      throw e;
    }
  },
  load(url, context, next) {
    const name = url.match(/\/lib\/server\/([a-z-]+)\.ts$/)?.[1];
    if (!name || !FAKES[name]) return next(url, context);
    return { format: "module", shortCircuit: true, source: fill(name, url, FAKES[name]) };
  },
});

let failures = 0;
let passed = 0;
async function check(name, fn) {
  try {
    await fn();
    passed++;
  } catch (e) {
    failures++;
    console.error(`FAIL ${name}\n  ${e.stack?.split("\n").slice(0, 4).join("\n  ") ?? e.message}`);
  }
}
const DASHES = /[‒–—―]| - /;

const DEE = { userId: "user_dee", email: "dee@acme.example", name: "Dee" };
const fresh = () => ({
  owner: { name: "Ava" },
  workspace: "ws_main",
  workspaces: [
    { id: "ws_main", name: "Main", createdAt: 0, orgoProjectId: "proj-main" },
    { id: "ws_fern", name: "Fernway", createdAt: 1, orgoProjectId: "proj-fern" },
  ],
  bots: [
    { id: "sam", name: "Sam", isMain: true },
    { id: "iris", name: "Iris", access: { ca_notion: "read" } },
    { id: "juno", name: "Juno", workspaceId: "ws_fern" },
    { id: "rex", name: "Rex", workspaceId: "ws_fern", access: { ca_gmail: "none" } },
  ],
  accounts: [
    { id: "ca_gmail", app: "gmail", appName: "Gmail", name: "ava@acme.example", status: "active", at: 1, workspaceId: "ws_main" },
    { id: "ca_notion", app: "notion", appName: "Notion", status: "active", at: 1, workspaceId: "ws_main", onlyGiven: true },
  ],
  vault: [
    { id: "vl_x", site: "x.com", username: "ava", hasPassword: true, hasTotp: false, bots: "all", auto: true, addedAt: 1 },
    { id: "vl_li", site: "linkedin.com", username: "ava@acme.example", hasPassword: true, hasTotp: false, bots: ["sam", "juno"], auto: false, addedAt: 1 },
  ],
  sessions: [
    { id: "ses_mine", botId: "juno", status: "running", replies: [] },
    { id: "ses_out", botId: "juno", status: "running", fromOutside: true, replies: [] },
    { id: "ses_out_part", botId: "juno", status: "running", partOf: "ses_out", replies: [] },
    { id: "ses_dee", botId: "juno", status: "running", member: DEE, replies: [] },
    { id: "ses_told", botId: "juno", status: "running", replies: [{ id: "r1", role: "user", text: "sign in to x", at: 1, member: DEE }] },
    { id: "ses_dee_part", botId: "juno", status: "running", partOf: "ses_dee", replies: [] },
  ],
  messages: [],
  routines: [],
  chats: [],
});
let state = fresh();
const signIns = [];
let pages = [{ id: "tab1", url: "https://x.com/login" }];
globalThis.__fake = {
  changed: 0,
  keys: [],
  store: {
    getState: () => state,
    update: (fn) => fn(state),
    bot: (id) => state.bots.find((b) => b.id === id),
    session: (id) => state.sessions.find((s) => s.id === id),
    patchSession: (id, patch) => Object.assign(state.sessions.find((s) => s.id === id), typeof patch === "function" ? {} : patch),
    ownerName: () => "Ava",
    stateReady: () => true,
    stateUser: () => "u1",
    id: (p) => `${p}_1`,
  },
  local: { openPages: async () => pages, onTab: async (_ep, _id, fn) => fn() },
  // A sign in page's read, kept where the screen watch keeps it (state.screens), as readScreen does.
  screenWatch: {
    readScreen: async (botId, display) => {
      const read = { url: pages[0].url, form: { identifier: true, password: true }, blocker: "sign_in" };
      (state.screens ??= {})[`${botId}:${display}`] = read;
      return read;
    },
  },
  signIn: { submitSignIn: async (b, display, values) => (signIns.push({ bot: b.id, display, values: Object.keys(values) }), { read: { url: pages[0].url }, filled: Object.keys(values) }) },
};

const T = await import(`${root}/lib/types.ts`);
const L = await import(`${root}/lib/server/logins.ts`);
const V = await import(`${root}/lib/server/vault.ts`);
const Route = await import(`${root}/app/api/logins/route.ts`);
const bot = (id) => state.bots.find((b) => b.id === id);
const account = (id) => state.accounts.find((a) => a.id === id);
const find = (id) => state.sessions.find((s) => s.id === id);
const patch = (body, window = true) =>
  Route.PATCH(new Request("http://localhost/api/logins", { method: "PATCH", headers: { "content-type": "application/json", ...(window ? { "x-bops-window": UI } : {}) }, body: JSON.stringify(body) }));

/* ---------------- levelOf with Used in ---------------- */

await check("levelOf: the default is the account's own workspace's, and each it's switched on in; the picker narrows it; a bot of anywhere else has none", () => {
  state = fresh();
  const gmail = account("ca_gmail");
  assert.equal(T.levelOf(bot("juno"), gmail), null, "Fernway's Juno hasn't Main's Gmail");
  assert.equal(T.levelOf(bot("juno"), gmail, ["ws_fern"]), "act", "switched on in Fernway: Read & act");
  assert.equal(T.levelOf(bot("rex"), gmail, ["ws_fern"]), null, "Rex was given No access there");
  assert.equal(T.levelOf({ ...bot("juno"), access: { ca_gmail: "read" } }, gmail, ["ws_fern"]), "read", "Read only narrows it");
  assert.equal(T.levelOf(bot("sam"), gmail, ["ws_fern"]), "act", "Main's bots as before");
  assert.equal(T.levelOf(bot("juno"), account("ca_notion"), ["ws_fern"]), null, "one only the bots given it have: not by default anywhere");
  assert.equal(T.levelOf(bot("iris"), account("ca_notion")), "read");
  assert.equal(T.levelOf(bot("juno"), { id: "ca_slack", app: "slackbot", workspaceId: "ws_main" }, ["ws_fern"]), null, "a channel app never by default");
  assert.equal(T.levelOf(bot("juno"), gmail, ["ws_other"]), null, "switched on elsewhere isn't here");
  assert.equal(T.levelOf({ workspaceId: "ws_fern", access: Object.create({ ca_gmail: "act" }) }, gmail), null, "only the bot's own grants, never inherited ones");
});

await check("levelIn reads Workspace.loginsOn; usedIn and accountIn say where each login is; switchedOn takes only a record", () => {
  state = fresh();
  state.workspaces[1].loginsOn = { "app:ca_gmail": { at: 1 } };
  assert.deepEqual(T.usedIn(state, "app:ca_gmail"), ["ws_fern"]);
  assert.equal(T.levelIn(state, bot("juno"), account("ca_gmail")), "act");
  assert.deepEqual(T.accountIn(state, account("ca_gmail")).sort(), ["ws_fern", "ws_main"]);
  assert.deepEqual(T.accountIn(state, account("ca_notion")), ["ws_main"], "given only to Iris, of Main");
  for (const junk of [null, true, "yes", 1]) assert.equal(T.switchedOn({ loginsOn: { k: junk } }, "k"), false, String(junk));
  assert.equal(T.switchedOn({ loginsOn: Object.create({ k: { at: 1 } }) }, "k"), false, "never an inherited one");
  assert.deepEqual(T.siteLoginIn(state, state.vault[0]).sort(), ["ws_fern", "ws_main"], "every bot: every workspace");
  assert.deepEqual(T.siteLoginIn(state, { bots: ["sam"] }), ["ws_main"]);
  assert.deepEqual(T.siteLoginIn(state, { bots: [] }), []);
});

/* ---------------- Switching on and off ---------------- */

await check("a Connected App switched on in Fernway is every bot's there by default; off, no bot there has it, and what they were given by name goes", () => {
  state = fresh();
  const n = globalThis.__fake.changed;
  assert.deepEqual(L.setAppIn("ca_gmail", "ws_fern", true), { ok: true });
  assert.ok(state.workspaces[1].loginsOn["app:ca_gmail"].at > 0);
  assert.equal(globalThis.__fake.changed, n + 1, "Orgo's copy of who may use what goes again");
  assert.equal(T.levelIn(state, bot("juno"), account("ca_gmail")), "act");
  bot("juno").access = { ca_gmail: "read", ca_notion: "act" };
  assert.deepEqual(L.setAppIn("ca_gmail", "ws_fern", false), { ok: true });
  assert.equal(state.workspaces[1].loginsOn, undefined, "an empty loginsOn goes");
  assert.deepEqual(bot("juno").access, { ca_notion: "act" }, "its Gmail grant goes, another login's stays");
  assert.equal(bot("rex").access.ca_gmail, "none", "a No access stays");
  assert.equal(T.levelIn(state, bot("juno"), account("ca_gmail")), null);
  assert.deepEqual(L.setAppIn("ca_gmail", "ws_main", true), { ok: true }, "on where it was connected: nothing to do");
  assert.equal(state.workspaces[0].loginsOn, undefined);
  const own = L.setAppIn("ca_gmail", "ws_main", false);
  assert.equal(own.status, 409);
  assert.ok(!DASHES.test(own.error), "no dashes");
  assert.equal(L.setAppIn("ca_gone", "ws_fern", true).status, 404);
  assert.equal(L.setAppIn("ca_gmail", "ws_nope", true).status, 404);
});

await check("a site login switched off in Fernway: every bot but Fernway's, by name; on again: each of Fernway's by name, never every bot of every workspace", () => {
  state = fresh();
  assert.deepEqual(L.setSiteIn("vl_x", "ws_fern", false), { ok: true });
  assert.deepEqual(state.vault[0].bots, ["sam", "iris"]);
  assert.deepEqual(V.loginsFor("juno", "https://x.com/home"), [], "Juno can't use it");
  assert.equal(V.loginsFor("sam", "https://x.com/home").length, 1);
  assert.deepEqual(L.setSiteIn("vl_x", "ws_fern", true), { ok: true });
  assert.deepEqual(state.vault[0].bots, ["sam", "iris", "juno", "rex"]);
  assert.deepEqual(L.setSiteIn("vl_li", "ws_fern", false), { ok: true });
  assert.deepEqual(state.vault[1].bots, ["sam"]);
  assert.equal(state.workspaces[1].loginsOn, undefined, "nothing new kept for a site login");
  assert.equal(L.setSiteIn("vl_gone", "ws_fern", true).status, 404);
});

await check("a login disconnected, or a key removed, is switched off everywhere (forgetLogin)", () => {
  state = fresh();
  state.workspaces[1].loginsOn = { "app:ca_gmail": { at: 1 }, "key:proj-main:GITHUB_TOKEN": { at: 1 } };
  L.forgetLogin(state, "app:ca_gmail");
  assert.deepEqual(state.workspaces[1].loginsOn, { "key:proj-main:GITHUB_TOKEN": { at: 1 } });
  L.forgetLogin(state, "key:proj-main:GITHUB_TOKEN");
  assert.equal(state.workspaces[1].loginsOn, undefined);
});

await check("the route: only from the Bops window, plain words for what it can't do, and each kind switched", async () => {
  state = fresh();
  assert.equal((await patch({ kind: "app", id: "ca_gmail", workspaceId: "ws_fern", on: true }, false)).status, 403, "a page in a bot's Chrome can't");
  assert.equal(state.workspaces[1].loginsOn, undefined);
  assert.equal((await patch({ kind: "app", id: "ca_gmail", workspaceId: "ws_fern" })).status, 400, "on or off?");
  assert.equal((await patch({ kind: "nope", id: "ca_gmail", workspaceId: "ws_fern", on: true })).status, 400);
  assert.equal((await patch({ kind: "app", id: "ca_gmail", workspaceId: "ws_fern", on: true })).status, 200);
  assert.ok(state.workspaces[1].loginsOn["app:ca_gmail"]);
  assert.equal((await patch({ kind: "site", id: "vl_x", workspaceId: "ws_fern", on: false })).status, 200);
  assert.deepEqual(state.vault[0].bots, ["sam", "iris"]);
  globalThis.__fake.keys = [{ name: "GITHUB_TOKEN", updatedAt: null, workspaceId: "proj-main" }];
  assert.equal((await patch({ kind: "key", id: "proj-main:GITHUB_TOKEN", workspaceId: "ws_fern", on: true })).status, 200);
  assert.ok(state.workspaces[1].loginsOn["key:proj-main:GITHUB_TOKEN"]);
  bot("juno").keys = ["GITHUB_TOKEN"];
  assert.equal((await patch({ kind: "key", id: "proj-main:GITHUB_TOKEN", workspaceId: "ws_fern", on: false })).status, 200);
  assert.equal(bot("juno").keys, undefined, "off: Juno loses its name");
  assert.equal((await patch({ kind: "key", id: "proj-main:NOPE", workspaceId: "ws_fern", on: true })).status, 404);
  assert.equal((await patch({ kind: "key", id: "proj-main:GITHUB_TOKEN", workspaceId: "ws_main", on: false })).status, 409, "a workspace's own key is always on there");
  const r = await patch({ kind: "app", id: "ca_gmail", workspaceId: "ws_main", on: false });
  assert.ok(!DASHES.test((await r.json()).error), "no dashes");
});

/* ---------------- Saved site logins on a member's or a stranger's thread ---------------- */

await check("whose thread it is: a stranger's (fromOutside, or a part of one) or a member's (started, told something, or a part of one)", () => {
  state = fresh();
  const out = (id) => T.outsideThread(find(id), find);
  const mem = (id) => T.memberThread(find(id), find);
  assert.deepEqual(["ses_mine", "ses_out", "ses_out_part", "ses_dee", "ses_told", "ses_dee_part"].map(out), [false, true, true, false, false, false]);
  assert.deepEqual(["ses_mine", "ses_out", "ses_out_part", "ses_dee", "ses_told", "ses_dee_part"].map(mem), [false, false, false, true, true, true]);
  assert.deepEqual(["ses_dee", "ses_told", "ses_dee_part"].map((id) => T.memberOf(find(id), find)?.name), ["Dee", "Dee", "Dee"]);
  assert.equal(T.othersThread(find("ses_dee"), find), true, "still someone else's work for the CRM and memory");
});

await check("a stranger's thread gets none of the owner's saved logins: it waits for them to sign in", async () => {
  state = fresh();
  signIns.length = 0;
  for (const id of ["ses_out", "ses_out_part"]) {
    const said = await V.vaultSignIn("juno", T.DISPLAYS[0], id);
    assert.match(said, /^Ava's saved logins are only for the people Ava works with, and someone outside Bops asked for this task/);
    assert.ok(!DASHES.test(said), "no dashes");
    assert.equal(find(id).blocker, "sign_in");
  }
  assert.deepEqual(signIns, [], "nothing typed");
});

await check("a member's thread signs in with a saved login its bot has that signs in by itself; one that asks first waits for the owner's card", async () => {
  state = fresh();
  signIns.length = 0;
  pages = [{ id: "tab1", url: "https://x.com/login" }];
  // (Each on a screen of its own: one page gets two tries at most, so a wrong password never loops.)
  for (const [i, id] of ["ses_dee", "ses_told", "ses_dee_part"].entries()) {
    const said = await V.vaultSignIn("juno", T.DISPLAYS[i], id);
    assert.equal(said, "Signed in to x.com with Ava's saved login. Look at the screen and carry on.", id);
  }
  assert.equal(signIns.length, 3, "typed from the Keychain, never seen by the bot");
  assert.deepEqual(signIns[0].values, ["identifier", "password"]);
  // LinkedIn asks first: only Ava's tap signs Juno in with it.
  pages = [{ id: "tab2", url: "https://www.linkedin.com/login" }];
  const said = await V.vaultSignIn("juno", T.DISPLAYS[0], "ses_dee");
  assert.equal(said, "Ava's saved linkedin.com login is set to ask first, so only Ava can sign you in with it. Stop and say in one sentence that you need to sign in: a card lets Ava sign you in with one tap.");
  assert.ok(!DASHES.test(said));
  assert.equal(signIns.length, 3, "nothing more typed");
  // A login Rex wasn't given, on Rex's member thread: none.
  state.sessions.push({ id: "ses_rex", botId: "rex", status: "running", member: DEE, replies: [] });
  assert.match(await V.vaultSignIn("rex", T.DISPLAYS[0], "ses_rex"), /^No login saved in Ava's Logins fits a page/);
  pages = [{ id: "tab1", url: "https://x.com/login" }];
});

console.log(`logins: ${passed} passed, ${failures} failed`);
process.exit(failures ? 1 : 0);
