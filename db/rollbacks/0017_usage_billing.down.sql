-- Undoes db/migrations/0017_usage_billing.sql by hand (cloud/db.ts never runs this folder). Run as bops_app only
-- after the cloud that reads bops.plans.billing is gone (an older cloud never reads it), and after orgo-web has
-- set every user back to plan billing: the column is the cloud's only record of who is billed by use. Safe to run again.

BEGIN;

ALTER TABLE bops.plans DROP CONSTRAINT IF EXISTS plans_billing_check;
ALTER TABLE bops.plans DROP COLUMN IF EXISTS billing;
DELETE FROM bops.schema_migrations WHERE version = '0017_usage_billing';

COMMIT;
