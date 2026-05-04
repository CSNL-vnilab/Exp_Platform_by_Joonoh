// Shared HTML shell for all participant-facing transactional emails.
//
// Adds the doctype + <head> with color-scheme meta tags so iOS Gmail
// (and other auto-darken email clients) doesn't crush our light-mode
// box backgrounds into unreadable dark-on-dark.
//
// `<meta name="color-scheme" content="light only">` opts out of forced
// dark-mode color inversion. Most modern clients honor it; a few
// (Outlook 2016) ignore it. The companion `supported-color-schemes`
// is the older Apple Mail / Gmail variant. Including both is the
// safest cross-client recipe.
//
// Pure function — no styling beyond the body wrapper. Templates pass
// in their own inner content (the existing <div style="…">…</div>).

export interface EmailShellOpts {
  lang?: string; // ko by default
  title?: string; // <title> for accessibility / preview
}

export function wrapEmailHtml(bodyContent: string, opts: EmailShellOpts = {}): string {
  const lang = opts.lang ?? "ko";
  const title = opts.title ?? "";
  return `<!DOCTYPE html>
<html lang="${lang}">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width,initial-scale=1">
<meta name="color-scheme" content="light only">
<meta name="supported-color-schemes" content="light">
${title ? `<title>${escapeAttribute(title)}</title>` : ""}
</head>
<body style="margin:0;padding:0;background-color:#ffffff;color:#111827;">
${bodyContent}
</body>
</html>`;
}

// Conservative attribute escape — title can echo experiment titles
// which are user-controlled.
function escapeAttribute(s: string): string {
  return s
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;");
}
