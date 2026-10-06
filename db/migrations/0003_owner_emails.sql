-- The users' own email addresses, verified by an emailed code (Settings, How your bots reach you;
-- lib/server/owner-email.ts). Run as bops_app after 0002_owner_phones.sql:
--   psql "$BOPS_DATABASE_URL" -v ON_ERROR_STOP=1 -f db/migrations/0003_owner_emails.sql
-- Safe to run again.
--
-- The state row (bops.app_state) keeps its own copy (state.ownerEmails), which is what the server
-- reads. Only verified addresses are ever written. Unlike bops.owner_phones there is deliberately no
-- unique index across users: an email reaches a user through the bot's inbox it was sent to, not by
-- who sent it, and one address (a shared work inbox) can belong to two users.

BEGIN;

CREATE TABLE IF NOT EXISTS bops.owner_emails (
  orgo_user_id     text NOT NULL REFERENCES bops.app_state (user_id) ON DELETE CASCADE,
  -- Lowercased, with a local part before the @.
  email            text NOT NULL CHECK (email = lower(email) AND position('@' in email) > 1),
  -- When they entered the right code.
  verified_at      timestamptz NOT NULL,
  -- The verification provider's id for the check that verified it (for support and audits).
  verification_ref text,
  created_at       timestamptz NOT NULL DEFAULT now(),
  updated_at       timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (orgo_user_id, email)
);

INSERT INTO bops.schema_migrations (version) VALUES ('0003_owner_emails') ON CONFLICT DO NOTHING;

COMMIT;
