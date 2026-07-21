-- 00081 — drop experiments.offline_code_analysis (offline code-analysis feature removed).
--
-- The "실험 코드 분석" (offline code analysis) feature — which ingested
-- experiment source and used LLMs (Ollama / Anthropic) to extract parameters
-- and conditions — has been removed wholesale (user directive: the per-run
-- API cost was prohibitive). Every reader/writer of this column was deleted
-- or edited in the same release:
--   • src/app/api/experiments/[experimentId]/offline-code/route.ts (deleted)
--   • src/app/api/experiments/code-analysis/** (deleted)
--   • src/lib/experiments/code-analysis-schema.ts (deleted)
--   • src/components/offline-code-analyzer.tsx (deleted)
--   • src/components/experiment-form.tsx, src/types/database.ts,
--     duplicate/route.ts (edited — all references removed)
--
-- DESTRUCTIVE, deploy-before-drop: this migration is applied ONLY after the
-- code above is out of production, so no live query still selects the column
-- (verified: the offline-code route's `.update({ offline_code_analysis })`
-- and every `.select()` touching it are gone). The 4 rows that carried a
-- cached analysis are intentionally discarded ("아예 삭제").
--
-- The historical 00049_offline_code_analysis.sql that CREATED the column is
-- left on disk untouched (migrations are append-only).
--
-- Idempotent: DROP COLUMN IF EXISTS is a no-op on re-apply. NOTIFY pgrst
-- refreshes PostgREST's schema cache so supabase-js stops advertising it.

ALTER TABLE experiments DROP COLUMN IF EXISTS offline_code_analysis;

NOTIFY pgrst, 'reload schema';
