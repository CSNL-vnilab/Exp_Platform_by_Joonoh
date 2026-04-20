// Shared category constants for experiments. Participant-facing labels live
// here so the researcher form, public booking page, and any Notion exports
// speak the same vocabulary.
//
// Locations used to live here as a hardcoded enum ({slab, snubic}). They now
// live in the `experiment_locations` database table (migration 00019) so any
// lab can manage its own rooms via `/locations`. The `LocationInfo` type and
// `locationInfo()` helper remain only as back-compat shims for legacy rows
// whose `location` column was set before the migration. New rows should use
// `experiments.location_id`.

export const EXPERIMENT_CATEGORIES = [
  { value: "offline_behavioral", label: "오프라인 행동실험" },
  { value: "mri", label: "MRI" },
  { value: "brain_stimulation", label: "뇌자극" },
  { value: "eye_tracking", label: "안구추적" },
  { value: "online_behavioral", label: "온라인 행동 실험" },
] as const;

export type CategoryValue = (typeof EXPERIMENT_CATEGORIES)[number]["value"];
export const CATEGORY_VALUES = EXPERIMENT_CATEGORIES.map((c) => c.value) as CategoryValue[];

export function categoryLabel(value: string): string {
  return EXPERIMENT_CATEGORIES.find((c) => c.value === value)?.label ?? value;
}

// Legacy location type kept for back-compat with rows still using the old
// enum column. Returns null for everything now — new code reads from the
// experiment_locations table.
export type LocationValue = string;

export interface LocationInfo {
  value: string;
  shortName: string;
  addressLines: string[];
  naverMapUrl: string;
}

export function locationInfo(_value: string | null | undefined): LocationInfo | null {
  return null;
}
