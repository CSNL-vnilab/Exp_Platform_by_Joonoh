import { NextResponse } from "next/server";
import type { NextRequest } from "next/server";
import { authorizeCronRequest } from "@/lib/auth/cron-secret";
import { processReminders } from "@/lib/services/reminder.service";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

async function handle(request: NextRequest) {
  try {
    if (!authorizeCronRequest(request)) {
      return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
    }
    const processed = await processReminders();
    return NextResponse.json({ ok: true, processed });
  } catch (err) {
    console.error("[RemindersCron] error:", err);
    return NextResponse.json({ error: "Internal server error" }, { status: 500 });
  }
}

// Vercel crons invoke with GET.
export const GET = handle;
// Manual triggers keep using POST.
export const POST = handle;
