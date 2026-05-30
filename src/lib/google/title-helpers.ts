// Calendar-event title + description helpers.
//
// Why this exists (subsystems.md cross-cutting #4, 2026-05-30):
//
// `creatorInitial` and `formatKrPhone` were defined identically in
// booking.service.ts (the runtime "post-booking pipeline" path) AND
// gcal-retry.service.ts (the cron retry path) — except `creatorInitial`
// had a drift:
//
//   * booking.service.ts:318 — the fromInternalEmail branch returned
//     the full uppercased username, e.g. `"KIMJUNGYOUNG"`.
//   * gcal-retry.service.ts:41 — the same branch additionally
//     `.slice(0, 4)`, producing `"KIMJ"`.
//
// Net effect: a booking whose initial GCal create succeeded would
// land on the calendar as `[KIMJUNGYOUNG] ...`; if instead it failed
// and the retry cron created the event, the SAME researcher's title
// would read `[KIMJ] ...`. Researchers occasionally noticed and
// reported it as a flaky bug.
//
// Single owner now: the runtime path's "always slice(0, 4)" version
// for the email-derived fallbacks, and "no slice when we have an
// explicit synthetic username" for the fromInternalEmail branch. The
// retry path was the over-aggressive one — we standardise on the
// runtime semantics since calendar pages were already going out with
// that shape and changing that would be the user-visible regression.

import { fromInternalEmail } from "@/lib/auth/username";

export interface CalendarTitleCreator {
  email: string;
  display_name: string | null;
}

/**
 * Researcher initial tag for the calendar title.
 *
 * Preference:
 *   1. `fromInternalEmail(email)` (synthetic @lab.local username) — use
 *      the full username uppercased; these are already short.
 *   2. Otherwise the local part of the email, uppercased, capped at 4.
 *   3. `display_name`, uppercased, capped at 4.
 *   4. `"???"` when no creator was supplied.
 */
export function creatorInitial(
  creator: CalendarTitleCreator | null,
): string {
  if (!creator) return "???";
  const username = fromInternalEmail(creator.email);
  if (username) return username.toUpperCase();
  const localPart = creator.email.split("@")[0];
  if (localPart) return localPart.toUpperCase().slice(0, 4);
  return (creator.display_name ?? "???").toUpperCase().slice(0, 4);
}

/**
 * Pretty-print a Korean phone number from the participant row's
 * digits-only form. Falls back to the raw string when the digit count
 * is unexpected.
 */
export function formatKrPhone(raw: string): string {
  const d = raw.replace(/\D/g, "");
  if (d.length === 11) return `${d.slice(0, 3)}-${d.slice(3, 7)}-${d.slice(7)}`;
  if (d.length === 10) return `${d.slice(0, 3)}-${d.slice(3, 6)}-${d.slice(6)}`;
  return raw;
}

export interface CalendarTitleInput {
  /** Researcher whose initial tag goes in `[...]` at the front. */
  creator: CalendarTitleCreator | null;
  /** Experiment project_name (preferred when set) or title (fallback). */
  experimentTitle: string;
  /** Optional project label. When trimmed-non-empty, used instead of title. */
  projectName: string | null;
  /** 1-based subject number; 0 when unassigned. */
  subjectNumber: number | null;
  /** 1-based session count within the booking_group. */
  sessionNumber: number | null;
}

/**
 * Generate a Google Calendar event title from the booking + experiment
 * shape. Format is:
 *
 *     [<INITIAL>] <project-or-title>/Sbj <n>/Day <n>
 *
 * e.g. `[KIMJ] TimeExp1/Sbj 7/Day 3`.
 *
 * Both the runtime post-booking pipeline (booking.service.ts) and the
 * cron retry path (gcal-retry.service.ts) compose the title identically
 * — extracted here in iter 30 (2026-05-30) so a future tweak (e.g.
 * adding the experiment status flag) touches one place.
 */
export function calendarTitle(input: CalendarTitleInput): string {
  const initial = creatorInitial(input.creator);
  const project = input.projectName?.trim() || input.experimentTitle;
  const sbj = input.subjectNumber ?? 0;
  const day = input.sessionNumber ?? 1;
  return `[${initial}] ${project}/Sbj ${sbj}/Day ${day}`;
}
