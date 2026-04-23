import { notFound } from "next/navigation";
import { requireUser } from "@/lib/auth/role";
import { createAdminClient } from "@/lib/supabase/admin";
import { ensureParticipantLabIdentity } from "@/lib/participants/identity";
import {
  ParticipantDetail,
  type ParticipantDetailData,
} from "@/components/participant-detail";
import type { ParticipantClass } from "@/types/database";

export const dynamic = "force-dynamic";

// Shape of the Supabase `bookings` join used for this page.
interface BookingJoinRow {
  id: string;
  slot_start: string;
  slot_end: string;
  status: string;
  session_number: number;
  subject_number: number | null;
  experiments: { id: string; title: string; lab_id: string } | null;
}

export default async function ParticipantDetailPage({
  params,
}: {
  params: Promise<{ participantId: string }>;
}) {
  const profile = await requireUser();
  const { participantId } = await params;

  const admin = createAdminClient();

  // Participant — 404 cleanly if missing.
  const { data: participant } = await admin
    .from("participants")
    .select("id, name, phone, email, gender, birthdate, created_at")
    .eq("id", participantId)
    .maybeSingle();

  if (!participant) {
    notFound();
  }

  // Resolve the lab via the first booking's experiment. Labs table gives us
  // the human-readable code for the public identifier.
  const { data: bookingRows } = await admin
    .from("bookings")
    .select(
      `id, slot_start, slot_end, status, session_number, subject_number,
       experiments:experiments(id, title, lab_id)`,
    )
    .eq("participant_id", participantId)
    .order("slot_start", { ascending: false });

  const bookingsData = (bookingRows ?? []) as unknown as BookingJoinRow[];

  // Pick the most recent lab for this participant (if any). The participant
  // may have bookings across multiple labs in principle, but the current
  // schema only has one lab. We use the first experiment's lab_id.
  const labId = bookingsData[0]?.experiments?.lab_id ?? null;

  let labCode = "";
  let publicCode = "";

  if (labId) {
    const { data: lab } = await admin
      .from("labs")
      .select("code")
      .eq("id", labId)
      .maybeSingle();
    labCode = lab?.code ?? "";

    // Ensure lab identity exists (idempotent).
    try {
      const { publicCode: pc } = await ensureParticipantLabIdentity(
        participantId,
        labId,
      );
      publicCode = pc;
    } catch {
      // Non-fatal: the UI falls back to an empty code with its own handling.
    }
  } else {
    // Participant has no bookings yet — fall back to the site's default lab
    // (single-lab deployments). If there's exactly one lab, use it.
    const { data: labs } = await admin.from("labs").select("id, code").limit(2);
    if (labs && labs.length === 1) {
      labCode = labs[0].code;
      try {
        const { publicCode: pc } = await ensureParticipantLabIdentity(
          participantId,
          labs[0].id,
        );
        publicCode = pc;
      } catch {
        // ignore
      }
    }
  }

  // Current class row for (participant, lab).
  let currentClass: ParticipantDetailData["class"] = null;
  if (labId) {
    const { data: classRow } = await admin
      .from("participant_classes")
      .select(
        "class, reason, assigned_by, assigned_kind, valid_from, valid_until, completed_count",
      )
      .eq("participant_id", participantId)
      .eq("lab_id", labId)
      .or(`valid_until.is.null,valid_until.gt.${new Date().toISOString()}`)
      .order("valid_from", { ascending: false })
      .limit(1)
      .maybeSingle();

    if (classRow) {
      currentClass = {
        class: classRow.class as ParticipantClass,
        reason: classRow.reason,
        assigned_by: classRow.assigned_by,
        assigned_kind: classRow.assigned_kind,
        valid_from: classRow.valid_from,
        valid_until: classRow.valid_until,
        completed_count: classRow.completed_count,
      };
    }
  }

  // Stats derived from the already-fetched booking list.
  const stats = {
    completed: 0,
    confirmed: 0,
    cancelled: 0,
    no_show: 0,
  };
  for (const b of bookingsData) {
    if (b.status === "completed") stats.completed++;
    else if (b.status === "confirmed") stats.confirmed++;
    else if (b.status === "cancelled") stats.cancelled++;
    else if (b.status === "no_show") stats.no_show++;
  }

  // QC R-C1: strip PII from the RSC payload when the caller isn't admin.
  // Non-admin researchers only see the pseudonymous public_code view.
  const isAdmin = profile.role === "admin";

  // Pull class audit history (QC R-H3) — surfaced as a collapsible card.
  let audit: ParticipantDetailData["audit"] = [];
  if (labId) {
    const { data: auditRows } = await admin
      .from("participant_class_audit" as never)
      .select(
        "previous_class, new_class, reason, changed_kind, changed_by, created_at",
      )
      .eq("participant_id", participantId)
      .eq("lab_id", labId)
      .order("created_at", { ascending: false })
      .limit(50);
    audit = ((auditRows ?? []) as unknown) as ParticipantDetailData["audit"];
  }

  const data: ParticipantDetailData = {
    participant: isAdmin
      ? {
          id: participant.id,
          name: participant.name,
          phone: participant.phone,
          email: participant.email,
          gender: participant.gender,
          birthdate: participant.birthdate,
          created_at: participant.created_at,
        }
      : {
          id: participant.id,
          name: null,
          phone: null,
          email: null,
          gender: null,
          birthdate: null,
          created_at: participant.created_at,
        },
    lab_identity: {
      public_code: publicCode,
      lab_code: labCode,
    },
    class: currentClass,
    bookings: bookingsData.map((b) => ({
      id: b.id,
      experiment_title: b.experiments?.title ?? "(삭제된 실험)",
      experiment_id: b.experiments?.id ?? "",
      slot_start: b.slot_start,
      slot_end: b.slot_end,
      status: b.status,
      session_number: b.session_number,
      subject_number: b.subject_number,
    })),
    stats,
    audit,
  };

  return <ParticipantDetail data={data} role={profile.role} />;
}
