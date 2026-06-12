import type { ReactNode } from "react";

/**
 * Notice — calm, work-tool advisory/warning panel.
 *
 * Pure presentational primitive. Unifies the many ad-hoc info/warning boxes
 * scattered across the admin app — each previously hand-rolled with raw
 * amber / sky classes at slightly different radius (xl vs lg), border
 * lightness (300 vs 200), and padding — into one token-based pattern. No
 * behavior: callers keep their own render conditions, copy, links, and icons.
 *
 * Token-only (globals.css warning / info / danger / neutral), no raw hex.
 *
 * - `tone` colors the box for the meaning the message carries:
 *     warning = caution / something needs attention (amber)
 *     info    = neutral-positive informational note (sky)
 *     danger  = error / destructive / irreversible (red)
 *     neutral = quiet, low-emphasis note (grey)
 *   NOTE: there is intentionally no `success` (emerald) tone here — the
 *   success/emerald hue is a pending user taste-fork and is deliberately
 *   left out of this round.
 * - `title` renders an optional bold lead line above the body.
 * - `icon` renders an optional leading glyph slot, tinted to the tone.
 * - `size` controls density: `md` (default, px-4 py-3 text-sm) or `sm`
 *   (px-3 py-2 text-xs) for tighter inline notices.
 */

type NoticeTone = "warning" | "info" | "danger" | "neutral";
type NoticeSize = "md" | "sm";

interface NoticeProps {
  tone?: NoticeTone;
  title?: ReactNode;
  icon?: ReactNode;
  size?: NoticeSize;
  children?: ReactNode;
  className?: string;
  /** Optional pass-through for semantics (e.g. role="alert"/"status"). */
  role?: string;
  "aria-live"?: "polite" | "assertive" | "off";
}

const toneClasses: Record<NoticeTone, string> = {
  warning: "border-warning-200 bg-warning-50 text-warning-800",
  info: "border-info-200 bg-info-50 text-info-800",
  danger: "border-danger-200 bg-danger-50 text-danger-700",
  neutral: "border-neutral-200 bg-neutral-50 text-neutral-700",
};

const iconToneClasses: Record<NoticeTone, string> = {
  warning: "text-warning-700",
  info: "text-info-700",
  danger: "text-danger-700",
  neutral: "text-neutral-600",
};

const sizeClasses: Record<NoticeSize, string> = {
  md: "px-4 py-3 text-sm",
  sm: "px-3 py-2 text-xs",
};

export function Notice({
  tone = "warning",
  title,
  icon,
  size = "md",
  children,
  className = "",
  role,
  "aria-live": ariaLive,
}: NoticeProps) {
  return (
    <div
      role={role}
      aria-live={ariaLive}
      className={`rounded-lg border ${toneClasses[tone]} ${sizeClasses[size]} ${className}`}
    >
      <div className={icon ? "flex gap-2" : ""}>
        {icon ? (
          <span className={`shrink-0 ${iconToneClasses[tone]}`} aria-hidden="true">
            {icon}
          </span>
        ) : null}
        <div className={icon ? "min-w-0 flex-1" : ""}>
          {title ? <p className="font-medium">{title}</p> : null}
          {children}
        </div>
      </div>
    </div>
  );
}

export type { NoticeProps, NoticeTone, NoticeSize };
