// Tests for reading public web pages safely: lib/server/safe-fetch.ts (which addresses Bops will open at
// all, the lookup and the pinned connection, redirects, the byte cap, the clock, the kinds of file it
// reads, compression and charsets) and lib/server/web-page.ts (readPage for a bot's web_fetch,
// pageLines and htmlLines for page monitors). The pages come from a fixture server on 127.0.0.1 with a
// port the system picks, reachable only through BOPS_FETCH_ALLOW; DNS is a stand-in table, so no name is
// looked up and nothing reaches the network. Every message a user could see is checked for dashes.
// Usage: node --conditions=react-server scripts/test-web.mjs
import assert from "node:assert/strict";
import { createServer } from "node:http";
import { registerHooks } from "node:module";
import { pathToFileURL } from "node:url";
import zlib from "node:zlib";

for (const k of Object.keys(process.env)) if (/^BOPS_/.test(k)) delete process.env[k];
const root = new URL("..", import.meta.url).pathname.replace(/\/$/, "");

// DNS for safe-fetch.ts is this table: a name not in it isn't found, and every lookup is counted.
const dns = { table: new Map(), calls: [] };
globalThis.__webTestLookup = async (host, opts) => {
  dns.calls.push(host);
  assert.equal(opts?.all, true, "every address is asked for");
  const found = dns.table.get(host);
  if (!found) throw Object.assign(new Error(`getaddrinfo ENOTFOUND ${host}`), { code: "ENOTFOUND" });
  return found;
};
const FAKE_DNS = `data:text/javascript,${encodeURIComponent("export const lookup = (...a) => globalThis.__webTestLookup(...a);")}`;
// This Mac's network connections, for safe-fetch.ts: a stand-in a part sets (none: no connections but loopback).
globalThis.__webTestInterfaces = () => ({ lo0: [{ address: "127.0.0.1", netmask: "255.0.0.0", family: "IPv4", mac: "00:00:00:00:00:00", internal: true, cidr: "127.0.0.1/8" }] });
const FAKE_OS = `data:text/javascript,${encodeURIComponent("export const networkInterfaces = () => globalThis.__webTestInterfaces();")}`;

// The server modules import "@/lib/…" and "./app-version" (no extension), the way Next resolves them.
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

const { FetchRefused, checkUrl, isBlockedAddress, safeFetch } = await import(pathToFileURL(`${root}/lib/server/safe-fetch.ts`).href);
const { READ_PAGE_MAX_CHARS, htmlLines, pageLines, readPage } = await import(pathToFileURL(`${root}/lib/server/web-page.ts`).href);

/* ---------------- The fixture pages ---------------- */

const para = (n) => `<p>Paragraph ${n} of the story, long enough to read like an article: the council met on Tuesday and voted to keep the library open late through the winter, after hundreds of residents wrote in.</p>`;
const ARTICLE = `<!doctype html><html><head><title>Library stays open | Town News</title><style>p { color: red }</style></head><body>
<nav><a href="/">Home</a> <a href="/news">News</a> <a href="/sports">Sports</a></nav>
<article><h1>Library stays open late</h1>${[1, 2, 3, 4, 5, 6, 7, 8].map(para).join("\n")}</article>
<footer>Copyright Town News. All rights reserved.</footer><script>window.tracker = "nope";</script></body></html>`;
// A store listing: a table and a list with little running text, so Readability has no article to find.
const LISTING = `<!doctype html><html><head><title>Widgets</title></head><body>
<header>Widget Store</header>
<table><tr><th>Item</th><th>Price</th><th>Stock</th></tr><tr><td>Widget Pro</td><td>$19.99</td><td>In stock</td></tr><tr><td>Widget Mini</td><td></td><td>Sold out</td></tr></table>
<ul><li>Free shipping</li><li>30 day returns</li></ul><button>Add to cart</button></body></html>`;
const FEED = `<?xml version="1.0"?><rss version="2.0"><channel><title>Town feed</title><link>https://town.example/</link>
<item><title>Library &amp; parks</title><description><![CDATA[<p>Open <b>late</b> all winter</p>]]></description><pubDate>Mon, 13 Oct 2026 09:00:00 GMT</pubDate></item>
<item><title>Roads</title><description>&lt;p&gt;Main St closed&lt;/p&gt;</description></item></channel></rss>`;

const held = new Set();
let port = 0;
const server = createServer((req, res) => {
  const url = new URL(req.url, "http://fixture");
  const p = url.pathname;
  const send = (status, type, body, headers = {}) => {
    res.writeHead(status, { ...(type ? { "Content-Type": type } : {}), ...headers });
    res.end(body);
  };
  if (p === "/article") return send(200, "text/html; charset=utf-8", ARTICLE);
  if (p === "/listing") return send(200, "text/html", LISTING);
  if (p === "/plain") return send(200, "text/plain", "line one\r\nline two\n\n  indented three\n");
  if (p === "/long") return send(200, "text/plain", `${"word ".repeat(1000)}\n`.repeat(5));
  if (p === "/json") return send(200, "application/json", JSON.stringify({ name: "Widget Pro", price: 19.99, tags: ["new", "hot"] }));
  if (p === "/badjson") return send(200, "application/problem+json", "{ not json");
  if (p === "/feed") return send(200, "application/rss+xml", FEED);
  if (p === "/echo") return send(200, "application/json", JSON.stringify({ host: req.headers.host, ua: req.headers["user-agent"], accept: req.headers.accept, path: req.url }));
  if (p === "/redirect") return send(Number(url.searchParams.get("status") ?? 302), "text/plain", "moved", { Location: url.searchParams.get("to") });
  // Nested 10,000 deep in under half a megabyte: Readability alone would take many seconds on it.
  if (p === "/deep") return send(200, "text/html", `<!doctype html><html><head><title>Deep</title></head><body>${'<div><a href="/x">link</a> some text here '.repeat(10_000)}${"</div>".repeat(10_000)}</body></html>`);
  if (p.startsWith("/chain/")) {
    const n = Number(p.slice(7));
    return n > 0 ? send(302, "", "", { Location: `/chain/${n - 1}` }) : send(200, "text/html", "<title>End</title><p>End of the chain</p>");
  }
  if (p === "/big") {
    // 3 MB, a chunk at a time, ending only if the client reads it all.
    res.writeHead(200, { "Content-Type": "text/plain" });
    const chunk = Buffer.alloc(64 * 1024, "a");
    let sent = 0;
    const pump = () => {
      while (sent < 3 * 1024 * 1024) {
        sent += chunk.length;
        if (!res.write(chunk)) return res.once("drain", pump);
      }
      res.end();
    };
    return pump();
  }
  if (p === "/bomb") return send(200, "text/plain", BOMB, { "Content-Encoding": "gzip" });
  if (p === "/gzip") return send(200, "text/html", zlib.gzipSync(LISTING), { "Content-Encoding": "gzip" });
  if (p === "/br") return send(200, "text/html", zlib.brotliCompressSync(LISTING), { "Content-Encoding": "br" });
  if (p === "/compress") return send(200, "text/html", "x", { "Content-Encoding": "compress" });
  if (p === "/latin1") return send(200, "text/html; charset=iso-8859-1", Buffer.from("<title>Caf\xe9</title><p>Cr\xe8me br\xfbl\xe9e</p>", "latin1"));
  if (p === "/meta-charset") return send(200, "text/html", Buffer.from('<meta charset="windows-1252"><p>Price: \x80 5</p>', "latin1"));
  if (p === "/png") return send(200, "image/png", Buffer.from([0x89, 0x50, 0x4e, 0x47]));
  if (p === "/pdf") return send(200, "application/pdf", "%PDF-1.4");
  if (p === "/untyped") return send(200, "", "who knows");
  if (p === "/missing") return send(404, "text/html", "<title>Not found</title><p>Nothing here</p>");
  if (p === "/down") return send(503, "image/png", "x");
  if (p === "/stall-headers") return held.add(res);
  if (p === "/stall-body") {
    res.writeHead(200, { "Content-Type": "text/plain" });
    res.write("start of a page that never ends");
    return held.add(res);
  }
  send(404, "text/plain", "no such fixture");
});
const BOMB = zlib.gzipSync(Buffer.alloc(20 * 1024 * 1024));
await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
port = server.address().port;
const at = (path) => `http://127.0.0.1:${port}${path}`;
const allow = (...extra) => (process.env.BOPS_FETCH_ALLOW = [`127.0.0.1:${port}`, ...extra].join(","));

/* ---------------- The run ---------------- */

const results = [];
let missed = [];
/** A named check inside a part: one that fails is reported by name, and the rest of the part still runs. */
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
  results.push({ name, ok: !missed.length, checks: missed.map((m) => `${name}: ${m.what}`) });
  console.log(`${missed.length ? "FAIL" : "ok  "} ${name}`);
  for (const m of missed) console.log(`       ${m.what}: ${m.error?.stack ?? m.error}`);
}

/** No em or en dash, and no " - " used as punctuation, in anything a user could read. */
const noDashes = (text) => assert.ok(!/[–—]| - /.test(text), `a dash in ${JSON.stringify(text)}`);
/** The error a promise or function ends with (it must end with one). */
async function failure(fn) {
  try {
    await fn();
  } catch (e) {
    noDashes(e.message);
    return e;
  }
  assert.fail("expected it to fail");
}
const refused = async (fn, re) => {
  const e = await failure(fn);
  assert.ok(e instanceof FetchRefused, `refused, not ${e.name}: ${e.message}`);
  if (re) assert.match(e.message, re);
  return e;
};

await part("The address classifier", async () => {
  const blocked = [
    "127.0.0.1",
    "127.255.255.254",
    "0.0.0.0",
    "0.1.2.3",
    "10.1.2.3",
    "100.64.0.1",
    "100.100.1.1",
    "100.127.255.255",
    "169.254.169.254",
    "172.16.0.1",
    "172.31.255.255",
    "192.168.1.1",
    "192.0.2.10",
    "198.18.0.1",
    "224.0.0.1",
    "240.0.0.1",
    "255.255.255.255",
    "::1",
    "::",
    "[::1]",
    "0:0:0:0:0:0:0:1",
    "::ffff:127.0.0.1",
    "::ffff:7f00:1",
    "::ffff:8.8.8.8",
    "::127.0.0.1",
    "fc00::1",
    "fd12:3456::1",
    "fe80::1",
    "fe80::1%en0",
    "fec0::1",
    "ff02::1",
    "64:ff9b::7f00:1",
    "64:ff9b::10.0.0.1",
    "64:ff9b:1::1",
    "2001:db8::1",
    "2001:0:4136:e378::1",
    "2002:7f00:1::1",
    "100::1",
    "not an address",
    "",
  ];
  const open = ["8.8.8.8", "1.1.1.1", "93.184.216.34", "100.63.255.255", "100.128.0.1", "172.15.255.255", "172.32.0.1", "192.169.0.1", "2606:4700:4700::1111", "[2a00:1450:4001::200e]", "64:ff9b::808:808", "64:ff9b::8.8.8.8"];
  for (const a of blocked) await check(`${a || "(empty)"} is blocked`, () => assert.equal(isBlockedAddress(a), true));
  for (const a of open) await check(`${a} is public`, () => assert.equal(isBlockedAddress(a), false));
});

await part("Addresses refused before any lookup", async () => {
  // Every spelling of this Mac the URL parser accepts ends up as its plain form, and is refused.
  for (const url of [
    "http://2130706433/",
    "http://0177.0.0.1/",
    "http://0x7f.1/",
    "http://127.1/",
    "http://0.0.0.0/",
    "http://[::1]/",
    "http://[0:0:0:0:0:0:0:1]/",
    "http://[::ffff:127.0.0.1]/",
    "http://[::ffff:7f00:1]/",
    "http://[64:ff9b::7f00:1]/",
    "http://100.100.1.1/",
    "http://169.254.169.254/latest/meta-data/",
    "http://[fd00::1]/",
    "http://[fe80::1]/",
    "http://localhost/",
    "http://LOCALHOST./",
    "http://app.localhost/",
    "http://printer.local/",
    "http://metadata.google.internal/",
    "http://mac.tail1234.ts.net/",
    "http://router.home.arpa/",
    "http://intranet/",
  ])
    await check(`${url} is private`, () => refused(() => checkUrl(url), /this Mac or a private network/));
  for (const [url, re] of [
    ["https://example.com:8080/", /usual ports \(80 and 443\), not 8080/],
    ["http://example.com:22/", /not 22/],
    ["ftp://example.com/", /http and https/],
    ["file:///etc/passwd", /http and https/],
    ["javascript:alert(1)", /http and https/],
    ["data:text/html,hi", /http and https/],
    ["http://user:secret@example.com/", /password/],
    ["http://user@example.com/", /user name/],
    ["not a url", /isn't a web address/],
    ["", /isn't a web address/],
  ])
    await check(`${url || "(empty)"} is refused`, () => refused(() => checkUrl(url), re));
  for (const url of ["https://example.com/", "http://example.com:80/x", "https://example.com:443/", "https://sub.example.co.uk/path?q=1#top", "  https://example.com/padded  "])
    await check(`${url.trim()} passes`, () => assert.ok(checkUrl(url) instanceof URL));
  await check("safeFetch refuses them without a lookup or a connection", async () => {
    await refused(() => safeFetch("http://127.0.0.1/"), /private network/);
    await refused(() => safeFetch("http://localhost/"));
    assert.deepEqual(dns.calls, []);
  });
});

await part("The fixture is refused unless BOPS_FETCH_ALLOW names it", async () => {
  await check("refused without it (its port, then its address)", async () => {
    await refused(() => safeFetch(at("/plain")), new RegExp(`not ${port}`));
  });
  await check("refused when the list names another port", async () => {
    process.env.BOPS_FETCH_ALLOW = `127.0.0.1:${port + 1}, localhost:${port}`;
    await refused(() => safeFetch(at("/plain")));
  });
  await check("read when it does", async () => {
    allow();
    const got = await safeFetch(at("/plain"));
    assert.equal(got.status, 200);
    assert.equal(got.contentType, "text/plain");
    assert.equal(got.body, "line one\r\nline two\n\n  indented three\n");
    assert.equal(got.truncated, false);
    assert.equal(got.url, at("/plain"));
  });
  await check("never for Bops itself, the relay or DevTools", () => {
    process.env.BOPS_FETCH_ALLOW = "127.0.0.1:3210,127.0.0.1:8897,127.0.0.1:9200,127.0.0.1:9222,127.0.0.1:9399,localhost:3210";
    for (const url of ["http://127.0.0.1:3210/api/health", "http://127.0.0.1:8897/", "http://127.0.0.1:9200/json/list", "http://127.0.0.1:9222/json/new", "http://127.0.0.1:9399/", "http://localhost:3210/"]) assert.throws(() => checkUrl(url), FetchRefused, url);
  });
  await check("a password in the address is refused even when allowed", async () => {
    allow();
    await refused(() => safeFetch(`http://u:p@127.0.0.1:${port}/plain`), /password/);
  });
  await check("the request says it's Bops", async () => {
    allow();
    const echo = JSON.parse((await safeFetch(at("/echo?x=1#frag"))).body);
    assert.match(echo.ua, /^Bops\/\S+ \(\+https:\/\/bops\.bot\)$/);
    assert.equal(echo.path, "/echo?x=1");
    assert.match(echo.accept, /text\/html/);
  });
});

await part("Lookups: every address checked, the connection pinned", async () => {
  await check("a name that points to this Mac is refused", async () => {
    dns.table.set("rebind.test", [{ address: "127.0.0.1", family: 4 }]);
    await refused(() => safeFetch("http://rebind.test/"), /rebind\.test points to this Mac or a private network/);
  });
  await check("one private address among public ones refuses the name", async () => {
    dns.table.set("mixed.test", [
      { address: "93.184.216.34", family: 4 },
      { address: "10.0.0.7", family: 4 },
    ]);
    await refused(() => safeFetch("https://mixed.test/"));
  });
  await check("an IPv4-mapped answer is refused", async () => {
    dns.table.set("mapped.test", [{ address: "::ffff:8.8.8.8", family: 6 }]);
    await refused(() => safeFetch("http://mapped.test/"));
  });
  await check("a name that isn't found says so", async () => {
    const e = await failure(() => safeFetch("http://nowhere.test/"));
    assert.ok(!(e instanceof FetchRefused));
    assert.equal(e.message, "Couldn't find a website called nowhere.test.");
  });
  await check("the connection goes to the address that was checked, with one lookup", async () => {
    // pinned.test exists only in the stand-in table: had the connection asked the system's DNS
    // again, it would not have been found. The Host header still names the site.
    dns.table.set("pinned.test", [{ address: "127.0.0.1", family: 4 }]);
    allow(`pinned.test:${port}`);
    dns.calls.length = 0;
    const got = await safeFetch(`http://pinned.test:${port}/echo`);
    assert.equal(JSON.parse(got.body).host, `pinned.test:${port}`);
    assert.deepEqual(dns.calls, ["pinned.test"]);
  });
});

await part("Redirects", async () => {
  allow();
  await check("a relative redirect is followed, and the final address returned", async () => {
    const got = await safeFetch(at("/redirect?to=/listing"));
    assert.equal(got.url, at("/listing"));
    assert.match(got.body, /Widget Pro/);
  });
  await check("301, 303, 307 and 308 are followed too", async () => {
    for (const status of [301, 303, 307, 308]) assert.equal((await safeFetch(at(`/redirect?status=${status}&to=/plain`))).url, at("/plain"));
  });
  for (const to of ["http://10.0.0.1/", "http://192.168.1.1/admin", `http://localhost:${port}/plain`, `http://[::1]:${port}/plain`, "http://169.254.169.254/latest/meta-data/", "http://127.0.0.1:3210/api/health", "http://127.0.0.1:9222/json/list", "file:///etc/passwd", `http://u:p@127.0.0.1:${port}/plain`])
    await check(`a redirect to ${to} is refused`, () => refused(() => safeFetch(at(`/redirect?to=${encodeURIComponent(to)}`))));
  await check("a redirect to a name that points to a private network is refused", async () => {
    dns.table.set("inside.test", [{ address: "192.168.0.10", family: 4 }]);
    await refused(() => safeFetch(at(`/redirect?to=${encodeURIComponent("http://inside.test/")}`)), /inside\.test points/);
  });
  await check("5 redirects are followed", async () => {
    const got = await safeFetch(at("/chain/5"));
    assert.equal(got.url, at("/chain/0"));
    assert.match(got.body, /End of the chain/);
  });
  await check("a 6th is too many", async () => {
    const e = await failure(() => safeFetch(at("/chain/6")));
    assert.equal(e.message, "That page sent Bops through too many redirects.");
  });
});

await part("This Mac's own networks, and redirects to a bare address", async () => {
  // A home network with IPv6: the Mac's address there is public, and so are its neighbors' (the router's, a NAS's).
  const home = {
    lo0: [{ address: "127.0.0.1", netmask: "255.0.0.0", family: "IPv4", mac: "00:00:00:00:00:00", internal: true, cidr: "127.0.0.1/8" }],
    en0: [
      { address: "192.168.1.20", netmask: "255.255.255.0", family: "IPv4", mac: "aa:bb:cc:dd:ee:ff", internal: false, cidr: "192.168.1.20/24" },
      { address: "2600:1700:abcd:1234::5", netmask: "ffff:ffff:ffff:ffff::", family: "IPv6", mac: "aa:bb:cc:dd:ee:ff", internal: false, scopeid: 0, cidr: "2600:1700:abcd:1234::5/64" },
      { address: "fe80::1%en0", netmask: "ffff:ffff:ffff:ffff::", family: "IPv6", mac: "aa:bb:cc:dd:ee:ff", internal: false, scopeid: 4, cidr: "fe80::1/64" },
    ],
  };
  globalThis.__webTestInterfaces = () => home;
  try {
    await check("an address on the home's IPv6 network is refused before any lookup", () => refused(() => checkUrl("http://[2600:1700:abcd:1234::1]/"), /this Mac or a private network/));
    await check("this Mac's own public address too", () => refused(() => checkUrl("http://[2600:1700:abcd:1234::5]/")));
    await check("another network's address passes", () => assert.ok(checkUrl("http://[2600:1700:abcd:9999::1]/") instanceof URL));
    await check("a name that points into the home network is refused", async () => {
      dns.table.set("nas.test", [{ address: "2600:1700:abcd:1234::77", family: 6 }]);
      await refused(() => safeFetch("http://nas.test/"), /nas\.test points to this Mac or a private network/);
    });
    await check("a redirect into the home network is refused", async () => {
      allow();
      await refused(() => safeFetch(at(`/redirect?to=${encodeURIComponent("http://[2600:1700:abcd:1234::1]/")}`)));
    });
    await check("a redirect to a bare address the site's name didn't have is refused (a home's own public address)", async () => {
      dns.table.set("site.test", [{ address: "127.0.0.1", family: 4 }]);
      allow(`site.test:${port}`);
      const e = await refused(() => safeFetch(`http://site.test:${port}/redirect?to=${encodeURIComponent("http://73.12.34.56/admin")}`));
      assert.equal(e.message, "That page redirected to a bare network address, so Bops won't follow it.");
    });
    await check("the networks are read fresh each time (the Mac moved)", () => {
      globalThis.__webTestInterfaces = () => ({});
      assert.ok(checkUrl("http://[2600:1700:abcd:1234::1]/") instanceof URL);
    });
  } finally {
    globalThis.__webTestInterfaces = () => ({});
  }
});

await part("The byte cap", async () => {
  allow();
  await check("a page over the cap is cut there, not refused", async () => {
    const got = await safeFetch(at("/big"), { maxBytes: 100_000 });
    assert.equal(got.body.length, 100_000);
    assert.equal(got.truncated, true);
  });
  await check("2 MB by default", async () => {
    const got = await safeFetch(at("/big"));
    assert.equal(got.body.length, 2 * 1024 * 1024);
    assert.equal(got.truncated, true);
  });
  await check("the cap counts unzipped bytes (a zip bomb stops at it)", async () => {
    const got = await safeFetch(at("/bomb"), { maxBytes: 50_000 });
    assert.equal(got.body.length, 50_000);
    assert.equal(got.truncated, true);
  });
  await check("a page under the cap is whole", async () => {
    const got = await safeFetch(at("/plain"), { maxBytes: 100_000 });
    assert.equal(got.truncated, false);
  });
});

await part("The clock", async () => {
  allow();
  await check("a site that never answers runs out of time", async () => {
    const started = Date.now();
    const e = await failure(() => safeFetch(at("/stall-headers"), { timeoutMs: 300 }));
    assert.equal(e.message, "127.0.0.1 took too long to answer.");
    assert.ok(Date.now() - started < 3000);
  });
  await check("so does a page that never finishes", async () => {
    const e = await failure(() => safeFetch(at("/stall-body"), { timeoutMs: 300 }));
    assert.equal(e.message, "127.0.0.1 took too long to answer.");
  });
  await check("a closed port says so", async () => {
    const closed = createServer();
    await new Promise((r) => closed.listen(0, "127.0.0.1", r));
    const p = closed.address().port;
    await new Promise((r) => closed.close(r));
    allow(`127.0.0.1:${p}`);
    const e = await failure(() => safeFetch(`http://127.0.0.1:${p}/`));
    assert.equal(e.message, "127.0.0.1 refused the connection.");
  });
});

await part("The kinds of file read", async () => {
  allow();
  for (const [path, re] of [
    ["/png", /an image, not a page/],
    ["/pdf", /a PDF, not a page/],
    ["/untyped", /didn't say what kind of file/],
  ])
    await check(`${path} is refused`, () => refused(() => safeFetch(at(path)), re));
  await check("an error answer that isn't a page comes back with its status and no body", async () => {
    const got = await safeFetch(at("/down"));
    assert.equal(got.status, 503);
    assert.equal(got.body, "");
  });
  await check("gzip and brotli are unzipped", async () => {
    for (const path of ["/gzip", "/br"]) assert.match((await safeFetch(at(path))).body, /Widget Pro/);
  });
  await check("an unknown compression is an error", async () => {
    await failure(() => safeFetch(at("/compress")));
  });
  await check("a charset in the header is used", async () => {
    assert.match((await safeFetch(at("/latin1"))).body, /Crème brûlée/);
  });
  await check("so is one in a meta tag", async () => {
    assert.match((await safeFetch(at("/meta-charset"))).body, /Price: € 5/);
  });
});

await part("htmlLines", async () => {
  const page = `<!doctype html><html><head><title>  The   page </title><script>var a = "script text";</script><style>.x{}</style><meta name="x" content="meta text"></head>
  <body><noscript>Turn on JavaScript</noscript><svg><text>svg text</text></svg><template><p>template text</p></template>
  <h1>Big <em>news</em></h1><p>First   paragraph
     spans lines.<br>After a break</p>
  <div>Outer <span>inline</span><div>Inner block</div>tail</div>
  <ul><li>One</li><li>Two</li><li>One</li></ul>
  <table><tr><th>Item</th><th>Price</th></tr><tr><td>Widget</td><td>$5</td></tr><tr><td>Gadget</td><td></td><td>Sold out</td></tr></table>
  <p hidden>hidden text</p><p style="display: none">invisible text</p><p style="visibility:hidden">unseen text</p>
  <p>x</p><p>​Zero width&nbsp;and nbsp</p><pre>code line 1
code line 2</pre><select><option>Option text</option></select><button>Buy now</button></body></html>`;
  const { title, lines } = htmlLines(page);
  await check("the title, collapsed", () => assert.equal(title, "The page"));
  await check("script, style, meta, noscript, svg, template, select and hidden text are dropped", () => {
    for (const gone of ["script text", ".x{}", "meta text", "Turn on JavaScript", "svg text", "template text", "hidden text", "invisible text", "unseen text", "Option text"]) assert.ok(!lines.some((l) => l.includes(gone)), gone);
  });
  await check("blocks split into lines, inline text stays on its line", () =>
    assert.deepEqual(lines, [
      "Big news",
      "First paragraph spans lines.",
      "After a break",
      "Outer inline",
      "Inner block",
      "tail",
      "One",
      "Two",
      "Item · Price",
      "Widget · $5",
      "Gadget · Sold out",
      "Zero width and nbsp",
      "code line 1",
      "code line 2",
      "Buy now",
    ]),
  );
  await check("long lines are split to 300 characters, never lost", () => {
    const text = Array.from({ length: 20 }, (_, i) => `Sentence number ${i} is here to make the line long. `).join("");
    const { lines } = htmlLines(`<p>${text}</p>`);
    assert.ok(lines.length >= 4, String(lines.length));
    assert.ok(lines.every((l) => l.length >= 2 && l.length <= 300 && l.endsWith(".")));
    assert.equal(lines.join(" "), text.trim());
    // One "word" of 700 letters with no space to cut at: cut at 300.
    const word = Array.from({ length: 700 }, (_, i) => String.fromCharCode(97 + (i % 26))).join("");
    const pieces = htmlLines(`<p>${word}</p>`).lines;
    assert.deepEqual(pieces.map((l) => l.length), [300, 300, 100]);
    assert.equal(pieces.join(""), word);
  });
  await check("at most 400 lines, each once", () => {
    const many = htmlLines(Array.from({ length: 900 }, (_, i) => `<p>Row ${i % 600}</p>`).join("")).lines;
    assert.equal(many.length, 400);
    assert.equal(new Set(many).size, 400);
    assert.equal(many[0], "Row 0");
  });
  await check("a page with no html, head or body tags", () => {
    const got = htmlLines("<!doctype html><title>Bare</title><h1>Heading</h1><p>Body text</p>");
    assert.equal(got.title, "Bare");
    assert.deepEqual(got.lines, ["Heading", "Body text"]);
  });
  await check("plain text with no tags at all", () => assert.deepEqual(htmlLines("just some text & more").lines, ["just some text & more"]));
  await check("an empty page", () => assert.deepEqual(htmlLines(""), { title: "", lines: [] }));
  await check("no title: og:title, then the first heading", () => {
    assert.equal(htmlLines('<html><head><meta property="og:title" content="From OG"></head><body><h1>H</h1></body></html>').title, "From OG");
    assert.equal(htmlLines("<html><body><h1>From the heading</h1></body></html>").title, "From the heading");
  });
  await check("nesting thousands deep doesn't overflow", () => {
    const deep = `${"<div><span>".repeat(3000)}deep text${"</span></div>".repeat(3000)}`;
    assert.deepEqual(htmlLines(deep).lines, ["deep text"]);
  });
});

await part("readPage", async () => {
  allow();
  await check("an article: Readability's text, not the menu or footer", async () => {
    const got = await readPage(at("/article"));
    assert.equal(got.url, at("/article"));
    assert.match(got.title, /Library stays open/);
    assert.match(got.text, /Paragraph 1 of the story/);
    assert.match(got.text, /Paragraph 8 of the story/);
    assert.ok(!/Sports|Copyright|tracker|color: red/.test(got.text), got.text);
    assert.equal(got.text.split("\n").filter((l) => l.startsWith("Paragraph")).length, 8, "one line a paragraph");
    assert.equal(got.truncated, false);
  });
  await check("a page Readability can't read: everything visible", async () => {
    const got = await readPage(at("/listing"));
    assert.equal(got.title, "Widgets");
    assert.equal(got.text, ["Widget Store", "Item · Price · Stock", "Widget Pro · $19.99 · In stock", "Widget Mini · Sold out", "Free shipping", "30 day returns", "Add to cart"].join("\n"));
  });
  await check("JSON is pretty-printed", async () => {
    const got = await readPage(at("/json"));
    assert.equal(got.text, JSON.stringify({ name: "Widget Pro", price: 19.99, tags: ["new", "hot"] }, null, 2));
    assert.equal(got.title, `127.0.0.1:${port}/json`);
  });
  await check("JSON that doesn't parse comes as it is", async () => assert.equal((await readPage(at("/badjson"))).text, "{ not json"));
  await check("plain text as it is", async () => assert.equal((await readPage(at("/plain"))).text, "line one\nline two\n\n  indented three"));
  await check("a feed as lines, its HTML read as HTML", async () => {
    const got = await readPage(at("/feed"));
    assert.equal(got.title, "Town feed");
    const lines = got.text.split("\n");
    for (const l of ["Library & parks", "Open late all winter", "Roads", "Main St closed", "Mon, 13 Oct 2026 09:00:00 GMT"]) assert.ok(lines.includes(l), `${l} in ${JSON.stringify(lines)}`);
    assert.ok(!/<p>|<b>/.test(got.text));
  });
  await check(`at most ${READ_PAGE_MAX_CHARS} characters, said to be cut`, async () => {
    const got = await readPage(at("/long"));
    assert.ok(got.text.length <= READ_PAGE_MAX_CHARS && got.text.length > READ_PAGE_MAX_CHARS * 0.8, String(got.text.length));
    assert.equal(got.truncated, true);
  });
  await check("a page that answers 404 is an error, with its status", async () => {
    const e = await failure(() => readPage(at("/missing")));
    assert.equal(e.message, "That page answered 404 (not found).");
    assert.equal(e.status, 404);
  });
  await check("a refused address stays refused", () => refused(() => readPage("http://localhost/")));
  await check("a page nested thousands deep is read quickly, as its visible text, and the server isn't held up", async () => {
    let beats = 0;
    const beat = setInterval(() => beats++, 10);
    const started = performance.now();
    const got = await readPage(at("/deep"));
    const took = performance.now() - started;
    clearInterval(beat);
    assert.ok(took < 2_000, `took ${Math.round(took)} ms`);
    assert.match(got.text, /^link some text here/);
    assert.equal(got.truncated, true);
    assert.ok(beats > 0 || took < 200, "the event loop kept beating");
  });
});

await part("pageLines", async () => {
  allow();
  await check("a listing as lines", async () => {
    const got = await pageLines(at("/redirect?to=/listing"));
    assert.equal(got.url, at("/listing"));
    assert.equal(got.title, "Widgets");
    assert.deepEqual(got.lines, ["Widget Store", "Item · Price · Stock", "Widget Pro · $19.99 · In stock", "Widget Mini · Sold out", "Free shipping", "30 day returns", "Add to cart"]);
  });
  await check("an article keeps its menu and footer (monitors see the whole page)", async () => {
    const got = await pageLines(at("/article"));
    assert.ok(got.lines.includes("Home News Sports"));
    assert.ok(got.lines.includes("Copyright Town News. All rights reserved."));
    assert.ok(got.lines.every((l) => l.length >= 2 && l.length <= 300));
  });
  await check("JSON pretty-printed, line by line", async () => {
    const got = await pageLines(at("/json"));
    // "{", "]" and "}" are one character: too short to be a line.
    assert.deepEqual(got.lines, ['"name": "Widget Pro",', '"price": 19.99,', '"tags": [', '"new",', '"hot"']);
  });
  await check("plain text line by line", async () => assert.deepEqual((await pageLines(at("/plain"))).lines, ["line one", "line two", "indented three"]));
  await check("a feed", async () => {
    const got = await pageLines(at("/feed"));
    assert.ok(got.lines.includes("Open late all winter"));
    assert.ok(got.lines.includes("Main St closed"));
  });
  await check("a site that's down is an error, never a change", async () => {
    const e = await failure(() => pageLines(at("/down")));
    assert.equal(e.message, "That page answered 503 (the site is having trouble).");
  });
});

/* ---------------- The results ---------------- */

for (const res of held) res.destroy();
server.closeAllConnections();
await new Promise((r) => server.close(r));
const failed = results.filter((r) => !r.ok);
console.log(`\nWeb pages: ${results.length - failed.length} of ${results.length} parts passed (pages from the fixture on 127.0.0.1, names from the stand-in table; nothing reached the network).`);
const failing = failed.flatMap((r) => r.checks);
if (failing.length) console.log(`Checks that fail:\n${failing.map((c) => `  * ${c}`).join("\n")}`);
process.exit(failed.length ? 1 : 0);
