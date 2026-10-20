// Tests for what a computer's runner may touch of its user's Bops (cloud/computer-scope.ts): which bots
// work on a computer and what they may use, the same as lib/types.ts says (workBot, levelOf) over many
// states; that what keepAllowed keeps is never refused (writeDenials) and that it keeps every change a
// computer may make; and the store's two sides of it (lib/server/persist-cloud.ts): a runner sends only
// what its computer may change, messages only in its bots' chats, and holds back a path Bops Cloud
// refuses anyway; the Mac takes of a runner's write only what its computer may change, and puts the rest
// back.
//
// Bops Cloud is a fake on localhost that refuses a computer's write as the real one does, and the working
// folder a throwaway one, so nothing reaches the real cloud or the user's files.
// Usage: node --conditions=react-server scripts/test-computer-scope.mjs
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { createServer } from "node:http";
import { registerHooks } from "node:module";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { pathToFileURL } from "node:url";

for (const k of Object.keys(process.env)) if (/^(BOPS|ORGO)_/.test(k)) delete process.env[k];
const root = new URL("..", import.meta.url).pathname.replace(/\/$/, "");
const scratch = mkdtempSync(join(tmpdir(), "bops-test-computer-scope-"));
process.chdir(scratch);
process.env.HOME = scratch;

registerHooks({
  resolve(specifier, context, next) {
    if (specifier === "server-only") return { url: "data:text/javascript,", shortCircuit: true };
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

const C = await import(`${root}/cloud/computer-scope.ts`);
const T = await import(`${root}/lib/types.ts`);
const D1 = "c1c1c1c1-0000-4000-8000-000000000001";
const D2 = "c2c2c2c2-0000-4000-8000-000000000002";

/* ---------------- The same rules as the app's ---------------- */

/** A small random number generator, so a failure can be run again. */
function rng(seed) {
  let x = seed >>> 0 || 1;
  return () => ((x = (x * 1664525 + 1013904223) >>> 0) / 2 ** 32);
}
const pick = (r, list) => list[Math.floor(r() * list.length)];

function randomState(r) {
  const n = 1 + Math.floor(r() * 6);
  const bots = [];
  for (let i = 0; i < n; i++) {
    const b = { id: `b${i}`, name: `B${i}`, role: "", color: "#000", isMain: r() < 0.4, computerStatus: "ready" };
    const computer = pick(r, [undefined, "shared", "own"]);
    if (computer) b.computer = computer;
    const id = pick(r, [undefined, D1, D2, D1.toUpperCase()]);
    if (id) b.computerId = id;
    if (r() < 0.3) b.freeComputer = true;
    const ws = pick(r, [undefined, "ws_main", "ws_two"]);
    if (ws) b.workspaceId = ws;
    const access = {};
    for (const a of ["a1", "a2", "a3"]) {
      const v = pick(r, [undefined, "read", "act", "none"]);
      if (v) access[a] = v;
    }
    if (Object.keys(access).length) b.access = access;
    bots.push(b);
  }
  const accounts = ["a1", "a2", "a3"].map((id) => ({
    id,
    app: pick(r, ["gmail", "notion", "slackbot"]),
    appName: id,
    status: pick(r, ["active", "active", "expired"]),
    at: 1,
    ...(r() < 0.7 ? { workspaceId: pick(r, ["ws_main", "ws_two"]) } : {}),
    ...(r() < 0.3 ? { onlyGiven: true } : {}),
  }));
  return { bots, accounts };
}

await check("which bot's computer each bot works on, and what it may do in each account: as lib/types.ts says, over 2000 states", () => {
  const r = rng(7);
  for (let i = 0; i < 2000; i++) {
    const s = randomState(r);
    for (const b of s.bots) {
      assert.equal(C.workBotOf(b, s.bots).id, T.workBot(b, s.bots).id, JSON.stringify(s));
      for (const a of s.accounts) assert.equal(C.levelOf(b, a), T.levelOf(b, a), JSON.stringify({ b, a }));
    }
    const on = C.botsOn(s, D1).map((b) => b.id);
    assert.deepEqual(on, s.bots.filter((b) => T.workBot(b, s.bots).computerId?.toLowerCase() === D1).map((b) => b.id), "any case of its id");
  }
});

/* ---------------- What it may write ---------------- */

const ME = "dev-runner-1";
const scope = { desktopId: D1, device: ME };

function baseState() {
  return {
    owner: { name: "Ann" },
    bots: [
      { id: "main", name: "Boppy", isMain: true, computerId: D1, computerStatus: "ready", keys: ["K1"] },
      { id: "helper", name: "Max", isMain: false, computerStatus: "ready" },
      { id: "iris", name: "Iris", isMain: false, computer: "own", computerId: D2, computerStatus: "ready" },
    ],
    chats: [{ id: "bot:main", kind: "bot", botIds: ["main"], createdAt: 1, typing: [] }],
    sessions: [{ id: "s-mac", botId: "main", by: "mac", status: "running" }],
    routines: [
      { id: "r-main", botId: "main", title: "A", goal: "a", schedule: { kind: "daily", times: ["09:00"] }, enabled: true, nextRunAt: 1, skips: [5, 9] },
      { id: "r-iris", botId: "iris", title: "B", goal: "b", schedule: { kind: "daily", times: ["09:00"] }, enabled: true, nextRunAt: 1 },
    ],
    accounts: [{ id: "a1", app: "gmail", appName: "Gmail", status: "active", at: 1 }],
    brains: [{ id: "br", kind: "claude", name: "C", auth: "plan", bots: ["main"], workspaceId: "ws_main", createdAt: 1, signIns: [{ computerId: D2, at: 1 }] }],
    screenLog: { "iris:1": { sessionId: "x", botId: "iris", title: "t", at: 1 } },
    digest: [{ botId: "iris", text: "old", at: 1 }],
    workspaces: [{ id: "ws_main", name: "Acme", createdAt: 1 }],
    usage: [],
  };
}

/** Everything a runner's work changes (each allowed). */
const ALLOWED = [
  (s) => s.sessions.push({ id: "s-run", botId: "main", by: ME, status: "running" }),
  (s) => Object.assign(s.routines[0], { nextRunAt: 2, lastRunAt: 2, last: { at: 2, status: "ok" }, lateRun: true, eventsThrough: 3 }),
  (s) => (s.routines[0].skips = [9]),
  (s) => (s.routines[0].enabled = false),
  (s) => Object.assign(s.bots[0], { computerStatus: "error", computerRam: 8, wakeFailed: { why: "x", at: 1 }, tailnet: { ip: "1", name: "n" }, composio: { sessionId: "trs", access: "k" } }),
  (s) => (s.bots[1].computerStatus = "cloning"),
  (s) => (s.accounts[0].usedAt = 5),
  (s) => s.brains[0].signIns.push({ computerId: D1, at: 2 }),
  (s) => (s.screenLog["main:1"] = { sessionId: "s-run", botId: "main", title: "t", at: 2 }),
  (s) => s.digest.push({ botId: "helper", text: "news", at: 2 }),
  (s) => s.usage.push({ kind: "model.tokens", at: 2 }),
  (s) => (s.credits = { out: true, at: 2 }),
];
/** What it may not (and the path refused). */
const REFUSED = [
  [(s) => s.bots[0].keys.push("STRIPE"), "bots.main.keys"],
  [(s) => (s.bots[2].computerId = D1), "bots.iris"],
  [(s) => (s.bots[1].access = { a1: "act" }), "bots.helper.access"],
  [(s) => s.bots.push({ id: "x", isMain: false }), "bots.x"],
  [(s) => (s.routines[0].goal = "z"), "routines.r-main.goal"],
  [(s) => (s.routines[1].nextRunAt = 9), "routines.r-iris"],
  [(s) => (s.routines[0].skips = [5, 9, 11]), "routines.r-main.skips"],
  [(s) => s.routines.pop(), "routines.r-iris"],
  [(s) => (s.sessions[0].status = "failed"), "sessions.s-mac"],
  [(s) => s.sessions.push({ id: "s-x", botId: "main", by: "mac", status: "queued" }), "sessions.s-x"],
  [(s) => (s.brains[0].signIns = []), "brains.br.signIns"],
  [(s) => (s.screenLog["iris:1"].title = "z"), "screenLog.iris:1"],
  [(s) => (s.digest = []), "digest"],
  [(s) => (s.workspaces[0].name = "z"), "workspaces"],
  [(s) => (s.macs = { [ME]: { relay: { on: true } } }), "macs"],
  [(s) => (s.accounts[0].onlyGiven = true), "accounts.a1.onlyGiven"],
];

await check("a computer may make each change its runner's work makes, all at once too, and none it may not", () => {
  const base = baseState();
  for (const change of ALLOWED) {
    const next = structuredClone(base);
    change(next);
    assert.deepEqual(C.writeDenials(base, next, scope), [], change.toString());
    assert.ok(C.same(C.keepAllowed(base, next, scope).blob, next), `kept whole: ${change}`);
  }
  const all = structuredClone(base);
  for (const change of ALLOWED) change(all);
  assert.deepEqual(C.writeDenials(base, all, scope), []);
  for (const [change, path] of REFUSED) {
    const next = structuredClone(base);
    change(next);
    assert.ok(C.writeDenials(base, next, scope).includes(path), `${path}: ${JSON.stringify(C.writeDenials(base, next, scope))}`);
    const kept = C.keepAllowed(base, next, scope);
    assert.ok(kept.held.includes(path));
    assert.ok(C.same(kept.blob, base), `${path}: put back as it was`);
  }
  assert.deepEqual(C.writeDenials({}, { bots: [] }, scope), ["state"], "never a state of its own making");
});

await check("whatever a runner's state becomes, what keepAllowed keeps is never refused, and keeps each allowed change in it (3000 mixes)", () => {
  const r = rng(11);
  for (let i = 0; i < 3000; i++) {
    const base = baseState();
    const mine = structuredClone(base);
    const allowed = ALLOWED.filter(() => r() < 0.4);
    for (const change of allowed) change(mine);
    for (const [change] of REFUSED.filter(() => r() < 0.3)) change(mine);
    const kept = C.keepAllowed(base, mine, scope);
    assert.deepEqual(C.writeDenials(base, kept.blob, scope), [], `mix ${i}`);
    const only = structuredClone(base);
    for (const change of allowed) change(only);
    // Each allowed change made is in what's kept (a refused one on the same thing may have taken it back with it).
    for (const k of ["usage", "credits", "accounts"]) if (!REFUSED.length || C.same(only[k], mine[k])) assert.ok(C.same(kept.blob[k], only[k]), `mix ${i}: ${k}`);
  }
  // A path Bops Cloud refused anyway is put back too.
  const base = baseState();
  const mine = structuredClone(base);
  mine.routines[0].nextRunAt = 7;
  const held = C.keepAllowed(base, mine, scope, ["routines.r-main.nextRunAt"]);
  assert.equal(held.blob.routines[0].nextRunAt, 1);
});

await check("what its bots may use: their chats, accounts, inboxes, lines and memory banks", () => {
  const s = {
    bots: [
      { id: "main", isMain: true, computerId: D1, access: { a2: "read" }, mail: { inboxId: "in-main", past: ["in-old"] } },
      { id: "helper", isMain: false, workspaceId: "ws_main", phone: "+1", phoneLine: { numberId: "n-h", agentId: "ag-h" } },
      { id: "iris", isMain: false, computer: "own", computerId: D2, workspaceId: "ws_two", mail: { inboxId: "in-iris" } },
    ],
    chats: [{ id: "g", botIds: ["iris", "helper"] }, { id: "g2", botIds: ["iris"] }],
    accounts: [
      { id: "a1", app: "gmail", status: "active", workspaceId: "ws_main" },
      { id: "a2", app: "notion", status: "active", workspaceId: "ws_main", onlyGiven: true },
      { id: "a3", app: "slack", status: "expired", workspaceId: "ws_main" },
    ],
    workspaces: [{ id: "ws_main", line: { numberId: "n-ws", agentId: "ag-ws" } }, { id: "ws_two", memory: { bank: "bops", peer: "user" } }],
    ownerPhones: [{ number: "+1 (415) 555-0199", verifiedAt: 1 }, { number: "+14155550100", consentAt: 1 }, { number: "+14155550111", verifiedAt: 1, userId: "someone-else" }],
  };
  assert.deepEqual([...C.chatsOn(s, D1)].sort(), ["bot:helper", "bot:main", "g"]);
  assert.deepEqual([...C.grantsOn(s, D1)].map(([id, g]) => [id, g.level]), [["a1", "act"], ["a2", "read"]], "an expired account isn't one");
  assert.deepEqual([...C.grantsOn(s, D1, "helper")].map(([id]) => id), ["a1"]);
  assert.deepEqual([...C.inboxesOn(s, D1)].sort(), ["in-main", "in-old"]);
  assert.deepEqual([...C.linesOn(s, D1).numberIds].sort(), ["n-h", "n-ws"], "the main bot's workspace line, and the helper's own");
  assert.deepEqual([...C.banksOn(s, D1)], ["bops"]);
  assert.deepEqual([...C.banksOn(s, D2)], ["bops"], "a workspace sharing the default's bank");
  assert.deepEqual([...C.ownerNumbers(s, "u1")], ["4155550199"], "verified, this user's");
});

/* ---------------- The store: a runner's side, and the Mac's ---------------- */

// Bops Cloud, faked: one user's blob and messages, a computer's write refused as cloud/state.ts does.
const cloud = { version: 1, state: {}, writer: "mac", messages: [], refused: 0, alsoRefuse: [], puts: [] };
const USER = "u_scope";
const server = createServer((req, res) => {
  let body = "";
  req.on("data", (c) => (body += c));
  req.on("end", () => {
    const send = (status, json) => res.writeHead(status, { "content-type": "application/json" }).end(JSON.stringify(json));
    const device = req.headers["x-bops-device"];
    const computer = device === RUNNER ? { desktopId: D1, device: RUNNER } : null;
    const path = req.url.split("?")[0];
    if (req.method === "GET" && path === "/v1/state") return send(200, { version: cloud.version, seq: 0, protocol: 4, writer: cloud.writer, state: cloud.state });
    if (req.method === "GET" && path === "/v1/state/head") return send(200, { version: cloud.version, seq: 0, writer: cloud.writer });
    if (req.method === "GET" && path === "/v1/messages") return send(200, { messages: [], seq: 0, more: false });
    if (req.method === "POST" && path === "/v1/messages") {
      const b = JSON.parse(body);
      if (computer) {
        const chats = C.chatsOn(cloud.state, D1);
        const bad = b.upsert.filter((m) => !chats.has(m.chatId)).map((m) => `messages.${m.id}`);
        if (bad.length) {
          cloud.refused++;
          return send(403, { code: "computer_not_allowed", paths: bad });
        }
      }
      cloud.messages.push(...b.upsert);
      return send(200, { seq: 0 });
    }
    if (req.method === "PUT" && path === "/v1/state") {
      const b = JSON.parse(body);
      if (b.base !== cloud.version) return send(409, { error: "changed", code: "state_conflict", version: cloud.version, state: cloud.state });
      if (computer) {
        // A newer Bops Cloud's rules, stricter than the runner's: these paths refused too when they change.
        const denied = [...C.writeDenials(cloud.state, b.state, computer), ...cloud.alsoRefuse.filter((x) => !C.same(x.get(cloud.state), x.get(b.state))).map((x) => x.path)];
        if (denied.length) {
          cloud.refused++;
          return send(403, { code: "computer_not_allowed", paths: denied });
        }
      }
      cloud.puts.push({ device, state: b.state });
      cloud.state = b.state;
      cloud.writer = device;
      return send(200, { version: ++cloud.version });
    }
    send(404, { error: "no such route" });
  });
});
await new Promise((r) => server.listen(0, "127.0.0.1", r));
process.env.BOPS_CLOUD_URL = `http://127.0.0.1:${server.address().port}`;

const warned = [];
const quiet = { info: console.info, warn: console.warn };
console.info = () => {};
console.warn = (...a) => void warned.push(a.join(" "));

const S = await import(`${root}/lib/server/store.ts`);
const P = await import(`${root}/lib/server/persist-cloud.ts`);
const RUNNER = P.deviceIdFor(USER, D1);

const seed = () => {
  cloud.state = {
    bots: [
      { id: "main", name: "Boppy", role: "Chief of Staff", color: "#000", isMain: true, computerId: D1, computerStatus: "ready", keys: ["K1"] },
      { id: "iris", name: "Iris", role: "Research", color: "#111", isMain: false, computer: "own", computerId: D2, computerStatus: "ready" },
    ],
    chats: [
      { id: "bot:main", kind: "bot", botIds: ["main"], createdAt: 1, typing: [] },
      { id: "bot:iris", kind: "bot", botIds: ["iris"], createdAt: 1, typing: [] },
    ],
    sessions: [],
    routines: [
      { id: "r-main", botId: "main", title: "A", goal: "a", schedule: { kind: "daily", times: ["09:00"] }, enabled: true, nextRunAt: 1 },
      { id: "r-iris", botId: "iris", title: "B", goal: "b", schedule: { kind: "daily", times: ["09:00"] }, enabled: true, nextRunAt: 1 },
    ],
  };
  cloud.version++;
  cloud.writer = "mac";
  cloud.puts.length = 0;
  cloud.messages.length = 0;
  cloud.refused = 0;
  cloud.alsoRefuse = [];
};

try {
  await check("a runner sends only what its computer may change, and messages only in its bots' chats: Bops Cloud refuses it nothing", async () => {
    process.env.BOPS_RUNNER = "1";
    process.env.BOPS_RUNNER_COMPUTER = D1;
    process.env.BOPS_DEVICE_SEED = D1;
    delete globalThis.bopsPlatformId;
    seed();
    await S.bindSignIn(USER, "sk_runner");
    assert.equal(S.stateDevice(), RUNNER);
    // Its own work, and what it may not change (a bug, or something on the computer steering it).
    S.update((s) => {
      s.sessions.push({ id: "s-run", botId: "main", chatId: "bot:main", by: RUNNER, status: "running", title: "x", goal: "x", host: "orgo", steps: [], replies: [], createdAt: 1 });
      s.routines[0].nextRunAt = 50;
      s.bots[0].keys.push("STRIPE_SECRET_KEY");
      s.routines[1].goal = "something else";
    });
    S.addMessage({ chatId: "bot:main", role: "system", text: "ran" });
    S.addMessage({ chatId: "bot:iris", role: "system", text: "not mine" });
    assert.equal(await S.flushState(3000), true);
    assert.equal(cloud.refused, 0, "nothing refused");
    const put = cloud.puts.at(-1).state;
    assert.equal(put.routines[0].nextRunAt, 50, "its routine's run went");
    assert.ok(put.sessions.some((x) => x.id === "s-run"), "its thread went");
    assert.deepEqual(put.bots[0].keys, ["K1"], "the key it gave a bot didn't");
    assert.equal(put.routines[1].goal, "b", "nor the other computer's routine's edit");
    assert.deepEqual(cloud.messages.map((m) => m.chatId), ["bot:main"], "its bot's chat only");
    assert.deepEqual(S.getState().bots[0].keys, ["K1", "STRIPE_SECRET_KEY"], "kept on the runner");
    assert.ok(warned.some((l) => l.includes("kept on this runner, not sent to Bops Cloud") && l.includes("bots.main.keys")), warned.join(" | "));
    // Said once: nothing more goes for what it holds.
    const puts = cloud.puts.length;
    warned.length = 0;
    S.update((s) => (s.routines[0].nextRunAt = 60));
    assert.equal(await S.flushState(3000), true);
    assert.equal(cloud.puts.length, puts + 1);
    assert.ok(!warned.some((l) => l.includes("bots.main.keys")), "not said again");
    // A change that's all held back is no write.
    S.update((s) => s.bots[0].keys.push("ANOTHER"));
    assert.equal(await S.flushState(3000), true);
    assert.equal(cloud.puts.length, puts + 1, "nothing sent for it");
  });

  await check("a path Bops Cloud refuses a runner anyway is held from then on, and the rest goes", async () => {
    cloud.alsoRefuse = [{ path: "routines.r-main.lastRunAt", get: (st) => st.routines?.find((r) => r.id === "r-main")?.lastRunAt }];
    S.update((s) => {
      s.routines[0].lastRunAt = 70;
      s.sessions[0].status = "done";
    });
    assert.equal(await S.flushState(3000), true);
    assert.equal(cloud.refused, 1, "refused once");
    const put = cloud.puts.at(-1).state;
    assert.equal(put.routines[0].lastRunAt, undefined, "held");
    assert.equal(put.sessions.find((x) => x.id === "s-run").status, "done", "the rest went");
    await S.releaseSignOut();
  });

  await check("the Mac takes of a runner's write only what its computer may change, and writes the rest back as it was", async () => {
    delete process.env.BOPS_RUNNER;
    delete process.env.BOPS_RUNNER_COMPUTER;
    process.env.BOPS_DEVICE_SEED = "mac-a";
    delete globalThis.bopsPlatformId;
    seed();
    await S.bindSignIn(USER, "sk_mac");
    await S.flushState(3000);
    warned.length = 0;
    // The runner's write, right after the Mac's version (a cloud from before the computer rules let it through).
    const next = structuredClone(cloud.state);
    next.routines[0].nextRunAt = 99;
    next.bots[0].keys = ["K1", "STRIPE_SECRET_KEY"];
    next.bots[1].computerId = D1;
    cloud.state = next;
    cloud.version++;
    cloud.writer = RUNNER;
    await S.pullState();
    const st = S.getState();
    assert.equal(st.routines[0].nextRunAt, 99, "its routine's run taken");
    assert.deepEqual(st.bots[0].keys, ["K1"], "the key not");
    assert.equal(st.bots[1].computerId, D2, "nor the move");
    assert.ok(warned.some((l) => l.includes(`computer ${D1}'s runner wrote what a computer may not change`)), warned.join(" | "));
    assert.equal(await S.flushState(3000), true);
    const put = cloud.puts.at(-1);
    assert.equal(put.device, P.deviceIdFor(USER, "mac-a"), "written back by the Mac");
    assert.deepEqual([put.state.bots[0].keys, put.state.bots[1].computerId, put.state.routines[0].nextRunAt], [["K1"], D2, 99]);
    // Versions it skipped: it can't tell whose each change was, and takes them (Bops Cloud's guard is the first).
    const later = structuredClone(cloud.state);
    later.bots[0].keys = ["K1", "K2"];
    cloud.state = later;
    cloud.version += 2;
    cloud.writer = RUNNER;
    await S.pullState();
    assert.deepEqual(S.getState().bots[0].keys, ["K1", "K2"]);
    // Another Mac's write: all of it.
    const mac = structuredClone(cloud.state);
    mac.bots[0].keys = ["K3"];
    cloud.state = mac;
    cloud.version++;
    cloud.writer = P.deviceIdFor(USER, "mac-b");
    await S.pullState();
    assert.deepEqual(S.getState().bots[0].keys, ["K3"]);
    await S.releaseSignOut();
  });
} finally {
  console.info = quiet.info;
  console.warn = quiet.warn;
  server.close();
  process.chdir(tmpdir());
  rmSync(scratch, { recursive: true, force: true });
}

console.log(`computer scope: ${passed} passed, ${failures} failed`);
process.exit(failures ? 1 : 0);
