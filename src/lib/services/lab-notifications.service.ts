// Out-of-band lab notifications: registration approvals + experiment
// publications. Fire-and-forget from the mutating route (approve,
// status change). Failures are logged and swallowed so the primary
// action (user creation, status transition) is not blocked.

import { createAdminClient } from "@/lib/supabase/admin";
import { sendEmail } from "@/lib/google/gmail";
import { BRAND_NAME, brandContactEmailOrNull } from "@/lib/branding";
import { escapeHtml } from "@/lib/utils/validation";
import { fromInternalEmail } from "@/lib/auth/username";
import { formatDateKR } from "@/lib/utils/date";

type Supabase = ReturnType<typeof createAdminClient>;

function appBase(): string {
  return (
    process.env.NEXT_PUBLIC_APP_URL?.replace(/\/$/, "") ||
    "https://lab-reservation-seven.vercel.app"
  );
}

// ── 1. Registration approval ──
//
// Called after the admin approve-endpoint has created the auth user +
// updated the profile. `requestRow` is the just-approved
// registration_requests row; `loginUsername` is what the researcher
// types into the login form (the part before @, from toInternalEmail).

export async function sendRegistrationApprovedEmail(
  requestRow: {
    contact_email: string;
    display_name: string;
    username: string;
  },
): Promise<void> {
  const to = (requestRow.contact_email ?? "").trim();
  if (!to || !/@/.test(to)) {
    console.warn(
      `[LabNotify] registration approved but no contact_email for ${requestRow.username}`,
    );
    return;
  }

  const safeName = escapeHtml(requestRow.display_name);
  const safeId = escapeHtml(requestRow.username);
  const loginUrl = `${appBase()}/login`;

  const html = `
    <div style="font-family:-apple-system,'Segoe UI',sans-serif;max-width:620px;margin:0 auto;padding:8px;color:#111827;line-height:1.55;">
      <div style="padding:14px 18px;background:#ecfdf5;border:1px solid #6ee7b7;border-radius:10px;margin-bottom:18px;">
        <p style="margin:0;font-size:15px;font-weight:600;color:#065f46;">✓ 연구원 계정 가입이 승인되었습니다</p>
      </div>

      <p style="margin:0 0 6px 0;">안녕하세요, ${safeName}님.</p>
      <p style="margin:0 0 14px 0;">
        ${escapeHtml(BRAND_NAME)} 실험 예약 시스템의 연구원 가입 요청이 관리자에 의해 승인되었습니다.
        아래 ID와 가입 신청 시 입력하신 비밀번호로 로그인하실 수 있습니다.
      </p>

      <table style="border-collapse:collapse;width:100%;margin:14px 0;font-size:14px;">
        <tr>
          <td style="padding:10px 12px;border:1px solid #e5e7eb;background:#f9fafb;font-weight:600;width:120px;">로그인 ID</td>
          <td style="padding:10px 12px;border:1px solid #e5e7eb;font-family:monospace;">${safeId}</td>
        </tr>
        <tr>
          <td style="padding:10px 12px;border:1px solid #e5e7eb;background:#f9fafb;font-weight:600;">비밀번호</td>
          <td style="padding:10px 12px;border:1px solid #e5e7eb;">가입 신청 시 입력하신 비밀번호</td>
        </tr>
      </table>

      <p style="margin:16px 0;">
        <a href="${loginUrl}" style="display:inline-block;padding:10px 18px;background:#2563eb;color:#ffffff;border-radius:6px;text-decoration:none;font-size:14px;font-weight:600;">로그인하기 →</a>
      </p>

      <p style="margin:14px 0 4px 0;font-size:13px;color:#374151;">처음 로그인 후 해주실 일:</p>
      <ul style="margin:0 0 14px 0;padding-left:20px;font-size:13px;color:#374151;">
        <li>대시보드 상단의 "기록이 누락된 실험 메타데이터" 안내 확인</li>
        <li>실험을 새로 만드실 때 <b>코드 디렉토리</b> · <b>데이터 경로</b> · <b>사전 체크리스트</b> 를 함께 기록</li>
        <li>궁금한 점은 담당 관리자에게 문의</li>
      </ul>

      <p style="margin:18px 0 4px 0;font-size:12px;color:#9ca3af;">
        ${escapeHtml(BRAND_NAME)}${brandContactEmailOrNull() ? ` — 문의: <a href="mailto:${brandContactEmailOrNull()}" style="color:#2563eb;">${brandContactEmailOrNull()}</a>` : ""}
      </p>
    </div>
  `;

  try {
    const res = await sendEmail({
      to,
      subject: `[${BRAND_NAME}] 연구원 가입 승인 안내 — ${safeName}`,
      html,
    });
    if (!res.success) {
      console.error(
        `[LabNotify] registration approval email to ${to} failed: ${res.error}`,
      );
    }
  } catch (err) {
    console.error(
      `[LabNotify] registration approval email to ${to} threw:`,
      err instanceof Error ? err.message : err,
    );
  }
}

// ── 2. Experiment publication ──
//
// Called immediately after an experiment transitions from not-active
// → active. Emails every enabled lab member (admin + researcher) with
// the schedule. Uses BCC so member addresses aren't leaked to each
// other. Fire-and-forget: failures don't block the status change.
//
// "All members" = every non-disabled profile with role in
// ('admin','researcher'). The publishing researcher is included so
// they get delivery confirmation + the same member-view as everyone.

const WEEKDAY_LABELS_KO = ["일", "월", "화", "수", "목", "금", "토"];

function formatWeekdays(weekdays: number[] | null | undefined): string {
  if (!weekdays || weekdays.length === 0) return "-";
  const all = [0, 1, 2, 3, 4, 5, 6];
  if (
    weekdays.length === 7 &&
    all.every((w) => weekdays.includes(w))
  ) {
    return "매일";
  }
  const sorted = [...weekdays].sort((a, b) => a - b);
  return sorted.map((w) => WEEKDAY_LABELS_KO[w]).join(" · ");
}

interface PublishedExperimentInput {
  id: string;
  title: string;
  project_name: string | null;
  start_date: string;
  end_date: string;
  daily_start_time: string;
  daily_end_time: string;
  weekdays: number[] | null;
  session_duration_minutes: number;
  session_type: "single" | "multi";
  required_sessions: number;
  participation_fee: number;
  description?: string | null;
  experiment_mode?: "offline" | "online" | "hybrid";
  created_by: string | null;
}

export async function sendExperimentPublishedEmail(
  supabase: Supabase,
  experiment: PublishedExperimentInput,
): Promise<{ attempted: number; recipients: number }> {
  // Find every lab member with a deliverable email. Prefer
  // contact_email (public-facing) before falling back to their login
  // email (which is the internal {username}@ form).
  const { data: profiles } = await supabase
    .from("profiles")
    .select("id, display_name, email, contact_email, disabled, role")
    .in("role", ["admin", "researcher"])
    .eq("disabled", false);

  const rows = (profiles ?? []) as unknown as Array<{
    id: string;
    display_name: string | null;
    email: string;
    contact_email: string | null;
  }>;
  const recipientSet = new Set<string>();
  for (const p of rows) {
    const raw = (p.contact_email ?? "").trim() || p.email.trim();
    if (!raw) continue;
    // Skip the internal {username}@... form — these aren't real
    // inboxes. fromInternalEmail returns non-null for internal form.
    if (fromInternalEmail(p.email) === raw.split("@")[0] && !p.contact_email) {
      continue;
    }
    if (/@/.test(raw) && !raw.endsWith("@vnilab.local")) {
      recipientSet.add(raw);
    }
  }
  const bcc = [...recipientSet];
  if (bcc.length === 0) {
    console.warn("[LabNotify] experiment publish: no deliverable lab emails");
    return { attempted: 0, recipients: 0 };
  }

  // Publishing researcher name (for the "published by" footer).
  let publisherName = "담당 연구원";
  if (experiment.created_by) {
    const { data: me } = await supabase
      .from("profiles")
      .select("display_name")
      .eq("id", experiment.created_by)
      .maybeSingle();
    publisherName = ((me as { display_name?: string | null } | null)?.display_name ?? "담당 연구원").trim() || "담당 연구원";
  }

  const safeTitle = escapeHtml(experiment.title);
  const safeProject = experiment.project_name
    ? escapeHtml(experiment.project_name)
    : "-";
  const safePublisher = escapeHtml(publisherName);
  const detailUrl = `${appBase()}/experiments/${experiment.id}`;
  const bookingUrl = `${appBase()}/book/${experiment.id}`;

  const sessionLine =
    experiment.session_type === "multi"
      ? `${experiment.session_duration_minutes}분 × ${experiment.required_sessions}회차`
      : `${experiment.session_duration_minutes}분 단일 세션`;
  const feeLine =
    experiment.participation_fee > 0
      ? `${experiment.participation_fee.toLocaleString()}원`
      : "무료";
  const modeLine =
    experiment.experiment_mode === "online"
      ? "온라인"
      : experiment.experiment_mode === "hybrid"
        ? "하이브리드"
        : "오프라인";

  const descriptionBlock =
    experiment.description && experiment.description.trim().length > 0
      ? `
      <p style="margin:18px 0 6px 0;font-weight:600;">실험 소개</p>
      <p style="margin:0;line-height:1.6;white-space:pre-wrap;">${escapeHtml(
        experiment.description.trim(),
      )}</p>`
      : "";

  const html = `
    <div style="font-family:-apple-system,'Segoe UI',sans-serif;max-width:620px;margin:0 auto;padding:8px;color:#111827;line-height:1.55;">
      <div style="padding:14px 18px;background:#eff6ff;border:1px solid #93c5fd;border-radius:10px;margin-bottom:18px;">
        <p style="margin:0;font-size:15px;font-weight:600;color:#1d4ed8;">📣 새 실험이 공개되었습니다</p>
      </div>

      <p style="margin:0 0 14px 0;"><b>${safePublisher}</b>님이 <b>${safeTitle}</b> 실험을 공개했습니다.</p>

      <table style="border-collapse:collapse;width:100%;margin:14px 0;font-size:14px;">
        <tr>
          <td style="padding:10px 12px;border:1px solid #e5e7eb;background:#f9fafb;font-weight:600;width:110px;">프로젝트</td>
          <td style="padding:10px 12px;border:1px solid #e5e7eb;">${safeProject}</td>
        </tr>
        <tr>
          <td style="padding:10px 12px;border:1px solid #e5e7eb;background:#f9fafb;font-weight:600;">모집 기간</td>
          <td style="padding:10px 12px;border:1px solid #e5e7eb;">${formatDateKR(experiment.start_date)} ~ ${formatDateKR(experiment.end_date)}</td>
        </tr>
        <tr>
          <td style="padding:10px 12px;border:1px solid #e5e7eb;background:#f9fafb;font-weight:600;">운영 요일</td>
          <td style="padding:10px 12px;border:1px solid #e5e7eb;">${formatWeekdays(experiment.weekdays)}</td>
        </tr>
        <tr>
          <td style="padding:10px 12px;border:1px solid #e5e7eb;background:#f9fafb;font-weight:600;">운영 시간</td>
          <td style="padding:10px 12px;border:1px solid #e5e7eb;">${escapeHtml(experiment.daily_start_time)} ~ ${escapeHtml(experiment.daily_end_time)}</td>
        </tr>
        <tr>
          <td style="padding:10px 12px;border:1px solid #e5e7eb;background:#f9fafb;font-weight:600;">세션</td>
          <td style="padding:10px 12px;border:1px solid #e5e7eb;">${sessionLine} · ${modeLine}</td>
        </tr>
        <tr>
          <td style="padding:10px 12px;border:1px solid #e5e7eb;background:#f9fafb;font-weight:600;">참여비</td>
          <td style="padding:10px 12px;border:1px solid #e5e7eb;">${feeLine}</td>
        </tr>
      </table>

      ${descriptionBlock}

      <p style="margin:20px 0;">
        <a href="${detailUrl}" style="display:inline-block;padding:10px 18px;background:#2563eb;color:#ffffff;border-radius:6px;text-decoration:none;font-size:14px;font-weight:600;margin-right:6px;">실험 상세 보기 →</a>
        <a href="${bookingUrl}" style="display:inline-block;padding:10px 18px;background:#ffffff;color:#2563eb;border:1px solid #93c5fd;border-radius:6px;text-decoration:none;font-size:14px;font-weight:600;">예약 페이지 →</a>
      </p>

      <p style="margin:14px 0 4px 0;font-size:12px;color:#6b7280;">
        이 메일은 ${escapeHtml(BRAND_NAME)} 구성원 전체에게 발송됩니다 (BCC).
        참여자 모집 / 공동 운영 / 일정 조율이 필요한 경우 ${safePublisher}님께 직접 연락해 주세요.
      </p>
      <p style="margin:4px 0 0 0;font-size:12px;color:#9ca3af;">
        ${escapeHtml(BRAND_NAME)}${brandContactEmailOrNull() ? ` — 문의: <a href="mailto:${brandContactEmailOrNull()}" style="color:#2563eb;">${brandContactEmailOrNull()}</a>` : ""}
      </p>
    </div>
  `;

  // Lab-wide inbox is the canonical "to". Skip the send entirely if the
  // deploy never configured one (would otherwise email contact@example.com).
  // Individual researchers still see the publication in the admin UI.
  const labInbox = brandContactEmailOrNull();
  if (!labInbox) {
    console.warn(
      "[LabNotify] skipping experiment publish email: NEXT_PUBLIC_LAB_CONTACT_EMAIL not configured",
    );
    return { attempted: 0, recipients: bcc.length };
  }

  try {
    const res = await sendEmail({
      to: labInbox, // lab-wide inbox; individual members on BCC
      bcc,
      subject: `[${BRAND_NAME}] 새 실험 공개 — ${experiment.title}`,
      html,
    });
    if (!res.success) {
      console.error(
        `[LabNotify] experiment publish email failed: ${res.error}`,
      );
    }
    return { attempted: 1, recipients: bcc.length };
  } catch (err) {
    console.error(
      "[LabNotify] experiment publish email threw:",
      err instanceof Error ? err.message : err,
    );
    return { attempted: 1, recipients: 0 };
  }
}
