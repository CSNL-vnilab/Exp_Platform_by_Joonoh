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
