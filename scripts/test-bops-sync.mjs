// Tests for the map of each workspace's Bops in Orgo (lib/server/bops-sync.ts): the PUT orgo-web takes
// (lib/bops-map/body.ts) with each bot and the computer it works on (its main bot's when it shares; none
// while the bots work in browsers on this Mac), what's the workspace's and what's each bot's own, and the
// watches; names and ids only (no key, token, password or pairing code), text cut to orgo-web's limits and
// ids that wouldn't keep left out, each item once; a change is sent once, 2 seconds after the burst, and
// an unchanged map isn't; an Orgo without the route (404 or 405) is left alone for 6 hours; one that
// didn't answer is asked again; and a computer's runner never sends the map, nor the access set.
//
// The store and the Orgo client are fakes: Orgo's answers come from a fake below, which records every
// call, so nothing reaches a real Orgo or the user's data.
// Usage: node --conditions=react-server scripts/test-bops-sync.mjs
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdtempSync, rmSync } from "node:fs";
import { registerHooks } from "node:module";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { unfaked } from "./fake-exports.mjs";

for (const k of Object.keys(process.env)) if (/^(BOPS|ORGO|NEXT_PUBLIC_BOPS)_/.test(k)) delete process.env[k];
// A build with brains (lib/types.ts BRAINS_ON, read as it loads): this file runs itself once more as one, for the brains' checks.
const BRAINS_BUILD = process.argv.includes("--brains-build");
if (BRAINS_BUILD) process.env.NEXT_PUBLIC_BOPS_BRAINS = "1";
const root = new URL("..", import.meta.url).pathname.replace(/\/$/, "");
const scratch = mkdtempSync(join(tmpdir(), "bops-test-map-"));

const FAKES = {
  store: ["bot", "getState", "pullState", "session", "stateEpoch", "statePulledAt", "stateReady", "stateTooNew", "update", "userDir", "watchChanges"],
  orgo: ["apiKey", "callOrgo"],
  keys: ["listKeys", "keysOf"],
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
    return { format: "module", shortCircuit: true, source: FAKES[name].map((n) => `export const ${n} = (...a) => globalThis.__fake[${JSON.stringify(name)}].${n}(...a);`).join("\n") + unfaked(name, url, FAKES[name]) };
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
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const PID = "11111111-2222-4333-8444-555555555555";
const PID2 = "99999999-2222-4333-8444-555555555555";
const C_MAIN = "AAAAAAAA-0000-4000-8000-000000000001";
const C_IRIS = "aaaaaaaa-0000-4000-8000-000000000002";
const C_ACME = "aaaaaaaa-0000-4000-8000-000000000003";
// What's secret in the state: none of it may reach Orgo.
const SECRETS = ["appsKey_secret_1", "orbit_secret_1", "pair_secret_1", "cmp_session_1", "agent_secret_1", "pod_secret_1"];

const fresh = () => ({
  host: "orgo",
  owner: { name: "Sam" },
  workspace: "ws_main",
  workspaces: [
    { id: "ws_main", name: "Main", createdAt: 0, orgoProjectId: PID, orbitKey: "orbit_secret_1", line: { phone: "+15550000000", numberId: "num_ws", agentId: "agent_secret_1", type: "imessage", scope: "sub", at: 1 } },
    { id: "ws_acme", name: "Acme", createdAt: 0, orgoProjectId: PID2 },
    { id: "ws_local", name: "Local", createdAt: 0 },
  ],
  bots: [
    {
      id: "boppy",
      name: "Boppy",
      role: "Chief of staff",
      color: "#0A0A0A",
      isMain: true,
      computer: "own",
      computerId: C_MAIN,
      computerStatus: "ready",
      appsKey: "appsKey_secret_1",
      composio: { sessionId: "cmp_session_1", access: "x" },
      phone: "+15551112222",
      phoneLine: { numberId: "num_boppy", agentId: "agent_secret_1" },
      email: "boppy@main.bops.bot",
      mail: { inboxId: "inbox_boppy", podId: "pod_secret_1", paused: true },
      persona: "Be brief.",
      // The vault keys it may use: names only go (bops_bots.secret_names), each once, sorted; one too long for Orgo stays out.
      keys: ["OPENAI_API_KEY", "GITHUB_TOKEN", "OPENAI_API_KEY", "K".repeat(129)],
    },
    { id: "max", name: "Max", role: "Research", color: "#E9FF3B", isMain: false, computerStatus: "none" },
    { id: "iris", name: "Iris", role: "", color: "#FF8800", isMain: false, computer: "own", computerId: C_IRIS, computerStatus: "ready", brain: "brn_1" },
    { id: "ace", name: "Ace", role: "", color: "#00AAFF", isMain: true, computer: "own", computerId: C_ACME, computerStatus: "ready", workspaceId: "ws_acme" },
    { id: "lo", name: "Lo", role: "", color: "#00AAFF", isMain: true, computerStatus: "none", workspaceId: "ws_local" },
  ],
  brains: [{ id: "brn_1", name: "Claude Code", kind: "claude", auth: "plan", bots: ["iris"], workspaceId: "ws_main" }],
  accounts: [
    { id: "ca_gmail", app: "gmail", appName: "Gmail", name: "sam@acme.com", label: "Work", status: "active", at: 1, workspaceId: "ws_main" },
    { id: "ca_old", app: "linear", appName: "Linear", status: "expired", at: 1 },
    { id: "ca_acme", app: "notion", appName: "Notion", status: "active", at: 1, workspaceId: "ws_acme" },
  ],
  vault: [
    { id: "vl_all", site: "x.com", username: "sam", hasPassword: true, hasTotp: true, bots: "all", auto: false, addedAt: 1 },
    { id: "vl_iris", site: "linkedin.com", username: "sam@acme.com", hasPassword: true, hasTotp: false, bots: ["iris"], auto: true, addedAt: 1 },
    { id: "vl_ace", site: "notion.so", username: "ace", hasPassword: true, hasTotp: false, bots: ["ace"], auto: false, addedAt: 1 },
  ],
  channels: [{ id: "ch_tg", kind: "telegram", botId: "max", handle: "@max_bot", pairCode: "pair_secret_1", status: "live", at: 1, owner: "42" }],
  watches: [
    { id: "w_x", botId: "boppy", display: 2, site: "X", lookFor: "new DMs", since: 1, alert: { text: "A DM", at: 1 }, told: ["A DM"] },
    { id: "w_page", botId: "iris", display: 0, site: "Status page", lookFor: "an outage", since: 1, page: { url: "https://status.example.com", everyMin: 30, hash: "h", lines: ["ok"] }, paused: true },
    { id: "w_mac", botId: "max", display: 0, site: "Messages", lookFor: "texts from Jo", since: 1, mac: { app: "Messages", title: "Jo" } },
    { id: "w_acme", botId: "ace", display: 1, site: "Gmail", lookFor: "mail", since: 1 },
  ],
  sessions: [],
  messages: [],
  chats: [],
  routines: [],
});
let state = fresh();

// The fake Orgo: what it was asked, and what it answers (by default as orgo-web does: 200).
const calls = [];
let answer = () => ({ status: 200, json: {} });
let key = "sk_test_key";
let ready = true;
let tooNew = false;
let broken = false;
const watchers = new Map();
globalThis.__fake = {
  store: {
    // (Whose state it is: one account here.)
    stateEpoch: () => 1,
    getState: () => {
      if (broken) throw new Error("state isn't ready");
      return state;
    },
    bot: (id) => state.bots.find((b) => b.id === id),
    session: (id) => state.sessions.find((s) => s.id === id),
    stateReady: () => ready,
    stateTooNew: () => tooNew,
    userDir: () => scratch,
    watchChanges: (name, fn) => watchers.set(name, fn),
    pullState: async () => {},
    statePulledAt: () => 0,
  },
  orgo: {
    apiKey: async () => {
      if (!key) throw new Error("Not signed in to Orgo");
      return key;
    },
    callOrgo: async (k, path, init = {}) => {
      assert.equal(k, key, "the signed-in key");
      calls.push({ method: init.method ?? "GET", path, body: init.body === undefined ? undefined : JSON.parse(JSON.stringify(init.body)) });
      return answer(init.method ?? "GET", path, init.body);
    },
  },
  keys: { listKeys: async () => [], keysOf: (all) => all },
};

const Sync = await import("@/lib/server/bops-sync");
const Access = await import("@/lib/server/access-sync");
const T = Sync.bopsSyncForTests;
const realNow = Date.now;
const reset = () => {
  T.reset();
  Access.accessSyncForTests.reset();
  watchers.clear();
  calls.length = 0;
  answer = () => ({ status: 200, json: {} });
  key = "sk_test_key";
  ready = true;
  tooNew = false;
  broken = false;
  state = fresh();
  delete process.env.BOPS_RUNNER;
  Date.now = realNow;
};
const puts = () => calls.filter((c) => c.method === "PUT" && c.path.endsWith("/bops"));

if (BRAINS_BUILD) {
  await check("every brain of the workspace is in its map (names only), once orgo-web says it takes the kind: sent again at once then", async () => {
    reset();
    state.brains.push(
      { id: "brn_2", name: "Codex (work)", kind: "codex", auth: "key", keyName: "CODEX_WORK_KEY", keyScope: "workspace", bots: [], workspaceId: "ws_main", createdAt: 1 },
      { id: "brn_3", name: "Claude Code", kind: "claude", auth: "plan", bots: ["ace"], workspaceId: "ws_acme", createdAt: 1 },
    );
    const brainsIn = (body) => body.resources.filter((r) => r.kind === "brain");
    // An orgo-web that hasn't said, or says it takes no brains: none sent (one it doesn't take would fail the whole map).
    assert.deepEqual(brainsIn(Sync.bopsMapPayload("ws_main", state)), []);
    answer = () => ({ status: 200, json: { kinds: ["app", "login", "phone", "inbox", "channel"] } });
    T.look();
    await T.flushAll();
    assert.equal(puts().length, 2);
    assert.ok(puts().every((c) => !brainsIn(c.body).length));
    assert.equal(puts().find((c) => c.path === `/api/projects/${PID}/bops`).body.bots.find((b) => b.bopsId === "iris").brain, "brn_1", "the brain a bot uses, as before");
    // It takes them now: every workspace's map goes again at once, with each of its brains, one no bot uses too.
    calls.length = 0;
    answer = () => ({ status: 200, json: { kinds: ["app", "login", "phone", "inbox", "channel", "brain"] } });
    state.bots.find((b) => b.id === "max").name = "Max R";
    T.look();
    await T.flushAll();
    await T.flushAll();
    const main = puts().filter((c) => c.path === `/api/projects/${PID}/bops`).at(-1);
    assert.deepEqual(brainsIn(main.body), [
      { kind: "brain", ref: "brn_1", name: "Claude Code", app: "claude_code", status: "plan" },
      { kind: "brain", ref: "brn_2", name: "Codex (work)", app: "codex", status: "key" },
    ]);
    const acme = puts().filter((c) => c.path === `/api/projects/${PID2}/bops`).at(-1);
    assert.ok(acme, "the other workspace's map went again too, unchanged otherwise");
    assert.deepEqual(brainsIn(acme.body), [{ kind: "brain", ref: "brn_3", name: "Claude Code", app: "claude_code", status: "plan" }]);
    assert.ok(!JSON.stringify(calls).includes("CODEX_WORK_KEY"), "never its key's name, nor a value");
    // Sent once: nothing more while nothing changes.
    calls.length = 0;
    T.look();
    await T.flushAll();
    assert.equal(puts().length, 0);
  });
  await check("a start in a build with brains: the kinds are read first, so the first map already holds the brains (orgo-web never deletes them to make them again)", async () => {
    reset();
    const ALL = ["app", "login", "phone", "inbox", "channel", "brain"];
    const brainsIn = (body) => body.resources.filter((r) => r.kind === "brain");
    const acmeBrain = { id: "brn_3", name: "Claude Code", kind: "claude", auth: "plan", bots: ["ace"], workspaceId: "ws_acme", createdAt: 1 };
    state.brains.push(acmeBrain);
    answer = () => ({ status: 200, json: { kinds: ALL } });
    T.look();
    await T.flushAll();
    const gets = calls.filter((c) => c.method === "GET");
    assert.deepEqual(gets.map((c) => c.path), [`/api/projects/${PID}/bops`], "read once, for every workspace");
    assert.ok(calls.indexOf(gets[0]) < calls.findIndex((c) => c.method === "PUT"), "before the first map");
    assert.equal(puts().length, 2);
    assert.ok(puts().every((c) => brainsIn(c.body).length), "every map with its brains, the first too");
    calls.length = 0;
    T.look();
    await T.flushAll();
    assert.deepEqual(calls, [], "sent once: nothing more while nothing changes");
    // Orgo not answering the read: the map waits (never one without its brains), and goes with them after.
    reset();
    state.brains.push(acmeBrain);
    answer = (method) => (method === "GET" ? { status: 503, json: {} } : { status: 200, json: { kinds: ALL } });
    T.look();
    await T.flushAll();
    assert.equal(puts().length, 0);
    answer = () => ({ status: 200, json: { kinds: ALL } });
    await T.flushAll();
    assert.equal(puts().length, 2);
    assert.ok(puts().every((c) => brainsIn(c.body).length));
  });
  rmSync(scratch, { recursive: true, force: true });
  console.log(`bops sync (brains): ${passed} passed, ${failures} failed`);
  process.exit(failures ? 1 : 0);
}

await check("the payload: each bot and its computer, the workspace's and each bot's own, the watches", async () => {
  reset();
  const map = Sync.bopsMapPayload("ws_main", state);
  assert.deepEqual(map.bots, [
    { bopsId: "boppy", name: "Boppy", role: "Chief of staff", isMain: true, computer: "own", desktopId: C_MAIN.toLowerCase(), keys: ["GITHUB_TOKEN", "OPENAI_API_KEY"] },
    // Max shares: it works on Boppy's computer. No keys is said as none, so one taken away goes from Orgo too.
    { bopsId: "max", name: "Max", role: "Research", isMain: false, computer: "shared", desktopId: C_MAIN.toLowerCase(), keys: [] },
    // A brain only in a build with brains (BRAINS_ON): none here.
    { bopsId: "iris", name: "Iris", role: "", isMain: false, computer: "own", desktopId: C_IRIS, keys: [] },
  ]);
  assert.deepEqual(map.resources, [
    { kind: "app", ref: "ca_gmail", name: "Gmail, Work · sam@acme.com", app: "gmail", status: "active" },
    // One from before workspaces had accounts: the first workspace's.
    { kind: "app", ref: "ca_old", name: "Linear", app: "linear", status: "expired" },
    { kind: "login", ref: "vl_all", name: "x.com, sam" },
    { kind: "login", ref: "vl_iris", name: "linkedin.com, sam@acme.com", ownerBotId: "iris" },
    { kind: "phone", ref: "num_ws", name: "+15550000000", status: "active" },
    { kind: "phone", ref: "num_boppy", name: "+15551112222", status: "active", ownerBotId: "boppy" },
    { kind: "inbox", ref: "inbox_boppy", name: "boppy@main.bops.bot", status: "paused", ownerBotId: "boppy" },
    { kind: "channel", ref: "ch_tg", name: "@max_bot", app: "telegram", status: "live", ownerBotId: "max" },
  ]);
  assert.deepEqual(map.watches, [
    { bopsId: "w_x", botId: "boppy", kind: "screen", site: "X", lookFor: "new DMs", paused: false },
    { bopsId: "w_page", botId: "iris", kind: "page", site: "Status page", lookFor: "an outage", url: "https://status.example.com", everyMin: 30, paused: true },
    { bopsId: "w_mac", botId: "max", kind: "mac", site: "Messages", lookFor: "texts from Jo", paused: false },
  ]);
  // Another workspace's: its own bots, account, login and watch only.
  const acme = Sync.bopsMapPayload("ws_acme", state);
  assert.deepEqual(acme.bots.map((b) => b.bopsId), ["ace"]);
  assert.deepEqual(acme.resources.map((r) => r.ref), ["ca_acme", "vl_all", "vl_ace"]);
  assert.equal(acme.resources[2].ownerBotId, "ace");
  assert.deepEqual(acme.watches.map((w) => w.bopsId), ["w_acme"]);
});

await check("names and ids only: no key, token, password, pairing code or Orbit secret", async () => {
  reset();
  const all = JSON.stringify([Sync.bopsMapPayload("ws_main", state), Sync.bopsMapPayload("ws_acme", state)]);
  for (const s of SECRETS) assert.ok(!all.includes(s), s);
  for (const k of ["appsKey", "composio", "persona", "pairCode", "agentId", "podId", "orbitKey", "hasPassword", "hasTotp", "told", "alert", "hash"]) assert.ok(!all.includes(`"${k}"`), k);
});

await check("bots in browsers on this Mac (host mac) have no computer in the map", async () => {
  reset();
  state.host = "mac";
  assert.deepEqual(Sync.bopsMapPayload("ws_main", state).bots.map((b) => b.desktopId), [null, null, null]);
});

await check("orgo-web's limits: text cut without half an emoji, NUL out, ids that wouldn't keep left out, each once, the caps", async () => {
  reset();
  const long = `${"a".repeat(199)}😀tail`;
  state.bots[0].name = `Bo\u0000ppy`;
  state.bots[0].role = "r".repeat(600);
  state.bots[2].name = long;
  state.bots[2].computerId = "not-a-uuid";
  state.bots.push({ id: "x".repeat(129), name: "Too long an id", isMain: false, computerStatus: "none" });
  state.accounts.push({ id: "ca_gmail", app: "gmail", appName: "Gmail again", status: "active", at: 2, workspaceId: "ws_main" }, { id: `ca_\uD800`, app: "gmail", appName: "Half", status: "active", at: 2, workspaceId: "ws_main" });
  state.watches[1].page.everyMin = 999999;
  state.watches[1].page.url = `https://x.com/${"p".repeat(2100)}`;
  state.watches.push({ ...state.watches[0] });
  const map = Sync.bopsMapPayload("ws_main", state);
  assert.equal(map.bots[0].name, "Boppy");
  assert.equal(map.bots[0].role.length, 500);
  assert.equal(map.bots[2].name, "a".repeat(199), "an emoji that wouldn't fit whole is left out");
  assert.equal(map.bots[2].desktopId, null, "not a computer id");
  assert.equal(map.bots.length, 3, "an id too long to keep isn't sent");
  assert.deepEqual(map.resources.filter((r) => r.kind === "app").map((r) => r.name), ["Gmail, Work · sam@acme.com", "Linear"], "one of each, none with half an emoji");
  assert.equal(map.watches.length, 3, "each watch once");
  assert.equal(map.watches[1].everyMin, 10080);
  assert.ok(!("url" in map.watches[1]), "an address too long to keep isn't sent");
  // The caps: 200 bots, 2000 resources, 500 watches.
  state.bots = Array.from({ length: 230 }, (_, i) => ({ id: `b${i}`, name: `B${i}`, role: "", isMain: i === 0, computerStatus: "none", phone: `+1555${i}`, phoneLine: { numberId: `n${i}`, agentId: "a" }, mail: { inboxId: `i${i}`, podId: "p" } }));
  state.accounts = Array.from({ length: 1900 }, (_, i) => ({ id: `ca${i}`, app: "gmail", appName: "Gmail", status: "active", at: 1, workspaceId: "ws_main" }));
  state.watches = Array.from({ length: 600 }, (_, i) => ({ id: `w${i}`, botId: "b0", display: 1, site: "X", lookFor: "x", since: 1 }));
  const warn = console.warn;
  const said = [];
  console.warn = (...a) => said.push(a.join(" "));
  try {
    const big = Sync.bopsMapPayload("ws_main", state);
    assert.deepEqual([big.bots.length, big.resources.length, big.watches.length], [200, 2000, 500]);
    Sync.bopsMapPayload("ws_main", state);
  } finally {
    console.warn = warn;
  }
  // What's cut is said, once a run (the map is built on every look), never silently.
  assert.deepEqual(said, ["[bops-sync] ws_main: 230 bots (Orgo takes 200), 2362 resources (2000), 600 watches (500); the rest isn't in Orgo's copy"]);
});

await check("a change is one PUT 2 seconds after the burst, each workspace to its own project; unchanged isn't sent", async () => {
  reset();
  assert.equal(Sync.SYNC_DEBOUNCE_MS, 2000);
  Sync.startBopsSync();
  assert.ok(watchers.has("bops-sync"), "it looks at every change");
  await sleep(1800);
  assert.equal(puts().length, 0, "not yet");
  await sleep(400);
  assert.deepEqual(puts().map((c) => c.path).sort(), [`/api/projects/${PID}/bops`, `/api/projects/${PID2}/bops`], "every workspace with a project, once");
  assert.deepEqual(puts().find((c) => c.path.includes(PID)).body, Sync.bopsMapPayload("ws_main", state));
  calls.length = 0;
  // Changes that don't touch the map: nothing.
  state.messages.push({ id: "m1" });
  watchers.get("bops-sync")();
  watchers.get("bops-sync")();
  await sleep(2700);
  assert.equal(puts().length, 0, "an unchanged map isn't sent");
  // A bot moved onto its own computer: its workspace's map goes again, and only that one.
  state.bots[1].computer = "own";
  state.bots[1].computerId = "bbbbbbbb-0000-4000-8000-000000000009";
  for (let i = 0; i < 3; i++) watchers.get("bops-sync")();
  await sleep(2900);
  assert.deepEqual(puts().map((c) => c.path), [`/api/projects/${PID}/bops`]);
  assert.equal(puts()[0].body.bots[1].desktopId, "bbbbbbbb-0000-4000-8000-000000000009");
});

await check("an Orgo without the route is left alone for 6 hours, then asked again on a change", async () => {
  reset();
  answer = () => ({ status: 404, json: {} });
  T.look();
  await T.flushAll();
  assert.equal(puts().length, 2);
  calls.length = 0;
  answer = () => ({ status: 200, json: {} });
  state.bots[0].name = "Boppy 2";
  T.look();
  await T.flushAll();
  assert.equal(puts().length, 0, "left alone");
  const t = realNow();
  Date.now = () => t + Sync.MISSING_RETRY_MS + 1000;
  T.look();
  await T.flushAll();
  assert.equal(puts().length, 2, "asked again, the map as it is now");
  assert.equal(puts().find((c) => c.path.includes(PID)).body.bots[0].name, "Boppy 2");
});

await check("no answer or a 5xx: sent again; a 400 waits for the next change; signed out sends nothing", async () => {
  reset();
  const warn = console.warn;
  console.warn = () => {};
  answer = () => ({ status: 503, json: {} });
  T.look();
  await T.flushAll();
  console.warn = warn;
  assert.equal(T.pendingCount(), 2, "both wait for a retry");
  answer = () => ({ status: 200, json: {} });
  calls.length = 0;
  await T.flushAll();
  assert.equal(puts().length, 2, "sent again");
  assert.equal(T.pendingCount(), 0);
  reset();
  console.warn = () => {};
  try {
    answer = () => ({ status: 400, json: { error: "invalid_bops_map" } });
    T.look();
    await T.flushAll();
    assert.equal(T.pendingCount(), 0, "not sent again as it is");
    calls.length = 0;
    T.look();
    await T.flushAll();
    assert.equal(puts().length, 0);
  } finally {
    console.warn = warn;
  }
  reset();
  key = "";
  T.look();
  await T.flushAll();
  assert.equal(calls.length, 0, "signed out");
});

await check("nothing before the state is ready, while a newer Bops wrote it, or when the state breaks", async () => {
  reset();
  ready = false;
  T.look();
  tooNew = true;
  ready = true;
  T.look();
  await T.flushAll();
  assert.equal(T.pendingCount() + calls.length, 0);
  reset();
  Sync.startBopsSync();
  await T.flushAll();
  calls.length = 0;
  broken = true;
  const warn = console.warn;
  const said = [];
  console.warn = (m) => said.push(m);
  try {
    watchers.get("bops-sync")();
    await sleep(600);
    assert.ok(said.some((m) => /\[bops-sync\]/.test(m)), "a warning, never a throw");
  } finally {
    console.warn = warn;
  }
});

await check("a map that couldn't go when it was due (a newer Bops wrote the state then) goes on the next look", async () => {
  reset();
  T.look();
  tooNew = true;
  await T.flushAll();
  assert.equal(calls.length, 0, "not while a newer Bops wrote the state");
  tooNew = false;
  T.look();
  await T.flushAll();
  assert.ok(calls.some((c) => c.method === "PUT" && c.path === `/api/projects/${PID}/bops`), "sent once it can be, though nothing in it changed");
});

await check("a computer's runner never sends the map, nor the access set", async () => {
  reset();
  process.env.BOPS_RUNNER = "1";
  Sync.startBopsSync();
  assert.ok(!watchers.has("bops-sync"), "no look at changes");
  T.look();
  await T.flushAll();
  Access.accessSyncForTests.look();
  Access.accessChanged();
  await Access.accessSyncForTests.flushAll();
  assert.equal(calls.length, 0, JSON.stringify(calls.map((c) => c.path)));
  // The Mac sends the access set as before.
  delete process.env.BOPS_RUNNER;
  Access.accessSyncForTests.look();
  await Access.accessSyncForTests.flushAll();
  assert.ok(calls.some((c) => c.path === `/api/projects/${PID}/access`), "the Mac's access set");
});

// The brains' checks, in a build with brains (this file once more, as one).
{
  const run = spawnSync(process.execPath, ["--conditions=react-server", fileURLToPath(import.meta.url), "--brains-build"], { encoding: "utf8" });
  const said = /bops sync \(brains\): (\d+) passed, (\d+) failed/.exec(run.stdout);
  if (run.status === 0 && said) passed += Number(said[1]);
  else {
    failures += Math.max(1, Number(said?.[2] ?? 1));
    console.error(`FAIL in a build with brains\n  ${(run.stdout + run.stderr).split("\n").filter((l) => !/MODULE_TYPELESS|To eliminate|trace-warnings|Reparsing/.test(l)).join("\n  ")}`);
  }
}

rmSync(scratch, { recursive: true, force: true });
console.log(`bops sync: ${passed} passed, ${failures} failed`);
process.exit(failures ? 1 : 0);
