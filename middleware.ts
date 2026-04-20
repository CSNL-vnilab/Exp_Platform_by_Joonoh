import { type NextRequest } from "next/server";
import { updateSession } from "@/lib/supabase/proxy";

export async function middleware(request: NextRequest) {
  return await updateSession(request);
}

export const config = {
  matcher: [
    // Match all routes except static files and API routes that don't need session
    "/((?!_next/static|_next/image|favicon.ico|api/bookings$|api/notifications).*)",
  ],
};
