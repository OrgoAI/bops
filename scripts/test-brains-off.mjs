// Tests for a build without brains (lib/types.ts BRAINS_ON off, as every release is: scripts/release.sh): with a
// brain saved in the state and the main bot on it (as a development build left it), nothing about brains shows
// or runs. Settings has no Brain section and its old subtitle, a bot's profile has no Brain card or badge, a
// thread Claude Code ran has no badge and no Open in terminal, a thread waiting on its brain doesn't ask the
// user anything, and a Codex thread's reply box reads as Bops agent's. Every brain route and a thread's terminal
// route answer 404. The bot is on Bops agent (brainOf), no CLI runs (cliDriver), the approve tool turns everything
// down, and its tasks run on Bops agent: a new one, and one Claude Code ran, which carries on from what it did
// (brainRecord) as the bot's own answers, Wait included. Nothing goes on its computer for brains (no Claude Code
// install, no brain scripts, no bops-brain or bops-agent run), and the saved brain stays as it was. A bot's own
// computer, a copy of the main one, is still cleared of its brain folders, and a failure there names no brain.
//
// Orgo, Bops Cloud and OpenAI behind it are fakes on made-up origins; nothing reaches a real service.
// Usage: node scripts/test-brains-off.mjs   (not with --conditions=react-server: the window's code renders here too)
import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, symlinkSync } from "node:fs";
import { registerHooks } from "node:module";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import ts from "typescript";

for (const k of Object.keys(process.env))
  if (/^(BOPS|OPENAI|AGENTPHONE|AGENTMAIL|HONCHO|COMPOSIO|TYPESAFE|TWILIO|ORGO|CODEX|TAILSCALE|TREG|ANTHROPIC|CLAUDE_CODE)_/.test(k) || k === "CLAUDECODE") delete process.env[k];
// A build without brains, as a release is: nothing sets it.
delete process.env.NEXT_PUBLIC_BOPS_BRAINS;
process.env.BOPS_DEVICE_SEED = "test-brains-off";
process.env.BOPS_RESPONSES_WS = "0";
process.env.HOSTNAME = "127.0.0.1";
const root = new URL("..", import.meta.url).pathname.replace(/\/$/, "");
// Modules that would start processes when loaded are stand-ins: each export does nothing.
const STAND_INS = new Set(["relay", "desktop", "mirror"]);
registerHooks({
  resolve(specifier, context, next) {
    // Only the server may import these; here everything is the server, and the window's code too.
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
  load(url, context, next) {
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

const scratch = mkdtempSync(join(tmpdir(), "bops-test-brains-off-"));
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
let failed = 0;
async function check(name, fn) {
  try {
    await fn();
    passed++;
    console.log(`ok   ${name}`);
  } catch (e) {
    failed++;
    console.log(`FAIL ${name}\n     ${String(e?.stack ?? e).split("\n").slice(0, 8).join("\n     ")}`);
  }
}

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
/** Every command a computer was given, by computer. */
const commands = new Map();
/** Computers that can't be cleared of what a copy of the main one brought (sessions.ts ensureComputer). */
const uncleared = new Set();
async function bash(id, command) {
  if (!commands.has(id)) commands.set(id, []);
  commands.get(id).push(command);
  if (uncleared.has(id) && command.includes("rm -rf /root/.bops/brains")) return { output: "", exit_code: 1 };
  if (command.startsWith("md5sum ")) return { output: "", exit_code: 0 };
  if (command.includes("bops-screens list")) return { output: "{}", exit_code: 0 };
  return { output: command.includes("echo ok") ? "ok" : "1", exit_code: 0 };
}
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

const T = await import(`${root}/lib/types.ts`);
const S = await import(`${root}/lib/server/store.ts`);
const X = await import(`${root}/lib/server/sessions.ts`);
const C = await import(`${root}/lib/server/cli-agents.ts`);
const A = await import(`${root}/lib/asks.ts`);

await S.bindSignIn(USER.id, "sk_orgo_test");
S.update((s) => {
  s.account = { user: USER, signedInAt: Date.now() };
  s.host = "orgo";
  s.owner = { name: "Maya" };
});
const main = S.getState().bots.find((b) => b.isMain);
const PC = "pc-main";
// As a development build left it: a plan brain, signed in on the main bot's computer, with the main bot on it.
const PLAN = { id: "brain_plan", kind: "claude", name: "Claude Code", auth: "plan", bots: [main.id], workspaceId: "ws_main", createdAt: 1, signIns: [{ computerId: PC, at: 1, method: "claude.ai", account: { email: "maya@acme.test", plan: "max" } }] };
S.update((s) => {
  Object.assign(S.bot(main.id), { computerId: PC, computerStatus: "ready", effort: "medium", brain: PLAN.id });
  s.brains = [structuredClone(PLAN)];
});
const thread = (id) => S.session(id);
const ended = (id, what = "the thread to end") => until(() => ["done", "failed"].includes(thread(id)?.status) && thread(id), what);
/** Anything a computer was given for brains: Claude Code's install, the brain scripts, a run of one. */
const brainCommands = () => [...commands.values()].flat().filter((c) => /claude-code|\/opt\/bops\/claude|bops-brain|bops-agent/.test(c));
/** A thread Claude Code ran in a build with brains, as it was left: what it did, and (`more`) where it stopped. */
const brainThread = (id, more = {}) => ({
  id,
  botId: main.id,
  chatId: T.botChatId(main.id),
  sentVia: "you",
  title: "Cart total",
  goal: "Fix the cart total",
  host: "orgo",
  runsOn: "cloud",
  status: "done",
  steps: [
    { tool: "command", detail: "ran npm test", at: 2 },
    { tool: "edit", detail: "edited cart.ts", at: 3 },
  ],
  replies: [],
  answer: "Fixed the total.",
  createdAt: 1,
  startedAt: 1,
  endedAt: 4,
  lastDisplay: 101,
  brainRun: { brainId: PLAN.id, kind: "claude", computerId: PC, cli: "0f6c3d2e-1111-4a2b-9c3d-123456789abc", started: true },
  ...more,
});

/* ---------------- The switch, and who a bot's tasks run on ---------------- */

await check("off unless it's set: no brain for a bot set to one, no CLI to run, and the approve tool turns everything down", async () => {
  assert.equal(T.BRAINS_ON, false);
  assert.equal(S.bot(main.id).brain, PLAN.id, "the bot keeps what it picked");
  assert.equal(T.brainOf(S.bot(main.id), S.getState()), undefined, "on Bops agent");
  assert.equal(C.cliDriver("claude"), undefined);
  assert.equal(C.cliDriver("codex"), undefined);
  S.update((s) => s.sessions.push(brainThread("ses_ask", { status: "running", display: 101 })));
  const said = JSON.parse(await C.approveTool(main.id, "ses_ask", { tool: "NotebookEdit", input: { notebook_path: "/workspace/a.ipynb" } }));
  assert.equal(said.behavior, "deny");
  assert.deepEqual(S.getState().appApprovals ?? [], [], "no card");
  S.update((s) => (s.sessions = s.sessions.filter((x) => x.id !== "ses_ask")));
});

await check("a new task for a bot set to a brain runs on Bops agent, on AI credit, and nothing goes on its computer for brains", async () => {
  answers.push(() => response("resp_n1", [said("Bops agent: the totals are fixed.")]));
  const s = X.startSession({ botId: main.id, goal: "Fix the totals", title: "Totals", where: "cloud", fresh: true });
  const t = await ended(s.id);
  assert.equal(t.status, "done", `${t.error ?? ""}; ${warned.join(" | ")}`);
  assert.equal(t.answer, "Bops agent: the totals are fixed.");
  assert.equal(t.runner, "computer", "Bops agent's computer tool");
  assert.ok(t.responseId);
  assert.equal(t.brainRun, undefined, "no brain began it");
  assert.equal(asked.length, 1);
  assert.deepEqual(brainCommands(), [], "no Claude Code install, brain script or run on the computer");
});

await check("a thread Claude Code ran carries on with Bops agent, with what Claude Code did, and its answers are the bot's own", async () => {
  const answer = "Claude Code reached your Max plan's usage limit until 5:00 PM. I can finish this on Bops agent, on your AI credit, or wait.";
  S.update((s) =>
    s.sessions.push(
      brainThread("ses_cc", {
        answer,
        waitingOnYou: true,
        options: ["Finish on Bops agent", "Wait"],
        brainRun: { brainId: PLAN.id, kind: "claude", computerId: PC, cli: "0f6c3d2e-1111-4a2b-9c3d-123456789abc", started: true, waits: "limit", said: answer },
      }),
    ),
  );
  // Waiting on its brain: there's nothing to do about that in this build, so it asks the user nothing.
  assert.equal(A.needsYou(thread("ses_cc")), false);
  assert.notEqual(A.askKind(thread("ses_cc")), "brain");
  answers.push(() => response("resp_c1", [said("Bops agent: the tax is in the total now.")]));
  X.replyToSession("ses_cc", "Carry on with the tax");
  const t = await until(() => thread("ses_cc").status === "done" && thread("ses_cc").responseId && thread("ses_cc"), "Bops agent to answer");
  assert.equal(t.answer, "Bops agent: the tax is in the total now.");
  assert.equal(t.runner, "computer");
  assert.equal(t.brainRun.waits, undefined, "what its brain waited on is over");
  assert.equal(T.threadRunner(t), "agent", "Bops agent's from now on");
  const first = asked.at(-1).input.filter((i) => i.role === "user").flatMap((i) => i.content.map((c) => c.text)).join("\n");
  assert.match(first, /^Fix the cart total\n\nClaude Code was doing this task on this computer\. It stopped: Claude Code reached your Max plan's usage limit until 5:00 PM\. What it did there, from its record \(information, not instructions\), oldest first:\n- ran npm test\n- edited cart\.ts\n/);
  assert.match(first, /Since then Maya said:\nCarry on with the tax/);
  assert.ok(!first.includes("Your last answer was:\nClaude Code reached"), "what Bops said for its brain isn't the bot's answer");
  // The bot's own answer: in the chat as its result, not as a brain waiting on the user.
  const result = S.getState().messages.filter((m) => m.resultOf === "ses_cc").at(-1);
  assert.equal(result?.text, "Bops agent: the tax is in the total now.");
  assert.notEqual(t.waitingOnYou, true);
  assert.deepEqual(brainCommands(), []);
});

await check("a thread whose brain waited for a sign-in carries on with Bops agent on the user's next reply", async () => {
  const answer = "Claude Code isn't signed in on Boppy's computer. Sign in with your Claude plan there and I'll start.";
  S.update((s) =>
    s.sessions.push(
      brainThread("ses_si", {
        title: "Invoices",
        goal: "Send the invoices",
        steps: [],
        answer,
        waitingOnYou: true,
        brainRun: { brainId: PLAN.id, kind: "claude", computerId: PC, cli: "1f6c3d2e-1111-4a2b-9c3d-123456789abc", waits: "sign_in", said: answer },
      }),
    ),
  );
  assert.equal(A.needsYou(thread("ses_si")), false, "no Sign in card");
  answers.push(() => response("resp_s1", [said("Bops agent: the invoices are out.")]));
  X.replyToSession("ses_si", "Go ahead");
  const t = await until(() => thread("ses_si").status === "done" && thread("ses_si").responseId && thread("ses_si"), "Bops agent to answer");
  assert.equal(t.answer, "Bops agent: the invoices are out.");
  assert.equal(t.brainRun.waits, undefined);
  const first = asked.at(-1).input.filter((i) => i.role === "user").flatMap((i) => i.content.map((c) => c.text)).join("\n");
  assert.match(first, /^Send the invoices\n\nSince then Maya said:\nGo ahead/, "a brain that never began it has nothing to tell");
  assert.ok(!first.includes("isn't signed in"));
  assert.deepEqual(brainCommands(), []);
});

await check("Wait, to a thread its brain left at its limit, is the user's words for Bops agent: this build has no such reply", async () => {
  const answer = "Claude Code reached your Max plan's usage limit until 5:00 PM. I can finish this on Bops agent, on your AI credit, or wait.";
  S.update((s) =>
    s.sessions.push(
      brainThread("ses_lw", {
        title: "Refunds",
        goal: "Process the refunds",
        answer,
        waitingOnYou: true,
        options: ["Finish on Bops agent", "Wait"],
        brainRun: { brainId: PLAN.id, kind: "claude", computerId: PC, cli: "3f6c3d2e-1111-4a2b-9c3d-123456789abc", started: true, waits: "limit", said: answer },
      }),
    ),
  );
  answers.push(() => response("resp_w1", [said("Bops agent: the refunds are done.")]));
  try {
    X.replyToSession("ses_lw", "Wait");
    const t = await until(() => thread("ses_lw").status === "done" && thread("ses_lw").responseId && thread("ses_lw"), "Bops agent to answer");
    assert.equal(t.answer, "Bops agent: the refunds are done.");
    assert.equal(t.brainRun.waits, undefined);
    const first = asked.at(-1).input.filter((i) => i.role === "user").flatMap((i) => i.content.map((c) => c.text)).join("\n");
    assert.match(first, /Since then Maya said:\nWait/);
    assert.deepEqual(brainCommands(), []);
  } finally {
    answers.length = 0;
  }
});

/* ---------------- The routes ---------------- */

await check("every brain route, and a thread's terminal, answers 404", async () => {
  const req = (url, method, body) => new Request(`http://localhost:3210${url}`, { method, headers: { "content-type": "application/json" }, ...(body === undefined ? {} : { body: JSON.stringify(body) }) });
  const routes = {
    brains: await import(`${root}/app/api/brains/route.ts`),
    bot: await import(`${root}/app/api/brains/bot/route.ts`),
    signIn: await import(`${root}/app/api/brains/sign-in/route.ts`),
    signOut: await import(`${root}/app/api/brains/sign-out/route.ts`),
    terminal: await import(pathToFileURL(`${root}/app/api/sessions/[sessionId]/terminal/route.ts`).href),
  };
  S.update((s) => s.sessions.push(brainThread("ses_term")));
  const calls = [
    ["GET /api/brains", () => routes.brains.GET(req("/api/brains", "GET"))],
    ["POST /api/brains", () => routes.brains.POST(req("/api/brains", "POST", { kind: "claude", auth: "plan", bots: [main.id], use: true }))],
    ["PATCH /api/brains", () => routes.brains.PATCH(req("/api/brains", "PATCH", { id: PLAN.id, name: "Renamed" }))],
    ["DELETE /api/brains", () => routes.brains.DELETE(req("/api/brains", "DELETE", { id: PLAN.id }))],
    ["POST /api/brains/bot", () => routes.bot.POST(req("/api/brains/bot", "POST", { botId: main.id, brainId: null }))],
    ["GET /api/brains/sign-in", () => routes.signIn.GET(req(`/api/brains/sign-in?brain=${PLAN.id}&bot=${main.id}`, "GET"))],
    ["POST /api/brains/sign-in", () => routes.signIn.POST(req("/api/brains/sign-in", "POST", { brainId: PLAN.id, botId: main.id }))],
    ["DELETE /api/brains/sign-in", () => routes.signIn.DELETE(req("/api/brains/sign-in", "DELETE", { brainId: PLAN.id }))],
    ["POST /api/brains/sign-out", () => routes.signOut.POST(req("/api/brains/sign-out", "POST", { brainId: PLAN.id, botId: main.id }))],
    ["POST /api/sessions/ses_term/terminal", () => routes.terminal.POST(req("/api/sessions/ses_term/terminal", "POST", {}), { params: Promise.resolve({ sessionId: "ses_term" }) })],
  ];
  for (const [what, call] of calls) {
    const res = await call();
    assert.equal(res.status, 404, what);
    assert.equal((await res.json()).error, "This version of Bops has no brains.", what);
  }
  assert.equal(S.getState().takeover, undefined, "no terminal opened");
  // The saved brain stays as it was, the bot still on it, for a build with brains.
  assert.deepEqual(S.getState().brains, [PLAN]);
  assert.equal(S.bot(main.id).brain, PLAN.id);
  assert.deepEqual(brainCommands(), []);
  S.update((s) => (s.sessions = s.sessions.filter((x) => x.id !== "ses_term")));
});

await check("a release builds without brains, whatever a .env file says", () => {
  assert.match(readFileSync(join(root, "scripts/release.sh"), "utf8"), /^NEXT_PUBLIC_BOPS_BRAINS=0 npx next build$/m);
});

/* ---------------- A copy of the main computer ---------------- */

await check("a bot's own computer is still cleared of the main computer's brain folders, and says it couldn't be without naming them", async () => {
  // Made from the main computer, where a development build may have left a Claude Code sign-in.
  S.update((s) => {
    s.bots.push({ id: "nova", name: "Nova", role: "Research", color: "#2EC4B6", isMain: false, computer: "own", computerId: "pc-nova", computerNeverReady: "pc-nova", computerStatus: "none" });
    s.chats.push({ id: T.botChatId("nova"), kind: "bot", botIds: ["nova"], createdAt: 1, typing: [] });
  });
  uncleared.add("pc-nova");
  try {
    await X.ensureComputer("nova");
    assert.ok((commands.get("pc-nova") ?? []).some((c) => c.includes("rm -rf /root/.bops/brains /root/.bops/agents")), "cleared as in a build with brains");
    assert.equal(S.bot("nova").computerStatus, "error", "not set up");
    const note = S.getState().messages.filter((m) => m.chatId === T.botChatId("nova")).at(-1)?.text ?? "";
    assert.equal(note, "I couldn't set up my computer (the copy of the main computer couldn't be cleaned up (no answer)). I'll try again on my next task.");
    assert.doesNotMatch(note, /Claude|Codex|brain/i);
  } finally {
    S.update((s) => {
      s.bots = s.bots.filter((b) => b.id !== "nova");
      s.chats = s.chats.filter((c) => c.id !== T.botChatId("nova"));
    });
  }
});

/* ---------------- The window ---------------- */

globalThis.window = globalThis;
globalThis.addEventListener = () => {};
globalThis.removeEventListener = () => {};
globalThis.document = { hidden: false, addEventListener() {}, removeEventListener() {}, getElementById: () => null };
globalThis.localStorage = { getItem: () => null, setItem() {}, removeItem() {} };
globalThis.matchMedia = () => ({ matches: false });
const { renderToStaticMarkup } = await import("react-dom/server");
const { createElement: h } = await import("react");
const text = (html) => html.replace(/<[^>]+>/g, " ").replace(/&#x27;/g, "'").replace(/&amp;/g, "&").replace(/\s+/g, " ").trim();
const noop = () => {};
const view = (sessions = [], more = {}) => ({ ...structuredClone(S.getState()), sessions, messages: [], ...more });
/** Anything that's about brains. */
const BRAINY = /\bBrain\b|their brain|Claude Code|Bops agent|Codex|Open in terminal|Sign in with your Claude plan/;

await check("Settings has no Brain section, and its subtitle doesn't mention one", async () => {
  const { Settings } = await import(pathToFileURL(`${root}/components/app/bops-app.tsx`).href);
  const t = text(renderToStaticMarkup(h(Settings, { state: view(), onClose: noop, onShowScreen: noop, onOpenVault: noop })));
  assert.match(t, /^Settings You, how your bots reach you, this Mac, and where your bots work /, t.slice(0, 200));
  assert.match(t, /Where your bots work .* Your bots' computers/, "the sections around where Brain was");
  assert.doesNotMatch(t, BRAINY);
});

await check("a bot's profile has no Brain and no badge for the brain it was set to", async () => {
  const { BotPanel } = await import(pathToFileURL(`${root}/components/app/bot-panel.tsx`).href);
  const st = view();
  const b = st.bots.find((x) => x.id === main.id);
  for (const section of ["details", "skills"]) {
    const t = text(
      renderToStaticMarkup(
        h(BotPanel, { state: st, bot: b, section, onSection: noop, onOpenChat: noop, onOpenThread: noop, onOpenVault: noop, onOpenComputer: noop, onOpenKeys: noop, onShowScreen: noop, onOpenAutopilot: noop, onOpenSkills: noop, onAsk: noop, onUpgrade: noop, onClose: noop }),
      ),
    );
    assert.match(t, new RegExp(`${b.name} Chief of Staff · runs the team`), section);
    assert.doesNotMatch(t, BRAINY, section);
  }
});

await check("a thread Claude Code ran has no badge and no Open in terminal, one waiting on its brain no Sign in, and a Codex thread's reply box reads as Bops agent's", async () => {
  const { ThreadSheet, ChatView } = await import(pathToFileURL(`${root}/components/app/chat-view.tsx`).href);
  const sheetHtml = (s, more) => renderToStaticMarkup(h(ThreadSheet, { state: view([s], more), session: s, onClose: noop, onShowComputer: noop, onShowScreen: noop }));
  const done = text(sheetHtml(brainThread("ses_a")));
  assert.match(done, new RegExp(`^Cart total ${main.name} · finished · 2 steps · left off on screen \\d `), done);
  assert.doesNotMatch(done, BRAINY);
  // Bops agent took it over: no "Bops agent" badge either.
  assert.doesNotMatch(text(sheetHtml(brainThread("ses_a", { responseId: "resp_1" }))), BRAINY);
  const waiting = brainThread("ses_w", {
    answer: "Waiting.",
    waitingOnYou: true,
    brainRun: { brainId: PLAN.id, kind: "claude", computerId: PC, cli: "2f6c3d2e-1111-4a2b-9c3d-123456789abc", waits: "sign_in", said: "Waiting." },
  });
  const w = text(sheetHtml(waiting));
  assert.doesNotMatch(w, /needs Claude Code signed in|Sign in/, w);
  const codexHtml = sheetHtml(brainThread("ses_c", { status: "running", display: 101, brainRun: { brainId: "brain_codex", kind: "codex", computerId: PC, cli: "019a0000-1111-7a2b-9c3d-123456789abc", started: true } }));
  assert.match(codexHtml, /Reply in thread · it sees this as it works/);
  assert.doesNotMatch(text(codexHtml), BRAINY);
  // Its chip in the chat: no badge, and no card pinned over the composer for the one waiting on its brain.
  const s = brainThread("ses_a");
  const chat = { id: T.botChatId(main.id), kind: "bot", botIds: [main.id], createdAt: 1, typing: [] };
  const msg = { id: "msg_1", chatId: chat.id, role: "bot", botId: main.id, text: "Fixed the total.", at: 4, sessionIds: [s.id], resultOf: s.id };
  const html = renderToStaticMarkup(h(ChatView, { state: view([s, waiting], { messages: [msg], chats: [chat] }), chat, wide: false, onOpenThread: noop, onShowBot: noop, onShowMac: noop, onShowScreen: noop, call: null, onCall: noop, callSlot: noop }));
  const chip = text(html);
  assert.match(chip, /Cart total/, chip);
  assert.doesNotMatch(chip, BRAINY);
  assert.doesNotMatch(chip, /is waiting on you|needs .* signed in/);
});

console.log(`\nbrains off: ${passed} passed, ${failed} failed`);
if (!failed) rmSync(scratch, { recursive: true, force: true });
else console.log(`The throwaway folder is kept for a look: ${scratch}`);
process.exit(failed ? 1 : 0);
