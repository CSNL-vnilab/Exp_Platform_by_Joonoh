import { NextResponse } from "next/server";
import type { NextRequest } from "next/server";
import { createAdminClient } from "@/lib/supabase/admin";
import { bookingRequestSchema, normalizePhone } from "@/lib/utils/validation";
import { BOOKING_ERRORS, BOOKING_RETRY } from "@/lib/utils/constants";
import { runPostBookingPipeline } from "@/lib/services/booking.service";
import { rateLimit } from "@/lib/utils/rate-limit";

// Abuse guard for the ONLY unauthenticated write in the app (creates
// participant PII + real bookings + fires email/SMS = real cost). Per-Lambda
// in-memory (same limiter the 9 other public/token routes use); a distributed
// Postgres-backed limiter is tracked in the future-work blueprint. Keyed on
// both client IP and the participant phone so neither a single IP nor a single
// identity can spam bookings.
const BOOKING_IP_LIMIT = { windowMs: 60_000, max: 10 };
const BOOKING_ID_LIMIT = { windowMs: 60_000, max: 5 };

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

export async function POST(request: NextRequest) {
  try {
    const body = await request.json();
    const result = bookingRequestSchema.safeParse(body);

    if (!result.success) {
      return NextResponse.json(
        { error: "Validation failed", issues: result.error.issues },
        { status: 400 }
      );
    }

    const { experiment_id, participant, slots } = result.data;
    const phone = normalizePhone(participant.phone);

    // Rate-limit before doing any DB work. IP from the standard forwarded
    // header chain; phone as the identity key.
    const ip =
      request.headers.get("x-forwarded-for")?.split(",")[0]?.trim() ||
      request.headers.get("x-real-ip") ||
      "unknown";
    for (const [prefix, key, opts] of [
      ["booking-ip", ip, BOOKING_IP_LIMIT],
      ["booking-id", `${experiment_id}:${phone}`, BOOKING_ID_LIMIT],
    ] as const) {
      const rl = rateLimit(prefix, key, opts);
      if (!rl.allowed) {
        const retryAfter = Math.ceil(rl.retryAfterMs / 1000);
        return NextResponse.json(
          { error: "요청이 너무 잦습니다. 잠시 후 다시 시도해 주세요." },
          { status: 429, headers: { "retry-after": String(retryAfter) } },
        );
      }
    }

    const adminClient = createAdminClient();

    // Cross-study exclusion (online/hybrid, D9 / migration 00045) is enforced
    // solely by the book_slot RPC, which resolves the participant by id and
    // returns EXPERIMENT_EXCLUDED (mapped to a Korean message below). A former
    // app-layer pre-check duplicated this via a phone+email lookup, but the
    // email side compared the raw request value against stored (possibly
    // mixed-case / whitespace-differing) emails — diverging from the RPC's
    // id-based authority and letting the pre-check silently pass or fail on
    // trivial formatting differences. Removed to keep a single source of
    // truth; the RPC still enforces exclusion.

    let lastError: string | null = null;

    for (let attempt = 1; attempt <= BOOKING_RETRY.MAX_ATTEMPTS; attempt++) {
      const { data, error } = await adminClient.rpc("book_slot", {
        p_experiment_id: experiment_id,
        p_participant_name: participant.name,
        p_participant_phone: phone,
        p_participant_email: participant.email,
        p_participant_gender: participant.gender,
        p_participant_birthdate: participant.birthdate,
        p_slots: slots,
      });

      if (error) {
        return NextResponse.json({ error: "예약 처리 중 오류가 발생했습니다" }, { status: 500 });
      }

      // The RPC returns a JSON value — cast to check for application-level errors
      const result = data as { error?: string; booking_ids?: string[] };

      if (!result.error) {
        const rpcResult = data as {
          success: boolean;
          booking_ids: string[];
          booking_group_id: string;
          participant_id: string;
        };

        // On serverless platforms (Vercel) the request process terminates
        // once the response is returned, so we must `await` the pipeline.
        // The outbox rows each land in a terminal state before we reply,
        // giving the client a chance to retry or flag partial failures.
        await runPostBookingPipeline({
          bookingIds: rpcResult.booking_ids,
          bookingGroupId: rpcResult.booking_group_id,
          participantId: rpcResult.participant_id,
          experimentId: experiment_id,
        }).catch((err) => {
          console.error("[Booking] pipeline crashed:", err);
        });

        return NextResponse.json(
          {
            booking_ids: rpcResult.booking_ids,
            booking_group_id: rpcResult.booking_group_id,
          },
          { status: 201 }
        );
      }

      lastError = result.error;

      if (result.error === "SLOT_CONTENTION_RETRY") {
        if (attempt < BOOKING_RETRY.MAX_ATTEMPTS) {
          await sleep(BOOKING_RETRY.BACKOFF_MS);
          continue;
        }
        // Exhausted retries
        return NextResponse.json(
          { error: BOOKING_ERRORS.SLOT_CONTENTION_RETRY },
          { status: 409 }
        );
      }

      // Map known application errors to human-readable messages
      const errorKey = result.error as keyof typeof BOOKING_ERRORS;
      const message = BOOKING_ERRORS[errorKey] ?? result.error;
      const status =
        result.error === "EXPERIMENT_NOT_FOUND"
          ? 404
          : result.error === "PARTICIPANT_BLACKLISTED"
          ? 403
          : result.error === "EXPERIMENT_EXCLUDED" ||
            result.error === "RECRUITMENT_FULL" ||
            result.error === "REGISTRATION_CLOSED"
          ? 409
          : result.error === "DUPLICATE_PARTICIPATION" ||
            result.error === "SLOT_ALREADY_TAKEN" ||
            result.error === "WRONG_SESSION_COUNT"
          ? 409
          : 400;

      return NextResponse.json({ error: message }, { status });
    }

    // Should not be reached, but safety fallback
    return NextResponse.json(
      { error: lastError ?? "Booking failed" },
      { status: 500 }
    );
  } catch {
    return NextResponse.json(
      { error: "Internal server error" },
      { status: 500 }
    );
  }
}
