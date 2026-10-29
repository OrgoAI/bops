// Tests for a bot's AI profile and the agent each of its threads runs on (lib/agents.ts, lib/server/bot-ai.ts,
// POST /api/bots/ai, cli-agents.ts's flags, stops and OpenCode driver, components/app/bot-ai.tsx and
// new-thread.tsx): a bot's brains move over on load as its agents (the one it used its Default), a profile keeps
// only what Bops can run, and changing it stops what ran on an agent that went and clears its folder on the
// computer. A thread runs on the agent it was given, read again from its bot's profile at every start, so a
// thread can't move onto an agent or account its bot doesn't have. A bot with no profile is exactly as before.
// The window's AI section, New thread sheet and chips render every state in plain words.
//
// Orgo is a fake that records the commands it's given; nothing reaches a real service or CLI. A build without
// brains (a release) is checked by a child of this test (--off).
//
// Usage: node scripts/test-bot-ai.mjs   (not with --conditions=react-server: the window's code renders here too)
import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { registerHooks } from "node:module";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import ts from "typescript";

const OFF = process.argv.includes("--off");
for (const k of Object.keys(process.env)) if (/^(BOPS|OPENAI|ORGO|CODEX|ANTHROPIC|CLAUDE_CODE)_/.test(k)) delete process.env[k];
process.env.NEXT_PUBLIC_BOPS_BRAINS = OFF ? "0" : "1";
process.env.BOPS_SELF_HOSTED = "1";
process.env.BOPS_ORGO_ORIGIN = "https://orgo.test";
const UI = "ui-token-test-bot-ai";
process.env.BOPS_UI_TOKEN = UI;
const root = fileURLToPath(new URL("..", import.meta.url)).replace(/\/$/, "");
const scratch = mkdtempSync(join(tmpdir(), "bops-test-bot-ai-"));
process.env.HOME = join(scratch, "home");
mkdirSync(process.env.HOME);
globalThis.bopsOrgoKey = "sk_orgo_test_bot_ai";
const work = join(scratch, "work");
mkdirSync(join(work, ".data"), { recursive: true });
symlinkSync(join(root, "vm"), join(work, "vm"));
process.chdir(work);

/* ---------------- The saved state, from before profiles ---------------- */

// Boppy uses Claude Code on a Claude plan and may use Codex on a key; Rook may use the plan; Pip has nothing;
// Kai is in another workspace, whose Claude plan Rook was on before it moved (so that one stays behind).
const now = Date.now();
writeFileSync(
  join(work, ".data", "state.json"),
  JSON.stringify({
    host: "orgo",
    owner: { name: "Maya" },
    workspaces: [
      { id: "ws_main", name: "Main", createdAt: 1 },
      { id: "ws_two", name: "Two", createdAt: 2 },
    ],
    workspace: "ws_main",
    bots: [
      { id: "boppy", name: "Boppy", role: "Chief of staff", color: "#E9FF3B", isMain: true, computerStatus: "ready", computerId: "pc-main", brain: "brain_plan", workspaceId: "ws_main" },
      { id: "rook", name: "Rook", role: "Recruiting", color: "#47C46B", isMain: false, computerStatus: "ready", computer: "own", computerId: "pc-rook", workspaceId: "ws_main" },
      { id: "pip", name: "Pip", role: "Research", color: "#5B8CFF", isMain: false, computerStatus: "ready", computer: "own", computerId: "pc-pip", workspaceId: "ws_main" },
      { id: "kai", name: "Kai", role: "Ops", color: "#EB5757", isMain: true, computerStatus: "none", workspaceId: "ws_two" },
    ],
    brains: [
      { id: "brain_plan", kind: "claude", name: "Claude Code", auth: "plan", bots: ["boppy", "rook"], workspaceId: "ws_main", createdAt: 1, signIns: [{ computerId: "pc-main", at: now, account: { plan: "max" } }] },
      { id: "brain_codex", kind: "codex", name: "Codex", auth: "key", keyName: "OPENAI_API_KEY", keyScope: "all", bots: ["boppy"], workspaceId: "ws_main", createdAt: 2 },
      { id: "brain_two", kind: "claude", name: "Claude Code", auth: "plan", bots: ["rook", "kai"], workspaceId: "ws_two", createdAt: 3 },
    ],
    chats: [],
    messages: [],
    sessions: [],
    routines: [],
  }),
);

/* ---------------- Loading the app's modules ---------------- */

const fileUrl = (p) => pathToFileURL(`${root}/${p}`).href;
// sessions.ts is a stand in: what setBotAi asks of it is recorded.
const SESSIONS_OWN = `
const calls = (globalThis.__sessionCalls ??= []);
export function agentsChanged(only) { calls.push(["agentsChanged"]); return globalThis.__left ?? []; }
export function returnControl() { calls.push(["returnControl"]); }
export function brainLeft(brainId) { calls.push(["brainLeft", brainId]); return []; }
`;
const OWN = new Set(["agentsChanged", "returnControl", "brainLeft"]);
const STAND_INS = new Set(["mac", "relay", "desktop", "mirror"]);
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
  load(url, context, next) {
    if (url.endsWith(".css")) return { format: "module", source: "export default {};", shortCircuit: true };
    const name = url.match(/\/lib\/server\/([a-z-]+)\.ts$/)?.[1];
    if (name && (STAND_INS.has(name) || name === "sessions")) {
      const names = [...readFileSync(new URL(url), "utf8").matchAll(/^export (?:async )?(?:function\*? |const |let |class )([A-Za-z_$][\w$]*)/gm)].map((m) => m[1]);
      const rest = names.filter((n) => name !== "sessions" || !OWN.has(n)).map((n) => `export const ${n} = function () { return Promise.resolve(); };`);
      return { format: "module", shortCircuit: true, source: [...rest, name === "sessions" ? SESSIONS_OWN : ""].join("\n") };
    }
    if (!url.endsWith(".tsx")) return next(url, context);
    const source = readFileSync(fileURLToPath(url), "utf8");
    const out = ts.transpileModule(source, { compilerOptions: { jsx: ts.JsxEmit.ReactJSX, module: ts.ModuleKind.ESNext, target: ts.ScriptTarget.ES2022, verbatimModuleSyntax: false }, fileName: url });
    return { format: "module", source: out.outputText, shortCircuit: true };
  },
});
const logged = [];
for (const k of ["info", "warn", "error", "debug"]) console[k] = (...a) => void logged.push(a.map(String).join(" "));

/** What the fake computers were told to run, by computer. */
const commands = [];
const json = (status, obj) => new Response(JSON.stringify(obj), { status, headers: { "content-type": "application/json" } });
globalThis.fetch = async (input, init = {}) => {
  const req = new Request(input, init);
  const url = new URL(req.url);
  if (url.origin !== "https://orgo.test") throw new TypeError(`fetch failed (the test is offline: ${url.host})`);
  const body = req.body ? JSON.parse(await req.text()) : undefined;
  const m = /^\/api\/computers\/([^/]+)\/bash$/.exec(url.pathname);
  if (m) {
    commands.push({ computer: m[1], command: body.command });
    return json(200, { output: body.command.startsWith("md5sum") ? "" : "ok\ncleared\n", exit_code: 0 });
  }
  return json(404, { error: "Not found" });
};
globalThis.window = globalThis;
globalThis.addEventListener = () => {};
globalThis.removeEventListener = () => {};
globalThis.document = { hidden: false, addEventListener() {}, removeEventListener() {}, getElementById: () => null };
globalThis.localStorage = { getItem: () => null, setItem() {}, removeItem() {} };
globalThis.matchMedia = () => ({ matches: false });

const A = await import(fileUrl("lib/agents.ts"));
const S = await import(fileUrl("lib/server/store.ts"));
const BA = await import(fileUrl("lib/server/bot-ai.ts"));
const R = await import(fileUrl("app/api/bots/ai/route.ts"));
const { BotAiSection, AgentTile, stateWords } = await import(fileUrl("components/app/bot-ai.tsx"));
const { NewThread, AgentChipPick, boxAgents } = await import(fileUrl("components/app/new-thread.tsx"));
const { AgentChip } = await import(fileUrl("components/app/agent-marks.tsx"));
const { renderToStaticMarkup } = await import("react-dom/server");
const { createElement: h } = await import("react");
const text = (html) => html.replace(/<[^>]+>/g, " ").replace(/&#x27;/g, "'").replace(/&amp;/g, "&").replace(/\s+/g, " ").trim();
const render = (el) => text(renderToStaticMarkup(el));
/** Words for the user: plain, no dash of any kind (long, short, or a hyphen joining words), never "Orbit". */
const plain = (t, where) => assert.ok(!/[–—]| - |[A-Za-z]-[A-Za-z]|\bOrbit\b/.test(t), `${where}: ${t.match(/.{0,40}([–—]| - |[A-Za-z]-[A-Za-z]|Orbit).{0,40}/)?.[0]}`);
const fromWindow = (body) => new Request("http://localhost:3210/api/bots/ai", { method: "POST", headers: { "content-type": "application/json", cookie: `bops_window=${UI}` }, body: JSON.stringify(body) });
const fromPage = (body) => new Request("http://localhost:3210/api/bots/ai", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(body) });

let passed = 0;
const test = async (name, fn) => {
  await fn();
  passed++;
  console.log(`ok ${name}`);
};
const bot = (id) => S.bot(id);

/* ---------------- A build without brains (the --off child) ---------------- */

if (OFF) {
  await test("without brains: Bops agent only, CLI agents kept in the state but never shown or run", async () => {
    const b = bot("boppy");
    assert.ok(b.ai.agents.some((x) => x.kind === "claude"), "kept in the state for a build that has them");
    assert.deepEqual(A.aiOf(b, S.getState()), { agents: [{ id: "bops", kind: "bops", pays: "credit" }], default: "bops" });
    const s = { id: "s1", botId: "boppy", agent: { id: b.ai.default, kind: "claude" }, brainRun: { brainId: "brain_plan", kind: "claude", computerId: "pc-main", cli: "x", started: true } };
    assert.equal(A.threadAgent(s, b, S.getState()).kind, "bops", "a thread a CLI agent ran carries on on Bops agent");
    const off = await R.POST(fromWindow({ botId: "boppy", op: "add", kind: "codex", pays: "key" }));
    assert.equal(off.status, 404);
    const model = await R.POST(fromWindow({ botId: "pip", op: "update", agentId: "bops", model: "gpt-6-astra" }));
    assert.equal(model.status, 200, "Bops agent's model is still the owner's to pick");
    const section = render(h(BotAiSection, { state: S.getState(), bot: bot("boppy") }));
    assert.match(section, /^▾ AI Default Bops agent Agents it can run Bops agent Default OpenAI · Bops credit Thinking/, section);
    assert.ok(!/New thread/.test(section), "no New thread choice where there's only Bops agent");
    assert.ok(!/Claude Code|Codex|OpenCode|agy|\+ Add|Open its terminal/.test(section), section);
    assert.match(section, /Chat, threads, memory and calls run on Bops AI credit\./);
  });
  rmSync(scratch, { recursive: true, force: true });
  process.stdout.write(`brains off: ${passed} passed\n`);
  process.exit(0);
}

/* ---------------- Moving over, and what a profile may hold ---------------- */

const planAgent = A.agentIdFor("boppy", "brain_plan");
const codexAgent = A.agentIdFor("boppy", "brain_codex");

await test("brains move over on load: the brains a bot may use become its agents, the one it used its Default", () => {
  assert.deepEqual(bot("boppy").ai, {
    agents: [
      { id: "bops", kind: "bops", pays: "credit" },
      { id: planAgent, kind: "claude", pays: "plan", account: "brain_plan" },
      { id: codexAgent, kind: "codex", pays: "key", account: "brain_codex" },
    ],
    default: planAgent,
  });
  // Rook may use the plan, so it has it, but it used none: Bops agent stays its Default. Its account from the
  // other workspace stays behind.
  assert.deepEqual(bot("rook").ai, { agents: [{ id: "bops", kind: "bops", pays: "credit" }, { id: A.agentIdFor("rook", "brain_plan"), kind: "claude", pays: "plan", account: "brain_plan" }], default: "bops" });
  assert.equal(bot("pip").ai, undefined, "a bot on no brain: no profile, today's Bops agent");
  assert.equal(bot("kai").ai.agents[1].account, "brain_two");
  // For older Bops: the Default's account as Bot.brain, each brain's bots those with an agent on it.
  assert.equal(bot("boppy").brain, "brain_plan");
  assert.equal(bot("rook").brain, undefined);
  const brains = Object.fromEntries(S.getState().brains.map((x) => [x.id, x.bots]));
  assert.deepEqual(brains, { brain_plan: ["boppy", "rook"], brain_codex: ["boppy"], brain_two: ["kai"] });
  // The same ids on every Mac, and doing it again changes nothing.
  assert.match(planAgent, /^ag_[A-Za-z0-9]{10}$/);
  assert.equal(A.agentIdFor("boppy", "brain_plan"), planAgent);
  assert.notEqual(planAgent, codexAgent);
  const again = A.cleanAi(bot("boppy").ai, S.getState().brains, "ws_main");
  assert.deepEqual(again, bot("boppy").ai);
});

await test("a profile keeps only what Bops can run: Bops agent first, each agent once, a real account of its kind here, at most six", () => {
  const brains = S.getState().brains;
  const ai = A.cleanAi(
    {
      agents: [
        { id: "ag_codex00001", kind: "codex", pays: "plan", account: "brain_codex" },
        { id: "ag_agy0000001", kind: "agy", pays: "key" },
        { id: "ag_claude0001", kind: "claude", pays: "credit" },
        { id: "ag_wrongacct1", kind: "claude", pays: "plan", account: "brain_codex" },
        { id: "ag_otherws001", kind: "claude", pays: "plan", account: "brain_two" },
        { id: "ag_plan000001", kind: "claude", pays: "plan", account: "brain_plan", model: "claude-sonnet-5-5" },
        { id: "ag_plan000002", kind: "claude", pays: "plan", account: "brain_plan" },
        { id: "ag_badmodel01", kind: "codex", pays: "key", account: "brain_codex", model: "gpt-1" },
        { id: "ag_oc00000001", kind: "opencode", pays: "key", model: "deepinfra/some-model" },
        { id: "ag_oc00000002", kind: "opencode", pays: "key", model: "evil.example/x" },
        { id: "nope", kind: "opencode", pays: "key" },
        { id: "bops", kind: "bops", pays: "credit", model: "gpt-6-astra" },
      ],
      default: "ag_agy0000001",
    },
    brains,
    "ws_main",
  );
  assert.deepEqual(ai, {
    agents: [
      { id: "bops", kind: "bops", pays: "credit", model: "gpt-6-astra" },
      { id: "ag_plan000001", kind: "claude", pays: "plan", account: "brain_plan", model: "claude-sonnet-5-5" },
      { id: "ag_badmodel01", kind: "codex", pays: "key", account: "brain_codex" },
      { id: "ag_oc00000001", kind: "opencode", pays: "key", model: "deepinfra/some-model" },
      { id: "ag_oc00000002", kind: "opencode", pays: "key" },
    ],
    default: "bops",
  });
  assert.equal(A.cleanAi({ agents: [{ id: "bops", kind: "bops", pays: "credit" }], default: "bops" }), undefined, "the default is never stored");
  assert.equal(A.cleanAi({ agents: [{ id: "bops", kind: "bops", pays: "credit", model: "auto" }], default: "bops" }), undefined, "Auto is the default");
  const many = Array.from({ length: 9 }, (_, i) => ({ id: `ag_oc0000000${i}`, kind: "opencode", pays: "key" }));
  assert.equal(A.cleanAi({ agents: many, default: "bops" }).agents.length, A.MAX_AGENTS);
});

/* ---------------- Changing it ---------------- */

const sessionCalls = (globalThis.__sessionCalls ??= []);

await test("adding agents: an account of the workspace's is reused, another made when asked, and each lands on the profile", () => {
  const ai = BA.setBotAi("pip", { op: "add", kind: "claude", pays: "plan", model: "claude-opus-5-5" });
  const claude = ai.agents.find((x) => x.kind === "claude");
  assert.equal(claude.account, "brain_plan", "the workspace's Claude plan, one sign in per computer");
  assert.equal(claude.model, "claude-opus-5-5");
  assert.equal(ai.default, "bops", "a new agent isn't the Default by itself");
  BA.setBotAi("pip", { op: "add", kind: "codex", pays: "key" });
  BA.setBotAi("pip", { op: "add", kind: "opencode", pays: "key", model: "anthropic/claude-sonnet-5-5" });
  const second = BA.setBotAi("pip", { op: "add", kind: "claude", pays: "plan", newAccount: true });
  const plans = second.agents.filter((x) => x.kind === "claude");
  assert.equal(plans.length, 2);
  assert.notEqual(plans[0].account, plans[1].account, "Use another account: a second Claude plan");
  assert.equal(S.getState().brains.find((x) => x.id === plans[1].account).name, "Claude Code 2");
  assert.deepEqual(S.getState().brains.find((x) => x.id === "brain_plan").bots.sort(), ["boppy", "pip", "rook"], "mirrored for older Bops");
});

await test("one account is one agent of the bot's: the editor never offers the other one's, and the server turns it down", () => {
  const [first, second] = bot("pip").ai.agents.filter((x) => x.kind === "claude");
  const before = JSON.stringify(bot("pip").ai);
  assert.throws(() => BA.setBotAi("pip", { op: "update", agentId: second.id, account: first.account }), /Pip's other Claude Code uses that account\. Pick another, or remove that one first\./);
  assert.equal(JSON.stringify(bot("pip").ai), before, "nothing changed, nothing dropped");
  const ed = renderToStaticMarkup(h(BotAiSection, { state: S.getState(), bot: bot("pip"), editing: second.id }));
  assert.match(ed, new RegExp(`<option value="${first.account}" disabled="">Claude Code · Pip&#x27;s other Claude Code uses it</option>`), ed);
  assert.match(text(ed), /Move to another account/);
  assert.ok(!/Use another account/.test(text(ed)));
  // Two of one kind, told apart everywhere: on their tiles, in the chip's menu and in chat.
  const st = S.getState();
  const at = { bot: bot("pip"), state: st };
  assert.deepEqual([A.agentLabel(first, at), A.agentLabel(second, at)], ["Claude Code · Max plan · Opus 5.5", "Claude Code · Claude plan · Opus 5.5"]);
  assert.match(text(renderToStaticMarkup(h(AgentTile, { agent: second, bot: bot("pip"), state: st, isDefault: false }))), /^Claude Code · Claude plan /);
  // Both on the same kind of plan: a number tells them apart.
  const same = { ...st, brains: st.brains.map((x) => (x.id === second.account || x.id === first.account ? { ...x, signIns: [{ computerId: "pc-pip", at: now }] } : x)) };
  const sameAt = { bot: bot("pip"), state: same };
  assert.deepEqual([A.agentLabel(first, sameAt), A.agentLabel(second, sameAt)], ["Claude Code · Claude plan · Opus 5.5", "Claude Code · Claude plan 2 · Opus 5.5"]);
  assert.equal(A.agentNamed(bot("pip"), same, "Claude Code · Claude plan 2")?.id, second.id);
  assert.equal(A.agentNamed(bot("pip"), same, "Claude Code · Claude plan 2 · Opus 5.5")?.id, second.id);
  // One of its kind needs nothing more than its name.
  assert.equal(A.agentLabel(bot("boppy").ai.agents.find((x) => x.id === codexAgent), { bot: bot("boppy"), state: st }), "Codex · GPT 6.1 Sol");
});

await test("what isn't in Bops yet answers Soon, with why; a bad model, a seventh agent, or Bops agent's removal are turned down", () => {
  const err = (op) => {
    try {
      BA.setBotAi("pip", op);
    } catch (e) {
      return `${e.status} ${e.message}`;
    }
    return "ok";
  };
  assert.match(err({ op: "add", kind: "agy", pays: "key" }), /^400 Soon: agy signs in with a Google account/);
  assert.match(err({ op: "add", kind: "codex", pays: "plan" }), /^400 Soon: A ChatGPT plan for Codex needs a check of OpenAI's terms first\./);
  assert.match(err({ op: "add", kind: "claude", pays: "credit" }), /^400 Soon: Bops credit for Claude Code needs Bops Cloud to carry it first\./);
  assert.match(err({ op: "add", kind: "opencode", pays: "key", model: "evil.example/x" }), /^400 OpenCode can't use that model\./);
  assert.match(err({ op: "add", kind: "bops", pays: "credit" }), /^400 Bops agent is always there/);
  assert.match(err({ op: "remove", agentId: "bops" }), /^400 Bops agent is always there: it is chat's agent/);
  assert.match(err({ op: "update", agentId: "bops", pays: "key" }), /^400 Soon:|^400 Bops agent/);
  BA.setBotAi("pip", { op: "add", kind: "opencode", pays: "key", model: "openai/gpt-6.1-sol" });
  assert.match(err({ op: "add", kind: "opencode", pays: "key" }), /^400 A bot runs at most 6 agents\./);
  assert.match(err({ op: "update", agentId: bot("pip").ai.agents.find((x) => x.kind === "claude").id, account: "brain_two" }), /^400 That account isn't one this agent can use\./, "another workspace's account");
  S.update((s) => void (s.shared = { ownerName: "Maya" }));
  assert.match(err({ op: "default", agentId: "bops" }), /^403 Only Maya changes Pip's AI\./);
  S.update((s) => void delete s.shared);
});

await test("the Default and a model change new threads only; an agent removed or moved stops what runs on it and clears its folder on the computer", async () => {
  const pip = () => bot("pip");
  const claude = pip().ai.agents.find((x) => x.kind === "claude");
  sessionCalls.length = 0;
  commands.length = 0;
  BA.setBotAi("pip", { op: "default", agentId: claude.id });
  BA.setBotAi("pip", { op: "update", agentId: claude.id, model: "claude-haiku-5-5" });
  await new Promise((r) => setTimeout(r, 50));
  assert.deepEqual(sessionCalls, [], "nothing stopped");
  assert.equal(pip().brain, "brain_plan", "the Default's account, for older Bops");
  // A thread open in a terminal on that agent (so not running, not among those stopped) has its terminal closed.
  S.update((s) => {
    s.sessions.push({ id: "s_term", botId: "pip", chatId: "bot_pip", sentVia: "you", title: "In its terminal", goal: "x", host: "orgo", status: "failed", error: "Paused while it's open in the terminal", steps: [], replies: [], createdAt: Date.now(), agent: { id: claude.id, kind: "claude" }, brainRun: { brainId: "brain_plan", agentId: claude.id, kind: "claude", computerId: "pc-pip", cli: "x", started: true } });
    s.takeover = { botId: "pip", sessionId: "s_term", display: 2, since: Date.now(), terminal: { paused: true } };
  });
  // Its way to pay: the model and account start over, and what ran on the plan stops.
  BA.setBotAi("pip", { op: "update", agentId: claude.id, pays: "key" });
  const now = pip().ai.agents.find((x) => x.id === claude.id);
  assert.equal(now.pays, "key");
  assert.equal(now.model, undefined);
  assert.notEqual(now.account, "brain_plan");
  const codex = pip().ai.agents.find((x) => x.kind === "codex");
  BA.setBotAi("pip", { op: "remove", agentId: codex.id });
  await new Promise((r) => setTimeout(r, 100));
  assert.ok(sessionCalls.filter((c) => c[0] === "agentsChanged").length >= 2);
  const sent = commands.filter((c) => c.computer === "pc-pip" && c.command.includes("bot-clear")).map((c) => c.command);
  assert.ok(sent.some((c) => c.includes(`bops-brain bot-clear pip ${claude.id}`)), sent.join("\n"));
  assert.ok(sent.some((c) => c.includes(`bops-brain bot-clear pip ${codex.id}`)), sent.join("\n"));
  assert.ok(sessionCalls.some((c) => c[0] === "returnControl"), "the terminal on the plan closed");
  S.update((s) => {
    s.sessions = s.sessions.filter((x) => x.id !== "s_term");
    delete s.takeover;
  });
  // Every other agent of Pip's has its wrappers written again from its profile now: the plan it left isn't in them.
  const rebin = sent.find((c) => c.includes(`bops-brain bot-clear pip ${claude.id}`) && c.includes("bops-brain rebin pip"));
  assert.ok(rebin && !/claude:plan:brain_plan:/.test(rebin), rebin);
  // Back to the default: everything goes, and the whole bot's folder with it.
  for (const x of pip().ai.agents.filter((y) => y.kind !== "bops")) BA.setBotAi("pip", { op: "remove", agentId: x.id });
  BA.setBotAi("pip", { op: "update", agentId: "bops", model: null });
  await new Promise((r) => setTimeout(r, 100));
  assert.equal(pip().ai, undefined, "back to no profile at all");
  assert.equal(pip().brain, undefined);
  assert.ok(commands.some((c) => c.computer === "pc-pip" && /bops-brain bot-clear pip$/.test(c.command)));
});

await test("POST /api/bots/ai: from the Bops window only, with words for what's wrong", async () => {
  assert.equal((await R.POST(fromPage({ botId: "pip", op: "add", kind: "codex", pays: "key" }))).status, 403);
  assert.equal((await R.POST(fromWindow({ botId: "pip", op: "fly" }))).status, 400);
  assert.equal((await R.POST(fromWindow({ botId: "nobody", op: "default", agentId: "bops" }))).status, 404);
  const ok = await R.POST(fromWindow({ botId: "pip", op: "update", agentId: "bops", model: "gpt-6-astra" }));
  assert.equal(ok.status, 200);
  assert.deepEqual((await ok.json()).ai, { agents: [{ id: "bops", kind: "bops", pays: "credit", model: "gpt-6-astra" }], default: "bops" });
  BA.setBotAi("pip", { op: "update", agentId: "bops", model: null });
  // Add says which agent it added, so the window opens its editor.
  const added = await (await R.POST(fromWindow({ botId: "pip", op: "add", kind: "opencode", pays: "key" }))).json();
  assert.match(added.added, /^ag_[A-Za-z0-9]{10}$/);
  assert.ok(added.ai.agents.some((x) => x.id === added.added));
  BA.setBotAi("pip", { op: "remove", agentId: added.added });
});

/* ---------------- A thread's agent ---------------- */

await test("a thread runs on the agent it was given, as its bot's profile has it now; anything else is Bops agent, and one whose agent went says so", () => {
  const st = S.getState();
  const b = bot("boppy");
  const cloud = { id: "s", botId: "boppy" };
  // Given Claude Code: that agent, its account and the kind's default model.
  let r = A.threadAgent({ ...cloud, agent: { id: planAgent, kind: "claude" } }, b, st);
  assert.equal(r.kind, "claude");
  assert.equal(r.account.id, "brain_plan");
  assert.equal(r.model, "claude-opus-5-5");
  assert.equal(r.route, undefined, "a plan has no gate");
  // A model the agent allows sticks; one it doesn't is the agent's own.
  assert.equal(A.threadAgent({ ...cloud, agent: { id: planAgent, kind: "claude", model: "claude-sonnet-5-5" } }, b, st).model, "claude-sonnet-5-5");
  assert.equal(A.threadAgent({ ...cloud, agent: { id: planAgent, kind: "claude", model: "gpt-6-astra" } }, b, st).model, "claude-opus-5-5");
  // Codex on its key: the gate's route and the Vault key.
  r = A.threadAgent({ ...cloud, agent: { id: codexAgent, kind: "codex" } }, b, st);
  assert.deepEqual([r.kind, r.route, r.keyName, r.model], ["codex", "openai", "OPENAI_API_KEY", "gpt-6.1-sol"]);
  // From before profiles: no agent, its brainRun's account finds it; no brainRun, the Default.
  assert.equal(A.threadAgent({ ...cloud, brainRun: { brainId: "brain_codex", kind: "codex", computerId: "pc-main", cli: "x" } }, b, st).kind, "codex");
  assert.equal(A.threadAgent(cloud, b, st).agent.id, planAgent);
  // A thread naming an agent its bot doesn't have (a computer can write its own threads whole): Bops agent, with why.
  r = A.threadAgent({ ...cloud, agent: { id: "ag_forged0001", kind: "claude" } }, b, st);
  assert.equal(r.kind, "bops");
  assert.equal(r.gone, "Stopped: Boppy doesn't run Claude Code anymore. Reply and it carries on with Bops agent.");
  assert.equal(r.goneNote, "Boppy doesn't run Claude Code anymore, so Bops agent does this, on your AI credit.");
  // Begun on one account, and the agent moved to another since.
  r = A.threadAgent({ ...cloud, agent: { id: planAgent, kind: "claude" }, brainRun: { brainId: "brain_old", agentId: planAgent, kind: "claude", computerId: "pc-main", cli: "x", started: true } }, b, st);
  assert.equal(r.kind, "bops");
  assert.match(r.gone, /on that account anymore/);
  // On the Mac, or once Bops agent ran any of it: Bops agent.
  assert.equal(A.threadAgent({ ...cloud, agent: { id: planAgent, kind: "claude" }, runsOn: "mac" }, b, st).kind, "bops");
  assert.equal(A.threadAgent({ ...cloud, agent: { id: planAgent, kind: "claude" }, responseId: "resp_1" }, b, st).kind, "bops");
  assert.equal(A.threadAgent({ ...cloud, agent: { id: planAgent, kind: "claude" } }, { ...b, runsOn: "mac" }, st).kind, "bops");
  // OpenCode: its provider by its model, the gate's route and the provider's Vault key.
  const oc = { ...b, ai: { agents: [...b.ai.agents, { id: "ag_oc00000001", kind: "opencode", pays: "key", model: "deepinfra/some-model" }], default: b.ai.default } };
  r = A.threadAgent({ ...cloud, agent: { id: "ag_oc00000001", kind: "opencode" } }, oc, st);
  assert.deepEqual([r.kind, r.route, r.keyName, r.account], ["opencode", "deepinfra", "DEEPINFRA_API_KEY", undefined]);
});

await test("a new thread's agent: the owner's pick, then one named, then the Default; nothing written for a bot with no profile", () => {
  const st = S.getState();
  const b = bot("boppy");
  // Each with the model it starts on (the agent's, else its kind's default), so a later change of the agent's model
  // never moves a thread already going; Bops agent on Auto keeps none (its route picks one each task).
  assert.deepEqual(A.pickAgent(b, st, [codexAgent, planAgent]), { id: codexAgent, kind: "codex", model: "gpt-6.1-sol" });
  assert.deepEqual(A.pickAgent(b, st, ["ag_notmine001", planAgent]), { id: planAgent, kind: "claude", model: "claude-opus-5-5" });
  assert.deepEqual(A.pickAgent(b, st, [undefined, null]), { id: planAgent, kind: "claude", model: "claude-opus-5-5" }, "the Default");
  assert.deepEqual(A.pickAgent(b, st, [planAgent], "claude-haiku-5-5"), { id: planAgent, kind: "claude", model: "claude-haiku-5-5" });
  assert.deepEqual(A.pickAgent(b, st, [planAgent], "gpt-6-astra"), { id: planAgent, kind: "claude", model: "claude-opus-5-5" }, "a model it doesn't allow isn't kept");
  assert.deepEqual(A.pickAgent(b, st, ["bops"]), { id: "bops", kind: "bops" });
  const started = A.pickAgent(b, st, [planAgent]);
  const haiku = { ...b, ai: { ...b.ai, agents: b.ai.agents.map((x) => (x.id === planAgent ? { ...x, model: "claude-haiku-5-5" } : x)) } };
  assert.equal(A.threadAgent({ id: "s", botId: "boppy", agent: started }, haiku, st).model, "claude-opus-5-5", "its agent's model changed later: the thread keeps its own");
  assert.equal(A.pickAgent(bot("pip"), st, [planAgent]), undefined);
  // In chat: the agents a task can start on, by the names the model is offered.
  const ready = A.readyAgents(b, st).map((x) => A.agentLabel(x));
  assert.deepEqual(ready, ["Bops agent", "Claude Code · Opus 5.5", "Codex · GPT 6.1 Sol"]);
  assert.equal(A.agentNamed(b, st, "Codex · GPT 6.1 Sol").id, codexAgent);
  assert.equal(A.agentNamed(b, st, "claude code").id, planAgent);
  assert.equal(A.agentNamed(b, st, "Gemini"), undefined);
  // Rook's plan isn't signed in on its own computer: not ready, so not offered.
  assert.deepEqual(A.readyAgents(bot("rook"), st).map((x) => x.kind), ["bops"]);
});

/* ---------------- On the computer: flags, stops, OpenCode ---------------- */

const C = await import(fileUrl("lib/server/cli-agents.ts"));

await test("a run's flags for the computer: its bot, agent, model, thinking, gate route, the bot's other agents, its shell's name", () => {
  const st = S.getState();
  S.update((s) => void (s.bots.find((x) => x.id === "boppy").effort = "high"));
  const b = bot("boppy");
  const plan = A.threadAgent({ id: "s", botId: "boppy", agent: { id: planAgent, kind: "claude" } }, b, st);
  assert.deepEqual(C.agentFlags(plan, b), ["--bot", "boppy", "--agent", planAgent, "--model", "claude-opus-5-5", "--effort", "high", "--also", "codex:key:brain_codex:", "--label", "boppy"]);
  const codex = A.threadAgent({ id: "s", botId: "boppy", agent: { id: codexAgent, kind: "codex" } }, b, st);
  assert.deepEqual(C.agentFlags(codex, b), ["--bot", "boppy", "--agent", codexAgent, "--model", "gpt-6.1-sol", "--effort", "high", "--route", "openai", "--also", "claude:plan:brain_plan:", "--label", "boppy"]);
  assert.equal(C.alsoSpec(b), "claude:plan:brain_plan:,codex:key:brain_codex:", "the Bops agent's bin: every CLI agent");
  S.update((s) => void delete s.bots.find((x) => x.id === "boppy").effort);
});

await test("a CLI's stop is sorted: limit, sign in or key, a model its account can't use, its provider down", () => {
  assert.equal(C.stopOf("Claude AI usage limit reached|1760032800"), "limit");
  assert.equal(C.stopOf("invalid x-api-key"), "auth");
  assert.equal(C.stopOf("The model claude-opus-5-5 is not available on your plan"), "model");
  assert.equal(C.stopOf("unknown model: gpt-1"), "model");
  assert.equal(C.stopOf("529 Overloaded"), "down");
  assert.equal(C.stopOf("Bops couldn't reach api.anthropic.com."), "down");
  assert.equal(C.stopOf("it stopped (exit 1)"), undefined);
});

await test("OpenCode's events (captured from opencode 2.0.27) read as a thread's steps, its answer and how its turn ended", () => {
  const D = C.opencodeDriver;
  const events = readFileSync(join(root, "scripts/fixtures/opencode-run.jsonl"), "utf8").trim().split("\n").map((l) => JSON.parse(l));
  const read = events.flatMap((e) => D.parse(e));
  assert.deepEqual(read, [
    { type: "tool", id: "call_1", tool: "command", detail: "ran npm test", args: { command: "npm test", description: "Runs the tests" } },
    { type: "text", text: "Hello from the fake." },
  ]);
  assert.deepEqual(D.parse({ type: "bops", subtype: "started", session: "ses_bopsFixture0001" }), [{ type: "started", session: "ses_bopsFixture0001", failed: [] }]);
  assert.deepEqual(D.parse({ type: "bops", subtype: "turn", ok: true }), [{ type: "result", ok: true }]);
  assert.deepEqual(D.parse({ type: "bops", subtype: "turn", ok: false, error: "invalid x-api-key" }), [{ type: "result", ok: false, text: "invalid x-api-key", stop: "auth" }]);
  assert.deepEqual(D.parse({ type: "tool_use", part: { tool: "screen_click", state: { status: "completed", input: { x: 1, y: 2 } } } }), [{ type: "tool", id: "", tool: "click", args: { x: 1, y: 2 } }], "Bops' own tools, worded by Bops");
  assert.equal(D.cliId("ses_bopsFixture0001"), "ses_bopsFixture0001");
  assert.equal(D.cliId("ses_x; rm -rf /"), undefined);
  assert.match(D.newSession(), /^ses_[A-Za-z0-9]{24}$/);
  assert.equal(C.cliId("0b7c2f9e-1d2a-4c3b-9e8f-112233445566"), "0b7c2f9e-1d2a-4c3b-9e8f-112233445566");
  assert.equal(C.cliDriver("opencode"), D);
});

await test("keys and run tokens are taken out of anything read back from a computer", async () => {
  const P = await import(fileUrl("lib/secret-patterns.ts"));
  const said = `env: ANTHROPIC_API_KEY=bopsrun_${"a1".repeat(32)} OPENAI_API_KEY=sk-proj-${"x".repeat(40)} and sk-ant-api03-${"y".repeat(30)}`;
  assert.equal(P.redact(said), "env: ANTHROPIC_API_KEY=[hidden] OPENAI_API_KEY=[hidden] and [hidden]");
  assert.deepEqual(P.redactDeep({ a: [said], b: 1 }), { a: [P.redact(said)], b: 1 });
});

/* ---------------- The window ---------------- */

await test("the AI section: its agents as tiles with the Default marked, agy Soon, Thinking, threads now with their agent, calls, and what stays on credit", () => {
  const st = S.getState();
  S.update((s) => {
    s.sessions.push(
      { id: "s_a", botId: "boppy", chatId: "bot_boppy", sentVia: "you", title: "Fix the header", goal: "x", host: "orgo", status: "running", steps: [], replies: [], createdAt: now, agent: { id: planAgent, kind: "claude" } },
      { id: "s_b", botId: "boppy", chatId: "bot_boppy", sentVia: "you", title: "Weekly report", goal: "x", host: "orgo", status: "done", waitingOnYou: true, steps: [], replies: [], createdAt: now, endedAt: now },
    );
  });
  const out = render(h(BotAiSection, { state: S.getState(), bot: bot("boppy"), onShowScreen() {} }));
  // Worst first in the header, and the Default by its name (its model would push the rest out of a narrow row).
  assert.match(out, /^▾ AI Default Claude Code · 1 needs you · 1 running Agents it can run /, out);
  assert.match(out, /Bops agent OpenAI · Bops credit Claude Code Default Max plan · signed in here Codex Your OpenAI key/);
  assert.match(out, /agy Soon Google Antigravity \+ Add Thinking/);
  assert.match(out, /Threads now Bops agent: Weekly report · needs you Claude Code · Opus 5\.5: Fix the header \+ New thread Open its terminal Calls OpenAI live voice/);
  assert.match(out, /Each thread runs on the agent you pick, with Boppy's own accounts\. Chat, memory and calls stay on Bops AI credit\./);
  // Boppy's computer is its own, but Otto-like bots sharing it would hear the warning: Rook's plan on Pip's? none here.
  assert.ok(!/can reach/.test(out));
  plain(out, "the AI section");
  // A tile's editor: model, how it pays (Soon ones say why), its account, Make default and Remove.
  const ed = render(h(BotAiSection, { state: S.getState(), bot: bot("boppy"), editing: codexAgent, onShowScreen() {} }));
  assert.match(ed, /Model GPT 6\.1 Sol GPT 6 Astra ▾ Pays with Bops credit ChatGPT plan Your key Account Codex Max plan|Model GPT 6\.1 Sol GPT 6 Astra ▾ Pays with Bops credit ChatGPT plan Your key/);
  assert.match(renderToStaticMarkup(h(BotAiSection, { state: S.getState(), bot: bot("boppy"), editing: codexAgent })), /title="Soon: A ChatGPT plan for Codex needs a check of OpenAI&#x27;s terms first\."/);
  assert.match(ed, /Your OpenAI key Make default Remove/);
  // What's Soon says why, in words on the page, not only on hover.
  assert.match(ed, /Soon: Bops credit for Codex needs Bops Cloud to carry it first\. A ChatGPT plan for Codex needs a check of OpenAI's terms first\./);
  plain(ed, "the editor");
  // No key for it in the Vault (when the window has read the Vault's names): not ready, with Add key.
  const noKey = render(h(BotAiSection, { state: S.getState(), bot: bot("boppy"), editing: codexAgent, onAddKey() {} }));
  assert.ok(!/No OpenAI key/.test(noKey), "the Vault unread: as it was");
  assert.equal(render(h(AgentTile, { agent: bot("boppy").ai.agents.find((x) => x.id === codexAgent), bot: bot("boppy"), state: S.getState(), isDefault: false, keys: new Set(["ANTHROPIC_API_KEY"]) })), "Codex No OpenAI key in your Vault yet.");
  assert.deepEqual(A.readyAgents(bot("boppy"), S.getState(), new Set(["ANTHROPIC_API_KEY"])).map((x) => x.kind), ["bops", "claude"]);
  assert.equal(A.agentState(bot("boppy").ai.agents.find((x) => x.id === codexAgent), bot("boppy"), S.getState(), new Set(["OPENAI_API_KEY"])).ready, true);
  // A member sees it, read only.
  const member = render(h(BotAiSection, { state: { ...st, sessions: S.getState().sessions, shared: { ownerName: "Maya" } }, bot: bot("boppy") }));
  assert.match(member, /Only Maya changes Boppy's AI\./);
  assert.ok(!/\+ Add|New thread|Make default|Remove/.test(member), member);
  // A thread's state in words: "needs your OK" only for an approval; one stopped, or open in its terminal, says so.
  const t0 = { id: "s_w", botId: "boppy", status: "done", steps: [], replies: [], createdAt: now };
  assert.equal(stateWords({ ...t0, waitingOnYou: true }, st), "needs you");
  assert.equal(stateWords({ ...t0, status: "failed", error: "Paused while it's open in the terminal" }, st), "in its terminal");
  assert.equal(stateWords({ ...t0, status: "failed", error: "Stopped: Boppy doesn't run Codex anymore. Reply and it carries on with Bops agent." }, st), "stopped");
  assert.equal(stateWords({ ...t0, status: "failed", error: "It broke" }, st), "didn't finish");
  assert.equal(stateWords(t0, st), "done");
});

await test("every state of a tile says what it is, with its one button", () => {
  const st = S.getState();
  const tile = (x, b = bot("rook"), state = st) => render(h(AgentTile, { agent: x, bot: b, state, isDefault: false }));
  const rookPlan = bot("rook").ai.agents.find((x) => x.kind === "claude");
  assert.equal(tile(rookPlan), "Claude Code Not signed in on Rook's computer yet.");
  assert.equal(render(h(AgentTile, { agent: rookPlan, bot: bot("rook"), state: st, isDefault: true })), "Claude Code Default Not signed in on Rook's computer yet.", "the Default says so whatever its state");
  const going = { ...st, brains: st.brains.map((x) => (x.id === "brain_plan" ? { ...x, signingIn: { botId: "rook", computerId: "pc-rook", display: 2, at: now } } : x)) };
  assert.equal(tile(rookPlan, bot("rook"), going), "Claude Code Sign in is open on its screen.");
  const failed = { ...st, brains: st.brains.map((x) => (x.id === "brain_plan" ? { ...x, signingIn: { botId: "rook", computerId: "pc-rook", display: 2, at: now, failed: "it took too long" } } : x)) };
  assert.equal(tile(rookPlan, bot("rook"), failed), "Claude Code Sign in didn't finish: it took too long.");
  assert.equal(tile(rookPlan, bot("rook"), { ...st, host: "mac" }), "Claude Code Claude Code runs on a cloud computer. Your bots work on this Mac.");
  assert.equal(tile(rookPlan, { ...bot("rook"), runsOn: "mac" }), "Claude Code Rook works on your Mac, so its threads use Bops agent.");
  assert.equal(tile({ id: "ag_oc00000001", kind: "opencode", pays: "key", model: "anthropic/claude-sonnet-5-5" }), "OpenCode Sonnet 5.5 · your Anthropic key");
  assert.equal(tile({ id: "bops", kind: "bops", pays: "credit", model: "gpt-6-astra" }), "Bops agent GPT 6 Astra · Bops credit");
  // A bot that shares a computer and keeps a login there is told its logins aren't walled off.
  const shared = { ...st, bots: [...st.bots, { id: "otto", name: "Otto", role: "Outbound", color: "#E9FF3B", isMain: false, computer: "shared", workspaceId: "ws_main", ai: bot("rook").ai }] };
  assert.equal(A.sharesComputerWithLogins(shared.bots.at(-1), shared), "Otto shares Boppy's computer, so bots there can reach Otto's logins. Give Otto its own computer to keep them apart.");
});

await test("New thread, in place (never a dialog over the window), and the agent chip", () => {
  const html = renderToStaticMarkup(h(NewThread, { state: S.getState(), bot: bot("boppy"), agentId: codexAgent, onClose() {}, onStarted() {} }));
  const out = text(html);
  assert.match(out, /^New thread for Boppy × Bops agent /);
  assert.match(out, /Codex GPT 6\.1 Sol Model GPT 6\.1 Sol GPT 6 Astra ▾ Pays with: your OpenAI key/);
  assert.match(out, /Cancel Start$/);
  // In place where it was asked for, named by its title (Escape in it closes it, not the profile behind), its box labelled and focused.
  assert.match(html, /role="region" aria-labelledby="([^"]+)" data-new-thread="true"[\s\S]*id="\1"[^>]*>New thread for Boppy/);
  assert.doesNotMatch(html, /aria-modal|role="dialog"|fixed inset-0/, "no dialog, no scrim");
  assert.match(html, /<textarea[^>]*placeholder="What should it do\?"[^>]*aria-label="What should it do\?"/);
  plain(out, "the New thread sheet");
  // Rook's Default is its Claude plan, not signed in: the sheet starts on one that's ready and offers Set up for it,
  // and the message box's chip says the Default as it is (the server starts a task there), not Bops agent.
  const st = S.getState();
  const rook = { ...bot("rook"), ai: { ...bot("rook").ai, default: bot("rook").ai.agents.find((x) => x.kind === "claude").id } };
  const rookState = { ...st, bots: st.bots.map((x) => (x.id === "rook" ? rook : x)) };
  const sheet = renderToStaticMarkup(h(NewThread, { state: rookState, bot: rook, onClose() {}, onStarted() {}, onSetUp() {} }));
  assert.match(sheet, /aria-pressed="true"[^>]*>(?:(?!aria-pressed).)*Bops agent/, "on the one that's ready");
  assert.match(text(sheet), /Claude Code Default Not signed in on Rook's computer yet\. Set up/);
  const chip = text(renderToStaticMarkup(h(AgentChipPick, { state: rookState, bot: rook, value: null, defaultOpen: true, onPick() {} })));
  assert.equal(chip, "Claude Code · not signed in ▾ Claude Code · Opus 5.5 · not signed in Default Bops agent");
  // A pick that isn't ready anymore is never the one a message carries.
  assert.equal(boxAgents(rookState, rook, rook.ai.default).picked, undefined);
  assert.equal(boxAgents(rookState, rook, "bops").picked?.id, "bops");
  assert.equal(render(h(AgentChip, { agent: { kind: "claude", model: "claude-sonnet-5-5" } })), "Claude Code · Sonnet 5.5");
  for (const w of [...Object.values(A.AGENTS).map((x) => x.soon ?? ""), ...Object.values(A.PAYS_SOON).flatMap((x) => Object.values(x))]) plain(w, "a Soon reason");
});

await test("a bot that leaves a computer (deleted, or moved to its own) has its folder there cleared; a bot on the default has none", async () => {
  commands.length = 0;
  BA.leaveComputer(bot("boppy"), "pc-old");
  BA.leaveComputer(bot("pip"), "pc-old");
  await new Promise((r) => setTimeout(r, 100));
  const there = commands.filter((c) => c.computer === "pc-old" && c.command.includes("bops-brain bot-clear")).map((c) => c.command);
  assert.equal(there.length, 1, there.join("\n"));
  assert.match(there[0], /bops-brain bot-clear boppy$/);
});

await test("a Bops agent model the profile picked stays through the router's bumps", async () => {
  const Rt = await import(fileUrl("lib/server/routing.ts"));
  const route = { by: "router", model: "gpt-6.1-sol", effort: "medium", tier: "standard", bumps: 2, pinned: true };
  assert.equal(Rt.taskConfig(route).model, "gpt-6.1-sol");
  assert.notEqual(Rt.taskConfig({ ...route, pinned: undefined }).model, undefined);
});

await test("a build without brains (a release): the --off pass", async () => {
  const out = await new Promise((resolve, reject) =>
    execFile(process.execPath, [...process.execArgv, fileURLToPath(import.meta.url), "--off"], { env: { PATH: process.env.PATH, TMPDIR: tmpdir() } }, (err, stdout, stderr) => (err ? reject(new Error(`${stdout}${stderr}`)) : resolve(stdout))),
  );
  assert.match(out, /brains off: 1 passed/, out);
});

rmSync(scratch, { recursive: true, force: true });
assert.ok(!logged.some((l) => /bopsrun_[0-9a-f]{16}|sk-ant-|sk-proj-/.test(l)), "nothing secret in what Bops logged");
process.stdout.write(`bot ai: ${passed} passed\n`);
process.exit(0);
