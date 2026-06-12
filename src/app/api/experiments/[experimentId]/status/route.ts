import { NextResponse } from "next/server";
import type { NextRequest } from "next/server";
import { z } from "zod/v4";
import { createAdminClient } from "@/lib/supabase/admin";
import { requireExperimentAccess } from "@/lib/auth/experiment-access";
import type {
  ExperimentMode,
  OnlineRuntimeConfig,
} from "@/types/database";
import { createExperimentPage } from "@/lib/notion/client";
import { sendExperimentPublishedEmail } from "@/lib/services/lab-notifications.service";

const statusBodySchema = z.object({
  status: z.enum(["draft", "active", "completed", "cancelled"]),
});

const KNOWN_COUNTERBALANCE_KINDS = [
  "latin_square",
  "block_rotation",
  "random",
] as const;

// Online/hybrid activation readiness check. Returns a Korean error string when
// the experiment is NOT ready to be published, or null when it passes.
//
// This is intentionally a SHAPE-SANITY check, not a full re-validation: the
// zod schema in src/lib/utils/validation.ts (online_runtime_config) already
// rejects malformed config at save time, so config that landed in the row is
// well-formed. Here we only confirm the run-shell can actually start —
// (1) a usable entry_url exists, and (2) IF the researcher claims to have
// configured counterbalancing or attention checks, the stored structure is
// the expected shape (defence-in-depth against a hand-edited/legacy row).
function assertOnlineActivationReady(
  config: OnlineRuntimeConfig | null,
): string | null {
  if (!config) {
    // null config = legacy online row authored before entry_url existed, or a
    // mode-switched offline→online row that was never re-saved. Either way the
    // run-shell has nothing to load.
    return "온라인 실험 코드 주소(entry_url)가 필요합니다. 실험 수정에서 참여자 브라우저가 불러올 .js 파일 주소를 입력해주세요.";
  }

  const entryUrl = config.entry_url?.trim();
  if (!entryUrl || !/^https?:\/\//i.test(entryUrl)) {
    return "온라인 실험 코드 주소(entry_url)가 유효한 http:// 또는 https:// 주소여야 합니다.";
  }

  // Sanity-only: present-but-malformed counterbalance/attention structures
  // (e.g. from a manual DB edit) must not slip past as "ready".
  const spec = config.counterbalance_spec;
  if (spec !== undefined && spec !== null) {
    if (
      typeof spec !== "object" ||
      !KNOWN_COUNTERBALANCE_KINDS.includes(
        (spec as { kind?: string }).kind as (typeof KNOWN_COUNTERBALANCE_KINDS)[number],
      )
    ) {
      return "조건 배정(counterbalance) 설정 형식이 올바르지 않습니다. 실험 수정에서 다시 저장해주세요.";
    }
  }

  const checks = config.attention_checks;
  if (checks !== undefined && checks !== null) {
    if (!Array.isArray(checks)) {
      return "주의검사(attention check) 설정 형식이 올바르지 않습니다. 실험 수정에서 다시 저장해주세요.";
    }
    const malformed = checks.some(
      (c) =>
        !c ||
        typeof c !== "object" ||
        typeof c.position !== "string" ||
        typeof c.correct_answer !== "string" ||
        c.correct_answer.trim().length === 0,
    );
    if (malformed) {
      return "주의검사(attention check) 항목에 위치(position) 또는 정답(correct_answer)이 누락되었습니다. 실험 수정에서 다시 저장해주세요.";
    }
  }

  return null;
}

export async function POST(
  request: NextRequest,
  { params }: { params: Promise<{ experimentId: string }> },
) {
  try {
    const { experimentId } = await params;

    // ownerOnly — admins shouldn't flip a researcher's experiment
    // status (publishes/cancels), matching the pre-helper behavior.
    const access = await requireExperimentAccess(experimentId, {
      ownerOnly: true,
      extraColumns:
        "status, code_repo_url, data_path, experiment_mode, online_runtime_config",
    });
    if (access instanceof NextResponse) return access;
    const { user, supabase } = access;
    const existing = access.experiment as unknown as {
      id: string;
      created_by: string | null;
      status: string | null;
      code_repo_url: string | null;
      data_path: string | null;
      experiment_mode: ExperimentMode | null;
      online_runtime_config: OnlineRuntimeConfig | null;
    };

    const parsed = statusBodySchema.safeParse(await request.json());
    if (!parsed.success) {
      return NextResponse.json(
        { error: "Validation failed", issues: parsed.error.issues },
        { status: 400 },
      );
    }
    const nextStatus = parsed.data.status;

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

      // Online readiness gate (P1-7 / blueprint Step G). The code_repo_url +
      // data_path check above is the OFFLINE invariant and stays required for
      // every mode (cumulative). For online/hybrid we additionally assert the
      // run-shell can actually load and run the study, so a green "ready"
      // signal can't lie: a participant who books an online experiment must
      // reach a real runtime, not a stripped/empty config.
      //
      // online_runtime_config is null on legacy online rows authored before
      // the entry_url field existed — that is exactly "not ready" and is
      // caught by the entry_url check below. Offline rows skip this block
      // entirely, so previously-passing offline activations are unaffected.
      if (existing.experiment_mode && existing.experiment_mode !== "offline") {
        const gateError = assertOnlineActivationReady(
          existing.online_runtime_config,
        );
        if (gateError) {
          return NextResponse.json({ error: gateError }, { status: 400 });
        }
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
