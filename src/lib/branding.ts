// Centralized lab branding. Every deployment configures its own identity via
// NEXT_PUBLIC_LAB_* env vars so this code ships neutral and any research group
// can drop in their own name without editing source.
//
// Defaults below are placeholders — they read clearly in screenshots but do
// not name any real lab. The placeholder values are intentionally fixed
// strings so callers (email/SMS templates, instrumentation) can detect them
// and adjust behaviour:
//   - email/SMS templates hide the lab-wide mailto fallback when it's the
//     placeholder, so participants never see "contact@example.com" in a
//     production message;
//   - src/instrumentation.ts asserts at server-startup time that the
//     placeholders aren't being used in NODE_ENV=production, so a missing
//     env in a Vercel deploy fails loudly instead of silently shipping
//     "[LAB] …" subject lines to participants.

const PLACEHOLDER_NAME = "LAB";
const PLACEHOLDER_CONTACT_EMAIL = "contact@example.com";
const PLACEHOLDER_SUBTITLE = "연구실 실험 예약 시스템";

export const BRAND_NAME = process.env.NEXT_PUBLIC_LAB_NAME || PLACEHOLDER_NAME;
export const BRAND_SUBTITLE =
  process.env.NEXT_PUBLIC_LAB_SUBTITLE || PLACEHOLDER_SUBTITLE;
export const BRAND_PI = process.env.NEXT_PUBLIC_LAB_PI || "";
export const BRAND_CONTACT_EMAIL =
  process.env.NEXT_PUBLIC_LAB_CONTACT_EMAIL || PLACEHOLDER_CONTACT_EMAIL;
export const BRAND_INITIAL =
  process.env.NEXT_PUBLIC_LAB_INITIAL ||
  (BRAND_NAME.trim().charAt(0) || "L").toUpperCase();

// Upstream project this instance is forked from. Always rendered in the
// footer watermark — see `src/components/footer-watermark.tsx`.
export const PLATFORM_REPO = "https://github.com/CSNL-vnilab/Exp_Platform_by_Joonoh";
export const PLATFORM_CREDIT = "Exp_Platform by Joonoh";

// ── Placeholder detection ────────────────────────────────────────────────

/** True if the brand name is the un-configured placeholder. */
export function isBrandNamePlaceholder(value: string = BRAND_NAME): boolean {
  return value === PLACEHOLDER_NAME;
}

/** True if the contact email is the un-configured placeholder. */
export function isBrandContactEmailPlaceholder(
  value: string = BRAND_CONTACT_EMAIL,
): boolean {
  return value === PLACEHOLDER_CONTACT_EMAIL;
}

/**
 * Returns the lab-wide contact email only if it's been configured.
 * Email/SMS templates should call this instead of using BRAND_CONTACT_EMAIL
 * directly — when the env is missing, returning null lets the template
 * suppress the entire mailto block rather than render a placeholder
 * address that participants might try to write to.
 */
export function brandContactEmailOrNull(): string | null {
  return isBrandContactEmailPlaceholder() ? null : BRAND_CONTACT_EMAIL;
}

/**
 * Validate that the production deployment actually configured branding.
 * Called from src/instrumentation.ts on server start; never throws in dev
 * because half-configured local environments are fine for development.
 *
 * Returns the list of missing/placeholder env vars; empty array = OK.
 */
export function validateBrandingForProduction(): string[] {
  const missing: string[] = [];
  if (!process.env.NEXT_PUBLIC_LAB_NAME || isBrandNamePlaceholder()) {
    missing.push("NEXT_PUBLIC_LAB_NAME");
  }
  if (
    !process.env.NEXT_PUBLIC_LAB_CONTACT_EMAIL ||
    isBrandContactEmailPlaceholder()
  ) {
    missing.push("NEXT_PUBLIC_LAB_CONTACT_EMAIL");
  }
  return missing;
}
