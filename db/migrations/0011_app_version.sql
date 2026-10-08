-- Which Bops app each user is on (cloud/app-version.ts): the version their app said on its latest call
-- to the cloud (NULL: an app before 0.0.18, which doesn't say), and when that was. With
-- BOPS_MIN_APP_VERSION set the cloud turns older apps away; these show who's still on one.
-- Run as bops_app after 0010 (cloud/db.ts migrate() does it at start). Safe to run again.

BEGIN;

ALTER TABLE bops.cloud_accounts ADD COLUMN IF NOT EXISTS app_version text;
ALTER TABLE bops.cloud_accounts ADD COLUMN IF NOT EXISTS app_seen_at timestamptz;

INSERT INTO bops.schema_migrations (version) VALUES ('0011_app_version') ON CONFLICT DO NOTHING;

COMMIT;
