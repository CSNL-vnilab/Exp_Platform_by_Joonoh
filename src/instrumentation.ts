// Next.js startup hook (called once per Node instance, before any request
// is served). We use it as the single canonical place to fail-fast on
// missing production env that would otherwise leak placeholder strings
// (e.g. "[LAB]" subject lines, "contact@example.com" mailto fallbacks)
// into participant-facing email or SMS.
//
// Dev / test: warn-only; a half-configured local env is fine.
// Production:  throw, so the Vercel cold-start surfaces the error in
// the deployment logs and the bad build doesn't silently serve traffic.

import { validateBrandingForProduction } from "@/lib/branding";

export async function register() {
  if (process.env.NEXT_RUNTIME !== "nodejs") return;

  const missing = validateBrandingForProduction();
  if (missing.length === 0) return;

  const isProd = process.env.NODE_ENV === "production";
  const message =
    `[branding] Missing or placeholder lab branding env: ${missing.join(", ")}. ` +
    `Configure these on Vercel (or your host) so participant-facing email/SMS ` +
    `does not show "LAB" / "contact@example.com".`;

  if (isProd) {
    // Throwing here aborts server startup. The Vercel build would have
    // already succeeded (env is read at runtime, not build), so this
    // surfaces as a clear runtime failure instead of leaking placeholder
    // text to users.
    throw new Error(message);
  }
  console.warn(message);
}
