import { createHmac, randomBytes, randomInt, randomUUID } from "node:crypto";
import { createServer, type IncomingMessage, type Server, type ServerResponse } from "node:http";
import type { AddressInfo } from "node:net";
import pg from "pg";
import { WebSocket, WebSocketServer } from "ws";
import { seal } from "../crypto.ts";
import { migrate, query } from "../db.ts";
import type { CloudToMac, MacToCloud } from "../protocol.ts";
import { makeServer } from "../server.ts";

/**
 * What the edge tests (tunnel, hooks, Slack, calls, state, pages) share: a throwaway Postgres,
 * made-up keys, and fakes on localhost for Orgo, OpenAI (REST and the call sideband), AgentPhone,
 * Composio's proxy to Slack and a user's Mac. Nothing here reaches a real provider. Never point
 * BOPS_TEST_DATABASE_URL at a real database: the tests add and delete rows (their own users only,
 * with random ids, so test files can run at once).
 */

export const TEST_DATABASE_URL = process.env.BOPS_TEST_DATABASE_URL || "postgres://bops_app:bops-local@127.0.0.1:55432/orgo_edge";
process.env.BOPS_DATABASE_URL = TEST_DATABASE_URL;
process.env.BOPS_CLOUD_SECRET = randomBytes(32).toString("base64");
process.env.OPENAI_API_KEY = "sk-test-not-a-real-key";
process.env.OPENAI_WEBHOOK_SECRET = `whsec_${randomBytes(24).toString("base64")}`;
process.env.AGENTPHONE_API_KEY = "ap-test-not-a-real-key";

/** Apply the migrations once at a time across test files (each file is its own process). */
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

export const newUserId = (what: string) => `edge-${what}-${randomUUID().slice(0, 8)}`;
/** A made-up US number in the 555 exchange (random area code, so test files running at once don't collide), as E.164. */
export const newNumber = () => `+1${randomInt(200, 1_000)}555${String(randomInt(0, 10_000)).padStart(4, "0")}`;

/** One of a user's lines as bops.phone_lines has it: its owner (and how), or how long its claim window has left. */
export type SeedLine = { phone: string; numberId?: string; botId?: string; owner?: string; via?: "call" | "text" | "sms_code"; claimForMs?: number };

/**
 * A user as the core builder's /v1/session and /proxy/agentphone leave them: state, account, agents
 * (secret sealed) and numbers; `ownerPhones` are numbers the user verified (bops.owner_phones), and
 * `lines` their lines' owners (bops.phone_lines).
 */
export async function seedUser(
  userId: string,
  opts: { state?: unknown; subAccount?: string; agents?: Record<string, string>; numbers?: string[]; ownerPhones?: string[]; lines?: SeedLine[] } = {},
) {
  await query(`INSERT INTO bops.app_state (user_id, state, version) VALUES ($1, $2::jsonb, 1) ON CONFLICT (user_id) DO UPDATE SET state = EXCLUDED.state`, [userId, JSON.stringify(opts.state ?? {})]);
  await query(`INSERT INTO bops.cloud_accounts (user_id, agentphone_sub_account) VALUES ($1, $2) ON CONFLICT (user_id) DO NOTHING`, [userId, opts.subAccount ?? null]);
  for (const [agentId, secret] of Object.entries(opts.agents ?? {}))
    await query(`INSERT INTO bops.cloud_agents (agent_id, user_id, secret_sealed) VALUES ($1, $2, $3)`, [agentId, userId, seal(secret)]);
  for (const n of opts.numbers ?? []) await query(`INSERT INTO bops.cloud_numbers (digits, user_id, e164) VALUES ($1, $2, $3)`, [n.replace(/\D/g, "").slice(-10), userId, n]);
  for (const n of opts.ownerPhones ?? [])
    await query(`INSERT INTO bops.owner_phones (orgo_user_id, phone_e164, consent_at, verified_at) VALUES ($1, $2, now(), now()) ON CONFLICT DO NOTHING`, [userId, n]);
  for (const l of opts.lines ?? []) {
    const digits = l.phone.replace(/\D/g, "").slice(-10);
    await query(`INSERT INTO bops.cloud_numbers (digits, user_id, number_id, e164) VALUES ($1, $2, $3, $4) ON CONFLICT (digits) DO UPDATE SET number_id = EXCLUDED.number_id`, [digits, userId, l.numberId ?? null, l.phone]);
    await query(
      `INSERT INTO bops.phone_lines (digits, user_id, number_id, e164, bot_id, owner_number, claimed_at, claimed_via, claim_until)
       VALUES ($1, $2, $3, $4, $5, $6, CASE WHEN $6::text IS NULL THEN NULL ELSE now() END, $7, CASE WHEN $8::float8 IS NULL THEN NULL ELSE now() + make_interval(secs => $8::float8 / 1000) END)`,
      [digits, userId, l.numberId ?? null, l.phone, l.botId ?? null, l.owner ?? null, l.owner ? (l.via ?? "call") : null, l.claimForMs ?? null],
    );
  }
}

/** A line's row in bops.phone_lines, for checking what a call or a route did. */
export const lineRow = async (phone: string) =>
  (await query<{ user_id: string; owner_number: string | null; claimed_via: string | null; claim_until: Date | null; bot_id: string | null; number_id: string | null }>(
    "SELECT user_id, owner_number, claimed_via, claim_until, bot_id, number_id FROM bops.phone_lines WHERE digits = $1",
    [phone.replace(/\D/g, "").slice(-10)],
  )).rows[0];

/** Remove the test users and everything of theirs. */
export async function dropUsers(userIds: string[]) {
  await query("DELETE FROM bops.cloud_objects WHERE user_id = ANY($1::text[])", [userIds]);
  await query("DELETE FROM bops.cloud_usage WHERE user_id = ANY($1::text[])", [userIds]);
  await query("DELETE FROM bops.app_state WHERE user_id = ANY($1::text[])", [userIds]);
}

export const pending = async (userId: string) =>
  (await query<{ id: string; kind: string; payload: Record<string, unknown>; dedupe_key: string | null; delivered_at: Date | null }>(
    "SELECT id, kind, payload, dedupe_key, delivered_at FROM bops.cloud_pending WHERE user_id = $1 ORDER BY id",
    [userId],
  )).rows;

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

/* ---------------- Servers on localhost ---------------- */

export type Listening = { url: string; server: Server; close: () => Promise<void> };

export async function listen(server: Server): Promise<Listening> {
  await new Promise<void>((r) => server.listen(0, "127.0.0.1", r));
  const { port } = server.address() as AddressInfo;
  return {
    url: `http://127.0.0.1:${port}`,
    server,
    close: () =>
      new Promise((r) => {
        server.close(() => r());
        server.closeAllConnections();
      }),
  };
}

const readAll = async (req: IncomingMessage) => {
  const chunks: Buffer[] = [];
  for await (const c of req) chunks.push(c as Buffer);
  return Buffer.concat(chunks);
};

const json = (res: ServerResponse, status: number, body: unknown) => res.writeHead(status, { "content-type": "application/json" }).end(JSON.stringify(body));

/** The cloud itself, on a free port. Its auth asks BOPS_ORGO_ORIGIN, so start fakeOrgo() first. */
export const startCloud = () => listen(makeServer());

/** Orgo's GET /api/user/profile: the key "key-<userId>" is <userId>'s; anything else is turned down. */
export async function fakeOrgo(): Promise<Listening> {
  const orgo = await listen(
    createServer((req, res) => {
      const userId = /^Bearer key-(.+)$/.exec(req.headers.authorization ?? "")?.[1];
      if (req.url !== "/api/user/profile" || !userId) return void json(res, 401, { error: "no" });
      json(res, 200, { id: userId, email: `${userId}@example.com` });
    }),
  );
  process.env.BOPS_ORGO_ORIGIN = orgo.url;
  return orgo;
}

export const keyOf = (userId: string) => `key-${userId}`;

/** AgentPhone's POST /v1/messages, remembering every text it was asked to send. */
export async function fakeAgentPhone() {
  const sent: { headers: IncomingMessage["headers"]; body: Record<string, unknown> }[] = [];
  const ap = await listen(
    createServer(async (req, res) => {
      const body = JSON.parse((await readAll(req)).toString() || "{}") as Record<string, unknown>;
      if (req.method === "POST" && req.url === "/v1/messages") {
        sent.push({ headers: req.headers, body });
        return void json(res, 200, { id: `msg_${sent.length}`, status: "queued" });
      }
      json(res, 404, { error: "not faked" });
    }),
  );
  process.env.BOPS_UPSTREAM_AGENTPHONE = ap.url;
  return Object.assign(ap, { sent });
}

/**
 * Composio's proxy to an app's own API (POST /api/v3.1/tools/execute/proxy), as the cloud uses it to
 * ask Slack's auth.test through one of a user's Slack accounts. `slack` says what Slack answers for
 * each connected account id; an account it doesn't list is one Composio doesn't know (404).
 */
export async function fakeComposio() {
  const got: { headers: IncomingMessage["headers"]; path: string; body: Record<string, unknown> }[] = [];
  const slack = new Map<string, Record<string, unknown>>();
  const composio = await listen(
    createServer(async (req, res) => {
      const body = JSON.parse((await readAll(req)).toString() || "{}") as Record<string, unknown>;
      got.push({ headers: req.headers, path: req.url ?? "", body });
      if (req.method !== "POST" || req.url !== "/api/v3.1/tools/execute/proxy") return void json(res, 404, { error: "not faked" });
      const answer = slack.get(String(body.connected_account_id));
      if (!answer) return void json(res, 404, { error: { message: "Connected account not found" } });
      json(res, 200, { data: answer, status: 200, headers: {} });
    }),
  );
  process.env.BOPS_UPSTREAM_COMPOSIO = composio.url;
  return Object.assign(composio, { got, slack });
}

/** Headers Slack sends with an event, signed with the app's signing secret (BOPS_SLACK_SIGNING_SECRET). */
export function slackHeaders(body: string, opts: { at?: number; secret?: string } = {}) {
  const ts = String(Math.floor((opts.at ?? Date.now()) / 1000));
  const secret = opts.secret ?? process.env.BOPS_SLACK_SIGNING_SECRET!;
  return {
    "content-type": "application/json",
    "x-slack-request-timestamp": ts,
    "x-slack-signature": `v0=${createHmac("sha256", secret).update(`v0:${ts}:${body}`).digest("hex")}`,
  };
}

/** One call's sideband as the fake OpenAI sees it: what the cloud sent, and a way to talk back. */
export type FakeSideband = {
  sessionId: string;
  authorization: string;
  got: Record<string, unknown>[];
  send: (event: Record<string, unknown>) => void;
  /** Wait for the cloud to send an event matching `match`. */
  receive: (match: (e: Record<string, unknown>) => boolean, what: string) => Promise<Record<string, unknown>>;
  ws: WebSocket;
};

/**
 * OpenAI's Live API as a call uses it: POST /v1/live/sessions/{id}/accept|reject|hangup, and the
 * sideband WebSocket /v1/live/sessions/{id}/attach. A hangup ends the session the way OpenAI does
 * (session.closed, then the sideband closes). `script` plays the caller's side of each call.
 */
/** What the fake Responses API answers: the bot's words, and any tool calls it makes (name and arguments). */
export type FakeResponse = { text?: string; tools?: { name: string; args: Record<string, unknown> }[]; status?: number; delayMs?: number };

/** A Responses API answer in OpenAI's shape, with token usage. */
export function responseOf(id: string, r: FakeResponse) {
  return {
    id,
    object: "response",
    model: "gpt-test",
    status: "completed",
    output: [
      ...(r.text ? [{ type: "message", role: "assistant", content: [{ type: "output_text", text: r.text }] }] : []),
      ...(r.tools ?? []).map((t, i) => ({ type: "function_call", call_id: `call_${i}`, name: t.name, arguments: JSON.stringify(t.args) })),
    ],
    usage: { input_tokens: 100, output_tokens: 20, input_tokens_details: { cached_tokens: 0 }, output_tokens_details: { reasoning_tokens: 5 } },
  };
}

export async function fakeOpenAi(script: (sb: FakeSideband) => Promise<void> | void = () => {}) {
  const controls: { action: string; sessionId: string; authorization: string; body: Record<string, unknown> | null }[] = [];
  const sidebands: FakeSideband[] = [];
  /** POST /v1/responses requests, as sent (a call's turns answered in the cloud). */
  const responses: { authorization: string; body: Record<string, unknown> }[] = [];
  const state: { acceptStatus: number; script: typeof script; respond: (body: Record<string, unknown>) => FakeResponse } = { acceptStatus: 200, script, respond: () => ({ text: "Hi there." }) };
  const wss = new WebSocketServer({ noServer: true });
  const server = createServer(async (req, res) => {
    const m = /^\/v1\/live\/sessions\/([^/]+)\/(accept|reject|hangup)$/.exec(req.url ?? "");
    const raw = (await readAll(req)).toString();
    if (req.method === "POST" && req.url === "/v1/responses") {
      const body = JSON.parse(raw) as Record<string, unknown>;
      responses.push({ authorization: req.headers.authorization ?? "", body });
      const r = state.respond(body);
      if (r.delayMs) await new Promise((done) => setTimeout(done, r.delayMs));
      if (r.status && r.status !== 200) return void json(res, r.status, { error: { message: "no" } });
      return void json(res, 200, responseOf(`resp_${randomUUID()}`, r));
    }
    if (req.method !== "POST" || !m) return void json(res, 404, { error: "not faked" });
    const [, sessionId, action] = m;
    controls.push({ action, sessionId: decodeURIComponent(sessionId), authorization: req.headers.authorization ?? "", body: raw ? (JSON.parse(raw) as Record<string, unknown>) : null });
    if (action === "accept" && state.acceptStatus !== 200) return void json(res, state.acceptStatus, { error: { message: "already accepted" } });
    res.writeHead(200).end();
    if (action === "hangup")
      for (const sb of sidebands.filter((x) => x.sessionId === decodeURIComponent(sessionId) && x.ws.readyState === WebSocket.OPEN)) {
        sb.send({ type: "session.closed", reason: "close_requested", usage: { seconds: 12 } });
        sb.ws.close();
      }
  });
  server.on("upgrade", (req, socket, head) => {
    const m = /^\/v1\/live\/sessions\/([^/]+)\/attach$/.exec(req.url ?? "");
    if (!m) return void socket.destroy();
    wss.handleUpgrade(req, socket, head, (ws) => {
      const got: Record<string, unknown>[] = [];
      const sb: FakeSideband = {
        sessionId: decodeURIComponent(m[1]),
        authorization: req.headers.authorization ?? "",
        got,
        ws,
        send: (event) => ws.readyState === WebSocket.OPEN && ws.send(JSON.stringify(event)),
        receive: (match, what) => until(() => got.find(match), what),
      };
      ws.on("message", (data) => got.push(JSON.parse(String(data)) as Record<string, unknown>));
      sidebands.push(sb);
      void Promise.resolve(state.script(sb)).catch((e: Error) => console.error(`[fake openai] script: ${e.message}`));
    });
  });
  const openai = await listen(server);
  process.env.BOPS_UPSTREAM_OPENAI = openai.url;
  return Object.assign(openai, { controls, sidebands, responses, state });
}

/* ---------------- A user's Mac on the tunnel ---------------- */

export type FakeMac = {
  ws: WebSocket;
  frames: CloudToMac[];
  closed: Promise<{ code: number; reason: string }>;
  send: (frame: MacToCloud) => void;
};

/**
 * A Mac connected over GET /v1/connect. By default it answers pings, acks events, and answers
 * requests with `answer` (none: requests go unanswered).
 */
export async function connectMac(
  cloudUrl: string,
  userId: string,
  opts: { pong?: boolean; ack?: boolean; answer?: (req: Extract<CloudToMac, { t: "req" }>) => Omit<Extract<MacToCloud, { t: "res" }>, "t" | "id"> | null | Promise<Omit<Extract<MacToCloud, { t: "res" }>, "t" | "id"> | null> } = {},
): Promise<FakeMac> {
  const ws = new WebSocket(`${cloudUrl.replace(/^http/, "ws")}/v1/connect`, { headers: { Authorization: `Bearer ${keyOf(userId)}` } });
  const frames: CloudToMac[] = [];
  const send = (frame: MacToCloud) => ws.readyState === WebSocket.OPEN && ws.send(JSON.stringify(frame));
  const closed = new Promise<{ code: number; reason: string }>((r) => ws.on("close", (code, reason) => r({ code, reason: String(reason) })));
  ws.on("message", async (data) => {
    const frame = JSON.parse(String(data)) as CloudToMac;
    frames.push(frame);
    if (frame.t === "ping" && opts.pong !== false) send({ t: "pong" });
    if (frame.t === "event" && opts.ack !== false) send({ t: "ack", id: frame.id });
    if (frame.t === "req" && opts.answer) {
      const res = await opts.answer(frame);
      if (res) send({ t: "res", id: frame.id, ...res });
    }
  });
  await new Promise<void>((resolve, reject) => {
    ws.once("open", () => resolve());
    ws.once("error", reject);
  });
  ws.on("error", () => {});
  return { ws, frames, closed, send };
}

/* ---------------- Signed webhooks ---------------- */

/** Headers AgentPhone sends with a delivery, signed with the agent's webhook secret. */
export function agentPhoneHeaders(secret: string, body: string, opts: { id?: string; at?: number } = {}) {
  const ts = String(Math.floor((opts.at ?? Date.now()) / 1000));
  return {
    "content-type": "application/json",
    "x-webhook-id": opts.id ?? `whd_${randomUUID()}`,
    "x-webhook-timestamp": ts,
    "x-webhook-event": "agent.message",
    "x-webhook-signature": `sha256=${createHmac("sha256", secret).update(`${ts}.${body}`).digest("hex")}`,
  };
}

/** Headers OpenAI sends with a webhook (Standard Webhooks), signed with OPENAI_WEBHOOK_SECRET. */
export function openAiHeaders(body: string, opts: { id?: string; at?: number; secret?: string } = {}) {
  const id = opts.id ?? `evt_${randomUUID()}`;
  const ts = String(Math.floor((opts.at ?? Date.now()) / 1000));
  const secret = opts.secret ?? process.env.OPENAI_WEBHOOK_SECRET!;
  const key = Buffer.from(secret.slice("whsec_".length), "base64");
  return {
    "content-type": "application/json",
    "webhook-id": id,
    "webhook-timestamp": ts,
    "webhook-signature": `v1,${createHmac("sha256", key).update(`${id}.${ts}.${body}`).digest("base64")}`,
  };
}

/** OpenAI's live.transport.incoming event for a call from `from` to `to`, the way AgentPhone's SIP trunk sends it. */
export function incomingCallEvent(sessionId: string, from: string, to: string, extra: { name: string; value: string }[] = []) {
  return {
    id: `evt_${randomUUID()}`,
    object: "event",
    type: "live.transport.incoming",
    created_at: Math.floor(Date.now() / 1000),
    data: {
      type: "sip",
      session_id: sessionId,
      sip_headers: [
        { name: "From", value: `"Caller" <sip:${from}@sip.example.net>;tag=abc123` },
        { name: "To", value: `<sip:${to}@sip.api.openai.com>` },
        { name: "Call-ID", value: "4155550100-7731@10.20.30.40" },
        ...extra,
      ],
    },
  };
}
