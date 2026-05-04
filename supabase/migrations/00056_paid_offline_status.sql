-- migration 00056 — add 'paid_offline' enum value (step 1 of 2).
--
-- Postgres requires a freshly-added enum value to be committed before it
-- can be referenced anywhere else (CHECK constraints, UPDATEs, etc.).
-- So step 1 is enum-only; the CHECK constraints get redefined in 00057
-- and the historical row backfill happens via a separate REST call.
--
-- See 00057_paid_offline_constraints.sql for context.

ALTER TYPE payment_status ADD VALUE IF NOT EXISTS 'paid_offline';
