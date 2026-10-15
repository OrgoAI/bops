// Tests for model routing (lib/server/routing.ts, presence.ts, models.ts): speed by rule (Ultrafast
// for someone waiting on Sol or Astra, Fast on Luna, standard for nobody; BOPS_SPEED caps it), the
// fallback a tier down when OpenAI turns a tier down, the tier table, Jev's answers into a tier (a
// costly mistake a tier up), a task's route with the router off, in shadow and on (and a bot's own
// setting kept), tiers up after a failure, a chat turn's route, the shadow log, and who's watching.
// Jev and OpenAI are fakes and the state lives in a throwaway folder: nothing reaches a real service.
// Usage: node --conditions=react-server scripts/test-routing.mjs
import assert from "node:assert/strict";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { registerHooks } from "node:module";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { pathToFileURL } from "node:url";

for (const k of Object.keys(process.env)) if (/^(BOPS|OPENAI|AGENTPHONE|AGENTMAIL|HONCHO|COMPOSIO|TYPESAFE|TWILIO|ORGO|CODEX|TAILSCALE|TREG)_/.test(k)) delete process.env[k];
process.env.BOPS_SELF_HOSTED = "1";
process.env.OPENAI_API_KEY = "sk-test-routing";
process.env.TYPESAFE_API_KEY = "ts-test-routing";
const root = new URL("..", import.meta.url).pathname.replace(/\/$/, "");
const scratch = mkdtempSync(join(tmpdir(), "bops-test-routing-"));
const bin = join(scratch, "bin");
mkdirSync(bin);
writeFileSync(join(bin, "security"), "#!/bin/sh\nexit 44\n", { mode: 0o755 });
process.env.PATH = `${bin}:${process.env.PATH}`;
process.env.HOME = join(scratch, "home");
mkdirSync(process.env.HOME);
const work = join(scratch, "work");
mkdirSync(work);
process.chdir(work);

const STAND_INS = new Set(["mac", "relay", "desktop", "mirror"]);
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

/* ---------------- Jev and OpenAI: fakes ---------------- */

const json = (obj, status = 200) => new Response(JSON.stringify(obj), { status, headers: { "content-type": "application/json" } });
/** What Jev answers next (a function of the questions asked), and every call it got. */
let jevAnswers = () => ({});
const jevAsked = [];
const asked = [];
const answers = [];
const response = (id, output) => ({ id, object: "response", model: "gpt-test", status: "completed", output, usage: { input_tokens: 100, output_tokens: 10, input_tokens_details: { cached_tokens: 0 }, output_tokens_details: { reasoning_tokens: 0 } } });
const said = (text) => ({ id: `msg_${text.length}`, type: "message", role: "assistant", content: [{ type: "output_text", text, annotations: [] }] });
globalThis.fetch = async (input, init) => {
  const req = new Request(input, init);
  const url = new URL(req.url);
  if (url.origin === "https://api.typesafe.ai" && url.pathname === "/v1/systemone") {
    const b = JSON.parse(await req.text());
    jevAsked.push(b);
    return json({ answers: jevAnswers(b.questions), model: "jev-latest", usage: { input_tokens: 50 } });
  }
  if (url.origin === "https://api.openai.com" && url.pathname === "/v1/responses") {
    const b = JSON.parse(await req.text());
    asked.push(b);
    const next = answers.shift();
    return next ? next(b) : json(response(`resp_${asked.length}`, [said("Done.")]));
  }
  throw new TypeError(`fetch failed (the test is offline: ${url.host})`);
};
const warned = [];
console.warn = (...a) => warned.push(a.join(" "));

const M = await import(`${root}/lib/server/models.ts`);
const R = await import(`${root}/lib/server/routing.ts`);
const P = await import(`${root}/lib/server/presence.ts`);
const S = await import(`${root}/lib/server/store.ts`);
const Chat = await import(`${root}/lib/server/chat.ts`);
const { botChatId } = await import(`${root}/lib/types.ts`);

/** Jev's answers: a difficulty (the most likely choice and how sure), and the noul questions' probabilities. */
const jev = ({ difficulty, sure = 0.8, stakes = 0.1, long = 0.1, hard = 0.1, oneShot = 0.1 }) => () => ({
  hard: { type: "noul", noul: hard },
  difficulty: { type: "choice", choice: difficulty, confidence: sure, probabilities: { [difficulty]: sure } },
  stakes: { type: "noul", noul: stakes },
  long: { type: "noul", noul: long },
  one_shot: { type: "noul", noul: oneShot },
});

/* ---------------- Settings: blank is not set ---------------- */

process.env.BOPS_X_MODEL = "   ";
process.env.BOPS_Y_MODEL = " gpt-y ";
assert.equal(M.setting("gpt-default", "BOPS_X_MODEL"), "gpt-default", "blank is not set");
assert.equal(M.setting("gpt-default", "BOPS_X_MODEL", "BOPS_Y_MODEL"), "gpt-y", "the first one set, trimmed");
assert.equal(M.setting("gpt-default", "BOPS_NOT_THERE"), "gpt-default");
assert.equal(R.SOL(), "gpt-6.1-sol");
assert.equal(R.ASTRA(), "gpt-6-astra");
assert.equal(R.LIGHT(), "gpt-6-luna");

/* ---------------- Speed ---------------- */

assert.equal(R.speedFor("gpt-6.1-sol", true), "ultrafast");
assert.equal(R.speedFor("gpt-6-astra", true), "ultrafast");
assert.equal(R.speedFor("gpt-6-luna", true), "fast", "Luna has no Ultrafast");
assert.equal(R.speedFor("gpt-6-sol", true), "fast", "nor the older 6-Sol");
assert.equal(R.speedFor("gpt-6.1-sol", false), "default", "nobody waiting: standard");
process.env.BOPS_SPEED = "fast";
assert.equal(R.speedFor("gpt-6.1-sol", true), "fast", "capped at Fast");
process.env.BOPS_SPEED = "standard";
assert.equal(R.speedFor("gpt-6.1-sol", true), "default", "capped at standard");
delete process.env.BOPS_SPEED;
assert.deepEqual(R.tierParam("default"), {}, "standard says nothing");
assert.deepEqual(R.tierParam("ultrafast"), { service_tier: "ultrafast" });

// A tier OpenAI turns down (its rate limit, or a 400 naming it) falls back a tier; anything else is thrown.
const refused = (status, message = "rate limited") => Object.assign(new Error(message), { status });
let tried = [];
let out = await R.withSpeed("ultrafast", async (tier, last) => {
  tried.push([tier, last]);
  if (tier !== "default") throw refused(429);
  return "ok";
});
assert.equal(out, "ok");
assert.deepEqual(tried, [["ultrafast", false], ["fast", false], ["default", true]]);
tried = [];
out = await R.withSpeed("ultrafast", async (tier) => {
  tried.push(tier);
  if (tier === "ultrafast") throw refused(400, "service_tier 'ultrafast' isn't available for this request");
  return tier;
});
assert.deepEqual([out, tried], ["fast", ["ultrafast", "fast"]]);
await assert.rejects(R.withSpeed("ultrafast", async () => { throw refused(402, "Out of AI credit"); }), /Out of AI credit/, "other errors aren't a tier's");
await assert.rejects(R.withSpeed("default", async () => { throw refused(429); }), /rate limited/, "standard is the last try");
tried = [];
await R.withSpeed("fast", async (tier, last) => (tried.push([tier, last]), "x"));
assert.deepEqual(tried, [["fast", false]], "the first tier that answers");

/* ---------------- The tier table ---------------- */

assert.deepEqual(R.configFor("quick"), { model: "gpt-6.1-sol", effort: "low" });
assert.deepEqual(R.configFor("standard"), { model: "gpt-6.1-sol", effort: "medium" });
assert.deepEqual(R.configFor("deep"), { model: "gpt-6.1-sol", effort: "high" });
assert.deepEqual(R.configFor("deep", { long: true }), { model: "gpt-6.1-sol", effort: "xhigh" });
assert.deepEqual(R.configFor("max"), { model: "gpt-6-astra", effort: "high" });
assert.deepEqual(R.configFor("max", { long: true, oneShot: true }), { model: "gpt-6-astra", effort: "xhigh", mode: "pro" });
assert.equal(R.up("quick"), "standard");
assert.equal(R.up("max"), "max", "never past max");
assert.equal(R.up("quick", 5), "max");

// Jev's answers into a tier: the most likely difficulty, a tier up for a costly mistake; nothing when it didn't answer.
const ans = (o) => jev(o)();
assert.equal(R.tierFrom(ans({ difficulty: "standard" })).tier, "standard");
assert.equal(R.tierFrom(ans({ difficulty: "standard", stakes: 0.7 })).tier, "deep");
assert.equal(R.tierFrom(ans({ difficulty: "max", stakes: 0.9 })).tier, "max");
assert.equal(R.tierFrom(ans({ difficulty: "deep", long: 0.8 })).long, true);
assert.match(R.tierFrom(ans({ difficulty: "deep", sure: 0.61, stakes: 0.7 })).why, /^deep \(61%\), costly mistakes \(70%\)$/);
assert.equal(R.tierFrom(null), null);
assert.equal(R.tierFrom({ difficulty: { type: "choice", choice: "huge", confidence: 1, probabilities: {} } }), null, "a choice it wasn't offered");

/* ---------------- A task's route ---------------- */

// A bot set to low, medium or high: that, and Jev isn't asked. High is Astra, as it always was.
jevAsked.length = 0;
assert.deepEqual(await R.routeTask("high", "Anything"), { by: "setting", model: "gpt-6-astra", effort: "high" });
assert.deepEqual(await R.routeTask("low", "Anything"), { by: "setting", model: "gpt-6.1-sol", effort: "low" });
assert.equal(jevAsked.length, 0);

// Shadow (the default): one Jev call asks the old question and the router's; the old rule runs, the router's pick is kept.
jevAnswers = jev({ difficulty: "deep", hard: 0.4 });
let r = await R.routeTask("auto", "Compare three CRMs for a 5-person agency");
assert.equal(jevAsked.length, 1, "one call");
assert.deepEqual(Object.keys(jevAsked[0].questions).sort(), ["difficulty", "hard", "long", "stakes"]);
assert.deepEqual([r.by, r.model, r.effort], ["rule", "gpt-6-astra", "high"], "the old rule: hard at 0.3 or more is Astra");
assert.deepEqual(r.router, { model: "gpt-6.1-sol", effort: "high", tier: "deep", why: "deep (80%)" }, "what the router would pick");
jevAnswers = jev({ difficulty: "quick", hard: 0.03 });
r = await R.routeTask(undefined, "Top story on Hacker News");
assert.deepEqual([r.by, r.model, r.effort, r.router.tier, r.router.effort], ["rule", "gpt-6.1-sol", "medium", "quick", "low"]);

// On: the router's pick runs (never pro mode in a task: it would pay on every step).
process.env.BOPS_ROUTER = "on";
jevAnswers = jev({ difficulty: "max", oneShot: 0.9, hard: 0.9 });
r = await R.routeTask("auto", "Write the board memo on our pricing change");
assert.deepEqual([r.by, r.model, r.effort, r.tier, r.router.mode], ["router", "gpt-6-astra", "high", "max", undefined]);
jevAnswers = jev({ difficulty: "deep", long: 0.9 });
r = await R.routeTask("auto", "Research every competitor's pricing page");
assert.deepEqual([r.model, r.effort, r.long], ["gpt-6.1-sol", "xhigh", true]);
// Jev didn't answer: the old rule's no-answer, medium on Sol.
jevAnswers = () => ({});
r = await R.routeTask("auto", "Anything");
assert.deepEqual([r.by, r.model, r.effort], ["rule", "gpt-6.1-sol", "medium"]);

// Off: only the old question, nothing logged as the router's.
process.env.BOPS_ROUTER = "off";
jevAsked.length = 0;
jevAnswers = jev({ difficulty: "deep", hard: 0.5 });
r = await R.routeTask("auto", "Anything");
assert.deepEqual(Object.keys(jevAsked[0].questions), ["hard"]);
assert.deepEqual([r.by, r.model, r.router], ["rule", "gpt-6-astra", undefined]);
delete process.env.BOPS_ROUTER;

// Tiers up: each bump on the router's route runs a tier harder; the old rule and a bot's setting stay as they are.
assert.deepEqual(R.taskConfig({ by: "router", model: "gpt-6.1-sol", effort: "medium", tier: "standard", bumps: 1 }), { model: "gpt-6.1-sol", effort: "high" });
assert.deepEqual(R.taskConfig({ by: "router", model: "gpt-6.1-sol", effort: "medium", tier: "standard", bumps: 2 }), { model: "gpt-6-astra", effort: "high" });
assert.deepEqual(R.taskConfig({ by: "router", model: "gpt-6.1-sol", effort: "high", tier: "deep", bumps: 1, long: true }), { model: "gpt-6-astra", effort: "xhigh" });
assert.deepEqual(R.taskConfig({ by: "rule", model: "gpt-6.1-sol", effort: "medium", bumps: 3 }), { model: "gpt-6.1-sol", effort: "medium" });
assert.equal(R.taskConfig(undefined), undefined);
for (const t of ["try again", "That's wrong", "thats not right", "not what I asked", "please redo it", "Look again"]) assert.ok(R.ASKS_AGAIN.test(t), t);
for (const t of ["thanks", "great, now book it", "again tomorrow?"]) assert.ok(!R.ASKS_AGAIN.test(t), t);

/* ---------------- A chat turn's route ---------------- */

const base = { model: "gpt-6.1-sol", effort: "low" };
jevAnswers = jev({ difficulty: "max", oneShot: 0.9 });
let c = await R.routeChat(base, "Analyze this contract and tell me the three riskiest clauses");
assert.deepEqual(c.config, base, "shadow: the chat as it was");
assert.deepEqual(c.router, { model: "gpt-6-astra", effort: "high", mode: "pro", tier: "max", why: "max (80%), one hard answer" });
process.env.BOPS_ROUTER = "on";
c = await R.routeChat(base, "Analyze this contract and tell me the three riskiest clauses");
assert.deepEqual(c.config, { model: "gpt-6-astra", effort: "high", mode: "pro" }, "on: Astra, pro mode, for one hard answer");
jevAnswers = jev({ difficulty: "quick" });
c = await R.routeChat(base, "thanks!");
assert.deepEqual(c.config, base, "quick is the chat as it is");
delete process.env.BOPS_ROUTER;

/* ---------------- Who's watching ---------------- */

assert.equal(P.watching({ id: "s1", chatId: "bot:a" }), false, "nothing said yet");
P.setView({ chatId: "bot:a", threadId: "s1", focused: true });
assert.equal(P.watching({ id: "s1", chatId: "bot:a" }), true, "its thread is open");
assert.equal(P.watching({ id: "s2", chatId: "bot:a" }), false, "another thread is open");
P.setView({ chatId: "bot:a", focused: true });
assert.equal(P.watching({ id: "s2", chatId: "bot:a" }), true, "its chat is open, no thread");
assert.equal(P.watching({ id: "s3", chatId: "bot:b" }), false, "another chat");
P.setView({ chatId: "bot:a", threadId: "s1", focused: false });
assert.equal(P.watching({ id: "s1", chatId: "bot:a" }), false, "the window isn't in front");
P.setView({ chatId: "bot:a", threadId: "s1", focused: true });
const realNow = Date.now;
Date.now = () => realNow() + 21_000;
assert.equal(P.watching({ id: "s1", chatId: "bot:a" }), false, "not heard from in 20 seconds: stale");
Date.now = realNow;

/* ---------------- In a chat turn: speed, the route and its log ---------------- */

S.update((s) => (s.owner = { name: "Alex" }));
const chatId = botChatId("boppy");
jevAnswers = jev({ difficulty: "deep" });
answers.push(() => json(response("resp_c1", [said("Here's the plan.")])));
let n0 = asked.length;
await Chat.handleMessage(chatId, "Plan my week around three client calls");
const first = asked[n0];
assert.equal(first.service_tier, "ultrafast", `the user's own message runs on Ultrafast (${warned.join(" | ")})`);
assert.deepEqual([first.model, first.reasoning], ["gpt-6.1-sol", { effort: "low" }], "shadow: the chat as it was");
const log = join(S.userHome(), "routes.jsonl");
await new Promise((r) => setTimeout(r, 50));
assert.ok(existsSync(log), "the shadow log");
const line = JSON.parse(readFileSync(log, "utf8").trim().split("\n").at(-1));
assert.deepEqual([line.kind, line.chatId, line.ran.model, line.router.tier, line.router.effort], ["chat", chatId, "gpt-6.1-sol", "deep", "high"]);
assert.match(line.words, /Plan my week/);

// Ultrafast busy: the same turn falls back to Fast, then answers.
answers.push(
  () => json({ error: { message: "Rate limit reached for ultrafast" } }, 429),
  () => json(response("resp_c2", [said("Done.")])),
);
n0 = asked.length;
await Chat.handleMessage(chatId, "And move Friday's call to Monday");
assert.deepEqual(asked.slice(n0).map((b) => b.service_tier), ["ultrafast", "fast"], "a tier down, at once");
assert.equal(S.getState().messages.filter((m) => m.chatId === chatId).at(-1).text, "Done.");

// On: the router's pick runs in the chat.
process.env.BOPS_ROUTER = "on";
jevAnswers = jev({ difficulty: "max", oneShot: 0.9 });
answers.push(() => json(response("resp_c3", [said("The riskiest clauses are…")])));
n0 = asked.length;
await Chat.handleMessage(chatId, "Analyze this contract and tell me the riskiest clauses");
assert.deepEqual([asked[n0].model, asked[n0].reasoning, asked[n0].service_tier], ["gpt-6-astra", { effort: "high", mode: "pro" }, "ultrafast"]);
delete process.env.BOPS_ROUTER;

// Someone else's text: nobody's waiting on it (standard), and Jev isn't asked to route it.
const text = S.addMessage({ chatId, role: "system", text: "Hi, is this Acme?", sms: { dir: "in", from: "+15551234567", to: "+15550000000" } });
const jevBefore = jevAsked.length;
n0 = asked.length;
await Chat.outsideNews("boppy", text.id, "A text");
assert.equal(asked[n0].service_tier, undefined, "standard");
assert.ok(!jevAsked.slice(jevBefore).some((b) => "one_shot" in b.questions), "no route asked");

/* ---------------- The comparison runs' endpoints ---------------- */

const post = async (mod, body) => {
  const res = await mod.POST(new Request("http://localhost:3210/x", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(body) }));
  return { status: res.status, body: await res.json() };
};
// What Bops would run a task on: the old rule's pick and the router's, whatever BOPS_ROUTER says.
process.env.BOPS_ROUTER = "off";
const RouteApi = await import(`${root}/app/api/route/route.ts`);
jevAnswers = jev({ difficulty: "deep", hard: 0.5 });
let res = await post(RouteApi, { goal: "Compare three CRMs" });
assert.deepEqual(res.body, { rule: { model: "gpt-6-astra", effort: "high" }, router: { model: "gpt-6.1-sol", effort: "high", tier: "deep", why: "deep (80%)" } });
assert.equal((await post(RouteApi, {})).status, 400);
delete process.env.BOPS_ROUTER;

// A task started on a set configuration: checked, kept on the session as forced, and always a new thread.
const SessionsApi = await import(`${root}/app/api/sessions/route.ts`);
assert.equal((await post(SessionsApi, { botId: "boppy", goal: "x", model: "gpt 6; rm" })).status, 400, "not a model name");
assert.equal((await post(SessionsApi, { botId: "boppy", goal: "x", model: "gpt-6.1-sol", effort: "huge" })).status, 400);
assert.equal((await post(SessionsApi, { botId: "boppy", goal: "x", model: "gpt-6.1-sol", speed: "warp" })).status, 400);
res = await post(SessionsApi, { botId: "boppy", goal: "Grid case", title: "Grid: a", model: "gpt-6-astra", effort: "xhigh", speed: "ultrafast" });
assert.equal(res.status, 200);
assert.deepEqual(S.session(res.body.id).route, { by: "forced", model: "gpt-6-astra", effort: "xhigh", speed: "ultrafast" });
assert.equal(S.session(res.body.id).effort, "xhigh");
const again = await post(SessionsApi, { botId: "boppy", goal: "Grid case", title: "Grid: a", model: "gpt-6-astra", effort: "xhigh" });
assert.notEqual(again.body.id, res.body.id, "the same goal again is a new thread, not the one running");
for (const id of [res.body.id, again.body.id]) (await import(`${root}/lib/server/sessions.ts`)).stopSession(id);

// The grader: pass or fail and why, from a strong model; an empty answer fails without asking.
const JudgeApi = await import(`${root}/app/api/judge/route.ts`);
answers.push((b) => {
  assert.deepEqual([b.model, b.reasoning, b.text.format.name], ["gpt-6.1-sol", { effort: "high" }, "grade"]);
  assert.match(b.input, /"rubric":"Says A6 shows 15/);
  return json(response("resp_j", [said(JSON.stringify({ pass: true, why: "It says A6 shows 15 and the file was saved." }))]));
});
res = await post(JudgeApi, { task: "Make a sheet", rubric: "Says A6 shows 15.", answer: "A6 shows 15. Saved /workspace/bench.ods." });
assert.deepEqual(res.body, { pass: true, why: "It says A6 shows 15 and the file was saved." });
const n1 = asked.length;
res = await post(JudgeApi, { task: "Make a sheet", rubric: "Says A6 shows 15.", answer: "  " });
assert.deepEqual([res.body.pass, asked.length], [false, n1], "nothing to grade");
assert.equal((await post(JudgeApi, { answer: "x" })).status, 400);

rmSync(scratch, { recursive: true, force: true });
console.log("routing: all tests passed");
process.exit(0);
