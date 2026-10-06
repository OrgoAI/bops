-- One-time setup of Bops' place in a Postgres database: its own login (bops_app) and its own schema
-- (bops) inside a database that already exists. Orgo runs it in orgo-web's production database
-- (`orgo`); a self-hoster can use any database. Not run by the app. Run as a superuser, connected to
-- the database Bops goes in:
--   psql "<superuser url to that database>" -v ON_ERROR_STOP=1 -v bops_app_password="$BOPS_APP_PASSWORD" -f db/provision.sql
-- The password comes in as a psql variable so it's never written in this file or the shell history.
-- Safe to run again (it sets the password again).

-- The login: it can sign in, own its schema and nothing else. Bops Cloud keeps a pool of 10.
SELECT NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'bops_app') AS make_role \gset
\if :make_role
CREATE ROLE bops_app LOGIN PASSWORD :'bops_app_password'
  NOSUPERUSER NOCREATEDB NOCREATEROLE NOREPLICATION NOBYPASSRLS
  CONNECTION LIMIT 50;
\else
ALTER ROLE bops_app LOGIN PASSWORD :'bops_app_password';
\endif

-- Keep a stuck query or a forgotten transaction from holding a database other apps share, and keep
-- unqualified names inside Bops' own schema.
ALTER ROLE bops_app SET statement_timeout = '15s';
ALTER ROLE bops_app SET idle_in_transaction_session_timeout = '60s';
ALTER ROLE bops_app SET search_path = bops;

SELECT format('GRANT CONNECT ON DATABASE %I TO bops_app', current_database()) \gexec

-- Bops' tables live here (db/migrations, applied by bops_app). bops_app gets no grants on the other
-- schemas, so it can't read or change the other app's tables.
CREATE SCHEMA IF NOT EXISTS bops AUTHORIZATION bops_app;

-- The one exception to "no grants on the other schemas": Bops' AI credit (cloud/credit.ts; each use
-- is priced in bops.cloud_usage by db/migrations/0007_ai_credit.sql), which lives in orgo-web's
-- schema so orgo-web (its Stripe webhook) and Bops Cloud share one balance. Only
-- its two tables; orgo-web's migration 20261022_bops_plans.sql makes them and grants the same when
-- bops_app exists then. This grants them again for a database where bops_app came after it, and
-- does nothing where they don't exist yet.
SELECT to_regclass('public.bops_ai_credit') IS NOT NULL AND to_regclass('public.bops_ai_credit_grants') IS NOT NULL AS has_ai_credit \gset
\if :has_ai_credit
GRANT SELECT, INSERT, UPDATE ON public.bops_ai_credit, public.bops_ai_credit_grants TO bops_app;
GRANT USAGE ON SEQUENCE public.bops_ai_credit_grants_id_seq TO bops_app;
\endif

-- What bops_app could still reach outside its schema: functions anyone may run. A SECURITY DEFINER
-- one runs as its owner, so each listed here needs a look before Bops Cloud goes live in this
-- database (REVOKE EXECUTE … FROM PUBLIC, and GRANT it back to the roles that use it).
SELECT n.nspname || '.' || p.proname || '(' || pg_get_function_identity_arguments(p.oid) || ')' AS public_security_definer_function,
       pg_get_userbyid(p.proowner) AS runs_as
FROM pg_proc p
JOIN pg_namespace n ON n.oid = p.pronamespace
WHERE p.prosecdef
  AND n.nspname NOT IN ('pg_catalog', 'information_schema', 'bops')
  AND has_function_privilege('bops_app', p.oid, 'EXECUTE')
ORDER BY 1;
