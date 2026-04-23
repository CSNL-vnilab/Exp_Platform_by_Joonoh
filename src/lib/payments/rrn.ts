// 주민등록번호 (Korean resident registration number) helpers.
//
// Format: YYMMDD-GSSSSSC
//   YYMMDD — birthdate (century inferred from G)
//   G      — gender/century digit (1..4 for SNU-era citizens, 5..8 foreign,
//            9..0 pre-1900)
//   SSSSS  — region / sequence
//   C      — checksum
//
// Checksum rule:
//   sum = Σ d_i × w_i  (weights 2 3 4 5 6 7 8 9 2 3 4 5)
//   check = (11 − (sum mod 11)) mod 10
// We validate shape *and* checksum so a typo'd RRN doesn't silently land
// in the DB.

const WEIGHTS = [2, 3, 4, 5, 6, 7, 8, 9, 2, 3, 4, 5];

export interface RrnValidationResult {
  valid: boolean;
  normalized?: string; // canonical XXXXXX-XXXXXXX form
  reason?: "shape" | "checksum" | "date";
}

export function validateRrn(raw: string): RrnValidationResult {
  const digits = raw.replace(/[\s-]/g, "");
  if (!/^\d{13}$/.test(digits)) return { valid: false, reason: "shape" };

  // Date sanity — month 1..12, day 1..31. (Full leap-year + per-month
  // days is overkill for a soft check; the admin will catch weird ones.)
  const mm = Number(digits.slice(2, 4));
  const dd = Number(digits.slice(4, 6));
  if (mm < 1 || mm > 12 || dd < 1 || dd > 31) {
    return { valid: false, reason: "date" };
  }

  let sum = 0;
  for (let i = 0; i < 12; i++) {
    sum += Number(digits[i]) * WEIGHTS[i];
  }
  const check = (11 - (sum % 11)) % 10;
  if (check !== Number(digits[12])) {
    return { valid: false, reason: "checksum" };
  }

  return {
    valid: true,
    normalized: `${digits.slice(0, 6)}-${digits.slice(6)}`,
  };
}

export function maskRrn(rrn: string): string {
  const digits = rrn.replace(/[\s-]/g, "");
  if (digits.length < 13) return "******-*******";
  return `${digits.slice(0, 6)}-${digits[6]}******`;
}
