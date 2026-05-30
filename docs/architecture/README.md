# Architecture Documentation

> 2026-05-29 — codex×3 정밀조사 + opus team×3 메타리뷰 결과를 통합한 lab-reservation 시스템 청사진.
> 인간 유지보수자가 첫 30분 안에 시스템 전체를 파악할 수 있도록 의도되었습니다.

## 이 문서들이 만들어진 배경

원래 코드베이스는 도메인 (gcal, notion, sms, payments) 과 이벤트 (post-booking, reschedule, status-change) 별로 누적되었지만 **횡단 관심사** (token 발급, outbox finalize, PII scrubbing, absolute URL origin, dispatch lock) 가 한 번도 통합되지 않았습니다. 결과: 각 외부 시스템이 자체 `scrubPii`, 자체 retry 모양, 자체 `finalize_*` RPC 변형, 자체 claim 모양을 가지게 되었습니다.

5 개의 병렬 에이전트 (Codex×3 precision + Opus×3 meta-review) 가 이를 진단:

| 에이전트 | 역할 | 결과 요약 |
|---|---|---|
| **Codex — Booking + Calendar/Notify** | 51 함수 inventory, 22 hidden hooks, spaghetti top 5, retry surface, magic constants | [blueprint § 4](./blueprint.md#4-booking-lifecycle) + [coupling catalog](./hidden-couplings.md) |
| **Codex — Payment workflow** | amount lifecycle map, status FSM, excel 양식 cell mapping, 12 race window | [blueprint § 5](./blueprint.md#5-payment-lifecycle) + [coupling catalog](./hidden-couplings.md) |
| **Codex — Infra (cron + auth + migrations)** | cron 토폴로지, 3 token system 중복, migration ordering, error handling, Vercel-GitHub wiring | [blueprint § 6-7](./blueprint.md) + cron-runbook.md (별도) |
| **Opus — Boundary Architect** | 10 subsystem 자연 boundary, 5 cross-cutting helper 추출 대상, anti-pattern inventory | [subsystems.md](./subsystems.md) |
| **Opus — Hidden Coupling Auditor** | 30 hidden couplings (🔴 8 / 🟡 22), 5 clusters, 9 ordering deps, audit-vs-reality drift | [hidden-couplings.md](./hidden-couplings.md) |
| **Opus — Blueprint Composer** | 12-section maintainer-facing blueprint, ERD, 3 sequence diagrams, troubleshooting matrix | [blueprint.md](./blueprint.md) |

## 어디서부터 읽나

| 당신의 상황 | 읽을 순서 |
|---|---|
| **처음 인계받음** | [`blueprint.md`](./blueprint.md) 만 (12 sections — 30 분) |
| **특정 영역 디버깅** | [`blueprint.md § 11 troubleshooting matrix`](./blueprint.md#11-where-to-look-when-x-happens) → 해당 영역 |
| **새 기능 추가** | [`subsystems.md`](./subsystems.md) 의 boundary 확인 → 어느 subsystem 책임 → [`hidden-couplings.md`](./hidden-couplings.md) 의 ordering deps 점검 |
| **refactor 계획** | [`refactor-roadmap.md`](./refactor-roadmap.md) — 5 phase 우선순위 |
| **race 디버깅** | [`hidden-couplings.md § audit-vs-reality drift`](./hidden-couplings.md#audit-row-vs-reality-drift) |

## 문서 인덱스

- [`blueprint.md`](./blueprint.md) — **시작점.** 12 sections: elevator pitch, stakeholder, ERD, lifecycle sequence diagrams, cron topology, auth/token map, external gateways, broken/fragile, troubleshooting matrix, evolution sketch
- [`subsystems.md`](./subsystems.md) — **모듈 경계.** 10 specialized subsystem 의 책임/entry/owned data/forbidden + dependency direction
- [`hidden-couplings.md`](./hidden-couplings.md) — **위험 지도.** 30 hidden couplings (🔴/🟡) + 5 clusters + 9 ordering deps + singleton inventory + cron-as-glue
- [`refactor-roadmap.md`](./refactor-roadmap.md) — **다음 단계.** Phase A-E (1주~6주) 우선순위, 각 phase 의 file/blast radius/conflict marker

## 관련 문서

- [`../ops-playbook.md`](../ops-playbook.md) — 일상 ops + migration 적용
- [`../cron-runbook.md`](../cron-runbook.md) — cron 9 개 표 + 실패 대응
- [`../../DEPLOY.md`](../../DEPLOY.md) — 신규 인스턴스 띄우기
- [`../../AGENTS.md`](../../AGENTS.md) — multi-session 협업 룰

## 변경 이력

- **2026-05-29** — 최초 작성. codex×3 + opus×3 의 통합 결과. f957baa / 529f0ed / 2751af1 / 53d66c2 까지 반영.
- **2026-05-29 ~ 30** — Phase A + 자율 loop iter 1-22 진행. 아래 "자율 loop 진행 요약" 절 참조.

## 자율 loop 진행 요약 (Phase A + iter 1-27, 2026-05-29 ~ 30)

원본 청사진의 "broken/fragile" 영역과 hidden-couplings 의 🔴 8 항목 중 다수를 자율적으로 처리한 작업 누적. 인계인이 이 절만 읽고도 현 위치를 파악할 수 있도록 의도.

### 신설 모듈 (7) + 확장 (3)

| 모듈 | 역할 | 도입 | 누적 사용처 |
|---|---|---|---|
| `src/lib/auth/secret-source.ts` | resolveSecret + KNOWN_TOKEN_SECRETS + auditTokenSecrets | A3 / iter 1 | 5 token 모듈 |
| `src/lib/auth/experiment-access.ts` | requireExperimentAccess (extraColumns, ownerOnly) | iter 7 | 13 routes |
| `src/lib/auth/booking-access.ts` | requireBookingAccess (extraBookingColumns, extraExperimentColumns, ownerOnly, `*` wildcard) | iter 12 | 5 methods |
| `src/lib/booking-edit/access.ts` | requireBookingEditAccess + verifyBookingEditTokenOrError sub-helper (iter 24) | iter 17 / 24 | 3 routes (cancel, reschedule, verify) |
| `src/lib/observability/pii.ts` | scrubPii / scrubLastError 단일 owner | A6 / iter 1 | 8+ caller |
| `src/lib/http/origin.ts` | getAppOrigin / getAppOriginOrNull (per-call, not module-cached) | B7-light / iter 1 | 13 call site |
| `src/lib/google/title-helpers.ts` | creatorInitial + formatKrPhone (drift fix — 같은 연구자가 runtime vs retry 경로에서 다른 calendar title 받던 버그 해소) | iter 25 | booking.service + gcal-retry.service |

**확장 (기존 모듈에 const 추가)**:

| 확장 | 어디 | 도입 | 의도 |
|---|---|---|---|
| `NOTIFY_OUTCOME` const + `NotifyOutcome` type | `payment-info-notify.service.ts` | iter 26 | 9 outcome 의 caller-side grep 가능성. string literal 그대로 써도 backward-compat. |
| `STATUS_NOTIFY_OUTCOME` const + `StatusNotifyOutcome` type | `booking-status-notify.service.ts` | iter 26 | 5 outcome 동일 패턴. |
| `NOTION_COLUMN` const + `NotionColumnName` type | `notion/schema.ts` | iter 27 | 21 semantic id ↔ Korean column name. client.ts 의 ~28 inline string literal 제거. NOTION_REQUIRED_PROPERTIES 도 const 참조 (single owner). |

### 신설 endpoint (3)

| Endpoint | 역할 | 도입 |
|---|---|---|
| `GET /api/health/secret-audit` | 5 token 모듈 중 어느 것이 SUPABASE_SERVICE_ROLE_KEY 으로 fallback 됐는지 audit (cron-secret-gated) | iter 1 |
| `GET /api/health/queue` | booking_integrations 의 pending/failed 큐 깊이 + 오래된 row age | iter 5 |
| `POST/GET /api/cron/gcal-orphan-reaper` | status=cancelled/no_show + google_event_id 존재 row sweep (grace_hours + batch_limit param) | iter 20-21 |

### 5 신설 smoke scripts

`scripts/smoke-all.mjs` 한 번에 실행 → cron-auth / secret-audit / queue-depth / pii-scrub 일괄 점검 + summary.

### Hidden-couplings 진척 (30 항목 중)

- ✅ 완전 해결: **5** — #2 (mark_group_completed gap), #23 (token-secret fallback chain), #25 (partial-cancel payment_info stuck), #28 (observation Notion fork), 그리고 audit-row-vs-reality drift 일부.
- 🟡 부분 해결: **5** — #1 (PII scrub centralize + outcome logging), #3 (GCal orphan side via reaper), #6 (lock + outcome logging + 5번째 entry 통합), #12 (long-tail orphan reaper), #14 (5번째 clearer = reaper).
- ⏳ 미해결: **20** — refactor-roadmap.md 의 Phase B/C 에서 처리.

### 누적 통계

- ~435 lines 중복 auth boilerplate 제거 (B4 family 3 helpers)
- ~290 lines 중복 inline compute 제거 (origin / PII / secret-source)
- ~28 inline Notion column string literal 제거 → 21 semantic id const (iter 27)
- creatorInitial + formatKrPhone drift fix (iter 25) — calendar title 일관성
- migration 00066-00067 신규 (payment_status enum + 폐기 RPC drop)
- 5 token 모듈 + 13 experiment routes + 5 booking methods + 3 booking-edit routes 의 auth 가 단일 helper-family 통과
- subsystems.md cross-cutting helpers 5 항목 중 4 ✅ (#1 PII, #2 origin, #4 title-helpers, #5 token secret partial). #3 KST partial, 나머지 unfixed.

### 다음 단계 (사용자 작업 필요)

- **`#68` D1-followup**: 9 cron workflow YAML 에 composite action wiring + 새 `gcal-orphan-reaper-cron.yml` 추가. PAT `workflow` scope 필요. 또는 사람이 직접 push.
- **`SLACK_WEBHOOK_URL`** GH secret 등록 → 실패 알림 즉시 활성화.
- **migration 00066/00067** prod 적용 (Supabase Dashboard 또는 `supabase db push`).
- **Phase B 본격 진행 검토**: B1 (`notify/`), B2 (`outbox/`), B3 (`payment-info/`), B4 (token kernel HMAC body 통합), B5 (`calendar/`), B6 (`notion/`), B7 (`http/` 의 rate-limit + KV-backed), B8 (KST date helpers — partial done).

### Cumulative commits (Phase A + iter 1-27)

| Iter | Commit | 주제 |
|---|---|---|
| Phase A | `595e933` | A1 mark_group_completed gap + A2 partial-cancel + A3 token secret + A6 PII scrub |
| 1 | `acca07a` | B7-light origin + secret-audit endpoint + Slack composite action |
| 2 | `e1d89a3` | A5 cleanup — notion-retry 통합 + migration 00067 |
| 3 | `caf0966` | obs wraps on payment-info-notify + booking-status-notify |
| 4 | `03b0fad` | smoke scripts (secret-audit + pii-scrub) |
| 5 | `e4452f3` | D2 /api/health/queue endpoint + smoke |
| 6 | `65f1d80` | smoke-cron-auth health 확장 |
| 7 | `750a0eb` | B4-light helper + 3 route POC |
| 8 | `37305de` | B4-light + ownerOnly (4 routes) |
| 9 | `4902900` | B4-light 3 routes (data-export, online-screeners, status) |
| 10 | `61fcda3` | B4-light experiments/[id] PUT+DELETE + payment-claim |
| 11 | `1af669d` | B4-light closeout (payment-claim/email) |
| 12 | `428a7a2` | B4-medium requireBookingAccess + 4 methods |
| 13 | `610da13` | B4-medium PATCH reschedule + closeout |
| 14 | `f753b4c` | D3 PII tests 18 cases |
| 15 | `4b33368` | smoke-all 통합 runner |
| 16 | `10a608a` | PUT bookings/[id] admin client dedup |
| 17 | `619f2e9` | B4-edit (booking-edit cancel + reschedule) |
| 18 | `ccbf5af` | B6 observation Notion defer (#28 ✅) |
| 19 | `62cd975` | hidden-couplings 정리 + B4 family summary |
| 20 | `470105a` | GCal orphan reaper endpoint (#3 #12 #14 partial) |
| 21 | `d789ee0` | reaper grace_hours + batch_limit params |
| 22 | `11b16d2` | subsystems.md mermaid + cross-cutting helpers ✅ |
| 23 | `ee5ed54` | README 자율 loop 종합 요약 (iter 1-22) |
| 24 | `3a2d2b7` | verifyBookingEditTokenOrError sub-helper + verify route 정리 |
| 25 | `8abdf8f` | creatorInitial + formatKrPhone dedup + drift fix (subsystems #4 ✅) |
| 26 | `194983f` | NOTIFY_OUTCOME + STATUS_NOTIFY_OUTCOME const exports |
| 27 | `7464f01` | NOTION_COLUMN const (21 ids) + client.ts migration |
