-- migration 00057 — redefine CHECK constraints to carve out 'paid_offline'
-- (step 2 of 2; companion to 00056).
--
-- Motivation: '시간 추정 실험 1' (TimeExp1) ran for many participants
-- (Sbj1~9) before this platform existed. 행정 disbursed those participation
-- fees through the lab's pre-platform workflow, so the participants
-- never filled the on-site PII form. Backfill happily created
-- pending_participant rows for them, but flipping to a terminal status
-- was blocked by payment_info_submitted_requires_pii.
--
-- Adding a third terminal value 'paid_offline' that is exempt from the
-- PII requirement is cleaner than (a) stuffing fake values, (b) deleting
-- the rows, or (c) widening 'paid' to mean both online + offline (which
-- would muddle accounting reports).
--
-- 'paid_offline' is also exempt from claimed_at: these rows never went
-- through the in-platform claim workflow.

ALTER TABLE participant_payment_info
  DROP CONSTRAINT IF EXISTS payment_info_submitted_requires_pii;

ALTER TABLE participant_payment_info
  ADD CONSTRAINT payment_info_submitted_requires_pii CHECK (
    status IN ('pending_participant', 'paid_offline')
    OR (
      rrn_cipher IS NOT NULL
      AND bank_name IS NOT NULL
      AND account_number IS NOT NULL
      AND signature_path IS NOT NULL
      AND signed_at IS NOT NULL
      AND bankbook_path IS NOT NULL
    )
  );

ALTER TABLE participant_payment_info
  DROP CONSTRAINT IF EXISTS payment_info_claimed_has_claim;

ALTER TABLE participant_payment_info
  ADD CONSTRAINT payment_info_claimed_has_claim CHECK (
    (status IN ('claimed', 'paid'))
      = (claimed_at IS NOT NULL)
  );
