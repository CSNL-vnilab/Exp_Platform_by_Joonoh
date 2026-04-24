import { NextResponse } from "next/server";
import type { NextRequest } from "next/server";
import { z } from "zod/v4";
import { createClient } from "@/lib/supabase/server";
import { createAdminClient } from "@/lib/supabase/admin";
import { isValidUUID } from "@/lib/utils/validation";
import { createExperimentPage } from "@/lib/notion/client";
import { sendExperimentPublishedEmail } from "@/lib/services/lab-notifications.service";

const statusBodySchema = z.object({
  status: z.enum(["draft", "active", "completed", "cancelled"]),
});

export async function POST(
  request: NextRequest,
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

    const parsed = statusBodySchema.safeParse(await request.json());
    if (!parsed.success) {
      return NextResponse.json(
        { error: "Validation failed", issues: parsed.error.issues },
        { status: 400 },
      );
    }
    const nextStatus = parsed.data.status;

    const { data: existing, error: fetchError } = await supabase
      .from("experiments")
      .select("*")
      .eq("id", experimentId)
      .single();
    if (fetchError || !existing) {
      return NextResponse.json({ error: "Experiment not found" }, { status: 404 });
    }
    if (existing.created_by !== user.id) {
      return NextResponse.json({ error: "Forbidden" }, { status: 403 });
    }

    const wasActive = existing.status === "active";

    // Enforce regardless of previous status: completed→active and cancelled→
    // active must satisfy the same metadata invariant as draft→active.
    if (nextStatus === "active") {
      if (!existing.code_repo_url?.trim() || !existing.data_path?.trim()) {
        return NextResponse.json(
          {
            error:
              "코드 저장소(code_repo_url)와 데이터 경로(data_path)가 모두 필요합니다.",
          },
          { status: 400 },
        );
      }
    }

    const { data: updated, error: updateError } = await supabase
      .from("experiments")
      .update({ status: nextStatus })
      .eq("id", experimentId)
      .select("*")
      .single();
    if (updateError || !updated) {
      return NextResponse.json(
        { error: updateError?.message ?? "상태 변경 실패" },
        { status: 500 },
      );
    }

    let notionSynced = false;
    let notionError: string | null = null;

    // Only mirror on the first-ever activation (wasActive === false). A
    // previously-active experiment already has its Notion page; subsequent
    // reactivations reuse it.
    if (
      !wasActive &&
      nextStatus === "active" &&
      !updated.notion_experiment_page_id &&
      process.env.NOTION_API_KEY
    ) {
      const admin = createAdminClient();

      // Mark the attempt BEFORE calling Notion, so that if the network drops
      // between page-create and page-id writeback, a retry knows to skip.
      // (The actual page id is written in the same follow-up update.)
      const attemptedAt = new Date().toISOString();
      await admin
        .from("experiments")
        .update({ notion_experiment_sync_attempted_at: attemptedAt })
        .eq("id", experimentId);

      try {
        const { data: profile } = await admin
          .from("profiles")
          .select("display_name, notion_member_page_id")
          .eq("id", user.id)
          .maybeSingle();

        const pageId = await createExperimentPage({
          experimentTitle: updated.title,
          projectName: updated.project_name ?? null,
          codeRepoUrl: updated.code_repo_url ?? "",
          dataPath: updated.data_path ?? "",
          parameterSchema: updated.parameter_schema ?? [],
          checklist: updated.pre_experiment_checklist ?? [],
          startDate: updated.start_date,
          endDate: updated.end_date,
          researcherName: profile?.display_name ?? null,
          status: "확정",
          protocolVersion: updated.protocol_version ?? null,
          researcherMemberPageId:
            (profile as { notion_member_page_id?: string | null } | null)
              ?.notion_member_page_id ?? null,
          projectPageId: updated.notion_project_page_id ?? null,
        });

        if (pageId) {
          await admin
            .from("experiments")
            .update({ notion_experiment_page_id: pageId })
            .eq("id", experimentId);
          notionSynced = true;
        }
      } catch (err) {
        notionError = err instanceof Error ? err.message : "Notion sync failed";
      }
    }

    // Lab-wide announcement — fire only on the first activation so
    // draft↔active toggles don't spam the lab. Fire-and-forget for the
    // same reason the Notion sync is: we don't want a flaky SMTP step
    // to undo a successful status change.
    if (!wasActive && nextStatus === "active") {
      const admin = createAdminClient();
      sendExperimentPublishedEmail(admin, {
        id: updated.id,
        title: updated.title,
        project_name: updated.project_name ?? null,
        start_date: updated.start_date,
        end_date: updated.end_date,
        daily_start_time: updated.daily_start_time,
        daily_end_time: updated.daily_end_time,
        weekdays: updated.weekdays ?? null,
        session_duration_minutes: updated.session_duration_minutes,
        session_type: updated.session_type as "single" | "multi",
        required_sessions: updated.required_sessions,
        participation_fee: updated.participation_fee,
        description: updated.description ?? null,
        experiment_mode: updated.experiment_mode as
          | "offline"
          | "online"
          | "hybrid",
        created_by: updated.created_by ?? null,
      }).catch((err) => {
        console.error(
          "[Status] experiment-published email fire-and-forget failed:",
          err instanceof Error ? err.message : err,
        );
      });
    }

    return NextResponse.json({
      experiment: updated,
      notion_synced: notionSynced,
      notion_error: notionError,
    });
  } catch (err) {
    return NextResponse.json(
      { error: err instanceof Error ? err.message : "Internal server error" },
      { status: 500 },
    );
  }
}
