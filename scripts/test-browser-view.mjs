// Tests for how this Bops sends a person's inputs on the bot's browser to Bops Cloud (lib/server/browser-view.ts
// actBrowser), against a fake Bops Cloud on localhost:
//
// - Inputs go on one socket per bot (WS /v1/browser/input), in order, signed in as the person with this Mac's device;
//   each is answered as soon as it's on its way, and ones that come while it opens wait and go in order. Take goes by POST.
// - Bops Cloud saying an act didn't go (its computer isn't connected): the next goes by POST, so its words come back.
// - Bops Cloud closing the socket: the next act opens another.
// - A refusal marked as the socket route's (403): that act goes by POST, which answers in words; the next tries again.
// - A Bops Cloud from before the socket (a plain 404): every act by POST for a while, without asking again; then asked
//   again (it may have been updated since). Another Bops Cloud isn't held to it.
// - A socket that stops answering pings (a network change can leave it dead without a close) goes, and the next act
//   opens another; one that answers stays.
// Usage: node scripts/test-browser-view.mjs
import assert from "node:assert/strict";
import { createServer } from "node:http";
import { registerHooks } from "node:module";
import { pathToFileURL } from "node:url";
import { WebSocketServer } from "ws";

const root = new URL("..", import.meta.url).pathname.replace(/\/$/, "");
// The signed-in person and where Bops Cloud is: stand-ins for what the app's server reads from its store and Keychain.
const STUBS = {
  "server-only": "export {}",
  "./app-version": "export const appHeaders = () => ({ 'x-bops-app-version': 'test' });",
  "./cloud": "export const cloudOn = () => true; export const cloudUrl = () => globalThis.__cloudUrl;",
  "./orgo-auth": "export const orgoKey = () => 'key-u1';",
  "./persist-cloud": "export const deviceIdFor = (u) => `device-${u}`;",
  "./shared": "export const sharedProjectId = () => null;",
  "./store": "export const stateUser = () => 'u1';",
};
registerHooks({
  resolve(specifier, context, next) {
    if (STUBS[specifier] !== undefined && (specifier === "server-only" || context.parentURL?.includes("/lib/server/browser-view.ts")))
      return { url: `data:text/javascript,${encodeURIComponent(STUBS[specifier])}`, shortCircuit: true };
    if (specifier.startsWith("@/")) return next(pathToFileURL(`${root}/${specifier.slice(2)}.ts`).href, context);
    return next(specifier, context);
  },
});
/** A fresh copy of the module (its sockets and "by POST for a while" are per process), with its timing as given. */
const fresh = async (n, timing = {}) => {
  const v = await import(`${root}/lib/server/browser-view.ts?${n}`);
  Object.assign(v.browserViewForTests?.timing ?? {}, timing);
  return v;
};

let passed = 0;
const test = async (name, f) => {
  await f();
  passed++;
  console.log(`ok - ${name}`);
};
async function until(check, what, ms = 5000) {
  for (const end = Date.now() + ms; Date.now() < end; await new Promise((r) => setTimeout(r, 10))) {
    const v = await check();
    if (v) return v;
  }
  assert.fail(`timed out waiting for ${what}`);
}

/**
 * A fake Bops Cloud: `upgrade` is "accept", 404 (a plain one: from before the socket) or 403 (marked as the route's), read
 * at each upgrade. `pong: false`: its sockets never answer a ping (a connection a network change left dead).
 */
async function fakeCloud(o) {
  const c = { posts: [], said: [], upgrades: 0, sockets: [], asked: [] };
  const server = createServer(async (req, res) => {
    let body = "";
    for await (const chunk of req) body += chunk;
    c.posts.push(JSON.parse(body));
    res.writeHead(o.postStatus ?? 202, { "content-type": "application/json" }).end(JSON.stringify(o.postStatus ? { error: "In Bops Cloud's words." } : { ok: true }));
  });
  const wss = new WebSocketServer({ noServer: true, autoPong: o.pong !== false });
  server.on("upgrade", (req, socket, head) => {
    c.upgrades++;
    c.asked.push({ url: req.url, auth: req.headers.authorization, device: req.headers["x-bops-device"] });
    if (o.upgrade === 404) return socket.end("HTTP/1.1 404 Not Found\r\nConnection: close\r\nContent-Length: 0\r\n\r\n");
    if (o.upgrade === 403) return socket.end("HTTP/1.1 403 Forbidden\r\nConnection: close\r\nx-bops-browser-input: 1\r\nContent-Length: 0\r\n\r\n");
    wss.handleUpgrade(req, socket, head, (ws) => {
      c.sockets.push(ws);
      ws.on("message", (m) => c.said.push(JSON.parse(String(m))));
      ws.on("close", () => (ws.ended = true));
    });
  });
  await new Promise((r) => server.listen(0, "127.0.0.1", r));
  c.url = globalThis.__cloudUrl = `http://127.0.0.1:${server.address().port}`;
  c.close = async () => {
    for (const ws of wss.clients) ws.terminate();
    server.closeAllConnections();
    await new Promise((r) => server.close(r));
  };
  return c;
}
const move = (x) => ({ bot: "b", act: "input", method: "Input.dispatchMouseEvent", params: { type: "mouseMoved", x, y: 1 } });

await test("inputs go on one socket in order, each answered once on its way; take by POST; an act Bops Cloud said didn't go makes the next a POST; a closed socket is opened again", async () => {
  const v = await fresh(1);
  const c = await fakeCloud({ upgrade: "accept" });
  try {
    // 30 at once: the first opens the socket, the rest wait for it, and all go in order.
    const answers = await Promise.all(Array.from({ length: 30 }, (_, x) => v.actBrowser(move(x), "")));
    assert.ok(answers.every((a) => a.status === 202), JSON.stringify(answers[0]));
    await until(() => c.said.length === 30, "the 30 on the socket");
    assert.deepEqual(c.said.map((m) => m.params.x), Array.from({ length: 30 }, (_, x) => x));
    assert.deepEqual(c.said[0], { act: "input", method: "Input.dispatchMouseEvent", params: { type: "mouseMoved", x: 0, y: 1 } });
    assert.equal(c.upgrades, 1, "one socket");
    assert.deepEqual(c.asked[0], { url: "/v1/browser/input?bot=b", auth: "Bearer key-u1", device: "device-u1" });
    assert.equal(c.posts.length, 0, "no input by POST");
    assert.equal((await v.actBrowser({ bot: "b", act: "take" }, "")).status, 202);
    assert.deepEqual(c.posts, [{ bot: "b", act: "take" }], "take by POST");
    // Bops Cloud says one didn't go: the next is a POST (its answer has the words), the one after the socket again.
    c.sockets[0].send(JSON.stringify({ t: "error", code: "browser_offline", why: "B's computer isn't connected right now." }));
    await new Promise((r) => setTimeout(r, 50));
    await v.actBrowser(move(100), "");
    assert.deepEqual(c.posts.at(-1), move(100));
    await v.actBrowser(move(101), "");
    await until(() => c.said.at(-1)?.params.x === 101, "the next on the socket");
    // Closed by Bops Cloud (their access changed): the next act opens another, which Bops Cloud asks about afresh.
    c.sockets[0].close(4403, "Access changed");
    await new Promise((r) => setTimeout(r, 50));
    assert.equal((await v.actBrowser(move(102), "")).status, 202);
    await until(() => c.said.at(-1)?.params.x === 102, "the act on the new socket");
    assert.equal(c.upgrades, 2);
    // Another workspace than the one open here: refused before anything is sent, as before.
    assert.equal((await v.actBrowser(move(103), "p-other")).body.code, "workspace_changed");
    // A method outside BROWSER_METHODS: by POST, so Bops Cloud's refusal comes back in its words; never on the socket.
    const said = c.said.length;
    await v.actBrowser({ bot: "b", act: "input", method: "Runtime.evaluate", params: { expression: "1" } }, "");
    assert.equal(c.posts.at(-1).method, "Runtime.evaluate");
    assert.equal(c.said.length, said);
  } finally {
    await c.close();
  }
});

await test("a refusal marked as the socket's (403): that act by POST, answered in Bops Cloud's words; the next asks for the socket again", async () => {
  const v = await fresh(2);
  const c = await fakeCloud({ upgrade: 403, postStatus: 403 });
  try {
    const a = await v.actBrowser(move(1), "");
    assert.deepEqual(a, { status: 403, body: { error: "In Bops Cloud's words." } });
    assert.deepEqual(c.posts, [move(1)]);
    await v.actBrowser(move(2), "");
    assert.equal(c.upgrades, 2, "asked again: access can come back");
    assert.equal(c.posts.length, 2);
  } finally {
    await c.close();
  }
});

await test("a Bops Cloud from before the socket (a plain 404): every act by POST for a while, without asking again; then asked again; another Bops Cloud isn't held to it", async () => {
  const v = await fresh(3, { noSocketMs: 300 });
  const o = { upgrade: 404 };
  const c = await fakeCloud(o);
  let other;
  try {
    const waiting = await Promise.all([1, 2, 3].map((x) => v.actBrowser(move(x), "")));
    assert.ok(waiting.every((a) => a.status === 202));
    assert.deepEqual(c.posts.map((p) => p.params.x), [1, 2, 3], "the ones waiting for the socket, by POST in order");
    for (const x of [4, 5]) assert.equal((await v.actBrowser(move(x), "")).status, 202);
    assert.equal(c.upgrades, 1, "not asked again for a while");
    assert.deepEqual(c.posts.map((p) => p.params.x), [1, 2, 3, 4, 5]);
    // Another Bops Cloud (signed in to elsewhere) is asked for its own socket.
    other = await fakeCloud({ upgrade: "accept" });
    assert.equal((await v.actBrowser(move(6), "")).status, 202);
    await until(() => other.said.length === 1, "the act on the other Bops Cloud's socket");
    assert.equal(other.posts.length, 0);
    // Bops Cloud updated since: once the while is up, the next act asks again and goes on the socket.
    globalThis.__cloudUrl = c.url;
    o.upgrade = "accept";
    await new Promise((r) => setTimeout(r, 350));
    assert.equal((await v.actBrowser(move(7), "")).status, 202);
    await until(() => c.said.length === 1, "the act on the socket");
    assert.equal(c.upgrades, 2, "asked again");
    assert.deepEqual(c.posts.map((p) => p.params.x), [1, 2, 3, 4, 5], "nothing more by POST");
  } finally {
    await c.close();
    await other?.close();
  }
});

await test("a socket that stops answering pings goes, and the next act opens another; one that answers stays", async () => {
  const v = await fresh(4, { pingMs: 40 });
  const here = await fakeCloud({ upgrade: "accept" });
  try {
    await v.actBrowser(move(1), "");
    await until(() => here.said.length === 1, "the act on the socket");
    await new Promise((r) => setTimeout(r, 250));
    assert.equal((await v.actBrowser(move(2), "")).status, 202);
    await until(() => here.said.length === 2, "the next on the same socket");
    assert.equal(here.upgrades, 1, "pings answered: one socket");
  } finally {
    await here.close();
  }
  const dead = await fakeCloud({ upgrade: "accept", pong: false });
  try {
    await v.actBrowser(move(3), "");
    await until(() => dead.said.length === 1, "the act on the socket");
    await until(() => dead.sockets[0].ended, "the socket that never answers to go", 1000);
    assert.equal((await v.actBrowser(move(4), "")).status, 202);
    await until(() => dead.said.length === 2, "the next act on a new socket");
    assert.equal(dead.upgrades, 2, "another socket");
    assert.equal(dead.posts.length, 0);
  } finally {
    await dead.close();
  }
});

console.log(`${passed} passed`);
