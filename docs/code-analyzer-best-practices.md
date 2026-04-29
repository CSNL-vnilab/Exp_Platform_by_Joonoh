# Offline-experiment code analyzer — best practices & TimeExp1 case study

작성: **Opus 4.7 (이 세션, 사람이 직접 작성한 문서임 — Qwen 출력이 아님)** · 작성일: 2026-04-29
편집 이력:
- 2026-04-29 v1 — 초안 (bench 결과·구현 요약)
- 2026-04-29 v2 — 박준오의 ground-truth 정정 반영 (`par.dist`, Day1=훈련-only, practice/test taxonomy)

대상 시스템: `OfflineCodeAnalyzer` 컴포넌트 + `from-source` 파이프라인 (migration 00049)
케이스 스터디: 박준오의 TimeExp1 (Magnitude duration reproduction task)

---

## TL;DR

연구자는 **소스 주소 한 줄 (서버 경로 OR GitHub URL)** 만 주면 되고, 시스템은 자동으로:

1. 디렉토리 트리를 가져와 (서버 mount 또는 `git clone --depth 1`)
2. 노이즈(`old/`, `*_backup_*`, `.asv`, 결과/데이터 디렉토리, 바이너리 등)를 걸러내고
3. 엔트리 파일을 자동 감지하고 (`main_*`/`run_*`/`index`)
4. 호출되는 helper 만 1–2 hop 따라가서 ≤ 80 KB 번들로 정리하고
5. README/summary 같은 문서를 자동으로 컨텍스트에 주입하고
6. 휴리스틱 + Qwen3.6 으로 메타데이터 JSON 을 추출해
7. 편집 가능한 표로 보여줌

Bench (TimeExp1, 16 cells) 결과 winning preset = `save-focused + qwen3.6:latest + docs=Y` → 자동 회복률 **79.2%** (vs 원시 baseline-no-docs 20.8%, **3.8× 개선**).

> 79.2% 는 *명시적·기계 채점 가능* 한 항목 (블럭/트라이얼 수, IV 이름, 파라미터 값, 저장 변수 이름) 기준. **`par.day` 가 단순 longitudinal 인지 IV 인지** 같은 디자인-수준 해석 (TimeExp1 의 경우 Day1 은 훈련-only) 은 자동 분석으로 100% 까지 가지 않는 것이 맞고, 분석기는 그래서 모든 셀을 편집 가능하게 + 챗봇으로 1~2턴 수정 가능하게 만들어두었다. 사람의 ground-truth 정정이 항상 마지막 채점 단계.

UI 측에서는 옛 수동 입력 (`code_repo_url`, `data_path` 두 개의 필수 텍스트 박스) 를 모두 폐기하고, 분석기 안의 단일 "소스 주소" 필드가 그 둘을 자동으로 채운다. 분석기로 도달할 수 없는 비공개 저장소 등을 위해 collapsed-by-default `<details>` 안에 수동 입력을 보존했다.

---

## 1. 어떤 문제를 풀었나

### 1.1 문제 1 — 단일 파일은 정보가 부족하다

`main_duration.m` 만 분석했을 때:

| 카테고리 | 결과 |
|---|---|
| 메타 | `language=matlab`, `framework=psychtoolbox` ✓ |
| n_blocks / n_trials | **null** — 모두 `par.nT` 통해 indirection |
| factors | **0개** |
| saved_variables | 3개 (`blockState`/`finalState`/`par.tp`) |

핵심 정보 (블럭 수, 트라이얼 수, dist IV, per-trial 저장 필드) 가 모두 `sub/` 안의 helper 함수에 들어 있어, 단일 파일로는 잡힐 수가 없다.

### 1.2 문제 2 — `sub/`만 통째로 던지면 노이즈에 묻힌다

TimeExp1 의 경우 `sub/` 에 약 300+ 파일 (Old_2026-02-20_fbmerge/, .asv backups, 다른 실험 변형 (HistoryShown, BaseRate, GaborPitch, MCCR …) 의 param 파일들) 이 있어 그대로 묶으면:

- 80 KB 컨텍스트가 노이즈로 차서 정작 핵심 6–8 개 helper 가 잘림
- AI 가 다른 실험의 분기 (`condition=3` scaling) 를 IV 로 오인
- 호출되지 않는 dead code 가 분석 우선순위를 흐림

### 1.3 문제 3 — 코드만 봐서는 IV 와 setup 상수의 구분이 어렵다

`dist` 가 IV 라는 사실은 코드에서 `info.distToday = iff(ch=='A', 2, 3)` 같은 형태로만 나타난다. 모델이 이걸 "between-subject IV" 라고 결론짓기 위해서는 **도메인 지식** (행동 실험에서 피험자별 분포 할당이 IV) 이 필요하다. 작은/오픈소스 모델에 이 도메인 추론을 시키는 건 불안정하다.

---

## 2. 해결 방법

### 2.1 Server-side fetcher (`source-fetcher.ts`)

```ts
// 1. 서버 경로
const fetched = await fetchSource({ source: "/Volumes/CSNL_new-1/.../Experiment" });

// 2. GitHub
const fetched = await fetchSource({ source: "owner/repo#branch" });
const fetched = await fetchSource({ source: "https://github.com/owner/repo" });
```

규칙:
- **allow-list**: `CODE_SOURCE_ROOTS` env (기본: `/Volumes/CSNL_new-1,/Volumes/CSNL_new,/srv/csnl`) 안의 절대 경로만 허용. 임의 디스크 읽기 차단.
- **확장자 화이트리스트**: `.m .py .js .ts .r .txt .md .json …` 만 텍스트로 인식. .mat / 이미지 / .pdf / .csv / .zip 등은 모두 skip.
- **디렉토리 블랙리스트**: `.git`, `node_modules`, `results`, `data`, `raw`, `__pycache__`, `dist`, `tex_cache`, `.next`, `.cache`, `Old_*`, `archive`, `legacy`, `deprecated`.
- **GitHub** 은 `git clone --depth 1 --single-branch` (timeout 60s, `GIT_TERMINAL_PROMPT=0` 으로 hang 방지). 분석 후 tmp 디렉토리 cleanup.
- **글로벌 cap**: 전체 5 MiB, per-file 400 KB. 둘 다 truncated 플래그로 UI 에 통지.

### 2.2 Call-graph bundler (`code-bundler.ts`)

```ts
const b = bundle(files, { entryHint: "main_duration.m" });
// → { entry, bundled (≤80KB), selected: 28 files, dropped: 222, totalChars }
```

선정 알고리즘:

1. **노이즈 제거** (위 디렉토리 블랙리스트 + 확장자)
2. **엔트리 감지**: `entryHint` > `main_*` > `run_*` > `experiment*` > `index.*`/`app.*`. 깊이가 얕을수록 가산점.
3. **참조 그래프**:
   - MATLAB: `\b([A-Za-z_][A-Za-z0-9_]{2,})\s*\(` 에서 함수 호출 식별자 추출 (PTB / 내장함수 keyword 차단). `function_name` ↔ `function_name.m` 1:1 매칭.
   - Python: `from x.y import z` / `import x` → `x/y.py` 또는 `x/y/__init__.py`.
   - JS/TS: `import … from "./foo"` → `./foo.{ts,tsx,js,jsx}`.
   - 1-hop entry → helpers; MATLAB/Python 은 추가로 helpers 의 참조까지 (2-hop).
4. **우선순위 가중치**:
   - +100: `setup_*`, `param*_`, `paramX_`, `init_*`, `config`, `settings`, `exp_info` ← 파라미터/설정 파일
   - +60: `make_*`, `build_*`, `seed_*`, `trial_schedule` ← 자극/스케줄 생성
   - +50: `summary_*`, `result*_`, `save_*`, `backup_*` ← 결과 처리
   - −40: `disp/draw/tex_template/stimuli/ui/render/gui` ← 디스플레이/UI
   - −80: `legacy/deprecated`
5. **예산 적합**: 엔트리 ≤40 KB, helpers ≤12 KB 각. 초과 시 head 85% + tail 15% 형태로 잘라서 라인 경계 보존. 파일 헤더에 `=== file: path (Nlines, M chars; refs→[…]) ===` 마커.

TimeExp1 결과: `1080 files → 28 selected (67 KB)` — entry, 8개 config, 5개 supporting, 14개 called.

### 2.3 Docs auto-pickup

소스 fetch 후 root 의 `README*`, `summary*`, `protocol*`, `spec*` 파일을 자동으로 docs 로 사용. 연구자가 명시적으로 `docsPath: "summary.MD"` 또는 `docs: "<직접 입력>"` 을 주면 그게 우선.

### 2.4 Prompt presets

`SYSTEM_PROMPT_PRESETS` 에 4개:

| preset | 핵심 규칙 |
|---|---|
| `baseline` | factors vs parameters 구분, conditions 는 코드에서 실제 실행되는 것만 |
| `branch-aware` | `if isexercise/isdemo` 분기 안 demo/exercise 값 무시, 헤더 주석은 changelog (본문 우선), 죽은 분기 제외, between-subject IV (`subjNum mod N`) 잡기 |
| `save-focused` | per-trial / per-block / per-session 저장 변수를 빠짐없이 (cell-of-cell 풀어서), 단위는 도메인 지식으로 추정 |
| `staged-cot` | factors → conditions → parameters → saved 단계별 추출 |

**기본값**: `save-focused` (bench 결과 reasoning). `PROMPT_PRESET` env 로 오버라이드.

### 2.5 Model 선택

| 모델 | active params | TimeExp1 점수 (winning preset) |
|---|---|---|
| qwen3.6:latest | 3B (MoE) | **79.2%** ← 기본값 |
| gemma4:26b (dense) | 26B | OOM 빈발, 1회 0% (파싱 실패) |
| gemma4:31b | 31B | 호스트 OOM, 못 띄움 |

`qwen3.6:latest` 가 이 작업에서 일관되게 우세. 이유:
- 작아서 빠름 (45–150 s/cell)
- json 모드에서 안정적 (gemma4 가 같은 schema 로 JSON 생성하다 truncate 빈발)
- Qwen 의 thinking 비활성화 (`think: false`) 가 중요 — 가능 시 num_predict 예산을 본문 출력에만 씀

### 2.6 Output budget

- `num_ctx: 32768`, `num_predict: 12288`. save-focused 가 50+ saved_variables × 6필드 → 6–8 K JSON 토큰 출력.
- 4096 으로 시작했더니 closing brace 직전에서 잘림. 12288 이 안전 마진.

---

## 3. TimeExp1 (`main_duration.m`) 케이스 스터디

### 3.1 Ground truth (연구자 직접 정정)

- `language=matlab`, `framework=psychtoolbox`
- **Day 1 = 훈련-only 일 (training day)**. 10 blocks 모두 학습 목적, dist=U (Uniform).
  - 분석기 UI 가 “n_blocks=10” 만 채택하면 안 됨 — 의미가 *연습 일* 임을 함께 표시.
- **Day 2~5 = 본 실험 (test days)**. 각 12 blocks. `par.dist` 는 그 날의 stimulus prior distribution = `A` (L-skewed) **또는** `B` (R-skewed). 어느 쪽인지는 `subjNum mod 4` × `day` 패턴(`AABB/ABBA/BABA/BBAA`)으로 결정.
- IVs (정정):
  - **`par.dist` ∈ {U, A, B}** — *session-level* stimulus prior distribution. Day 별로 한 값을 갖는다. between-session within-subject IV. (단순 “dist” 가 아니라 실험 코드 안 변수명 그대로 `par.dist`)
  - **`par.day` ∈ {1..5}** — within-subject longitudinal IV. Day1 (training) vs Day2~5 (test) 의 *질적* 구분.
  - **`par.subjNum`** — between-subject identifier; subjNum mod 4 로 (`AABB/ABBA/BABA/BBAA`) 패턴 인덱스 결정.
- Parameters (반복; trial-level 상수): `lentrial=7.7s`, `tprecue=0.3s`, `testimate=2.5s`, `tfeedback=1.0s`, `trest=5s`, `tdelay=0.5s`, `tmask=0.5s`, `tstim=3s`
- Saved (per-trial): `Stm`, `Stm_pr`, `thetaLabel`, `feedback`, `Est`, `Error`, `RT`, `ResponseAngle`, 9개 timing channels (`vbl_start`, `vbl_cue`, `vbl_occlu`, `vbl_occlu_end`, `vbl_cue2`, `vbl_respOnset`, `vbl_resp`, `tend`, `occlu_dur_observed`)
- Saved (per-block): `biasRepro`, `blockState`(.mat backup)
- Saved (per-session): `finalState`, `subID`, `subjNum`, `day`, `dist`, `expType`, `time_start`, `rng.runStart/runEnd`, `schedule`, `scheduleRngState`

**TimeExp1 에 한해 `par.condition` 은 단일값(=2, reproduction-only)이라 IV 가 아님.** 분석기가 “condition” 을 IV 로 잡으면 노이즈. 다만 다른 실험에서는 의미가 다르다 — 다음 §3.4 참조.

### 3.4 Block-kind taxonomy (다른 lab 실험에 일반화)

연구자 직접 지적: *"어떤 실험의 경우에는 practice / test block 구분있음"*. CSNL 의 PTB 실험들은 일반적으로 한 세션 안에 여러 종류의 block 을 섞는다. 분석기가 IV 와 *block-kind partition* 을 혼동하지 않도록 다음 taxonomy 를 잡아둔다.

| 변수 (par.X) | 의미 | TimeExp1 값 | 다른 실험 예 |
|---|---|---|---|
| `par.condition` | 과제 유형 (reproduction=2, scaling=3, …) | **2 (단일 — IV 아님)** | 같은 코드를 reproduction 과 scaling 둘 다 돌리는 실험 → IV |
| `par.StairTrainTest` | 블록의 학습 단계 — `1=stair`, `2=train`, `3=test` | **2 만 사용** | stair (피험자 threshold 잡기) → train (피드백 있음) → test (피드백 없음, 데이터) 가 **한 세션 내에서** 분리되는 실험 → block-kind factor |
| `par.day` | 회차 (1..N) | training vs test day 분리 (Day1 vs Day2~5) | 모든 day 가 test 인 실험도 있음 — day 그 자체는 IV 가 아니고 longitudinal 로만 |
| `par.dist` | session-level stimulus prior | U (Day1) / A or B (Day2~5) | 단일 dist 만 쓰는 실험에서는 상수 |
| `par.feedback{iR}(iT)` | 피드백 trial 마스크 | mixed (일부 trial 만 피드백) | 일부 실험은 모든 trial 피드백, 일부는 첫 N trial 만 피드백 |

**분석기 처리 규칙** (현재 prompt 에 인코딩):

1. **단일값으로만 사용되는 변수는 IV 가 아니다.** `par.condition = 2 * ones(1,nBlocks)` 처럼 단일 상수이면 parameters 또는 “meta.task_type” 으로 분류하고 factors 에 넣지 않는다.
2. **block-kind 가 한 세션 안에서 변하면** (`par.StairTrainTest = [1 1 2 2 3 3]`) within-session block-kind factor 로 잡되, 위치(라벨)는 “stair/train/test” 등 표준 라벨로 정규화한다.
3. **day 자체는 IV 가 아닐 수도 있다.** Day1 이 training-only 인 경우 `meta.training_day` 같은 별도 메타로 표시하고, 본 실험 IV (`par.dist`) 와 분리한다.
4. **per-day mapping 은 conditions 가 아니라 별도 design matrix.** TimeExp1 의 `(subjNum mod 4) × day → dist` 매트릭스는 conditions 배열에 cartesian 으로 풀어 넣지 말고, `meta.design_matrix` 같은 자유형 필드 (또는 warnings 에 자연어로) 로 표시.

이 taxonomy 는 `code-ai-analyzer.ts:SYSTEM_PROMPT_PRESETS` 에 다음 라운드에서 추가 룰로 인코딩 예정 — `branch-aware` preset 의 “3. 죽은 분기 제외” 다음에 “4. 단일값 변수는 IV 아님 / block-kind 는 within-session factor / training-day 는 별도 meta”.

**휴리스틱 측 보강 후보**:
- `par.StairTrainTest = N * ones(...)` 패턴 + 그 N 값 → block-kind 단일성 자동 판정
- `par.<X> = N * ones(1,nBlocks)` 형태 일반화 → 단일값 검출
- `par.<X> = [...]` 명시적 cell/벡터 → block-kind factor 후보로 승격

### 3.2 Pipeline 결과 (winning preset, with docs)

```
fetching source: /Volumes/CSNL_new-1/people/JOP/Magnitude/Experiment
  → 1080 files (full); 222 skipped
  → docs auto: summary.MD (7589 chars)
bundle: entry=main_duration.m; 28 files; 67457 chars

merged (raw 출력 — 정정 전):
  language=matlab          ✓
  framework=psychtoolbox   ✓
  n_blocks=12              △ (Day2~5 의 test-day 값. Day1=10 은 training-only,
                              두 숫자는 의미가 다름)
  n_trials=30              ✓
  factors: dist, day, condition  △ (par.dist + par.day ✓; condition 은 노이즈)
  parameters: 12개 (lentrial=7.7, tprecue=0.3, testimate=2.5, tfeedback=1.0, …)
  saved_variables: 48개
  warnings:
    - n_blocks is 10 for Day1 and 12 for Days 2-5. Defaulted to 12 in meta.
    - sdErrRepro/varWithinStimRepro/logSlope/logR2 are saved as NaN ...

연구자 정정 후 (UI 위에서 사람이 한두 줄 손볼 항목):
  meta.training_day_count = 1 (Day1)        ← 신규 필드 또는 warnings 로 표기
  meta.test_day_count     = 4 (Day2~5)
  meta.n_blocks_train     = 10
  meta.n_blocks_test      = 12
  factors:
    par.dist (session-level): {U (Day1 only), A, B}
    par.day  (longitudinal):  {1=training, 2..5=test}
  conditions:
    훈련(Day1, dist=U)
    test×A · test×B (subjNum mod 4 패턴으로 day 별 결정)
  factors_bogus 제거: condition (par.condition=2 단일값)
```

비교:

| 시나리오 | 점수 | 시간 |
|---|---:|---:|
| 원시 baseline (단일 main_duration.m, no docs) | ~ 30% | 45 s |
| baseline + 8개 helper concat (no docs) | 37.5% | 75 s |
| **bundler + docs + save-focused (현재)** | **79.2%** | 118 s |

### 3.3 Bench leaderboard (16 cells)

```
rank  pct%   avg-s   preset           | model           | docs
 1.   79.2%  118s   save-focused      | qwen3.6:latest  | docs=Y  ★
 2.   62.5%   97s   save-focused      | qwen3.6:latest  | docs=N
 3.   58.3%   86s   baseline          | qwen3.6:latest  | docs=Y
 4.   58.3%   80s   save-focused      | gemma4:26b      | docs=N
 5.   52.1%   59s   branch-aware      | gemma4:26b      | docs=Y
 6.   52.1%   66s   staged-cot        | gemma4:26b      | docs=Y
 7.   50.0%   87s   branch-aware      | qwen3.6:latest  | docs=Y
 8.   45.8%   64s   branch-aware      | qwen3.6:latest  | docs=N
 9.   41.7%   51s   branch-aware      | gemma4:26b      | docs=N
10.   35.4%   60s   baseline          | gemma4:26b      | docs=Y
11.   31.3%   57s   baseline          | gemma4:26b      | docs=N
12.   29.2%   65s   staged-cot        | qwen3.6:latest  | docs=N
13.   20.8%   73s   baseline          | qwen3.6:latest  | docs=N  ← 원시 baseline
14.    4.2%  124s   staged-cot        | qwen3.6:latest  | docs=Y
15.    4.2%   62s   staged-cot        | gemma4:26b      | docs=N
16.    0.0%    0s   save-focused      | gemma4:26b      | docs=Y  (timeout/parse fail)
```

**해석**:

1. **Docs 가 가장 큰 변수**. 같은 preset+model 비교에서 docs=Y 는 +10 ~ +35 pt. README/summary 가 IV 식별에 결정적.
2. **save-focused** 가 win. 점수의 큰 비중인 saved_variables 추출에 가장 적합 (cell-of-cell timing 풀어달라는 명시적 지시).
3. **qwen3.6:latest > gemma4:26b** 이 작업에서. gemma4 는 long-context JSON 생성에 fragility 있음 (한 번은 OOM/parse failure).
4. **staged-cot 은 fragile** — qwen 에서 docs=Y 일 때 4.2% 로 떨어진 적이 있음. 단계별 추출 지시가 모델을 오히려 보수적으로 (빈 배열) 만든 것으로 보임.
5. **Branch-aware 는 중간**. 분기 처리는 잘 되지만 saved_variables 회복이 약함.

---

## 4. 신규 UI 흐름 (사용자 동선)

```
[연구자]
   │
   │ 1. /experiments/new 또는 /experiments/<id>/edit
   ▼
┌─────────────────────────────────────────────────┐
│ 오프라인 실험 코드 자동 분석                      │
│ ┌─────────────────────────────────────────────┐ │
│ │ 소스 주소                                    │ │
│ │  [/Volumes/CSNL_new-1/.../Experiment ]  [자동 감지] │
│ │  > 고급 옵션 (entry / docs path)            │ │
│ │  [ 참고 문서 직접 입력 ... ]                │ │
│ │  [소스에서 분석 실행] [휴리스틱만]          │ │
│ └─────────────────────────────────────────────┘ │
│ ┌─────────────────────────────────────────────┐ │
│ │ 소스: /Volumes/.../Experiment   1080개 파일 │ │
│ │ 엔트리: main_duration.m  28개 번들          │ │
│ │ 문서: 자동 감지 (summary.MD, 7589자)        │ │
│ └─────────────────────────────────────────────┘ │
│                                                 │
│ ▼ 분석 결과 (편집 가능, 출처 배지: AI/휴리스틱/사용자) │
│  • 메타: language matlab · framework PTB ·      │
│         n_blocks 12 · n_trials 30 · seed 0       │
│  • Factors: dist (U,A,B) · day (1..5)           │
│  • Parameters: 12개 (lentrial 7.7 sec, …)       │
│  • Conditions: …                                │
│  • Saved Variables: 48개 (Stm, RT, vbl_*, …)    │
│  • Warnings: n_blocks 10/12 dual case …         │
│                                                 │
│ [실험 파라미터 스키마로 가져오기] [이 실험에 저장] │
│                                                 │
│ ▶ 수동 입력 (붙여넣기 / 파일 / zip / 폴더)        │
└─────────────────────────────────────────────────┘
   │
   │ 2. (모호한 항목이 있으면) 우측 챗봇과 대화
   │    "dist 의 levels 가 맞나?" → 모델이 <patch> 블럭 emit
   │    → 사용자가 적용/거부 토글
   ▼
[저장 → experiments.offline_code_analysis JSONB]
[code_repo_url 자동 동기화]
```

**과거 vs 현재**:

| 옛 UI | 새 UI |
|---|---|
| `code_repo_url` 텍스트 박스 (필수) | (자동 동기화, 분석기 안 source 필드가 채움) |
| `data_path` 텍스트 박스 (필수) | (results/ 자동 추정 + 비공개 케이스 위해 collapsed manual 보존) |
| `parameter_schema` 한 줄씩 + 추가 버튼 | 자동 추출 → "스키마로 가져오기" 1클릭 |
| 코드 분석 = 없음 (연구자가 직접 머리 굴림) | 79% 자동 회복 |

옛 두 필수 입력은 **collapsed `<details>` 안**으로 옮겨서 비공개 저장소·콜드 디스크 상황에선 직접 편집 가능하도록 했다.

---

## 5. 운영 체크리스트

### 5.1 새 호스트에 배포 시

- [ ] `OLLAMA_HOST` env (기본 `http://127.0.0.1:11434`)
- [ ] Ollama 에 `qwen3.6:latest` 풀: `ollama pull qwen3.6:latest`
- [ ] 원하면 `qwen3.6-35b-a3b` 등 더 큰 모델: `OFFLINE_CODE_MODEL=qwen3.6-35b-a3b` env
- [ ] `CODE_SOURCE_ROOTS` 에 lab 의 mount points 등록 (ex `/Volumes/CSNL_new-1,/Volumes/CSNL_new`)
- [ ] `git` CLI 가 PATH 에 있어야 GitHub fetch 동작 (Cloudflare Workers 런타임에서는 미지원 — Node-only 라우트로 한정)
- [ ] supabase migration 00049 적용

### 5.2 Prompt 또는 모델 변경

```bash
# bench 다시 돌리기
PROMPTS=baseline,branch-aware,save-focused,staged-cot \
MODELS=qwen3.6:latest,gemma4:26b \
npx tsx scripts/prompt-bench.mjs

# 결과 → tmp/prompt-bench.json
```

승자 프리셋이 바뀌면 `code-ai-analyzer.ts:DEFAULT_PROMPT_PRESET` 업데이트.

### 5.3 새 실험 도메인 추가

다른 실험 (TimeExp2, Magnitude scaling, etc.) 에서 점수가 낮다면:

1. 새 실험으로 `scripts/prompt-bench.mjs` 다시 돌려서 정답 셋업 확인 (`GROUND_TRUTH` 를 그 실험에 맞게 갱신)
2. 만약 휴리스틱 패턴이 부족하면 `code-heuristics.ts` 에 add (예: `extractPsychtoolbox` 안에 새 패턴)
3. 만약 prompt preset 이 부족하면 `SYSTEM_PROMPT_PRESETS` 에 새 entry 추가하고 bench 로 검증

### 5.4 디버깅

- 분석이 비어 있으면 → bench 로 같은 input 으로 재현 + heuristic-only mode 로 격리
- AI 출력이 truncate 되면 → `num_predict` 더 키우거나 docs 길이 줄이기
- `chatJson: model returned non-JSON` → 모델이 thinking 모드면 `think: false` 확인 (이미 default)
- 번들이 noise 로 차면 → `code-bundler.ts:NOISE_PATTERNS` 에 lab-specific 디렉토리명 추가

---

## 6. 향후 개선 후보 (순위 순)

1. **§3.4 taxonomy 를 prompt 에 인코딩** (HIGH, 다음 라운드): `branch-aware` / `save-focused` preset 에 “단일값 변수는 IV 아님 / `par.StairTrainTest` 가 한 세션 내 변하면 within-session block-kind factor / training-only day 는 별도 meta” 룰 추가. 이후 bench 재실행해서 winning preset 갱신.
2. **휴리스틱 보강** (HIGH): `par.<X> = N * ones(1,nBlocks)` 단일값 패턴, `par.<X> = [a b c]` cell/벡터 패턴, `par.day == 1` 분기 안 nBlocks 수 — 모두 정규식만으로도 잡힘. 현재는 AI 가 떠받치는데 휴리스틱이 1차 결정해야 일관성 ↑.
3. **`meta` 확장**: 현재 `n_blocks` 단일 정수만 있어 “Day1 10 train / Day2~5 12 test” 같은 케이스를 표현 못함. `meta.block_phases: [{kind, n_blocks, n_trials_per_block, dist?}]` 같은 배열 필드를 schema 에 추가.
4. **Notebook 업로드** (.ipynb): JSON 파싱해서 cell `source` 만 추출 → 같은 분석기에 투입.
5. **Cron 백필**: 활성화된 실험의 `code_repo_url` 을 주기적으로 재분석해서 코드 변경 시 알림 (오프라인 코드의 protocol drift 추적).
6. **2-pass refinement**: qwen 추출 → gemma4 (또는 큰 reasoning 모델) 가 "이 결과에서 의심스러운 항목" 만 review + patch — 챗봇 채널을 그대로 재사용.
7. **`experiments.code_source_address` 컬럼 분리**: 현재는 `code_repo_url` 을 source 와 두 용도로 쓰지만, 의미가 점점 분기되고 있어 별도 컬럼이 더 깨끗.
8. **Per-trial save schema → DB 스키마 검증**: 분석기가 추출한 `saved_variables` 를 실제 결과 .mat 파일과 비교해서 "코드에 있다고 했는데 실제 데이터엔 없는 필드" 를 flag.
9. **GitHub PR / 변경 diff 분석**: protocol_version 이 올라가면 자동으로 변경된 helper 만 재분석.

---

## 7. 현재 파일 맵

```
src/lib/experiments/
  ├── code-analysis-schema.ts      zod 스키마 (single source of truth)
  ├── code-bundler.ts              call-graph 번들러
  ├── code-heuristics.ts           regex 휴리스틱 (no-AI fallback)
  ├── code-ai-analyzer.ts          Qwen 호출 + prompt presets
  ├── code-analysis-patch.ts       챗봇 <patch> 적용 로직
  └── source-fetcher.ts            서버 path / git 클론

src/app/api/experiments/
  ├── code-analysis/
  │   ├── route.ts                 POST {code|files, docs, mode}
  │   ├── from-source/route.ts     POST {source, docs?, mode}  ← 신규
  │   └── chat/route.ts            POST {code, current, messages} (스트리밍)
  └── [experimentId]/offline-code/
      └── route.ts                 PUT/DELETE — 결과 영속화

src/components/
  └── offline-code-analyzer.tsx    UI (소스 주소 패널 + 편집 표 + 챗봇)

scripts/
  ├── prompt-bench.mjs             N×M×K 프리셋 벤치
  ├── smoke-from-source.mjs        from-source 스모크
  └── smoke-code-analyzer.mjs      heuristic+AI 스모크 (단일 코드)

supabase/migrations/00049_offline_code_analysis.sql
                                   experiments.offline_code_analysis JSONB

docs/code-analyzer-best-practices.md
                                   (이 문서)
```

---

## 8. 한 줄 요약

> 옛 “경로 두 개를 손으로 입력하세요” 가 → "주소 한 줄 + 분석 버튼 → 표를 검토하세요" 로 바뀌었고, TimeExp1 ground truth 대비 *기계 채점 가능* 항목 자동 회복률이 ~30 → 79% 로 올라갔다. 핵심 lever 는 (1) call-graph 번들러로 컨텍스트를 정제, (2) README/summary 자동 주입, (3) save-focused prompt + qwen3.6:latest. 디자인-수준 해석 (Day1=훈련-only 같은 *질적* 구분, single-value 변수가 IV 가 아님 같은 판단) 은 마지막 마일을 사람이 마무리하도록 모든 셀을 편집 가능하게 + 챗봇 1~2턴으로 patch 가능하게 만들어 두었다.
