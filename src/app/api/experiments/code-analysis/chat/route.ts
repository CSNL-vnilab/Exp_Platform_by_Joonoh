// POST /api/experiments/code-analysis/chat
// Streams Qwen output (text/plain). The chatbot sees the raw code +
// the current merged analysis + conversation history and answers in
// Korean. When it wants to amend the analysis it emits one or more
// patches inside `<patch>{...}</patch>` blocks; the client parses
// these out, lets the user approve/reject, and applies them to the
// `overrides` map.
//
// The patch format is intentionally narrow — see PATCH_GRAMMAR below.

import { NextResponse } from "next/server";
import type { NextRequest } from "next/server";
import { z } from "zod/v4";
import { createClient } from "@/lib/supabase/server";
import { streamChat, type ChatMessage, modelFor, ping } from "@/lib/ollama";
import { CodeAnalysisSchema } from "@/lib/experiments/code-analysis-schema";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

const messageSchema = z.object({
  role: z.enum(["user", "assistant"]),
  content: z.string().max(8000),
});

const bodySchema = z.object({
  code: z.string().max(200_000),
  filename: z.string().max(200).nullable().optional(),
  current: CodeAnalysisSchema, // the user's current merged view
  messages: z.array(messageSchema).max(40),
  user_message: z.string().min(1).max(4000),
});

const PATCH_GRAMMAR = `사용 가능한 patch 명령:

<patch>{"op":"set_meta","field":"n_blocks|n_trials_per_block|total_trials|estimated_duration_min|seed|summary|framework|language","value":...}</patch>
<patch>{"op":"upsert_factor","name":"...","type":"categorical|continuous|ordinal","levels":["..."],"description":"..."}</patch>
<patch>{"op":"remove_factor","name":"..."}</patch>
<patch>{"op":"upsert_parameter","name":"...","type":"number|string|boolean|array|other","default":"...","unit":"...","description":"..."}</patch>
<patch>{"op":"remove_parameter","name":"..."}</patch>
<patch>{"op":"upsert_condition","label":"...","factor_assignments":{"factor":"level"},"description":"..."}</patch>
<patch>{"op":"remove_condition","label":"..."}</patch>
<patch>{"op":"upsert_saved_variable","name":"...","format":"int|float|string|bool|array|matrix|struct|csv-row|json|other","unit":"...","sink":"...","description":"..."}</patch>
<patch>{"op":"remove_saved_variable","name":"..."}</patch>

규칙:
- 한 번의 답변에 여러 patch 를 emit 할 수 있음.
- patch 외부에는 한국어 설명/근거를 자연어로 작성. 사용자가 patch 를 검토 후 적용하므로 "적용했다"고 단정하지 않는다.
- 코드를 보지 않고 추측하지 않는다 — 근거가 없으면 질문하라.
`;

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

  if (!(await ping())) {
    return NextResponse.json(
      { error: "AI 서버(Ollama)에 연결할 수 없습니다." },
      { status: 503 },
    );
  }

  const { code, filename, current, messages, user_message } = parsed.data;

  const codeExcerpt = code.slice(0, 60_000);
  const truncated = code.length > 60_000;

  const system = [
    "당신은 행동·인지 실험 코드 분석 및 메타데이터 관리 전문가입니다.",
    "사용자가 업로드한 실험 코드와 현재 추출된 메타데이터(JSON)를 검토하고, 모호하거나 누락된 항목에 대해 한국어로 대화합니다.",
    "사용자가 명시적으로 변경을 요청하거나 코드를 근거로 명백한 누락/오류를 발견했을 때만 patch 를 emit 합니다.",
    "코드 라인 번호를 인용해 근거를 보이세요.",
    PATCH_GRAMMAR,
    `현재 메타데이터(JSON):\n${JSON.stringify(current, null, 2)}`,
    `파일명: ${filename ?? "(미지정)"} ${truncated ? " — 코드가 잘려 일부만 제공됩니다." : ""}`,
    `코드:\n\`\`\`\n${codeExcerpt}\n\`\`\``,
  ].join("\n\n");

  const chatMessages: ChatMessage[] = [
    { role: "system", content: system },
    ...messages.map<ChatMessage>((m) => ({ role: m.role, content: m.content })),
    { role: "user", content: user_message },
  ];

  const model = modelFor("code.analysis");
  const encoder = new TextEncoder();
  const stream = new ReadableStream({
    async start(controller) {
      try {
        for await (const chunk of streamChat({
          model,
          messages: chatMessages,
          temperature: 0.2,
          num_ctx: 32_768,
          num_predict: 2_048,
        })) {
          controller.enqueue(encoder.encode(chunk));
        }
        controller.close();
      } catch (err) {
        const msg = err instanceof Error ? err.message : "unknown";
        controller.enqueue(encoder.encode(`\n\n[stream error] ${msg.slice(0, 200)}`));
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
