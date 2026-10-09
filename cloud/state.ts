import type { IncomingMessage, ServerResponse } from "node:http";
import { promisify } from "node:util";
import { gunzip, gzip } from "node:zlib";
import type pg from "pg";
import type { CloudUser } from "./auth.ts";
import { query, tx } from "./db.ts";
import { HttpError, readBody, sendJson, type Route } from "./http.ts";
import { afterStateUpload } from "./plans.ts";
import {
  BOPS_DEVICE_HEADER,
  BOPS_PROTOCOL_HEADER,
  BOPS_USER_HEADER,
  STATE_CONFLICT,
  STATE_PROTOCOL,
  WRONG_USER,
  type CloudMessageRow,
  type CloudMessagesPage,
  type CloudState,
  type CloudStateBody,
  type CloudStateConflict,
  type CloudStateHead,
} from "./protocol.ts";
import { notifyMac } from "./tunnel.ts";
import { forgetTelemetryChoice } from "./analytics.ts";

/**
 * The app's state, kept here for each user (protocol.ts, "The app's state in Bops Cloud"). Owner: edge builder.
 *
 * A signed-in Mac keeps no state of its own: it loads it from here at sign-in and writes each change
 * back (lib/server/persist-cloud.ts). The chat messages are rows in bops.chat_messages, written one by
 * one (POST /v1/messages); everything else is one blob in bops.app_state (PUT /v1/state), written only
 * over the version it was read at, so two Macs of one user can't write over each other: the second
 * gets 409 with what's there now, merges, and writes again. After every write the user's connected Mac
 * hears of it (a "state" frame), and the others look now and then (GET /v1/state/head).
 *
 * Builds from before upload the whole state, messages and all, as a backup (CloudStateBody). They're
 * still taken until a newer build writes for the user (the row's protocol becomes 2); then they're
 * refused (426), so an old build can't write over the newer one's work. Their GET gets the messages
 * put back in.
 *
 * Every call that's for a user's state names that user (X-Bops-User), and it must be the key's: a Mac
 * that signed in as someone else since can't write into the wrong account (409 wrong_user).
 *
 * The cloud writes messages of its own too (writeMessages): one sent from the phone and the main
 * bot's answer to it (cloud/agent.ts), read from here by the user's Macs like any other.
 */

/** A state upload or a batch of messages, as sent and once unzipped. */
const MAX_BODY = 20 * 1024 * 1024;
/** One message, as JSON. */
const MAX_MESSAGE = 256 * 1024;
const PAGE = 2000;
const MAX_PAGE = 5000;
/** How long a removed message's row stays, so a Mac that was away hears it went. */
export const REMOVED_KEEP_DAYS = 30;
const SWEEP_MS = 3600_000;

const unzip = promisify(gunzip);
const zip = promisify(gzip);

/** JSON for a JSONB column. Postgres can't keep NUL in JSONB text (screen text and pasted mail sometimes have one), so it's dropped, as lib/server/persist-pg.ts does. */
export const toJson = (value: unknown) => JSON.stringify(value, (_key, v) => (typeof v === "string" && v.includes("\0") ? v.replaceAll("\0", "") : v));

type Row = { version: number; protocol: number; writer: string | null; state: Record<string, unknown>; empty: boolean };

async function readRow(userId: string): Promise<Row | null> {
  const r = await query<{ state: Record<string, unknown>; version: string; protocol: number; writer: string | null }>(
    "SELECT state, version, protocol, writer FROM bops.app_state WHERE user_id = $1",
    [userId],
  );
  const row = r.rows[0];
  if (!row) return null;
  return { version: Number(row.version), protocol: row.protocol, writer: row.writer, state: row.state, empty: !row.state || Object.keys(row.state).length === 0 };
}

/**
 * The user's state without its messages, or null. The empty row other tables need before the first
 * upload (db.ts ensureUserRow) doesn't count. What the cloud reads to answer calls while the Mac is
 * away (calls.ts, voice.ts, hooks.ts, provision.ts, handles.ts): none of them needs a message.
 */
export async function loadState(userId: string): Promise<{ version: number; state: unknown } | null> {
  const row = await readRow(userId);
  return row && !row.empty ? { version: row.version, state: row.state } : null;
}

/** The newest message write's seq for the user (0: none yet). */
async function lastSeq(userId: string, c: pg.PoolClient | null = null): Promise<number> {
  const sql = "SELECT COALESCE(max(seq), 0) AS seq FROM bops.chat_messages WHERE user_id = $1";
  const r = c ? await c.query<{ seq: string }>(sql, [userId]) : await query<{ seq: string }>(sql, [userId]);
  return Number(r.rows[0].seq);
}

/**
 * Where a reader that has everything up to now goes on from: the user's newest message write's seq, or
 * the highest seq swept for good when that's newer (its rows are gone), so a cursor from here never has
 * to start over (sweptSeq). 0: none yet.
 */
export async function newestSeq(userId: string): Promise<number> {
  const r = await query<{ seq: string }>(
    `SELECT GREATEST((SELECT COALESCE(max(seq), 0) FROM bops.chat_messages WHERE user_id = $1),
                     (SELECT COALESCE(max(swept_seq), 0) FROM bops.app_state WHERE user_id = $1)) AS seq`,
    [userId],
  );
  return Number(r.rows[0].seq);
}

async function head(userId: string): Promise<CloudStateHead> {
  const row = await readRow(userId);
  return { version: row?.version ?? 0, seq: await lastSeq(userId), writer: row?.writer ?? null };
}

/** The user's live messages, oldest first: the order the app keeps them in. */
async function liveMessages(userId: string): Promise<Record<string, unknown>[]> {
  const r = await query<{ json: Record<string, unknown> }>("SELECT json FROM bops.chat_messages WHERE user_id = $1 AND json IS NOT NULL ORDER BY at, seq", [userId]);
  return r.rows.map((x) => x.json);
}

/** The user's Mac hears that their state changed (it reads what did). Best effort, after the write. */
function announce(userId: string) {
  void head(userId)
    .then((h) => notifyMac(userId, { t: "state", version: h.version, seq: h.seq }))
    .catch(() => {});
}

const headerOf = (req: IncomingMessage, name: string) => {
  const v = req.headers[name];
  return (Array.isArray(v) ? v[0] : v)?.trim() || "";
};
const newBuild = (req: IncomingMessage) => headerOf(req, BOPS_PROTOCOL_HEADER) === String(STATE_PROTOCOL);
const deviceOf = (req: IncomingMessage) => headerOf(req, BOPS_DEVICE_HEADER).slice(0, 64) || null;

/** The user the call names must be the key's. `required`: calls only a newer build makes must name one (and the phone's, cloud/agent.ts). */
export function checkUser(req: IncomingMessage, user: CloudUser, required: boolean) {
  const named = headerOf(req, BOPS_USER_HEADER);
  if (!named) {
    if (required) throw new HttpError(400, `Name the user (${BOPS_USER_HEADER})`);
    return;
  }
  if (named !== user.id) throw new HttpError(409, "This Orgo sign-in is another account's", { code: WRONG_USER });
}

/** The request body, unzipped when the Mac gzipped it. Past 20 MB, sent or unzipped, it's refused (413). */
async function bodyOf(req: IncomingMessage): Promise<Buffer> {
  const raw = await readBody(req, MAX_BODY);
  const encoding = (req.headers["content-encoding"] ?? "identity").trim().toLowerCase();
  if (encoding === "identity") return raw;
  if (encoding !== "gzip") throw new HttpError(415, "Send the state as plain JSON or gzipped");
  try {
    return await unzip(raw, { maxOutputLength: MAX_BODY });
  } catch (e) {
    if ((e as { code?: string }).code === "ERR_BUFFER_TOO_LARGE") throw new HttpError(413, "Request too large");
    throw new HttpError(400, "Body isn't valid gzip");
  }
}

function jsonOf<T>(data: Buffer): T {
  try {
    return JSON.parse(data.toString("utf8")) as T;
  } catch {
    throw new HttpError(400, "Body isn't JSON");
  }
}

const isObject = (v: unknown): v is Record<string, unknown> => !!v && typeof v === "object" && !Array.isArray(v);
const wholeNumber = (v: unknown): v is number => typeof v === "number" && Number.isSafeInteger(v) && v >= 0;

/** JSON, gzipped for a client that asks: a whole state or a page of messages runs to megabytes, gzipped a tenth of that. */
export async function sendZipped(req: IncomingMessage, res: ServerResponse, status: number, body: unknown) {
  const json = Buffer.from(JSON.stringify(body));
  const gzipped = /\bgzip\b/i.test(req.headers["accept-encoding"] ?? "");
  const data = gzipped ? await zip(json) : json;
  res.writeHead(status, {
    "content-type": "application/json",
    "content-length": String(data.length),
    "cache-control": "no-store",
    vary: "accept-encoding",
    ...(gzipped ? { "content-encoding": "gzip" } : {}),
  });
  res.end(data);
}

/** The blob as it's kept: never with the messages, which have their own rows. */
function blobOf(state: Record<string, unknown>) {
  return Object.fromEntries(Object.entries(state).filter(([k]) => k !== "messages"));
}

/** A message as it's written: an object with an id, a chat and a time, small enough. */
type Msg = { id: string; chatId: string; at: number; json: string };
function messageOf(m: unknown): Msg {
  if (!isObject(m) || typeof m.id !== "string" || !m.id || m.id.length > 200) throw new HttpError(400, "Each message needs an id");
  const json = toJson(m);
  if (Buffer.byteLength(json) > MAX_MESSAGE) throw new HttpError(413, `Message ${m.id} is too big`);
  return { id: m.id, chatId: typeof m.chatId === "string" ? m.chatId : "", at: typeof m.at === "number" && Number.isFinite(m.at) ? Math.floor(m.at) : 0, json };
}

/** Last one wins when an id comes twice (Postgres can't update one row twice in a statement). */
const lastOfEach = (msgs: Msg[]) => [...new Map(msgs.map((m) => [m.id, m])).values()];

/**
 * Write messages (each replacing its row) on the user's locked row. A row that's already the same
 * keeps its seq, so no Mac reads it again for nothing.
 */
async function upsertMessages(c: pg.PoolClient, userId: string, msgs: Msg[]) {
  if (!msgs.length) return;
  const list = lastOfEach(msgs);
  await c.query(
    `INSERT INTO bops.chat_messages (user_id, id, chat_id, at, json)
     SELECT $1, t.id, t.chat_id, t.at, t.json::jsonb
     FROM unnest($2::text[], $3::text[], $4::bigint[], $5::text[]) WITH ORDINALITY AS t(id, chat_id, at, json, n)
     ORDER BY t.n
     ON CONFLICT (user_id, id) DO UPDATE
       SET chat_id = EXCLUDED.chat_id, at = EXCLUDED.at, json = EXCLUDED.json, seq = EXCLUDED.seq, updated_at = now()
       WHERE bops.chat_messages.json IS DISTINCT FROM EXCLUDED.json`,
    [userId, list.map((m) => m.id), list.map((m) => m.chatId), list.map((m) => m.at), list.map((m) => m.json)],
  );
}

/** Mark messages removed (their rows stay, empty, for REMOVED_KEEP_DAYS). */
async function removeMessages(c: pg.PoolClient, userId: string, ids: string[]) {
  if (!ids.length) return;
  await c.query(
    `UPDATE bops.chat_messages SET json = NULL, seq = nextval('bops.chat_seq'), updated_at = now()
     WHERE user_id = $1 AND id = ANY($2::text[]) AND json IS NOT NULL`,
    [userId, ids],
  );
}

/** Lock the user's row (making the empty one if there's none), so their writes go one at a time and seqs land in order. */
async function lockUser(c: pg.PoolClient, userId: string) {
  await c.query(`INSERT INTO bops.app_state (user_id, state, version) VALUES ($1, '{}'::jsonb, 0) ON CONFLICT (user_id) DO NOTHING`, [userId]);
  const r = await c.query<{ version: string; protocol: number }>("SELECT version, protocol FROM bops.app_state WHERE user_id = $1 FOR UPDATE", [userId]);
  return { version: Number(r.rows[0].version), protocol: r.rows[0].protocol };
}

/* ---------------- The cloud's own messages, and one chat's (cloud/agent.ts) ---------------- */

/**
 * Write messages as the cloud's own (cloud/agent.ts: a message sent from the phone, and the main
 * bot's answer to it), each replacing its row, on the user's locked row as POST /v1/messages writes
 * them; then the user's connected Mac hears of it (a "state" frame) and reads them, as it reads
 * another Mac's. Each needs an id, a chat and a time.
 */
export async function writeMessages(userId: string, messages: Record<string, unknown>[]): Promise<void> {
  const msgs = messages.map(messageOf);
  if (!msgs.length) return;
  await tx(async (c) => {
    await lockUser(c, userId);
    await upsertMessages(c, userId, msgs);
  });
  announce(userId);
}

/** A message's row as kept: its JSON, or null when it was removed (the chat it was in stays). */
export type MessageRow = { id: string; seq: number; chatId: string; at: number; json: Record<string, unknown> | null };
type RawRow = { id: string; seq: string; chat_id: string; at: string; json: Record<string, unknown> | null };
const rowOf = (x: RawRow): MessageRow => ({ id: x.id, seq: Number(x.seq), chatId: x.chat_id, at: Number(x.at), json: x.json });
const ROW = "id, seq, chat_id, at, json";

/**
 * Every chat's rows written after `after`, removed ones too, oldest first, as GET /v1/messages pages
 * them: `seq` is the last row's (the next cursor, past other chats' rows too), `more` whether there
 * are more than `limit`.
 */
export async function rowsAfter(userId: string, after: number, limit: number): Promise<{ rows: MessageRow[]; seq: number; more: boolean }> {
  const r = await query<RawRow>(`SELECT ${ROW} FROM bops.chat_messages WHERE user_id = $1 AND seq > $2 ORDER BY seq LIMIT $3`, [userId, after, limit + 1]);
  const rows = r.rows.slice(0, limit).map(rowOf);
  return { rows, seq: rows.length ? rows[rows.length - 1].seq : after, more: r.rows.length > limit };
}

/** One chat's newest `limit` live messages, or the newest before `beforeAt`, oldest first; `more`: there are older ones. */
export async function chatPage(userId: string, chatId: string, beforeAt: number | null, limit: number): Promise<{ rows: MessageRow[]; more: boolean }> {
  const r =
    beforeAt === null
      ? await query<RawRow>(`SELECT ${ROW} FROM bops.chat_messages WHERE user_id = $1 AND chat_id = $2 AND json IS NOT NULL ORDER BY at DESC, seq DESC LIMIT $3`, [userId, chatId, limit + 1])
      : await query<RawRow>(`SELECT ${ROW} FROM bops.chat_messages WHERE user_id = $1 AND chat_id = $2 AND json IS NOT NULL AND at < $3 ORDER BY at DESC, seq DESC LIMIT $4`, [
          userId,
          chatId,
          beforeAt,
          limit + 1,
        ]);
  return { rows: r.rows.slice(0, limit).map(rowOf).reverse(), more: r.rows.length > limit };
}

/**
 * What a bot reads of a chat (lib/server/chat.ts history): its messages, without the system lines that
 * aren't an email, a text or an app's answer. The newest `limit` of them, oldest first, and how many
 * the chat has in all (where the bot's window of them starts depends on it).
 */
export async function chatSaid(userId: string, chatId: string, limit: number): Promise<{ rows: MessageRow[]; total: number }> {
  const r = await query<RawRow & { total: string }>(
    `SELECT ${ROW}, count(*) OVER () AS total FROM bops.chat_messages
     WHERE user_id = $1 AND chat_id = $2 AND json IS NOT NULL
       AND (json->>'role' IS DISTINCT FROM 'system' OR jsonb_typeof(json->'email') = 'object' OR jsonb_typeof(json->'sms') = 'object' OR jsonb_typeof(json->'appResult') = 'object')
     ORDER BY at DESC, seq DESC LIMIT $3`,
    [userId, chatId, limit],
  );
  return { rows: r.rows.map(rowOf).reverse(), total: Number(r.rows[0]?.total ?? 0) };
}

/** The user's live messages with these ids. */
export async function messagesById(userId: string, ids: string[]): Promise<MessageRow[]> {
  if (!ids.length) return [];
  const r = await query<RawRow>(`SELECT ${ROW} FROM bops.chat_messages WHERE user_id = $1 AND id = ANY($2::text[]) AND json IS NOT NULL`, [userId, ids]);
  return r.rows.map(rowOf);
}

/**
 * The highest seq of the user's removals swept for good (sweepRemovedMessages; 0: none yet). A reader
 * whose cursor is below it may have missed a removal: it starts over (cloud/agent.ts `reset`).
 */
export async function sweptSeq(userId: string): Promise<number> {
  const r = await query<{ seq: string }>("SELECT swept_seq AS seq FROM bops.app_state WHERE user_id = $1", [userId]);
  return Number(r.rows[0]?.seq ?? 0);
}

/** The live message that answers `messageId` (its `answers`: the main bot's answer to a phone message, cloud/agent.ts), the newest if several; null when none. */
export async function answerTo(userId: string, messageId: string): Promise<MessageRow | null> {
  const r = await query<RawRow>(
    // `json ? 'answers'` is the index's own condition (chat_messages_answers, 0013), so the index serves it.
    `SELECT ${ROW} FROM bops.chat_messages WHERE user_id = $1 AND json ? 'answers' AND json->>'answers' = $2 ORDER BY seq DESC LIMIT 1`,
    [userId, messageId],
  );
  return r.rows[0] ? rowOf(r.rows[0]) : null;
}

/* ---------------- Routes ---------------- */

const get: Route = {
  method: "GET",
  path: "/v1/state",
  auth: "user",
  handle: async (req, res, { user }) => {
    const v2 = newBuild(req);
    checkUser(req, user!, v2);
    const row = await readRow(user!.id);
    if (!row || row.empty) throw new HttpError(404, "No state saved yet", v2 ? { version: row?.version ?? 0, seq: await lastSeq(user!.id) } : undefined);
    if (v2) {
      const body: CloudState = { version: row.version, seq: await lastSeq(user!.id), protocol: row.protocol, writer: row.writer, state: row.state };
      return sendZipped(req, res, 200, body);
    }
    // A build from before: the whole state, its messages back in.
    const body: CloudStateBody = { version: row.version, state: { ...row.state, messages: await liveMessages(user!.id) } };
    await sendZipped(req, res, 200, body);
  },
};

const getHead: Route = {
  method: "GET",
  path: "/v1/state/head",
  auth: "user",
  handle: async (req, res, { user }) => {
    checkUser(req, user!, true);
    sendJson(res, 200, await head(user!.id));
  },
};

/** A newer build's write: the blob, over `base`. */
async function putOver(req: IncomingMessage, res: ServerResponse, user: CloudUser, base: unknown, state: Record<string, unknown>) {
  checkUser(req, user, true);
  if (!wholeNumber(base)) throw new HttpError(400, "base must be a whole number, 0 or more");
  const json = toJson(blobOf(state));
  const writer = deviceOf(req);
  const version = await tx(async (c) => {
    const row = await lockUser(c, user.id);
    if (row.version !== base) return null;
    const r = await c.query<{ version: string }>(
      `UPDATE bops.app_state SET state = $2::jsonb, version = version + 1, protocol = $3, writer = $4, updated_at = now() WHERE user_id = $1 RETURNING version`,
      [user.id, json, STATE_PROTOCOL, writer],
    );
    return Number(r.rows[0].version);
  });
  if (version === null) {
    const now = await readRow(user.id);
    const body: CloudStateConflict = { error: "Your Bops changed on another Mac", code: STATE_CONFLICT, version: now?.version ?? 0, state: now?.state ?? {} };
    return sendZipped(req, res, 409, body);
  }
  sendJson(res, 200, { version });
  announce(user.id);
  // A paid plan that waited to know the main bot is set up now (plans.ts).
  afterStateUpload(user.id);
  forgetTelemetryChoice(user.id);
}

/** A build from before: its whole state, messages and all, the Mac's own `version` kept as given. */
async function putBackup(req: IncomingMessage, res: ServerResponse, user: CloudUser, version: unknown, state: Record<string, unknown>) {
  checkUser(req, user, false);
  if (!wholeNumber(version)) throw new HttpError(400, "version must be a whole number, 0 or more");
  const list = Array.isArray(state.messages) ? state.messages.filter((m) => isObject(m) && typeof m.id === "string" && m.id).map(messageOf) : [];
  await tx(async (c) => {
    const row = await lockUser(c, user.id);
    if (row.protocol >= STATE_PROTOCOL) throw new HttpError(426, "Update Bops to keep your chats in sync");
    await c.query(`UPDATE bops.app_state SET state = $2::jsonb, version = $3, writer = NULL, updated_at = now() WHERE user_id = $1`, [user.id, toJson(blobOf(state)), version]);
    // The upload is the whole state: its messages are all there are.
    await upsertMessages(c, user.id, list);
    await c.query(
      `UPDATE bops.chat_messages SET json = NULL, seq = nextval('bops.chat_seq'), updated_at = now()
       WHERE user_id = $1 AND json IS NOT NULL AND NOT (id = ANY($2::text[]))`,
      [user.id, list.map((m) => m.id)],
    );
  });
  sendJson(res, 200, { ok: true, version });
  announce(user.id);
  afterStateUpload(user.id);
  forgetTelemetryChoice(user.id);
}

const put: Route = {
  method: "PUT",
  path: "/v1/state",
  auth: "user",
  handle: async (req, res, { user }) => {
    const body = jsonOf<Record<string, unknown> | null>(await bodyOf(req));
    const state = body?.state;
    if (!isObject(state)) throw new HttpError(400, "state must be the app's state, an object");
    if (body && "base" in body) return putOver(req, res, user!, body.base, state);
    return putBackup(req, res, user!, body?.version, state);
  },
};

const getMessages: Route = {
  method: "GET",
  path: "/v1/messages",
  auth: "user",
  handle: async (req, res, { user, url }) => {
    checkUser(req, user!, true);
    const after = Number(url.searchParams.get("after") ?? 0);
    const limit = Number(url.searchParams.get("limit") ?? PAGE);
    if (!wholeNumber(after)) throw new HttpError(400, "after must be a whole number, 0 or more");
    if (!Number.isSafeInteger(limit) || limit < 1 || limit > MAX_PAGE) throw new HttpError(400, `limit must be 1 to ${MAX_PAGE}`);
    const r = await query<{ id: string; seq: string; json: Record<string, unknown> | null }>(
      "SELECT id, seq, json FROM bops.chat_messages WHERE user_id = $1 AND seq > $2 ORDER BY seq LIMIT $3",
      [user!.id, after, limit + 1],
    );
    const more = r.rows.length > limit;
    const rows = r.rows.slice(0, limit);
    // From the start, what was removed is of no use; from a seq on, it's how a Mac hears a message went.
    const messages: CloudMessageRow[] = rows.filter((x) => after > 0 || x.json !== null).map((x) => ({ id: x.id, seq: Number(x.seq), json: x.json }));
    const body: CloudMessagesPage = { messages, seq: rows.length ? Number(rows[rows.length - 1].seq) : after, more };
    await sendZipped(req, res, 200, body);
  },
};

const postMessages: Route = {
  method: "POST",
  path: "/v1/messages",
  auth: "user",
  handle: async (req, res, { user }) => {
    checkUser(req, user!, true);
    const body = jsonOf<Record<string, unknown> | null>(await bodyOf(req));
    const upsert = body?.upsert ?? [];
    const remove = body?.remove ?? [];
    if (!Array.isArray(upsert) || !Array.isArray(remove) || !remove.every((x) => typeof x === "string")) throw new HttpError(400, "Send { upsert: [messages], remove: [ids] }");
    const msgs = upsert.map(messageOf);
    const seq = await tx(async (c) => {
      await lockUser(c, user!.id);
      await upsertMessages(c, user!.id, msgs);
      await removeMessages(c, user!.id, remove as string[]);
      return lastSeq(user!.id, c);
    });
    sendJson(res, 200, { seq });
    if (msgs.length || remove.length) announce(user!.id);
  },
};

/** A copy of the whole state, messages and all, before the user starts over (Settings). */
const postBackup: Route = {
  method: "POST",
  path: "/v1/state/backups",
  auth: "user",
  handle: async (req, res, { user }) => {
    checkUser(req, user!, true);
    const r = await query<{ id: string }>(
      `INSERT INTO bops.app_state_backups (user_id, state)
       SELECT s.user_id, s.state || jsonb_build_object('messages', COALESCE(
         (SELECT jsonb_agg(m.json ORDER BY m.at, m.seq) FROM bops.chat_messages m WHERE m.user_id = s.user_id AND m.json IS NOT NULL), '[]'::jsonb))
       FROM bops.app_state s WHERE s.user_id = $1 AND s.state <> '{}'::jsonb
       RETURNING id`,
      [user!.id],
    );
    if (!r.rows[0]) throw new HttpError(404, "No state saved yet");
    sendJson(res, 200, { ok: true, id: Number(r.rows[0].id) });
  },
};

export const routes: Route[] = [get, getHead, put, getMessages, postMessages, postBackup];

/* ---------------- Sweeps ---------------- */

/**
 * Rows of messages removed more than `days` ago go for good. In the same statement, each user's highest
 * seq swept goes into app_state.swept_seq, so a reader with an older cursor knows it can't hear of every
 * removal any more (sweptSeq). A Mac knows by time instead (lib/server/persist-cloud.ts reads everything
 * again after 25 days away). Returns how many rows went.
 */
export async function sweepRemovedMessages(days = REMOVED_KEEP_DAYS): Promise<number> {
  const r = await query<{ n: string }>(
    `WITH gone AS (
       DELETE FROM bops.chat_messages WHERE json IS NULL AND updated_at < now() - make_interval(days => $1) RETURNING user_id, seq
     ), marked AS (
       UPDATE bops.app_state s SET swept_seq = g.seq
       FROM (SELECT user_id, max(seq) AS seq FROM gone GROUP BY user_id) g
       WHERE s.user_id = g.user_id AND s.swept_seq < g.seq
     )
     SELECT count(*) AS n FROM gone`,
    [days],
  );
  return Number(r.rows[0]?.n ?? 0);
}

/** Sweep removed messages every hour; returns the stop. */
export function startStateSweeps(): () => void {
  const t = setInterval(() => void sweepRemovedMessages().catch((e: Error) => console.warn(`[state] sweep: ${e.message}`)), SWEEP_MS);
  t.unref?.();
  return () => clearInterval(t);
}
