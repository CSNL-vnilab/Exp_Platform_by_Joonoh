import type { ParticipantClass } from "@/types/database";
import { Badge } from "@/components/ui/badge";

// Korean labels used across list badges, participant detail headers, and the
// bookings manager row column. Kept in sync with lib/participants/classes.ts.
const LABELS: Record<ParticipantClass, string> = {
  newbie: "뉴비",
  royal: "로열",
  blacklist: "블랙리스트",
  vip: "VIP",
};

type BadgeVariant = "default" | "success" | "danger" | "info" | "warning";

const VARIANTS: Record<ParticipantClass, BadgeVariant> = {
  newbie: "default",
  royal: "success",
  blacklist: "danger",
  vip: "info",
};

interface ClassBadgeProps {
  value: ParticipantClass | null;
  compact?: boolean;
  className?: string;
}

/**
 * Small coloured pill surfacing the participant's current class.
 * Falls back to "미분류" / default variant when the participant has no row in
 * participant_class_current (e.g. first contact before any booking completes).
 */
export function ClassBadge({ value, compact, className }: ClassBadgeProps) {
  if (!value) {
    return (
      <Badge variant="default" className={className}>
        {compact ? "미" : "미분류"}
      </Badge>
    );
  }
  const label = compact ? LABELS[value].slice(0, 1) : LABELS[value];
  return (
    <Badge variant={VARIANTS[value]} className={className}>
      {label}
    </Badge>
  );
}
