-- Undoes db/migrations/0020_runner_keeper.sql by hand (cloud/db.ts never runs this folder). Run as bops_app only after
-- the cloud that reads these is gone (an older cloud never reads them). Safe to run again.

BEGIN;

ALTER TABLE bops.cloud_accounts DROP COLUMN IF EXISTS state_level;
DROP TABLE IF EXISTS bops.runner_releases;
DROP TABLE IF EXISTS bops.runner_keeper;
ALTER TABLE bops.runner_seen DROP COLUMN IF EXISTS auth;
ALTER TABLE bops.runner_seen DROP COLUMN IF EXISTS build_id;
DELETE FROM bops.schema_migrations WHERE version = '0020_runner_keeper';

COMMIT;
