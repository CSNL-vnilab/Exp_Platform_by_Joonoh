import { NextResponse } from "next/server";
import type { NextRequest } from "next/server";
import { z } from "zod/v4";
import { createClient } from "@/lib/supabase/server";
import { streamChat, type ChatMessage } from "@/lib/ollama";
import { pickReviewModel } from "@/lib/ollama/models";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

const bodySchema = z.object({
  content: z.string().min(1).max(120_000),
  system: z.string().max(4_000).optional(),
  depth: z.enum(["fast", "deep", "auto"]).default("auto"),
});

export async function POST(request: NextRequest) {
  const supabase = await createClient();
  const { data: { user } } = await supabase.auth.getUser();
  if (!user) {
    return NextResponse.json({ error: "인증이 필요합니다" }, { status: 401 });
  }

  const parsed = bodySchema.safeParse(await request.json().catch(() => null));
  if (!parsed.success) {
    return NextResponse.json({ error: "잘못된 요청입니다" }, { status: 400 });
  }

  const { content, system, depth } = parsed.data;
  const model =
    depth === "fast" ? "gemma4:26b" :
    depth === "deep" ? "gemma4:31b" :
    pickReviewModel(Math.ceil(content.length / 4));

  const messages: ChatMessage[] = [
    {
      role: "system",
      content:
        system ??
        "너는 실험 설계·예약 시스템을 검토하는 시니어 리뷰어다. 한국어로, 근거와 함께, 위험/버그/개선을 우선순위 태그(CRITICAL/HIGH/MED/LOW)로 정리해서 답한다.",
    },
    { role: "user", content },
  ];

  const encoder = new TextEncoder();
  const stream = new ReadableStream({
    async start(controller) {
      try {
        for await (const chunk of streamChat({ model, messages, num_ctx: 16_384, num_predict: 4_096 })) {
          controller.enqueue(encoder.encode(chunk));
        }
        controller.close();
      } catch {
        controller.enqueue(encoder.encode("\n\n[stream error]"));
        controller.close();
      }
    },
  });

  return new Response(stream, {
    headers: {
      "Content-Type": "text/plain; charset=utf-8",
      "X-Ollama-Model": model,
      "Cache-Control": "no-store",
    },
  });
}
