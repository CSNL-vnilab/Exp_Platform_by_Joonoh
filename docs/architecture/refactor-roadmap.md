# Refactor Roadmap

> 2026-05-29 — codex×3 정밀조사 + opus team×3 메타리뷰의 통합 결과.
> 5 phase, 우선순위는 "silent break risk" + "blast radius" 기준.

## 원칙

1. **Behavior preserving first.** 각 phase 는 외부 contract (API 응답, 발송 email shape, DB row 양식) 을 유지하면서 internal boundary 만 정리.
2. **Test-first when unclear.** 어떤 invariant 가 implicit 인지 모르겠으면 그 invariant 를 검증하는 e2e/integration test 부터.
3. **One subsystem per PR.** [`subsystems.md`](./subsystems.md) 의 10 개 boundary 가 PR 단위. 두 개 boundary 를 같이 건드리는 PR 은 거부.
4. **Concurrent-session-safe.** 진행 중인 session 이 건드리는 영역 (e.g. payment-claim) 은 그 session 끝난 후. [`../../AGENTS.md`](../../AGENTS.md) 의 "다른 session 영역 안 만짐" 룰.
5. **Migration-safe.** schema 변경은 항상 (a) old 컬럼 그대로 + new 컬럼 추가, (b) dual-write, (c) read 마이그레이션, (d) old 컬럼 제거 — 4 PR.

---

## Phase A — Stop the bleeding (1-2 weeks)

**Goal**: silent break 위험 큰 항목 + 누구나 즉시 이득 보는 cleanup.

### A1. 🔴 `mark_group_completed` gap 메우기 — hidden coupling #2

- **Where**: `src/app/api/experiments/[experimentId]/groups/[bookingGroupId]/mark-completed/route.ts:71-73`
- **Fix**: route 가 RPC return 후 `notifyPaymentInfoIfReady` 명시 호출.
- **Why**: 현재 정산 메일은 nightly `auto-complete-bookings` cron sweep 까지 24h 대기. 연구원은 즉시 갔다고 가정.
- **Test**: `mark_group_completed` 호출 → `payment_link_sent_at` 가 같은 request 안에 set 되어야 함.
- **Blast radius**: 한 route. Lock semantics 가 fan-in 4 → 5 으로 확장; lock 자체가 idempotent guarantee.
- **Conflict markers**: 다른 session 이 mark-completed route 안 건드리는지 git fetch 후 확인.

### A2. 🔴 partial-cancel 시 payment-info stuck — hidden coupling #25

- **Where**: `booking-edit/[token]/[bookingId]/cancel/route.ts:78-130`, `bookings/[bookingId]/route.ts:179-224`
- **Fix**: cancel 1 booking 후 group 의 모든 remaining booking 이 `completed` 면 `notifyPaymentInfoIfReady` 호출; 모두 `cancelled` 이면 `participant_payment_info` 자체를 `cancelled` 로 transition (status FSM 에 새 transition 추가).
- **Why**: 5 회차 중 1 cancel = forever pending. 연구원 수동 개입 필요.
- **Migration**: `participant_payment_info.status` enum 에 `cancelled` 추가 (00066).
- **Test**: 2-session group + 1 session cancel → notification fire; full cancel → row=cancelled.

### A3. 🔴 token-secret fallback chain 명시화 — hidden coupling #23

- **Where**: `booking-edit/token.ts:24-41` (+ analogous `payment-token.ts`, `run-token.ts`)
- **Fix**: 4-chain fallback 제거; 각 token 시스템이 자체 secret 만 사용. boot-time validator (`src/lib/auth/env-check.ts`) 가 누락된 secret 발견 시 startup throw — silent fallback 보다 명시 fail.
- **Why**: `SUPABASE_SERVICE_ROLE_KEY` rotation 이 모든 token (60-day TTL 포함) 을 즉사시키는 hidden coupling 제거.
- **Migration**: deploy 전 모든 secret 명시 set 확인 — `DEPLOY.md` 의 secret 리스트에 이미 있음.
- **Test**: env 에 secret 없으면 boot fail; rotation 한 secret 만 영향.

### A4. 🟡 Cloudflare 잔해 deletion 완료

- **Where**: working tree 의 `D open-next.config.ts`, `D proxy.ts`, `D wrangler.jsonc`, `D scripts/check-stream-state.mjs`, `D scripts/cleanup-db.mjs`, `D scripts/notion-demo.mjs`, `D scripts/calendar-parse-2026.mjs`, `D scripts/repair-backfilled-slab-rows.mjs`, `D scripts/check-loc.mjs`, `D scripts/check-schema.mjs`, `D scripts/check-live-data.mjs`, `D scripts/check-live-schema-cols.mjs`, `D scripts/purge-e2e-leftovers.mjs`
- **Action**: 다른 session 이 의도적으로 진행 중인 deletion 인지 확인. 진짜 deletion 이면 commit; in-progress refactor 의 일부면 그 session 끝날 때까지 대기.
- **Why**: `git status` noise 가 다른 변경의 review 를 늦춤. `DEPLOY.md` 에 이미 "참고용으로 남음" 명시.
- **Blast radius**: zero (이미 reference 없음).

### A5. 🟡 Outbox-retry 잔존 leak 정리 (scope 정정 2026-05-29)

> **Scope 정정**: 초기 roadmap 은 "booking_integrations vs outbox 두 테이블" 이라
> 잘못 기재. Codex Explore 정밀조사 (auto-loop iter 1) 결과 별도 "outbox" 테이블
> 존재 안 함 — `booking_integrations` 가 곧 outbox. 실제 잔존 cleanup 은
> 훨씬 작음.

- **Where**:
  - Legacy `claim_next_notion_retry()` RPC (00032) — hardcoded
    `WHERE integration_type IN ('notion', 'notion_survey')`
  - 일반화된 `claim_next_outbox_retry(p_types[])` (00037) 가 이미 모든
    integration_type 커버
  - 구 `/api/cron/notion-retry` endpoint (있다면) 가 legacy RPC 호출
- **Decision**: 일반화된 RPC 만 유지; legacy RPC + 구 endpoint 제거.
- **Why**: 두 RPC 가 동일 컬럼 (`booking_integrations.attempts`) 에 concurrent
  작업. cron 이 둘 다 발사하면 attempts double-bump 가능.
- **Migration**:
  1. GH Actions 에서 구 endpoint cron 이 disable 됐는지 확인
  2. endpoint 코드 삭제
  3. 다음 release 의 migration 에서 `DROP FUNCTION claim_next_notion_retry`
- **Blast radius**: 매우 작음 (legacy RPC 가 unused 면 zero).

### A6. 🟡 PII scrub centralize

- **Where**: 3+ `scrubPii` variant (notion, gcal, email-retry 별)
- **Fix**: `src/lib/observability/pii.ts` 단일 module — `scrubLastError(err: unknown): string` + `scrubPiiRow(row)`. 모든 `last_error` write 가 이 함수 통과.
- **Why**: hidden coupling #1 — error path 의 일부만 scrub 됐었음. 한 곳에서 patterns 유지.
- **Test**: golden tests with 한국 phone/email/RRN sample.

**Phase A 완료 기준:**
- 위 6 항목 PR merged.
- `mark_group_completed` + partial-cancel + token rotation 각각 e2e test 추가.
- 다음 phase 들이 reference 할 module skeleton (`src/lib/observability/pii.ts`) 존재.

---

## Phase B — Subsystem extraction (3-4 weeks)

**Goal**: [`subsystems.md`](./subsystems.md) 의 10 boundary 가 코드에서 실제 directory 로 reflect. Phase A 가 high-risk hot spot 해결했으므로 이제 평탄한 refactor.

### B1. `src/lib/notify/` — Notification dispatch & templates

- **Move in**: `services/booking-email-template.ts`, `services/booking-status-notify.service.ts`, `services/booking-edit-email.ts`, `services/email-retry.service.ts`, `services/booking-sms.service.ts`, `services/post-booking-sms.service.ts`, `services/payment-claim-email.ts`
- **Public API**: `notify.bookingConfirmed(group)`, `notify.statusChanged(booking, status)`, `notify.paymentInfo(group)`, `notify.paymentClaim(claim)`.
- **Internal**: gateway (gmail, solapi) 호출. `notify/` 외부에서 `gmail.ts` direct import 금지.
- **Why**: 5 entry → 4 path 의 fan-out 이 한 module 안. Caller 가 audit/template/dispatch 분리해 부르지 않음.
- **Blast radius**: 모든 PUT/POST route + cron 들. Pure rename + import 정리 위주.
- **Conflict**: in-flight 다른 session 이 `booking-email-template.ts` 건드리는지 확인 (현재 modified).

### B2. `src/lib/outbox/` — Outbox & retry kernel

- **Move in**: `services/notion-retry.service.ts`, `services/gcal-retry.service.ts`, `services/email-retry.service.ts`, retry RPC contract.
- **Public API**: `outbox.markPending(rowId, type)`, `outbox.runRetry(type, handler)`, `outbox.deadLetter(rowId, reason)`.
- **Why**: hidden coupling #17 — type 별 finalize semantics 가 갈라짐. 한 kernel + type-specific handler.
- **New requirement**: `attempts` 컬럼 update 가 RPC 만; application code 의 `markIntegration` 의 read-then-write race 제거 (#15).
- **Migration**: `markIntegration` 의 deprecation; tests on every retry handler.

### B3. `src/lib/payment-info/` — Payment information collection

- **Move in**: `services/payment-info-notify.service.ts`, `payments/backfill.ts`, `payment-info/*` route handlers' business logic (route 는 thin).
- **Public API**: `paymentInfo.notifyIfReady(groupId, opts)`, `paymentInfo.acceptSubmission(token, payload)`, `paymentInfo.openTouch(token)`.
- **Owned columns**: `participant_payment_info.*`.
- **Why**: hidden coupling #6, #7, #8 — single owner. Caller 4 (PUT bookings, observation, verify, resend) + 1 cron 가 같은 entry.
- **Test**: 4 concurrent caller → 1 email (lock invariant); rotate vs preserve token decision matrix.

### B4. `src/lib/auth/` consolidation

- **Move in**: `payment-token.ts`, `run-token.ts`, `booking-edit/token.ts`, `verify-session.ts`, `signed-fetch.ts`.
- **Public API**: `token.issue(kind, claims, ttl)`, `token.verify(kind, token)`, `session.startVerify(kind, identity)`, `session.checkVerify(kind, cookie)`.
- **Why**: 3-4 parallel HMAC system 의 boilerplate 통합. Hidden coupling #23 의 secret 명시화도 여기서.

### B4-light. requireExperimentAccess 헬퍼 — 진행 중 (auto-loop iter 7)

- **Where**: `src/lib/auth/experiment-access.ts` (신규).
- **What**: 15+ route 가 복사붙여넣기하던 admin/owner 게이트 (`getUser` → `experiments select` → `profiles role` → isOwner||isAdmin) 를 단일 `requireExperimentAccess(experimentId, { extraColumns? })` 로 통합. NextResponse 반환 시 caller 가 그대로 return, AccessContext 반환 시 supabase/admin/user/experiment/isOwner/isAdmin 분해해 사용.
- **POC migrated** (iter 7, commit `750a0eb`):
  - `experiments/[id]/payment-info/[gid]/mark-completed/route.ts`
  - `experiments/[id]/pilot-toggle/route.ts`
  - `experiments/[id]/manual-blocks/route.ts` (POST, with extraColumns: "google_calendar_id")
- **Iter 8 migrated**:
  - `experiments/[id]/offline-code/route.ts` (PUT + DELETE, **`ownerOnly: true`** — helper gained the option this iter)
  - `experiments/[id]/backfill-payment-info/route.ts`
  - `experiments/[id]/manual-blocks/[blockId]/route.ts` (DELETE, extraColumns: "google_calendar_id")
  - `experiments/[id]/data-export-csv/route.ts` (GET, extraColumns: "experiment_mode, title, project_name")
- **Iter 9 migrated**:
  - `experiments/[id]/data-export/route.ts` (GET, extraColumns: "experiment_mode")
  - `experiments/[id]/online-screeners/route.ts` (GET + PUT — also deleted local `requireResearcher()` helper that duplicated the same logic)
  - `experiments/[id]/status/route.ts` (POST, **`ownerOnly: true`** + extraColumns: "status, code_repo_url, data_path")
- **Iter 10 migrated**:
  - `experiments/[id]/route.ts` (PUT + DELETE, both **`ownerOnly: true`**; GET intentionally NOT migrated — it has a public-if-active path that the helper doesn't model)
  - `experiments/[id]/payment-claim/route.ts` (POST, extraColumns: "title" used for the Excel file name)
- **Iter 11 migrated**:
  - `experiments/[id]/payment-claim/[claimId]/email/route.ts` (369 lines) — kept the route's pre-existing local `loadAuthContext` function as a thin wrapper that calls `requireExperimentAccess` and enriches with the researcher's `display_name` + `contact_email` from `profiles` (needed for the email envelope). Callers (GET + POST) unchanged.
- **NOT migratable to `requireExperimentAccess`** (architecture boundary):
  - `experiments/route.ts` (collection) — GET is public-with-RLS, POST creates a new experiment (no existing row to gate against). The helper is for routes operating on an *existing* experiment.
  - `bookings/[id]/route.ts`, `bookings/[id]/observation/route.ts` — paths carry `bookingId`, not `experimentId`. Each route does a `bookings.select(*, experiments(created_by, ...))` join + ownership check. A sibling helper `requireBookingAccess(bookingId, { extraExperimentColumns?, extraBookingColumns? })` would land the same consolidation but is its own Phase B-medium effort (bookings/[id] is 532 lines and merges several lifecycle paths). Deferred.

**Cumulative B4-light** (iter 7-11): **13 routes migrated**, ~325 lines of duplicated auth-gate boilerplate removed, helper grew `ownerOnly` + `extraColumns` options. The remaining 5 candidate routes either don't fit the helper's "existing experiment" model (2) or need a sibling booking-scoped helper (3 routes / 759 total lines, Phase B-medium).

### B4-medium. requireBookingAccess 헬퍼 — 진행 중 (auto-loop iter 12)

- **Where**: `src/lib/auth/booking-access.ts` (신규 sibling helper).
- **What**: `requireBookingAccess(bookingId, { extraBookingColumns?, extraExperimentColumns?, ownerOnly? })` — resolves booking + joined experiment, runs the same admin/owner gate as `requireExperimentAccess`. Returns `{ user, admin, supabase, booking, experiment, isOwner, isAdmin }`. Wildcard `extraBookingColumns: "*"` supported for routes that need the full row.
- **Iter 12 migrated**:
  - `bookings/[bookingId]/route.ts` (GET — `extraBookingColumns: "*"`, ownerOnly; PUT — `extraBookingColumns: "status, google_event_id, booking_group_id"` + `extraExperimentColumns: "google_calendar_id"`, ownerOnly)
  - `bookings/[bookingId]/observation/route.ts` (GET — ownerOnly; PUT — `extraBookingColumns: "slot_start"`, ownerOnly)
- **Iter 13 migrated**:
  - `bookings/[bookingId]/route.ts` PATCH (reschedule, 200+ lines) — `owner-or-admin` (default), `extraBookingColumns: "status, slot_start, slot_end, session_number, booking_group_id, google_event_id"` + `extraExperimentColumns: "weekdays, max_participants_per_slot, google_calendar_id, status"`. The route body's reschedule pipeline (GCal patch, renumber, reminders RPC, propagate_payment_period RPC, email/SMS, cache invalidate) is unchanged — only the auth preamble swapped.
  - Cleaned up the file's now-unused `createClient` and `isValidUUID` imports — every method now goes through `requireBookingAccess` (which provides both internally).

**Cumulative B4-medium** (iter 12-13): **5 methods migrated** (GET + PUT + PATCH on bookings/[id]; GET + PUT on observation), ~110 lines of duplicated auth-gate boilerplate removed. Booking auth surface now fully consolidated — no remaining inline `bookings.select(..., experiments(created_by, ...))` ownership checks in production routes.

**Iter 16 cleanup**: PUT /bookings/[id] had three inline `createAdminClient()` calls in its cancel/notify/payment-info fan-out (lines 155, 189, 226 pre-cleanup) — leftovers from before the helper landed. Each was independently spawning a service-role client when one was already available via `access.admin`. Deduped to a single client per request (also dropped the now-unused `createAdminClient` import). Behavioural no-op — `createAdminClient()` is a thin factory, but having one shared instance makes the data flow easier to follow and matches the pattern PATCH already uses.
- **Behavior change**: 일부 route 가 한국어 에러 메시지 ("실험을 찾을 수 없습니다") 를 영어 ("Experiment not found") 로 표준화. UI 가 이 메시지를 i18n 으로 처리한다면 다음 phase 에서 헬퍼에 message override 옵션 추가.
- **Blast radius**: 각 route 당 ~20 lines 제거, 1 helper 호출 추가. 동작 동일.

### B5. `src/lib/calendar/` — Calendar gateway

- **Move in**: `google/calendar.ts`, `google/slab-calendar.ts`, `services/freebusy-cache.ts`, GCal retry logic.
- **Public API**: `calendar.createEvent(spec)`, `calendar.deleteEvent(eventId)`, `calendar.busyCheck(window)`, `calendar.invalidate(window)`.
- **Forbidden outside**: direct `googleapis` import.
- **Migration**: 9 caller of `invalidateCalendarCache` → 모두 새 API.
- **New cron**: GCal orphan-event reaper (#3, #14 — currently "doesn't exist yet").

### B6. `src/lib/notion/` — Notion mirror

- **Move in**: `notion/*`, `notion-retry.service.ts`, observation Notion sync helper.
- **Public API**: best-effort projection. `notion.mirrorBooking(id)`, `notion.mirrorObservation(id)`.
- **Decision**: hidden coupling #28 (observation page 의 booking-page-id fallback) 을 두 phase 로 처리 — 지금 명시 contract, 이후 schema 단순화.

### B7. Shared HTTP helpers — `src/lib/http/`

- **Move in**: `utils/origin.ts` (APP_ORIGIN helper, hidden coupling #22), `utils/rate-limit.ts`, route-level `requireAuth`.
- **Why**: per-Lambda singleton 인 buckets Map (#21) 의 KV-backed replacement (or 명시적 "best-effort per-instance" 명세) 결정. Phase A 에서 fix 안 하고 명시화만.

### B8. KST date helpers

- **Where**: `utils/kst-date.ts` (이미 부분 존재). 누락된 utility 추가.
- **Why**: `bookings.slot_start` 가 timestamptz 인데 SMS/email 의 "오후 2시" 표시가 KST 보장 — UTC 직접 만지는 caller 가 silent break 위험.

**Phase B 완료 기준:**
- 위 모든 directory 가 존재; 각 directory 에 `README.md` (contract).
- ESLint rule `no-restricted-imports`: `googleapis` 는 calendar 안에만, `@notionhq/client` 는 notion 안에만, `nodemailer` 는 notify 안에만.
- Top-level route handler 는 thin (parse → call subsystem → respond) 으로 reduce.

---

## Phase C — Online runtime separation (4-6 weeks)

**Goal**: `src/app/online/` (TimeExpOnline1 등 web 실험 runtime) 을 별 subsystem 으로 추출.

### C1. `online/` subsystem boundary

- **Move in**: `src/app/(public)/run/[token]/*` 의 experiment runtime (paradigm-specific harness, MATLAB-port glue).
- **Public API**: `online.startSession(runToken)`, `online.recordTrial(sessionId, payload)`, `online.finalize(sessionId)`.
- **Why**: 현재 lab-reservation main loop 과 online runtime 이 같은 `src/app/(public)/` 에 mix. 도메인 다름.
- **Conflict warning**: TimeExpOnline 작업이 active. 그 작업과 sync 필요.

### C2. `outbox` table drop (phase A5 의 dual-write 끝)

- **Migration**: `DROP TABLE outbox`.
- **Why**: 두 mechanism → 하나. Phase A5 의 deprecation 완료 조건.

### C3. `events_log` append-only table

- **Schema**: `events_log(id, ts, actor, kind, subject_type, subject_id, payload)`.
- **Why**: 현재 audit row 는 mutation (`booking_integrations.status='completed'`) — observation 4-5 trigger fire 가 시간순으로 reconstruct 안 됨. Append-only 가 무엇이 발사됐는지 정확.
- **Backfill**: 안 함 (forward-only).
- **Caller**: 모든 subsystem 의 boundary 가 publish.

### C4. Migration ordering 명시화

- **Where**: `supabase/migrations/`.
- **Fix**: 각 migration header 에 `Depends-On:` 명시 (e.g. `00065_amount_override_workflow.sql` 는 `00063_payments` 의존). CI lint 가 violation 시 fail.
- **Why**: 현재 number-only ordering 이 다른 session 의 PR 와 collide (00063 충돌 사례 있었음).

---

## Phase D — Observability (ongoing)

**Goal**: silent failure 감지.

### D1. Cron failure → Slack incoming webhook

- **Where**: GitHub Actions `.github/workflows/*-cron.yml`. `if: failure()` step 추가.
- **Why**: `docs/cron-runbook.md` 의 §5 가 "현재 미설정" — operator 가 cron silence 가 정상인지 fail 인지 모름.
- **Effort**: 30 분.

### D2. SMTP queue depth gauge

- **Where**: `outbox` (B2 이후 `booking_integrations`) 의 pending count + oldest age.
- **Surface**: `/api/health/queue` JSON; cron 이 threshold 넘으면 Slack alert.

### D3. PII redaction test fixture

- **Where**: golden tests for `scrubPii*` — 한국 phone/email/RRN sample.
- **Why**: phase A6 의 module 이 regression 없게.

### D4. Payment-info dispatch trace

- **Where**: each `notifyPaymentInfoIfReady` call 의 input/output 을 `events_log` (phase C3) 에 publish — caller, freshRow snapshot, decision (sent/skipped reason), token rotation.
- **Why**: race 디버깅이 현재 `git log` + DB snapshot 으로만. Reproducible trace.

---

## Phase E — Scale escape (필요 시)

**Goal**: Hobby tier 의 cap (2 cron) + per-Lambda singleton 의 limit 이 실제 bottleneck 되면.

### E1. Vercel Pro → unify GH Actions + Vercel Cron

- 9 cron 모두 Vercel Cron 로; GH Actions 폐기.
- **Why**: 현재 두 platform 운영이 cognitive overhead. Hobby cap 만 아니면 한 platform.

### E2. KV-backed rate limit

- `rate-limit.ts:40` 의 in-memory `buckets` Map 을 Vercel KV (or Supabase) backed 으로.
- **Why**: hidden coupling #21 — per-Lambda 가 real cap 을 instance count 만큼 multiply.

### E3. Supabase pooling

- 현재 service-role client 가 cold start 마다 새 connection. PgBouncer 또는 Supabase pooled connection 으로.

---

## Conflict map (다른 session 와의 boundary)

각 phase 의 PR 가 건드릴 영역을 다른 session 의 in-flight 와 cross check 필요:

| Phase | Touch area | 잠재 충돌 |
|---|---|---|
| A1 | `mark-completed/route.ts` | 낮음 |
| A2 | `booking-edit/[token]/[bookingId]/cancel/route.ts`, FSM migration | booking-edit feature 진행 중인 session |
| A3 | `lib/auth/*`, `DEPLOY.md` | secret rotation 작업 중인 session |
| A4 | working tree deletion | Cloudflare cleanup session |
| A5 | `outbox` 테이블 schema | retry 작업 중인 session |
| A6 | `scrubPii` callers (multiple files) | last_error format 의존 session |
| B1 | `src/lib/services/booking-email-template.ts` (현재 modified) | 활성 session |
| B3 | `src/lib/services/payment-info-notify.service.ts` (현재 modified) | 활성 session |
| B5 | `src/lib/google/gmail.ts` (현재 modified) | 활성 session |
| C1 | `src/app/(public)/booking-edit/` (현재 untracked) | booking-edit session |

**Rule**: 각 phase 시작 전 `git fetch && git log HEAD..origin/main -- <touch area>` 로 그 영역의 다른 session 활동 확인. Active 면 stash until done.

---

## Effort estimate (1 person, dedicated time)

| Phase | Effort | Risk |
|---|---|---|
| A | 1-2 weeks | medium (live system 의 hot path) |
| B | 3-4 weeks | low-medium (mechanical move) |
| C | 4-6 weeks | medium (TimeExpOnline coord) |
| D | rolling | low |
| E | 1-2 weeks | low (when needed) |

**Total**: ~10 weeks to "specialized system" state.

---

## "Don't do" 목록

다음은 의도적으로 refactor 범위 밖:

- **`bookings_recompute_class` trigger 제거**: hidden coupling #4 — trigger 가 advisory-lock 으로 한 종류의 contention 해결. 새 application-level coordination 필요한데 가치 대비 risk 큼.
- **`book_slot` RPC 의 advisory lock 제거**: 마찬가지로 slot contention 의 currently-working solution.
- **multi-session group email dedup logic 단순화 (#29)**: special-case 가 정확한 곳에 있음. 추출 안 함.
- **Migration 번호 reset**: 다음 PR 와의 collision 위험 + git blame 손실.
- **Per-session class enum 의 8 가지 type 통합**: domain 정확성 우선.

---

## 성공 측정

| 지표 | Before | Target (after phase B) |
|---|---|---|
| "이 route 가 호출하면 무슨 일?" 답하는 데 걸리는 시간 | 30 분 (4-5 file 읽기) | 5 분 (subsystem README) |
| `mark_group_completed` 후 payment email 도착 시간 | 0~24h | < 30 s |
| Token rotation operator 부담 | "전부 다시 발급" 가능성 | 명시 fail-fast |
| `last_error` 의 PII 유출 risk | 일부 path 에서 가능 | 0 (golden test) |
| 새 cron 추가 시간 | 1-2 시간 (cron-runbook 학습) | 30 분 (template) |
| Cloudflare deletion noise | git status 12 줄 | 0 |
