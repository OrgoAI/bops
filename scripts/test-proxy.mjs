// Who may call Bops' API (proxy.ts): the app on this Mac only, and on the Mac app, only its window (the
// httpOnly cookie desktop/main.cjs sets, or its own header), so a bot's Chrome that reached the server
// can neither act nor read. The tailnet's and the cloud tunnel's paths prove themselves; the app's health
// and bots' pages are open reads.
// Run: node --conditions=react-server scripts/test-proxy.mjs
import assert from "node:assert/strict";
import { registerHooks } from "node:module";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");
// proxy.ts imports "next/server" the way Next resolves it (the package's CommonJS entry file).
registerHooks({
  resolve(specifier, context, next) {
    return next(specifier === "next/server" ? "next/server.js" : specifier, context);
  },
});
const { NextRequest } = await import("next/server");
const { proxy } = await import(`${root}/proxy.ts`);

const TOKEN = "t".repeat(64);
const call = (method, path, { host = "localhost:3210", origin = "http://localhost:3210", cookie, header } = {}) => {
  const headers = { host };
  if (origin) headers.origin = origin;
  if (cookie) headers.cookie = cookie;
  if (header) headers["x-bops-window"] = header;
  return proxy(new NextRequest(`http://${host}${path}`, { method, headers }));
};
const passes = (res) => res.headers.get("x-middleware-next") === "1";

// No token (a hosted server, or a dev server outside the app): same-origin calls go through as before.
delete process.env.BOPS_UI_TOKEN;
assert.ok(passes(call("POST", "/api/apps/approvals")), "no token: as before");
assert.equal(call("POST", "/api/apps/approvals", { host: "192.168.1.5:3210", origin: null }).status, 403, "another host still can't");
assert.equal(call("POST", "/api/apps/approvals", { origin: "https://evil.example" }).status, 403, "another origin still can't");

process.env.BOPS_UI_TOKEN = TOKEN;
// What a bot's Chrome on this Mac could send after a redirect onto the app's own page: same origin, no cookie.
for (const [method, path] of [["POST", "/api/apps/approvals"], ["POST", "/api/chats/c1/messages"], ["POST", "/api/sessions/s1/where"], ["POST", "/api/apps"], ["PATCH", "/api/mac"], ["DELETE", "/api/bots"], ["POST", "/api/restart"]]) {
  const res = call(method, path);
  assert.equal(res.status, 403, `${method} ${path} without the window's token`);
  assert.deepEqual(await res.json(), { error: "Only the Bops app can do that." });
}
assert.equal(call("POST", "/api/apps/approvals", { cookie: `bops_window=${"x".repeat(64)}` }).status, 403, "another token");
assert.equal(call("POST", "/api/apps/approvals", { cookie: "bops_window=short" }).status, 403, "a short one");
// The window: its cookie (every request it makes), or main.cjs's header.
assert.ok(passes(call("POST", "/api/apps/approvals", { cookie: `theme=dark; bops_window=${TOKEN}` })), "the window's cookie");
assert.ok(passes(call("POST", "/api/restart", { origin: null, header: TOKEN })), "main.cjs's own call");
// Reads too: the chats, a bot computer's VNC password, the Mac's windows.
for (const path of ["/api/state", "/api/vnc?bot=boppy", "/api/mac/windows?all=1", "/api/mac/window?app=Notes", "/api/screen?bot=boppy", "/api/account", "/api/memory?ws=main"])
  assert.equal(call("GET", path).status, 403, `GET ${path} without the window's token`);
assert.ok(passes(call("GET", "/api/state", { cookie: `bops_window=${TOKEN}` })), "the window reads");
assert.ok(passes(call("GET", "/api/vnc?bot=boppy", { origin: null, cookie: `bops_window=${TOKEN}` })), "an img or a stream of the window's, no Origin");
// Open reads: the app's health (main.cjs, before the window loads) and bots' pages (a tab of their own, or the browser).
assert.ok(passes(call("HEAD", "/api/health", { origin: null })));
assert.ok(passes(call("GET", "/api/health", { origin: null })));
assert.ok(passes(call("GET", "/api/pages/p_123", { origin: null })));
assert.equal(call("POST", "/api/pages/p_123").status, 403, "but nothing else on them");
assert.ok(passes(call("OPTIONS", "/api/state")));
// The tailnet's paths and the tunnel's prove themselves (a bot's secret, a webhook signature, the tunnel's token).
assert.ok(passes(call("POST", "/api/apps/call", { host: "100.64.0.3:3210", origin: null })));
assert.ok(passes(call("POST", "/api/phone/agentphone", { origin: null })));
assert.ok(passes(call("POST", "/api/cloud/event", { host: "127.0.0.1:3210", origin: null })));
delete process.env.BOPS_UI_TOKEN;
console.log("proxy: ok");
