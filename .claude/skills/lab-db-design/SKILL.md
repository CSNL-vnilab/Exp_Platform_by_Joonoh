---
name: lab-db-design
description: lab-reservation Supabase Postgres 설계·마이그레이션 작업 전용. 스키마 변경, 새 마이그레이션 작성, RLS 정책, RPC(SECURITY DEFINER) 설계·수정, 인덱스 추가, 상태 규약 질문이 나오면 반드시 이 스킬을 사용할 것. "마이그레이션 만들어/적용해", "컬럼 추가", "RLS", "book_slot 수정", "상태 전이" 류 요청 포함. 일반 SQL 질문이나 타 프로젝트 DB는 해당 없음.
---

# lab-db-design — 연구DB 설계 규약

repo: `/Users/csnl/Documents/claude/lab-reservation-main`

## 절대 규약 (위반 시 과거에 실제 사고 났던 것들)

1. **세션 상태 규약**: 살아있는/참석 세션 = `status IN ('confirmed','running','completed')`. cancelled·no_show 는 terminal-non-payable. 기준 구현은 `propagate_payment_period` (00055). 새 쿼리가 세션을 세거나 날짜를 모으면 이 필터를 복제하라 — 빠뜨려서 취소 세션이 행정서류에 들어간 사고가 2026-06-10 에 확정됐다.
2. **상태 쓰기는 CAS**: `UPDATE bookings SET status=... WHERE id=... AND status IN (기대값)` + affected-rows 확인. supabase-js 는 `.select('id')` 를 붙여 행 수로 판정.
3. **zod v4 `.partial()` 은 `.default()` 를 유지**한다 — PATCH 라우트는 요청 body 키와 교집합 후 UPDATE (`src/app/api/experiments/[experimentId]/route.ts` 가 캐노니컬). 안 하면 한 필드 패치가 전 필드를 디폴트로 클로버.
4. **enum 추가 + 같은 트랜잭션 내 사용 = 55P04 에러.** apply-migration-mgmt 는 파일 전체를 한 트랜잭션으로 보낸다 → enum 추가와 사용을 다른 마이그레이션 파일로 분리.
5. **`supabase db push` 금지** (트래킹 드리프트로 00022+ 전부 재적용 시도함). 적용은:
   ```bash
   /Applications/Codex.app/Contents/Resources/node scripts/apply-migration-mgmt.mjs supabase/migrations/000NN_xxx.sql
   ```
   `.env.local` 필요 (main worktree 에 있음).
6. **돈 경로 멱등 패턴**: dispatch lock (payment-info-notify.service, 00053) / UNIQUE(booking_group_id) (00024) / advisory lock (book_slot) / google_event_id UNIQUE partial (00070). 새 사이드이펙트 경로는 이 중 하나를 반드시 채택.

## 마이그레이션 작성 워크플로우

1. 번호 = `ls supabase/migrations | tail` 최대값 +1 (중복 번호 존재 가능 — 00065 두 개, 00067 두 개. 신규는 항상 유일 번호로).
2. 파일 머리에 **왜** 를 쓴다 — 어떤 사용자 지시/리뷰 finding 에서 왔는지.
3. `CREATE OR REPLACE FUNCTION` 시 기존 시그니처·GRANT 를 원본 마이그레이션에서 확인 후 동일하게 재선언 (REVOKE PUBLIC + GRANT 대상 명시).
4. UNIQUE 인덱스 추가 전 프로드 중복 검사 쿼리를 먼저 돌린다.
5. 적용 후 커밋 메시지 본문에 "applied to prod" 명시 (AGENTS.md 규칙 3).

## 핵심 객체 맵 (어디를 보면 되는가)

| 객체 | 위치 | 역할 |
|---|---|---|
| book_slot | 00069 (최신 재정의) | 예약 원자성: advisory lock, overlap 충돌, 모집정원, 블랙리스트 |
| mark_group_completed | 00070 (최신) | 그룹 일괄 완료 — slot_end<now 가드 |
| auto_complete_stale_bookings | 00070 (최신) | confirmed+running 7일 grace 청소 |
| propagate_payment_period | 00055 | 활용일자/금액 재산출 — 상태 규약의 기준 |
| 결제 디스패치 게이트 | src/lib/services/payment-info-notify.service.ts | terminal-non-payable {cancelled,no_show}, sweep cap=SWEEP_MAX_ATTEMPTS |
| RLS | 00005, 00010 | experiments/participants/bookings 정책 |

## 검증

변경 후: `tsc --noEmit` + 관련 단위테스트(`node --import tsx scripts/test-payment-info-notify.mjs`, `test-backfill-payment-info.mjs`) + 영향 렌즈만 flow-qa 재실행.
