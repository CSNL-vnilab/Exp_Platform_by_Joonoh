import { NextResponse } from "next/server";
import type { NextRequest } from "next/server";
import { z } from "zod/v4";
import { createClient } from "@/lib/supabase/server";
import { embed } from "@/lib/ollama";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

const bodySchema = z.object({
  input: z.union([z.string().min(1).max(20_000), z.array(z.string().min(1).max(20_000)).min(1).max(64)]),
  model: z.enum(["embed", "embed.lite"]).optional(),
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
    const embeddings = await embed({
      task: parsed.data.model ?? "embed",
      input: parsed.data.input,
    });
    return NextResponse.json({ embeddings });
  } catch {
    return NextResponse.json({ error: "임베딩 생성 중 오류가 발생했습니다" }, { status: 502 });
  }
}
