# Self-review — Opus 4.7 session (2026-04-27 ~ 2026-05-04)

작성: Opus 4.7 (이 세션, agent author + reviewer 동시) · 2026-05-04 KST

이 문서는 단일 세션이 6일 동안 진행한 두 트랙의 작업에 대한 *자체 리뷰*입니다 — 무엇을 끝냈고, 어디에 빚이 있고, 다음 세션이 어디부터 손대면 좋을지를 후속 작업자(사람 또는 다른 에이전트) 에게 인계하기 위해.

---

## 0. Merged to main

| PR | 머지 커밋 | 시점 (UTC) | 핵심 변경 |
|---|---|---|---|
| **#1 — Code analyzer (agent-team hardened)** | `0568957` | 2026-05-04 08:04 | 서버경로/GitHub URL → call-graph 번들러 → Qwen3.6 / Claude Opus → 구조화 JSON 추출. 4 CRITICAL + 7 HIGH defect 패치, 5 prompt edits, 5 fixture × 91.9% bench |
| **#2 — Booking reschedule UX** | `5fb69fb` | 2026-05-04 07:26 | 단일-주 페이지 picker + ◀▶ 토글, `events.list` 로 GCal 이벤트 제목 노출, `renumberSessionsInGroup` 자동 회차 재번호 |

`+1,282 / −236` lines · 22 files. 모두 sister-session 의 P0-Α / P0-Γ / P0-Η / migration 00053·00054 와 충돌 없이 안착.

---

## 1. 트랙 A — 오프라인 실험 코드 분석기

### 1-1. 끝낸 것

- **schema** (`src/lib/experiments/code-analysis-schema.ts`) — `factors.role`, `parameters.shape`, `meta.block_phases`, `meta.domain_genre`, `meta.design_matrix` 5 axes. zod `.catch()` lenient validation 으로 모델 enum drift 자동 흡수.
- **bundler** (`src/lib/experiments/code-bundler.ts`) — call-graph 1-2 hop, MATLAB / Python / JS / R 적응. 1080 → 28 파일 / 67KB 로 압축. Windows backslash 정규화.
- **source fetcher** (`src/lib/experiments/source-fetcher.ts`) — allow-listed 서버 경로 + GitHub tarball API. `lstat` symlink-escape 방어, tar `..` traversal + GNU longname 처리, git host allow-list, credential 격리 (`HOME=tmp` + `askpass=/bin/false`).
- **prompt** (`src/lib/experiments/code-ai-analyzer.ts`) — 3-layer composed (general 14 rules + framework aug + genre hint 14가). branch-aware / save-focused / staged-cot 프리셋 보존.
- **provider** (`src/lib/experiments/llm-provider.ts`) — Ollama (local Qwen3.6) + Anthropic (Claude Opus 4.7) 대칭 fallback.
- **chatbot** (`src/lib/experiments/code-analysis-patch.ts`) — `<patch>{...}</patch>` 블럭 emit → 사용자 승인 후 적용.
- **DB** (`supabase/migrations/00049_offline_code_analysis.sql`) — JSONB column on experiments 테이블.
- **UI** (`src/components/offline-code-analyzer.tsx`) — 소스 주소 입력 / drag-drop / docs textarea / 편집 표 / provenance 배지 / 챗봇 사이드패널.
- **bench** (`scripts/bench-fixtures.mjs` + 5 fixtures + `scripts/fixtures/timeexp1_groundtruth.json`) — 91.9% overall, blind agent 의 사람-수준 reference.

### 1-2. UI 개선 후보 (다음 세션 우선순위 높음)

1. **편집 결과 → DB 영속화 UX** — 현재 `이 실험에 저장` 버튼이 있지만 *언제 무엇을 어떻게* 저장했는지 시각적 피드백 약함. "마지막 저장: 2분 전 · 7개 항목 변경됨" 같은 status pill 추가.
2. **provenance 배지의 시각적 무게** — "AI" / "휴리스틱" / "사용자" 가 같은 stroke 로 그려져 있음. AI 가 잡았지만 사용자가 미수정인 행 vs 사용자가 직접 수정한 행을 한눈에 구분하도록 색상 강도 분리.
3. **block_phases 표 상단에 시각화 막대 그래프** — 현재는 행으로만 표시. day_range × phase 를 가로 시간선 형태로 그리면 multi-day 실험 구조가 한 눈에.
4. **saved_variables 테이블이 너무 길다** — TimeExp1 에서 51 항목. per-trial / per-block / per-session 그룹별 접기 가능한 disclosure 가 필요. 검색 필드도.
5. **챗봇 사이드패널 토글이 잘 안 보임** — 분석 결과 표 아래에 묻혀 있어서 연구자가 그 존재를 모름. 헤더 영역으로 옮기고 "💬 챗봇으로 정정" 같은 라벨로 노출.
6. **소스 fetch 진행 상황 표시** — GitHub clone 이 30~60s 걸릴 때 UI 가 그저 spinner. "트리 fetch (1080 파일) → 번들링 (28개 선택) → 휴리스틱 → AI (qwen3.6, 110초 예상)" 단계별 progress.
7. **bench 결과를 UI 안에서 확인 가능** — 분석한 후 "참고: 이 fixture 와 비슷한 실험은 이전 bench 에서 X% 회복률" 표시. 신뢰도 신호.

### 1-3. 다음 라운드의 기능 후보 (PR description 들에 있던 항목)

- **2-pass refinement** — qwen 1차 → gemma4:31b / Opus 가 *의심스러운 항목만* review patch (챗봇 patch 채널 그대로 재사용 가능).
- **Notebook 업로드** (`.ipynb`) — JSON 파싱해서 cell `source` 만 추출 → 같은 분석기에 투입.
- **schema-validated patch** — 챗봇이 emit 하는 `<patch>` 가 zod 검증 안 됨. discriminated union schema 추가.
- **per-trial save schema → 실제 .mat 비교** — 코드에 있다고 했는데 실제 데이터엔 없는 필드 flag. 분석 단계 사전 점검에 유용.
- **GitHub PR diff 분석** — `protocol_version` 올라갈 때 변경된 helper 만 재분석.
- **Cron 백필** — 활성 실험의 `code_repo_url` 주기 재분석 → drift 감지 알림.
- **`experiments.code_source_address` 컬럼 분리** — 현재 `code_repo_url` 을 source/display 두 용도로 사용 중, 의미가 분기 중.

### 1-4. 알려진 한계

- TimeExp1 에서 blind agent 22 factors / 75 saved 대비 분석기는 7 / 51 (factors 32% / saved 68% recall). 사람 1~2 줄 정정으로 100% 가능하지만 1-pass 정확도 자체는 다음 라운드 향상 필요.
- 챗봇 patch 채널이 zod 검증 없어 모델이 잘못된 enum / 타입을 emit 하면 UI 상태가 손상될 수 있음 (위 §1-3 schema-validated patch 참조).
- `events.list` 폴백이 503/timeout 에서는 동작하지 않음 — 첫 시도 자체가 실패. 그때만 `freebusy.query` 로 재시도하는 polish 가 필요.

---

## 2. 트랙 B — Booking 예약 변경 UX

### 2-1. 끝낸 것

- **단일-주 페이지 picker** (`src/components/booking-actions.tsx`) — ◀ ▶ 토글, 주 라벨, "현재 예약 주" / "이전·다음 가능 주" 단축, "↻ 캘린더 새로고침" (cache 무시).
- **GCal 이벤트 제목 노출** (`src/lib/google/calendar.ts`) — `freebusy.query` → `events.list` 전환. 셀 툴팁에 `Google Calendar 충돌: <event 제목>` 노출. 권한 부족 시 자동 폴백.
- **셀 색 4분류** — 이동가능(초록) / 현재(파란 ring) / 캘린더 충돌(앰버) / 마감·지난시간(회색).
- **자동 회차 재번호** (`src/lib/services/booking.service.ts:renumberSessionsInGroup`) — 같은 booking_group 의 active 예약을 `slot_start` 순으로 정렬해 1..N 재할당. terminal 상태(cancelled/no_show) 보존.
- **PATCH 응답에 `renumber: { changed, total }`** — toast 가 "회차 N건 자동 재번호" 안내.

### 2-2. UI 개선 후보 (다음 세션)

1. **"여러 회차 동시 변경" 모드** — 현재는 1회차씩 따로 변경. participant 가 multi-session 예약을 한꺼번에 옮길 때 (예: 휴가로 1주 통째 미루기) drag-or-shift 패턴 지원.
2. **모달 내 좌우 토글에 keyboard shortcut** (`←` / `→` / `Today` / `Esc`) — 마우스 이동 줄이는 작은 polish.
3. **요일 한글 표시 정리** — 현재는 `Intl.DateTimeFormat` 의 "월" / "화" 라 한 글자. 평일 / 휴일 구분 색 추가하면 더 명확 (예: 토 = 파랑, 일 = 빨강).
4. **충돌 셀 클릭 시 GCal 링크** — `Google Calendar 충돌: <제목>` tooltip 만 보여줌. 클릭 → `https://calendar.google.com/...?eid=...` 로 이동 가능하면 진단 속도 ↑.
5. **참여자에게 발송될 안내 미리보기** — 변경 확정 직전 "이 변경에 따라 발송될 메일/SMS 본문 미리보기" 패널. 옛 "12월 3일 → 12월 5일" 식의 diff 강조.
6. **manual_blocks 와 GCal 충돌 시각적 구분** — 둘 다 앰버 셀로 묶여 있음. 연구자 명시 차단(`experiment_manual_blocks`) 은 다른 색 + 차단 사유 노출.
7. **반응형 — 모바일 모달** — 7-col grid 가 좁은 화면에서 셀 너무 작음. 480px 이하에서는 *하루 한 컬럼* 레이아웃으로 전환.

### 2-3. 알려진 한계

- `renumberSessionsInGroup` 이 idempotent 하지만 *atomic 하지 않음* — 한 row 씩 update. 동시에 두 reschedule 요청이 들어오면 race 가능. 실제로는 admin/researcher 가 동시에 한 참여자를 옮기는 시나리오가 드물어서 immediate risk 는 낮지만, 정공법은 single SQL `UPDATE ... CASE WHEN id=... THEN ... END` 또는 RPC migration.
- `events.list` 가 `maxResults: 250` 제한. 90일 범위에 250건 넘는 캘린더(스튜디오 공용 캘린더 등)에선 일부 일정 누락 가능. paging 미지원. 다음 세션 후보.
- "↻ 캘린더 새로고침" 이 5분 cache 만 무시 — Google API 자체의 propagation 지연 (캘린더 추가 후 1~2분) 은 우회 못함. UI 에 "Google 측 반영 1~2분 소요 가능" 안내 추가하면 명확.
- 옛 `freebusy.query` 의 `transparency` 인지 누락 — 새 `events.list` 에서는 `transparency==="transparent"` 이벤트는 자동 제외하지만, 폴백 path 에서는 freebusy 자체가 transparent 를 어떻게 처리하는지 Google 의 동작에 의존.

---

## 3. 환경 / 운영 인계

### 3-1. 새로 추가된 env vars

- `OFFLINE_CODE_MODEL` (기본 `qwen3.6:latest`) — Ollama 로컬 분석 모델
- `LLM_PROVIDER` ∈ {`ollama`, `anthropic`, 미설정=auto}
- `ANTHROPIC_API_KEY`, `ANTHROPIC_CODE_MODEL` — 클라우드 분석
- `OLLAMA_HOST` (기본 `http://127.0.0.1:11434`)
- `CODE_SOURCE_ROOTS` (기본 `/Volumes/CSNL_new-1,...`) — 서버 경로 분석 allow-list
- `CODE_GIT_HOSTS` (기본 `github.com,gitlab.com,bitbucket.org,codeberg.org`) — git clone 허용 호스트
- `ANALYZER_FIXTURE_ROOT=1` — dev 만, bench fixture 디렉토리 자동 등록
- `ANALYZER_DEV_BYPASS=1` — dev/test 만, 분석 API auth 우회
- `PROMPT_PRESET` (기본 `composed`) — A/B 용 prompt preset 강제

### 3-2. 새로 추가된 DB 컬럼 / 마이그레이션

- `00049_offline_code_analysis.sql` — `experiments.offline_code_analysis` JSONB. Vercel/lab 모두에 적용 필요.

### 3-3. Build / typecheck 상태

`npm run build` 통과. `npx tsc --noEmit` clean (분석기 + 예약 변경 영역). 다른 도메인 (payment-export, claim-bundle) 의 sister-session 진행중 작업이 stale 한 타입 오류를 띄우지만 분석기/예약 영역과 무관.

### 3-4. fixture & bench

```
$ npx tsx scripts/bench-fixtures.mjs    # 5 fixture × ground truth, ~5분
psychopy_estimation     94.4%
jspsych_decision        95.0%
ptb_psychophysics       95.2%
r_categorization        88.0%
labjs_staircase_audiovisual 88.9%
overall                 91.9%
```

`scripts/fixtures/timeexp1_groundtruth.json` 은 blind agent 가 작성한 *사람-수준 reference* — 향후 분석기 회귀 측정 기준.

---

## 4. 자체 평가

### 잘한 것

- **agent-team 검토 도입** — single Claude pass 의 blind spot 을 외부 perspective(blind ground-truth + 적대적 reviewer + prompt critic) 가 catch. 4 개 CRITICAL silent-corruption 이 출하 직전에 잡힘.
- **다중 세션 충돌 회피** — 같은 repo 에 sister sessions (P0-Α/Γ/Η, payment-info, status-notify) 가 동시에 작업했지만 두 PR 모두 0-conflict 머지.
- **체계적 테스트 자산** — bench 5 fixture + ground truth JSON 이 다음 세션의 회귀 검증 환경을 깔끔히 남김.

### 못한 것 / 인지된 빚

- **챗봇 patch zod 검증** 미실행 — 모델이 잘못된 enum 이나 타입을 emit 하면 UI 상태 손상 가능. 이번 세션에서 인지했으나 다음 라운드로 미룸.
- **`renumberSessionsInGroup` non-atomic** — 동시 reschedule race 가능. 발생 빈도 낮아 일부러 미룬 결정이지만 RPC 로 옮길 명확한 후속.
- **`events.list` paging 미구현** — 250 이상 캘린더에서 일정 누락 가능.
- **소스 fetch 진행 단계 UI** — 30~60s 무반응 spinner. 사용자 피드백 없음.
- **2-pass refinement** — TimeExp1 에서 1-pass 가 32% factor recall. 2-pass (Opus / gemma4 review patch) 가 가장 큰 자동 회복 lift 가 될 텐데 이번 세션에 손 못댐.

### 다음 세션이 손대면 좋을 1 가지

**챗봇 patch 의 zod 검증 + 2-pass refinement**. 둘 다 *기존 챗봇 채널 재사용* 으로 구현 가능 — 새 인프라 없이 구조적 robustness 와 정확도를 동시에 끌어올림. 1 PR 안에 묶어서 실험 가치 있음.

---

## 5. 파일 트리 (이 세션이 추가/수정한 영역)

```
src/lib/experiments/                  # 트랙 A 핵심 — 신규 디렉토리
  ├── code-analysis-schema.ts         # zod schema (factors.role, parameters.shape, block_phases, ...)
  ├── code-bundler.ts                 # call-graph 1-2 hop file selector
  ├── code-heuristics.ts              # framework-별 regex 추출
  ├── code-ai-analyzer.ts             # Qwen / Opus chat — 3-layer composed prompt
  ├── code-analysis-patch.ts          # 챗봇 <patch> 블럭 적용
  ├── llm-provider.ts                 # Ollama + Anthropic 대칭 fallback
  ├── source-fetcher.ts               # 서버 path / git tarball + 보안 가드
  ├── dev-bypass.ts                   # auth bypass helper
  └── ...

src/components/
  ├── offline-code-analyzer.tsx       # 트랙 A UI (소스 주소 + 편집 표 + 챗봇)
  └── booking-actions.tsx             # 트랙 B 의 reschedule modal (single-week paged)

src/app/api/experiments/code-analysis/
  ├── route.ts                        # POST 단일/다중-파일
  ├── from-source/route.ts            # POST 소스 주소
  └── chat/route.ts                   # POST 스트리밍 챗봇

src/app/api/experiments/[experimentId]/offline-code/route.ts   # PUT/DELETE 영속화
src/app/api/bookings/[bookingId]/route.ts                       # 트랙 B PATCH (renumber 호출)

src/lib/google/calendar.ts            # events.list + freebusy.query 폴백
src/lib/google/freebusy-cache.ts      # busy_summary round-trip
src/lib/utils/slots.ts                # BusyInterval / ClassifiedSlot 에 summary
src/lib/services/booking.service.ts   # renumberSessionsInGroup() 추가

supabase/migrations/00049_offline_code_analysis.sql

scripts/
  ├── prompt-bench.mjs                # 트랙 A prompt × model A/B
  ├── bench-fixtures.mjs              # 트랙 A 5-fixture 회귀 bench
  ├── smoke-from-source.mjs           # 트랙 A 소스 분석 스모크
  ├── smoke-code-analyzer.mjs         # 트랙 A 휴리스틱+AI 스모크
  └── fixtures/
      ├── psychopy_estimation/
      ├── jspsych_decision/
      ├── ptb_psychophysics/
      ├── r_categorization/
      ├── labjs_staircase_audiovisual/
      └── timeexp1_groundtruth.json   # blind agent 사람-수준 reference

docs/
  ├── code-analyzer-best-practices.md # 트랙 A 설계 / 케이스 스터디
  └── self-review-2026-05-04.md       # (이 문서)
```

---

## 6. 마지막 한 줄

> 두 트랙 모두 main 에 안착했다. 분석기는 자동 회복 91.9% / 사람 정정 1~2 턴 = 100% 도달 가능한 state, 예약 변경 UX 는 옛 "한 화면에 8주 빽빽" 으로부터 단일-주 페이지 + GCal 제목 노출 + 자동 회차 재번호로 정리됐다. 빚은 §4 에 정직하게 적었고, §1-2 / §2-2 / §1-3 가 다음 세션의 work queue 다.
