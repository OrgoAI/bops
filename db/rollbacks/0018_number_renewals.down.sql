-- Undoes db/migrations/0018_number_renewals.sql by hand (cloud/db.ts never runs this folder). Run as bops_app
-- after the cloud that renews numbers is gone. Safe to run again.

BEGIN;

ALTER TABLE bops.phone_lines DROP COLUMN IF EXISTS paid_until;
DELETE FROM bops.schema_migrations WHERE version = '0018_number_renewals';

COMMIT;
