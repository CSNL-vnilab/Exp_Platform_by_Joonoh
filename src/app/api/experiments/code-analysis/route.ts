// POST /api/experiments/code-analysis
// Body shapes (any one):
//   A) { code, filename?, docs?, mode }                — single file
//   B) { files: [{path,content},...], entry?, docs?, mode } — multi-file
// Returns: { heuristic, ai, merged, model, bundle? }
//
// Stateless — no DB write. The caller decides when to persist via PUT
// /api/experiments/[experimentId]/offline-code.

import { NextResponse } from "next/server";
import type { NextRequest } from "next/server";
import { z } from "zod/v4";
import { createClient } from "@/lib/supabase/server";
import { runHeuristic } from "@/lib/experiments/code-heuristics";
import { runAiAnalysis } from "@/lib/experiments/code-ai-analyzer";
import { mergeAnalysis } from "@/lib/experiments/code-analysis-schema";
import { bundle, type InputFile } from "@/lib/experiments/code-bundler";
import { resolveProvider } from "@/lib/experiments/llm-provider";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

const fileSchema = z.object({
  path: z.string().min(1).max(400),
  content: z.string().max(400_000),
});

const bodySchema = z.object({
  // single-file
  code: z.string().max(200_000).optional(),
  filename: z.string().max(200).nullable().optional(),
  // multi-file
  files: z.array(fileSchema).max(500).optional(),
  entry: z.string().max(400).nullable().optional(),
  // shared
  docs: z.string().max(50_000).nullable().optional(),
  mode: z.enum(["heuristic", "ai", "both"]).default("both"),
}).refine((v) => !!v.code || (v.files && v.files.length > 0), {
  message: "code 또는 files 중 하나는 필요합니다",
});

export async function POST(request: NextRequest) {
  const supabase = await createClient();
  const { data: { user } } = await supabase.auth.getUser();
  if (!user) {
    return NextResponse.json({ error: "인증이 필요합니다" }, { status: 401 });
  }

  const parsed = bodySchema.safeParse(await request.json().catch(() => null));
  if (!parsed.success) {
    return NextResponse.json(
      { error: "잘못된 요청입니다", issues: parsed.error.issues },
      { status: 400 },
    );
  }

  const { code, filename, files, entry, docs, mode } = parsed.data;

  // Build the actual analysis input. Multi-file path runs the bundler;
  // single-file path stays as-is.
  let analysisCode: string;
  let analysisFilename: string | null;
  let bundleInfo: ReturnType<typeof bundle> | null = null;
  if (files && files.length > 0) {
    const inputs: InputFile[] = files.map((f) => ({ path: f.path, content: f.content }));
    bundleInfo = bundle(inputs, { entryHint: entry ?? null });
    if (!bundleInfo.entry) {
      return NextResponse.json(
        { error: "엔트리 파일을 찾지 못했습니다. main_*, run_*, index, app 같은 파일이 필요합니다." },
        { status: 400 },
      );
    }
    analysisCode = bundleInfo.bundled;
    analysisFilename = bundleInfo.entry;
  } else {
    analysisCode = code!;
    analysisFilename = filename ?? null;
  }

  const heuristic = runHeuristic({ code: analysisCode, filename: analysisFilename });

  let ai = null;
  let modelUsed: string | null = null;
  if (mode !== "heuristic") {
    try {
      // health-check before issuing a long call
      await resolveProvider({ override: "auto" });
    } catch (err) {
      return NextResponse.json(
        {
          error:
            err instanceof Error
              ? err.message
              : "AI 백엔드에 연결할 수 없습니다 (Ollama / Anthropic).",
          heuristic,
          ai: null,
          merged: heuristic,
          bundle: bundleInfo
            ? {
                entry: bundleInfo.entry,
                selected: bundleInfo.selected,
                dropped: bundleInfo.dropped.slice(0, 50),
                totalChars: bundleInfo.totalChars,
              }
            : null,
        },
        { status: 503 },
      );
    }
    try {
      const r = await runAiAnalysis({
        code: analysisCode,
        filename: analysisFilename,
        heuristic,
        docs: docs ?? null,
      });
      ai = r.analysis;
      modelUsed = r.model;
    } catch (err) {
      const msg = err instanceof Error ? err.message : "unknown";
      return NextResponse.json(
        {
          error: `AI 분석 실패: ${msg.slice(0, 200)}`,
          heuristic,
          ai: null,
          merged: heuristic,
        },
        { status: 502 },
      );
    }
  }

  const merged = mergeAnalysis(heuristic, ai, null);

  return NextResponse.json({
    heuristic,
    ai,
    merged,
    model: modelUsed,
    bundle: bundleInfo
      ? {
          entry: bundleInfo.entry,
          selected: bundleInfo.selected,
          dropped: bundleInfo.dropped.slice(0, 50),
          totalChars: bundleInfo.totalChars,
        }
      : null,
  });
}
