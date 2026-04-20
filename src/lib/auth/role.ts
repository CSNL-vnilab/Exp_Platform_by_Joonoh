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
