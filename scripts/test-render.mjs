// Tests for reading a page in a browser when a plain fetch can't: lib/server/web-render.ts (when a page
// needs the browser, the sites remembered for 7 days, the one-at-a-time queue), lib/server/render-guard.ts
// (the gate every request of a rendered page goes through: the same address checks as safe-fetch) and,
// with the real Electron Bops ships, desktop/render.cjs (the hidden window, through
// scripts/render-harness.cjs) and how lib/server/web-page.ts uses it all (readPage, pageLines).
//
// The pages come from a fixture server on 127.0.0.1 let through with BOPS_FETCH_ALLOW; a second server,
// the "canary", stands for a private address and must never be reached. DNS for safe-fetch.ts is a
// stand-in table, so no name is looked up and nothing reaches the network. The Electron part runs only
// where node_modules/electron has its app (macOS); it shows no window and no Dock icon.
// Usage: node --conditions=react-server scripts/test-render.mjs
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { createServer, request } from "node:http";
import { registerHooks } from "node:module";
import net from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { pathToFileURL } from "node:url";

for (const k of Object.keys(process.env)) if (/^BOPS_/.test(k)) delete process.env[k];
const root = new URL("..", import.meta.url).pathname.replace(/\/$/, "");
// The sites remembered as needing the browser go in .data/ under the working folder: a throwaway one.
const scratch = mkdtempSync(join(tmpdir(), "bops-test-render-"));
process.chdir(scratch);
const sitesFile = join(scratch, ".data", "browser-sites.json");

// DNS for safe-fetch.ts is this table: a name not in it isn't found.
const dns = { table: new Map(), calls: [] };
globalThis.__webTestLookup = async (host) => {
  dns.calls.push(host);
  const found = dns.table.get(host);
  if (!found) throw Object.assign(new Error(`getaddrinfo ENOTFOUND ${host}`), { code: "ENOTFOUND" });
  return found;
};
const FAKE_DNS = `data:text/javascript,${encodeURIComponent("export const lookup = (...a) => globalThis.__webTestLookup(...a);")}`;
globalThis.__webTestInterfaces = () => ({ lo0: [{ address: "127.0.0.1", netmask: "255.0.0.0", family: "IPv4", mac: "00:00:00:00:00:00", internal: true, cidr: "127.0.0.1/8" }] });
const FAKE_OS = `data:text/javascript,${encodeURIComponent("export const networkInterfaces = () => globalThis.__webTestInterfaces();")}`;

registerHooks({
  resolve(specifier, context, next) {
    if (specifier === "node:dns/promises" && context.parentURL?.endsWith("/lib/server/safe-fetch.ts")) return { url: FAKE_DNS, format: "module", shortCircuit: true };
    if (specifier === "node:os" && context.parentURL?.endsWith("/lib/server/safe-fetch.ts")) return { url: FAKE_OS, format: "module", shortCircuit: true };
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

const { FetchRefused } = await import(pathToFileURL(`${root}/lib/server/safe-fetch.ts`).href);
const render = await import(pathToFileURL(`${root}/lib/server/web-render.ts`).href);
const { openGuard } = await import(pathToFileURL(`${root}/lib/server/render-guard.ts`).href);
const { pageLines, readPage } = await import(pathToFileURL(`${root}/lib/server/web-page.ts`).href);
const { CHALLENGE, RENDER_LIMIT_MS, browserStatus, forgetSites, lastGuardRefusals, needsBrowser, rememberSite, renderPage, siteNeedsBrowser } = render;

/* ---------------- The fixture pages ---------------- */

// An app's shell: nothing to read until its script runs, then prices in a table, a list and a link.
const APP = `<!doctype html><html><head><title>Price board</title></head><body><div id="root"></div>
<script>setTimeout(() => {
  document.getElementById("root").innerHTML = '<h1>Prices loaded by JavaScript</h1><table><tr><td>Widget Pro</td><td>$19.99</td></tr><tr><td>Widget Mini</td><td>$9.99</td></tr></table><ul><li>Free shipping on every order</li></ul><p><a href="/about">About the price board</a> <a href="mailto:x@y.example">mail us</a></p>';
}, 150);</script></body></html>`;
// A wall that checks for a human: a 403 "Just a moment..." until its script sets a cookie and reloads.
const WALL = `<!doctype html><html><head><title>Just a moment...</title></head><body><p>Checking your browser before accessing the site.</p>
<script>setTimeout(() => { document.cookie = "passed=1; path=/"; location.reload(); }, 800);</script></body></html>`;
const PAST_WALL = `<!doctype html><html><head><title>Members news</title></head><body><h1>Welcome past the wall</h1><p>Today's news for everyone who got through.</p></body></html>`;
// A wall that never lets anyone through.
const WALL_FOREVER = `<!doctype html><html><head><title>Just a moment...</title></head><body><p>Verify you are human.</p></body></html>`;
// A shell whose script reaches for this Mac and private networks every way it can, then says what happened.
const reach = (canary) => `<!doctype html><html><head><title>Reaching</title></head><body><div id="root"></div>
<img src="http://127.0.0.1:${canary}/img.png"><iframe src="file:///etc/hosts"></iframe><iframe src="http://localhost:${canary}/frame"></iframe>
<script>
const tries = {
  "fetch-ip": () => fetch("http://127.0.0.1:${canary}/fetch"),
  "fetch-localhost": () => fetch("http://localhost:${canary}/fetch2"),
  "fetch-private-name": () => fetch("http://private.example/x"),
  "fetch-ten": () => fetch("http://10.0.0.1/x"),
  "fetch-bops": () => fetch("http://127.0.0.1:3210/api/health"),
  "fetch-file": () => fetch("file:///etc/hosts"),
  "socket": () => new Promise((ok, no) => { const ws = new WebSocket("ws://127.0.0.1:${canary}/ws"); ws.onopen = ok; ws.onerror = no; }),
  "beacon-xhr": () => new Promise((ok, no) => { const x = new XMLHttpRequest(); x.open("GET", "http://127.0.0.1:${canary}/xhr"); x.onload = ok; x.onerror = no; x.send(); }),
};
Promise.all(Object.entries(tries).map(([name, go]) => Promise.race([go(), new Promise((_, no) => setTimeout(no, 3000))]).then(() => name + " reached", () => name + " blocked")))
  .then((out) => { document.getElementById("root").textContent = "Results: " + out.join(", "); });
</script></body></html>`;
// A shell whose script never arrives: the page never finishes loading.
const SLOW = `<!doctype html><html><head><title>Slow</title><script src="/never.js"></script></head><body><div id="root"></div></body></html>`;

const isBrowser = (ua = "") => /Chrome\//.test(ua) && !/^Bops\//.test(ua);
const hits = { plain: new Map(), browser: new Map(), canary: [] };
const count = (req, path) => {
  const m = isBrowser(req.headers["user-agent"]) ? hits.browser : hits.plain;
  m.set(path, (m.get(path) ?? 0) + 1);
};
const held = new Set();
let holding = 0;
let mostHolding = 0;
const userAgents = new Set();

const server = createServer((req, res) => {
  const url = new URL(req.url, "http://fixture");
  const p = url.pathname;
  count(req, p);
  if (isBrowser(req.headers["user-agent"])) userAgents.add(req.headers["user-agent"]);
  const send = (status, type, body, headers = {}) => {
    res.writeHead(status, { "Content-Type": type, ...headers });
    res.end(body);
  };
  if (p === "/app") return send(200, "text/html", APP);
  if (p === "/about") return send(200, "text/html", "<title>About</title><p>About us</p>");
  if (p === "/wall") return /passed=1/.test(req.headers.cookie ?? "") ? send(200, "text/html", PAST_WALL) : send(403, "text/html", WALL);
  if (p === "/wall-forever") return send(403, "text/html", WALL_FOREVER);
  if (p === "/reach") return send(200, "text/html", reach(canaryPort));
  if (p === "/slow") return send(200, "text/html", SLOW);
  // A script that never finishes arriving: a little every second, so no connection sits idle.
  if (p === "/never.js") {
    res.writeHead(200, { "Content-Type": "text/javascript" });
    const drip = setInterval(() => res.write("/* still coming */\n"), 1000);
    res.on("close", () => clearInterval(drip));
    return held.add(res);
  }
  if (p === "/hold") {
    holding++;
    mostHolding = Math.max(mostHolding, holding);
    return setTimeout(() => {
      holding--;
      send(200, "text/html", `<title>Held</title><p>Page ${url.searchParams.get("n")} after a wait</p>`);
    }, 300);
  }
  if (p === "/file.pdf") return send(200, "application/pdf", "%PDF-1.4 not really");
  // An app whose page, once drawn, is long and mentions a human check: a page, not a wall.
  if (p === "/guide")
    return send(200, "text/html", `<title>Guide</title><div id="root"></div><script>setTimeout(() => { document.getElementById("root").innerHTML = "<h1>How sites check for bots</h1>" + "<p>Some sites ask you to verify you are human with a puzzle; this guide explains how those checks work and why they exist.</p>".repeat(40); }, 100);</script>`);
  if (p === "/article") return send(200, "text/html", `<title>Article</title><article>${"<p>Plain words anyone can read without a browser. </p>".repeat(20)}</article>`);
  send(404, "text/plain", "no such fixture");
});
// Stands for this Mac and private networks: every request it gets is a failure of the guard.
const canary = createServer((req, res) => {
  hits.canary.push(req.url);
  res.end("canary");
});
canary.on("upgrade", (req, sock) => {
  hits.canary.push(`upgrade ${req.url}`);
  sock.destroy();
});
canary.on("connect", (req, sock) => {
  hits.canary.push(`connect ${req.url}`);
  sock.destroy();
});
await new Promise((r) => server.listen(0, "127.0.0.1", r));
await new Promise((r) => canary.listen(0, "127.0.0.1", r));
const port = server.address().port;
const canaryPort = canary.address().port;
const at = (path) => `http://127.0.0.1:${port}${path}`;
const allow = () => (process.env.BOPS_FETCH_ALLOW = `127.0.0.1:${port}`);

/* ---------------- The run ---------------- */

const results = [];
let missed = [];
async function check(what, fn) {
  try {
    await fn();
  } catch (e) {
    missed.push({ what, error: e });
  }
}
async function part(name, fn) {
  missed = [];
  delete process.env.BOPS_FETCH_ALLOW;
  dns.table.clear();
  dns.calls.length = 0;
  try {
    await fn();
  } catch (e) {
    missed.push({ what: "(the part itself)", error: e });
  }
  results.push({ name, ok: !missed.length });
  console.log(`${missed.length ? "FAIL" : "ok  "} ${name}`);
  for (const m of missed) console.log(`       ${m.what}: ${m.error?.stack ?? m.error}`);
}
const noDashes = (text) => assert.ok(!/[–—]| - /.test(text), `a dash in ${JSON.stringify(text)}`);
async function failure(fn) {
  try {
    await fn();
  } catch (e) {
    noDashes(e.message);
    return e;
  }
  assert.fail("expected it to fail");
}

await part("When a page needs the browser", async () => {
  const html = (body, status = 200) => ({ status, contentType: "text/html", body });
  const scripts = '<script src="/a.js"></script><script src="/b.js"></script><script src="/c.js"></script>';
  for (const [what, got, want] of [
    ["an empty #root", html(`<title>App</title><div id="root"></div><script src="/app.js"></script>`), "shell"],
    ["an empty #__next", html(`<div id="__next"></div>`), "shell"],
    ["an empty #app", html(`<div id="app">  </div>`), "shell"],
    ["little text and many scripts", html(`<p>Loading</p>${scripts}`), "shell"],
    ["a noscript that asks for JavaScript", html(`<noscript>You need to enable JavaScript to run this app.</noscript><p>Hi</p>`), "shell"],
    ["Cloudflare's wait page, as a 403", html(`<title>Just a moment...</title><p>Checking your browser</p>`, 403), "challenge"],
    ["Cloudflare's wait page, as a 200", html(`<title>Just a moment...</title>`), "challenge"],
    ["a challenge script with no words", html(`<script src="/cdn-cgi/challenge-platform/h/b/orchestrate/chl_page/v1"></script>`, 503), "challenge"],
    ["verify you are human", html(`<p>Please verify you are a human to continue.</p>`), "challenge"],
    ["a 403 with a page", html(`<title>Forbidden</title><p>Access denied.</p>`, 403), "blocked"],
    ["a 429 with a page", html(`<p>Slow down</p>`, 429), "blocked"],
    ["a 503 with a page", html(`<p>Service unavailable</p>`, 503), "blocked"],
  ])
    await check(`${what}: ${want}`, () => assert.equal(needsBrowser(got), want));
  const long = `<h1>How we stop bots</h1>${"<p>Some sites ask you to verify you are human with a puzzle; this article explains how those checks work and why. </p>".repeat(30)}`;
  for (const [what, got] of [
    ["an article", html(`<title>News</title><article>${"<p>Words to read, plenty of them, without any script at all.</p>".repeat(10)}</article>${scripts}`)],
    ["a long page that only mentions a human check", html(long)],
    ["a 404 page", html("<title>Not found</title><p>Nothing here</p>", 404)],
    ["a 500 page", html("<p>Oops</p>", 500)],
    ["a 403 with no page", { status: 403, contentType: "text/html", body: "  " }],
    ["a 403 that's JSON", { status: 403, contentType: "application/json", body: '{"error":"forbidden"}' }],
    ["JSON", { status: 200, contentType: "application/json", body: "{}" }],
    ["plain text", { status: 200, contentType: "text/plain", body: "" }],
    ["a short page with no scripts", html("<title>Hi</title><p>Hello</p>")],
  ])
    await check(`${what}: not needed`, () => assert.equal(needsBrowser(got), null));
  await check("the wait words match the usual walls", () => {
    for (const t of ["Just a moment...", "Attention Required! | Cloudflare", "Checking your browser before accessing", "Verifying you are human. This may take a few seconds.", "Pardon Our Interruption", "Press & Hold to confirm you are a human"]) assert.match(t, CHALLENGE, t);
    for (const t of ["Prices loaded by JavaScript", "Welcome past the wall", "Just a moment ago", "Checking your order status", "One more step to finish your account"]) assert.doesNotMatch(t, CHALLENGE, t);
  });
  await check("the hidden window waits on the same words, its own copy (no pattern comes from a request)", () => {
    const own = /const WALL_WORDS =\s*(\/.*\/)([a-z]*);/.exec(readFileSync(join(root, "desktop/render.cjs"), "utf8"));
    assert.ok(own, "WALL_WORDS in desktop/render.cjs");
    assert.equal(own[1], `/${CHALLENGE.source}/`);
    assert.equal(own[2], CHALLENGE.flags);
  });
});

await part("Sites remembered as needing the browser, for 7 days", async () => {
  rmSync(sitesFile, { force: true });
  forgetSites();
  await check("none at first", () => assert.equal(siteNeedsBrowser("shop.example"), false));
  await check("remembered by name, www and case aside, and kept in the file", () => {
    rememberSite("WWW.Shop.Example");
    assert.equal(siteNeedsBrowser("shop.example"), true);
    assert.equal(siteNeedsBrowser("www.shop.example"), true);
    assert.equal(siteNeedsBrowser("other.example"), false);
    const kept = JSON.parse(readFileSync(sitesFile, "utf8"));
    assert.deepEqual(Object.keys(kept), ["shop.example"]);
    assert.ok(Math.abs(kept["shop.example"] - Date.now()) < 5000);
  });
  await check("read back from the file after a restart", () => {
    forgetSites();
    assert.equal(siteNeedsBrowser("shop.example"), true);
  });
  await check("one older than 7 days is forgotten", () => {
    const day = 24 * 60 * 60_000;
    writeFileSync(sitesFile, JSON.stringify({ "old.example": Date.now() - 7 * day - 1000, "recent.example": Date.now() - 6 * day, "bad.example": "soon" }));
    forgetSites();
    assert.equal(siteNeedsBrowser("old.example"), false);
    assert.equal(siteNeedsBrowser("recent.example"), true);
    assert.equal(siteNeedsBrowser("bad.example"), false);
  });
  await check("forgotten on purpose", () => {
    rememberSite("recent.example", false);
    assert.equal(siteNeedsBrowser("recent.example"), false);
    forgetSites();
    assert.equal(siteNeedsBrowser("recent.example"), false);
  });
  rmSync(sitesFile, { force: true });
  forgetSites();
});

/** CONNECT through the guard: the status line it answers with, and the socket (open on 200). */
function connectVia(guardPort, target) {
  return new Promise((resolve, reject) => {
    const s = net.connect(guardPort, "127.0.0.1", () => s.write(`CONNECT ${target} HTTP/1.1\r\nHost: ${target}\r\n\r\n`));
    let buf = "";
    s.setTimeout(5000, () => reject(new Error("no answer")));
    s.on("data", (d) => {
      buf += d;
      const end = buf.indexOf("\r\n\r\n");
      if (end < 0) return;
      s.removeAllListeners("data");
      resolve({ status: Number(/^HTTP\/1\.1 (\d+)/.exec(buf)?.[1]), socket: s, rest: buf.slice(end + 4) });
    });
    s.on("error", reject);
  });
}
/** A request through the guard as a browser sends one to a proxy (the full address as the path). */
function getVia(guardPort, path) {
  return new Promise((resolve, reject) => {
    const req = request({ host: "127.0.0.1", port: guardPort, path, method: "GET", headers: { Host: "x" } }, (res) => {
      let body = "";
      res.on("data", (d) => (body += d));
      res.on("end", () => resolve({ status: res.statusCode, body }));
    });
    req.on("error", reject);
    req.end();
  });
}

await part("The guard: every request a rendered page makes is checked like safe-fetch", async () => {
  dns.table.set("private.example", [{ address: "192.168.1.5", family: 4 }]);
  dns.table.set("mixed.example", [
    { address: "8.8.8.8", family: 4 },
    { address: "10.0.0.1", family: 4 },
  ]);
  dns.table.set("tailnet.example", [{ address: "100.100.1.1", family: 4 }]);
  dns.table.set("v6.example", [{ address: "fd00::1", family: 6 }]);
  hits.canary.length = 0;
  const guard = await openGuard(new URL(at("/app")));
  try {
    for (const target of [`127.0.0.1:${canaryPort}`, `localhost:${canaryPort}`, "10.0.0.1:443", "192.168.1.1:443", "169.254.169.254:80", "100.100.1.1:443", "[::1]:443", "[fd00::1]:443", "private.example:443", "mixed.example:443", "tailnet.example:443", "v6.example:443", "printer.local:443", "intranet:443", "example.com:8443", "example.com:22", "93.184.216.34:443", "garbage"])
      await check(`CONNECT ${target} is refused`, async () => {
        const { status, socket } = await connectVia(guard.port, target);
        socket.destroy();
        assert.equal(status, 403);
      });
    await check("a bare public address the page's names never had is refused without a connection", () => assert.ok(guard.refused.includes("93.184.216.34:443")));
    // Refused as a failed connection, not an answer: the page sees a network error, never a 403 it could read.
    for (const path of [`http://127.0.0.1:${canaryPort}/x`, `http://localhost:${canaryPort}/x`, "http://10.0.0.1/x", "http://private.example/x", "http://example.com:8080/x", `http://user:pw@127.0.0.1:${port}/app`])
      await check(`GET ${path} is refused`, async () => {
        const e = await getVia(guard.port, path).then(
          (r) => assert.fail(`answered ${r.status}`),
          (err) => err,
        );
        assert.match(e.code ?? e.message, /ECONNRESET|socket hang up/);
        assert.ok(guard.refused.includes(path), path);
      });
    await check("a request for a path alone (not through a proxy) is refused", async () => assert.equal((await getVia(guard.port, "/app")).status, 400));
    await check("the fixture is refused too, until BOPS_FETCH_ALLOW names it", async () => {
      const e = await getVia(guard.port, at("/app")).then(
        (r) => assert.fail(`answered ${r.status}`),
        (err) => err,
      );
      assert.ok(e);
    });
    allow();
    await check("then a plain request reaches it, and comes back", async () => {
      const got = await getVia(guard.port, at("/about"));
      assert.equal(got.status, 200);
      assert.match(got.body, /About us/);
    });
    await check("and a tunnel to it works (https and websockets go this way)", async () => {
      const { status, socket } = await connectVia(guard.port, `127.0.0.1:${port}`);
      assert.equal(status, 200);
      const body = await new Promise((resolve) => {
        let b = "";
        socket.on("data", (d) => (b += d));
        socket.on("end", () => resolve(b));
        socket.write("GET /about HTTP/1.1\r\nHost: fixture\r\nConnection: close\r\n\r\n");
      });
      assert.match(body, /About us/);
    });
    await check("Bops' own ports never, even when BOPS_FETCH_ALLOW names them", async () => {
      process.env.BOPS_FETCH_ALLOW = `127.0.0.1:${port},127.0.0.1:3210,127.0.0.1:9222,127.0.0.1:8897`;
      for (const t of ["127.0.0.1:3210", "127.0.0.1:9222", "127.0.0.1:8897"]) {
        const { status, socket } = await connectVia(guard.port, t);
        socket.destroy();
        assert.equal(status, 403, t);
      }
      await assert.rejects(getVia(guard.port, "http://127.0.0.1:3210/api/health"));
    });
    await check("the canary was never reached", () => assert.deepEqual(hits.canary, []));
    await check("only the names were looked up, never a bare address", () => assert.ok(dns.calls.every((h) => /[a-z]/.test(h) && !/^\d/.test(h)), dns.calls.join(", ")));
  } finally {
    guard.close();
  }
  await check("closed: nothing listens", async () => {
    const e = await connectVia(guard.port, `127.0.0.1:${port}`).then(
      (r) => (r.socket.destroy(), null),
      (err) => err,
    );
    assert.ok(e, "still listening");
  });
});

await part("No browser: pages read as they always did", async () => {
  allow();
  await check("an app's shell is read plain, with no via", async () => {
    const p = await readPage(at("/app"));
    assert.equal(p.via, undefined);
    assert.doesNotMatch(p.text, /Prices loaded/);
  });
  await check("renderPage says there's no browser", async () => {
    const e = await failure(() => renderPage(at("/app")));
    assert.match(e.message, /browser isn't available/);
  });
});

/* ---------------- The real browser (Electron, as the Mac app runs it) ---------------- */

const ELECTRON = join(root, "node_modules/electron/dist/Electron.app/Contents/MacOS/Electron");
if (process.platform !== "darwin" || !existsSync(ELECTRON)) {
  console.log(`skip The real browser: no Electron app at ${ELECTRON}`);
} else {
  const sockDir = mkdtempSync(join(tmpdir(), "bops-render-"));
  process.env.BOPS_RENDER_SOCKET = join(sockDir, "r.sock");
  process.env.BOPS_UI_TOKEN = "0123456789abcdef".repeat(4); // gitleaks:allow (a made-up token for this test)
  const harnessEnv = { ...process.env };
  delete harnessEnv.BOPS_FETCH_ALLOW;
  const electron = spawn(ELECTRON, [join(root, "scripts/render-harness.cjs")], { env: harnessEnv, stdio: ["pipe", "pipe", "pipe"] });
  let harnessLog = "";
  electron.stderr.on("data", (d) => (harnessLog += d));
  const started = await new Promise((resolve) => {
    const timer = setTimeout(() => resolve(false), 20_000);
    electron.stdout.on("data", (d) => String(d).includes("ready") && (clearTimeout(timer), resolve(true)));
    electron.once("exit", () => (clearTimeout(timer), resolve(false)));
  });
  const browserHits = (path) => hits.browser.get(path) ?? 0;
  const plainHits = (path) => hits.plain.get(path) ?? 0;
  const fresh = () => {
    rmSync(sitesFile, { force: true });
    forgetSites();
  };

  await part("The real browser: it starts", async () => {
    await check("the harness listens", () => assert.ok(started, harnessLog));
    await check("nothing open, nothing waiting", async () => assert.deepEqual(await browserStatus(), { open: 0, waiting: 0 }));
  });

  if (started) {
    await part("The real browser: everything goes through the guard, this Mac's own addresses too", async () => {
      // A guard that lets nothing through and notes what it was asked: the page can't load around it.
      const asked = [];
      const shut = createServer((req, res) => {
        asked.push(req.url);
        res.socket.destroy();
      });
      shut.on("connect", (req, sock) => {
        asked.push(`connect ${req.url}`);
        sock.destroy();
      });
      await new Promise((r) => shut.listen(0, "127.0.0.1", r));
      const before = browserHits("/app");
      const answer = await new Promise((resolve, reject) => {
        const sock = net.connect(process.env.BOPS_RENDER_SOCKET);
        let buf = "";
        sock.on("connect", () => sock.write(`${JSON.stringify({ token: process.env.BOPS_UI_TOKEN, url: at("/app"), proxyPort: shut.address().port, allow: [`127.0.0.1:${port}`], limitMs: 5000 })}\n`));
        sock.on("data", (d) => (buf += d));
        sock.on("end", () => resolve(JSON.parse(buf)));
        sock.on("error", reject);
      });
      shut.close();
      await check("the page didn't load", () => assert.equal(answer.ok, false));
      await check("the guard was asked for it", () => assert.ok(asked.includes(at("/app")), asked.join(", ")));
      await check("the fixture never heard from the browser", () => assert.equal(browserHits("/app"), before));
    });

    await part("The real browser: a page whose text only appears after JavaScript runs", async () => {
      allow();
      fresh();
      const plain0 = plainHits("/app");
      const browser0 = browserHits("/app");
      await check("readPage reads it in the browser, after a plain fetch showed a shell", async () => {
        const p = await readPage(at("/app"));
        assert.equal(p.via, "browser");
        assert.equal(p.title, "Price board");
        assert.match(p.text, /Prices loaded by JavaScript/);
        assert.match(p.text, /Widget Pro · \$19\.99/);
        assert.match(p.text, /Free shipping on every order/);
        assert.deepEqual(p.links, [{ url: at("/about"), text: "About the price board" }]);
        assert.equal(p.url, at("/app"));
        assert.equal(plainHits("/app"), plain0 + 1);
        assert.equal(browserHits("/app"), browser0 + 1);
      });
      await check("its site is remembered, so the next read goes straight to the browser", async () => {
        assert.equal(siteNeedsBrowser("127.0.0.1"), true);
        const lines = await pageLines(at("/app"));
        assert.equal(lines.via, "browser");
        assert.equal(lines.kind, "html");
        assert.ok(lines.lines.includes("Widget Pro · $19.99"), lines.lines.join(" | "));
        assert.ok(lines.lines.includes("Widget Mini · $9.99"));
        assert.ok(lines.lines.includes("Prices loaded by JavaScript"));
        assert.equal(plainHits("/app"), plain0 + 1, "no plain fetch the second time");
        assert.equal(browserHits("/app"), browser0 + 2);
      });
      await check("a plain page on a remembered site is read in the browser too, and still reads", async () => {
        const p = await readPage(at("/article"));
        assert.equal(p.via, "browser");
        assert.match(p.text, /Plain words anyone can read/);
      });
      await check("a file on a remembered site (a PDF) fails at once in the browser, then a plain fetch says what it is", async () => {
        const t = Date.now();
        const e = await failure(() => readPage(at("/file.pdf")));
        assert.match(e.message, /PDF/);
        assert.ok(Date.now() - t < 8000, `${Date.now() - t} ms`);
      });
      await check("a long page that mentions a human check is read at once, not waited on as a wall", async () => {
        const t = Date.now();
        const p = await readPage(at("/guide"));
        assert.equal(p.via, "browser");
        assert.match(p.text, /How sites check for bots/);
        assert.ok(Date.now() - t < 8000, `${Date.now() - t} ms`);
      });
      await check("the browser says it's Chrome, not Electron or Bops", () => {
        assert.ok(userAgents.size > 0);
        for (const ua of userAgents) assert.doesNotMatch(ua, /Electron|Bops/, ua);
      });
      fresh();
      await check("a plain page on a site not remembered never goes to the browser", async () => {
        const before = browserHits("/article");
        const p = await readPage(at("/article"));
        assert.equal(p.via, undefined);
        assert.equal(browserHits("/article"), before);
      });
      await check("every window was destroyed", async () => assert.deepEqual(await browserStatus(), { open: 0, waiting: 0 }));
    });

    await part("The real browser: a page behind a check for a human", async () => {
      allow();
      fresh();
      await check("a plain fetch sees the wall (403), with no browser", async () => {
        const sock = process.env.BOPS_RENDER_SOCKET;
        delete process.env.BOPS_RENDER_SOCKET;
        try {
          const e = await failure(() => readPage(at("/wall")));
          assert.match(e.message, /answered 403/);
        } finally {
          process.env.BOPS_RENDER_SOCKET = sock;
        }
      });
      fresh();
      await check("the browser waits for the wall to let it through, then reads the page", async () => {
        const p = await readPage(at("/wall"));
        assert.equal(p.via, "browser");
        assert.equal(p.title, "Members news");
        assert.match(p.text, /Welcome past the wall/);
        assert.equal(siteNeedsBrowser("127.0.0.1"), true);
      });
      fresh();
      await check("a wall that never lets it through fails, said plainly, once its time is up", async () => {
        const t = Date.now();
        const e = await failure(() => renderPage(at("/wall-forever"), { limitMs: 4000 }));
        assert.match(e.message, /kept checking for a human/);
        assert.ok(Date.now() - t < 9000, `${Date.now() - t} ms`);
      });
      await check("nothing remembered for it", () => assert.equal(siteNeedsBrowser("127.0.0.1"), false));
      await check("every window was destroyed", async () => assert.deepEqual(await browserStatus(), { open: 0, waiting: 0 }));
    });

    await part("The real browser: a page that reaches for private addresses", async () => {
      allow();
      fresh();
      dns.table.set("private.example", [{ address: "192.168.1.5", family: 4 }]);
      hits.canary.length = 0;
      let p;
      await check("it's read", async () => {
        p = await readPage(at("/reach"));
        assert.equal(p.via, "browser");
      });
      await check("every way it tried was blocked", () => {
        for (const name of ["fetch-ip", "fetch-localhost", "fetch-private-name", "fetch-ten", "fetch-bops", "fetch-file", "socket", "beacon-xhr"]) assert.match(p?.text ?? "", new RegExp(`${name} blocked`), p?.text);
        assert.doesNotMatch(p?.text ?? "", /reached/);
      });
      await check("the canary never heard from it (image, frame, fetch, XHR, websocket)", () => assert.deepEqual(hits.canary, []));
      await check("the refusals are on record", () => {
        const refused = lastGuardRefusals().join("\n");
        assert.match(refused, new RegExp(`127\\.0\\.0\\.1:${canaryPort}`));
        assert.match(refused, /private\.example/);
        assert.match(refused, /3210/);
        assert.match(refused, /10\.0\.0\.1/);
      });
      await check("every window was destroyed", async () => assert.deepEqual(await browserStatus(), { open: 0, waiting: 0 }));
    });

    await part("The real browser: never for an address safe-fetch refuses", async () => {
      fresh();
      const before = [...hits.browser.values()].reduce((a, b) => a + b, 0);
      await check("a private address is refused before any browser", async () => {
        const e = await failure(() => readPage("http://10.0.0.1/"));
        assert.ok(e instanceof FetchRefused);
      });
      await check("and the fixture without BOPS_FETCH_ALLOW", async () => {
        const e = await failure(() => pageLines(at("/app")));
        assert.ok(e instanceof FetchRefused);
      });
      await check("nothing went to the browser", () => assert.equal([...hits.browser.values()].reduce((a, b) => a + b, 0), before));
    });

    await part("The real browser: one page at a time, a few waiting", async () => {
      allow();
      mostHolding = 0;
      const all = await Promise.allSettled([1, 2, 3, 4, 5, 6].map((n) => renderPage(at(`/hold?n=${n}`))));
      await check("five read, one at a time", () => {
        assert.equal(all.filter((r) => r.status === "fulfilled").length, 5);
        assert.equal(mostHolding, 1);
      });
      await check("the sixth refused at once, said plainly", () => {
        const no = all.find((r) => r.status === "rejected");
        assert.match(no?.reason?.message ?? "", /Too many pages are waiting/);
        noDashes(no.reason.message);
      });
      await check("every window was destroyed", async () => assert.deepEqual(await browserStatus(), { open: 0, waiting: 0 }));
    });

    await part("The real browser: a slow page hits the time limit", async () => {
      allow();
      fresh();
      await check("the limit is 20 seconds", () => assert.equal(RENDER_LIMIT_MS, 20_000));
      await check("renderPage gives up at its limit", async () => {
        const t = Date.now();
        const e = await failure(() => renderPage(at("/slow"), { limitMs: 3000 }));
        assert.match(e.message, /took too long/);
        assert.ok(Date.now() - t < 6000, `${Date.now() - t} ms`);
      });
      await check("readPage waits the full 20 seconds, then reads it as a plain fetch did", async () => {
        const t = Date.now();
        const p = await readPage(at("/slow"));
        const took = Date.now() - t;
        assert.equal(p.via, undefined);
        assert.ok(took >= 19_000 && took < 28_000, `${took} ms`);
        assert.equal(siteNeedsBrowser("127.0.0.1"), false);
      });
      await check("every window was destroyed", async () => assert.deepEqual(await browserStatus(), { open: 0, waiting: 0 }));
      for (const res of held) res.destroy();
      held.clear();
    });

    await part("The real browser: a wrong token is refused", async () => {
      const token = process.env.BOPS_UI_TOKEN;
      process.env.BOPS_UI_TOKEN = "f".repeat(64);
      await check("not allowed", async () => {
        const e = await failure(() => renderPage(at("/app")));
        assert.match(e.message, /Not allowed/);
      });
      process.env.BOPS_UI_TOKEN = token;
    });
  }

  electron.stdin.end();
  await new Promise((r) => {
    const timer = setTimeout(() => (electron.kill("SIGKILL"), r()), 5000);
    electron.once("exit", () => (clearTimeout(timer), r()));
  });
  rmSync(sockDir, { recursive: true, force: true });
}

server.close();
canary.close();
for (const res of held) res.destroy();
server.closeAllConnections?.();
rmSync(scratch, { recursive: true, force: true });
const failed = results.filter((r) => !r.ok);
console.log(`\n${results.length - failed.length}/${results.length} parts passed`);
process.exit(failed.length ? 1 : 0);
