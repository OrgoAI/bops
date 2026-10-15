// Tests for a task's fast steps over a WebSocket (lib/server/responses-ws.ts, computer-task.ts): a step
// is a `response.create` and its answer the finished response; a step OpenAI turns down throws with its
// status (a busy tier falls back), Bops Cloud's credit refusals as its own errors; a socket that won't
// open or drops mid-step throws a TransportError (the step goes over HTTP); a step that hangs times out,
// and Stop stops it. Then a real turn: its Ultrafast step turned down, the same socket carries it on Fast,
// and the socket closes with the turn; a socket that's refused leaves the step to HTTP. Self-hosted, with
// a fake OpenAI on this Mac (OPENAI_BASE_URL): nothing reaches a real service.
// Usage: node --conditions=react-server scripts/test-responses-ws.mjs
import assert from "node:assert/strict";
import { createServer } from "node:http";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { registerHooks } from "node:module";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { pathToFileURL } from "node:url";
import { WebSocketServer } from "ws";

for (const k of Object.keys(process.env)) if (/^(BOPS|OPENAI|AGENTPHONE|AGENTMAIL|HONCHO|COMPOSIO|TYPESAFE|TWILIO|ORGO|CODEX|TAILSCALE|TREG)_/.test(k)) delete process.env[k];
process.env.BOPS_SELF_HOSTED = "1";
process.env.OPENAI_API_KEY = "sk-test-ws";
const root = new URL("..", import.meta.url).pathname.replace(/\/$/, "");
const scratch = mkdtempSync(join(tmpdir(), "bops-test-ws-"));
const bin = join(scratch, "bin");
mkdirSync(bin);
writeFileSync(join(bin, "security"), "#!/bin/sh\nexit 44\n", { mode: 0o755 });
process.env.PATH = `${bin}:${process.env.PATH}`;
process.env.HOME = join(scratch, "home");
mkdirSync(process.env.HOME);
globalThis.bopsOrgoKey = "sk_orgo_test_ws";
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

/* ---------------- A fake OpenAI: WebSocket mode, and HTTP for what falls back ---------------- */

const response = (id, output, tier = "default") => ({ id, object: "response", model: "gpt-6.1-sol", status: "completed", service_tier: tier, output, usage: { input_tokens: 100, output_tokens: 10, input_tokens_details: { cached_tokens: 0 }, output_tokens_details: { reasoning_tokens: 0 } } });
const said = (text) => ({ id: `msg_${text.length}`, type: "message", role: "assistant", phase: "final_answer", content: [{ type: "output_text", text, annotations: [] }] });
/** Each connection (its headers), each `response.create` it got, and how the fake answers it (a function of the event and the socket). */
const connections = [];
let onCreate = (e, ws) => ws.send(JSON.stringify({ type: "response.completed", response: response("resp_1", [said("Hi.")], e.service_tier) }));
let refuseUpgrade = false;
const http = createServer((req, res) => {
  // HTTP: what falls back when the socket is refused. Answered as a plain JSON response.
  let body = "";
  req.on("data", (c) => (body += c));
  req.on("end", () => {
    httpCalls.push(JSON.parse(body || "{}"));
    res.writeHead(200, { "content-type": "application/json" });
    res.end(JSON.stringify(response("resp_http", [said("Over HTTP.")], JSON.parse(body || "{}").service_tier)));
  });
});
const httpCalls = [];
const wss = new WebSocketServer({ noServer: true });
http.on("upgrade", (req, socket, head) => {
  if (refuseUpgrade || req.url !== "/v1/responses") return socket.end("HTTP/1.1 401 Unauthorized\r\n\r\n");
  wss.handleUpgrade(req, socket, head, (ws) => {
    const conn = { headers: req.headers, creates: [], closed: false };
    connections.push(conn);
    ws.on("message", (data) => {
      const e = JSON.parse(String(data));
      conn.creates.push(e);
      onCreate(e, ws);
    });
    ws.on("close", () => (conn.closed = true));
  });
});
await new Promise((r) => http.listen(0, "127.0.0.1", r));
process.env.OPENAI_BASE_URL = `http://127.0.0.1:${http.address().port}/v1`;
const warned = [];
console.warn = (...a) => warned.push(a.join(" "));

const W = await import(`${root}/lib/server/responses-ws.ts`);
const { CloudError, outOfCredits } = await import(`${root}/lib/server/cloud.ts`);
const S = await import(`${root}/lib/server/store.ts`);
const CT = await import(`${root}/lib/server/computer-task.ts`);
const { APIConnectionTimeoutError } = await import("openai");
const until = async (check, what) => {
  for (let i = 0; i < 200; i++) {
    if (check()) return;
    await new Promise((r) => setTimeout(r, 10));
  }
  assert.fail(`timed out waiting for ${what}`);
};

/* ---------------- The socket ---------------- */

// A step: response.create with the body a POST would have; its answer is the finished response, whatever came before it.
onCreate = (e, ws) => {
  ws.send(JSON.stringify({ type: "response.created", response: { id: "resp_a", status: "in_progress" } }));
  ws.send(JSON.stringify({ type: "response.output_text.delta", delta: "Hi" }));
  ws.send(JSON.stringify({ type: "response.completed", response: response("resp_a", [said("Hi.")], e.service_tier) }));
};
let socket = await W.ResponsesSocket.open("boppy");
assert.equal(socket.open, true);
assert.equal(connections[0].headers.authorization, "Bearer sk-test-ws", "self-hosting: on OPENAI_API_KEY");
let r = await socket.create({ model: "gpt-6.1-sol", input: [{ role: "user", content: "hi" }], previous_response_id: "resp_0", service_tier: "ultrafast" }, { timeoutMs: 5000 });
assert.deepEqual([r.id, r.service_tier, r.output[0].content[0].text], ["resp_a", "ultrafast", "Hi."]);
assert.deepEqual(connections[0].creates[0], { type: "response.create", model: "gpt-6.1-sol", input: [{ role: "user", content: "hi" }], previous_response_id: "resp_0", service_tier: "ultrafast" });
// An incomplete response is an answer too (as over HTTP).
onCreate = (e, ws) => ws.send(JSON.stringify({ type: "response.incomplete", response: { ...response("resp_b", []), status: "incomplete" } }));
assert.equal((await socket.create({ model: "m" }, { timeoutMs: 5000 })).status, "incomplete");

// Turned down: a busy tier (its status, so it falls back), a failed response, and Bops Cloud's credit refusals as its errors.
onCreate = (e, ws) => ws.send(JSON.stringify({ type: "error", status: 429, error: { type: "rate_limit_error", code: "rate_limit_exceeded", message: "Rate limit reached for ultrafast" } }));
let err = await socket.create({ model: "m" }, { timeoutMs: 5000 }).catch((e) => e);
assert.deepEqual([err.status, err.message, err instanceof W.TransportError], [429, "Rate limit reached for ultrafast", false]);
onCreate = (e, ws) => ws.send(JSON.stringify({ type: "error", error: { code: "rate_limit_exceeded", message: "slow down" } }));
assert.equal((await socket.create({ model: "m" }, { timeoutMs: 5000 }).catch((e) => e)).status, 429, "no status said: a rate limit by its code");
onCreate = (e, ws) => ws.send(JSON.stringify({ type: "response.failed", response: { id: "resp_f", status: "failed", error: { message: "server_error" } } }));
assert.equal((await socket.create({ model: "m" }, { timeoutMs: 5000 }).catch((e) => e)).message, "server_error");
onCreate = (e, ws) => ws.send(JSON.stringify({ type: "error", status: 402, error: { type: "invalid_request_error", code: "ai_credit_empty", message: "Out of AI credit" } }));
err = await socket.create({ model: "m" }, { timeoutMs: 5000 }).catch((e) => e);
assert.ok(err instanceof CloudError && err.status === 402 && err.code === "ai_credit_empty", "Bops Cloud's credit refusal");
assert.equal(outOfCredits(err), true, "read as AI credit used up, as a POST's 402 is");
// One step at a time; the socket still works after a refusal.
onCreate = (e, ws) => setTimeout(() => ws.send(JSON.stringify({ type: "response.completed", response: response("resp_c", []) })), 50);
const first = socket.create({ model: "m" }, { timeoutMs: 5000 });
assert.match((await socket.create({ model: "m" }, { timeoutMs: 5000 }).catch((e) => e)).message, /One step at a time/);
assert.equal((await first).id, "resp_c");

// A step that hangs times out (the turn's "stuck"), and Stop stops one.
onCreate = () => {};
err = await socket.create({ model: "m" }, { timeoutMs: 100 }).catch((e) => e);
assert.ok(err instanceof APIConnectionTimeoutError, "timed out as the SDK would");
const ac = new AbortController();
const stopping = socket.create({ model: "m" }, { timeoutMs: 5000, signal: ac.signal });
ac.abort();
assert.equal((await stopping.catch((e) => e)).message, "Stopped");
// Dropped mid-step: a TransportError (the step wasn't answered), and the socket is no longer open.
onCreate = (e, ws) => ws.close();
err = await socket.create({ model: "m" }, { timeoutMs: 5000 }).catch((e) => e);
assert.ok(err instanceof W.TransportError);
assert.equal(socket.open, false);
assert.ok((await socket.create({ model: "m" }, { timeoutMs: 5000 }).catch((e) => e)) instanceof W.TransportError, "a closed socket can't carry a step");
// Refused at the door: a TransportError from open.
refuseUpgrade = true;
assert.ok((await W.ResponsesSocket.open("boppy").catch((e) => e)) instanceof W.TransportError);
refuseUpgrade = false;
// BOPS_RESPONSES_WS=0 turns it off.
assert.equal(W.responsesSocketOn(), true);
process.env.BOPS_RESPONSES_WS = "0";
assert.equal(W.responsesSocketOn(), false);
delete process.env.BOPS_RESPONSES_WS;

/* ---------------- A task's turn ---------------- */

S.update((s) => (s.owner = { name: "Alex" }));
const session = { id: "ses_ws", botId: "boppy", chatId: "bot:boppy", sentVia: "you", title: "WS", goal: "Say hi", host: "mac", status: "running", steps: [], replies: [], createdAt: Date.now() };
S.update((s) => s.sessions.push({ ...session }));
const turn = (speed) => CT.computerTurn({ sessionId: "ses_ws", computerId: "pc_ws", display: 100, model: "gpt-6.1-sol", effort: "medium", instructions: "Be brief.", apps: false, input: "Say hi", signal: new AbortController().signal, timeoutMs: 60_000, idleMs: 5_000, step: () => {}, speed });

// Its Ultrafast step turned down: the same socket carries it on Fast; the answer comes back, and the socket closes with the turn.
const before = connections.length;
onCreate = (e, ws) =>
  ws.send(
    e.service_tier === "ultrafast"
      ? JSON.stringify({ type: "error", status: 429, error: { code: "rate_limit_exceeded", message: "Ultrafast is full" } })
      : JSON.stringify({ type: "response.completed", response: response("resp_t1", [said("Hi from the socket.")], e.service_tier) }),
  );
let answer = await turn(() => "ultrafast");
assert.equal(answer, "Hi from the socket.");
assert.equal(connections.length, before + 1, "one socket for the turn");
const conn = connections.at(-1);
assert.deepEqual(conn.creates.map((c) => c.service_tier), ["ultrafast", "fast"], "a tier down, on the same socket");
assert.deepEqual([conn.creates[1].model, conn.creates[1].reasoning, conn.creates[1].truncation, conn.creates[1].instructions], ["gpt-6.1-sol", { effort: "medium", summary: "auto" }, "auto", "Be brief."]);
assert.equal(S.session("ses_ws").responseId, "resp_t1", "the turn goes on from its response, as over HTTP");
await until(() => conn.closed, "the socket to close with the turn");
assert.equal(httpCalls.length, 0, "nothing over HTTP");

// A standard step goes over HTTP, as it always did: no socket.
const sockets = connections.length;
answer = await turn(() => "default");
assert.deepEqual([answer, connections.length, httpCalls.length, httpCalls.at(-1).service_tier], ["Over HTTP.", sockets, 1, undefined]);

// A socket that's refused: the fast step goes over HTTP, on its tier.
refuseUpgrade = true;
answer = await turn(() => "ultrafast");
assert.deepEqual([answer, httpCalls.length, httpCalls.at(-1).service_tier], ["Over HTTP.", 2, "ultrafast"]);
refuseUpgrade = false;

http.close();
rmSync(scratch, { recursive: true, force: true });
console.log("responses ws: all tests passed");
process.exit(0);
