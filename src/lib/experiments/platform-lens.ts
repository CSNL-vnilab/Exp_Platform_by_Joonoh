// Platform-specific analysis "lenses" for the offline experiment-code
// analyzer. A behavioural experiment written in Psychtoolbox (MATLAB),
// PsychoPy (Python) or jsPsych (JS) encodes the *same* concepts —
// trials, blocks, conditions, IVs, saved data — through completely
// different API surfaces. A single generic prompt under-extracts on all
// three. This module gives each platform its own lens:
//
//   1. `detectPlatform()` — weighted signal scan over the whole bundle
//      (stronger than the single-file regex in code-heuristics.ts).
//   2. `extractionLens`    — system-prompt augmentation for pass-1
//      (qwen3.6) telling it exactly which constructs encode each concept
//      on this platform, plus the platform's classic miss/pitfall list.
//   3. `reviewChecklist`   — an active audit list for the pass-2 (gemma)
//      reviewer. The earlier reviewer prompt biased toward "0 patches is
//      safest" and gemma emitted nothing; this makes the audit concrete.
//   4. `probe()`           — deterministic regex probes over the bundle
//      that surface concrete candidate identifiers WITH line evidence.
//      Feeding these to the reviewer turns "review the JSON" into
//      "diff this evidence list against the JSON" — high recall without
//      hallucination, because every probe hit is a real code line.
//
// The module is pure (no LLM, no fs) so it is unit-testable and shared
// by both passes.

import type { Framework } from "./code-analysis-schema";

export type Platform = "psychtoolbox" | "psychopy" | "jspsych" | "generic";

export interface PlatformDetection {
  platform: Platform;
  confidence: number; // 0..1
  signals: string[]; // human-readable matched signals (for warnings/telemetry)
}

export type ProbeCategory =
  | "factor"
  | "parameter"
  | "saved"
  | "structure";

export interface PlatformProbeHit {
  category: ProbeCategory;
  name: string; // candidate identifier / construct
  evidence: string; // the matched source line, trimmed
  line_hint: string | null; // "file:line" when resolvable from bundle headers
  note?: string; // why this matters (role hint, channel split, …)
}

export interface PlatformLens {
  platform: Platform;
  label: string;
  framework: Framework; // maps onto the schema enum
  extractionLens: string[]; // injected into pass-1 system prompt
  reviewChecklist: string[]; // injected into pass-2 reviewer prompt
  probe: (bundle: string) => PlatformProbeHit[];
}

// ---------------------------------------------------------------------------
// bundle line walker — attributes a (file, line) to every body line by
// tracking the `=== file: path (N lines, …) ===` markers emitted by the
// code-bundler. Body lines are 1-based per file, matching the contract
// the extraction prompt states ("각 헤더 뒤의 라인은 그 파일의 라인 번호").
// ---------------------------------------------------------------------------
const BUNDLE_HEADER_RE = /^=== file:\s+(.+?)\s+\(\d+\s+lines,/;

interface WalkedLine {
  file: string | null;
  line: number;
  text: string;
}

function* walkBundle(bundle: string): Generator<WalkedLine> {
  let curFile: string | null = null;
  let curLine = 0;
  for (const raw of bundle.split(/\r?\n/)) {
    const h = raw.match(BUNDLE_HEADER_RE);
    if (h) {
      curFile = h[1];
      curLine = 0;
      continue;
    }
    if (/^% \[\.\.\.truncated\.\.\.\]$/.test(raw)) continue; // bundler marker
    curLine += 1;
    yield { file: curFile, line: curLine, text: raw };
  }
}

function hintOf(w: WalkedLine): string | null {
  if (!w.file) return null;
  return `${w.file}:${w.line}`;
}

// Bounded, deduped collector so a probe can't blow the prompt budget.
class HitSink {
  private seen = new Set<string>();
  private out: PlatformProbeHit[] = [];
  constructor(private readonly perCategoryCap = 26) {}
  add(h: PlatformProbeHit): void {
    const key = `${h.category}:${h.name}`;
    if (this.seen.has(key)) return;
    const inCat = this.out.filter((x) => x.category === h.category).length;
    if (inCat >= this.perCategoryCap) return;
    this.seen.add(key);
    this.out.push({ ...h, evidence: h.evidence.trim().slice(0, 160) });
  }
  all(): PlatformProbeHit[] {
    return this.out;
  }
}

// ---------------------------------------------------------------------------
// detection
// ---------------------------------------------------------------------------
interface SignalRule {
  platform: Platform;
  rx: RegExp;
  weight: number;
  label: string;
}

const SIGNALS: SignalRule[] = [
  // Psychtoolbox / MATLAB
  { platform: "psychtoolbox", rx: /\bScreen\s*\(\s*['"]OpenWindow/i, weight: 5, label: "Screen('OpenWindow')" },
  { platform: "psychtoolbox", rx: /\bPsychDefaultSetup\s*\(/, weight: 5, label: "PsychDefaultSetup()" },
  { platform: "psychtoolbox", rx: /\bKbCheck\b|\bKbWait\b|\bKbName\b/, weight: 3, label: "KbCheck/KbWait" },
  { platform: "psychtoolbox", rx: /\bGetSecs\s*\(/, weight: 3, label: "GetSecs()" },
  { platform: "psychtoolbox", rx: /\bWaitSecs\s*\(/, weight: 2, label: "WaitSecs()" },
  { platform: "psychtoolbox", rx: /\bsave\s*\(\s*['"][^'"]+\.mat['"]/, weight: 2, label: "save(*.mat)" },
  { platform: "psychtoolbox", rx: /\bpar\.\w+|\bpar\.results\.\w+/, weight: 2, label: "par.* struct" },

  // PsychoPy / Python
  { platform: "psychopy", rx: /from\s+psychopy\s+import|import\s+psychopy/, weight: 6, label: "import psychopy" },
  { platform: "psychopy", rx: /\bvisual\.Window\s*\(/, weight: 4, label: "visual.Window()" },
  { platform: "psychopy", rx: /\bdata\.TrialHandler\s*\(|\bTrialHandlerExt\s*\(/, weight: 4, label: "data.TrialHandler()" },
  { platform: "psychopy", rx: /\.addData\s*\(|thisExp\.addData\s*\(/, weight: 3, label: ".addData()" },
  { platform: "psychopy", rx: /importConditions\s*\(/, weight: 3, label: "importConditions()" },
  { platform: "psychopy", rx: /\bcore\.(wait|Clock|quit)\b/, weight: 2, label: "core.wait/Clock" },
  { platform: "psychopy", rx: /saveAsWideText\s*\(|saveAsPickle\s*\(/, weight: 3, label: "saveAsWideText()" },

  // jsPsych / JS
  { platform: "jspsych", rx: /\binitJsPsych\s*\(|jsPsych\.init\s*\(/, weight: 6, label: "initJsPsych()" },
  { platform: "jspsych", rx: /jsPsych\.randomization\.\w+/, weight: 4, label: "jsPsych.randomization.*" },
  { platform: "jspsych", rx: /jsPsych\.timelineVariable\s*\(/, weight: 4, label: "timelineVariable()" },
  { platform: "jspsych", rx: /jsPsych\.data\.(addProperties|get|displayData)\s*\(/, weight: 3, label: "jsPsych.data.*" },
  { platform: "jspsych", rx: /\btype:\s*jsPsych[A-Z]\w+/, weight: 3, label: "type: jsPsych<Plugin>" },
  { platform: "jspsych", rx: /\btimeline\s*:\s*\[|\bvar\s+timeline\b|\bconst\s+timeline\b/, weight: 2, label: "timeline[]" },
];

const FRAMEWORK_OF: Record<Platform, Framework> = {
  psychtoolbox: "psychtoolbox",
  psychopy: "psychopy",
  jspsych: "jspsych",
  generic: "custom",
};

export function frameworkOf(p: Platform): Framework {
  return FRAMEWORK_OF[p];
}

// Map a heuristic-detected framework string back onto a Platform so a
// strong heuristic signal can break a weak detection tie.
function platformFromFramework(fw?: string): Platform | null {
  switch ((fw ?? "").toLowerCase()) {
    case "psychtoolbox":
      return "psychtoolbox";
    case "psychopy":
      return "psychopy";
    case "jspsych":
      return "jspsych";
    default:
      return null;
  }
}

export function detectPlatform(
  bundle: string,
  heuristicFramework?: string,
): PlatformDetection {
  const score: Record<Platform, number> = {
    psychtoolbox: 0,
    psychopy: 0,
    jspsych: 0,
    generic: 0,
  };
  const signals: string[] = [];
  for (const s of SIGNALS) {
    if (s.rx.test(bundle)) {
      score[s.platform] += s.weight;
      signals.push(`${s.platform}:${s.label}`);
    }
  }
  // A confident heuristic framework adds a tie-breaking nudge.
  const heur = platformFromFramework(heuristicFramework);
  if (heur) score[heur] += 3;

  const ranked = (Object.keys(score) as Platform[])
    .filter((p) => p !== "generic")
    .sort((a, b) => score[b] - score[a]);
  const top = ranked[0];
  const topScore = score[top] ?? 0;
  const runnerUp = score[ranked[1]] ?? 0;

  // Need a minimum absolute signal AND a margin over the runner-up,
  // otherwise fall back to the generic lens (mixed/unknown repos).
  if (topScore < 4 || topScore - runnerUp < 2) {
    return {
      platform: "generic",
      confidence: topScore === 0 ? 0 : Math.min(0.4, topScore / 20),
      signals,
    };
  }
  // Confidence: saturating function of absolute score + margin.
  const confidence = Math.min(
    0.99,
    0.5 + topScore / 24 + (topScore - runnerUp) / 24,
  );
  return { platform: top, confidence, signals };
}

// ---------------------------------------------------------------------------
// shared probe helpers
// ---------------------------------------------------------------------------
function ident(s: string): string {
  return s.trim().replace(/[`'"]/g, "").slice(0, 64);
}

// ---------------------------------------------------------------------------
// Psychtoolbox / MATLAB lens
// ---------------------------------------------------------------------------
function probePsychtoolbox(bundle: string): PlatformProbeHit[] {
  const sink = new HitSink();
  for (const w of walkBundle(bundle)) {
    const t = w.text;
    if (!t || /^\s*%/.test(t)) continue; // skip pure-comment lines

    // per-trial stimulus/condition/response: par.X{iR}(iT), par.results.X{iR}(iT),
    // par.X(iR,iT)
    let m = t.match(
      /\bpar\.(?:results\.)?([A-Za-z_]\w*)\s*(?:\{[^}]*\}\s*)?\(\s*i?R?[\w+]*\s*,?\s*i?T?[\w+]*\s*\)\s*=/,
    );
    if (m) {
      sink.add({
        category: "saved",
        name: ident(m[1]),
        evidence: t,
        line_hint: hintOf(w),
        note: "per-trial 기록 (par.X{iR}(iT) / par.X(iR,iT))",
      });
    }

    // per-trial timing channels: par.tp.X{iR}(iT) — EACH channel separate
    m = t.match(/\bpar\.tp\.([A-Za-z_]\w*)\s*(?:\{[^}]*\}|\()/);
    if (m) {
      sink.add({
        category: "saved",
        name: `tp.${ident(m[1])}`,
        evidence: t,
        line_hint: hintOf(w),
        note: "per-trial 타이밍 채널 — 채널별 별도 항목, 단위 sec(GetSecs)",
      });
    }

    // per-block summary: par.results.X(iR), par.blockX(iR)
    m = t.match(/\bpar\.(?:results\.)?([A-Za-z_]\w*)\s*\(\s*i?R\w*\s*\)\s*=/);
    if (m && !/iT/.test(t)) {
      sink.add({
        category: "saved",
        name: ident(m[1]),
        evidence: t,
        line_hint: hintOf(w),
        note: "per-block 요약 (par.X(iR))",
      });
    }

    // per-session meta fields
    m = t.match(
      /\bpar\.(subID|subjNum|day|dist|group|expType|isexercise|isdemo|time_start|prevDayBest|schedule|scheduleRngState)\b/,
    );
    if (m) {
      sink.add({
        category: "saved",
        name: ident(m[1]),
        evidence: t,
        line_hint: hintOf(w),
        note: "per-session 메타 — finalState 에 저장됨",
      });
    }

    // sinks: save('file.mat', 'X', ...)
    m = t.match(/\bsave\s*\(\s*[^,]*['"]([^'"]+\.mat)['"]/);
    if (m) {
      sink.add({
        category: "saved",
        name: `(file) ${ident(m[1])}`,
        evidence: t,
        line_hint: hintOf(w),
        note: "저장 sink — 파일명",
      });
    }

    // between-subject IV: mod(subjNum, N)
    m = t.match(/\bmod\s*\(\s*(?:par\.)?subj?N?u?m?\w*\s*,\s*(\d+)\s*\)/i);
    if (m) {
      sink.add({
        category: "factor",
        name: `mod(subjNum,${m[1]})`,
        evidence: t,
        line_hint: hintOf(w),
        note: "between_subject 배정 — design_matrix 에 패턴 기록",
      });
    }

    // within_subject / phase split: if par.day == N
    m = t.match(/\bif\s+(?:par\.)?day\s*==\s*(\d+)/);
    if (m) {
      sink.add({
        category: "structure",
        name: `day==${m[1]} 분기`,
        evidence: t,
        line_hint: hintOf(w),
        note: "block_phases 분리 후보 (training vs test day)",
      });
    }

    // within_session block-kind: par.StairTrainTest = [...]
    m = t.match(/\bpar\.StairTrainTest\s*=\s*(\[[^\]]+\]|[^;]+ones)/);
    if (m) {
      sink.add({
        category: "factor",
        name: "StairTrainTest",
        evidence: t,
        line_hint: hintOf(w),
        note: "벡터=within_session block-kind / N*ones=상수(parameter)",
      });
    }

    // timing / setup parameters
    m = t.match(
      /\bpar\.([A-Za-z_]\w*)\s*=\s*([0-9.]+)\s*;?\s*%?.*$/,
    );
    if (m && /pre|cue|stim|isi|iti|delay|dur|len|feedback|time|wait/i.test(m[1])) {
      sink.add({
        category: "parameter",
        name: ident(m[1]),
        evidence: t,
        line_hint: hintOf(w),
        note: "셋업 상수 (timing) — shape=constant",
      });
    }
  }
  return sink.all();
}

const PTB_EXTRACTION = [
  "**Psychtoolbox / MATLAB 렌즈 (CSNL 랩 컨벤션)** — 이 플랫폼에서 각 개념이 어떻게 인코딩되는지:",
  "- *trial 루프*: `for iT = 1:nT` 안. *block 루프*: `for iR = 1:nBlocks` 안. iR=블럭 인덱스, iT=트라이얼 인덱스.",
  "- *per-trial 기록*: `par.X{iR}(iT)=`, `par.results.X{iR}(iT)=`, `par.X(iR,iT)=`. 발견되는 X 전부 saved_variables.",
  "- *타이밍*: `par.tp.<channel>{iR}(iT)` — cell-of-cell. **채널마다 별도 항목** (vbl_start/vbl_cue/vbl_resp/tend …), format=array, unit=sec(GetSecs).",
  "- *per-block 요약*: `par.results.X(iR)`, `par.blockX(iR)` (biasRepro/threshold/slope/R²).",
  "- *per-session 메타*: `par.subID/subjNum/day/dist/expType/isexercise/isdemo/time_start/rng.*` — 보통 setup_*/exp_info_*/param_init_* 에서 할당, 마지막 `save(...,'finalState')`. 누락 잦음 — 반드시 등록.",
  "- *저장 sink*: `save('results.mat',...)`, `run-wise-backup/results_<iR>.mat`, `trial_schedule.mat`. struct 통째 저장이어도 주요 필드는 별도 항목으로 풀어서.",
  "- *IV 분류*: `mod(subjNum,N)`→between_subject; `if par.day==N`→block_phases 분리(+day=within_subject longitudinal); `par.StairTrainTest=[1 1 2 2 3 3]`→within_session; `par.X = N*ones(1,nBlocks)`→**상수 parameter(IV 아님)**.",
  "- *흔한 실수*: `par.tp` struct 하나로 뭉치기 / subID·day 메타 누락 / 헤더 주석의 `0.5->0.3` 변경이력을 현재값으로 오인.",
];

const PTB_REVIEW = [
  "**PTB 감사 체크리스트** — 1차 JSON 을 아래 각 항목과 *대조*, 코드에 있는데 JSON 에 없으면 upsert patch:",
  "□ `par.tp.*` 타이밍 채널이 *채널별로* saved_variables 에 있는가? (struct 하나로 뭉쳐있으면 채널별 upsert)",
  "□ per-session 메타(subID/subjNum/day/dist/expType/isexercise/isdemo) 가 saved_variables 에 모두 있는가?",
  "□ per-trial 자극/반응/per-block 요약 `par.results.*` 누락 없는가?",
  "□ `mod(subjNum,N)` 가 between_subject factor 로 잡혔는가? design_matrix 에 패턴 기술됐는가?",
  "□ `if par.day==N` 분기가 meta.block_phases 로 분리됐는가? (단일 n_blocks 평탄화면 set_meta + 누락 phase 는 warnings)",
  "□ `par.X = N*ones(...)` 가 factors 에 잘못 들어갔으면 remove_factor + upsert_parameter(shape=constant).",
];

// ---------------------------------------------------------------------------
// PsychoPy / Python lens
// ---------------------------------------------------------------------------
function probePsychoPy(bundle: string): PlatformProbeHit[] {
  const sink = new HitSink();
  for (const w of walkBundle(bundle)) {
    const t = w.text;
    if (!t || /^\s*#/.test(t)) continue;

    // conditions file → conditions_file parameter, levels live in the csv
    let m = t.match(/importConditions\s*\(\s*[^'"]*['"]([^'"]+)['"]/);
    if (m) {
      sink.add({
        category: "parameter",
        name: "conditions_file",
        evidence: t,
        line_hint: hintOf(w),
        note: `조건표 ${ident(m[1])} — levels 는 csv 외부, factors 는 컬럼명에서`,
      });
    }

    // TrialHandler(nReps=, trialList=) → trial count structure
    m = t.match(/\b(?:data\.)?TrialHandler\w*\s*\(/);
    if (m) {
      const reps = t.match(/nReps\s*=\s*(\w+)/);
      sink.add({
        category: "structure",
        name: "TrialHandler",
        evidence: t,
        line_hint: hintOf(w),
        note: reps ? `n_trials = nReps(${reps[1]}) × len(trialList)` : "trial 수 = nReps × len(trialList)",
      });
    }

    // saved: .addData('name', …), thisExp.addData(...)
    m = t.match(/\.addData\s*\(\s*['"]([A-Za-z0-9_.]+)['"]/);
    if (m) {
      sink.add({
        category: "saved",
        name: ident(m[1]),
        evidence: t,
        line_hint: hintOf(w),
        note: "PsychoPy data 파일 컬럼",
      });
    }

    // saved sink: saveAsWideText / saveAsPickle / logging file
    m = t.match(/\bsaveAs(?:WideText|Pickle)\s*\(\s*[^'")]*['"]?([^'"),]*)/);
    if (m) {
      sink.add({
        category: "saved",
        name: `(file) ${ident(m[1] || "psychopy_data")}`,
        evidence: t,
        line_hint: hintOf(w),
        note: "저장 sink",
      });
    }

    // expInfo entries (meta — subj/session/condition)
    m = t.match(/expInfo\s*\[\s*['"]([^'"]+)['"]\s*\]/);
    if (m) {
      sink.add({
        category: "parameter",
        name: `expInfo.${ident(m[1])}`,
        evidence: t,
        line_hint: hintOf(w),
        note: "분기-지정이면 factor, 단일값이면 parameter",
      });
    }

    // explicit IV convention
    m = t.match(/independent[_-]?vars?\s*[:=]\s*\[([^\]]+)\]/i);
    if (m) {
      for (const tok of m[1].split(",").map(ident).filter(Boolean)) {
        sink.add({
          category: "factor",
          name: tok,
          evidence: t,
          line_hint: hintOf(w),
          note: "명시된 IV (independent_vars)",
        });
      }
    }

    // timeline variable read: thisTrial['col'] / trials.thisTrial.col
    m = t.match(/thisTrial\s*\[\s*['"]([A-Za-z0-9_]+)['"]\s*\]/);
    if (m) {
      sink.add({
        category: "factor",
        name: ident(m[1]),
        evidence: t,
        line_hint: hintOf(w),
        note: "조건표 컬럼 사용 — within-session factor 후보",
      });
    }

    // visual.<Stim>( …) setup
    m = t.match(/\bvisual\.([A-Z]\w+)\s*\(/);
    if (m) {
      sink.add({
        category: "structure",
        name: `visual.${ident(m[1])}`,
        evidence: t,
        line_hint: hintOf(w),
        note: "자극 셋업 — 파라미터 추출 대상",
      });
    }
  }
  return sink.all();
}

const PSYCHOPY_EXTRACTION = [
  "**PsychoPy / Python 렌즈** — 이 플랫폼에서 각 개념이 어떻게 인코딩되는지:",
  "- *trial 구조*: `data.TrialHandler(trialList=…, nReps=N)` → trial 수 = N × len(trialList). `TrialHandlerExt`/`MultiStairHandler` 도 동일 취급.",
  "- *조건/IV*: `data.importConditions('cond.csv')` → `conditions_file` parameter; **실제 levels 는 csv 외부**. 코드에서 `thisTrial['col']` 로 읽는 컬럼명이 within-session factor.",
  "- `expInfo` dict: 단일값이면 parameter, `if expInfo['cond']==..` 처럼 분기 지정이면 factor. `gui.DlgFromDict` 로 수집.",
  "- *saved*: `.addData('name', val)` / `thisExp.addData(...)` 가 데이터 파일 컬럼. `addData` 호출 전부 saved_variables.",
  "- *저장 sink*: `thisExp.saveAsWideText('x.csv')`, `saveAsPickle`, `logging.LogFile`.",
  "- *타이밍 파라미터*: `core.wait(t)`, `<clock>.getTime()`, frame 기반 `for frameN in range(...)`; 상수 timing 은 parameters[shape=constant].",
  "- *흔한 실수*: conditions.csv 컬럼을 levels 로 못 가져옴(파일 외부라 OK, factor 이름만 등록 + warnings) / `addData` 일부 누락 / Builder 생성 코드의 `thisComponent` 노이즈를 변수로 오인.",
];

const PSYCHOPY_REVIEW = [
  "**PsychoPy 감사 체크리스트** — 1차 JSON 과 대조, 누락이면 patch:",
  "□ 모든 `.addData('X',…)` 의 X 가 saved_variables 에 있는가? (가장 흔한 누락)",
  "□ `importConditions(csv)` 가 conditions_file parameter 로, 그 csv 컬럼들이 factor 로 등록됐는가?",
  "□ `TrialHandler(nReps=N, trialList=…)` 로 n_trials 구조가 반영됐는가?",
  "□ `expInfo` 항목 중 분기 지정에 쓰인 것이 factor 로 분류됐는가?",
  "□ `saveAsWideText/Pickle` sink 가 saved_variables 의 sink 컬럼에 반영됐는가?",
];

// ---------------------------------------------------------------------------
// jsPsych / JS lens
// ---------------------------------------------------------------------------
function probeJsPsych(bundle: string): PlatformProbeHit[] {
  const sink = new HitSink();

  // factorial({a:[...], b:[...]}) can span lines — scan the whole bundle.
  for (const fm of bundle.matchAll(
    /jsPsych\.randomization\.\w+\s*\(\s*\{([\s\S]{0,600}?)\}\s*[,)]/g,
  )) {
    for (const pm of fm[1].matchAll(/(['"]?[A-Za-z_]\w*['"]?)\s*:\s*\[/g)) {
      sink.add({
        category: "factor",
        name: ident(pm[1]),
        evidence: fm[0].slice(0, 120),
        line_hint: null,
        note: "jsPsych.randomization factor × levels",
      });
    }
  }

  for (const w of walkBundle(bundle)) {
    const t = w.text;
    if (!t || /^\s*\/\//.test(t)) continue;

    // timelineVariable('x') → within-session factor
    let m = t.match(/jsPsych\.timelineVariable\s*\(\s*['"]([A-Za-z0-9_]+)['"]/);
    if (m) {
      sink.add({
        category: "factor",
        name: ident(m[1]),
        evidence: t,
        line_hint: hintOf(w),
        note: "timelineVariable — within_session factor",
      });
    }

    // timeline_variables: [ {a:.., b:..}, ... ] — keys are factors
    m = t.match(/timeline_variables\s*:/);
    if (m) {
      sink.add({
        category: "structure",
        name: "timeline_variables",
        evidence: t,
        line_hint: hintOf(w),
        note: "객체 키들이 within_session factor",
      });
    }

    // on_finish: data.X = …  → saved
    m = t.match(/\bdata\.([A-Za-z_]\w*)\s*=/);
    if (m && /on_finish|on_load|function|=>/.test(t) === false) {
      // bare data.X = assignment
      sink.add({
        category: "saved",
        name: ident(m[1]),
        evidence: t,
        line_hint: hintOf(w),
        note: "trial data 필드",
      });
    }
    m = t.match(/on_finish\s*:\s*(?:function\s*)?\(?\s*\w*\s*\)?\s*=?>?\s*\{?[\s\S]{0,80}?data\.([A-Za-z_]\w*)/);
    if (m) {
      sink.add({
        category: "saved",
        name: ident(m[1]),
        evidence: t,
        line_hint: hintOf(w),
        note: "on_finish 기록 필드",
      });
    }

    // data: { k: v } on a trial node
    m = t.match(/\bdata\s*:\s*\{([^}]{1,160})\}/);
    if (m) {
      for (const km of m[1].matchAll(/([A-Za-z_]\w*)\s*:/g)) {
        sink.add({
          category: "saved",
          name: ident(km[1]),
          evidence: t,
          line_hint: hintOf(w),
          note: "trial node data:{} 필드",
        });
      }
    }

    // jsPsych.data.addProperties({...}) — global metadata on every row
    m = t.match(/jsPsych\.data\.addProperties\s*\(\s*\{([^}]{1,160})\}/);
    if (m) {
      for (const km of m[1].matchAll(/([A-Za-z_]\w*)\s*:/g)) {
        sink.add({
          category: "saved",
          name: ident(km[1]),
          evidence: t,
          line_hint: hintOf(w),
          note: "addProperties — 전 trial 공통 메타",
        });
      }
    }

    // plugin type → structure
    m = t.match(/\btype\s*:\s*(jsPsych[A-Z]\w+)/);
    if (m) {
      sink.add({
        category: "structure",
        name: ident(m[1]),
        evidence: t,
        line_hint: hintOf(w),
        note: "plugin — trial 유형",
      });
    }

    // sinks
    m = t.match(/jsPsych\.data\.get\(\)\.(?:csv|json|localSave)\s*\(|jsPsychPipe|saveData\s*\(/);
    if (m) {
      sink.add({
        category: "saved",
        name: "(data sink)",
        evidence: t,
        line_hint: hintOf(w),
        note: "데이터 저장 경로 (csv/localSave/DataPipe)",
      });
    }
  }
  return sink.all();
}

const JSPSYCH_EXTRACTION = [
  "**jsPsych / JavaScript 렌즈** — 이 플랫폼에서 각 개념이 어떻게 인코딩되는지:",
  "- *trial 단위*: `timeline` 배열의 각 노드. `type: jsPsych<Plugin>` 가 trial 유형. `timeline_variables: [{...}]` + `jsPsych.timelineVariable('x')` 가 within_session factor.",
  "- *IV*: `jsPsych.randomization.factorial({f:[...], g:[...]})` 인자 객체가 factor × levels. `repetitions`/`sample` 로 trial 수.",
  "- *saved*: 노드의 `data: { key: val }`, `on_finish:(data)=>{ data.X=… }`, `jsPsych.data.addProperties({...})`(전 row 공통 메타). 이 세 경로 전부 saved_variables.",
  "- *저장 sink*: `jsPsych.data.get().csv()/json()/localSave()`, DataPipe `jsPsychPipe`, 커스텀 `saveData()` — sink 컬럼에 기록.",
  "- *타이밍 파라미터*: `trial_duration`, `stimulus_duration`, `post_trial_gap`, `fixation` 시간 등 상수는 parameters[shape=constant].",
  "- *흔한 실수*: `data:{}` 의 키 일부 누락 / `timelineVariable` IV 를 parameter 로 오분류 / plugin 기본 수집 필드(rt, response) 누락.",
];

const JSPSYCH_REVIEW = [
  "**jsPsych 감사 체크리스트** — 1차 JSON 과 대조, 누락이면 patch:",
  "□ 모든 노드의 `data:{}` 키, 모든 `on_finish` 의 `data.X=` 가 saved_variables 에 있는가?",
  "□ `jsPsych.data.addProperties({...})` 의 키(전 row 공통 메타)가 등록됐는가?",
  "□ `randomization.factorial({...})` 의 각 키가 factor, 배열이 levels 로 등록됐는가?",
  "□ `timelineVariable('x')` 로 읽는 x 가 within_session factor 로 분류됐는가?",
  "□ 플러그인 기본 수집(rt/response/correct 등)이 saved_variables 에 반영됐는가?",
  "□ 데이터 저장 경로(csv/localSave/DataPipe)가 sink 으로 기록됐는가?",
];

// ---------------------------------------------------------------------------
// generic fallback lens (mixed / unknown / R / lab.js / custom loops)
// ---------------------------------------------------------------------------
function probeGeneric(bundle: string): PlatformProbeHit[] {
  const sink = new HitSink();
  for (const w of walkBundle(bundle)) {
    const t = w.text;
    if (!t || /^\s*(#|\/\/|%)/.test(t)) continue;

    // SCREAMING_SNAKE constants → parameters
    let m = t.match(/^\s*(?:const|let|var)?\s*([A-Z][A-Z0-9_]{2,})\s*[=:]\s*([^;]+)/);
    if (m && !/[([]/.test(m[2])) {
      sink.add({
        category: "parameter",
        name: ident(m[1]),
        evidence: t,
        line_hint: hintOf(w),
        note: "셋업 상수 (SCREAMING_SNAKE) — shape=constant",
      });
    }

    // row append into a results frame/array → per-trial saved
    m = t.match(
      /\b(?:results|data|trials|df)\s*(?:\.append\s*\(|\[\s*len\([^)]*\)\s*\]\s*=|=\s*rbind\s*\()/,
    );
    if (m) {
      sink.add({
        category: "saved",
        name: "(per-trial row)",
        evidence: t,
        line_hint: hintOf(w),
        note: "결과 프레임 행 추가 — 컬럼들이 saved_variables",
      });
    }

    // file sinks
    m = t.match(
      /\b(?:to_csv|write\.csv|fwrite|writeFile|np\.save|savetxt|writeLines|fopen)\s*\(\s*[^,]*['"]([^'"]+)['"]/,
    );
    if (m) {
      sink.add({
        category: "saved",
        name: `(file) ${ident(m[1])}`,
        evidence: t,
        line_hint: hintOf(w),
        note: "저장 sink",
      });
    }

    // RNG-sampled per-trial variables
    m = t.match(/\b([A-Za-z_]\w*)\s*=\s*(?:runif|rnorm|sample|Math\.random|np\.random\.\w+)\s*\(/);
    if (m) {
      sink.add({
        category: "factor",
        name: ident(m[1]),
        evidence: t,
        line_hint: hintOf(w),
        note: "RNG sampled — per_trial 변수 후보",
      });
    }
  }
  return sink.all();
}

const GENERIC_EXTRACTION = [
  "**일반/혼합 프레임워크 렌즈** (R · vanilla JS · 직접 루프 · lab.js):",
  "- per-trial: `for` 루프 안에서 `results.append(...)` / `rbind(df, ...)` / `data[i]=` → 추가되는 컬럼 전부 saved_variables.",
  "- parameters: 대문자 상수(N_TRIALS, ITI_MS, FEEDBACK_MS …) 전부 shape=constant 로 등록.",
  "- factors: `x = runif/rnorm/sample/np.random(...)` → per_trial; 루프마다 바뀌는 `block_kind`/`phase` 문자열 → within_session.",
  "- sink: `to_csv`/`write.csv`/`fwrite`/`np.save`/`writeFile` 의 파일명.",
];

const GENERIC_REVIEW = [
  "**일반 감사 체크리스트** — 1차 JSON 과 대조, 누락이면 patch:",
  "□ 결과 프레임에 append 되는 모든 컬럼이 saved_variables 에 있는가?",
  "□ 대문자 상수가 parameters[shape=constant] 로 빠짐없이 등록됐는가?",
  "□ RNG 로 샘플링되는 per-trial 변수가 factors(per_trial) 로 잡혔는가?",
  "□ 파일 저장 sink 가 기록됐는가?",
];

// ---------------------------------------------------------------------------
// registry
// ---------------------------------------------------------------------------
const LENSES: Record<Platform, PlatformLens> = {
  psychtoolbox: {
    platform: "psychtoolbox",
    label: "Psychtoolbox (MATLAB)",
    framework: "psychtoolbox",
    extractionLens: PTB_EXTRACTION,
    reviewChecklist: PTB_REVIEW,
    probe: probePsychtoolbox,
  },
  psychopy: {
    platform: "psychopy",
    label: "PsychoPy (Python)",
    framework: "psychopy",
    extractionLens: PSYCHOPY_EXTRACTION,
    reviewChecklist: PSYCHOPY_REVIEW,
    probe: probePsychoPy,
  },
  jspsych: {
    platform: "jspsych",
    label: "jsPsych (JavaScript)",
    framework: "jspsych",
    extractionLens: JSPSYCH_EXTRACTION,
    reviewChecklist: JSPSYCH_REVIEW,
    probe: probeJsPsych,
  },
  generic: {
    platform: "generic",
    label: "Generic / mixed",
    framework: "custom",
    extractionLens: GENERIC_EXTRACTION,
    reviewChecklist: GENERIC_REVIEW,
    probe: probeGeneric,
  },
};

export function lensFor(platform: Platform): PlatformLens {
  return LENSES[platform];
}

// Render probe hits as a compact, grounded evidence list for the
// reviewer prompt. Kept terse — the reviewer also has the full code.
export function summariseProbeHits(
  hits: PlatformProbeHit[],
  max = 60,
): string {
  if (hits.length === 0) return "(probe 후보 없음)";
  const byCat: Record<ProbeCategory, PlatformProbeHit[]> = {
    factor: [],
    parameter: [],
    saved: [],
    structure: [],
  };
  for (const h of hits.slice(0, max)) byCat[h.category].push(h);
  const lines: string[] = [];
  const titles: Record<ProbeCategory, string> = {
    factor: "factors(IV) 후보",
    parameter: "parameters 후보",
    saved: "saved_variables 후보",
    structure: "구조/phase 후보",
  };
  for (const cat of ["factor", "saved", "parameter", "structure"] as ProbeCategory[]) {
    const items = byCat[cat];
    if (items.length === 0) continue;
    lines.push(`■ ${titles[cat]} (${items.length}):`);
    for (const h of items) {
      const loc = h.line_hint ? ` @${h.line_hint}` : "";
      const note = h.note ? ` — ${h.note}` : "";
      lines.push(`  • ${h.name}${loc}${note}`);
    }
  }
  return lines.join("\n");
}
