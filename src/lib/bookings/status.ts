// SSOT — bookings.status 규약의 단일 진실원 (TS 측 미러).
//
// 왜 이 모듈이 존재하는가
// ────────────────────────
// 2026-06-10 블라인드 리뷰에서, bookings.status 를 읽고-쓰는 7개 writer 가
// "살아있는 세션 / terminal-non-payable / 전이 가능 출발상태" 규칙을 각자
// 인라인으로 재구현하고 있었다. 그 결과 한 writer 가 'cancelled' 만
// 특별취급하고 'no_show' 를 빠뜨리는 **no_show 비대칭 사고**가 났다 —
// 멀티세션 그룹에 no_show 가 하나 섞이면, 실제로 완료한 회차가 영원히
// 정산되지 못하거나, 불참 회차의 slot 이 정산서류(period/회수/금액)에
// 부풀려 들어갔다. 규칙을 한 곳에 모아 모든 소비처가 import 하게 한다.
//
// SQL 측 대응물과의 관계 (중요)
// ──────────────────────────────
// 상태 규약의 **원본(source of truth)은 마이그레이션 SQL** 이다:
//   - 00055 propagate_payment_period — 살아있는/참석 세션 =
//       status IN ('confirmed','running','completed'). period/금액 재산출 기준.
//   - 00069 book_slot — 예약 원자성(capacity 는 status='confirmed' 만 셈).
//   - 00070 mark_group_completed / auto_complete_stale_bookings —
//       confirmed+running 을 completed 로 전이.
// 이 모듈은 그 규약의 **TS 측 미러**일 뿐이다. SQL 과 어긋나면 SQL 이 옳다.
// 규약을 바꾸려면 먼저 마이그레이션을 고치고 여기를 따라 갱신한다.
//
// 주의: 슬롯 가용성(capacity) 의 status='confirmed' 는 "정원 점유" 의미이지
// LIVE 가 아니다 (slots/*, freebusy). 그 쿼리들은 이 상수를 쓰지 않는다.

/** bookings.status 가 가질 수 있는 전체 5종.  *
 * 의도적 SSOT 미사용 (capacity/freebusy 도메인): 슬롯 가용성 쿼리의
 * status='confirmed' (정원 점유 의미)와 freebusy-cache 의 orphan 판정
 * terminal-set 은 별도 도메인 규약이라 리터럴 유지.
*/
export const BOOKING_STATUSES = [
  "confirmed",
  "running",
  "completed",
  "cancelled",
  "no_show",
] as const;

export type BookingStatus = (typeof BOOKING_STATUSES)[number];

/**
 * 살아있는/참석 세션 = 정산·서류 집계에 들어가는 상태.
 * 00055 propagate_payment_period 규약과 정합. cancelled·no_show 제외.
 */
export const LIVE_STATUSES = ["confirmed", "running", "completed"] as const;

/**
 * 참석하지 않은 종단 상태 — 정산 대상이 아니며 그룹 readiness 게이트를
 * 막지 않는다. cancelled(취소) 와 no_show(불참) 는 대칭으로 다뤄야 한다
 * (no_show 비대칭 사고의 교훈).
 */
export const TERMINAL_NON_PAYABLE = ["cancelled", "no_show"] as const;

/**
 * "전이 가능 출발상태" — 아직 종단에 도달하지 않은 in-flight 세션.
 * completed/cancelled 로의 전이나 cascade 취소의 CAS 출발집합으로 쓴다.
 * (LIVE 와 다르다: completed 는 이미 종단이므로 여기에 없다.)
 */
export const COMPLETABLE_STATUSES = ["confirmed", "running"] as const;

/**
 * 허용 상태 전이표 — 종단 상태에서 되돌아가는 것을 막는다.
 * 'running' 은 /run 이 완료코드를 발급할 때 자동 설정된다 — 연구원은 보통
 * running → completed (완료코드 검증 후) 또는 running → cancelled
 * (참여자 이탈) 만 수행한다.
 * (원본: src/app/api/bookings/[bookingId]/route.ts 상단에 있던 정의를 이동.)
 */
export const VALID_TRANSITIONS: Record<BookingStatus, readonly BookingStatus[]> = {
  confirmed: ["cancelled", "completed", "no_show", "running"],
  running: ["cancelled", "completed", "no_show"],
  cancelled: [],
  // 완료·불참을 취소로 되돌릴 수 있다 (2026-07 user directive). 실험이 실제로는
  // 취소됐는데 서버가 자동으로 완료 처리한 경우 등, 연구원이 언제든 정정할 수
  // 있어야 함. 취소로 되돌리면 캘린더 일정이 즉시 삭제되고 정산이 재산정되며,
  // 정원 자동마감된 실험은 재오픈되어 재예약이 가능해진다.
  completed: ["cancelled"],
  no_show: ["cancelled"],
};

/** 살아있는/참석 세션인가 (LIVE_STATUSES 멤버십). */
export function isLive(status: string): boolean {
  return (LIVE_STATUSES as readonly string[]).includes(status);
}

/** 참석하지 않은 종단(정산 비대상) 상태인가 (cancelled/no_show). */
export function isTerminalNonPayable(status: string): boolean {
  return (TERMINAL_NON_PAYABLE as readonly string[]).includes(status);
}

/** from → to 상태 전이가 허용되는가 (VALID_TRANSITIONS 기준). */
export function canTransition(from: string, to: string): boolean {
  const allowed =
    (VALID_TRANSITIONS as Record<string, readonly string[]>)[from] ?? [];
  return allowed.includes(to);
}
