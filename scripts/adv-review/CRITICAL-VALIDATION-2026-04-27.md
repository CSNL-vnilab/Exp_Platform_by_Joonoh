# 2차 적대적 심사 — 검증 결과

날짜: 2026-04-27
대상 런: `/tmp/adv-review-2026-04-27/`
하네스 변경: 1차 후 적용 (lenient JSON 파서 + 다층 방어 페르소나 + slice 06/08 방어 파일 추가)
검증자: 사람 + Claude (코드 재확인)

## 핵심 비교

| 지표 | 1차 (2026-04-24) | 2차 (2026-04-27) | Δ |
|---|---|---|---|
| TOTAL | 112 | 110 | -2 |
| **CRITICAL** | **11** | **1** | **-91%** |
| HIGH | 26 | 27 | +1 |
| MED | 24 | 26 | +2 |
| LOW | 28 | 35 | +7 |
| OPEN | 23 | 21 | -2 |

CRITICAL 11→1은 페르소나의 "다층 방어 존중" 원칙이 의도대로 작동했다는
증거다. 1차에서 CRITICAL로 잘못 찍힌 9건(RLS 우회·PII 캐스케이드·OR-결합·
admin guard 누락 등)이 모두 HIGH 이하로 강등되었고, 그중 다수는 evidence
란에 "RLS 의존" / "다층 방어 가능성" 같은 문구가 명시되어 페르소나의
사고가 보인다.

## 2차 CRITICAL+HIGH 검증 (28건)

### CRITICAL (1건)

| # | 파일 | 판정 | 비고 |
|---|---|---|---|
| 1 | `src/app/api/users/route.ts:55` 트랜잭션 부재 | ✅ **실제** (MED급) | createUser 성공 후 profile UPDATE 실패 시 절반-만들어진 계정. **수정함** — auth.users 자동 롤백 추가 |

### HIGH (27건)

| 슬라이스 | 파일 | 판정 |
|---|---|---|
| 01 | `role.ts:36` requireAdmin Server Component | ❌ FP — `createClient()` cookie-bound, Server Component 정상 동작 |
| 01 | `registration-requests:65` 비밀번호 DB 저장 | ⚠️ 1차 동일 — 승인 흐름상 일시 보관, 승인 직후 폐기 (설계 의도) |
| 01 | `registration-requests:50` 사용자 enumeration | ❌ FP — 일반 가입 라우트의 표준 동작, 어드민이 호출 |
| 02 | `bookings:76` pipeline 분리 | ❌ FP — 1차에 검증함. `runPostBookingPipeline` 이미 await |
| 02 | `[bookingId]:233` GCal 생성 실패 시 DB 롤백 부재 | ❌ FP — line 233은 권한 체크 라인. P2-1 수정으로 GCal 사전 생성 → DB 업데이트 순서임 |
| 02 | `bookings:60` EXCLUDE+RLS 분리 검증 | ❌ FP — 두 계층 모두 의도된 방어, 어느 한쪽만 깨져도 다른 쪽이 막음 |
| 03 | `experiments:60` RLS 우회 | ❌ FP — `createClient()` (cookie-bound, RLS 적용). 1차 CRITICAL이 HIGH로 강등된 케이스 |
| 03 | `status:100` 중복 예약 DB 제약 누락 | ❌ FP — 상태 변경은 예약을 만들지 않음. 슬라이스 외부 confusion |
| 04 | `data-export-csv:105` _pilot PII 누출 | ❌ FP — export 컬럼은 trial 데이터(`subject_number/block_index/...`), PII 없음 |
| 04 | `reissue-token:55` 이전 토큰 무효화 부재 | ❌ FP — `token_hash` 덮어쓰기가 즉시 무효화 (HMAC 검증이 hash 비교) |
| 04 | `verify:75` 완료 코드 timing attack | ✅ **실제** (베스트프랙티스) | 락아웃 있으나 `!==` 비교. **수정함** — SHA-256 + `timingSafeEqual` |
| 05 | `payment-info.ts:43` KDF 취약 | ⚠️ 부분 — env가 high-entropy면 안전하나 운영자 오설정 방어 부족. **수정함** — 32자 미만 입력 거부 (fail-fast) |
| 05 | `payment-export RLS 우회` | ❌ FP — P1 감사 완료. 권한 체크 견고함 |
| 06 | `00010 RLS EXISTS 인덱스` | ❌ FP — 성능 항목, 보안 아님. 현재 데이터 규모에서 비문제 |
| 06 | `class/route.ts:156` cascade race | ❌ FP — P2-3 코드. CAS 가드(`.in("status", [...])`) + RPC advisory lock 이미 존재 |
| 07 | `notion:60` Notion PII 외부 노출 | ⚠️ 설계 의도 — Notion DB는 lab-private, 1차에 동일 판정. briefing 원칙 #3 |
| 07 | `solapi:10` Salt 예측 가능성 | ❌ FP — `crypto.randomBytes(16)` is CSPRNG, Vercel Node.js 환경 안전 |
| 08 | `cron-secret.ts:23` plaintext 비교 timing attack | ❌ FP — 모델이 잘못 읽음. line 23은 `safeEqualHashed` (SHA-256 + `timingSafeEqual`) |
| 08 | `outbox-retry:115` rate limit break 영구실패 | ❌ FP — 의도된 백오프. 다음 sweep에서 재시도, RPC가 백오프 큐 관리 |
| 09 | `week-timetable:138` Realtime 과도 refresh | ⚠️ MED — UX 개선 여지. CRITICAL/HIGH 아님 |
| 09 | `booking-flow:108` 에러 코드 string-match | ⚠️ LOW — 미래 개선 가치. 현 동작 정상 |
| 10 | `experiments/page.tsx:15` admin 권한 부재 (RLS 의존) | ❌ FP — 페이지가 admin+researcher 공용 의도, role-prop UI 분기. 페르소나가 RLS 의존을 명시한 점은 발전 |
| 10 | `add-user-form:17` 비밀번호 클라이언트 생성 | ❌ FP — 신규 계정의 랜덤 비밀번호 생성. HTTPS 전송 |
| 10 | `dashboard:40` N+1 | ❌ 성능, 보안 아님 |
| 11 | `00045 EXCLUDE 미적용` | ❌ FP — RPC 내부 advisory lock + capacity check가 동시성 처리 |
| 11 | `00010 is_admin 함수 의존성` | ❌ FP — `is_admin()` 함수 존재함 |
| 11 | `00045 advisory_xact_lock 범위` | ❌ FP — 1차 동일. 실험 단위 락이 의도된 스코프 |

**TP / FP 요약**: 28건 중 **3건 실제 (1 CRITICAL→MED + 2 HIGH→best practice)**, 25건 FP.

대비:
- 1차: CRITICAL 11건 중 1 TP, 10 FP (90.9% FP율)
- 2차: CRITICAL+HIGH 28건 중 3 TP, 25 FP (89.3% FP율)

비율은 비슷하나 **절대 CRITICAL이 11→1로 줄어** 사람 검수 부담이 크게 감소.

## 적용한 수정 (3건)

### #1 CRITICAL — `users/route.ts:55` 계정 생성 원자성

createUser 성공 후 profile.update 실패 시 `auth.admin.deleteUser()`로
auth.users 행을 자동 롤백. 둘 다 실패한 극단 경우만 운영자 수동 정리
안내 메시지로 fall-through. 기존 행에는 영향 없음 (생성 흐름에만 적용).

### #2 HIGH — `verify/route.ts:94` 완료 코드 timing-safe 비교

`got !== expected` → SHA-256 다이제스트 + `crypto.timingSafeEqual`로 교체.
입력·기대값 모두 문자 길이가 변할 수 있으므로 다이제스트(고정 32바이트)
비교가 timingSafeEqual의 동일-길이 요구를 안전하게 충족. 동작 의미는
동일 — 실패 시 같은 락아웃 카운터 증가, 성공 시 같은 verified_at 스탬프.

### #3 HIGH — `payment-info.ts` env 길이 가드

`PAYMENT_INFO_KEY` / `PAYMENT_INFO_KEY_V*`가 32자 미만이면 키 도출
시점에 throw. 운영자가 `"supersecret"` 같은 저-엔트로피 값을 잘못
설정해도 deploy 로그에서 즉시 실패하여 평문 출하를 막음. 기존 정상
설정(64-hex 추천)에는 영향 없음.

## 하네스 자체 개선 — 슬라이스 09 12/12 회복

1차에서 12 fence 중 3개만 파싱되던 문제 추적 결과: `evidence` 필드에
인라인 ` ``` ` 백틱이 들어 있어 fence regex가 조기에 닫혔던 것.
parser를 두 단계로 재구성:

1. `^```json ... ```\s*$/m` (앵커링된 fence) — 코드블록 안 ``` 무시
2. brace-walking 스캔 (quote-state 추적) — fence 문법 깨진 블록도 회수
3. dedup으로 중첩 회수 합치기

10/11 (raw 12개), 09 (raw 12개 → 12개 회수) 검증 완료.

## 페르소나 효과 측정

다층 방어 원칙(#6)이 실제 evidence/fix 본문에 반영된 케이스:

- `10-frontend-admin-ux experiments/page.tsx`: title에 "RLS 의존"이라고
  명시 → CRITICAL 대신 HIGH로 자체 강등
- `06-participants 00010`: persona가 RLS 정책 자체를 슬라이스에서 본
  결과 PII CRITICAL이 사라짐 (1차에는 있었음)
- `08-cron`: cron-secret.ts를 슬라이스에 넣었으나 모델이 line 23 의미
  를 잘못 해석 — 페르소나가 모르는 라이브러리 의미 (timingSafeEqual)
  를 인지시키지는 못함. 다음 페르소나 개선 후보

## 재실행 계획

수정(#1~#3) 적용 후 동일 하네스 3차 재실행 시 다음을 확인한다:
- CRITICAL 1건이 사라지는가 (users 라우트 롤백 추가로 트랜잭션 부재
  지적이 해소되어야 함)
- timing-safe 변경이 새로운 false positive를 만들지 않는가
- payment-info 길이 가드가 어떤 형태로 인지되는가
