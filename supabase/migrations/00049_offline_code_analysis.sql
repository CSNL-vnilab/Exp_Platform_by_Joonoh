-- Store the LLM/heuristic-extracted offline-experiment metadata next to
-- each experiment row. Single JSONB column keeps the migration small;
-- the shape is enforced at the application layer (zod) rather than via
-- a CHECK constraint so researchers can iterate the schema without an
-- ALTER TABLE.
--
-- Top-level shape (see src/lib/experiments/code-analysis-schema.ts):
--   {
--     code_excerpt:    text | null,           -- raw uploaded source, capped 200KB
--     code_filename:   text | null,
--     code_lang:       text | null,
--     analyzed_at:     iso-timestamp | null,
--     model:           text | null,           -- ollama model tag or "heuristic"
--     heuristic:       CodeAnalysis | null,
--     ai:              CodeAnalysis | null,
--     overrides:       CodeAnalysis (partial) | null,
--     merged:          CodeAnalysis           -- pre-computed view used by the rest of the app
--   }

ALTER TABLE experiments
  ADD COLUMN IF NOT EXISTS offline_code_analysis jsonb;

COMMENT ON COLUMN experiments.offline_code_analysis IS
  'Structured metadata extracted from the experimenter''s offline code (heuristic + AI + user overrides). See src/lib/experiments/code-analysis-schema.ts for the shape.';
