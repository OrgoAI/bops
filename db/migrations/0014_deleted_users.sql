-- Deleting a user (cloud/delete-user.ts): orgo-web's account deletion asks Bops Cloud to delete
-- everything it holds for an Orgo user (POST /v1/internal/delete-user). Run as bops_app after 0013
-- (cloud/db.ts migrate() does it at start). Safe to run again.

BEGIN;

-- Who was deleted lately, and when: nothing of theirs is written again while they're here (a Mac or a
-- computer's runner still signed in, a turn finishing, a plan notice from the Stripe cancel that came
-- with the deletion: db.ts ensureUserRow, state.ts lockUser refuse them), and every sign-in of theirs is
-- turned down (auth.ts). Only the Orgo user id, which orgo-web keeps on its own tombstone too; swept
-- 3 days after the last delete (cloud/state.ts startStateSweeps; cloud/db.ts DELETED_KEEP_DAYS says why
-- that long), or taken out at once by POST /v1/internal/undelete-user.
CREATE TABLE IF NOT EXISTS bops.deleted_users (
  user_id    text PRIMARY KEY,
  deleted_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS deleted_users_at ON bops.deleted_users (deleted_at);

-- A deleted user's mail handles stay, retired and nobody's (user_id NULL), so a handle is never claimed
-- again: mail to the old addresses (<bot>@<handle>.bops.bot) would reach whoever took it. The foreign
-- key stays as it is: a row with no user hangs off no state row, so deleting one never takes it.
ALTER TABLE bops.mail_handles ALTER COLUMN user_id DROP NOT NULL;
DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'mail_handles_nobodys_retired' AND conrelid = 'bops.mail_handles'::regclass) THEN
    ALTER TABLE bops.mail_handles ADD CONSTRAINT mail_handles_nobodys_retired CHECK (user_id IS NOT NULL OR retired_at IS NOT NULL);
  END IF;
END
$$;

INSERT INTO bops.schema_migrations (version) VALUES ('0014_deleted_users') ON CONFLICT DO NOTHING;

COMMIT;
