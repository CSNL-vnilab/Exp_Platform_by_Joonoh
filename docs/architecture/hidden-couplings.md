# Hidden Couplings Catalog

> 2026-05-29 — Opus Hidden Coupling Auditor + Codex Booking/Payment 정밀조사 통합.
> "name 이 효과를 advertise 안 하는" 곳, "spaghetti junction", "naïve refactor 가 silently break 시키는" 곳.

## 분류

- 🔴 **CRITICAL** — 협조 없이 refactor 시 silent break
- 🟡 **MEDIUM** — careful migration 으로 manageable
- 🟢 **LOW** — cosmetic, 안전 extract

---

## 1. Booking 완료 fan-out cluster

### #1 🟡 PUT /api/bookings/[bookingId] 가 silent SMTP+SMS+payment-info fanout (부분 해결)

- **Where**: `src/app/api/bookings/[bookingId]/route.ts:179-224`
- **What**: `cancelled`/`no_show` 으로 status PUT 하면 `notifyBookingStatusChange` (참여자 email + SMS + audit) 호출; `completed` 면 `notifyPaymentInfoIfReady` (정산 메일 가능).
- **Caller view**: "status 만 바꾼다." Reader view: SMTP send, Solapi send, 2 booking_integrations audit row, 별도 참여자 email.
- **Failure**: SMTP fail 은 swallow; DB 는 `cancelled` 이지만 참여자 모름. PII 가 `last_error` 로 누설 (일부 path 만 scrub).
- **Partial fix (Phase A iter 0 + iter 3, 2026-05-29)**: PII 누설 부분은 A6 의 `@/lib/observability/pii` 중앙 helper 로 전 경로 통일됨. fan-out 자체는 outcome logging (iter 3: 구조화된 `[StatusNotify]`/`[PaymentInfoNotify]` info-level grep-able 로그) 으로 추적 가능. fan-out 의 동적 dispatch 자체는 여전히 silent — 완전 해결은 `notify/` subsystem 추출 (Phase B B1) 필요.

### #2 ✅ `mark_group_completed` RPC bypasses notifyPaymentInfoIfReady — 최대 24h silent delay

- **Where**: `migrations/00055:101-143`; `mark-completed/route.ts:71-73`
- **What**: 한 클릭으로 group 의 모든 booking 완료시키지만 route 가 즉시 return. PUT 와 observation 과 달리 `notifyPaymentInfoIfReady` 안 fire. 정산 메일은 nightly `auto-complete-bookings` cron 의 다음 sweep 까지 대기.
- **Caller view**: "completed mark 했으니 참여자에게 link 갈 것." 실제: 24h 까지 silent delay.
- **Fix (Phase A1, commit `595e933`)**: mark-completed/route.ts 가 RPC 후 `notifyPaymentInfoIfReady(admin, bookingGroupId)` 즉시 호출. lock 으로 idempotent — 다른 path 가 같은 group 에 fire 해도 no-op. silent 24h delay → <30s.

### #3 🟡 Blacklist cascade 가 bookings + GCal 을 silent 변형 + 알림 없음 (GCal orphan side 부분 해결)

- **Where**: `participants/[participantId]/class/route.ts:186-241`
- **What**: class 를 `blacklist` 로 set → 모든 future confirmed/running booking cancel, GCal event delete, 그러나 `notifyBookingStatusChange` 의도적으로 skip.
- **Reader view**: 연구원이 자기 캘린더에서 참여자 사라진 것 모름; 참여자도 모름; payment_info row 가 stuck (한 booking 이 cancelled 이라 "not all completed" 가 forever block).
- **Partial fix (iter 18 + iter 20, 2026-05-30)**: payment_info 정체 부분은 #25 ✅ 의 `'cancelled'` enum + `all_cancelled` outcome 으로 해결됨 — blacklist 가 그룹의 모든 booking 을 cancel 하면 payment_info 가 자동으로 `cancelled` 로 transition. GCal orphan 누적 부분은 새 `/api/cron/gcal-orphan-reaper` 가 sweep — blacklist cascade 가 deleteEvent 를 skip 해도 reaper 가 catch-up. **남은 문제**: notification 자체 (참여자/연구자 알림). Phase B B1 의 notify subsystem 추출에서 처리.

### #4 🟡 `bookings_recompute_class` trigger 가 모든 status='completed' transition 에 arbitrary class recompute 발사

- **Where**: `migrations/00025:282-309`
- **What**: `AFTER UPDATE OF status` 가 `recompute_participant_class` 호출 → 참여자 Royal 으로 flip + `class_promotion_audit` row 작성 → promotion cron 이 나중에 메일 발송.
- **Caller view (mark_group_completed)**: 5 booking flip → 5 trigger 호출 (advisory lock 각각) → 시간/일 후 cron 에 의해 메일 발송. Sender 가 UPDATE 가 이메일 trigger 했음 모름.

### #5 🟡 `recompute_participant_class` advisory-lock contention non-obvious

- **Where**: `migrations/00028, 00029`
- **What**: 같은 참여자의 multiple status update 가 advisory lock 에 serialize. `assign_participant_class_manual` RPC 도 같은 lock. 긴 blacklist cascade 가 auto-recompute 를 starve 시킴.

---

## 2. Payment-info dispatch race / 4-way fan-in cluster

### #6 🟡 `notifyPaymentInfoIfReady` 의 4 entry + 1 sweep — lock 만이 safety (이전 검토 후 lock + outcome logging)

- **Where**: `payment-info-notify.service.ts:97-434`; callers `bookings/[id]:208`, `observation:211`, `verify:149`, `resend:102`, `cron auto-complete:55`, `mark-completed:101` (A1, 2026-05-29)
- **What**: `payment_link_dispatch_lock_until` lease 없으면 같은 group 이 4 path race → 같은 email 이 4 token (preserve vs rotate) 으로 발송.
- **Failure**: 미래 contributor 가 lock 제거 or 5번째 caller 가 lock 안 잡으면 multi-send 복귀.
- **Mitigations (Phase A + iter 3, 2026-05-29)**: (a) Phase A 의 C6/C7/C8/C9 fix 로 atomic lock+sent_at reset + post-lock re-fetch — lock 자체의 race window 좁아짐. (b) iter 3 의 structured outcome logging (`[PaymentInfoNotify] ${outcome} ${groupId}`) 으로 race 디버깅 grep-able. (c) A2 (#25 fix) 후 5번째 caller (mark-completed) 도 lock 채택 — 6 entry 모두 lock 통과. 구조적 해결 (notify subsystem 추출) 은 Phase B B3 에서.

### #7 🟡 `payment_link_first_opened_at` 가 hidden control variable for token rotation

- **Where**: write at `payment-info/[token]/touch/route.ts` (real-browser mount); read at `payment-info-notify.service.ts:254`
- **What**: 네트워크-side action (browser POST) 으로 trip 되는 column 이 server-side decision (rotate vs preserve) 제어. Writer fire 시 reader behavior 가 silent 변경.
- **Failure**: JS-executing email preview bot 이 `/touch` hit → flag trip → 다음 dispatch 가 old token preserve.

### #8 🔴 `token_cipher/iv/tag/key_version` quadruplet 가 `token_hash` 와 lock-step write 필수

- **Where**: `payment-info-notify.service.ts:283-319`, `backfill.ts:138-155`, `booking.service.ts:208-252`, `payment-info-notify.service.ts:307-319`
- **What**: 4 컬럼 + 1 hash 가 같은 plaintext encode. 단일 writer 가 하나 update + 나머지 omit → page 가 INVALID (hash != cipher decrypt).

### #9 🟡 `participant_payment_info` 의 두 writer (`runPostBookingPipeline` + `backfillPaymentInfoForExperiment`) 가 `period_start/end` 를 다르게 derive

- **Where**: `booking.service.ts:198-273` vs `payments/backfill.ts:119-165`
- **What**: backfill 은 period 에서 cancelled row 제외; seed 는 모든 row 사용. 부분 cancelled group 이 backfill 시 subtle drift.

---

## 3. Reschedule / renumber chain cluster

### #10 🟡 `renumberSessionsInGroup` 가 SMS template / email template / payment Excel 의 implicit precondition

- **Where**: `booking.service.ts:970-1002`. Used at PATCH `bookings/[id]:443`, `booking-edit/reschedule:273`
- **What**: row.session_number rewrite. Reschedule 후 email 의 "회차" label, payment_info period_start, Excel ordering 이 의존.

### #11 🟡 `runReschedulePipeline` 가 `reschedule_reminders` + `propagate_payment_period` RPC 를 OTHER WORK 전 호출 — undocumented ordering

- **Where**: `booking.service.ts:709-769`
- **What**: RPC 가 email send 전 실행되어야 email 의 "기간" 라인이 새 date 반영. Comment 가 "P0-Γ" 라 표시. 이 RPC 가 옮겨지면 email 이 stale data 사용.

### #12 🟡 `createReschedGCalEvent` MUST run before bookings.update; DB-failure 시 orphan event 의 cleanup path 없음 (reaper 추가)

- **Where**: PATCH `bookings/[id]:391-434`
- **Failure**: Long-tail orphan event on shared calendar; busy-check 가 다른 참여자에게 spurious conflict.
- **Partial fix (iter 20, 2026-05-30)**: cleanup path 가 신설됨 — `/api/cron/gcal-orphan-reaper` 가 status='cancelled'/'no_show' + google_event_id 존재 row 를 6h 마다 sweep. reschedule 의 race window (create-then-DB-update 사이 DB 실패) 자체는 여전히 가능하지만 long-tail 누적은 막힘. **남은 문제**: ordering 자체 (create-before-update) 의 전체 atomic 화 — 작은 가능성이지만 race 자체 제거하려면 trigger-based 접근 필요.

---

## 4. Cross-area writes through shared columns

### #13 🟡 `bookings.notion_page_id` 가 3 path (post-booking, notion-retry, observation) 별로 race guard 가 다름

- **Where**: `booking.service.ts:483`, `notion-retry.service.ts:182-186` (CAS via `.is("notion_page_id", null)`), `observation.service.ts:176-182` (booking_observations.notion_page_id 만, bookings 아님)
- **What**: Notion sync target 이 2 컬럼으로 split. `syncObservationToNotion` 가 `bookings.notion_page_id` 로 fallback → observation sync 가 booking-page creation 성공에 silent depend.

### #14 🟡 `bookings.google_event_id` 가 4 writer + 3 clearer (reconciler 추가)

- **Writers**: `booking.service.ts:384` (initial), `:814` (reschedule-legacy), `gcal-retry.service.ts:165` (CAS-guarded), `bookings/[id] PATCH:419` (reschedule new)
- **Clearers**: PUT cancel:159, booking-edit cancel:101, blacklist cascade:227, **`/api/cron/gcal-orphan-reaper`** (iter 20)
- **What**: 일부 clearer (PUT cancel) 가 rest of pipeline skip; 다른 (blacklist) 가 `markIntegration` 우회. "event_id null" 이 cancel / never had / GCal down 어느 것인지 reader 구분 불가.
- **Partial fix (iter 20, 2026-05-30)**: 5번째 clearer (orphan-reaper) 가 doc 의 "Key takeaways for refactor" 섹션에서 명시한 `Missing cron: GCal orphan-event reaper` 를 충족. status=terminal + event_id non-null 인 row 가 누적되지 않음. **남은 문제**: writer-clearer semantic divergence 자체 (왜 5 시스템 이 같은 컬럼 만지는지) — Phase B B5 calendar gateway 추출 때 단일 owner 화.

### #15 🟡 `booking_integrations` upsert behavior 가 seed (`ignoreDuplicates: true`) vs `markIntegration` (`update`) 으로 변경

- **Where**: `booking.service.ts:285-288` vs `:307-318`
- **What**: `seedIntegrationRows` 가 duplicate ignore (re-run 이 `attempts` bump 안 함); `markIntegration` 이 read-then-write (race — 2 concurrent attempt 가 `attempts=N` 읽고 둘 다 `N+1` write).

---

## 5. Cron-as-glue

### #16 🔴 `/api/cron/auto-complete-bookings` 가 `mark_group_completed → email` gap 의 유일 retry path

- **Where**: `auto-complete-bookings/route.ts:54-66`
- **What**: `sweepPaymentInfoNotifications` 호출 — synchronous path 가 miss 한 payment email dispatch. Cron paused 시 모든 `mark_group_completed` group + 모든 failed attempt 가 pending forever.

### #17 🟡 `/api/cron/outbox-retry` 가 email/sms/notion/gcal failure 의 유일 catch-up

- **What**: 4 retry service dispatch by integration_type. RPC allowlist 확장; runner 에 "fall-through finalize" for unknown types — 그러나 새 integration_type 추가하면서 service handler 빼먹으면 모든 row 가 `unknown_integration_type:X` 로 finalize failed.

### #18 🟡 `/api/cron/promotion-notifications` 가 trigger 가 silent 작성한 class-promotion-audit row read

- **Where**: `promotion-notifications/route.ts` + trigger from 00025
- **What**: 연구원 A 가 booking 을 completed mark 하면 모르는 사이에 연구원 B (참여자의 lab owner) 가 Royal-promotion 메일 받음. Cross-researcher information leak.

### #19 🟡 Reminders cron 이 `reschedule_reminders` RPC 에 implicit depend — `reminders.scheduled_at` honest 유지

- **Where**: `reminder.service.ts` reads `reminders.scheduled_at`; `reschedule_reminders` (only via `runReschedulePipeline`) 가 update
- **What**: 미래 reschedule path 가 `runReschedulePipeline` bypass 하면 reminders 가 old time 에 발사.

---

## 6. In-memory / module-level state

### #20 🟡 `calendar_freebusy_cache` table 이 booking page render 가 read; 9 call site 가 invalidate

- **Where**: 모든 `invalidateCalendarCache` caller
- **What**: invalidation site 한 곳 miss = public booking page 가 5 분 stale availability 보임. invalidation 이 `.catch(() => {})` 로 silent drop.

### #21 🟡 In-memory rate-limit `buckets` Map 이 per-Lambda-instance (가시화)

- **Where**: `utils/rate-limit.ts:40`
- **What**: `payment-submit-ip`, `payment-submit-token`, `payment-touch-*` 가 모두 여기. Vercel 의 multiple warm Lambda instance 가 count split → real cap = cap × instance_count.
- **Partial fix (iter 35, 2026-06-01)**: 구조적 해결은 Phase E2 의 KV-backed migration 이지만, 그 사이의 운영 가시성 추가. `rateLimit()` 첫 호출 시 process 당 1회 `[rate-limit] per-Lambda in-memory bucket (pid=…) — hidden-couplings #21` 경고 로그. 운영자는 Vercel 로그에서 distinct pid 수를 세어 실제 cap multiplier 추정 가능. `getRateLimitDiagnostics()` 도 export — 향후 `/api/health/rate-limit` 에서 instance 별 bucket 수 snapshot 노출 가능.

### #22 🟡 `nodemailer.transporter` 가 module-level singleton

- **Where**: `gmail.ts:3-11`
- **What**: 모듈 init 때 env 읽음. Credential rotation 이 Lambda cold-start 필요. Caller 가 invalidate 방법 없음.
- **Note**: 별도로 `APP_ORIGIN const cached at module load` 라는 동일한 패턴의 다른 module-cache 가 booking-status-notify.service.ts:46-49 에 있었음 — 그건 B7-light (iter 1, commit `acca07a`) 에서 `getAppOrigin()` per-call helper 로 해결됨. `nodemailer.transporter` 는 미해결.

---

## 7. Booking-edit token chain

### #23 ✅ `issueBookingEditToken` 가 4 fallback secret chain — partial rotation 시 silent

- **Where**: `booking-edit/token.ts:24-41`
- **What**: `BOOKING_EDIT_TOKEN_SECRET → PAYMENT_TOKEN_SECRET → RUN_TOKEN_SECRET → REGISTRATION_SECRET → SUPABASE_SERVICE_ROLE_KEY`. `SUPABASE_SERVICE_ROLE_KEY` rotate 했지만 token secret rotate 안 했으면, 발급된 모든 booking-edit token 이 instantly invalid (HMAC key 가 fallback through 했음). 60일 TTL 가짐.
- **Severity**: 🔴 (operational).
- **Fix (Phase A3 + iter 1, commits `595e933`/`acca07a`)**: 5 token 모듈 (payments/booking-edit token/booking-edit session/run-token/symmetric) 모두 새 `src/lib/auth/secret-source.ts` 의 `resolveSecret({ primary, fallbacks, purpose })` 사용. `SUPABASE_SERVICE_ROLE_KEY` fall-through 시 process 당 1 회 warn 로그 + audit endpoint `/api/health/secret-audit` 가 anyFellThroughToServiceRole 보고. DEPLOY.md 에 rotation 주의 표 추가. fall-through 자체는 backward-compat 으로 유지 (deploy 무중단), audit 으로 가시화.

### #24 🟡 Booking-edit reschedule route 가 `renumberSessionsInGroup` + `runReschedulePipeline` 을 silent reuse

- **Where**: `booking-edit/[token]/[bookingId]/reschedule/route.ts:264-290`
- **What**: 참여자 한 클릭이 (a) GCal create, (b) DB update, (c) renumber every sibling, (d) `reschedule_reminders` RPC, (e) `propagate_payment_period` RPC, (f) email send, (g) SMS send, (h) cache invalidate. Unauthenticated (token-auth) endpoint 에 heavy fan-out.

### #25 ✅ Participant cancel route 가 payment-info logic bypass — payment_info row 가 stay

- **Where**: `booking-edit/[token]/[bookingId]/cancel/route.ts:78-130`
- **What**: Multi-session group 의 한 booking cancel = payment_info row stays pending; `notifyPaymentInfoIfReady` 가 forever 거부 ("not all completed" — 하나가 cancelled). Silent payment-stuck state.
- **Fix (Phase A2, commit `595e933`)**: 3 단계. (a) migration 00066 — `payment_status` enum 에 `'cancelled'` 추가. (b) `notifyPaymentInfoIfReady` 의 "all completed" gate 가 cancelled bookings 를 terminal-non-blocking 으로 취급. 모든 booking 이 cancelled 면 payment_info row 를 `'cancelled'` 로 transition + short-circuit (`outcome: "all_cancelled"`). (c) admin PUT + booking-edit cancel route 가 status='cancelled' 시에도 notify fire. partial-cancel group 의 나머지가 completed 면 즉시 dispatch, 전 cancel 이면 row 가 queue 에서 자동 퇴장.

---

## 8. Auth / ownership ordering

### #26 🟡 `/api/payment-info/[token]/submit` 가 Storage 에 upload 후 CAS update — race 시 orphan blob

- **Where**: `payment-info/[token]/submit/route.ts:342-417`
- **What**: signature + bankbook upload; 그 후 CAS `update … where status='pending_participant'`. CAS race 패배 (concurrent submit) → 2 Storage blob orphan. Comment: "harmless, later cron will purge" — 그런 cron 없음.

### #27 🟡 Observation PUT 가 `submit_booking_observation` RPC → trigger flip → trigger fire recompute → 그러나 route 도 `envelope.auto_completed` 따라 `notifyPaymentInfoIfReady` 호출

- **Where**: `bookings/[bookingId]/observation/route.ts:184-219`
- **What**: 3 layer (RPC, trigger, application) 가 각각 side effect. `envelope.auto_completed` true 인데 trigger 가 안 flip (concurrent observer 가 먼저) 했으면, route 가 already-completed group 에 `notifyPaymentInfoIfReady` fire — lock + sent_at 가 handle 하지만 layered logic 가 fragile.

---

## 9. Misc

### #28 ✅ `syncObservationToNotion` 가 `bookings.notion_page_id` 로 fallback — observation sync 가 booking-page creation order 에 couple

- **Where**: `observation.service.ts:154-158` (resolved 2026-05-30, auto-loop iter 18)
- **What (original)**: Runtime pipeline 의 Notion creation 실패 + observation arrival 이 outbox retry 성공 전에 = observation page standalone created (Notion 에 2 page: booking-not-yet + observation). Later booking-page retry 성공 시 merge 없음.
- **Fix (iter 18)**: `existingPageId === null` (둘 다 없음) 일 때 standalone page 생성 제거. 명시적으로 `mark({ status: 'failed', last_error: 'booking-page sync pending — observation deferred…' })` + `return { ok: false, deferred: true }`. outbox-retry cron 이 다음 sweep 에서 재시도 → booking-page 가 그때 존재하면 normal PATCH path 로 들어감. 2 page 분기 race 제거. `upsertObservationPage` 의 standalone-create fallback 은 defensive 로 남김 (다른 caller 가 null 전달 가능성).

### #29 🟡 `runEmail` (initial confirmation) 이 `rows` 의 모든 row 를 같은 결과로 mark

- **Where**: `booking.service.ts:587-599`
- **What**: Multi-session group 이 ONE email 발송; failure 시 N integration row 모두 stamped failed. Email-retry 가 special-cased dedup (`email-retry.service.ts:108-134`) — pipeline 이 이 invariant 를 silent 유지.

### #30 🟡 `scheduled_at` vs slot_start drift in reminders 가 test 로 enforce 안 됨 — `reschedule_reminders` 만 alignment 유지

- **Where**: `00054_reschedule_propagation.sql`
- **What**: future code path 가 `runReschedulePipeline` skip 하면 booking 이 move 됐어도 reminders 안 align. DB constraint 없음.

---

## Coupling clusters (요약)

**A. "Booking → completed → 5 side effects"** (#1, #2, #4, #16, #18, #27): virtual module "BookingCompletionFanout" 필요 — email send / payment-info dispatch / class recompute / audit row / promotion notification 소유. 현재 PUT route, observation, verify, mark-completed, auto-complete cron 에 흩어져 있음.

**B. "Payment-info row mutation"** (#6, #7, #8, #9, #25, #26): 4 writer + 4 trigger path + 1 stuck state. "PaymentInfoStateMachine" module 이 status transition 명시 소유.

**C. "GCal mutation"** (#3, #12, #14, #20): multiple writer + clearer; central reconciler 없음; orphan-event creation cleanup cron 없음.

**D. "Notion mirror"** (#13, #17, #28): 2 parallel mirror column + 3 entry point + "fall-through" page-id resolution.

**E. "HMAC token chain"** (#23): 4 token system 이 `SUPABASE_SERVICE_ROLE_KEY` 로 fall through — single rotation 이 모든 token invalidate.

---

## Ordering dependencies (9 hard rules)

1. `createReschedGCalEvent` MUST run before `bookings.update` (PATCH /api/bookings)
2. `reschedule_reminders` + `propagate_payment_period` MUST run BEFORE email send in `runReschedulePipeline`
3. `seedRunTokens` MUST run before `runEmail` (email's /run link 가 빠짐)
4. `seedPaymentInfo` MUST run before `runEmail` (email's payment link 빠짐)
5. `backfillIdentityForBooking` SHOULD run before `runNotion` (Notion 공개 ID column blank — silent degradation)
6. Payment-info `token_cipher/iv/tag/key_version` MUST be written in same UPDATE as `token_hash` (#8)
7. Lock acquire in `notifyPaymentInfoIfReady` MUST happen before token mint/rotate
8. `claim_next_outbox_retry` RPC MUST be the only writer of `attempts` once a row is claimed. `runEmail`-on-retry violates this by relying on the cron's CAS pattern (#29)
9. `payment_info` row creation MUST precede `notifyPaymentInfoIfReady` — import script 가 pipeline skip 하면 backfill 필요

---

## Audit-row-vs-reality drift

- **`booking_integrations.status='completed'` for email but participant didn't receive.** `sendEmail` 이 Gmail acceptance 에서 success 반환, delivery 아님. Spam folder = "completed" in DB.
- **`booking.status='completed'` but `participant_payment_info.payment_link_sent_at` stuck NULL.** `mark_group_completed` 가 fire 됐는데 `notifyPaymentInfoIfReady` 안 호출 (#2), 또는 group 의 한 booking 이 cancelled (#25).
- **`bookings.google_event_id IS NULL` 이 무엇인지 모름**: never created (skipped), failed (retry pending), cancelled (cleared), blacklist-cleared (audit row 없음) 중 어느 것?
- **`participant_payment_info.payment_link_first_opened_at` 이 참여자 안 열어도 set** — JS-executing preview bot 이 `/touch` stamp.
- **`reminders.status='sent'` for cancelled booking** — `reminder.service.ts:98-104` 가 booking cancelled 시 sent stamp. Audit log says "we sent" — 안 보냄.
- **`booking_integrations.attempts` is approximate** — non-CAS read-then-write (#15) 가 concurrent retry undercount.
- **`payment_claims.booking_group_ids[]` 가 실제 `claimed_in` reference 와 diverge** during rollback window (`payment-claim/route.ts:175-184`).

---

## Cron-as-glue dependency 요약

각 cron 이 멈추면 silent-degrade 시키는 feature:

- `auto-complete-bookings` → 정산 메일 stuck pending; class promotion delayed
- `outbox-retry` → email/SMS/GCal/Notion confirmation 모든 failure stuck
- `promotion-notifications` → 연구원이 Royal promotion 학습 못 함; 다른 path 가 surface 안 함
- `metadata-reminders` → gentle nag 정지 (degrade 영향 적음)
- `notion-health` → schema-drift detection 정지
- `reminders` → 참여자 reminder 안 받음; cancelled booking 도 여기서 sent stamp (#19)

---

## Singleton / shared state 인벤토리

- **`nodemailer.transporter`** (`gmail.ts:3`) — env-bound at module init; rotation 이 cold start 필요
- **`rate-limit.buckets` Map** (`rate-limit.ts:40`) — per-Lambda; `cleanupHandle` 가 lazy module-level setInterval (warm instance 마다 1 개)
- **`booking-edit/token.ts:getKey()`** — pure function 이지만 모든 call 마다 env read; 5 env var 중 하나 change 시 key silently 변경
- **`calendar_freebusy_cache`** (DB-backed) — 5-min TTL; 9 invalidation site
- **`creatorInitial` derivation** 이 `booking.service.ts:324` (3-4 char, "???" fallback) 와 `gcal-retry.service.ts:40` (4 char) 가 다름. 같은 연구원에 대해 다른 initial 이 calendar 에 등장 가능 (first attempt 실패 + retry).
- **`APP_ORIGIN` constant** 이 `booking-status-notify.service.ts:46-49` 에서 module load 시 1번 compute — env var swap 안 들어옴
- **`MAX_AGE_MS = 60 days`** for booking-edit token — `EDIT_CUTOFF_HOURS=24` 가 BOTH cancel + reschedule route 에 duplicate. 2 상수가 3 곳에.

---

## Refactor risk matrix

| Coupling | Extract module | Add new caller | Rename/move | Delete one path |
|---|---|---|---|---|
| #1 status PUT fan-out | risky | risky | safe | risky |
| #2 mark_group_completed gap | safe | risky | safe | risky (silent break) |
| #3 blacklist cascade | safe | risky | safe | risky |
| #6 payment-info 4 entry points | risky (lock semantics) | risky | safe | safe (one path) |
| #7 first_opened_at flag | safe | risky | safe | risky (semantic change) |
| #8 token cipher quadruplet | risky | risky | risky | risky |
| #14 google_event_id 4 writers | safe | risky | safe | risky |
| #16 cron-as-glue | risky | safe | safe | risky |
| #23 token secret fallback chain | safe | safe | risky | risky (invalidates tokens) |
| #25 partial-cancel stuck payment | safe | safe | safe | risky |
| #26 storage-before-CAS | safe | safe | safe | safe |
| #29 multi-session email dedup | risky | risky | safe | safe |

---

## Key takeaways for refactor

- **Top priority (🔴):** #2, #25 (silent payment-stuck), #6 (lock 이 유일 safety), #8 (cipher-hash lockstep), #23 (token rotation), #1+#3 (silent SMTP/SMS), #16 (cron-as-glue for payment).
- **Missing module**: `BookingCompletionFanout` — 5 entry 모두 호출 → `mark_group_completed` gap 제거 + trigger-driven recompute 지식 중앙화.
- **Missing module**: `PaymentInfoStateMachine` — legal transition enumerate; 오늘 컬럼 write 위치로 inferred.
- **Missing cron**: GCal orphan-event reaper (code 에 "doesn't exist yet" 언급).
- **Missing cron**: Storage blob orphan reaper for upload-before-CAS race.
- **Schema invariant**: `booking_integrations.attempts` 는 application code 가 아닌 RPC 가 increment 해야 (현재 `markIntegration` 의 race-prone read-then-write).
- **Test gap**: `reminders.scheduled_at` 가 reschedule path 후 `bookings.slot_start` 와 alignment enforce 하는 test 없음.
