---
name: lab-flow-qa
description: 예약→완료→정산입력→청구 플로우와 예외경로(취소/변경/백필/no_show)의 무결성 검증 전용. "플로우 검증/리뷰해", "버그 있나 봐줘", "정산이 안 가/이상해", 머지 전 QA 게이트, 회귀 확인, 블라인드 리뷰 재실행 요청이 나오면 반드시 이 스킬을 사용할 것. 단순 기능 구현은 해당 없음.
---

# lab-flow-qa — 경계면 교차검증 방법론

repo: `/Users/csnl/Documents/claude/lab-reservation-main`
기준 문서: `docs/payment-flow-review-2026-06-10.md` (32 confirmed 의 원장 — 수용-리스크/이연 목록 포함)

## 핵심 원리

존재 확인이 아니라 **경계면 양쪽을 동시에 읽고 어긋남을 찾는다**:
- DB 규약 ↔ TS 쿼리 필터 (예: 00055 의 status IN ↔ loadSessionsByBgId)
- 서버 게이트 ↔ UI 버튼 조건 (예: notify 의 payable.every ↔ 패널 allBookingsCompleted)
- 한 문(door)의 사이드이펙트 ↔ 다른 문의 동일 전이 (예: PUT 의 sweep ↔ observation 의 sweep)

finding 등급: **critical**(돈 오류·참여자 커뮤니케이션 오발/유실) > **high**(플로우 정지·데이터 손상) > **medium**(운영 혼란, 복구 가능) > **low**. 모든 finding 은 file:line 인용 + 단계별 시나리오 필수 — 없으면 uncertain.

## 6렌즈 분해 (전체 리뷰 시)

1. **state-machine** — bookings.status 쓰는 모든 경로의 전이 가드/CAS
2. **payment-dispatch** — notifyPaymentInfoIfReady 게이트·락·7개 call site
3. **money-correctness** — amount_krw 생성→표시 전 구간, 세션 필터, 라운딩 합계
4. **cancel-reschedule** — 셀프서비스/관리자 취소·변경의 사이드이펙트 완전성
5. **backfill-import** — 멱등성, 그룹 재사용, sentinel email, 억제 스탬프
6. **cron-concurrency** — claim/lock, 더블파이어, 재시도 상한

## 실행 모드

- **증분(기본)**: 변경 diff 가 닿는 렌즈만. `git diff --name-only <base>` 로 파일→렌즈 매핑.
- **전체(분기 1회/대형 리팩토링 후)**: Workflow 도구로 6렌즈 블라인드 병렬 + finding 별 반박-편향 검증. 스크립트 원형: 세션 워크플로우 `payment-flow-blind-review` (scripts 디렉토리의 사본 또는 동일 구조 재작성). 반박 검증자 프롬프트 골자: "REFUTE 를 시도하라. 시나리오의 한 단계라도 코드상 불가능하면 refuted. 확신 없으면 uncertain."

## 머지 게이트 체크 (증분 모드 최소셋)

- [ ] 새 bookings.status UPDATE 에 CAS 있는가
- [ ] 새 세션 조회에 status 필터 있는가 (또는 의도적 전수 조회라는 주석)
- [ ] 새 사이드이펙트 경로(메일/SMS/GCal)에 멱등 장치 있는가
- [ ] UI 버튼 조건이 서버 게이트와 같은 규약을 인용하는가
- [ ] 단위테스트: `node --import tsx scripts/test-payment-info-notify.mjs` + `test-backfill-payment-info.mjs` 통과
- [ ] `NEXT_PUBLIC_APP_URL=... node scripts/smoke-all.mjs` 4/4

## 보고 형식

`_workspace/{NN}_flow-qa_findings.md`: confirmed / uncertain / refuted 3절 + 회귀 확인절(직전 리뷰 confirmed 가 재발했는지). 수용-리스크 재보고 금지(악화 시그널만 예외).
