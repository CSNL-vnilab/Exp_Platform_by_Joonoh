import { NextResponse } from "next/server";
import type { NextRequest } from "next/server";
import { timingSafeEqual } from "crypto";
import { processReminders } from "@/lib/services/reminder.service";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

function safeCompare(a: string, b: string): boolean {
  const bufA = Buffer.from(a);
  const bufB = Buffer.from(b);
  if (bufA.length !== bufB.length) return false;
  return timingSafeEqual(bufA, bufB);
}

// Minimum CRON_SECRET entropy — 32 hex = 128 bits.
const MIN_SECRET_LENGTH = 32;

function authorize(request: NextRequest): boolean {
  const expected = (process.env.CRON_SECRET ?? "").trim();
  if (!expected || expected.length < MIN_SECRET_LENGTH) return false;

  // Accept either our custom header (manual triggers / tests)...
  const custom = request.headers.get("x-cron-secret") ?? "";
  if (custom && safeCompare(custom, expected)) return true;

  // ...or the Authorization: Bearer <CRON_SECRET> header Vercel crons send.
  const auth = request.headers.get("authorization") ?? "";
  if (auth.startsWith("Bearer ")) {
    const token = auth.slice(7).trim();
    if (token && safeCompare(token, expected)) return true;
  }

  return false;
}

async function handle(request: NextRequest) {
  try {
    if (!authorize(request)) {
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
