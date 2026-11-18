-- Undoes db/migrations/0019_cloud_all.sql by hand (cloud/db.ts never runs this folder). Run as bops_app only after
-- the cloud that reads these is gone (an older cloud never reads them). Safe to run again.

BEGIN;

ALTER TABLE bops.chat_turns DROP COLUMN IF EXISTS min_version;
ALTER TABLE bops.chat_turns DROP COLUMN IF EXISTS is_group;
ALTER TABLE bops.chat_routing DROP COLUMN IF EXISTS trouble_at;
ALTER TABLE bops.chat_routing DROP COLUMN IF EXISTS trouble_desktop;
ALTER TABLE bops.chat_routing DROP COLUMN IF EXISTS trouble_bot;
ALTER TABLE bops.chat_routing DROP COLUMN IF EXISTS trouble;
DROP TABLE IF EXISTS bops.app_views;
DROP TABLE IF EXISTS bops.runner_seen;
DELETE FROM bops.schema_migrations WHERE version = '0019_cloud_all';

COMMIT;
