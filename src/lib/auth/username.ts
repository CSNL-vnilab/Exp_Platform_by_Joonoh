// Researchers / admins log in with a short English ID instead of an email.
// Supabase auth still requires an email, so we map each ID to a synthetic
// internal address under a lab-configurable domain (AUTH_EMAIL_DOMAIN).

export const USERNAME_EMAIL_DOMAIN =
  process.env.NEXT_PUBLIC_AUTH_EMAIL_DOMAIN || "lab.local";
export const USERNAME_REGEX = /^[A-Za-z]{3,4}$/;
export const PASSWORD_REGEX = /^[0-9]{6}$/; // researcher-only rule

export function normalizeUsername(raw: string): string {
  return raw.trim().toLowerCase();
}

export function isValidUsername(raw: string): boolean {
  return USERNAME_REGEX.test(raw.trim());
}

export function toInternalEmail(username: string): string {
  return `${normalizeUsername(username)}@${USERNAME_EMAIL_DOMAIN}`;
}

export function fromInternalEmail(email: string): string | null {
  const suffix = `@${USERNAME_EMAIL_DOMAIN}`;
  if (!email.endsWith(suffix)) return null;
  const id = email.slice(0, -suffix.length);
  return isValidUsername(id) ? id : null;
}
