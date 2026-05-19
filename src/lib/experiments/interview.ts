// Confirmation-interview generator for the offline-code-analyzer.
//
// The analyzer's job is to *deconstruct* experiment code; this module
// turns the *uncertain* parts of that deconstruction into a short,
// grounded, multiple-choice interview the experimenter answers in the
// UI. Each answer maps to a typed Patch (the same channel the chatbot
// uses), so confirming "this is a per-trial IV" deterministically
// refines the analysis — no free-form parsing, no LLM round-trip.
//
// Methodology mirrors the lab's archiver interview agent:
//   - one concern per question, prioritised most-uncertain first
//   - grounded: every question cites code evidence (file:line) when the
//     analyzer recorded one; we never ask about things with no signal
//   - multiple-choice over open-ended; a text box only where a free
//     value is genuinely needed (levels, the hierarchy one-liner)
//   - every question has a no-op "leave as is" answer so the loop is
//     skippable and never blocks
//
// Pure + framework-free (browser-safe): the UI imports buildInterview()
// directly and applies the chosen option's patches via applyPatch().

import type { CodeAnalysis } from "./code-analysis-schema";
import type { Patch } from "./code-analysis-patch";

export interface InterviewOption {
  label: string;
  // Applied in order via applyPatch when the option is chosen. Omitted
  // / empty ⇒ "leave the analysis unchanged" (explicit confirm or skip).
  patches?: Patch[];
  tone?: "primary" | "default" | "danger";
}

export type InterviewTextBuild =
  | { mode: "set_meta"; field: "hierarchy" | "summary" | "design_matrix" }
  | { mode: "factor_levels"; name: string }
  | { mode: "factor_rename"; name: string };

export interface InterviewQuestion {
  id: string;
  topic: "factor" | "hierarchy" | "parameter" | "condition" | "saved" | "note";
  question: string;
  // "file:line" the analyzer attached, or a short grounding note. Shown
  // verbatim in the UI so the experimenter can check the source.
  evidence: string | null;
  kind: "single" | "text";
  options?: InterviewOption[]; // kind === "single"
  text?: { placeholder: string; build: InterviewTextBuild }; // kind === "text"
}

const FACTOR_ROLE_LABEL: Record<string, string> = {
  between_subject: "피험자/그룹마다 다름 (between-subject)",
  within_subject: "같은 피험자의 day/session 마다 다름 (within-subject)",
  within_session: "한 세션 안 블럭 종류마다 다름 (within-session)",
  per_trial: "trial 마다 다름 (per-trial)",
  derived: "다른 변수에서 계산됨 (IV 아님 / derived)",
};

function ev(lineHint: unknown): string | null {
  if (lineHint == null) return null;
  if (typeof lineHint === "number") return `line ${lineHint}`;
  const s = String(lineHint).trim();
  return s ? s : null;
}

// Heuristic: an inference-clue factor surfaced from a call site rather
// than a literal assignment (platform-lens emits "→ fn()" / "← fn()",
// or a description that says it was inferred).
function isInferenceClue(name: string, description: string | null): boolean {
  if (/^[→←]\s/.test(name)) return true;
  return /추론|호출부|call site|inferred/i.test(description ?? "");
}

const MAX_QUESTIONS = 14;

/**
 * Build the confirmation interview from the *merged* analysis. Pure and
 * deterministic: same analysis → same ordered questions. The UI takes a
 * snapshot when the panel opens (it does not re-run per keystroke) so
 * the experimenter's position is stable while they answer.
 */
export function buildInterview(merged: CodeAnalysis): InterviewQuestion[] {
  const qs: InterviewQuestion[] = [];

  // ---- 1. inference-clue factors (highest uncertainty) --------------
  for (const f of merged.factors) {
    if (!isInferenceClue(f.name, f.description)) continue;
    const clean = f.name.replace(/^[→←]\s*/, "");
    qs.push({
      id: `clue:${f.name}`,
      topic: "factor",
      question: `'${clean}' 는 생성기/함수 호출부에서 *추론된* 조작변수 후보입니다. 실제로 trial 마다 바뀌는 IV 가 맞습니까?`,
      evidence: ev(f.line_hint),
      kind: "single",
      options: [
        {
          label: "맞음 — per-trial 조작변수로 확정",
          tone: "primary",
          patches: [
            { op: "upsert_factor", name: f.name, role: "per_trial" },
          ],
        },
        {
          label: "아님 — 조작변수에서 제거",
          tone: "danger",
          patches: [{ op: "remove_factor", name: f.name }],
        },
        { label: "잘 모르겠음 — 그대로 둠" },
      ],
    });
  }

  // ---- 2. factor role unknown --------------------------------------
  for (const f of merged.factors) {
    if (f.role && f.role !== "unknown") continue;
    if (isInferenceClue(f.name, f.description)) continue; // already asked
    qs.push({
      id: `role:${f.name}`,
      topic: "factor",
      question: `조작변수 '${f.name}' 는 실험에서 *어느 수준*에서 변합니까?`,
      evidence: ev(f.line_hint),
      kind: "single",
      options: [
        ...(["between_subject", "within_subject", "within_session", "per_trial", "derived"] as const).map(
          (role): InterviewOption => ({
            label: FACTOR_ROLE_LABEL[role],
            tone: role === "derived" ? "danger" : "default",
            patches:
              role === "derived"
                ? [{ op: "remove_factor", name: f.name }]
                : [{ op: "upsert_factor", name: f.name, role }],
          }),
        ),
        { label: "모르겠음 — 그대로 둠" },
      ],
    });
  }

  // ---- 3. single-value factor: IV vs fixed constant ----------------
  for (const f of merged.factors) {
    if ((f.levels?.length ?? 0) > 1) continue;
    if (f.role === "per_trial") continue; // continuous per-trial is fine
    if (isInferenceClue(f.name, f.description) || !f.role || f.role === "unknown")
      continue; // covered above
    qs.push({
      id: `single:${f.name}`,
      topic: "factor",
      question: `'${f.name}' 는 코드에서 한 값으로만 보입니다. 실제 *조작*변수입니까, 아니면 고정 셋업 *상수*입니까?`,
      evidence: ev(f.line_hint),
      kind: "single",
      options: [
        { label: "조작변수가 맞음 — 그대로 둠", tone: "primary" },
        {
          label: "고정 상수임 — parameter 로 옮김",
          tone: "danger",
          patches: [
            { op: "remove_factor", name: f.name },
            {
              op: "upsert_parameter",
              name: f.name,
              shape: "constant",
              description: "실험자 확인: 고정 상수 (IV 아님)",
            },
          ],
        },
      ],
    });
  }

  // ---- 4. categorical factor with no levels ------------------------
  for (const f of merged.factors) {
    if (f.type !== "categorical") continue;
    if ((f.levels?.length ?? 0) > 0) continue;
    if (isInferenceClue(f.name, f.description)) continue;
    // Don't ask a factor's *levels* until its existence/role is settled
    // — the role question (above) comes first; revisit on the next pass.
    if (!f.role || f.role === "unknown") continue;
    qs.push({
      id: `levels:${f.name}`,
      topic: "factor",
      question: `'${f.name}' 의 수준(levels)은 무엇입니까? (코드에서 못 읽었습니다 — 조건표/외부 csv 등)`,
      evidence: ev(f.line_hint),
      kind: "text",
      text: {
        placeholder: "쉼표로 구분 — 예: low, med, high",
        build: { mode: "factor_levels", name: f.name },
      },
    });
  }

  // ---- 5. hierarchy one-liner missing ------------------------------
  if (!merged.meta.hierarchy || !merged.meta.hierarchy.trim()) {
    const nb = merged.meta.n_blocks;
    const nt = merged.meta.n_trials_per_block;
    qs.push({
      id: "meta:hierarchy",
      topic: "hierarchy",
      question:
        "experiment→session→block→trial 중첩 구조를 한 줄로 확인/수정해 주세요. (계층이 정확해야 trial 수·조건 배정이 맞습니다)",
      evidence: `현재 추정: n_blocks=${nb ?? "?"}, n_trials_per_block=${nt ?? "?"}, block_phases=${merged.meta.block_phases?.length ?? 0}`,
      kind: "text",
      text: {
        placeholder:
          "예: session: par.day 1..5; block: for iR=1:nBlocks (Day1=10/Day2-5=12); trial: for iT=1:nT (40)",
        build: { mode: "set_meta", field: "hierarchy" },
      },
    });
  }

  // ---- 6. parameter shape unknown ----------------------------------
  for (const p of merged.parameters) {
    if (p.shape && p.shape !== "unknown") continue;
    qs.push({
      id: `shape:${p.name}`,
      topic: "parameter",
      question: `파라미터 '${p.name}'${p.default != null ? ` (= ${p.default})` : ""} 의 형태는 무엇입니까?`,
      evidence: ev(p.line_hint),
      kind: "single",
      options: [
        {
          label: "모든 trial 고정 단일값 (constant)",
          tone: "primary",
          patches: [{ op: "upsert_parameter", name: p.name, shape: "constant" }],
        },
        {
          label: "블럭마다 다른 벡터 (vector) — IV 후보일 수 있음",
          patches: [{ op: "upsert_parameter", name: p.name, shape: "vector" }],
        },
        {
          label: "다른 값에서 계산 (expression)",
          patches: [{ op: "upsert_parameter", name: p.name, shape: "expression" }],
        },
        {
          label: "런타임 입력 (input)",
          patches: [{ op: "upsert_parameter", name: p.name, shape: "input" }],
        },
        { label: "모르겠음 — 그대로 둠" },
      ],
    });
  }

  // ---- 7. analyzer qualitative notes → confirm ---------------------
  for (let i = 0; i < (merged.warnings ?? []).length; i += 1) {
    const w = merged.warnings[i];
    // skip the analyzer's own bookkeeping lines (lens applied, truncated…)
    if (/플랫폼 렌즈|이상이어서 일부|2-pass|refinement|스키마/.test(w)) continue;
    qs.push({
      id: `note:${i}`,
      topic: "note",
      question: `분석기 메모를 확인해 주세요: "${w}"`,
      evidence: null,
      kind: "single",
      options: [
        { label: "확인했음 (조치 불필요)", tone: "primary" },
        { label: "관련 항목을 직접 수정하겠음", tone: "default" },
      ],
    });
  }

  return qs.slice(0, MAX_QUESTIONS);
}
