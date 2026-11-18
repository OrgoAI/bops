-- One lease per app (cloud/app-lease.ts, protocol.ts APP_LEASE_PATH): who's changing each app of the owner's now, so
-- nothing on one app runs twice across their Macs, their computers' runners and Bops Cloud's jobs. Run as bops_app
-- after 0019 (cloud/db.ts migrate() does it at start); bops_app owns schema bops (db/provision.sql), so its tables need
-- no grants. Additive and safe to run again; db/rollbacks/0021_app_leases.down.sql undoes it.

BEGIN;

-- holder: "mac:<device>:<nonce>", "runner:<device>:<nonce>" or "job:<turn id>" (a job's, from its claim to its end).
-- device_id: the device that holds it (a job's: the computer's that claimed it). kind: what's under way (AppLeaseKind).
-- until: when it goes unless renewed. at: when it was taken.
CREATE TABLE IF NOT EXISTS bops.app_leases (
  user_id   text NOT NULL REFERENCES bops.app_state (user_id) ON DELETE CASCADE,
  ws_id     text NOT NULL,
  app       text NOT NULL,
  holder    text NOT NULL,
  device_id text NOT NULL,
  kind      text NOT NULL,
  until     timestamptz NOT NULL,
  at        timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (user_id, ws_id, app)
);
CREATE INDEX IF NOT EXISTS app_leases_holder ON bops.app_leases (user_id, holder);

INSERT INTO bops.schema_migrations (version) VALUES ('0021_app_leases') ON CONFLICT DO NOTHING;

COMMIT;
