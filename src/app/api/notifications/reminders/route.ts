import { NextResponse } from "next/server";
import type { NextRequest } from "next/server";
import { timingSafeEqual } from "crypto";
import { processReminders } from "@/lib/services/reminder.service";

function safeCompare(a: string, b: string): boolean {
  const bufA = Buffer.from(a);
  const bufB = Buffer.from(b);
  if (bufA.length !== bufB.length) return false;
  return timingSafeEqual(bufA, bufB);
}

export async function POST(request: NextRequest) {
  try {
    const cronSecret = request.headers.get("x-cron-secret") ?? "";
    const expected = process.env.CRON_SECRET ?? "";
    if (!cronSecret || !expected || !safeCompare(cronSecret, expected)) {
      return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
    }

    const processed = await processReminders();
    return NextResponse.json({ processed });
  } catch (err) {
    return NextResponse.json(
      { error: "Internal server error" },
      { status: 500 }
    );
  }
}
