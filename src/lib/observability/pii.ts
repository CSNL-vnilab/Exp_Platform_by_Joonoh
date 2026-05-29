// PII scrubbing for last_error / audit columns.
//
// Why this exists (refactor-roadmap A6 / hidden-couplings #1):
//
// Every retry service (sms / notion / gcal / email) had its own
// identical scrubPii copy, and several other last_error writers
// (PUT /api/bookings cancel-path, booking-edit cancel-path,
// payment-claim email failures) wrote raw error messages straight to
// the DB. SMTP / Solapi / googleapis errors can include the
// participant's email and phone in the message body verbatim —
// stamping that into a long-lived audit column violates the data
// minimization principle in our IRB protocol.
//
// One module owns the patterns now. Add new redaction patterns here,
// not in callers. Match the existing strict approach: replace whole
// matches with `<email>` / `<phone>` rather than partial masking so
// the DB never holds even the prefix.

/**
 * Replace email and Korean phone patterns with `<email>` / `<phone>`.
 *
 * Email: standard local@domain with TLD ≥ 2.
 * Phone: 010-1234-5678 / 010 1234 5678 / 01012345678 / 0212345678 /
 *        02-1234-5678 / 02 123 4567 etc — anything matching
 *        `\b\d{2,3}-?\d{3,4}-?\d{4}\b` (room for service+land numbers).
 *
 * Does NOT touch RRN (주민등록번호) — those have their own dedicated
 * crypto module (src/lib/crypto/rrn.ts) and never flow into error
 * strings because they're never sent to external APIs unencrypted.
 */
export function scrubPii(msg: string): string {
  return msg
    .replace(/\b[\w._%+-]+@[\w.-]+\.[A-Za-z]{2,}\b/g, "<email>")
    .replace(/\b\d{2,3}-?\d{3,4}-?\d{4}\b/g, "<phone>");
}

/**
 * Scrub + truncate for the common `last_error TEXT` columns sized to
 * 500 chars. Keeps the call site terse — caller doesn't need to
 * remember the cap.
 */
export function scrubLastError(err: unknown, maxLen = 500): string {
  const raw = err instanceof Error ? err.message : String(err);
  return scrubPii(raw).slice(0, maxLen);
}
