-- The users' own mobile numbers, verified by a texted code (Settings → Phone; lib/server/verify.ts).
-- Run as bops_app after 0001_init.sql:
--   psql "$BOPS_DATABASE_URL" -v ON_ERROR_STOP=1 -f db/migrations/0002_owner_phones.sql
-- Safe to run again.
--
-- The state row (bops.app_state) keeps its own copy (state.ownerPhones), which is what the server
-- reads. This table is what has to hold across users: one verified number belongs to exactly one
-- Bops user, so a hosted server can route a text from that number to the right user, and a second
-- account can't claim a number someone else already proved is theirs.

BEGIN;

CREATE TABLE IF NOT EXISTS bops.owner_phones (
  orgo_user_id     text NOT NULL REFERENCES bops.app_state (user_id) ON DELETE CASCADE,
  -- E.164: a leading + and 10 to 15 digits.
  phone_e164       text NOT NULL CHECK (phone_e164 ~ '^\+[0-9]{10,15}$'),
  -- When the user ticked the box agreeing to get texts (the opt-in carriers ask for).
  consent_at       timestamptz NOT NULL,
  -- When they entered the right code; null while not verified.
  verified_at      timestamptz,
  -- The verification provider's id for the check that verified it (for support and audits).
  verification_ref text,
  created_at       timestamptz NOT NULL DEFAULT now(),
  updated_at       timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (orgo_user_id, phone_e164)
);

-- One verified owner per number, across all users.
CREATE UNIQUE INDEX IF NOT EXISTS owner_phones_verified_once ON bops.owner_phones (phone_e164) WHERE verified_at IS NOT NULL;

INSERT INTO bops.schema_migrations (version) VALUES ('0002_owner_phones') ON CONFLICT DO NOTHING;

COMMIT;
