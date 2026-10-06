# Bops database (hosted Bops)

The desktop app keeps its state in `.data/state.json` and needs none of this. Hosted Bops keeps its
data in Postgres: Bops Cloud (`cloud/`, see cloud/README.md) for every user's cloud setup, webhooks,
pending texts and calls, plus each user's state backup (`bops.app_state`, one row per Orgo user, the
whole app state as JSONB).

At Orgo it lives in orgo-web's production database (`orgo`), in its own schema (`bops`), under its
own login (`bops_app`). That login owns its schema and has no grants on orgo-web's, so it can't read
or change orgo-web's tables; it shares the database's backups and its `max_connections`. A
self-hoster can put it in any database the same way.

One exception: AI credit. Each user's balance is in orgo-web's schema (`public.bops_ai_credit`, with
every grant in `public.bops_ai_credit_grants`), because orgo-web's Stripe webhook adds Pro's and Max's
monthly credit and Bops Cloud takes each use from it (`cloud/credit.ts`). orgo-web's migration
`20261022_bops_plans.sql` makes the two tables and their three functions and grants `bops_app`
SELECT, INSERT and UPDATE on those two tables (and the grants' id sequence), nothing else;
`provision.sql` grants the same again for a database set up the other way round. `bops_app` still
can't read `profiles` or anything else of orgo-web's. Bops Cloud uses them only with
`BOPS_AI_CREDITS=1`, and then refuses to start without them.

## Set it up (once per database)

1. Pick the password and keep it in the secrets file (below), then make the login and the schema as
   a superuser, connected to the database Bops goes in. An application role (orgo-web's `orgo_v2`
   included) can't create roles.

   ```bash
   psql "<superuser url to that database>" -v ON_ERROR_STOP=1 -v bops_app_password="$BOPS_APP_PASSWORD" -f db/provision.sql
   ```

   It ends by listing the SECURITY DEFINER functions anyone may run (they run as their owner, so
   `bops_app` could reach through them). Look at each before Bops Cloud goes live there.

2. Let Bops Cloud's address reach Postgres: the database box's firewall, and `pg_hba.conf` if it
   names users (`hostssl orgo bops_app <bops cloud address>/32 scram-sha-256`).

3. The tables: Bops Cloud applies `db/migrations/*.sql` itself when it starts (`cloud/db.ts`), as
   `bops_app`. By hand:

   ```bash
   for f in db/migrations/*.sql; do psql "$BOPS_DATABASE_URL" -v ON_ERROR_STOP=1 -f "$f"; done
   ```

   Migrations are plain SQL, numbered, and safe to run again; `bops.schema_migrations` records which
   ran. They never create anything outside schema `bops`.

## The connection string

```
BOPS_DATABASE_URL=postgres://bops_app:<password>@<host>:5432/orgo?sslmode=no-verify
```

(`no-verify`: encrypted, without checking the server's self-signed certificate.) It lives in the
encrypted secrets (`envs/prod/bops-secrets.env`, sops), and Bops Cloud gets it from there at deploy
time. Never put it in `.env.example`, a commit or a log.

The older single-user hosted server (`lib/server/persist-pg.ts`) reads the same `bops.app_state`.
Optional for it: `BOPS_ORGO_USER_ID` pins a server to one user, whose state it loads before taking
requests, and refuses a sign-in by anyone else. Start it with `NEXT_MANUAL_SIG_HANDLE=true`, so it
saves before it exits on SIGTERM.

## How many connections

`db/provision.sql` gives `bops_app` a limit of 50 connections. A Bops Cloud process keeps a pool of
at most 10 (`cloud/db.ts`), and a single-user hosted server holds one. Raising the limit takes from
the `max_connections` orgo-web shares, so check that first; past it, put PgBouncer in front, in
transaction mode.

## How the server uses it

- Before the first request (`instrumentation.ts`) a pinned server loads the user's row; any other
  server loads it at sign-in. A sign-in fails if the row can't be read. If the database doesn't
  answer within 15 seconds, the server starts anyway and writes nothing until it has read the row,
  so a fresh state can never overwrite a saved one.
- Changes are written behind, at most every 2 seconds. Each write names the row version it last
  saw; if another server saved in between, that save stands and this server reloads it (its own
  unsaved changes are dropped, and logged).
- If the database goes away, the server keeps working from memory and retries with backoff (up to
  30 seconds), logging the first failure and then every tenth.
- `bops.usage_events` is a view over each user's usage ledger, for reporting across users.
- `bops.owner_phones` (0002) holds each user's own mobile numbers once they've proved them with a
  texted code (Settings → Phone; `lib/server/verify.ts`): when they agreed to texts, when it was
  verified, and the verification's id. A unique index on the number, over verified rows only, means
  one verified mobile belongs to exactly one Bops user: a second account trying to verify it is
  refused (before a code is sent, and again at the check, where the index settles a race). That's
  also what will let a hosted server route a text from a user's mobile to the right user. The row is
  written when the code checks out and deleted when the user removes the number or starts over; the
  state row keeps its own copy (`state.ownerPhones`), which is what the server reads for "is this
  the user". `BOPS_OWNER_PHONES` skips all of this: never set it on a hosted server.
  For now a hosted server refuses to add or remove these numbers (`/api/phone/verify/*` and
  `remove-owner` are for the app on a Mac only): it has no per-request sign-in yet, so anyone who
  reaches it could verify their own phone as its user. The table and the code that writes it are
  ready for when a request can prove which Orgo user sent it; the send limits in
  `lib/server/verify.ts` are per process then, and a cap shared across servers belongs here.
  Bops Cloud also adds a number here when it claims one of the user's lines (below), with
  `verification_ref` `claim:call` or `claim:text`.
- `bops.phone_lines` (0006, Bops Cloud's `cloud/lines.ts`): one row per bot number, with its owner's
  own phone. The first phone to call or text a new number in its 15 minutes becomes the owner (one
  conditional UPDATE, so only one wins); a number verified by code links lines with no owner. Bops
  Cloud checks every call and text to a line against it, never against the state row.
- `bops.cloud_usage.cost_micros` and `bops.cloud_objects.model` (0007, `0007_ai_credit.sql`, Bops
  Cloud's `cloud/usage.ts` and `cloud/credit.ts`): what each use cost Orgo, taken from the user's AI
  credit, and the model an agent session runs on, to price its turns.

## Test against a throwaway database

```bash
createdb bops_test
BOPS_TEST_DATABASE_URL=postgres://localhost/bops_test node scripts/test-persist-pg.mjs
```
