// Tests for the server side of the apps the bots make (lib/server/made-apps.ts and its routes): a build
// (streamed from a fake OpenAI) makes v1 under an id of 128 random bits; what an app keeps (bops.data);
// bops.bot refused until the user allows it, and the allow gone with every new version (a build, a Go
// back); a Go back mid-build refused; how much an app may ask in an hour (bops.ask too); a call too big for
// the bridge route refused before it's read; a delete taking its files; a build cut off when Bops quit not
// left building (store.ts); the list kept per Mac in Bops Cloud (state-merge.ts PER_MAC); and the bot only
// reading for an app (chat.ts answerForApp).
// OpenAI is a fake, and the state lives in a throwaway folder: nothing reaches a real service.
// Usage: node --conditions=react-server scripts/test-made-apps-server.mjs
import assert from "node:assert/strict";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { registerHooks } from "node:module";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { pathToFileURL } from "node:url";

for (const k of Object.keys(process.env)) if (/^(BOPS|OPENAI|AGENTPHONE|AGENTMAIL|HONCHO|COMPOSIO|TYPESAFE|TWILIO|ORGO|CODEX|TAILSCALE|TREG)_/.test(k)) delete process.env[k];
process.env.BOPS_SELF_HOSTED = "1";
process.env.OPENAI_API_KEY = "sk-test-made-apps";
const root = new URL("..", import.meta.url).pathname.replace(/\/$/, "");
// Where an app's page finds React and Tailwind (public/made-apps), as in the Mac app.
process.env.BOPS_SERVER_JS = join(root, "server.js");
const scratch = mkdtempSync(join(tmpdir(), "bops-test-made-apps-"));
const bin = join(scratch, "bin");
mkdirSync(bin);
writeFileSync(join(bin, "security"), "#!/bin/sh\nexit 44\n", { mode: 0o755 });
process.env.PATH = `${bin}:${process.env.PATH}`;
process.env.HOME = join(scratch, "home");
mkdirSync(process.env.HOME);
const work = join(scratch, "work");
mkdirSync(work);
process.chdir(work);

// Modules that start processes when loaded do nothing.
const STAND_INS = new Set(["mac", "relay", "desktop", "mirror", "sessions"]);
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

/* ---------------- A fake OpenAI ---------------- */

const json = (obj, status = 200) => new Response(JSON.stringify(obj), { status, headers: { "content-type": "application/json" } });
const sse = (events) => new Response(events.map((e) => `event: ${e.type}\ndata: ${JSON.stringify(e)}\n\n`).join(""), { headers: { "content-type": "text/event-stream" } });
const usage = { input_tokens: 10, output_tokens: 5, input_tokens_details: { cached_tokens: 0 }, output_tokens_details: { reasoning_tokens: 0 } };
const done = (text) => ({ id: "resp_x", object: "response", model: "gpt-test", status: "completed", output: [{ id: "msg_x", type: "message", role: "assistant", content: [{ type: "output_text", text, annotations: [] }] }], usage });
/** What a build writes next (its whole file), and how many quick answers (bops.ask) were asked for. */
const code = [];
let quick = 0;
globalThis.fetch = async (input, init) => {
  const req = new Request(input, init);
  const url = new URL(req.url);
  if (url.origin === "https://api.openai.com" && url.pathname === "/v1/responses") {
    const b = JSON.parse(await req.text());
    if (b.stream)
      return sse([
        { type: "response.output_text.delta", item_id: "msg_b", output_index: 0, content_index: 0, delta: code.shift() ?? "", logprobs: [], sequence_number: 1 },
        { type: "response.completed", sequence_number: 2, response: done("") },
      ]);
    quick++;
    return json(done("An answer."));
  }
  throw new TypeError(`fetch failed (the test is offline: ${url.host})`);
};

// Bops stopped mid-build: the saved state still says the app is building.
mkdirSync(join(work, ".data"), { recursive: true });
writeFileSync(
  join(work, ".data", "state.json"),
  JSON.stringify({ madeApps: [{ id: "app_was", title: "Was building", botId: "boppy", chatId: "chat_boppy", ws: "ws_main", version: 1, versions: [{ n: 1, note: "First", at: 1 }], building: { change: "Add a chart", since: 1, chars: 900 }, createdAt: 1, updatedAt: 1 }] }),
);

const S = await import(`${root}/lib/server/store.ts`);
const A = await import(`${root}/lib/server/made-apps.ts`);
const M = await import(`${root}/lib/server/state-merge.ts`);
const Bridge = await import(`${root}/app/api/made-apps/[appId]/bridge/route.ts`);
const { botChatId } = await import(`${root}/lib/types.ts`);
S.update((s) => (s.owner = { name: "Alex", timeZone: "America/New_York" }));

let passed = 0;
let failures = 0;
async function check(name, fn) {
  try {
    await fn();
    passed++;
  } catch (e) {
    failures++;
    console.error(`FAIL ${name}\n  ${e.stack?.split("\n").slice(0, 4).join("\n  ") ?? e.message}`);
  }
}
const app = (id) => S.getState().madeApps?.find((a) => a.id === id);
const waitBuilt = async (id) => {
  for (let i = 0; i < 100 && app(id)?.building; i++) await new Promise((r) => setTimeout(r, 20));
  assert.equal(app(id)?.building, undefined, "the build ended");
};
const chatId = botChatId("boppy");

await check("a build cut off when Bops quit isn't left building, and says so", () => {
  const was = app("app_was");
  assert.equal(was.building, undefined);
  assert.equal(was.error, "Bops closed before it was done. Ask again.");
  assert.equal(was.version, 1, "the version it had stays");
});

let made;
await check("a build makes v1 under an id of 128 random bits, and its code is kept on this Mac", async () => {
  code.push("// Counts\nexport default function App() { return <p>1</p>; }\n");
  made = A.buildApp("boppy", chatId, { title: "Counter", change: "Count things." });
  assert.match(made.id, /^app_[0-9a-f]{32}$/);
  assert.ok(app(made.id).building, "building at once");
  await waitBuilt(made.id);
  assert.equal(app(made.id).version, 1, app(made.id).error);
  assert.match(A.appCode(made.id), /^\/\/ Counts/);
  assert.match(A.viewPage(made.id), /<div id="root"><\/div>/);
  assert.ok(S.getState().messages.some((m) => m.text === "Made Counter"));
});

await check("what an app keeps: set, get, list, delete", async () => {
  assert.equal(await A.bridge(made.id, "data.set", { key: "n", value: 3 }), true);
  assert.equal(await A.bridge(made.id, "data.get", { key: "n" }), 3);
  assert.deepEqual(await A.bridge(made.id, "data.list", { prefix: "" }), ["n"]);
  await A.bridge(made.id, "data.delete", { key: "n" });
  assert.equal(await A.bridge(made.id, "data.get", { key: "n" }), null);
  await assert.rejects(A.bridge(made.id, "fetch", {}), /bops\.fetch isn't something apps can do/);
  await assert.rejects(A.bridge("app_nope", "data.get", { key: "n" }), /No such app/);
});

await check("bops.bot waits for the user's allow, and every new version asks again (a build, a Go back)", async () => {
  await assert.rejects(A.bridge(made.id, "bot", { prompt: "Who replied?" }), (e) => e instanceof A.NeedsAllow && e.what === "bot");
  A.allow(made.id, "bot", true);
  assert.ok(app(made.id).allowed.bot);
  code.push("// Counts by two\nexport default function App() { return <p>2</p>; }\n");
  A.buildApp("boppy", chatId, { appId: made.id, change: "Count by two." });
  await waitBuilt(made.id);
  assert.equal(app(made.id).version, 2);
  assert.equal(app(made.id).allowed, undefined, "a new build: asked again");
  A.allow(made.id, "bot", true);
  A.goBack(made.id, 1);
  assert.equal(app(made.id).version, 3);
  assert.equal(app(made.id).versions.at(-1).note, "Back to v1");
  assert.equal(app(made.id).allowed, undefined, "a Go back: asked again");
  await assert.rejects(A.bridge(made.id, "bot", { prompt: "Who replied?" }), A.NeedsAllow);
});

await check("no Go back while it's being changed", async () => {
  code.push("// Slow\nexport default function App() { return <p>3</p>; }\n");
  A.buildApp("boppy", chatId, { appId: made.id, change: "Again." });
  assert.throws(() => A.goBack(made.id, 1), /being changed right now/);
  await waitBuilt(made.id);
});

await check("bops.ask is limited per app and hour too (a loop can't run up the credit)", async () => {
  const before = quick;
  for (let i = 0; i < 120; i++) assert.equal(await A.bridge(made.id, "ask", { prompt: `Sum ${i}` }), "An answer.");
  await assert.rejects(A.bridge(made.id, "ask", { prompt: "Once more" }), /This app has asked for answers a lot in the last hour\. Try again later\./);
  assert.equal(quick - before, 120, "the one past the limit never reached the model");
  await assert.rejects(A.bridge(made.id, "ask", { prompt: "  " }), /bops\.ask needs a prompt/);
});

await check("the bridge route: a call too big is refused before it's read; a bad body is no call", async () => {
  const ctx = { params: Promise.resolve({ appId: made.id }) };
  const call = (body, headers = {}) => Bridge.POST(new Request("http://localhost/api/made-apps/x/bridge", { method: "POST", headers: { "content-type": "application/json", ...headers }, body }), ctx);
  const big = await call("x", { "content-length": "7000000" });
  assert.equal(big.status, 413);
  assert.match((await big.json()).error, /too much for one call/);
  // Said small, sent big (no length said): cut off once past the cap.
  const stream = new ReadableStream({
    start(c) {
      for (let i = 0; i < 7; i++) c.enqueue(new Uint8Array(1_000_000).fill(32));
      c.close();
    },
  });
  const streamed = await Bridge.POST(new Request("http://localhost/x", { method: "POST", body: stream, duplex: "half" }), ctx);
  assert.equal(streamed.status, 413);
  const ok = await call(JSON.stringify({ method: "data.set", args: { key: "k", value: "v" } }));
  assert.deepEqual(await ok.json(), { result: true });
  assert.deepEqual(await (await call("not json")).json(), { error: "bops. isn't something apps can do." });
  assert.deepEqual(await (await call(JSON.stringify({ method: "bot", args: { prompt: "Hi" } }))).json(), { needs: "bot" });
});

await check("the list is this Mac's alone in Bops Cloud (its files are here)", () => {
  const shared = M.toShared(S.getState(), "mac_a");
  assert.equal(shared.madeApps, undefined, "not for every Mac");
  assert.equal(shared.macs.mac_a.madeApps.length, S.getState().madeApps.length, "kept under this Mac");
  assert.equal(M.fromShared(shared, "mac_a").madeApps.length, S.getState().madeApps.length, "and back on it");
  assert.equal(M.fromShared(shared, "mac_b").madeApps, undefined, "another Mac doesn't list them");
});

await check("delete takes its files and its record", () => {
  const dir = join(S.userDir(), "made-apps", made.id);
  assert.ok(existsSync(join(dir, "v1.tsx")));
  A.deleteApp(made.id);
  assert.equal(existsSync(dir), false);
  assert.equal(app(made.id), undefined);
});

await check("an app's bot only reads for it: no app action that changes anything, not even with Just do it on", () => {
  const chat = readFileSync(`${root}/lib/server/chat.ts`, "utf8");
  const body = chat.slice(chat.indexOf("export async function answerForApp("), chat.indexOf("/** Thrown when another account's Bops came in"));
  assert.match(body, /runAppAction\(botId, a\.action \?\? "", a\.arguments \?\? \{\}, \{ chatId: app\.chatId \}, undefined, a\.account \?\? null, \{ readOnly: true \}\)/);
  assert.match(body, /Here you only read: you can't send, create or change anything/);
  const composio = readFileSync(`${root}/lib/server/composio.ts`, "utf8");
  const run = composio.slice(composio.indexOf("export async function runAppAction("));
  assert.ok(run.indexOf("if (opts.readOnly) return") < run.indexOf("b.autoApprove ? autoOk"), "readOnly refuses before Just do it or low risk is weighed");
});

rmSync(scratch, { recursive: true, force: true });
console.log(`made apps (server): ${passed} passed, ${failures} failed`);
process.exit(failures ? 1 : 0);
