-- 00077 — experiment_kind: classify each experiment as 'external' or 'pilot'.
--
-- 사용자 요청 (2026-06-17): 실험 카테고리를 두 가지로 구분한다.
--   - 'external' (기본): 기존 실험과 완전히 동일한 양식 — IRB, 참여비·정산,
--     Notion 연동을 모두 사용한다. 이미 생성된 모든 실험(TimeExp1/2 등)은
--     이 카테고리로 분류된다.
--   - 'pilot': IRB / 참여자비 / Notion 연동 단계를 생략하는 간소 양식.
--     나머지 일정·세션·실행방식 등은 external 과 동일하다.
--
-- The NOT NULL DEFAULT 'external' backfills every pre-existing experiment row
-- to 'external' as part of the ADD COLUMN (no separate UPDATE needed), exactly
-- matching "기존 실험은 외부로 백필". A named CHECK keeps the value domain to the
-- two allowed kinds. Strictly additive — no behavior change for existing rows
-- (external == the prior always-full-form behavior). NOTIFY refreshes the
-- PostgREST schema cache so supabase-js resolves the column immediately.

ALTER TABLE experiments
  ADD COLUMN IF NOT EXISTS experiment_kind text NOT NULL DEFAULT 'external'
    CONSTRAINT experiments_experiment_kind_check
    CHECK (experiment_kind IN ('external', 'pilot'));

COMMENT ON COLUMN experiments.experiment_kind IS
  'Experiment category. external (default): full form — IRB, participation fee/settlement, and Notion mirroring all apply (the behavior every pre-2026-06-17 experiment had). pilot: a lightweight experiment that skips IRB, participation fee, and Notion — seedPaymentInfo already no-ops when participation_fee<=0, and the status-route Notion mirror is gated on kind<>pilot.';

NOTIFY pgrst, 'reload schema';
