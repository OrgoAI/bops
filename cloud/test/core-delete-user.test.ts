import assert from "node:assert/strict";
import { createHmac, randomBytes, randomUUID } from "node:crypto";
import { after, before, beforeEach, test } from "node:test";
import pg from "pg";
import { WebSocket, WebSocketServer } from "ws";
import { clearAuthCache } from "../auth.ts";
import { seal } from "../crypto.ts";
import { closeDb, DELETED_KEEP_DAYS, ensureUserRow, forgetDeletedKnown, ownObject, query, sweepDeletedUsers } from "../db.ts";
import { deleteTiming, UNDELETE_USER_PATH, undeleteSigned } from "../delete-user.ts";
import { ACCOUNT_DELETED } from "../protocol.ts";
import { honchoPrefix } from "../session.ts";
import { BACKUPS_PER_USER, sweepBackups, writeMessages } from "../state.ts";
import { DELETED_CLOSE } from "../tunnel.ts";
import { recordTokens, recordUsage, recordUsageFor } from "../usage.ts";
import { call, dropUsers, fakeOrgo, fakeProvider, gate, keyOf, newNumber, newUserId, prepareDb, startCloud, TEST_DATABASE_URL, until, type Listening } from "./core-fakes.ts";

/**
 * Deleting a user (delete-user.ts): orgo-web's signed POST /v1/internal/delete-user deletes everything
 * Bops Cloud holds for an Orgo user, here and at the providers (numbers given back, the pod and its
 * inboxes, the memory banks under their prefix, stored responses, connected accounts), keeps their mail
 * handles retired and nobody's, answers 200 only once nothing is left (502 when a provider failed, which
 * a retry finishes; 503 while it's still going), and lets nothing of theirs be written again: their
 * tunnel ends, and a stale Mac's write, the cloud's own, or a plan notice, makes no row. Only a body of
 * exactly {userId} is taken, so no other signed notice deletes anyone; the tombstone is Postgres's (a
 * restart turns them down just the same), and undelete-user, signed with its route, lifts it. Copies
 * before Start over are pruned by age and count.
 */

const SECRET = randomBytes(32).toString("base64");
const users: string[] = [];
const handles: string[] = [];
const objects: string[] = [];
let orgo: Listening, cloud: Listening;
let noticeId = 0;

/** AgentPhone, per sub-account: its numbers (given back: `released`). */
const numbers: { id: string; phoneNumber: string; sub: string; released?: boolean }[] = [];
/** AgentMail: pods with their client id and inboxes. */
const pods = new Map<string, { client_id: string; inboxes: string[] }>();
/** Honcho: every workspace in the project. */
const workspaces: string[] = [];
/** OpenAI's stored responses, and Composio's connected accounts. */
const responses = new Set<string>();
const accounts = new Set<string>();
/**
 * Breaks one provider for a test: AgentPhone fails giving a number back, OpenAI holds each delete until
 * the gate opens, or runs `onOpenaiDelete` first (a call already under way making something meanwhile),
 * and OpenAI and Honcho hold what a call makes (a stored response, a memory bank) until `madeHeld` opens.
 */
const breaks = { agentphoneFails: false, openaiHeld: null as Promise<void> | null, onOpenaiDelete: null as (() => Promise<void>) | null, madeHeld: null as Promise<void> | null };
/** How many responses the fake OpenAI made (POST /v1/responses). */
let made = 0;
/** Each response.create the fake OpenAI got over a WebSocket. */
let wsCreates = 0;

let agentphone: Awaited<ReturnType<typeof fakeProvider>>,
  agentmail: Awaited<ReturnType<typeof fakeProvider>>,
  honcho: Awaited<ReturnType<typeof fakeProvider>>,
  openai: Awaited<ReturnType<typeof fakeProvider>>,
  composio: Awaited<ReturnType<typeof fakeProvider>>;

before(async () => {
  await prepareDb();
  orgo = await fakeOrgo();
  agentphone = await fakeProvider((g) => {
    const sub = String(g.headers["x-sub-account-id"] ?? "");
    const mine = numbers.filter((n) => n.sub === sub && !n.released);
    if (g.method === "GET" && g.path === "/v1/numbers") return { json: { data: mine } };
    const m = /^\/v1\/numbers\/([^/]+)$/.exec(g.path);
    if (m && g.method === "DELETE") {
      if (breaks.agentphoneFails) return { status: 500, json: { detail: "try later" } };
      const n = mine.find((x) => x.id === decodeURIComponent(m[1]));
      if (!n) return { status: 404, json: { detail: "not found" } };
      n.released = true;
      return { json: { ok: true } };
    }
    return { status: 418 };
  });
  agentmail = await fakeProvider((g) => {
    if (g.method === "GET" && g.path === "/v0/pods") return { json: { pods: [...pods].map(([pod_id, p]) => ({ pod_id, client_id: p.client_id })), next_page_token: null } };
    const m = /^\/v0\/pods\/([^/]+)(?:\/inboxes(?:\/([^/]+))?)?$/.exec(g.path);
    const pod = m ? pods.get(decodeURIComponent(m[1])) : undefined;
    if (!m) return { status: 418 };
    if (!pod) return { status: 404, json: { name: "NotFoundError" } };
    const inboxPath = g.path.includes("/inboxes");
    if (g.method === "GET" && inboxPath && !m[2]) return { json: { count: pod.inboxes.length, inboxes: pod.inboxes.map((inbox_id) => ({ inbox_id })), next_page_token: null } };
    if (g.method === "DELETE" && m[2]) {
      const id = decodeURIComponent(m[2]);
      if (!pod.inboxes.includes(id)) return { status: 404, json: { name: "NotFoundError" } };
      pod.inboxes = pod.inboxes.filter((x) => x !== id);
      return { json: {} };
    }
    if (g.method === "DELETE" && !inboxPath) {
      pods.delete(decodeURIComponent(m[1]));
      return { json: {} };
    }
    return { status: 418 };
  });
  honcho = await fakeProvider(async (g) => {
    // Two to a page, so the delete has to read every page.
    if (g.method === "POST" && g.path === "/v3/workspaces/list") {
      const page = Number(g.query.get("page") ?? 1);
      return { json: { items: workspaces.slice((page - 1) * 2, page * 2).map((id) => ({ id })), total: workspaces.length, page, size: 2, pages: Math.ceil(workspaces.length / 2) } };
    }
    const m = /^\/v3\/workspaces\/([^/]+)$/.exec(g.path);
    if (m && g.method === "DELETE") {
      const i = workspaces.indexOf(decodeURIComponent(m[1]));
      if (i < 0) return { status: 404, json: { detail: "not found" } };
      workspaces.splice(i, 1);
      return { status: 202, json: {} };
    }
    // Get-or-create, as the app's SDK makes a memory bank.
    if (g.method === "POST" && g.path === "/v3/workspaces") {
      if (breaks.madeHeld) await breaks.madeHeld;
      const id = String((g.json as { id?: unknown })?.id);
      if (!workspaces.includes(id)) workspaces.push(id);
      return { json: { id, metadata: {} } };
    }
    return { status: 418 };
  });
  openai = await fakeProvider(async (g) => {
    // A response made and stored, answered whole once it's done (not streamed).
    if (g.method === "POST" && g.path === "/v1/responses") {
      if (breaks.madeHeld) await breaks.madeHeld;
      const id = `resp_made_${++made}`;
      responses.add(id);
      return { json: { id, object: "response", model: "gpt-6.1-sol", status: "completed", output: [], usage: { input_tokens: 10, output_tokens: 1 } } };
    }
    const m = /^\/v1\/responses\/([^/]+)$/.exec(g.path);
    if (!m || g.method !== "DELETE") return { status: 418 };
    if (breaks.openaiHeld) await breaks.openaiHeld;
    if (breaks.onOpenaiDelete) await breaks.onOpenaiDelete();
    const id = decodeURIComponent(m[1]);
    if (!responses.delete(id)) return { status: 404, json: { error: { message: "No response found" } } };
    return { json: { id, object: "response.deleted", deleted: true } };
  });
  // Responses over a WebSocket: each response.create answered as created.
  const sockets = new WebSocketServer({ noServer: true });
  openai.server.on("upgrade", (req, socket, head) => {
    if (req.url !== "/v1/responses") return socket.end("HTTP/1.1 404 Not Found\r\n\r\n");
    sockets.handleUpgrade(req, socket, head, (ws) =>
      ws.on("message", () => ws.send(JSON.stringify({ type: "response.created", response: { id: `resp_ws_${++wsCreates}`, object: "response", status: "in_progress" } }))),
    );
  });
  composio = await fakeProvider((g) => {
    const m = /^\/api\/v3\.1\/connected_accounts\/([^/]+)$/.exec(g.path);
    if (!m || g.method !== "DELETE" || g.headers["x-api-key"] !== "composio-test-not-a-real-key") return { status: 418 };
    if (!accounts.delete(decodeURIComponent(m[1]))) return { status: 404, json: { error: "not found" } };
    return { json: { success: true } };
  });
  Object.assign(process.env, {
    BOPS_UPSTREAM_AGENTPHONE: agentphone.url,
    BOPS_UPSTREAM_AGENTMAIL: agentmail.url,
    BOPS_UPSTREAM_HONCHO: honcho.url,
    BOPS_UPSTREAM_OPENAI: openai.url,
    BOPS_UPSTREAM_COMPOSIO: composio.url,
    AGENTPHONE_API_KEY: "ap-test-not-a-real-key",
    AGENTMAIL_API_KEY: "am-test-not-a-real-key",
    HONCHO_API_KEY: "honcho-test-not-a-real-key",
    OPENAI_API_KEY: "sk-test-not-a-real-key",
    COMPOSIO_API_KEY: "composio-test-not-a-real-key",
    BOPS_CLOUD_PLAN_SECRET: SECRET,
  });
  noticeId = Number((await query<{ id: string }>("INSERT INTO bops.notices (title, body) VALUES ('Test', 'A notice for the delete tests') RETURNING id")).rows[0].id);
  cloud = await startCloud();
});

after(async () => {
  await dropUsers(users);
  await query("DELETE FROM bops.deleted_users WHERE user_id = ANY($1::text[])", [users]);
  await query("DELETE FROM bops.mail_handles WHERE handle = ANY($1::text[])", [handles]);
  await query("DELETE FROM bops.cloud_objects WHERE object_id = ANY($1::text[])", [objects]);
  await query("DELETE FROM bops.cloud_limits WHERE key LIKE 'verify:to:sms:+1%' AND count = 99");
  await query("DELETE FROM bops.notices WHERE id = $1", [noticeId]);
  await Promise.all([cloud?.close(), orgo?.close(), agentphone?.close(), agentmail?.close(), honcho?.close(), openai?.close(), composio?.close()]);
  await closeDb();
});

beforeEach(() => {
  Object.assign(breaks, { agentphoneFails: false, openaiHeld: null, onOpenaiDelete: null, madeHeld: null });
  Object.assign(deleteTiming, { answerWithinMs: 45_000, callsWithinMs: 30_000 });
});

/** An Orgo user's id, as orgo-web sends it (a lowercase UUID). */
const newId = () => {
  const id = randomUUID();
  users.push(id);
  return id;
};

/** orgo-web's call, signed as lib/account-deletion/job.ts signs it (signBopsCloud), or as `signed` says (what undelete-user signs). */
function deleteCall(body: unknown, opts: { secret?: string; at?: number; raw?: string; path?: string; signed?: (raw: string) => Buffer | string } = {}) {
  const raw = opts.raw ?? JSON.stringify(body);
  const ts = String(Math.floor((opts.at ?? Date.now()) / 1000));
  const sig = `sha256=${createHmac("sha256", opts.secret ?? SECRET).update(`${ts}.`).update(opts.signed ? opts.signed(raw) : raw).digest("hex")}`;
  return fetch(`${cloud.url}${opts.path ?? "/v1/internal/delete-user"}`, { method: "POST", headers: { "content-type": "application/json", "x-bops-timestamp": ts, "x-bops-signature": sig }, body: raw }).then(async (r) => ({
    status: r.status,
    // Whatever the cloud answered; each test reads what it checks.
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    json: (await r.json().catch(() => null)) as any,
  }));
}

/** orgo-web's undo, signed with its route as delete-user.ts says. */
const undeleteCall = (body: unknown, opts: { signed?: (raw: string) => Buffer | string } = {}) => deleteCall(body, { path: UNDELETE_USER_PATH, signed: opts.signed ?? undeleteSigned });

/** `p`, or a failure after `ms` (a socket that's never closed fails its test instead of holding the run). */
const soon = <T>(p: Promise<T>, what: string, ms = 5_000) =>
  Promise.race([p, new Promise<never>((_, reject) => setTimeout(() => reject(new Error(`timed out waiting for ${what}`)), ms).unref())]);

const count = async (table: string, userId: string, column = "user_id") => Number((await query<{ n: string }>(`SELECT count(*) AS n FROM bops.${table} WHERE ${column} = $1`, [userId])).rows[0].n);

/** Every table that names a user, and how many rows each has for this one. */
async function rowsOf(userId: string) {
  const out: Record<string, number> = {};
  for (const t of ["app_state", "app_state_backups", "chat_messages", "cloud_accounts", "cloud_agents", "cloud_numbers", "cloud_objects", "cloud_pending", "cloud_usage", "mail_handles", "mail_inboxes", "notice_dismissals", "phone_lines", "plans", "slack_links"])
    out[t] = await count(t, userId);
  out.owner_phones = await count("owner_phones", userId, "orgo_user_id");
  out.owner_emails = await count("owner_emails", userId, "orgo_user_id");
  out.cloud_limits = Number((await query<{ n: string }>("SELECT count(*) AS n FROM bops.cloud_limits WHERE key LIKE '%' || $1 || '%'", [userId])).rows[0].n);
  return out;
}
const nothingOf = (rows: Record<string, number>) => Object.fromEntries(Object.keys(rows).map((k) => [k, 0]));

const ZERO = {
  app_state: 0, app_state_backups: 0, chat_messages: 0, cloud_accounts: 0, cloud_agents: 0, cloud_limits: 0, cloud_numbers: 0, cloud_objects: 0,
  cloud_pending: 0, cloud_usage: 0, mail_inboxes: 0, notice_dismissals: 0, owner_emails: 0, owner_phones: 0, phone_lines: 0, plans: 0, slack_links: 0,
};
const NO_PROVIDERS = { agentphone: { numbers: 0 }, agentmail: { inboxes: 0, pods: 0 }, honcho: { workspaces: 0 }, openai: { responses: 0 }, composio: { connectedAccounts: 0 } };

/**
 * A user who used everything: state and chats, a copy before Start over, a verified phone and email, a
 * number with its owner and one given back, an agent's secret, a pod with an inbox the cloud made and
 * one the Mac made, memory banks, stored responses and an agent session, a connected account and a
 * sign-in setup, a Slack link, a plan, a dismissed notice, usage, limits, a code's hold, two handles.
 */
async function fullUser() {
  const id = newId();
  const sub = `sub_${id}`;
  const pod = `pod_${id}`;
  const phone = newNumber();
  const line = newNumber();
  const given = newNumber();
  const hex = randomBytes(4).toString("hex");
  const handle = { now: `del${hex}`, old: `del${hex}-old` };
  handles.push(handle.now, handle.old);
  const ids = { r1: `resp_${hex}1`, r2: `resp_${hex}2`, session: `sess_${hex}`, account: `ca_${hex}`, setup: `ac_${hex}`, hold: `sms:${phone}` };
  objects.push(ids.setup);
  await query("INSERT INTO bops.app_state (user_id, state, version, protocol, writer) VALUES ($1, $2::jsonb, 3, 3, 'mac-1')", [id, JSON.stringify({ installId: "inst1", bots: [{ id: "boppy", name: "Boppy", isMain: true }] })]);
  await query("INSERT INTO bops.chat_messages (user_id, id, chat_id, at, json) VALUES ($1, 'm1', 'bot:boppy', 1, '{\"id\":\"m1\",\"text\":\"hi\"}'), ($1, 'm2', 'bot:boppy', 2, NULL)", [id]);
  await query("INSERT INTO bops.app_state_backups (user_id, state) VALUES ($1, '{\"messages\":[]}')", [id]);
  await query("INSERT INTO bops.owner_phones (orgo_user_id, phone_e164, consent_at, verified_at) VALUES ($1, $2, now(), now())", [id, phone]);
  await query("INSERT INTO bops.owner_emails (orgo_user_id, email, verified_at) VALUES ($1, $2, now())", [id, `${id}@example.com`]);
  await query("INSERT INTO bops.cloud_accounts (user_id, email, agentmail_pod_id, agentmail_key_sealed, agentphone_sub_account, app_version) VALUES ($1, $2, $3, $4, $5, '0.0.31')", [id, `${id}@example.com`, pod, seal("am_pod_key"), sub]);
  await query("INSERT INTO bops.cloud_agents (agent_id, user_id, secret_sealed) VALUES ($1, $2, $3)", [`agent_${hex}`, id, seal("whsec")]);
  await query("INSERT INTO bops.cloud_numbers (digits, user_id, number_id, e164) VALUES ($1, $2, $3, $4)", [line.slice(-10), id, `num_${hex}`, line]);
  await query(
    `INSERT INTO bops.phone_lines (digits, user_id, number_id, e164, bot_id, owner_number, claimed_at, claimed_via, status) VALUES
       ($1, $2, $3, $4, 'boppy', $5, now(), 'call', 'ready'), ($6, $2, $7, $8, 'boppy', NULL, NULL, NULL, 'released')`,
    [line.slice(-10), id, `num_${hex}`, line, phone, given.slice(-10), `num_${hex}_given`, given],
  );
  // At AgentPhone: the line's number, and one the cloud never recorded (it's listed).
  numbers.push({ id: `num_${hex}`, phoneNumber: line, sub }, { id: `num_${hex}_unrecorded`, phoneNumber: newNumber(), sub }, { id: `num_${hex}_given`, phoneNumber: given, sub, released: true });
  await query("INSERT INTO bops.cloud_pending (user_id, kind, payload) VALUES ($1, 'agentphone', '{\"text\":\"while you were away\"}')", [id]);
  await query("INSERT INTO bops.slack_links (user_id, account_id, team_id) VALUES ($1, $2, 'T1')", [id, ids.account]);
  await query("INSERT INTO bops.plans (user_id, tier, changed_at, source) VALUES ($1, 'pro_bops', now(), 'notice')", [id]);
  await query(`INSERT INTO bops.mail_inboxes (inbox_id, user_id, pod_id, email, plan, status) VALUES ($1, $2, $3, $1, true, 'ready')`, [`boppy@${handle.now}.bops.bot`, id, pod]);
  pods.set(pod, { client_id: `bops-${id}`, inboxes: [`boppy@${handle.now}.bops.bot`, `sam@${handle.now}.bops.bot`] });
  await query("INSERT INTO bops.mail_handles (handle, user_id, workspace_id, retired_at) VALUES ($1, $3, 'ws_main', NULL), ($2, $3, 'ws_main', now())", [handle.now, handle.old, id]);
  await query("INSERT INTO bops.notice_dismissals (user_id, notice_id) VALUES ($1, $2)", [id, noticeId]);
  await query("INSERT INTO bops.cloud_usage (user_id, kind, units) VALUES ($1, 'openai.tokens', 10)", [id]);
  await query("INSERT INTO bops.cloud_limits (key, window_start, count) VALUES ('agent:send:' || $1, now(), 1), ('verify:slot:sms:' || $1 || ':' || $2, now(), 1), ('verify:to:sms:' || $2, now(), 99)", [id, phone]);
  await query(
    `INSERT INTO bops.cloud_objects (provider, object_id, kind, user_id) VALUES
       ('openai', $2, 'response', $1), ('openai', $3, 'response', $1), ('openai', $4, 'agent_session', $1),
       ('composio', $5, 'connected_account', $1), ('composio', $6, 'auth_config', $1), ('twilio', $7, 'verification', $1)`,
    [id, ids.r1, ids.r2, ids.session, ids.account, ids.setup, ids.hold],
  );
  responses.add(ids.r1).add(ids.r2);
  accounts.add(ids.account);
  // Memory banks: theirs (two), someone else's, and one of a user whose id starts with theirs (its prefix and a 0): those two must stay.
  const prefix = honchoPrefix(id);
  workspaces.push(`${prefix}-bops`, `u-someone${hex}-bops`, `${prefix}-bops-ws2`, `${prefix}0-bops`);
  return { id, sub, pod, handle, ids, prefix, phone, other: `u-someone${hex}-bops`, longer: `${prefix}0-bops` };
}

/** A Mac of the user's on the tunnel. */
async function connectMac(userId: string) {
  const ws = new WebSocket(`${cloud.url.replace(/^http/, "ws")}/v1/connect`, { headers: { authorization: `Bearer ${keyOf(userId)}`, "x-bops-version": "99.0.0", "x-bops-state-level": "3" } });
  const closed = new Promise<number>((resolve) => ws.on("close", (code) => resolve(code)));
  ws.on("error", () => {});
  await new Promise<void>((resolve, reject) => {
    ws.on("open", () => resolve());
    ws.on("unexpected-response", (_req, res) => reject(new Error(`refused ${res.statusCode}`)));
  });
  return { ws, closed };
}

/** A Mac's state headers (lib/server/persist-cloud.ts). */
const macHeaders = (userId: string) => ({ "x-bops-user": userId, "x-bops-protocol": "2", "x-bops-device": "mac-1", "x-bops-version": "99.0.0", "x-bops-state-level": "3" });

test("the call is refused unsigned, signed wrong, too old or malformed, and is 404 with no secret set; nothing is deleted", async () => {
  const { id } = await fullUser();
  const before = await rowsOf(id);
  assert.equal((await fetch(`${cloud.url}/v1/internal/delete-user`, { method: "POST", body: JSON.stringify({ userId: id }) })).status, 401);
  assert.equal((await deleteCall({ userId: id }, { secret: "not-it" })).status, 401);
  assert.equal((await deleteCall({ userId: id }, { at: Date.now() - 10 * 60_000 })).status, 401);
  assert.equal((await deleteCall({ userId: id }, { at: Date.now() + 10 * 60_000 })).status, 401);
  assert.equal((await deleteCall(null, { raw: "{not json" })).status, 400);
  assert.equal((await deleteCall({ userId: "" })).status, 400);
  assert.equal((await deleteCall({ userId: "a/b" })).status, 400);
  assert.equal((await deleteCall({ user: id })).status, 400);
  // Only an Orgo user's id (a lowercase UUID), and nothing beside it.
  assert.equal((await deleteCall({ userId: newUserId("del") })).status, 400);
  assert.equal((await deleteCall({ userId: id.toUpperCase() })).status, 400);
  assert.equal((await deleteCall([{ userId: id }])).status, 400);
  assert.equal((await deleteCall({ userId: id, reason: "asked" })).status, 400);
  // orgo-web's other notices, signed with the same secret over the same "{timestamp}.{raw body}", sent here as they are: not a delete.
  for (const notice of [{ userId: id, tier: "free_bops", at: new Date().toISOString() }, { projectId: randomUUID(), userId: id }]) {
    const replayed = await deleteCall(notice);
    assert.deepEqual([replayed.status, replayed.json.error], [400, "Send {userId}, and nothing else"], JSON.stringify(notice));
  }
  // An undo's signature isn't a delete's, and a delete's isn't an undo's.
  assert.equal((await deleteCall({ userId: id }, { signed: undeleteSigned })).status, 401);
  assert.equal((await undeleteCall({ userId: id }, { signed: (raw) => raw })).status, 401);
  delete process.env.BOPS_CLOUD_PLAN_SECRET;
  try {
    assert.equal((await deleteCall({ userId: id })).status, 404);
  } finally {
    process.env.BOPS_CLOUD_PLAN_SECRET = SECRET;
  }
  assert.deepEqual(await rowsOf(id), before);
  assert.equal(await count("deleted_users", id), 0);
  // Their sign-in still works: nothing was marked.
  assert.equal((await call(cloud.url, "GET", "/v1/state/head", { key: keyOf(id), headers: macHeaders(id) })).status, 200);
});

test("everything of the user's goes, here and at every provider, with counts; their handles stay retired and nobody's; their tunnel ends", async () => {
  const u = await fullUser();
  const mac = await connectMac(u.id);
  const r = await deleteCall({ userId: u.id });
  assert.equal(r.status, 200, JSON.stringify(r.json));
  assert.deepEqual(r.json.deleted, {
    ...ZERO, app_state: 1, app_state_backups: 1, chat_messages: 2, cloud_accounts: 1, cloud_agents: 1, cloud_limits: 2, cloud_numbers: 1,
    // An agent session and a code's hold at once; two responses and the connected account once their provider deleted them.
    cloud_objects: 5,
    cloud_pending: 1, cloud_usage: 1, mail_inboxes: 1, notice_dismissals: 1, owner_emails: 1, owner_phones: 1,
    // The one given back at once; the live one once AgentPhone took it back.
    phone_lines: 2,
    plans: 1, slack_links: 1,
  });
  assert.deepEqual(r.json.kept, { mail_handles: 2, cloud_objects: 1 });
  assert.deepEqual(r.json.providers, { agentphone: { numbers: 2 }, agentmail: { inboxes: 2, pods: 1 }, honcho: { workspaces: 2 }, openai: { responses: 2 }, composio: { connectedAccounts: 1 } });
  // Nothing left of theirs here.
  assert.deepEqual(await rowsOf(u.id), nothingOf(await rowsOf(u.id)));
  // At the providers: every number of their sub-account given back, their pod gone with its inboxes, their banks gone (not anyone else's), their responses and account.
  assert.deepEqual(numbers.filter((n) => n.sub === u.sub && !n.released), []);
  assert.equal(pods.has(u.pod), false);
  assert.deepEqual(workspaces.filter((w) => w.startsWith(u.prefix)), [u.longer], "theirs went; one whose id only starts with theirs stays");
  assert.ok(workspaces.includes(u.other), "someone else's memory stays");
  assert.equal(responses.has(u.ids.r1) || responses.has(u.ids.r2), false);
  assert.equal(accounts.has(u.ids.account), false);
  // Their handles: kept, retired, with nothing that ties them to the person.
  const kept = (await query<{ handle: string; user_id: string | null; workspace_id: string; retired: boolean }>("SELECT handle, user_id, workspace_id, retired_at IS NOT NULL AS retired FROM bops.mail_handles WHERE handle = ANY($1::text[]) ORDER BY handle", [[u.handle.now, u.handle.old]])).rows;
  assert.deepEqual(kept, [
    { handle: u.handle.now, user_id: null, workspace_id: "", retired: true },
    { handle: u.handle.old, user_id: null, workspace_id: "", retired: true },
  ]);
  // The sign-in setup everyone uses stays, nobody's; a verify count by recipient alone is no one's and stays for its own sweep.
  assert.deepEqual((await query("SELECT user_id FROM bops.cloud_objects WHERE object_id = $1", [u.ids.setup])).rows, [{ user_id: "" }]);
  assert.equal(Number((await query<{ n: string }>("SELECT count(*) AS n FROM bops.cloud_limits WHERE key = 'verify:to:sms:' || $1", [u.phone])).rows[0].n), 1);
  // The tombstone, and their Mac's tunnel closed (not as "replaced", so it tries again, and is refused).
  assert.equal(await count("deleted_users", u.id), 1);
  assert.equal(await soon(mac.closed, "the tunnel to close"), DELETED_CLOSE);
  await assert.rejects(connectMac(u.id), /refused 401/);
});

test("a handle a deleted user had is taken for everyone else", async () => {
  const u = await fullUser();
  assert.equal((await deleteCall({ userId: u.id })).status, 200);
  const other = newUserId("del-other");
  users.push(other);
  const check = await call(cloud.url, "GET", `/v1/mail/handle?workspace=ws_main&try=${u.handle.now}`, { key: keyOf(other) });
  assert.equal(check.status, 200);
  assert.equal(check.json.status, "taken");
  assert.notEqual(check.json.suggestion, u.handle.now);
  // Asked for it outright, it's refused; asked for the suggestion from the same name, it's skipped.
  const claim = await call(cloud.url, "POST", "/v1/mail/handle", { key: keyOf(other), json: { workspaceId: "ws_main", handle: u.handle.old } });
  assert.equal(claim.status, 409);
  assert.equal(claim.json.code, "handle_taken");
  const picked = await call(cloud.url, "POST", "/v1/mail/handle", { key: keyOf(other), json: { workspaceId: "ws_main", handle: check.json.suggestion } });
  assert.equal(picked.status, 200);
  handles.push(picked.json.handle);
  assert.equal((await query("SELECT user_id FROM bops.mail_handles WHERE handle = $1", [u.handle.now])).rows[0].user_id, null);
});

test("a second call is 200 with zeros, and nothing of theirs is written again: a stale Mac's state or messages, a session, the cloud's own write, a plan notice", async () => {
  const u = await fullUser();
  assert.equal((await deleteCall({ userId: u.id })).status, 200);
  const again = await deleteCall({ userId: u.id });
  assert.deepEqual(again, { status: 200, json: { deleted: ZERO, kept: { mail_handles: 0, cloud_objects: 0 }, providers: NO_PROVIDERS } });
  // Orgo (the fake) still vouches for their key, as it could for a token not turned down yet: the cloud turns it down itself.
  const key = keyOf(u.id);
  const put = await call(cloud.url, "PUT", "/v1/state", { key, headers: macHeaders(u.id), json: { base: 0, state: { installId: "inst1", bots: [{ id: "boppy" }] } } });
  assert.deepEqual([put.status, put.json.code], [401, ACCOUNT_DELETED]);
  const posted = await call(cloud.url, "POST", "/v1/messages", { key, headers: macHeaders(u.id), json: { upsert: [{ id: "m9", chatId: "bot:boppy", at: 9, text: "stale" }], remove: [] } });
  assert.deepEqual([posted.status, posted.json.code], [401, ACCOUNT_DELETED]);
  assert.equal((await call(cloud.url, "POST", "/v1/session", { key, headers: macHeaders(u.id) })).status, 401);
  // What isn't a call (a phone turn's answer finishing, a plan's setup) is refused by the tombstone in Postgres.
  await assert.rejects(writeMessages(u.id, [{ id: "msg_cloud_1", chatId: "bot:boppy", at: 10, role: "bot", text: "late" }]), (e: Error & { extra?: { code?: string } }) => e.extra?.code === ACCOUNT_DELETED);
  await assert.rejects(ensureUserRow(u.id), (e: Error & { extra?: { code?: string } }) => e.extra?.code === ACCOUNT_DELETED);
  // The Stripe cancel's plan notice is answered as taken, and makes nothing.
  const raw = JSON.stringify({ userId: u.id, tier: "free_bops", at: new Date().toISOString() });
  const ts = String(Math.floor(Date.now() / 1000));
  const notice = await fetch(`${cloud.url}/v1/internal/plan-changed`, {
    method: "POST",
    headers: { "content-type": "application/json", "x-bops-timestamp": ts, "x-bops-signature": `sha256=${createHmac("sha256", SECRET).update(`${ts}.${raw}`).digest("hex")}` },
    body: raw,
  });
  assert.deepEqual([notice.status, await notice.json()], [200, { ok: true, applied: false }]);
  const rows = await rowsOf(u.id);
  assert.deepEqual(rows, nothingOf(rows));
});

test("a provider that fails is 502 and keeps only what the retry needs; the retry finishes, and a stale write meanwhile is refused", async () => {
  const id = newId();
  const sub = `sub_${id}`;
  const line = newNumber();
  const owner = newNumber();
  await query("INSERT INTO bops.app_state (user_id, state, version) VALUES ($1, '{\"installId\":\"i\"}', 2)", [id]);
  await query("INSERT INTO bops.chat_messages (user_id, id, chat_id, at, json) VALUES ($1, 'm1', 'bot:b', 1, '{\"id\":\"m1\"}')", [id]);
  await query("INSERT INTO bops.cloud_accounts (user_id, email, agentmail_key_sealed, agentphone_sub_account) VALUES ($1, $2, $3, $4)", [id, `${id}@example.com`, seal("k"), sub]);
  await query("INSERT INTO bops.phone_lines (digits, user_id, number_id, e164, owner_number, claimed_at, claimed_via) VALUES ($1, $2, $3, $4, $5, now(), 'text')", [line.slice(-10), id, `num_${id}`, line, owner]);
  numbers.push({ id: `num_${id}`, phoneNumber: line, sub });
  breaks.agentphoneFails = true;
  const first = await deleteCall({ userId: id });
  assert.equal(first.status, 502);
  assert.match(first.json.providers.agentphone.error, /AgentPhone answered 500 for DELETE \/v1\/numbers\//);
  assert.deepEqual(first.json.providers.agentmail, { inboxes: 0, pods: 0 });
  assert.equal(first.json.deleted.chat_messages, 1);
  // What the retry needs stays (the line's number id, the sub-account), and nothing that names the person.
  assert.deepEqual((await query("SELECT number_id, owner_number, claimed_via FROM bops.phone_lines WHERE user_id = $1", [id])).rows, [{ number_id: `num_${id}`, owner_number: null, claimed_via: null }]);
  assert.deepEqual((await query("SELECT email, agentmail_key_sealed, agentphone_sub_account FROM bops.cloud_accounts WHERE user_id = $1", [id])).rows, [{ email: null, agentmail_key_sealed: null, agentphone_sub_account: sub }]);
  assert.deepEqual((await query("SELECT state, version FROM bops.app_state WHERE user_id = $1", [id])).rows, [{ state: {}, version: "0" }]);
  assert.equal(await count("chat_messages", id), 0);
  // A Mac's stale write in between is refused, under the row the delete left.
  const put = await call(cloud.url, "PUT", "/v1/state", { key: keyOf(id), headers: macHeaders(id), json: { base: 0, state: { installId: "i" } } });
  assert.deepEqual([put.status, put.json.code], [401, ACCOUNT_DELETED]);
  await assert.rejects(writeMessages(id, [{ id: "m2", chatId: "bot:b", at: 2 }]), (e: Error & { extra?: { code?: string } }) => e.extra?.code === ACCOUNT_DELETED);
  // orgo-web asks again later: it finishes.
  breaks.agentphoneFails = false;
  const retry = await deleteCall({ userId: id });
  assert.equal(retry.status, 200, JSON.stringify(retry.json));
  assert.deepEqual(retry.json.providers.agentphone, { numbers: 1 });
  assert.deepEqual([retry.json.deleted.phone_lines, retry.json.deleted.cloud_accounts, retry.json.deleted.app_state, retry.json.deleted.chat_messages], [1, 1, 1, 0]);
  assert.equal(numbers.find((n) => n.id === `num_${id}`)?.released, true);
  const rows = await rowsOf(id);
  assert.deepEqual(rows, nothingOf(rows));
});

test("a provider that says it has no such thing counts as done", async () => {
  const id = newId();
  const line = newNumber();
  const hex = randomBytes(4).toString("hex");
  await query("INSERT INTO bops.app_state (user_id, state, version) VALUES ($1, '{}', 1)", [id]);
  // A pod, a number, a response and an account the providers have never heard of (gone by hand, or never kept there).
  await query("INSERT INTO bops.cloud_accounts (user_id, agentmail_pod_id, agentphone_sub_account) VALUES ($1, $2, $3)", [id, `pod_gone_${hex}`, `sub_gone_${hex}`]);
  await query("INSERT INTO bops.cloud_numbers (digits, user_id, number_id, e164) VALUES ($1, $2, $3, $4)", [line.slice(-10), id, `num_gone_${hex}`, line]);
  await query("INSERT INTO bops.phone_lines (digits, user_id, number_id, e164) VALUES ($1, $2, $3, $4)", [line.slice(-10), id, `num_gone_${hex}`, line]);
  await query("INSERT INTO bops.mail_inboxes (inbox_id, user_id, pod_id, email) VALUES ($1, $2, $3, $1)", [`gone${hex}@agentmail.to`, id, `pod_gone_${hex}`]);
  await query("INSERT INTO bops.cloud_objects (provider, object_id, kind, user_id) VALUES ('openai', $2, 'response', $1), ('composio', $3, 'connected_account', $1)", [id, `resp_gone_${hex}`, `ca_gone_${hex}`]);
  const r = await deleteCall({ userId: id });
  assert.equal(r.status, 200, JSON.stringify(r.json));
  assert.deepEqual(r.json.providers, NO_PROVIDERS);
  assert.deepEqual([r.json.deleted.phone_lines, r.json.deleted.cloud_numbers, r.json.deleted.mail_inboxes, r.json.deleted.cloud_objects, r.json.deleted.cloud_accounts], [1, 1, 1, 2, 1]);
  assert.ok(agentphone.got.some((g) => g.method === "DELETE" && g.path === `/v1/numbers/num_gone_${hex}`), "it asked AgentPhone");
  assert.ok(openai.got.some((g) => g.method === "DELETE" && g.path === `/v1/responses/resp_gone_${hex}`), "it asked OpenAI");
  const rows = await rowsOf(id);
  assert.deepEqual(rows, nothingOf(rows));
});

test("numbers recorded for a user with no AgentPhone sub-account have nothing to give back there: their records go, and AgentPhone isn't asked", async () => {
  const id = newId();
  const hex = randomBytes(4).toString("hex");
  const line = newNumber();
  await query("INSERT INTO bops.app_state (user_id, state, version) VALUES ($1, '{}', 1)", [id]);
  await query("INSERT INTO bops.cloud_accounts (user_id) VALUES ($1)", [id]);
  await query("INSERT INTO bops.cloud_numbers (digits, user_id, number_id, e164) VALUES ($1, $2, $3, $4)", [line.slice(-10), id, `num_nosub_${hex}`, line]);
  const asked = agentphone.got.length;
  const r = await deleteCall({ userId: id });
  // Not 502 for good: the last step knows step 3 saw that number, and passed it over.
  assert.equal(r.status, 200, JSON.stringify(r.json));
  assert.deepEqual([r.json.providers.agentphone, r.json.deleted.cloud_numbers], [{ numbers: 0 }, 1]);
  assert.equal(agentphone.got.length, asked);
  const rows = await rowsOf(id);
  assert.deepEqual(rows, nothingOf(rows));
});

test("a user Bops Cloud never heard of is 200 with zeros", async () => {
  const id = newId();
  const asked = { agentphone: agentphone.got.length, agentmail: agentmail.got.length, openai: openai.got.length, composio: composio.got.length };
  const r = await deleteCall({ userId: id });
  assert.deepEqual(r, { status: 200, json: { deleted: ZERO, kept: { mail_handles: 0, cloud_objects: 0 }, providers: NO_PROVIDERS } });
  // AgentPhone and AgentMail aren't asked anything about an account the cloud never set up (with no sub-account, AgentPhone would list the
  // whole account's numbers; with no account, AgentMail would be asked for every pod), and OpenAI and Composio have nothing recorded to delete.
  assert.deepEqual({ agentphone: agentphone.got.length, agentmail: agentmail.got.length, openai: openai.got.length, composio: composio.got.length }, asked);
});

test("what a deleted user did as a member in someone else's workspace goes, waiting or already taken, and their act count; that owner's own stays", async () => {
  const id = newId();
  const owner = newId();
  await ensureUserRow(owner);
  const payload = (userId: string) => JSON.stringify({ projectId: "p1", wsId: "ws_acme", member: { userId, name: "Sam" }, key: "k_12345678", at: 1, act: { act: "chat", chatId: "bot:max", text: "hi" } });
  await query("INSERT INTO bops.cloud_pending (user_id, kind, payload, dedupe_key) VALUES ($1, 'member', $2::jsonb, 'member:' || $3 || ':k1'), ($1, 'member', $4::jsonb, 'member:someone:k1'), ($1, 'slack', '{}', NULL)", [owner, payload(id), id, payload("someone-else")]);
  // One the owner's Mac took already: kept a week for its key, with their name and words in it.
  await query("INSERT INTO bops.cloud_pending (user_id, kind, payload, dedupe_key, delivered_at) VALUES ($1, 'member', $2::jsonb, 'member:' || $3 || ':k2', now())", [owner, payload(id), id]);
  await query("INSERT INTO bops.cloud_limits (key, window_start, count) VALUES ('member:act:' || $1, now(), 3)", [id]);
  const r = await deleteCall({ userId: id });
  assert.equal(r.status, 200, JSON.stringify(r.json));
  assert.equal((r.json.deleted as Record<string, number>).cloud_pending, 2);
  assert.equal((r.json.deleted as Record<string, number>).cloud_limits, 1);
  const left = (await query<{ kind: string; who: string | null }>("SELECT kind, payload->'member'->>'userId' AS who FROM bops.cloud_pending WHERE user_id = $1 ORDER BY id", [owner])).rows;
  assert.deepEqual(left, [{ kind: "member", who: "someone-else" }, { kind: "slack", who: null }]);
  await query("DELETE FROM bops.cloud_pending WHERE user_id = $1", [owner]);
  await dropUsers([owner]);
});

test("one still going past the wait is 503, a call meanwhile waits for the same run, and the next one after it is done says so", async () => {
  const id = newId();
  const hex = randomBytes(4).toString("hex");
  await query("INSERT INTO bops.app_state (user_id, state, version) VALUES ($1, '{}', 1)", [id]);
  await query("INSERT INTO bops.cloud_objects (provider, object_id, kind, user_id) VALUES ('openai', $2, 'response', $1)", [id, `resp_slow_${hex}`]);
  responses.add(`resp_slow_${hex}`);
  const held = gate();
  breaks.openaiHeld = held.promise;
  deleteTiming.answerWithinMs = 150;
  const first = await deleteCall({ userId: id });
  assert.deepEqual([first.status, first.json.pending], [503, true]);
  const second = await deleteCall({ userId: id });
  assert.equal(second.status, 503);
  held.open();
  await until(async () => (await count("app_state", id)) === 0, "the run to finish");
  assert.equal(openai.got.filter((g) => g.path === `/v1/responses/resp_slow_${hex}`).length, 1, "one run, one delete");
  deleteTiming.answerWithinMs = 45_000;
  assert.equal((await deleteCall({ userId: id })).status, 200);
  assert.equal(responses.has(`resp_slow_${hex}`), false);
});

test("the tombstone is Postgres's: after a restart (nothing in memory) a deleted user's sign-in is still turned down, and so is one deleted elsewhere", async () => {
  const u = await fullUser();
  assert.equal((await deleteCall({ userId: u.id })).status, 200);
  // A restart: the process knows nothing of who was deleted, and asks Orgo about each key again.
  forgetDeletedKnown();
  clearAuthCache();
  const head = await call(cloud.url, "GET", "/v1/state/head", { key: keyOf(u.id), headers: macHeaders(u.id) });
  assert.deepEqual([head.status, head.json.code], [401, ACCOUNT_DELETED]);
  // One this process never deleted (another process did, or it was before the restart) is turned down too, within the minute.
  const other = newId();
  await query("INSERT INTO bops.app_state (user_id, state, version) VALUES ($1, '{}', 1)", [other]);
  const ask = () => call(cloud.url, "GET", "/v1/state/head", { key: keyOf(other), headers: macHeaders(other) });
  assert.equal((await ask()).status, 200);
  await query("INSERT INTO bops.deleted_users (user_id) VALUES ($1)", [other]);
  forgetDeletedKnown();
  const theirs = await ask();
  assert.deepEqual([theirs.status, theirs.json.code], [401, ACCOUNT_DELETED]);
});

test("undelete-user lifts the tombstone, signed with its route: they sign in and write again, nothing deleted comes back, and it waits for a delete still running", async () => {
  const u = await fullUser();
  assert.equal((await deleteCall({ userId: u.id })).status, 200);
  const put = () => call(cloud.url, "PUT", "/v1/state", { key: keyOf(u.id), headers: macHeaders(u.id), json: { base: 0, state: { installId: "inst1", bots: [{ id: "boppy" }] } } });
  assert.deepEqual([(await put()).status, await count("deleted_users", u.id)], [401, 1]);
  // Unsigned, signed as a delete is, or more than {userId}: refused, and the tombstone stays.
  assert.equal((await fetch(`${cloud.url}${UNDELETE_USER_PATH}`, { method: "POST", body: JSON.stringify({ userId: u.id }) })).status, 401);
  assert.equal((await undeleteCall({ userId: u.id }, { signed: (raw) => raw })).status, 401);
  assert.equal((await undeleteCall({ userId: u.id, tier: "free_bops" })).status, 400);
  assert.equal(await count("deleted_users", u.id), 1);
  delete process.env.BOPS_CLOUD_PLAN_SECRET;
  try {
    assert.equal((await undeleteCall({ userId: u.id })).status, 404);
  } finally {
    process.env.BOPS_CLOUD_PLAN_SECRET = SECRET;
  }
  assert.deepEqual(await undeleteCall({ userId: u.id }), { status: 200, json: { ok: true, lifted: true } });
  assert.equal(await count("deleted_users", u.id), 0);
  // Their Mac writes again, from nothing: what was deleted stays deleted.
  const again = await put();
  assert.equal(again.status, 200, JSON.stringify(again.json));
  assert.deepEqual([await count("chat_messages", u.id), await count("app_state_backups", u.id)], [0, 0]);
  // A restart changes nothing; a second undo finds no tombstone.
  forgetDeletedKnown();
  clearAuthCache();
  assert.equal((await call(cloud.url, "GET", "/v1/state/head", { key: keyOf(u.id), headers: macHeaders(u.id) })).status, 200);
  assert.deepEqual(await undeleteCall({ userId: u.id }), { status: 200, json: { ok: true, lifted: false } });
  // While a delete of theirs still runs, an undo is turned away (it would let their writes in mid-delete).
  const hex = randomBytes(4).toString("hex");
  await query("INSERT INTO bops.cloud_objects (provider, object_id, kind, user_id) VALUES ('openai', $2, 'response', $1)", [u.id, `resp_undo_${hex}`]);
  responses.add(`resp_undo_${hex}`);
  const held = gate();
  breaks.openaiHeld = held.promise;
  deleteTiming.answerWithinMs = 150;
  assert.equal((await deleteCall({ userId: u.id })).status, 503);
  const early = await undeleteCall({ userId: u.id });
  assert.deepEqual([early.status, early.json.error], [409, "Still deleting: ask again once it's done"]);
  held.open();
  await until(async () => (await count("app_state", u.id)) === 0, "the run to finish");
  assert.equal(await count("deleted_users", u.id), 1);
});

test("something a provider deletes, made by a call already under way while the delete ran, keeps it from finishing: 502, and the retry deletes it there too", async () => {
  const id = newId();
  const hex = randomBytes(4).toString("hex");
  await query("INSERT INTO bops.app_state (user_id, state, version) VALUES ($1, '{}', 1)", [id]);
  await query("INSERT INTO bops.cloud_objects (provider, object_id, kind, user_id) VALUES ('openai', $2, 'response', $1)", [id, `resp_old_${hex}`]);
  responses.add(`resp_old_${hex}`);
  // While OpenAI deletes the one recorded, a call that got in before the delete records what it made: a stored response, a turn, a use.
  breaks.onOpenaiDelete = async () => {
    breaks.onOpenaiDelete = null;
    responses.add(`resp_new_${hex}`);
    await ownObject(id, "openai", "response", `resp_new_${hex}`);
    await ownObject(id, "openai", "agent_turn", `turn_new_${hex}`);
    await recordUsage(id, "honcho.calls", 1);
  };
  const first = await deleteCall({ userId: id });
  assert.equal(first.status, 502, JSON.stringify(first.json));
  assert.deepEqual(first.json.providers.openai, { responses: 1, error: "Something of theirs was made there while this ran: ask again to delete it" });
  // The new response's record stays for the retry, with the state row; the turn and the use were never written.
  assert.deepEqual((await query("SELECT object_id, kind FROM bops.cloud_objects WHERE user_id = $1", [id])).rows, [{ object_id: `resp_new_${hex}`, kind: "response" }]);
  assert.deepEqual([await count("cloud_usage", id), await count("app_state", id)], [0, 1]);
  const retry = await deleteCall({ userId: id });
  assert.equal(retry.status, 200, JSON.stringify(retry.json));
  assert.deepEqual(retry.json.providers.openai, { responses: 1 });
  assert.equal(responses.has(`resp_new_${hex}`), false);
  const rows = await rowsOf(id);
  assert.deepEqual(rows, nothingOf(rows));
  // Once it's all gone, nothing is recorded for them at all.
  await ownObject(id, "openai", "response", `resp_late_${hex}`);
  await recordUsageFor(id, "openai.tokens", `resp_late_${hex}`, 10);
  await recordTokens(id, `resp_late_${hex}`, { input_tokens: 10, output_tokens: 1 }, { source: "responses" });
  assert.deepEqual([await count("cloud_objects", id), await count("cloud_usage", id)], [0, 0]);
});

/** A response asked for through the proxy, as a task's computer asks (not streamed: it's recorded once its whole answer is in), once OpenAI has it: its answer, to wait for. */
async function askResponse(userId: string) {
  const input = `think it through ${randomBytes(4).toString("hex")}`;
  const asked = call(cloud.url, "POST", "/proxy/openai/v1/responses", { key: keyOf(userId), json: { model: "gpt-6.1-sol", input } });
  await until(() => openai.got.some((g) => g.method === "POST" && (g.json as { input?: unknown })?.input === input), "the call to reach OpenAI");
  // In an object: an async function returning the promise itself would wait for it.
  return { asked };
}

test("calls under way when the delete comes that may make something at a provider are waited for: what they make (a stored response, a memory bank) is deleted there too", async () => {
  const u = await fullUser();
  const held = gate();
  breaks.madeHeld = held.promise;
  // A long answer, and a memory bank being made, both in at the providers before the delete comes.
  const { asked } = await askResponse(u.id);
  const bank = call(cloud.url, "POST", "/v3/workspaces", { key: keyOf(u.id), json: { id: `${u.prefix}-bops-late` } });
  await until(() => honcho.got.some((g) => g.method === "POST" && g.path === "/v3/workspaces" && (g.json as { id?: unknown })?.id === `${u.prefix}-bops-late`), "the bank call to reach Honcho");
  const deleting = deleteCall({ userId: u.id });
  await until(async () => (await count("chat_messages", u.id)) === 0, "their content to go");
  const first = await Promise.race([deleting.then(() => "answered"), new Promise((resolve) => setTimeout(() => resolve("waiting"), 300))]);
  assert.equal(first, "waiting", "the delete waits for their calls before it asks the providers");
  held.open();
  const [response, made, done] = await Promise.all([soon(asked, "the response"), soon(bank, "the bank"), soon(deleting, "the delete")]);
  assert.deepEqual([response.status, made.status], [200, 200], "calls signed in before the delete get their answers");
  assert.equal(done.status, 200, JSON.stringify(done.json));
  assert.equal(done.json.providers.openai.responses, 3, "the two recorded before, and the one it made");
  assert.equal(done.json.providers.honcho.workspaces, 3, "the two banks before, and the one made");
  assert.ok(openai.got.some((g) => g.method === "DELETE" && g.path === `/v1/responses/${response.json.id}`), "what it made was deleted at OpenAI");
  assert.deepEqual([responses.has(response.json.id), workspaces.includes(`${u.prefix}-bops-late`)], [false, false]);
  const rows = await rowsOf(u.id);
  assert.deepEqual(rows, nothingOf(rows));
});

test("a call still going past the wait is 502 for its provider and keeps their state row, and the retry deletes what it made", async () => {
  const id = newId();
  await query("INSERT INTO bops.app_state (user_id, state, version) VALUES ($1, '{}', 1)", [id]);
  const held = gate();
  breaks.madeHeld = held.promise;
  deleteTiming.callsWithinMs = 100;
  const { asked } = await askResponse(id);
  const first = await deleteCall({ userId: id });
  assert.equal(first.status, 502, JSON.stringify(first.json));
  assert.deepEqual(first.json.providers.openai, { responses: 0, error: "A call of theirs there was still going: ask again to delete what it made" });
  assert.equal(await count("app_state", id), 1, "their state row stays, so what it makes is recorded");
  held.open();
  const response = await asked;
  assert.equal(response.status, 200);
  assert.deepEqual((await query("SELECT kind FROM bops.cloud_objects WHERE user_id = $1 AND object_id = $2", [id, response.json.id])).rows, [{ kind: "response" }]);
  const retry = await deleteCall({ userId: id });
  assert.equal(retry.status, 200, JSON.stringify(retry.json));
  assert.deepEqual(retry.json.providers.openai, { responses: 1 });
  assert.equal(responses.has(response.json.id), false);
  const rows = await rowsOf(id);
  assert.deepEqual(rows, nothingOf(rows));
});

test("a task's Responses socket open when the delete comes is closed; one a delete didn't reach sends nothing more", async () => {
  const url = `${cloud.url.replace(/^http/, "ws")}/proxy/openai/v1/responses`;
  const open = async (userId: string) => {
    const ws = new WebSocket(url, { headers: { authorization: `Bearer ${keyOf(userId)}` } });
    const got: { type: string; response?: { id: string }; error?: { code?: string | null } }[] = [];
    ws.on("message", (data) => got.push(JSON.parse(String(data))));
    const closed = new Promise<number>((resolve) => ws.on("close", (code) => resolve(code)));
    await new Promise((resolve, reject) => (ws.once("open", resolve), ws.once("error", reject)));
    return { ws, got, closed };
  };
  const ask = (ws: WebSocket) => ws.send(JSON.stringify({ type: "response.create", model: "gpt-6.1-sol", input: "hello" }));
  const u = await fullUser();
  const task = await open(u.id);
  ask(task.ws);
  const made = await until(() => task.got.find((e) => e.type === "response.created"), "a response");
  await until(async () => (await query("SELECT 1 FROM bops.cloud_objects WHERE object_id = $1 AND user_id = $2", [made.response!.id, u.id])).rowCount, "it to be theirs");
  assert.equal((await deleteCall({ userId: u.id })).status, 200);
  assert.equal(await soon(task.closed, "the socket to close"), DELETED_CLOSE);
  assert.ok(openai.got.some((g) => g.method === "DELETE" && g.path === `/v1/responses/${made.response!.id}`), "what it made was deleted at OpenAI too");
  const status = await new Promise<number>((resolve) => new WebSocket(url, { headers: { authorization: `Bearer ${keyOf(u.id)}` } }).once("unexpected-response", (_req, res) => resolve(res.statusCode ?? 0)));
  assert.equal(status, 401);
  // A socket the delete didn't reach (the tombstone written elsewhere): its next response.create is refused, nothing goes on, and it's closed.
  const other = newId();
  await query("INSERT INTO bops.app_state (user_id, state, version) VALUES ($1, '{}', 1)", [other]);
  const late = await open(other);
  await query("INSERT INTO bops.deleted_users (user_id) VALUES ($1)", [other]);
  forgetDeletedKnown();
  const sent = wsCreates;
  ask(late.ws);
  assert.equal(await soon(late.closed, "the late socket to close"), DELETED_CLOSE);
  assert.equal(late.got.find((e) => e.type === "error")?.error?.code, ACCOUNT_DELETED);
  assert.equal(wsCreates, sent, "nothing went on to OpenAI");
});

test("a delete that loses a deadlock to the hourly sweep's order (an old removed message's row, then the state row) is tried again, and finishes", async () => {
  const id = newId();
  await query("INSERT INTO bops.app_state (user_id, state, version) VALUES ($1, '{}', 1)", [id]);
  await query("INSERT INTO bops.chat_messages (user_id, id, chat_id, at, json) VALUES ($1, 'removed', 'bot:b', 1, NULL)", [id]);
  // The sweep's order, by hand (state.ts sweepRemovedMessages): the removed message's row first...
  const sweep = new pg.Client({ connectionString: TEST_DATABASE_URL });
  await sweep.connect();
  try {
    await sweep.query("BEGIN");
    await sweep.query("SELECT 1 FROM bops.chat_messages WHERE user_id = $1 FOR UPDATE", [id]);
    const r = deleteCall({ userId: id });
    // ...then, once the delete holds the state row and waits for that one, the state row: Postgres stops one of them.
    await until(
      async () => (await query("SELECT 1 FROM pg_stat_activity WHERE wait_event_type = 'Lock' AND query LIKE 'DELETE FROM bops.chat_messages WHERE user_id%'")).rowCount,
      "the delete to wait on the message's row",
    );
    await sweep.query("UPDATE bops.app_state SET swept_seq = swept_seq WHERE user_id = $1", [id]);
    await sweep.query("COMMIT");
    const done = await r;
    assert.equal(done.status, 200, JSON.stringify(done.json));
    assert.equal(done.json.deleted.chat_messages, 1);
  } finally {
    await sweep.end();
  }
  const rows = await rowsOf(id);
  assert.deepEqual(rows, nothingOf(rows));
});

test("copies before Start over are kept 30 days, and the newest 5 per user; tombstones go after their days", async () => {
  const a = newUserId("del-backups");
  const b = newUserId("del-backups");
  users.push(a, b);
  for (let i = 0; i < 7; i++) await query("INSERT INTO bops.app_state_backups (user_id, state, created_at) VALUES ($1, $2::jsonb, now() - make_interval(hours => $3))", [a, JSON.stringify({ n: i }), i]);
  await query("INSERT INTO bops.app_state_backups (user_id, state, created_at) VALUES ($1, '{\"n\":\"old\"}', now() - interval '31 days'), ($1, '{\"n\":\"recent\"}', now() - interval '29 days')", [b]);
  await sweepBackups();
  const left = async (userId: string) => (await query<{ state: { n: unknown } }>("SELECT state FROM bops.app_state_backups WHERE user_id = $1 ORDER BY created_at DESC", [userId])).rows.map((r) => r.state.n);
  assert.deepEqual(await left(a), [0, 1, 2, 3, 4].slice(0, BACKUPS_PER_USER));
  assert.deepEqual(await left(b), ["recent"]);
  // A deleted user's tombstone leaves after DELETED_KEEP_DAYS.
  await query("INSERT INTO bops.deleted_users (user_id, deleted_at) VALUES ($1, now() - make_interval(days => $3)), ($2, now())", [a, b, DELETED_KEEP_DAYS + 1]);
  await sweepDeletedUsers();
  assert.deepEqual([await count("deleted_users", a), await count("deleted_users", b)], [0, 1]);
});
