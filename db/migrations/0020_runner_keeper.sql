-- Runners that set up and update themselves (protocol.ts CLOUD_SELF_MIN_VERSION, cloud/runner-release.ts, the keeper
-- vm/bin/bops-runner-keeper.mjs): what Bops Cloud keeps so a bot's computer brings its own runner up and keeps it on the
-- newest signed release. Run as bops_app after 0019 (cloud/db.ts migrate() does it at start); bops_app owns schema bops
-- (db/provision.sql), so its tables need no grants. Additive and safe to run again; db/rollbacks/0020_runner_keeper.down.sql
-- undoes it.

BEGIN;

-- Which build of its version each runner said it runs as it last connected (protocol.ts RUNNER_BUILD_HEADER; NULL: it
-- said none), and what it signed in with: its computer's Orgo identity, or a key (cloud/auth.ts CloudComputer.kind).
ALTER TABLE bops.runner_seen ADD COLUMN IF NOT EXISTS build_id text;
ALTER TABLE bops.runner_seen ADD COLUMN IF NOT EXISTS auth text CHECK (auth IN ('identity', 'key'));

-- Each computer's keeper as it last asked Bops Cloud (POST /v1/runner/keeper), by Orgo computer id (lowercased):
-- keeper, the keeper's own version; runner, what it found there ("<version>-<build>", NULL: none); staff, whether the
-- owner is Orgo's staff then; runs_on, where Orgo said the account's bots work; answer and why, what Bops Cloud said
-- (protocol.ts KeeperAnswer), and go_at, when it last said install or update; outcome, outcome_of ("<version>-<build>")
-- and outcome_at, the last thing it said it did (KeeperAsk.outcome); asked_at, when it last asked (NULL: never, a row
-- kept only for boot_at); boot_at, when Bops Cloud last asked orgo-web to put a keeper on it.
CREATE TABLE IF NOT EXISTS bops.runner_keeper (
  user_id    text NOT NULL REFERENCES bops.app_state (user_id) ON DELETE CASCADE,
  desktop_id text NOT NULL CHECK (desktop_id = lower(desktop_id)),
  keeper     text,
  runner     text,
  staff      boolean NOT NULL DEFAULT false,
  runs_on    text CHECK (runs_on IN ('cloud', 'mac')),
  answer     text CHECK (answer IN ('nothing', 'install', 'update')),
  why        text,
  go_at      timestamptz,
  outcome    text,
  outcome_of text,
  outcome_at timestamptz,
  asked_at   timestamptz,
  boot_at    timestamptz,
  PRIMARY KEY (user_id, desktop_id)
);

-- Every signed runner release Bops Cloud has read (cloud/runner-release.ts), by version: its build, the state level it
-- writes (protocol.ts RunnerRelease.stateLevel), when it was signed, and when Bops Cloud first read it. Nobody's.
CREATE TABLE IF NOT EXISTS bops.runner_releases (
  version     text PRIMARY KEY,
  build_id    text NOT NULL,
  state_level int NOT NULL,
  released_at timestamptz,
  seen_at     timestamptz NOT NULL DEFAULT now()
);

-- Which state the user's last Mac may be given (cloud/state.ts stateLevelOf), kept with its version (app-version.ts):
-- a runner is never updated to a release that writes a newer state than that Mac reads.
ALTER TABLE bops.cloud_accounts ADD COLUMN IF NOT EXISTS state_level int;

INSERT INTO bops.schema_migrations (version) VALUES ('0020_runner_keeper') ON CONFLICT DO NOTHING;

COMMIT;
