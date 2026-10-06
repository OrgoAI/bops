-- Bops Cloud (cloud/): the multi-user server that holds Orgo's provider keys, takes webhooks for every
-- user and passes each to that user's Mac, and answers calls when the Mac is away. Run as bops_app
-- after 0003 (cloud/db.ts migrate() does it at start). Safe to run again.

BEGIN;

-- One row per Bops user the cloud has set up: their AgentMail pod (and a key sealed with
-- BOPS_CLOUD_SECRET that reaches only that pod) and their AgentPhone sub-account.
CREATE TABLE IF NOT EXISTS bops.cloud_accounts (
  user_id                text PRIMARY KEY REFERENCES bops.app_state (user_id) ON DELETE CASCADE,
  email                  text,
  agentmail_pod_id       text,
  agentmail_key_sealed   text,
  agentphone_sub_account text UNIQUE,
  created_at             timestamptz NOT NULL DEFAULT now(),
  updated_at             timestamptz NOT NULL DEFAULT now(),
  last_seen_at           timestamptz NOT NULL DEFAULT now()
);

-- AgentPhone agents a user's Mac registered a webhook for (through /proxy/agentphone). The webhook
-- secret AgentPhone returned is kept here, sealed, and never reaches the Mac: the cloud checks each
-- delivery's signature and knows whose it is from the agent.
CREATE TABLE IF NOT EXISTS bops.cloud_agents (
  agent_id      text PRIMARY KEY,
  user_id       text NOT NULL REFERENCES bops.cloud_accounts (user_id) ON DELETE CASCADE,
  secret_sealed text,
  created_at    timestamptz NOT NULL DEFAULT now(),
  updated_at    timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS cloud_agents_user ON bops.cloud_agents (user_id);

-- Phone numbers in users' sub-accounts, by their last 10 digits: which user a call to it is for.
CREATE TABLE IF NOT EXISTS bops.cloud_numbers (
  digits     text PRIMARY KEY CHECK (digits ~ '^[0-9]{10}$'),
  user_id    text NOT NULL REFERENCES bops.cloud_accounts (user_id) ON DELETE CASCADE,
  number_id  text,
  e164       text,
  updated_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS cloud_numbers_user ON bops.cloud_numbers (user_id);

-- Who owns each provider object the cloud has seen (an OpenAI response, conversation or live
-- session; a Composio connected account): a proxy refuses one user's request for another's.
CREATE TABLE IF NOT EXISTS bops.cloud_objects (
  provider   text NOT NULL,
  object_id  text NOT NULL,
  kind       text NOT NULL,
  user_id    text NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (provider, object_id)
);
CREATE INDEX IF NOT EXISTS cloud_objects_user ON bops.cloud_objects (user_id, created_at DESC);

-- What waited for a user's Mac (texts that came in while it was away, calls the cloud answered).
-- Delivered over the tunnel when the Mac connects; delivered_at is set when the Mac acks.
CREATE TABLE IF NOT EXISTS bops.cloud_pending (
  id           bigserial PRIMARY KEY,
  user_id      text NOT NULL REFERENCES bops.app_state (user_id) ON DELETE CASCADE,
  kind         text NOT NULL,
  payload      jsonb NOT NULL,
  dedupe_key   text,
  created_at   timestamptz NOT NULL DEFAULT now(),
  delivered_at timestamptz
);
CREATE INDEX IF NOT EXISTS cloud_pending_waiting ON bops.cloud_pending (user_id, id) WHERE delivered_at IS NULL;
CREATE UNIQUE INDEX IF NOT EXISTS cloud_pending_dedupe ON bops.cloud_pending (user_id, dedupe_key) WHERE dedupe_key IS NOT NULL;

-- Metered use per user (model tokens, numbers, call minutes, codes sent), for the account page and billing.
CREATE TABLE IF NOT EXISTS bops.cloud_usage (
  id      bigserial PRIMARY KEY,
  user_id text NOT NULL,
  kind    text NOT NULL,
  units   numeric NOT NULL DEFAULT 0,
  detail  jsonb,
  at      timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS cloud_usage_user ON bops.cloud_usage (user_id, at DESC);

-- Fixed-window rate limits shared by every cloud process (texted codes, checks).
CREATE TABLE IF NOT EXISTS bops.cloud_limits (
  key          text NOT NULL,
  window_start timestamptz NOT NULL,
  count        integer NOT NULL DEFAULT 0,
  PRIMARY KEY (key, window_start)
);

INSERT INTO bops.schema_migrations (version) VALUES ('0004_cloud') ON CONFLICT DO NOTHING;

COMMIT;
