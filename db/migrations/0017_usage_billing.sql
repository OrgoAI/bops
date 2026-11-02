-- Bops billed by use (cloud/plans.ts): whether orgo-web bills the user by Bops' own plans ('plan': Free, Pro or Max,
-- with Bops' AI credit) or by what they use, from their Orgo credit ('usage': no Bops plan, the computer by the hour
-- and AI at Orgo's rate). orgo-web keeps it (profiles.bops_billing) and says it with the tier, in its plan notice and
-- its GET /api/bops/plan; the cloud keeps the last word here with the tier, under the same changed_at. Every row
-- from before is 'plan', which is what they are. Run as bops_app after 0008 (cloud/db.ts migrate() does it at
-- start). Additive and safe to run again; db/rollbacks/0017_usage_billing.down.sql undoes it.

BEGIN;

ALTER TABLE bops.plans ADD COLUMN IF NOT EXISTS billing text NOT NULL DEFAULT 'plan';
DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'plans_billing_check' AND conrelid = 'bops.plans'::regclass) THEN
    ALTER TABLE bops.plans ADD CONSTRAINT plans_billing_check CHECK (billing IN ('plan', 'usage'));
  END IF;
END
$$;

INSERT INTO bops.schema_migrations (version) VALUES ('0017_usage_billing') ON CONFLICT DO NOTHING;

COMMIT;
