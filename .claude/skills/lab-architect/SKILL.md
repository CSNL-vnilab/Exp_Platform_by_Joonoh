---
name: lab-architect
description: lab-reservation 의 설계자 하네스 오케스트레이터. DB 설계/마이그레이션, UI/UX 개선, Vercel 성능 최적화, 플로우 QA 가 얽힌 작업 — "플랫폼 개선해", "설계 리뷰해", "blueprint 보완", "DB랑 UI 같이", "최적화하고 검증까지", 하네스 실행/재실행/업데이트/부분 재실행("QA만 다시", "UI만 다시") 요청이 오면 반드시 이 스킬을 사용할 것. 단일 영역의 작은 수정은 해당 도메인 스킬(lab-db-design / lab-ui-design / lab-vercel-optimize / lab-flow-qa)을 직접 사용해도 된다.
---

# lab-architect — 설계자 하네스 오케스트레이터

repo: `/Users/csnl/Documents/claude/lab-reservation-main` · 산출물 작업장: `_workspace/` (gitignored)

## 팀 구성

| 에이전트 | 정의 | 전문 | 도메인 스킬 |
|---|---|---|---|
| db-architect | .claude/agents/db-architect.md | Supabase 스키마/마이그레이션/RLS/RPC | lab-db-design |
| ui-architect | .claude/agents/ui-architect.md | App Router UI/UX, 두 페르소나 | lab-ui-design |
| vercel-optimizer | .claude/agents/vercel-optimizer.md | 번들/캐시/함수/배포 | lab-vercel-optimize |
| flow-qa | .claude/agents/flow-qa.md | 경계면 교차검증, 머지 게이트 | lab-flow-qa |

**실행 모드: 하이브리드** — 탐사·리뷰·독립 구현은 **서브 에이전트 병렬**(Agent 도구, `model:"opus"`, 산출물은 파일 기반 `_workspace/`), 렌즈 팬아웃+반박검증은 **Workflow 도구**(결정적 fan-out, lab-flow-qa 전체 모드). 에이전트 간 실시간 합의가 필요한 대형 설계 변경(스키마 개편 등)은 팀 도구 가용 시 TeamCreate 로 승격하되, 미가용 환경에선 메인 세션이 라운드 중재(산출물 교환 → 상충점만 재질의)로 대신한다.

## Phase 0: 컨텍스트 확인 (매 실행 필수)

1. `_workspace/` 존재 여부:
   - 있음 + 부분 수정 요청 → **부분 재실행** (해당 에이전트만, 기존 산출물을 입력으로)
   - 있음 + 새 주제 → `_workspace_prev/` 로 이동 후 **새 실행**
   - 없음 → **초기 실행** (`mkdir _workspace`)
2. `git fetch origin main && git log HEAD..origin/main` — 멀티세션 환경이므로 시작 전 sync (AGENTS.md 규칙 준수).
3. 기준 문서 로드: `docs/architecture.md`(블루프린트), `docs/payment-flow-review-2026-06-10.md`(QA 원장), `docs/cron-runbook.md`.

## Phase 1: 작업 분해 & 라우팅

요청을 도메인별 작업으로 분해해 `_workspace/00_plan.md` 에 기록. 라우팅 기준:
- 스키마/마이그레이션/RPC/RLS → db-architect
- 화면/폼/카피/모바일 → ui-architect
- 속도/사이즈/빌드/배포/cron → vercel-optimizer
- 검증/회귀/머지게이트 → flow-qa (항상 마지막 게이트로 포함)

## Phase 2: 병렬 실행 (서브 에이전트)

독립 작업은 동시 스폰 (한 메시지에 복수 Agent 호출, `model:"opus"`). 각 프롬프트에 반드시 포함:
- 에이전트 정의 파일 경로 ("너의 역할 정의: .claude/agents/X.md 를 먼저 읽어라")
- 해당 도메인 스킬 경로 (".claude/skills/lab-X/SKILL.md 의 규약을 따르라")
- 산출물 경로 (`_workspace/{NN}_{agent}_{artifact}.md`)
- 읽기/쓰기 범위 (코드 수정 여부)

파일명 컨벤션: `{phase}_{agent}_{artifact}.md` (예: `02_db-architect_index-audit.md`).

## Phase 3: QA 게이트

코드 변경이 있으면 flow-qa 를 **증분 모드**로 실행 (변경 diff → 닿는 렌즈만). critical/high finding 은 해당 에이전트에 차환 후 재게이트. medium 이하는 백로그(`docs/payment-flow-review-*.md` 이연 목록에 추가).

## Phase 4: 통합·배송

1. 산출물 종합 → 변경 요약.
2. `tsc --noEmit` + 단위테스트 + (배포 시) smoke-all.
3. 커밋·푸시는 AGENTS.md 멀티세션 규칙 (fetch 선행, ALLOW_FEATURE_BRANCH=1, 60초 대기).
4. 마이그레이션 있으면 lab-db-design 의 적용 절차 + 커밋 본문에 "applied to prod".

## 데이터 전달

- 산출물: 파일 기반 (`_workspace/`)
- 결과 수집: Agent 반환값 (요약만 — 상세는 파일)
- 교차 참조: 후속 에이전트 프롬프트에 선행 산출물 경로 명시

## 에러 핸들링

- 에이전트 실패(반환 null/예외): 1회 재시도 → 재실패 시 해당 산출물 없이 진행, 최종 보고에 누락 명시.
- 산출물 상충(두 에이전트가 같은 파일을 다르게 수정): 삭제하지 않고 양안을 메인이 병기 검토, 머지 결정은 메인 세션.
- QA critical 미해결: 배송 중단, 사용자 보고.

## 테스트 시나리오

**정상 흐름**: "참여자 관리 화면 느린 것 개선하고 검증까지" → Phase 1 분해(vercel-optimizer 측정 + ui-architect 렌더 분석 병렬) → 수정 → flow-qa 증분 → 배송. 기대: `_workspace/` 에 측정표 + diff + findings, smoke 4/4.

**에러 흐름**: db-architect 가 마이그레이션 초안 중 기존 객체 충돌 발견 → 작업 중단·보고 (원칙 준수 확인) → 메인이 번호 재배정 후 부분 재실행. 기대: 충돌 마이그레이션이 prod 에 적용되지 않음.

## 진화

실행 후 결함 패턴 발견 시: 결과물 품질→도메인 스킬 수정, 역할 공백→에이전트 정의 수정, 순서 문제→본 스킬 수정. 변경은 AGENTS.md 하네스 섹션의 변경 이력 테이블에 기록.
