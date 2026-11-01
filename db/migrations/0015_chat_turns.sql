-- Chat through Bops Cloud (cloud/turns.ts): in a workspace switched to it, every message a person says in a chat is
-- written here first (by Bops Cloud, never by a Mac or a computer), and the bot's answer is owed as a turn that the
-- runner on the bot's computer claims, runs and finishes. Run as bops_app after 0014 (cloud/db.ts migrate() does it
-- at start). Safe to run again.

BEGIN;

-- One turn owed per message (unique message_id). state: owed (waiting for a runner), waking (its computer is being
-- woken), claimed (a runner holds it until lease_until, beating every 30 seconds; phase "tools" once the turn did
-- something that can't be done twice, so a lost lease ends it instead of handing it to another runner), paused (it
-- waits for someone's OK: approval_id, no lease), done, failed or expired (with a note said in the chat). member: who
-- said it, when it was a member ({userId, email, name, ref, joinedAt, projectId}), so their removal ends what they're
-- owed. human_at: the message's time, which the answer is never stamped before (a computer's clock can lag after it
-- wakes). One turn of a chat runs at a time (cloud/turns.ts claim).
CREATE TABLE IF NOT EXISTS bops.chat_turns (
  user_id       text NOT NULL REFERENCES bops.app_state (user_id) ON DELETE CASCADE,
  id            text NOT NULL,
  message_id    text NOT NULL,
  chat_id       text NOT NULL,
  bot_id        text NOT NULL,
  ws_id         text NOT NULL,
  member        jsonb,
  desktop_id    text NOT NULL,
  target_device text NOT NULL,
  state         text NOT NULL CHECK (state IN ('owed', 'waking', 'claimed', 'paused', 'done', 'failed', 'expired')),
  phase         text CHECK (phase IN ('model', 'tools')),
  claimed_by    text,
  lease_until   timestamptz,
  attempts      int NOT NULL DEFAULT 0,
  deadline      timestamptz NOT NULL,
  approval_id   text,
  note          text,
  human_at      bigint NOT NULL,
  created_at    timestamptz NOT NULL DEFAULT now(),
  updated_at    timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (user_id, id),
  UNIQUE (user_id, message_id)
);
CREATE INDEX IF NOT EXISTS chat_turns_open ON bops.chat_turns (user_id, target_device, created_at) WHERE state IN ('owed', 'waking', 'claimed', 'paused');
CREATE INDEX IF NOT EXISTS chat_turns_chat ON bops.chat_turns (user_id, chat_id, created_at) WHERE state IN ('owed', 'waking', 'claimed', 'paused');
CREATE INDEX IF NOT EXISTS chat_turns_due ON bops.chat_turns (deadline) WHERE state IN ('owed', 'waking', 'claimed', 'paused');
CREATE INDEX IF NOT EXISTS chat_turns_member ON bops.chat_turns ((member->>'userId')) WHERE member IS NOT NULL;
CREATE INDEX IF NOT EXISTS chat_turns_ended ON bops.chat_turns (updated_at) WHERE state IN ('done', 'failed', 'expired');

-- The runners listening for turns now (GET /v1/runner/live). The open streams in Bops Cloud's memory are the truth;
-- these rows say when each was last seen, for the sweep and for a look from outside. Cleared at start.
CREATE TABLE IF NOT EXISTS bops.runner_presence (
  user_id      text NOT NULL REFERENCES bops.app_state (user_id) ON DELETE CASCADE,
  device_id    text NOT NULL,
  desktop_id   text NOT NULL,
  version      text,
  connected_at timestamptz NOT NULL DEFAULT now(),
  seen_at      timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (user_id, device_id)
);

-- The per workspace switch (off by default): mode 'cloud' sends that workspace's chat through Bops Cloud.
-- allow_hourly: the owner lets a message wake a computer billed by the hour (else it's refused, with a note).
CREATE TABLE IF NOT EXISTS bops.chat_routing (
  user_id      text NOT NULL REFERENCES bops.app_state (user_id) ON DELETE CASCADE,
  ws_id        text NOT NULL,
  mode         text NOT NULL DEFAULT 'mac' CHECK (mode IN ('mac', 'cloud')),
  allow_hourly boolean NOT NULL DEFAULT false,
  set_by       text,
  set_at       timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (user_id, ws_id)
);

INSERT INTO bops.schema_migrations (version) VALUES ('0015_chat_turns') ON CONFLICT DO NOTHING;

COMMIT;
