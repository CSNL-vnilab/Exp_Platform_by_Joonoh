// Heuristic (no-AI) extractor for offline experiment code. Produces a
// best-effort CodeAnalysis using regex rules tailored to common
// frameworks. The result is a starting point — the AI pass refines it,
// and the experimenter can edit any field by hand. Intentionally
// conservative: when in doubt, returns nothing rather than a guess.

import {
  CodeAnalysisSchema,
  type BlockPhase,
  type CodeAnalysis,
  type CodeLang,
  type Framework,
  type Factor,
  type Parameter,
  type SavedVariable,
} from "./code-analysis-schema";

export interface HeuristicInput {
  code: string;
  filename?: string | null;
}

const MAX_CODE_LEN = 200_000;

export function detectLanguage(code: string, filename?: string | null): CodeLang {
  const ext = (filename ?? "").toLowerCase().match(/\.([a-z0-9]+)$/)?.[1];
  if (ext) {
    if (ext === "m") return "matlab";
    if (ext === "py") return "python";
    if (ext === "js" || ext === "mjs") return "javascript";
    if (ext === "ts" || ext === "tsx") return "typescript";
    if (ext === "r") return "r";
  }
  if (/^\s*function\s+\w+\s*\(/m.test(code) || /Screen\(['"`]Open/.test(code)) return "matlab";
  if (/from\s+psychopy|import\s+psychopy|^\s*def\s+\w+\s*\(/m.test(code)) return "python";
  if (/jsPsych\.|initJsPsych\(|var\s+timeline/.test(code)) return "javascript";
  if (/^\s*library\(|^\s*<-/m.test(code)) return "r";
  return "other";
}

export function detectFramework(code: string, lang: CodeLang): Framework {
  if (lang === "python" && /from\s+psychopy|import\s+psychopy/.test(code)) return "psychopy";
  if (lang === "javascript" && /jsPsych\.|initJsPsych\(/.test(code)) return "jspsych";
  if (lang === "javascript" && /import\s+.*from\s+['"]lab\.js['"]/.test(code)) return "lab.js";
  if (lang === "matlab" && /\bScreen\s*\(|\bPsychDefaultSetup\b|\bKbCheck\b/.test(code))
    return "psychtoolbox";
  if (/from\s+libopensesame|opensesame_/.test(code)) return "opensesame";
  if (/Presentation\b.*scenario/i.test(code)) return "neurobs-presentation";
  return "custom";
}

export function runHeuristic(input: HeuristicInput): CodeAnalysis {
  const code = input.code.slice(0, MAX_CODE_LEN);
  const lines = code.split(/\r?\n/);
  const lang = detectLanguage(code, input.filename);
  const framework = detectFramework(code, lang);

  const warnings: string[] = [];
  const factors: Factor[] = [];
  const parameters: Parameter[] = [];
  const savedVars: SavedVariable[] = [];

  let nBlocks: number | null = null;
  let nTrialsPerBlock: number | null = null;
  let totalTrials: number | null = null;
  let estDurationMin: number | null = null;
  let seed: string | null = null;

  // ----- generic numeric assignments (n_blocks, n_trials, etc.) ---------
  for (let i = 0; i < lines.length; i += 1) {
    const ln = lines[i];

    const numMatch = ln.match(
      /\b(num?_?blocks|nBlocks|n_blocks|blocks?|num?_?trials|nTrials|n_trials|trialsPerBlock|trials_per_block|seed|rngSeed|random_seed)\s*[=:<-]\s*([0-9]+(?:\.[0-9]+)?)/i,
    );
    if (numMatch) {
      const key = numMatch[1].toLowerCase();
      const val = Number(numMatch[2]);
      if (/blocks?/.test(key) && !/trials/.test(key) && nBlocks == null) nBlocks = Math.round(val);
      else if (/trials_per_block|trialsperblock/.test(key) && nTrialsPerBlock == null)
        nTrialsPerBlock = Math.round(val);
      else if (/trials/.test(key) && nTrialsPerBlock == null) nTrialsPerBlock = Math.round(val);
      else if (/seed/.test(key) && seed == null) seed = String(val);
    }

    const seedStr = ln.match(/\b(seed|rng)\s*[=:]\s*['"]([^'"\n]{1,40})['"]/i);
    if (seedStr && seed == null) seed = seedStr[2];

    const durMatch = ln.match(
      /\b(estimated_duration_min|sessionMinutes|duration_min)\s*[=:]\s*([0-9]+(?:\.[0-9]+)?)/i,
    );
    if (durMatch && estDurationMin == null) estDurationMin = Number(durMatch[2]);
  }

  if (nBlocks != null && nTrialsPerBlock != null) {
    totalTrials = nBlocks * nTrialsPerBlock;
  }

  // ----- block-phase taxonomy (MATLAB-flavoured patterns) ---------------
  // We recognise three common phase splits in PTB-style code:
  //   a) `if par.day == 1 nBlocks = N1; else nBlocks = N2; end`  — day split
  //   b) `par.nT = [0 30 30]`  — nonzero positions tag stair/train/test stage
  //   c) `par.StairTrainTest = N * ones(...)` (single)
  //      vs `par.StairTrainTest = [...]` (per-block kinds: 1=stair 2=train 3=test)
  const blockPhases: BlockPhase[] = [];
  // (a) day-branched n_blocks
  for (const m of code.matchAll(
    /\bif\s+(?:par\.)?day\s*==\s*(\d+)[\s\S]{0,200}?nBlocks\s*=\s*(\d+)\s*;[\s\S]{0,200}?else[\s\S]{0,200}?nBlocks\s*=\s*(\d+)\s*;/gi,
  )) {
    const day = m[1];
    const ifN = parseInt(m[2], 10);
    const elseN = parseInt(m[3], 10);
    blockPhases.push({
      kind: "training",
      label: `Day ${day} (분기 if 절)`,
      n_blocks: ifN,
      n_trials_per_block: nTrialsPerBlock,
      day_range: day,
      applies_when: `par.day == ${day}`,
      description: "day-branched 분기 검출 — 기본값과 다른 block 수가 사용됨",
    });
    blockPhases.push({
      kind: "main",
      label: `Day ≠ ${day} (분기 else 절)`,
      n_blocks: elseN,
      n_trials_per_block: nTrialsPerBlock,
      day_range: null,
      applies_when: `par.day ≠ ${day}`,
      description: "day-branched 분기의 다른 분기",
    });
  }

  // (b) par.nT = [0 30 30] — nonzero positions are the active stage(s)
  //     positions: 1=stair, 2=train, 3=test (CSNL convention)
  const STAGE_NAMES = ["stair", "main", "test"] as const;
  const nTArr = code.match(/\bpar\.nT\s*=\s*\[\s*([\d\s.]+)\s*\]/);
  if (nTArr) {
    const nums = nTArr[1].trim().split(/\s+/).map(Number);
    nums.forEach((n, idx) => {
      if (!Number.isFinite(n) || n === 0) return;
      const kind = STAGE_NAMES[idx] ?? "other";
      // only emit if the kind isn't already present
      if (!blockPhases.some((p) => p.kind === kind)) {
        blockPhases.push({
          kind: kind === "stair" ? "stair" : kind === "test" ? "test" : "main",
          label: `${kind} stage (par.nT[${idx + 1}]=${n})`,
          n_blocks: null,
          n_trials_per_block: n,
          day_range: null,
          applies_when: `par.StairTrainTest == ${idx + 1}`,
          description: "par.nT 배열에서 nonzero 인 stage 만 실행됨",
        });
      }
    });
  }

  // (c) par.StairTrainTest single-value vs per-block array
  // single: par.StairTrainTest = 2 * ones(1,nBlocks);  → all train
  // multi:  par.StairTrainTest = [1 1 2 2 3 3];        → mixed kinds
  const sttSingle = code.match(
    /\bpar\.StairTrainTest\s*=\s*(\d+)\s*\*\s*ones\s*\(/,
  );
  const sttMulti = code.match(/\bpar\.StairTrainTest\s*=\s*\[([\d\s]+)\]/);
  if (sttSingle && !sttMulti) {
    const v = parseInt(sttSingle[1], 10);
    const k = STAGE_NAMES[v - 1] ?? "other";
    if (!blockPhases.some((p) => p.kind === (k === "stair" ? "stair" : k === "test" ? "test" : "main"))) {
      blockPhases.push({
        kind: k === "stair" ? "stair" : k === "test" ? "test" : "main",
        label: `${k}-only (StairTrainTest = ${v})`,
        n_blocks: nBlocks,
        n_trials_per_block: nTrialsPerBlock,
        day_range: null,
        applies_when: `par.StairTrainTest == ${v}`,
        description: "전 블럭이 단일 kind (단일값 곱셈 패턴)",
      });
    }
  } else if (sttMulti) {
    const seq = sttMulti[1].trim().split(/\s+/).map(Number).filter(Number.isFinite);
    const counts = new Map<number, number>();
    for (const v of seq) counts.set(v, (counts.get(v) ?? 0) + 1);
    for (const [v, c] of counts) {
      const k = STAGE_NAMES[v - 1] ?? "other";
      blockPhases.push({
        kind: k === "stair" ? "stair" : k === "test" ? "test" : "main",
        label: `${k} (${c} blocks)`,
        n_blocks: c,
        n_trials_per_block: nTrialsPerBlock,
        day_range: null,
        applies_when: `par.StairTrainTest == ${v}`,
        description: "within-session block-kind partition",
      });
    }
  }

  // ----- framework-specific extractors ----------------------------------
  if (framework === "psychopy") {
    extractPsychoPy(code, lines, factors, parameters, savedVars);
  } else if (framework === "jspsych") {
    extractJsPsych(code, lines, factors, parameters, savedVars);
  } else if (framework === "psychtoolbox") {
    extractPsychtoolbox(code, lines, factors, parameters, savedVars);
  }

  // ----- universal: top-level assignments → parameters ------------------
  extractGenericParameters(lines, parameters, framework);

  // ----- saved variables (file writes) ----------------------------------
  extractSinks(code, lines, savedVars);

  if (factors.length === 0) warnings.push("조작 변수(factor) 후보를 찾지 못했습니다 — AI 분석 또는 수동 입력을 권장합니다.");
  if (parameters.length === 0) warnings.push("파라미터 후보를 찾지 못했습니다.");
  if (savedVars.length === 0) warnings.push("저장 변수 후보를 찾지 못했습니다.");
  if (nBlocks == null) warnings.push("블럭 수를 추정하지 못했습니다.");
  if (nTrialsPerBlock == null) warnings.push("블럭당 트라이얼 수를 추정하지 못했습니다.");

  // Tag each parameter with shape (constant / vector / expression) so the
  // model + UI can tell IV-candidates apart from setup constants.
  const taggedParameters = parameters.map((p) => ({
    ...p,
    shape:
      p.shape === "unknown"
        ? classifyShape(p.default)
        : p.shape,
  }));

  // If we found phase splits but no top-level n_blocks, back-fill from
  // the dominant phase (the one with the most blocks).
  let metaNBlocks = nBlocks;
  if (metaNBlocks == null && blockPhases.length > 0) {
    const dominant = [...blockPhases].sort(
      (a, b) => (b.n_blocks ?? 0) - (a.n_blocks ?? 0),
    )[0];
    if (dominant?.n_blocks) metaNBlocks = dominant.n_blocks;
  }

  if (blockPhases.length > 0) {
    warnings.push(
      `${blockPhases.length}개 phase 검출 (training/test 등). meta.block_phases 참조 — 단일 n_blocks 는 대표값임.`,
    );
  }

  const analysis: CodeAnalysis = CodeAnalysisSchema.parse({
    meta: {
      language: lang,
      framework,
      n_blocks: metaNBlocks,
      n_trials_per_block: nTrialsPerBlock,
      total_trials: totalTrials,
      estimated_duration_min: estDurationMin,
      seed,
      block_phases: blockPhases,
      summary: null,
    },
    factors: dedupeBy(factors, (f) => f.name),
    parameters: dedupeBy(taggedParameters, (p) => p.name),
    conditions: [], // heuristic stays out of this — Cartesian explosion is unsafe to assume
    saved_variables: dedupeBy(savedVars, (s) => s.name),
    warnings,
  });
  return analysis;
}

// Classify the RHS of an assignment by shape so the UI / AI can spot
// "single-value variables that pretend to be IVs".
//   - "1.0"            → constant
//   - "2 * ones(...)"  → constant (replicated single value — common PTB)
//   - "[1 2 3]"        → vector
//   - "{'a','b','c'}"  → vector (cell)
//   - "input(...)"     → input
//   - "foo(bar) + 1"   → expression
function classifyShape(literal: string | null | undefined): Parameter["shape"] {
  if (literal == null) return "unknown";
  const t = literal.trim();
  if (!t) return "unknown";
  if (/^\d+\s*\*\s*ones\s*\(/i.test(t)) return "constant";
  if (/^['"`]/.test(t) || /^-?\d+(?:\.\d+)?(?:[eE]-?\d+)?$/.test(t) || /^(true|false|True|False|null|None|undefined)$/.test(t)) {
    return "constant";
  }
  if (/^\[[\d\s.,;-]+\]$/.test(t)) return "vector";
  if (/^\{[^}]+\}$/.test(t)) return "vector";
  if (/\binput\s*\(/i.test(t)) return "input";
  if (/[A-Za-z_]\w*\s*\(/.test(t)) return "expression";
  return "unknown";
}

// ---------------------------------------------------------------------------
// Framework-specific extractors
// ---------------------------------------------------------------------------

function extractPsychoPy(
  code: string,
  lines: string[],
  factors: Factor[],
  parameters: Parameter[],
  savedVars: SavedVariable[],
): void {
  // PsychoPy ConditionsFile pattern: data.importConditions('cond.csv')
  for (let i = 0; i < lines.length; i += 1) {
    const m = lines[i].match(/importConditions\s*\(\s*['"]([^'"]+)['"]/);
    if (m) {
      parameters.push({
        name: "conditions_file",
        type: "string",
        default: m[1],
        unit: null,
        shape: "unknown",
        description: "PsychoPy conditions CSV 경로",
        line_hint: i + 1,
      });
    }

    // expInfo dict — 보통 실험에서 수집되는 메타데이터
    const exp = lines[i].match(/expInfo\s*\[\s*['"]([^'"]+)['"]\s*\]\s*=\s*(.+)$/);
    if (exp) {
      parameters.push({
        name: `expInfo.${exp[1]}`,
        type: guessTypeFromLiteral(exp[2]),
        default: stripLiteral(exp[2]),
        unit: null,
        shape: "unknown",
        description: "PsychoPy expInfo entry",
        line_hint: i + 1,
      });
    }

    // TrialHandler — factors are inferred from `conditions=[{...}, ...]`
    const th = lines[i].match(/TrialHandler\(/);
    if (th) {
      // best-effort: skip; AI pass will fill in
    }

    // .addData('field', value) → saved var
    const add = lines[i].match(/\.addData\(\s*['"]([A-Za-z0-9_.]+)['"]\s*,/);
    if (add) {
      savedVars.push({
        name: add[1],
        format: "other",
        unit: null,
        sink: "PsychoPy data file",
        description: null,
        line_hint: i + 1,
      });
    }
  }

  // independent variable convention: independent_vars = ['contrast', 'duration']
  const ivs = code.match(/independent[_-]?vars?\s*[:=]\s*\[([^\]]+)\]/i);
  if (ivs) {
    for (const tok of splitListLiteral(ivs[1])) {
      factors.push({
        name: tok,
        type: "categorical",
        levels: [],
        role: "unknown",
        description: null,
        line_hint: null,
      });
    }
  }
}

function extractJsPsych(
  code: string,
  lines: string[],
  factors: Factor[],
  parameters: Parameter[],
  savedVars: SavedVariable[],
): void {
  for (let i = 0; i < lines.length; i += 1) {
    const factorsMatch = lines[i].match(/jsPsych\.randomization\.factorial\s*\(\s*\{([^}]+)\}/);
    if (factorsMatch) {
      const body = factorsMatch[1];
      const pairs = body.matchAll(/(\w+)\s*:\s*\[([^\]]+)\]/g);
      for (const p of pairs) {
        factors.push({
          name: p[1],
          type: "categorical",
          levels: splitListLiteral(p[2]),
          role: "unknown",
          description: null,
          line_hint: i + 1,
        });
      }
    }
    const dataAdd = lines[i].match(
      /jsPsych\.data\.(?:addProperties|getInteractionData|get)\s*\(\s*\{([^}]+)\}/,
    );
    if (dataAdd) {
      const pairs = dataAdd[1].matchAll(/(\w+)\s*:/g);
      for (const p of pairs) {
        savedVars.push({
          name: p[1],
          format: "other",
          unit: null,
          sink: "jsPsych data",
          description: null,
          line_hint: i + 1,
        });
      }
    }
    const onFinish = lines[i].match(/data\.([a-zA-Z_][a-zA-Z0-9_]*)\s*=/);
    if (onFinish) {
      savedVars.push({
        name: onFinish[1],
        format: "other",
        unit: null,
        sink: "jsPsych on_finish",
        description: null,
        line_hint: i + 1,
      });
    }
  }
}

function extractPsychtoolbox(
  code: string,
  lines: string[],
  factors: Factor[],
  parameters: Parameter[],
  savedVars: SavedVariable[],
): void {
  // factor cell array convention:  conditions = {'low','med','high'};
  for (let i = 0; i < lines.length; i += 1) {
    const cellAssign = lines[i].match(
      /^\s*(?:conditions|factors|levels|contrasts|stims?)\s*=\s*\{([^}]+)\}\s*;/i,
    );
    if (cellAssign) {
      const items = splitListLiteral(cellAssign[1]);
      if (items.length > 1) {
        factors.push({
          name: lines[i].match(/^\s*(\w+)/)?.[1] ?? "factor",
          type: "categorical",
          levels: items,
          role: "unknown",
          description: null,
          line_hint: i + 1,
        });
      }
    }

    // params struct fields:  params.contrast = 0.5;
    const paramAssign = lines[i].match(
      /^\s*params\.([A-Za-z_][A-Za-z0-9_]*)\s*=\s*([^;]+);/,
    );
    if (paramAssign) {
      parameters.push({
        name: paramAssign[1],
        type: guessTypeFromLiteral(paramAssign[2]),
        default: stripLiteral(paramAssign[2]),
        unit: null,
        shape: "unknown",
        description: null,
        line_hint: i + 1,
      });
    }

    // data.* writes
    const dataAssign = lines[i].match(
      /^\s*data\.([A-Za-z_][A-Za-z0-9_]*)\s*\([^)]*\)?\s*=/,
    );
    if (dataAssign) {
      savedVars.push({
        name: dataAssign[1],
        format: "other",
        unit: null,
        sink: "data struct",
        description: null,
        line_hint: i + 1,
      });
    }

    // save('file.mat', '-struct', ...)
    const saveCall = lines[i].match(/\bsave\s*\(\s*['"]([^'"]+\.mat)['"]/);
    if (saveCall) {
      savedVars.push({
        name: "(saved file)",
        format: "struct",
        unit: null,
        sink: saveCall[1],
        description: null,
        line_hint: i + 1,
      });
    }
  }
}

function extractGenericParameters(
  lines: string[],
  parameters: Parameter[],
  framework: Framework,
): void {
  // Capture top-of-file constant assignments (UPPER_SNAKE or
  // identifier with literal RHS). Skips anything that looks like
  // string concat / function call so noise stays low.
  for (let i = 0; i < Math.min(lines.length, 200); i += 1) {
    const ln = lines[i].trim();
    if (!ln || ln.startsWith("#") || ln.startsWith("//") || ln.startsWith("%")) continue;
    const m = ln.match(/^(?:const|let|var)?\s*([A-Z][A-Z0-9_]{2,}|[a-z][A-Za-z0-9_]{2,})\s*=\s*([^;]+?)\s*;?\s*$/);
    if (!m) continue;
    const name = m[1];
    const rhs = m[2];
    // skip obvious non-constants
    if (/[(]|[\[]\s*\{|require\(|import\s/.test(rhs)) continue;
    // skip framework-noise names already captured
    if (/^(true|false|null|None|undefined)$/i.test(name)) continue;
    if (parameters.some((p) => p.name === name)) continue;
    parameters.push({
      name,
      type: guessTypeFromLiteral(rhs),
      default: stripLiteral(rhs),
      unit: null,
      shape: "unknown",
      description: null,
      line_hint: i + 1,
    });
    if (parameters.length >= 30) break; // budget — AI pass picks up the rest
  }
}

function extractSinks(
  code: string,
  lines: string[],
  savedVars: SavedVariable[],
): void {
  // file-write sinks: open('x.csv','w'), fopen, csv writers, save() …
  for (let i = 0; i < lines.length; i += 1) {
    const f =
      lines[i].match(/\b(?:open|fopen|to_csv|writeFile|writerow|np\.save|savetxt)\s*\(\s*['"]([^'"]+)['"]/);
    if (f) {
      savedVars.push({
        name: "(file)",
        format: f[1].endsWith(".csv") ? "csv-row" : f[1].endsWith(".json") ? "json" : "other",
        unit: null,
        sink: f[1],
        description: null,
        line_hint: i + 1,
      });
    }
  }
}

// ---------------------------------------------------------------------------
// helpers
// ---------------------------------------------------------------------------

function guessTypeFromLiteral(literal: string): Parameter["type"] {
  const t = literal.trim();
  if (/^['"`].*['"`]$/.test(t)) return "string";
  if (/^(true|false|True|False)$/.test(t)) return "boolean";
  if (/^[\[\{]/.test(t)) return "array";
  if (/^-?\d+(\.\d+)?(e-?\d+)?$/i.test(t)) return "number";
  return "other";
}

function stripLiteral(literal: string): string | null {
  const t = literal.trim().replace(/[;,]+$/, "");
  if (!t) return null;
  return t.slice(0, 200);
}

function splitListLiteral(body: string): string[] {
  return body
    .split(",")
    .map((s) => s.trim().replace(/^['"`]|['"`]$/g, ""))
    .filter(Boolean)
    .slice(0, 64);
}

function dedupeBy<T>(xs: T[], key: (x: T) => string): T[] {
  const seen = new Set<string>();
  const out: T[] = [];
  for (const x of xs) {
    const k = key(x);
    if (!k || seen.has(k)) continue;
    seen.add(k);
    out.push(x);
  }
  return out;
}
