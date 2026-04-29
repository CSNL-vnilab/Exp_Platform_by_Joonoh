// POST /api/experiments/code-analysis/from-source
// Body: { source: string, kind?: "auto"|"server-path"|"github", docs?, mode }
// Returns: same shape as /code-analysis (heuristic, ai, merged, model,
// bundle) plus { source: { kind, root, fetched, truncated, skipped } }.
//
// Single-call replacement for the "manual paste / drag-drop" flow:
// researcher gives an address, server fetches → bundles → analyzes.

import { NextResponse } from "next/server";
import type { NextRequest } from "next/server";
import { z } from "zod/v4";
import { createClient } from "@/lib/supabase/server";
import { fetchSource } from "@/lib/experiments/source-fetcher";
import { bundle } from "@/lib/experiments/code-bundler";
import { runHeuristic } from "@/lib/experiments/code-heuristics";
import { runAiAnalysis } from "@/lib/experiments/code-ai-analyzer";
import { mergeAnalysis } from "@/lib/experiments/code-analysis-schema";
import { resolveProvider } from "@/lib/experiments/llm-provider";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

const bodySchema = z.object({
  source: z.string().min(1).max(1000),
  kind: z.enum(["auto", "server-path", "github"]).default("auto"),
  // optional explicit entry hint relative to the source root
  entry: z.string().max(400).nullable().optional(),
  // optional README/summary doc to feed the AI
  docs: z.string().max(50_000).nullable().optional(),
  // optional path inside the source whose contents become docs
  // (e.g. "summary.MD" relative to a server path or repo). When set
  // and `docs` is empty, the server reads the file from the fetched
  // tree.
  docsPath: z.string().max(400).nullable().optional(),
  mode: z.enum(["heuristic", "ai", "both"]).default("both"),
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

  const { source, kind, entry, docs: docsBody, docsPath, mode } = parsed.data;

  // 1. fetch the source tree
  let fetched;
  try {
    fetched = await fetchSource({ source, kind });
  } catch (err) {
    return NextResponse.json(
      { error: err instanceof Error ? err.message : "소스 fetch 실패" },
      { status: 400 },
    );
  }

  try {
    if (fetched.files.length === 0) {
      return NextResponse.json(
        { error: "소스에서 분석 가능한 텍스트 파일을 찾지 못했습니다" },
        { status: 400 },
      );
    }

    // 2. resolve docs — body wins, else docsPath, else nothing
    let docs: string | null = docsBody ?? null;
    if (!docs && docsPath) {
      const target = fetched.files.find(
        (f) => f.path === docsPath || f.path.toLowerCase() === docsPath.toLowerCase(),
      );
      if (target) docs = target.content;
    }
    // Auto-pickup convention: README.md / readme.md / summary.MD / docs/ in root
    if (!docs) {
      const conv = fetched.files.find((f) =>
        /^(readme(\.[a-z]+)?|summary(\.[a-z]+)?|protocol(\.[a-z]+)?|spec(\.[a-z]+)?)$/i.test(
          f.path,
        ),
      );
      if (conv) docs = conv.content;
    }

    // 3. bundle with the server-side bundler
    const bundleInfo = bundle(fetched.files, { entryHint: entry ?? null });
    if (!bundleInfo.entry) {
      return NextResponse.json(
        {
          error:
            "엔트리 파일을 식별하지 못했습니다. main_*, run_*, index, app 같은 파일이 필요합니다. entry 파라미터로 직접 지정해주세요.",
          source: {
            kind,
            root: fetched.rootDisplay,
            fileCount: fetched.files.length,
          },
        },
        { status: 400 },
      );
    }

    // 4. run heuristic + (optional) AI
    const heuristic = runHeuristic({
      code: bundleInfo.bundled,
      filename: bundleInfo.entry,
    });

    let ai = null;
    let modelUsed: string | null = null;
    if (mode !== "heuristic") {
      try {
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
            bundle: bundleInfoJson(bundleInfo),
            source: {
              kind,
              root: fetched.rootDisplay,
              fileCount: fetched.files.length,
              docsAuto: docs && !docsBody && !docsPath,
            },
          },
          { status: 503 },
        );
      }
      try {
        const r = await runAiAnalysis({
          code: bundleInfo.bundled,
          filename: bundleInfo.entry,
          heuristic,
          docs,
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
            bundle: bundleInfoJson(bundleInfo),
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
      bundle: bundleInfoJson(bundleInfo),
      source: {
        kind,
        root: fetched.rootDisplay,
        fileCount: fetched.files.length,
        truncated: fetched.truncated,
        skipped: fetched.skipped.slice(0, 50),
        docsResolved: docs ? (docsBody ? "body" : docsPath ? "path" : "auto") : "none",
        docsBytes: docs ? docs.length : 0,
      },
      // Echo back the resolved code+docs so the client can keep them in
      // its local state for the chatbot context (the chatbot endpoint
      // is stateless and needs the raw text on every call).
      resolved: {
        code: bundleInfo.bundled,
        docs: docs ?? null,
      },
    });
  } finally {
    if (fetched.cleanup) await fetched.cleanup();
  }
}

function bundleInfoJson(b: ReturnType<typeof bundle>) {
  return {
    entry: b.entry,
    selected: b.selected,
    dropped: b.dropped.slice(0, 50),
    totalChars: b.totalChars,
    language: b.language,
  };
}
