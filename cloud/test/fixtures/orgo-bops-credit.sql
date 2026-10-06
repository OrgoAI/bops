-- For the cloud's tests only: orgo-web's AI credit ledger, as its migration
-- db/migrations/20261022_bops_plans.sql makes it in orgo-web's database (public.bops_ai_credit,
-- public.bops_ai_credit_grants and the three functions, copied from it as they are there), on a
-- stand-in public.profiles with only an id. Keep it in step with that file. Applied to the throwaway
-- test database by cloud/test/core-credit.test.ts; never to a real one. Safe to run again.

BEGIN;

CREATE TABLE IF NOT EXISTS public.profiles (
  id uuid PRIMARY KEY
);

CREATE TABLE IF NOT EXISTS public.bops_ai_credit (
  user_id         uuid PRIMARY KEY REFERENCES public.profiles(id) ON DELETE CASCADE,
  plan_micros     bigint NOT NULL DEFAULT 0,
  plan_expires_at timestamptz,
  free_micros     bigint NOT NULL DEFAULT 0,
  updated_at      timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS public.bops_ai_credit_grants (
  id                bigserial PRIMARY KEY,
  user_id           uuid NOT NULL REFERENCES public.profiles(id) ON DELETE CASCADE,
  kind              text NOT NULL CHECK (kind IN ('free_signup','plan')),
  tier              text NOT NULL CHECK (tier IN ('free_bops','pro_bops','max_bops')),
  amount_micros     bigint NOT NULL,
  period_start      timestamptz,
  period_end        timestamptz,
  stripe_invoice_id text UNIQUE,
  created_at        timestamptz NOT NULL DEFAULT now()
);
CREATE UNIQUE INDEX IF NOT EXISTS bops_ai_credit_grants_one_free
  ON public.bops_ai_credit_grants (user_id) WHERE kind = 'free_signup';
CREATE INDEX IF NOT EXISTS bops_ai_credit_grants_user
  ON public.bops_ai_credit_grants (user_id, created_at DESC);

-- What the user has left, in micros. The first time anyone asks about a user
-- (Bops Cloud's gate or session, or GET /api/bops/plan), it grants the one-time
-- free $5; the unique index keeps that to one grant even on concurrent calls.
CREATE OR REPLACE FUNCTION public.bops_ai_credit_balance(p_user uuid) RETURNS bigint
  LANGUAGE plpgsql SECURITY INVOKER
  SET search_path = public, pg_temp
AS $$
DECLARE
  v_left bigint;
BEGIN
  IF NOT EXISTS (SELECT 1 FROM public.bops_ai_credit_grants WHERE user_id = p_user AND kind = 'free_signup') THEN
    INSERT INTO public.bops_ai_credit_grants (user_id, kind, tier, amount_micros)
    VALUES (p_user, 'free_signup', 'free_bops', 5000000)
    ON CONFLICT (user_id) WHERE kind = 'free_signup' DO NOTHING;
    IF FOUND THEN
      INSERT INTO public.bops_ai_credit AS c (user_id, free_micros) VALUES (p_user, 5000000)
      ON CONFLICT (user_id) DO UPDATE SET free_micros = c.free_micros + 5000000, updated_at = now();
    END IF;
  END IF;
  SELECT (CASE WHEN plan_expires_at > now() THEN plan_micros ELSE 0 END) + free_micros
    INTO v_left
    FROM public.bops_ai_credit WHERE user_id = p_user;
  RETURN COALESCE(v_left, 0);
END
$$;

-- Spend p_micros (at our cost) and return what is left. The allowance pays
-- first, because it expires; the rest comes from the free credit, which may go
-- negative. A spend of zero or less changes nothing.
CREATE OR REPLACE FUNCTION public.bops_ai_credit_spend(p_user uuid, p_micros bigint) RETURNS bigint
  LANGUAGE plpgsql SECURITY INVOKER
  SET search_path = public, pg_temp
AS $$
DECLARE
  v_left bigint;
BEGIN
  IF p_micros IS NULL OR p_micros <= 0 THEN
    SELECT (CASE WHEN plan_expires_at > now() THEN plan_micros ELSE 0 END) + free_micros
      INTO v_left
      FROM public.bops_ai_credit WHERE user_id = p_user;
    RETURN COALESCE(v_left, 0);
  END IF;
  INSERT INTO public.bops_ai_credit AS c (user_id, free_micros) VALUES (p_user, -p_micros)
  ON CONFLICT (user_id) DO UPDATE SET
    plan_micros = CASE WHEN c.plan_expires_at > now() THEN GREATEST(c.plan_micros - p_micros, 0) ELSE 0 END,
    free_micros = c.free_micros
                  - GREATEST(p_micros - CASE WHEN c.plan_expires_at > now() THEN c.plan_micros ELSE 0 END, 0),
    updated_at = now()
  RETURNING (CASE WHEN c.plan_expires_at > now() THEN c.plan_micros ELSE 0 END) + c.free_micros
    INTO v_left;
  RETURN v_left;
END
$$;

-- Grant a paid invoice's AI credit. Returns the micros granted, or NULL when
-- this invoice was granted before. One period is identified by its end:
--   • the first grant of a period resets the allowance to it (no rollover);
--   • a later grant in the same period (the proration invoice of an upgrade)
--     adds what the period has not had yet, so Pro then Max adds $180 and the
--     period never totals more than the highest tier's credit.
-- Serialized per user, so two invoices of one period can't both see "nothing
-- granted yet".
CREATE OR REPLACE FUNCTION public.bops_ai_credit_grant_plan(
  p_user uuid, p_invoice text, p_tier text, p_amount bigint, p_start timestamptz, p_end timestamptz
) RETURNS bigint
  LANGUAGE plpgsql SECURITY INVOKER
  SET search_path = public, pg_temp
AS $$
DECLARE
  v_already bigint;
  v_add     bigint;
  v_id      bigint;
BEGIN
  PERFORM pg_advisory_xact_lock(hashtext('bops_ai_credit:' || p_user::text));
  SELECT COALESCE(sum(amount_micros), 0) INTO v_already
    FROM public.bops_ai_credit_grants
   WHERE user_id = p_user AND kind = 'plan' AND period_end = p_end;
  v_add := GREATEST(p_amount - v_already, 0);
  INSERT INTO public.bops_ai_credit_grants
    (user_id, kind, tier, amount_micros, period_start, period_end, stripe_invoice_id)
  VALUES (p_user, 'plan', p_tier, v_add, p_start, p_end, p_invoice)
  ON CONFLICT (stripe_invoice_id) DO NOTHING
  RETURNING id INTO v_id;
  IF v_id IS NULL THEN
    RETURN NULL;
  END IF;
  IF v_already = 0 THEN
    INSERT INTO public.bops_ai_credit AS c (user_id, plan_micros, plan_expires_at) VALUES (p_user, v_add, p_end)
    ON CONFLICT (user_id) DO UPDATE SET plan_micros = v_add, plan_expires_at = p_end, updated_at = now();
  ELSE
    INSERT INTO public.bops_ai_credit AS c (user_id, plan_micros, plan_expires_at) VALUES (p_user, v_add, p_end)
    ON CONFLICT (user_id) DO UPDATE SET
      plan_micros = (CASE WHEN c.plan_expires_at > now() THEN c.plan_micros ELSE 0 END) + v_add,
      plan_expires_at = p_end,
      updated_at = now();
  END IF;
  RETURN v_add;
END
$$;

DO $$ BEGIN
  IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'bops_app') THEN
    GRANT SELECT, INSERT, UPDATE ON public.bops_ai_credit, public.bops_ai_credit_grants TO bops_app;
    GRANT USAGE ON SEQUENCE public.bops_ai_credit_grants_id_seq TO bops_app;
  END IF;
END $$;

COMMIT;
