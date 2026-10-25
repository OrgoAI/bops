// Tests for who may use what (lib/types.ts levelOf, lib/server/composio.ts, lib/server/access-sync.ts): every bot
// has Read & act in every account of its workspace by default (not another workspace's), the user's own choice
// for a bot wins (read, act, or none), and a channel app (Bops' Slack app) has no default; a bot's Composio session holds the apps it has by default, read
// only where it was set so, and nothing it may not use; a task someone outside Bops started gets no apps; a write
// asks the user (the run pauses for it: lib/server/permission.ts) unless the bot's rules allow it, and Always allow
// saves such a rule; only the user replies, never a bot's computer; each
// workspace's whole set goes to its Orgo project as the PUT orgo-web takes, a use goes to the log, and an Orgo
// without the routes (404) is left alone; a use Orgo didn't take waits in an outbox on disk (written at once
// as Bops quits) and goes after a restart, once, with its entry's id each time (clientId). After an upgrade from v0.0.28 every bot has exactly what it had
// there in an account from before (only where it was given it), while one connected from now on is every bot's.
//
// The store, Bops Cloud, the vault's keys, Orgo and Composio are fakes: nothing reaches a real service.
// Usage: node --conditions=react-server scripts/test-access.mjs
import assert from "node:assert/strict";
import { existsSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { registerHooks } from "node:module";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { pathToFileURL } from "node:url";
import { fill } from "./fake-exports.mjs";

for (const k of Object.keys(process.env)) if (/^(BOPS|COMPOSIO|ORGO)_/.test(k)) delete process.env[k];
process.env.COMPOSIO_API_KEY = "test-composio";
const root = new URL("..", import.meta.url).pathname.replace(/\/$/, "");
const scratch = mkdtempSync(join(tmpdir(), "bops-test-access-"));

const forward = (mod, names) => names.map((n) => `export const ${n} = (...a) => globalThis.__fake[${JSON.stringify(mod)}].${n}(...a);`).join("\n");
const FAKES = {
  store: forward("store", ["addMessage", "bot", "getState", "id", "installId", "ownerName", "ownSession", "pullState", "session", "stateDevice", "stateEpoch", "statePulledAt", "update", "stateReady", "userDir", "watchArrivals", "watchChanges", "watchLoads"]),
  orgo: forward("orgo", ["apiKey", "callOrgo"]),
  keys: forward("keys", ["listKeys", "keysOf"]),
  cloud: forward("cloud", ["cloudOn", "cloudProxy", "cloudSession", "cloudSessionNow", "cloudUrl"]),
  analytics: "export const trackServerEvent = () => {};",
  "app-version": "export const appHeaders = () => ({}); export const orgoHeaders = () => ({});",
  judgment: "export const lowRisk = async () => false; export const movesMoney = async () => false;",
  treg: "export const DATA_TOOL_NAMES = new Set(); export const dataOn = () => false; export const foundByBots = () => false; export const runDataTool = async () => '';",
  "routine-suggestions": ["offerStarters", "makeCheck", "dropChecks"].map((n) => `export const ${n} = (...a) => globalThis.__fake.suggest(${JSON.stringify(n)}, ...a);`).join("\n"),
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
    { id: "ca_gmail", app: "gmail", appName: "Gmail", name: "sam@acme.com", status: "active", at: 1, workspaceId: "ws_main" },
    { id: "ca_notion", app: "notion", appName: "Notion", label: "Work", status: "active", at: 1, workspaceId: "ws_main" },
    { id: "ca_hubspot", app: "hubspot", appName: "HubSpot", status: "active", at: 1, workspaceId: "ws_main" },
    { id: "ca_old", app: "linear", appName: "Linear", status: "expired", at: 1, workspaceId: "ws_main" },
    { id: "ca_slack", app: "slackbot", appName: "Slack", name: "Acme", status: "active", at: 1, workspaceId: "ws_main" },
    { id: "ca_lo", app: "gmail", appName: "Gmail", name: "lo@acme.com", status: "active", at: 1, workspaceId: "ws_local" },
  ],
  vault: [{ id: "vl_x", site: "x.com", username: "sam", hasPassword: true, hasTotp: false, bots: ["iris"], auto: false, addedAt: 1 }],
  sessions: [
    { id: "ses_out", botId: "iris", fromOutside: true },
    { id: "ses_mine", botId: "iris" },
    { id: "ses_routine", botId: "iris", routineId: "rt_1" },
  ],
  messages: [],
  routines: [],
};

let asks = 0;
const arrivals = new Map();
const created = [];
const executed = [];
const calls = [];
// What composio.ts asked routine-suggestions.ts for, in order: starters offered, checks made, checks dropped.
const suggested = [];
let orgoAnswer = (method) => ({ status: method === "PUT" ? 200 : 201, json: {} });
globalThis.__fake = {
  suggest: (fn, ...a) => {
    // A check is asked for once its account is there, with the access picked given: it says what it saw.
    const seen = fn === "makeCheck" ? { account: !!state.accounts.find((x) => x.id === a[0]), level: a[1].bots.map((id) => T.levelOf(state.bots.find((b) => b.id === id), state.accounts.find((x) => x.id === a[0]) ?? {})) } : undefined;
    suggested.push({ fn, args: JSON.parse(JSON.stringify(a)), ...(seen ? { seen } : {}) });
    return fn === "makeCheck" ? {} : undefined;
  },
  store: {
    bot: (id) => state.bots.find((b) => b.id === id),
    getState: () => state,
    session: (id) => state.sessions.find((s) => s.id === id),
    update: (fn) => fn(state),
    addMessage: (m) => (state.messages.push(m), m),
    id: (p) => (p === "apr" ? `apr_${++asks}` : `${p}_1`),
    installId: () => "test",
    ownerName: () => "Sam",
    stateReady: () => true,
    userDir: () => scratch,
    watchChanges: () => {},
    // What runs once changes from elsewhere came in (another Bops's, merged in): arrive() stands in for that.
    watchArrivals: (name, fn) => void arrivals.set(name, fn),
    // No state loads whole in these tests (a sign-in, a restart): nothing to run.
    watchLoads: () => {},
    pullState: async () => {},
    stateEpoch: () => 1,
    statePulledAt: () => 0,
    // This Bops's device: the Mac's, or a computer's runner's (as it records its routines' runs and its asks).
    stateDevice: () => (process.env.BOPS_RUNNER === "1" ? "dev_runner" : "dev_mac"),
    ownSession: (s) => (s.by ? s.by === globalThis.__fake.store.stateDevice() : process.env.BOPS_RUNNER !== "1"),
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
const P = await import(`${root}/lib/server/permission.ts`);
const R = await import(`${root}/lib/permission.ts`);
const A = await import(`${root}/lib/server/access-sync.ts`);
const O = await import(`${root}/lib/server/sync-outbox.ts`);
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
  assert.match(log.body.entries[0].clientId, /^[0-9a-f]{16}$/, "its outbox entry's id, so orgo-web can keep one row for it");
  assert.deepEqual({ ...log.body.entries[0], at: undefined, clientId: undefined }, { bot: "iris", kind: "app", target: "ca_gmail", targetName: "Gmail, sam@acme.com", action: "GMAIL_FETCH_EMAILS", via: "routine", viaId: "rt_1", outcome: "ok", at: undefined, clientId: undefined });
  assert.ok(!Number.isNaN(Date.parse(log.body.entries[0].at)));
  assert.deepEqual(Object.keys(A.lastUses(new Set(["iris"]))), ["ca_gmail"]);
  assert.deepEqual(A.lastUses(new Set(["boppy"])), {}, "by this workspace's bots only");
  // Nothing changed: nothing more goes.
  calls.length = 0;
  A.accessSyncForTests.look();
  await A.accessSyncForTests.flushAll();
  assert.equal(calls.length, 0);
});

await check("a write asks the user: logged as waiting, the run told to pause (NeedsOk, with exactly what and to whom), and done on their yes, logged as the user's", async () => {
  A.accessSyncForTests.reset();
  calls.length = 0;
  const ran = executed.length;
  const asked = await C.runAppAction("boppy", "GMAIL_SEND_EMAIL", { to: "a@b.c", subject: "Hi" }, { chatId: "bot:boppy", via: "call" }).then(
    () => null,
    (e) => e,
  );
  assert.ok(asked instanceof P.NeedsOk, "the engine running it pauses there");
  assert.deepEqual(asked.ask, { action: "GMAIL_SEND_EMAIL in Gmail (sam@acme.com)", resources: ["a@b.c"], preview: "to: a@b.c\nsubject: Hi", kind: "app" });
  assert.equal(executed.length, ran, "nothing done");
  assert.deepEqual(state.appApprovals ?? [], [], "the tool opens no request itself: the engine does, with what resumes its run");
  // Its run carries on from the user's yes: the same call, approved.
  assert.equal(await C.runAppAction("boppy", "GMAIL_SEND_EMAIL", { to: "a@b.c", subject: "Hi" }, { chatId: "bot:boppy", via: "call" }, null, { approved: true }), '{"ok":true}');
  assert.equal(executed.length, ran + 1, "done once");
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

await check("Always allow is a rule for that bot and that action, whoever it's for, as the card says: that action then goes without asking to anyone (said in the chat), and the bot's other requests for it are answered; another action, or another bot, still asks; the last rule for an action wins; one saved before for one recipient covers that action for anyone", async () => {
  const ran = executed.length;
  const SEND = "GMAIL_SEND_EMAIL in Gmail (sam@acme.com)";
  const needs = (botId, args, slug = "GMAIL_SEND_EMAIL") =>
    C.runAppAction(botId, slug, args, { chatId: `bot:${botId}` }).then(
      () => false,
      (e) => e instanceof P.NeedsOk,
    );
  const asked = await C.runAppAction("boppy", "GMAIL_SEND_EMAIL", { to: "dana@acme.example" }, { chatId: "bot:boppy" }).then(
    () => null,
    (e) => e,
  );
  assert.ok(asked instanceof P.NeedsOk, "no rule: it asks");
  // The card says what Always allow covers: this bot and this action, whoever it's for.
  assert.equal(R.alwaysScope("Boppy", asked.ask), `Always allow Boppy to ${SEND}, whoever it's for and whatever it says.`);
  const request = (id, botId, action, to) => ({ id, botId, chatId: `bot:${botId}`, askedBy: "dev_mac_b", action, resources: [to], preview: `to: ${to}`, at: 1, resume: { engine: "chat", responseId: "r", callId: "c", call: { name: "use_app", arguments: "{}" }, outputs: [] } });
  // Dana's, and others waiting meanwhile: the same action to Max, another action, the same action from Iris.
  state.appApprovals = [
    request("apr_dana", "boppy", SEND, "dana@acme.example"),
    request("apr_max", "boppy", SEND, "max@acme.example"),
    request("apr_draft", "boppy", "GMAIL_CREATE_DRAFT in Gmail (sam@acme.com)", "max@acme.example"),
    request("apr_iris", "iris", SEND, "dana@acme.example"),
  ];
  // The owner's Always allow on Dana's (permission.ts replyToAsk), from their Mac.
  assert.equal(P.replyToAsk("apr_dana", "always"), undefined);
  assert.deepEqual(state.bots.find((b) => b.id === "boppy").permissions, [{ action: SEND, resource: "*", effect: "allow" }], "one rule for that action, for anyone");
  assert.deepEqual(
    state.appApprovals.map((a) => [a.id, a.reply?.reply]),
    [
      ["apr_dana", "always"],
      ["apr_max", "always"],
      ["apr_draft", undefined],
      ["apr_iris", undefined],
    ],
    "Boppy's other request for that action answered; another action's and Iris's still wait",
  );
  assert.equal(P.replyToAsk("apr_dana", "once"), "That isn't waiting on you anymore.", "never answered twice");
  const before = state.messages.length;
  assert.equal(await C.runAppAction("boppy", "GMAIL_SEND_EMAIL", { to: "eve@other.example", cc: ["sam.o@other.example"], subject: "Hi" }, { chatId: "bot:boppy" }), '{"ok":true}', "that action to anyone else: no ask");
  assert.equal(executed.length, ran + 1);
  assert.match(state.messages.slice(before).at(-1).text, /you always allow it, so didn't ask/);
  assert.equal(await needs("boppy", { to: "dana@acme.example" }, "GMAIL_CREATE_DRAFT"), true, "another action still asks");
  assert.equal(await needs("iris", { to: "dana@acme.example" }), true, "another bot still asks");
  // A later rule that asks for that action wins over the allow.
  state.bots.find((b) => b.id === "boppy").permissions.push({ action: SEND, effect: "ask" });
  assert.equal(await needs("boppy", { to: "dana@acme.example" }), true, "the last rule for an action wins");
  // Saved before, for one recipient: a rule for that action now. A pattern is no rule for anything but itself.
  state.bots.find((b) => b.id === "boppy").permissions = [{ action: SEND, resource: "dana@acme.example", effect: "allow" }];
  assert.equal(await needs("boppy", { to: "eve@other.example" }), false, "one saved for Dana covers that action for anyone");
  state.bots.find((b) => b.id === "boppy").permissions = [{ action: "GMAIL_*", resource: "*", effect: "allow" }];
  assert.equal(await needs("boppy", { to: "dana@acme.example" }), true, "no wildcards");
  delete state.bots.find((b) => b.id === "boppy").permissions;
  state.appApprovals = [];
});

await check("a request shows who and what its inputs name, as best Bops can tell, for the user to read: whatever the input is called, nested anywhere, all of them", () => {
  assert.deepEqual(C.resourcesOf({ recipient_email: "ava@acme.example", subject: "Hi", body: "Write to max@acme.example if you need me" }), ["ava@acme.example"], "an address in the text reaches no one");
  assert.deepEqual(C.resourcesOf({ recipient_email: "ava@acme.example", extra_recipients: ["eve@evil.example"] }), ["ava@acme.example", "eve@evil.example"], "Gmail's extra recipients");
  assert.deepEqual(C.resourcesOf({ to_email: "ava@acme.example", cc_emails: ["eve@evil.example"], bcc_emails: ["dana@acme.example"] }), ["ava@acme.example", "eve@evil.example", "dana@acme.example"], "Outlook's cc and bcc");
  assert.deepEqual(C.resourcesOf({ invitees: [{ email: "Max@acme.example", name: "Max" }], user_ids: ["U1", "U2"], participants: ["U3"], guests: "sam@acme.example; Dana <dana@acme.example>" }), ["max@acme.example", "u1", "u2", "u3", "sam@acme.example", "dana@acme.example"]);
  assert.deepEqual(C.resourcesOf({ message: { toRecipients: [{ emailAddress: { address: "eve@evil.example" } }] } }), ["eve@evil.example"], "one nested anywhere");
  assert.deepEqual(C.resourcesOf({ phone_number_id: "pn-1", to_number: "+15551230001", text: "Hi" }), ["+15551230001"], "the number someone is texted at");
  assert.deepEqual(C.resourcesOf({ participant_id: "111", text: "Hi" }), ["111"], "a participant's id");
  assert.equal(C.resourcesOf({ to: Array.from({ length: 12 }, (_, i) => `p${i}@acme.example`) }).length, 12, "however many");
});

await check("on a computer's runner an action goes as on the Mac: the bot's rule covers it there too, and on the user's yes it's made with the runner's own credential only, nothing of their answer sent to Bops Cloud", async () => {
  const cloud = globalThis.__fake.cloud;
  const was = { ...cloud };
  const made = [];
  const realMade = globalThis.__fake.composio.made;
  globalThis.__fake.composio.made = (o) => made.push(o);
  Object.assign(cloud, { cloudOn: () => true, cloudProxy: () => ({ url: "https://cloud.test/proxy/composio", key: "orgo_vm_x" }), cloudSessionNow: () => ({ composio: { userId: "bops-u1" } }) });
  process.env.BOPS_RUNNER = "1";
  try {
    const ran = executed.length;
    state.bots.find((b) => b.id === "boppy").permissions = [{ action: "GMAIL_SEND_EMAIL in Gmail (sam@acme.com)", resource: "*", effect: "allow" }];
    assert.equal(await C.runAppAction("boppy", "GMAIL_SEND_EMAIL", { to: "dana@acme.example" }, { sessionId: "ses_mine" }), '{"ok":true}', "the rule");
    delete state.bots.find((b) => b.id === "boppy").permissions;
    // An empty file input in the call the user said yes to: it goes as it is (Composio drops it before sending).
    assert.equal(await C.runAppAction("boppy", "GMAIL_SEND_EMAIL", { to: "dana@acme.example", attachment: "" }, { sessionId: "ses_mine" }, null, { approved: true }), '{"ok":true}', "their yes");
    assert.equal(executed.length, ran + 2);
    assert.ok(made.every((o) => !Object.keys(o.defaultHeaders ?? {}).some((h) => /^x-bops-ok$/i.test(h))), "no answer named to Bops Cloud");
  } finally {
    globalThis.__fake.composio.made = realMade;
    Object.assign(cloud, was);
    delete process.env.BOPS_RUNNER;
    delete state.bots.find((b) => b.id === "boppy").permissions;
  }
});

await check("only the user replies, from a Bops of their own: a bot's computer can't (it writes no reply), nor anyone for a request that isn't waiting", async () => {
  state.appApprovals = [{ id: "apr_run", botId: "iris", threadId: "ses_routine", askedBy: "dev_runner", action: "GMAIL_SEND_EMAIL in Gmail (sam@acme.com)", resources: ["dana@acme.example"], preview: "to: dana@acme.example", at: 1, resume: { engine: "responses", responseId: "resp_1", callId: "call_1", call: { name: "use_app", arguments: "{}" } } }];
  process.env.BOPS_RUNNER = "1";
  try {
    assert.equal(P.replyToAsk("apr_run", "once"), "A bot's computer can't answer for you.");
    assert.equal(P.replyToAsk("apr_run", "always"), "A bot's computer can't answer for you.");
    assert.equal(state.appApprovals[0].reply, undefined, "still waiting on the owner");
  } finally {
    delete process.env.BOPS_RUNNER;
  }
  assert.equal(P.replyToAsk("apr_none", "once"), "That isn't waiting on you anymore.");
  state.appApprovals = [];
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

await check("on the way out the outbox is written at once, not half a second later (persist.ts onExit)", async () => {
  A.accessSyncForTests.reset();
  O.outboxForTests.restart();
  const file = join(scratch, "outbox", "access-uses.json");
  rmSync(file, { force: true });
  orgoAnswer = () => null;
  await C.runAppAction("iris", "GMAIL_FETCH_EMAILS", {}, { sessionId: "ses_exit" });
  assert.equal(existsSync(file), false, "not written yet: it's due in half a second");
  await globalThis.__bopsExitWork.get("outbox:access-uses")();
  assert.deepEqual(JSON.parse(readFileSync(file, "utf8")).entries.map((e) => e.item.viaId), ["ses_exit"], "written as Bops goes");
  await A.accessSyncForTests.flushAll();
  A.accessSyncForTests.reset();
  O.outboxForTests.restart();
  rmSync(file, { force: true });
});

await check("a use Orgo didn't take waits in an outbox on disk: after a quit and a start it goes, once", async () => {
  A.accessSyncForTests.reset();
  calls.length = 0;
  // Orgo away.
  orgoAnswer = () => null;
  await C.runAppAction("iris", "GMAIL_FETCH_EMAILS", {}, { sessionId: "ses_outbox" });
  await A.accessSyncForTests.flushAll();
  assert.ok(calls.some((c) => c.method === "POST"), "tried");
  O.outboxForTests.writeAll();
  const file = join(scratch, "outbox", "access-uses.json");
  const kept = JSON.parse(readFileSync(file, "utf8")).entries;
  assert.deepEqual(kept.map((e) => [e.wsId, e.item.viaId]), [["ws_main", "ses_outbox"]], "kept on disk with its workspace");
  // Bops quits (what's in memory is gone) and starts again, with Orgo back.
  A.accessSyncForTests.reset();
  O.outboxForTests.restart();
  orgoAnswer = (method) => ({ status: method === "PUT" ? 200 : 201, json: {} });
  calls.length = 0;
  A.accessSyncForTests.look();
  await A.accessSyncForTests.flushAll();
  const sent = calls.filter((c) => c.method === "POST" && c.path === `/api/projects/${PID}/access/log`).flatMap((c) => c.body.entries);
  assert.deepEqual(sent.map((e) => [e.action, e.via, e.viaId]), [["GMAIL_FETCH_EMAILS", "thread", "ses_outbox"]], "the use from before went");
  assert.ok(!("oid" in sent[0]), "the outbox's id goes only as its clientId");
  assert.equal(sent[0].clientId, kept[0].id, "the same id as the first try: a resend is the same entry");
  assert.equal(A.accessSyncForTests.waitingUses().length, 0, "out of the outbox once Orgo took it");
  // Started again: not sent twice.
  A.accessSyncForTests.reset();
  O.outboxForTests.restart();
  calls.length = 0;
  A.accessSyncForTests.look();
  await A.accessSyncForTests.flushAll();
  assert.equal(calls.filter((c) => c.method === "POST").length, 0);
});

/* ---------------- After an upgrade from v0.0.28 ---------------- */

// On v0.0.28 a bot had an account only where the user gave it to that bot (its accountsOf read Bot.access
// alone). A team from then, as this build has it in memory: some accounts as v0.0.28 wrote them (a Mac
// still on it, merged in), the rest as this build keeps them once it loaded them (lib/server/store.ts).
const had = (b, a) => b.access?.[a.id] ?? null;
const fromV028 = () => ({
  bots: [
    { id: "boppy", name: "Boppy", isMain: true, access: { ca_gmail: "act" } },
    { id: "iris", name: "Iris", access: { ca_gmail: "read", ca_stripe: "act" } },
    { id: "penny", name: "Penny", autoApprove: true },
    { id: "otto", name: "Otto", access: { ca_linear: "act" } },
    { id: "lo", name: "Lo", workspaceId: "ws_local", access: { ca_notion: "read" } },
  ],
  accounts: [
    { id: "ca_gmail", app: "gmail", appName: "Gmail", name: "sam@acme.com", status: "active", at: 1 },
    { id: "ca_stripe", app: "stripe", appName: "Stripe", name: "Acme", status: "active", at: 1 },
    { id: "open:hackernews", app: "hackernews", appName: "Hacker News", status: "active", at: 1 },
    { id: "ca_notion", app: "notion", appName: "Notion", status: "active", at: 1, workspaceId: "ws_local", onlyGiven: true },
    { id: "ca_linear", app: "linear", appName: "Linear", status: "active", at: 1, workspaceId: "ws_main", onlyGiven: true },
  ],
});

await check("an account from before is only the bots' it was given: each has what it had on v0.0.28, Just do it acts nowhere else, a bot made since has none", async () => {
  Object.assign(state, fromV028());
  for (const b of state.bots) for (const a of state.accounts) assert.equal(T.levelOf(b, a), had(b, a), `${b.name} in ${a.appName}`);
  assert.equal(T.levelOf({ id: "new" }, account("ca_gmail")), null, "a bot made since");
  assert.equal(T.levelOf({ id: "new" }, account("ca_linear")), null);
  assert.deepEqual(C.accountsOf(bot("penny")), []);
  assert.equal(C.appList(bot("iris")), "Gmail (sam@acme.com: read only), Stripe (Acme: read & act)");
  const n = executed.length;
  assert.match(await C.runAppAction("penny", "STRIPE_CREATE_REFUND", { charge: "ch_1" }, { chatId: "bot:penny" }), /^You don't have that app/);
  assert.match(await C.runAppAction("penny", "GMAIL_SEND_EMAIL", { to: "a@b.c" }, { chatId: "bot:penny" }), /^You don't have that app/);
  assert.equal(executed.length, n, "Just do it did nothing");
  assert.deepEqual(
    A.accessPayload("ws_main")
      .filter((r) => r.target === "ca_stripe")
      .map((r) => [r.bot, r.level]),
    [
      ["boppy", "none"],
      ["iris", "act"],
      ["penny", "none"],
      ["otto", "none"],
    ],
    "Orgo is told the same",
  );
});

await check("accounts connected from now on are every bot's of their workspace; one from before given to a bot, or signed back in, or one found in Composio, stays only its bots'", async () => {
  Object.assign(state, fromV028());
  const meta = { description: "", categories: [], tools_count: 1 };
  let connected;
  Object.assign(globalThis.__fake.composio.client, {
    getClient: () => ({
      toolkits: {
        list: async () => ({
          items: [
            { slug: "hackernews", name: "Hacker News", no_auth: true, meta },
            { slug: "weathermap", name: "Weather", no_auth: true, meta },
            { slug: "gmail", name: "Gmail", auth_schemes: ["OAUTH2"], meta },
            { slug: "linear", name: "Linear", auth_schemes: ["OAUTH2"], meta },
          ],
          next_cursor: null,
        }),
      },
    }),
    authConfigs: { list: async () => ({ items: [{ id: "ac_1", status: "ENABLED" }] }) },
    connectedAccounts: {
      list: async () => ({
        items: [...state.accounts.filter((a) => !a.id.startsWith("open:")).map((a) => ({ id: a.id, status: "ACTIVE", toolkit: { slug: a.app } })), { id: "ca_found", status: "ACTIVE", toolkit: { slug: "gmail" } }],
        nextCursor: null,
      }),
      get: async (id) => ({ data: { email: `${id}@acme.com` } }),
      link: async () => ({ id: "wait_1", waitForConnection: () => new Promise((r) => (connected = r)) }),
      delete: async () => null,
    },
  });
  const levels = (a) => state.bots.map((b) => T.levelOf(b, a));
  // Found in Composio, connected where this Mac didn't see who was picked (a Mac still on v0.0.28, whose
  // state Bops Cloud keeps out until it's updated): nobody's until given, Just do it can't use it either.
  await C.syncApps();
  assert.deepEqual([account("ca_found")?.workspaceId, account("ca_found")?.onlyGiven], ["ws_main", true]);
  assert.deepEqual(levels(account("ca_found")), [null, null, null, null, null]);
  const n = executed.length;
  assert.match(await C.runAppAction("penny", "GMAIL_SEND_EMAIL", { to: "a@b.c" }, { chatId: "bot:penny" }), /^You don't have that app/);
  assert.equal(executed.length, n, "Just do it did nothing");
  bot("otto").access.ca_found = "read";
  assert.deepEqual(levels(account("ca_found")), [null, null, null, "read", null], "given to a bot: its alone");
  // Connected here.
  await C.connectApp("weathermap");
  assert.deepEqual(levels(account("open:weathermap")), ["act", "act", "act", "act", null]);
  // Hacker News from before, given to Penny now: hers, and still nobody else's.
  await C.connectApp("hackernews", undefined, undefined, { bots: ["penny"], level: "act" });
  assert.deepEqual(levels(account("open:hackernews")), [null, null, "act", null, null]);
  // Linear from before, signed back in: the new account takes its place, still only Otto's.
  await C.connectApp("linear", undefined, "ca_linear");
  connected({ id: "ca_linear2" });
  await new Promise((r) => setTimeout(r, 50));
  const relinked = account("ca_linear2");
  assert.ok(relinked && !account("ca_linear"), "signed back in");
  assert.deepEqual([relinked.workspaceId, relinked.onlyGiven], ["ws_main", true]);
  assert.deepEqual(levels(relinked), [null, null, null, "act", null]);
});

/* ---------------- How often: a check made once it's connected ---------------- */

// Each sign-in waits until the test finishes it (resolve, with the account) or gives up on it (reject).
const waits = new Map();
let waitNo = 0;
const linkWaiting = async () => {
  const w = { id: `wait_${++waitNo}` };
  w.waitForConnection = () => new Promise((resolve, reject) => waits.set(w.id, { resolve, reject }));
  return w;
};
const settle = () => new Promise((r) => setTimeout(r, 50));
const hourly = { kind: "every", minutes: 60 };

await check("How often goes with the sign-in: a check is asked for only once the account is connected and given, never for a sign-in that failed or was cancelled, and not without one", async () => {
  Object.assign(state, fromV028(), { routines: [], connecting: [] });
  globalThis.__fake.composio.client.connectedAccounts.link = linkWaiting;
  suggested.length = 0;
  // Continue: nothing yet, the How often waits with the sign-in.
  await C.connectApp("gmail", "Work", undefined, { bots: ["iris", "boppy"], level: "read", check: hourly });
  assert.deepEqual(state.connecting.at(-1).grant, { bots: ["iris", "boppy"], level: "read", check: hourly, workspaceId: "ws_main" });
  assert.deepEqual(suggested, [], "nothing on Continue");
  // The sign-in isn't finished: nothing is made.
  waits.get("wait_1").reject(new Error("Connection timed out"));
  await settle();
  assert.equal(state.connecting.at(-1).status, "failed");
  assert.deepEqual(suggested, [], "nothing for a sign-in that failed");
  // Try again (the Vault posts the same grant): finished, so its check, then the starters.
  const again = state.connecting.at(-1);
  await C.connectApp(again.app, again.label, again.replaces, again.grant);
  waits.get("wait_2").resolve({ id: "ca_gmail2" });
  await settle();
  assert.deepEqual(
    suggested.map((x) => [x.fn, x.args[0]]),
    [
      ["makeCheck", "ca_gmail2"],
      ["offerStarters", "gmail"],
    ],
    "the check first, so the starters offered leave out its job",
  );
  assert.deepEqual(suggested[0].args[1], { bots: ["iris", "boppy"], level: "read", check: hourly, workspaceId: "ws_main" });
  assert.deepEqual(suggested[0].seen, { account: true, level: ["read", "read"] }, "the account is there, with the access picked");
  // Cancelled, then finished anyway: no check.
  suggested.length = 0;
  await C.connectApp("gmail", undefined, undefined, { bots: ["boppy"], level: "act", check: hourly });
  C.cancelConnect("wait_3");
  waits.get("wait_3").resolve({ id: "ca_gmail3" });
  await settle();
  assert.ok(!suggested.some((x) => x.fn === "makeCheck"), "nothing for a sign-in that was given up");
  // Only when asked: no check, the starters all the same.
  await C.connectApp("gmail", undefined, undefined, { bots: ["boppy"], level: "act" });
  waits.get("wait_4").resolve({ id: "ca_gmail5" });
  await settle();
  assert.deepEqual(suggested.map((x) => x.fn), ["offerStarters"]);
  // An app with no sign-in is connected at once: its check right away, then its starters.
  suggested.length = 0;
  await C.connectApp("weathermap", undefined, undefined, { bots: ["penny"], level: "act", check: { kind: "daily", time: "08:00" } });
  assert.deepEqual(
    suggested.map((x) => [x.fn, x.args[0]]),
    [
      ["makeCheck", "open:weathermap"],
      ["offerStarters", "weathermap"],
    ],
  );
  assert.deepEqual(suggested[0].seen, { account: true, level: ["act"] });
});

await check("signing in again keeps the account's check (it moves to the new account), makes no other; disconnecting drops it", async () => {
  state.routines = [{ id: "rtn_check", botId: "boppy", title: "Check Gmail (Work)", goal: "x", schedule: hourly, enabled: true, source: { app: "gmail", template: "check", account: "ca_gmail2" } }];
  suggested.length = 0;
  await C.connectApp("gmail", undefined, "ca_gmail2");
  const w = state.connecting.at(-1);
  assert.equal(w.grant, undefined, "signing in again picks nothing");
  waits.get(w.id).resolve({ id: "ca_gmail6" });
  await settle();
  assert.ok(account("ca_gmail6") && !account("ca_gmail2"), "signed back in");
  assert.deepEqual(state.routines[0].source, { app: "gmail", template: "check", account: "ca_gmail6" }, "the check is the new account's");
  assert.deepEqual(suggested, [], "no second check, and no starters for signing back in");
  await C.disconnectAccount("ca_gmail6");
  assert.deepEqual(suggested.map((x) => [x.fn, x.args[0]]), [["dropChecks", "ca_gmail6"]]);
});

await check("POST /api/apps takes How often from the Bops window only, as a schedule Bops keeps", async () => {
  const route = await import(`${root}/app/api/apps/route.ts`);
  const post = (body, headers = {}) => route.POST(new Request("http://localhost/api/apps", { method: "POST", headers: { "content-type": "application/json", ...headers }, body: JSON.stringify(body) }));
  state.connecting = [];
  let res = await post({ app: "gmail", grant: { bots: ["boppy"], level: "read", check: { kind: "daily", time: "8 AM" } } });
  assert.equal(res.status, 200);
  assert.deepEqual(state.connecting.at(-1).grant, { bots: ["boppy"], level: "read", check: { kind: "daily", time: "08:00" }, workspaceId: "ws_main" });
  res = await post({ app: "gmail", grant: { bots: ["boppy"], level: "read", check: { kind: "daily", time: "99:99" } } });
  assert.equal(res.status, 400);
  assert.match((await res.json()).error, /isn't a time of day/);
  assert.equal(state.connecting.length, 1, "nothing for a bad one");
  process.env.BOPS_UI_TOKEN = "window-token-for-tests";
  try {
    res = await post({ app: "gmail", grant: { bots: ["boppy"], level: "read", check: hourly } });
    assert.equal(res.status, 403, "not from the window: no routine set up through it");
    assert.equal(state.connecting.length, 1);
    res = await post({ app: "gmail", grant: { bots: ["boppy"], level: "read", check: hourly } }, { cookie: "bops_window=window-token-for-tests" });
    assert.equal(res.status, 200);
    assert.deepEqual(state.connecting.at(-1).grant.check, hourly);
    // Without How often it's the connect it always was, from anywhere.
    res = await post({ app: "gmail", grant: { bots: ["boppy"], level: "read" } });
    assert.equal(res.status, 200);
    assert.equal(state.connecting.at(-1).grant.check, undefined);
  } finally {
    delete process.env.BOPS_UI_TOKEN;
  }
});

rmSync(scratch, { recursive: true, force: true });
console.log(`access: ${passed} passed, ${failures} failed`);
process.exit(failures ? 1 : 0);
