# 1차 적대적 심사 — CRITICAL 11건 검증 결과

날짜: 2026-04-24
대상 런: `/tmp/adv-review-full/`
검증자: 사람 + Claude (코드 재확인)

## 개요

qwen3.6:latest가 뽑은 CRITICAL 11건을 실제 코드·설계 의도에 비추어 검증했다.
결론: **실질적으로 수정 필요한 것은 1건(#8 CRON timing-safe)** 이며, 나머지 10건은
모델의 컨텍스트 부족 또는 설계 의도 몰이해로 인한 **오판(false positive)**이다.

이 문서는 재실행 시 대조군 역할을 한다.

## 검증 요약

| # | 슬라이스 | qwen 판정 | 실제 | 비고 |
|---|---|---|---|---|
| 1 | auth | 관리자 비밀번호 평문 저장 | ❌ 오판 | `admin.auth.admin.createUser({password})` — Supabase Auth가 bcrypt 서버측 해싱 |
| 2 | booking | 고스트 예약 (pipeline async) | ❌ 오판 | 현재 `await runPostBookingPipeline`, outbox 터미널 상태까지 동기 대기 (comment 96-99) |
| 3 | experiments | RLS 우회·service-role 노출 | ❌ 오판 | `createClient()` (cookie-bound, RLS 적용) + 인증된 `user.id`를 `created_by`로 삽입 |
| 4 | data-pii | CSV export PII 유출 | ❌ 오판 | 실제 export 컬럼은 `subject_number/block_index/trial_index/condition/is_pilot/submitted_at` 및 trial-level 키. 이름·전화·이메일 없음 |
| 5 | crypto | RRN 키 회전 부재 | ❌ 오판 | `getKey(version)`이 per-version 룩업 지원. 쓰기는 ACTIVE, 읽기는 `blob.keyVersion`으로. 폴백도 구현됨 |
| 6 | participants | PII RLS 경로 | ❌ 방어 충분 | RLS(policy 00010) + 서버 column 필터(`isAdmin ? piiCols : safeCols`) + role-prop UI 분기 3중 방어 |
| 7 | integrations | 캘린더 PII 노출 | ⚠️ 설계 의도 | briefing 원칙 #3 "PII는 캘린더 제목이 아닌 description에만" 그대로 구현. 제목은 `[initial] project/Sbj/Day`만, description에 PII. 공유 범위는 연구실 계정 한정 |
| **8** | **cron** | **CRON_SECRET timing attack** | **✅ 실제 (경미)** | `safeCompare` 길이 선행 비교로 길이 누출. MIN_SECRET_LENGTH=32 + openssl hex 64 고정이라 실질 위협 없으나 베스트프랙티스 적용 가치. **수정함** |
| 9 | frontend | Realtime N+1 | ⚠️ MED급 | channel은 이미 experimentId로 바운드. 세밀한 row-filter는 개선 여지이지만 CRITICAL 아님 |
| 10 | admin-ux | `/admin/participants` requireAdmin 누락 | ❌ 의도 | 페이지 주석 "Admins and researchers both see this page; researchers get a name-less view" — `role` prop으로 UI가 분기, API도 동일 방어 |
| 11 | db-rls | RLS OR-결합 버그 | ❌ 오판 | 복수 permissive 정책 OR은 Postgres 정상 시맨틱. participants INSERT 정책은 이 마이그레이션에 없음 (RPC SECURITY DEFINER만 경로) |

## 수정한 것

### #8 — CRON_SECRET 비교 강화

5개 cron 라우트에 동일 `safeCompare`가 복붙돼 있었고, 모두 길이 먼저 비교 →
길이 정보 누출. 수정:

- 신규 `src/lib/auth/cron-secret.ts` 에 `authorizeCronRequest` 단일 구현:
  - SHA-256 다이제스트 비교 (양쪽 항상 32바이트 고정) → 길이 누출 제거
  - `MIN_SECRET_LENGTH=32` 검증 유지
- 5개 route에서 중복 제거:
  - `src/app/api/cron/auto-complete-bookings/route.ts`
  - `src/app/api/cron/outbox-retry/route.ts`
  - `src/app/api/cron/notion-health/route.ts`
  - `src/app/api/cron/notion-retry/route.ts`
  - `src/app/api/cron/promotion-notifications/route.ts`

타입체크 통과. 동작 계약 동일 (같은 헤더·같은 env).

## 오판 패턴 (재실행·페르소나 개선 메모)

qwen이 놓친 지점들:

1. **인접 파일을 같이 안 읽음**: `participants/[id]/route.ts` 한 파일만 보고 PII 유출이라고 판단. 실제로는 RLS(마이그레이션) + server column select + UI role-prop가 함께 방어.
2. **라이브러리 계약 모름**: `supabase.auth.admin.createUser({password})`가 서버에서 해싱되는 것을 "평문 저장"으로 오인.
3. **동일 파일 내 인접 코드 미독**: `runPostBookingPipeline`이 이미 `await` 되어 있는데 "분리되어 있다"고 판단.
4. **브리핑을 무시**: briefing에 명시된 설계 원칙을 위반이라고 지적 (#7 캘린더 PII는 설계 의도).
5. **Postgres RLS 시맨틱 혼동**: 복수 permissive 정책 OR을 "우회 경로"로 오인.
6. **파일 경로·마이그레이션명 환각**: 실제 파일명을 몰라 `00045_add_exclude_constraint.sql` 식으로 가공.

개선 방향 (다음 버전 하네스):

- briefing을 persona 직후가 아닌 **매 슬라이스 마지막**에 한 번 더 반복해서 설계 원칙을 상기시킨다.
- "OPEN으로 남기면 감점 없음"을 persona에 더 강조해 추측-단정을 줄인다.
- 슬라이스 focus에 "인접 방어선(RLS/미들웨어/UI) 함께 확인" 명시.
- 2차 리뷰 패스: 1차에서 CRITICAL로 찍힌 것만 모아서 **재검증 슬라이스**(관련 파일 패키지 + "1차 판정 근거" 동반)로 한 번 더 돌린다.

## 재실행 계획

- 위 수정(#8)만 적용한 상태에서 동일 하네스 재실행.
- 새 런에서 CRITICAL #8이 사라지고, 나머지 오판이 유사하게 재출현하는지 확인.
- 유사 재출현 → 모델 한계 확정. 신규 이슈 등장 → 가치 있음.
