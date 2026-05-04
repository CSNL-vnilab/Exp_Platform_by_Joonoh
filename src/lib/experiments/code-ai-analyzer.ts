// AI-driven extractor: refines / completes the heuristic CodeAnalysis by
// asking Qwen via Ollama with format=json + a JSON-Schema hint. The
// heuristic output is passed in the prompt as a seed so the model only
// has to fill gaps and correct mistakes — much cheaper than a cold
// extraction pass and usable on smaller models (Qwen3.6-35B-A3B).

import {
  CodeAnalysisSchema,
  CODE_ANALYSIS_JSON_SCHEMA_HINT,
  SUPPORTED_FRAMEWORKS,
  SUPPORTED_GENRES,
  SUPPORTED_LANGS,
  type CodeAnalysis,
  type CodeAnalysisOverrides,
} from "./code-analysis-schema";
import { applyPatch, parsePatchBlocks } from "./code-analysis-patch";
import {
  resolveProvider,
  resolveReviewProvider,
  type LLMProvider,
} from "./llm-provider";

export interface AiAnalyzeInput {
  code: string;
  filename?: string | null;
  heuristic: CodeAnalysis;
  signal?: AbortSignal;
  // Explicit ollama tag (e.g. "qwen3.6:latest"). For the bench harness.
  // Production code paths should leave this null and let the provider
  // factory pick.
  model?: string;
  // Force a specific provider. "auto" honours env / availability.
  provider?: "ollama" | "anthropic" | "auto";
  // Optional researcher-supplied prose (README, summary.md, IRB protocol).
  // Massively raises accuracy on ambiguous experiments because the AI
  // can ground "which IV is the *real* IV" in human-curated text rather
  // than guessing from code structure alone.
  docs?: string | null;
  // Override the default system prompt — used by the prompt bench.
  systemPromptOverride?: string;
  // Override the user payload — used by the prompt bench.
  userPromptOverride?: string;
  // Force the second-pass refinement on/off. When undefined, env
  // REFINEMENT=on enables it, REFINEMENT=off (or unset) disables it.
  refinement?: boolean;
  // Override the review-pass model tag (Ollama tag or Anthropic model).
  refinementModel?: string;
  // Override the review-pass provider. "auto" honours env.
  refinementProvider?: "ollama" | "anthropic" | "auto";
}

export interface AiAnalyzeResult {
  analysis: CodeAnalysis;
  model: string;
  // Populated only when the second-pass refinement ran.
  refinement?: {
    model: string;
    appliedCount: number;
    rejectedCount: number;
    durationMs: number;
  };
}

const CODE_BUDGET = 80_000; // chars — fits comfortably in 32k ctx with Qwen tokenizer

// ---------------------------------------------------------------------------
// Prompt presets — exposed so the bench harness (scripts/prompt-bench.mjs)
// can A/B different framings against ground truth and pick a winner.
//
// Layered design:
//   1. `general` block (framework-agnostic core rules)
//   2. framework augmentation (psychopy / jspsych / matlab-ptb / r)
//   3. genre hint (psychophysics / decision / estimation / …)
//
// At runtime, `buildSystemPrompt` composes [general, framework-aug, genre-hint]
// based on the heuristic-detected `meta.framework` and (if present)
// `meta.domain_genre`. The bench overrides this to A/B specific
// framings; production code paths use the auto-composed prompt.
// ---------------------------------------------------------------------------

interface BuildOpts {
  hasDocs?: boolean;
  framework?: string;
  domainGenre?: string;
}

const GENERAL_RULES = [
  "당신은 인지·행동 실험 코드를 메타데이터 JSON으로 추출하는 전문가입니다.",
  "출력은 JSON 객체 하나뿐 — 다른 텍스트, 마크다운, 주석 금지.",
  "코드 입력은 `=== file: path/to/file.ext (… lines, … chars; refs→[…]) ===` 헤더로 구분된 다중 파일 번들임 — 각 헤더 뒤의 라인은 *그 파일* 의 라인 번호임.",
  "",
  "**핵심 분류 규칙 (어떤 언어/프레임워크/장르에도 공통)**:",
  "1. **factors (조작 변수, IV)**: 실험자가 *의도적으로 변형*해 효과를 측정하는 변수. 코드에서 피험자/세션/날짜/조건/블럭/트라이얼 마다 *다른 값*을 갖는 것.",
  "   - **`role` 필드는 필수**. 다음 6개 enum 중 하나만 선택 — *enum 외의 값 금지*:",
  "     • `between_subject`  — 피험자 ID/group 별로 다름 (예: `subjNum`, `mod(subjNum,4)`, `group`).",
  "     • `within_subject`   — 같은 피험자가 세션/일자에 따라 다름 (예: `day`, `session`, `phase`).",
  "     • `within_session`   — 한 세션 안 블럭 사이에서 변함 (예: block-kind, day 안의 condition).",
  "     • `per_trial`        — trial 단위로 변함 (예: stimulus contrast, SOA, jitter).",
  "     • `derived`          — 다른 IV 의 함수 (예: `truth = f(orientation)`).",
  "     • `unknown`          — 분류 불가만, 최후 수단.",
  "   - `shape` enum 도 동일하게 스키마 외 값 금지: `constant | vector | expression | input | unknown` 만 허용.",
  "2. **parameters (셋업 상수)**: 모든 trial에서 *고정*된 셋업 값. timing, screen geometry, stimulus 셋업, 파일 경로 등.",
  "   - `shape` 필드: constant / vector / expression / input / unknown.",
  "3. **단일값(constant) 변수는 IV 가 아닙니다**. 코드에서 한 값으로만 등장하면 parameters[shape=\"constant\"] 에 분류, factors 에 절대 넣지 마세요.",
  "4. **벡터(vector) 변수**가 *블럭마다 다른 값*을 가지면 within-session block-kind factor 후보.",
  "5. **conditions**: 코드에서 *실제로 실행되는* factor-level 조합만 (Cartesian explosion 금지). 죽은 분기(`if cond==N elseif cond==M` 에서 사용 안 되는 N) 는 제외.",
  "",
  "**saved_variables — 빠짐없이 추출 (가장 흔한 누락 영역)**:",
  "6a. **per-trial 자극/조건**: trial 단위로 기록되는 stimulus 정보 (자극 값, 자극 카테고리/라벨, 분포 인덱스, feedback 마스크, 시드). 종종 `par.X{iR}(iT)`, `par.results.X{iR}(iT)`, `data.X = …`, `addData('X', …)` 형태.",
  "6b. **per-trial 반응**: response/choice/RT/accuracy/error/confidence/click_position/keypress.",
  "6c. **per-trial 타이밍**: 모든 timestamp/onset/RT/duration 채널을 *채널별로 분리* 해 등록. 컨테이너(struct/dict/cell-of-cell) 통째로 한 항목 X — 내부 키마다 별도 항목 O.",
  "6d. **per-trial 운동학/세부 자극** (해당 실험에 있을 때): kinematic / eye / hand / motion-trajectory 관련 필드 모두 등록.",
  "6e. **per-block 요약**: bias, threshold, slope, R², blockEnd 등. 종종 `par.results.X(iR)`, `par.blockX(iR)`.",
  "6f. **per-session 메타데이터**: subID, subjNum, day, dist/group, expType, isexercise/isdemo, time_start, rng.runStart/runEnd, schedule, scheduleRngState, distribution lookups.",
  "6g. **저장 파일 자체**: `save('foo.mat', 'struct')`, `to_csv`, `writeFile`, `np.save` — 파일명은 sink 컬럼.",
  "6h. *struct 통째로* 저장 (`save(file, 'finalState')`) 되는 경우, finalState 자체를 항목 하나로 등록 + sink=파일명. 단, 그 안의 *주요 필드* 는 별도 항목으로 풀어 등록 — 합쳐서 분석에 필요한 모든 변수가 saved_variables 에 등장해야 함.",
  "",
  "**구조 메타**:",
  "7. **meta.block_phases**: phase 가 여럿이면 `[{kind, n_blocks, n_trials_per_block?, day_range?, applies_when?, description?}]` 배열로 분리. 예: `[{kind:\"training\",n_blocks:10,day_range:\"1\"},{kind:\"test\",n_blocks:12,day_range:\"2-5\"}]`. 단일 phase 면 빈 배열. 단일 n_blocks 로 평탄화 금지.",
  "8. **meta.n_blocks 단일값**: block_phases 가 여러 개면 *대표값* 또는 *최대값* 을 단일 정수로. 모를 때만 null. 절대 \"10 or 12\" 같은 문자열 금지 — 정수만.",
  "9. **meta.design_matrix**: 피험자/세션 별 IV 배정 패턴 (예: `subjNum mod 4 → AABB/ABBA/...`) 은 자연어 설명으로 여기 넣고, conditions 에 cartesian 으로 풀지 말 것.",
  "10. **meta.domain_genre**: 코드의 task 구조와 saved_variable 모양으로 추정 (psychophysics / estimation / decision / retrieval / search / memory / motor / categorization / attention / imagery / language / social / gamified / perception / other).",
  "",
  "**기타**:",
  "11. **헤더 주석은 changelog**: `% Timing: tprecue 0.5->0.3` 같은 주석은 *변경 이력*. 본문 할당이 있으면 본문 우선.",
  "12. **확신 없으면 null + warnings 한국어 1줄 사유**.",
  "13. **line_hint 형식**: 다중 파일 번들 안 위치는 `\"sub/exp_info.m:25\"` 처럼 *파일경로:라인* 으로 적기 (모를 때만 null). 단일 파일이면 \"파일명:25\" 또는 \"25\" 둘 다 OK.",
  "14. **다중 프레임워크 / 적응형 / between-subject 분기**:",
  "   (a) repo 에 두 framework (예: PsychoPy + jsPsych mirror) 가 공존하면 둘 다 saved_variables/factors 에 반영하고 warnings 에 명시.",
  "   (b) 적응형 절차 (QUEST / staircase / Bayesian / 3-down-1-up) 의 IV 는 `per_trial` + `shape=expression` 으로 등록 — literal vector 가 없어도 IV.",
  "   (c) `mod(subjNum, N)` / Latin-square 분기는 *between_subject* — \"죽은 분기\"로 오인해 제거 금지. design_matrix 에 매핑을 자연어로 기록.",
];

const FRAMEWORK_AUGS: Record<string, string[]> = {
  psychopy: [
    "**PsychoPy 패턴 힌트**:",
    "- `expInfo` dict 항목은 메타 (subjNum, session, condition 등) — 단일 값이면 parameters, 분기-지정이면 factors.",
    "- `data.TrialHandler(trialList=…, nReps=N)` → trial 수는 nReps × len(trialList).",
    "- `data.importConditions('foo.csv')` → `conditions_file` parameter, 실제 levels 는 csv 외부.",
    "- `addData('field', value)` → saved_variables. PsychoPy data file 에 들어감.",
    "- `independent_vars = [...]` 패턴이 있으면 그 항목이 명시된 IV.",
  ],
  jspsych: [
    "**jsPsych 패턴 힌트**:",
    "- `jsPsych.randomization.factorial({...})` 인자 객체가 factor × levels 정의.",
    "- `timeline` 배열의 trial node 마다 `data:{}` 가 saved_variables 의 source.",
    "- `on_finish: function(data) { data.X = … }` 도 saved_variables.",
    "- `jsPsych.data.addProperties({...})` → 모든 trial 에 붙는 metadata.",
    "- `jsPsych.timelineVariable('X')` 가 자주 등장하면 X 가 within-session factor.",
  ],
  psychtoolbox: [
    "**Psychtoolbox / MATLAB 패턴 힌트** (CSNL 랩 컨벤션 포함):",
    "",
    "*[구조 / IV 분류]*",
    "- `par.condition = N * ones(1,nBlocks)` 처럼 단일값 곱셈은 *상수* — IV 가 아님 (parameters[shape=constant]).",
    "- `par.nT = [stair train test]` 배열에서 nonzero 원소가 활성 stage. 0 인 stage 는 미실행.",
    "- `par.StairTrainTest = [1 1 2 2 3 3]` 처럼 cell 배열은 within-session block-kind factor (role=within_session).",
    "- `if par.day == 1 nBlocks = N1; else nBlocks = N2;` → meta.block_phases 두 항목 (training day vs test day). `meta.n_blocks` 는 두 값 중 *대표값* 정수로.",
    "- `mod(subjNum, N)`, `pat = patList{...}` → between_subject IV. design_matrix 에 패턴 자연어 기록.",
    "- `par.day` (1..N) 가 longitudinal axis 면 within_subject role.",
    "",
    "*[saved_variables — 빠짐없이 추출]*",
    "MATLAB PTB 실험은 보통 5~6 개 카테고리에 흩어져 있음. 각 카테고리에서 *발견되는 모든 필드를 별도 항목으로* 등록하세요:",
    "",
    "(a) **per-trial 자극/조건** — `par.X{iR}(iT) = …` 또는 `par.results.X{iR}(iT) = …` 또는 `par.X(iR,iT) = …`. ",
    "    예: `Stm` (stimulus), `Stm_pr` (stimulus probability index), `thetaLabel` (분위 인덱스), `feedback` (피드백 마스크), `seed`.",
    "",
    "(b) **per-trial 반응** — `par.results.{Est, Error, RT, ResponseAngle, Choice, Confidence, Click, Hit}` 또는 `par.X(iR,iT)`.",
    "",
    "(c) **per-trial 타이밍** — `par.tp.X{iR}(iT)`. cell-of-cell 패턴 — *반드시* 채널별 풀어서 9개면 9개 항목으로:",
    "    `vbl_start`, `vbl_cue`, `vbl_occlu`, `vbl_occlu_end`, `vbl_cue2`, `vbl_respOnset`, `vbl_resp`, `tend`, `occlu_dur_observed` 등 발견되는 모든 키.",
    "    포맷=array, 단위=sec (PTB GetSecs).",
    "",
    "(d) **per-trial 운동학/세부 자극** (motion/trajectory 실험에 흔함) — `par.trial.X` 또는 `par.kin.X` 같은 sub-struct:",
    "    `tvm1/2/3`, `speed1/2`, `start1/2`, `dir1/2`, `end1`, `occl_end`, `sca_bound1/2`, `occ_deg`, `eyepos`, `handpos` 등.",
    "",
    "(e) **per-block 요약** — `par.results.X(iR)`, `par.blockX(iR)`, `par.CurrentStims.blockend(iR)`, `par.timestemp.blockdur(iR)`, `blockState.rng.blockEnd`.",
    "    예: `biasRepro`, `blockThreshold`, `logSlope`, `regSlope`, `R2`.",
    "",
    "(f) **per-session 메타데이터** — `par.subID`, `par.subjNum`, `par.day`, `par.dist`, `par.expType`, `par.isexercise`, `par.isdemo`, `par.time_start`, `par.rng.{runStart, runStartClock, runEnd}`, `par.prevDayBest`, `par.schedule`, `par.scheduleRngState`, `par.Stmdist1_15`, `par.Stmdist2_15`.",
    "    이 필드들은 보통 `setup_experiment_*.m` / `exp_info_*.m` / `param_init_*.m` 에서 할당되고 마지막 `save(...,'finalState')` 로 저장됨.",
    "",
    "(g) **저장 파일 (sink)** — `save('foo.mat', 'X')` 의 파일명을 sink 컬럼에 적기. 예: `results.mat` (finalState), `run-wise-backup/results_<iR>.mat` (blockState), `trial_schedule.mat` (schedule + scheduleRngState), `codebackup.zip`.",
    "    `blockState`/`finalState` 같은 상위 struct 도 항목 하나 (format=struct) — 그 안 *주요 필드들은 (a)~(f) 에서 별도 항목* 으로 다시 등록.",
    "",
    "*[흔한 실수]*",
    "- `par.tp` struct 자체만 등록하고 9개 채널을 안 풀면 NG — 풀어서 9개.",
    "- `subID`, `subjNum`, `day`, `dist` 같은 메타 필드 누락 — 반드시 finalState 에 들어가므로 saved_variables 에 등록.",
    "- `timestemp` 가 `timestamp` 의 오타지만 코드가 그대로 쓰면 그 이름 그대로 등록.",
  ],
  "lab.js": [
    "**lab.js 패턴 힌트**:",
    "- `lab.flow.Sequence({content: [...]})` 안 노드들이 trial. `parameters` 객체가 IV.",
    "- `lab.html.Form` 의 result 가 saved_variables.",
  ],
  // R / custom — generic framework. Common in survey / data-analysis
  // / shiny / direct-loop experiments.
  custom: [
    "**일반/커스텀 프레임워크 패턴 힌트** (R · vanilla JS · 직접 루프):",
    "- `for (i in 1:N)` 또는 `for (let i = 0; i < N; i++)` 루프 안에서 `data.frame`/`object` 에 행을 append → per-trial saved_variables.",
    "- 대문자 SCREAMING_SNAKE 상수 (N_TRIALS, ITI_MS, FEEDBACK_MS, BLOCK_DURATION, …) 는 모두 parameters[shape=constant] — 빠짐없이 등록.",
    "- R 의 `<-` 또는 `=` 할당, JS 의 `const`/`let` 모두 동일 처리.",
    "- `write.csv(df, 'foo.csv')` / `writeLines(...)` / `fwrite(...)` 등이 saved_variables sink — df 의 *모든 column* 을 항목으로.",
    "- `runif(1, lo, hi)` / `sample(...)` / `Math.random()` → per-trial 변수 candidate.",
    "- 만약 `block_kind` 또는 `phase` 같은 string 값이 outer loop 마다 다르면 within-session block-kind factor.",
  ],
  r: [
    "**R 패턴 힌트**:",
    "- `data.frame(...)` / `tibble(...)` / `rbind(results, ...)` 가 per-trial 저장. column 이름들이 saved_variables.",
    "- `library(...)` 는 노이즈 — 무시.",
    "- `runif`, `rnorm`, `sample` 등 RNG 호출은 per-trial IV (continuous) 가 sampled 됐다는 신호.",
    "- 대문자 상수 (N_TRAINING, ITI_MS, ...) 는 parameters.",
  ],
};

const GENRE_HINTS: Record<string, string> = {
  psychophysics:
    "psychophysics 실험의 IV는 보통 stimulus parameter (contrast, duration, SOA, eccentricity, …); DV는 detection / discrimination accuracy + RT + threshold.",
  estimation:
    "estimation 실험의 IV는 stimulus magnitude / prior shape; DV는 reproduction / estimation accuracy + bias + precision (+ regression slope).",
  decision:
    "decision 실험의 IV는 evidence strength / payoff / prior; DV는 choice + RT + confidence.",
  retrieval:
    "retrieval 실험의 IV는 cue type / delay; DV는 hit/false-alarm rate + RT + d'.",
  search:
    "visual search 실험의 IV는 set size / target presence / similarity; DV는 RT + accuracy.",
  memory:
    "memory 실험의 IV는 study duration / list length / interference; DV는 recall accuracy + d' + RT.",
  motor:
    "motor 실험의 IV는 perturbation / target jitter; DV는 endpoint error + reaction time + adaptation rate.",
  categorization:
    "categorization 실험의 IV는 category boundary / training set; DV는 classification accuracy + RT.",
  attention:
    "attention 실험의 IV는 cue validity / load; DV는 RT + accuracy + capture index.",
  imagery:
    "imagery 실험의 IV는 cue type / vividness rating; DV는 vividness scale + RT.",
  language:
    "language 실험의 IV는 syntactic / semantic manipulation; DV는 reading time + accuracy + plausibility rating.",
  social:
    "social 실험의 IV는 partner type / framing; DV는 cooperation rate + offers + ratings.",
  gamified:
    "gamified 실험의 IV는 reward schedule / level / opponent type; DV는 score + decisions + RT.",
  perception:
    "perception 실험의 IV는 modality / noise; DV는 detection rate + identification accuracy + bias.",
};

function composePrompt(opts: BuildOpts): string {
  const general = GENERAL_RULES.join("\n");
  const fw = (opts.framework ?? "").toLowerCase();
  const fwAug = FRAMEWORK_AUGS[fw] ? FRAMEWORK_AUGS[fw].join("\n") : "";
  const genre = (opts.domainGenre ?? "").toLowerCase();
  const genreHint = GENRE_HINTS[genre] ? `**장르 힌트**: ${GENRE_HINTS[genre]}` : "";
  const docs = opts.hasDocs
    ? "**문서 우선**: 참고 문서(README/summary/protocol)는 ground truth — 코드와 충돌 시 문서 우선."
    : "";
  return [general, fwAug, genreHint, docs, `JSON Schema:\n${CODE_ANALYSIS_JSON_SCHEMA_HINT}`]
    .filter(Boolean)
    .join("\n\n");
}

export const SYSTEM_PROMPT_PRESETS: Record<string, (o: BuildOpts) => string> = {
  // Baseline preset that shipped initially. Generic, schema-anchored.
  baseline: (o) =>
    [
      "당신은 인지·행동 실험 코드를 정확히 읽어 메타데이터를 구조화 JSON으로 추출하는 도구입니다.",
      "주어진 JSON Schema를 엄격히 따르는 객체만 출력하세요. 마크다운/주석/설명을 추가하지 않습니다.",
      "이미 휴리스틱 파서가 추출한 결과(seed)가 함께 제공됩니다. seed가 맞으면 그대로 두고, 잘못된 값만 수정하세요.",
      "확실하지 않은 값은 null 로 두고, warnings 배열에 한국어로 1줄 사유를 적으세요.",
      "factors(조작 변수)는 실험에서 의도적으로 변형되는 IV이며, parameters(파라미터)는 실험 셋업 상수입니다 — 혼동하지 마세요.",
      "conditions 는 가능한 factor-level 조합 중 코드에서 실제로 사용되는 것만 나열합니다 (Cartesian explosion 금지).",
      "saved_variables 는 `data.x = …`, `to_csv`, `addData(...)`, `save(...)` 등 데이터 sink 가 명시적인 항목만 포함합니다.",
      "line_hint 는 1-based 라인 번호. 모르면 null.",
      o.hasDocs
        ? "참고 문서(README/summary)가 함께 주어집니다. 문서와 코드가 충돌하면 문서를 우선 신뢰하되, 문서에 없는 사실은 코드에서만 추출하세요."
        : "",
      `JSON Schema:\n${CODE_ANALYSIS_JSON_SCHEMA_HINT}`,
    ]
      .filter(Boolean)
      .join("\n\n"),

  // Branch-aware preset: tells the model how to handle if/elif branches
  // in MATLAB / Python where multiple n_blocks values exist.
  "branch-aware": (o) =>
    [
      "당신은 인지·행동 실험 코드를 메타데이터 JSON으로 추출하는 전문가입니다.",
      "출력은 JSON 객체 하나뿐 — 다른 텍스트 금지.",
      "**핵심 규칙 (꼭 지키시오)**:",
      "1. **분기 안 정수 처리**: `if isexercise==0`, `if par.day==1` 같은 조건문 안에 nBlocks/nTrials 같은 정수가 있으면, 단순히 한 분기를 채택하지 말고 `meta.block_phases` 배열에 분리해 보존하세요. 예: Day1=10 training / Day2~5=12 test → block_phases 두 항목.",
      "2. **단일값(constant) 변수는 IV 가 아닙니다**. `par.condition = 2 * ones(1,nBlocks)` 처럼 단일 상수면 parameters[shape=\"constant\"] 에 분류, factors 에 절대 넣지 마세요.",
      "3. **벡터 변수는 within-session block-kind factor 후보**. `par.StairTrainTest = [1 1 2 2 3 3]` → factors 에 role=within_session 으로 등록.",
      "4. **헤더 주석은 변경 이력**: `% Timing: tprecue 0.5->0.3` 같은 주석은 *현재 값이 아니라 변경 로그*입니다. 본문 할당을 우선.",
      "5. **죽은 분기는 제외**: `if condition==2 ... elseif condition==3 ...` 에서 코드 본문이 condition=2만 사용한다면 condition=3 분기는 conditions 에 넣지 마세요.",
      "6. **factors.role**: between_subject (subjNum/group), within_subject (day/session), within_session (block-kind), per_trial (SOA/contrast), derived, unknown.",
      "7. **between-subject IV 잡기**: `mod(subjNum, N)` 으로 분포/조건 매핑 → between_subject factor.",
      "8. **per-day design**: `subjNum × day → dist` 매트릭스는 `meta.design_matrix` 에 자연어 설명으로. conditions 에 cartesian 으로 풀지 말 것.",
      "9. **확신 없으면 null + warnings**.",
      "10. **line_hint**: 1-based, 모르면 null.",
      o.hasDocs
        ? "11. **문서 우선**: 참고 문서가 함께 제공됩니다. 문서가 명시한 IV/phase/saved_variables는 문서를 신뢰하고, 코드에서 보강만 하세요."
        : "",
      `JSON Schema:\n${CODE_ANALYSIS_JSON_SCHEMA_HINT}`,
    ]
      .filter(Boolean)
      .join("\n\n"),

  // Save-schema-focused preset: optimized for catching every per-trial /
  // per-block / per-session output field (the largest miss category in
  // the magnitude experiment test).
  "save-focused": (o) =>
    [
      "당신은 실험 코드의 *데이터 저장 스키마*를 정확히 추출하는 전문가입니다.",
      "출력은 JSON 객체 하나뿐. 다른 텍스트 금지.",
      "**저장 변수(saved_variables) 추출 규칙**:",
      "- `par.results.X(iR)(iT) = …`, `par.tp.X{iR}(iT) = …`, `data.X = …`, `addData('X', …)`, `to_csv`, `np.save`, `writeFile`, `save(...)` 등 모든 데이터 sink 를 빠짐없이 추출.",
      "- 셀 배열로 wrap된 timing 필드 (`par.tp.{vbl_start, vbl_cue, …}`) 는 채널별로 풀어서 각각 별도 항목으로 등록.",
      "- 단위(unit)는 코드/주석/도메인 지식으로 추정: PTB GetSecs 결과는 sec, RT는 sec, angle은 deg, accuracy는 0/1.",
      "- format: 단일 숫자 → float/int, 배열/매트릭스 → array/matrix, struct → struct, mat 파일 → struct.",
      "- sink 는 파일명 또는 저장 위치 (results.mat, run-wise-backup/results_X.mat, par.results, data.csv 등).",
      "",
      "**factors / parameters 분류 핵심 규칙 (CSNL 행동실험 taxonomy)**:",
      "1. **단일값(constant)으로만 사용되는 변수는 IV 가 아닙니다.** `par.condition = 2 * ones(1,nBlocks)` 처럼 단일 상수면 parameters[] 에 `shape=\"constant\"` 로 분류. 절대 factors[] 에 넣지 마세요.",
      "2. **벡터로 블럭마다 변하는 변수는 within-session block-kind factor 후보**. 예: `par.StairTrainTest = [1 1 2 2 3 3]` → factors 에 등록 + role=within_session + levels=[stair,train,test].",
      "3. **factors.role 분류**: between_subject (subjNum/group), within_subject (day/session 단위), within_session (block-kind), per_trial (SOA/contrast/jitter), derived (다른 변수에서 계산), unknown.",
      "4. **`par.day`** 가 단일 longitudinal 변수면 factor 가 아닐 수도 있다. **Day1 만 훈련-only 같은 경우** `meta.block_phases` 에 `{kind:\"training\", day_range:\"1\"}` 와 `{kind:\"test\", day_range:\"2-5\"}` 로 분리하고, day 자체는 factor 가 아닌 longitudinal axis 로만 표시.",
      "5. **`if par.day == 1 nBlocks = 10; else nBlocks = 12;`** 같은 분기는 single n_blocks 로 평탄화하지 말 것 — `meta.block_phases` 에 두 항목으로 분리.",
      "6. **per-day mapping** (예: `subjNum mod 4 → AABB/ABBA/...`) 는 conditions[] 에 cartesian explosion 으로 풀지 말고, `meta.design_matrix` 에 한국어 설명으로 적기.",
      "7. **헤더 주석은 changelog**: `% Timing: tprecue 0.5->0.3` 같은 주석은 *변경 이력*. 본문 할당이 있으면 본문 우선.",
      "8. **죽은 분기 제외**: `if condition==2 ... elseif condition==3 ...` 에서 코드 본문이 condition=2 만 사용하면 condition=3 분기는 conditions 에 넣지 말 것.",
      "9. 확신 없으면 null + warnings 배열에 한국어 1줄 사유.",
      "",
      o.hasDocs
        ? "**문서 우선**: 참고 문서(README/summary/protocol)가 ground truth — 문서에 명시된 IV/phase/saved_variables 는 모두 등록하고, 코드와 충돌 시 문서 우선."
        : "",
      `JSON Schema:\n${CODE_ANALYSIS_JSON_SCHEMA_HINT}`,
    ]
      .filter(Boolean)
      .join("\n\n"),

  // Research-grade preset: explicit chain-of-thought structure (factors
  // first, then conditions, then parameters, then saved). For dense
  // models that respond well to staged extraction.
  "staged-cot": (o) =>
    [
      "당신은 행동·인지 실험 코드 분석가입니다. 정확한 JSON 메타데이터를 출력하세요.",
      "출력 형식: JSON 객체 하나뿐. 다른 텍스트 금지.",
      "**추출 단계 (순서대로)**:",
      "단계1. language/framework 식별.",
      "단계2. **factors 식별** (가장 중요):",
      "  a) 코드에서 피험자/세션/날짜/조건 마다 변하는 값을 찾는다. `subjNum`, `day`, `dist`, `condition`, `group` 등.",
      "  b) `mod(subjNum, N)`, `pat[day-1]`, `if day==1` 같은 분기 매핑은 between-subject 또는 within-subject factor를 의미.",
      "  c) 죽은 분기(코드 본문에서 사용 안 됨) 는 제외.",
      "단계3. **conditions 매핑**: factors의 어떤 level 조합이 어떤 라벨로 사용되는지. Cartesian explosion 금지 — 코드에서 실제로 사용되는 것만.",
      "단계4. **parameters 추출**: 모든 trial에서 고정된 셋업 상수. timing(tprecue, testimate, lentrial), 자극 범위(theta range, contrast levels), display(pxPerDeg) 등.",
      "  - 헤더 주석의 `0.5->0.3` 같은 변경 이력은 무시. 본문 할당을 우선.",
      "  - `if isexercise==0 / if isdemo==1` 분기에서 main 분기 값을 채택.",
      "단계5. **saved_variables 추출**: 모든 데이터 sink. per-trial / per-block / per-session 모두.",
      "단계6. 확신 없는 값은 null + warnings 배열에 사유.",
      o.hasDocs
        ? "**참고 문서 (ground truth)**: 코드와 충돌 시 문서를 우선 신뢰하세요."
        : "",
      `JSON Schema:\n${CODE_ANALYSIS_JSON_SCHEMA_HINT}`,
    ]
      .filter(Boolean)
      .join("\n\n"),

  // Default — composed = general core + framework-aware augmentation +
  // genre hint. Generalises across PsychoPy, jsPsych, MATLAB/PTB,
  // lab.js, R and any future framework added to FRAMEWORK_AUGS.
  composed: composePrompt,
};

export type SystemPromptPreset = keyof typeof SYSTEM_PROMPT_PRESETS;

// Default preset — `composed` layers framework-aware rules on top of
// the framework-agnostic core. This generalises beyond MATLAB/PTB: any
// PsychoPy / jsPsych / lab.js / R / generic code gets the right hints.
// Override via PROMPT_PRESET env at runtime to A/B specific presets.
const DEFAULT_PROMPT_PRESET: SystemPromptPreset =
  ((process.env.PROMPT_PRESET as SystemPromptPreset) in SYSTEM_PROMPT_PRESETS
    ? (process.env.PROMPT_PRESET as SystemPromptPreset)
    : "composed");

function buildSystemPrompt(opts: BuildOpts): string {
  return SYSTEM_PROMPT_PRESETS[DEFAULT_PROMPT_PRESET](opts);
}

export async function runAiAnalysis(input: AiAnalyzeInput): Promise<AiAnalyzeResult> {
  // Provider resolution: explicit override → env LLM_PROVIDER →
  // ANTHROPIC_API_KEY presence → Ollama. The bench supplies an
  // explicit model tag (Ollama path); production code lets the
  // factory pick.
  const provider: LLMProvider = await resolveProvider({
    override: input.provider ?? "auto",
    ollamaModel: input.model,
  });
  const code = input.code.slice(0, CODE_BUDGET);
  const truncated = input.code.length > CODE_BUDGET;

  const docs = (input.docs ?? "").slice(0, 30_000);
  const system =
    input.systemPromptOverride ??
    buildSystemPrompt({
      hasDocs: !!docs,
      framework: input.heuristic.meta.framework,
      // domain_genre is initially "other" from the heuristic; the
      // model fills it in. We pass whatever we have so the genre hint
      // can fire when the heuristic seeded a non-trivial genre.
      domainGenre: input.heuristic.meta.domain_genre,
    });

  const userPayload = {
    filename: input.filename ?? null,
    truncated,
    seed_from_heuristic: input.heuristic,
    code,
  };

  const userContent =
    input.userPromptOverride ??
    [
      docs
        ? "참고 문서(연구자 작성 — 실험 설계의 ground truth로 우선 신뢰):\n```\n" +
          docs +
          "\n```\n"
        : "",
      "아래 코드와 (있다면) 참고 문서를 정독하고 스키마에 맞는 JSON 만 출력하세요.",
      "`seed_from_heuristic` 은 정규식 초안입니다. 각 항목을 코드로 *재검증* 해 (a) 정확하면 그대로 유지, (b) 부정확하면 수정, (c) 환각이면 제거하세요. **추가**: seed 에 빠진 IV / parameter / saved_variable 은 반드시 신규 등록. seed 와 동일한 JSON 을 그대로 출력하는 것은 *검증을 안 했다는 신호* 로 간주됩니다.",
      "**완성도 체크리스트 — JSON 출력 직전 *반드시* 자기검증**:",
      "  □ 모든 factor 에 `role` 가 채워졌는가? (between_subject / within_subject / within_session / per_trial / derived)",
      "  □ 모든 parameter 에 `shape` 가 채워졌는가? (constant / vector / expression / input)",
      "  □ saved_variables 에 *per-trial 자극*, *per-trial 반응*, *per-trial 타이밍*, *per-block 요약*, *per-session 메타* 5 카테고리가 모두 들어있는가?",
      "    (없으면 그 이유를 warnings 에 적기 — 정말 없는지 vs 추출 못 했는지)",
      "  □ 참고 문서가 §4 / Saved Variables 섹션을 명시했다면, 그 *모든* 필드가 saved_variables 에 등록됐는가?",
      "  □ `meta.n_blocks` 가 정수인가? (블럭 수가 day 별로 다르면 *대표값* 을 정수로 — \"10 or 12\" 같은 문자열 금지)",
      "  □ `meta.block_phases` 가 단일 phase 가 아니면 채워졌는가?",
      "  □ line_hint 형식: 다중 파일 번들이면 `\"path:line\"`, 단일 파일이면 정수.",
      "",
      "```json",
      JSON.stringify(userPayload, null, 2),
      "```",
    ]
      .filter(Boolean)
      .join("\n");

  const messages = [
    { role: "system" as const, content: system },
    { role: "user" as const, content: userContent },
  ];

  // Strengthened prompt + bundled multi-file input pushes total tokens
  // past the default 32k context. With a 67KB bundle (~17K tokens) +
  // 5K system + 2K user, only ~8K remained for output and qwen
  // truncated mid-meta. Raising num_ctx to 64K leaves comfortable room
  // for a 20K-token JSON response. (Qwen3.6 supports up to 256K via
  // YaRN, but most local pulls quantise the rope settings around 64K.)
  const raw = await provider.chatJson<unknown>({
    messages,
    temperature: 0.1,
    num_ctx: 65_536,
    num_predict: 20_480,
    signal: input.signal,
  });

  const safe = CodeAnalysisSchema.safeParse(raw);
  if (!safe.success) {
    return {
      analysis: {
        ...input.heuristic,
        warnings: [
          ...input.heuristic.warnings,
          `AI 분석 결과 스키마가 일치하지 않아 휴리스틱 결과를 유지했습니다 (${safe.error.issues[0]?.message ?? "unknown"}).`,
        ],
      },
      model: `${provider.model} (${provider.name})`,
    };
  }
  if (truncated) {
    safe.data.warnings = [
      ...safe.data.warnings,
      `코드가 ${CODE_BUDGET.toLocaleString()}자 이상이어서 일부만 분석되었습니다.`,
    ];
  }

  const pass1: AiAnalyzeResult = {
    analysis: safe.data,
    model: `${provider.model} (${provider.name})`,
  };

  // ---- second-pass refinement (optional) -----------------------------
  // Env-gated A/B knob: REFINEMENT=on enables it. The reviewer model
  // (gemma4:31b by default, or Anthropic Opus when configured) gets
  // the pass-1 analysis + the original code and emits *only* <patch>
  // blocks for items it would correct. Patches are validated through
  // the same zod schema the chatbot patches use, so a hallucinated
  // enum can't corrupt the merged view.
  const refineEnabled =
    input.refinement ??
    (process.env.REFINEMENT ?? "").toLowerCase() === "on";
  if (!refineEnabled) return pass1;

  try {
    const refined = await runRefinement({
      pass1: pass1.analysis,
      code,
      filename: input.filename ?? null,
      docs,
      truncated,
      provider: input.refinementProvider,
      model: input.refinementModel,
      signal: input.signal,
    });
    // Keep the primary extraction model as `model`; the reviewer model
    // shows up under `refinement.model`.
    return {
      analysis: refined.analysis,
      model: pass1.model,
      refinement: refined.refinement,
    };
  } catch (err) {
    const detail = err instanceof Error ? err.message : String(err);
    pass1.analysis.warnings = [
      ...pass1.analysis.warnings,
      `2-pass refinement 실패 (${detail.slice(0, 120)}) — 1-pass 결과를 그대로 사용합니다.`,
    ];
    return pass1;
  }
}

// ---- two-pass refinement ---------------------------------------------
//
// runRefinement(): given a pass-1 CodeAnalysis, ask a *different* LLM
// to act as reviewer and emit <patch> blocks for items it would change.
// Patches go through validatePatch (PR #4) and are applied via
// applyPatch — same channel the chatbot uses, so any hallucinated
// enum / wrong-type value is rejected with a visible warning rather
// than silently corrupting the merged view.
//
// The default reviewer is gemma4:31b on Ollama (MODELS.reviewDeep);
// hosts can override with REFINEMENT_MODEL / REFINEMENT_PROVIDER env.
//
// Returns:
//   { analysis: refined CodeAnalysis,
//     refinement: { model, appliedCount, rejectedCount, durationMs } }

interface RefinementInput {
  pass1: CodeAnalysis;
  code: string;
  filename: string | null;
  docs: string | null;
  truncated: boolean;
  provider?: "ollama" | "anthropic" | "auto";
  model?: string;
  signal?: AbortSignal;
}

interface RefinementOutput {
  analysis: CodeAnalysis;
  refinement: NonNullable<AiAnalyzeResult["refinement"]>;
}

const REFINE_REVIEW_PROMPT = [
  "당신은 인지·행동 실험 코드 분석 결과를 *교차 검토*하는 리뷰어입니다.",
  "qwen3.6 분석기가 1차 추출한 메타데이터(JSON) 와 원본 코드(다중 파일 번들) 를 입력으로 받습니다.",
  "당신의 임무: 원본 코드를 다시 정독하고, 1차 추출이 *놓쳤거나 잘못 분류한* 항목을 찾아 patch 명령으로 emit.",
  "",
  "**출력 규칙 (필수)**:",
  "1. patch 블럭만 출력. patch 외부의 텍스트, 마크다운, 설명 *모두 금지*.",
  "2. 1차 추출이 정확하면 patch 0 개로 종료 (no-op 가 가장 안전한 응답).",
  "3. 각 patch 는 코드 라인 근거를 가져야 함. 추측 금지 — 코드에 근거가 없으면 emit 하지 말 것.",
  "",
  "**우선 점검 영역**:",
  "- factors: 누락된 IV (per-trial / within-session / between-subject), role 오분류, 단일값 변수를 IV 로 잘못 등록한 경우 (remove + parameter upsert).",
  "- parameters: 누락된 셋업 상수 (timing, screen, paths). default 값과 unit 도 함께.",
  "- saved_variables: 5 카테고리 — per-trial 자극, per-trial 반응, per-trial 타이밍, per-block 요약, per-session 메타. 누락된 항목 upsert.",
  "- meta.block_phases: phase 가 여러 개인데 단일 n_blocks 로 평탄화된 경우 set_meta + (phase 정보는 단일 patch 에 못 담으므로 warnings 에 자연어 요약 — 본 grammar 에는 block_phases set 이 없음, n_blocks 만 정정).",
  "- meta.domain_genre / framework / language: 잘못된 분류는 set_meta 로 정정.",
  "",
  "**사용 가능한 patch op (정확히 이 grammar — 다른 키 추가 금지)**:",
  '<patch>{"op":"set_meta","field":"n_blocks|n_trials_per_block|total_trials|estimated_duration_min|seed|summary|framework|language","value":...}</patch>',
  '<patch>{"op":"upsert_factor","name":"...","type":"categorical|continuous|ordinal","levels":["..."],"role":"between_subject|within_subject|within_session|per_trial|derived|unknown","description":"...","line_hint":"path:line"}</patch>',
  '<patch>{"op":"remove_factor","name":"..."}</patch>',
  '<patch>{"op":"upsert_parameter","name":"...","type":"number|string|boolean|array|other","default":"...","unit":"...","shape":"constant|vector|expression|input|unknown","description":"..."}</patch>',
  '<patch>{"op":"remove_parameter","name":"..."}</patch>',
  '<patch>{"op":"upsert_condition","label":"...","factor_assignments":{"factor":"level"},"description":"..."}</patch>',
  '<patch>{"op":"remove_condition","label":"..."}</patch>',
  '<patch>{"op":"upsert_saved_variable","name":"...","format":"int|float|string|bool|array|matrix|struct|csv-row|json|other","unit":"...","sink":"...","description":"..."}</patch>',
  '<patch>{"op":"remove_saved_variable","name":"..."}</patch>',
  "",
  `enum 값들 (정확히 일치해야 — 오타 / 추가 enum 금지):`,
  `- framework: ${SUPPORTED_FRAMEWORKS.join(" | ")}`,
  `- language: ${SUPPORTED_LANGS.join(" | ")}`,
  `- domain_genre: ${SUPPORTED_GENRES.join(" | ")}`,
  "",
  "분석 후 patch 를 0~30 개 범위에서 emit. 그 외 텍스트 출력 금지.",
].join("\n");

const REFINE_CODE_BUDGET = 80_000;
// 32K is the safe native context for most local Ollama gemma4 / qwen
// pulls without rope tweaks. Hosts with bigger models can override
// via REFINEMENT_NUM_CTX env. Earlier 65K default tripped Ollama's
// "invalid num_ctx" rejection on stock gemma4:31b pulls.
const REFINE_NUM_CTX_DEFAULT = 32_768;
const REFINE_NUM_PREDICT = 8_192;
// Hard ceiling to avoid hung reviewers masquerading as success. The
// outer try/catch in runAiAnalysis converts the AbortError to a
// warning on the analysis output. Override via REFINEMENT_TIMEOUT_MS.
const REFINE_TIMEOUT_MS_DEFAULT = 240_000;

async function runRefinement(input: RefinementInput): Promise<RefinementOutput> {
  const reviewer = await resolveReviewProvider({
    override: input.provider ?? "auto",
    ollamaModel: input.model,
    anthropicModel: input.model,
  });
  const code = input.code.slice(0, REFINE_CODE_BUDGET);
  const docs = (input.docs ?? "").slice(0, 30_000);
  const userContent = [
    docs
      ? "참고 문서(연구자 작성):\n```\n" + docs + "\n```\n"
      : "",
    "1차 추출 JSON (1차 추출기):",
    "```json",
    JSON.stringify(input.pass1, null, 2),
    "```",
    "",
    `원본 코드 번들 (filename hint: ${input.filename ?? "(unknown)"})${
      input.truncated ? " — 코드가 잘렸으니 일부 사실은 추론 불가" : ""
    }:`,
    "```",
    code,
    "```",
    "",
    "위 1차 추출에서 잘못/누락된 항목만 patch 로 emit 하세요. 정확하면 0 개 emit.",
  ]
    .filter(Boolean)
    .join("\n");

  const messages = [
    { role: "system" as const, content: REFINE_REVIEW_PROMPT },
    { role: "user" as const, content: userContent },
  ];

  const numCtx = clampPositiveInt(process.env.REFINEMENT_NUM_CTX, REFINE_NUM_CTX_DEFAULT);
  const timeoutMs = clampPositiveInt(process.env.REFINEMENT_TIMEOUT_MS, REFINE_TIMEOUT_MS_DEFAULT);
  // Caller's signal still wins if it fires earlier; we add an
  // independent timeout signal so a hung Ollama call can't pin the
  // bench / API request indefinitely.
  const timeoutSignal = AbortSignal.timeout(timeoutMs);
  const signal = input.signal
    ? AbortSignal.any([input.signal, timeoutSignal])
    : timeoutSignal;

  const t0 = Date.now();
  const text = await reviewer.chatText({
    messages,
    temperature: 0.1,
    num_ctx: numCtx,
    num_predict: REFINE_NUM_PREDICT,
    signal,
  });
  const durationMs = Date.now() - t0;

  const { blocks } = parsePatchBlocks(text);
  // Treat pass-1 as the seed for refinement. We *don't* pre-parse
  // through CodeAnalysisOverridesSchema — that strips defaults the
  // canonical schema injects (factor.role, parameter.shape, etc.).
  // The structural shape of CodeAnalysis is a strict subset of
  // CodeAnalysisOverrides (all top-level keys present), so applyPatch
  // can ingest it directly.
  let working = input.pass1 as unknown as CodeAnalysisOverrides;
  let appliedCount = 0;
  let rejectedCount = 0;
  const rejectedReasons: string[] = [];
  for (const b of blocks) {
    if (!b.patch) {
      rejectedCount += 1;
      if (b.error) rejectedReasons.push(b.error);
      continue;
    }
    const r = applyPatch(working, b.patch);
    if (r.error) {
      rejectedCount += 1;
      rejectedReasons.push(r.error);
      continue;
    }
    working = r.next;
    appliedCount += 1;
  }
  // Re-parse to fill any missing defaults and guarantee
  // CodeAnalysis shape. safeParse so we can attach a meaningful
  // warning instead of dropping pass-1 results on a future merge bug.
  const reparsed = CodeAnalysisSchema.safeParse(working);
  const refinedAnalysis = reparsed.success ? reparsed.data : input.pass1;
  if (!reparsed.success) {
    refinedAnalysis.warnings = [
      ...refinedAnalysis.warnings,
      `2-pass: 최종 검증 실패 — 1-pass 결과로 폴백 (${reparsed.error.issues[0]?.message?.slice(0, 100) ?? "?"})`,
    ];
  }
  if (rejectedCount > 0) {
    refinedAnalysis.warnings = [
      ...refinedAnalysis.warnings,
      `2-pass: 거부된 patch ${rejectedCount}개 (${rejectedReasons[0]?.slice(0, 80) ?? "?"})`,
    ];
  }
  return {
    analysis: refinedAnalysis,
    refinement: {
      model: `${reviewer.model} (${reviewer.name})`,
      appliedCount,
      rejectedCount,
      durationMs,
    },
  };
}

function clampPositiveInt(raw: string | undefined, fallback: number): number {
  if (!raw) return fallback;
  const n = Number.parseInt(raw, 10);
  return Number.isFinite(n) && n > 0 ? n : fallback;
}
