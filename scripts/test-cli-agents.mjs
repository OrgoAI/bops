// Tests for a bot's threads on its brain (lib/server/cli-agents.ts, sessions.ts brainTurns, vm/bin/bops-agent,
// the screen MCP's approve tool): a bot whose brain is Claude Code runs its tasks' turns on Claude Code on its
// computer, through the same session runner, never on AI credit. A plan brain that isn't signed in on that
// computer waits on the user with Sign in, and carries on once it's signed in. Claude Code runs detached, pinned
// to the thread's screen, from an empty environment (no Anthropic key or token from anywhere for a plan brain;
// a key brain's key only in its environment, never on a command line, its file deleted), with Bops' screen and
// browser MCP servers, Bops' briefing and the tools it may use by itself; everything else asks the user with the
// app approval card (yes, no, or no answer in time). Its events become the thread's steps (pictures never come
// back to Bops), its session id is kept and picked back up on the next turn, a reply mid-turn goes in at once and
// the turn ends when every message has its answer, Stop interrupts it, a process that died is started again on
// the same session, an MCP server that didn't start is said, and a usage limit waits on the user with Finish on
// Bops agent (which carries on there, on AI credit, with what Claude Code did) and Wait.
//
// Orgo is a fake whose computers run Bops' commands here, in a throwaway folder: the real vm/bin/bops-agent and
// bops-brain (as Bops installed them on the fake computer) with a fake Claude Code that reads stream-json lines
// and writes stream-json events as the real one does, in an environment with Anthropic keys and tokens planted
// in it. Bops Cloud (OpenAI behind it) is a fake too. Nothing reaches a real service. The window's cards for
// these threads are rendered to HTML by a child of the test (--render: the window's code isn't react-server).
//
// Usage: node --conditions=react-server scripts/test-cli-agents.mjs
//        REAL_CLAUDE=1 node --conditions=react-server scripts/test-cli-agents.mjs
//          also runs this Mac's own Claude Code (signed in as it is here, with no Anthropic key or token in its
//          environment) through the same fake computer, on "Reply with the word ok.", and prints the events it saw.
import assert from "node:assert/strict";
import { execFile, execFileSync } from "node:child_process";
import { accessSync, constants, existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmdirSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { registerHooks } from "node:module";
import { homedir, tmpdir } from "node:os";
import { delimiter, join } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import ts from "typescript";

const REAL_CLAUDE = process.env.REAL_CLAUDE === "1";
const REAL_HOME = homedir();
const REAL_PATH = process.env.PATH ?? "";
for (const k of Object.keys(process.env))
  if (/^(BOPS|OPENAI|AGENTPHONE|AGENTMAIL|HONCHO|COMPOSIO|TYPESAFE|TWILIO|ORGO|CODEX|TAILSCALE|TREG|ANTHROPIC|CLAUDE_CODE)_/.test(k) || k === "CLAUDECODE" || k === "REAL_CLAUDE") delete process.env[k];
process.env.BOPS_DEVICE_SEED = "test-cli-agents";
process.env.BOPS_RESPONSES_WS = "0";
// Bops listens on this Mac only, as the Mac app does by default: computers get no address for it, and
// nothing asks this Mac's Tailscale (composio.ts bopsAddress).
process.env.HOSTNAME = "127.0.0.1";
const root = new URL("..", import.meta.url).pathname.replace(/\/$/, "");
// Modules that would start processes when loaded are stand-ins: each export does nothing.
const STAND_INS = new Set(["relay", "desktop", "mirror"]);
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
    // The app's window code (the --render pass below), compiled with the TypeScript in node_modules.
    if (url.endsWith(".css")) return { format: "module", source: "export default {};", shortCircuit: true };
    if (url.endsWith(".tsx")) {
      const out = ts.transpileModule(readFileSync(fileURLToPath(url), "utf8"), { compilerOptions: { jsx: ts.JsxEmit.ReactJSX, module: ts.ModuleKind.ESNext, target: ts.ScriptTarget.ES2022, verbatimModuleSyntax: false }, fileName: url });
      return { format: "module", source: out.outputText, shortCircuit: true };
    }
    const name = url.match(/\/lib\/server\/([a-z-]+)\.ts$/)?.[1];
    if (!name || !STAND_INS.has(name)) return next(url, context);
    const names = [...readFileSync(new URL(url), "utf8").matchAll(/^export (?:async )?(?:function\*? |const |let |class )([A-Za-z_$][\w$]*)/gm)].map((m) => m[1]);
    return { format: "module", shortCircuit: true, source: names.map((n) => `export const ${n} = function () { return Promise.resolve(); };`).join("\n") };
  },
});
/* ---------------- The --render pass: the window's cards, from the threads the server made ---------------- */

// A child of the test, without react-server (these are the window's components): a thread waiting for its
// brain's sign-in has Sign in, one at its limit has its two replies, and a brain's approval says what it runs.
if (process.argv[2] === "--render") {
  globalThis.window = globalThis;
  globalThis.addEventListener = () => {};
  globalThis.removeEventListener = () => {};
  globalThis.document = { hidden: false, addEventListener() {}, removeEventListener() {}, getElementById: () => null };
  globalThis.localStorage = { getItem: () => null, setItem() {}, removeItem() {} };
  globalThis.matchMedia = () => ({ matches: false });
  globalThis.fetch = async () => ({ ok: false, status: 404, json: async () => ({}) });
  const { ThreadSheet, ChatView } = await import(pathToFileURL(`${root}/components/app/chat-view.tsx`).href);
  const { renderToStaticMarkup } = await import("react-dom/server");
  const { createElement: h } = await import("react");
  const v = JSON.parse(readFileSync(process.argv[3], "utf8"));
  const text = (html) => html.replace(/<[^>]+>/g, " ").replace(/&#x27;/g, "'").replace(/&amp;/g, "&").replace(/\s+/g, " ").trim();
  const noop = () => {};
  const state = (s, more = {}) => ({ bots: v.bots, brains: v.brains, sessions: [s], chats: [v.chat], messages: [], host: "orgo", ...more });
  const sheet = (s) => text(renderToStaticMarkup(h(ThreadSheet, { state: state(s), session: s, onClose: noop, onShowComputer: noop, onShowScreen: noop })));
  const signIn = sheet(v.signIn);
  assert.match(signIn, /Boppy needs Claude Code signed in Sign in Dismiss/, signIn);
  assert.ok(!/Try again/.test(signIn));
  console.log("ok render: waiting for its brain's sign-in, the card has Sign in");
  const limit = sheet(v.limit);
  assert.match(limit, /Boppy is waiting on you Finish on Bops agent Wait Never mind Something else/, limit);
  console.log("ok render: at its limit, the card has Finish on Bops agent and Wait");
  const chat = text(renderToStaticMarkup(h(ChatView, { state: state(v.asking, { appApprovals: [v.approval] }), chat: v.chat, wide: false, onOpenThread: noop, onShowBot: noop, onShowMac: noop, onShowScreen: noop, call: null, onCall: noop, callSlot: noop })));
  assert.match(chat, /Boppy wants to run: NotebookEdit \/workspace\/report\.ipynb For “Asks” notebook path: \/workspace\/report\.ipynb new source: print\(1\) Do it Don’t/, chat);
  console.log("ok render: a brain's approval says what it wants to run");
  for (const t of [signIn.match(/Boppy needs.*Dismiss/)[0], limit.match(/Boppy is waiting.*Wait/)[0], chat.match(/Boppy wants to run.*Don’t/)[0]]) assert.ok(!/[–—]/.test(t), t);
  process.exit(0);
}

const scratch = mkdtempSync(join(tmpdir(), "bops-test-cli-agents-"));
process.chdir(scratch);
process.env.HOME = join(scratch, "home");
mkdirSync(process.env.HOME);
// The app's files (vm/, the browser tools' version) are read from where it runs.
symlinkSync(join(root, "node_modules"), join(scratch, "node_modules"));
symlinkSync(join(root, "vm"), join(scratch, "vm"));
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
async function until(check, what, ms = 20_000) {
  for (const end = Date.now() + ms; Date.now() < end; await sleep(20)) {
    const v = check();
    if (v) return v;
  }
  assert.fail(`timed out waiting for ${what}`);
}
let passed = 0;
const test = async (name, fn) => {
  await fn();
  passed++;
  console.log(`ok ${name}`);
};

/* ---------------- A fake Claude Code ---------------- */

const fakebin = join(scratch, "fakebin");
mkdirSync(fakebin);
const LOG = join(scratch, "logs");
mkdirSync(LOG);
const FLAGS = join(scratch, "flags");
mkdirSync(FLAGS);
const RUNS = join(LOG, "runs.jsonl");
const HEARD = join(LOG, "heard.jsonl");
/** A picture as big as a screenshot: it must never come back to Bops whole. */
const PICTURE = "iVBORw0KGgo".padEnd(60_000, "A");
const fakeClaude = join(scratch, "fake-claude.mjs");
writeFileSync(
  fakeClaude,
  `import { appendFileSync, existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { createInterface } from "node:readline";
const RUNS = ${JSON.stringify(RUNS)}, HEARD = ${JSON.stringify(HEARD)}, FLAGS = ${JSON.stringify(FLAGS)}, PICTURE = ${JSON.stringify(PICTURE)};
const args = process.argv.slice(2);
const pid = process.pid;
appendFileSync(RUNS, JSON.stringify({ pid, args, env: process.env, cwd: process.cwd() }) + "\\n");
const heard = (x) => appendFileSync(HEARD, JSON.stringify({ pid, ...x }) + "\\n");
const D = process.env.CLAUDE_CONFIG_DIR ?? join(process.env.HOME ?? "/", ".claude");
if (args[0] === "--version") { console.log("2.1.292 (Claude Code)"); process.exit(0); }
if (args[0] === "auth" && args[1] === "status") {
  if (existsSync(join(D, ".credentials.json"))) console.log(JSON.stringify({ loggedIn: true, authMethod: "claude.ai", apiProvider: "firstParty", email: "maya@acme.test", orgId: "org-7f3a", orgName: "Acme", subscriptionType: "max", configDirectory: D }));
  else { console.log(JSON.stringify({ loggedIn: false, authMethod: "none", apiProvider: "firstParty" })); process.exit(1); }
  process.exit(0);
}
if (args[0] === "auth") process.exit(0);
const flag = (n) => { const i = args.indexOf(n); return i >= 0 ? args[i + 1] : undefined; };
const sid = flag("--resume") ?? flag("--session-id");
const file = join(D, "projects", "-workspace", sid + ".jsonl");
if (flag("--resume") && !existsSync(file)) { console.error("No conversation found with session ID: " + sid); process.exit(1); }
const mcp = JSON.parse(readFileSync(flag("--mcp-config"), "utf8"));
process.on("SIGINT", () => { heard({ interrupted: true }); process.exit(130); });
process.on("exit", (code) => heard({ exit: code }));
const out = (e) => process.stdout.write(JSON.stringify({ ...e, session_id: sid }) + "\\n");
const say = (content, parent = null) => out({ type: "assistant", message: { role: "assistant", content }, parent_tool_use_id: parent });
const back = (id, content) => out({ type: "user", message: { role: "user", content: [{ type: "tool_result", tool_use_id: id, content, is_error: false }] }, parent_tool_use_id: null });
const wait = async (f) => { while (!existsSync(join(FLAGS, f))) await new Promise((r) => setTimeout(r, 15)); };
let began = false, n = 0, closed = false, busy = false;
const lines = [];
const rl = createInterface({ input: process.stdin });
rl.on("line", (l) => { if (!l.trim()) return; const m = JSON.parse(l); heard({ got: m.message.content }); lines.push(m); void go(); });
rl.on("close", () => { closed = true; if (!busy) process.exit(0); });
async function go() {
  if (busy) return;
  busy = true;
  while (lines.length) await answer(lines.shift());
  busy = false;
  if (closed) process.exit(0);
}
async function answer(m) {
  const text = m.message.content;
  mkdirSync(dirname(file), { recursive: true });
  appendFileSync(file, JSON.stringify({ type: "user", text }) + "\\n");
  if (!began) {
    began = true;
    const fail = existsSync(join(FLAGS, "mcp-fail"));
    out({ type: "system", subtype: "init", cwd: process.cwd(), model: "claude-test", permissionMode: "default", tools: ["Bash", "Read", "Edit", "Task", "mcp__screen__click", "mcp__screen__approve"], mcp_servers: Object.keys(mcp.mcpServers).map((name) => ({ name, status: fail && name === "screen" ? "failed" : "connected" })) });
  }
  const t = "t" + ++n;
  if (text.includes("HANG")) { say([{ type: "text", text: "Working on it." }]); await new Promise(() => {}); }
  if (text.includes("DIE") && !existsSync(join(FLAGS, "died"))) { writeFileSync(join(FLAGS, "died"), ""); say([{ type: "text", text: "Starting on it." }]); process.exit(1); }
  if (text.includes("LIMIT")) { out({ type: "result", subtype: "success", is_error: true, result: "Claude AI usage limit reached|1760032800", num_turns: 1, total_cost_usd: 0 }); return; }
  say([{ type: "thinking", thinking: "Checking the cart totals first. Then the tests.", signature: "sig".repeat(400) }]);
  say([{ type: "text", text: "Looking at the cart." }]);
  say([{ type: "tool_use", id: t + "a", name: "Bash", input: { command: "npm test" } }]);
  back(t + "a", "12 passing");
  say([{ type: "tool_use", id: t + "b", name: "Edit", input: { file_path: "/workspace/src/cart.ts", old_string: "a", new_string: "b" } }]);
  back(t + "b", "ok");
  say([{ type: "tool_use", id: t + "c", name: "mcp__screen__click", input: { x: 10, y: 20 } }]);
  back(t + "c", [{ type: "image", source: { type: "base64", media_type: "image/png", data: PICTURE } }]);
  say([{ type: "tool_use", id: t + "d", name: "mcp__browser__browser_navigate", input: { url: "https://example.com/cart" } }]);
  back(t + "d", "navigated");
  say([{ type: "tool_use", id: t + "e", name: "Task", input: { description: "Check the tax rules", prompt: "...", subagent_type: "general-purpose" } }]);
  say([{ type: "tool_use", id: t + "f", name: "WebSearch", input: { query: "sales tax rules" } }], t + "e");
  back(t + "e", "Tax is 8%.");
  if (text.includes("SLOW")) await wait("go");
  const done = "Done: " + text.split("\\n")[0];
  say([{ type: "text", text: done }]);
  out({ type: "result", subtype: "success", is_error: false, result: done, num_turns: 4, total_cost_usd: 0.02, usage: { input_tokens: 10, output_tokens: 5 } });
}
`,
);
const fake = (name, body) => writeFileSync(join(fakebin, name), `#!/bin/bash\n${body}\n`, { mode: 0o755 });
fake("claude", `exec ${JSON.stringify(process.execPath)} ${JSON.stringify(fakeClaude)} "$@"`);
fake("setsid", `exec "$@"`);
const lines = (f) => (existsSync(f) ? readFileSync(f, "utf8").trim().split("\n").filter(Boolean).map((l) => JSON.parse(l)) : []);
/** Every Claude Code process the fake computers ran for a thread (not its status checks), oldest first. */
const runs = () => lines(RUNS).filter((r) => r.args.includes("-p"));
const heardBy = (pid) => lines(HEARD).filter((h) => h.pid === pid);
const flagOn = (f) => writeFileSync(join(FLAGS, f), "");
const flagOff = (f) => rmSync(join(FLAGS, f), { force: true });

/* ---------------- Bops Cloud, OpenAI behind it, and Orgo: fakes ---------------- */

process.env.BOPS_CLOUD_URL = "https://cloud.test";
process.env.BOPS_ORGO_ORIGIN = "https://orgo.test";
globalThis.bopsOrgoKey = "sk_orgo_test";
const USER = { id: "u_1", email: "me@acme.test", name: "Maya" };
const PNG = Buffer.from("iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==", "base64");
const json = (obj, status = 200) => new Response(JSON.stringify(obj), { status, headers: { "content-type": "application/json" } });
const cloudState = { version: 0, seq: 0, blob: null };
/** Bops agent's model calls (bodies), and what OpenAI answers next. */
const asked = [];
const answers = [];
const said = (text) => ({ id: `msg_${asked.length}`, type: "message", role: "assistant", phase: "final_answer", content: [{ type: "output_text", text, annotations: [] }] });
const response = (id, output) => ({ id, object: "response", model: "gpt-6.1-sol", status: "completed", output, usage: { input_tokens: 100, output_tokens: 5, input_tokens_details: { cached_tokens: 0 }, output_tokens_details: { reasoning_tokens: 0 } } });
const KEY = "sk-ant-api03-VAULT-KEY-7Qx9";
/** What the computer's environment has besides Bops' own: keys and tokens Claude Code would use first. */
const PLANTED = { ANTHROPIC_API_KEY: "sk-ant-api03-PLANTED", ANTHROPIC_AUTH_TOKEN: "planted-auth-token", CLAUDE_CODE_OAUTH_TOKEN: "planted-oauth-token", ANTHROPIC_BASE_URL: "https://planted.test", CLAUDECODE: "1" };

const pcs = new Map();
/** A fake computer: a folder whose /usr/local/bin, /root and /workspace are its own. */
const pc = (id) => {
  if (!pcs.has(id)) {
    const dir = join(scratch, "pcs", id);
    for (const d of ["bin", "root/.bops/agents", "root/.bops/brains", "workspace", "logs", "opt"]) mkdirSync(join(dir, d), { recursive: true });
    pcs.set(id, { id, dir, bin: join(dir, "bin"), agents: join(dir, "root/.bops/agents"), brains: join(dir, "root/.bops/brains"), commands: [], outputs: [], claude: join(fakebin, "claude"), home: join(dir, "root") });
  }
  return pcs.get(id);
};
const onPc = (c, path) => (path.startsWith("/usr/local/bin/") ? join(c.bin, path.slice("/usr/local/bin/".length)) : join(c.dir, path));
const runHere = (c, command) =>
  new Promise((resolve) =>
    execFile(
      "/bin/bash",
      ["-c", command],
      {
        env: {
          PATH: `${c.bin}:${fakebin}:/usr/bin:/bin:/usr/sbin:/sbin`,
          HOME: c.home,
          BOPS_AGENTS: c.agents,
          BOPS_BRAINS: c.brains,
          BOPS_WORKSPACE: join(c.dir, "workspace"),
          BOPS_CLAUDE: c.claude,
          BOPS_LOGS: join(c.dir, "logs"),
          BOPS_HOME: c.home,
          ...PLANTED,
        },
        timeout: 30_000,
      },
      (err, stdout, stderr) => resolve({ output: `${stdout}${stderr}`, exit_code: err ? (typeof err.code === "number" ? err.code : 1) : 0 }),
    ),
  );
async function bash(id, command) {
  const c = pc(id);
  c.commands.push(command);
  if (command.startsWith("md5sum ")) return { output: "", exit_code: 0 };
  const write = /^(?:mkdir -p \S+ && )?echo ([A-Za-z0-9+/=]+) \| base64 -d > (\S+) && chmod (\d+) \2 && echo ok$/.exec(command);
  if (write) {
    const to = onPc(c, write[2]);
    mkdirSync(join(to, ".."), { recursive: true });
    writeFileSync(to, Buffer.from(write[1], "base64"), { mode: parseInt(write[3], 8) });
    return { output: "ok\n", exit_code: 0 };
  }
  if (command.includes("npm install -g --prefix /opt/bops/claude")) return { output: "claude 2.1.292\n", exit_code: 0 };
  if (/(^|\n|; |\| )bops-(agent|brain) /.test(command)) {
    const r = await runHere(c, command);
    c.outputs.push({ command, output: r.output });
    return r;
  }
  if (command.includes("bops-screens list")) return { output: "{}", exit_code: 0 };
  return { output: command.includes("echo ok") ? "ok" : "1", exit_code: 0 };
}
const vault = new Map([["ANTHROPIC_API_KEY", KEY]]);
let reveals = 0;
globalThis.fetch = async (input, init) => {
  const req = new Request(input, init);
  const url = new URL(req.url);
  const body = req.body ? await req.text() : "";
  if (url.origin === "https://cloud.test") {
    if (url.pathname === "/v1/session" && req.method === "POST")
      return json({ userId: USER.id, mail: null, agentphone: null, honcho: null, composio: null, openai: { executorKey: "sk_exec" }, typesafe: false, verify: { sms: false, email: false }, slack: null });
    const head = { version: cloudState.version, seq: cloudState.seq };
    if (url.pathname === "/v1/state" && req.method === "GET") return cloudState.blob ? json({ ...head, protocol: 2, state: cloudState.blob }) : json(head, 404);
    if (url.pathname === "/v1/state/head") return json(head);
    if (url.pathname === "/v1/state" && req.method === "PUT") {
      const { base, state } = JSON.parse(body);
      if (base !== cloudState.version) return json({ code: "state_conflict", ...head, state: cloudState.blob }, 409);
      cloudState.blob = state;
      return json({ version: ++cloudState.version });
    }
    if (url.pathname === "/v1/messages" && req.method === "GET") return json({ messages: [], seq: cloudState.seq, more: false });
    if (url.pathname === "/v1/messages" && req.method === "POST") return json({ seq: ++cloudState.seq });
    if (url.pathname === "/proxy/openai/v1/responses" && req.method === "POST") {
      const b = JSON.parse(body);
      // Bops agent's turn (it has the computer); Jev and the rest get a plain refusal, and go on without.
      if (!b.tools?.some((t) => t.type === "computer")) return json({ error: { message: "not in this test" } }, 400);
      asked.push(b);
      const next = answers.shift();
      assert.ok(next, `an answer for model call ${asked.length}`);
      return json(next(b));
    }
    return json({ error: "not faked" }, 404);
  }
  if (url.origin === "https://orgo.test") {
    const path = url.pathname.replace(/^\/api/, "");
    if (path === "/bops/computer/active") return json({ ok: true });
    if (path === "/secrets/reveal" && req.method === "POST") {
      reveals++;
      const { name } = JSON.parse(body);
      return vault.has(name) ? json({ name, value: vault.get(name) }) : json({ error: "Secret not set" }, 404);
    }
    const m = /^\/computers\/([^/]+)(\/.*)?$/.exec(path);
    if (m && m[2] === "/screens") return json({ screens: [99, 100, 101, 102].map((d) => ({ id: d === 99 ? "default" : `screen-${d}`, display: `:${d}`, width: 1280, height: 960, vnc_port: 5900 + d, ws_port: 5981 + d, default: d === 99 })) });
    if (m && m[2] === "/screenshot") return new Response(PNG, { headers: { "content-type": "image/png" } });
    if (m && m[2] === "/bash" && req.method === "POST") return json(await bash(m[1], JSON.parse(body).command));
    if (m && !m[2]) return json({ id: m[1], status: "running" });
    return json({ error: "not faked" }, 404);
  }
  throw new TypeError(`fetch failed (the test is offline: ${url.host})`);
};
const warned = [];
console.warn = (...a) => warned.push(a.join(" "));

const S = await import(`${root}/lib/server/store.ts`);
const X = await import(`${root}/lib/server/sessions.ts`);
const C = await import(`${root}/lib/server/cli-agents.ts`);
const A = await import(`${root}/lib/asks.ts`);
const Cx = await import(`${root}/lib/server/composio.ts`);
C.cliTiming.pollMs = 25;

await S.bindSignIn(USER.id, "sk_orgo_test");
S.update((s) => {
  s.account = { user: USER, signedInAt: Date.now() };
  s.host = "orgo";
  s.owner = { name: "Maya" };
});
const main = S.getState().bots.find((b) => b.isMain);
const PC = "pc-main";
const PLAN = { id: "brain_plan", kind: "claude", name: "Claude Code", auth: "plan", bots: [main.id], workspaceId: "ws_main", createdAt: 1 };
S.update((s) => {
  Object.assign(S.bot(main.id), { computerId: PC, computerStatus: "ready", effort: "medium", brain: PLAN.id });
  s.brains = [structuredClone(PLAN)];
});
const thread = (id) => S.session(id);
const ended = (id, what = "the thread to end") => until(() => ["done", "failed"].includes(thread(id)?.status) && thread(id), what);
/** Sign the plan brain in on the fake computer, as Claude Code's own sign-in leaves its folder. */
const signIn = (computerId = PC, brainId = PLAN.id) => {
  const d = join(pc(computerId).brains, brainId);
  mkdirSync(d, { recursive: true });
  writeFileSync(join(d, ".computer"), computerId);
  writeFileSync(join(d, ".credentials.json"), '{"claudeAiOauth":{"accessToken":"sk-ant-oat01-NEVER-KEPT"}}');
};
const agentDir = (sid, computerId = PC) => join(pc(computerId).agents, sid);
const alive = (pid) => {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
};
const details = (id) => thread(id).steps.map((x) => x.detail);
/** Threads as the server left them, for the --render pass. */
const views = {};

/* ---------------- Not signed in, then signed in ---------------- */

let t1;
await test("a plan brain that isn't signed in on the bot's computer waits on the user with Sign in, not an error, and never on AI credit", async () => {
  // Out of AI credit: Bops agent wouldn't start, a brain's run doesn't ask.
  S.update((s) => (s.credits = { out: true, at: Date.now() }));
  const s = X.startSession({ botId: main.id, goal: "Fix the cart total", title: "Cart total", where: "cloud", fresh: true });
  t1 = s.id;
  const t = await ended(t1);
  assert.equal(t.status, "done", `it waits rather than failing (${t.error ?? ""}; ${warned.join(" | ")})`);
  assert.match(t.answer, /^Claude Code isn't signed in on Boppy's computer\. Sign in with your Claude plan there and I'll start\.$/);
  assert.equal(t.brainRun.waits, "sign_in");
  assert.equal(t.brainRun.brainId, PLAN.id);
  assert.equal(t.brainRun.computerId, PC);
  assert.match(t.brainRun.cli, /^[0-9a-f-]{36}$/);
  assert.equal(t.brainRun.started, undefined);
  assert.equal(t.waitingOnYou, true);
  assert.equal(A.needsYou(t), true);
  assert.equal(A.askKind(t), "brain", "its card has Sign in");
  assert.equal(runs().length, 0, "Claude Code didn't run");
  assert.notEqual(t.error, "You're out of AI credit");
  const result = S.getState().messages.filter((m) => m.resultOf === t1).at(-1);
  assert.equal(result?.text, t.answer, "said in the chat");
  views.signIn = structuredClone(t);
});

let sid1;
await test("signed in there, the thread carries on: Claude Code on its screen, from an empty environment, with Bops' tools and briefing", async () => {
  signIn();
  X.brainSignedIn(PLAN.id, PC);
  await until(() => thread(t1).status !== "done", "it to start again");
  const t = await ended(t1);
  assert.equal(t.status, "done", `it finished (${t.error ?? ""}; ${warned.join(" | ")})`);
  assert.equal(t.answer, "Done: Fix the cart total", "the goal went in as its first message");
  assert.equal(t.waitingOnYou === true, false);
  assert.equal(t.brainRun.waits, undefined);
  assert.equal(t.brainRun.started, true);
  const [r] = runs();
  sid1 = t.brainRun.cli;
  // Its arguments: headless stream-json both ways, Bops' MCP servers only, Bops' briefing, what it may do, who it asks.
  const arg = (n) => r.args[r.args.indexOf(n) + 1];
  for (const a of ["-p", "--verbose", "--strict-mcp-config"]) assert.ok(r.args.includes(a), a);
  assert.equal(arg("--input-format"), "stream-json");
  assert.equal(arg("--output-format"), "stream-json");
  assert.equal(arg("--session-id"), sid1, "a new session, under the id Bops keeps");
  assert.ok(!r.args.includes("--resume"));
  assert.equal(arg("--permission-prompt-tool"), "mcp__screen__approve");
  assert.deepEqual(arg("--allowedTools").split(","), ["Bash", "BashOutput", "KillShell", "Read", "Edit", "MultiEdit", "Write", "Glob", "Grep", "LS", "WebFetch", "WebSearch", "TodoWrite", "Task", "Agent", "mcp__screen", "mcp__browser"]);
  for (const a of ["--dangerously-skip-permissions", "--bare", "--permission-mode"]) assert.ok(!r.args.includes(a), `never ${a}`);
  const dir = agentDir(t1);
  assert.equal(arg("--mcp-config"), join(dir, "mcp.json"));
  assert.equal(arg("--append-system-prompt-file"), join(dir, "prompt.md"));
  // Its environment: nothing from the computer's (no Anthropic key, token or base URL), its own folder, its screen.
  const display = t.lastDisplay;
  for (const k of Object.keys(PLANTED)) assert.equal(r.env[k], undefined, `no ${k}`);
  assert.ok(!Object.keys(r.env).some((k) => /^ANTHROPIC_/.test(k)), "no ANTHROPIC_ variable at all");
  assert.equal(r.env.CLAUDE_CONFIG_DIR, join(pc(PC).brains, PLAN.id));
  assert.equal(r.env.DISPLAY, `:${display}`);
  assert.equal(r.cwd.replace(/^\/private/, ""), join(pc(PC).dir, "workspace").replace(/^\/private/, ""));
  // Its tools: the same screen and browser MCP servers as Bops agent's, on its screen.
  const mcp = JSON.parse(readFileSync(join(dir, "mcp.json"), "utf8"));
  assert.deepEqual(Object.keys(mcp.mcpServers), ["screen", "browser"]);
  assert.deepEqual(mcp.mcpServers.screen.args, ["/opt/bops/screen_mcp.py", "stdio", "--session", t1, "--bot", main.id, "--approve"]);
  assert.equal(mcp.mcpServers.screen.env.DISPLAY, `:${display}`);
  assert.deepEqual(mcp.mcpServers.browser.args.slice(1, 3), ["--cdp-endpoint", `http://127.0.0.1:${9200 + display}`]);
  // Its briefing: the bot as Bops agent knows it, then what it's told about itself as Claude Code.
  const prompt = readFileSync(join(dir, "prompt.md"), "utf8");
  assert.match(prompt, /^You are Boppy, the .* bot in Bops\./);
  assert.match(prompt, /You run as Claude Code on this computer, for Bops\..*Any other tool asks Maya in Bops first/);
  assert.ok(!/[–—]/.test(prompt.slice(prompt.indexOf("You run as Claude Code"))), "no long dashes in what Bops adds");
  // Its events are the thread's steps, worded as Bops agent's are, its helper's credited to it.
  const d = details(t1);
  for (const x of ["Looking at the cart.", "ran npm test", "edited cart.ts", "clicked (10, 20)", "opened https://example.com/cart", "brought in a helper for Check the tax rules", 'searched "sales tax rules"'])
    assert.ok(d.includes(x), `a step says ${JSON.stringify(x)}: ${JSON.stringify(d)}`);
  assert.equal(t.steps.find((x) => x.detail === 'searched "sales tax rules"').who, "Check the tax rules");
  assert.ok(!d.includes("Done: Fix the cart total"), "its answer isn't a step too");
  assert.deepEqual(t.steps.find((x) => x.detail === "ran npm test").tool, "command");
  // Pictures never come back to Bops: what it reads is made small on the computer.
  const reads = pc(PC).outputs.filter((o) => o.command.includes("bops-agent read"));
  assert.ok(reads.length > 0);
  assert.ok(reads.every((o) => !o.output.includes(PICTURE.slice(0, 2000)) && !o.output.includes("sigsigsig")), "no picture or signature in a read");
  assert.ok(reads.every((o) => o.output.length < 40_000));
  // The run's end lets its process go.
  await until(() => heardBy(r.pid).some((h) => "exit" in h), "its process to exit");
  assert.equal(heardBy(r.pid).find((h) => "exit" in h).exit, 0, "it ended with its input, not a kill");
  assert.ok(!heardBy(r.pid).some((h) => h.interrupted));
  S.update((s) => (s.credits = undefined));
});

await test("a reply picks the same Claude Code session back up", async () => {
  X.replyToSession(t1, "Now add a test for it");
  await until(() => thread(t1).status !== "done", "it to start again");
  const t = await ended(t1);
  assert.equal(t.status, "done", t.error);
  assert.equal(t.answer, "Done: Now add a test for it");
  const r = runs().at(-1);
  assert.equal(r.args[r.args.indexOf("--resume") + 1], sid1, "resumed");
  assert.ok(!r.args.includes("--session-id"));
  assert.equal(t.brainRun.cli, sid1);
  assert.match(heardBy(r.pid).find((h) => h.got).got, /^Now add a test for it/);
});

await test("a reply mid-turn goes in at once, and the turn ends when both have their answers", async () => {
  X.replyToSession(t1, "SLOW: check the totals");
  await until(() => thread(t1).status === "running" && runs().length === 3 && heardBy(runs().at(-1).pid).some((h) => h.got?.startsWith("SLOW")), "the first message to arrive");
  X.replyToSession(t1, "Also check the tax");
  const r = runs().at(-1);
  await until(() => heardBy(r.pid).some((h) => h.got === "Also check the tax"), "the second to arrive while it works");
  assert.equal(thread(t1).status, "running", "still on its first");
  await until(() => thread(t1).replies.at(-1).delivered === true, "it to be marked sent");
  flagOn("go");
  const t = await ended(t1);
  flagOff("go");
  assert.equal(t.status, "done", t.error);
  assert.equal(t.answer, "Done: Also check the tax", "the last answer is the turn's");
  assert.ok(details(t1).includes("Done: SLOW: check the totals"), "the one on the way is a step");
  assert.equal(runs().length, 3, "one process for the run");
});

await test("Stop interrupts its Claude Code", async () => {
  X.replyToSession(t1, "HANG on this one");
  await until(() => runs().length === 4 && heardBy(runs().at(-1).pid).some((h) => h.got?.startsWith("HANG")), "it to start working");
  const r = runs().at(-1);
  X.stopSession(t1);
  const t = await ended(t1);
  assert.equal(t.status, "failed");
  assert.equal(t.error, "Stopped by you");
  await until(() => heardBy(r.pid).some((h) => h.interrupted), "SIGINT");
  await until(() => !alive(r.pid), "it to be gone");
});

await test("a process that died mid-turn is started again on the same session, and told", async () => {
  X.replyToSession(t1, "DIE and then finish");
  const t = await ended(t1);
  assert.equal(t.status, "done", t.error);
  const [first, again] = runs().slice(-2);
  assert.ok(heardBy(first.pid).some((h) => h.got?.startsWith("DIE")));
  assert.equal(again.args[again.args.indexOf("--resume") + 1], sid1, "picked up the same session");
  const got = heardBy(again.pid).find((h) => h.got).got;
  assert.match(got, /^\(From Bops: you were cut off while you worked on this, and started again\. Check what's already done before you carry on\.\)\n\nDIE and then finish/);
  assert.ok(details(t1).includes("Starting on it."), "what it said before it died is kept");
});

/* ---------------- Its tools ---------------- */

await test("an MCP server that didn't start is said in the thread", async () => {
  flagOn("mcp-fail");
  const s = X.startSession({ botId: main.id, goal: "Read the dashboard", title: "Dashboard", where: "cloud", fresh: true });
  const t = await ended(s.id);
  flagOff("mcp-fail");
  assert.equal(t.status, "done", t.error);
  assert.ok(details(s.id).includes("Its screen tools didn't start, so it works without them"), JSON.stringify(details(s.id)));
  assert.notEqual(t.brainRun.cli, sid1, "a thread of its own, a session of its own");
});

await test("a tool it may not use by itself asks the user with the approval card: yes, no, or no answer in time", async () => {
  const s = X.startSession({ botId: main.id, goal: "HANG while it asks", title: "Asks", where: "cloud", fresh: true });
  await until(() => runs().some((r) => heardBy(r.pid).some((h) => h.got?.startsWith("HANG while"))), "it to start");
  const key = Cx.appsKeyFor(main.id);
  const yes = Cx.appCall(s.id, key, "approve", { tool: "NotebookEdit", input: { notebook_path: "/workspace/report.ipynb", new_source: "print(1)" } });
  const card = await until(() => S.getState().appApprovals?.find((a) => a.sessionId === s.id), "the card");
  assert.equal(card.app, "brain");
  assert.equal(card.title, "NotebookEdit /workspace/report.ipynb");
  assert.equal(card.action, "NotebookEdit");
  assert.match(card.detail, /notebook path: \/workspace\/report\.ipynb\nnew source: print\(1\)/);
  views.approval = structuredClone(card);
  views.asking = structuredClone(thread(s.id));
  Cx.answerApp(card.id, true);
  assert.deepEqual(JSON.parse((await yes).text), { behavior: "allow" });
  const no = Cx.appCall(s.id, key, "approve", { tool: "mcp__github__create_issue", input: { title: "Bug" } });
  const card2 = await until(() => S.getState().appApprovals?.find((a) => a.sessionId === s.id), "the second card");
  assert.equal(card2.title, "create_issue Bug");
  Cx.answerApp(card2.id, false);
  const denied = JSON.parse((await no).text);
  assert.equal(denied.behavior, "deny");
  assert.match(denied.message, /^Maya said no\. Don't do it, and don't do it another way\.$/);
  C.cliTiming.approveMs = 80;
  const late = JSON.parse((await Cx.appCall(s.id, key, "approve", { tool: "Bash", input: { command: "rm -rf build" } })).text);
  C.cliTiming.approveMs = 19 * 60_000;
  assert.equal(late.behavior, "deny");
  assert.match(late.message, /didn't answer in time/);
  assert.ok(!S.getState().appApprovals?.some((a) => a.sessionId === s.id), "its card went");
  // Only a running thread of its own bot, by its secret; and only a thread a brain runs asks this way.
  assert.equal((await Cx.appCall(s.id, "wrong-key", "approve", { tool: "Bash", input: {} })).status, 403);
  X.stopSession(s.id);
  await ended(s.id);
  assert.equal((await Cx.appCall(s.id, key, "approve", { tool: "Bash", input: {} })).status, 403, "a stopped thread's call opens nothing");
  assert.match(await C.approveTool(main.id, "ses_not_a_brain", { tool: "Bash", input: {} }), /Only a thread a brain runs/);
});

await test("the screen MCP's approve tool hands Claude Code allow with its input, or deny with why", () => {
  // The screen MCP with a stand-in for the mcp package (not installed here), and Bops' answer stood in for.
  const stub = join(scratch, "py", "mcp", "server", "fastmcp");
  mkdirSync(stub, { recursive: true });
  writeFileSync(join(scratch, "py", "mcp", "__init__.py"), "");
  writeFileSync(join(scratch, "py", "mcp", "server", "__init__.py"), "");
  writeFileSync(
    join(stub, "__init__.py"),
    "class Image:\n    def __init__(self, **k): pass\nclass FastMCP:\n    def __init__(self, name): self.tools = {}\n    def tool(self, **k):\n        def add(f):\n            self.tools[f.__name__] = f\n            return f\n        return add\n    def run(self, **k): pass\n",
  );
  const driver = join(scratch, "py", "drive.py");
  writeFileSync(
    driver,
    [
      "import json, sys, importlib.util",
      `sys.argv = ["screen_mcp.py", "stdio", "--session", "ses_1", "--bot", "boppy", "--approve"]`,
      `spec = importlib.util.spec_from_file_location("screen_mcp", ${JSON.stringify(join(root, "vm/screen_mcp.py"))})`,
      "m = importlib.util.module_from_spec(spec); spec.loader.exec_module(m)",
      "assert 'approve' in m.server.tools",
      "m.os.path.exists = lambda p: True",
      "out = []",
      "for said in ['{\"behavior\": \"allow\"}', '{\"behavior\": \"deny\", \"message\": \"Maya said no.\"}', 'Bops refused: not allowed']:",
      "    m._apps = lambda tool, args, said=said: said",
      "    out.append(json.loads(m.approve('Bash', {'command': 'ls'}, 'tu_1')))",
      "print(json.dumps(out))",
    ].join("\n"),
  );
  const out = JSON.parse(execFileSync("python3", [driver], { env: { PATH: REAL_PATH, PYTHONPATH: join(scratch, "py"), PYTHONDONTWRITEBYTECODE: "1" } }).toString());
  assert.deepEqual(out[0], { behavior: "allow", updatedInput: { command: "ls" } });
  assert.deepEqual(out[1], { behavior: "deny", message: "Maya said no." });
  assert.deepEqual(out[2], { behavior: "deny", message: "Bops refused: not allowed" });
  // Without --approve, a Bops agent thread's screen MCP has no such tool.
  const plain = execFileSync("python3", ["-c", `import sys, importlib.util; sys.argv=["s","stdio","--session","x"]; spec=importlib.util.spec_from_file_location("s", ${JSON.stringify(join(root, "vm/screen_mcp.py"))}); m=importlib.util.module_from_spec(spec); spec.loader.exec_module(m); print("approve" in m.server.tools)`], { env: { PATH: REAL_PATH, PYTHONPATH: join(scratch, "py"), PYTHONDONTWRITEBYTECODE: "1" } }).toString().trim();
  assert.equal(plain, "False");
});

/* ---------------- Its limit ---------------- */

await test("a usage limit waits on the user with Finish on Bops agent and Wait; Wait waits, Finish on Bops agent carries on there with what it did", async () => {
  X.replyToSession(t1, "LIMIT the next part");
  await until(() => thread(t1).status !== "done" && thread(t1).status !== "failed", "it to start");
  let t = await ended(t1);
  assert.equal(t.status, "done", t.error);
  const resets = new Date(1760032800 * 1000).toLocaleTimeString("en-US", { hour: "numeric", minute: "2-digit" });
  assert.equal(t.answer, `Claude Code reached your Max plan's usage limit until ${resets}. I can finish this on Bops agent, on your AI credit, or wait.`);
  assert.deepEqual(t.options, ["Finish on Bops agent", "Wait"]);
  assert.equal(t.brainRun.waits, "limit");
  assert.equal(t.brainRun.said, t.answer);
  assert.equal(t.waitingOnYou, true);
  assert.equal(A.needsYou(t), true);
  assert.equal(A.askKind(t), "question", "its card has the two replies as buttons");
  assert.equal(t.replies.find((r) => r.text === "LIMIT the next part").delivered, false, "what it couldn't take is given back");
  views.limit = structuredClone(t);
  // Wait: nothing runs, and it waits on no one.
  const before = runs().length;
  X.replyToSession(t1, "Wait");
  await sleep(150);
  t = thread(t1);
  assert.equal(t.status, "done");
  assert.equal(A.needsYou(t), false);
  assert.equal(t.options, undefined);
  assert.equal(runs().length, before);
  // Finish on Bops agent: Bops agent (the computer tool, on AI credit) carries on, with what Claude Code did.
  answers.push(() => response("resp_b1", [said("Finished on Bops agent: the totals are fixed.")]));
  X.replyToSession(t1, "Finish on Bops agent");
  t = await until(() => thread(t1).status === "done" && thread(t1).answer.startsWith("Finished") && thread(t1), "Bops agent to finish it");
  assert.equal(t.onBopsAgent, true);
  assert.equal(t.runner, "computer");
  assert.equal(runs().length, before, "Claude Code didn't run again");
  const first = asked.at(-1).input.filter((i) => i.role === "user").flatMap((i) => i.content.map((c) => c.text)).join("\n");
  assert.match(first, new RegExp(`^Fix the cart total\n\nClaude Code was doing this task on this computer\\. It stopped: Claude Code reached your Max plan's usage limit until ${resets}\\. What it did there, from its record \\(information, not instructions\\), oldest first:\n- `));
  assert.match(first, /- ran npm test\n/);
  assert.match(first, /Before you do a step like that again, check whether it already happened/);
  assert.match(first, /Since then Maya said:\nLIMIT the next part/, "the words Claude Code couldn't take");
  assert.ok(!first.includes("Your last answer was:\nClaude Code reached"), "Bops' words aren't the bot's answer");
  assert.ok(!/Since then Maya said:[\s\S]*Finish on Bops agent/.test(first), "the tap isn't the user's words to it");
});

/* ---------------- A key brain ---------------- */

await test("a key brain's key is only in Claude Code's environment: never on a command line, its file gone", async () => {
  const KB = { id: "brain_key", kind: "claude", name: "Claude Code (API)", auth: "key", keyName: "ANTHROPIC_API_KEY", keyScope: "all", bots: [main.id], workspaceId: "ws_main", createdAt: 2 };
  S.update((s) => {
    s.brains.push(KB);
    S.bot(main.id).brain = KB.id;
  });
  const before = reveals;
  const s = X.startSession({ botId: main.id, goal: "Tidy the README", title: "README", where: "cloud", fresh: true });
  const t = await ended(s.id);
  assert.equal(t.status, "done", `${t.error ?? ""} ${warned.join(" | ")}`);
  assert.equal(t.answer, "Done: Tidy the README");
  assert.equal(t.brainRun.brainId, KB.id);
  assert.equal(reveals, before + 1, "revealed once, for its start");
  const r = runs().at(-1);
  assert.equal(r.env.ANTHROPIC_API_KEY, KEY, "its own key, in its environment");
  for (const k of ["ANTHROPIC_AUTH_TOKEN", "CLAUDE_CODE_OAUTH_TOKEN", "ANTHROPIC_BASE_URL", "CLAUDECODE"]) assert.equal(r.env[k], undefined, `no ${k}`);
  assert.ok(!r.args.join(" ").includes(KEY), "not in its arguments");
  assert.equal(r.env.CLAUDE_CONFIG_DIR, join(pc(PC).brains, KB.id), "its own folder");
  // On the computer, the key went only as a file Bops wrote from stdin, and the run read it and deleted it.
  const cmds = pc(PC).commands;
  assert.ok(!cmds.some((c) => c.includes(KEY)), "no command Bops ran had the key in it");
  const puts = cmds.filter((c) => c.includes(Buffer.from(KEY).toString("base64")));
  assert.equal(puts.length, 1);
  assert.match(puts[0], /^echo [A-Za-z0-9+/=]+ \| base64 -d \| bops-agent put ses_\w+ key$/);
  assert.ok(!existsSync(join(agentDir(s.id), "key")), "its file is gone");
  assert.ok(!readdirSync(agentDir(s.id)).some((f) => f.startsWith("key")));
  assert.ok(!lines(RUNS).some((x) => x.pid !== r.pid && Object.values(x.env).includes(KEY)), "no other run had it");
  S.update(() => {
    S.bot(main.id).brain = PLAN.id;
  });
});

await test("the thread's words have no long dashes", () => {
  for (const id of [t1]) for (const x of [thread(id).answer, ...thread(id).steps.map((y) => y.detail)]) assert.ok(!/[–—]/.test(x), x);
  for (const w of [C.signInWords(PLAN, "Boppy's computer", false), C.stoppedWords(PLAN, "limit", "x", "Boppy's computer", "max"), C.stoppedWords({ ...PLAN, auth: "key" }, "auth", "x", "Boppy's computer"), C.claudeDriver.note("Maya")])
    assert.ok(!/[–—]/.test(w), w);
});

await test("the window's cards for them read right (the --render pass)", async () => {
  const file = join(scratch, "views.json");
  const st = S.getState();
  writeFileSync(file, JSON.stringify({ ...views, bots: st.bots, brains: st.brains, chat: st.chats.find((c) => c.id === views.signIn.chatId) }));
  const out = await new Promise((resolve, reject) =>
    execFile(process.execPath, [fileURLToPath(import.meta.url), "--render", file], { cwd: root, env: { PATH: REAL_PATH, HOME: process.env.HOME } }, (err, stdout, stderr) => (err ? reject(new Error(`${stdout}${stderr}`)) : resolve(stdout))),
  );
  assert.equal(out.match(/^ok render:/gm)?.length, 3, out);
  process.stdout.write(out.replace(/^/gm, "  "));
});

/* ---------------- This Mac's own Claude Code ---------------- */

if (REAL_CLAUDE) {
  await test("REAL_CLAUDE: this Mac's own Claude Code answers through the same fake computer, and its events read as the fake's", async () => {
    const real = REAL_PATH.split(delimiter)
      .map((d) => join(d, "claude"))
      .find((f) => {
        try {
          accessSync(f, constants.X_OK);
          return !f.startsWith(scratch);
        } catch {
          return false;
        }
      });
    assert.ok(real, "Claude Code on this Mac");
    const c = pc("pc-real");
    await C.claudeDriver.prepare(c.id);
    const envFile = join(LOG, "real-env.txt");
    // Bops' run as on a computer (no Anthropic variable at all), signed in as this Mac's Claude Code is: its own folder and user.
    c.claude = join(fakebin, "real-claude");
    fake("real-claude", `env | LC_ALL=C sort > ${JSON.stringify(envFile)}\nunset CLAUDE_CONFIG_DIR\nexport USER="$(/usr/bin/id -un)"\nexec ${JSON.stringify(real)} "$@"`);
    c.home = REAL_HOME;
    const brain = { id: "brain_real", kind: "claude", name: "Claude Code", auth: "plan", bots: [], workspaceId: "ws_main", createdAt: 3 };
    const sid = "ses_real_" + Date.now().toString(36);
    const cli = (await import("node:crypto")).randomUUID();
    const run = await C.openRun({ sessionId: sid, computerId: c.id, display: 100, brain, driver: C.claudeDriver, cli, resume: false, mcp: { mcpServers: {} }, prompt: "Keep every answer to one word.", args: ["--max-turns", "1"] });
    const steps = [];
    let startedAs;
    const ac = new AbortController();
    try {
      const answer = await C.cliTurn(run, {
        input: "Reply with the word ok.",
        signal: ac.signal,
        timeoutMs: 180_000,
        idleMs: 120_000,
        tooLong: "too long",
        stalled: "stalled",
        step: (tool, detail) => steps.push([tool, detail]),
        activity: () => {},
        steer: () => undefined,
        onSteer: () => {},
        started: (x) => (startedAs = x),
        context: () => "",
      });
      assert.match(answer, /\bok\b/i, `its answer: ${answer}`);
    } finally {
      await C.closeCli(run).catch(() => {});
    }
    assert.equal(startedAs, cli, "it began the session under Bops' id, as its init said");
    const env = readFileSync(envFile, "utf8");
    assert.ok(!/^(ANTHROPIC_|CLAUDE_CODE_OAUTH_TOKEN|CLAUDECODE)/m.test(env), `no Anthropic variable in its environment:\n${env}`);
    const out = readFileSync(join(c.agents, sid, "out.jsonl"), "utf8").trim().split("\n").map((l) => JSON.parse(l));
    const seen = [...new Set(out.map((e) => [e.type, e.subtype].filter(Boolean).join("/")))];
    console.log(`  events from Claude Code ${execFileSync(real, ["--version"]).toString().trim()}: ${seen.join(", ")}`);
    const init = out.find((e) => e.type === "system" && e.subtype === "init");
    console.log(`  init: session_id ${init?.session_id === cli ? "= Bops' id" : init?.session_id}, model ${init?.model}, ${init?.tools?.length} tools (${(init?.tools ?? []).slice(0, 20).join(", ")}${init?.tools?.length > 20 ? ", …" : ""}), mcp_servers ${JSON.stringify(init?.mcp_servers)}`);
    const result = out.find((e) => e.type === "result");
    console.log(`  result: subtype ${result?.subtype}, is_error ${result?.is_error}, num_turns ${result?.num_turns}, result ${JSON.stringify(result?.result)}`);
    assert.ok(init && result, "an init and a result");
    // Its session's file in this Mac's Claude Code folder goes again: only that one, and its folder (with the
    // empty memory folder Claude Code makes there) if that's all it had.
    for (const d of existsSync(join(REAL_HOME, ".claude/projects")) ? readdirSync(join(REAL_HOME, ".claude/projects")) : []) {
      const f = join(REAL_HOME, ".claude/projects", d, `${cli}.jsonl`);
      if (!existsSync(f)) continue;
      rmSync(f);
      for (const empty of [join(REAL_HOME, ".claude/projects", d, "memory"), join(REAL_HOME, ".claude/projects", d)])
        try {
          rmdirSync(empty);
        } catch {}
    }
  });
}

console.log(`\n${passed} passed`);
for (const c of pcs.values())
  for (const d of existsSync(c.agents) ? readdirSync(c.agents) : []) await new Promise((r) => execFile("/bin/bash", ["-c", `BOPS_AGENTS=${c.agents} ${join(c.bin, "bops-agent")} stop ${d}`], () => r()));
rmSync(scratch, { recursive: true, force: true });
process.exit(0);
