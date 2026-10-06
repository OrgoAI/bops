-- Who owns each of the users' Bops numbers (cloud/lines.ts): the source of truth for whether a call
-- or text to a line is its owner, checked by Bops Cloud on every delivery. Never the app's uploaded
-- state. Run as bops_app after 0005 (cloud/db.ts migrate() does it at start). Safe to run again.

BEGIN;

-- One row per number. A new line has no owner: the first phone number to call or text it before
-- claim_until (15 minutes after the number was bought, or after the user asked for a new window)
-- becomes its owner, set once by a single conditional UPDATE so only one caller can win. A number
-- the user verified with a texted code (Settings) may be linked too (claimed_via 'sms_code').
CREATE TABLE IF NOT EXISTS bops.phone_lines (
  -- The line by its last 10 digits (US and Canadian numbers only, as bops.cloud_numbers): how a call or text to it is found.
  digits       text PRIMARY KEY CHECK (digits ~ '^[0-9]{10}$'),
  user_id      text NOT NULL REFERENCES bops.cloud_accounts (user_id) ON DELETE CASCADE,
  -- AgentPhone's id for the number, and the number as E.164.
  number_id    text,
  e164         text NOT NULL,
  -- The bot whose number it is, or the workspace whose number it is (its main bot's), as the app says.
  bot_id       text,
  workspace_id text,
  -- The owner's own phone, as E.164; null until claimed.
  owner_number text CHECK (owner_number ~ '^\+[0-9]{10,15}$'),
  claim_until  timestamptz,
  claimed_at   timestamptz,
  claimed_via  text CHECK (claimed_via IN ('call', 'text', 'sms_code')),
  created_at   timestamptz NOT NULL DEFAULT now(),
  updated_at   timestamptz NOT NULL DEFAULT now(),
  CHECK ((owner_number IS NULL) = (claimed_via IS NULL))
);
CREATE INDEX IF NOT EXISTS phone_lines_user ON bops.phone_lines (user_id);
CREATE INDEX IF NOT EXISTS phone_lines_number_id ON bops.phone_lines (number_id) WHERE number_id IS NOT NULL;

-- The lines that exist already: every number in a user's sub-account. No claim window opens for
-- them (nobody was told to call); the app opens one when the user asks. Where the user has verified
-- a number with a texted code, the newest one is linked. Only the first time: run again, it would
-- link a line the user has unlinked since.
DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM bops.schema_migrations WHERE version = '0006_phone_lines') THEN
    INSERT INTO bops.phone_lines (digits, user_id, number_id, e164)
    SELECT n.digits, n.user_id, n.number_id, COALESCE(n.e164, '+1' || n.digits)
    FROM bops.cloud_numbers n
    ON CONFLICT (digits) DO NOTHING;

    UPDATE bops.phone_lines l
    SET owner_number = p.phone_e164, claimed_at = p.verified_at, claimed_via = 'sms_code', updated_at = now()
    FROM (
      SELECT DISTINCT ON (orgo_user_id) orgo_user_id, phone_e164, verified_at
      FROM bops.owner_phones
      WHERE verified_at IS NOT NULL
      ORDER BY orgo_user_id, verified_at DESC
    ) p
    WHERE l.user_id = p.orgo_user_id AND l.owner_number IS NULL;
  END IF;
END
$$;

INSERT INTO bops.schema_migrations (version) VALUES ('0006_phone_lines') ON CONFLICT DO NOTHING;

COMMIT;
