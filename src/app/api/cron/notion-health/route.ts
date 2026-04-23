import { NextResponse } from "next/server";
import type { NextRequest } from "next/server";
import { timingSafeEqual } from "crypto";
import { createAdminClient } from "@/lib/supabase/admin";
import {
  diffNotionSchema,
  NOTION_TITLE_COLUMN,
  type NotionLivePropertyType,
} from "@/lib/notion/schema";

// Notion schema drift detection.
//
// Fetches the live Notion DB properties via GET /v1/databases/{id} and
// diffs against src/lib/notion/schema.ts. Records the result as one
// append-only row in `notion_health_state` with check_type='schema_drift'.
//
// Cron schedule: daily. Sooner would be cheaper; daily is chosen because
// template edits are rare and the retry worker already handles transient
// failures — this cron only catches intentional-but-accidental researcher
// renames in Notion UI.

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

function safeCompare(a: string, b: string): boolean {
  const bufA = Buffer.from(a);
  const bufB = Buffer.from(b);
  if (bufA.length !== bufB.length) return false;
  return timingSafeEqual(bufA, bufB);
}

const MIN_SECRET_LENGTH = 32;

function authorize(request: NextRequest): boolean {
  const expected = (process.env.CRON_SECRET ?? "").trim();
  if (!expected || expected.length < MIN_SECRET_LENGTH) return false;
  const custom = request.headers.get("x-cron-secret") ?? "";
  if (custom && safeCompare(custom, expected)) return true;
  const auth = request.headers.get("authorization") ?? "";
  if (auth.startsWith("Bearer ")) {
    const token = auth.slice(7).trim();
    if (token && safeCompare(token, expected)) return true;
  }
  return false;
}

async function handle(request: NextRequest) {
  const started = Date.now();
  try {
    if (!authorize(request)) {
      return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
    }

    const token = process.env.NOTION_API_KEY;
    const dbId = process.env.NOTION_DATABASE_ID;
    if (!token || !dbId) {
      // M6 fix — record as unhealthy so the dashboard surfaces a distinct
      // "비활성" badge instead of a misleading green. The sync isn't running
      // at all; researchers should know.
      const admin = createAdminClient();
      await admin.from("notion_health_state").insert({
        check_type: "schema_drift",
        healthy: false,
        schema_hash: null,
        report: { skipped: true, reason: "NOTION_API_KEY or NOTION_DATABASE_ID absent" },
        duration_ms: Date.now() - started,
      });
      return NextResponse.json({ ok: true, skipped: true });
    }

    const res = await fetch(
      `https://api.notion.com/v1/databases/${dbId.trim()}`,
      {
        headers: {
          Authorization: `Bearer ${token}`,
          "Notion-Version": "2022-06-28",
        },
      },
    );
    if (!res.ok) {
      const body = await res.text().catch(() => "");
      const admin = createAdminClient();
      await admin.from("notion_health_state").insert({
        check_type: "schema_drift",
        healthy: false,
        report: {
          api_error: true,
          http_status: res.status,
          body: body.slice(0, 500),
        },
        duration_ms: Date.now() - started,
      });
      return NextResponse.json(
        { ok: false, error: "Notion fetch failed", status: res.status },
        { status: 502 },
      );
    }

    const db = (await res.json()) as {
      properties: Record<
        string,
        {
          type: string;
          select?: { options: Array<{ name: string }> };
          relation?: { database_id?: string };
        }
      >;
    };

    // Reshape into the LiveSchema the diff helper expects.
    let titleColumnName: string | null = null;
    const live: Record<string, NotionLivePropertyType> = {};
    for (const [name, p] of Object.entries(db.properties)) {
      if (p.type === "title") {
        titleColumnName = name;
        continue;
      }
      live[name] = {
        type: p.type,
        selectOptions: p.select?.options.map((o) => o.name),
        relatedDbId: p.relation?.database_id,
      };
    }
    // Title column is also represented in live so the diff sees it in
    // case it was renamed to something other than NOTION_TITLE_COLUMN —
    // but we also pass it explicitly via the titleColumnName arg.
    if (titleColumnName) {
      live[titleColumnName] = { type: "title" };
    }

    const report = diffNotionSchema(live, titleColumnName);

    const admin = createAdminClient();
    const { error: insertErr } = await admin.from("notion_health_state").insert({
      check_type: "schema_drift",
      healthy: report.healthy,
      schema_hash: report.schema_hash,
      // NotionDriftReport is a structurally-plain object but TS refuses
      // to narrow it to Json without an explicit round-trip. Parse/stringify
      // is the smallest-blast-radius coercion.
      // NotionDriftReport is structurally Json-compatible but TS's index-sig
      // narrowing refuses the cast. Use an explicit unknown→Json via type
      // assertion instead of a round-trip JSON.parse(JSON.stringify).
      report: report as unknown as import("@/types/database").Json,
      duration_ms: Date.now() - started,
    });
    if (insertErr) {
      console.error("[NotionHealthCron] insert failed:", insertErr.message);
    }

    return NextResponse.json({
      ok: true,
      healthy: report.healthy,
      drift_count: report.items.filter((i) => i.kind !== "unexpected").length,
      schema_hash: report.schema_hash,
    });
  } catch (err) {
    console.error("[NotionHealthCron] error:", err);
    return NextResponse.json(
      {
        error: err instanceof Error ? err.message : "Internal server error",
      },
      { status: 500 },
    );
  }
}

export const GET = handle;
export const POST = handle;
