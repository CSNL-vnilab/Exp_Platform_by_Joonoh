import type { ReactNode } from "react";

/**
 * EmptyState — calm, work-tool empty/zero/loading placeholder.
 *
 * Pure presentational primitive. Unifies the many ad-hoc empty messages
 * scattered across the admin app (border-dashed dashboard variant,
 * py-10/py-12 CardContent dialects, raw text-neutral-500 deviations) into a
 * single coherent pattern. No behavior — callers keep their own render
 * conditions and copy.
 *
 * - `tone` colors the title for the three meanings these messages carry:
 *     muted   = nothing here / loading (default, neutral grey)
 *     success = a positive zero state (e.g. "all done ✓")
 *     danger  = an error message
 * - `inset` controls padding/density:
 *     card    = standalone, sits inside a <Card> body (default, p-8)
 *     section = a small empty block inside a larger section
 *     compact = micro empty state inside a cell/list row
 */

type EmptyStateTone = "muted" | "success" | "danger";
type EmptyStateInset = "card" | "section" | "compact";

interface EmptyStateProps {
  title: ReactNode;
  description?: ReactNode;
  icon?: ReactNode;
  action?: ReactNode;
  tone?: EmptyStateTone;
  inset?: EmptyStateInset;
  className?: string;
}

const insetClasses: Record<EmptyStateInset, string> = {
  card: "p-8",
  section: "px-4 py-6",
  compact: "px-3 py-4",
};

const titleToneClasses: Record<EmptyStateTone, string> = {
  muted: "text-muted",
  success: "text-success-700",
  danger: "text-danger",
};

export function EmptyState({
  title,
  description,
  icon,
  action,
  tone = "muted",
  inset = "card",
  className = "",
}: EmptyStateProps) {
  const compact = inset === "compact";
  return (
    <div
      className={`
        flex flex-col items-center justify-center rounded-lg border border-dashed border-border
        text-center ${insetClasses[inset]} ${className}
      `}
    >
      {icon ? (
        <span className="mb-2 text-neutral-400" aria-hidden="true">
          {icon}
        </span>
      ) : null}
      <p
        className={`font-medium ${compact ? "text-xs" : "text-sm"} ${titleToneClasses[tone]}`}
      >
        {title}
      </p>
      {description ? (
        <p className="mt-1 text-2xs text-neutral-500">{description}</p>
      ) : null}
      {action ? <div className="mt-4">{action}</div> : null}
    </div>
  );
}

export type { EmptyStateProps, EmptyStateTone, EmptyStateInset };
