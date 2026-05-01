# 이메일 자동화 — 개선 플랜 노트

3회의 Adversarial review (Opus) 결과를 종합한 개선 백로그.
원 리뷰 3건은 각각 **(A) 분산 시스템 / 정합성**, **(B) 보안 / 프라이버시**,
**(C) UX / 커뮤니케이션** 관점.

상위 항목은 여러 리뷰가 공통으로 지적한 것 — 즉 **루트 원인이 같거나
서로 묶어 한 번에 해결하는 게 효율적**인 묶음으로 정리.

---

## 0. 전체 진단 — 3개 리뷰의 공통 메시지

| 영역 | 핵심 진단 |
|---|---|
| (A) Architecture | "post-hoc CAS" 가 발송 직후 stamp 만 하고 발송 자체는 lock 안 걸음 → at-least-once 가 자주 발생. 멀티세션·reschedule 가 의존 데이터에 propagate 안 됨. 상태 전이 (cancel/no_show) 가 booking_integrations 에 audit row 안 남김 → "fail-soft" 가 실제로는 "fail-silent". |
| (B) Security | `PAYMENT_INFO_KEY` 단일 키가 RRN(passive read) + 토큰 plaintext(active capability) 둘 다 보호 → 단일 compromise 의 blast radius 가 너무 큼. `payment_link_first_opened_at` 이 unauthenticated/unrate-limited → 도난된 URL 의 토큰을 60일 보존 가능. 정산 submit 라우트도 rate-limit 부재. |
| (C) UX | 멀티세션 / 0원 실험 / 거절 흐름 등 **엣지케이스 침묵**이 가장 큰 마찰. 1회차 후 정산 폼에 들어와도 "지금 입력하면 저장됨/안됨"이 불분명해 silent data loss 위험. 일정 변경·노쇼 메일에 참여자가 "거절·재참여" 할 동선이 없어서 한국 학부생 권력거리 정서로 침묵 → 노쇼 악순환. |

세 리뷰 모두 한 가지에 동의: **현재 시스템은 happy path 는 잘 정리됐지만,
edge case / failure mode / multi-writer 시나리오에서 사일런트하게 깨진다.**

---

## 1. P0 — 즉시 처리 필요 (사용자 영향 또는 보안)

### P0-Α. 발송 디스패치 락 부재 — at-least-once 가 일상적으로 발생

**리뷰 출처:** A-P0-1, A-P0-6 (manual resend 와 cron 의 race), A-P0-5 (status flip 도 같은 패턴), B-P1-9 (race 가 보안 의미도 가짐)

**문제:**
`payment-info-notify.service.ts:91-330` 에서 `payment_link_sent_at IS NULL` 을
SELECT → SMTP send → conditional UPDATE 하는 구조. SELECT 와 UPDATE 사이에
SMTP call (~700ms) 이 들어 있어, 4개 트리거 (PUT-completed / observation
auto-complete / /run verify auto-complete / cron sweep) 가 사실상 동시에 fire
하면 동일 booking_group 에 2~4통 메일이 나간다. CAS 는 stamp 만 하지 발송을
막지 못함.

manual resend 는 더 위험 — 참여자가 이미 link 를 열었는지 (`first_opened_at`)
에 따라 한 트리거는 토큰 보존, 다른 트리거는 토큰 회전 → 동시에 일어나면
참여자가 두 통 받고 그중 하나는 죽은 링크.

**해결:**
1. Migration `00053_payment_link_dispatch_lock.sql`:
   ```sql
   ALTER TABLE participant_payment_info
     ADD COLUMN payment_link_dispatch_lock_until timestamptz;
   ```
2. `notifyPaymentInfoIfReady` 시작에서 atomic UPDATE 시도:
   ```sql
   UPDATE participant_payment_info
   SET payment_link_dispatch_lock_until = now() + interval '5 minutes'
   WHERE booking_group_id = $1
     AND payment_link_sent_at IS NULL
     AND (payment_link_dispatch_lock_until IS NULL
          OR payment_link_dispatch_lock_until < now())
   RETURNING id;
   ```
   row 가 안 돌아오면 즉시 `outcome: "lock_held"` 로 종료.
3. 같은 패턴을 `notifyBookingStatusChange` 에도 적용 — 단 이건 booking 레벨
   이므로 `bookings.status_email_dispatch_lock_until` 추가.

**영향 범위:** payment-info-notify.service, booking-status-notify.service,
새 migration 1개, 기존 테스트 수정 (race 시뮬레이션 테스트 추가).

---

### P0-Β. 토큰 회전 시 ciphertext 가 새 hash 와 desync — DB CHECK 위반 가능

**리뷰 출처:** A-P0-2

**문제:**
`payment-info-notify.service.ts:224-237` 의 rotation branch 가 `token_hash`
만 새로 쓰고 `token_cipher/iv/tag/key_version` 는 그대로 둔다. Migration
00052 의 `payment_info_token_blob_complete` CHECK 제약은 "all-NULL or
all-populated" 만 허용 — 이 자체는 위반 안 하지만 (이미 populated 상태
유지), **stale ciphertext 가 새 hash 와 짝이 안 맞음**. 다음에 참여자가
새 메일 링크를 누르면 `info.token_hash !== verified.hash` 로 INVALID 처리
됨 (`page.tsx:85`).

**해결:**
rotation branch 에서 새 토큰을 `encryptToken` → 같은 UPDATE 에 cipher/iv/
tag/key_version 도 함께 쓰기. 한 줄 추가:
```ts
const enc = encryptToken(issued.token);
await supabase.from(...).update({
  token_hash: issued.hash,
  token_cipher: toHex(enc.cipher),
  token_iv: toHex(enc.iv),
  token_tag: toHex(enc.tag),
  token_key_version: enc.keyVersion,
  // ...기존 필드
})
```

테스트: `test-payment-token-preserve.mjs` 에 "rotate after legacy preserve
fail → cipher updated to match new hash" 추가.

---

### P0-Γ. Reschedule 가 reminders 에 propagate 안 됨

**리뷰 출처:** A-P0-3

**문제:**
PATCH `/api/bookings/[id]` 가 `slot_start/end` 만 update 하고 `reminders.
scheduled_at` 은 그대로 둔다. cron 은 옛 시각에 fire 하면서 본문은 새 슬롯
정보 사용 → "오늘 18:00 실험" 안내가 어제 18:00 에 도착, 또는 실험 종료 후
도착.

**해결:**
1. Supabase RPC `reschedule_reminders(p_booking_id uuid, p_new_slot_start
   timestamptz, p_new_slot_end timestamptz)` 신설 — `book_slot` 의 KST 계산
   로직 재사용. `WHERE status='pending'` 만 UPDATE.
2. PATCH route 에서 booking UPDATE 직후 RPC 호출.
3. 같은 패턴: `participant_payment_info.period_start/end` 와 `amount_krw` 도
   reschedule 시 재계산해야 함 (A-P1-12).

---

### P0-Δ. 단일 키로 RRN + 토큰 plaintext 보호 — blast radius 과대

**리뷰 출처:** B-P0-2

**문제:**
`PAYMENT_INFO_KEY` 가 RRN 암호화 + 토큰 plaintext 암호화 둘 다 사용.
Vercel/Supabase 단일 compromise 가 (a) 모든 RRN 디크립트 + (b) 모든 pending
payment URL 발급 능력을 동시에 부여. (b) 는 active capability — 공격자가
참여자 행세로 forged 데이터 (가짜 계좌) 를 submit 하면 행정에서 그쪽으로
입금됨.

**해결:**
1. 별도 env `PAYMENT_TOKEN_PLAINTEXT_KEY` 도입.
2. `crypto/payment-info.ts` 를 두 함수로 분리:
   - `encryptRrn/decryptRrn` — `PAYMENT_INFO_KEY` 사용 (기존)
   - `encryptToken/decryptToken` — `PAYMENT_TOKEN_PLAINTEXT_KEY` 사용 (신규)
3. 두 키 모두 `validateBrandingForProduction` 옆에 startup-validation 추가.

**대안 (더 보수적):** 토큰 plaintext 를 아예 저장하지 않고, **resume token**
패턴 — 첫 open 시 별도 short-lived token 발급해 사용자 cookie + DB 에 저장,
auto-dispatch 메일에는 그 resume token 으로 link. 원본 confirmation 토큰은
첫 open 시 자연 만료. P0 #6 의 token-preserve 효과는 유지되면서 plaintext
저장은 사라짐. 단, 구현 복잡도 ↑.

---

### P0-Ε. `first_opened_at` 이 unauthenticated/unrate-limited

**리뷰 출처:** B-P0-1

**문제:**
`/payment-info/[token]/page.tsx:100-106` 가 매 valid GET 마다 admin client
로 stamp. 누구든 token URL 을 가지면 stamp 가능. 결과:
- 도난된 URL 도 한 번 열면 자동 발송에서 토큰 회전 안 함 → 60일 동안 살아
  있음.
- 정상 사용자가 안 열어도 메일 자동 forward / spam 격리 UI / 어깨너머 → 누가
  몰래 GET 한 번 → first_opened_at stamp.

**해결:**
1. page.tsx 에서 stamp 제거.
2. `PaymentInfoForm` 의 첫 input focus 또는 mount 시 `POST /api/payment-info/
   [token]/touch` 호출 → 서버에서 stamp. 봇 GET 으로는 stamp 안 됨.
3. `/touch` 라우트에 `X-Forwarded-For` 기반 per-token rate limit
   (`payment_link_open_attempts` int 컬럼 + 분당 5회 cap).

---

### P0-Ζ. 정산 submit 라우트 rate-limit 부재

**리뷰 출처:** B-P0-3

**문제:**
`/api/payment-info/[token]/submit` 가 `createAdminClient()` 로 RLS 우회.
HMAC 검증은 강하지만 per-IP / per-token throttle 이 없음. 토큰 plaintext 를
얻은 공격자가 N개 parallel POST 로 race → CAS first-write 가 공격자가 됨 →
연구원 export 에서 공격자 계좌로 입금.

**해결:**
1. 단순: middleware 또는 route handler 시작에 in-memory or Vercel KV 기반
   per-(IP × token) limiter — 분당 3회.
2. 정공: Vercel WAF rule for `/api/payment-info/*` (5 POST/min/IP, 20/day/
   token).
3. `verifyPaymentToken` 실패가 1분에 3회 이상 같은 IP 에서 발생하면 Sentry
   alert.

---

### P0-Η. status-notify (cancel/no_show) 발송이 `booking_integrations` 에 안 남음

**리뷰 출처:** A-P0-5

**문제:**
PUT `/api/bookings/[id]` 의 cancel/no_show 분기가 `notifyBookingStatusChange`
를 부르고 결과를 `console.warn` 만 함 — `booking_integrations` 에 audit row
가 없음. 발송 실패 시 사일런트로 잃음. 참여자가 "왜 통보 안 받았어요?" 항의
시 추적 불가.

**해결:**
1. `integration_type` enum 에 `status_email`, `status_sms` 추가 (migration).
2. `notifyBookingStatusChange` 가 마지막에 `booking_integrations` row INSERT
   (성공/실패).
3. 정책상 retry 안 하더라도 audit 는 항상 남김.

---

### P0-Θ. 멀티세션 1회차 후 정산 폼 진입 시 silent data loss

**리뷰 출처:** C-P0-1, C-P0-2

**문제:**
참여자가 1회차 끝나고 확정 메일의 정산 링크 누름 → 노란 경고 "지금 작성은
가능하지만, 제출은 마지막 세션 종료 후에만 처리됩니다." 가 뜸. **참여자는
"그럼 지금 입력하면 저장되나?" 가 가장 큰 의문이지만 답 없음.** 실제로는
저장 안 됨 → 다시 와서 RRN 두 번 입력.

추가로 폼이 처음부터 다시 시작 — `account_holder`, `bank_name`,
`institution` 이 page.tsx 에서 select 되긴 하지만 form 으로 안 넘김.

**해결:**
1. 노란 경고 박스 문구 수정:
   > "⚠ 마지막 세션이 아직 남아 있어 지금은 **제출이 불가**합니다 (남은
   > 회차: N회). 지금 작성하신 내용은 **저장되지 않으니** 마지막 세션
   > 종료일({날짜}) 이후에 다시 이 링크를 열어 입력해 주세요."
2. RRN/통장사본/서명 입력란을 disabled 처리하거나 form 자체를 hard gate
   ("아직 입력 시점이 아닙니다") 로 바꿈. 부분 입력 자체를 막는 게 silent
   data loss 보다 친절.
3. `account_holder/bank_name/institution` 이미 select 한 것 form 에 prefill.

---

### P0-Ι. 다크모드 메일 박스 색상 깨짐

**리뷰 출처:** C-P0-5

**문제:**
Gmail iOS app + 다크모드. 인라인 background + 진색 글자 조합이 강제
darken 으로 흡수됨 → 본문 거의 안 보임.

**해결:**
모든 메일 template 의 `<head>` 에 추가:
```html
<meta name="color-scheme" content="light">
<meta name="supported-color-schemes" content="light">
```
강제 다크 변환 비활성화 (대부분 클라이언트 존중). 추가 안전장치로 박스를
`background: transparent; border: 2px solid {color}` 로 전환 권장.

---

### P0-Κ. RRN 입력 `type=password` → iOS Keychain 트리거

**리뷰 출처:** C-P0-7

**문제:**
iPhone Safari 가 `type=password` 만나면 iCloud Keychain 저장 비밀번호 제안
팝업 (autoComplete="off" 무시). 참여자 당황 + RRN 이 비밀번호로 저장될
위험. `👁/🙈` 이모지 버튼은 일부 안드로이드 폰트 fallback 깨짐 + screen
reader 가 "토끼" "원숭이" 로 읽음.

**해결:**
1. `type="text"` 로 되돌리기 + CSS `-webkit-text-security: disc` 마스킹.
   Chromium/WebKit 지원, Firefox fallback 만 깨짐 (수용 가능).
2. 이모지 → SVG heroicons (eye / eye-slash) 교체.
3. `name="participant-id-number"` + `data-form-type="other"` (1Password 힌트)
   로 password manager 캡처 차단.

---

### P0-Λ. 참여비 0원 실험 — 정산 메일 침묵에 대한 안내 부재

**리뷰 출처:** C-P0-6

**해결:**
booking-email-template.ts 의 fee 분기에서 `fee == 0` 시 별도 회색 박스:
> "본 실험은 **참여비 없는 실험**입니다. 별도 정산 절차가 없으며, 학점
> 인정 등은 담당 연구원에게 문의해 주세요."

---

## 2. P1 — 다음 사이클

### 정합성·라우팅 (A 리뷰)

| ID | 항목 | 핵심 |
|---|---|---|
| A-P1-8 | auto-complete cron sweep 이 50건 한정 + 정렬 없음 | `created_at ASC` + 200건, 또는 RPC 가 booking_group_id[] 반환하는 형태로 변경 |
| A-P1-10 | reschedule pipeline 에서 SMS 가 email 실패와 무관하게 발송 | email 성공 후에만 SMS, 또는 retry 가능하게 |
| A-P1-11 | 리마인드 실패 후 재시도 안 되고 cancellation 시 sent_at stamp 됨 | day_before 만 12h 후 1회 재시도, cancellation 은 status='cancelled' enum 추가 |
| A-P1-13 | runReschedulePipeline 에 auth precondition 없음 | 호출 전 `bookings.slot_start != params.oldSlotStart` 검증 |

### 보안 (B 리뷰)

| ID | 항목 | 핵심 |
|---|---|---|
| B-P1-5 | PUT /api/bookings 가 admin client 로 mutation | 후처리만 admin, mutation 은 user-scoped |
| B-P1-7 | /run 에러 코드 5종 노출 — 토큰 lifecycle enumeration | payment-info 처럼 EXPIRED/INVALID 두 코드로 collapse |
| B-P1-8 | subject line escapeHtml 부재 — 헤더 인젝션 잠재 | `sanitizeHeader()` 추가 (CR/LF strip) |
| B-P1-9 | SMTP Sent 폴더에 모든 payment URL 60일 보존 | Postmark/SES 이전 또는 24h 자동삭제 Gmail 필터 |
| B-P1-10 | 계좌번호/예금주 plaintext 저장 | RRN 과 동일 키 versioning 으로 암호화 |
| B-P1-11 | 통장사본 orphan upload purge cron 부재 | 미참조 파일 24h 후 삭제 cron |

### UX (C 리뷰)

| ID | 항목 | 핵심 |
|---|---|---|
| C-P0-3 | 일정변경 메일에 거절 동선 없음 | "이 시간이 어려우시면 거절하실 수 있습니다" + 회신 가이드 |
| C-P0-4 | 노쇼 메일 — "다음 행동" 비결정 | mailto 깊은 링크 (subject/body prefill) |
| C-P0-8 | 정산 submit success 화면 — "곧" 모호 | "2~4주 이내" 명시 + 마스킹 계좌번호 4자리 |
| C-P1-1 | 정산 메일 CTA 가 정보 리스트 위 | 본문 흐름 재배치 또는 CTA sticky 반복 |
| C-P1-2 | 확정 메일 4개 컬러 박스 우선순위 충돌 | 색→회색 통일, 헤드라인만 색 강조 |
| C-P1-3 | SMS 에 풀 URL 부재 | 단축 URL 또는 day_of SMS 한정 /run URL |
| C-P1-4 | Reply-To 헤더 부재 | sendEmail 호출에 `replyTo: researcherEmail` |
| C-P1-5 | 캔버스 모바일 회전 시 좌표 어긋남 | resize listener + clear or redraw |
| C-P1-6 | 통장사본 안내 — "스마트폰 사진 OK" 명시 부재 | 안내 문구 풀어쓰기 |
| C-P1-7 | 폼 제출 실패 시 자가 해결 가이드 부재 | inline 에러 박스 + 3단계 가이드 |
| C-P1-8 | 노쇼/취소 메일 재시도 안 함 | 12h 후 1회 retry |
| C-P1-9 | 정산 패널 "재발송" 버튼 안전성 불명 | tooltip 또는 ⓘ 추가 |

---

## 3. P2 — 폴리시 / 백로그

### Architecture (A)

- **A-P2-14**: `runReschedulePipeline` 192줄 → 순차 step 으로 분해
- **A-P2-15**: `period_end` vs `auto_complete + 7d` 표기 불일치 — 라벨 변경
- **A-P2-16**: 토큰 키 fallback chain 위험 — 키 버전 + startup digest check
- **A-P2-17**: confirmation 발송 N개 integration row 마킹 partial write
- **A-P2-18**: bookings.experiments join 컬럼 리스트 6곳에 중복 → `loadBookingForEmail` helper
- **A-P2-19**: race condition 테스트 부재 → `test-payment-concurrent.mjs`

### Security (B)

- **B-P2-12**: GH Actions 워크플로의 `secret_length` 로깅 제거
- **B-P2-13**: `/api/cron/*` 의 `Bearer` fallback 제거 (proxy 로깅 위험)
- **B-P2-14**: 메일 템플릿의 `href="${url}"` 도 escapeHtml + 따옴표 quote
- **B-P2-15**: payment-info 페이지에 strict CSP 헤더
- **B-P2-16**: RRN decrypt 실패 시 export 가 빈 문자열 → hard fail + alert
- **B-P2-17**: `payment_link_last_error` 의 SMTP 에러 텍스트 PII strip
- **B-P2-18**: PIPA 데이터 보존 정책 cron + 공개 정책 문서

### UX (C)

- **C-P2-1**: subject prefix `[랩]` 반복 → "랩 · " separator
- **C-P2-2**: i18n hook (`participants.preferred_language`)
- **C-P2-3**: 무의미 footer "본 메일은 예약 신청 확인용" 제거 또는 정보화
- **C-P2-4**: precaution amber ≡ reschedule amber → reschedule 색 변경
- **C-P2-6**: 확정 메일 표 td 에 `word-break:keep-all` 추가
- **C-P2-7**: /run 에러 화면의 `err: {reason}` 노출 → `<details>` 토글
- **C-P2-8**: 메일·SMS 정보 일치성 (특히 거절 가이드)

---

## 4. 공통 루트 원인 — "이거 하나 고치면 N개 해결"

리뷰 3건이 공통으로 지적한 구조적 결함 3가지. 위 P0/P1 의 **루트** 이므로
이걸 먼저 처리하면 cascade 로 여러 항목이 사라짐:

### 루트 #1 — Integration row 가 outbound message 의 single source of truth 가 아님
- 영향: A-P0-5, A-P1-10, A-P1-11, B-P1-9 (Sent 폴더가 사실상 audit), C-P1-8
- 해결: `integration_type` enum 확장 (`status_email`, `status_sms`,
  `payment_dispatch`, `reminder_retry`) + 모든 outbound 가 row 를 남김 + outbox-
  retry 가 일관된 정책으로 운영.

### 루트 #2 — Lock 없이 "post-hoc CAS" 패턴
- 영향: A-P0-1, A-P0-6, A-P1-9, B-P1-9
- 해결: `*_dispatch_lock_until timestamptz` 컬럼 + 발송 전 atomic UPDATE
  acquire-lock pattern. SMTP 동안 lock hold, 성공 시 stamp_sent_at, 실패 시
  release lock for retry.

### 루트 #3 — Reschedule mutation 이 의존 row 에 propagate 안 됨
- 영향: A-P0-3, A-P1-12, C-P1-8
- 해결: PATCH 직후 `propagate_booking_change(booking_id)` RPC 호출 — reminders
  + payment_info.period + GCal 까지 한 번에. 함수 안에서 atomic.

---

## 5. 마이그레이션·릴리스 순서

P0 들이 서로 독립적이지 않음. 다음 순서 권장:

```
Phase 1 — 즉시 보안/안정화 (1주)
  ├─ P0-Ζ  rate limit on /api/payment-info/*/submit          (코드만, 마이그 X)
  ├─ P0-Ε  first_opened_at 을 form interaction 로 이전        (코드 + 1 라우트)
  ├─ P0-Β  rotation 시 cipher 도 같이 update                  (코드 1줄)
  └─ P0-Ι  메일 dark-mode meta 추가                          (template 5개)

Phase 2 — Lock + audit 인프라 (2주)
  ├─ migration 00053 — dispatch_lock_until + integration_type 확장
  ├─ P0-Α  lock-acquire 패턴으로 notify 재작성
  ├─ P0-Η  status-notify 가 booking_integrations row 남김
  └─ 테스트 — race condition 시뮬레이션 추가

Phase 3 — Reschedule propagation (1주)
  ├─ migration 00054 — reschedule_reminders RPC
  ├─ P0-Γ  PATCH 가 reminders + payment_info.period propagate
  └─ A-P1-12 동시 처리

Phase 4 — 키 분리 (보안 강화) (1-2주)
  ├─ env 추가 — PAYMENT_TOKEN_PLAINTEXT_KEY
  ├─ P0-Δ  crypto/payment-info.ts 분리
  ├─ key rotation cron 신설
  └─ B-P2-16 RRN decrypt fail 시 hard fail

Phase 5 — UX 폴리시 (P0-Θ, Λ, Κ + P1 UX 항목들) (2주)
  ├─ P0-Θ  멀티세션 1회차 후 진입 시 hard gate + 안내
  ├─ P0-Λ  0원 실험 안내 박스
  ├─ P0-Κ  RRN 입력 CSS 마스킹 + SVG 아이콘
  ├─ C-P0-3, C-P0-4  거절·재참여 동선 추가 (메일 본문 변경)
  ├─ C-P0-8  success 화면 "2~4주 이내" + 마스킹 계좌
  └─ C-P1-3, P1-4, P1-5, P1-6, P1-9 한 번에

Phase 6 — Backlog (P2 + 신규 기능 검토) (필요 시)
  ├─ Postmark/SES 이전 (B-P1-9)
  ├─ 계좌 plaintext 암호화 (B-P1-10)
  ├─ orphan purge cron (B-P1-11)
  ├─ i18n (C-P2-2)
  └─ runReschedulePipeline 분해 (A-P2-14) 등
```

---

## 6. 개별 항목 처리 시 주의 (multi-session 환경)

이 리포는 여러 Claude 세션이 동시에 수정 중. 위 phase 들을 다음 세션이
이어받을 때:

1. **Phase 진입 전 `git fetch && git log HEAD..origin/main`** — 다른 세션이
   migration 번호 (`00053+`) 를 먼저 차지했을 수 있음.
2. **`participant_payment_info` 컬럼 추가 시** — Phase 2 의
   `dispatch_lock_until` 와 Phase 4 의 키 버전 컬럼이 같은 마이그레이션에
   섞이면 회수 어려움. 한 phase 당 1 migration.
3. **`booking-email-template.ts` 수정 시** — 4개 템플릿이 비슷한 구조라 같은
   파일에 동시 수정 충돌 위험. 한 PR 에 1 파일.
4. **테스트 추가 시** — 기존 7 suite (276 tests) 회귀 항상 확인 (
   `payment-stream3, payment-info-notify, branding-placeholder, booking-status-
   email, booking-reschedule-email, run-token-error-contact,
   payment-token-preserve`).

---

## 7. 우선순위 요약 (TL;DR for next operator)

> **이번 주 안에 해야 할 3가지:**
> 1. `/api/payment-info/*/submit` 에 per-IP rate limit 추가 (P0-Ζ)
> 2. 메일 템플릿 5개에 `<meta name="color-scheme" content="light">` (P0-Ι)
> 3. 멀티세션 1회차 후 정산 폼 hard gate + 안내 문구 (P0-Θ)
>
> **2주 안:**
> - dispatch lock 인프라 (P0-Α 루트 #2) — race 자체 차단
> - reschedule propagation RPC (P0-Γ 루트 #3)
> - status-notify audit row (P0-Η 루트 #1)
>
> **1개월 안:**
> - 키 분리 (P0-Δ) — 보안 blast radius 축소
> - first_opened_at 인증 (P0-Ε)
> - UX 폴리시 묶음 (Phase 5)

---

**리뷰 원문 보존 위치:** 본 노트는 3건의 review 원문을 합친 요약. 원문이
필요하면 `git log` 로 본 commit 의 부모 커밋 메시지 + 본 commit 시점의
session transcript 확인.
