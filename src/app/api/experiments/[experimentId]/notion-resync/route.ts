import { NextResponse } from "next/server";
import type { NextRequest } from "next/server";
import { createClient } from "@/lib/supabase/server";
import { createAdminClient } from "@/lib/supabase/admin";
import { isValidUUID } from "@/lib/utils/validation";
import { createExperimentPage } from "@/lib/notion/client";

// Researcher-triggered retry for the experiment-level Notion mirror.
//
// When /api/experiments/[id]/status flips draft→active, it tries to
// createExperimentPage() and writes the resulting page_id onto the row. If
// that fails (Notion down, template mismatch, writeback interrupted), the
// status flips anyway but notion_experiment_page_id stays null while
// notion_experiment_sync_attempted_at is set. The dashboard surfaces a
// retry banner; POST here re-runs the Notion call without touching
// experiment status.
//
// Idempotency: we short-circuit if notion_experiment_page_id already
// exists (a concurrent call won the race) so retries never duplicate.

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function POST(
  _request: NextRequest,
  { params }: { params: Promise<{ experimentId: string }> },
) {
  try {
    const { experimentId } = await params;
    if (!isValidUUID(experimentId)) {
      return NextResponse.json({ error: "Invalid experiment ID" }, { status: 400 });
    }

    const supabase = await createClient();
    const {
      data: { user },
      error: authError,
    } = await supabase.auth.getUser();
    if (authError || !user) {
      return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
    }

    const admin = createAdminClient();
    const { data: existing } = await admin
      .from("experiments")
      .select("*")
      .eq("id", experimentId)
      .maybeSingle();
    if (!existing) {
      return NextResponse.json({ error: "Experiment not found" }, { status: 404 });
    }
    if (existing.created_by !== user.id) {
      // Admin override — check profile role.
      const { data: profile } = await admin
        .from("profiles")
        .select("role")
        .eq("id", user.id)
        .maybeSingle();
      if (profile?.role !== "admin") {
        return NextResponse.json({ error: "Forbidden" }, { status: 403 });
      }
    }

    if (!process.env.NOTION_API_KEY) {
      return NextResponse.json(
        { error: "NOTION_API_KEY가 설정되지 않았습니다." },
        { status: 400 },
      );
    }

    if (existing.notion_experiment_page_id) {
      return NextResponse.json({
        notion_synced: true,
        notion_page_id: existing.notion_experiment_page_id,
        note: "이미 동기화된 실험입니다.",
      });
    }

    if (existing.status !== "active") {
      return NextResponse.json(
        { error: "active 상태의 실험만 Notion에 동기화됩니다." },
        { status: 400 },
      );
    }

    if (!existing.code_repo_url?.trim() || !existing.data_path?.trim()) {
      return NextResponse.json(
        {
          error:
            "코드 저장소와 데이터 경로가 설정되어야 Notion 동기화가 가능합니다.",
        },
        { status: 400 },
      );
    }

    // Stamp the attempt timestamp BEFORE the Notion call so retries after a
    // broken writeback know an attempt already happened.
    await admin
      .from("experiments")
      .update({ notion_experiment_sync_attempted_at: new Date().toISOString() })
      .eq("id", experimentId);

    const { data: profile } = await admin
      .from("profiles")
      .select("display_name, notion_member_page_id")
      .eq("id", existing.created_by ?? user.id)
      .maybeSingle();

    try {
      const pageId = await createExperimentPage({
        experimentTitle: existing.title,
        projectName: existing.project_name ?? null,
        codeRepoUrl: existing.code_repo_url ?? "",
        dataPath: existing.data_path ?? "",
        parameterSchema: existing.parameter_schema ?? [],
        checklist: existing.pre_experiment_checklist ?? [],
        startDate: existing.start_date,
        endDate: existing.end_date,
        researcherName: profile?.display_name ?? null,
        status: "확정",
        protocolVersion: existing.protocol_version ?? null,
        researcherMemberPageId:
          (profile as { notion_member_page_id?: string | null } | null)
            ?.notion_member_page_id ?? null,
        projectPageId: existing.notion_project_page_id ?? null,
      });

      if (!pageId) {
        return NextResponse.json(
          { error: "Notion 클라이언트가 페이지 id를 반환하지 않았습니다." },
          { status: 500 },
        );
      }

      await admin
        .from("experiments")
        .update({ notion_experiment_page_id: pageId })
        .eq("id", experimentId);

      return NextResponse.json({
        notion_synced: true,
        notion_page_id: pageId,
      });
    } catch (err) {
      const msg = err instanceof Error ? err.message : "Notion sync failed";
      console.error("[Notion resync] failed:", msg);
      return NextResponse.json(
        { notion_synced: false, notion_error: msg.slice(0, 500) },
        { status: 502 },
      );
    }
  } catch (err) {
    return NextResponse.json(
      { error: err instanceof Error ? err.message : "Internal server error" },
      { status: 500 },
    );
  }
}
