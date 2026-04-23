import { createClient } from "@/lib/supabase/server";
import type { ParticipantClass, ParticipantClassRow } from "@/types/database";

// Korean labels surfaced in list badges, participant detail, audit trail.
export const CLASS_LABELS_KR: Record<ParticipantClass, string> = {
  newbie: "뉴비",
  royal: "로열",
  blacklist: "블랙리스트",
  vip: "VIP",
};

// Visual treatment keys — mapped by the UI layer to actual CSS classes.
export const CLASS_COLORS: Record<
  ParticipantClass,
  "default" | "info" | "success" | "danger"
> = {
  newbie: "default",
  royal: "success",
  blacklist: "danger",
  vip: "info",
};

// Audit row shape — matches 00025.participant_class_audit. Kept locally
// since the generated Database type doesn't expose the table yet.
export interface ParticipantClassAuditRow {
  id: string;
  participant_id: string;
  lab_id: string;
  previous_class: ParticipantClass | null;
  new_class: ParticipantClass;
  reason: string | null;
  completed_count: number | null;
  changed_by: string | null;
  changed_kind: "auto" | "manual";
  created_at: string;
}

/**
 * Latest effective class for a participant in the given lab. Reads through
 * the cookie-bound client so RLS continues to gate access.
 */
export async function getCurrentClass(
  participantId: string,
  labId: string,
): Promise<ParticipantClassRow | null> {
  const supabase = await createClient();
  const { data } = await supabase
    .from("participant_classes")
    .select("*")
    .eq("participant_id", participantId)
    .eq("lab_id", labId)
    .or("valid_until.is.null,valid_until.gt." + new Date().toISOString())
    .order("valid_from", { ascending: false })
    .limit(1)
    .maybeSingle();

  return (data as ParticipantClassRow | null) ?? null;
}

/**
 * Full audit trail, newest-first. Surfaces every auto and manual transition
 * for the researcher UI.
 */
export async function listAuditTrail(
  participantId: string,
  labId: string,
): Promise<ParticipantClassAuditRow[]> {
  const supabase = await createClient();
  const { data } = await supabase
    .from(
      // participant_class_audit isn't in Database yet — cast to any-shaped
      // generic is unsafe; we pin the return type via the explicit interface.
      "participant_class_audit" as never,
    )
    .select("*")
    .eq("participant_id", participantId)
    .eq("lab_id", labId)
    .order("created_at", { ascending: false });

  return ((data ?? []) as unknown as ParticipantClassAuditRow[]);
}
