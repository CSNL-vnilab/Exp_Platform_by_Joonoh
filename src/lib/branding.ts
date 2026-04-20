// Centralized lab branding. Every deployment configures its own identity via
// NEXT_PUBLIC_LAB_* env vars so this code ships neutral and any research group
// can drop in their own name without editing source.
//
// Defaults below are placeholders — they read clearly in screenshots but do
// not name any real lab.

export const BRAND_NAME = process.env.NEXT_PUBLIC_LAB_NAME || "LAB";
export const BRAND_SUBTITLE =
  process.env.NEXT_PUBLIC_LAB_SUBTITLE || "연구실 실험 예약 시스템";
export const BRAND_PI = process.env.NEXT_PUBLIC_LAB_PI || "";
export const BRAND_CONTACT_EMAIL =
  process.env.NEXT_PUBLIC_LAB_CONTACT_EMAIL || "contact@example.com";
export const BRAND_INITIAL =
  process.env.NEXT_PUBLIC_LAB_INITIAL ||
  (BRAND_NAME.trim().charAt(0) || "L").toUpperCase();

// Upstream project this instance is forked from. Always rendered in the
// footer watermark — see `src/components/footer-watermark.tsx`.
export const PLATFORM_REPO = "https://github.com/CSNL-vnilab/Exp_Platform_by_Joonoh";
export const PLATFORM_CREDIT = "Exp_Platform by Joonoh";
