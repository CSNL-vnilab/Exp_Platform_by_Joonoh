import { redirect } from "next/navigation";
import { createClient } from "@/lib/supabase/server";
import type { Profile, UserRole } from "@/types/database";

export async function getCurrentUser() {
  const supabase = await createClient();
  const { data: { user } } = await supabase.auth.getUser();
  return user;
}

export async function getCurrentProfile(): Promise<Profile | null> {
  const supabase = await createClient();
  const { data: { user } } = await supabase.auth.getUser();
  if (!user) return null;

  const { data } = await supabase
    .from("profiles")
    .select("*")
    .eq("id", user.id)
    .single();

  return data ?? null;
}

export async function requireUser(loginPath = "/login"): Promise<Profile> {
  const profile = await getCurrentProfile();
  if (!profile || profile.disabled) {
    redirect(loginPath);
  }
  return profile;
}

export async function requireAdmin(redirectPath = "/dashboard"): Promise<Profile> {
  const profile = await requireUser();
  if (profile.role !== "admin") {
    redirect(redirectPath);
  }
  return profile;
}

export function hasRole(profile: Profile | null, role: UserRole): boolean {
  return profile?.role === role && !profile.disabled;
}

// API-route variants — return the profile or null instead of redirect().
// Inside a route handler, redirect() emits a 307 HTML redirect (not JSON),
// which fetch-based callers misreport. Use these where a 401/403 JSON
// response is wanted: the caller checks for null and responds itself.

/** Active (non-disabled) user, or null. Caller responds 401 on null. */
export async function requireUserApi(): Promise<Profile | null> {
  const profile = await getCurrentProfile();
  if (!profile || profile.disabled) return null;
  return profile;
}

/** Active admin, or null. Caller responds 401/403 on null. */
export async function requireAdminApi(): Promise<Profile | null> {
  const profile = await getCurrentProfile();
  if (!profile || profile.disabled || profile.role !== "admin") return null;
  return profile;
}
