-- 00075 — let the 'cancelled' settlement status satisfy the two PII /
--         claim CHECK constraints, then backfill the orphaned live rows.
--
-- Background (synth F3/F4; companion to the enum-value migration):
--
-- 00066 first declared 'cancelled' for the payment_status enum but never
-- reached prod (its combined ALTER+COMMENT tripped apply-migration-mgmt's
-- 55P04 guard); 00074 re-applied the bare ADD VALUE so the value now exists
-- in prod. This migration MUST run after 00074 — Postgres requires the new
-- enum value committed before any CHECK / UPDATE can resolve it.
--
-- 00066/00074 added 'cancelled' to the payment_status enum and the application
-- helper (payment-info-notify.service.ts) transitions a settlement row to
-- 'cancelled' when EVERY booking in the group ended up cancelled/no_show.
-- But two CHECK constraints (last redefined in 00057) silently rejected
-- that transition for the exact rows that needed it, and the helper
-- destructured-and-ignored the resulting error — so the rows stayed stuck
-- in a non-terminal status with no visible failure:
--
--   payment_info_submitted_requires_pii — exempts only
--     ('pending_participant','paid_offline'); any OTHER status requires the
--     full PII bundle. A pending row with NO PII (live: sbj14
--     pi=bc1dfa0a) could not move to 'cancelled' because cancelled isn't
--     exempt and it has no PII.
--
--   payment_info_claimed_has_claim — `(status IN ('claimed','paid')) =
--     (claimed_at IS NOT NULL)`. A claimed row carries claimed_at; flipping
--     it to 'cancelled' (live: sbj13 pi=818c13e9, status=claimed, all 5
--     bookings cancelled) while PRESERVING claimed_at (audit trail) made
--     the biconditional false → violation.
--
-- This migration relaxes both constraints in the strictly-loosening
-- direction: 'cancelled' becomes exempt from the PII requirement, and
-- the claim biconditional is rewritten as a one-way implication so a
-- cancelled row may keep or drop claimed_at. Every pre-existing row stays
-- valid (loosening never introduces new violations); the meaning of all
-- non-cancelled statuses is unchanged. paid / paid_offline keep their
-- exact prior semantics — they are never the target of the cancelled
-- transition (the helper's guard excludes them) and a real payment is
-- never reversed.

-- (1) PII requirement — add 'cancelled' to the exempt list. A fully-
--     cancelled group's settlement row was never paid and the participant
--     never submitted PII, so requiring the bundle is wrong; the row is
--     simply dead.
ALTER TABLE participant_payment_info
  DROP CONSTRAINT IF EXISTS payment_info_submitted_requires_pii;

ALTER TABLE participant_payment_info
  ADD CONSTRAINT payment_info_submitted_requires_pii CHECK (
    status IN ('pending_participant', 'paid_offline', 'cancelled')
    OR (
      rrn_cipher IS NOT NULL
      AND bank_name IS NOT NULL
      AND account_number IS NOT NULL
      AND signature_path IS NOT NULL
      AND signed_at IS NOT NULL
      AND bankbook_path IS NOT NULL
    )
  );

-- (2) claimed_at requirement — relax the biconditional to a one-way
--     implication. claimed/paid STILL require claimed_at (the forward
--     direction is preserved: you cannot be claimed/paid without a claim
--     timestamp). All other statuses — including a 'cancelled' row that
--     was previously 'claimed' and retains claimed_at for audit — are
--     unconstrained on claimed_at. Equivalent to the old constraint for
--     every status except that cancelled may now carry a non-null
--     claimed_at (the claimed→cancelled audit-preserving case) and a
--     non-claimed/paid status may carry a stray claimed_at without error.
ALTER TABLE participant_payment_info
  DROP CONSTRAINT IF EXISTS payment_info_claimed_has_claim;

ALTER TABLE participant_payment_info
  ADD CONSTRAINT payment_info_claimed_has_claim CHECK (
    status NOT IN ('claimed', 'paid')
    OR claimed_at IS NOT NULL
  );

-- (3) One-time backfill of the already-orphaned rows lives in a SEPARATE
--     script, NOT in this migration. The backfill is a prod DATA write
--     (mutates participant_payment_info rows) — the auto-mode permission
--     classifier blocks an agent applying it through the migration path,
--     and a one-time data repair is not schema anyway. A fresh-DB replay
--     of this file has nothing to backfill (orphaned rows only exist from
--     the historical bug), so DDL-only here is also the correct shape.
--
--     Run, by the user, AFTER this migration is applied:
--       node --env-file=.env.local \
--         scripts/backfill-cancelled-settlement-rows.mjs
--     It applies exactly the WHERE clause this part-3 used to hold
--     (idempotent, paid-protective, all all-terminal non-settled groups);
--     live targets at write time were 2 rows — sbj13 pi=818c13e9
--     (claimed) and sbj14 pi=bc1dfa0a (pending_participant).
