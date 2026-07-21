# 미래작업 설계도 (Future-Work Blueprint)

작성 2026-07-21. 플랫폼 성숙도 감사(Adversarial + Naive + UI-design 리뷰 3회차)에서
도출된, **아직 구현하지 않은** 개선/기능을 우선순위·근거·리스크와 함께 기록한다.
즉시 구현한 저위험 항목은 이 문서에 없다(git 이력 참조). 여기 있는 항목은 (a) 별도
설계·검증이 필요하거나, (b) 프로덕션 데이터/동작 리스크가 있어 신중히 진행해야 하는 것들.

> 원칙: prod는 실사용 중. 각 항목은 tsc/eslint/next build + adversarial 검증 후 배포하고,
> DB 변경은 append-only 마이그레이션 + introspection 검증. 파괴적 변경은 배포 후 적용.

---

## 1. 신뢰성 · 관측성 (Reliability / Observability)

### 1.1 애플리케이션 에러 추적 (Sentry/APM) — 효과 高, S/M
현재 에러는 `console.error`로만 남아 Vercel 로그에 묻히고, 백그라운드 파이프라인
(`runPostBookingPipeline().catch(console.error)` 등)의 예외는 집계·알림 없이 사라진다.
`@sentry/nextjs`(또는 경량 구조화 로거 sink) 도입 → 프로덕션 예외를 actionable하게.
루트 `global-error.tsx`는 이미 추가됨(2026-07-21) — Sentry 연동 시 여기서 캡처.

### 1.2 큐 백로그 알림 배선 — 효과 高, S (quick win)
`GET /api/health/queue`는 outbox 백로그/dead-letter 임계 초과 시 `ok:false`를 반환하고,
`.github/actions/notify-cron-failure`(Slack)도 있으나 **둘이 연결되어 있지 않다**. cron이
200을 반환하면서 큐가 깊게 밀려도(SMTP 다운, Notion 429 폭주) 아무도 페이징받지 못함.
→ 15분 주기 GH Actions workflow가 `/api/health/queue`를 curl해 `ok:false`면 기존 Slack
액션으로 알림. `get_researcher_pending_work`의 `notion_dead_letter` 카운트도 임계 포함.

### 1.3 부분 예약 정합성 점검 (partial-booking reconciliation) — 효과 中, S
`book_slot` 커밋 후 `runPostBookingPipeline`이 enqueue 이전에 throw하면 booking은
존재하나 `booking_integrations` 행이 없어 outbox-retry 그물에서 빠진다(보이지 않는 부분
예약). → 기존 `db-quality-check` 또는 `gcal-orphan-reaper` cron에 "integration 행이 없는
confirmed booking" 탐지 패스 추가(신규 인프라 불필요, cron auth + admin client 재사용).

### 1.4 분산 레이트 리미터 (Postgres atomic counter) — 효과 中, M
`src/lib/utils/rate-limit.ts`는 Lambda별 인메모리(실질 cap = cap × warm instances,
cold start시 리셋). 모듈 헤더가 이미 "Supabase-backed atomic counter or Vercel WAF"를
해법으로 명시하고 `getRateLimitDiagnostics()`/`/api/health/rate-limit` 프로브까지 준비됨.
→ 가장 뜨거운 리미터(booking POST, booking-edit verify, payment-info submit)를
`UPDATE ... RETURNING` 원자 카운터(작은 rate_limits 테이블)로 이관. (이 앱은 Redis 없음 →
업계 표준 Upstash 대신 Postgres 카운터가 적합. 웹 리서치 근거: Upstash가 serverless 표준이나
Redis 서비스 추가 필요.) 2026-07-21에 booking POST는 인메모리 리미터로 우선 방어함.

---

## 2. 데이터 정합성 · 감사 (Data Integrity / Audit)

### 2.1 예약 상태변경 감사 로그 (booking_status_audit) — 효과 中, S/M
`no_show`/`cancelled`/`completed` 상태 전이(PATCH /api/bookings/[id])와 실험 편집(PUT
experiments/[id])은 in-place로 바뀌고 "누가·언제·왜"의 기록이 없다. 분쟁("왜 노쇼 처리됐나 /
왜 미지급인가") 시 추적 불가. → append-only `booking_status_audit`(booking_id, old_status,
new_status, actor, reason, at) 테이블 + PATCH 핸들러에서 1 insert. 기존 감사 패턴
(`participant_class_audit`, `booking_wipe_audit`, `class_delete_audit`)과 동일.

### 2.2 실험 편집 이력 — 효과 中, M
experiments PUT의 변경 이력(정원/일정/장소/파라미터)이 없어 "언제 무엇을 바꿨나" 불명.
경량 diff-audit 테이블 또는 Notion 미러 확장으로 기록.

---

## 3. 스케줄링 고도화 (Scheduling)

### 3.1 대기자 명단 (Waitlist) — 효과 高, L
정원 도달로 자동 마감(00062/00084) 후 취소로 결원이 생겨도(이제 00084로 실험은 재오픈되나)
그 자리를 원하던 사람에게 알림이 없다. → `experiment_waitlist`(experiment_id, participant
연락처, 원하는 slot/요일, created_at) + 결원 발생 시(취소 PATCH·reopen) 대기자에게 예약
링크 알림. `booking_group`/알림 파이프라인 재사용.

### 3.2 자동 노쇼 정책 — 효과 高, L
`no_show`는 first-class 상태지만 participant class/blacklist로 자동 연결되지 않는다(연구원이
수동 추적). → N회 노쇼 → 자동 blacklist-request 생성 또는 class 강등(트리거 또는 cron).
기존 `participant_classes` + `participant_blacklist_requests` 위에 구축.

---

## 4. 참여자 UX

### 4.1 참여자 셀프서비스 포털 — 효과 高, M
현재 booking-edit/payment-info/run은 회차별 토큰 링크 전용이라, 이메일을 잃으면 참여자가
스스로 복구 불가(연구원이 reissue). → 이름+전화 조회 페이지에서 본인의 예정/과거 예약을
보여주고 edit/verify 링크 재발급(verify-form이 이미 이름+전화 수집; 토큰 발급 + verify
쿠키 재사용). 지원 부담 큰 "링크 분실"을 셀프 해결.

### 4.2 확정 화면 add-to-calendar — 효과 中, S
확정 페이지에 .ics / Google Calendar 추가 버튼(노쇼 감소). 2026-07-21에 확정 화면에
"일정 변경/취소 안내"는 추가함 — add-to-calendar는 후속.

---

## 5. 컴플라이언스 (Compliance / Privacy)

### 5.1 PII 보존·파기 정책 — 효과 高, M
name/phone/email/birthdate + AES-암호화 RRN을 저장하나 보존기간·파기 크론·실험별 보존설정이
없다(유일한 PII 제거는 수동 wipe/스크립트). IRB/PIPA는 보존기간 후 식별자 삭제·익명화 요구.
→ `retention_days` 설정 + 멱등 파기 cron(기간 경과 PII 익명화/삭제 + 로깅). 크립토·감사 기반은
이미 견고 — 보존창 설정 + 파기 크론만 추가.

---

## 6. 연구자 UX

### 6.1 통합 데이터셋 익스포트 — 효과 中, M
현재 익스포트 3종(data-export JSON, data-export-csv, payment-export)이 분산·pull-only.
"이 실험 전부" 단일 zip(bookings+participants+observations+screener + manifest.json:
counts/checksums/generated_at/actor)로 재현가능한 분석 핸드오프 제공. 기존
`listExperimentBlocks`+CSV 빌더 위 소폭 추가.

---

## 7. UI 완성도 (중위험 — 신중 진행)

> 저위험(토큰 정합·포커스링·aria·copy)은 2026-07-21에 이미 반영. 아래는 상호작용/레이아웃을
> 바꿔 회귀 위험이 있어 별도 검증 필요.

### 7.1 native window.confirm/alert → useConfirm/useToast — 효과 高(전문성 인상), M
34개 호출부(bookings-manager ~8 window.confirm + alert, payment-panel claim/backfill/
mark-completed 등)가 브라우저 기본 다이얼로그 사용 — 가장 큰 "비전문적" 인상. 앱은 이미
promise 기반 `useConfirm`(danger + detail 슬롯) + `useToast` 보유. 파괴적 액션(wipe/no-show/
reissue)부터 이관. fetch/guard 로직 불변 유지. WipeButton은 이미 리치 메시지라 confirm의
message/detail에 적합.

### 7.2 hand-rolled modal → Modal 프리미티브 — 효과 中, M
VerifyCompletionModal(bookings-manager) + payment 이메일 모달이 `<dialog>` 기반 `Modal`
프리미티브(Esc·focus-in-top-layer·라벨드 close) 대신 수제 오버레이 재구현. 통일 시 폴리시 +
모달 키보드/AT 동작 개선.

### 7.3 모바일 슬롯 터치타겟 ≥44px — 효과 中, M
week-timetable 슬롯 셀 h-10(40px)로 WCAG 2.5.8 권장(44px) 미만. 모바일 예약 정확도. 캘린더
그리드 밀도에 영향 → 스코프 신중.

---

## 8. 온라인 실험 런타임 P2 (docs/online-runtime-blueprint.md §2)

- **링크 폐기 writer 부재**: `reissue-token/route.ts`가 `token_revoked_at`를 null로만 씀 →
  모든 게이트가 read하나 non-null로 세팅하는 경로가 없어 탈취/오배포 링크를 죽일 수 없음.
  → Step H revoke 라우트 + 연구원 "폐기" 버튼(컬럼·read-게이트는 이미 존재).
- **entry_url 버저닝/피닝** 부재, **sessionIndex** 브리지 미노출, **preflight** 심리물리 rigor
  부족.
- **`/api/experiments/[id]/data/[bookingId]/session` GET 프루닝 결정**: 앱 내 호출자 zero
  (run-shell은 SSR props 사용). 단 외부 런타임 계약 문서(online-experiment-designer-guide
  §148-154) + e2e 2종이 참조 → 외부 런타임이 이 엔드포인트를 쓸 계획이 없다면 라우트 삭제 +
  designer-guide §session 삭제 + e2e-online-exp/e2e-online-phase2에서 /session 히트 제거를
  **동일 커밋**으로. 그 전엔 삭제 금지(스모크 스위트 깨짐).

---

## 9. 코드 위생 (누적 lint 부채)

- `src/components/booking/participant-form.tsx`: birthdate useEffect의 `react-hooks/
  set-state-in-effect` (pre-existing). 파생값을 effect가 아닌 렌더 중 계산 또는 이벤트 핸들러로
  이관해 해소.
- `src/components/run/run-shell.tsx`: 6 problems (pre-existing) — 스코프 잡아 정리.

---

## 우선순위 요약
- **Quick wins (S, 저위험)**: 1.2 큐 알림 배선, 1.3 부분예약 정합성, 4.2 add-to-calendar.
- **High-value (검증 필요)**: 1.1 Sentry, 2.1 상태감사, 3.1 waitlist, 3.2 노쇼정책,
  4.1 셀프서비스 포털, 5.1 PII 보존, 7.1 다이얼로그 이관.
- **큰 프로젝트 (L)**: waitlist, 노쇼정책, (온라인 런타임 P2 tier).
