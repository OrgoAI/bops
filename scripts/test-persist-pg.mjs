// Exercise the Postgres state backend (lib/server/persist-pg.ts) against a throwaway database.
// It creates schema bops there (db/migrations/0001_init.sql) and drops it at the end.
// Never point it at a real database.
// Usage: BOPS_TEST_DATABASE_URL=postgres://localhost/bops_test node --conditions=react-server scripts/test-persist-pg.mjs
import { readFileSync } from "node:fs";
import assert from "node:assert/strict";
import pg from "pg";

const url = process.env.BOPS_TEST_DATABASE_URL;
if (!url) {
  console.log("BOPS_TEST_DATABASE_URL isn't set: nothing to test against (see db/README.md).");
  process.exit(0);
}
process.env.BOPS_DATABASE_URL = url;
process.env.BOPS_ORGO_USER_ID = "user_test_a";
const { pgStore, StateTable, OwnerPhoneTable, OwnerEmailTable } = await import("../lib/server/persist-pg.ts");

const admin = new pg.Pool({ connectionString: url, max: 1 });
await admin.query("DROP SCHEMA IF EXISTS bops CASCADE");
for (const m of ["0001_init.sql", "0002_owner_phones.sql", "0003_owner_emails.sql"]) await admin.query(readFileSync(new URL(`../db/migrations/${m}`, import.meta.url), "utf8"));
const table = new StateTable(admin);
const wait = (ms) => new Promise((r) => setTimeout(r, ms));

try {
  // The queries: make, read, write over the right version, refuse a stale one.
  assert.equal(await table.create("u1", { bots: [], note: "a\0b" }), 1);
  assert.equal(await table.create("u1", { bots: [] }), null, "a second create doesn't overwrite");
  assert.equal((await table.read("u1")).state.note, "ab", "NUL is dropped, not an error");
  assert.equal(await table.write("u1", { bots: [], n: 2 }, 1), 2);
  assert.equal(await table.write("u1", { bots: [], n: 3 }, 1), null, "a stale version is refused");
  assert.equal((await table.read("u1")).state.n, 2);

  // The backend: hydrate the pinned user, save behind, reload when another server saved first.
  let state = { bots: [], hello: "fresh" };
  const access = { get: () => state, replace: (raw) => (state = raw ?? { bots: [] }) };
  const store = pgStore(access);
  await store.hydrate();
  let row = await table.read("user_test_a");
  assert.equal(row?.state.hello, "fresh", "a new user's state is saved as theirs");

  state.hello = "changed";
  store.changed();
  await wait(2600);
  row = await table.read("user_test_a");
  assert.equal(row.state.hello, "changed", "changes are written behind");

  await table.write("user_test_a", { bots: [], hello: "from another server" }, row.version);
  state.hello = "lost";
  store.changed();
  await wait(2600);
  assert.equal(state.hello, "from another server", "the other server's save stands and is loaded");
  assert.equal((await table.read("user_test_a")).state.hello, "from another server");

  // A pinned server refuses anyone else's sign-in, and keeps its user's state across a sign-out.
  await assert.rejects(store.signIn("user_test_b"), /this server is for/);
  state.account = { user: { id: "user_test_a" }, signedInAt: 1 };
  await store.signIn("user_test_a");
  await store.signOut();
  assert.equal(state.hello, "from another server", "a pinned server keeps its user's state");
  assert.equal((await table.read("user_test_a")).state.account, undefined, "saved signed out");

  // An unpinned server: each sign-in loads that user's own state before it returns; a sign-out clears memory.
  delete process.env.BOPS_ORGO_USER_ID;
  delete globalThis.__bopsPg;
  state = { bots: [], hello: "nobody's" };
  const open = pgStore(access);
  await open.hydrate();
  await open.signIn("user_test_a");
  assert.equal(state.hello, "from another server", "A's saved state is loaded at sign-in");
  state.account = { user: { id: "user_test_a" }, signedInAt: 1 };
  state.hello = "A's latest";
  await open.signIn("user_test_b");
  assert.equal((await table.read("user_test_a")).state.hello, "A's latest", "A's unsaved changes are saved as A's");
  assert.equal(state.hello, undefined, "B starts fresh, with none of A's state");
  state.account = { user: { id: "user_test_b" }, signedInAt: 2 };
  state.hello = "B's";
  await open.signOut();
  assert.equal((await table.read("user_test_b")).state.hello, "B's");
  assert.equal(state.hello, undefined, "nothing of B's stays in memory");
  state.account = { user: { id: "user_test_a" }, signedInAt: 3 }; // as if the binding had been skipped
  await open.signIn("user_test_a");
  state.account = { user: { id: "user_test_b" }, signedInAt: 3 };
  open.changed();
  await wait(2600);
  assert.equal((await table.read("user_test_a")).state.account, undefined, "an account that isn't the row's user is never saved");
  state.account = { user: { id: "user_test_a" }, signedInAt: 3 };

  // A view over the usage ledger.
  await table.write("user_test_a", { bots: [], usage: [{ kind: "call.minutes", at: Date.now(), qty: 3 }] }, (await table.read("user_test_a")).version);
  const usage = await admin.query("SELECT kind, qty FROM bops.usage_events WHERE user_id = $1", ["user_test_a"]);
  assert.deepEqual(usage.rows, [{ kind: "call.minutes", qty: 3 }]);

  // Owner phones: one verified number belongs to one user.
  const phones = new OwnerPhoneTable(admin);
  for (const u of ["p1", "p2"]) await table.create(u, { bots: [] });
  const num = "+15551234567";
  assert.equal(await phones.takenByOther("p1", num), false);
  assert.deepEqual(await phones.claim("p1", num, Date.now(), "vrf_a"), { ok: true });
  assert.deepEqual(await phones.claim("p1", num, Date.now(), "vrf_b"), { ok: true }, "the same user verifying again is fine");
  assert.equal(await phones.takenByOther("p2", num), true);
  assert.equal(await phones.takenByOther("p1", num), false);
  assert.deepEqual(await phones.claim("p2", num, Date.now(), "vrf_c"), { ok: false, why: "taken" });
  // The unique index settles a race the pre-check missed.
  await assert.rejects(
    admin.query("INSERT INTO bops.owner_phones (orgo_user_id, phone_e164, consent_at, verified_at) VALUES ('p2', $1, now(), now())", [num]),
    (e) => e.code === "23505",
  );
  assert.equal(await phones.ownerOf(num), "p1");
  await phones.release("p1", num);
  assert.equal(await phones.ownerOf(num), null);
  assert.deepEqual(await phones.claim("p2", num, Date.now(), "vrf_d"), { ok: true }, "free again once released");
  await phones.releaseAll("p2");
  assert.equal(await phones.ownerOf(num), null);
  await assert.rejects(admin.query("INSERT INTO bops.owner_phones (orgo_user_id, phone_e164, consent_at) VALUES ('p1', '5551234567', now())"), (e) => e.code === "23514", "E.164 only");

  // Owner emails: a user's verified addresses. Unlike numbers, one address can belong to two users.
  const emails = new OwnerEmailTable(admin);
  const emailRows = async () => (await admin.query("SELECT orgo_user_id, email, verification_ref FROM bops.owner_emails ORDER BY orgo_user_id")).rows;
  await emails.claim("p1", "Shared@Example.com", "vrf_e1");
  await emails.claim("p2", "shared@example.com", "vrf_e2");
  await emails.claim("p1", "shared@example.com", "vrf_e3");
  assert.deepEqual(await emailRows(), [
    { orgo_user_id: "p1", email: "shared@example.com", verification_ref: "vrf_e3" },
    { orgo_user_id: "p2", email: "shared@example.com", verification_ref: "vrf_e2" },
  ], "lowercased, verified again in place, and shared across users");
  await emails.release("p1", "SHARED@example.com");
  assert.deepEqual((await emailRows()).map((r) => r.orgo_user_id), ["p2"]);
  for (const bad of ["Me@Example.com", "@example.com", "me"])
    await assert.rejects(admin.query("INSERT INTO bops.owner_emails (orgo_user_id, email, verified_at) VALUES ('p1', $1, now())", [bad]), (e) => e.code === "23514", bad);
  await assert.rejects(admin.query("INSERT INTO bops.owner_emails (orgo_user_id, email, verified_at) VALUES ('nobody', 'a@example.com', now())"), (e) => e.code === "23503", "only a user with a state row");
  await admin.query("DELETE FROM bops.app_state WHERE user_id = 'p2'");
  assert.deepEqual(await emailRows(), [], "a user's addresses go with their state");
  // Safe to run again.
  await admin.query(readFileSync(new URL("../db/migrations/0003_owner_emails.sql", import.meta.url), "utf8"));
  assert.equal((await admin.query("SELECT count(*)::int AS n FROM bops.schema_migrations WHERE version = '0003_owner_emails'")).rows[0].n, 1);

  console.log("persist-pg: all checks passed");
} finally {
  await admin.query("DROP SCHEMA IF EXISTS bops CASCADE");
  await admin.end();
}
process.exit(0);
