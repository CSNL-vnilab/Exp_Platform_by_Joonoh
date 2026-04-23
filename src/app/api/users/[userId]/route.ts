import { NextResponse } from "next/server";
import type { NextRequest } from "next/server";
import { z } from "zod/v4";
import { requireAdmin } from "@/lib/auth/role";
import { createAdminClient } from "@/lib/supabase/admin";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

const uuidRe =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

// Notion page IDs come as either bare 32-char hex (e.g. "abc123…") or
// full Notion URL (https://www.notion.so/TEAM/xxx-32charhex?v=…). This
// helper extracts the hex id or returns null if the input doesn't look
// like either. Accepts dashed or undashed.
function parseNotionPageId(raw: unknown): string | null {
  if (typeof raw !== "string") return null;
  const s = raw.trim();
  if (s === "") return "";
  // If it's a URL, look at the last path segment.
  let candidate = s;
  const urlMatch = s.match(/notion\.so\/[^/]+\/(.+?)(?:[?#]|$)/i);
  if (urlMatch) {
    // The last segment is typically "some-slug-32charhex" or "32charhex"
    const segs = urlMatch[1].split(/[-]/);
    candidate = segs[segs.length - 1];
  }
  const hex = candidate.replace(/-/g, "").toLowerCase();
  if (/^[0-9a-f]{32}$/.test(hex)) {
    // Re-insert standard dashes: 8-4-4-4-12
    return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20)}`;
  }
  return null;
}

const patchSchema = z
  .object({
    role: z.enum(["admin", "researcher"]).optional(),
    disabled: z.boolean().optional(),
    // Accepts bare id, dashed id, or Notion page URL. Empty string clears.
    notion_member_page_id: z
      .string()
      .max(256)
      .optional()
      .transform((v, ctx) => {
        if (v === undefined || v === "") return v === "" ? null : undefined;
        const parsed = parseNotionPageId(v);
        if (parsed == null) {
          ctx.addIssue({
            code: "custom",
            message:
              "Notion 페이지 ID를 인식할 수 없습니다. 전체 URL 또는 32자 hex를 입력해주세요.",
          });
          return v;
        }
        return parsed;
      }),
  })
  .refine(
    (v) =>
      v.role !== undefined ||
      v.disabled !== undefined ||
      v.notion_member_page_id !== undefined,
    {
      message: "role / disabled / notion_member_page_id 중 하나는 필요합니다",
    },
  );

export async function PATCH(
  request: NextRequest,
  { params }: { params: Promise<{ userId: string }> },
) {
  const me = await requireAdmin();
  const { userId } = await params;

  if (!uuidRe.test(userId)) {
    return NextResponse.json({ error: "잘못된 사용자 ID입니다" }, { status: 400 });
  }
  if (userId === me.id) {
    return NextResponse.json(
      { error: "본인 계정은 변경할 수 없습니다" },
      { status: 400 },
    );
  }

  const parsed = patchSchema.safeParse(await request.json().catch(() => null));
  if (!parsed.success) {
    return NextResponse.json({ error: "잘못된 요청입니다" }, { status: 400 });
  }

  const admin = createAdminClient();
  const { data, error } = await admin
    .from("profiles")
    .update(parsed.data)
    .eq("id", userId)
    .select()
    .single();

  if (error || !data) {
    return NextResponse.json({ error: "업데이트에 실패했습니다" }, { status: 500 });
  }

  return NextResponse.json({ profile: data });
}
