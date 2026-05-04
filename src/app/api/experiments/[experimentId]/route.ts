import { NextResponse } from "next/server";
import type { NextRequest } from "next/server";
import { createClient } from "@/lib/supabase/server";
import { experimentEditSchema, isValidUUID } from "@/lib/utils/validation";
import { invalidateCalendarCache } from "@/lib/google/freebusy-cache";

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

    if (!isValidUUID(experimentId)) {
      return NextResponse.json({ error: "Invalid experiment ID" }, { status: 400 });
    }

    const supabase = await createClient();
    const { data: { user }, error: authError } = await supabase.auth.getUser();

    if (authError || !user) {
      return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
    }

    // Verify ownership
    const { data: existing, error: fetchError } = await supabase
      .from("experiments")
      .select("created_by")
      .eq("id", experimentId)
      .single();

    if (fetchError || !existing) {
      return NextResponse.json({ error: "Experiment not found" }, { status: 404 });
    }

    if (existing.created_by !== user.id) {
      return NextResponse.json({ error: "Forbidden" }, { status: 403 });
    }

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

    const { data, error } = await supabase
      .from("experiments")
      .update(result.data)
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

    if (!isValidUUID(experimentId)) {
      return NextResponse.json({ error: "Invalid experiment ID" }, { status: 400 });
    }

    const supabase = await createClient();
    const { data: { user }, error: authError } = await supabase.auth.getUser();

    if (authError || !user) {
      return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
    }

    // Verify ownership
    const { data: existing, error: fetchError } = await supabase
      .from("experiments")
      .select("created_by")
      .eq("id", experimentId)
      .single();

    if (fetchError || !existing) {
      return NextResponse.json({ error: "Experiment not found" }, { status: 404 });
    }

    if (existing.created_by !== user.id) {
      return NextResponse.json({ error: "Forbidden" }, { status: 403 });
    }

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
