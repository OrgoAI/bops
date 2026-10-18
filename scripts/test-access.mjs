// Tests for who may use what (lib/types.ts levelOf, lib/server/composio.ts, lib/server/access-sync.ts): every bot
// has Read & act in every account of its workspace by default (not another workspace's), the user's own choice
// for a bot wins (read, act, or none), and a channel app (Bops' Slack app) has no default; a bot's Composio session holds the apps it has by default, read
// only where it was set so, and nothing it may not use; a task someone outside Bops started gets no apps; each
// workspace's whole set goes to its Orgo project as the PUT orgo-web takes, a use goes to the log, and an Orgo
// without the routes (404) is left alone.
//
// The store, Bops Cloud, the vault's keys, Orgo and Composio are fakes: nothing reaches a real service.
// Usage: node --conditions=react-server scripts/test-access.mjs
import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { registerHooks } from "node:module";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { pathToFileURL } from "node:url";

for (const k of Object.keys(process.env)) if (/^(BOPS|COMPOSIO|ORGO)_/.test(k)) delete process.env[k];
process.env.COMPOSIO_API_KEY = "test-composio";
const root = new URL("..", import.meta.url).pathname.replace(/\/$/, "");
const scratch = mkdtempSync(join(tmpdir(), "bops-test-access-"));

const forward = (mod, names) => names.map((n) => `export const ${n} = (...a) => globalThis.__fake[${JSON.stringify(mod)}].${n}(...a);`).join("\n");
const FAKES = {
  store: forward("store", ["addMessage", "bot", "getState", "id", "installId", "ownerName", "session", "update", "stateReady", "userDir", "watchChanges"]),
  orgo: forward("orgo", ["apiKey", "callOrgo"]),
  keys: forward("keys", ["listKeys", "keysOf"]),
  cloud: forward("cloud", ["cloudOn", "cloudProxy", "cloudSession", "cloudSessionNow", "cloudUrl"]),
  analytics: "export const trackServerEvent = () => {};",
  "app-version": "export const appHeaders = () => ({}); export const orgoHeaders = () => ({});",
  judgment: "export const lowRisk = async () => false; export const movesMoney = async () => false;",
  treg: "export const DATA_TOOL_NAMES = new Set(); export const dataOn = () => false; export const foundByBots = () => false; export const runDataTool = async () => '';",
};
const COMPOSIO = `export class Composio { constructor(o) { globalThis.__fake.composio.made(o); return globalThis.__fake.composio.client; } }`;
registerHooks({
  resolve(specifier, context, next) {
    if (specifier === "@composio/core") return { url: "fake:composio", shortCircuit: true };
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
    if (url === "fake:composio") return { format: "module", shortCircuit: true, source: COMPOSIO };
    const name = url.match(/\/lib\/server\/([a-z-]+)\.ts$/)?.[1];
    if (!name || !FAKES[name]) return next(url, context);
    return { format: "module", shortCircuit: true, source: FAKES[name] };
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
    console.error(`FAIL ${name}\n  ${e.message.split("\n").join("\n  ")}`);
  }
}

const PID = "11111111-2222-4333-8444-555555555555";
const state = {
  owner: { name: "Sam" },
  workspace: "ws_main",
  workspaces: [
    { id: "ws_main", name: "Main", createdAt: 0, orgoProjectId: PID },
    { id: "ws_local", name: "Local", createdAt: 0 },
  ],
  bots: [
    { id: "boppy", name: "Boppy", isMain: true, keys: ["STRIPE_SECRET_KEY"] },
    { id: "iris", name: "Iris", access: { ca_notion: "read", ca_hubspot: "none" } },
    { id: "lo", name: "Lo", workspaceId: "ws_local" },
  ],
  accounts: [
    { id: "ca_gmail", app: "gmail", appName: "Gmail", name: "sam@acme.com", status: "active", at: 1 },
    { id: "ca_notion", app: "notion", appName: "Notion", label: "Work", status: "active", at: 1 },
    { id: "ca_hubspot", app: "hubspot", appName: "HubSpot", status: "active", at: 1 },
    { id: "ca_old", app: "linear", appName: "Linear", status: "expired", at: 1 },
    { id: "ca_slack", app: "slackbot", appName: "Slack", name: "Acme", status: "active", at: 1 },
    { id: "ca_lo", app: "gmail", appName: "Gmail", name: "lo@acme.com", status: "active", at: 1, workspaceId: "ws_local" },
  ],
  vault: [{ id: "vl_x", site: "x.com", username: "sam", hasPassword: true, hasTotp: false, bots: ["iris"], auto: false, addedAt: 1 }],
  sessions: [
    { id: "ses_out", botId: "iris", fromOutside: true },
    { id: "ses_mine", botId: "iris" },
    { id: "ses_routine", botId: "iris", routineId: "rt_1" },
  ],
  messages: [],
};

const created = [];
const executed = [];
const calls = [];
let orgoAnswer = (method) => ({ status: method === "PUT" ? 200 : 201, json: {} });
globalThis.__fake = {
  store: {
    bot: (id) => state.bots.find((b) => b.id === id),
    getState: () => state,
    session: (id) => state.sessions.find((s) => s.id === id),
    update: (fn) => fn(state),
    addMessage: (m) => (state.messages.push(m), m),
    id: (p) => `${p}_1`,
    installId: () => "test",
    ownerName: () => "Sam",
    stateReady: () => true,
    userDir: () => scratch,
    watchChanges: () => {},
  },
  orgo: {
    apiKey: async () => "sk_test",
    callOrgo: async (key, path, o) => {
      calls.push({ path, method: o.method, body: JSON.parse(JSON.stringify(o.body)) });
      return orgoAnswer(o.method, path);
    },
  },
  keys: { listKeys: async () => [{ name: "OPENAI_API_KEY", workspaceId: null }], keysOf: (all) => all },
  cloud: { cloudOn: () => false, cloudProxy: () => null, cloudSession: async () => null, cloudSessionNow: () => null, cloudUrl: () => "" },
  composio: {
    made: () => {},
    client: {
      sessions: {
        create: async (user, cfg) => (created.push(cfg), { sessionId: `s${created.length}`, search: async () => ({ results: [] }) }),
        use: async () => null,
      },
      tools: {
        getRawComposioToolBySlug: async (slug) => ({ tags: slug.includes("FETCH") ? ["readOnlyHint"] : [], name: slug, toolkit: { slug: slug.split("_")[0].toLowerCase() } }),
        execute: async (slug, o) => (executed.push({ slug, account: o.connectedAccountId }), { data: { ok: true }, successful: true }),
      },
    },
  },
};

const T = await import(`${root}/lib/types.ts`);
const C = await import(`${root}/lib/server/composio.ts`);
const A = await import(`${root}/lib/server/access-sync.ts`);
const bot = (id) => state.bots.find((b) => b.id === id);
const account = (id) => state.accounts.find((a) => a.id === id);

await check("every bot reads and acts everywhere by default; the user's choice wins; a channel app has no default", () => {
  assert.equal(T.levelOf(bot("boppy"), account("ca_gmail")), "act", "the default");
  assert.equal(T.levelOf({ id: "new" }, account("ca_gmail")), "act", "a bot made later too");
  assert.equal(T.levelOf(bot("lo"), account("ca_gmail")), null, "not a bot of another workspace");
  assert.equal(T.levelOf(bot("lo"), account("ca_lo")), "act", "its own workspace's");
  assert.equal(T.levelOf(bot("boppy"), account("ca_lo")), null);
  assert.equal(T.levelOf(bot("iris"), account("ca_notion")), "read");
  assert.equal(T.levelOf(bot("iris"), account("ca_hubspot")), null, "none is no access");
  assert.equal(T.levelOf(bot("boppy"), account("ca_slack")), null, "Bops' Slack app only when given");
  assert.equal(T.levelOf({ access: { ca_slack: "act" } }, account("ca_slack")), "act");
  assert.equal(T.accessIsDefault(bot("iris"), account("ca_gmail")), true);
  assert.equal(T.accessIsDefault(bot("iris"), account("ca_hubspot")), false);
  assert.deepEqual(
    C.accountsOf(bot("iris")).map((x) => [x.account.id, x.level]),
    [
      ["ca_gmail", "act"],
      ["ca_notion", "read"],
    ],
    "working accounts only",
  );
});

await check("a bot's Composio session holds the apps it has by default, read only where set, nothing it may not use", async () => {
  await C.findAppActions("iris", "find emails");
  const cfg = created.at(-1);
  assert.deepEqual(cfg.toolkits, { enable: ["gmail", "notion"] });
  assert.deepEqual(cfg.tools, { gmail: { tags: { disable: ["destructiveHint"] } }, notion: { tags: ["readOnlyHint"] } });
  assert.deepEqual(cfg.connectedAccounts, { gmail: ["ca_gmail"], notion: ["ca_notion"] });
  assert.match(C.appList(bot("iris")), /^Gmail \(sam@acme\.com: read & act\), Notion \(Work: read only\)$/);
});

await check("a task someone outside Bops started gets no apps", async () => {
  const n = created.length;
  assert.match(await C.findAppActions("iris", "find emails", { sessionId: "ses_out" }), /^Not on this task: someone outside Bops started it/);
  assert.match(await C.runAppAction("iris", "GMAIL_FETCH_EMAILS", {}, { sessionId: "ses_out" }), /^Not on this task/);
  assert.equal(created.length, n);
  assert.ok(!executed.length, "nothing ran");
});

await check("the set orgo-web takes: every bot of the workspace times every account, key and login", () => {
  const rows = A.accessPayload("ws_main", ["OPENAI_API_KEY"]);
  const find = (b, target) => rows.find((r) => r.bot === b && r.target === target);
  assert.deepEqual(find("iris", "ca_gmail"), { bot: "iris", botName: "Iris", kind: "app", target: "ca_gmail", targetName: "Gmail, sam@acme.com", level: "act", isDefault: true });
  assert.deepEqual([find("iris", "ca_notion").level, find("iris", "ca_notion").isDefault, find("iris", "ca_notion").targetName], ["read", false, "Notion, Work"]);
  assert.deepEqual([find("iris", "ca_hubspot").level, find("iris", "ca_hubspot").isDefault], ["none", false]);
  assert.deepEqual([find("boppy", "ca_slack").level, find("boppy", "ca_slack").isDefault], ["none", true]);
  assert.deepEqual([find("boppy", "STRIPE_SECRET_KEY").level, find("boppy", "STRIPE_SECRET_KEY").isDefault, find("iris", "STRIPE_SECRET_KEY").level], ["act", false, "none"]);
  assert.deepEqual([find("boppy", "OPENAI_API_KEY").level, find("boppy", "OPENAI_API_KEY").isDefault], ["none", true], "a vault key no bot has");
  assert.deepEqual([find("iris", "vl_x").kind, find("iris", "vl_x").level, find("boppy", "vl_x").level, find("iris", "vl_x").targetName], ["login", "act", "none", "x.com, sam"]);
  assert.ok(!rows.some((r) => r.bot === "lo"), "only this workspace's bots");
  assert.ok(!rows.some((r) => r.target === "ca_lo"), "not another workspace's accounts");
  assert.equal(rows.length, 2 * (5 + 2 + 1));
});

await check("a use fits orgo-web's limits: long text is cut, never to half an emoji, and an action is never empty", () => {
  const u = A.usePayload({ bot: "iris", kind: "key", target: "K".repeat(300), targetName: "\u{1F600}".repeat(150), action: "", via: "thread", viaId: "s".repeat(200), outcome: "refused", at: 1 });
  assert.deepEqual([u.target.length, u.targetName.length, u.viaId.length, u.action], [256, 200, 128, "unknown"]);
  assert.ok(!/[\uD800-\uDBFF]$/.test(u.targetName), "no half an emoji at the end");
});

await check("a change goes to Orgo as one PUT of the whole set; a use goes to the log", async () => {
  A.accessSyncForTests.reset();
  calls.length = 0;
  A.accessSyncForTests.look();
  assert.equal(await C.runAppAction("iris", "GMAIL_FETCH_EMAILS", {}, { sessionId: "ses_routine" }), '{"ok":true}');
  await A.accessSyncForTests.flushAll();
  const put = calls.find((c) => c.method === "PUT");
  assert.equal(put.path, `/api/projects/${PID}/access`);
  assert.deepEqual(put.body.grants, A.accessPayload("ws_main", ["OPENAI_API_KEY"]));
  const log = calls.find((c) => c.method === "POST");
  assert.equal(log.path, `/api/projects/${PID}/access/log`);
  assert.deepEqual({ ...log.body.entries[0], at: undefined }, { bot: "iris", kind: "app", target: "ca_gmail", targetName: "Gmail, sam@acme.com", action: "GMAIL_FETCH_EMAILS", via: "routine", viaId: "rt_1", outcome: "ok", at: undefined });
  assert.ok(!Number.isNaN(Date.parse(log.body.entries[0].at)));
  assert.deepEqual(Object.keys(A.lastUses(new Set(["iris"]))), ["ca_gmail"]);
  assert.deepEqual(A.lastUses(new Set(["boppy"])), {}, "by this workspace's bots only");
  // Nothing changed: nothing more goes.
  calls.length = 0;
  A.accessSyncForTests.look();
  await A.accessSyncForTests.flushAll();
  assert.equal(calls.length, 0);
});

await check("a write waits for the user: logged as waiting, then as the user's yes", async () => {
  A.accessSyncForTests.reset();
  calls.length = 0;
  let decided;
  const said = await C.runAppAction("boppy", "GMAIL_SEND_EMAIL", { to: "a@b.c" }, { chatId: "bot:boppy", via: "call" }, (a) => (decided = a));
  assert.match(said, /needs Sam's approval first/);
  const ask = state.appApprovals.at(-1);
  assert.deepEqual(Object.keys(ask).sort(), ["action", "app", "at", "botId", "chatId", "detail", "id", "title"], "the approval keeps only its chat");
  C.answerApp(ask.id, true);
  assert.equal(await decided, '{"ok":true}');
  await A.accessSyncForTests.flushAll();
  const entries = calls.filter((c) => c.method === "POST").flatMap((c) => c.body.entries);
  assert.deepEqual(
    entries.map((e) => [e.action, e.via, e.outcome, e.approvedBy]),
    [
      ["GMAIL_SEND_EMAIL", "call", "waiting", undefined],
      ["GMAIL_SEND_EMAIL", "call", "ok", "user"],
    ],
  );
});

await check("an Orgo without the routes is left alone", async () => {
  A.accessSyncForTests.reset();
  calls.length = 0;
  orgoAnswer = () => ({ status: 404, json: {} });
  A.accessSyncForTests.look();
  await A.accessSyncForTests.flushAll();
  assert.equal(calls.length, 1);
  bot("boppy").access = { ca_gmail: "read" };
  A.accessSyncForTests.look();
  await C.runAppAction("iris", "GMAIL_FETCH_EMAILS", {}, { sessionId: "ses_mine" });
  await A.accessSyncForTests.flushAll();
  assert.equal(calls.length, 1, "not asked again for 6 hours");
  orgoAnswer = (method) => ({ status: method === "PUT" ? 200 : 201, json: {} });
});

await check("the use log on this Mac keeps the last uses", async () => {
  await new Promise((r) => setTimeout(r, 1200));
  const kept = JSON.parse(readFileSync(join(scratch, "access-log.json"), "utf8")).uses;
  assert.ok(kept.length >= 3);
  assert.deepEqual(Object.keys(kept.at(-1)).sort(), ["action", "at", "bot", "kind", "outcome", "target", "targetName", "via", "viaId"]);
  assert.deepEqual([kept.at(-1).via, kept.at(-1).viaId], ["thread", "ses_mine"]);
});

rmSync(scratch, { recursive: true, force: true });
console.log(`access: ${passed} passed, ${failures} failed`);
process.exit(failures ? 1 : 0);
