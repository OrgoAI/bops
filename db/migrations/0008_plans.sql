-- Bops plans in the cloud (cloud/plans.ts, cloud/provision.ts, cloud/handles.ts): each user's tier as
-- orgo-web last said, the number and inbox a paid plan brings their main bot, how each of those
-- stands, and the part of the address each workspace's bots get (<name>@<handle>.bops.bot). Run as
-- bops_app after 0007 (cloud/db.ts migrate() does it at start). Safe to run again.

BEGIN;

-- The user's Bops plan (profiles.bops_tier in orgo-web, which bops_app can't read): orgo-web's
-- Stripe webhook tells the cloud (POST /v1/internal/plan-changed), and the cloud asks orgo-web again
-- at each session start. `changed_at` is when orgo-web wrote it: an older notice never undoes a newer one.
CREATE TABLE IF NOT EXISTS bops.plans (
  user_id    text PRIMARY KEY REFERENCES bops.app_state (user_id) ON DELETE CASCADE,
  tier       text NOT NULL CHECK (tier IN ('free_bops', 'pro_bops', 'max_bops')),
  changed_at timestamptz NOT NULL,
  -- Who said so last: orgo-web's notice ('notice') or the cloud's own read at a session start ('session').
  source     text NOT NULL CHECK (source IN ('notice', 'session')),
  updated_at timestamptz NOT NULL DEFAULT now()
);

-- How each line stands, so nobody has to ask AgentPhone: setting_up (being bought or wired),
-- ready (read back from AgentPhone: its calls go to its agent, whose webhook is the cloud), broken
-- (`problem` says why; the next reconcile tries again), paused (the plan ended: calls and texts to it
-- aren't answered), released (given back to AgentPhone 30 days after it was paused). `plan`: the
-- number came with the plan (the cloud bought it for the main bot), so it's paused and released with
-- it; a number the user bought themselves never is. Lines from before are ready.
ALTER TABLE bops.phone_lines ADD COLUMN IF NOT EXISTS status text NOT NULL DEFAULT 'ready';
ALTER TABLE bops.phone_lines ADD COLUMN IF NOT EXISTS checked_at timestamptz;
ALTER TABLE bops.phone_lines ADD COLUMN IF NOT EXISTS problem text;
ALTER TABLE bops.phone_lines ADD COLUMN IF NOT EXISTS plan boolean NOT NULL DEFAULT false;
ALTER TABLE bops.phone_lines ADD COLUMN IF NOT EXISTS agent_id text;
ALTER TABLE bops.phone_lines ADD COLUMN IF NOT EXISTS paused_at timestamptz;
DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'phone_lines_status_check' AND conrelid = 'bops.phone_lines'::regclass) THEN
    ALTER TABLE bops.phone_lines ADD CONSTRAINT phone_lines_status_check CHECK (status IN ('setting_up', 'ready', 'broken', 'paused', 'released'));
  END IF;
END
$$;
CREATE INDEX IF NOT EXISTS phone_lines_paused ON bops.phone_lines (paused_at) WHERE status = 'paused';

-- The inboxes the cloud made for a plan (the main bot's), with the same states as phone_lines. The
-- Mac makes every other inbox itself, with its pod key, and keeps them in its own state.
CREATE TABLE IF NOT EXISTS bops.mail_inboxes (
  inbox_id     text PRIMARY KEY,
  user_id      text NOT NULL REFERENCES bops.cloud_accounts (user_id) ON DELETE CASCADE,
  pod_id       text NOT NULL,
  email        text NOT NULL,
  bot_id       text,
  workspace_id text,
  handle       text,
  plan         boolean NOT NULL DEFAULT true,
  status       text NOT NULL DEFAULT 'setting_up' CHECK (status IN ('setting_up', 'ready', 'broken', 'paused', 'released')),
  checked_at   timestamptz,
  problem      text,
  paused_at    timestamptz,
  created_at   timestamptz NOT NULL DEFAULT now(),
  updated_at   timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS mail_inboxes_user ON bops.mail_inboxes (user_id);
CREATE INDEX IF NOT EXISTS mail_inboxes_paused ON bops.mail_inboxes (paused_at) WHERE status = 'paused';

-- Each workspace's part of its bots' addresses (sam@<handle>.bops.bot), claimed once across every
-- Bops user: the user's default workspace takes their own handle (from their Orgo name or email),
-- any other workspace its own name. One current row per (user, workspace); a handle changed away
-- from stays here (retired_at), still the user's, since mail to the old addresses still arrives:
-- nobody else can take it, and the user can go back to it. `changes`: how many times this
-- workspace's handle was changed (at most 3). `auto`: Bops picked it (the user chose later, or a
-- plan was set up while their Mac was closed), so the app offers to change it.
CREATE TABLE IF NOT EXISTS bops.mail_handles (
  handle       text PRIMARY KEY CHECK (handle ~ '^[a-z0-9][a-z0-9-]{1,28}[a-z0-9]$' AND handle !~ '--'),
  user_id      text NOT NULL REFERENCES bops.app_state (user_id) ON DELETE CASCADE,
  workspace_id text NOT NULL,
  auto         boolean NOT NULL DEFAULT false,
  changes      integer NOT NULL DEFAULT 0,
  created_at   timestamptz NOT NULL DEFAULT now(),
  retired_at   timestamptz
);
CREATE UNIQUE INDEX IF NOT EXISTS mail_handles_current ON bops.mail_handles (user_id, workspace_id) WHERE retired_at IS NULL;

INSERT INTO bops.schema_migrations (version) VALUES ('0008_plans') ON CONFLICT DO NOTHING;

COMMIT;
