// An app's Local beside its bot's chat in the Mac app (desktop/preview-frames.cjs), with Electron's objects faked: a
// webview on a persist:bops-preview- partition gets its session prepared once (a plain Chrome's user agent, the tabs'
// permission rules); its pages may open Google's sign in and their own localhost pages as child windows on the same
// session, anything else goes to the system browser (from its Preview link and Published domain too, which load in the same
// session); a web tab's (persist:bops-web-) is left as it was. Each preview webview gets its keys' preload
// (desktop/preview-frame-preload.cjs: sandboxed, isolated, no Node, never one the window names), run here as Electron
// runs it, with a page faked: S and D said to the webview only as typing never is (not in anything editable, not with
// Cmd, Ctrl or Alt, not held down, not when the page took the key), Esc always, the key's name and nothing more. A Preview's
// password cookie goes in a preview's session only when every part of the ask checks out (a preview partition, https on a
// 12 character label under orgo.dev or staging.orgo.dev, the name __Host-orgo_pass, a value a browser takes), host only,
// Secure, HttpOnly, SameSite Lax, path /, 30 days; anything else is refused and nothing is set.
// Usage: node scripts/test-preview-frames.mjs
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { createRequire } from "node:module";

const P = createRequire(import.meta.url)("../desktop/preview-frames.cjs");
const root = new URL("..", import.meta.url);
let passed = 0;
const check = async (name, fn) => {
  await fn();
  passed++;
  console.log(`ok - ${name}`);
};

/** A fake Electron: sessions by partition, and the app's web-contents-created listeners. */
function fake() {
  const sessions = new Map();
  const listeners = [];
  const session = {
    fromPartition: (p) => {
      if (!sessions.has(p)) {
        const set = [];
        sessions.set(p, { partition: p, ua: "Mozilla/5.0 Chrome/140.0 Electron/38.1.0 Bops/0.0.33 Safari/537.36", setUserAgent(u) { this.ua = u; }, getUserAgent() { return this.ua; }, set, cookies: { set: async (c) => void set.push(c) } });
      }
      return sessions.get(p);
    },
  };
  const app = { on: (ev, fn) => ev === "web-contents-created" && listeners.push(fn) };
  const fenced = [];
  const external = [];
  const frames = P.installPreviewFrames({ app, session, fence: (s) => fenced.push(s.partition), external: (u) => external.push(u), preload: PRELOAD });
  /** A window's contents that attaches a webview with `partition` (`prefs` and `params` as the window asked), then that webview's contents. */
  const attach = (partition, prefs = {}, params = {}) => {
    const embedder = { handlers: {}, on(ev, fn) { this.handlers[ev] = fn; }, getType: () => "window", session: session.fromPartition("main") };
    for (const l of listeners) l({}, embedder);
    embedder.handlers["will-attach-webview"]?.({}, prefs, Object.assign(params, { partition, src: "http://localhost:3000/" }));
    const contents = { getType: () => "webview", session: session.fromPartition(partition), open: null, setWindowOpenHandler(fn) { this.open = fn; }, on() {} };
    for (const l of listeners) l({}, contents);
    return contents;
  };
  return { sessions, fenced, external, frames, attach, session };
}

const PART = "persist:bops-preview-u_1-ws_main-recipe_box";
const PRELOAD = "/app/desktop/preview-frame-preload.cjs";

await check("a preview partition's session is prepared once: a plain Chrome's user agent and the tabs' permission rules", () => {
  const f = fake();
  f.attach(PART);
  f.attach(PART);
  const s = f.sessions.get(PART);
  assert.equal(s.ua, "Mozilla/5.0 Chrome/140.0 Safari/537.36", "no Electron/ nor Bops/ in it");
  assert.deepEqual(f.fenced, [PART], "fenced once");
  assert.equal(f.frames.isPreview(s), true);
  assert.equal(P.isPreviewPartition(PART), true);
  assert.equal(P.isPreviewPartition("persist:bops-preview-../x"), false);
});

await check("Google's sign in and its own localhost pages open as child windows on the same session; anything else goes to the system browser", () => {
  const f = fake();
  const c = f.attach(PART);
  const google = c.open({ url: "https://accounts.google.com/o/oauth2/v2/auth?client_id=x" });
  assert.equal(google.action, "allow");
  assert.equal(google.overrideBrowserWindowOptions.webPreferences.session, c.session, "the same session, so the sign in comes back to its opener");
  assert.equal(c.open({ url: "http://localhost:3000/api/auth/signin" }).action, "allow");
  assert.deepEqual(c.open({ url: "https://evil.example/" }), { action: "deny" });
  assert.deepEqual(c.open({ url: "https://accounts.google.com.evil.example/" }), { action: "deny" });
  assert.deepEqual(c.open({ url: "http://user:pw@localhost:3000/" }), { action: "deny" });
  assert.deepEqual(f.external, ["https://evil.example/", "https://accounts.google.com.evil.example/", "http://user:pw@localhost:3000/"]);
});

await check("a preview's webview gets its keys' preload: sandboxed, isolated, no Node, and never a preload the window names", () => {
  const f = fake();
  const prefs = { preload: "/evil.js", nodeIntegration: true, sandbox: false, contextIsolation: false };
  const params = { preload: "file:///evil.js", allowpopups: "true" };
  f.attach(PART, prefs, params);
  assert.deepEqual(prefs, { preload: PRELOAD, nodeIntegration: false, sandbox: true, contextIsolation: true, nodeIntegrationInSubFrames: false, nodeIntegrationInWorker: false });
  assert.deepEqual(params, { allowpopups: "true", partition: PART, src: "http://localhost:3000/" }, "its own popups as before (Google's sign in)");
  const main = readFileSync(new URL("desktop/main.cjs", root), "utf8");
  assert.ok(main.includes('installPreviewFrames({ app, session, fence: fenceTabSession, external: (url) => shell.openExternal(url), preload: path.join(__dirname, "preview-frame-preload.cjs"), log: mainLog })'), "main.cjs names it");
});

await check("a web tab's webview (persist:bops-web-) is left as it was: nothing prepared, no handler set", () => {
  const f = fake();
  const prefs = { preload: "/tab.js" };
  const c = f.attach("persist:bops-web-u_1", prefs);
  assert.deepEqual(prefs, { preload: "/tab.js" }, "no preload of the preview's");
  assert.equal(c.open, null);
  assert.deepEqual(f.fenced, []);
  assert.equal(f.frames.isPreview(c.session), false);
  assert.equal(f.sessions.get("persist:bops-web-u_1").ua.includes("Electron/"), true, "its agent untouched here (main.cjs sets its own)");
});

await check("its Preview link and Published domain load in the same session (preview-tab.tsx): Google's sign in from them stays in it, their own pages' new windows go to the browser", () => {
  const f = fake();
  const c = f.attach(PART);
  const google = c.open({ url: "https://accounts.google.com/o/oauth2/v2/auth?redirect_uri=https%3A%2F%2Fk7p2qxm4wr3d.orgo.dev%2Fapi%2Fauth%2Fcallback%2Fgoogle" });
  assert.equal(google.action, "allow");
  assert.equal(google.overrideBrowserWindowOptions.webPreferences.session, c.session);
  assert.deepEqual(c.open({ url: "https://k7p2qxm4wr3d.orgo.dev/terms" }), { action: "deny" });
  assert.deepEqual(c.open({ url: "https://recipes.example.com/help" }), { action: "deny" });
  assert.deepEqual(f.external, ["https://k7p2qxm4wr3d.orgo.dev/terms", "https://recipes.example.com/help"]);
  assert.deepEqual(f.fenced, [PART], "one session, prepared once");
});

/** The keys' preload in a page, as Electron runs it (sandboxed: require("electron") only): what it said to the webview, and presses. */
function previewPage() {
  const src = readFileSync(new URL("desktop/preview-frame-preload.cjs", root), "utf8");
  const sent = [];
  const heard = [];
  const document = { activeElement: null };
  const window = { addEventListener: (kind, fn, capture) => heard.push({ kind, fn, capture }) };
  const require = (m) => {
    assert.equal(m, "electron", "nothing but Electron's own (a sandboxed preload)");
    return { ipcRenderer: { sendToHost: (channel, ...args) => sent.push([channel, ...args]) } };
  };
  new Function("require", "window", "document", src)(require, window, document);
  assert.deepEqual(heard.map((h) => [h.kind, h.capture]), [["keydown", true]], "the page's keys, before the page's own listeners");
  /** A key pressed on `target` (the page's body unless said); `page` is what the page's own listeners do with it after. */
  const press = async (key, extra = {}, page = () => {}) => {
    const target = extra.target ?? { tagName: "BODY" };
    const e = { isTrusted: true, key, metaKey: false, ctrlKey: false, altKey: false, repeat: false, isComposing: false, defaultPrevented: false, composedPath: () => [target], ...extra };
    heard[0].fn(e);
    page(e);
    await new Promise((r) => setTimeout(r, 5));
    return sent.splice(0).map((x) => x.slice(1).join());
  };
  return { src, document, press };
}

await check("keys in a preview's page: S and D said to its webview as their name, Shift too; nothing else", async () => {
  const p = previewPage();
  assert.deepEqual(await p.press("s"), ["s"]);
  assert.deepEqual(await p.press("D"), ["d"], "with Shift");
  assert.deepEqual(await p.press("x"), []);
  assert.deepEqual(await p.press("Enter"), []);
  assert.ok(p.src.includes('ipcRenderer.sendToHost("bops-preview-key", k)'), "on its channel, the key's name only");
  assert.doesNotMatch(p.src, /contextBridge|exposeInMainWorld/, "the page gets nothing");
});

await check("keys in a preview's page: never while typing (a field, a text box, a menu, anything editable, in a shadow root too)", async () => {
  const p = previewPage();
  for (const target of [{ tagName: "INPUT" }, { tagName: "TEXTAREA" }, { tagName: "SELECT" }, { tagName: "DIV", isContentEditable: true }]) assert.deepEqual(await p.press("s", { target }), [], target.tagName);
  p.document.activeElement = { tagName: "TEXTAREA" };
  assert.deepEqual(await p.press("d"), [], "its focus in a text box");
  p.document.activeElement = { tagName: "RICH-EDITOR", shadowRoot: { activeElement: { tagName: "DIV", isContentEditable: true } } };
  assert.deepEqual(await p.press("s"), [], "in a shadow root");
  p.document.activeElement = { tagName: "BUTTON" };
  assert.deepEqual(await p.press("s"), ["s"], "a button isn't typing");
});

await check("keys in a preview's page: never with Cmd, Ctrl or Alt, never held down, never mid composition, never made up by the page", async () => {
  const p = previewPage();
  assert.deepEqual(await p.press("s", { metaKey: true }), [], "Cmd S");
  assert.deepEqual(await p.press("s", { ctrlKey: true }), []);
  assert.deepEqual(await p.press("d", { altKey: true }), []);
  assert.deepEqual(await p.press("s", { repeat: true }), [], "held down");
  assert.deepEqual(await p.press("s", { isComposing: true }), []);
  assert.deepEqual(await p.press("s", { isTrusted: false }), [], "a key the page dispatched itself");
  assert.deepEqual(await p.press("Escape", { isTrusted: false }), []);
});

await check("keys in a preview's page: a key the page's own listeners took (defaultPrevented once they've all run) is the site's", async () => {
  const p = previewPage();
  assert.deepEqual(await p.press("s", {}, (e) => (e.defaultPrevented = true)), [], "the site's own S wins");
  assert.deepEqual(await p.press("d", {}, (e) => (e.defaultPrevented = true)), []);
  assert.deepEqual(await p.press("s", {}, () => {}), ["s"], "one it let be");
});

await check("Esc in a preview's page: always, wherever its focus is, whatever the page did with it", async () => {
  const p = previewPage();
  assert.deepEqual(await p.press("Escape"), ["escape"]);
  assert.deepEqual(await p.press("Escape", { target: { tagName: "INPUT" } }), ["escape"], "in a field");
  assert.deepEqual(await p.press("Escape", { metaKey: true, repeat: true }), ["escape"]);
  assert.deepEqual(await p.press("Escape", {}, (e) => (e.defaultPrevented = true)), ["escape"], "taken by the page");
});

const ASK = { partition: PART, url: "https://k7p2qxm4wr3d.orgo.dev/", name: "__Host-orgo_pass", value: "v1.Zm9vYmFy_x-9" };

await check("a Preview's password cookie goes in that preview's session: host only, Secure, HttpOnly, SameSite Lax, path /, 30 days", async () => {
  const f = fake();
  assert.equal(await f.frames.signIn({ ...ASK, url: "https://k7p2qxm4wr3d.orgo.dev/menu?x=1" }), true);
  const s = f.sessions.get(PART);
  assert.equal(s.set.length, 1);
  const c = s.set[0];
  const days = (c.expirationDate - Date.now() / 1000) / 86400;
  assert.ok(days > 29.9 && days <= 30, "30 days");
  assert.deepEqual({ ...c, expirationDate: 0 }, { url: "https://k7p2qxm4wr3d.orgo.dev/", name: "__Host-orgo_pass", value: ASK.value, secure: true, httpOnly: true, sameSite: "lax", path: "/", expirationDate: 0 });
  assert.equal("domain" in c, false, "no domain: that host alone, as a __Host- cookie must be");
  assert.equal(s.ua, "Mozilla/5.0 Chrome/140.0 Safari/537.36", "its session prepared as a webview's would be");
  assert.deepEqual(f.fenced, [PART]);
  assert.equal(await f.frames.signIn({ ...ASK, url: "https://m3n4b5v6c7x8.staging.orgo.dev/" }), true, "Orgo's staging too");
  assert.equal(P.passCookie(ASK, 0).cookie.expirationDate, 30 * 86400);
});

await check("anything else is refused and nothing is set: another partition, another address, another cookie, a value a browser wouldn't take", async () => {
  const f = fake();
  const bad = [
    null,
    "x",
    { ...ASK, partition: "persist:bops-web-u_1" },
    { ...ASK, partition: "persist:bops-preview-../x" },
    { ...ASK, partition: "main" },
    { ...ASK, url: "http://k7p2qxm4wr3d.orgo.dev/" },
    { ...ASK, url: "https://k7p2qxm4wr3d.orgo.dev:8443/" },
    { ...ASK, url: "https://user:pw@k7p2qxm4wr3d.orgo.dev/" },
    { ...ASK, url: "https://k7p2qxm4wr3.orgo.dev/" },
    { ...ASK, url: "https://k7p2qxm4wr3dx.orgo.dev/" },
    { ...ASK, url: "https://k7p2-xm4wr3d.orgo.dev/" },
    { ...ASK, url: "https://orgo.dev/" },
    { ...ASK, url: "https://k7p2qxm4wr3d.orgo.dev.example.com/" },
    { ...ASK, url: "https://k7p2qxm4wr3d.example.dev/" },
    { ...ASK, url: "https://a.k7p2qxm4wr3d.orgo.dev/" },
    { ...ASK, url: "https://k7p2qxm4wr3d.other.orgo.dev/" },
    { ...ASK, url: "not a url" },
    { ...ASK, url: undefined },
    { ...ASK, name: "orgo_pass" },
    { ...ASK, name: "__Host-orgo_pass " },
    { ...ASK, name: "bops_window" },
    { ...ASK, value: "" },
    { ...ASK, value: "a b" },
    { ...ASK, value: "a;b=c" },
    { ...ASK, value: 'a"b' },
    { ...ASK, value: "a,b" },
    { ...ASK, value: "a\\b" },
    { ...ASK, value: "x".repeat(4097) },
    { ...ASK, value: 42 },
  ];
  for (const ask of bad) {
    assert.equal(P.passCookie(ask), null, JSON.stringify(ask));
    assert.equal(await f.frames.signIn(ask), false);
  }
  assert.equal([...f.sessions.values()].reduce((n, s) => n + s.set.length, 0), 0, "nothing set anywhere");
  assert.deepEqual(f.fenced, [], "no session prepared for a refused ask");
});

await check("main.cjs hands the page's ask to signIn as it came, and the preload asks it by one name", async () => {
  const main = readFileSync(new URL("../desktop/main.cjs", import.meta.url), "utf8");
  const preload = readFileSync(new URL("../desktop/preload.cjs", import.meta.url), "utf8");
  assert.match(main, /ipcMain\.handle\("preview-sign-in", \(_, ask\) => previewFrames\?\.signIn\(ask\) \?\? false\);/);
  assert.match(preload, /previewSignIn: \(ask\) => ipcRenderer\.invoke\("preview-sign-in", ask\),/);
});

console.log(`preview frames: ${passed} passed`);
