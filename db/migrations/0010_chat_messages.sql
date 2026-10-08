-- The app's state lives in Bops Cloud now (cloud/state.ts): the signed-in Mac loads it from here and
-- writes its changes back, instead of keeping its own copy in .data/state.json. Chats grow without
-- end, so their messages get their own rows (bops.chat_messages) and a message is written on its own;
-- the rest of the state stays one JSONB blob in bops.app_state, which loses its `messages` key here.
-- Run as bops_app after 0009 (cloud/db.ts migrate() does it at start). Safe to run again.

BEGIN;

-- Every write of a message (or of its removal) takes the next number, so a Mac asks for what changed
-- since the last one it saw (GET /v1/messages?after=). One sequence for every user: a user's numbers
-- only ever go up, with gaps.
CREATE SEQUENCE IF NOT EXISTS bops.chat_seq;

-- One row per message (lib/types.ts Message, as JSON). `json` NULL is a removed message, kept 30 days
-- so another Mac of the user's hears it went, then swept (cloud/state.ts).
CREATE TABLE IF NOT EXISTS bops.chat_messages (
  user_id    text NOT NULL REFERENCES bops.app_state (user_id) ON DELETE CASCADE,
  id         text NOT NULL,
  chat_id    text NOT NULL,
  at         bigint NOT NULL,
  json       jsonb,
  seq        bigint NOT NULL DEFAULT nextval('bops.chat_seq'),
  updated_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (user_id, id)
);
CREATE INDEX IF NOT EXISTS chat_messages_seq ON bops.chat_messages (user_id, seq);
CREATE INDEX IF NOT EXISTS chat_messages_chat ON bops.chat_messages (user_id, chat_id, at) WHERE json IS NOT NULL;
CREATE INDEX IF NOT EXISTS chat_messages_removed ON bops.chat_messages (updated_at) WHERE json IS NULL;

-- protocol: 1 while only builds from before this one have written the row (they PUT the whole state
-- as a backup), 2 once a build that keeps its state here has; from then on the old upload is refused,
-- so an old build can't write over the newer one's work. writer: the Mac (its device id) that wrote
-- the state last. version is now the cloud's own count, bumped on every write.
ALTER TABLE bops.app_state ADD COLUMN IF NOT EXISTS protocol smallint NOT NULL DEFAULT 1;
ALTER TABLE bops.app_state ADD COLUMN IF NOT EXISTS writer text;

-- The messages already uploaded inside each state move to their own rows, and out of the blob.
INSERT INTO bops.chat_messages (user_id, id, chat_id, at, json)
SELECT s.user_id,
       m->>'id',
       COALESCE(m->>'chatId', ''),
       CASE WHEN jsonb_typeof(m->'at') = 'number' THEN floor((m->>'at')::numeric)::bigint ELSE 0 END,
       m
FROM bops.app_state s
CROSS JOIN LATERAL jsonb_array_elements(CASE WHEN jsonb_typeof(s.state->'messages') = 'array' THEN s.state->'messages' ELSE '[]'::jsonb END) AS m
WHERE jsonb_typeof(m) = 'object' AND jsonb_typeof(m->'id') = 'string'
ON CONFLICT (user_id, id) DO NOTHING;
UPDATE bops.app_state SET state = state - 'messages' WHERE state ? 'messages';

INSERT INTO bops.schema_migrations (version) VALUES ('0010_chat_messages') ON CONFLICT DO NOTHING;

COMMIT;
