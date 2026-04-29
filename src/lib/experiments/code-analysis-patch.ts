// Client-side parser + applier for the chatbot's <patch>{...}</patch>
// blocks. Each patch is a structured edit on the user-overrides map.
// Kept framework-free so it can be unit-tested or reused elsewhere.

import type {
  CodeAnalysisOverrides,
  Condition,
  Factor,
  Parameter,
  SavedVariable,
} from "./code-analysis-schema";

export type Patch =
  | {
      op: "set_meta";
      field:
        | "n_blocks"
        | "n_trials_per_block"
        | "total_trials"
        | "estimated_duration_min"
        | "seed"
        | "summary"
        | "framework"
        | "language";
      value: string | number | null;
    }
  | { op: "upsert_factor"; name: string } & Partial<Factor>
  | { op: "remove_factor"; name: string }
  | { op: "upsert_parameter"; name: string } & Partial<Parameter>
  | { op: "remove_parameter"; name: string }
  | { op: "upsert_condition"; label: string } & Partial<Condition>
  | { op: "remove_condition"; label: string }
  | { op: "upsert_saved_variable"; name: string } & Partial<SavedVariable>
  | { op: "remove_saved_variable"; name: string };

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
    try {
      const obj = JSON.parse(match[1]) as Patch;
      if (typeof obj !== "object" || obj == null || !("op" in obj)) {
        error = "patch 형식이 올바르지 않습니다";
      } else {
        patch = obj;
      }
    } catch (e) {
      error = e instanceof Error ? e.message : "JSON parse error";
    }
    blocks.push({ raw: match[1], patch, error });
    lastIndex = match.index + match[0].length;
  }
  prose += text.slice(lastIndex);
  return { prose, blocks };
}

// Apply one patch into a CodeAnalysisOverrides (the user-overrides
// shape). Returns the new overrides object — pure.
export function applyPatch(
  overrides: CodeAnalysisOverrides,
  patch: Patch,
): CodeAnalysisOverrides {
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
      const merged: Factor = {
        name: patch.name,
        type: (patch.type as Factor["type"]) ?? next.factors![i]?.type ?? "categorical",
        levels: patch.levels ?? next.factors![i]?.levels ?? [],
        role: (patch as Partial<Factor>).role ?? next.factors![i]?.role ?? "unknown",
        description: patch.description ?? next.factors![i]?.description ?? null,
        line_hint: patch.line_hint ?? next.factors![i]?.line_hint ?? null,
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
      const merged: Parameter = {
        name: patch.name,
        type: (patch.type as Parameter["type"]) ?? next.parameters![i]?.type ?? "other",
        default: patch.default ?? next.parameters![i]?.default ?? null,
        unit: patch.unit ?? next.parameters![i]?.unit ?? null,
        shape: (patch as Partial<Parameter>).shape ?? next.parameters![i]?.shape ?? "unknown",
        description: patch.description ?? next.parameters![i]?.description ?? null,
        line_hint: patch.line_hint ?? next.parameters![i]?.line_hint ?? null,
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
      const merged: Condition = {
        label: patch.label,
        factor_assignments:
          patch.factor_assignments ??
          next.conditions![i]?.factor_assignments ??
          {},
        description: patch.description ?? next.conditions![i]?.description ?? null,
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
      const merged: SavedVariable = {
        name: patch.name,
        format: (patch.format as SavedVariable["format"]) ?? next.saved_variables![i]?.format ?? "other",
        unit: patch.unit ?? next.saved_variables![i]?.unit ?? null,
        sink: patch.sink ?? next.saved_variables![i]?.sink ?? null,
        description: patch.description ?? next.saved_variables![i]?.description ?? null,
        line_hint: patch.line_hint ?? next.saved_variables![i]?.line_hint ?? null,
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
  return next;
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
      return `parameter "${p.name}" 추가/수정${p.default != null ? ` = ${p.default}` : ""}`;
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
