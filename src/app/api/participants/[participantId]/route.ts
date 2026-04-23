import { NextResponse } from "next/server";
import type { NextRequest } from "next/server";
import { createClient } from "@/lib/supabase/server";
import { createAdminClient } from "@/lib/supabase/admin";
import { isValidUUID } from "@/lib/utils/validation";
import type {
  Booking,
  Participant,
  ParticipantClass,
  ParticipantClassRow,
} from "@/types/database";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

// Default lab for single-tenant CSNL deployment. The migration always
// backfills experiments.lab_id to CSNL, so this is also what every booking
// implicitly belongs to — surface it in the participant detail view.
const DEFAULT_LAB_CODE = "CSNL";

interface BookingJoinRow {
  id: string;
  experiment_id: string;
  slot_start: string;
  slot_end: string;
  status: Booking["status"];
  session_number: number;
  subject_number: number | null;
  experiments: { title: string; lab_id: string } | null;
}

export async function GET(
  _request: NextRequest,
  { params }: { params: Promise<{ participantId: string }> },
) {
  try {
    const { participantId } = await params;
    if (!isValidUUID(participantId)) {
      return NextResponse.json(
        { error: "Invalid participant ID" },
        { status: 400 },
      );
    }

    const supabase = await createClient();
    const {
      data: { user },
      error: authError,
    } = await supabase.auth.getUser();
    if (authError || !user) {
      return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
    }

    // Role gate: non-admin researchers never receive PII (QC C1). They only
    // see the pseudonymous public_code + aggregate stats + class.
    const admin = createAdminClient();
    const { data: roleRow } = await admin
      .from("profiles")
      .select("role")
      .eq("id", user.id)
      .maybeSingle();
    const isAdmin = roleRow?.role === "admin";

    // Cookie-bound read: RLS decides whether this user may see the participant.
    // For non-admins we only fetch id/created_at — name/phone/email/etc. never
    // make it into the response body.
    const piiCols = "id, name, phone, email, gender, birthdate, created_at";
    const safeCols = "id, created_at";
    const { data: participant, error: pErr } = await supabase
      .from("participants")
      .select(isAdmin ? piiCols : safeCols)
      .eq("id", participantId)
      .maybeSingle();

    if (pErr || !participant) {
      return NextResponse.json(
        { error: "참여자를 찾을 수 없습니다" },
        { status: 404 },
      );
    }

    // Lab id for CSNL. Stream A always seeds CSNL; look it up so multi-lab
    // expansion can drive by query param later.
    const { data: lab } = await admin
      .from("labs")
      .select("id, code")
      .eq("code", DEFAULT_LAB_CODE)
      .maybeSingle();

    // Current class (RLS-gated read).
    let currentClass: ParticipantClassRow | null = null;
    if (lab?.id) {
      const { data: classRow } = await supabase
        .from("participant_classes")
        .select("*")
        .eq("participant_id", participantId)
        .eq("lab_id", lab.id)
        .or(
          "valid_until.is.null,valid_until.gt." + new Date().toISOString(),
        )
        .order("valid_from", { ascending: false })
        .limit(1)
        .maybeSingle();
      currentClass = (classRow as ParticipantClassRow | null) ?? null;
    }

    // Public code (service-role read — identity_hmac is admin-only).
    let labIdentity: { public_code: string; lab_code: string } | null = null;
    if (lab?.id) {
      const { data: idRow } = await admin
        .from("participant_lab_identity")
        .select("public_code")
        .eq("participant_id", participantId)
        .eq("lab_id", lab.id)
        .maybeSingle();
      if (idRow?.public_code) {
        labIdentity = {
          public_code: idRow.public_code,
          lab_code: lab.code,
        };
      }
    }

    // Bookings + experiment title (RLS-gated).
    const { data: bookingRows } = await supabase
      .from("bookings")
      .select(
        "id, experiment_id, slot_start, slot_end, status, session_number, subject_number, experiments(title, lab_id)",
      )
      .eq("participant_id", participantId)
      .order("slot_start", { ascending: false });

    const bookings = (bookingRows ?? []) as unknown as BookingJoinRow[];

    const bookingsOut = bookings.map((b) => ({
      id: b.id,
      experiment_id: b.experiment_id,
      experiment_title: b.experiments?.title ?? null,
      slot_start: b.slot_start,
      slot_end: b.slot_end,
      status: b.status,
      session_number: b.session_number,
      subject_number: b.subject_number,
    }));

    // Aggregates — count across all bookings (not just the current lab) so
    // the UI can show the participant's full history.
    const stats = {
      completed: 0,
      confirmed: 0,
      cancelled: 0,
      no_show: 0,
    };
    for (const b of bookings) {
      switch (b.status) {
        case "completed":
          stats.completed += 1;
          break;
        case "confirmed":
          stats.confirmed += 1;
          break;
        case "cancelled":
          stats.cancelled += 1;
          break;
        case "no_show":
          stats.no_show += 1;
          break;
        default:
          break;
      }
    }

    // QC R-H3: surface the class change history so the researcher can see
    // when/why a class flipped (especially for blacklists). Read via admin
    // client — participant_class_audit has SELECT RLS but writes are
    // SECURITY DEFINER, so admin client is safe.
    let audit: Array<{
      previous_class: ParticipantClass | null;
      new_class: ParticipantClass;
      reason: string | null;
      changed_kind: "auto" | "manual";
      changed_by: string | null;
      created_at: string;
    }> = [];
    if (lab?.id) {
      const { data: auditRows } = await admin
        .from("participant_class_audit" as never)
        .select(
          "previous_class, new_class, reason, changed_kind, changed_by, created_at",
        )
        .eq("participant_id", participantId)
        .eq("lab_id", lab.id)
        .order("created_at", { ascending: false })
        .limit(50);
      audit = ((auditRows ?? []) as unknown) as typeof audit;
    }

    // Conditionally strip PII for non-admin researchers before returning.
    // Supabase's select() literal parser narrows to PostgrestError shapes
    // when given a variable, so cast through unknown.
    const participantAny = participant as unknown as Participant;
    const participantOut = isAdmin
      ? participantAny
      : {
          id: participantAny.id,
          created_at: participantAny.created_at,
        };

    return NextResponse.json({
      participant: participantOut,
      lab_identity: labIdentity,
      class: currentClass
        ? {
            class: currentClass.class as ParticipantClass,
            reason: currentClass.reason,
            assigned_by: currentClass.assigned_by,
            assigned_kind: currentClass.assigned_kind,
            valid_from: currentClass.valid_from,
            valid_until: currentClass.valid_until,
            completed_count: currentClass.completed_count,
          }
        : null,
      bookings: bookingsOut,
      stats,
      audit,
    });
  } catch (err) {
    console.error("[Participant GET] failed:", err);
    return NextResponse.json(
      { error: "Internal server error" },
      { status: 500 },
    );
  }
}
