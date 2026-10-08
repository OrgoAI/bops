-- Usage, exactly once and for the right bot (cloud/usage.ts, cloud/reconcile.ts): the bot an Agents API
-- session works for, so its turns and web searches are counted for that bot; when it last got work,
-- and when the cloud last read its turns back from OpenAI itself, so a turn the Mac never saw finish
-- (the app quit, the Mac slept, a helper ran on) is still counted, and counted again when OpenAI's
-- own count of it changes. Run as bops_app after 0008 (cloud/db.ts migrate() does it at start). Safe
-- to run again.

BEGIN;

-- The bot an Agents API session was made for (the app's x-bops-bot header).
ALTER TABLE bops.cloud_objects ADD COLUMN IF NOT EXISTS bot_id text;
-- An Agents API session's last input (made, or a message sent to it); when the cloud last read its
-- turns back (reconcile.ts); and when it last found them all finished (null: some still ran).
ALTER TABLE bops.cloud_objects ADD COLUMN IF NOT EXISTS used_at timestamptz;
ALTER TABLE bops.cloud_objects ADD COLUMN IF NOT EXISTS checked_at timestamptz;
ALTER TABLE bops.cloud_objects ADD COLUMN IF NOT EXISTS settled_at timestamptz;
CREATE INDEX IF NOT EXISTS cloud_objects_sessions_used ON bops.cloud_objects (used_at) WHERE kind = 'agent_session' AND used_at IS NOT NULL;

-- A use seen more than once is found by its ref (recordUsageFor), and the account page sums by kind.
CREATE INDEX IF NOT EXISTS cloud_usage_ref ON bops.cloud_usage (user_id, kind, (detail->>'ref'));

INSERT INTO bops.schema_migrations (version) VALUES ('0009_usage') ON CONFLICT DO NOTHING;

COMMIT;
