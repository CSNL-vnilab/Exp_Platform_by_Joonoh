# Email Automation 가이드 (실험자용)

이 문서는 본 플랫폼이 참여자·연구원에게 자동 발송하는 모든 이메일·SMS의 동작과,
실험자가 그 세부사항을 어디서·어떻게 조정할 수 있는지를 정리합니다.

> 코드 진입점만 빠르게 보고 싶다면 → [부록 A: 파일 맵](#부록-a-파일-맵).
> 운영자(관리자) 입장 환경설정 → [부록 B: env 설정](#부록-b-env-설정).

---

## 0. 전체 흐름 한눈에

```
참여자 예약 신청
        │
        ├─► [E1] 예약 확정 메일 + SMS                            ← 즉시
        │
        │  (예약 시점에 두 개의 reminders 행도 함께 INSERT)
        │
        ├─► [E2] 전일 18:00 KST 리마인드 메일 + SMS              ← 매 15분 cron
        ├─► [E3] 당일 09:00 KST 리마인드 메일 + SMS              ← 매 15분 cron
        │
   ┌────┴────┐
   │ 실험 종료│
   └────┬────┘
        │  (booking → 'completed' 전이)
        │
        ├─► [E6] 정산 정보 입력 안내 메일                        ← 즉시 (멀티세션은 마지막 회차 후)
        │  · 참여자가 이미 링크를 열었으면 동일 URL 재발송 (P0 #6)
        │  · 처음이면 새 토큰 발급 + 발송
        │
        │  (참여자가 폼 제출하면 status → 'submitted_to_admin')
        │
        ├─► (연구원) 청구 번들 ZIP 다운로드 → 행정 이메일로 직접 전달
        │
   (별도 분기: 연구원이 status 변경 시)
        │
        ├─► [E4] 일정 변경(reschedule) 메일 + SMS               ← 즉시
        ├─► [E5a] 취소(cancel) 메일 + SMS                       ← 즉시
        └─► [E5b] 노쇼(no_show) 메일 + SMS                      ← 즉시

(연구원 가입 흐름 — 참여자 메일과는 별개)
        │
        ├─► [E7] 가입 신청 → 관리자에게 알림                     ← 즉시
        ├─► [E8] 관리자가 승인 → 신청자에게 승인 안내             ← 즉시
        └─► [E9] 새 실험 공개 → 랩 구성원 전체 BCC 안내           ← 즉시 (선택)

(연구원 본인용)
        └─► [E10] 메타데이터 누락 알림                          ← 매주 월요일 09:00 KST
```

---

## 1. 참여자에게 발송되는 이메일·SMS

### E1. 예약 확정 (booking confirmation)

| 속성 | 값 |
|---|---|
| 발생 시점 | 참여자가 예약 신청을 완료한 직후 (POST `/book/[experimentId]/confirm`) |
| 채널 | 이메일 + SMS (SOLAPI 환경변수가 있을 때만 SMS) |
| 수신자 | 참여자 본인 (이메일은 담당 연구원 cc) |
| 트리거 | `runPostBookingPipeline` → `runEmail` / `runSMS` |
| 템플릿 | `src/lib/services/booking-email-template.ts:buildConfirmationEmail` |
| 제목 | `[연구실] 실험 예약 확정 — {실험명}` |

**메일 본문에 포함되는 것:**
- ✓ 헤드라인 박스 (녹색) + "변경·취소가 필요하면 24시간 전까지 담당자에게 알려주세요" 보조 라인
- 실험명 / 회차별 일시 / 참여비
- (온라인/하이브리드 실험만) `/run/{bookingId}?t=…` 링크
- (오프라인 실험만) 위치 + 네이버 지도 링크
- 예약 시 동의한 사전 주의사항(precautions)
- (참여비 > 0) 정산 정보 입력 링크 (1차 발송)
- 담당 연구원 이름 + 전화 + 이메일 + 푸터 워터마크

**연구원이 조정할 수 있는 것:**
| 어디서 | 무엇 |
|---|---|
| 실험 생성/수정 폼 | 실험명·참여비·위치·실험 모드·precautions·온라인 entry_url |
| 본인 프로필 (`/users` → 본인 행) | 표시 이름·연구원 contact_email·전화번호 |
| (운영자) env | `NEXT_PUBLIC_LAB_NAME`, `NEXT_PUBLIC_LAB_CONTACT_EMAIL` (랩 브랜드 / fallback 메일) |

---

### E2 / E3. 리마인드 메일 + SMS (전일 / 당일)

| 속성 | 값 |
|---|---|
| 발생 시점 | E2: 전일 18:00 KST · E3: 당일 09:00 KST (실험별로 변경 가능) |
| 채널 | 이메일 + SMS |
| 수신자 | 참여자 본인 (담당 연구원 cc) |
| 트리거 | GitHub Actions cron `*/15 * * * *` → `POST /api/notifications/reminders` → `processReminders()` |
| 템플릿 | `src/lib/services/reminder.service.ts` 안 인라인 |
| 제목 | `[연구실] 내일/오늘 실험 리마인드 — {실험명}` |

**메일 본문:**
- 🔔(전일) 또는 ⏰(당일) 헤드라인 박스
- 실험명 / 일시 / 회차
- (오프라인) 위치 + 네이버 지도 링크
- precautions
- 담당 연구원 contact

**연구원이 조정할 수 있는 것:**
| 어디서 | 무엇 |
|---|---|
| 실험 생성/수정 폼의 "리마인더" 섹션 | `reminder_day_before_enabled` (on/off)<br>`reminder_day_before_time` (기본 18:00 KST)<br>`reminder_day_of_enabled` (on/off)<br>`reminder_day_of_time` (기본 09:00 KST) |

리마인드 행은 예약 시점에 미리 INSERT 되며, cron 이 `scheduled_at <= now()` 인 행만 골라 보냅니다.
**예약 시점 이후에 위 시간 설정을 바꿔도 이미 큐된 리마인드의 시각은 바뀌지 않습니다** —
정 바꾸려면 해당 booking 의 `reminders` 행을 직접 update 하거나, cron 실행 전에 booking 을 reschedule 해 새 reminder 행을 만들어야 합니다.

booking 이 `cancelled` 가 되면 `processReminders()` 가 자동으로 해당 reminder 를 `sent` 로 마감합니다(발송 X).

---

### E4. 일정 변경 (reschedule)

| 속성 | 값 |
|---|---|
| 발생 시점 | 연구원이 booking 의 시간을 변경한 직후 (PATCH `/api/bookings/[id]`) |
| 채널 | 이메일 + SMS |
| 수신자 | 참여자 본인 (담당 연구원 cc) |
| 트리거 | `runReschedulePipeline` |
| 템플릿 | `src/lib/services/booking-reschedule-email.ts:buildRescheduleEmail` / `buildRescheduleSMS` |
| 제목 | `[연구실] {실험명}{회차} 일정이 변경되었습니다` |

**메일 본문:**
- 📅 헤드라인 박스 (amber)
- 인사 + "갑작스러운 변경에 양해 부탁드립니다" 사과 한 줄
- 표: 실험명 / (회차 > 1 일 때만) 회차 / **이전 일정** (취소선) / **변경된 일정** (강조)
- (멀티세션) 다른 회차는 그대로 진행됨을 명시 + 회차별 일시 리스트
- (오프라인) 위치 블록
- 담당 연구원 contact + 푸터

**SMS 본문:** `[연구실] 일정 변경\n{이름}님, "{실험명}" {N회차}\n{이전 일시} → {변경된 일시}\n문의: {연구원 contact_email}`

**연구원이 조정할 수 있는 것:**
- 본인 프로필 contact 정보가 메일·SMS 양쪽에 들어갑니다.
- 메일 본문 자체는 **수정 UI 없음** — 사과 톤·CTA·표 모양은 코드에 박혀 있어 PR 로 변경.

---

### E5a / E5b. 취소 / 노쇼

| 속성 | 값 |
|---|---|
| 발생 시점 | 연구원이 booking 을 `cancelled` 또는 `no_show` 로 변경 (PUT `/api/bookings/[id]`) |
| 채널 | 이메일 + SMS |
| 수신자 | 참여자 본인 |
| 트리거 | `notifyBookingStatusChange` |
| 템플릿 | `src/lib/services/booking-status-email.ts` |
| 제목 | 취소: `[연구실] {실험명}{회차} 예약이 취소되었습니다`<br>노쇼: `[연구실] {실험명}{회차} 결석이 기록되었습니다` |

**취소 메일:**
- 빨간 헤드라인 박스 + "부득이한 사정으로 일정을 진행하지 못하게 된 점 양해 부탁드립니다" 사과
- 취소된 일정 (취소선)
- (멀티세션) 다른 회차는 예정대로 진행됨 안내 + 리스트
- (오프라인) 다시 예약하기 CTA 버튼 (booking page 링크). **온라인 실험은 CTA 자동 숨김** (재예약 흐름이 다름)
- 담당 연구원 contact

**노쇼 메일:**
- 노란 헤드라인 박스 + "피치 못할 사정이 있으셨다면 담당 연구원에게 알려 주세요" (비난 X)
- 결석 기록된 일정
- "다시 참여 가능 여부는 담당 연구원에게 문의" 안내
- 담당 연구원 contact

**SMS:** 짧은 형태 — "예약 취소" / "결석 기록" + 일시 + 문의처.

> 메일·SMS 발송이 SMTP/SOLAPI 오류로 실패해도 booking 의 status 변경 자체는 롤백되지 않습니다. 발송 실패는 콘솔 로그에만 남습니다.

---

### E6. 정산 정보 입력 안내 (auto-dispatch)

| 속성 | 값 |
|---|---|
| 발생 시점 | booking_group 의 **모든** booking 이 `completed` 가 되는 순간 (멀티세션이면 마지막 회차 끝) |
| 채널 | 이메일만 (SMS X — 정산 링크는 메일 전용) |
| 수신자 | 참여자 본인 |
| 트리거 4곳 | (a) PUT `/api/bookings/[id]` status='completed', (b) `submit_booking_observation` RPC 의 자동완료 분기, (c) `/run` verify 엔드포인트의 자동완료 분기, (d) cron `auto-complete-bookings` 의 sweep |
| 템플릿 | `src/lib/services/payment-info-email-template.ts:buildPaymentInfoEmail` |
| 제목 | `[연구실] {실험명} 참여비 정산 정보 입력 안내` (또는 `(재안내)`) |

**메일 본문:**
- 📝 헤드라인 + "참여비 X원 지급을 위해 아래 링크에서 정산 정보를 입력해 주세요"
- 보라색 CTA 박스 + 링크 (`/payment-info/{token}`)
- "필요한 정보" 리스트: 성명·연락처·이메일·소속 / 주민등록번호 / 본인 명의 계좌 / 통장 사본 / 전자서명
- ⚠ 일회성 링크 + 만료일(60일) 안내
- 담당 연구원 contact

**핵심 동작 — 토큰 보존 (P0 #6, migration 00052):**
- 이미 예약 확정 메일에 정산 링크가 한 번 들어갔습니다. 자동 발송 시 토큰을 회전(=원본 링크 죽음)시키면 참여자가 북마크해 둔 링크가 invalid 가 됩니다.
- 따라서: 참여자가 확정 메일의 링크를 **한 번이라도 열었으면** (`payment_link_first_opened_at != NULL`), 동일 토큰을 그대로 재발송. 제목에 `(재안내)` 가 붙고 본문 인사가 "확정 메일에서 보내드린 동일한 링크가 그대로 사용 가능하니, 이미 입력 중이셨다면 그대로 이어서 진행하셔도 됩니다." 로 바뀝니다.
- 한 번도 열지 않았으면 새 토큰 발급 + 회전. 첫 메일의 링크가 죽지만 참여자가 본 적 없으니 무해합니다.

**멱등성:**
- `payment_link_sent_at` 이 NULL 인 행만 발송. 같은 booking_group 의 booking 들이 차례로 completed 로 바뀌어도 마지막 한 번만 메일이 나갑니다.
- 4개 트리거 경로가 동시에 fire 해도 마지막 1회만 실제로 발송 (CAS).

**연구원이 조정할 수 있는 것:**
| 어디서 | 무엇 |
|---|---|
| 실험 생성 폼 | `participation_fee` (0 이면 정산 메일 자체 발송 안 함) |
| `/experiments/{id}/bookings` 페이지의 정산 패널 | "안내 메일" 컬럼: 발송 시각 / 발송 실패 / 미발송 상태 확인 |
| 동일 패널의 **재발송 버튼** | 발송 상태를 리셋하고 다시 보냄 (POST `/api/experiments/{id}/payment-info/{bookingGroupId}/resend`) |
| 정산 패널의 금액 인라인 편집 | 자동 계산된 amount 를 수동 override (정산 메일 다음 발송 시 새 금액 반영) |

---

### E6'. 정산 안내 수동 재발송 (manual resend)

| 속성 | 값 |
|---|---|
| 발생 시점 | 연구원이 정산 패널 "재발송" 또는 "안내 메일 발송" 버튼을 클릭 |
| 트리거 | POST `/api/experiments/[id]/payment-info/[bookingGroupId]/resend` |

자동 발송과 동일 함수(`notifyPaymentInfoIfReady`)를 사용하지만 호출 전에 발송 상태(`payment_link_sent_at`, `payment_link_attempts`, `payment_link_last_error`)를 리셋해 무조건 발송 모드로 진입합니다. 토큰 보존 규칙은 그대로 적용 — 이미 열었으면 동일 링크, 아니면 새 토큰.

조건:
- 본인이 만든 실험 또는 admin 만 호출 가능
- booking_group 의 모든 booking 이 `completed` 여야 함 (아니면 409 "모든 실험 세션이 종료된 후에 발송할 수 있습니다")
- 참여자 이메일 주소가 있어야 함 (`email_override` 또는 `participants.email`)
- 정산이 이미 제출되었으면 재발송 불가 (409)

---

## 2. 연구원/관리자 운영 메일

### E7. 신규 가입 신청 알림 (관리자에게)

| 속성 | 값 |
|---|---|
| 발생 시점 | 외부인이 `/signup` 에서 가입 신청 |
| 수신자 | `LAB_APPROVAL_EMAIL` (또는 fallback `NEXT_PUBLIC_LAB_CONTACT_EMAIL`) |
| 트리거 | POST `/api/registration-requests` |
| 제목 | `[연구실] 연구원 등록 요청 — {ID}` |
| 본문 | ID·이름·요청시각 + `/users` 승인 페이지 링크 |

`LAB_APPROVAL_EMAIL` / `NEXT_PUBLIC_LAB_CONTACT_EMAIL` 둘 다 미설정 시 메일 자체를 보내지 않습니다 (placeholder 누출 방지). 관리자는 `/users` 페이지에서 직접 확인.

---

### E8. 가입 승인 알림 (신청자에게)

| 속성 | 값 |
|---|---|
| 발생 시점 | 관리자가 `/users` 에서 가입 신청을 승인 |
| 수신자 | 신청자가 가입 시 입력한 contact_email |
| 트리거 | `sendRegistrationApprovedEmail` |
| 제목 | `[연구실] 연구원 가입 승인 안내 — {이름}` |
| 본문 | ✓ 헤드라인 + 로그인 ID + 안내 + `/login` CTA + 담당 관리자 안내 |

---

### E9. 신규 실험 공개 안내 (랩 구성원 전체)

| 속성 | 값 |
|---|---|
| 발생 시점 | 연구원이 실험 status 를 `draft` → `active` 로 변경 |
| 수신자 | `to`: 랩 inbox / `bcc`: 모든 연구원 프로필의 contact_email |
| 트리거 | 실험 status 변경 핸들러 → `notifyExperimentPublished` |
| 제목 | `[연구실] 새 실험 공개 — {제목}` |
| 본문 | 📣 헤드라인 + 프로젝트·모집기간·운영요일·세션·참여비 표 + (있으면) 실험 소개 + 실험 상세 페이지 + 예약 페이지 CTA |

`NEXT_PUBLIC_LAB_CONTACT_EMAIL` 미설정 시 발송 자체를 skip 합니다.

---

### E10. 메타데이터 누락 주간 알림

| 속성 | 값 |
|---|---|
| 발생 시점 | 매주 월요일 00:00 UTC (= 09:00 KST) cron |
| 수신자 | 메타데이터(코드 디렉토리·데이터 경로·사전 체크리스트)가 비어있는 실험의 created_by 연구원 |
| 트리거 | GitHub Actions `metadata-reminders-cron.yml` → `POST /api/cron/metadata-reminders` |
| 제목 | `[연구실] 실험 메타데이터 입력 알림` |

라우트 레벨에서 rate-limit (한 연구원당 한 주 1회) — 입력하면 다음 주부터 자동 중단.

---

## 3. 실험자가 자주 조정하는 항목 — 빠른 레퍼런스

### 3.1 본인 contact 정보 (모든 메일 footer 에 들어감)

`/users` → 본인 행 → 수정. 다음 3개가 모든 참여자 메일/SMS 에 노출됩니다:

| 필드 | 우선순위 |
|---|---|
| `contact_email` | 1순위. 비어있으면 `email`(로그인 메일)로 fallback |
| `phone` | 표시는 가능하면 같이 |
| `display_name` | 비어있으면 "담당 연구원" 으로 fallback |

`contact_email` 만 사용자에게 노출 — 로그인 ID(`@lab.local` 합성)는 절대 노출 안 됩니다.

### 3.2 실험별 메일 영향 필드

`/experiments/new` 또는 `/experiments/{id}` 편집 폼:

| 필드 | 어떤 메일에 영향 |
|---|---|
| `title` | 모든 메일 제목·본문 |
| `participation_fee` | 0 이면 정산 메일(E6) 자체 발송 안 됨 + 확정 메일(E1) 의 paymentBlock 숨김 |
| `precautions` | 확정 메일(E1) + 리마인드(E2/E3) 의 "참여 전 확인 사항" |
| `experiment_mode` | online → 확정 메일에 `/run` 링크 / 리마인드에서 위치 블록 자동 숨김 / 취소 메일 rebook CTA 자동 숨김 |
| `online_runtime_config.entry_url` | E1 의 `/run` 링크 활성화 조건 |
| `location_id` | 오프라인 실험의 위치 + 네이버 지도 표시 |
| `reminder_day_before_enabled/time` | 전일 리마인드(E2) 발송 여부·시각 |
| `reminder_day_of_enabled/time` | 당일 리마인드(E3) 발송 여부·시각 |

### 3.3 발송 후 사후 조치

| 상황 | 어디서 | 액션 |
|---|---|---|
| 참여자가 확정 메일을 못 받았다 | (참여자에게 직접 재발송 UI 없음) | DB 의 `booking_integrations.status='failed'` 행을 admin 이 확인 → outbox-retry cron 이 자동 재시도 |
| 정산 메일이 누락/실패 | `/experiments/{id}/bookings` → 정산 패널 → "재발송" | 새 토큰 또는 동일 토큰(이미 열림) 재발송 |
| 일정 변경 메일 톤 수정 필요 | 코드 수정 → PR | `src/lib/services/booking-reschedule-email.ts` |
| 리마인드 시각 조정 | 실험 편집 폼 | 위 3.2 의 `reminder_*_time` 필드 |
| 랩 브랜드명·연락처 변경 | Vercel env | `NEXT_PUBLIC_LAB_NAME`, `NEXT_PUBLIC_LAB_CONTACT_EMAIL` (재배포 필요) |

---

## 4. 발송 실패·재시도

모든 발송은 `booking_integrations` 테이블에 audit row 를 남깁니다 (`integration_type` IN `email`/`sms`/`gcal`/`notion`). status 가 `failed` 인 행은 cron `outbox-retry` 가 4시간마다 picking up → 최대 5회 재시도.

| 메일 | 재시도 동작 |
|---|---|
| E1 (확정 메일) | 재시도 가능. 토큰은 보존 (동일 링크 재발송) |
| E2/E3 (리마인드) | 재시도 안 함 — 시간이 지나면 의미 X |
| E4 (일정 변경) | 재시도 가능 |
| E5a/b (취소·노쇼) | 재시도 안 함 (코드 정책) |
| E6 (정산 메일) | 재시도 안 함. 연구원이 패널에서 수동 "재발송" |

`payment-info` 의 `payment_link_attempts` / `payment_link_last_error` 컬럼이 정산 메일의 시도 횟수·마지막 오류를 기록합니다. UI 의 정산 패널에서 "발송 실패 (N회)" 로 노출 + "다시 시도" 버튼 제공.

---

## 5. 발송 안 함을 보장하는 규칙 (안심)

| 규칙 | 어디서 |
|---|---|
| `participation_fee == 0` 인 실험은 정산 메일 자체가 만들어지지 않음 | `seedPaymentInfo` 의 early return |
| booking 이 `cancelled` 면 큐된 리마인더가 자동 마감(발송 X) | `processReminders` 의 status check |
| 멀티세션 중 일부만 completed 인 그룹은 정산 메일 발송 X | `notifyPaymentInfoIfReady` 의 "all completed" check |
| `NEXT_PUBLIC_LAB_NAME` / `_CONTACT_EMAIL` 미설정 prod 빌드는 cold-start 시 throw | `src/instrumentation.ts` (P0 #1) |
| 환경 미설정 시 메일 본문의 `mailto:` 라인은 자동 숨김 (placeholder 누출 방지) | `brandContactEmailOrNull()` |
| 연구원 cc 가 참여자 이메일과 동일하면 cc 안 함 (중복 수신 방지) | `runEmail` |

---

## 부록 A: 파일 맵

```
src/lib/services/
├─ booking.service.ts                 # E1 + E4 dispatch
├─ booking-email-template.ts          # E1 메일 빌더
├─ booking-reschedule-email.ts        # E4 메일/SMS 빌더
├─ booking-status-email.ts            # E5a/E5b 메일/SMS 빌더
├─ booking-status-notify.service.ts   # E5 dispatch
├─ payment-info-notify.service.ts     # E6 dispatch + sweep
├─ payment-info-email-template.ts     # E6 메일 빌더
├─ reminder.service.ts                # E2/E3 (템플릿 + dispatch 한 파일)
├─ lab-notifications.service.ts       # E8/E9
└─ email-retry.service.ts             # outbox 재시도

src/app/api/
├─ bookings/[bookingId]/route.ts                         # E4 (PATCH) / E5 (PUT)
├─ payment-info/[token]/submit/route.ts                  # 정산 폼 제출 처리
├─ experiments/[experimentId]/payment-info/.../resend/   # E6' 수동 재발송
├─ cron/auto-complete-bookings/route.ts                  # E6 sweep
├─ cron/promotion-notifications/route.ts                 # E9 sweep (모집 마감 임박)
├─ cron/metadata-reminders/route.ts                      # E10
├─ cron/outbox-retry/route.ts                            # 모든 채널 재시도
├─ notifications/reminders/route.ts                      # E2/E3
└─ registration-requests/route.ts                        # E7

.github/workflows/
├─ reminders-cron.yml              # */15 * * * * → /api/notifications/reminders
├─ auto-complete-cron.yml          # 15 17 * * *  (= 02:15 KST 다음날) → auto-complete
├─ promotion-notifications-cron.yml # */30 * * * *
├─ metadata-reminders-cron.yml     # 0 0 * * 1   (월요일 00:00 UTC = 09:00 KST)
└─ outbox-retry-cron.yml           # 매 N분 outbox-retry

src/lib/branding.ts                # BRAND_NAME / BRAND_CONTACT_EMAIL + placeholder 가드
src/instrumentation.ts             # cold-start 시 env 검증
```

## 부록 B: env 설정

| 환경변수 | 용도 | 미설정 시 |
|---|---|---|
| `NEXT_PUBLIC_LAB_NAME` | 모든 메일 제목 prefix `[…]`, footer 워터마크, SMS prefix | prod cold-start 시 throw (`src/instrumentation.ts`) |
| `NEXT_PUBLIC_LAB_CONTACT_EMAIL` | 연구원 contact_email 미입력 시 fallback / E7·E9 의 `to:` | 메일 본문의 mailto 라인 자동 숨김 + E7·E9 발송 자체 skip |
| `NEXT_PUBLIC_LAB_SUBTITLE` | 페이지 헤더 부제목 | "연구실 실험 예약 시스템" |
| `NEXT_PUBLIC_LAB_PI` | 페이지 헤더 PI 표시 | 표시 안 함 |
| `NEXT_PUBLIC_LAB_INITIAL` | GCal 이벤트 제목 prefix | `BRAND_NAME` 의 첫 글자 대문자 |
| `LAB_APPROVAL_EMAIL` | E7 (가입 신청) 수신지 — 별도 inbox 두고 싶을 때 | `NEXT_PUBLIC_LAB_CONTACT_EMAIL` 로 fallback |
| `GMAIL_USER` / `GMAIL_APP_PASSWORD` | SMTP 발송 (앱 패스워드 권장) | 모든 이메일 발송 실패 |
| `SOLAPI_API_KEY` / `SOLAPI_API_SECRET` | SMS 발송 (선택) | 미설정 시 SMS 자동 skip — 메일만 발송 |
| `NEXT_PUBLIC_APP_URL` | 메일 안 링크의 절대 URL prefix | Vercel `VERCEL_URL` 으로 fallback |
| `PAYMENT_TOKEN_SECRET` | 정산 토큰 HMAC 서명 키 (32자 이상) | 정산 토큰 발급 실패 |
| `PAYMENT_INFO_KEY` | 주민등록번호 + 정산 토큰 plaintext 암호화 키 (32자 이상) | RRN/토큰 암호화 실패 |
| `CRON_SECRET` | GH Actions cron 이 라우트 호출 시 검증 헤더 | cron 401 |

env 변경 후에는 **재배포 필수** (Next.js 가 빌드 타임에 `NEXT_PUBLIC_*` 를 인라인하므로).

---

## 변경 이력 (요약)

본 문서가 정리하는 자동화 흐름은 다음 commit 묶음에서 정착되었습니다 (참고 — `git log` 로 확인):

- `0ee9084` — branding env 검증 + placeholder 누출 차단 (P0 #1)
- `75c04ad` — 취소·노쇼 메일 신설 (P0 #2)
- `cc2d540` — 일정 변경 메일 redesign + before→after SMS (P0 #3+#4)
- `7499a63` — `/run` 토큰 에러 화면에 mailto (P0 #5)
- `fe0a21a` — 정산 토큰 보존 (P0 #6, migration 00052)
- `7797509` — 정산 메일 자동 발송 (initial)
- `44cfefc` — 정산 폼 contact 필드 (이름·연락처·이메일)
- `57fe869` / `a723815` / `152a701` — UX 폴리시 (폰트, RRN 마스킹, 업로드 progress, 헤드라인 CTA)

세부 구현은 위 commit 들의 본문에 자세히 기록되어 있습니다.
