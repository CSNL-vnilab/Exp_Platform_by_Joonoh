// Participant-fee amount helpers — single source of truth for "how much
// should we pay this participant" calculations.
//
// `experiments.participation_fee` is the TOTAL amount for a booking_group
// at the originally-planned session count. Reality drifts:
//
//   - The experiment may run 6 회차 instead of the planned 5 (timing
//     slipped, extra trial run added) → fee should go up.
//   - The participant may drop out after 2 회차 of a planned 5 → fee
//     should go down to a pro-rated amount.
//
// Until now `participant_payment_info.amount_krw` was seeded once at
// final completion to `experiments.participation_fee` and any deviation
// from "5 of 5" required the researcher to type the new amount blind.
// These helpers expose a *recommended* amount based on the active-
// session count so the researcher can edit-with-context — they NEVER
// auto-apply. The researcher's manual override (PATCH amount route)
// always wins.

export interface RecommendedAmountInput {
  /** experiments.participation_fee — total for the originally-planned run. */
  totalFeeKrw: number;
  /** Session count the fee was scoped to. Falls back to completedSessions when null. */
  plannedSessions: number | null;
  /** How many bookings in this group actually finished (status='completed'). */
  completedSessions: number;
}

export interface RecommendedAmount {
  /** Computed default amount, rounded to nearest ₩100 for clean payout. */
  recommendedKrw: number;
  /** Plain Korean explanation the UI can show as a sub-line. */
  rationale: string;
  /** True when the recommendation differs from the simple `totalFeeKrw`. */
  adjusted: boolean;
}

// Round to the nearest 100원 for clean disbursement. Researchers
// historically pay in 100-원 multiples and odd-단 amounts trip up
// downstream 행정 excel templates.
function roundToHundred(krw: number): number {
  if (!Number.isFinite(krw) || krw <= 0) return 0;
  return Math.round(krw / 100) * 100;
}

/**
 * Compute a recommended amount given the actually-completed session
 * count. Linear pro-rate over the planned session count: 2 of 5 sessions
 * completed → 2/5 × totalFee. Extra sessions beyond planned scale up
 * symmetrically (6 of 5 → 6/5 × totalFee).
 *
 * When `plannedSessions` is null or 0 (single-session experiment, or
 * data missing) we fall back to `totalFeeKrw` unchanged — the per-
 * session rate is undefined and we don't want to invent one.
 */
export function recommendAmount(
  input: RecommendedAmountInput,
): RecommendedAmount {
  const { totalFeeKrw, plannedSessions, completedSessions } = input;

  if (totalFeeKrw <= 0) {
    return {
      recommendedKrw: 0,
      rationale: "참여비가 0원으로 설정된 실험입니다.",
      adjusted: false,
    };
  }

  // Missing or single-session plan → no pro-rate basis. Pay the
  // full posted fee; researcher overrides if reality differs.
  if (!plannedSessions || plannedSessions <= 1) {
    return {
      recommendedKrw: roundToHundred(totalFeeKrw),
      rationale: `실험 등록 시 책정된 ₩${totalFeeKrw.toLocaleString()} 그대로 지급 권장 (단일 회차 실험).`,
      adjusted: false,
    };
  }

  // The expected case: planned multi-session, fee distributes over
  // planned. Completed === planned → no adjustment.
  if (completedSessions === plannedSessions) {
    return {
      recommendedKrw: roundToHundred(totalFeeKrw),
      rationale: `${plannedSessions}회차 모두 완료 — 등록 시 책정된 ₩${totalFeeKrw.toLocaleString()} 그대로 지급 권장.`,
      adjusted: false,
    };
  }

  // Deviation — pro-rate. Guard against 0 completed (we shouldn't be
  // computing for a group with no completed bookings in the first
  // place, but if we do, recommend 0).
  if (completedSessions <= 0) {
    return {
      recommendedKrw: 0,
      rationale: "완료된 회차가 없어 지급 권장액 ₩0.",
      adjusted: true,
    };
  }

  const perSessionKrw = totalFeeKrw / plannedSessions;
  const recommended = roundToHundred(perSessionKrw * completedSessions);
  return {
    recommendedKrw: recommended,
    rationale:
      completedSessions > plannedSessions
        ? `${plannedSessions}회차 계획이 ${completedSessions}회차로 연장 — ₩${roundToHundred(perSessionKrw).toLocaleString()}/회 × ${completedSessions} = ₩${recommended.toLocaleString()} 권장.`
        : `${plannedSessions}회차 계획 중 ${completedSessions}회차만 완료 — ₩${roundToHundred(perSessionKrw).toLocaleString()}/회 × ${completedSessions} = ₩${recommended.toLocaleString()} 권장.`,
    adjusted: true,
  };
}

/**
 * UI-friendly diff between two amounts. Returns null when they match.
 */
export function describeAmountDelta(
  fromKrw: number,
  toKrw: number,
): { sign: "+" | "-"; magnitudeKrw: number; label: string } | null {
  if (fromKrw === toKrw) return null;
  const diff = toKrw - fromKrw;
  const sign = diff > 0 ? "+" : "-";
  const mag = Math.abs(diff);
  return {
    sign,
    magnitudeKrw: mag,
    label: `${sign}₩${mag.toLocaleString()}`,
  };
}
