import { NextResponse } from "next/server";
import type { NextRequest } from "next/server";
import { createClient } from "@/lib/supabase/server";
import { isValidUUID } from "@/lib/utils/validation";
import { getCurrentProfile } from "@/lib/auth/role";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function POST(
  _request: NextRequest,
  { params }: { params: Promise<{ experimentId: string }> },
) {
  const { experimentId } = await params;
  if (!isValidUUID(experimentId)) {
    return NextResponse.json({ error: "잘못된 실험 ID입니다" }, { status: 400 });
  }

  const profile = await getCurrentProfile();
  if (!profile || profile.disabled) {
    return NextResponse.json({ error: "인증이 필요합니다" }, { status: 401 });
  }

  const supabase = await createClient();
  const { data: original, error: fetchError } = await supabase
    .from("experiments")
    .select("*")
    .eq("id", experimentId)
    .single();

  if (fetchError || !original) {
    return NextResponse.json({ error: "원본 실험을 찾을 수 없습니다" }, { status: 404 });
  }

  // Researchers can only duplicate their own experiments; admins can duplicate any.
  if (profile.role !== "admin" && original.created_by !== profile.id) {
    return NextResponse.json({ error: "복사 권한이 없습니다" }, { status: 403 });
  }

  const { data: inserted, error: insertError } = await supabase
    .from("experiments")
    .insert({
      title: `${original.title} (복사본)`,
      description: original.description,
      start_date: original.start_date,
      end_date: original.end_date,
      daily_start_time: original.daily_start_time,
      daily_end_time: original.daily_end_time,
      session_duration_minutes: original.session_duration_minutes,
      break_between_slots_minutes: original.break_between_slots_minutes,
      max_participants_per_slot: original.max_participants_per_slot,
      participation_fee: original.participation_fee,
      session_type: original.session_type,
      required_sessions: original.required_sessions,
      google_calendar_id: original.google_calendar_id,
      irb_document_url: original.irb_document_url,
      precautions: original.precautions,
      status: "draft",
      created_by: profile.id, // transfer ownership to the duplicator
    })
    .select()
    .single();

  if (insertError || !inserted) {
    return NextResponse.json(
      { error: "실험 복사에 실패했습니다" },
      { status: 500 },
    );
  }

  return NextResponse.json({ experiment: inserted }, { status: 201 });
}
