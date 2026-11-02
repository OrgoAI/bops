-- Undoes db/migrations/0018_number_renewals.sql by hand (cloud/db.ts never runs this folder). Run as bops_app
-- after the cloud that renews numbers is gone. A line paused for its month is put back on first: a cloud
-- without renewals would never pick it up again or give it back. Safe to run again.

BEGIN;

DO $$
BEGIN
  IF EXISTS (SELECT 1 FROM information_schema.columns WHERE table_schema = 'bops' AND table_name = 'phone_lines' AND column_name = 'unpaid') THEN
    UPDATE bops.phone_lines SET status = 'ready', paused_at = NULL, updated_at = now() WHERE unpaid AND status = 'paused';
  END IF;
END $$;

ALTER TABLE bops.phone_lines DROP COLUMN IF EXISTS unpaid;
ALTER TABLE bops.phone_lines DROP COLUMN IF EXISTS paid_until;
DELETE FROM bops.schema_migrations WHERE version = '0018_number_renewals';

COMMIT;
