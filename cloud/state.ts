import type { IncomingMessage } from "node:http";
import { promisify } from "node:util";
import { gunzip, gzip } from "node:zlib";
import { query } from "./db.ts";
import { HttpError, readBody, sendJson, type Route } from "./http.ts";
import type { CloudStateBody } from "./protocol.ts";

/**
 * GET/PUT /v1/state: the Mac's state (the app's whole AppState, lib/types.ts) kept in bops.app_state
 * as a backup, and read by the cloud to answer calls while the Mac is away. Owner: edge builder.
 *
 * The Mac is the source of truth: each upload replaces the one before (the Mac sends them one at a
 * time). `version` is the Mac's own number for what it sent, kept as given and handed back by GET.
 */

/** A state upload, as sent and once unzipped. */
const MAX_STATE = 20 * 1024 * 1024;
const unzip = promisify(gunzip);
const zip = promisify(gzip);

/** JSON for a JSONB column. Postgres can't keep NUL in JSONB text (screen text and pasted mail sometimes have one), so it's dropped, as lib/server/persist-pg.ts does. */
export const toJson = (value: unknown) => JSON.stringify(value, (_key, v) => (typeof v === "string" && v.includes("\0") ? v.replaceAll("\0", "") : v));

/** The user's last uploaded state, or null. The empty row other tables need before the first upload (db.ts ensureUserRow) doesn't count. */
export async function loadState(userId: string): Promise<{ version: number; state: unknown } | null> {
  const r = await query<{ state: unknown; version: string }>("SELECT state, version FROM bops.app_state WHERE user_id = $1 AND state <> '{}'::jsonb", [userId]);
  const row = r.rows[0];
  return row ? { version: Number(row.version), state: row.state } : null;
}

async function saveState(userId: string, body: CloudStateBody) {
  await query(
    `INSERT INTO bops.app_state (user_id, state, version) VALUES ($1, $2::jsonb, $3)
     ON CONFLICT (user_id) DO UPDATE SET state = EXCLUDED.state, version = EXCLUDED.version, updated_at = now()`,
    [userId, toJson(body.state), body.version],
  );
}

/** The request body, unzipped when the Mac gzipped it. Past 20 MB, sent or unzipped, it's refused (413). */
async function bodyOf(req: IncomingMessage): Promise<Buffer> {
  const raw = await readBody(req, MAX_STATE);
  const encoding = (req.headers["content-encoding"] ?? "identity").trim().toLowerCase();
  if (encoding === "identity") return raw;
  if (encoding !== "gzip") throw new HttpError(415, "Send the state as plain JSON or gzipped");
  try {
    return await unzip(raw, { maxOutputLength: MAX_STATE });
  } catch (e) {
    if ((e as { code?: string }).code === "ERR_BUFFER_TOO_LARGE") throw new HttpError(413, "Request too large");
    throw new HttpError(400, "Body isn't valid gzip");
  }
}

function parseUpload(data: Buffer): CloudStateBody {
  let body: Partial<CloudStateBody> | null;
  try {
    body = JSON.parse(data.toString("utf8")) as Partial<CloudStateBody> | null;
  } catch {
    throw new HttpError(400, "Body isn't JSON");
  }
  const { version, state } = body ?? {};
  if (typeof version !== "number" || !Number.isSafeInteger(version) || version < 0) throw new HttpError(400, "version must be a whole number, 0 or more");
  if (!state || typeof state !== "object" || Array.isArray(state)) throw new HttpError(400, "state must be the app's state, an object");
  return { version, state };
}

const get: Route = {
  method: "GET",
  path: "/v1/state",
  auth: "user",
  handle: async (req, res, { user }) => {
    const saved = await loadState(user!.id);
    if (!saved) throw new HttpError(404, "No state saved yet");
    // A whole state runs to megabytes of JSON; gzipped it's a tenth of that.
    const json = Buffer.from(JSON.stringify(saved));
    const gzipped = /\bgzip\b/i.test(req.headers["accept-encoding"] ?? "");
    const data = gzipped ? await zip(json) : json;
    res.writeHead(200, {
      "content-type": "application/json",
      "content-length": String(data.length),
      "cache-control": "no-store",
      vary: "accept-encoding",
      ...(gzipped ? { "content-encoding": "gzip" } : {}),
    });
    res.end(data);
  },
};

const put: Route = {
  method: "PUT",
  path: "/v1/state",
  auth: "user",
  handle: async (req, res, { user }) => {
    const body = parseUpload(await bodyOf(req));
    await saveState(user!.id, body);
    sendJson(res, 200, { ok: true, version: body.version });
  },
};

export const routes: Route[] = [get, put];
