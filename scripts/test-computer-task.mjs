// Tests for cloud tasks on the Responses API's computer tool (lib/server/computer-task.ts, sessions.ts):
// a task's screen actions become xdotool on its screen, and the script Bops sends is run here against a
// stand-in xdotool, so each argument must arrive as the model sent it (keys with quotes and symbols, text
// that ends in a newline, a one-point drag), and nothing in one runs as a command. Its tool calls run and
// their answers are kept, so a task stopped mid-step picks up with what really happened. A step OpenAI
// flags waits for the user's OK, which a reply sent before they saw the question doesn't give. A reply
// sent while it works goes in with its next step (steering), or waits for the next turn if that step
// fails. A task on a computer that's asleep says it's in use before its first look, which wakes it, and
// makes no screen on top of the ones it has. AI credit
// used up ends it as it ends any task. Bops Cloud (OpenAI behind it) and Orgo are fakes: nothing reaches
// a real service.
// Usage: node --conditions=react-server scripts/test-computer-task.mjs
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, symlinkSync, writeFileSync } from "node:fs";
import { registerHooks } from "node:module";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { pathToFileURL } from "node:url";

for (const k of Object.keys(process.env)) if (/^(BOPS|OPENAI|AGENTPHONE|AGENTMAIL|HONCHO|COMPOSIO|TYPESAFE|TWILIO|ORGO|CODEX|TAILSCALE)_/.test(k)) delete process.env[k];
process.env.BOPS_DEVICE_SEED = "test-computer-task";
const root = new URL("..", import.meta.url).pathname.replace(/\/$/, "");
// Modules that would start processes when loaded, or that Node can't load, are stand-ins: each export does nothing.
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
    const name = url.match(/\/lib\/server\/([a-z-]+)\.ts$/)?.[1];
    if (!name || !STAND_INS.has(name)) return next(url, context);
    const names = [...readFileSync(new URL(url), "utf8").matchAll(/^export (?:async )?(?:function\*? |const |let |class )([A-Za-z_$][\w$]*)/gm)].map((m) => m[1]);
    return { format: "module", shortCircuit: true, source: names.map((n) => `export const ${n} = function () { return Promise.resolve(); };`).join("\n") };
  },
});
const scratch = mkdtempSync(join(tmpdir(), "bops-test-computer-task-"));
process.chdir(scratch);
process.env.HOME = join(scratch, "home");
mkdirSync(process.env.HOME);
// The screen tools Bops puts on a computer are read from the working folder (sessions.ts ensureScreenTools).
symlinkSync(join(root, "node_modules"), join(scratch, "node_modules"));
symlinkSync(join(root, "vm"), join(scratch, "vm"));
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
async function until(check, what, ms = 15_000) {
  for (const end = Date.now() + ms; Date.now() < end; await sleep(25)) {
    const v = check();
    if (v) return v;
  }
  assert.fail(`timed out waiting for ${what}`);
}

/* ---------------- Bops Cloud, OpenAI behind it, and Orgo: fakes ---------------- */

process.env.BOPS_CLOUD_URL = "https://cloud.test";
process.env.BOPS_ORGO_ORIGIN = "https://orgo.test";
globalThis.bopsOrgoKey = "sk_orgo_test";
const USER = { id: "u_1", email: "me@example.com", name: "Test" };
const COMPUTER = "comp_1";
// A 1x1 PNG: what Orgo answers for a screenshot.
const PNG = Buffer.from("iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==", "base64");
const json = (obj, status = 200) => new Response(JSON.stringify(obj), { status, headers: { "content-type": "application/json" } });
const cloudState = { version: 0, seq: 0, blob: null, messages: new Map() };
/** Each task's model calls (bodies) in order, and what OpenAI answers next: a function of the body. */
const asked = [];
const answers = [];
/**
 * The computer as orgo-web keeps Free's: its status, and when Bops last said it's in use (null: never, so it's
 * never put to sleep for want of use). Every call to Orgo, as "METHOD /path".
 */
const pc = { status: "running", activeAt: null, shot409: false };
const idleAsleep = () => pc.status === "suspended" && pc.activeAt !== null && Date.now() - pc.activeAt > 15 * 60_000;
const orgoCalls = [];
/** Every command Bops ran on the computer, and what a run_command answers (a function of the command, run when it's called). */
const bash = [];
let onCommand = () => ({ output: "", exit_code: 0 });
const response = (id, output) => ({ id, object: "response", model: "gpt-6.1-sol", status: "completed", output, usage: { input_tokens: 1000, output_tokens: 50, input_tokens_details: { cached_tokens: 0 }, output_tokens_details: { reasoning_tokens: 0 } } });
const said = (text) => ({ id: `msg_${text.length}`, type: "message", role: "assistant", content: [{ type: "output_text", text, annotations: [] }] });

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
      // A task's call (it has the computer); Jev and the rest get a plain refusal, and go on without.
      if (!b.tools?.some((t) => t.type === "computer")) return json({ error: { message: "not in this test" } }, 400);
      asked.push(b);
      const next = answers.shift();
      assert.ok(next, `an answer for model call ${asked.length}`);
      const a = await next(b);
      return a instanceof Response ? a : json(a);
    }
    return json({ error: "not faked" }, 404);
  }
  if (url.origin === "https://orgo.test") {
    const path = url.pathname.replace(/^\/api/, "");
    orgoCalls.push(`${req.method} ${path}`);
    // Bops says the computer is in use (lib/server/free-hours.ts).
    if (path === "/bops/computer/active") {
      pc.activeAt = Date.now();
      return json({ ok: true });
    }
    if (path === `/computers/${COMPUTER}/screens`) {
      // Asleep for want of use, its screens come from what Orgo has on record (no ports), and it isn't woken;
      // any other read wakes it, and the computer's own list has its ports.
      const listed = (d, ports) => ({ id: d === 99 ? "default" : `screen-${d}`, display: `:${d}`, width: 1280, height: 960, vnc_port: ports ? 5900 + d : null, ws_port: ports ? 5981 + d : null, default: d === 99 });
      if (idleAsleep()) return json({ screens: [99, 100, 101, 102].map((d) => listed(d, false)) });
      if (pc.status === "suspended") pc.status = "running";
      return json({ screens: [100, 101, 102].map((d) => listed(d, true)) });
    }
    if (path === `/computers/${COMPUTER}/screenshot`) {
      // Orgo left it asleep for a look (the heartbeat lapsed mid-task, say): once, then it's woken by an action.
      if (pc.shot409) {
        pc.shot409 = false;
        pc.status = "suspended";
        return json({ error: "This computer is asleep.", code: "computer_asleep" }, 409);
      }
      return new Response(PNG, { headers: { "content-type": "image/png" } });
    }
    if (path === `/computers/${COMPUTER}/bash`) {
      // An action wakes it, asleep or not.
      if (pc.status === "suspended") pc.status = "running";
      const { command } = JSON.parse(body);
      bash.push(command);
      if (command.includes("cd /workspace && export DISPLAY")) return json(await onCommand(command));
      return json({ output: command.includes("echo ok") ? "ok" : "", exit_code: 0 });
    }
    if (path === `/computers/${COMPUTER}`) return json({ id: COMPUTER, status: pc.status });
    return json({ error: "not faked" }, 404);
  }
  throw new TypeError(`fetch failed (the test is offline: ${url.host})`);
};
const warned = [];
console.warn = (...a) => warned.push(a.join(" "));

const S = await import(`${root}/lib/server/store.ts`);
const Cl = await import(`${root}/lib/server/cloud.ts`);
const X = await import(`${root}/lib/server/sessions.ts`);

await S.bindSignIn(USER.id, "sk_orgo_test");
S.update((s) => {
  s.account = { user: USER, signedInAt: Date.now() };
  s.host = "orgo";
});
const main = S.getState().bots.find((b) => b.isMain);
S.update(() => Object.assign(S.bot(main.id), { computerId: COMPUTER, computerStatus: "ready", effort: "medium" }));

/** Start a task in the cloud and wait for it to end. */
async function task(goal, title) {
  const s = X.startSession({ botId: main.id, goal, title, where: "cloud", fresh: true });
  await until(() => ["done", "failed"].includes(S.session(s.id)?.status), `"${title}" to end`);
  return s.id;
}
const ended = (id) => until(() => ["done", "failed"].includes(S.session(id)?.status) && S.session(id), "the thread to end");
const userText = (b) => b.input.filter((i) => i.role === "user").flatMap((i) => i.content.map((c) => c.text)).join("\n");

/* ---------------- A task: the screen, a command, an answer ---------------- */

const FINAL = "The report is ready: report.pdf.";
answers.push(
  () =>
    response("resp_1", [
      { id: "rs_1", type: "reasoning", summary: [{ type: "summary_text", text: "Opening the page." }] },
      {
        id: "cu_1",
        type: "computer_call",
        call_id: "call_1",
        status: "completed",
        actions: [
          { type: "click", x: 10.4, y: 20.6, button: "left", keys: ["CTRL"] },
          { type: "keypress", keys: ["CTRL", "+"] },
          { type: "keypress", keys: ["'; touch PWNED; echo '"] },
          { type: "keypress", keys: ["$(touch PWNED2)"] },
          { type: "type", text: "two lines\nend\n" },
          { type: "drag", path: [{ x: 5, y: 6 }] },
          { type: "scroll", x: 1, y: 2, scroll_x: 0, scroll_y: -250 },
          { type: "screenshot" },
        ],
      },
    ]),
  () => response("resp_2", [{ id: "fc_2", type: "function_call", call_id: "call_2", name: "run_command", arguments: JSON.stringify({ command: "ls", timeout_seconds: null }) }]),
  // Its last response says what it's doing, then answers: the answer is only the answer.
  () => response("resp_3", [{ ...said("Checking the folder once more."), phase: "commentary" }, { ...said(FINAL), phase: "final_answer" }]),
);
onCommand = (c) => ({ output: c.endsWith("\nls") ? "report.pdf" : "", exit_code: 0 });
const first = await task("Make the report", "Report");
let s = S.session(first);
assert.equal(s.status, "done", `it finished (${s.error ?? ""}; ${warned.join(" | ")})`);
assert.equal(s.answer, FINAL);
assert.equal(s.runner, "computer", "a new cloud task runs on the computer tool");
assert.equal(s.agentSessionId, undefined, "no Agents API session");
assert.equal(s.owed, undefined, "nothing owed after an answer");
assert.equal(asked.length, 3);
// What the model is given: the screen, web search, a shell, signing in from the vault, the user's CRM (crm.ts), its instructions; each call follows the last.
assert.deepEqual(asked[0].tools.map((t) => t.name ?? t.type), ["computer", "web_search", "run_command", "sign_in_from_vault", "crm_files", "crm_read", "crm_save_rows", "crm_create_file"]);
assert.match(asked[0].instructions, /Bops CRM: .* save them with crm_save_rows as you go/, "told about the CRM, as a task");
assert.match(asked[0].instructions, /call sign_in_from_vault: Bops fills/, "told to use it (no helpers' screens here)");
assert.equal(asked[0].previous_response_id, undefined);
assert.match(userText(asked[0]), /^Make the report/);
assert.equal(asked[1].previous_response_id, "resp_1");
const shot = asked[1].input.find((i) => i.type === "computer_call_output");
assert.equal(shot.call_id, "call_1");
assert.equal(shot.output.type, "computer_screenshot");
assert.equal(shot.output.detail, "original", "full size, so its coordinates are the screen's");
assert.equal(shot.output.image_url, `data:image/png;base64,${PNG.toString("base64")}`);
assert.equal(asked[2].previous_response_id, "resp_2");
assert.deepEqual(asked[2].input[0], { type: "function_call_output", call_id: "call_2", output: "exit code 0\nreport.pdf" });
// The thread's steps read as the screen MCP's do.
const details = s.steps.map((x) => x.detail);
for (const d of ["clicked (10, 21)", "pressed CTRL++", 'typed "two lines\nend\n"', "dragged", "scrolled up", "ran ls", "Checking the folder once more."]) assert.ok(details.includes(d), `a step says ${JSON.stringify(d)}: ${JSON.stringify(details)}`);

// The actions went to the task's screen as one script. Run here against a stand-in xdotool, each argument
// arrives whole and as sent, and nothing in a key's name runs.
const script = bash.find((c) => c.includes("xdotool"));
assert.ok(script, "the actions ran on the computer");
const display = s.lastDisplay ?? s.display;
assert.ok(script.includes(`DISPLAY=:${display} xdotool`), "on the task's own screen");
const bin = join(scratch, "bin");
mkdirSync(bin);
const log = join(scratch, "xdotool.log");
writeFileSync(join(bin, "xdotool"), `#!/bin/sh\nnode -e 'require("fs").appendFileSync(process.argv[1], JSON.stringify({ display: process.env.DISPLAY, args: process.argv.slice(2) }) + "\\n")' ${JSON.stringify(log)} "$@"\n`, { mode: 0o755 });
const run = join(scratch, "run");
mkdirSync(run);
execFileSync("/bin/bash", ["-c", script.replace(/^sleep [\d.]+$/m, "true")], { cwd: run, env: { ...process.env, PATH: `${bin}:${process.env.PATH}` }, stdio: ["ignore", "ignore", "ignore"] });
const xdo = readFileSync(log, "utf8").trim().split("\n").map((l) => JSON.parse(l));
assert.ok(xdo.every((x) => x.display === `:${display}`));
assert.deepEqual(
  xdo.map((x) => x.args),
  [
    ["mousemove", "10", "21"],
    ["keydown", "ctrl"],
    ["click", "1"],
    ["keyup", "ctrl"],
    ["key", "--", "ctrl+plus"],
    ["key", "--", "'; touch PWNED; echo '"],
    ["key", "--", "$(touch PWNED2)"],
    ["type", "--delay", "12", "--", "two lines\nend\n"],
    ["mousemove", "5", "6"],
    ["mousedown", "1"],
    ["mouseup", "1"],
    ["mousemove", "1", "2"],
    ["click", "--repeat", "3", "4"],
  ],
);
assert.ok(!existsSync(join(run, "PWNED")) && !existsSync(join(run, "PWNED2")), "a key's name never runs as a command");

/* ---------------- Stopped mid-step: it picks up with what really happened ---------------- */

answers.push(() => response("resp_s1", [{ id: "fc_s1", type: "function_call", call_id: "call_s1", name: "run_command", arguments: JSON.stringify({ command: "make-report", timeout_seconds: 60 }) }]));
let stopping;
onCommand = () => {
  // Stop is pressed while the command runs: it finishes, and its answer is kept for when the task picks up.
  X.stopSession(stopping);
  return { output: "report ready", exit_code: 0 };
};
const before = asked.length;
const started = X.startSession({ botId: main.id, goal: "Make another report", title: "Another report", where: "cloud", fresh: true });
stopping = started.id;
s = await ended(started.id);
assert.equal(s.status, "failed");
assert.equal(s.error, "Stopped by you");
assert.equal(asked.length, before + 1, "nothing more was asked after Stop");
assert.deepEqual(s.owed, [{ id: "call_s1", type: "function", output: "exit code 0\nreport ready" }]);
answers.push(() => response("resp_s2", [said("Done, it's in /workspace.")]));
X.replyToSession(started.id, "go on");
await until(() => S.session(started.id).status === "done", "the thread to pick up and finish");
const picked = asked.at(-1);
assert.equal(picked.previous_response_id, "resp_s1");
assert.deepEqual(picked.input[0], { type: "function_call_output", call_id: "call_s1", output: "exit code 0\nreport ready" }, "the command's real answer, not that it didn't run");
assert.match(userText(picked), /^go on/);
assert.equal(S.session(started.id).owed, undefined);

/* ---------------- A step OpenAI flags waits for the user's OK ---------------- */

const check = { id: "cu_sc_1", code: "malicious_instructions", message: "The page asks you to do something the user didn't." };
let flagged;
answers.push(() => {
  // The user writes in the thread while the step is being decided: before they could see the question.
  X.replyToSession(flagged, "also check the prices");
  return response("resp_f1", [{ id: "cu_f1", type: "computer_call", call_id: "call_f1", status: "completed", actions: [{ type: "click", x: 300, y: 400, button: "left", keys: null }], pending_safety_checks: [check] }]);
});
const scripts = bash.length;
const flaggedAt = asked.length;
const f = X.startSession({ botId: main.id, goal: "Book the table", title: "Table", where: "cloud", fresh: true });
flagged = f.id;
s = await ended(f.id);
assert.equal(s.status, "done", `it stopped to ask (${s.error ?? ""})`);
assert.match(s.answer, /need your OK/);
assert.match(s.answer, /The page asks you to do something/);
assert.ok(!s.answer.includes("—"), "no dashes");
assert.ok(!bash.slice(scripts).some((c) => c.includes("mousemove 300 400")), "the flagged step wasn't done");
await sleep(300);
assert.equal(asked.length, flaggedAt + 1, "the reply sent before the question didn't answer it");
assert.equal(S.session(f.id).status, "done");
answers.push((b) => {
  assert.deepEqual(b.input[0].acknowledged_safety_checks, [check], "acknowledged, now the user has answered");
  return response("resp_f2", [said("Booked for 8pm.")]);
});
X.replyToSession(f.id, "go on");
await until(() => S.session(f.id).status === "done" && asked.length === flaggedAt + 2, "the flagged thread to go on");
const okd = asked.at(-1);
assert.equal(okd.previous_response_id, "resp_f1");
assert.equal(okd.input[0].type, "computer_call_output");
assert.equal(okd.input[0].call_id, "call_f1");
assert.match(userText(okd), /^also check the prices\ngo on/, "both replies reach it");
assert.equal(S.session(f.id).answer, "Booked for 8pm.");

/* ---------------- A reply while it works steers it: it goes in with the next step ---------------- */

let steered;
answers.push(
  () => response("resp_t1", [{ id: "fc_t1", type: "function_call", call_id: "call_t1", name: "run_command", arguments: JSON.stringify({ command: "fetch-prices", timeout_seconds: 60 }) }]),
  () => response("resp_t2", [said("Saved prices.csv.")]),
);
onCommand = () => {
  // The user changes their mind while the command runs.
  X.replyToSession(steered, "make it a CSV, not a PDF");
  return { output: "prices fetched", exit_code: 0 };
};
const steerAt = asked.length;
const st = X.startSession({ botId: main.id, goal: "Get the prices as a PDF", title: "Prices", where: "cloud", fresh: true });
steered = st.id;
s = await ended(st.id);
assert.equal(s.status, "done", `it finished (${s.error ?? ""})`);
assert.equal(asked.length, steerAt + 2, "one turn: the reply went into it, not into a turn of its own after");
const withReply = asked[steerAt + 1];
assert.equal(withReply.previous_response_id, "resp_t1");
assert.deepEqual(withReply.input[0], { type: "function_call_output", call_id: "call_t1", output: "exit code 0\nprices fetched" }, "the step's answer first");
assert.deepEqual(withReply.input.at(-1), { role: "user", content: [{ type: "input_text", text: "make it a CSV, not a PDF" }] }, "then the reply");
assert.ok(s.replies.filter((r) => r.role === "user").every((r) => r.delivered), "marked sent");
assert.equal(s.answer, "Saved prices.csv.");

// A step that fails with the reply in it leaves the reply unsent, for the thread's next turn.
answers.push(
  () => response("resp_u1", [{ id: "fc_u1", type: "function_call", call_id: "call_u1", name: "run_command", arguments: JSON.stringify({ command: "fetch-prices", timeout_seconds: 60 }) }]),
  () => json({ error: { message: "Bad request." } }, 400),
);
const un = X.startSession({ botId: main.id, goal: "Get the prices again", title: "Prices again", where: "cloud", fresh: true });
steered = un.id;
s = await ended(un.id);
assert.equal(s.status, "failed");
assert.equal(s.replies.find((r) => r.text === "make it a CSV, not a PDF")?.delivered, false, "not lost: the next turn gets it");

/* ---------------- A task on a computer that's asleep ---------------- */

// Free's computer, asleep after 15 minutes nobody used it: Orgo answers a read of its screens from its record
// rather than wake it. The task says the computer is in use before its first look, so that look wakes it, and
// no screen is made on top of the ones it has.
Object.assign(pc, { status: "suspended", activeAt: Date.now() - 16 * 60_000 });
answers.push(() => response("resp_a1", [said("Your inbox is clear.")]));
const sinceAsleep = orgoCalls.length;
const commandsBefore = bash.length;
const woke = await task("Check the inbox", "Inbox");
assert.equal(S.session(woke).status, "done", `it finished (${S.session(woke).error ?? ""})`);
const sinceThen = orgoCalls.slice(sinceAsleep);
const saidInUse = sinceThen.indexOf("POST /bops/computer/active");
const firstLook = sinceThen.indexOf(`GET /computers/${COMPUTER}/screens`);
assert.ok(saidInUse >= 0 && firstLook > saidInUse, `said to be in use before its first look: ${sinceThen.slice(0, 4).join(", ")}`);
assert.equal(pc.status, "running", "woken by that look");
assert.ok(!sinceThen.includes(`POST /computers/${COMPUTER}/screens`), "no screen made");
assert.ok(!bash.slice(commandsBefore).includes("true"), "nothing else needed to wake it");
assert.equal(S.session(woke).answer, "Your inbox is clear.");

// It fell asleep mid-task (Orgo answered a screenshot with 409 computer_asleep): an action wakes it, and the
// screenshot is taken again, once. The task carries on.
answers.push(
  () => response("resp_z1", [{ id: "cu_z", type: "computer_call", call_id: "call_z", status: "completed", actions: [{ type: "screenshot" }] }]),
  () => response("resp_z2", [said("All quiet.")]),
);
pc.shot409 = true;
const sinceShot = orgoCalls.length;
const bashBefore = bash.length;
const dozed = await task("Look at the screen", "Look");
assert.equal(S.session(dozed).status, "done", `it finished (${S.session(dozed).error ?? ""})`);
const shots = orgoCalls.slice(sinceShot).filter((c) => c === `GET /computers/${COMPUTER}/screenshot`).length;
assert.equal(shots, 2, "the screenshot taken again once it woke");
assert.ok(bash.slice(bashBefore).includes("true"), "woken by an action");
assert.equal(pc.status, "running");
const zshot = asked.at(-1).input.find((i) => i.type === "computer_call_output");
assert.equal(zshot?.output.type, "computer_screenshot", "the model got the screen");

/* ---------------- AI credit used up ---------------- */

answers.push(() => json({ error: { message: "You're out of AI credit.", code: "ai_credit_empty" }, code: "ai_credit_empty", upgrade: true }, 402));
const out = await task("Find a flight", "Flight");
s = S.session(out);
assert.equal(s.status, "failed");
assert.equal(s.error, Cl.OUT_OF_CREDIT, "told apart from any other error (its 402 isn't lost on the way)");
assert.ok(S.getState().messages.some((m) => m.text === Cl.OUT_OF_CREDIT && m.resultOf === out), "the chat says so, with Upgrade");
assert.ok(!S.getState().messages.some((m) => m.resultOf === out && m.text.startsWith("I couldn't finish")), "not as a failure");

assert.equal(answers.length, 0, "every answer was asked for");
console.log("computer task: ok");
process.exit(0);
