// Centralized absolute-origin resolution for outgoing email/SMS links.
//
// Why this exists (refactor-roadmap B7 / hidden-couplings #22):
//
// At least 15 call sites were each doing the same conditional:
//
//     process.env.NEXT_PUBLIC_APP_URL?.replace(/\/$/, "") ||
//     (process.env.VERCEL_URL ? `https://${process.env.VERCEL_URL}`.replace(/\/$/, "") : "")
//
// Two real problems:
//
//   1. **Module-level cache vs runtime env.** booking-status-notify
//      computed APP_ORIGIN once at module load. Vercel Functions keep
//      modules warm across invocations, so an env-var swap at deploy
//      time wouldn't reach an already-imported module — emails sent
//      from a warm Lambda kept linking the OLD origin until cold start.
//
//   2. **Subtle semantic drift.** Some sites also accepted
//      `https://${VERCEL_URL}`; others rejected it; reminder.service
//      returned null instead of "" when both were missing; etc. Diverge
//      slowly, break in different ways.
//
// This helper is called at the relevant moment (never cached at module
// scope) and returns the same shape every site needs. Pure read of
// process.env — no I/O, cheap to call per request.

/**
 * Returns the absolute origin (scheme + host, no trailing slash) the
 * app should use when minting email/SMS links. Preference order:
 *
 *   1. NEXT_PUBLIC_APP_URL — the explicit prod URL operators set
 *   2. VERCEL_URL          — the preview / branch URL Vercel injects
 *   3. ""                  — empty, caller decides how to degrade
 *
 * NEVER read at module scope. The Vercel Function runtime keeps modules
 * warm, so a module-level read survives env swaps; per-call reads pick
 * up the new value on the next request.
 */
export function getAppOrigin(): string {
  const explicit = process.env.NEXT_PUBLIC_APP_URL?.replace(/\/$/, "");
  if (explicit) return explicit;
  const vercel = process.env.VERCEL_URL;
  if (vercel) return `https://${vercel}`.replace(/\/$/, "");
  return "";
}

/**
 * Same as getAppOrigin() but returns null when neither env is set —
 * matches the older reminder.service convention so a caller that
 * needs to short-circuit (skip rendering a link box rather than render
 * a broken one) can do `if (origin == null) return`.
 */
export function getAppOriginOrNull(): string | null {
  const v = getAppOrigin();
  return v === "" ? null : v;
}
