import { NextResponse } from "next/server";
import type { NextRequest } from "next/server";
import { createAdminClient } from "@/lib/supabase/admin";
import { authorizeCronRequest } from "@/lib/auth/cron-secret";
import { sendEmail } from "@/lib/google/gmail";
import { BRAND_NAME, brandContactEmailOrNull } from "@/lib/branding";
import { escapeHtml } from "@/lib/utils/validation";

// Researcher metadata reminder cron.
//
// Weekly push covering the same gap set the /dashboard banner surfaces:
//   * experiments.code_repo_url empty
//   * experiments.data_path empty
//   * experiments.pre_experiment_checklist empty
//
// Rate-limited via `metadata_reminder_log` — at most one email per
// researcher per 7 days. Active experiments only (status in draft /
// active); completed / cancelled skipped because their metadata gaps
// no longer block future bookings.
//
// Same auth contract as every other cron (MIN_SECRET_LENGTH=32,
// Authorization Bearer or x-cron-secret; see cron-secret.ts).

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

const DEDUP_WINDOW_DAYS = 7;

interface ExperimentRow {
  id: string;
  title: string;
  status: string;
  code_repo_url: string | null;
  data_path: string | null;
  pre_experiment_checklist: unknown[] | null;
  created_by: string | null;
}

interface ProfileRow {
  id: string;
  display_name: string | null;
  email: string;
  contact_email: string | null;
  disabled: boolean | null;
}

function experimentGaps(e: ExperimentRow): string[] {
  const gaps: string[] = [];
  if (!e.code_repo_url || !String(e.code_repo_url).trim())
    gaps.push("코드 디렉토리");
  if (!e.data_path || !String(e.data_path).trim()) gaps.push("데이터 경로");
  if (!Array.isArray(e.pre_experiment_checklist) || e.pre_experiment_checklist.length === 0)
    gaps.push("사전 체크리스트");
  return gaps;
}

function renderEmailHtml(
  researcherName: string,
  rows: Array<{ title: string; gaps: string[]; id: string; appBase: string }>,
): string {
  const safeName = escapeHtml(researcherName);
  const items = rows
    .map((r) => {
      const url = `${r.appBase}/experiments/${r.id}`;
      return `
        <li style="margin:6px 0;">
          <a href="${url}" style="color:#2563eb;">${escapeHtml(r.title)}</a>
          <span style="color:#6b7280;"> — 누락: ${r.gaps.map(escapeHtml).join(", ")}</span>
        </li>`;
    })
    .join("");
  return `
    <div style="font-family:-apple-system,'Segoe UI',sans-serif;max-width:620px;margin:0 auto;padding:8px;color:#111827;line-height:1.55;">
      <div style="padding:14px 18px;background:#eff6ff;border:1px solid #93c5fd;border-radius:10px;margin-bottom:18px;">
        <p style="margin:0;font-size:15px;font-weight:600;color:#1d4ed8;">📋 실험 메타데이터 입력 요청</p>
      </div>
      <p style="margin:0 0 14px 0;">안녕하세요 ${safeName}님.</p>
      <p style="margin:0 0 14px 0;">
        아래 ${rows.length}개 실험이 재현 가능한 기록에 필요한 필수 정보를 아직 입력하지 않았습니다. 실험 페이지에서 직접 입력해 주세요.
      </p>
      <ul style="margin:0 0 16px 0;padding-left:20px;">${items}</ul>
      <p style="margin:14px 0 4px 0;font-size:13px;color:#374151;">필요한 항목:</p>
      <ul style="margin:0 0 14px 0;padding-left:20px;font-size:13px;color:#374151;">
        <li><b>코드 디렉토리</b> · GitHub URL 또는 서버 절대 경로 (실험 활성화 전 필수)</li>
        <li><b>데이터 경로</b> · 원본 데이터 저장 경로 (실험 활성화 전 필수)</li>
        <li><b>사전 체크리스트</b> · 실험 시작 전 확인할 항목 목록</li>
      </ul>
      <p style="margin:18px 0 4px 0;font-size:12px;color:#6b7280;">
        이 메일은 일주일에 한 번, 기록되지 않은 필수 정보가 남아 있는 동안에만 발송됩니다. 입력을 완료하시면 다음 주부터 자동으로 중단됩니다.
      </p>
      <p style="margin:4px 0 0 0;font-size:12px;color:#9ca3af;">
        ${escapeHtml(BRAND_NAME)}${brandContactEmailOrNull() ? ` — 문의: <a href="mailto:${brandContactEmailOrNull()}" style="color:#2563eb;">${brandContactEmailOrNull()}</a>` : ""}
      </p>
    </div>
  `;
}

async function handle(request: NextRequest) {
  const started = Date.now();
  try {
    if (!authorizeCronRequest(request)) {
      return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
    }

    const admin = createAdminClient();

    // 1. Load all draft/active experiments with missing-gap fields.
    const { data: experiments } = await admin
      .from("experiments")
      .select(
        "id, title, status, code_repo_url, data_path, pre_experiment_checklist, created_by",
      )
      .in("status", ["draft", "active"]);

    const rows = ((experiments ?? []) as unknown as ExperimentRow[]).filter(
      (e) => e.created_by && experimentGaps(e).length > 0,
    );
    const byResearcher = new Map<string, ExperimentRow[]>();
    for (const e of rows) {
      if (!e.created_by) continue;
      const list = byResearcher.get(e.created_by) ?? [];
      list.push(e);
      byResearcher.set(e.created_by, list);
    }

    // 2. Researcher contact lookup in one round-trip.
    const researcherIds = [...byResearcher.keys()];
    const profileById = new Map<string, ProfileRow>();
    if (researcherIds.length > 0) {
      const { data: profs } = await admin
        .from("profiles")
        .select("id, display_name, email, contact_email, disabled")
        .in("id", researcherIds);
      for (const p of (profs ?? []) as unknown as ProfileRow[]) {
        profileById.set(p.id, p);
      }
    }

    // 3. Dedup — skip researchers emailed in the last 7 days.
    const cutoff = new Date(
      Date.now() - DEDUP_WINDOW_DAYS * 24 * 60 * 60 * 1000,
    ).toISOString();
    const { data: recentLogs } = await admin
      .from("metadata_reminder_log")
      .select("researcher_user_id")
      .in("researcher_user_id", researcherIds.length > 0 ? researcherIds : ["00000000-0000-0000-0000-000000000000"])
      .gte("sent_at", cutoff);
    const recentlyEmailed = new Set(
      ((recentLogs ?? []) as unknown as { researcher_user_id: string }[]).map(
        (r) => r.researcher_user_id,
      ),
    );

    // 4. Send + log.
    const appBase =
      process.env.NEXT_PUBLIC_APP_URL?.replace(/\/$/, "") ||
      "https://lab-reservation-seven.vercel.app";

    const results: Array<{
      researcher_user_id: string;
      email: string;
      experiments: number;
      ok: boolean;
      error?: string;
      skipped_reason?: string;
    }> = [];

    for (const [userId, expList] of byResearcher.entries()) {
      const profile = profileById.get(userId);
      if (!profile) {
        results.push({
          researcher_user_id: userId,
          email: "(unknown)",
          experiments: expList.length,
          ok: false,
          skipped_reason: "profile_missing",
        });
        continue;
      }
      if (profile.disabled) {
        results.push({
          researcher_user_id: userId,
          email: profile.email,
          experiments: expList.length,
          ok: false,
          skipped_reason: "profile_disabled",
        });
        continue;
      }
      if (recentlyEmailed.has(userId)) {
        results.push({
          researcher_user_id: userId,
          email: profile.email,
          experiments: expList.length,
          ok: false,
          skipped_reason: "rate_limited_7d",
        });
        continue;
      }
      const to =
        (profile.contact_email ?? "").trim() || profile.email.trim();
      if (!to || !/@/.test(to)) {
        results.push({
          researcher_user_id: userId,
          email: profile.email,
          experiments: expList.length,
          ok: false,
          skipped_reason: "no_valid_email",
        });
        continue;
      }

      const gapRows = expList.map((e) => ({
        id: e.id,
        title: e.title,
        gaps: experimentGaps(e),
        appBase,
      }));
      const html = renderEmailHtml(profile.display_name ?? "연구원", gapRows);

      try {
        const res = await sendEmail({
          to,
          subject: `[${BRAND_NAME}] 실험 메타데이터 입력 요청 (${gapRows.length}건)`,
          html,
        });
        if (!res.success) {
          results.push({
            researcher_user_id: userId,
            email: to,
            experiments: expList.length,
            ok: false,
            error: res.error ?? "send_failed",
          });
          continue;
        }

        await admin.from("metadata_reminder_log").insert({
          researcher_user_id: userId,
          email_to: to,
          experiment_count: gapRows.length,
          gap_summary: { rows: gapRows.map((r) => ({ id: r.id, title: r.title, gaps: r.gaps })) },
        });
        results.push({
          researcher_user_id: userId,
          email: to,
          experiments: expList.length,
          ok: true,
        });
      } catch (err) {
        results.push({
          researcher_user_id: userId,
          email: to,
          experiments: expList.length,
          ok: false,
          error: err instanceof Error ? err.message : String(err),
        });
      }
    }

    const summary = {
      ok: true,
      duration_ms: Date.now() - started,
      total_researchers_with_gaps: byResearcher.size,
      emailed: results.filter((r) => r.ok).length,
      rate_limited: results.filter((r) => r.skipped_reason === "rate_limited_7d").length,
      skipped_other: results.filter((r) => r.skipped_reason && r.skipped_reason !== "rate_limited_7d").length,
      failed: results.filter((r) => !r.ok && !r.skipped_reason).length,
      rows: results,
    };
    return NextResponse.json(summary);
  } catch (err) {
    console.error("[MetadataReminderCron] error:", err);
    return NextResponse.json(
      { error: err instanceof Error ? err.message : "Internal server error" },
      { status: 500 },
    );
  }
}

export const GET = handle;
export const POST = handle;
