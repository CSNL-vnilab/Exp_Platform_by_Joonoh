import { NextResponse } from "next/server";
import type { NextRequest } from "next/server";
import { createClient } from "@/lib/supabase/server";
import { isValidUUID } from "@/lib/utils/validation";
import { getCurrentProfile } from "@/lib/auth/role";
import type { Database } from "@/types/database";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

type ExperimentRow = Database["public"]["Tables"]["experiments"]["Row"];
type ExperimentInsert = Database["public"]["Tables"]["experiments"]["Insert"];

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

  // Reset any per-session state on the duplicated checklist — the copy is
  // a fresh experiment, researcher must tick items again before bookings open.
  const copiedChecklist = (original.pre_experiment_checklist ?? []).map(
    (item) => ({
      item: item.item,
      required: item.required,
      checked: false,
      checked_at: null,
    }),
  );

  // Copy-all-then-strip. Start from the *entire* original row so every
  // experiment-level setting is carried automatically (experiment_mode,
  // online_runtime_config, data_consent_required, protocol_version,
  // offline_code_analysis, location, …). A hand-maintained allowlist used
  // to drop new columns silently — that was the original bug. Only fields
  // that must be regenerated, or that belong to 예약 현황 / per-session
  // state, are stripped or overridden below.
  const draft = { ...original } as Partial<ExperimentRow>;
  // DB-generated identity & timestamps.
  delete draft.id;
  delete draft.created_at;
  delete draft.updated_at;
  // Notion mirror state — the copy mirrors to its own fresh Notion pages on
  // its first activation; carrying these would point it at the original's.
  delete draft.notion_experiment_page_id;
  delete draft.notion_experiment_sync_attempted_at;
  delete draft.notion_project_page_id;

  const insertPayload: ExperimentInsert = {
    ...(draft as ExperimentInsert),
    title: `${original.title} (복사본)`,
    status: "draft",
    created_by: profile.id, // transfer ownership to the duplicator
    pre_experiment_checklist: copiedChecklist,
    checklist_completed_at: null,
  };

  const { data: inserted, error: insertError } = await supabase
    .from("experiments")
    .insert(insertPayload)
    .select()
    .single();

  if (insertError || !inserted) {
    return NextResponse.json(
      { error: "실험 복사에 실패했습니다" },
      { status: 500 },
    );
  }

  // Copy experiment *configuration* children (recruitment + scheduling setup),
  // but NOT 예약 현황: bookings and everything keyed off a booking
  // (booking_integrations, reminders, screener responses, run progress) are
  // intentionally left out so the copy opens with no reservations.
  //
  // No multi-statement transaction is available through the JS client, so on
  // any child-copy failure we delete the freshly inserted experiment (its
  // children cascade) and report the failure rather than leaving a
  // half-copied experiment behind.
  const rollback = async () => {
    await supabase.from("experiments").delete().eq("id", inserted.id);
  };

  // Online screeners = recruitment criteria. Without these a copied online
  // experiment would lose its entire screening flow.
  const { data: screeners, error: screenerFetchError } = await supabase
    .from("experiment_online_screeners")
    .select("position, kind, question, help_text, validation_config, required")
    .eq("experiment_id", experimentId)
    .order("position", { ascending: true });

  if (screenerFetchError) {
    await rollback();
    return NextResponse.json(
      { error: "실험 복사에 실패했습니다 (선별 문항)" },
      { status: 500 },
    );
  }

  if (screeners && screeners.length > 0) {
    const { error: screenerInsertError } = await supabase
      .from("experiment_online_screeners")
      .insert(
        screeners.map((s) => ({ ...s, experiment_id: inserted.id })),
      );
    if (screenerInsertError) {
      await rollback();
      return NextResponse.json(
        { error: "실험 복사에 실패했습니다 (선별 문항)" },
        { status: 500 },
      );
    }
  }

  // Manual blocks = researcher-defined busy intervals (scheduling setup,
  // not reservations).
  const { data: blocks, error: blockFetchError } = await supabase
    .from("experiment_manual_blocks")
    .select("block_start, block_end, reason")
    .eq("experiment_id", experimentId);

  if (blockFetchError) {
    await rollback();
    return NextResponse.json(
      { error: "실험 복사에 실패했습니다 (차단 시간대)" },
      { status: 500 },
    );
  }

  if (blocks && blocks.length > 0) {
    const { error: blockInsertError } = await supabase
      .from("experiment_manual_blocks")
      .insert(
        blocks.map((b) => ({
          ...b,
          experiment_id: inserted.id,
          created_by: profile.id,
        })),
      );
    if (blockInsertError) {
      await rollback();
      return NextResponse.json(
        { error: "실험 복사에 실패했습니다 (차단 시간대)" },
        { status: 500 },
      );
    }
  }

  return NextResponse.json({ experiment: inserted }, { status: 201 });
}
