import { NextResponse } from "next/server";
import { listModels, OLLAMA_HOST, MODELS } from "@/lib/ollama";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function GET() {
  try {
    const installed = await listModels();
    const required = Object.values(MODELS);
    const missing = required.filter((m) => !installed.includes(m));
    return NextResponse.json({
      ok: missing.length === 0,
      host: OLLAMA_HOST,
      installed,
      required,
      missing,
    });
  } catch (err) {
    return NextResponse.json(
      { ok: false, host: OLLAMA_HOST, error: (err as Error).message },
      { status: 503 },
    );
  }
}
