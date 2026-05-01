// Single source of truth for the offline-experiment-code analysis payload.
// The same shape is produced by the heuristic regex parser, by the AI
// parser (Qwen via Ollama), and rendered in the OfflineCodeAnalyzer UI.
// The DB column `experiments.offline_code_analysis` stores
// `{ source, code_excerpt, code_filename, code_lang, analyzed_at,
//    model, heuristic, ai, overrides, merged }` — `merged` is the final
// view (overrides ∘ ai ∘ heuristic) and is what other parts of the
// system read.

import { z } from "zod/v4";

export const SUPPORTED_LANGS = [
  "matlab",
  "python",
  "javascript",
  "typescript",
  "r",
  "other",
] as const;

export type CodeLang = (typeof SUPPORTED_LANGS)[number];

export const SUPPORTED_FRAMEWORKS = [
  "psychopy",
  "jspsych",
  "psychtoolbox",
  "lab.js",
  "opensesame",
  "neurobs-presentation",
  "custom",
  "unknown",
] as const;

export type Framework = (typeof SUPPORTED_FRAMEWORKS)[number];

const intOrNull = z.number().int().min(0).max(1_000_000).nullable();
const numOrNull = z.number().min(0).max(1_000_000).nullable();
// Generous string caps with auto-truncation: the model occasionally
// emits long descriptive labels (e.g. multi-line `applies_when`,
// stimulus formula `seed`). Hard-rejecting the whole record on a few
// extra characters wastes a 200-second analysis run, so we accept
// anything stringy and trim on parse.
const shortStr = z.string().max(2000).transform((s) => s.slice(0, 500));
const longStr = z.string().max(20000).transform((s) => s.slice(0, 4000));

export const FactorSchema = z.object({
  name: z.string().min(1).max(64),
  type: z.enum(["categorical", "continuous", "ordinal"]).catch("categorical").default("categorical"),
  levels: z.array(shortStr).max(64).catch([]).default([]),
  // role: where in the design this IV sits.
  //   between_subject — varies across participants (e.g. group, age)
  //   within_subject  — varies within a participant across sessions/days
  //   within_session  — varies within a single session (block-kind, trial type)
  //   per_trial       — varies per trial (typically continuous like SOA, contrast)
  //   derived         — *not* an IV — a constant or function of others.
  //                     The model is instructed to *prefer* parameters[]
  //                     for these but if it slipped one in here, this
  //                     flag lets the UI surface the mistake.
  role: z
    .enum([
      "between_subject",
      "within_subject",
      "within_session",
      "per_trial",
      "derived",
      "unknown",
    ])
    .catch("unknown")
    .optional()
    .default("unknown"),
  description: longStr.nullable().default(null),
  line_hint: z.union([z.number().int().min(0).max(1_000_000), z.string().max(200)]).nullable().default(null),
});

export type Factor = z.infer<typeof FactorSchema>;

export const ParameterSchema = z.object({
  name: z.string().min(1).max(64),
  type: z.enum(["number", "string", "boolean", "array", "other"]).catch("other").default("other"),
  default: z.string().max(200).nullable().default(null),
  unit: shortStr.nullable().default(null),
  // Provenance tag: "constant" (single value used throughout), "vector"
  // (varies per block — block-kind candidate), "expression" (computed
  // from other vars), "input" (read from user/file at runtime). Helps
  // the UI distinguish "tfeedback = 1.0" (constant timing) from
  // "par.StairTrainTest = [1 1 2 2 3 3]" (block-kind partition).
  shape: z
    .enum(["constant", "vector", "expression", "input", "unknown"])
    .catch("unknown")
    .optional()
    .default("unknown"),
  description: longStr.nullable().default(null),
  line_hint: z.union([z.number().int().min(0).max(1_000_000), z.string().max(200)]).nullable().default(null),
});

export type Parameter = z.infer<typeof ParameterSchema>;

export const ConditionSchema = z.object({
  label: z.string().min(1).max(64),
  factor_assignments: z.record(z.string(), z.string()).default({}),
  description: longStr.nullable().default(null),
});

export type Condition = z.infer<typeof ConditionSchema>;

export const SavedVariableSchema = z.object({
  name: z.string().min(1).max(64),
  format: z.enum([
    "int",
    "float",
    "string",
    "bool",
    "array",
    "matrix",
    "struct",
    "csv-row",
    "json",
    "other",
  ]).catch("other").default("other"),
  unit: shortStr.nullable().default(null),
  sink: shortStr.nullable().default(null), // "data.csv", "results.mat", "ExpInfo.dat"
  description: longStr.nullable().default(null),
  line_hint: z.union([z.number().int().min(0).max(1_000_000), z.string().max(200)]).nullable().default(null),
});

export type SavedVariable = z.infer<typeof SavedVariableSchema>;

// One “phase” of the experiment — used when a single experiment session
// has multiple block kinds (training/practice/main/test/transfer/stair)
// or when n_blocks/n_trials varies by day. TimeExp1 is the canonical
// example: Day 1 = 10 training blocks (dist=U), Day 2~5 = 12 test
// blocks (dist=A or B). Without this field the analyzer can only show
// a single integer for n_blocks and would force an artificial choice.
export const BlockPhaseSchema = z.object({
  kind: z
    .enum([
      "training",
      "practice",
      "stair",
      "main",
      "test",
      "transfer",
      "rest",
      "demo",
      "other",
    ])
    .catch("other")
    .default("other"),
  // Human-readable label, e.g. "Day1 training", "Day2~5 test (dist=A/B)"
  label: shortStr.nullable().default(null),
  n_blocks: intOrNull.default(null),
  n_trials_per_block: intOrNull.default(null),
  // Optional day range this phase applies to ("1", "2-5", "1,3,5")
  day_range: shortStr.nullable().default(null),
  // Free-form: stimulus distribution / condition / dist value used in this phase
  applies_when: longStr.nullable().default(null),
  description: longStr.nullable().default(null),
});

export type BlockPhase = z.infer<typeof BlockPhaseSchema>;

// Experiment genre — orthogonal to language/framework. Helps the
// analyzer prioritise *which* IVs and saved variables to look hardest
// for, e.g. psychophysics → contrast/duration/threshold; estimation →
// accuracy/bias/precision; decision → choice/RT/confidence; etc.
export const SUPPORTED_GENRES = [
  "psychophysics",
  "gamified",
  "estimation",
  "decision",
  "retrieval",
  "search",
  "perception",
  "memory",
  "motor",
  "social",
  "language",
  "categorization",
  "imagery",
  "attention",
  "other",
] as const;
export type DomainGenre = (typeof SUPPORTED_GENRES)[number];

export const AnalysisMetaSchema = z.object({
  language: z.enum(SUPPORTED_LANGS).catch("other").default("other"),
  framework: z.enum(SUPPORTED_FRAMEWORKS).catch("unknown").default("unknown"),
  // High-level experimental paradigm — orthogonal to framework.
  // The model picks one based on the task structure (stimulus →
  // response loop) and the saved-variable shape; researchers can
  // override.
  domain_genre: z.enum(SUPPORTED_GENRES).catch("other").optional().default("other"),
  // Single-value rollups (kept for back-compat + the simple case where
  // every phase has the same n_blocks/n_trials).
  n_blocks: intOrNull.default(null),
  n_trials_per_block: intOrNull.default(null),
  total_trials: intOrNull.default(null),
  estimated_duration_min: numOrNull.default(null),
  seed: shortStr.nullable().default(null),
  // Phase decomposition — when set, takes precedence over the singletons
  // above. Empty array means "single phase, see n_blocks above".
  block_phases: z.array(BlockPhaseSchema).max(20).catch([]).default([]),
  // Free-form design-matrix description for between-subject /
  // counterbalance schemes that don't fit the conditions array
  // (e.g. "subjNum mod 4 → AABB / ABBA / BABA / BBAA pattern across days").
  design_matrix: longStr.nullable().default(null),
  // free-form summary the AI / heuristic can use to convey intent
  summary: longStr.nullable().default(null),
});

export type AnalysisMeta = z.infer<typeof AnalysisMetaSchema>;

export const CodeAnalysisSchema = z.object({
  meta: AnalysisMetaSchema.default({} as never),
  factors: z.array(FactorSchema).max(50).catch([]).default([]),
  parameters: z.array(ParameterSchema).max(100).catch([]).default([]),
  conditions: z.array(ConditionSchema).max(200).catch([]).default([]),
  saved_variables: z.array(SavedVariableSchema).max(100).catch([]).default([]),
  warnings: z.array(z.string().max(500)).max(50).catch([]).default([]),
});

export type CodeAnalysis = z.infer<typeof CodeAnalysisSchema>;

// User-overrides shape: every field is optional, AND `meta` is itself
// shallow-partial. zod's `.partial()` only makes the top-level keys
// optional — the inner `meta` would remain fully-required, which would
// reject realistic patches like `{ meta: { n_blocks: 5 } }`. We declare
// the override shape explicitly here.
export const CodeAnalysisOverridesSchema = z.object({
  meta: AnalysisMetaSchema.partial().optional(),
  factors: z.array(FactorSchema).max(50).optional(),
  parameters: z.array(ParameterSchema).max(100).optional(),
  conditions: z.array(ConditionSchema).max(200).optional(),
  saved_variables: z.array(SavedVariableSchema).max(100).optional(),
  warnings: z.array(z.string().max(500)).max(50).optional(),
});

export type CodeAnalysisOverrides = z.infer<typeof CodeAnalysisOverridesSchema>;

// --- Persisted shape on experiments.offline_code_analysis ---------------

export const ProvenanceSchema = z.enum(["heuristic", "ai", "user", "merged"]);
export type Provenance = z.infer<typeof ProvenanceSchema>;

export const OfflineCodeAnalysisRowSchema = z.object({
  // raw uploaded source — capped to 200KB to keep the row small
  code_excerpt: z.string().max(200_000).nullable().default(null),
  code_filename: shortStr.nullable().default(null),
  code_lang: z.enum(SUPPORTED_LANGS).nullable().default(null),
  analyzed_at: z.string().nullable().default(null), // ISO
  model: shortStr.nullable().default(null),         // ollama model used (or "heuristic")
  // each layer keeps its own copy so the user can re-run or revert
  heuristic: CodeAnalysisSchema.nullable().default(null),
  ai: CodeAnalysisSchema.nullable().default(null),
  // user overrides — same shape; missing keys mean "use the AI/heuristic value"
  overrides: CodeAnalysisOverridesSchema.nullable().default(null),
  // pre-computed merge (overrides ∘ ai ∘ heuristic). The UI reads this.
  merged: CodeAnalysisSchema,
});

export type OfflineCodeAnalysisRow = z.infer<typeof OfflineCodeAnalysisRowSchema>;

// JSON-Schema (loose) text for prompting Qwen via Ollama format=json.
// Kept in sync with CodeAnalysisSchema by hand — Ollama doesn't accept a
// zod object so we serialise the contract as a small JSON-Schema string.
export const CODE_ANALYSIS_JSON_SCHEMA_HINT = `{
  "type": "object",
  "required": ["meta", "factors", "parameters", "conditions", "saved_variables", "warnings"],
  "properties": {
    "meta": {
      "type": "object",
      "properties": {
        "language":     { "enum": ${JSON.stringify(SUPPORTED_LANGS)} },
        "framework":    { "enum": ${JSON.stringify(SUPPORTED_FRAMEWORKS)} },
        "domain_genre": { "enum": ${JSON.stringify(SUPPORTED_GENRES)} },
        "n_blocks":              { "type": ["integer","null"] },
        "n_trials_per_block":    { "type": ["integer","null"] },
        "total_trials":          { "type": ["integer","null"] },
        "estimated_duration_min":{ "type": ["number","null"]  },
        "seed":                  { "type": ["string","null"]  },
        "summary":               { "type": ["string","null"]  },
        "design_matrix":         { "type": ["string","null"]  },
        "block_phases": {
          "type": "array",
          "items": {
            "type": "object",
            "required": ["kind"],
            "properties": {
              "kind":               { "enum": ["training","practice","stair","main","test","transfer","rest","demo","other"] },
              "label":              { "type": ["string","null"] },
              "n_blocks":           { "type": ["integer","null"] },
              "n_trials_per_block": { "type": ["integer","null"] },
              "day_range":          { "type": ["string","null"] },
              "applies_when":       { "type": ["string","null"] },
              "description":        { "type": ["string","null"] }
            }
          }
        }
      }
    },
    "factors": {
      "type": "array",
      "items": {
        "type": "object",
        "required": ["name","levels","role"],
        "properties": {
          "name":        { "type": "string" },
          "type":        { "enum": ["categorical","continuous","ordinal"] },
          "levels":      { "type": "array", "items": { "type": "string" } },
          "role":        { "enum": ["between_subject","within_subject","within_session","per_trial","derived","unknown"] },
          "description": { "type": ["string","null"] },
          "line_hint":   { "type": ["string","integer","null"] }
        }
      }
    },
    "parameters": {
      "type": "array",
      "items": {
        "type": "object",
        "required": ["name","shape"],
        "properties": {
          "name":        { "type": "string" },
          "type":        { "enum": ["number","string","boolean","array","other"] },
          "default":     { "type": ["string","null"] },
          "unit":        { "type": ["string","null"] },
          "shape":       { "enum": ["constant","vector","expression","input","unknown"] },
          "description": { "type": ["string","null"] },
          "line_hint":   { "type": ["string","integer","null"] }
        }
      }
    },
    "conditions": {
      "type": "array",
      "items": {
        "type": "object",
        "required": ["label","factor_assignments"],
        "properties": {
          "label":              { "type": "string" },
          "factor_assignments": { "type": "object", "additionalProperties": { "type": "string" } },
          "description":        { "type": ["string","null"] }
        }
      }
    },
    "saved_variables": {
      "type": "array",
      "items": {
        "type": "object",
        "required": ["name","format"],
        "properties": {
          "name":        { "type": "string" },
          "format":      { "enum": ["int","float","string","bool","array","matrix","struct","csv-row","json","other"] },
          "unit":        { "type": ["string","null"] },
          "sink":        { "type": ["string","null"] },
          "description": { "type": ["string","null"] },
          "line_hint":   { "type": ["string","integer","null"] }
        }
      }
    },
    "warnings": { "type": "array", "items": { "type": "string" } }
  }
}`;

// Build a final view by layering: heuristic → ai → overrides.
// For each list field, items are matched by `name`/`label` so an
// override of one factor does not blow away the rest.
export function mergeAnalysis(
  heuristic: CodeAnalysis | null | undefined,
  ai: CodeAnalysis | null | undefined,
  overrides: CodeAnalysisOverrides | null | undefined,
): CodeAnalysis {
  const empty: CodeAnalysis = CodeAnalysisSchema.parse({});
  const base = heuristic ?? empty;

  // When the AI returns a substantive parameter set, treat *generic*
  // heuristic captures (no description, no unit, no concrete default)
  // as noise — drop them. This avoids the UI piling `baseDir` etc on
  // top of the AI's curated `lentrial`/`tprecue`. Heuristic items the
  // AI re-affirmed (same name) keep both descriptions via mergeByKey.
  //
  // Critical: a heuristic param with a non-null `default` is *always*
  // kept — that's a literal value the regex parser actually saw in
  // code, and dropping it would lose researcher data on AI runs that
  // happened not to echo the same name (review item #4).
  const aiHasParams = (ai?.parameters?.length ?? 0) >= 3;
  const heurParams = aiHasParams
    ? (base.parameters ?? []).filter((p) => {
        const aiKnows = ai?.parameters?.some((a) => a.name === p.name);
        if (aiKnows) return true;
        // keep if heuristic provided concrete signal: literal value,
        // unit, or human-meaningful description.
        if (p.default != null) return true;
        if (p.unit || p.description) return true;
        return false;
      })
    : base.parameters;

  const layered: CodeAnalysis = {
    meta: { ...base.meta, ...(ai?.meta ?? {}), ...(overrides?.meta ?? {}) },
    factors: mergeByKey(base.factors, ai?.factors, overrides?.factors, (f) => f.name),
    parameters: mergeByKey(heurParams, ai?.parameters, overrides?.parameters, (p) => p.name),
    conditions: mergeByKey(base.conditions, ai?.conditions, overrides?.conditions, (c) => c.label),
    saved_variables: mergeByKey(base.saved_variables, ai?.saved_variables, overrides?.saved_variables, (s) => s.name),
    warnings: dedupe([
      ...(base.warnings ?? []),
      ...((ai?.warnings) ?? []),
      ...((overrides?.warnings) ?? []),
    ]),
  };
  return layered;
}

function mergeByKey<T extends object>(
  base: T[] | undefined,
  ai: T[] | undefined,
  overrides: T[] | undefined,
  key: (t: T) => string,
): T[] {
  const out = new Map<string, T>();
  for (const t of base ?? []) out.set(key(t), t);
  for (const t of ai ?? []) {
    const k = key(t);
    out.set(k, { ...(out.get(k) ?? {} as T), ...t });
  }
  for (const t of overrides ?? []) {
    const k = key(t);
    out.set(k, { ...(out.get(k) ?? {} as T), ...t });
  }
  return Array.from(out.values());
}

function dedupe<T>(xs: T[]): T[] {
  const seen = new Set<string>();
  const out: T[] = [];
  for (const x of xs) {
    const k = JSON.stringify(x);
    if (seen.has(k)) continue;
    seen.add(k);
    out.push(x);
  }
  return out;
}
