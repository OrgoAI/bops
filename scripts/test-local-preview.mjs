// An app's Local seen from this Mac (lib/server/local-preview.ts): a forward on a loopback port to a dev server
// elsewhere (here, one on this Mac standing in for the bot's computer). A request goes through with its Host kept,
// a websocket upgrade too; it refuses a port something else answers on; a Host that isn't localhost on that port
// gets a 403, a dev server that's down a 502; it closes on closeForward, when idle, and when another app takes the
// port; what a request says never changes where it goes. One with a carrier (an SSH tunnel's) has each connection
// through it, and its carrier closes with it, or at once when it can't open, or when it moves to another.
// Usage: node scripts/test-local-preview.mjs
import assert from "node:assert/strict";
import { registerHooks } from "node:module";
import http from "node:http";
import net from "node:net";

registerHooks({
  resolve(specifier, context, next) {
    if (specifier === "server-only") return { url: "data:text/javascript,export {}", shortCircuit: true };
    return next(specifier, context);
  },
});
const F = await import(new URL("../lib/server/local-preview.ts", import.meta.url).href);

let passed = 0;
const check = async (name, fn) => {
  await fn();
  passed++;
  console.log(`ok - ${name}`);
};
const freePort = () =>
  new Promise((done) => {
    const s = net.createServer().listen(0, "127.0.0.1", () => {
      const { port } = s.address();
      s.close(() => done(port));
    });
  });
/** One raw request on 127.0.0.1:port: what came back, whole. */
const raw = (port, text) =>
  new Promise((done, fail) => {
    const s = net.connect({ host: "127.0.0.1", port }, () => s.write(text));
    let out = "";
    s.on("data", (d) => (out += d));
    s.on("end", () => done(out));
    s.on("close", () => done(out));
    s.on("error", fail);
    s.setTimeout(3000, () => s.destroy());
  });

// The dev server: says the Host it got, and echoes a websocket's bytes once upgraded.
const seen = [];
const dev = http.createServer((req, res) => {
  seen.push(req.headers.host);
  res.setHeader("content-type", "text/plain");
  res.end(`hello from ${req.url} for ${req.headers.host}`);
});
dev.on("upgrade", (req, sock) => {
  sock.write("HTTP/1.1 101 Switching Protocols\r\nUpgrade: websocket\r\nConnection: Upgrade\r\n\r\n");
  sock.on("data", (d) => sock.write(d));
});
await new Promise((r) => dev.listen(0, "127.0.0.1", r));
const DEV = dev.address().port;
const MAC = await freePort();

await check("a request goes through with its Host kept; a websocket upgrade echoes; what a request says never changes where it goes", async () => {
  await F.openForward({ key: "ws/shop/shop", app: "shop", macPort: MAC, host: "127.0.0.1", port: DEV });
  const got = await raw(MAC, `GET /menu HTTP/1.1\r\nHost: localhost:${MAC}\r\nConnection: close\r\n\r\n`);
  assert.match(got, /^HTTP\/1\.1 200/);
  assert.ok(got.includes(`hello from /menu for localhost:${MAC}`), "its Host kept");
  const ws = await new Promise((done) => {
    const s = net.connect({ host: "127.0.0.1", port: MAC }, () => s.write(`GET /_next/webpack-hmr HTTP/1.1\r\nHost: localhost:${MAC}\r\nUpgrade: websocket\r\nConnection: Upgrade\r\n\r\n`));
    let out = "";
    s.on("data", (d) => {
      out += d;
      if (out.includes("\r\n\r\n") && !out.includes("ping")) s.write("ping");
      if (out.endsWith("ping")) {
        s.destroy();
        done(out);
      }
    });
  });
  assert.match(ws, /^HTTP\/1\.1 101/);
  assert.ok(ws.endsWith("ping"), "echoed");
  // An absolute address in the request line: still the same dev server.
  const abs = await raw(MAC, `GET http://evil.test/x HTTP/1.1\r\nHost: localhost:${MAC}\r\nConnection: close\r\n\r\n`);
  assert.ok(abs.includes("hello from") && abs.includes(`for localhost:${MAC}`));
  assert.deepEqual(F.forwardOn(MAC), { key: "ws/shop/shop", host: "127.0.0.1", port: DEV });
});

await check("a Host that isn't localhost on its port gets a 403 (no DNS rebinding); 127.0.0.1 and [::1] on it are fine", async () => {
  const evil = await raw(MAC, `GET / HTTP/1.1\r\nHost: evil.test\r\n\r\n`);
  assert.match(evil, /^HTTP\/1\.1 403/);
  assert.ok(evil.includes(`Open it at localhost:${MAC}.`));
  const other = await raw(MAC, `GET / HTTP/1.1\r\nHost: localhost:9\r\n\r\n`);
  assert.match(other, /^HTTP\/1\.1 403/);
  for (const host of [`127.0.0.1:${MAC}`, `[::1]:${MAC}`]) assert.match(await raw(MAC, `GET / HTTP/1.1\r\nHost: ${host}\r\nConnection: close\r\n\r\n`), /^HTTP\/1\.1 200/, host);
});

await check("its dev server down: a 502 in words", async () => {
  const gone = await freePort();
  const port2 = await freePort();
  await F.openForward({ key: "ws/notes/notes", app: "notes", macPort: port2, host: "127.0.0.1", port: gone });
  const r = await raw(port2, `GET / HTTP/1.1\r\nHost: localhost:${port2}\r\n\r\n`);
  assert.match(r, /^HTTP\/1\.1 502/);
  assert.ok(r.includes("Bops can't reach notes on its computer right now."));
  F.closeForward("ws/notes/notes");
});

await check("a port something else answers on is refused (MAC_PORT_BUSY)", async () => {
  const busy = net.createServer().listen(0, "127.0.0.1");
  await new Promise((r) => busy.on("listening", r));
  const p = busy.address().port;
  await assert.rejects(F.openForward({ key: "ws/x/x", macPort: p, host: "127.0.0.1", port: DEV }), (e) => e instanceof F.ForwardError && e.code === "MAC_PORT_BUSY");
  busy.close();
});

await check("another app on the same port takes it over (the first's key said, to close its tab); closeForward and idle close it", async () => {
  const r = await F.openForward({ key: "ws/blog/blog", app: "blog", macPort: MAC, host: "127.0.0.1", port: DEV });
  assert.equal(r.replaced, "ws/shop/shop");
  assert.equal(F.forwardOn(MAC).key, "ws/blog/blog");
  F.closeForward("ws/blog/");
  assert.equal(F.forwardOn(MAC), undefined);
  await assert.rejects(raw(MAC, `GET / HTTP/1.1\r\nHost: localhost:${MAC}\r\n\r\n`));
  await F.openForward({ key: "ws/shop/shop", app: "shop", macPort: MAC, host: "127.0.0.1", port: DEV });
  F.sweepForwards(Date.now() + F.IDLE_MS - 1000);
  assert.ok(F.forwardOn(MAC), "not idle long enough");
  F.sweepForwards(Date.now() + F.IDLE_MS + 1000);
  assert.equal(F.forwardOn(MAC), undefined, "idle: closed");
});

await check("a carrier takes each connection (the Host check first); it closes with the forward (its tab, idle, another app taking the port), at once when the port is in use, and when the forward moves to another or to none", async () => {
  const carrier = (log) => ({
    via: "ssh",
    connect: () => (log.push("connect"), net.connect({ host: "127.0.0.1", port: DEV })),
    close: () => log.push("close"),
  });
  const a = [];
  await F.openForward({ key: "ws/shop/shop", app: "shop", macPort: MAC, host: "198.51.100.7", port: 3000, carrier: carrier(a) });
  assert.deepEqual(F.forwardOf("ws/shop/shop"), { macPort: MAC, host: "198.51.100.7", port: 3000, via: "ssh" });
  assert.match(await raw(MAC, `GET /x HTTP/1.1\r\nHost: localhost:${MAC}\r\nConnection: close\r\n\r\n`), /hello from \/x/);
  assert.match(await raw(MAC, `GET / HTTP/1.1\r\nHost: evil.test\r\n\r\n`), /^HTTP\/1\.1 403/);
  assert.deepEqual(a, ["connect"], "through it, once the Host is checked");
  // Moved to another carrier: the old one closes; to none (the tailnet): that one too.
  const b = [];
  await F.openForward({ key: "ws/shop/shop", app: "shop", macPort: MAC, host: "198.51.100.7", port: 3000, carrier: carrier(b) });
  assert.deepEqual([a, b], [["connect", "close"], []]);
  await F.openForward({ key: "ws/shop/shop", app: "shop", macPort: MAC, host: "127.0.0.1", port: DEV });
  assert.deepEqual(b, ["close"]);
  assert.equal(F.forwardOf("ws/shop/shop").via, undefined);
  // Its tab, idle, another app: each closes it.
  for (const end of [() => F.closeForward("ws/blog/blog"), () => F.sweepForwards(Date.now() + F.IDLE_MS + 1000), () => F.openForward({ key: "ws/shop/shop", app: "shop", macPort: MAC, host: "127.0.0.1", port: DEV })]) {
    const c = [];
    await F.openForward({ key: "ws/blog/blog", app: "blog", macPort: MAC, host: "198.51.100.7", port: 3000, carrier: carrier(c) });
    await end();
    assert.deepEqual(c, ["close"]);
  }
  F.closeForward("ws/shop/shop");
  // The port in use: refused, and its carrier closed at once.
  const busy = net.createServer().listen(0, "127.0.0.1");
  await new Promise((r) => busy.on("listening", r));
  const d = [];
  await assert.rejects(F.openForward({ key: "ws/x/x", macPort: busy.address().port, host: "198.51.100.7", port: 3000, carrier: carrier(d) }), (e) => e.code === "MAC_PORT_BUSY");
  assert.deepEqual(d, ["close"]);
  assert.equal(await F.macPortBusy(busy.address().port), true);
  busy.close();
});

dev.close();
console.log(`local preview: ${passed} passed`);
process.exit(0);
