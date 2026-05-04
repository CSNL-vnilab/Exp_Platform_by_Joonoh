// Client-side parser + applier for the chatbot's <patch>{...}</patch>
// blocks. Each patch is a structured edit on the user-overrides map.
// Kept framework-free so it can be unit-tested or reused elsewhere.
//
// Defence-in-depth:
//   1. parsePatchBlocks()  → JSON-decode each <patch> block and
//      validate against PatchSchema (a strict zod discriminated union
//      mirroring PATCH_GRAMMAR). Invalid ops, unknown enums, or
//      mistyped values are surfaced as a Korean error string the UI
//      renders next to the rejected block.
//   2. applyPatch()        → after merging the patch into the overrides
//      map, re-parse the result through CodeAnalysisOverridesSchema.
//      The fresh validation provides a safety net against any future
//      bug in the merge logic that might let an invariant slip — if
//      the parse fails the patch is rejected and the previous state is
//      returned untouched.

import { z } from "zod/v4";
import {
  CodeAnalysisOverridesSchema,
  SUPPORTED_FRAMEWORKS,
  SUPPORTED_LANGS,
  type CodeAnalysisOverrides,
  type Condition,
  type Factor,
  type Parameter,
  type SavedVariable,
} from "./code-analysis-schema";

// ---- enums (kept in sync with code-analysis-schema.ts) ----------------
//
// We mirror the schema enums *strictly* here (no .catch()/.default())
// because patches arrive directly from the chatbot — we want bad model
// output to be visibly rejected, not silently coerced.

const FACTOR_TYPES = ["categorical", "continuous", "ordinal"] as const;
const FACTOR_ROLES = [
  "between_subject",
  "within_subject",
  "within_session",
  "per_trial",
  "derived",
  "unknown",
] as const;
const PARAMETER_TYPES = ["number", "string", "boolean", "array", "other"] as const;
const PARAMETER_SHAPES = ["constant", "vector", "expression", "input", "unknown"] as const;
const SAVED_FORMATS = [
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
] as const;

const SET_META_FIELDS = [
  "n_blocks",
  "n_trials_per_block",
  "total_trials",
  "estimated_duration_min",
  "seed",
  "summary",
  "framework",
  "language",
] as const;

const lineHintSchema = z
  .union([z.number().int().min(0).max(1_000_000), z.string().max(200)])
  .nullable();

// ---- per-op schemas ---------------------------------------------------

const SetMetaPatchSchema = z
  .object({
    op: z.literal("set_meta"),
    field: z.enum(SET_META_FIELDS),
    value: z.unknown(),
  })
  .superRefine((data, ctx) => {
    const fail = (msg: string) =>
      ctx.addIssue({ code: "custom", path: ["value"], message: msg });
    switch (data.field) {
      case "n_blocks":
      case "n_trials_per_block":
      case "total_trials": {
        const r = z
          .number()
          .int()
          .min(0)
          .max(1_000_000)
          .nullable()
          .safeParse(data.value);
        if (!r.success) fail(`${data.field} 은(는) 0 이상 정수 또는 null 이어야 합니다`);
        return;
      }
      case "estimated_duration_min": {
        const r = z.number().min(0).max(1_000_000).nullable().safeParse(data.value);
        if (!r.success) fail("estimated_duration_min 은(는) 0 이상 숫자 또는 null 이어야 합니다");
        return;
      }
      case "seed":
      case "summary": {
        const r = z.string().max(20_000).nullable().safeParse(data.value);
        if (!r.success) fail(`${data.field} 은(는) 문자열 또는 null 이어야 합니다`);
        return;
      }
      case "framework": {
        const r = z.enum(SUPPORTED_FRAMEWORKS).nullable().safeParse(data.value);
        if (!r.success)
          fail(`framework 은(는) ${SUPPORTED_FRAMEWORKS.join("|")} 또는 null 이어야 합니다`);
        return;
      }
      case "language": {
        const r = z.enum(SUPPORTED_LANGS).nullable().safeParse(data.value);
        if (!r.success)
          fail(`language 은(는) ${SUPPORTED_LANGS.join("|")} 또는 null 이어야 합니다`);
        return;
      }
    }
  });

const UpsertFactorPatchSchema = z.object({
  op: z.literal("upsert_factor"),
  name: z.string().min(1).max(64),
  type: z.enum(FACTOR_TYPES).optional(),
  levels: z.array(z.string().max(2000)).max(64).optional(),
  role: z.enum(FACTOR_ROLES).optional(),
  description: z.string().max(20_000).nullable().optional(),
  line_hint: lineHintSchema.optional(),
});

const RemoveFactorPatchSchema = z.object({
  op: z.literal("remove_factor"),
  name: z.string().min(1).max(64),
});

const UpsertParameterPatchSchema = z.object({
  op: z.literal("upsert_parameter"),
  name: z.string().min(1).max(64),
  type: z.enum(PARAMETER_TYPES).optional(),
  default: z.string().max(200).nullable().optional(),
  unit: z.string().max(2000).nullable().optional(),
  shape: z.enum(PARAMETER_SHAPES).optional(),
  description: z.string().max(20_000).nullable().optional(),
  line_hint: lineHintSchema.optional(),
});

const RemoveParameterPatchSchema = z.object({
  op: z.literal("remove_parameter"),
  name: z.string().min(1).max(64),
});

const UpsertConditionPatchSchema = z.object({
  op: z.literal("upsert_condition"),
  label: z.string().min(1).max(64),
  factor_assignments: z.record(z.string(), z.string()).optional(),
  description: z.string().max(20_000).nullable().optional(),
});

const RemoveConditionPatchSchema = z.object({
  op: z.literal("remove_condition"),
  label: z.string().min(1).max(64),
});

const UpsertSavedVariablePatchSchema = z.object({
  op: z.literal("upsert_saved_variable"),
  name: z.string().min(1).max(64),
  format: z.enum(SAVED_FORMATS).optional(),
  unit: z.string().max(2000).nullable().optional(),
  sink: z.string().max(2000).nullable().optional(),
  description: z.string().max(20_000).nullable().optional(),
  line_hint: lineHintSchema.optional(),
});

const RemoveSavedVariablePatchSchema = z.object({
  op: z.literal("remove_saved_variable"),
  name: z.string().min(1).max(64),
});

// op → schema (manual dispatch — set_meta uses superRefine which
// can't sit inside z.discriminatedUnion, so we pick the right schema
// by `op` ourselves and report a tight error message).
const PATCH_SCHEMAS = {
  set_meta: SetMetaPatchSchema,
  upsert_factor: UpsertFactorPatchSchema,
  remove_factor: RemoveFactorPatchSchema,
  upsert_parameter: UpsertParameterPatchSchema,
  remove_parameter: RemoveParameterPatchSchema,
  upsert_condition: UpsertConditionPatchSchema,
  remove_condition: RemoveConditionPatchSchema,
  upsert_saved_variable: UpsertSavedVariablePatchSchema,
  remove_saved_variable: RemoveSavedVariablePatchSchema,
} as const;

const ALL_OPS = Object.keys(PATCH_SCHEMAS) as ReadonlyArray<keyof typeof PATCH_SCHEMAS>;

export type Patch =
  | z.infer<typeof SetMetaPatchSchema>
  | z.infer<typeof UpsertFactorPatchSchema>
  | z.infer<typeof RemoveFactorPatchSchema>
  | z.infer<typeof UpsertParameterPatchSchema>
  | z.infer<typeof RemoveParameterPatchSchema>
  | z.infer<typeof UpsertConditionPatchSchema>
  | z.infer<typeof RemoveConditionPatchSchema>
  | z.infer<typeof UpsertSavedVariablePatchSchema>
  | z.infer<typeof RemoveSavedVariablePatchSchema>;

export type PatchValidationResult =
  | { ok: true; patch: Patch }
  | { ok: false; error: string };

function humaniseIssue(issue: z.core.$ZodIssue): string {
  // zod issues have a `path` (e.g. ["value"]) and a `message`. Render
  // them as "field: message" so the UI can show field-targeted errors.
  const path = (issue.path ?? []).join(".");
  const msg = issue.message ?? "잘못된 값";
  return path ? `${path}: ${msg}` : msg;
}

export function validatePatch(input: unknown): PatchValidationResult {
  if (typeof input !== "object" || input == null) {
    return { ok: false, error: "patch 는 object 여야 합니다" };
  }
  const op = (input as Record<string, unknown>).op;
  if (typeof op !== "string") {
    return { ok: false, error: "op 필드가 누락되었습니다" };
  }
  if (!(op in PATCH_SCHEMAS)) {
    return {
      ok: false,
      error: `알 수 없는 op "${op}" — 사용 가능: ${ALL_OPS.join(", ")}`,
    };
  }
  const schema = PATCH_SCHEMAS[op as keyof typeof PATCH_SCHEMAS];
  const r = schema.safeParse(input);
  if (!r.success) {
    const detail = r.error.issues.slice(0, 3).map(humaniseIssue).join(" · ");
    return { ok: false, error: detail || "검증 실패" };
  }
  return { ok: true, patch: r.data as Patch };
}

export interface ParsedPatchBlock {
  raw: string;
  patch: Patch | null;
  error: string | null;
}

const PATCH_RE = /<patch>\s*([\s\S]*?)\s*<\/patch>/g;

export function parsePatchBlocks(text: string): {
  prose: string;
  blocks: ParsedPatchBlock[];
} {
  const blocks: ParsedPatchBlock[] = [];
  let prose = "";
  let lastIndex = 0;
  let match: RegExpExecArray | null;
  while ((match = PATCH_RE.exec(text)) !== null) {
    prose += text.slice(lastIndex, match.index);
    let patch: Patch | null = null;
    let error: string | null = null;
    let obj: unknown = null;
    try {
      obj = JSON.parse(match[1]);
    } catch (e) {
      error = `JSON 형식 오류: ${e instanceof Error ? e.message : String(e)}`;
    }
    if (!error) {
      const r = validatePatch(obj);
      if (r.ok) patch = r.patch;
      else error = r.error;
    }
    blocks.push({ raw: match[1], patch, error });
    lastIndex = match.index + match[0].length;
  }
  prose += text.slice(lastIndex);
  return { prose, blocks };
}

export interface ApplyPatchResult {
  next: CodeAnalysisOverrides;
  error?: string;
}

// Apply one patch into a CodeAnalysisOverrides (the user-overrides
// shape). Returns `{ next }` on success, or `{ next: <unchanged>, error }`
// if the post-merge re-parse fails. Pure — does not mutate `overrides`.
export function applyPatch(
  overrides: CodeAnalysisOverrides,
  patch: Patch,
): ApplyPatchResult {
  const next: CodeAnalysisOverrides = {
    ...overrides,
    meta: { ...(overrides.meta ?? {}) },
    factors: [...(overrides.factors ?? [])],
    parameters: [...(overrides.parameters ?? [])],
    conditions: [...(overrides.conditions ?? [])],
    saved_variables: [...(overrides.saved_variables ?? [])],
    warnings: [...(overrides.warnings ?? [])],
  };

  switch (patch.op) {
    case "set_meta":
      (next.meta as Record<string, unknown>)[patch.field] = patch.value as never;
      break;
    case "upsert_factor": {
      const i = next.factors!.findIndex((f) => f.name === patch.name);
      const existing = i >= 0 ? next.factors![i] : undefined;
      const merged: Factor = {
        name: patch.name,
        type: patch.type ?? existing?.type ?? "categorical",
        levels: patch.levels ?? existing?.levels ?? [],
        role: patch.role ?? existing?.role ?? "unknown",
        description:
          patch.description !== undefined
            ? patch.description
            : existing?.description ?? null,
        line_hint:
          patch.line_hint !== undefined
            ? patch.line_hint
            : existing?.line_hint ?? null,
      };
      if (i >= 0) next.factors![i] = merged;
      else next.factors!.push(merged);
      break;
    }
    case "remove_factor":
      next.factors = next.factors!.filter((f) => f.name !== patch.name);
      break;
    case "upsert_parameter": {
      const i = next.parameters!.findIndex((p) => p.name === patch.name);
      const existing = i >= 0 ? next.parameters![i] : undefined;
      const merged: Parameter = {
        name: patch.name,
        type: patch.type ?? existing?.type ?? "other",
        default:
          patch.default !== undefined ? patch.default : existing?.default ?? null,
        unit: patch.unit !== undefined ? patch.unit : existing?.unit ?? null,
        shape: patch.shape ?? existing?.shape ?? "unknown",
        description:
          patch.description !== undefined
            ? patch.description
            : existing?.description ?? null,
        line_hint:
          patch.line_hint !== undefined
            ? patch.line_hint
            : existing?.line_hint ?? null,
      };
      if (i >= 0) next.parameters![i] = merged;
      else next.parameters!.push(merged);
      break;
    }
    case "remove_parameter":
      next.parameters = next.parameters!.filter((p) => p.name !== patch.name);
      break;
    case "upsert_condition": {
      const i = next.conditions!.findIndex((c) => c.label === patch.label);
      const existing = i >= 0 ? next.conditions![i] : undefined;
      const merged: Condition = {
        label: patch.label,
        factor_assignments:
          patch.factor_assignments ?? existing?.factor_assignments ?? {},
        description:
          patch.description !== undefined
            ? patch.description
            : existing?.description ?? null,
      };
      if (i >= 0) next.conditions![i] = merged;
      else next.conditions!.push(merged);
      break;
    }
    case "remove_condition":
      next.conditions = next.conditions!.filter((c) => c.label !== patch.label);
      break;
    case "upsert_saved_variable": {
      const i = next.saved_variables!.findIndex((s) => s.name === patch.name);
      const existing = i >= 0 ? next.saved_variables![i] : undefined;
      const merged: SavedVariable = {
        name: patch.name,
        format: patch.format ?? existing?.format ?? "other",
        unit: patch.unit !== undefined ? patch.unit : existing?.unit ?? null,
        sink: patch.sink !== undefined ? patch.sink : existing?.sink ?? null,
        description:
          patch.description !== undefined
            ? patch.description
            : existing?.description ?? null,
        line_hint:
          patch.line_hint !== undefined
            ? patch.line_hint
            : existing?.line_hint ?? null,
      };
      if (i >= 0) next.saved_variables![i] = merged;
      else next.saved_variables!.push(merged);
      break;
    }
    case "remove_saved_variable":
      next.saved_variables = next.saved_variables!.filter(
        (s) => s.name !== patch.name,
      );
      break;
  }

  // Defence in depth: re-parse the merged overrides through the
  // canonical schema. If a patch somehow corrupted shape (future merge
  // bug), reject and keep the previous state.
  const reparsed = CodeAnalysisOverridesSchema.safeParse(next);
  if (!reparsed.success) {
    const detail = reparsed.error.issues.slice(0, 3).map(humaniseIssue).join(" · ");
    return {
      next: overrides,
      error: `패치 적용 후 검증 실패: ${detail || "shape 오류"}`,
    };
  }
  return { next: reparsed.data };
}

export function summarisePatch(p: Patch): string {
  switch (p.op) {
    case "set_meta":
      return `메타.${p.field} = ${JSON.stringify(p.value)}`;
    case "upsert_factor":
      return `factor "${p.name}" 추가/수정${
        p.levels ? ` (levels: ${p.levels.join(", ")})` : ""
      }`;
    case "remove_factor":
      return `factor "${p.name}" 삭제`;
    case "upsert_parameter":
      return `parameter "${p.name}" 추가/수정${
        p.default != null ? ` = ${p.default}` : ""
      }`;
    case "remove_parameter":
      return `parameter "${p.name}" 삭제`;
    case "upsert_condition":
      return `condition "${p.label}" 추가/수정`;
    case "remove_condition":
      return `condition "${p.label}" 삭제`;
    case "upsert_saved_variable":
      return `saved variable "${p.name}" 추가/수정${p.format ? ` (${p.format})` : ""}`;
    case "remove_saved_variable":
      return `saved variable "${p.name}" 삭제`;
  }
}
