import { NextResponse } from "next/server";
import type { NextRequest } from "next/server";
import { timingSafeEqual } from "crypto";
import { createAdminClient } from "@/lib/supabase/admin";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

// Auto-complete cron. Runs nightly. For every `confirmed` booking whose
// slot_end is older than the configured grace period (default 7d), flips
// status → 'completed' and stamps auto_completed_at. The bookings-status
// trigger then recomputes the participant's class in the experiment's lab.
//
// Grace period exists so researchers have time to tick post-survey first —
// which would set completed explicitly (attested) and bypass the auto path.
// `auto_completed_at` lets analytics distinguish attested vs auto.

function safeCompare(a: string, b: string): boolean {
  const bufA = Buffer.from(a);
  const bufB = Buffer.from(b);
  if (bufA.length !== bufB.length) return false;
  return timingSafeEqual(bufA, bufB);
}

// Minimum CRON_SECRET entropy — 32 hex = 128 bits. timingSafeEqual on
// a 1-byte secret is degenerate; enforce a floor.
const MIN_SECRET_LENGTH = 32;

function authorize(request: NextRequest): boolean {
  const expected = (process.env.CRON_SECRET ?? "").trim();
  if (!expected || expected.length < MIN_SECRET_LENGTH) return false;

  const custom = request.headers.get("x-cron-secret") ?? "";
  if (custom && safeCompare(custom, expected)) return true;

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

    const url = new URL(request.url);
    const graceRaw = url.searchParams.get("grace_days");
    const graceDays = graceRaw
      ? Math.max(0, Math.min(90, Number.parseInt(graceRaw, 10) || 7))
      : 7;

    const admin = createAdminClient();
    const { data, error } = await admin.rpc("auto_complete_stale_bookings", {
      p_grace_days: graceDays,
    });

    if (error) {
      console.error("[AutoCompleteCron] rpc error:", error.message);
      return NextResponse.json(
        { error: "RPC failed", detail: error.message },
        { status: 500 },
      );
    }

    return NextResponse.json({ ok: true, grace_days: graceDays, completed: data ?? 0 });
  } catch (err) {
    console.error("[AutoCompleteCron] error:", err);
    return NextResponse.json({ error: "Internal server error" }, { status: 500 });
  }
}

export const GET = handle;
export const POST = handle;
