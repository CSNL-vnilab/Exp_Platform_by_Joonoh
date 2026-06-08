import { NextResponse } from "next/server";
import type { NextRequest } from "next/server";
import { createClient } from "@/lib/supabase/server";
import { experimentEditSchema, isValidUUID } from "@/lib/utils/validation";
import { invalidateCalendarCache } from "@/lib/google/freebusy-cache";
import { requireExperimentAccess } from "@/lib/auth/experiment-access";

export async function GET(
  _request: NextRequest,
  { params }: { params: Promise<{ experimentId: string }> }
) {
  try {
    const { experimentId } = await params;

    if (!isValidUUID(experimentId)) {
      return NextResponse.json({ error: "Invalid experiment ID" }, { status: 400 });
    }

    const supabase = await createClient();
    const { data: { user } } = await supabase.auth.getUser();

    const { data: experiment, error } = await supabase
      .from("experiments")
      .select("*")
      .eq("id", experimentId)
      .single();

    if (error || !experiment) {
      return NextResponse.json({ error: "Experiment not found" }, { status: 404 });
    }

    // Public if active; otherwise only the owner may view it
    if (experiment.status !== "active") {
      if (!user || user.id !== experiment.created_by) {
        return NextResponse.json({ error: "Forbidden" }, { status: 403 });
      }
    }

    return NextResponse.json({ experiment });
  } catch (err) {
    return NextResponse.json(
      { error: "Internal server error" },
      { status: 500 }
    );
  }
}

export async function PUT(
  request: NextRequest,
  { params }: { params: Promise<{ experimentId: string }> }
) {
  try {
    const { experimentId } = await params;

    // ownerOnly — admins shouldn't edit a researcher's experiment
    // configuration directly. Matches pre-helper behavior.
    const access = await requireExperimentAccess(experimentId, {
      ownerOnly: true,
    });
    if (access instanceof NextResponse) return access;
    const { supabase } = access;

    const body = await request.json();
    // Accept Notion page URL or bare hex id for notion_project_page_id,
    // normalise before the schema sees it. Same parser as
    // /api/users/[userId]/route.ts — kept inline here to avoid a shared
    // helper churn.
    if (typeof body?.notion_project_page_id === "string") {
      const raw = body.notion_project_page_id.trim();
      if (raw === "") {
        body.notion_project_page_id = null;
      } else {
        let candidate = raw;
        const urlMatch = raw.match(/notion\.so\/[^/]+\/(.+?)(?:[?#]|$)/i);
        if (urlMatch) {
          const segs = urlMatch[1].split(/[-]/);
          candidate = segs[segs.length - 1];
        }
        const hex = candidate.replace(/-/g, "").toLowerCase();
        if (/^[0-9a-f]{32}$/.test(hex)) {
          body.notion_project_page_id = `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20)}`;
        } else {
          return NextResponse.json(
            { error: "notion_project_page_id 형식이 올바르지 않습니다 (URL 또는 32자 hex)" },
            { status: 400 },
          );
        }
      }
    }

    // experimentEditSchema is the partial-safe variant — zod v4 disallows
    // .partial() on the original schema because of its top-level cross-
    // field refine ("online/hybrid mode requires entry_url"). The
    // cross-field check is re-applied below only when BOTH related fields
    // are present in the patch.
    const result = experimentEditSchema.safeParse(body);

    if (!result.success) {
      return NextResponse.json(
        { error: "Validation failed", issues: result.error.issues },
        { status: 400 }
      );
    }

    // Manual re-application of the cross-field rule for the create-path
    // schema. Patches that don't touch experiment_mode + online_runtime_config
    // skip this check entirely (existing-row's mode/runtime are unchanged
    // and were validated at create time).
    if (
      result.data.experiment_mode !== undefined &&
      result.data.experiment_mode !== "offline" &&
      result.data.online_runtime_config !== undefined &&
      !result.data.online_runtime_config?.entry_url
    ) {
      return NextResponse.json(
        {
          error: "Validation failed",
          issues: [{
            path: ["online_runtime_config", "entry_url"],
            message: "온라인/하이브리드 실험은 entry_url이 필요합니다",
          }],
        },
        { status: 400 }
      );
    }

    // CRITICAL — zod v4's .partial() does NOT strip .default() semantics:
    // a `{ is_project: false }` body parses to `{ is_project: false,
    // participation_fee: 0, weekdays: [0..6], reminder_day_of_time:
    // "07:00", session_type: "single", required_sessions: 1, … }` —
    // every field with a default gets materialised. Feeding that into
    // UPDATE clobbers the researcher's configured values.
    //
    // This was the actual cause of the 2026-06-08 bug report
    // ("프로젝트 아님 면제 버튼 클릭시 오류 / 전반적으로 버튼 작동
    // 올바르지 않음"): clicking opt-out reset participation_fee,
    // session_type, weekdays, and tripped the experiments_enforce_online_config
    // trigger when the defaulted experiment_mode mismatched the stored
    // online_runtime_config.
    //
    // Filter to keys actually present in the request body so the
    // UPDATE touches only fields the client explicitly asked to change.
    // Parsed (and possibly normalised — e.g. notion_project_page_id) is
    // used for value; body presence is used as the key gate.
    const requestedKeys =
      body && typeof body === "object" && !Array.isArray(body)
        ? new Set(Object.keys(body as Record<string, unknown>))
        : new Set<string>();
    const updatePayload: Partial<typeof result.data> = {};
    for (const k of Object.keys(result.data) as Array<keyof typeof result.data>) {
      if (requestedKeys.has(k as string)) {
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        (updatePayload as any)[k] = result.data[k];
      }
    }

    if (Object.keys(updatePayload).length === 0) {
      return NextResponse.json(
        { error: "변경할 항목이 없습니다" },
        { status: 400 }
      );
    }

    const { data, error } = await supabase
      .from("experiments")
      .update(updatePayload)
      .eq("id", experimentId)
      .select()
      .single();

    if (error) {
      return NextResponse.json({ error: "처리 중 오류가 발생했습니다" }, { status: 500 });
    }

    if (data.google_calendar_id) {
      invalidateCalendarCache(data.google_calendar_id).catch(() => {});
    }

    return NextResponse.json({ experiment: data });
  } catch (err) {
    return NextResponse.json(
      { error: "Internal server error" },
      { status: 500 }
    );
  }
}

export async function DELETE(
  _request: NextRequest,
  { params }: { params: Promise<{ experimentId: string }> }
) {
  try {
    const { experimentId } = await params;

    // ownerOnly — admins shouldn't permanently delete a researcher's
    // experiment without their consent. Matches pre-helper behavior.
    const access = await requireExperimentAccess(experimentId, {
      ownerOnly: true,
    });
    if (access instanceof NextResponse) return access;
    const { supabase } = access;

    // Hard delete. Cascades through bookings → booking_integrations, reminders,
    // manual_blocks via FK. GCal events created for confirmed bookings are
    // left in place (admin can clean them up in Google Calendar if needed).
    const { data: deleted, error } = await supabase
      .from("experiments")
      .delete()
      .eq("id", experimentId)
      .select("google_calendar_id")
      .single();

    if (error) {
      return NextResponse.json({ error: "삭제 중 오류가 발생했습니다" }, { status: 500 });
    }

    if (deleted?.google_calendar_id) {
      invalidateCalendarCache(deleted.google_calendar_id).catch(() => {});
    }

    return NextResponse.json({ success: true });
  } catch (err) {
    return NextResponse.json(
      { error: "Internal server error" },
      { status: 500 }
    );
  }
}
