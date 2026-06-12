/**
 * BookingStatusBar — presentational-only stacked status distribution bar.
 *
 * Renders a booking's status breakdown as a horizontal proportional bar plus a
 * compact legend, so a researcher can read an experiment's progress at a glance
 * instead of parsing "확정 N / 취소·기타 M" text. Pure rendering: it computes
 * nothing beyond proportions from the counts it is handed (no data fetching, no
 * client interactivity), so it stays a server component.
 *
 * Colour mapping is semantic-honest (R1 design tokens):
 *   completed → success  (done / 완료)
 *   confirmed → primary  (예정·확정)
 *   running   → info-600  (진행 중)
 *   cancelled → neutral-300 (취소 — muted, not alarming)
 *   no_show   → warning-600  (노쇼 — attention, not error)
 */

export interface BookingStatusCounts {
  confirmed: number;
  completed: number;
  running: number;
  cancelled: number;
  no_show: number;
  total: number;
}

type StatusKey = "completed" | "confirmed" | "running" | "cancelled" | "no_show";

// Stable render order: meaningful progress first (completed → confirmed →
// running), then the de-emphasised outcomes (cancelled → no_show).
const SEGMENTS: { key: StatusKey; label: string; bar: string; dot: string; text: string }[] = [
  { key: "completed", label: "완료", bar: "bg-success", dot: "bg-success", text: "text-success-700" },
  { key: "confirmed", label: "확정", bar: "bg-primary", dot: "bg-primary", text: "text-primary-800" },
  { key: "running", label: "진행", bar: "bg-info-600", dot: "bg-info-600", text: "text-info-700" },
  { key: "cancelled", label: "취소", bar: "bg-neutral-300", dot: "bg-neutral-300", text: "text-neutral-500" },
  { key: "no_show", label: "노쇼", bar: "bg-warning-600", dot: "bg-warning-600", text: "text-warning-700" },
];

export function BookingStatusBar({ counts }: { counts: BookingStatusCounts }) {
  const total = counts.total;

  if (total <= 0) {
    return (
      <div className="flex items-center gap-2 text-2xs text-neutral-500">
        <div className="h-2 flex-1 rounded-full bg-neutral-100" aria-hidden />
        <span className="shrink-0">예약 없음</span>
      </div>
    );
  }

  // Only segments with a positive count participate in the bar and legend.
  const present = SEGMENTS.map((s) => ({ ...s, n: counts[s.key] })).filter((s) => s.n > 0);

  return (
    <div>
      <div
        className="flex h-2 w-full overflow-hidden rounded-full bg-neutral-100"
        role="img"
        aria-label={`예약 상태 분포: 총 ${total}건 — ${present
          .map((s) => `${s.label} ${s.n}건`)
          .join(", ")}`}
      >
        {present.map((s) => (
          <div
            key={s.key}
            className={s.bar}
            style={{ width: `${(s.n / total) * 100}%` }}
            title={`${s.label} ${s.n}건`}
          />
        ))}
      </div>
      <div className="mt-1.5 flex flex-wrap items-center gap-x-2.5 gap-y-1 text-2xs">
        {present.map((s) => (
          <span key={s.key} className="inline-flex items-center gap-1" title={`${s.label} ${s.n}건`}>
            <span className={`inline-block h-1.5 w-1.5 shrink-0 rounded-full ${s.dot}`} aria-hidden />
            <span className="text-neutral-500">{s.label}</span>
            <span className={`font-semibold tabular-nums ${s.text}`}>{s.n}</span>
          </span>
        ))}
        <span className="ml-auto text-neutral-500 tabular-nums">총 {total}건</span>
      </div>
    </div>
  );
}
