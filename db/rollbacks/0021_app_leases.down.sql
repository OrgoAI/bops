-- Undoes db/migrations/0021_app_leases.sql by hand (cloud/db.ts never runs this folder). Run as bops_app only after
-- the cloud that reads it is gone (an older cloud never reads it). Safe to run again.

BEGIN;

DROP TABLE IF EXISTS bops.app_leases;
DELETE FROM bops.schema_migrations WHERE version = '0021_app_leases';

COMMIT;
