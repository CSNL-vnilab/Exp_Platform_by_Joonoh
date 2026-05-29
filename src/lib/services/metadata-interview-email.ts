// Calendar-grounded metadata-fill interview email.
//
// Used by both the manual one-shot script (`scripts/send-metadata-
// interview.mjs`) and the daily cron route (`/api/cron/db-quality-
// check`). Builds + sends a per-researcher email listing every owned
// experiment with metadata gaps, grouped into "활성화 필요" (required
// for `status='active'`) vs "권장" (recommended), with a single CTA
// to `/metadata-fill` so the recipient fills everything on one page.

import type { createAdminClient } from "@/lib/supabase/admin";
import { sendEmail } from "@/lib/google/gmail";
import { wrapEmailHtml } from "@/lib/services/email-shell";
import { escapeHtml } from "@/lib/utils/validation";
import { BRAND_NAME } from "@/lib/branding";
import { getAppOrigin } from "@/lib/http/origin";

type Admin = ReturnType<typeof createAdminClient>;

function appBase(): string {
  return getAppOrigin() || "https://lab-reservation-seven.vercel.app";
}

interface ExperimentRow {
  id: string;
  title: string;
  project_name: string | null;
  status: string;
  start_date: string;
  end_date: string;
  code_repo_url: string | null;
  data_path: string | null;
  pre_experiment_checklist: unknown;
  protocol_version: string | null;
  location_id: string | null;
  description: string | null;
  participation_fee: number | null;
  irb_document_url: string | null;
  recruitment_target: number | null;
}

export interface GapField {
  field: keyof ExperimentRow;
  label: string;
  required: boolean;
}

export const GAP_FIELDS: GapField[] = [
  { field: "code_repo_url", label: "분석 코드 저장소/디렉토리", required: true },
  { field: "data_path", label: "원본 데이터 경로", required: true },
  { field: "pre_experiment_checklist", label: "사전 체크리스트", required: false },
  { field: "protocol_version", label: "프로토콜 버전", required: false },
  { field: "location_id", label: "장소", required: false },
  { field: "description", label: "실험 소개", required: false },
  { field: "participation_fee", label: "참여비", required: false },
  { field: "irb_document_url", label: "IRB 문서 URL", required: false },
  { field: "recruitment_target", label: "모집 인원", required: false },
];

function isEmpty(field: keyof ExperimentRow, v: unknown): boolean {
  if (v == null || v === "") return true;
  if (Array.isArray(v) && v.length === 0) return true;
  if (typeof v === "string" && v.trim() === "") return true;
  // participation_fee=0 is ambiguous (could be intentional "무료"); we
  // mirror the metadata-fill page's behaviour and treat it as a gap so
  // the researcher confirms one way or the other.
  if (field === "participation_fee" && v === 0) return true;
  return false;
}

export interface ResearcherGap {
  profile: {
    id: string;
    display_name: string | null;
    email: string;
    contact_email: string | null;
  };
  rows: Array<{
    experiment: ExperimentRow;
    bookings: number;
    requiredGaps: GapField[];
    optionalGaps: GapField[];
  }>;
}

/**
 * Walk every non-disabled lab member, fetch their owned draft/active/
 * completed experiments, classify the gap fields per row, and return
 * one entry per researcher who has at least one gap. Counts of past
 * bookings are joined so the email can say "캘린더 예약 N건 기록됨"
 * (= calendar-grounded — the experiment really ran).
 */
export async function buildResearcherGapInventory(
  admin: Admin,
): Promise<ResearcherGap[]> {
  const { data: profs } = await admin
    .from("profiles")
    .select("id, display_name, email, contact_email, role, disabled")
    // 2026-05-28 directive: admins (e.g. csnl) get used for fixtures /
    // smoke tests / ops bookings — never their own research projects.
    // The trigger from migration 00064 flips is_project=false on
    // admin-owned experiments; this filter additionally drops admins
    // from the recipient sweep so they never receive the reminder.
    .eq("role", "researcher")
    .eq("disabled", false);

  const out: ResearcherGap[] = [];
  for (const p of (profs ?? []) as Array<{
    id: string;
    display_name: string | null;
    email: string;
    contact_email: string | null;
  }>) {
    const { data: exps } = await admin
      .from("experiments")
      .select(
        "id, title, project_name, status, start_date, end_date, code_repo_url, data_path, pre_experiment_checklist, protocol_version, location_id, description, participation_fee, irb_document_url, recruitment_target",
      )
      .eq("created_by", p.id)
      // 2026-05-28: pilots / equipment tests / one-offs can be marked
      // is_project=false on /metadata-fill and drop out of every
      // reminder channel here.
      .eq("is_project", true)
      .in("status", ["draft", "active", "completed"]);
    const expRows = (exps ?? []) as unknown as ExperimentRow[];

    const ids = expRows.map((e) => e.id);
    const bookingCounts: Record<string, number> = {};
    if (ids.length > 0) {
      const { data: bks } = await admin
        .from("bookings")
        .select("experiment_id")
        .in("experiment_id", ids)
        .in("status", ["confirmed", "completed", "running", "no_show"]);
      for (const b of (bks ?? []) as Array<{ experiment_id: string }>) {
        bookingCounts[b.experiment_id] = (bookingCounts[b.experiment_id] ?? 0) + 1;
      }
    }

    const rows = expRows
      .map((e) => {
        const requiredGaps = GAP_FIELDS.filter(
          (g) => g.required && isEmpty(g.field, (e as unknown as Record<string, unknown>)[g.field]),
        );
        const optionalGaps = GAP_FIELDS.filter(
          (g) => !g.required && isEmpty(g.field, (e as unknown as Record<string, unknown>)[g.field]),
        );
        return {
          experiment: e,
          bookings: bookingCounts[e.id] ?? 0,
          requiredGaps,
          optionalGaps,
        };
      })
      .filter((r) => r.requiredGaps.length + r.optionalGaps.length > 0);

    if (rows.length > 0) out.push({ profile: p, rows });
  }
  return out;
}

/**
 * Render the per-researcher email HTML + plain-text. Pure function —
 * no I/O. Same template the manual script uses; centralised here so
 * both surfaces stay in sync.
 */
export function renderInterviewEmail(g: ResearcherGap): {
  subject: string;
  html: string;
  text: string;
} {
  const totalRequired = g.rows.reduce((n, r) => n + r.requiredGaps.length, 0);

  const cardsHtml = g.rows
    .map((r) => {
      const req = r.requiredGaps.map((x) => escapeHtml(x.label)).join(", ");
      const opt = r.optionalGaps.map((x) => escapeHtml(x.label)).join(", ");
      return `
      <div style="margin:14px 0;padding:14px 16px;border:1px solid #e5e7eb;border-radius:10px;background:#f9fafb;">
        <p style="margin:0;font-size:14px;font-weight:600;color:#111827;">
          ${escapeHtml(r.experiment.title)}
          <span style="font-weight:400;color:#6b7280;font-size:12px;"> · ${escapeHtml(r.experiment.project_name ?? "-")} · ${escapeHtml(r.experiment.status)}</span>
        </p>
        <p style="margin:4px 0 0 0;font-size:12px;color:#6b7280;">
          모집기간 ${escapeHtml(r.experiment.start_date)} ~ ${escapeHtml(r.experiment.end_date)} · 캘린더 예약 ${r.bookings}건 기록됨
        </p>
        ${req ? `<p style="margin:8px 0 0 0;font-size:13px;color:#9a3412;"><b>활성화 필요:</b> ${req}</p>` : ""}
        ${opt ? `<p style="margin:6px 0 0 0;font-size:13px;color:#374151;">권장: ${opt}</p>` : ""}
      </div>`;
    })
    .join("");

  const inner = `
    <div style="max-width:640px;margin:0 auto;padding:24px 18px;font-family:-apple-system,'Apple SD Gothic Neo','Malgun Gothic',sans-serif;line-height:1.65;font-size:14px;color:#111827;">
      <div style="padding:14px 18px;background:#eff6ff;border:1px solid #93c5fd;border-radius:10px;margin-bottom:18px;">
        <p style="margin:0;font-size:15px;font-weight:600;color:#1d4ed8;">📋 실험 메타데이터 입력 요청 — ${escapeHtml(g.profile.display_name ?? "")}님</p>
      </div>
      <p style="margin:0 0 10px 0;">안녕하세요, <b>${escapeHtml(g.profile.display_name ?? "")}</b>님.</p>
      <p style="margin:0 0 14px 0;">
        캘린더에 기록된 실험 중 Lab DB 의 메타데이터(코드 경로 / 데이터 경로 / 프로토콜 / 장소 등) 가
        비어 있는 항목이 있습니다. 이 정보가 채워져야 향후 분석 재현, 정산 자동 처리, 참여자 모집/홍보까지
        묶여 동작합니다.
      </p>
      <p style="margin:0 0 18px 0;">
        아래 ${g.rows.length}개 실험에 채워야 할 항목이 있습니다.
        <b>활성화 필요</b> 표시 ${totalRequired}건은 실험을 다시 <code>active</code> 로 돌리거나 새 정산 흐름을 태우려면 필수입니다.
      </p>
      <p style="margin:0 0 16px 0;text-align:center;">
        <a href="${appBase()}/metadata-fill"
           style="display:inline-block;padding:12px 22px;background:#2563eb;color:#ffffff;border-radius:6px;text-decoration:none;font-size:15px;font-weight:600;">
          한 페이지에서 한번에 입력 →
        </a>
      </p>
      <p style="margin:0 0 18px 0;text-align:center;font-size:12px;color:#6b7280;">
        위 버튼이 안 보이면 다음 주소를 열어주세요:<br>
        <span style="font-family:monospace;">${appBase()}/metadata-fill</span>
      </p>
      <h3 style="margin:24px 0 8px 0;font-size:14px;color:#111827;">실험별 현황</h3>
      ${cardsHtml}
      <p style="margin:20px 0 6px 0;font-size:13px;color:#374151;">
        한 번에 다 채우지 않으셔도 됩니다 — 각 카드의 <b>"이 실험 저장"</b> 버튼은 그 실험만 갱신합니다.
        본 메일은 매일 09:00 KST 에 비어 있는 항목이 남아있을 때만 자동 발송됩니다.
      </p>
      <p style="margin:6px 0 0 0;padding:10px 12px;font-size:13px;color:#374151;background:#fef9c3;border:1px solid #fde68a;border-radius:8px;">
        💡 <b>pilot · 장비 테스트 · 일회성 예약</b> 처럼 정식 프로젝트가 아닌 항목은
        각 카드 우측 상단의 <b>"프로젝트 아님 (면제)"</b> 버튼으로 면제 처리할 수 있습니다.
        면제 처리된 실험은 이 안내에서 자동으로 빠집니다.
      </p>
      <p style="margin:18px 0 4px 0;font-size:12px;color:#9ca3af;">
        문의: <a href="mailto:vnilab@gmail.com" style="color:#2563eb;">vnilab@gmail.com</a>
      </p>
    </div>`;

  const html = wrapEmailHtml(inner, { title: "실험 메타데이터 입력 요청" });

  const text =
    `안녕하세요, ${g.profile.display_name ?? ""}님.\n\n` +
    `백필된 ${g.rows.length}개 실험에 메타데이터를 채워주세요. (활성화 필요 ${totalRequired}건)\n\n` +
    `한번에 입력: ${appBase()}/metadata-fill\n\n` +
    `실험 목록:\n` +
    g.rows
      .map(
        (r) =>
          `- ${r.experiment.title} (${r.experiment.start_date}~${r.experiment.end_date}, 예약 ${r.bookings}건)\n` +
          `    필요: ${r.requiredGaps.map((x) => x.label).join(", ") || "-"}\n` +
          `    권장: ${r.optionalGaps.map((x) => x.label).join(", ") || "-"}`,
      )
      .join("\n") +
    `\n\n💡 pilot / 장비 테스트 / 일회성 예약은 각 카드의 "프로젝트 아님 (면제)" 버튼으로 면제 처리 가능 — 면제 처리된 실험은 다음 안내부터 자동 제외됩니다.\n\n본 메일은 매일 09:00 KST 에 비어 있는 항목이 남아있을 때만 자동 발송됩니다.\n`;

  return {
    subject: `[${BRAND_NAME}] 실험 메타데이터 입력 요청 — ${g.profile.display_name ?? ""}님 (${g.rows.length}건)`,
    html,
    text,
  };
}

/**
 * Send the rendered email to the researcher's contact_email, CCing
 * the lab inbox. Returns the SMTP outcome so the caller can log it.
 */
export async function sendInterviewEmail(
  g: ResearcherGap,
): Promise<{ success: boolean; messageId?: string; error?: string; skipped?: string }> {
  const to = g.profile.contact_email?.trim();
  if (!to || !/@/.test(to)) {
    return { success: false, skipped: "no contact_email" };
  }
  const { subject, html, text } = renderInterviewEmail(g);
  const cc = process.env.GMAIL_USER || undefined;
  return await sendEmail({ to, cc, subject, html, text });
}
