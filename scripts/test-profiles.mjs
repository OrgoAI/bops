// Tests for whose state is whose on a Mac (lib/server/persist-cloud.ts, state-merge.ts, user-paths.ts,
// orgo-sign-in.ts, app/api/auth/signout): the app's state lives in Bops Cloud under the signed-in Orgo
// user, never in a file on the Mac. One account signs in, chats, adds a bot and a phone link, signs out;
// another signs in and sees none of it; the first signs back in and has it all, from the cloud. The
// state file from before goes to its own user only, and one that's nobody's for sure is kept aside.
// Writes made offline wait and go up once the cloud is back; a sign-out with unsent changes asks
// first. Another Mac's changes are merged in, never over this Mac's unsent ones, and a second Mac's
// older state file never writes over what's newer in the cloud. A sign-in landing over another
// account's, and a bot's turn still waiting on the model across a sign-out and another sign-in,
// leave nothing of the first account in the second's state.
//
// Bops Cloud is the real one (cloud/server.ts, run as a child process) on the local test Postgres
// (BOPS_TEST_DATABASE_URL, as cloud/test/edge-fakes.ts: 127.0.0.1:55432); Orgo is a fake on
// 127.0.0.1; the Keychain is a folder; Bops Cloud's tunnel, the relay, the bots' sessions and the Mac check are
// stand-ins. Nothing reaches a real service.
// Usage: node --conditions=react-server scripts/test-profiles.mjs
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { randomBytes } from "node:crypto";
import { existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, statSync, symlinkSync, writeFileSync } from "node:fs";
import { createServer } from "node:http";
import { createRequire, registerHooks } from "node:module";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

const root = new URL("..", import.meta.url).pathname.replace(/\/$/, "");
const require = createRequire(import.meta.url);
const ts = require("typescript");
const pg = require("pg");
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
async function until(check, what, ms = 8000) {
  for (const end = Date.now() + ms; Date.now() < end; await sleep(25)) {
    const v = await check();
    if (v) return v;
  }
  assert.fail(`timed out waiting for ${what}`);
}

const DB = process.env.BOPS_TEST_DATABASE_URL || "postgres://bops_app:bops-local@127.0.0.1:55432/orgo_edge";
for (const k of Object.keys(process.env)) if (/^(BOPS|OPENAI|AGENTPHONE|AGENTMAIL|HONCHO|COMPOSIO|TYPESAFE|TWILIO|ORGO)_/.test(k)) delete process.env[k];

// A throwaway home and working folder (.data, ~/.bops, the Keychain).
const scratch = mkdtempSync(join(tmpdir(), "bops-test-profiles-"));
process.chdir(scratch);
process.env.HOME = scratch;
symlinkSync(join(root, "node_modules"), join(scratch, "node_modules"));
const bin = join(scratch, "bin");
mkdirSync(bin);
mkdirSync(join(scratch, "keychain"));
process.env.BOPS_TEST_KEYCHAIN = join(scratch, "keychain");
// macOS's `security`, with a folder for a Keychain (as scripts/test-cloud.mjs).
writeFileSync(
  join(bin, "security"),
  `#!/usr/bin/env node
const fs = require("fs"), path = require("path");
const file = (a) => path.join(process.env.BOPS_TEST_KEYCHAIN, encodeURIComponent(a));
const arg = (args, flag) => args[args.indexOf(flag) + 1];
function run(args) {
  if (args[0] === "find-generic-password") {
    if (!fs.existsSync(file(arg(args, "-a")))) process.exit(44);
    process.stdout.write(fs.readFileSync(file(arg(args, "-a")), "utf8") + "\\n");
  } else if (args[0] === "delete-generic-password") fs.rmSync(file(arg(args, "-a")), { force: true });
  else if (args[0] === "add-generic-password") {
    // A slow Keychain, when a test asks for one.
    if (process.env.BOPS_TEST_KEYCHAIN_SLOW_MS) Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, Number(process.env.BOPS_TEST_KEYCHAIN_SLOW_MS));
    fs.writeFileSync(file(arg(args, "-a")), Buffer.from(arg(args, "-X"), "hex").toString("utf8"));
  }
  else process.exit(1);
}
if (process.argv[2] === "-i") {
  let input = "";
  process.stdin.on("data", (d) => (input += d)).on("end", () => run(input.trim().match(/"[^"]*"|\\S+/g).map((x) => x.replace(/^"|"$/g, ""))));
} else run(process.argv.slice(2));
`,
  { mode: 0o755 },
);
process.env.PATH = `${bin}:${process.env.PATH}`;
const keychain = () => readdirSync(join(scratch, "keychain")).map(decodeURIComponent).sort();

const freePort = () =>
  new Promise((resolve) => {
    const s = createServer().listen(0, "127.0.0.1", () => {
      const { port } = s.address();
      s.close(() => resolve(port));
    });
  });

/* ---------------- Orgo, faked: the device-code sign-in and who a key is ---------------- */

const run = randomBytes(3).toString("hex");
const A = `prof-a-${run}`;
const B = `prof-b-${run}`;
const D = `prof-d-${run}`;
const users = [A, B, D];
const keyOf = (id) => `key-${id}`;
/** Who the next approved sign-in is. */
const orgo = { next: null };
const orgoServer = createServer((req, res) => {
  const chunks = [];
  req.on("data", (c) => chunks.push(c));
  req.on("end", () => {
    const send = (status, body) => res.writeHead(status, { "content-type": "application/json" }).end(JSON.stringify(body));
    const url = new URL(req.url, "http://orgo");
    if (url.pathname === "/api/user/profile") {
      const id = /^Bearer key-(.+)$/.exec(req.headers.authorization ?? "")?.[1];
      return id ? send(200, { id, email: `${id}@example.com`, full_name: `User ${id.split("-")[1].toUpperCase()}` }) : send(401, { error: "no" });
    }
    if (url.pathname === "/api/cli/auth/start")
      return send(200, { device_code: `device-${randomBytes(4).toString("hex")}`, user_code: "ABC-DEF-GHJ", verification_uri_complete: `http://orgo/cli/approve?code=ABC-DEF-GHJ`, interval_seconds: 1, expires_in_seconds: 600 });
    if (url.pathname === "/api/cli/auth/poll") return send(200, { status: "approved", api_key: keyOf(orgo.next), user: { id: orgo.next, email: `${orgo.next}@example.com` } });
    send(404, { error: "not faked" });
  });
});
await new Promise((r) => orgoServer.listen(0, "127.0.0.1", r));
const ORGO = `http://127.0.0.1:${orgoServer.address().port}`;
process.env.BOPS_ORGO_ORIGIN = ORGO;

/* ---------------- Bops Cloud: the real server, on the test Postgres ---------------- */

const db = new pg.Pool({ connectionString: DB, max: 2 });
try {
  await db.query("SELECT 1");
} catch (e) {
  console.error(`test-profiles needs the local test Postgres (${DB.replace(/:[^:@/]+@/, ":***@")}): ${e.message}`);
  process.exit(1);
}
const cloudPort = await freePort();
const CLOUD = `http://127.0.0.1:${cloudPort}`;
process.env.BOPS_CLOUD_URL = CLOUD;
const cloud = { child: null, log: "" };
async function startCloudServer() {
  const child = spawn(process.execPath, [join(root, "cloud/server.ts")], {
    env: { PATH: process.env.PATH, HOME: scratch, BOPS_DATABASE_URL: DB, BOPS_CLOUD_PORT: String(cloudPort), BOPS_CLOUD_SECRET: randomBytes(32).toString("base64"), BOPS_ORGO_ORIGIN: ORGO },
    stdio: ["ignore", "pipe", "pipe"],
  });
  cloud.child = child;
  child.stdout.on("data", (d) => (cloud.log += d));
  child.stderr.on("data", (d) => (cloud.log += d));
  await until(() => cloud.log.includes(`listening on 127.0.0.1:${cloudPort}`), "Bops Cloud to start", 20_000);
}
async function stopCloudServer() {
  const child = cloud.child;
  cloud.child = null;
  cloud.log = "";
  child.kill("SIGKILL");
  await new Promise((r) => child.once("exit", r));
}
await startCloudServer();

/** A call to the cloud as a user's newer build would make it (to look at what's there, or be another Mac). */
async function asUser(id, path, init = {}) {
  const res = await fetch(`${CLOUD}${path}`, {
    method: init.method ?? "GET",
    headers: { Authorization: `Bearer ${keyOf(id)}`, "x-bops-user": id, "x-bops-protocol": "2", "x-bops-device": init.device ?? "other-mac", "content-type": "application/json" },
    body: init.body === undefined ? undefined : JSON.stringify(init.body),
  });
  return { status: res.status, body: await res.json().catch(() => null) };
}
const cloudMessages = async (id) => (await asUser(id, "/v1/messages?after=0&limit=5000")).body.messages.map((m) => m.json);
const cloudState = async (id) => (await asUser(id, "/v1/state")).body;

/* ---------------- The state file from before: user A's ---------------- */

const LEGACY_TEXT = "From before: remember the blue folder";
mkdirSync(join(scratch, ".data", "uploads"), { recursive: true });
writeFileSync(join(scratch, ".data", "uploads", "img_legacy1.png"), "png");
writeFileSync(
  join(scratch, ".data", "state.json"),
  JSON.stringify({
    account: { user: { id: A, email: `${A}@example.com` }, signedInAt: 1 },
    cloudUser: A,
    computersOf: A,
    owner: { name: "User A", about: "Likes blue folders" },
    bots: [
      { id: "boppy", name: "Boppy", role: "Chief of Staff", color: "#0A0A0A", isMain: true, computerStatus: "none" },
      { id: "legacybot", name: "Lex", role: "Research", color: "#47C46B", isMain: false, computerStatus: "none" },
    ],
    chats: [],
    messages: [{ id: "msg_legacy1", chatId: "chat_boppy", role: "user", text: LEGACY_TEXT, at: 1_700_000_000_000 }],
    sessions: [],
    routines: [],
    host: "orgo",
    relay: { on: false, turnedOff: true },
  }),
);

/* ---------------- The app's modules ---------------- */

// Modules that would start something (Bops Cloud's tunnel, the relay, the bots' sessions, the Mac
// check that installs the Codex CLI, the desktop and mirror) are stand-ins: each of their exports does nothing.
const STAND_INS = new Set(["cloud-tunnel", "relay", "sessions", "mac", "desktop", "mirror"]);
const project = pathToFileURL(root).href + "/";
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
    if (!url.startsWith(project) || url.includes("/node_modules/") || !/\.tsx?$/.test(url)) return next(url, context);
    const file = fileURLToPath(url);
    const source = readFileSync(file, "utf8");
    const name = url.match(/\/lib\/server\/([a-z-]+)\.ts$/)?.[1];
    // OpenAI, faked: each call waits until the test lets it answer (a bot's turn in flight), then says `reply`.
    if (name === "openai-client")
      return {
        format: "module",
        shortCircuit: true,
        source: `const fake = (globalThis.__fakeOpenAI ??= { calls: 0, gate: Promise.resolve(), reply: "" });
export function openaiClient() {
  return { responses: { create: async () => { fake.calls++; await fake.gate; return { id: "resp_fake", model: "fake", usage: undefined, output: [], output_text: fake.reply }; } } };
}`,
      };
    if (name && STAND_INS.has(name)) {
      const names = [...source.matchAll(/^export (?:async )?(?:function\*? |const |let |class )([A-Za-z_$][\w$]*)/gm)].map((m) => m[1]);
      return { format: "module", shortCircuit: true, source: names.map((n) => `export const ${n} = function () { return Promise.resolve(); };`).join("\n") };
    }
    const { outputText } = ts.transpileModule(source, { fileName: file, compilerOptions: { module: ts.ModuleKind.ESNext, target: ts.ScriptTarget.ES2022, jsx: ts.JsxEmit.ReactJSX } });
    return { format: "module", source: outputText, shortCircuit: true };
  },
});

const quiet = { info: console.info, warn: console.warn, error: console.error };
console.info = () => {};
console.warn = () => {};

const S = await import(`${root}/lib/server/store.ts`);
const L = await import(`${root}/lib/server/orgo-sign-in.ts`);
const U = await import(`${root}/lib/server/user-paths.ts`);
const Up = await import(`${root}/lib/server/uploads.ts`);
const K = await import(`${root}/lib/server/keychain.ts`);
const M = await import(`${root}/lib/server/state-merge.ts`);
const SO = await import(`${root}/app/api/auth/signout/route.ts`);
const OA = await import(`${root}/lib/server/orgo-auth.ts`);
const OW = await import(`${root}/app/api/owner/route.ts`);
const setOwner = async (name) => {
  const res = await OW.POST(new Request("http://localhost/api/owner", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ name }) }));
  return res.status;
};

const dataFiles = () => {
  const out = [];
  const walk = (d) => {
    for (const f of existsSync(d) ? readdirSync(d) : []) {
      const p = join(d, f);
      if (statSync(p).isDirectory()) walk(p);
      else out.push(p.slice(scratch.length + 1));
    }
  };
  walk(join(scratch, ".data"));
  return out.sort();
};
/** No state file anywhere on the Mac but the ones set aside. */
const noStateFile = (what) => assert.deepEqual(dataFiles().filter((f) => /(^|\/)state\.json(\.tmp)?$/.test(f) && !f.startsWith(".data/legacy/")), [], what);

async function signIn(id) {
  orgo.next = id;
  await L.startSignIn();
  const r = await L.pollSignIn();
  assert.equal(r.status, "approved", `${id} signed in`);
  assert.equal(r.user.id, id);
  assert.equal(S.getState().account?.user.id, id);
  assert.equal(S.stateReady(), true);
}
async function signOut(body = {}) {
  const res = await SO.POST(new Request("http://localhost/api/auth/signout", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(body) }));
  return { status: res.status, body: await res.json() };
}
const texts = () => S.getState().messages.map((m) => m.text);
const botNames = () => S.getState().bots.map((b) => b.name);

try {
  /* ---------------- First start: the file from before goes to its user, and nothing is loaded ---------------- */

  assert.equal(existsSync(join(scratch, ".data", "state.json")), false, "the shared state file is gone at once");
  const waiting = join(scratch, ".data", "users", U.scopeOf(A), "legacy-state.json");
  assert.equal(existsSync(waiting), true, "it waits in A's folder, to go to A's cloud at A's sign-in");
  assert.equal(existsSync(join(scratch, ".data", "users", U.scopeOf(A), "uploads", "img_legacy1.png")), true, "what was beside it went with it");
  assert.equal(S.stateReady(), false, "signed out: no state to work on");
  assert.equal(texts().includes(LEGACY_TEXT), false);
  assert.throws(() => S.installId(), /Sign in to Bops first/, "nothing outside is made for nobody");
  assert.equal(S.userDir(), null);
  assert.equal(await setOwner("Nobody"), 409, "routes that change the state wait for one");
  console.log("first start: the file from before waits for its own user; signed out there's no state");

  /* ---------------- A signs in: their state from before goes up to their cloud ---------------- */

  await signIn(A);
  assert.ok(texts().includes(LEGACY_TEXT), "A's chat from before");
  assert.ok(botNames().includes("Lex"), "A's bot from before");
  assert.equal(S.getState().owner?.about, "Likes blue folders");
  assert.equal(S.getState().relay?.turnedOff, true, "this Mac's own setting, kept for this Mac");
  assert.equal(await S.flushState(10_000), true);
  await until(() => !existsSync(waiting), "the file from before to be removed once it's all up");
  assert.ok((await cloudMessages(A)).some((m) => m.text === LEGACY_TEXT), "in A's cloud");
  const a0 = await cloudState(A);
  assert.equal(a0.protocol, 2);
  assert.ok(a0.state.bots.some((b) => b.name === "Lex"));
  assert.equal(a0.state.messages, undefined, "messages are rows, never in the blob");
  assert.equal(a0.state.account, undefined, "who's signed in stays on the Mac");
  const device = Object.keys(a0.state.macs ?? {})[0];
  assert.deepEqual(a0.state.macs[device].relay, { on: false, turnedOff: true }, "this Mac's own, under its id");
  console.log("A signs in: the state from before is A's in the cloud, and its file is gone");

  // A chats, adds a bot and a phone link.
  S.addMessage({ chatId: "chat_boppy", role: "user", text: "A: book the dentist" });
  S.addMessage({ chatId: "chat_boppy", role: "bot", botId: "boppy", text: "Booked for Tuesday." });
  S.update((s) => {
    s.bots.push({ id: "otto", name: "Otto", role: "Outbound", color: "#E9FF3B", isMain: false, computerStatus: "none", phone: "+14155550123" });
    s.workspaces[0].line = { phone: "+14155550123", numberId: "num_a", agentId: "agt_a", type: "sms" };
    s.ownerPhones = [{ number: "+14155550199", consentAt: 1, verifiedAt: 2, userId: A }];
  });
  const img = Up.saveUpload(`data:image/png;base64,${Buffer.from("a-image").toString("base64")}`);
  assert.ok(Up.uploadPath(img.id).path.includes(join(".data", "users", U.scopeOf(A), "uploads")), "A's image in A's folder");
  await K.setUserSecret("login_a1:password", "a-secret");
  assert.ok(keychain().includes(`${A}:login_a1:password`), "A's vault password under A's name");
  assert.equal(await S.flushState(10_000), true);
  noStateFile("signed in, nothing is written to a state file");
  const aMessages = await cloudMessages(A);
  assert.ok(aMessages.some((m) => m.text === "A: book the dentist") && aMessages.some((m) => m.text === "Booked for Tuesday."));
  const a1 = await cloudState(A);
  assert.ok(a1.state.bots.some((b) => b.name === "Otto" && b.phone === "+14155550123"));
  assert.equal(a1.state.workspaces[0].line.phone, "+14155550123");
  console.log("A chats, adds a bot and a phone link: each message a row, the rest in the blob");

  // A big chat: written in batches, every message its own row.
  const big = Array.from({ length: 3000 }, (_, i) => ({ id: `msg_big${String(i).padStart(5, "0")}`, chatId: "chat_boppy", role: i % 2 ? "bot" : "user", botId: i % 2 ? "boppy" : undefined, text: `line ${i} `.repeat(20), at: 1_800_000_000_000 + i }));
  S.update((s) => s.messages.push(...big));
  const sent = Date.now();
  assert.equal(await S.flushState(30_000), true);
  assert.equal((await cloudMessages(A)).length, 3000 + 3, "3,000 more rows");
  const tookMs = Date.now() - sent;
  // Then one more line is one row, not the whole chat again.
  S.addMessage({ chatId: "chat_boppy", role: "user", text: "A: one more" });
  const before = await asUser(A, "/v1/state/head");
  assert.equal(await S.flushState(10_000), true);
  const changed = (await asUser(A, `/v1/messages?after=${before.body.seq}`)).body.messages;
  assert.deepEqual(changed.map((m) => m.json.text), ["A: one more"]);
  console.log(`a big chat: 3,000 messages up in ${tookMs} ms, and a new line after is one row`);

  /* ---------------- A signs out; B signs in and sees nothing of A's ---------------- */

  let out = await signOut();
  assert.equal(out.status, 200);
  assert.equal(out.body.signedIn, false);
  assert.equal(S.stateReady(), false);
  assert.equal(S.getState().account, undefined);
  assert.equal(texts().length, 0, "A's chats left memory");
  assert.equal(keychain().includes("orgo-api-key"), false, "A's key left the Keychain");

  await signIn(B);
  assert.equal(texts().some((t) => t.startsWith("A:") || t === LEGACY_TEXT || t === "Booked for Tuesday."), false, "none of A's chats");
  assert.equal(S.getState().messages.length, 0);
  assert.deepEqual(botNames(), ["Boppy"], "none of A's bots");
  assert.equal(S.getState().bots.some((b) => b.phone), false, "no phone link of A's");
  assert.equal(S.getState().workspaces.some((w) => w.line), false);
  assert.equal(S.getState().ownerPhones, undefined, "no number A verified");
  assert.equal(S.getState().owner?.about, undefined);
  assert.equal(S.getState().owner?.name, `User ${B.split("-")[1].toUpperCase()}`, "B's own name from Orgo");
  assert.equal(Up.uploadPath(img.id), null, "A's images aren't B's");
  assert.equal(await K.getUserSecret("login_a1:password"), null, "A's vault password isn't B's");
  assert.notEqual(S.userChrome(), null);
  assert.ok(S.userChrome().endsWith(U.scopeOf(B)), "B's bots get their own Chrome profiles");
  S.addMessage({ chatId: "chat_boppy", role: "user", text: "B: hello" });
  assert.equal(await S.flushState(10_000), true);
  assert.deepEqual((await cloudMessages(B)).map((m) => m.text), ["B: hello"], "B's cloud has only B's");
  assert.equal((await cloudMessages(A)).some((m) => m.text === "B: hello"), false, "and A's none of B's");
  noStateFile("B signed in, no state file either");
  console.log("A signs out, B signs in: nothing of A's (chats, bots, phone link, images, vault)");

  /* ---------------- Offline: writes wait, a sign-out asks, and they go once the cloud is back ---------------- */

  await stopCloudServer();
  S.addMessage({ chatId: "chat_boppy", role: "user", text: "B: written offline" });
  S.update((s) => (s.owner = { name: "B renamed offline" }));
  assert.equal(await S.flushState(1500), false, "can't go up");
  assert.equal(S.unsentState(), true);
  assert.ok(texts().includes("B: written offline"), "the app keeps working from memory");
  out = await signOut();
  assert.deepEqual([out.status, out.body], [409, { unsent: true }], "a sign-out asks first");
  assert.equal(S.getState().account?.user.id, B, "and does nothing until told");
  await startCloudServer();
  assert.equal(await S.flushState(15_000), true, "up once the cloud is back");
  assert.equal(S.unsentState(), false);
  assert.ok((await cloudMessages(B)).some((m) => m.text === "B: written offline"));
  assert.equal((await cloudState(B)).state.owner.name, "B renamed offline");
  console.log("offline: writes wait in memory, a sign-out asks first, and they go up when the cloud is back");

  /* ---------------- Another Mac of B's ---------------- */

  // It writes the blob (a new bot) and a message; this Mac changed something else meanwhile.
  const head = (await asUser(B, "/v1/state/head")).body;
  const theirs = (await cloudState(B)).state;
  assert.equal((await asUser(B, "/v1/state", { method: "PUT", body: { base: head.version, state: { ...theirs, bots: [...theirs.bots, { id: "mira", name: "Mira", role: "Design", color: "#5B8CFF", isMain: false, computerStatus: "none" }] } } })).status, 200);
  await asUser(B, "/v1/messages", { method: "POST", body: { upsert: [{ id: "msg_othermac", chatId: "chat_boppy", role: "user", text: "B on the other Mac", at: Date.now() }], remove: [] } });
  S.update((s) => (s.owner = { name: "B", about: "Set on this Mac" }));
  assert.equal(await S.flushState(10_000), true, "a 409, merged, and written over theirs");
  await S.pullState();
  assert.ok(botNames().includes("Mira"), "the other Mac's bot is here");
  assert.equal(S.getState().owner.about, "Set on this Mac", "and this Mac's change stands");
  assert.ok(texts().includes("B on the other Mac"), "the other Mac's message is here");
  const merged = (await cloudState(B)).state;
  assert.ok(merged.bots.some((b) => b.name === "Mira"));
  assert.equal(merged.owner.about, "Set on this Mac");
  console.log("another Mac: its changes merge in, this Mac's stand, nothing is written over");

  /* ---------------- Signed out offline anyway; the next sign-in waits for the cloud ---------------- */

  await stopCloudServer();
  S.addMessage({ chatId: "chat_boppy", role: "user", text: "B: last words offline" });
  out = await signOut({ force: true });
  assert.equal(out.status, 200, "told to, it signs out");
  assert.equal(S.stateReady(), false);
  assert.equal(texts().length, 0, "B's state left memory, unsent changes and all");
  // A signs in while the cloud is away: refused (there's no state to give them), nothing of B's shown.
  orgo.next = A;
  await L.startSignIn();
  await assert.rejects(L.pollSignIn(), (e) => e instanceof L.SignInError && e.reason === "cloud", "Couldn't load your Bops from Bops Cloud");
  assert.equal(S.stateReady(), false);
  assert.equal(S.getState().account, undefined);
  assert.equal(keychain().includes("orgo-api-key"), false, "the key isn't kept until the state loads");
  await startCloudServer();
  // Try again: the key Orgo gave is still held, so no new code.
  const again = await L.pollSignIn();
  assert.equal(again.status, "approved");
  assert.equal(S.getState().account?.user.id, A);
  assert.equal(texts().includes("B: last words offline"), false, "B's unsent changes never land in A's state");
  await until(async () => (await cloudMessages(B)).some((m) => m.text === "B: last words offline"), "B's last changes to reach B's own cloud", 20_000);
  assert.equal((await cloudMessages(A)).some((m) => m.text === "B: last words offline"), false);
  console.log("signed out offline: B's unsent changes go to B's cloud later; A's sign-in waits for the cloud, then loads only A's");

  /* ---------------- A signs back in: everything from the cloud ---------------- */
  for (const t of [LEGACY_TEXT, "A: book the dentist", "Booked for Tuesday.", "A: one more"]) assert.ok(texts().includes(t), `A's "${t}"`);
  assert.equal(S.getState().messages.length, 3000 + 4);
  assert.equal(texts().some((t) => /^B[: ]/.test(t)), false, "none of B's");
  assert.ok(botNames().includes("Otto") && botNames().includes("Lex"));
  assert.equal(botNames().includes("Mira"), false);
  assert.equal(S.getState().bots.find((b) => b.id === "otto").phone, "+14155550123", "A's phone link");
  assert.equal(S.getState().workspaces[0].line.phone, "+14155550123");
  assert.deepEqual(S.getState().ownerPhones.map((p) => p.number), ["+14155550199"]);
  assert.equal(S.getState().relay?.turnedOff, true, "this Mac's own setting, back for this Mac");
  assert.equal(Up.uploadPath(img.id) !== null, true, "A's image again");
  assert.equal(await K.getUserSecret("login_a1:password"), "a-secret", "A's vault password again");
  // In order: the messages read back are oldest first.
  const ats = S.getState().messages.map((m) => m.at);
  assert.deepEqual(ats, [...ats].sort((x, y) => x - y));
  noStateFile("A signed in again, no state file");
  console.log("A signs back in: chats, bots, phone link, images and vault, all from the cloud");

  /* ---------------- The server starts with A's key in the Keychain ---------------- */

  assert.equal(await setOwner("User A"), 200);
  assert.equal(await S.flushState(10_000), true);
  // As a new start: nobody's state in memory, the key still here. The cloud is away at first.
  await S.releaseSignOut();
  await stopCloudServer();
  console.error = () => {};
  let st = await L.authStatus();
  console.error = quiet.error;
  assert.deepEqual([st.signedIn, st.needsSignIn, st.cloudProblem], [false, false, true], "can't reach Bops Cloud: says so, no sign-in asked");
  assert.equal(S.stateReady(), false);
  await startCloudServer();
  st = await L.authStatus({ retry: true });
  assert.deepEqual([st.signedIn, st.cloudProblem, st.user?.id], [true, false, A], "Try again: loaded");
  assert.ok(texts().includes("A: book the dentist"));
  assert.equal(S.getState().owner.name, "User A");
  console.log("starting with the key in the Keychain: the state loads from the cloud, and says so while it can't");

  /* ---------------- A file that's nobody's for sure ---------------- */

  // Another account signed in on top of A's state (the bug this fixes): it names both.
  writeFileSync(
    join(scratch, ".data", "state.json"),
    JSON.stringify({ account: { user: { id: D } }, cloudUser: A, owner: { name: "Mixed" }, bots: [{ id: "boppy", name: "Boppy", isMain: true }], messages: [{ id: "msg_mixed", chatId: "chat_boppy", role: "user", text: "Whose is this?", at: 1 }] }),
  );
  assert.equal(U.legacyOwner(JSON.parse(readFileSync(join(scratch, ".data", "state.json"), "utf8"))), null);
  const moved = U.moveLegacyState("legacy-state.json", true);
  assert.equal(moved.owner, null);
  assert.ok(moved.to.includes(join(".data", "legacy")), "kept aside");
  assert.equal(existsSync(join(scratch, ".data", "state.json")), false);
  assert.equal(existsSync(join(scratch, ".data", "users", U.scopeOf(D), "legacy-state.json")), false, "not waiting for anyone");
  assert.equal((await signOut()).status, 200);
  await signIn(D);
  assert.equal(texts().includes("Whose is this?"), false, "not uploaded for whoever signs in");
  assert.equal(S.getState().owner?.name.includes("Mixed"), false);
  assert.equal(await S.flushState(10_000), true);
  assert.equal((await cloudMessages(D)).some((m) => m.text === "Whose is this?"), false);
  assert.equal((await cloudMessages(A)).some((m) => m.text === "Whose is this?"), false);
  assert.equal(existsSync(moved.to), true, "the file stays aside");
  // And one that names only one user is theirs (the same rule as at the first start).
  assert.equal(U.legacyOwner({ account: { user: { id: A } }, cloudUser: A, computersOf: A, ownerPhones: [{ userId: A }] }), A);
  assert.equal(U.legacyOwner({ cloudUser: A }), A, "signed out, but its backup was A's");
  assert.equal(U.legacyOwner({ owner: { name: "x" } }), null, "from before sign-in: nobody's for sure");
  assert.equal(U.legacyOwner({ cloudUser: A, computersOf: B }), null);
  console.log("a file that's nobody's for sure is kept aside, never uploaded for whoever signs in");

  /* ---------------- Another Mac writes first, right after a load or a read: this Mac's changes stand ---------------- */

  const otherMacWrites = async (id, change) => {
    const h = (await asUser(id, "/v1/state/head")).body;
    const cur = (await cloudState(id)).state;
    assert.equal((await asUser(id, "/v1/state", { method: "PUT", body: { base: h.version, state: change(cur) } })).status, 200);
  };
  const dMsg = S.addMessage({ chatId: "chat_boppy", role: "user", text: "D: the newest words" });
  assert.equal(await S.flushState(10_000), true);
  // As a new start: D's state loads from the cloud. The other Mac writes before this Mac's first save;
  // meanwhile this Mac changes a bot in place, as the app's routes do.
  await S.releaseSignOut();
  await S.bindSignIn(D, keyOf(D));
  await otherMacWrites(D, (cur) => ({ ...cur, owner: { ...cur.owner, about: "Set on the other Mac" } }));
  S.update((s) => void (s.bots.find((b) => b.id === "boppy").role = "Changed on this Mac"));
  assert.equal(await S.flushState(10_000), true);
  let dNow = (await cloudState(D)).state;
  assert.equal(dNow.bots.find((b) => b.id === "boppy").role, "Changed on this Mac", "this Mac's change survives a conflict right after a load");
  assert.equal(dNow.owner.about, "Set on the other Mac");
  assert.equal(S.getState().bots.find((b) => b.id === "boppy").role, "Changed on this Mac");
  // The other Mac adds a bot; this Mac reads it in and edits it; the other Mac writes again first.
  await otherMacWrites(D, (cur) => ({ ...cur, bots: [...cur.bots, { id: "zed", name: "Zed", role: "Original", color: "#5B8CFF", isMain: false, computerStatus: "none" }] }));
  await S.pullState();
  assert.ok(botNames().includes("Zed"), "the other Mac's bot is read in");
  S.update((s) => void (s.bots.find((b) => b.id === "zed").role = "Edited on this Mac"));
  await otherMacWrites(D, (cur) => ({ ...cur, owner: { ...cur.owner, about: "Other Mac again" } }));
  await S.pullState();
  assert.equal(S.getState().bots.find((b) => b.id === "zed").role, "Edited on this Mac", "a read doesn't undo an unsent change");
  assert.equal(await S.flushState(10_000), true);
  dNow = (await cloudState(D)).state;
  assert.equal(dNow.bots.find((b) => b.id === "zed").role, "Edited on this Mac", "and it goes up");
  assert.equal(dNow.owner.about, "Other Mac again");
  console.log("another Mac writing first, right after a load or a read: this Mac's unsent changes stand");

  /* ---------------- A second Mac's state file from before, older than what's in the cloud now ---------------- */

  // D upgrades another Mac whose state file is from before D started on this build: what the cloud has
  // since stands, and the file only adds what the cloud never had.
  const dDir = join(scratch, ".data", "users", U.scopeOf(D));
  const dLegacy = join(dDir, "legacy-state.json");
  mkdirSync(dDir, { recursive: true });
  writeFileSync(
    dLegacy,
    JSON.stringify({
      account: { user: { id: D } },
      cloudUser: D,
      owner: { name: "Stale name", about: "Stale about" },
      bots: [
        { id: "boppy", name: "Boppy", role: "Stale role", color: "#0A0A0A", isMain: true, computerStatus: "none" },
        { id: "oldbot", name: "Olde", role: "Archive", color: "#47C46B", isMain: false, computerStatus: "none" },
      ],
      messages: [
        { ...dMsg, text: "D: stale copy of the newest words" },
        { id: "msg_other_mac_file", chatId: "chat_boppy", role: "user", text: "Only in the other Mac's file", at: 2 },
      ],
    }),
  );
  await S.releaseSignOut();
  await S.bindSignIn(D, keyOf(D));
  assert.equal(S.getState().bots.find((b) => b.id === "boppy").role, "Changed on this Mac", "the cloud's newer bot stands");
  assert.equal(S.getState().owner.about, "Other Mac again", "and its newer settings");
  assert.ok(botNames().includes("Olde") && botNames().includes("Zed"), "the file's bot comes in, the cloud's stays");
  assert.ok(texts().includes("D: the newest words") && !texts().includes("D: stale copy of the newest words"), "the cloud's newer message stands");
  assert.ok(texts().includes("Only in the other Mac's file"));
  assert.equal(await S.flushState(10_000), true);
  await until(() => !existsSync(dLegacy), "the file to go once it's up");
  dNow = (await cloudState(D)).state;
  assert.equal(dNow.bots.find((b) => b.id === "boppy").role, "Changed on this Mac");
  assert.equal(dNow.owner.about, "Other Mac again");
  assert.ok((await cloudMessages(D)).some((m) => m.text === "Only in the other Mac's file"));
  assert.equal((await cloudMessages(D)).some((m) => m.text === "D: stale copy of the newest words"), false);
  console.log("a second Mac's older state file adds what the cloud lacks and never writes over what's newer");

  /* ---------------- Another account signs in over A, while the app asks who's signed in ---------------- */

  assert.equal((await signOut()).status, 200);
  await signIn(A);
  // B's sign-in lands on top of A's (no sign-out first). While B's state is still loading (the cloud
  // is slow), the app asks who's signed in: A's key is still the one in memory, but A's state must not
  // come back over B's.
  cloud.child.kill("SIGSTOP");
  orgo.next = B;
  await L.startSignIn();
  const switching = L.pollSignIn();
  await sleep(300);
  const asking = L.authStatus();
  await sleep(300);
  cloud.child.kill("SIGCONT");
  assert.equal((await switching).status, "approved");
  await asking;
  await sleep(1500);
  assert.equal(S.getState().account?.user.id, B, "B is signed in");
  assert.equal(S.stateUser(), B, "and B's state is the one in memory");
  assert.equal(texts().some((t) => t.startsWith("A:") || t === LEGACY_TEXT), false, "none of A's chats");
  assert.equal(botNames().includes("Otto"), false, "none of A's bots");
  const st2 = await L.authStatus();
  assert.deepEqual([st2.signedIn, st2.user?.id], [true, B]);
  console.log("another account signing in over A while the app asks who's signed in: only B's state, B's key");

  /* ---------------- A bot's turn still waiting on the model when A signs out and B signs in ---------------- */

  const C = await import(`${root}/lib/server/chat.ts`);
  assert.equal((await signOut()).status, 200);
  await signIn(A);
  const fake = globalThis.__fakeOpenAI;
  let answer;
  fake.gate = new Promise((r) => (answer = r));
  fake.reply = "A's private answer: the safe code is 4417";
  const callsBefore = fake.calls;
  const turn = C.handleMessage("bot:boppy", "A: what's the safe code?");
  await until(() => fake.calls > callsBefore, "A's bot to be waiting on the model", 20_000);
  const ours = S.sameState();
  assert.equal((await signOut()).status, 200);
  await signIn(B);
  assert.equal(ours(), false, "the state A's turn started on is gone");
  answer();
  await turn;
  await sleep(200);
  assert.equal(texts().some((t) => t.includes("4417") || t.startsWith("Something went wrong")), false, "A's answer never lands in B's chat");
  assert.equal(S.getState().chats.find((c) => c.id === "bot:boppy").typing.length, 0, "nor A's bot typing there");
  assert.equal(await S.flushState(10_000), true);
  assert.equal((await cloudMessages(B)).some((m) => m.text.includes("4417")), false, "nor in B's cloud");
  console.log("a bot's turn in flight across a sign-out and another sign-in: nothing of it lands in the new account");

  /* ---------------- Bops stops while Bops Cloud is away: what's unsent waits on this Mac ---------------- */

  // B changes things with the cloud away (a message, the blob, a message removed), then Bops stops (or restarts).
  await stopCloudServer();
  S.addMessage({ chatId: "chat_boppy", role: "user", text: "B: kept on this Mac" });
  S.update((s) => {
    s.owner = { ...s.owner, about: "Kept while offline" };
    s.messages = s.messages.filter((m) => m.id !== "msg_othermac");
  });
  await globalThis.__bopsExitWork.get("state")();
  const keptFile = join(scratch, ".data", "users", U.scopeOf(B), "unsent-state.json");
  assert.equal(existsSync(keptFile), true, "what the cloud didn't take is kept in B's folder");
  assert.equal(statSync(keptFile).mode & 0o777, 0o600, "readable by this Mac's user alone");
  assert.equal(existsSync(join(scratch, ".data", "users", U.scopeOf(A), "unsent-state.json")), false, "and nowhere else");
  // The process ends: nothing of B's is in memory any more, nothing is sending.
  const box = globalThis.__bopsCloudStore;
  clearTimeout(box.timer);
  box.timer = undefined;
  box.sync = undefined;
  box.failures = 0;
  for (const a of box.aside.values()) clearTimeout(a.timer);
  box.aside.clear();
  await startCloudServer();
  // Another Mac of B's wrote meanwhile: a bot, and a message.
  const head2 = (await asUser(B, "/v1/state/head")).body;
  const theirs2 = (await cloudState(B)).state;
  assert.equal((await asUser(B, "/v1/state", { method: "PUT", body: { base: head2.version, state: { ...theirs2, bots: [...theirs2.bots, { id: "nova", name: "Nova", role: "Ops", color: "#5B8CFF", isMain: false, computerStatus: "none" }] } } })).status, 200);
  await asUser(B, "/v1/messages", { method: "POST", body: { upsert: [{ id: "msg_elsewhere", chatId: "chat_boppy", role: "user", text: "B elsewhere while this Mac was off", at: Date.now() }], remove: [] } });
  // B signs in again here: the cloud's state, with this Mac's kept changes over it.
  await signIn(B);
  assert.ok(texts().includes("B: kept on this Mac"), "B's message written offline");
  assert.ok(texts().includes("B elsewhere while this Mac was off"), "and the other Mac's");
  assert.equal(texts().includes("B on the other Mac"), false, "the message removed here stays removed");
  assert.equal(S.getState().owner.about, "Kept while offline");
  assert.ok(botNames().includes("Nova"), "the other Mac's bot");
  assert.equal(await S.flushState(10_000), true);
  await until(() => !existsSync(keptFile), "the kept changes to be removed once they're up");
  const msgsB = (await cloudMessages(B)).map((m) => m.text);
  assert.ok(msgsB.includes("B: kept on this Mac") && msgsB.includes("B elsewhere while this Mac was off"));
  assert.equal(msgsB.includes("B on the other Mac"), false);
  const stB = (await cloudState(B)).state;
  assert.equal(stB.owner.about, "Kept while offline");
  assert.ok(stB.bots.some((b) => b.name === "Nova"));
  console.log("Bops stopping while the cloud is away: the unsent changes wait in the user's folder, and go up at their next sign-in beside another Mac's");

  /* ---------------- The key comes in with the state, before the Keychain has it ---------------- */

  // A signs in over B with a slow Keychain: from the moment A's state is in memory, the key in use is A's
  // (nothing runs on B's key over A's state: a bot's computer it can't see would look deleted).
  process.env.BOPS_TEST_KEYCHAIN_SLOW_MS = "1500";
  orgo.next = A;
  await L.startSignIn();
  const landing = L.pollSignIn();
  try {
    await until(() => S.stateUser() === A, "A's state to load", 20_000);
    assert.equal(readFileSync(join(scratch, "keychain", "orgo-api-key"), "utf8"), keyOf(B), "the Keychain is still being written");
    assert.equal(OA.orgoKey(), keyOf(A), "but the key in use is A's already");
    assert.equal((await landing).status, "approved");
  } finally {
    delete process.env.BOPS_TEST_KEYCHAIN_SLOW_MS;
  }
  assert.equal(readFileSync(join(scratch, "keychain", "orgo-api-key"), "utf8"), keyOf(A));
  assert.equal(S.getState().account?.user.id, A);
  console.log("signing in over another account: the new key comes in with the new state, before the Keychain is written");

  /* ---------------- Merging, on its own ---------------- */

  const base = { owner: { name: "N" }, bots: [{ id: "a", n: 1 }, { id: "b", n: 1 }, { id: "c", n: 1 }], usage: [{ kind: "x", at: 1 }], host: "orgo" };
  const mine = { owner: { name: "N", about: "mine" }, bots: [{ id: "a", n: 2 }, { id: "b", n: 1 }, { id: "d", n: 1 }], usage: [{ kind: "x", at: 1 }, { kind: "y", at: 3 }], host: "mac" };
  const other = { owner: { name: "N2" }, bots: [{ id: "a", n: 3 }, { id: "c", n: 1 }, { id: "e", n: 1 }], usage: [{ kind: "x", at: 1 }, { kind: "z", at: 2 }], host: "orgo" };
  assert.deepEqual(M.merge3(base, mine, other), {
    owner: { name: "N2", about: "mine" },
    // a: changed on both, this Mac's; b: removed there, gone; c: removed here, gone; d and e: new on each side, kept.
    bots: [{ id: "a", n: 2 }, { id: "d", n: 1 }, { id: "e", n: 1 }],
    usage: [{ kind: "x", at: 1 }, { kind: "z", at: 2 }, { kind: "y", at: 3 }],
    host: "mac",
  });
  const shared = M.toShared({ account: { user: { id: A } }, relay: { on: true }, macs: { m2: { relay: { on: false } } }, bots: [{ id: "a", appsKey: "k" }], chats: [{ id: "c", typing: ["a"] }], messages: [{ id: "m" }], screens: { x: 1 } }, "m1");
  assert.deepEqual(shared, { bots: [{ id: "a" }], chats: [{ id: "c" }], macs: { m2: { relay: { on: false } }, m1: { relay: { on: true } } } });
  console.log("merging: by key, by id, usage together; what's this Mac's and what never leaves it");
} finally {
  console.info = quiet.info;
  console.warn = quiet.warn;
  if (cloud.child) await stopCloudServer().catch(() => {});
  orgoServer.close();
  await db.query("DELETE FROM bops.app_state_backups WHERE user_id = ANY($1::text[])", [users]).catch(() => {});
  await db.query("DELETE FROM bops.app_state WHERE user_id = ANY($1::text[])", [users]).catch(() => {});
  await db.end();
  process.chdir(tmpdir());
  rmSync(scratch, { recursive: true, force: true });
}
console.log("profile tests passed");
process.exit(0);
