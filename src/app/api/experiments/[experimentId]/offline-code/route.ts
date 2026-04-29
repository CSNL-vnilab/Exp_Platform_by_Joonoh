// PUT /api/experiments/[experimentId]/offline-code
// Persists `offline_code_analysis` on the experiment row. The body
// carries everything: raw uploaded code, heuristic output, AI output,
// user overrides, and the pre-merged final view. The server only
// validates shape + computes `merged` server-side as a defence in
// depth (don't trust the client's merge).

import { NextResponse } from "next/server";
import type { NextRequest } from "next/server";
import { z } from "zod/v4";
import { createClient } from "@/lib/supabase/server";
import { isValidUUID } from "@/lib/utils/validation";
import {
  CodeAnalysisSchema,
  CodeAnalysisOverridesSchema,
  mergeAnalysis,
  SUPPORTED_LANGS,
} from "@/lib/experiments/code-analysis-schema";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

const bodySchema = z.object({
  code_excerpt: z.string().max(200_000).nullable().optional(),
  code_filename: z.string().max(200).nullable().optional(),
  code_lang: z.enum(SUPPORTED_LANGS).nullable().optional(),
  model: z.string().max(120).nullable().optional(),
  heuristic: CodeAnalysisSchema.nullable().optional(),
  ai: CodeAnalysisSchema.nullable().optional(),
  overrides: CodeAnalysisOverridesSchema.nullable().optional(),
});

export async function PUT(
  request: NextRequest,
  { params }: { params: Promise<{ experimentId: string }> },
) {
  const { experimentId } = await params;
  if (!isValidUUID(experimentId)) {
    return NextResponse.json({ error: "Invalid experiment ID" }, { status: 400 });
  }

  const supabase = await createClient();
  const { data: { user } } = await supabase.auth.getUser();
  if (!user) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }

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

  const parsed = bodySchema.safeParse(await request.json().catch(() => null));
  if (!parsed.success) {
    return NextResponse.json(
      { error: "Validation failed", issues: parsed.error.issues },
      { status: 400 },
    );
  }

  const merged = mergeAnalysis(
    parsed.data.heuristic ?? null,
    parsed.data.ai ?? null,
    parsed.data.overrides ?? null,
  );

  const payload = {
    code_excerpt: parsed.data.code_excerpt ?? null,
    code_filename: parsed.data.code_filename ?? null,
    code_lang: parsed.data.code_lang ?? null,
    analyzed_at: new Date().toISOString(),
    model: parsed.data.model ?? null,
    heuristic: parsed.data.heuristic ?? null,
    ai: parsed.data.ai ?? null,
    overrides: parsed.data.overrides ?? null,
    merged,
  };

  const { data, error } = await supabase
    .from("experiments")
    .update({ offline_code_analysis: payload })
    .eq("id", experimentId)
    .select("offline_code_analysis")
    .single();
  if (error) {
    return NextResponse.json({ error: "저장 중 오류가 발생했습니다" }, { status: 500 });
  }
  return NextResponse.json({ offline_code_analysis: data.offline_code_analysis });
}

export async function DELETE(
  _request: NextRequest,
  { params }: { params: Promise<{ experimentId: string }> },
) {
  const { experimentId } = await params;
  if (!isValidUUID(experimentId)) {
    return NextResponse.json({ error: "Invalid experiment ID" }, { status: 400 });
  }
  const supabase = await createClient();
  const { data: { user } } = await supabase.auth.getUser();
  if (!user) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });

  const { data: existing } = await supabase
    .from("experiments")
    .select("created_by")
    .eq("id", experimentId)
    .single();
  if (!existing) return NextResponse.json({ error: "Not found" }, { status: 404 });
  if (existing.created_by !== user.id)
    return NextResponse.json({ error: "Forbidden" }, { status: 403 });

  const { error } = await supabase
    .from("experiments")
    .update({ offline_code_analysis: null })
    .eq("id", experimentId);
  if (error) return NextResponse.json({ error: "Delete failed" }, { status: 500 });
  return NextResponse.json({ success: true });
}
