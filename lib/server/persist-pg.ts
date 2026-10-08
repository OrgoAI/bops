import "server-only";
import { Pool } from "pg";
import type { AppState } from "@/lib/types";
import type { Persistence, StateAccess } from "./persist";

/**
 * Hosted Bops keeps each user's state in Postgres: one row per Orgo user in bops.app_state (see
 * db/), the whole AppState as JSONB. A server process holds one user's state in memory at a time,
 * the same as the desktop app: pinned with BOPS_ORGO_USER_ID, or whoever signs in.
 *
 * - The user's row is loaded into memory before the first request (instrumentation.ts) when the
 *   server is pinned, and otherwise at sign-in, before signIn() returns (switchTo). A sign-out
 *   saves the user's state and clears it from memory, so the next person to sign in never sees it.
 * - Changes are written behind, at most every SAVE_MS, guarded by the row's version: a write only
 *   lands on the version it was loaded at. If another server wrote the row in between, nothing is
 *   overwritten: this server takes the newer row and drops its own unsaved changes (logged).
 * - If the database is down, the state in memory keeps serving and the save is retried with
 *   backoff. Nothing is written for a user whose row hasn't been read yet, so a server that
 *   started while the database was down can't overwrite the saved state with a fresh one.
 */

/** Slower than the file's quarter second: every save rewrites the user's whole row. */
const SAVE_MS = 2000;
const MAX_RETRY_MS = 30_000;
/** How long hydrate() waits for the database before letting the server start without it. */
const HYDRATE_MS = 15_000;

type Row = { state: Record<string, unknown>; version: number };

/** Postgres can't keep NUL in JSONB text; screen text and pasted mail sometimes have one. */
const toJson = (state: unknown) => JSON.stringify(state, (_k, v) => (typeof v === "string" && v.includes("\0") ? v.replaceAll("\0", "") : v));

/** The queries, apart from the timing, so a test can drive them against a throwaway database. */
export class StateTable {
  /** Shared with OwnerPhoneTable and OwnerEmailTable: one connection per server (db/README.md). */
  readonly db: Pool;
  constructor(db: Pool) {
    this.db = db;
  }

  async read(userId: string): Promise<Row | null> {
    const r = await this.db.query<{ state: Record<string, unknown>; version: string }>("SELECT state, version FROM bops.app_state WHERE user_id = $1", [userId]);
    return r.rows[0] ? { state: r.rows[0].state, version: Number(r.rows[0].version) } : null;
  }

  /** A new user's first row; null if one was made in the meantime. */
  async create(userId: string, state: AppState): Promise<number | null> {
    const r = await this.db.query<{ version: string }>(
      "INSERT INTO bops.app_state (user_id, state) VALUES ($1, $2::jsonb) ON CONFLICT (user_id) DO NOTHING RETURNING version",
      [userId, toJson(state)],
    );
    return r.rows[0] ? Number(r.rows[0].version) : null;
  }

  /** Save over the version this server last saw; the new version, or null if someone else wrote first. */
  async write(userId: string, state: AppState, version: number): Promise<number | null> {
    const r = await this.db.query<{ version: string }>(
      "UPDATE bops.app_state SET state = $2::jsonb, version = version + 1, updated_at = now() WHERE user_id = $1 AND version = $3 RETURNING version",
      [userId, toJson(state), version],
    );
    return r.rows[0] ? Number(r.rows[0].version) : null;
  }

  async backup(userId: string, state: AppState) {
    await this.db.query("INSERT INTO bops.app_state_backups (user_id, state) VALUES ($1, $2::jsonb)", [userId, toJson(state)]);
  }
}

export type ClaimResult = { ok: true } | { ok: false; why: "taken" };

/**
 * The user's verified mobile numbers as rows (bops.owner_phones, db/migrations/0002_owner_phones.sql),
 * beside the copy in their state. A partial unique index lets one verified number belong to one user
 * only: that is what lets a hosted server route an inbound text to the right user, and what stops a
 * second account from claiming someone else's number.
 */
export class OwnerPhoneTable {
  private readonly db: Pool;
  constructor(db: Pool) {
    this.db = db;
  }

  /** Whether another user already verified this number. */
  async takenByOther(userId: string, e164: string): Promise<boolean> {
    const r = await this.db.query("SELECT 1 FROM bops.owner_phones WHERE phone_e164 = $1 AND verified_at IS NOT NULL AND orgo_user_id <> $2 LIMIT 1", [e164, userId]);
    return r.rowCount! > 0;
  }

  /** Record the number as this user's, verified now; refused when another user verified it first (the unique index decides a race). */
  async claim(userId: string, e164: string, consentAt: number, ref: string): Promise<ClaimResult> {
    if (await this.takenByOther(userId, e164)) return { ok: false, why: "taken" };
    try {
      await this.db.query(
        `INSERT INTO bops.owner_phones (orgo_user_id, phone_e164, consent_at, verified_at, verification_ref)
         VALUES ($1, $2, to_timestamp($3::double precision / 1000), now(), $4)
         ON CONFLICT (orgo_user_id, phone_e164) DO UPDATE
           SET consent_at = EXCLUDED.consent_at, verified_at = now(), verification_ref = EXCLUDED.verification_ref, updated_at = now()`,
        [userId, e164, consentAt, ref],
      );
      return { ok: true };
    } catch (e) {
      if ((e as { code?: string }).code === "23505") return { ok: false, why: "taken" };
      throw e;
    }
  }

  async release(userId: string, e164: string) {
    await this.db.query("DELETE FROM bops.owner_phones WHERE orgo_user_id = $1 AND phone_e164 = $2", [userId, e164]);
  }

  async releaseAll(userId: string) {
    await this.db.query("DELETE FROM bops.owner_phones WHERE orgo_user_id = $1", [userId]);
  }

  /** Whose verified number this is (for routing an inbound text on a hosted server). */
  async ownerOf(e164: string): Promise<string | null> {
    const r = await this.db.query<{ orgo_user_id: string }>("SELECT orgo_user_id FROM bops.owner_phones WHERE phone_e164 = $1 AND verified_at IS NOT NULL", [e164]);
    return r.rows[0]?.orgo_user_id ?? null;
  }
}

/** The owner_phones table on this server's connection, once the Postgres store is up; null in file mode. */
export function ownerPhoneTable(): OwnerPhoneTable | null {
  const box = (globalThis as unknown as { __bopsPg?: PgBox }).__bopsPg;
  return box ? (box.phones ??= new OwnerPhoneTable(box.table.db)) : null;
}

/**
 * The user's email addresses verified by an emailed code, as rows (bops.owner_emails,
 * db/migrations/0003_owner_emails.sql), beside the copy in their state (state.ownerEmails). Unlike a
 * number, an address may belong to more than one user: an email reaches a user through the bot's
 * inbox it was sent to, never by who sent it, so nothing here is unique across users. Not used yet:
 * adding an address is refused on a hosted server until its requests prove which user sent them.
 */
export class OwnerEmailTable {
  private readonly db: Pool;
  constructor(db: Pool) {
    this.db = db;
  }

  /** Record the address as this user's, verified now (again, if it already was). */
  async claim(userId: string, email: string, ref: string) {
    await this.db.query(
      `INSERT INTO bops.owner_emails (orgo_user_id, email, verified_at, verification_ref)
       VALUES ($1, $2, now(), $3)
       ON CONFLICT (orgo_user_id, email) DO UPDATE
         SET verified_at = now(), verification_ref = EXCLUDED.verification_ref, updated_at = now()`,
      [userId, email.toLowerCase(), ref],
    );
  }

  async release(userId: string, email: string) {
    await this.db.query("DELETE FROM bops.owner_emails WHERE orgo_user_id = $1 AND email = $2", [userId, email.toLowerCase()]);
  }
}

/** The owner_emails table on this server's connection, once the Postgres store is up; null in file mode. */
export function ownerEmailTable(): OwnerEmailTable | null {
  const box = (globalThis as unknown as { __bopsPg?: PgBox }).__bopsPg;
  return box ? (box.emails ??= new OwnerEmailTable(box.table.db)) : null;
}

type PgBox = {
  phones?: OwnerPhoneTable;
  emails?: OwnerEmailTable;
  table: StateTable;
  /** Whose state is in memory, once their row has been read (or made). */
  user?: string;
  version?: number;
  timer?: ReturnType<typeof setTimeout>;
  writing?: Promise<void>;
  again?: boolean;
  failures: number;
  hooked?: boolean;
};

export function pgStore({ get, replace }: StateAccess): Persistence {
  const g = globalThis as unknown as { __bopsPg?: PgBox };
  // One pool per process, kept across dev reloads. Small: each server holds one user's state.
  const box = (g.__bopsPg ??= {
    // One user per process and one query at a time (saves, sign-ins and backups are serialized), so
    // one connection. db/provision.sql sizes the role's connection limit on that.
    table: new StateTable(new Pool({ connectionString: process.env.BOPS_DATABASE_URL, max: 1, connectionTimeoutMillis: 5000, idleTimeoutMillis: 30_000 })),
    failures: 0,
  });
  const pinned = process.env.BOPS_ORGO_USER_ID || undefined;

  /** Take this user's saved state into memory, or (no row yet) save what's in memory, or a fresh start, as theirs. */
  async function bind(userId: string, opts: { fresh: boolean }) {
    const row = await box.table.read(userId);
    if (row) {
      replace(row.state);
      box.user = userId;
      box.version = row.version;
      console.info(`[store] loaded ${userId} (v${row.version})`);
      return;
    }
    if (opts.fresh) replace(null);
    const version = await box.table.create(userId, get());
    if (version === null) return bind(userId, opts); // made by another server just now: take theirs
    box.user = userId;
    box.version = version;
    console.info(`[store] new state for ${userId}`);
  }

  async function write(state: AppState = get()) {
    const version = await box.table.write(box.user!, state, box.version!);
    if (version !== null) {
      box.version = version;
      return;
    }
    // Someone else saved this user's state since we read it: theirs stands, ours since our last save is dropped.
    const row = await box.table.read(box.user!);
    if (!row) throw new Error(`state row for ${box.user} is gone`);
    console.warn(`[store] ${box.user}'s state was saved elsewhere (v${box.version} -> v${row.version}): loading that and dropping this server's unsaved changes`);
    replace(row.state);
    box.version = row.version;
  }

  async function save() {
    const state = get();
    if (!box.user) {
      // A pinned server whose row couldn't be read at start: keep trying. Otherwise nobody's signed
      // in, and what's in memory is nobody's to keep.
      if (pinned) await bind(pinned, { fresh: false });
      return;
    }
    // switchTo() binds every sign-in before it lands, so this can't happen; if it somehow does,
    // writing would put one user's account in another's row.
    const signedIn = state.account?.user.id;
    if (signedIn && signedIn !== box.user) throw new Error(`state in memory is signed in as ${signedIn}, not ${box.user}; not saving it`);
    await write(state);
  }

  /** Run fn with no save in flight and none starting until it's done; a save that was due runs after. */
  async function exclusive<T>(fn: () => Promise<T>): Promise<T> {
    if (box.timer) {
      clearTimeout(box.timer);
      box.timer = undefined;
      box.again = true;
    }
    while (box.writing) await box.writing;
    const run = fn();
    box.writing = run.then(
      () => {},
      () => {},
    );
    try {
      return await run;
    } finally {
      box.writing = undefined;
      if (box.again) {
        box.again = false;
        persist(box.failures ? retryDelay() : SAVE_MS);
      }
    }
  }

  /**
   * Someone signed in: before their key or account lands, save whoever's state is in memory and
   * load theirs. Throws (and the sign-in should fail) if the database can't do either, so nobody
   * ever works on, or saves into, another user's state.
   */
  async function switchTo(userId: string) {
    if (pinned && userId !== pinned) throw new Error(`this server is for Orgo user ${pinned}`);
    await exclusive(async () => {
      if (box.user === userId) return;
      if (box.user) {
        await write({ ...get(), account: undefined });
        // Unbound before the load: if it fails, nothing more is saved as the previous user.
        box.user = box.version = undefined;
        replace(null);
      }
      // Nobody's state was bound. On a pinned server that's its own user's row not read yet: keep what's
      // in memory if they're new. Otherwise what's in memory is nobody's (left over from a sign-out, or
      // work that finished after it): a new user starts fresh, never with someone else's leftovers.
      await bind(userId, { fresh: !pinned });
    });
  }

  /**
   * Signing out: save the user's state (signed out), then clear it from memory, unless the server is
   * pinned to them (only they can sign in to it again). Throws if the save fails.
   */
  async function leave() {
    await exclusive(async () => {
      if (!box.user) {
        // Nothing bound, so nothing to save; what's in memory still goes, so the next person never sees it.
        if (!pinned) replace(null);
        return;
      }
      await write({ ...get(), account: undefined });
      if (pinned) return;
      box.user = box.version = undefined;
      replace(null);
      box.again = false; // nothing of anyone's left to save
    });
  }

  function retryDelay() {
    return Math.min(MAX_RETRY_MS, 1000 * 2 ** Math.min(box.failures - 1, 5));
  }

  function persist(delay = SAVE_MS) {
    if (box.timer) return;
    box.timer = setTimeout(() => {
      box.timer = undefined;
      if (box.writing) {
        box.again = true;
        return;
      }
      box.writing = save()
        .then(() => {
          if (box.failures) console.info(`[store] saving again after ${box.failures} failed ${box.failures === 1 ? "try" : "tries"}`);
          box.failures = 0;
        })
        .catch((e: Error) => {
          box.failures++;
          // Keep serving from memory; say so on the first failure and then now and then, not every retry.
          if (box.failures === 1 || box.failures % 10 === 0) console.error(`[store] save failed (${box.failures}x, retrying in ${retryDelay() / 1000}s): ${e.message}`);
          box.again = true;
        })
        .finally(() => {
          box.writing = undefined;
          if (box.again) {
            box.again = false;
            persist(box.failures ? retryDelay() : SAVE_MS);
          }
        });
    }, delay);
  }

  /** On the way out: one last save, bounded so a dead database can't hold up the exit. */
  async function flush() {
    if (box.timer) clearTimeout(box.timer);
    box.timer = undefined;
    const last = (async () => {
      await box.writing;
      await save();
    })();
    await Promise.race([last.catch((e: Error) => console.error(`[store] last save failed: ${e.message}`)), new Promise((r) => setTimeout(r, 5000))]);
  }

  if (!box.hooked) {
    box.hooked = true;
    let leaving = false;
    process.on("beforeExit", () => {
      if (leaving) return;
      leaving = true;
      void flush();
    });
    // Next exits on SIGINT/SIGTERM itself, as soon as open requests finish, without waiting for this
    // save. NEXT_MANUAL_SIG_HANDLE=true (set before `next start`; db/README.md) leaves the exit to us.
    if (!process.env.NEXT_MANUAL_SIG_HANDLE)
      console.warn("[store] NEXT_MANUAL_SIG_HANDLE isn't set: the last save on shutdown can be cut off (db/README.md)");
    for (const sig of ["SIGINT", "SIGTERM"] as const)
      process.once(sig, () => {
        leaving = true;
        void flush().finally(() => process.exit(0));
      });
  }

  return {
    // The row is read in hydrate(): module init can't wait on the database.
    initial: () => null,
    // A hosted server serves whatever is in memory (a pinned server's user before their row is read).
    ready: () => true,
    user: () => box.user ?? null,
    async flush(ms) {
      if (box.timer) clearTimeout(box.timer);
      box.timer = undefined;
      const done = (async () => {
        while (box.writing) await box.writing;
        await save();
        return true;
      })().catch(() => false);
      return Promise.race([done, new Promise<boolean>((r) => setTimeout(() => r(false), ms))]);
    },
    unsent: () => !!box.timer || !!box.writing || box.failures > 0,
    pull: async () => {},
    changed: () => persist(box.failures ? retryDelay() : SAVE_MS),
    signIn: switchTo,
    signOut: leave,
    async backup() {
      if (!box.user) return;
      const user = box.user;
      await box.table.backup(user, get()).catch((e: Error) => console.error(`[store] backup for ${user} failed: ${e.message}`));
    },
    async hydrate() {
      const who = pinned;
      if (!who || box.user) return; // otherwise the state is bound at sign-in (switchTo)
      const until = Date.now() + HYDRATE_MS;
      for (let attempt = 1; ; attempt++) {
        try {
          await bind(who, { fresh: false });
          return;
        } catch (e) {
          if (Date.now() >= until) {
            // Start anyway, from memory, without writing: the save retries the load until the database answers.
            console.error(`[store] couldn't load ${who}'s state (${(e as Error).message}); serving without saving until the database answers`);
            box.failures = 1;
            persist(retryDelay());
            return;
          }
          await new Promise((r) => setTimeout(r, Math.min(1000 * attempt, 5000)));
        }
      }
    },
  };
}
