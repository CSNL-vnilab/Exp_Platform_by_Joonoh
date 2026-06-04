# 예약·취소 신뢰성 규칙 (Vercel 운영 규칙)

> 2026-06-04. 목적: **참여자가 실험 취소·예약 과정의 내부 오류(특히 Google
> 캘린더 동기화 실패) 때문에 불편을 겪지 않도록** 시스템이 지켜야 하는
> 불변식(invariant)과 그것을 강제하는 코드 위치를 한곳에 정리한다. 계기는
> 2026-06-04 발견된 사례 — 한 참여자(CSNL-BPXPYD)의 취소 예약 10건이 캘린더
> 일정 삭제 실패로 "orphan"으로 남아 해당 시간대가 계속 '예약됨'으로 보였고,
> 전체로는 6명·2개 실험에 걸쳐 31건의 orphan이 누적되어 있었다.

이 문서는 규칙(불변식)이다. 절차적 런북은
[`../cron-runbook.md`](../cron-runbook.md), 전체 구조는
[`./README.md`](./README.md) 를 본다.

---

## 핵심 원칙: DB가 진실, 캘린더는 보조

랩의 **자체 예약 점유 상태는 `bookings` 테이블이 단일 진실원본**이다. Google
캘린더는 두 가지 보조 역할만 한다: (a) 시스템 밖에서 만들어진 **외부 일정**
충돌 표시, (b) 공용 캘린더를 공유하는 **타 실험의 confirmed 예약**(같은 방
충돌) 표시. 따라서 랩 자신의 취소/노쇼 예약에 대응하는 캘린더 일정은 — 설령
물리적으로 아직 남아 있어도 — **절대로 슬롯을 막아서는 안 된다.**

---

## 불변식

### R1. 가용성은 조언(advisory), `book_slot`이 권위(authoritative)

슬롯 그리드(`/api/experiments/[id]/slots/range`)는 약간 오래된 정보를 보여줄
수 있다. 실제 예약 생성의 최종 관문은 `book_slot` RPC 하나다 —
`pg_try_advisory_xact_lock` + 정원/중복/모집 검사를 한 트랜잭션에서 수행한다.

- **귀결:** 가용성이 슬롯을 잘못 "available"로 보여줘도 RPC가 거부하므로
  더블북이 발생하지 않는다(참여자는 "이미 예약됨" 메시지를 본다). 따라서
  가용성 계층의 orphan 제외(R2)는 **안전하다** — 최악이라도 RPC가 막는다.

### R2. 랩 자신의 취소/노쇼 예약 일정은 슬롯을 막을 수 없다

`excludeBookingOrphans()` (`src/lib/google/freebusy-cache.ts`) 가 busy
interval 중 **`status IN ('cancelled','no_show')` 예약의 `google_event_id`와
일치하는 것**을 제거한다. 모든 가용성 경로가 이 필터를 통과한다:

- 부킹 페이지(범위) · 미리보기 — `getCachedFreeBusy` 내부에서 적용.
- 단일일 슬롯, 관리자/참여자 **변경(reschedule) 충돌 검사** — 호출부에서
  `getFreeBusy` 결과를 `excludeBookingOrphans`로 감싼다.

이 매칭은 취소된 행이 보관 중인 `google_event_id`로 이뤄지므로 **이미 쌓여
있던 orphan에도 소급 적용**된다(캘린더 마이그레이션 불필요). 일치 쿼리 실패
시에는 **fail-open**(전부 유지)하여 실제 외부 충돌을 숨기지 않는다.

- **이벤트 id 출처:** `getFreeBusy`는 `events.list`를 쓰며 각 일정의 `id`를
  반환한다. 권한 부족으로 `freebusy.query`로 폴백할 때만 id가 없고
  (`id:null`), 이 경우 제외 불가(드묾).

### R3. 캐시는 Google 원본을 저장, orphan 제외는 읽은 뒤 적용

`calendar_freebusy_cache`(TTL 5분)는 Google 응답 원본을 저장한다.
orphan 제외는 **캐시를 읽은 직후** 매 요청 적용된다. 그래서 TTL 도중
취소가 일어나도 다음 페이지 로드에 즉시 반영된다. 추가로 취소/변경/실험
수정 시 `invalidateCalendarCache()`로 캐시를 비운다.

### R4. 서버리스에서 부수효과는 응답 전에 await

Vercel 함수는 응답을 반환하면 프로세스가 동결된다. 따라서 예약 생성 후
외부 연동 파이프라인(`runPostBookingPipeline`)은 **fire-and-forget 금지,
반드시 `await`** 한다(`src/app/api/bookings/route.ts`). outbox 행이 응답
전에 종단 상태에 도달해야 클라이언트가 부분 실패를 알 수 있다.

### R5. GCal 부수효과는 best-effort + self-healing (3중 방어)

캘린더 일정 삭제(취소·변경)는 best-effort다. 실패해도 예약 상태 전이는
롤백하지 않는다. 대신 세 겹으로 방어한다:

1. **즉시 재시도** — `calendar.ts`의 `withRetry`(429/5xx/네트워크 1회 재시도).
2. **가용성 무해화(R2)** — 삭제가 끝내 실패해 orphan이 남아도 참여자
   가용성에는 영향이 없다. **이것이 참여자 보호의 핵심.**
3. **orphan-reaper 크론** — 6시간마다
   `/api/cron/gcal-orphan-reaper`(`grace_hours=12`)가
   `status IN ('cancelled','no_show') AND google_event_id IS NOT NULL`
   행을 쓸어 캘린더 일정을 삭제(404/410 idempotent)하고 id를 비운다.
   `.github/workflows/gcal-orphan-reaper-cron.yml`. 캘린더 시각적 청결용 —
   참여자 가용성은 이미 R2가 보장.

### R6. 모든 크론은 idempotent

GH Actions가 일시 실패에 재시도하므로 모든 크론 핸들러는 멱등이어야 한다
(status 마커, `WHERE status='pending'` 필터 등). reaper의 `grace_hours=12`는
변경(create→update→delete-old) 진행 중 레코드를 잘못 수확하지 않기 위한
유예창이다.

---

## 알려진 잔여 위험 (follow-up)

- **변경(reschedule)으로 인한 orphan.** 변경 경로는 *새 일정 생성 → DB가 새
  id로 갱신 → 옛 일정 삭제* 순서다. 마지막 삭제가 실패하면 **옛 일정이
  남는데 그 id는 더 이상 DB에 없다**(행은 새 id를 가리킴). 따라서 R2의
  `google_event_id` 매칭으로도, reaper로도 잡히지 않는다(둘 다 DB의
  현재 id에 의존). 빈도는 낮고(변경 + 삭제 실패 동시), reaper의 유예창과
  무관한 별도 클래스다.
  - **제안 해법(택1):** ① 일정 생성 시
    `extendedProperties.private.bookingId`로 태깅하고, 가용성에서 "내
    예약 일정인데 그 예약의 현재 시각과 불일치"하면 제외(시각 불일치 =
    stale) → 변경 orphan까지 포착. ② 변경을 *제자리 patch*(같은 event id의
    start/end 갱신)로 바꿔 옛 일정 자체가 생기지 않게 함. ②가 더 근본적이나
    현재의 "create-before-DB" 원자성(P2-1)과의 상호작용을 검토해야 한다.
  - 현재는 R1(권위 RPC) 덕에 이 잔여 orphan도 **더블북을 만들지 못하며**,
    옛 시각 슬롯이 일시적으로 막혀 보일 뿐이다. 관리자 화면에서 수동 정리
    가능.

- **`SLACK_WEBHOOK_URL` 미등록 시** 크론 실패 알림은 no-op(워크플로는
  여전히 빨간 ✕). 등록 절차는
  [`./PENDING-OPERATOR-ACTIONS.md`](./PENDING-OPERATOR-ACTIONS.md).
