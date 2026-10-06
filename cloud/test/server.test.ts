import assert from "node:assert/strict";
import { randomBytes } from "node:crypto";
import { createServer, type Server } from "node:http";
import { connect } from "node:net";
import type { AddressInfo } from "node:net";
import { after, before, test } from "node:test";

/**
 * The router itself: requests it can't read and clients that vanish mid-check get an answer or are
 * dropped, and the process keeps serving everyone else.
 */

let cloud: Server;
let orgo: Server;
let port = 0;

before(async () => {
  // A slow Orgo, so a client has time to drop its connection while the cloud checks who it is.
  orgo = createServer((_req, res) => setTimeout(() => res.writeHead(401).end(), 300));
  await new Promise<void>((r) => orgo.listen(0, "127.0.0.1", r));
  process.env.BOPS_ORGO_ORIGIN = `http://127.0.0.1:${(orgo.address() as AddressInfo).port}`;
  process.env.BOPS_DATABASE_URL ||= process.env.BOPS_TEST_DATABASE_URL || "postgres://bops_app:bops-local@127.0.0.1:55432/orgo_it";
  const { makeServer } = await import("../server.ts");
  cloud = makeServer();
  await new Promise<void>((r) => cloud.listen(0, "127.0.0.1", r));
  port = (cloud.address() as AddressInfo).port;
});

after(async () => {
  await new Promise((r) => cloud.close(r));
  await new Promise((r) => orgo.close(r));
  const { closeDb } = await import("../db.ts");
  await closeDb();
});

/** Send raw bytes and read what comes back until the server closes or a short wait passes. */
function raw(bytes: string, { hangUp = false } = {}): Promise<string> {
  return new Promise((resolve) => {
    const s = connect(port, "127.0.0.1");
    let got = "";
    s.on("data", (d) => (got += d.toString()));
    s.on("error", () => resolve(got));
    s.on("close", () => resolve(got));
    s.write(bytes);
    if (hangUp) s.resetAndDestroy();
    else setTimeout(() => s.end(), 400);
  });
}

/** A fresh handshake key for each upgrade (any 16 random bytes, base64). */
const wsKey = () => randomBytes(16).toString("base64");

const alive = async () => (await fetch(`http://127.0.0.1:${port}/health`)).status;

test("an address the router can't read is a 400, and the cloud keeps serving", async () => {
  const answer = await raw("GET // HTTP/1.1\r\nHost: cloud\r\nConnection: close\r\n\r\n");
  assert.match(answer, /^HTTP\/1\.1 400/);
  assert.equal(await alive(), 200);
});

test("an upgrade to an address the router can't read is refused with 400", async () => {
  const answer = await raw(`GET // HTTP/1.1\r\nHost: cloud\r\nConnection: Upgrade\r\nUpgrade: websocket\r\nSec-WebSocket-Version: 13\r\nSec-WebSocket-Key: ${wsKey()}\r\n\r\n`);
  assert.match(answer, /^HTTP\/1\.1 400/);
  assert.equal(await alive(), 200);
});

test("a client that drops its upgrade while it's being checked doesn't take the cloud down", async () => {
  await raw(
    `GET /v1/connect HTTP/1.1\r\nHost: cloud\r\nAuthorization: Bearer someone\r\nConnection: Upgrade\r\nUpgrade: websocket\r\nSec-WebSocket-Version: 13\r\nSec-WebSocket-Key: ${wsKey()}\r\n\r\n`,
    { hangUp: true },
  );
  // Let the slow Orgo answer, so the cloud writes to the socket that's gone.
  await new Promise((r) => setTimeout(r, 600));
  assert.equal(await alive(), 200);
});
