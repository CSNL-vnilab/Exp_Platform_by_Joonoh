import { createBrowserClient } from "@supabase/ssr";
import type { Database } from "@/types/database";

// Trim env values — the deployed Vercel project has a trailing newline on
// NEXT_PUBLIC_SUPABASE_ANON_KEY which gets URL-encoded as %0A in the
// realtime websocket URL, making Supabase reject the JWT and silently
// killing every postgres_changes subscription (notably /live's session
// dashboard). Trimming in code lets us recover without a Vercel env edit.
export function createClient() {
  return createBrowserClient<Database>(
    process.env.NEXT_PUBLIC_SUPABASE_URL!.trim(),
    process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY!.trim()
  );
}
