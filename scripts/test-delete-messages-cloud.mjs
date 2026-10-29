// Tests for where a deleted message goes, end to end (lib/server/remove.ts, persist-cloud.ts, deleted.ts,
// cloud/state.ts): on a signed in Mac, several deleted at once, a chat's every message, and Delete now each go
// up to Bops Cloud as removed rows (json NULL, a new seq) that every other Mac and the iPhone read as gone;
// Undo (Restore) writes them again, with a new seq, so they read as back; a removal made on another Mac takes
// the message out here, with its image when nothing is kept of what's deleted; and the copy in Recently
// deleted stays on this Mac only, never in Bops Cloud.
//
// Bops Cloud is the real one (cloud/server.ts, run as a child process) on the local test Postgres
// (BOPS_TEST_DATABASE_URL, as cloud/test/edge-fakes.ts: 127.0.0.1:55432); Orgo is a fake on 127.0.0.1; the
// Keychain is a folder; Bops Cloud's tunnel, the relay, the bots' sessions and the Mac check are stand-ins.
// Nothing reaches a real service.
// Usage: node --conditions=react-server scripts/test-delete-messages-cloud.mjs
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { randomBytes } from "node:crypto";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
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

const scratch = mkdtempSync(join(tmpdir(), "bops-test-delete-cloud-"));
process.chdir(scratch);
process.env.HOME = scratch;
symlinkSync(join(root, "node_modules"), join(scratch, "node_modules"));
const bin = join(scratch, "bin");
mkdirSync(bin);
mkdirSync(join(scratch, "keychain"));
process.env.BOPS_TEST_KEYCHAIN = join(scratch, "keychain");
// macOS's `security`, with a folder for a Keychain (as scripts/test-profiles.mjs).
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
process.env.PATH = `${bin}:${process.env.PATH}`;

const freePort = () =>
  new Promise((resolve) => {
    const s = createServer().listen(0, "127.0.0.1", () => {
      const { port } = s.address();
      s.close(() => resolve(port));
    });
  });

/* ---------------- Orgo, faked: the device-code sign-in and who a key is ---------------- */

const A = `delmsg-a-${randomBytes(3).toString("hex")}`;
const keyOf = (id) => `key-${id}`;
const orgoServer = createServer((req, res) => {
  const chunks = [];
  req.on("data", (c) => chunks.push(c));
  req.on("end", () => {
    const send = (status, body) => res.writeHead(status, { "content-type": "application/json" }).end(JSON.stringify(body));
    const url = new URL(req.url, "http://orgo");
    if (url.pathname === "/api/user/profile") {
      const id = /^Bearer key-(.+)$/.exec(req.headers.authorization ?? "")?.[1];
      return id ? send(200, { id, email: `${id}@example.com`, full_name: "Robin Example" }) : send(401, { error: "no" });
    }
    if (url.pathname === "/api/cli/auth/start")
      return send(200, { device_code: `device-${randomBytes(4).toString("hex")}`, user_code: "ABC-DEF-GHJ", verification_uri_complete: "http://orgo/cli/approve?code=ABC-DEF-GHJ", interval_seconds: 1, expires_in_seconds: 600 });
    if (url.pathname === "/api/cli/auth/poll") return send(200, { status: "approved", api_key: keyOf(A), user: { id: A, email: `${A}@example.com` } });
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
  console.error(`test-delete-messages-cloud needs the local test Postgres (${DB.replace(/:[^:@/]+@/, ":***@")}): ${e.message}`);
  process.exit(1);
}
const cloudPort = await freePort();
const CLOUD = `http://127.0.0.1:${cloudPort}`;
process.env.BOPS_CLOUD_URL = CLOUD;
const cloud = { child: null, log: "" };
cloud.child = spawn(process.execPath, [join(root, "cloud/server.ts")], {
  env: { PATH: process.env.PATH, HOME: scratch, BOPS_DATABASE_URL: DB, BOPS_CLOUD_PORT: String(cloudPort), BOPS_CLOUD_SECRET: randomBytes(32).toString("base64"), BOPS_ORGO_ORIGIN: ORGO },
  stdio: ["ignore", "pipe", "pipe"],
});
cloud.child.stdout.on("data", (d) => (cloud.log += d));
cloud.child.stderr.on("data", (d) => (cloud.log += d));
await until(() => cloud.log.includes(`listening on 127.0.0.1:${cloudPort}`), "Bops Cloud to start", 20_000);

/** A call to the cloud as another of the user's devices makes it: another Mac, or what Bops for iPhone reads (rows after its cursor). */
async function asOther(path, init = {}) {
  const res = await fetch(`${CLOUD}${path}`, {
    method: init.method ?? "GET",
    headers: { Authorization: `Bearer ${keyOf(A)}`, "x-bops-user": A, "x-bops-protocol": "2", "x-bops-device": "other-mac", "content-type": "application/json", "x-bops-state-level": "4" },
    body: init.body === undefined ? undefined : JSON.stringify(init.body),
  });
  return { status: res.status, body: await res.json().catch(() => null) };
}
/** The rows written after `after`, each as [id, its text or null for removed], and the cursor after them. */
const rowsAfter = async (after) => {
  const r = (await asOther(`/v1/messages?after=${after}&limit=5000`)).body;
  return { rows: r.messages.map((m) => [m.id, m.json ? m.json.text : null]), seq: r.seq };
};
const live = async () => (await rowsAfter(0)).rows.map(([id]) => id).sort();

/* ---------------- The app's modules ---------------- */

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
    if (name === "openai-client") return { format: "module", shortCircuit: true, source: "export function openaiClient() { return { responses: { create: async () => ({ id: 'r', output: [], output_text: '' }) } }; }" };
    if (name && STAND_INS.has(name)) {
      const names = [...source.matchAll(/^export (?:async )?(?:function\*? |const |let |class )([A-Za-z_$][\w$]*)/gm)].map((m) => m[1]);
      return { format: "module", shortCircuit: true, source: names.map((n) => `export const ${n} = function () { return Promise.resolve(); };`).join("\n") };
    }
    const { outputText } = ts.transpileModule(source, { fileName: file, compilerOptions: { module: ts.ModuleKind.ESNext, target: ts.ScriptTarget.ES2022, jsx: ts.JsxEmit.ReactJSX } });
    return { format: "module", source: outputText, shortCircuit: true };
  },
});

const quiet = { info: console.info, warn: console.warn };
console.info = () => {};
const warned = [];
console.warn = (...a) => warned.push(a.join(" "));
const emitWarning = process.emitWarning.bind(process);
process.emitWarning = (warning, ...rest) => (rest[0]?.code === "MODULE_TYPELESS_PACKAGE_JSON" ? undefined : emitWarning(warning, ...rest));

const S = await import(`${root}/lib/server/store.ts`);
const L = await import(`${root}/lib/server/orgo-sign-in.ts`);
const Up = await import(`${root}/lib/server/uploads.ts`);
const Del = await import(`${root}/lib/server/deleted.ts`);
await import(`${root}/lib/server/privacy.ts`);
const PrivacyRoute = await import(`${root}/app/api/privacy/route.ts`);
const MessagesRoute = await import(`${root}/app/api/chats/[chatId]/messages/route.ts`);
const { botChatId } = await import(`${root}/lib/types.ts`);

let failures = 0;
let passed = 0;
async function check(name, fn) {
  try {
    await fn();
    passed++;
    quiet.info(`ok   ${name}`);
  } catch (e) {
    failures++;
    console.error(`FAIL ${name}\n  ${e.stack?.split("\n").slice(0, 20).join("\n  ") ?? e.message}`);
  }
}
const CHAT = botChatId("boppy");
const del = async (body) => {
  const res = await MessagesRoute.DELETE(new Request(`http://localhost/api/chats/${encodeURIComponent(CHAT)}/messages`, { method: "DELETE", body: JSON.stringify(body) }), { params: Promise.resolve({ chatId: CHAT }) });
  return res.json();
};
const privacy = async (body) => {
  const res = await PrivacyRoute.POST(new Request("http://localhost/api/privacy", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(body) }));
  return { status: res.status, body: await res.json() };
};
const flush = async () => assert.equal(await S.flushState(10_000), true, "saved to Bops Cloud");
const ids = () => S.getState().messages.filter((m) => m.chatId === CHAT).map((m) => m.id);
const say = (id, text, at) => S.update((s) => s.messages.push({ id, chatId: CHAT, role: id.startsWith("b") ? "bot" : "user", ...(id.startsWith("b") ? { botId: "boppy" } : {}), text, at }));

try {
  await L.startSignIn();
  const r = await L.pollSignIn();
  assert.equal(r.status, "approved");
  assert.equal(S.stateReady(), true);
  if (!S.getState().chats.some((c) => c.id === CHAT)) S.update((s) => s.chats.push({ id: CHAT, kind: "bot", botIds: ["boppy"], createdAt: 1, typing: [] }));
  S.update((s) => (s.privacy = { deletedDays: 30 }));
  const t0 = Date.now() - 600_000;
  ["u1:Book the dentist", "b1:Booked for Tuesday", "u2:My pin is 4321", "b2:Noted", "u3:Thanks", "b3:Anytime"].forEach((x, i) => say(x.split(":")[0], x.split(":")[1], t0 + i * 1000));
  S.update((s) => (s.messages.find((m) => m.id === "u2").secret = true));
  await flush();
  const start = (await rowsAfter(0)).seq;
  assert.deepEqual(await live(), ["b1", "b2", "b3", "u1", "u2", "u3"]);

  await check("several deleted at once go up as removed rows, which another Mac and the iPhone read as gone", async () => {
    const out = await del({ ids: ["u1", "b1"] });
    assert.equal(out.deleted, 2);
    await flush();
    const after = await rowsAfter(start);
    assert.deepEqual(after.rows.map(([id, t]) => [id, t]).sort(), [["b1", null], ["u1", null]], "removed: json NULL, a new seq");
    assert.deepEqual(await live(), ["b2", "b3", "u2", "u3"]);
    // The copy stays on this Mac only: nothing of it in Bops Cloud.
    const blob = JSON.stringify((await asOther("/v1/state")).body);
    assert.ok(!blob.includes(out.restore) && !blob.includes("Booked for Tuesday"));
  });

  let cursor = (await rowsAfter(0)).seq;
  await check("Undo (Restore) writes them again: back with a new seq, so the other devices show them again", async () => {
    const [item] = Del.listDeleted();
    assert.equal(item.what, "2 messages in Boppy's chat");
    assert.equal((await privacy({ restore: item.id })).status, 200);
    assert.deepEqual(ids(), ["u1", "b1", "u2", "b2", "u3", "b3"]);
    await flush();
    const back = await rowsAfter(cursor);
    assert.deepEqual(back.rows.sort(), [["b1", "Booked for Tuesday"], ["u1", "Book the dentist"]]);
    assert.ok(back.seq > cursor);
    assert.deepEqual(await live(), ["b1", "b2", "b3", "u1", "u2", "u3"]);
    cursor = back.seq;
  });

  await check("Delete all messages: every row of the chat goes up removed, the one kept between us never into the copy; Undo brings back the rest", async () => {
    const out = await del({ all: true });
    assert.deepEqual([out.deleted, out.between], [6, 2], "the pin, and the answer to it");
    await flush();
    const after = await rowsAfter(cursor);
    assert.equal(after.rows.length, 6);
    assert.ok(after.rows.every(([, t]) => t === null));
    assert.deepEqual(await live(), []);
    assert.equal((await privacy({ restore: out.restore })).status, 200);
    await flush();
    assert.deepEqual(await live(), ["b1", "b3", "u1", "u3"], "what was between us is gone for good, everywhere");
    cursor = (await rowsAfter(0)).seq;
  });

  await check("Delete now goes up the same way, and its Undo too", async () => {
    const out = await privacy({ clear: { olderThan: null } });
    assert.equal(out.body.cleared.messages, 4);
    await flush();
    assert.deepEqual(await live(), []);
    assert.equal((await privacy({ restore: out.body.cleared.restore })).status, 200);
    await flush();
    assert.deepEqual(await live(), ["b1", "b3", "u1", "u3"]);
    cursor = (await rowsAfter(0)).seq;
  });

  await check("a removal made on another Mac takes the message out here; Gone at once, its image on this Mac too", async () => {
    S.update((s) => (s.privacy = {}));
    const pic = Up.saveUpload(`data:image/png;base64,${Buffer.from("tea").toString("base64")}`);
    S.update((s) => (s.messages.find((m) => m.id === "u3").images = [pic]));
    await flush();
    assert.equal((await asOther("/v1/messages", { method: "POST", body: { upsert: [], remove: ["u3"] } })).status, 200);
    await S.pullState();
    await until(() => !ids().includes("u3"), "the removal to arrive");
    await until(() => Up.uploadPath(pic.id) === null, "its image to go from this Mac");
    assert.deepEqual(ids(), ["u1", "b1", "b3"]);
  });
} finally {
  cloud.child.kill("SIGKILL");
  orgoServer.close();
  await db.query("DELETE FROM bops.chat_messages WHERE user_id = $1", [A]).catch(() => {});
  await db.query("DELETE FROM bops.app_state WHERE user_id = $1", [A]).catch(() => {});
  await db.end();
}

const stray = warned.filter((w) => /\[(privacy|remove|deleted)\]/.test(w));
if (stray.length) {
  failures++;
  console.error(`FAIL stray warnings\n  ${stray.join("\n  ")}`);
}
quiet.info(`\ndelete messages, Mac and Bops Cloud: ${passed} passed, ${failures} failed`);
if (!failures) rmSync(scratch, { recursive: true, force: true });
else quiet.info(`The throwaway folder is kept for a look: ${scratch}`);
process.exit(failures ? 1 : 0);
