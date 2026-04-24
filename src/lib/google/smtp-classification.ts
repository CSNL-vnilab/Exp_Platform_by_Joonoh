// SMTP error classification for the outbox retry path.
//
// Per RFC 5321: 4xx = transient (mail server should retry), 5xx =
// permanent (give up). Nodemailer surfaces the SMTP reply in err.message
// so we match against the raw string. Also accept:
//   - HTTP 429 (Gmail API rate-limit path)
//   - Node socket errors (ETIMEDOUT/ECONNRESET/ENOTFOUND/ECONNABORTED)
//   - Human-readable rate-limit / quota / greylist / "try again" wording
//
// 5xx is deliberately excluded so 550 "user unknown" and 553 "invalid
// mailbox" don't spin forever. 552 (over quota) often recovers next day
// but leaving it permanent is safer than an infinite retry loop against
// a mis-addressed recipient.
//
// History: this regex previously included `5\d\d`, which caused 550/553
// to retry forever. Fixed 2026-04-24 (commit 735ed5a). The unit test at
// scripts/test-smtp-classification.ts guards against regressions.

const TRANSIENT_SMTP_PATTERN =
  /\b4\d\d\b|\b429\b|ETIMEDOUT|ECONNRESET|ENOTFOUND|ECONNABORTED|rate[ _-]?limit|quota|temporar|greylist|try again|busy/i;

export function isTransientSmtpError(err: string): boolean {
  return TRANSIENT_SMTP_PATTERN.test(err);
}

// Scrub recipient email from an error body before persisting — the outbox
// table is read by researchers in the dashboard, so raw PII shouldn't land
// there. 500-char cap keeps one bad error from blowing up the JSON column.
export function scrubEmailAndTruncate(err: string, maxLen = 500): string {
  return err
    .replace(/\b[\w._%+-]+@[\w.-]+\.[A-Za-z]{2,}\b/g, "<email>")
    .slice(0, maxLen);
}
