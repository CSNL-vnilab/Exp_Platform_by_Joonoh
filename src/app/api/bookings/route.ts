import { NextResponse } from "next/server";
import type { NextRequest } from "next/server";
import { createAdminClient } from "@/lib/supabase/admin";
import { bookingRequestSchema, normalizePhone } from "@/lib/utils/validation";
import { BOOKING_ERRORS, BOOKING_RETRY } from "@/lib/utils/constants";
import { runPostBookingPipeline } from "@/lib/services/booking.service";

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

    const adminClient = createAdminClient();

    // Online/hybrid experiment cross-study exclusion (phase 2 follow-up):
    // refuse the booking if this participant has any prior bookings on
    // experiments listed in online_runtime_config.exclude_experiment_ids.
    // Offline experiments ignore this — they never populate the field.
    {
      const { data: exp } = await adminClient
        .from("experiments")
        .select("experiment_mode, online_runtime_config")
        .eq("id", experiment_id)
        .maybeSingle();
      const cfg = exp?.online_runtime_config as
        | { exclude_experiment_ids?: string[] }
        | null;
      const excludeIds = cfg?.exclude_experiment_ids ?? [];
      if (
        exp &&
        exp.experiment_mode !== "offline" &&
        excludeIds.length > 0
      ) {
        const { data: prior } = await adminClient
          .from("bookings")
          .select("id, participants!inner(phone, email)")
          .in("experiment_id", excludeIds)
          .in("status", ["confirmed", "running", "completed"])
          .eq("participants.phone", phone)
          .eq("participants.email", participant.email)
          .limit(1);
        if (prior && prior.length > 0) {
          // Unified with the DB-layer EXPERIMENT_EXCLUDED message (D9,
          // migration 00045). App-layer check stays as a fast-path /
          // defense-in-depth ahead of the RPC.
          return NextResponse.json(
            { error: BOOKING_ERRORS.EXPERIMENT_EXCLUDED },
            { status: 409 },
          );
        }
      }
    }

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
          : result.error === "EXPERIMENT_EXCLUDED"
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
  } catch (err) {
    return NextResponse.json(
      { error: "Internal server error" },
      { status: 500 }
    );
  }
}
