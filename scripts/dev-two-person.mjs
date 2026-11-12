// A local two-person Bops: everything the Browser tab (components/app/bot-browser.tsx) needs to be seen working by an
// owner and a teammate at once, on this Mac, with nothing real in it. `start` brings up, in a temp folder:
//
// - a throwaway Postgres cluster on a free port (55432 when free), with the databases Bops Cloud and its tests use
//   (orgo_stack for the stack, orgo_core and orgo_edge for `node --test cloud/test/`), set up as db/provision.sql does;
// - Bops Cloud itself (cloud/server.ts) on it;
// - a fake orgo-web: sign-in (who each made-up key is) and bops-role for two made-up users, "owner" and "sam"
//   (sam: member, Write on the bot, Use its computer; or Orgo's Admin with TWO_PERSON_MEMBER_ROLE=admin), from
//   scripts/fixtures/two-person.mjs; a vault in memory for Keys (/api/secrets for the owner, the shared workspace's
//   bops-keys routes for whoever has Keys there), whose values are never logged;
// - a scripted model behind Bops Cloud's OpenAI proxy (BOPS_UPSTREAM_OPENAI): a message about a key gets the bot's
//   ask_for_key card (lib/server/keys.ts), anything else "Ok.", so a chat turn runs with nothing real in it;
// - a stand-in bot computer: a headless Chrome with its own temp profile and DevTools port, and the browser relay
//   (lib/browser-relay.ts) exactly as a computer's runner runs it, signed in as that computer;
// - a test site that Chrome opens (a page with a unique word, a button, a field and a ticker; a sign-in page for the
//   fixture's test account);
// - two Bops apps (next dev), the owner's and sam's, each with a scratch HOME and a folder for a Keychain, signed in
//   with their made-up keys and pointed at the local cloud and the fake orgo-web.
//
// It also answers on a control port for the end-to-end test (scripts/test-browser-tab-e2e.mjs): a bot step on the
// stand-in's Chrome (page_script-style CDP), which waits while a person has control there, as the runner's do; and
// the owner's Bops shut and started again (POST /owner/stop, /owner/start: the owner's Mac closed, then opened), the
// rest of the stack staying up.
//
// `stop` stops all of it and removes the temp folder. Nothing reaches a real service: every key is made up, the apps'
// Keychain is a folder, and Chrome and the apps only ever load 127.0.0.1.
//
// Usage: node scripts/dev-two-person.mjs start | stop | status     (npm run two-person, npm run two-person:stop)
import { spawn, spawnSync } from "node:child_process";
import { randomBytes } from "node:crypto";
import { existsSync, mkdirSync, mkdtempSync, openSync, readdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { createServer } from "node:http";
import { createRequire, registerHooks } from "node:module";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { pathToFileURL } from "node:url";
import { endGroup, groupAlive, removeTemp } from "./fixtures/cleanup.mjs";
import { ACCOUNT, BOT, COMPUTER, SAM, SAM_ROLE, OWNER, PROJECT, ownerState, profileFor, roleFor, workspacesFor } from "./fixtures/two-person.mjs";

const root = new URL("..", import.meta.url).pathname.replace(/\/$/, "");
const require = createRequire(import.meta.url);
// The relay is the app's TypeScript (lib/browser-relay.ts), loaded as the tests load it: "@/" is this folder.
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
});
const HERE = join(root, ".scratch", "two-person");
const STATE = join(HERE, "stack.json");
const LOG = join(HERE, "stack.log");
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
/** The stand-in computer's Chrome: Google Chrome, as on the bots' computers (google-chrome-stable) and as the repo's browser tests launch it (channel "chrome"), with a profile of its own. */
const CHROME = process.env.TWO_PERSON_CHROME || "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome";

/** The ports it asks for first (each taken only when free): apps 3401 and 3402, site 3410, control 3411, cloud 8890, Postgres 55432, Chrome 9300 (9200 + display 100, as bops-chrome). */
const WANT = { owner: 3401, sam: 3402, site: 3410, control: 3411, cloud: 8890, pg: 55432, chrome: 9200 + COMPUTER.display };

const readState = () => {
  try {
    return JSON.parse(readFileSync(STATE, "utf8"));
  } catch {
    return null;
  }
};
const alive = (pid) => {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
};

/** Which of `ports` something on this Mac listens on (lsof), as "port: command". */
function listeners(ports) {
  const r = spawnSync("lsof", ["-nP", "-iTCP", "-sTCP:LISTEN"], { encoding: "utf8" });
  const out = [];
  for (const line of (r.stdout ?? "").split("\n").slice(1)) {
    const m = /:(\d+) \(LISTEN\)/.exec(line);
    if (m && ports.includes(Number(m[1]))) out.push(`${m[1]}: ${line.split(/\s+/)[0]}`);
  }
  return [...new Set(out)];
}

const portFree = (port) =>
  new Promise((resolve) => {
    const s = createServer();
    s.once("error", () => resolve(false));
    s.listen(port, "127.0.0.1", () => s.close(() => resolve(true)));
  });
const anyPort = () =>
  new Promise((resolve) => {
    const s = createServer().listen(0, "127.0.0.1", () => {
      const { port } = s.address();
      s.close(() => resolve(port));
    });
  });
async function pickPorts() {
  const out = {};
  const taken = new Set();
  for (const [name, want] of Object.entries(WANT)) {
    let p = want;
    if (taken.has(p) || !(await portFree(p))) do p = await anyPort(); while (taken.has(p));
    taken.add(p);
    out[name] = p;
  }
  return out;
}

/* ---------------- start / stop / status ---------------- */

async function start() {
  const had = readState();
  if (had && alive(had.pid)) {
    console.log(`Already running (pid ${had.pid}). Stop it first: node scripts/dev-two-person.mjs stop`);
    return print(had);
  }
  mkdirSync(HERE, { recursive: true });
  rmSync(STATE, { force: true });
  const log = openSync(LOG, "w");
  const child = spawn(process.execPath, [new URL(import.meta.url).pathname, "serve"], { detached: true, stdio: ["ignore", log, log], cwd: root });
  child.unref();
  const end = Date.now() + 8 * 60_000;
  for (;;) {
    const s = readState();
    if (s?.error) {
      console.error(`The stack didn't start: ${s.error}\nIts log: ${LOG}`);
      await stop();
      process.exit(1);
    }
    if (s?.ready) return print(s);
    if (!alive(child.pid)) {
      console.error(`The stack stopped while starting. Its log: ${LOG}`);
      process.exit(1);
    }
    if (Date.now() > end) {
      console.error(`The stack took over 8 minutes to start. Its log: ${LOG}`);
      await stop();
      process.exit(1);
    }
    await sleep(500);
  }
}

function print(s) {
  console.log(
    [
      `Two-person Bops is up (pid ${s.pid}):`,
      `  owner's Bops   ${s.urls.owner}`,
      `  sam's Bops    ${s.urls.sam}`,
      `  Bops Cloud     ${s.urls.cloud}`,
      `  test site      ${s.urls.site}  (word ${s.word})`,
      `  control        ${s.urls.control}`,
      `  Postgres       127.0.0.1:${s.ports.pg}`,
      `  stand-in Chrome DevTools 127.0.0.1:${s.ports.chrome}`,
      `Stop it with: node scripts/dev-two-person.mjs stop`,
    ].join("\n"),
  );
}

async function stop() {
  const s = readState();
  if (!s) return console.log("Nothing to stop.");
  if (alive(s.pid)) {
    process.kill(s.pid, "SIGTERM");
    for (const end = Date.now() + 30_000; alive(s.pid) && Date.now() < end; ) await sleep(200);
    if (alive(s.pid)) process.kill(s.pid, "SIGKILL");
  }
  // Whatever it started that outlived it (it was killed, say): each process group, ended before its folder goes (a
  // Chrome still writing its profile can't be removed), then the cluster.
  await Promise.all((s.children ?? []).map((pid) => endGroup(pid)));
  if (s.dir && existsSync(join(s.dir, "pg", "PG_VERSION"))) spawnSync(pgBin("pg_ctl"), ["-D", join(s.dir, "pg"), "stop", "-m", "immediate"], { stdio: "ignore" });
  if (s.dir) removeTemp(s.dir);
  rmSync(STATE, { force: true });
  const left = listeners(Object.values(s.ports ?? {}));
  if (left.length) {
    console.error(`Still listening after stop: ${left.join(", ")}`);
    process.exit(1);
  }
  console.log(`Stopped. Nothing listens on ${Object.values(s.ports ?? {}).join(", ")}.`);
}

function status() {
  const s = readState();
  if (!s || !alive(s.pid)) return console.log("Not running.");
  print(s);
}

/* ---------------- serve: the stack itself ---------------- */

/** Postgres's tools: on PATH, else Homebrew's newest. */
function pgBin(name) {
  const onPath = spawnSync("sh", ["-c", `command -v ${name}`], { encoding: "utf8" }).stdout.trim();
  if (onPath) return onPath;
  for (const base of ["/opt/homebrew/opt", "/usr/local/opt"]) {
    const found = existsSync(base) ? readdirSync(base).filter((d) => /^postgresql(@\d+)?$/.test(d)).sort().reverse() : [];
    for (const d of found) if (existsSync(join(base, d, "bin", name))) return join(base, d, "bin", name);
  }
  throw new Error(`${name} isn't installed (brew install postgresql@16)`);
}

/**
 * The fake orgo-web's vault (lib/server/keys.ts, lib/server/shared-keys.ts): the owner's /api/secrets, and the shared
 * workspace's bops-keys routes for whoever has Keys there (the owner, or an Admin; a Member without Keys is refused as
 * orgo-web refuses them). `vault`: "<workspace id or empty>:<name>" to { value, at }. Null for any other route. Never
 * says a value back but on a reveal, and never logs one.
 */
function vaultRoute(vault, method, url, key, body) {
  const owner = key === OWNER.key || key === COMPUTER.key;
  const list = (ws) => [...vault.entries()].filter(([k]) => ws === undefined || k.startsWith(`${ws ?? ""}:`)).map(([k, v]) => ({ name: k.slice(k.indexOf(":") + 1), workspace_id: k.slice(0, k.indexOf(":")) || null, updated_at: new Date(v.at).toISOString() }));
  const name = (n) => String(n ?? "").trim().toUpperCase().replace(/-/g, "_");
  if (url.pathname === "/api/secrets" || url.pathname.startsWith("/api/secrets/")) {
    if (!owner) return { status: 401, body: { error: "Invalid API key" } };
    if (method === "GET" && url.pathname === "/api/secrets") return { status: 200, body: { secrets: list() } };
    if (key !== OWNER.key) return { status: 403, body: { error: "Not for a computer's key" } };
    if (method === "POST" && url.pathname === "/api/secrets") {
      vault.set(`${body.workspace_id ?? ""}:${name(body.name)}`, { value: String(body.value ?? ""), at: Date.now() });
      return { status: 200, body: { ok: true } };
    }
    const del = /^\/api\/secrets\/([A-Za-z0-9_-]+)$/.exec(url.pathname);
    if (method === "DELETE" && del) return vault.delete(`${url.searchParams.get("workspace_id") ?? ""}:${name(del[1])}`) ? { status: 200, body: { ok: true } } : { status: 404, body: { error: "Secret not set" } };
    return { status: 404, body: { error: "Not faked in the two-person stack" } };
  }
  const pk = /^\/api\/projects\/([^/]+)\/bops-keys(?:\/([A-Za-z0-9_-]+))?$/.exec(url.pathname);
  if (!pk) return null;
  if (!profileFor(key) || key === COMPUTER.key) return { status: 401, body: { error: "Invalid API key" } };
  if (decodeURIComponent(pk[1]) !== PROJECT.id) return { status: 404, body: { error: "Not found" } };
  if (key !== OWNER.key && SAM_ROLE !== "admin") return { status: 403, body: { error: "No Keys here", code: "KEYS_NOT_ALLOWED" } };
  if (method === "GET" && !pk[2]) return { status: 200, body: { keys: list(PROJECT.id).map((k) => ({ name: k.name, updated_at: k.updated_at })) } };
  if (method === "POST" && !pk[2]) return vault.set(`${PROJECT.id}:${name(body.name)}`, { value: String(body.value ?? ""), at: Date.now() }), { status: 200, body: { ok: true, name: name(body.name) } };
  if (method === "DELETE" && pk[2]) return vault.delete(`${PROJECT.id}:${name(pk[2])}`) ? { status: 200, body: { ok: true } } : { status: 404, body: { error: "Not found", code: "KEY_NOT_FOUND" } };
  return { status: 404, body: { error: "Not faked in the two-person stack" } };
}

/**
 * The stack's model (POST /v1/responses through Bops Cloud's proxy): a chat turn whose latest words ask about a key, or
 * the open issues, calls ask_for_key for GitHub (Notion when they say Notion; "again" or "card": to change it); its
 * answer after the card is said plainly; anything else is "Ok.", and a structured answer is the schema's emptiest one.
 */
function scriptedModel(b) {
  const out = (output) => ({ id: `resp_two_person_${randomBytes(6).toString("hex")}`, object: "response", model: "two-person-scripted", status: "completed", output, usage: { input_tokens: 1, output_tokens: 1, input_tokens_details: { cached_tokens: 0 }, output_tokens_details: { reasoning_tokens: 0 } } });
  const say = (text) => out([{ id: `msg_${randomBytes(6).toString("hex")}`, type: "message", role: "assistant", status: "completed", content: [{ type: "output_text", text, annotations: [] }] }]);
  const input = Array.isArray(b.input) ? b.input : [];
  const empty = (schema) => {
    if (!schema || typeof schema !== "object") return null;
    const t = Array.isArray(schema.type) ? schema.type : [schema.type];
    if (schema.enum) return schema.enum[0];
    if (t.includes("null")) return null;
    if (t.includes("object")) return Object.fromEntries(Object.entries(schema.properties ?? {}).map(([k, v]) => [k, empty(v)]));
    if (t.includes("array")) return [];
    if (t.includes("boolean")) return false;
    if (t.includes("number") || t.includes("integer")) return 0;
    return "";
  };
  if (b.text?.format?.type === "json_schema") return say(JSON.stringify(empty(b.text.format.schema)));
  const asks = (b.tools ?? []).some((t) => t.name === "ask_for_key");
  const last = input.at(-1);
  if (asks && last?.type === "function_call_output") {
    const o = String(last.output ?? "");
    return say(/may use it now/.test(o) ? "Thanks, I can use it now." : /anymore/.test(o) ? "Done, that key is gone." : /^Declined/.test(o) ? "Ok, I'll leave it for now." : "I couldn't get the key just now.");
  }
  const words = (m) => (typeof m.content === "string" ? m.content : Array.isArray(m.content) ? m.content.map((c) => c.text ?? "").join(" ") : "");
  const said = words([...input].reverse().find((m) => m.role === "user" && !/^\[Bops/.test(words(m))) ?? {});
  // A Bops without the card (before ask_for_key): all a bot can do is say so.
  const notion = /notion/i.test(said);
  if (!asks && (b.tools ?? []).some((t) => t.name === "start_task") && /\bkey\b|issues/i.test(said)) return say(`I need a ${notion ? "Notion" : "GitHub"} key for that. Add one in Logins, Keys, then tell me.`);
  if (asks && /\bkey\b|issues/i.test(said)) {
    const args = { service: notion ? "NOTION_API_KEY" : "GITHUB_TOKEN", reason: notion ? "Read the team's notes in Notion" : "Read the open issues in the site's repository", change: /again|card/i.test(said) };
    return out([{ id: `fc_${randomBytes(6).toString("hex")}`, type: "function_call", status: "completed", call_id: `call_${randomBytes(6).toString("hex")}`, name: "ask_for_key", arguments: JSON.stringify(args) }]);
  }
  return say("Ok.");
}

/** The environment every child starts from: this one without anything that could be a real key or point at a real service. */
function cleanEnv() {
  const env = {};
  for (const [k, v] of Object.entries(process.env)) if (!/^(BOPS|OPENAI|AGENTPHONE|AGENTMAIL|HONCHO|COMPOSIO|TYPESAFE|TWILIO|ORGO|POSTHOG|SENTRY|ANTHROPIC|NEXT_PUBLIC)_/.test(k)) env[k] = v;
  return { ...env, NEXT_TELEMETRY_DISABLED: "1", BOPS_TELEMETRY: "0", DO_NOT_TRACK: "1", ...(process.env.BOPS_BROWSER_PROBE === "1" ? { BOPS_BROWSER_PROBE: "1" } : {}) };
}

/** macOS's `security`, with a folder for a Keychain (as scripts/test-delete-messages-cloud.mjs). */
const SECURITY = `#!/usr/bin/env node
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
`;

/** The test site's pages: the bot's start page (a unique word, a button, a field, a ticker so the screen keeps painting), and a sign-in. */
function sitePages(word) {
  const page = (title, body) =>
    `<!doctype html><html><head><meta charset="utf-8"><title>${title}</title><style>body{font:18px/1.5 -apple-system,Helvetica,sans-serif;margin:40px;color:#111}h1{font-size:56px;letter-spacing:.02em;margin:0 0 16px}button,input{font:inherit;padding:8px 14px}#tick{color:#777}</style></head><body>${body}</body></html>`;
  return {
    home: page(
      "Acme test page",
      `<h1 id="word">${word}</h1><p>A page the bot opened on its computer.</p><p><button id="press" onclick="this.textContent='Pressed by a person'">Press me</button></p><p><label>Your note <input id="note" oninput="document.getElementById('echo').textContent=this.value"></label></p><p>Typed: <b id="echo"></b></p><p><a href="/login">Sign in</a> · <a href="/other">Another page</a></p><p id="tick">0</p><script>let n=0;setInterval(()=>{document.getElementById('tick').textContent='Ticker '+(++n)},250)</script>`,
    ),
    word: (w) => page(`Word ${w}`, `<h1 id="word" style="font-size:96px">${w}</h1><p>A page the bot went to.</p>`),
    other: page("Another test page", `<h1>Another page</h1><p>Reached from the address bar.</p><p id="tick">0</p><script>let n=0;setInterval(()=>{document.getElementById('tick').textContent='Ticker '+(++n)},250)</script>`),
    login: page(
      "Sign in · Acme test",
      `<h1>Sign in</h1><form method="post" action="/login"><p><label>User <input id="user" name="user" autocomplete="username"></label></p><p><label>Password <input id="password" name="password" type="password" autocomplete="current-password"></label></p><p><button id="signin" type="submit">Sign in</button></p></form>`,
    ),
    account: (name) => page("Your account · Acme test", `<h1>Signed in</h1><p>Signed in as <b id="who">${name}</b></p>`),
    wrong: page("Sign in · Acme test", `<h1>Sign in</h1><p id="wrong">That user and password don't match.</p><p><a href="/login">Try again</a></p>`),
  };
}

async function serve() {
  const children = [];
  const ports = await pickPorts();
  const dir = mkdtempSync(join(tmpdir(), "bops-two-person-"));
  const word = `PELICAN${randomBytes(3).toString("hex").toUpperCase()}`;
  const urls = {
    owner: `http://127.0.0.1:${ports.owner}`,
    sam: `http://127.0.0.1:${ports.sam}`,
    cloud: `http://127.0.0.1:${ports.cloud}`,
    site: `http://127.0.0.1:${ports.site}`,
    control: `http://127.0.0.1:${ports.control}`,
  };
  const state = { pid: process.pid, dir, ports, urls, word, children, ready: false };
  const save = () => writeFileSync(STATE, JSON.stringify(state, null, 2));
  save();
  const say = (m) => console.log(`[two-person ${new Date().toISOString().slice(11, 19)}] ${m}`);
  const servers = [];
  let relay = null;

  let stopping = false;
  const shutdown = async (code = 0) => {
    if (stopping) return;
    stopping = true;
    say("stopping");
    try {
      await relay?.stop();
    } catch {}
    for (const s of servers) {
      s.closeAllConnections?.();
      s.close();
    }
    for (const c of [...children].reverse()) {
      try {
        process.kill(-c, "SIGTERM");
      } catch {}
    }
    // Each group as a whole (Chrome's helpers write its profile too), and gone before the folder is removed.
    for (const end = Date.now() + 5000; children.some(groupAlive) && Date.now() < end; ) await sleep(200);
    await Promise.all(children.map((c) => endGroup(c)));
    if (existsSync(join(dir, "pg", "PG_VERSION"))) spawnSync(pgBin("pg_ctl"), ["-D", join(dir, "pg"), "stop", "-m", "fast", "-w"], { stdio: "inherit" });
    removeTemp(dir);
    rmSync(STATE, { force: true });
    process.exit(code);
  };
  process.on("SIGTERM", () => void shutdown(0));
  process.on("SIGINT", () => void shutdown(0));
  process.on("uncaughtException", (e) => void fail(e));
  process.on("unhandledRejection", (e) => void fail(e));
  const fail = async (e) => {
    say(`failed: ${e.stack ?? e}`);
    state.error = String(e.message ?? e);
    save();
    await shutdown(1);
  };

  /** Children stopped on purpose (the owner's Bops shut through the control port): their exit doesn't stop the stack. */
  const letGo = new Set();
  /** A child in its own process group (so stop ends what it starts too), its output in the stack's log with a prefix. */
  const run = (name, cmd, args, opts = {}) => {
    const c = spawn(cmd, args, { detached: true, stdio: ["ignore", "pipe", "pipe"], ...opts });
    c.on("error", (e) => void fail(new Error(`${name} couldn't start: ${e.message}`)));
    if (c.pid) children.push(c.pid);
    save();
    let out = "";
    const take = (d) => {
      out += d;
      if (out.length > 200_000) out = out.slice(-100_000);
      for (const line of String(d).split("\n")) if (line.trim()) console.log(`[${name}] ${line}`);
    };
    c.stdout.on("data", take);
    c.stderr.on("data", take);
    c.on("exit", (code) => {
      if (!stopping && !letGo.has(c.pid)) void fail(new Error(`${name} exited (${code})`));
    });
    return { child: c, output: () => out };
  };
  const waitFor = async (what, check, ms) => {
    for (const end = Date.now() + ms; Date.now() < end; await sleep(250)) if (await check()) return;
    throw new Error(`timed out waiting for ${what}`);
  };

  try {
    /* Postgres: a cluster of its own, trust on loopback only, the databases Bops Cloud and its tests use. */
    const pgDir = join(dir, "pg");
    say(`Postgres on ${ports.pg}`);
    const init = spawnSync(pgBin("initdb"), ["-D", pgDir, "-U", "postgres", "--auth=trust", "-E", "UTF8", "--no-instructions"], { encoding: "utf8" });
    if (init.status !== 0) throw new Error(`initdb: ${init.stderr}`);
    const pgStart = spawnSync(pgBin("pg_ctl"), ["-D", pgDir, "-l", join(dir, "pg.log"), "-o", `-p ${ports.pg} -k ${dir} -c listen_addresses=127.0.0.1`, "start", "-w"], { encoding: "utf8" });
    if (pgStart.status !== 0) throw new Error(`pg_ctl start: ${pgStart.stderr || pgStart.stdout}`);
    const psql = (db, args) => {
      const r = spawnSync(pgBin("psql"), ["-h", "127.0.0.1", "-p", String(ports.pg), "-U", "postgres", "-d", db, "-v", "ON_ERROR_STOP=1", "-q", ...args], { encoding: "utf8" });
      if (r.status !== 0) throw new Error(`psql: ${r.stderr}`);
      return r.stdout;
    };
    psql("postgres", ["-c", "CREATE ROLE bops_app LOGIN PASSWORD 'bops-local'"]);
    for (const db of ["orgo_stack", "orgo_core", "orgo_edge"]) {
      psql("postgres", ["-c", `CREATE DATABASE ${db} OWNER bops_app`]);
      psql(db, ["-v", "bops_app_password=bops-local", "-f", join(root, "db", "provision.sql")]);
    }
    const DB = `postgres://bops_app:bops-local@127.0.0.1:${ports.pg}/orgo_stack`;

    /* The fake orgo-web: who each made-up key is, each user's workspaces and role in the shared one. Anything else 404s, and is logged. */
    const vault = new Map();
    const orgo = createServer(async (req, res) => {
      const send = (status, body) => res.writeHead(status, { "content-type": "application/json" }).end(JSON.stringify(body));
      const url = new URL(req.url, "http://orgo");
      const key = /^Bearer\s+(.+)$/.exec(req.headers.authorization ?? "")?.[1] ?? "";
      const chunks = [];
      for await (const c of req) chunks.push(c);
      const body = (() => {
        try {
          return chunks.length ? JSON.parse(Buffer.concat(chunks).toString()) : {};
        } catch {
          return {};
        }
      })();
      if (url.pathname === "/v1/responses" && req.method === "POST") return send(200, scriptedModel(body));
      const kept = vaultRoute(vault, req.method, url, key, body);
      if (kept) return send(kept.status, kept.body);
      if (req.method === "GET" && url.pathname === "/api/user/profile") {
        const p = profileFor(key);
        return p ? send(200, p) : send(401, { error: "Invalid API key" });
      }
      const role = /^\/api\/projects\/([^/]+)\/bops-role$/.exec(url.pathname);
      if (req.method === "GET" && role) {
        if (!profileFor(key)) return send(401, { error: "Invalid API key" });
        const r = roleFor(key, decodeURIComponent(role[1]));
        return r ? send(200, r) : send(404, { error: "Not found" });
      }
      if (req.method === "GET" && url.pathname === "/api/workspaces") {
        const w = workspacesFor(key);
        return w ? send(200, { workspaces: w }) : send(401, { error: "Invalid API key" });
      }
      // The bot's computer, as the owner's Bops looks it up (lib/server/orgo.ts computer): up, in the shared workspace. Never a VNC password.
      if (req.method === "GET" && url.pathname === `/api/computers/${COMPUTER.id}` && key === OWNER.key)
        return send(200, { id: COMPUTER.id, name: `${BOT.name}'s computer`, status: "running", cpu: 4, ram: 8, os: "linux", workspace_id: PROJECT.id, project_id: PROJECT.id });
      // Who's in the shared workspace, as the owner's People sheet reads it: the owner, and sam with Use its computer.
      if (req.method === "GET" && url.pathname === `/api/workspaces/${PROJECT.id}/members` && key === OWNER.key)
        return send(200, {
          members: [
            { id: OWNER.id, email: OWNER.email, name: OWNER.name, role: "owner" },
            SAM_ROLE === "admin" ? { id: SAM.id, email: SAM.email, name: SAM.name, role: "admin" } : { id: SAM.id, email: SAM.email, name: SAM.name, role: "member", bopsComputerUse: true },
          ],
          invites: [],
        });
      console.log(`[orgo-web] not faked: ${req.method} ${url.pathname}`);
      send(404, { error: "Not faked in the two-person stack" });
    });
    servers.push(orgo);
    const orgoPort = await anyPort();
    await new Promise((r) => orgo.listen(orgoPort, "127.0.0.1", r));
    const ORGO = `http://127.0.0.1:${orgoPort}`;

    /* The test site. */
    const pages = sitePages(word);
    const signedIn = new Set();
    const site = createServer((req, res) => {
      const url = new URL(req.url, "http://site");
      const html = (status, body, headers = {}) => res.writeHead(status, { "content-type": "text/html; charset=utf-8", "cache-control": "no-store", ...headers }).end(body);
      const cookie = /(?:^|;\s*)session=([a-f0-9]+)/.exec(req.headers.cookie ?? "")?.[1];
      if (req.method === "POST" && url.pathname === "/login") {
        let body = "";
        req.on("data", (d) => (body += d));
        req.on("end", () => {
          const f = new URLSearchParams(body);
          if (f.get("user") !== ACCOUNT.user || f.get("password") !== ACCOUNT.password) return html(200, pages.wrong);
          const sid = randomBytes(12).toString("hex");
          signedIn.add(sid);
          res.writeHead(303, { location: "/account", "set-cookie": `session=${sid}; Path=/; HttpOnly; SameSite=Lax` }).end();
        });
        return;
      }
      req.resume();
      if (url.pathname === "/") return html(200, pages.home);
      if (url.pathname === "/other") return html(200, pages.other);
      // A page with a word of the caller's (the end-to-end test's: what a navigation shows), and nothing that moves.
      const w = /^\/word\/([A-Z0-9]{4,24})$/.exec(url.pathname)?.[1];
      if (w) return html(200, pages.word(w));
      if (url.pathname === "/login") return html(200, pages.login);
      if (url.pathname === "/account") return cookie && signedIn.has(cookie) ? html(200, pages.account(ACCOUNT.name)) : res.writeHead(303, { location: "/login" }).end();
      html(404, "<!doctype html><title>Not found</title><p>Not found</p>");
    });
    servers.push(site);
    await new Promise((r) => site.listen(ports.site, "127.0.0.1", r));

    /* Bops Cloud. */
    say(`Bops Cloud on ${ports.cloud}`);
    const cloud = run("cloud", process.execPath, [join(root, "cloud", "server.ts")], {
      cwd: root,
      // Its OpenAI is the scripted model on the fake orgo-web (a made-up key that only it takes).
      env: { ...cleanEnv(), BOPS_DATABASE_URL: DB, BOPS_CLOUD_PORT: String(ports.cloud), BOPS_CLOUD_SECRET: randomBytes(32).toString("base64"), BOPS_ORGO_ORIGIN: ORGO, BOPS_CLOUD_PUBLIC_URL: urls.cloud, BOPS_UPSTREAM_OPENAI: ORGO, OPENAI_API_KEY: "sk-two-person-scripted-model" },
    });
    await waitFor("Bops Cloud", () => cloud.output().includes(`listening on 127.0.0.1:${ports.cloud}`), 60_000);

    // Probe only: delay the app-to-Cloud link, leaving the runner's link untouched.
    if (process.env.TWO_PERSON_BROWSER_LINK_MS !== undefined) {
      const delay = Number(process.env.TWO_PERSON_BROWSER_LINK_MS);
      if (![0, 35].includes(delay)) throw new Error("TWO_PERSON_BROWSER_LINK_MS must be 0 or 35");
      const { startLink } = await import("./browser-speed/link.mjs");
      const logFile = join(HERE, "link.jsonl");
      writeFileSync(logFile, "");
      const proxy = await startLink(urls.cloud, delay, logFile);
      servers.push(proxy.server);
      urls.browserProxy = proxy.url;
      ports.browserProxy = Number(new URL(proxy.url).port);
      state.probe = { delay, timing: process.env.BOPS_BROWSER_PROBE === "1", logFile };
      save();
    }

    /* The owner's state, before either app starts: the bot on the stand-in computer, and sam's access. */
    const pg = require("pg");
    const db = new pg.Client({ connectionString: DB });
    await db.connect();
    await db.query("INSERT INTO bops.app_state (user_id, state, version, protocol) VALUES ($1, $2::jsonb, 1, 2) ON CONFLICT (user_id) DO UPDATE SET state = $2::jsonb, version = bops.app_state.version + 1", [
      OWNER.id,
      JSON.stringify(ownerState()),
    ]);
    await db.end();

    /* The stand-in bot computer: a headless Chrome of its own on the test site, and the relay as a runner runs it. */
    const { chromium } = require("playwright-core");
    say(`stand-in Chrome on ${ports.chrome}`);
    run(
      "chrome",
      CHROME,
      [
        "--headless=new",
        `--remote-debugging-port=${ports.chrome}`,
        "--remote-debugging-address=127.0.0.1",
        `--user-data-dir=${join(dir, "chrome")}`,
        "--no-first-run",
        "--no-default-browser-check",
        "--disable-background-networking",
        // Never this Mac's Keychain (a sign-in on the test site would have Chrome's password manager reach for it), as Playwright launches Chrome.
        "--use-mock-keychain",
        "--password-store=basic",
        // A site by a name (acme.test) for a link that isn't localhost: it's this Mac, and nothing is looked up.
        "--host-resolver-rules=MAP *.test 127.0.0.1",
        "--window-size=1280,800",
        urls.site,
      ],
      { env: cleanEnv() },
    );
    await waitFor("Chrome's DevTools", () => fetch(`http://127.0.0.1:${ports.chrome}/json/version`).then((r) => r.ok, () => false), 30_000);
    // As a computer's runner starts it (lib/server/browser-runner.ts), with the stand-in's screen and its own made-up key.
    const { startRelay, handedBack } = await import(pathToFileURL(join(root, "lib", "browser-relay.ts")).href);
    const { travelMs } = await import(pathToFileURL(join(root, "lib", "cursor-path.ts")).href);
    const { BOPS_STATE_LEVEL_HEADER, BOPS_USER_HEADER, STATE_LEVEL } = await import(pathToFileURL(join(root, "cloud", "protocol.ts")).href);
    const relayOptions = {
      url: () => urls.cloud,
      headers: () => ({ Authorization: `Bearer ${COMPUTER.key}` }),
      screens: () => [{ display: COMPUTER.display, port: ports.chrome }],
      screenFor: () => COMPUTER.display,
      onControl: (bot, display, who, was) => {
        say(`control of screen ${display} (${bot}): ${who ? who.name : "handed back"}`);
        // Handed back: the bot's chat says so, as a runner's does (lib/server/browser-runner.ts), posted the way a
        // runner posts its notes: to Bops Cloud, signed in as the computer.
        if (!who && was) void postNote(handedBack(was.name, BOT.name));
      },
      log: (m) => console.log(`[relay] ${m}`),
    };
    relay = startRelay(relayOptions);

    /** A note from Bops in the bot's chat, as the computer's runner posts one (POST /v1/messages, its own key). */
    async function postNote(text, extra = {}) {
      const res = await fetch(`${urls.cloud}/v1/messages`, {
        method: "POST",
        // As a runner's (lib/server/app-version.ts appHeaders): whose state, and the state level it speaks.
        headers: { Authorization: `Bearer ${COMPUTER.key}`, [BOPS_USER_HEADER]: OWNER.id, [BOPS_STATE_LEVEL_HEADER]: String(STATE_LEVEL), "content-type": "application/json" },
        body: JSON.stringify({ upsert: [{ id: `msg_stand_in_${randomBytes(6).toString("hex")}`, chatId: `bot:${BOT.id}`, role: "system", text, at: Date.now(), ...extra }] }),
      }).catch((e) => ({ ok: false, status: 0, text: async () => e.message }));
      if (!res.ok) say(`couldn't post to the bot's chat: ${res.status} ${await res.text()}`);
      return res.ok;
    }

    /* The two apps, each its own HOME and Keychain folder, signed in with its made-up key. */
    const bin = join(dir, "bin");
    mkdirSync(bin);
    writeFileSync(join(bin, "security"), SECURITY, { mode: 0o755 });
    const app = (who, person, port, dist) => {
      const home = join(dir, `${who}-home`);
      const keychain = join(dir, `${who}-keychain`);
      // (Again for the owner's Bops started after a shut: the same folders, so it's the same Mac.)
      mkdirSync(home, { recursive: true });
      mkdirSync(keychain, { recursive: true });
      writeFileSync(join(keychain, encodeURIComponent("orgo-api-key")), person.key);
      return run(who, process.execPath, [join(root, "node_modules", "next", "dist", "bin", "next"), "dev", "-p", String(port), "-H", "127.0.0.1"], {
        cwd: root,
        env: {
          ...cleanEnv(),
          HOME: home,
          PATH: `${bin}:${process.env.PATH}`,
          BOPS_TEST_KEYCHAIN: keychain,
          BOPS_CLOUD_URL: urls.browserProxy ?? urls.cloud,
          BOPS_ORGO_ORIGIN: ORGO,
          ...(dist ? { BOPS_NEXT_DIST_DIR: dist } : {}),
        },
      });
    };
    say(`owner's Bops on ${ports.owner}, sam's on ${ports.sam}`);
    let ownerApp = app("owner", OWNER, ports.owner);
    const samApp = app("sam", SAM, ports.sam, ".scratch/next-sam");
    await waitFor("both apps", () => /Ready in/.test(ownerApp.output()) && /Ready in/.test(samApp.output()), 120_000);
    // The first load compiles the page and signs in: both, before saying it's up.
    for (const u of [urls.owner, urls.sam]) await waitFor(`${u} to load`, () => fetch(u).then((r) => r.ok, () => false), 240_000);

    /* The control port: what the end-to-end test asks of the stand-in computer. */
    const control = createServer(async (req, res) => {
      const send = (status, body) => res.writeHead(status, { "content-type": "application/json" }).end(JSON.stringify(body));
      const url = new URL(req.url, "http://control");
      let body = "";
      for await (const c of req) body += c;
      const json = body ? JSON.parse(body) : {};
      try {
        if (url.pathname === "/info") return send(200, { word, urls, ports, bot: BOT, project: PROJECT, sam: SAM_ROLE, account: { user: ACCOUNT.user } });
        if (url.pathname === "/relay") return send(200, relay ? relay.status() : { none: true });
        // The stand-in computer cut off from Bops Cloud, and back (its runner gone a while: the tab's "can't be reached").
        if (url.pathname === "/relay/cut" && req.method === "POST") {
          await relay?.stop();
          relay = null;
          return send(200, { cut: true });
        }
        // The owner's Bops shut (the owner's Mac closed: its tunnel goes), and started again on the same folders; the rest stays up.
        if (url.pathname === "/owner/stop" && req.method === "POST") {
          const pid = ownerApp.child.pid;
          letGo.add(pid);
          process.kill(-pid, "SIGTERM");
          // A moment to save what it holds to Bops Cloud, as a quit does; then nothing of it is left.
          for (const end = Date.now() + 5000; groupAlive(pid) && Date.now() < end; ) await sleep(200);
          await endGroup(pid);
          children.splice(children.indexOf(pid), 1);
          save();
          return send(200, { stopped: true });
        }
        if (url.pathname === "/owner/start" && req.method === "POST") {
          if (groupAlive(ownerApp.child.pid)) return send(409, { error: "the owner's Bops is running" });
          ownerApp = app("owner", OWNER, ports.owner);
          await waitFor("the owner's Bops", () => fetch(urls.owner).then((r) => r.ok, () => false), 240_000);
          return send(200, { started: true });
        }
        if (url.pathname === "/relay/back" && req.method === "POST") {
          relay ??= startRelay(relayOptions);
          return send(200, { back: true });
        }
        if (url.pathname === "/bot/step" && req.method === "POST") return send(200, json.do === "signin" ? await signInStep() : await botStep(json));
        // A message from the bot in its chat, as its runner would post one (links in it, say).
        if (url.pathname === "/bot/say" && req.method === "POST") return send(200, { ok: await postNote(String(json.text ?? ""), { role: "bot", botId: BOT.id }) });
        send(404, { error: "no such control" });
      } catch (e) {
        send(500, { error: String(e.message ?? e) });
      }
    });
    servers.push(control);
    await new Promise((r) => control.listen(ports.control, "127.0.0.1", r));

    /** Where the bot's pointer last was on the page (CSS pixels), for how long its cursor takes to get from there. */
    let botAt = null;
    /**
     * What the bot is doing with its browser, as a runner says it (relay.activity): browsing from a step's start, idle
     * 1.5 s after its last ends (steps a beat apart are one stretch of browsing, not a flicker).
     */
    let steps = 0;
    let idleLater = null;
    const browsing = (on) => {
      clearTimeout(idleLater);
      steps += on ? 1 : -1;
      if (on) relay?.activity(COMPUTER.display, BOT.id, { step: "browsing" });
      else if (!steps) idleLater = setTimeout(() => relay?.activity(COMPUTER.display, BOT.id, { step: "idle" }), 1500);
    };
    /**
     * A bot step on the stand-in's Chrome, as a runner's page_script would take it (vm/page-script.cjs: Playwright over
     * CDP on the tab in front): it waits while a person has control of that screen (the relay's hold), then runs.
     * `do`: "read" (the page's address, title and text), "goto" (an address), "click" (a selector, or a point `x`, `y`),
     * "browse" (`urls` in turn, `pause` ms on each).
     * A click is paced as Codex paces its agent's: the pointer moves, the bot waits for its cursor to get there
     * (lib/cursor-path.ts travelMs, and a beat), then presses, so a watcher sees what it's about to do. It aims inside the
     * target but off its words (to the right, a little low), so the cursor never covers what it presses.
     */
    async function botStep({ do: what, url: to, selector, x, y, urls: pages, pause = 1200 }) {
      const asked = Date.now();
      if (relay) await relay.whenFree(COMPUTER.display);
      const waited = Date.now() - asked;
      browsing(true);
      const browser = await chromium.connectOverCDP(`http://127.0.0.1:${ports.chrome}`);
      try {
        const page = browser.contexts()[0].pages().find((p) => !p.url().startsWith("devtools:")) ?? (await browser.contexts()[0].newPage());
        if (what === "goto") await page.goto(to, { waitUntil: "load" });
        // A stretch of browsing: each page in turn, a pause on each (a Watch chip's while it lasts).
        if (what === "browse")
          for (const u of pages ?? []) {
            // Someone took over meanwhile: the bot waits for them, as a runner's paused thread does.
            if (relay) await relay.whenFree(COMPUTER.display);
            await page.goto(u, { waitUntil: "load" });
            await sleep(pause);
          }
        let clickedAt;
        let movedAt;
        if (what === "click") {
          const box = selector ? await page.locator(selector).boundingBox() : null;
          if (selector && !box) throw new Error(`nothing on the page matches ${selector}`);
          const point = box ? { x: box.x + box.width * 0.85, y: box.y + box.height * 0.6 } : { x: Number(x), y: Number(y) };
          // First move of all: from where it rests, so a watcher sees it come rather than appear on the target.
          if (!botAt) {
            botAt = { x: 640, y: 420 };
            await page.mouse.move(botAt.x, botAt.y);
            await sleep(450);
          }
          movedAt = Date.now();
          await page.mouse.move(point.x, point.y);
          await sleep(travelMs(Math.hypot(point.x - botAt.x, point.y - botAt.y)) + 120);
          botAt = point;
          await page.mouse.down();
          await page.mouse.up();
          clickedAt = Date.now();
        }
        return { ok: true, waited, movedAt, clickedAt, at: botAt, url: page.url(), title: await page.title(), text: (await page.evaluate(() => document.body.innerText)).slice(0, 2000) };
      } finally {
        await browser.close().catch(() => {});
        browsing(false);
      }
    }

    /**
     * The bot reaches the test site's sign-in page and can't sign in itself: it asks in its chat (Message.signIn: "Sign in
     * in Boppy's browser"), its viewers' status line says it needs them, and it waits for someone to take over and hand
     * back. Then it reads the page: the name it's signed in as. A runner's bot asks the same way (follow-up).
     */
    async function signInStep() {
      const login = `${urls.site}/login`;
      if (relay) await relay.whenFree(COMPUTER.display);
      let browser = await chromium.connectOverCDP(`http://127.0.0.1:${ports.chrome}`);
      try {
        const page = browser.contexts()[0].pages().find((p) => !p.url().startsWith("devtools:"));
        await page.goto(login, { waitUntil: "load" });
      } finally {
        await browser.close().catch(() => {});
      }
      relay?.activity(COMPUTER.display, BOT.id, { step: "idle", signIn: login });
      await postNote("I'm at the test site's sign-in page and can't sign in myself. Sign in in my browser, then hand back and I'll carry on.", { role: "bot", botId: BOT.id, signIn: { url: login } });
      const asked = Date.now();
      // Someone takes over, signs in and hands back (two minutes at most).
      for (const end = asked + 120_000; !relay?.heldBy(COMPUTER.display); await sleep(100)) if (Date.now() > end) throw new Error("nobody took over to sign in");
      await relay.whenFree(COMPUTER.display);
      relay.activity(COMPUTER.display, BOT.id, { step: "browsing" });
      browser = await chromium.connectOverCDP(`http://127.0.0.1:${ports.chrome}`);
      try {
        const page = browser.contexts()[0].pages().find((p) => !p.url().startsWith("devtools:"));
        if (!page.url().endsWith("/account")) await page.goto(`${urls.site}/account`, { waitUntil: "load" });
        const text = await page.evaluate(() => document.body.innerText);
        return { ok: true, waited: Date.now() - asked, url: page.url(), signedInAs: /Signed in as (.+)/.exec(text)?.[1]?.trim() ?? null };
      } finally {
        await browser.close().catch(() => {});
        setTimeout(() => relay?.activity(COMPUTER.display, BOT.id, { step: "idle" }), 1500);
      }
    }

    state.ready = true;
    save();
    say("up");
  } catch (e) {
    await fail(e);
  }
}

const cmd = process.argv[2];
if (cmd === "start") await start();
else if (cmd === "stop") await stop();
else if (cmd === "status") status();
else if (cmd === "serve") await serve();
else {
  console.error("Usage: node scripts/dev-two-person.mjs start | stop | status");
  process.exit(2);
}
