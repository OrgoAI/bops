-- Everything through the cloud (cloud/turns.ts allCloud, protocol.ts CLOUD_ALL_MIN_VERSION): what Bops Cloud keeps so
-- a workspace switched to the cloud never needs the owner's Mac. Run as bops_app after 0018 (cloud/db.ts migrate() does
-- it at start); bops_app owns schema bops (db/provision.sql), so its tables need no grants. Additive and safe to run
-- again; db/rollbacks/0019_cloud_all.down.sql undoes it.

BEGIN;

-- The Bops each computer's runner said it runs as it last connected (GET /v1/runner/live, cloud/turns.ts runnerLive),
-- by Orgo computer id (lowercased). Unlike bops.runner_presence, never deleted when the runner goes: a computer that
-- naps still runs what it ran. turns.ts runnerVersionOf reads it with the owner's Mac's record (AppState.runners).
CREATE TABLE IF NOT EXISTS bops.runner_seen (
  user_id    text NOT NULL REFERENCES bops.app_state (user_id) ON DELETE CASCADE,
  desktop_id text NOT NULL CHECK (desktop_id = lower(desktop_id)),
  device_id  text NOT NULL,
  version    text NOT NULL,
  seen_at    timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (user_id, desktop_id)
);

-- What members see of an app (SharedApp), as the app's own computer last read it, kept out of the owner's state so a
-- new look never bumps its version. view_at: when the computer read it; seen_at: when Bops Cloud kept it.
CREATE TABLE IF NOT EXISTS bops.app_views (
  user_id text NOT NULL REFERENCES bops.app_state (user_id) ON DELETE CASCADE,
  ws_id   text NOT NULL,
  app     text NOT NULL,
  view    jsonb NOT NULL,
  view_at timestamptz NOT NULL,
  seen_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (user_id, ws_id, app)
);

-- Why a workspace switched to the cloud can't answer now (a NOTES key: stopped, deleted, noRunner, old…), which bot's
-- computer, and since when: said to the owner and Admins in place of moving the workspace back to the Mac.
ALTER TABLE bops.chat_routing ADD COLUMN IF NOT EXISTS trouble text;
ALTER TABLE bops.chat_routing ADD COLUMN IF NOT EXISTS trouble_bot text;
ALTER TABLE bops.chat_routing ADD COLUMN IF NOT EXISTS trouble_desktop text;
ALTER TABLE bops.chat_routing ADD COLUMN IF NOT EXISTS trouble_at timestamptz;

-- A turn a group's bots answer on their one computer (is_group), and the least Bops its runner must run to claim it
-- (min_version; none: any).
ALTER TABLE bops.chat_turns ADD COLUMN IF NOT EXISTS is_group boolean NOT NULL DEFAULT false;
ALTER TABLE bops.chat_turns ADD COLUMN IF NOT EXISTS min_version text;

INSERT INTO bops.schema_migrations (version) VALUES ('0019_cloud_all') ON CONFLICT DO NOTHING;

COMMIT;
