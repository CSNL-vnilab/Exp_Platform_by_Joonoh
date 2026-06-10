# 예약→완료→정보입력→청구 Flow — 블라인드 메타리뷰 검증기록

- 일시: 2026-06-10 (KST)
- 방법: 6-렌즈 블라인드 리뷰 (상태머신 / 지급디스패치 / 금액정합성 / 취소·변경 / 백필·임포트 / 크론·동시성) → 발견건별 반박-편향(adversarial) 독립 검증. 42 agents, ~3.5M tokens.
- 결과: confirmed 32 · refuted 1 · 미검증(검증자 rate-limit) 3
- 수정 커밋: 8822dd2 (migration 00070 prod 적용 포함)

## 슬라이스별 설계 평가 (design assessment)

### state-machine
The slice is concurrency-aware where it matters — book_slot's per-experiment advisory lock and the payment dispatch-lock are genuinely well-engineered, and most DB writers carry their own WHERE-status CAS — so the core is not naive. But the status state machine has no single source of truth: the only real transition table (VALID_TRANSITIONS) lives in one HTTP route, while six other writers (book_slot, mark_group_completed, auto_complete cron, submit_booking_observation, the /run verify route, and the blacklist cascade) each re-encode partial and divergent rules. The single biggest structural risk is that "every non-cancelled booking == completed" is the sole, hardcoded gate for payment readiness, yet the terminal 'no_show' and transient 'running' states are handled inconsistently across those writers and the gate — so real groups silently wedge into an unpayable, operator-invisible state with no recovery path through the app.

### payment-dispatch
The dispatch mechanics are genuinely sound: funneling every trigger through one function (notifyPaymentInfoIfReady) guarded by a DB-level optimistic lock delivers true exactly-once under the click+cron race — the lock UPDATE re-evaluates its `(lock IS NULL OR lock < now) [AND sent_at IS NULL]` predicate on the post-update tuple under READ COMMITTED, so only one caller proceeds, and the under-lock re-fetch of amount/status/auto_send/recipient (lines 448-536) closes the pre-lock TOCTOU. force-vs-auto_send semantics are also correct (force bypasses the opt-out at both gates). The single biggest structural risk is asymmetric terminal-state eligibility: `cancelled` was retrofitted as terminal-non-blocking (A2), but `no_show` and the blacklist cascade-cancel path were left out of that model, and the shared nightly sweep treats EVERY pending+unsent+amount>0+auto_send row as a send candidate regardless of provenance — so backfilled historical groups get mass-emailed and no_show/partial groups stall with no UI recovery. The send engine is solid; the eligibility/terminal-state model is where the holes are.

### money-correctness
The money slice is reasonably centralized at the data layer — `participant_payment_info.amount_krw` is the single disbursed figure and the SQL RPCs (`propagate_payment_period`, mark_group_completed) correctly scope live sessions with `status IN ('confirmed','running','completed')`. The single biggest structural risk is a split-brain between that DB layer and the document/export layer: session-status filtering is re-implemented ad hoc at every read site, and three separate export readers (claim-bundle `loadSessionsByBgId`, the individual-export route, the upload-form route) load `bookings` with NO status filter at all, so cancelled/no_show sessions silently leak into counts, dates, and per-session amounts. Compounding this, `amount_krw` is a write-once snapshot set to the full participation_fee and never reconciled against attended sessions — and the pro-rate reconciler that was actually written (`src/lib/payments/amount.ts`) is dead code, imported nowhere. Net effect: per-session and per-attendance correctness depends entirely on a researcher remembering to manually override, with no prompt and no guard at claim time.

### cancel-reschedule
This cancel/reschedule slice is thoughtfully built — HMAC token + name/phone identity cookie, a server-side 2h cutoff enforced on both cancel and reschedule (old slot AND new slot), pre-create-GCal-before-DB ordering, a dispatch lock that makes the payment email idempotent, and reschedule-propagation RPCs that rewrite reminders/period. The 2h cutoff, reminder voiding-on-cancel (via reminder.service's send-time status guard), and partial-cancel payment dispatch all work as intended on the happy path. The single biggest structural risk is that the reschedule and cancel UPDATE paths re-implement book_slot's invariants in application code but drop two things book_slot relies on: its `pg_try_advisory_xact_lock` serialization (so capacity is racy on reschedule, with no DB constraint as backstop) and its full eligibility gate set (experiment status + registration_deadline are not re-checked). A secondary structural gap is that the payment-readiness state machine special-cased 'cancelled' as terminal-non-blocking but left 'no_show' as a permanent dead-end, so a single terminal status that book_slot/observation can produce silently strands settlement.

### backfill-import
Mostly sound, with one structurally dangerous seam. The pieces the prompt worried about most are actually solid: the historical 5x amount bug is fixed AND regression-guarded (backfill.ts:136 uses flat `fee`; test-backfill-payment-info.mjs:99/101/103/171 assert `amount_krw === fee`, not `fee × sessions`), participant_payment_info has a real UNIQUE(booking_group_id) backstop (00024:72) so payment-row re-backfill is genuinely idempotent, and the live dispatch path is heavily concurrency-hardened (dispatch lock + force-reset + under-lock re-reads). The single biggest structural risk is that the import/backfill layer fabricates the two identities the money layer trusts — booking_group_id (random per-run UUID, no DB uniqueness) and participant identity (name-as-key placeholders, no real email) — entirely OUTSIDE the database's uniqueness guarantees, while everything downstream treats each booking_group as one payable unit and each non-empty email as one deliverable address. Any import imperfection (re-run, concurrency, homonym, sentinel email) therefore converts silently into duplicated payments, conflated participants, or dead-end nightly dispatch rather than failing loudly.

### cron-concurrency
This slice is partly well-engineered and partly under-protected, and the asymmetry is the story. The payment-info dispatch lock (migration 00053 + payment-info-notify.service.ts) is genuinely solid: an atomic lease acquire, under-lock re-fetch of amount/recipient/status, the force-path sent_at reset folded into the same lock CAS, and a try/finally release. Tracing it confirms the cron-vs-click race CANNOT double-send a payment email (the loser cleanly gets LOCK_HELD) — so the headline "two payment emails" question is answered "no". The biggest structural risk is that completion is driven by FOUR uncoordinated entry points (bookings PUT, submit_booking_observation RPC, /run verify, and the nightly cron) whose group-completion predicates DIVERGE: the PUT path runs a zero-grace stale-sibling sweep, the cron uses a 7-day grace, and the observation path runs no sweep at all. The same group therefore reaches "all completed" by different rules depending on which door the researcher used — and the reminders dispatcher, unlike the payment path, has no claim/lock whatsoever, leaving the exact double-send class the payment code carefully eliminated wide open on a paid (SMS) channel.

## Confirmed findings (32)

| # | sev | lens | finding | 처리 |
|---|-----|------|---------|------|
| 0 | critical | state-machine | no_show in a multi-session group permanently blocks the whole group's payment-info dispatch (completed sessions never pa | 수정(8822dd2) |
| 1 | high | state-machine | 'running' bookings are never auto-completed by any janitorial path; an un-verified online run stalls its payment indefin | 수정(8822dd2) |
| 2 | high | state-machine | mark_group_completed flips FUTURE sessions to 'completed' (no slot_end guard), freeing the slot for double-booking and f | 수정(8822dd2) |
| 3 | medium→upgrade | state-machine | Completion-code verify writes status with no CAS guard, so a concurrent cancel can be silently resurrected to 'completed | 수정(8822dd2) |
| 4 | medium | state-machine | Recruitment/capacity auto-close is one-way: a cancellation or no_show after the experiment auto-completes never re-opens | 이연/문서화 |
| 5 | medium | state-machine | Blacklist cascade cancels future sessions but never fires payment dispatch, leaving the completed-session payout to an i | 수정(8822dd2) |
| 6 | critical | payment-dispatch | backfill-payment-info + nightly auto-complete sweep mass-emails historical participants (payment-info request for long-f | 수정(8822dd2) |
| 7 | high | payment-dispatch | no_show permanently blocks payment dispatch for multi-session partial completion — participant owed money never gets the | 수정(8822dd2) |
| 8 | medium | payment-dispatch | Blacklist cascade-cancel does not call notify — ALL_CANCELLED transition unreachable from this cancel path; payment row  | 이연/문서화 |
| 9 | medium | payment-dispatch | No retry cap: a permanently-undeliverable recipient (placeholder/backfill email) retries every night forever and mints a | 수정(8822dd2) |
| 10 | low→upgrade | payment-dispatch | AMOUNT_ZERO guard precedes ALL_CANCELLED detection — a zeroed all-cancelled group never reaches its terminal 'cancelled' | 수정(8822dd2) |
| 11 | low | payment-dispatch | Dispatch-lock TTL re-acquire can double-send if an SMTP send stalls past 5 minutes while a concurrent force resend lands | 이연/문서화 |
| 12 | high | money-correctness | Cancelled/no_show sessions leak into the claim/export session list — inflates 방문 횟수, mis-prices per-session amount, and  | 수정(8822dd2) |
| 13 | high | money-correctness | amount_krw is auto-seeded to the FULL fee and never pro-rated for partial attendance; the pro-rate recommender that was  | 이연 — recommendAmount UI 와이어링 (자율주행 Phase B 후보) |
| 14 | medium | money-correctness | Per-session rows in the 지급신청서 don't sum to the printed total under non-divisible amounts (independent rounding) | 수정(8822dd2) |
| 15 | medium | money-correctness | docx 지급신청서 only fills 2 priced table rows; sessions 3+ are dumped into a free-text paragraph, so the table sum diverges  | 이연/문서화 |
| 16 | medium | money-correctness | Plain cancellation never re-derives period_start/period_end, so 활용일자 can show a date span ending on a session the partic | 수정(8822dd2) |
| 17 | low | money-correctness | Backfill treats no_show as a live session, stretching the payment period across no-show dates | 이연/문서화 |
| 18 | high | cancel-reschedule | A no_show session permanently blocks payment-info dispatch for the whole group (cancelled was fixed, no_show was not) | 수정(8822dd2) |
| 19 | medium | cancel-reschedule | Participant reschedule bypasses experiment-status and registration_deadline gates that book_slot enforces — the status g | 부분반박 — exp.status 게이트는 reschedule route :98에 이미 존재(파인더 누락); registration_deadline 미체크는 의도된 범위로 판단 |
| 20 | medium→upgrade | cancel-reschedule | reschedule_reminders can only update/cancel existing pending reminders — it never creates missing ones, silently droppin | 이연/문서화 |
| 21 | low | cancel-reschedule | Cancellation never refreshes the settlement period, so claim Excel/period can include the dates of cancelled sessions (r | 수정(8822dd2) |
| 22 | critical | backfill-import | Re-run / partial-run of importer splits one multi-session participant across multiple booking_groups → duplicate full-fe | 수정(8822dd2) |
| 23 | high | backfill-import | Backfill seeds placeholder/sentinel-email rows into the live dispatch sweep with no email-format guard and no attempts c | 수정(8822dd2) |
| 24 | high | backfill-import | bookings.google_event_id has no UNIQUE constraint — import idempotency is a read-once in-memory snapshot, so concurrent  | 수정(8822dd2) |
| 25 | medium | backfill-import | Import collapses distinct humans who share a name into a single participant row (name-as-identity placeholder) → conflat | 이연/문서화 |
| 26 | critical | cron-concurrency | Reminders dispatch has no atomic claim — concurrent cron runs double-send participant email + paid SMS | 수정(8822dd2) |
| 27 | high→downgrade | cron-concurrency | Payment-info auto-dispatch has no attempts cap or terminal-failure state — unreachable rows churn nightly forever and th | 수정(8822dd2) |
| 28 | high | cron-concurrency | Reschedule's final slot UPDATE has no status CAS — races the zero-grace sibling sweep into a 'completed' booking with a  | 수정(8822dd2) |
| 29 | medium→upgrade | cron-concurrency | Zero-grace sibling sweep auto-attests un-marked past sessions (including no-shows) — can bill for sessions the participa | 부분수정(8822dd2: no_show 게이트·문서필터·미래세션 가드로 위험 완화; zero-grace 자체는 유지 — 사용자 1-click 플로우 보존) |
| 30 | medium | cron-concurrency | Failed reminders are terminal with no retry path — a transient email/SMS error silently loses the reminder | 이연/문서화 |
| 31 | medium | cron-concurrency | Observation-modal auto-complete omits the stale-sibling sweep the PUT path has — payment email stalls up to 7 days on th | 수정(8822dd2) |

## 미검증 3건 (검증자 rate-limit 사망 — 반박 아님)

- (high) [cancel-reschedule] Reschedule capacity/overlap check is non-atomic — concurrent reschedules double-book a slot that book_slot's advisory lock prevents
- (medium) [backfill-import] Backfilled completed bookings count toward recruitment_target and can trip the fast-path auto-close that rejects the next genuine sign-up
- (medium) [backfill-import] Backfill seeds full fee + 'pending' for any group with ≥1 non-cancelled booking regardless of how many actually completed — over-pays no-shows and can wedge the dispatch gate for pipeline-bypassing groups

## 반박 1건
- (medium) [cancel-reschedule] Reschedule's GCal self-event exclusion matches by ±60s time window, not event id — falsely rejects sub-session-length nudges as calendar conflicts
  - 사유: The reviewer quoted the code accurately but misanalyzed the comparison. The ±60s exclusion in /Users/csnl/Documents/claude/lab-reservation-main/src/app/api/booking-edit/[token]/[bookingId]/reschedule/route.ts (lines 182-194) matches each busy interva

## 수기 검증 (메인 세션, 7번째 독립 리뷰어)
- [확정→수정] 취소 세션 청구서류 유입 — 팀 finding [12]와 일치, 독립 도달
- [반박] 참여자 self-cancel 시 dispatch 누락 의심 — booking-edit cancel route :141 이 notifyPaymentInfoIfReady 호출, 총 7개 call site 확인

## 이연 항목 상세 (후속 작업 백로그)
- [13] recommendAmount(amount.ts) 데드코드 → payment panel에 추천금액 표시 와이어링
- [4] recruitment auto-close 단방향(취소 후 재오픈 없음) — 정책 결정 필요
- [11] dispatch lock 5분 TTL 초과 SMTP 지연 시 이론상 중복 — 발생확률 극히 낮음, lock TTL 상향이나 SMTP timeout<TTL 보장으로 해결 가능
- [15] docx 표 priced 행 2개 제한(3회차+ 는 overflow 문단) — PDF는 전 행 표기되므로 PDF가 공식 산출물; docx 템플릿 행 복제 구현은 OOXML row-builder 필요
- [17] backfill이 no_show를 live로 간주(period 산출) — backfill.ts liveRows 필터에 no_show 추가하면 됨 (1줄)
- [20] reschedule_reminders 가 기존 pending 리마인더만 갱신, 신규 생성 없음 — 발송완료 후 더 미래로 변경 시 리마인더 부재
- [25] 동명이인 충돌(name-as-identity) — 사용자 지시로 수용된 백필 규약의 한계, 운영 시 이름+소속 구분 권장
- [30] 리마인더 failed 터미널(재시도 없음) — attempts 컬럼 추가 마이그레이션 필요, medium
