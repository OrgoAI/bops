-- Billing by use (cloud/numbers-renew.ts): a phone number past the one kept free costs a month at a time from
-- Orgo credit, at cost ($3 a number). paid_until is when the month last paid for runs out; null until the
-- renewal sweep first sees the line on billing by use (it is then set to the line's first month's end, or now
-- for a line older than that, so the first renewal is charged on the next pass). unpaid: the line is paused
-- (status 'paused', paused_at) because its month couldn't be paid from the user's credit; back on once it is
-- paid, given back 30 days after the pause if it still isn't (cloud/provision.ts releaseAfterPause). Lines on
-- Bops' plans never read either. Run as bops_app after 0017 (cloud/db.ts migrate() does it at start).
-- Additive and safe to run again; db/rollbacks/0018_number_renewals.down.sql undoes it.

BEGIN;

ALTER TABLE bops.phone_lines ADD COLUMN IF NOT EXISTS paid_until timestamptz;
ALTER TABLE bops.phone_lines ADD COLUMN IF NOT EXISTS unpaid boolean NOT NULL DEFAULT false;

INSERT INTO bops.schema_migrations (version) VALUES ('0018_number_renewals') ON CONFLICT DO NOTHING;

COMMIT;
