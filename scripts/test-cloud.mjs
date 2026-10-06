// Tests for the app's side of Bops Cloud (lib/server/cloud.ts, cloud-state.ts, cloud-tunnel.ts and the
// modules that switch to it): the session, every provider through the cloud and directly (self-hosting),
// codes through the cloud, the webhook routes' tunnel token, Slack through the cloud's app (its events,
// pairing codes, where the bots are), app actions that ask first, the state backup and restore, routing
// through this Mac on by default, and the tunnel against a fake cloud. Nothing reaches a real service or
// the real Keychain: the cloud and this Mac's server are fakes on 127.0.0.1, every other address answers
// from a stub (or not at all), and `security`, `codex` and `orgo-relay` are stand-ins.
// Usage: node --conditions=react-server scripts/test-cloud.mjs
import assert from "node:assert/strict";
import { createHmac } from "node:crypto";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, symlinkSync, unlinkSync, writeFileSync } from "node:fs";
import { createServer } from "node:http";
import { createRequire, registerHooks } from "node:module";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { gunzipSync } from "node:zlib";
import { WebSocketServer } from "ws";

const root = new URL("..", import.meta.url).pathname.replace(/\/$/, "");
const ts = createRequire(import.meta.url)("typescript");
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
/** Wait for `check` to give something truthy (and return it). */
async function until(check, what, ms = 4000) {
  for (const end = Date.now() + ms; Date.now() < end; await sleep(20)) {
    const v = await check();
    if (v) return v;
  }
  assert.fail(`timed out waiting for ${what}`);
}

// No keys or settings from the shell, a throwaway home and working folder (the state file, the
// Keychain), and stand-ins for the programs the server runs.
for (const k of Object.keys(process.env)) if (/^(BOPS|OPENAI|AGENTPHONE|AGENTMAIL|HONCHO|COMPOSIO|TYPESAFE|TWILIO|ORGO)_/.test(k)) delete process.env[k];
const scratch = mkdtempSync(join(tmpdir(), "bops-test-cloud-"));
process.chdir(scratch);
process.env.HOME = scratch;
// Some modules read files through the working folder (the page recorder they inject).
symlinkSync(join(root, "node_modules"), join(scratch, "node_modules"));
const bin = join(scratch, "bin");
mkdirSync(bin);
mkdirSync(join(scratch, "keychain"));
process.env.BOPS_TEST_KEYCHAIN = join(scratch, "keychain");
// macOS's `security`, with a folder for a Keychain.
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
  else if (args[0] === "add-generic-password") fs.writeFileSync(file(arg(args, "-a")), Buffer.from(arg(args, "-X"), "hex").toString("utf8"));
  else process.exit(1);
}
if (process.argv[2] === "-i") {
  let input = "";
  process.stdin.on("data", (d) => (input += d)).on("end", () => run(input.trim().match(/"[^"]*"|\\S+/g).map((x) => x.replace(/^"|"$/g, ""))));
} else run(process.argv.slice(2));
`,
  { mode: 0o755 },
);
// Codex's app server, signed in to nothing.
writeFileSync(
  join(bin, "codex"),
  `#!/usr/bin/env node
require("readline").createInterface({ input: process.stdin }).on("line", (line) => {
  const m = JSON.parse(line);
  if (m.id !== undefined && m.method) process.stdout.write(JSON.stringify({ jsonrpc: "2.0", id: m.id, result: m.method === "account/read" ? { account: null } : {} }) + "\\n");
});
`,
  { mode: 0o755 },
);
// The relay agent: says it's connected on its control address until it's stopped.
writeFileSync(
  join(bin, "orgo-relay"),
  `#!/usr/bin/env node
const [host, port] = process.argv[process.argv.indexOf("--control-addr") + 1].split(":");
require("http").createServer((_, res) => res.end('{"connected":true}')).listen(Number(port), host);
`,
  { mode: 0o755 },
);
process.env.PATH = `${bin}:${process.env.PATH}`;
process.env.BOPS_RELAY_BIN = join(bin, "orgo-relay");
const freePort = () =>
  new Promise((resolve) => {
    const s = createServer().listen(0, "127.0.0.1", () => {
      const { port } = s.address();
      s.close(() => resolve(port));
    });
  });
process.env.BOPS_RELAY_CONTROL = `127.0.0.1:${await freePort()}`;

// Every address but this Mac's own answers from the stub: `web.answer` (or no network at all).
const realFetch = globalThis.fetch;
const web = { calls: [], answer: null };
globalThis.fetch = async (input, init) => {
  const req = new Request(input, init);
  const url = new URL(req.url);
  if (url.hostname === "127.0.0.1") return realFetch(input, init);
  const call = { method: req.method, url: req.url, host: url.host, path: url.pathname + url.search, headers: Object.fromEntries(req.headers), body: req.body ? await req.text() : "" };
  web.calls.push(call);
  const out = web.answer?.(call);
  if (!out) throw new TypeError(`fetch failed (the test is offline: ${url.host})`);
  return out;
};
// Orgo: routing through this Mac isn't offered (403) until the routing tests say otherwise.
const orgo = { offered: false, devices: [], calls: [] };
const orgoAnswer = (c) => {
  if (c.host !== "www.orgo.ai") return null;
  orgo.calls.push(c);
  if (c.path === "/api/egress-devices" && !orgo.offered) return Response.json({ error: "Not available" }, { status: 403 });
  if (c.path === "/api/egress-devices" && c.method === "GET") return Response.json({ devices: orgo.devices, rendezvous: null });
  if (c.path === "/api/egress-devices" && c.method === "POST") {
    const d = { id: `dev_${orgo.devices.length + 1}`, name: JSON.parse(c.body).name, online: true };
    orgo.devices.push(d);
    return Response.json({ id: d.id, name: d.name, pairing_code: `code_${d.id}` });
  }
  return Response.json({ error: "not faked" }, { status: 404 });
};
/** AgentMail: no bops.bot here (so inboxes go on agentmail.to), empty inboxes, and any new inbox made. */
const agentmailAnswer = (c) => {
  if (c.host !== "api.agentmail.to") return null;
  if (c.path.startsWith("/v0/domains/")) return Response.json({ name: "NotFoundError", message: "Domain not found" }, { status: 404 });
  if (c.path.startsWith("/v0/domains")) return Response.json({ count: 0, domains: [] });
  if (c.method === "POST" && /^\/v0\/pods\/[^/]+\/inboxes$/.test(c.path)) return Response.json({ pod_id: "pod", inbox_id: "iris.main@agentmail.to", email: "iris.main@agentmail.to", display_name: "Iris", created_at: "2026-10-05T00:00:00Z", updated_at: "2026-10-05T00:00:00Z" });
  return Response.json({ count: 0, messages: [] });
};
/** AgentPhone's lists, empty. */
const agentphoneAnswer = (c) => (c.host === "api.agentphone.ai" ? Response.json(c.path.startsWith("/v1/register") ? { campaign_status: "approved" } : { data: [] }) : null);
/** The usual providers, answering anything else with an empty JSON object; Orgo as above. */
const providers = (c) => orgoAnswer(c) ?? agentmailAnswer(c) ?? agentphoneAnswer(c) ?? Response.json({});
web.answer = providers;

// The server modules import "@/lib/…" and "./store" (no extension), the way Next resolves them. Node only
// strips types and can't run parameter properties (lib/server/mirror.ts), so the project's TypeScript
// compiles each file instead.
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
    const { outputText } = ts.transpileModule(readFileSync(file, "utf8"), { fileName: file, compilerOptions: { module: ts.ModuleKind.ESNext, target: ts.ScriptTarget.ES2022, jsx: ts.JsxEmit.ReactJSX } });
    return { format: "module", source: outputText, shortCircuit: true };
  },
});

/* ---------------- The fake cloud: HTTP and the tunnel's WebSocket ---------------- */

const SESSION = {
  userId: "u1",
  email: "me@example.com",
  publicUrl: "https://cloud.example",
  agentmail: { podId: "pod_u1", apiKey: "am_pod_key" },
  agentphone: { subAccountId: "sub_u1", hookUrl: "https://cloud.example/hooks/agentphone" },
  honcho: { workspacePrefix: "u-u1" },
  composio: { userId: "bops-u1" },
  openai: { executorKey: "sk-exec-restricted" },
  typesafe: true,
  verify: { sms: true, email: false },
};
const BARE = { ...SESSION, agentmail: null, agentphone: null, honcho: null, composio: null, openai: { executorKey: null }, typesafe: false, verify: { sms: false, email: false } };
const cloud = { requests: [], upgrades: [], connections: [], session: SESSION, handle: null };
const cloudDefault = (r) => {
  if (r.path === "/v1/session") return { json: cloud.session };
  if (r.path === "/v1/state" && r.method === "GET") return { status: 404, json: { error: "No state yet" } };
  return { json: {} };
};
const cloudHttp = createServer((req, res) => {
  const chunks = [];
  req.on("data", (c) => chunks.push(c));
  req.on("end", async () => {
    const r = { method: req.method, path: req.url, headers: req.headers, body: Buffer.concat(chunks) };
    cloud.requests.push(r);
    const out = (await (cloud.handle ?? cloudDefault)(r)) ?? cloudDefault(r);
    res.writeHead(out.status ?? 200, { "content-type": "application/json" });
    res.end(typeof out.body === "string" ? out.body : JSON.stringify(out.json ?? {}));
  });
});
const wss = new WebSocketServer({ noServer: true });
cloudHttp.on("upgrade", (req, socket, head) => {
  cloud.upgrades.push({ path: req.url, auth: req.headers.authorization });
  if (req.url !== "/v1/connect") return socket.destroy();
  wss.handleUpgrade(req, socket, head, (ws) => {
    const c = { ws, auth: req.headers.authorization, frames: [], closed: null, at: Date.now() };
    ws.on("message", (d) => c.frames.push(JSON.parse(String(d))));
    ws.on("close", (code) => (c.closed = code));
    cloud.connections.push(c);
  });
});
await new Promise((r) => cloudHttp.listen(0, "127.0.0.1", r));
const CLOUD = `http://127.0.0.1:${cloudHttp.address().port}`;
process.env.BOPS_CLOUD_URL = CLOUD;
const since = (n) => cloud.requests.slice(n);
const json = (r) => JSON.parse(r.body.toString("utf8"));

// Signed out to start with: the Keychain is never asked for the key.
const g = globalThis;
g.bopsOrgoKey = null;
g.bopsOrgoKeyMissAt = Infinity;

const S = await import(`${root}/lib/server/store.ts`);
const Cl = await import(`${root}/lib/server/cloud.ts`);
const OA = await import(`${root}/lib/server/openai-client.ts`);
const P = await import(`${root}/lib/server/phone.ts`);
const M = await import(`${root}/lib/server/mail.ts`);
const Mem = await import(`${root}/lib/server/memory.ts`);
const C = await import(`${root}/lib/server/composio.ts`);
const D = await import(`${root}/lib/server/decide.ts`);
const V = await import(`${root}/lib/server/verify.ts`);
const B = await import(`${root}/lib/server/cloud-state.ts`);
const T = await import(`${root}/lib/server/cloud-tunnel.ts`);
const R = await import(`${root}/lib/server/relay.ts`);
const AP = await import(`${root}/app/api/phone/agentphone/route.ts`);
const OAI = await import(`${root}/app/api/phone/openai/route.ts`);
const EV = await import(`${root}/app/api/cloud/event/route.ts`);
const CH = await import(`${root}/lib/server/channels.ts`);
const SE = await import(`${root}/app/api/channels/slack/events/route.ts`);
const K = await import(`${root}/lib/server/skills.ts`);
const { MAIN_WORKSPACE, PAIR_CODE_MS } = await import(`${root}/lib/types.ts`);
const { buildURL: sidebandURL } = await import(`${root}/node_modules/openai/resources/live/sideband/internal-base.mjs`);

const KEY = "orgo_test_key";
const USER = { id: "u1", email: "me@example.com", name: "Test" };
function signIn(key = KEY, user = USER) {
  g.bopsOrgoKey = key;
  g.bopsOrgoKeyMissAt = undefined;
  S.update((s) => (s.account = { user, signedInAt: 1 }));
}
function signOut() {
  g.bopsOrgoKey = null;
  g.bopsOrgoKeyMissAt = Infinity;
  S.update((s) => (s.account = undefined));
}
/** Self-hosting for the length of `fn`, with these settings. */
async function selfHosted(env, fn) {
  Object.assign(process.env, { BOPS_SELF_HOSTED: "1", ...env });
  try {
    return await fn();
  } finally {
    for (const k of ["BOPS_SELF_HOSTED", ...Object.keys(env)]) delete process.env[k];
  }
}
/** A session with these services (the cloud's answer from now on). */
async function withSession(session) {
  cloud.session = session;
  Cl.forgetCloudSession();
  await Cl.cloudSession();
}

/* ---------------- Whether the app uses the cloud, and its session ---------------- */

assert.equal(Cl.cloudUrl(), CLOUD);
assert.equal(Cl.cloudOn(), false, "signed out");
await assert.rejects(Cl.cloudSession(), /Sign in with Orgo first\./);
assert.equal(Cl.cloudSessionNow(), null);
assert.equal(Cl.cloudProxy("openai"), null);
assert.equal(cloud.requests.length, 0, "signed out: nothing is asked");
signIn();
assert.equal(Cl.cloudOn(), true);
await selfHosted({}, () => assert.equal(Cl.cloudOn(), false, "self-hosting"));
process.env.BOPS_DATABASE_URL = "postgres://nowhere";
assert.equal(Cl.cloudOn(), false, "a hosted server holds its own keys");
delete process.env.BOPS_DATABASE_URL;
assert.deepEqual(Cl.cloudProxy("honcho"), { url: `${CLOUD}/proxy/honcho`, key: KEY });

// Asked once per key and kept; two at once share one request.
let n = cloud.requests.length;
const [s1, s2] = await Promise.all([Cl.cloudSession(), Cl.cloudSession()]);
assert.deepEqual(s1, SESSION);
assert.equal(s1, s2);
assert.equal(since(n).length, 1, "one request for both");
assert.equal(since(n)[0].method, "POST");
assert.equal(since(n)[0].path, "/v1/session");
assert.equal(since(n)[0].headers.authorization, `Bearer ${KEY}`);
await Cl.cloudSession();
assert.equal(since(n).length, 1, "kept");
assert.deepEqual(Cl.cloudSessionNow(), SESSION);
await Cl.cloudSession(true);
assert.equal(since(n).length, 2, "a sign-in asks again");
// Another key (someone else signed in): asked again on that key, and the old answer isn't theirs.
signIn("orgo_other_key", { id: "u2" });
assert.equal(Cl.cloudSessionNow(), null, "not the other key's session");
await until(() => since(n).some((r) => r.headers.authorization === "Bearer orgo_other_key"), "the session on the new key");
signIn();
Cl.forgetCloudSession();
assert.equal(Cl.cloudSessionNow(), null, "a sign-out forgets it (and the next look asks again)");
await until(() => Cl.cloudSessionNow(), "the session again");

// What goes wrong, in words the app can show; a failure stands 10 seconds before the cloud is asked again.
const problems = [
  [{ status: 401, json: { error: "Sign in with Orgo" } }, 401, "Bops Cloud didn't accept your Orgo sign-in. Sign out and sign in again."],
  [{ status: 503, json: { error: "db down" } }, 503, "Bops Cloud isn't working right now (503). Try again in a minute."],
  [{ status: 403, json: { error: "This Orgo account can't use Bops yet" } }, 403, "This Orgo account can't use Bops yet"],
  [{ status: 200, body: "<html>" }, 200, "Bops Cloud sent back something Bops couldn't read."],
];
for (const [answer, status, message] of problems) {
  cloud.handle = (r) => (r.path === "/v1/session" ? answer : cloudDefault(r));
  Cl.forgetCloudSession();
  await assert.rejects(Cl.cloudSession(), (e) => e instanceof Cl.CloudError && e.status === status && e.message === message);
  n = cloud.requests.length;
  await assert.rejects(Cl.cloudSession(), (e) => e.message === message);
  assert.equal(since(n).length, 0, "kept for a while");
}
process.env.BOPS_CLOUD_URL = "http://127.0.0.1:9";
Cl.forgetCloudSession();
await assert.rejects(Cl.cloudSession(), (e) => e instanceof Cl.CloudError && e.status === 0 && e.message === "Couldn't reach Bops Cloud. Check your internet connection.");
process.env.BOPS_CLOUD_URL = CLOUD;
cloud.handle = null;
await withSession(SESSION);
console.log("session: asked once per key, kept, forgotten on sign-out, errors in plain words");

/* ---------------- Every service: through the cloud, or directly when self-hosting ---------------- */

// What's on follows the session: nothing it doesn't run, and no key is ever asked for.
await withSession(BARE);
assert.deepEqual([M.mailOn(), P.phoneOn(), Mem.memoryOn(), C.composioOn(), V.verifyOn()], [false, false, false, false, false]);
n = cloud.requests.length;
assert.equal(await D.decide({ x: 1 }, { ok: { type: "noul", instructions: "Is it?" } }), null);
assert.equal(since(n).length, 0, "no Typesafe call without it");
await assert.rejects(Cl.executorKey(), /can't run tasks on computers/);
await assert.rejects(C.connectApp("gmail"), /^Error: Connected apps aren't available right now\.$/);
await withSession(SESSION);
assert.deepEqual([M.mailOn(), P.phoneOn(), Mem.memoryOn(), C.composioOn(), V.verifyOn()], [true, true, true, true, true]);
// Self-hosting goes by the keys in .env.local, as before.
await selfHosted({}, () => assert.deepEqual([M.mailOn(), P.phoneOn(), Mem.memoryOn(), C.composioOn(), V.verifyOn()], [false, false, false, false, false]));
await selfHosted({ AGENTMAIL_API_KEY: "x", AGENTPHONE_API_KEY: "x", HONCHO_API_KEY: "x", COMPOSIO_API_KEY: "x", TWILIO_VERIFY_SERVICE_SID: "VA1", TWILIO_API_KEY_SID: "SK1", TWILIO_API_KEY_SECRET: "x" }, () =>
  assert.deepEqual([M.mailOn(), P.phoneOn(), Mem.memoryOn(), C.composioOn(), V.verifyOn()], [true, true, true, true, true]),
);

// OpenAI: <cloud>/proxy/openai/v1 on the Orgo key, read per call, so a sign-in or sign-out applies at once.
cloud.handle = (r) => (r.path.startsWith("/proxy/openai/") ? { json: { id: "resp_1", object: "response", output: [], usage: null } } : cloudDefault(r));
const ai = OA.openaiClient({ maxRetries: 0 });
n = cloud.requests.length;
await ai.responses.create({ model: "gpt-test", input: "hi" });
await ai.live.sessions.accept("sess_1", { session: { type: "live" } });
assert.deepEqual(
  since(n).map((r) => [r.method, r.path, r.headers.authorization]),
  [
    ["POST", "/proxy/openai/v1/responses", `Bearer ${KEY}`],
    ["POST", "/proxy/openai/v1/live/sessions/sess_1/accept", `Bearer ${KEY}`],
  ],
);
// The call sideband builds its address from the client's, and signs in with the key the client last used.
assert.equal(String(sidebandURL(ai, { session_id: "sess_1" })), `${CLOUD.replace(/^http/, "ws")}/proxy/openai/v1/live/sessions/sess_1/attach`);
assert.equal(ai.apiKey, KEY);
await selfHosted({ OPENAI_API_KEY: "sk-self" }, async () => {
  web.answer = (c) => (c.host === "api.openai.com" ? Response.json({ id: "resp_2", object: "response", output: [] }) : providers(c));
  await ai.responses.create({ model: "gpt-test", input: "hi" });
  assert.equal(web.calls.at(-1).url, "https://api.openai.com/v1/responses");
  assert.equal(web.calls.at(-1).headers.authorization, "Bearer sk-self");
  assert.equal(String(sidebandURL(ai, { session_id: "s" })), "wss://api.openai.com/v1/live/sessions/s/attach");
  web.answer = providers;
});
await selfHosted({}, () => assert.rejects(ai.responses.create({ model: "x", input: "x" }), /No OpenAI key is set: add OPENAI_API_KEY to \.env\.local\./));
signOut();
await assert.rejects(ai.responses.create({ model: "x", input: "x" }), /Sign in with Orgo first\./);
signIn();

// AgentPhone: <cloud>/proxy/agentphone/v1 on the Orgo key, never naming a sub-account (the cloud acts in the user's own).
process.env.AGENTPHONE_SUB_ACCOUNT = "sub_self";
const apAnswers = new Map([["GET /sip-trunks", { data: [] }]]);
cloud.handle = (r) => {
  if (!r.path.startsWith("/proxy/agentphone/v1")) return cloudDefault(r);
  const answer = apAnswers.get(`${r.method} ${r.path.slice("/proxy/agentphone/v1".length)}`);
  return { json: typeof answer === "function" ? answer(r) : (answer ?? {}) };
};
n = cloud.requests.length;
await P.phoneStatus();
assert.deepEqual(
  since(n).map((r) => r.path),
  ["/proxy/agentphone/v1/register/status"],
  "calls go to each number's agent: no SIP trunk to look for",
);
for (const r of since(n)) {
  assert.equal(r.headers.authorization, `Bearer ${KEY}`);
  assert.equal(r.headers["x-sub-account-id"], undefined);
}
// A workspace's number: its webhook goes where the session says, and the secret the cloud kept stays there.
apAnswers.set("GET /numbers?limit=100", { data: [{ id: "num_1", phoneNumber: "+14155550100", agentId: null, type: "sms" }] });
apAnswers.set("GET /agents?limit=100", { data: [] });
apAnswers.set("POST /agents", { id: "agt_ws", name: "Bops · Main (Boppy)" });
apAnswers.set("POST /agents/agt_ws/webhook", { secret: "kept-by-cloud", url: "https://cloud.example/hooks/agentphone" });
n = cloud.requests.length;
await P.assignWorkspaceLine(MAIN_WORKSPACE, "+14155550100", "parent");
const hook = since(n).find((r) => r.path === "/proxy/agentphone/v1/agents/agt_ws/webhook");
assert.equal(json(hook).url, SESSION.agentphone.hookUrl);
// Its calls go to its agent (which Bops just made in voice mode "webhook"), and the cloud is told the line is the main bot's, with its 15 minutes for the first caller.
const routing = since(n).filter((r) => r.path === "/proxy/agentphone/v1/numbers/num_1/voice-routing");
assert.deepEqual(routing.map((r) => [r.method, json(r)]), [["PATCH", { method: "agent" }]]);
assert.equal(json(since(n).find((r) => r.path === "/proxy/agentphone/v1/agents" && r.method === "POST")).voiceMode, "webhook");
assert.equal(since(n).filter((r) => r.method === "PATCH" && r.path === "/proxy/agentphone/v1/agents/agt_ws").length, 0, "an agent just made in webhook mode isn't changed");
const lineTold = since(n).find((r) => r.path === "/v1/phone/lines");
assert.equal(lineTold.method, "PUT");
assert.deepEqual(json(lineTold), { numberId: "num_1", botId: "boppy", workspaceId: MAIN_WORKSPACE, open: true });
assert.equal(existsSync(join(scratch, ".data/phone-secrets.json")), false, "no secret kept here");
assert.deepEqual(P.hookSecrets(), []);
assert.equal(S.getState().workspaces[0].line.agentId, "agt_ws");
// A bot's own number gets its own webhook on the cloud (self-hosting has the sub-account's).
apAnswers.set("GET /numbers?limit=100", { data: [] });
apAnswers.set("POST /agents", { id: "agt_own", name: "Boppy (Bops)" });
apAnswers.set("POST /numbers", { id: "num_own", phoneNumber: "+14155550101", agentId: "agt_own" });
apAnswers.set("POST /agents/agt_own/webhook", { secret: "kept-by-cloud" });
n = cloud.requests.length;
assert.equal(await P.ensurePhone("boppy"), "+14155550101");
assert.equal(json(since(n).find((r) => r.path === "/proxy/agentphone/v1/agents/agt_own/webhook")).url, SESSION.agentphone.hookUrl);
assert.deepEqual(json(since(n).find((r) => r.path === "/proxy/agentphone/v1/numbers/num_own/voice-routing")), { method: "agent" });
assert.deepEqual(json(since(n).find((r) => r.path === "/v1/phone/lines")), { numberId: "num_own", botId: "boppy", open: true });
// At start, a number whose calls went to a SIP trunk (or whose agent wasn't in webhook mode) is put back, and the cloud learns each line's bot.
apAnswers.set("GET /numbers?limit=100", { data: [{ id: "num_own", phoneNumber: "+14155550101", agentId: "agt_own", voiceRouting: { method: "sip_trunk" } }, { id: "num_1", phoneNumber: "+14155550100", agentId: "agt_ws", voiceRouting: { method: "agent" } }] });
apAnswers.set("GET /agents?limit=100", { data: [{ id: "agt_own", voiceMode: "hosted" }, { id: "agt_ws", voiceMode: "webhook" }] });
n = cloud.requests.length;
assert.deepEqual(await P.lineUpkeep(), ["+14155550101: sip_trunk → agent (voice mode hosted → webhook)"]);
assert.deepEqual(
  since(n)
    .filter((r) => r.method === "PATCH" || r.method === "PUT")
    .map((r) => [r.method, r.path.replace("/proxy/agentphone/v1", ""), json(r)]),
  [
    ["PATCH", "/agents/agt_own", { voiceMode: "webhook" }],
    ["PATCH", "/numbers/num_own/voice-routing", { method: "agent" }],
    ["PUT", "/v1/phone/lines", { numberId: "num_1", botId: "boppy", workspaceId: MAIN_WORKSPACE }],
    ["PUT", "/v1/phone/lines", { numberId: "num_own", botId: "boppy" }],
  ],
);
S.update((s) => {
  delete s.bots[0].phone;
  delete s.bots[0].phoneLine;
});
await selfHosted({ AGENTPHONE_API_KEY: "ap_self" }, async () => {
  const w = web.calls.length;
  await P.phoneStatus();
  const direct = web.calls.slice(w).filter((c) => c.host === "api.agentphone.ai");
  assert.deepEqual(
    direct.map((c) => [c.url, c.headers.authorization, c.headers["x-sub-account-id"]]),
    [["https://api.agentphone.ai/v1/register/status", "Bearer ap_self", "sub_self"]],
  );
});
delete process.env.AGENTPHONE_SUB_ACCOUNT;
cloud.handle = null;

// AgentMail: directly, with the key that reaches only the user's own pod, and that pod.
S.update((s) => {
  s.bots[0].mail = { inboxId: "boppy@main.bops.bot", podId: "pod_u1" };
  s.bots[0].email = "boppy@main.bops.bot";
});
let w = web.calls.length;
await M.checkEmail("boppy", null);
const mailCall = web.calls.slice(w).find((c) => c.host === "api.agentmail.to");
assert.equal(mailCall.headers.authorization, "Bearer am_pod_key");
assert.match(mailCall.path, /^\/v0\/inboxes\/boppy(%40|@)main\.bops\.bot\/messages/);
S.update((s) => s.bots.push({ id: "iris", name: "Iris", role: "Inbox", color: "#5B8CFF", isMain: false, computerStatus: "none" }));
w = web.calls.length;
await M.ensureInbox("iris").catch(() => {});
assert.ok(
  web.calls.slice(w).some((c) => c.method === "POST" && c.path === "/v0/pods/pod_u1/inboxes" && c.headers.authorization === "Bearer am_pod_key"),
  "a new inbox goes in the user's own pod",
);
await selfHosted({ AGENTMAIL_API_KEY: "am_self" }, async () => {
  w = web.calls.length;
  await M.checkEmail("boppy", null);
  assert.equal(web.calls.slice(w).find((c) => c.host === "api.agentmail.to").headers.authorization, "Bearer am_self");
});
signOut();
await assert.rejects(M.checkEmail("boppy", null), /Email isn't available right now\./);
signIn();
S.update((s) => (s.bots = s.bots.filter((b) => b.id !== "iris")));

// Honcho: <cloud>/proxy/honcho on the Orgo key, every workspace with the user's prefix.
const honchoAnswer = (r) => {
  if (r.path === "/proxy/honcho/v3/workspaces") return { json: { id: json(r).id, metadata: {}, configuration: {}, created_at: "2026-01-01T00:00:00Z" } };
  if (r.path.endsWith("/peers/user/card")) return { json: { peer_card: ["Likes tea"] } };
  return { json: { id: "user", metadata: {}, configuration: {}, created_at: "2026-01-01T00:00:00Z" } };
};
cloud.handle = (r) => (r.path.startsWith("/proxy/honcho/") ? honchoAnswer(r) : cloudDefault(r));
n = cloud.requests.length;
assert.deepEqual((await Mem.memoryInfo(MAIN_WORKSPACE)).card, [{ text: "Likes tea", private: false }]);
let honcho = since(n).filter((r) => r.path.startsWith("/proxy/honcho/"));
assert.deepEqual(json(honcho[0]), { id: "u-u1-bops" });
assert.ok(honcho.some((r) => r.path === "/proxy/honcho/v3/workspaces/u-u1-bops/peers/user/card"));
assert.ok(honcho.every((r) => r.headers.authorization === `Bearer ${KEY}`));
n = cloud.requests.length;
await Mem.memoryInfo("ws_two");
honcho = since(n).filter((r) => r.path.startsWith("/proxy/honcho/"));
assert.deepEqual(json(honcho[0]), { id: "u-u1-bops-ws_two" }, "another workspace's bank");
await selfHosted({ HONCHO_API_KEY: "hc_self", HONCHO_WORKSPACE_ID: "nicks-bank" }, async () => {
  web.answer = (c) => (c.host === "api.honcho.dev" ? Response.json(c.path.endsWith("/card") ? { peer_card: [] } : { id: "x", metadata: {}, configuration: {}, created_at: "2026-01-01T00:00:00Z" }) : providers(c));
  w = web.calls.length;
  await Mem.memoryInfo(MAIN_WORKSPACE);
  const direct = web.calls.slice(w).filter((c) => c.host === "api.honcho.dev");
  assert.equal(direct[0].url, "https://api.honcho.dev/v3/workspaces");
  assert.deepEqual(JSON.parse(direct[0].body), { id: "nicks-bank" });
  assert.equal(direct[0].headers.authorization, "Bearer hc_self");
  web.answer = providers;
});
cloud.handle = null;

// Composio: <cloud>/proxy/composio, as the session's Composio user, on the Orgo key (Bearer, for the cloud).
cloud.handle = (r) => (r.path.startsWith("/proxy/composio/") ? { json: { items: [], next_cursor: null, total_pages: 1, current_page: 1, total_items: 0 } } : cloudDefault(r));
n = cloud.requests.length;
w = web.calls.length;
await C.syncApps();
const composio = since(n).filter((r) => r.path.startsWith("/proxy/composio/"));
assert.equal(composio.at(-1).path, "/proxy/composio/api/v3.1/connected_accounts?limit=100&user_ids=bops-u1");
assert.equal(composio.at(-1).headers.authorization, `Bearer ${KEY}`);
assert.ok(!web.calls.slice(w).some((c) => /composio/.test(c.host)), "nothing to Composio itself, usage reports included");
await selfHosted({ COMPOSIO_API_KEY: "cp_self", COMPOSIO_USER_ID: "nick" }, async () => {
  web.answer = (c) => (c.host === "backend.composio.dev" ? Response.json({ items: [], next_cursor: null, total_pages: 1, current_page: 1, total_items: 0 }) : providers(c));
  w = web.calls.length;
  await C.syncApps();
  const direct = web.calls.slice(w).find((c) => c.host === "backend.composio.dev");
  assert.equal(direct.url, "https://backend.composio.dev/api/v3.1/connected_accounts?limit=100&user_ids=nick");
  assert.equal(direct.headers["x-api-key"], "cp_self");
  web.answer = providers;
});
cloud.handle = null;

// The app picker's catalog. Through the cloud, only the apps that can connect there: no sign-in,
// Composio's own sign-in, a setup the cloud offers (Orgo's Slack app), or each person's own key; the
// rest would only be turned away at the cloud. Self-hosted, every app.
const toolkit = (slug, name, schemes, managed = [], more = {}) => ({ slug, name, meta: { description: `${name}.`, categories: [], tools_count: 5 }, is_local_toolkit: false, auth_schemes: schemes, composio_managed_auth_schemes: managed, no_auth: false, ...more });
const TOOLKITS = [
  toolkit("gmail", "Gmail", ["OAUTH2"], ["OAUTH2"]),
  toolkit("slackbot", "Slack", ["OAUTH2"]),
  toolkit("acmecrm", "Acme CRM", ["OAUTH2", "API_KEY"]),
  toolkit("keyonly", "Key Only", ["BEARER_TOKEN"]),
  toolkit("salesforce", "Salesforce", ["OAUTH2"]),
  toolkit("dcrapp", "DCR App", ["DCR_OAUTH"]),
  toolkit("hackernews", "Hacker News", [], [], { no_auth: true }),
  toolkit("composio", "Composio", [], [], { no_auth: true }),
];
const listPage = (items) => ({ items, next_cursor: null, total_pages: 1, current_page: 1, total_items: items.length });
const orgoSlackSetup = { id: "ac_slack", uuid: "ac_slack", name: "Bops", toolkit: { slug: "slackbot", logo: "" }, no_of_connections: 1, status: "ENABLED", is_composio_managed: false, auth_scheme: "OAUTH2" };
const picked = (apps) => apps.map((a) => `${a.app}:${a.auth}`);
const CLOUD_PICKS = ["gmail:oauth", "slackbot:oauth", "acmecrm:key", "keyonly:key", "hackernews:open"];
g.bopsComposio2.catalog = g.bopsComposio2.loadingCatalog = undefined;
cloud.handle = (r) =>
  r.path.startsWith("/proxy/composio/api/v3.1/toolkits?") ? { json: listPage(TOOLKITS) } : r.path.startsWith("/proxy/composio/api/v3.1/auth_configs") ? { json: listPage([orgoSlackSetup]) } : cloudDefault(r);
n = cloud.requests.length;
assert.deepEqual(picked(await C.catalog()), CLOUD_PICKS);
assert.ok(since(n).some((r) => r.method === "GET" && r.path.startsWith("/proxy/composio/api/v3.1/auth_configs")), "the setups the cloud offers");
n = cloud.requests.length;
assert.deepEqual(picked(await C.catalog()), CLOUD_PICKS);
assert.equal(since(n).length, 0, "kept (asked again after half a day)");
await selfHosted({ COMPOSIO_API_KEY: "cp_self" }, async () => {
  web.answer = (c) => (c.host === "backend.composio.dev" && c.path.startsWith("/api/v3.1/toolkits") ? Response.json(listPage(TOOLKITS)) : providers(c));
  w = web.calls.length;
  assert.deepEqual(picked(await C.catalog()), ["gmail:oauth", "slackbot:oauth", "acmecrm:oauth", "keyonly:key", "salesforce:oauth", "dcrapp:oauth", "hackernews:open"]);
  assert.ok(!web.calls.slice(w).some((c) => c.path.includes("auth_configs")), "no sign-in setups asked for");
  web.answer = providers;
});
assert.deepEqual(picked(await C.catalog()), CLOUD_PICKS, "back on the cloud: its own list");
// Connecting a key-only app through the cloud: the setup made for it asks each person for their own
// key (API_KEY), never an OAuth one the cloud would refuse.
const authFields = { auth_config_creation: { required: [], optional: [] }, connected_account_initiation: { required: [], optional: [] } };
const acme = {
  name: "Acme CRM",
  slug: "acmecrm",
  meta: { description: "Acme CRM.", categories: [] },
  is_local_toolkit: false,
  composio_managed_auth_schemes: [],
  auth_config_details: [
    { name: "Acme sign-in", mode: "OAUTH2", fields: authFields },
    { name: "Acme key", mode: "API_KEY", fields: authFields },
  ],
};
cloud.handle = (r) => {
  if (r.method === "GET" && r.path.startsWith("/proxy/composio/api/v3.1/auth_configs")) return { json: listPage([]) };
  if (r.method === "GET" && r.path.startsWith("/proxy/composio/api/v3.1/toolkits/acmecrm")) return { json: acme };
  if (r.method === "POST" && r.path === "/proxy/composio/api/v3.1/auth_configs") return { json: { toolkit: { slug: "acmecrm" }, auth_config: { id: "ac_key", auth_scheme: "API_KEY", is_composio_managed: false } } };
  if (r.path.startsWith("/proxy/composio/api/v3.1/connected_accounts/link")) return { status: 400, json: { error: { message: "stop here" } } };
  return cloudDefault(r);
};
n = cloud.requests.length;
await assert.rejects(C.connectApp("acmecrm"));
const keySetup = since(n).find((r) => r.method === "POST" && r.path === "/proxy/composio/api/v3.1/auth_configs");
assert.deepEqual(json(keySetup).auth_config, { type: "use_custom_auth", name: "Acme CRM (Bops)", authScheme: "API_KEY", credentials: {} });
assert.ok(!S.getState().connecting?.length, "nothing waiting after a failed start");
cloud.handle = null;

// Typesafe: <cloud>/proxy/typesafe on the Orgo key; self-hosting, TYPESAFE_API_KEY.
const question = { ok: { type: "noul", instructions: "Is it?" } };
cloud.handle = (r) => (r.path === "/proxy/typesafe/v1/systemone" ? { json: { answers: { ok: { type: "noul", noul: 0.9 } } } } : cloudDefault(r));
n = cloud.requests.length;
assert.deepEqual(await D.decide({ x: 1 }, question), { ok: { type: "noul", noul: 0.9 } });
assert.equal(since(n)[0].headers.authorization, `Bearer ${KEY}`);
assert.deepEqual(json(since(n)[0]).questions, question);
await selfHosted({ TYPESAFE_API_KEY: "ts_self" }, async () => {
  web.answer = (c) => (c.host === "api.typesafe.ai" ? Response.json({ answers: { ok: { type: "noul", noul: 0.2 } } }) : providers(c));
  assert.deepEqual(await D.decide({ x: 1 }, question), { ok: { type: "noul", noul: 0.2 } });
  assert.equal(web.calls.at(-1).url, "https://api.typesafe.ai/v1/systemone");
  assert.equal(web.calls.at(-1).headers.authorization, "Bearer ts_self");
  web.answer = providers;
});
cloud.handle = null;

// The key copied onto bot computers: the cloud's restricted one, or OPENAI_EXECUTOR_API_KEY.
assert.equal(await Cl.executorKey(), "sk-exec-restricted");
await selfHosted({ OPENAI_EXECUTOR_API_KEY: "sk-exec-self" }, async () => assert.equal(await Cl.executorKey(), "sk-exec-self"));
console.log("providers: through the cloud on the Orgo key, and directly when self-hosting");

/* ---------------- AI credit: out of it, and the Bops plan from Orgo ---------------- */

const L = await import(`${root}/lib/server/plan.ts`);
// What the cloud answers a call that would spend when the user's AI credit is used up.
const OUT = { error: "You're out of AI credit, so your bots have stopped. Upgrade in Settings to keep them going.", code: "ai_credit_empty", upgrade: true };
cloud.handle = (r) => (r.path.startsWith("/proxy/") ? { status: 402, json: OUT } : cloudDefault(r));
// OpenAI's SDK error keeps the cloud's words (not its code: OpenAI itself never answers 402); AgentPhone's
// keeps both. Either is out of credit, and marks it so where the app acts on it.
const fromOpenAi = await ai.responses.create({ model: "gpt-test", input: "hi" }).catch((e) => e);
assert.equal(fromOpenAi.status, 402);
assert.equal(Cl.outOfCredits(fromOpenAi), true);
assert.equal(S.getState().credits, undefined, "only noted where the app acts on it");
await assert.rejects(P.ensurePhone("boppy"), (e) => e instanceof Cl.CloudError && e.status === 402 && e.code === "ai_credit_empty" && e.message === OUT.error);
assert.equal(S.getState().credits?.out, true);
for (const [e, want] of [
  [new Cl.CloudError("x", 402, "ai_credit_empty"), true],
  [new Cl.CloudError("x", 403), false],
  [new Cl.CloudError("x", 402, "something_else"), false],
  [Object.assign(new Error("402"), { status: 402, code: "ai_credit_empty" }), false],
  [new Error("AgentPhone 402"), false],
  [null, false],
])
  assert.equal(Cl.outOfCredits(e), want, String(e?.message));
assert.equal(Cl.OUT_OF_CREDIT, "I'm out of AI credit, so I've stopped. Upgrade in Settings to keep me going.");
cloud.handle = null;

// Out: the bots don't ask the cloud for AI work, and Orgo isn't asked again for a few minutes. Then it
// is: still nothing left stays out (and waits again); credit there ends it.
const bopsPlan = { answer: null };
web.answer = (c) => (c.host === "www.orgo.ai" && c.path === "/api/bops/plan" ? (bopsPlan.answer?.(c) ?? Response.json({ error: "Not found" }, { status: 404 })) : providers(c));
const asked0 = web.calls.length;
assert.equal(await Cl.creditsOut(), true);
assert.equal(web.calls.slice(asked0).filter((c) => c.path === "/api/bops/plan").length, 0, "not asked again yet");
const PLAN = { tier: "free_bops", name: "Free", price_cents: 0, status: null, period_end: null, cancel_at_period_end: false, credit: { left_micros: -25_000, left_cents: 0, plan_left_micros: 0, plan_resets_at: null, free_left_micros: -25_000 } };
bopsPlan.answer = () => Response.json(PLAN);
S.update((s) => (s.credits = { out: true, at: Date.now() - 6 * 60_000 }));
assert.equal(await Cl.creditsOut(), true);
assert.ok(Date.now() - S.getState().credits.at < 1000, "asked again in a few minutes");
assert.equal(web.calls.at(-1).headers.authorization, `Bearer ${KEY}`);
S.update((s) => (s.credits = { out: true, at: Date.now() - 6 * 60_000 }));
bopsPlan.answer = () => Response.json({ ...PLAN, tier: "pro_bops", name: "Pro", price_cents: 2000, status: "active", period_end: "2026-11-06T00:00:00Z", credit: { left_micros: 19_975_000, left_cents: 1997, plan_left_micros: 20_000_000, plan_resets_at: "2026-11-06T00:00:00Z", free_left_micros: -25_000 } });
assert.equal(await Cl.creditsOut(), false);
assert.equal(S.getState().credits, undefined, "credit again: no longer out");
// Self-hosting has no AI credit: never out.
S.update((s) => (s.credits = { out: true, at: Date.now() }));
await selfHosted({}, async () => assert.equal(await Cl.creditsOut(), false));
S.update((s) => (s.credits = undefined));

// The Bops plan, as the account page shows it: Orgo's answer in the app's words (money in micro-dollars, times in ms).
assert.deepEqual(await L.readBopsPlan(KEY), {
  tier: "pro_bops",
  name: "Pro",
  priceCents: 2000,
  status: "active",
  periodEnd: Date.parse("2026-11-06T00:00:00Z"),
  credit: { leftMicros: 19_975_000, planLeftMicros: 20_000_000, resetsAt: Date.parse("2026-11-06T00:00:00Z"), freeLeftMicros: -25_000 },
});
bopsPlan.answer = () => Response.json({ tier: "something_new", credit: {} });
assert.deepEqual(await L.readBopsPlan(KEY), { tier: "free_bops", name: "Free", priceCents: 0 }, "no balance in the answer: none made up");
// An Orgo plan is never a Bops one: Free until Orgo says Pro or Max.
bopsPlan.answer = () => Response.json({ tier: "scale_v2", name: "Scale", credit: { left_micros: 0 } });
assert.deepEqual(await L.readBopsPlan(KEY), { tier: "free_bops", name: "Free", priceCents: 0, credit: { leftMicros: 0, planLeftMicros: 0, freeLeftMicros: 0 } });
bopsPlan.answer = null;
assert.equal(await L.readBopsPlan(KEY), null, "an Orgo without Bops plans");

// Paying and managing: Orgo's checkout or billing page for the browser, asked with the Orgo key; its refusals in plain words.
const billing = [];
web.answer = (c) => {
  if (c.host !== "www.orgo.ai" || !c.path.startsWith("/api/bops/")) return providers(c);
  billing.push(c);
  if (c.path === "/api/bops/checkout") {
    const { tier } = JSON.parse(c.body);
    return tier === "max_bops" ? Response.json({ error: "Bops plans aren't on yet", code: "bops_plans_off" }, { status: 503 }) : Response.json({ url: "https://checkout.stripe.com/c/pay/cs_test_1" });
  }
  if (c.path === "/api/bops/portal") return Response.json({ error: "No Bops plan", code: "no_bops_plan" }, { status: 409 });
  return null;
};
assert.deepEqual(await L.bopsBillingLink(KEY, { tier: "pro_bops" }), { url: "https://checkout.stripe.com/c/pay/cs_test_1" });
assert.deepEqual([billing[0].method, billing[0].headers.authorization, JSON.parse(billing[0].body)], ["POST", `Bearer ${KEY}`, { tier: "pro_bops" }]);
assert.deepEqual(await L.bopsBillingLink(KEY, { tier: "max_bops" }), { error: "Upgrades open soon.", status: 503, soon: true });
assert.deepEqual(await L.bopsBillingLink(KEY, "manage"), { error: "You don't have a paid plan to manage yet.", status: 409 });
assert.equal(billing.at(-1).path, "/api/bops/portal");
// An Orgo without Bops billing yet (no such route): upgrades open soon, not an error.
web.answer = (c) => (c.host === "www.orgo.ai" && c.path.startsWith("/api/bops/") ? new Response("Not found", { status: 404 }) : providers(c));
assert.deepEqual(await L.bopsBillingLink(KEY, { tier: "pro_bops" }), { error: "Upgrades open soon.", status: 404, soon: true });
web.answer = providers;
console.log("AI credit: out of it from the cloud's 402, rechecked with Orgo, the Bops plan and its pages from Orgo");

/* ---------------- Codes through the cloud ---------------- */

V.setVerifyApiForTests(null);
const HOUR = 3_600_000;
const t0 = 2_000_000_000_000;
const verifyAnswers = { start: null, check: null };
cloud.handle = (r) => {
  const step = /^\/v1\/verify\/(start|check)$/.exec(r.path)?.[1];
  return step ? verifyAnswers[step](r) : cloudDefault(r);
};
verifyAnswers.start = () => ({ json: { sid: "VEc1", status: "pending" } });
verifyAnswers.check = () => ({ json: { sid: "VEc1", status: "approved" } });
n = cloud.requests.length;
let r = await V.startVerification("sms", "+15551230001", "i:c", 7, t0);
assert.equal(r.ok, true, JSON.stringify(r));
assert.equal(since(n)[0].path, "/v1/verify/start");
assert.deepEqual(json(since(n)[0]), { to: "+15551230001", channel: "sms" });
assert.equal(since(n)[0].headers.authorization, `Bearer ${KEY}`);
r = await V.checkVerification("sms", "+15551230001", "i:c", "123456", t0 + 1000);
assert.deepEqual(r, { ok: true, ref: "VEc1", consentAt: 7 });
assert.deepEqual(json(since(n)[1]), { to: "+15551230001", code: "123456" });
// The cloud's errors carry Twilio's code and Retry-After, so they read as Twilio's did.
const starts = [
  [429, { error: "x", code: 60203, retryAfter: 120 }, "Too many codes were sent to this number. Try again in 2 min."],
  [400, { error: "x", code: 60200 }, "That number can't get a text. Check it and try again."],
  [409, { error: "Verified on another account" }, "That number is already verified on another Bops account."],
  [401, { error: "Sign in with Orgo" }, "Checking numbers by text isn't working on this server right now."],
  [503, { error: "x" }, "Couldn't send a code right now. Try again in a minute."],
];
for (const [i, [status, body, error]] of starts.entries()) {
  verifyAnswers.start = () => ({ status, json: body });
  r = await V.startVerification("sms", `+1555123010${i}`, "i:c", 1, t0 + (i + 1) * HOUR);
  assert.equal(r.ok, false);
  assert.equal(r.error, error, String(status));
}
const checks = [
  [404, { error: "x", code: 20404 }, "That code can't be used anymore. Send a new one.", true],
  [429, { error: "x", code: 60202 }, "Too many wrong codes. Send a new one.", true],
  [409, { error: "Verified on another account" }, "That number is already verified on another Bops account.", true],
  [400, { error: "x" }, "Enter the 6-digit code from the text.", undefined],
];
for (const [i, [status, body, error, restart]] of checks.entries()) {
  verifyAnswers.start = () => ({ json: { sid: `VEk${i}`, status: "pending" } });
  verifyAnswers.check = () => ({ status, json: body });
  const to = `+1555123020${i}`;
  assert.equal((await V.startVerification("sms", to, "i:k", 1, t0 + (i + 10) * HOUR)).ok, true);
  r = await V.checkVerification("sms", to, "i:k", "123456", t0 + (i + 10) * HOUR + 1000);
  assert.deepEqual([r.ok, r.error, r.restart], [false, error, restart], String(status));
}
// Email codes only when the session says the cloud sends them.
n = cloud.requests.length;
assert.equal(await V.emailCodesOn(t0), false);
r = await V.startVerification("email", "me@example.org", "i:c", 0, t0);
assert.equal(r.error, "Adding another email by code isn't available yet.");
assert.equal(since(n).length, 0);
await withSession({ ...SESSION, verify: { sms: true, email: true } });
V.setVerifyApiForTests(null);
assert.equal(await V.emailCodesOn(t0), true);
await withSession({ ...SESSION, verify: { sms: false, email: true } });
assert.equal(V.verifyOn(), false, "texts off");
r = await V.startVerification("sms", "+15551230300", "i:c", 1, t0);
assert.equal(r.error, "Checking numbers by text isn't set up on this server.");
await withSession(SESSION);
V.setVerifyApiForTests(null);
cloud.handle = null;
console.log("codes: through the cloud, its errors read as before");

/* ---------------- The webhook routes, and the tunnel's token ---------------- */

const token = g.bopsCloudTunnel.token;
assert.equal(typeof token, "string");
assert.ok(token.length >= 40);
const request = (path, headers, body) => new Request(`http://127.0.0.1:3210${path}`, { method: "POST", headers: { "content-type": "application/json", ...headers }, body });
const voiceTurn = JSON.stringify({ event: "agent.message", channel: "voice", agentId: "agt_nobody", data: {} });
// Replayed by the tunnel: the cloud checked the signature (it keeps the secrets), so it's taken as is.
let res = await AP.POST(request("/api/phone/agentphone", { "x-bops-cloud": token, "x-webhook-id": "wh_1" }, voiceTurn));
assert.equal(res.status, 200);
assert.equal((await res.json()).hangup, true);
// Anything else is checked as before, and this Mac has no secret: nothing gets in.
for (const forged of [{}, { "x-bops-cloud": "x".repeat(token.length) }, { "x-bops-cloud": token.slice(1) }, { "x-bops-cloud": `${token}x` }]) {
  res = await AP.POST(request("/api/phone/agentphone", forged, voiceTurn));
  assert.equal(res.status, 503, JSON.stringify(forged));
}
// Self-hosting with a secret: a signed delivery is taken; a made-up token is no signature.
process.env.AGENTPHONE_WEBHOOK_SECRET = "whsec_test";
const stamp = String(Math.floor(Date.now() / 1000));
const signature = `sha256=${createHmac("sha256", "whsec_test").update(`${stamp}.${voiceTurn}`).digest("hex")}`;
res = await AP.POST(request("/api/phone/agentphone", { "x-webhook-timestamp": stamp, "x-webhook-signature": signature }, voiceTurn));
assert.equal(res.status, 200);
res = await AP.POST(request("/api/phone/agentphone", { "x-bops-cloud": "made-up", "x-webhook-timestamp": stamp, "x-webhook-signature": "sha256=00" }, voiceTurn));
assert.equal(res.status, 400);
delete process.env.AGENTPHONE_WEBHOOK_SECRET;

// OpenAI's: the same.
const otherEvent = JSON.stringify({ id: "evt_1", object: "event", type: "response.completed", created_at: 1, data: { id: "resp_1" } });
res = await OAI.POST(request("/api/phone/openai", { "x-bops-cloud": token }, otherEvent));
assert.deepEqual([res.status, await res.json()], [200, { ok: true }]);
res = await OAI.POST(request("/api/phone/openai", {}, otherEvent));
assert.equal(res.status, 503);
process.env.OPENAI_WEBHOOK_SECRET = `whsec_${Buffer.from("a test secret for the hooks").toString("base64")}`;
res = await OAI.POST(request("/api/phone/openai", { "x-bops-cloud": "made-up", "webhook-id": "x", "webhook-timestamp": stamp, "webhook-signature": "v1,AAAA" }, otherEvent));
assert.equal(res.status, 400);
delete process.env.OPENAI_WEBHOOK_SECRET;
res = await OAI.POST(request("/api/phone/openai", { "x-bops-cloud": token }, "not json"));
assert.equal(res.status, 400);
// A call to the workspace's number, replayed: accepted through the cloud, and its sideband connects there too.
S.update((s) => (s.ownerPhones = [{ number: "+14155550166", consentAt: 1, verifiedAt: 2, userId: "u1" }]));
cloud.handle = (r) => (r.path.startsWith("/proxy/openai/") ? { json: {} } : r.path.startsWith("/proxy/honcho/") ? honchoAnswer(r) : cloudDefault(r));
const incoming = {
  id: "evt_9",
  object: "event",
  type: "live.transport.incoming",
  created_at: 1,
  data: { session_id: "sess_9", sip_headers: [{ name: "From", value: "<sip:+14155550166@carrier.example>" }, { name: "To", value: "<sip:+14155550100@sip.api.openai.com>" }] },
};
res = await OAI.POST(request("/api/phone/openai", { "x-bops-cloud": token }, JSON.stringify(incoming)));
assert.equal(res.status, 200);
await until(() => cloud.requests.some((x) => x.path === "/proxy/openai/v1/live/sessions/sess_9/accept"), "the call accepted through the cloud");
assert.equal(cloud.requests.find((x) => x.path === "/proxy/openai/v1/live/sessions/sess_9/accept").headers.authorization, `Bearer ${KEY}`);
await until(() => cloud.upgrades.find((u) => u.path === "/proxy/openai/v1/live/sessions/sess_9/attach"), "the sideband");
assert.equal(cloud.upgrades.find((u) => u.path === "/proxy/openai/v1/live/sessions/sess_9/attach").auth, `Bearer ${KEY}`);
await until(() => S.getState().messages.some((m) => m.call?.phone === "+14155550166"), "the call's note");
assert.equal(S.getState().bots[0].voice, "cedar", "the voice it answered in is kept for the cloud");
cloud.handle = null;

// The tunnel's events: only with the token; a call the cloud answered becomes a note in the bot's chat, once.
const callNote = (id) => S.getState().messages.filter((m) => m.sms?.id === `cloud-call:${id}`);
const ownersCall = { botId: "boppy", from: "+14155550166", owner: true, message: { text: "Remind me to call Ana" }, transcript: "Caller: Remind me to call Ana\nBot: Will do.", startedAt: "2026-10-05T10:00:00Z", endedAt: "2026-10-05T10:00:42Z" };
res = await EV.POST(request("/api/cloud/event", {}, JSON.stringify({ id: "1", kind: "call", payload: ownersCall })));
assert.equal(res.status, 403);
for (let i = 0; i < 2; i++) {
  res = await EV.POST(request("/api/cloud/event", { "x-bops-cloud": token }, JSON.stringify({ id: "1", kind: "call", payload: ownersCall, at: "2026-10-05T10:01:00Z" })));
  assert.equal(res.status, 200);
}
assert.equal(callNote("1").length, 1, "handed over twice, noted once");
assert.equal(callNote("1")[0].text, 'While your Mac was away, you called: "Remind me to call Ana"\n\nCaller: Remind me to call Ana\nBot: Will do.');
assert.deepEqual(callNote("1")[0].call, { seconds: 42, phone: "+14155550166" });
// Anyone else got a bot that only takes a message (cloud/voice.ts): the message is in the chat, with a chime, once.
const strangersCall = { botId: "boppy", from: "+14155550123", owner: false, message: { name: "Ana", text: "Send the deck", callback: "+14155550124" }, transcript: "Caller: Can you pass on a message?\nBot: Sure.", startedAt: "2026-10-05T11:00:00Z", endedAt: "2026-10-05T11:01:05Z" };
for (let i = 0; i < 2; i++) {
  res = await EV.POST(request("/api/cloud/event", { "x-bops-cloud": token }, JSON.stringify({ id: "2", kind: "call", payload: strangersCall })));
  assert.equal(res.status, 200);
}
assert.equal(callNote("2").length, 1);
assert.equal(callNote("2")[0].text, 'While your Mac was away, someone called and left a message (Ana): "Send the deck" Reach them at +14155550124.\n\nCaller: Can you pass on a message?\nBot: Sure.');
assert.deepEqual([callNote("2")[0].sms.from, callNote("2")[0].call, callNote("2")[0].ping], ["+14155550123", { seconds: 65, phone: "+14155550123" }, true]);
assert.equal(S.getState().ownerPhones.some((p) => p.number === "+14155550123"), false, "a stranger's number is nobody's");
// A first call that claimed the line (the cloud answered it): that phone is the user's here too.
res = await EV.POST(request("/api/cloud/event", { "x-bops-cloud": token }, JSON.stringify({ id: "4", kind: "call", payload: { ...ownersCall, from: "+14155550177", claimed: "call" } })));
assert.equal(res.status, 200);
assert.equal(S.getState().ownerPhones.find((p) => p.number === "+14155550177")?.claimedVia, "call");
res = await EV.POST(request("/api/cloud/event", { "x-bops-cloud": token }, JSON.stringify({ id: "3", kind: "mystery", payload: {} })));
assert.equal(res.status, 422, "a kind this app doesn't know waits for one that does");
res = await EV.POST(request("/api/cloud/event", { "x-bops-cloud": token }, JSON.stringify({ kind: "call", payload: ownersCall })));
assert.equal(res.status, 400);
console.log("routes: the tunnel's token is taken as checked, everything else is checked as before");

/* ---------------- Slack through the cloud, and pairing ---------------- */

// Bops' own Slack app on the cloud (CloudSession.slack): the main bot is in #general of the Acme
// workspace through the user's Slack account, not paired yet. Slack's API is reached through the cloud's Composio proxy.
const SLACK_SESSION = { ...SESSION, slack: { appId: "A0C6UNXT54J" } };
const linksPut = () => cloud.requests.filter((x) => x.method === "PUT" && x.path === "/v1/slack/links");
const posted = () => cloud.requests.filter((x) => x.path === "/proxy/composio/api/v3.1/tools/execute/proxy" && json(x).endpoint === "/chat.postMessage").map((x) => json(x).body);
const slackCloud = (x) => {
  if (x.method === "PUT" && x.path === "/v1/slack/links") return { json: { links: [] } };
  if (x.path === "/proxy/composio/api/v3.1/tools/execute/proxy") return { json: { data: { ok: true }, status: 200, headers: {} } };
  if (x.path.startsWith("/proxy/composio/api/v3.1/tools/SLACKBOT_")) return { json: { slug: x.path.split("/").pop().split("?")[0], name: "Slack", tags: [], toolkit: { slug: "slackbot", name: "Slack" } } };
  if (x.path.startsWith("/proxy/composio/api/v3.1/tools/execute/SLACKBOT_RETRIEVE_DETAILED_USER_INFORMATION")) return { json: { data: { user: { real_name: "Ana Owner" } }, error: null, successful: true } };
  if (x.path.startsWith("/proxy/openai/")) return { json: {} };
  return cloudDefault(x);
};
cloud.handle = slackCloud;
await withSession(SLACK_SESSION);
const slackLink = { id: "ch_s1", kind: "slack", botId: "boppy", handle: "Acme", pairCode: "424242", pairCodeAt: Date.now(), pairTries: 0, status: "live", at: Date.now(), slack: { accountId: "ca_slack", teamId: "T0ACME", botUserId: "UBOPS", channels: [{ id: "C0GEN", name: "general" }] } };
S.update((s) => {
  s.accounts = [{ id: "ca_slack", app: "slackbot", appName: "Slack", name: "Acme", status: "active", at: 1 }];
  s.channels = [structuredClone(slackLink)];
});
const link = () => S.getState().channels.find((l) => l.id === "ch_s1");
assert.equal(CH.ownSlackApp(), true, "the cloud's Slack app is this app's");
// Where the bots are goes to the cloud: once, then only when it changes.
let l0 = linksPut().length;
await CH.syncSlackLinks({ now: true });
assert.equal(linksPut().length, l0 + 1);
assert.deepEqual(json(linksPut().at(-1)), { links: [{ accountId: "ca_slack", channels: ["C0GEN"], dm: null, owners: [], pairing: true }] });
assert.equal(linksPut().at(-1).headers.authorization, `Bearer ${KEY}`);
await CH.syncSlackLinks({ now: true });
assert.equal(linksPut().length, l0 + 1, "nothing changed: nothing sent");
// The cloud's public pages: the bots' pictures and the page after an app's sign-in.
assert.equal(C.publicUrl(), "https://cloud.example");
assert.equal(CH.mascotUrl(S.getState().bots.find((b) => b.isMain)), "https://cloud.example/mascot/main-0A0A0A.png");

// Each message its own ts, as Slack gives them (seconds and a sequence): a message seen before isn't handled again.
let slackSeq = 0;
const envelope = (event, more = {}) => ({ type: "event_callback", team_id: "T0ACME", event_id: `Ev${++slackSeq}`, event: { type: "message", ts: `1791266000.${String(slackSeq).padStart(6, "0")}`, ...event }, ...more });
const dm = (text, user = "U0ANA") => envelope({ channel: "D0ANA", channel_type: "im", user, text });
const viaTunnel = (body) => SE.POST(request("/api/channels/slack/events", { "x-bops-cloud": token }, JSON.stringify(body)));
// Replayed by the tunnel: the cloud checked Slack's signature. Anything else needs Slack's own, and this Mac has no secret.
res = await viaTunnel({ type: "url_verification", challenge: "abc" });
assert.deepEqual(await res.json(), { challenge: "abc" });
res = await SE.POST(request("/api/channels/slack/events", {}, JSON.stringify(dm("hi"))));
assert.equal(res.status, 401, "unsigned");
res = await SE.POST(request("/api/channels/slack/events", { "x-bops-cloud": "x".repeat(token.length) }, JSON.stringify(dm("hi"))));
assert.equal(res.status, 401, "a made-up token");
// Self-hosted with its own Slack app: Slack's signature, checked here.
process.env.BOPS_SLACK_SIGNING_SECRET = "slack_secret";
const slackStamp = String(Math.floor(Date.now() / 1000));
const verification = JSON.stringify({ type: "url_verification", challenge: "xyz" });
const slackSig = `v0=${createHmac("sha256", "slack_secret").update(`v0:${slackStamp}:${verification}`).digest("hex")}`;
res = await SE.POST(request("/api/channels/slack/events", { "x-slack-request-timestamp": slackStamp, "x-slack-signature": slackSig }, verification));
assert.deepEqual([res.status, await res.json()], [200, { challenge: "xyz" }]);
res = await SE.POST(request("/api/channels/slack/events", { "x-slack-request-timestamp": slackStamp, "x-slack-signature": `${slackSig.slice(0, -2)}00` }, verification));
assert.equal(res.status, 401);
res = await SE.POST(request("/api/channels/slack/events", { "x-slack-request-timestamp": String(Number(slackStamp) - 600), "x-slack-signature": slackSig }, verification));
assert.equal(res.status, 401, "stale");
delete process.env.BOPS_SLACK_SIGNING_SECRET;

// Pairing: a message that holds the code among other words doesn't pair, and isn't counted as a try.
let before = posted().length;
res = await viaTunnel(dm("my code is 424242"));
assert.equal(res.status, 200);
await until(() => posted().length > before, "the pairing hint");
assert.match(posted().at(-1).markdown_text, /To pair with me, send me the code shown in Bops/);
assert.equal(posted().at(-1).icon_url, "https://cloud.example/mascot/main-0A0A0A.png", "the bot's picture, from the cloud");
assert.deepEqual([link().owner, link().pairTries, link().slack.dm], [undefined, 0, undefined], "not paired, no try, and a stranger's DM isn't recorded");
// A wrong code counts.
await viaTunnel(dm("111 111"));
await until(() => link().pairTries === 1, "a wrong code counted");
// The right code, waiting in the cloud while the Mac was away (a "slack" event): paired, and the DM recorded as theirs.
before = posted().length;
l0 = linksPut().length;
res = await EV.POST(request("/api/cloud/event", { "x-bops-cloud": token }, JSON.stringify({ id: "s1", kind: "slack", payload: dm("424242"), at: new Date().toISOString() })));
assert.equal(res.status, 200);
await until(() => link().owner === "U0ANA", "paired");
assert.deepEqual([link().ownerName, link().slack.dm, link().pairTries], ["Ana Owner", "D0ANA", 0]);
assert.notEqual(link().pairCode, "424242", "the code is used up");
await until(() => posted().length > before, "the hello");
assert.match(posted().at(-1).markdown_text, /^Hi Ana, it's Boppy\. We're paired/);
await until(() => linksPut().length > l0, "the cloud told");
assert.deepEqual(json(linksPut().at(-1)), { links: [{ accountId: "ca_slack", channels: ["C0GEN"], dm: "D0ANA", owners: ["U0ANA"], pairing: false }] });
// Paired: a code (even the new one) pairs nobody else.
await viaTunnel(dm(link().pairCode, "U0EVE"));
await sleep(150);
assert.equal(link().owner, "U0ANA", "only while unpaired");
// The bot knows where it's in Slack, and what a message from there looks like.
const mainBot = () => S.getState().bots.find((b) => b.isMain);
assert.match(K.placesNote(mainBot(), "chat"), /in Slack \(Acme: #general, direct messages with the Bops app\)/);
assert.match(K.placesNote(mainBot(), "chat"), /A message marked \[in Slack\] is .+ writing to you there/);
assert.match(K.placesNote(mainBot(), "task"), /in Slack \(Acme: #general.*your final answer goes back there on its own/);
// The owner in a channel shared with another workspace (Slack names the installation's workspace in
// authorizations): it reaches the bot, as from Slack.
const ownersWords = (text) => S.getState().messages.find((m) => m.chatId === "bot:boppy" && m.role === "user" && m.text === text);
await viaTunnel(envelope({ channel: "C0GEN", user: "U0ANA", text: "<@UBOPS> what's on today?" }, { team_id: "T0OTHER", authorizations: [{ team_id: "T0ACME" }] }));
await until(() => ownersWords("what's on today?"), "the owner's message in the bot's chat");
assert.equal(ownersWords("what's on today?").via, "slack");
assert.deepEqual(ownersWords("what's on today?").channel.linkId, "ch_s1");
// Another workspace's event never reaches this Mac's bots.
await viaTunnel(envelope({ channel: "C0GEN", user: "U0ANA", text: "<@UBOPS> elsewhere" }, { team_id: "T0OTHER" }));
await sleep(150);
assert.equal(ownersWords("elsewhere"), undefined);
// Pair again: a fresh code, nobody paired, and the old DM forgotten.
CH.repair("ch_s1");
assert.deepEqual([link().owner, link().slack.dm, link().pairTries], [undefined, undefined, 0]);
// A code runs out after an hour...
S.update(() => Object.assign(link(), { pairCodeAt: Date.now() - PAIR_CODE_MS - 1000 }));
await viaTunnel(dm(link().pairCode));
await sleep(150);
assert.equal(link().owner, undefined, "an expired code");
// ...and after five wrong codes, even the right one stops working.
CH.repair("ch_s1");
for (let i = 0; i < 5; i++) await viaTunnel(dm(`99999${i}`, `U0BAD${i}`));
await until(() => link().pairTries === 5, "five wrong codes");
await viaTunnel(dm(link().pairCode));
await sleep(150);
assert.equal(link().owner, undefined, "worn out");
await CH.syncSlackLinks({ now: true });
assert.equal(json(linksPut().at(-1)).links[0].pairing, false, "the cloud stops sending strangers' DMs once no code can pair");
// Linking needs the cloud's Slack app.
await withSession(SESSION);
await assert.rejects(CH.linkSlack("boppy", "ca_slack", []), /Slack isn't available in Bops yet/);
// Done: no bot in Slack, and the cloud told so.
await withSession(SLACK_SESSION);
S.update((s) => {
  s.channels = [];
  s.accounts = [];
});
await CH.syncSlackLinks({ now: true });
assert.deepEqual(json(linksPut().at(-1)), { links: [] });
await sleep(600);
await withSession(SESSION);
cloud.handle = null;

// Apps: only what Composio marks read-only runs unasked; GMAIL_SEND_DRAFT sends, so it asks.
const gmailTool = (slug, tags) => ({ slug, name: slug === "GMAIL_SEND_DRAFT" ? "Send Draft" : "Fetch Emails", tags, toolkit: { slug: "gmail", name: "Gmail" } });
cloud.handle = (x) => {
  if (x.path.startsWith("/proxy/composio/api/v3.1/tools/GMAIL_SEND_DRAFT")) return { json: gmailTool("GMAIL_SEND_DRAFT", []) };
  if (x.path.startsWith("/proxy/composio/api/v3.1/tools/GMAIL_FETCH_EMAILS")) return { json: gmailTool("GMAIL_FETCH_EMAILS", ["readOnlyHint"]) };
  if (x.path.startsWith("/proxy/composio/api/v3.1/tools/execute/")) return { json: { data: { messages: [] }, error: null, successful: true } };
  if (x.path === "/proxy/typesafe/v1/systemone") return { status: 503, json: { error: "down" } };
  return cloudDefault(x);
};
S.update((s) => {
  s.accounts = [
    { id: "ca_gmail", app: "gmail", appName: "Gmail", name: "me@example.com", status: "active", at: 1 },
    { id: "ca_sheets", app: "googlesheets", appName: "Google Sheets", name: "me@example.com", label: "Work", status: "active", at: 1 },
    { id: "ca_jira", app: "jira", appName: "Jira", status: "active", at: 1 },
    // The Slack connection is how bots get into Slack, not one of their apps: it's in neither list.
    { id: "ca_slackapp", app: "slackbot", appName: "Slack", name: "Acme", status: "active", at: 1 },
  ];
  s.bots.find((b) => b.isMain).access = { ca_gmail: "act", ca_sheets: "read" };
});
// What the bot is told: each account it may use by name and level, from the user's own accounts (any
// app), how to use the app gateway, and the user's other apps it can't use yet.
const told = K.appsNote(mainBot(), "chat");
assert.match(told, /Gmail \(me@example\.com: read & act\), Google Sheets \(Work · me@example\.com: read only\)/);
assert.match(told, /first call find_app_actions .* Then call use_app with one exact name/);
assert.match(told, /also has Jira connected, which you can't use yet/);
S.update((s) => (s.bots.find((b) => b.isMain).access.ca_slackapp = "act"));
assert.ok(!/Slack/.test(K.appsNote(mainBot(), "chat")), "not even when the bot was given the Slack connection");
assert.ok(!C.APP_TOOLS(mainBot()).some((t) => /Slack/.test(t.description)));
assert.match(K.appsNote(mainBot(), "task", { tools: false }), /can't be reached from this computer/);
assert.ok(!/find_app_actions with the job/.test(K.appsNote(mainBot(), "task", { tools: false })));
assert.match(C.APP_TOOLS(mainBot())[0].description, /app gateway .*Google Sheets \(Work · me@example\.com: read only\)/);
const executed = () => cloud.requests.filter((x) => x.path.startsWith("/proxy/composio/api/v3.1/tools/execute/")).map((x) => x.path.split("/").pop());
let decision = null;
const draft = await C.runAppAction("boppy", "GMAIL_SEND_DRAFT", { draft_id: "d1" }, { chatId: "bot:boppy" }, (a) => (decision = a));
assert.match(draft, /^This needs .+'s approval first: Send Draft in Gmail/);
const approval = S.getState().appApprovals.find((a) => a.action === "GMAIL_SEND_DRAFT");
assert.ok(approval && decision, "waits for the user");
assert.ok(!executed().includes("GMAIL_SEND_DRAFT"), "nothing sent yet");
C.answerApp(approval.id, false);
assert.match(await decision, /^Not approved/);
assert.ok(!executed().includes("GMAIL_SEND_DRAFT"), "and nothing sent after a no");
assert.equal(await C.runAppAction("boppy", "GMAIL_FETCH_EMAILS", {}, { chatId: "bot:boppy" }), '{"messages":[]}');
assert.ok(executed().includes("GMAIL_FETCH_EMAILS"), "reading runs at once");
S.update((s) => {
  s.accounts = [];
  delete s.bots.find((b) => b.isMain).access;
});
cloud.handle = null;
console.log("slack: through the cloud's app (events over the tunnel or waiting, links told), pairing codes exact, fresh, once; apps ask before a send; bots told their apps, the gateway and where they're reached");

/* ---------------- The state backup, and restoring onto a fresh install ---------------- */

// (What the calls above set going in the background settles first: a bot's reply, a call's note.)
await sleep(1000);
B.setBackupDelayForTests(150);
const backupBox = g.bopsCloudBackup;
const puts = () => cloud.requests.filter((x) => x.method === "PUT" && x.path === "/v1/state");
const gets = () => cloud.requests.filter((x) => x.method === "GET" && x.path === "/v1/state");
/** This Mac as a fresh install: the main bot alone, nothing said or set up, not checked against the cloud yet. */
const freshen = () =>
  S.update((s) => {
    s.bots = s.bots.filter((b) => b.isMain);
    for (const b of s.bots) {
      delete b.phone;
      delete b.phoneLine;
    }
    s.messages = [];
    s.sessions = [];
    s.routines = [];
    s.watches = [];
    s.vault = [];
    s.accounts = [];
    s.channels = [];
    s.ownerPhones = [];
    s.ownerEmails = [];
    s.workspaces = s.workspaces.slice(0, 1);
    delete s.workspaces[0].line;
    s.owner = { name: "Test" };
    delete s.cloudUser;
  });
freshen();
assert.equal(B.freshInstall(S.getState()), true);
assert.equal(B.freshInstall({}), true, "raw JSON with nothing in it");
for (const real of [{ messages: [{ role: "user" }] }, { bots: [{}, {}] }, { owner: { name: "A", about: "Bakes" } }, { ownerPhones: [{}] }, { routines: [{}] }, { accounts: [{}] }, { channels: [{}] }, { apps: { gmail: {} } }])
  assert.equal(B.freshInstall(real), false, JSON.stringify(real));
// The name from Orgo and a bot's first inbox come by themselves: still fresh.
S.update((s) => (s.bots[0].mail = { inboxId: "boppy@main.bops.bot", podId: "pod_u1" }));
assert.equal(B.freshInstall(S.getState()), true);

// Fresh here, and the cloud has a real copy: restored, keeping what's this Mac's own.
const backedUp = {
  bots: [
    { id: "boppy", name: "Sam", role: "Chief of Staff", color: "#0A0A0A", isMain: true, computerStatus: "none", connectors: {}, channels: {}, voice: "cedar" },
    { id: "max", name: "Max", role: "Research", color: "#E9FF3B", isMain: false, computerStatus: "none", connectors: { calendar: "Read only" }, channels: {} },
  ],
  // From an app before several accounts per app: one account per app, each bot's access by app.
  apps: { calendar: { accountId: "ca_cal", account: "ana@bakery.com", status: "active", at: 3 } },
  messages: [{ id: "m1", chatId: "bot:boppy", role: "user", text: "hello", at: 1 }],
  sessions: [],
  routines: [],
  owner: { name: "Ana", about: "Runs a bakery" },
  account: { user: { id: "someone-else" }, signedInAt: 0 },
  relay: { on: true, deviceId: "dev_other" },
  installId: "cafe1234",
  usage: [{ kind: "mail.inbox", at: 5 }],
};
S.update((s) => {
  s.relay = { on: false, turnedOff: true };
  s.usage = [{ kind: "mail.inbox", at: 9 }];
});
cloud.handle = (x) => (x.method === "GET" && x.path === "/v1/state" ? { json: { version: 7, state: backedUp } } : cloudDefault(x));
let p0 = puts().length;
await B.checkBackup();
let st = S.getState();
assert.deepEqual(st.bots.map((b) => b.name), ["Sam", "Max"]);
assert.deepEqual(JSON.parse(JSON.stringify(st.accounts)), [{ id: "ca_cal", app: "googlecalendar", appName: "Google Calendar", name: "ana@bakery.com", status: "active", at: 3 }], "an old backup's apps become accounts");
assert.deepEqual([st.bots[1].access, "connectors" in st.bots[1], "channels" in st.bots[1], "apps" in st], [{ ca_cal: "read" }, false, false, false], "and each bot's access is by account");
assert.deepEqual([st.owner.name, st.installId, st.messages[0].text], ["Ana", "cafe1234", "hello"]);
assert.equal(st.account.user.id, "u1", "who's signed in stays");
assert.deepEqual(st.relay, { on: false, turnedOff: true }, "routing through this Mac stays this Mac's");
assert.deepEqual(st.usage.map((u) => u.at), [5, 9], "what it cost here joins what it cost before");
assert.equal(st.cloudUser, "u1");
assert.equal(gets().at(-1).headers.authorization, `Bearer ${KEY}`);
assert.deepEqual([backupBox.dirty, backupBox.timer, puts().length], [false, undefined, p0], "the restored copy isn't sent straight back");
cloud.handle = null;

// From now on a change goes up 30 seconds (here 150 ms) later, with whatever else changed: one upload, gzipped.
S.update((s) => (s.bots[0].appsKey = "the-apps-secret"));
for (let i = 0; i < 5; i++) S.update((s) => (s.owner.about = `v${i}`));
await until(() => puts().length > p0, "an upload");
await sleep(350);
assert.equal(puts().length, p0 + 1, "one upload for the burst");
let put = puts().at(-1);
assert.equal(put.headers["content-encoding"], "gzip");
assert.equal(put.headers["content-type"], "application/json");
assert.equal(put.headers.authorization, `Bearer ${KEY}`);
let sent = JSON.parse(gunzipSync(put.body).toString("utf8"));
assert.equal(typeof sent.version, "number");
assert.equal(sent.state.owner.about, "v4");
assert.equal(sent.state.bots[0].voice, "cedar", "the cloud reads the voice to answer calls in");
assert.ok(!gunzipSync(put.body).toString("utf8").includes("the-apps-secret"), "bots' keys for app actions stay here");
// One at a time: a change while one is going up goes next, never alongside.
let inFlight = 0;
let most = 0;
cloud.handle = async (x) => {
  if (x.method === "PUT") {
    inFlight++;
    most = Math.max(most, inFlight);
    await sleep(300);
    inFlight--;
  }
  return cloudDefault(x);
};
p0 = puts().length;
S.update((s) => (s.owner.about = "w1"));
await sleep(200);
S.update((s) => (s.owner.about = "w2"));
await sleep(50);
const flushed = B.flushBackup();
await until(() => puts().length >= p0 + 2, "both uploads");
await flushed;
await sleep(500);
assert.equal(most, 1, "never two at once");
assert.equal(JSON.parse(gunzipSync(puts().at(-1).body).toString("utf8")).state.owner.about, "w2", "the latest went last");
cloud.handle = null;
// Sending now (a sign-out, the server stopping): at once, not in 30 seconds.
B.setBackupDelayForTests(60_000);
p0 = puts().length;
S.update((s) => (s.owner.about = "now"));
await B.flushBackup();
assert.equal(puts().length, p0 + 1);
B.setBackupDelayForTests(150);
// Never signed out, self-hosting, or for a state that's another account's.
p0 = puts().length;
signOut();
S.update((s) => (s.owner.about = "signed out"));
await sleep(300);
assert.equal(puts().length, p0, "not signed out");
signIn();
await until(() => puts().length > p0, "the change, once signed in again");
await sleep(300);
p0 = puts().length;
await selfHosted({}, async () => {
  S.update((s) => (s.owner.about = "self-hosted"));
  await sleep(300);
});
assert.equal(puts().length, p0, "not self-hosting");
S.update((s) => (s.cloudUser = "u-other"));
S.update((s) => (s.owner.about = "someone else's"));
await sleep(300);
assert.equal(puts().length, p0, "not for another account's state");
// That state stays the other account's: not claimed, not replaced, not even looked up.
let g0 = gets().length;
await B.checkBackup();
assert.equal(S.getState().cloudUser, "u-other");
assert.equal(gets().length, g0);
// A state with real content and no owner yet is claimed by the user it's checked for (no download needed).
S.update((s) => delete s.cloudUser);
await B.checkBackup();
assert.equal(S.getState().cloudUser, "u1");
assert.equal(gets().length, g0);
// Fresh, and the cloud has nothing (404) or nothing real: nothing restored, and it goes up from now on.
freshen();
await B.checkBackup();
assert.deepEqual([S.getState().cloudUser, S.getState().bots.length], ["u1", 1]);
freshen();
cloud.handle = (x) => (x.method === "GET" && x.path === "/v1/state" ? { json: { version: 1, state: { bots: [{ id: "boppy", name: "Boppy", isMain: true }], messages: [] } } } : cloudDefault(x));
await B.checkBackup();
assert.deepEqual([S.getState().cloudUser, S.getState().bots[0].name], ["u1", "Sam"], "not restored: nothing in it");
cloud.handle = null;
// Fresh and the cloud can't be reached: nothing goes up until it's been checked, so the backup isn't replaced.
freshen();
process.env.BOPS_CLOUD_URL = "http://127.0.0.1:9";
await assert.rejects(B.checkBackup(), /Couldn't reach Bops Cloud/);
process.env.BOPS_CLOUD_URL = CLOUD;
p0 = puts().length;
S.update((s) => (s.owner.about = ""));
await sleep(300);
assert.equal(puts().length, p0, "not checked yet: nothing went up");
await B.checkBackup();
S.update((s) => (s.owner.name = "Test again"));
await until(() => puts().length > p0, "an upload once checked");
console.log("backup: debounced, one at a time, gzipped; restored only onto a fresh install");

/* ---------------- Routing through this Mac: on by default, the user's "off" sticks ---------------- */

const statusNow = () => R.relayStatus();
// Orgo offers it: after sign-in it turns on by itself (paired, agent started), with no "off" on record.
orgo.offered = true;
S.update((s) => (s.relay = undefined));
R.relayAfterSignIn();
await until(() => S.getState().relay?.on, "routing on by default", 15_000);
assert.equal(S.getState().relay.deviceId, "dev_1");
assert.equal(S.getState().relay.turnedOff, undefined);
assert.deepEqual(JSON.parse(readFileSync(join(scratch, "keychain", encodeURIComponent("orgo-relay:u1")), "utf8")), { deviceId: "dev_1", code: "code_dev_1" }, "the pairing code in the Keychain");
await until(async () => (await statusNow()).running, "the relay running", 15_000);
let rs = await statusNow();
assert.deepEqual([rs.available, rs.on], [true, true]);
// The user turns it off: it stays off, also after a restart (it's in the state on disk) and a sign-in.
rs = await R.setRelay(false);
assert.equal(rs.on, false);
assert.deepEqual([S.getState().relay.on, S.getState().relay.turnedOff], [false, true]);
await R.reconcile();
await R.reconcile();
assert.equal(S.getState().relay.on, false);
await until(() => JSON.parse(readFileSync(join(scratch, ".data/state.json"), "utf8")).relay?.turnedOff, "the off saved");
R.relayAfterSignIn();
await R.reconcile();
assert.equal(S.getState().relay.on, false);
assert.equal((await statusNow()).on, false);
// A sign-out lets the device go, and keeps the user's "off".
await R.stopRelay(5000);
assert.deepEqual(S.getState().relay, { on: false, turnedOff: true });
// The user turns it on again: from then on it's on by default again.
rs = await R.setRelay(true);
assert.deepEqual([rs.on, S.getState().relay.on, S.getState().relay.turnedOff], [true, true, undefined]);
await R.stopRelay(5000);
assert.deepEqual(S.getState().relay, { on: false });
// Where Orgo doesn't offer it (403, production today): quietly off, and Orgo isn't asked again for a while.
orgo.offered = false;
R.relayAfterSignIn();
await R.reconcile();
const asked = orgo.calls.length;
await R.reconcile();
await R.reconcile();
rs = await statusNow();
assert.deepEqual([rs.available, rs.on, S.getState().relay.on], [false, false, false]);
assert.match(rs.reason, /isn't available on your Orgo account yet/);
assert.equal(orgo.calls.length, asked, "asked again only after 10 minutes");
// A Mac paired and turned off by an older build (no "off" on record yet) stays off; starting over keeps
// that, and whose backup the state is.
S.update((s) => (s.relay = { on: false, deviceId: "dev_9" }));
S.resetState();
assert.deepEqual([S.getState().relay, S.getState().cloudUser], [{ on: false, deviceId: "dev_9", turnedOff: true }, "u1"]);
S.update((s) => (s.relay = undefined));
console.log("routing: on by default where Orgo offers it, off when the user says so");

/* ---------------- The tunnel, against the fake cloud ---------------- */

// This Mac's server: the real webhook and event routes, behind a recorder.
const mac = { requests: [] };
const routes = { "/api/phone/agentphone": AP.POST, "/api/phone/openai": OAI.POST, "/api/cloud/event": EV.POST, "/api/channels/slack/events": SE.POST };
const macHttp = createServer((req, res) => {
  const chunks = [];
  req.on("data", (c) => chunks.push(c));
  req.on("end", async () => {
    const body = Buffer.concat(chunks);
    mac.requests.push({ method: req.method, path: req.url, headers: req.headers, body });
    const route = routes[new URL(req.url, "http://x").pathname];
    const headers = Object.entries(req.headers).filter(([k]) => !["host", "connection", "content-length", "transfer-encoding", "keep-alive"].includes(k));
    const answer = route ? await route(new Request(`http://127.0.0.1${req.url}`, { method: req.method, headers, body })) : new Response("Not found", { status: 404 });
    res.writeHead(answer.status, Object.fromEntries(answer.headers));
    res.end(Buffer.from(await answer.arrayBuffer()));
  });
});
await new Promise((r2) => macHttp.listen(0, "127.0.0.1", r2));
process.env.PORT = String(macHttp.address().port);
const connection = (i) => until(() => cloud.connections[i], `connection ${i + 1}`, 8000);
const frame = (c, test, what) => until(() => c.frames.find(test), what);
S.update((s) => {
  s.cloudUser = "u1";
  s.workspaces[0].line = { phone: "+14155550100", numberId: "num_1", agentId: "agt_ws", type: "sms", scope: "sub", at: 0 };
});
await withSession(SESSION);

// Opened on the signed-in key.
await T.startCloud({ signedIn: true });
const c1 = await connection(0);
assert.equal(c1.auth, `Bearer ${KEY}`);
c1.ws.send(JSON.stringify({ t: "ping" }));
await frame(c1, (f) => f.t === "pong", "pong");
// A webhook, replayed against this Mac's server with the token, the frame's own copy and connection headers dropped.
c1.ws.send(
  JSON.stringify({
    t: "req",
    id: "r1",
    method: "POST",
    path: "/api/phone/agentphone",
    headers: { "content-type": "application/json", "x-webhook-id": "wh_9", "x-webhook-event": "agent.message", "X-Bops-Cloud": "made-up", connection: "keep-alive", host: "evil.example", "transfer-encoding": "chunked" },
    body: Buffer.from(voiceTurn).toString("base64"),
  }),
);
const res1 = await frame(c1, (f) => f.t === "res" && f.id === "r1", "the answer");
assert.equal(res1.status, 200);
assert.equal(JSON.parse(Buffer.from(res1.body, "base64").toString("utf8")).hangup, true);
assert.equal(typeof res1.headers["content-type"], "string");
const replayed = mac.requests.find((x) => x.headers["x-webhook-id"] === "wh_9");
assert.equal(replayed.headers["x-bops-cloud"], token, "the real token, not the frame's");
assert.equal(replayed.headers.host, `127.0.0.1:${process.env.PORT}`);
assert.equal(replayed.headers["transfer-encoding"], undefined);
assert.equal(replayed.headers["x-webhook-event"], "agent.message");
assert.equal(replayed.body.toString("utf8"), voiceTurn);
assert.ok(!JSON.stringify(c1.frames).includes(token), "the token never goes back to the cloud");
// Only this server, only the webhooks.
const seen = mac.requests.length;
for (const [i, path] of ["/api/state", "/api/auth/signout", "//evil.example/api/phone/openai", "@evil.example/api/phone/openai", "/api/phone/openai/../../state", "http://evil.example/api/phone/openai", 42].entries()) {
  c1.ws.send(JSON.stringify({ t: "req", id: `bad${i}`, method: "POST", path, headers: {}, body: "" }));
  const out = await frame(c1, (f) => f.t === "res" && f.id === `bad${i}`, `refusing ${path}`);
  assert.equal(out.status, 403, String(path));
}
assert.equal(mac.requests.length, seen, "none of them reached the server");
// Bops' Slack app's events are one of the webhooks.
c1.ws.send(JSON.stringify({ t: "req", id: "sl1", method: "POST", path: "/api/channels/slack/events", headers: { "content-type": "application/json" }, body: Buffer.from(JSON.stringify({ type: "url_verification", challenge: "c1" })).toString("base64") }));
const sl1 = await frame(c1, (f) => f.t === "res" && f.id === "sl1", "the Slack event's answer");
assert.deepEqual([sl1.status, JSON.parse(Buffer.from(sl1.body, "base64").toString("utf8"))], [200, { challenge: "c1" }]);
// One that waited in the cloud is handled and acknowledged (here it's for no bot of this Mac's).
c1.ws.send(JSON.stringify({ t: "event", id: "44", kind: "slack", payload: { type: "event_callback", team_id: "T0NONE", event: { type: "message", channel: "C0X", user: "U0X", text: "hi", ts: "1.1" } }, at: "2026-10-05T12:00:00Z" }));
await frame(c1, (f) => f.t === "ack" && f.id === "44", "the Slack event's ack");
// Events: handed over, then acknowledged; one handed over again is acknowledged again but handled once.
const ownersNote = { ...ownersCall, message: { text: "Book the dentist" } };
for (let i = 0; i < 2; i++) c1.ws.send(JSON.stringify({ t: "event", id: "41", kind: "call", payload: ownersNote, at: "2026-10-05T12:00:00Z" }));
await until(() => c1.frames.filter((f) => f.t === "ack" && f.id === "41").length === 2, "two acks");
assert.equal(callNote("41").length, 1);
// A text that waited (no X-Webhook-Id: it's deduped by the event and its message id): STOP, then acknowledged.
const stop = { event: "agent.message", channel: "sms", agentId: "agt_ws", data: { id: "apmsg_1", body: "STOP", fromNumber: "+14155550177" } };
cloud.handle = (x) => (x.path === "/proxy/agentphone/v1/messages" ? { json: { id: "out_1" } } : cloudDefault(x));
c1.ws.send(JSON.stringify({ t: "event", id: "42", kind: "agentphone", payload: stop, at: "2026-10-05T12:01:00Z" }));
await frame(c1, (f) => f.t === "ack" && f.id === "42", "the text's ack");
await until(() => S.getState().smsOptOut?.includes("4155550177"), "STOP handled");
await until(() => cloud.requests.some((x) => x.path === "/proxy/agentphone/v1/messages"), "the STOP confirmation, through the cloud");
c1.ws.send(JSON.stringify({ t: "event", id: "42", kind: "agentphone", payload: stop, at: "2026-10-05T12:01:00Z" }));
await until(() => c1.frames.filter((f) => f.t === "ack" && f.id === "42").length === 2, "acked again");
assert.equal(S.getState().messages.filter((m) => /texted STOP/.test(m.text)).length, 1, "handled once");
cloud.handle = null;
// A kind this app doesn't know: not acknowledged.
c1.ws.send(JSON.stringify({ t: "event", id: "43", kind: "mystery", payload: {}, at: "2026-10-05T12:02:00Z" }));
await sleep(400);
assert.ok(!c1.frames.some((f) => f.t === "ack" && f.id === "43"));

// Dropped (the cloud restarting): back after 1 second, then 2.
let dropped = Date.now();
c1.ws.close(1001);
const c2 = await connection(1);
const first = c2.at - dropped;
assert.ok(first >= 800 && first < 2500, `back after ${first} ms`);
dropped = Date.now();
c2.ws.close(1001);
const c3 = await connection(2);
const second = c3.at - dropped;
assert.ok(second >= 1800 && second < 4000, `back after ${second} ms`);
assert.equal(c3.auth, `Bearer ${KEY}`);
// Replaced by a newer connection of the user's: stays closed (no taking it back), until a sign-in.
c3.ws.send(JSON.stringify({ t: "replaced" }));
c3.ws.close(4000);
await sleep(2500);
T.ensureCloud();
await sleep(300);
assert.equal(cloud.connections.length, 3, "not reopened");
// A sign-in starts it over on the new key, closing the one before.
signIn("orgo_key_2");
await T.startCloud({ signedIn: true });
const c4 = await connection(3);
assert.equal(c4.auth, "Bearer orgo_key_2");
T.ensureCloud();
await sleep(200);
assert.equal(cloud.connections.length, 4, "one at a time");
// A sign-out: the last state goes up while the key is still here, and the tunnel closes for good.
p0 = puts().length;
B.setBackupDelayForTests(60_000);
S.update((s) => (s.owner.about = "last words"));
await T.stopCloud();
assert.equal(puts().length, p0 + 1);
assert.equal(puts().at(-1).headers.authorization, "Bearer orgo_key_2");
await until(() => c4.closed === 1000, "the tunnel closed");
signOut();
T.ensureCloud();
await sleep(1500);
assert.equal(cloud.connections.length, 4, "stays closed signed out");
console.log("tunnel: requests replayed with the token, events acked once handled, reconnects with backoff");

// Outside this Mac only the stub was asked: the providers when self-hosting (AgentMail always), Composio's
// own version check and usage reports (self-hosting), and Orgo for routing.
const stubbed = new Set(["api.openai.com", "api.agentphone.ai", "api.agentmail.to", "api.honcho.dev", "backend.composio.dev", "api.typesafe.ai", "registry.npmjs.org", "telemetry.composio.dev", "www.orgo.ai"]);
assert.deepEqual(web.calls.filter((c) => !stubbed.has(c.host)), []);
console.log(`all cloud tests passed (${cloud.requests.length} requests to the fake cloud, ${cloud.connections.length} tunnels, ${web.calls.length} stubbed calls, none to the network)`);
// The link to the project's node_modules goes first, on its own, so nothing behind it is touched.
unlinkSync(join(scratch, "node_modules"));
rmSync(scratch, { recursive: true, force: true });
process.exit(0);
