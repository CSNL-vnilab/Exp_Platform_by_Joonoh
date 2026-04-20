import { NextResponse } from "next/server";
import type { NextRequest } from "next/server";
import { z } from "zod/v4";
import { createClient } from "@/lib/supabase/server";
import { chat } from "@/lib/ollama";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

const bodySchema = z.object({
  imageBase64: z
    .string()
    .min(32)
    .max(12_000_000)
    .regex(/^[A-Za-z0-9+/=\s]+$/),
  instruction: z.string().max(1_000).optional(),
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

  try {
    const text = await chat({
      task: "ocr",
      messages: [
        {
          role: "user",
          content: parsed.data.instruction ?? "이 이미지의 텍스트를 최대한 정확히 추출해 주세요.",
          images: [parsed.data.imageBase64.replace(/\s+/g, "")],
        },
      ],
      num_predict: 4_096,
    });
    return NextResponse.json({ text });
  } catch {
    return NextResponse.json({ error: "OCR 처리 중 오류가 발생했습니다" }, { status: 502 });
  }
}
