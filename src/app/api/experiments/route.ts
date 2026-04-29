import { NextResponse } from "next/server";
import type { NextRequest } from "next/server";
import { createClient } from "@/lib/supabase/server";
import { experimentSchema } from "@/lib/utils/validation";
import { invalidateCalendarCache } from "@/lib/google/freebusy-cache";
import type { Experiment } from "@/types/database";

type ExperimentStatus = Experiment["status"];

export async function GET(request: NextRequest) {
  try {
    const supabase = await createClient();
    const { data: { user } } = await supabase.auth.getUser();

    const { searchParams } = request.nextUrl;
    const statusParam = searchParams.get("status");
    const validStatuses: ExperimentStatus[] = ["draft", "active", "completed", "cancelled"];
    const statusFilter = validStatuses.includes(statusParam as ExperimentStatus)
      ? (statusParam as ExperimentStatus)
      : null;

    let query = supabase.from("experiments").select("*");

    if (user) {
      // Authenticated: return all their own experiments
      query = query.eq("created_by", user.id);
      if (statusFilter) {
        query = query.eq("status", statusFilter);
      }
    } else {
      // Unauthenticated: only active experiments
      query = query.eq("status", "active");
    }

    const { data, error } = await query.order("created_at", { ascending: false });

    if (error) {
      return NextResponse.json({ error: "데이터를 불러오는 중 오류가 발생했습니다" }, { status: 500 });
    }

    return NextResponse.json({ experiments: data });
  } catch (err) {
    return NextResponse.json(
      { error: "Internal server error" },
      { status: 500 }
    );
  }
}

export async function POST(request: NextRequest) {
  try {
    const supabase = await createClient();
    const { data: { user }, error: authError } = await supabase.auth.getUser();

    if (authError || !user) {
      return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
    }

    const body = await request.json();
    const result = experimentSchema.safeParse(body);

    if (!result.success) {
      return NextResponse.json(
        { error: "Validation failed", issues: result.error.issues },
        { status: 400 }
      );
    }

    const { data: labRow, error: labError } = await supabase
      .from("labs")
      .select("id")
      .limit(1)
      .maybeSingle();

    if (labError || !labRow?.id) {
      return NextResponse.json(
        { error: "Lab 설정을 찾을 수 없습니다" },
        { status: 500 }
      );
    }

    const { data, error } = await supabase
      .from("experiments")
      .insert({ ...result.data, created_by: user.id, lab_id: labRow.id })
      .select()
      .single();

    if (error) {
      return NextResponse.json({ error: "데이터를 불러오는 중 오류가 발생했습니다" }, { status: 500 });
    }

    // Researcher just linked a calendar — drop any stale FreeBusy cache so the
    // next participant page load sees the latest Google calendar state.
    if (data.google_calendar_id) {
      invalidateCalendarCache(data.google_calendar_id).catch(() => {});
    }

    return NextResponse.json({ experiment: data }, { status: 201 });
  } catch (err) {
    return NextResponse.json(
      { error: "Internal server error" },
      { status: 500 }
    );
  }
}
