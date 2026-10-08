import { readdir, readFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import pg from "pg";
import { config } from "./config.ts";

/**
 * Postgres for Bops Cloud: the `bops` schema in orgo-web's database, as the `bops_app` role, which
 * can reach that schema only (db/README.md). One small pool for the whole process.
 */

let pool: pg.Pool | null = null;

export function db(): pg.Pool {
  if (pool) return pool;
  const url = config.databaseUrl();
  if (!url) throw new Error("BOPS_DATABASE_URL isn't set");
  pool = new pg.Pool({ connectionString: url, max: 10, idleTimeoutMillis: 30_000, connectionTimeoutMillis: 10_000, application_name: "bops-cloud" });
  pool.on("error", (e) => console.error(`[db] idle client: ${e.message}`));
  return pool;
}

export async function query<T extends pg.QueryResultRow = pg.QueryResultRow>(text: string, values: unknown[] = []): Promise<pg.QueryResult<T>> {
  return db().query<T>(text, values);
}

/** Run `work` in one transaction (BEGIN … COMMIT, ROLLBACK on a throw). */
export async function tx<T>(work: (c: pg.PoolClient) => Promise<T>): Promise<T> {
  const c = await db().connect();
  try {
    await c.query("BEGIN");
    const out = await work(c);
    await c.query("COMMIT");
    return out;
  } catch (e) {
    await c.query("ROLLBACK").catch(() => {});
    throw e;
  } finally {
    c.release();
  }
}

/** Any fixed number: the advisory lock that lets one process at a time apply migrations. */
const MIGRATION_LOCK = 4_270_311;

/**
 * Apply db/migrations/*.sql in order. Each file is safe to run again and records itself in
 * bops.schema_migrations. Two processes starting at once take turns (an advisory lock), since two
 * CREATE TABLE IF NOT EXISTS racing each other can still fail.
 */
export async function migrate(): Promise<string[]> {
  const dir = join(dirname(fileURLToPath(import.meta.url)), "..", "db", "migrations");
  const files = (await readdir(dir)).filter((f) => /^\d{4}_.+\.sql$/.test(f)).sort();
  const c = await db().connect();
  try {
    await c.query("SELECT pg_advisory_lock($1)", [MIGRATION_LOCK]);
    const done = new Set<string>();
    try {
      const r = await c.query<{ version: string }>("SELECT version FROM bops.schema_migrations");
      for (const row of r.rows) done.add(row.version);
    } catch {
      // No table yet: the first migration makes it.
    }
    const ran: string[] = [];
    for (const f of files) {
      const version = f.replace(/\.sql$/, "");
      if (done.has(version)) continue;
      await c.query(await readFile(join(dir, f), "utf8"));
      ran.push(version);
    }
    return ran;
  } finally {
    await c.query("SELECT pg_advisory_unlock($1)", [MIGRATION_LOCK]).catch(() => {});
    c.release();
  }
}

/**
 * Ownership of provider objects (an OpenAI response or live session, a Composio connection): the
 * cloud records who made or was handed each id, so one user can't reach another's through a proxy.
 * An Agents API session keeps its model and its bot too, so its turns are priced at that model and
 * counted for that bot (usage.ts), and when it last got work, so the cloud reads its turns back
 * (reconcile.ts).
 */
export async function ownObject(userId: string, provider: string, kind: string, objectId: string, model?: string, botId?: string) {
  await query(
    `INSERT INTO bops.cloud_objects (object_id, provider, kind, user_id, model, bot_id, used_at)
     VALUES ($1, $2, $3, $4, $5, $6, CASE WHEN $3 = 'agent_session' THEN now() END)
     ON CONFLICT (provider, object_id) DO NOTHING`,
    [objectId, provider, kind, userId, model ?? null, botId ?? null],
  );
}

/** The model an object was made with (an Agents API session's, to price its turns), or null when the cloud doesn't know it. */
export async function objectModel(provider: string, objectId: string): Promise<string | null> {
  return (await objectInfo(provider, objectId)).model;
}

/** An object's model and bot, as kept when it was made (nulls when the cloud doesn't know). */
export async function objectInfo(provider: string, objectId: string): Promise<{ model: string | null; botId: string | null }> {
  const r = await query<{ model: string | null; bot_id: string | null }>("SELECT model, bot_id FROM bops.cloud_objects WHERE provider = $1 AND object_id = $2", [provider, objectId]);
  return { model: r.rows[0]?.model ?? null, botId: r.rows[0]?.bot_id ?? null };
}

/** An Agents API session got work (a message): the cloud reads its turns back again once that's done (reconcile.ts). */
export async function sessionUsed(sessionId: string) {
  await query("UPDATE bops.cloud_objects SET used_at = now() WHERE provider = 'openai' AND kind = 'agent_session' AND object_id = $1", [sessionId]);
}

/** Who owns an object, or null when the cloud never saw it. */
export async function objectOwner(provider: string, objectId: string): Promise<string | null> {
  const r = await query<{ user_id: string }>("SELECT user_id FROM bops.cloud_objects WHERE provider = $1 AND object_id = $2", [provider, objectId]);
  return r.rows[0]?.user_id ?? null;
}

/** Make sure the user has a state row (other tables point at it). The Mac's first state upload fills it in. */
export async function ensureUserRow(userId: string) {
  await query(`INSERT INTO bops.app_state (user_id, state, version) VALUES ($1, '{}'::jsonb, 0) ON CONFLICT (user_id) DO NOTHING`, [userId]);
}

/** For tests and shutdown. */
export async function closeDb() {
  const p = pool;
  pool = null;
  await p?.end();
}
