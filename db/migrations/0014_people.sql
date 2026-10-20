-- People: Bops users messaging each other, one to one and in groups (cloud/people.ts). Each user's own
-- chats with their bots stay in their state (bops.app_state, bops.chat_messages); a conversation
-- between people lives here once, for everyone in it, and each member's Mac mirrors it.
-- Run as bops_app after 0013 (cloud/db.ts migrate() does it at start). Safe to run again.

BEGIN;

-- Who's on Bops, as Orgo says when they sign in: found by their email (exactly) to start a conversation.
CREATE TABLE IF NOT EXISTS bops.people (
  user_id    text PRIMARY KEY,
  email      text,
  name       text,
  updated_at timestamptz NOT NULL DEFAULT now()
);
CREATE UNIQUE INDEX IF NOT EXISTS people_email ON bops.people (lower(email)) WHERE email IS NOT NULL;

-- Every change a member's Mac should pick up (a message, a conversation's members or name) takes the
-- next number, so a Mac asks for what changed since the last one it saw.
CREATE SEQUENCE IF NOT EXISTS bops.people_seq;

-- A conversation: "dm" between two people (one per pair: dm_key is their user ids, sorted), or a "group".
CREATE TABLE IF NOT EXISTS bops.convos (
  id          text PRIMARY KEY,
  kind        text NOT NULL CHECK (kind IN ('dm', 'group')),
  title       text,
  dm_key      text UNIQUE,
  created_by  text NOT NULL,
  created_at  timestamptz NOT NULL DEFAULT now(),
  seq         bigint NOT NULL DEFAULT nextval('bops.people_seq')
);

-- Who's in it. left_at: they left or were taken out (they keep what they saw, and get nothing new).
-- read_seq: the newest message they've read, for "Seen" and unread counts.
CREATE TABLE IF NOT EXISTS bops.convo_members (
  convo_id   text NOT NULL REFERENCES bops.convos (id) ON DELETE CASCADE,
  user_id    text NOT NULL,
  added_by   text,
  joined_at  timestamptz NOT NULL DEFAULT now(),
  left_at    timestamptz,
  read_seq   bigint NOT NULL DEFAULT 0,
  PRIMARY KEY (convo_id, user_id)
);
CREATE INDEX IF NOT EXISTS convo_members_user ON bops.convo_members (user_id) WHERE left_at IS NULL;

-- A message. id: the sender's own (so sending twice is one message). author: the user who sent it, and
-- bot_id when one of their bots wrote it. json: what else it carries (replyTo, images…), as the app keeps it.
CREATE TABLE IF NOT EXISTS bops.convo_messages (
  convo_id   text NOT NULL REFERENCES bops.convos (id) ON DELETE CASCADE,
  id         text NOT NULL,
  author     text NOT NULL,
  bot_id     text,
  text       text NOT NULL,
  json       jsonb,
  at         bigint NOT NULL,
  seq        bigint NOT NULL DEFAULT nextval('bops.people_seq'),
  PRIMARY KEY (convo_id, id)
);
CREATE INDEX IF NOT EXISTS convo_messages_seq ON bops.convo_messages (convo_id, seq);

-- Someone asked into a conversation by an email that isn't on Bops yet: they join it when they sign in with it.
CREATE TABLE IF NOT EXISTS bops.convo_invites (
  convo_id   text NOT NULL REFERENCES bops.convos (id) ON DELETE CASCADE,
  email      text NOT NULL,
  invited_by text NOT NULL,
  at         timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (convo_id, email)
);
CREATE INDEX IF NOT EXISTS convo_invites_email ON bops.convo_invites (lower(email));

INSERT INTO bops.schema_migrations (version) VALUES ('0014_people') ON CONFLICT DO NOTHING;

COMMIT;
