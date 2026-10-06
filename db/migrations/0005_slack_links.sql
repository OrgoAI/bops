-- Bops Cloud and Bops' own Slack app (cloud/slack.ts): which user's Mac gets each event the app's
-- Slack workspaces send to /hooks/slack. Run as bops_app after 0004 (cloud/db.ts migrate() does it at
-- start). Safe to run again.

BEGIN;

-- One row per user and Slack account (a Composio connected account of Bops' Slack app). The workspace
-- (team_id) and the app's bot user there come only from an auth.test the cloud ran through that
-- account; the rest is what the user's Mac says (PUT /v1/slack/links): the channels its bots are in,
-- the direct-message channel with the person paired once they've written there, the Slack user ids
-- its bots are paired with, and whether a bot is waiting for its pairing code. An event goes only to
-- rows of its own workspace: a channel message to the users in that channel, a direct message to the
-- user it's with (by its channel, or from someone their bots are paired with; else to those
-- pairing). Never to everyone in a workspace.
CREATE TABLE IF NOT EXISTS bops.slack_links (
  user_id     text NOT NULL REFERENCES bops.app_state (user_id) ON DELETE CASCADE,
  account_id  text NOT NULL,
  team_id     text NOT NULL,
  bot_user_id text,
  channels    text[] NOT NULL DEFAULT '{}',
  dm          text,
  owners      text[] NOT NULL DEFAULT '{}',
  pairing     boolean NOT NULL DEFAULT false,
  created_at  timestamptz NOT NULL DEFAULT now(),
  updated_at  timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (user_id, account_id)
);
CREATE INDEX IF NOT EXISTS slack_links_team ON bops.slack_links (team_id);

-- What waits for a Mac may go stale: a Slack event is kept a day, and past that it's dropped, not
-- handed over. Null: kept until delivered (texts, calls).
ALTER TABLE bops.cloud_pending ADD COLUMN IF NOT EXISTS expires_at timestamptz;

INSERT INTO bops.schema_migrations (version) VALUES ('0005_slack_links') ON CONFLICT DO NOTHING;

COMMIT;
