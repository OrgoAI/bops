-- Bops for iPhone (cloud/agent.ts, cloud/app-version.ts): the phone says it's the iPhone app
-- (x-bops-client: ios) and its own version, which is kept apart from the Mac's: cloud_accounts.app_version
-- stays the Mac's. ios_block_below is the oldest iPhone app the cloud serves (NULL: every one), as
-- block_below is for the Mac. chat_messages_answers finds the main bot's answer to a message sent from
-- the phone (its `answers`), so a message sent twice is answered once. app_state.swept_seq is the
-- highest seq of the user's removed messages swept for good after 30 days (cloud/state.ts): a phone
-- whose cursor is older than it may have missed a removal, so it loads the chat again.
-- Run as bops_app after 0012 (cloud/db.ts migrate() does it at start). Safe to run again.

BEGIN;

ALTER TABLE bops.cloud_accounts ADD COLUMN IF NOT EXISTS ios_version text;
ALTER TABLE bops.cloud_accounts ADD COLUMN IF NOT EXISTS ios_seen_at timestamptz;

ALTER TABLE bops.app_policy ADD COLUMN IF NOT EXISTS ios_block_below text;

CREATE INDEX IF NOT EXISTS chat_messages_answers ON bops.chat_messages (user_id, (json->>'answers')) WHERE json ? 'answers';

ALTER TABLE bops.app_state ADD COLUMN IF NOT EXISTS swept_seq bigint NOT NULL DEFAULT 0;

INSERT INTO bops.schema_migrations (version) VALUES ('0013_ios_client') ON CONFLICT DO NOTHING;

COMMIT;
