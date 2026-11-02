// Tests for the owner's own messages through Bops Cloud (lib/server/cloud-chat.ts): which go (a plain message in a one
// bot chat of a workspace switched to it, whose bot works on a computer; never pictures, an app beside the chat, Select's
// picks, a group, a bot with no computer or on the Mac, or on a runner), and how: written there ("sent", and the state is
// read now), answered here only when the request never went out or Bops Cloud says the chat isn't its, sent again with
// the same key when it went and got no answer, and "failed" after that.
//
// The store, Bops Cloud and the network are fakes (below). The people and ids are made up.
// Usage: node --conditions=react-server scripts/test-cloud-chat.mjs
import assert from "node:assert/strict";
import { registerHooks } from "node:module";
import { pathToFileURL } from "node:url";
import { unfaked } from "./fake-exports.mjs";

for (const k of Object.keys(process.env)) if (/^(BOPS|ORGO)_/.test(k)) delete process.env[k];
const root = new URL("..", import.meta.url).pathname.replace(/\/$/, "");

const FAKES = { store: ["chat", "getState", "pullState", "stateDevice", "stateUser"], cloud: ["cloudOn", "cloudUrl"], "orgo-auth": ["cloudKey"], persist: ["onRunner"] };
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
    const name = url.match(/\/lib\/server\/([a-z-]+)\.ts$/)?.[1];
    if (!name || !FAKES[name]) return next(url, context);
    return { format: "module", shortCircuit: true, source: FAKES[name].map((n) => `export const ${n} = (...a) => globalThis.__fake[${JSON.stringify(name)}].${n}(...a);`).join("\n") + unfaked(name, url, FAKES[name]) };
  },
});

let failures = 0;
let passed = 0;
async function check(name, fn) {
  try {
    await fn();
    passed++;
  } catch (e) {
    failures++;
    console.error(`FAIL ${name}\n  ${e.stack?.split("\n").slice(0, 6).join("\n  ") ?? e.message}`);
  }
}

const state = {
  workspaces: [{ id: "ws_main" }, { id: "ws_acme", chatOn: "cloud" }],
  bots: [
    { id: "boppy", isMain: true, computerId: "c-main" },
    { id: "max", isMain: true, workspaceId: "ws_acme", computerId: "c-max" },
    { id: "dana", workspaceId: "ws_acme" },
    { id: "zed", workspaceId: "ws_acme", runsOn: "mac" },
    { id: "nova", isMain: true, workspaceId: "ws_new" },
  ],
  chats: [
    { id: "bot:boppy", kind: "bot", botIds: ["boppy"] },
    { id: "bot:max", kind: "bot", botIds: ["max"], workspaceId: "ws_acme" },
    { id: "bot:dana", kind: "bot", botIds: ["dana"], workspaceId: "ws_acme" },
    { id: "bot:zed", kind: "bot", botIds: ["zed"], workspaceId: "ws_acme" },
    { id: "team", kind: "group", botIds: ["max", "dana"], workspaceId: "ws_acme" },
  ],
};
let runner = false;
let online = true;
let pulls = 0;
globalThis.__fake = {
  store: { chat: (id) => state.chats.find((c) => c.id === id), getState: () => state, pullState: async () => void pulls++, stateDevice: () => "mac-1", stateUser: () => "u_owner" },
  cloud: { cloudOn: () => online, cloudUrl: () => "https://bops-cloud.test" },
  "orgo-auth": { cloudKey: () => "key-owner" },
  persist: { onRunner: () => runner },
};

const C = await import(`${root}/lib/server/cloud-chat.ts`);
/** Each request to Bops Cloud, and what the next ones do (a Response, or an error thrown). */
const asked = [];
let next = [];
C.cloudChatForTests({
  fetch: async (url, init) => {
    asked.push({ url, headers: init.headers, body: JSON.parse(init.body) });
    const n = next.shift() ?? { status: 200, body: { ok: true, message: { id: "x" }, turn: "t" } };
    if (n instanceof Error) throw n;
    return new Response(JSON.stringify(n.body), { status: n.status, headers: { "content-type": "application/json" } });
  },
});
const failedWith = (code) => Object.assign(new TypeError("fetch failed"), { cause: { code } });

await check("which messages go through Bops Cloud", () => {
  assert.equal(C.sendsThroughCloud("bot:max", {}), true, "Max's chat in a switched workspace");
  assert.equal(C.sendsThroughCloud("bot:dana", {}), true, "Dana works on Max's computer");
  assert.equal(C.sendsThroughCloud("bot:boppy", {}), false, "a workspace not switched");
  assert.equal(C.sendsThroughCloud("bot:zed", {}), false, "a bot set to work on the Mac");
  assert.equal(C.sendsThroughCloud("team", {}), false, "a group");
  assert.equal(C.sendsThroughCloud("bot:nobody", {}), false);
  for (const extra of [{ images: 1 }, { lookingAt: "app_1" }, { appNote: true }, { picks: true }]) assert.equal(C.sendsThroughCloud("bot:max", extra), false, JSON.stringify(extra));
  online = false;
  assert.equal(C.sendsThroughCloud("bot:max", {}), false, "not signed in to Bops Cloud");
  online = true;
  runner = true;
  assert.equal(C.sendsThroughCloud("bot:max", {}), false, "never on a runner");
  runner = false;
});

await check("written there: sent once, as the owner, and the state read now", async () => {
  asked.length = 0;
  pulls = 0;
  assert.equal(await C.sendThroughCloud("bot:max", "hello", "m_root"), "sent");
  assert.equal(asked.length, 1);
  assert.equal(asked[0].url, "https://bops-cloud.test/v1/chats/bot%3Amax/send");
  assert.equal(asked[0].headers.Authorization, "Bearer key-owner");
  assert.equal(asked[0].headers["x-bops-user"], "u_owner");
  assert.deepEqual([asked[0].body.text, asked[0].body.replyTo], ["hello", "m_root"]);
  assert.match(asked[0].body.key, /^[a-f0-9]{24}$/);
  await new Promise((r) => setTimeout(r, 5));
  assert.equal(pulls, 1);
});

await check("never went out: answered here, at once; went out and no answer: sent again with the same key", async () => {
  asked.length = 0;
  next = [failedWith("ECONNREFUSED")];
  assert.equal(await C.sendThroughCloud("bot:max", "offline"), "here");
  assert.equal(asked.length, 1, "not tried again");
  asked.length = 0;
  next = [failedWith("UND_ERR_HEADERS_TIMEOUT"), { status: 503, body: { error: "busy" } }, { status: 200, body: { ok: true, message: {} } }];
  assert.equal(await C.sendThroughCloud("bot:max", "slow"), "sent");
  assert.equal(asked.length, 3);
  assert.equal(new Set(asked.map((a) => a.body.key)).size, 1, "one key: Bops Cloud takes it once");
  // A refused connection after one that may have landed: never answered here (it may be there).
  asked.length = 0;
  next = [failedWith("UND_ERR_SOCKET"), failedWith("ECONNREFUSED"), failedWith("ECONNREFUSED")];
  assert.equal(await C.sendThroughCloud("bot:max", "maybe"), "failed");
});

await check("Bops Cloud says the chat isn't its: answered here; refused otherwise: it didn't go", async () => {
  next = [{ status: 409, body: { code: "chat_not_in_cloud" } }];
  assert.equal(await C.sendThroughCloud("bot:max", "x"), "here");
  next = [{ status: 403, body: { error: "no" } }];
  assert.equal(await C.sendThroughCloud("bot:max", "x"), "failed");
  next = [{ status: 500, body: {} }, { status: 500, body: {} }, { status: 500, body: {} }];
  assert.equal(await C.sendThroughCloud("bot:max", "x"), "failed");
});

await check("a workspace whose owner chose the Mac (chatOn \"mac\") isn't the cloud's", () => {
  state.workspaces[1].chatOn = "mac";
  assert.equal(C.sendsThroughCloud("bot:max", {}), false);
  state.workspaces[1].chatOn = "cloud";
});

await check("the owner's switch goes to Bops Cloud as the owner, and the state is read after; refused, Bops Cloud's words", async () => {
  asked.length = 0;
  pulls = 0;
  next = [{ status: 200, body: { ok: true, cloud: false, allowHourly: false } }];
  assert.deepEqual(await C.setChatRouting("ws_acme", "mac"), { ok: true });
  assert.equal(asked[0].url, "https://bops-cloud.test/v1/chat-routing");
  assert.deepEqual([asked[0].headers.Authorization, asked[0].headers["x-bops-user"], asked[0].body], ["Bearer key-owner", "u_owner", { wsId: "ws_acme", mode: "mac" }]);
  assert.equal(pulls, 1);
  next = [{ status: 409, body: { error: "Update Bops to 0.0.36 or newer on every Mac first.", code: "chat_needs_update" } }];
  assert.deepEqual(await C.setChatRouting("ws_acme", "auto"), { error: "Update Bops to 0.0.36 or newer on every Mac first.", status: 409 });
  assert.equal(asked[1].body.mode, "auto");
  next = [failedWith("ECONNREFUSED")];
  assert.equal((await C.setChatRouting("ws_acme", "auto")).status, 502);
  online = false;
  assert.equal((await C.setChatRouting("ws_acme", "auto")).status, 409, "not signed in to Bops Cloud");
  online = true;
});

console.log(`cloud chat: ${passed} passed, ${failures} failed`);
process.exit(failures ? 1 : 0);
