import { createAdminClient } from "@/lib/supabase/admin";
import { ensureParticipantLabIdentity } from "@/lib/participants/identity";

/**
 * Ensure a participant_lab_identity row exists for the participant who owns
 * the given booking. Called from runPostBookingPipeline before Stream C's
 * Notion mirror needs the public_code.
 *
 * Non-blocking by contract: the booking service catches and logs any error
 * so the rest of the pipeline (GCal/Notion/email/SMS) still runs.
 */
export async function backfillIdentityForBooking(
  bookingId: string,
): Promise<{ publicCode: string } | null> {
  const admin = createAdminClient();

  const { data: booking, error } = await admin
    .from("bookings")
    .select("participant_id, experiments(lab_id)")
    .eq("id", bookingId)
    .maybeSingle();

  if (error || !booking) {
    console.error(
      `[ParticipantIdentity] booking ${bookingId} not found:`,
      error?.message,
    );
    return null;
  }

  const participantId = booking.participant_id;
  const exp = booking.experiments as { lab_id: string | null } | null;
  const labId = exp?.lab_id ?? null;

  if (!participantId || !labId) {
    console.error(
      `[ParticipantIdentity] booking ${bookingId} missing participant_id or lab_id`,
    );
    return null;
  }

  return ensureParticipantLabIdentity(participantId, labId);
}
