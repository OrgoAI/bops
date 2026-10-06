import { randomBytes, randomInt, randomUUID } from "node:crypto";
import { createServer, request, type IncomingHttpHeaders, type IncomingMessage, type Server, type ServerResponse } from "node:http";
import type { AddressInfo, Socket } from "node:net";
import pg from "pg";
import { migrate, query } from "../db.ts";
import { makeServer } from "../server.ts";

/**
 * What the core tests (session, proxies, verify) share: a throwaway Postgres, made-up keys, and fakes
 * on localhost for Orgo and every provider. Nothing here reaches a real provider. Never point
 * BOPS_TEST_DATABASE_URL at a real database: the tests add and delete rows (their own users only,
 * with random ids, so test files can run at once).
 */

export const TEST_DATABASE_URL = process.env.BOPS_TEST_DATABASE_URL || "postgres://bops_app:bops-local@127.0.0.1:55432/orgo_core";
process.env.BOPS_DATABASE_URL = TEST_DATABASE_URL;
process.env.BOPS_CLOUD_SECRET = randomBytes(32).toString("base64");
process.env.BOPS_CLOUD_PUBLIC_URL = "https://bops-api.test";

/** Apply the migrations one test file at a time (each file is its own process; the edge tests take the same lock). */
export async function prepareDb() {
  const lock = new pg.Client({ connectionString: TEST_DATABASE_URL });
  await lock.connect();
  try {
    await lock.query("SELECT pg_advisory_lock(hashtext('bops-edge-tests'))");
    await migrate();
  } finally {
    await lock.query("SELECT pg_advisory_unlock(hashtext('bops-edge-tests'))").catch(() => {});
    await lock.end();
  }
}

export const newUserId = (what: string) => `core-${what}-${randomUUID().slice(0, 8)}`;
export const keyOf = (userId: string) => `key-${userId}`;
/** US area codes only: some +1 codes are Caribbean, and codes are never texted there. */
const AREA_CODES = ["212", "213", "305", "312", "404", "415", "503", "510", "512", "602", "617", "646", "702", "718", "917", "206"];
/** A made-up US number in the 555 exchange (random area code and line, so runs don't collide), as E.164. */
export const newNumber = () => `+1${AREA_CODES[randomInt(0, AREA_CODES.length)]}555${String(randomInt(0, 10_000)).padStart(4, "0")}`;

/** A user with a state row and a cloud account, as /v1/session leaves them. */
export async function seedUser(userId: string, account: { subAccount?: string } = {}) {
  await query("INSERT INTO bops.app_state (user_id, state, version) VALUES ($1, '{}'::jsonb, 1) ON CONFLICT DO NOTHING", [userId]);
  await query("INSERT INTO bops.cloud_accounts (user_id, agentphone_sub_account) VALUES ($1, $2) ON CONFLICT DO NOTHING", [userId, account.subAccount ?? null]);
}

/** Remove the test users and everything of theirs. */
export async function dropUsers(userIds: string[]) {
  await query("DELETE FROM bops.cloud_objects WHERE user_id = ANY($1::text[])", [userIds]);
  await query("DELETE FROM bops.cloud_usage WHERE user_id = ANY($1::text[])", [userIds]);
  await query("DELETE FROM bops.app_state WHERE user_id = ANY($1::text[])", [userIds]);
}

/* ---------------- Servers on localhost ---------------- */

export type Listening = { url: string; server: Server; close: () => Promise<void> };

/** A server on a free port. Closing it ends every connection, WebSockets included, so a failed test can't keep the run open. */
export async function listen(server: Server): Promise<Listening> {
  const sockets = new Set<Socket>();
  server.on("connection", (s: Socket) => {
    sockets.add(s);
    s.on("close", () => sockets.delete(s));
  });
  await new Promise<void>((r) => server.listen(0, "127.0.0.1", r));
  const { port } = server.address() as AddressInfo;
  return {
    url: `http://127.0.0.1:${port}`,
    server,
    close: () =>
      new Promise((r) => {
        server.close(() => r());
        for (const s of sockets) s.destroy();
      }),
  };
}

const readAll = async (req: IncomingMessage) => {
  const chunks: Buffer[] = [];
  for await (const c of req) chunks.push(c as Buffer);
  return Buffer.concat(chunks);
};

/** The cloud itself, on a free port. Its auth asks BOPS_ORGO_ORIGIN, so start fakeOrgo() first. */
export const startCloud = () => listen(makeServer());

/** Orgo's GET /api/user/profile: the key "key-<userId>" is <userId>'s; anything else is turned down. */
export async function fakeOrgo(): Promise<Listening> {
  const orgo = await listen(
    createServer((req, res) => {
      const userId = /^Bearer key-(.+)$/.exec(req.headers.authorization ?? "")?.[1];
      if (req.url !== "/api/user/profile" || !userId) return void res.writeHead(401, { "content-type": "application/json" }).end('{"error":"no"}');
      res.writeHead(200, { "content-type": "application/json" }).end(JSON.stringify({ id: userId, email: `${userId}@example.com` }));
    }),
  );
  process.env.BOPS_ORGO_ORIGIN = orgo.url;
  return orgo;
}

/** A request a fake provider got. */
// A fake gets whatever JSON the code under test sends, and each test reads the fields it cares about.
// eslint-disable-next-line @typescript-eslint/no-explicit-any
export type Got = { method: string; path: string; query: URLSearchParams; headers: IncomingHttpHeaders; body: Buffer; json: any };
/** How a fake answers: JSON (the default), or nothing when the handler wrote the answer itself. */
export type Reply = { status?: number; json?: unknown; headers?: Record<string, string> } | void;

/** A provider on localhost that remembers every request and answers with `answer`. */
export async function fakeProvider(answer: (got: Got, res: ServerResponse) => Reply | Promise<Reply>) {
  const got: Got[] = [];
  const l = await listen(
    createServer(async (req, res) => {
      const body = await readAll(req);
      const url = new URL(req.url ?? "/", "http://fake");
      let json: unknown;
      try {
        json = body.length ? JSON.parse(body.toString("utf8")) : undefined;
      } catch {}
      const g: Got = { method: req.method ?? "GET", path: url.pathname, query: url.searchParams, headers: req.headers, body, json };
      got.push(g);
      const reply = await answer(g, res);
      if (!reply) return;
      const data = Buffer.from(JSON.stringify(reply.json ?? {}));
      res.writeHead(reply.status ?? 200, { "content-type": "application/json", "content-length": String(data.length), ...reply.headers }).end(data);
    }),
  );
  return { ...l, got };
}

/** Write server-sent events one at a time; a promise in the list holds the stream until it settles. */
export async function sse(res: ServerResponse, events: (unknown | Promise<unknown>)[]) {
  res.writeHead(200, { "content-type": "text/event-stream", "cache-control": "no-cache" });
  for (const e of events) {
    if (e instanceof Promise) await e;
    else res.write(`data: ${JSON.stringify(e)}\n\n`);
  }
  res.end();
}

/** A JSON call to the cloud as a Mac would make it. */
export async function call(base: string, method: string, path: string, opts: { key?: string; json?: unknown; headers?: Record<string, string> } = {}) {
  const res = await fetch(`${base}${path}`, {
    method,
    headers: { ...(opts.key ? { authorization: `Bearer ${opts.key}` } : {}), ...(opts.json === undefined ? {} : { "content-type": "application/json" }), ...opts.headers },
    body: opts.json === undefined ? undefined : JSON.stringify(opts.json),
  });
  const text = await res.text();
  // Whatever the cloud answered; the tests read the fields they check.
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  let json: any;
  try {
    json = JSON.parse(text);
  } catch {}
  return { status: res.status, json, text, headers: res.headers };
}

/** A request with the path exactly as written (fetch would tidy away "..", "//" and backslashes first). */
export function rawCall(base: string, method: string, path: string, key: string): Promise<{ status: number; text: string }> {
  const { hostname, port } = new URL(base);
  return new Promise((resolve, reject) => {
    const req = request({ hostname, port, method, path, headers: { authorization: `Bearer ${key}` } }, async (res) => resolve({ status: res.statusCode ?? 0, text: (await readAll(res)).toString() }));
    req.on("error", reject);
    req.end();
  });
}

/** Wait until `check` gives something (polling), or fail after `ms`. */
export async function until<T>(check: () => T | undefined | null | false | Promise<T | undefined | null | false>, what = "it", ms = 5_000): Promise<T> {
  const end = Date.now() + ms;
  for (;;) {
    const v = await check();
    if (v) return v;
    if (Date.now() > end) throw new Error(`timed out waiting for ${what}`);
    await new Promise((r) => setTimeout(r, 10));
  }
}

/** A promise with its resolve on the outside (to hold a fake's answer until the test lets it go). */
export function gate() {
  let open!: () => void;
  const p = new Promise<void>((r) => (open = r));
  return { promise: p, open };
}
