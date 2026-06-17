-- 00076 — re-apply 00065's column adds that the ledger falsely records as
--         applied (migration drift / renumber hazard).
--
-- ROOT CAUSE (2026-06-17): supabase_migrations.schema_migrations contains a
-- row version='00065', so `supabase db push` treats 00065 as applied and
-- skips it — but the experiments.payment_link_auto_send column and the
-- participant_payment_info.amount_overridden_by/at columns it declares are
-- ABSENT from prod (verified via information_schema). The file now numbered
-- 00065 carries the header "-- 00063 —", i.e. it was renumbered into a
-- version slot the ledger had already marked done under different content, so
-- its DDL never ran. Symptom: POST /api/experiments insert fails with
-- PGRST "Could not find the 'payment_link_auto_send' column of 'experiments'
-- in the schema cache" — every form-based experiment creation was blocked.
--
-- This migration is the strictly-additive, idempotent re-application of those
-- column adds. The two backfill rows 00065 also did (stamp amount_overridden_at
-- for amount_overridden=true rows) are a DATA write and are NOT included here
-- (the auto-mode classifier blocks agent prod data writes via migrations, and
-- the UI already falls back to "수정됨" when amount_overridden_at is null) — a
-- companion script handles it if ever needed.
--
-- Every change is ADD COLUMN IF NOT EXISTS with a NOT NULL DEFAULT or nullable
-- type, so it introduces no new constraint violations and preserves existing
-- behavior (payment_link_auto_send defaults true = the prior always-auto-send
-- semantics). A NOTIFY pgrst reload at the end refreshes PostgREST's schema
-- cache so supabase-js sees the columns immediately.

-- 1) experiments.payment_link_auto_send — the experiment-creation blocker.
ALTER TABLE experiments
  ADD COLUMN IF NOT EXISTS payment_link_auto_send boolean NOT NULL DEFAULT true;

COMMENT ON COLUMN experiments.payment_link_auto_send IS
  'When true (default), notifyPaymentInfoIfReady auto-sends the payment-info request email the moment every booking in a group flips to completed. When false, the researcher must explicitly trigger the send from the payment-panel — used when the experiment is prone to session-count changes (extension / early stop) and the amount needs a manual check before going out.';

-- 2) participant_payment_info.amount_overridden_by/at — audit columns the
--    amount-override workflow (PATCH /amount endpoint + payment panel) reads
--    and writes. Missing → that feature was silently broken too.
ALTER TABLE participant_payment_info
  ADD COLUMN IF NOT EXISTS amount_overridden_by uuid REFERENCES profiles(id) ON DELETE SET NULL,
  ADD COLUMN IF NOT EXISTS amount_overridden_at timestamptz;

COMMENT ON COLUMN participant_payment_info.amount_overridden_by IS
  'profiles.id of the researcher/admin who last changed amount_krw via the PATCH /amount endpoint. NULL when amount_krw is still the auto-seeded value from experiments.participation_fee.';
COMMENT ON COLUMN participant_payment_info.amount_overridden_at IS
  'Timestamp of the last manual amount_krw change. Together with amount_overridden_by, gives a simple audit trail for 행정 정산 분쟁 추적.';

-- 3) Refresh PostgREST's schema cache so the new columns are immediately
--    resolvable by the supabase-js client (the PGRST cache-miss was the
--    user-visible symptom).
NOTIFY pgrst, 'reload schema';
