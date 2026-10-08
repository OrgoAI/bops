-- What Orgo tells Bops users, and which Bops apps the cloud serves (cloud/notices.ts, cloud/app-version.ts),
-- both written with Orgo's scripts/notices.sh (OrgoAI/bops-secrets). Run as bops_app after 0011 (cloud/db.ts migrate() does it
-- at start). Safe to run again.

BEGIN;

-- A notice: shown once to each user as a pop-up in the app (0.0.19 on), from starts_at until ends_at (NULL:
-- until it's ended). below_version: only apps older than that version get it ("update Bops"); NULL: every app.
CREATE TABLE IF NOT EXISTS bops.notices (
  id            bigserial PRIMARY KEY,
  title         text NOT NULL,
  body          text NOT NULL,
  link_url      text,
  link_label    text,
  below_version text,
  starts_at     timestamptz NOT NULL DEFAULT now(),
  ends_at       timestamptz,
  created_at    timestamptz NOT NULL DEFAULT now()
);

-- Who put which notice away: it doesn't come back for them, on any of their Macs.
CREATE TABLE IF NOT EXISTS bops.notice_dismissals (
  user_id   text NOT NULL,
  notice_id bigint NOT NULL REFERENCES bops.notices (id) ON DELETE CASCADE,
  at        timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (user_id, notice_id)
);

-- One row: block_below, the oldest app the cloud serves. Older apps, and those before 0.0.18 (which don't
-- say their version), are turned away (426) on every call but their state's. NULL: every app is served.
CREATE TABLE IF NOT EXISTS bops.app_policy (
  id          boolean PRIMARY KEY DEFAULT true CHECK (id),
  block_below text,
  updated_at  timestamptz NOT NULL DEFAULT now()
);
INSERT INTO bops.app_policy (id) VALUES (true) ON CONFLICT DO NOTHING;

INSERT INTO bops.schema_migrations (version) VALUES ('0012_notices') ON CONFLICT DO NOTHING;

COMMIT;
