-- Billing by use (cloud/numbers-renew.ts): a phone number past the one kept free costs a month at a time from
-- Orgo credit, at cost ($3 a number). paid_until is when the month last paid for runs out; null until the
-- renewal sweep first sees the line on billing by use (it is then set to the line's first month's end, or now
-- for a line older than that, so the first renewal is charged on the next pass). Lines on Bops' plans never
-- read it. Run as bops_app after 0017 (cloud/db.ts migrate() does it at start). Additive and safe to run again;
-- db/rollbacks/0018_number_renewals.down.sql undoes it.

BEGIN;

ALTER TABLE bops.phone_lines ADD COLUMN IF NOT EXISTS paid_until timestamptz;

INSERT INTO bops.schema_migrations (version) VALUES ('0018_number_renewals') ON CONFLICT DO NOTHING;

COMMIT;
