/**
 * ParticipantProgress — presentational-only block-progress bar for a single
 * live session row.
 *
 * Visually consistent with dashboard/booking-status-bar: an h-2 rounded track
 * (bg-neutral-100) with a proportional fill, plus a compact tabular-nums label.
 * Pure rendering — it derives the fill ratio from the counts handed to it and
 * does nothing else (no fetch, no state).
 *
 * Honesty rules (no fabricated progress):
 *   - With a known total (blockCount): fill = submitted / total, fill colour
 *     follows the session's semantic tone (running→info, idle→warning,
 *     done→success). Label reads "{n}/{N} 블록".
 *   - Without a known total: we cannot show a ratio, so no bar is drawn —
 *     only the honest "{n} 블록" count. Inventing a denominator would be a lie.
 */

export type ProgressTone = "neutral" | "info" | "warning" | "success";

const FILL: Record<ProgressTone, string> = {
  neutral: "bg-neutral-300",
  info: "bg-info-600",
  warning: "bg-warning-600",
  success: "bg-success",
};

export function ParticipantProgress({
  submitted,
  total,
  tone,
}: {
  submitted: number;
  total: number | null;
  tone: ProgressTone;
}) {
  // No known denominator → show the honest raw count, no ratio bar.
  if (total === null || total <= 0) {
    return (
      <span className="text-foreground tabular-nums">
        {submitted} 블록
      </span>
    );
  }

  const clamped = Math.max(0, Math.min(submitted, total));
  const pct = (clamped / total) * 100;

  return (
    <div className="min-w-[7rem]">
      <div
        className="flex h-2 w-full overflow-hidden rounded-full bg-neutral-100"
        role="img"
        aria-label={`진행: ${total}블록 중 ${clamped}블록`}
      >
        <div
          className={FILL[tone]}
          style={{ width: `${pct}%` }}
          title={`${clamped}/${total} 블록`}
        />
      </div>
      <div className="mt-1 text-2xs text-neutral-500 tabular-nums">
        {clamped}/{total} 블록
      </div>
    </div>
  );
}
