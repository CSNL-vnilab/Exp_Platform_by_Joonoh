import { NextResponse } from "next/server";
import type { NextRequest } from "next/server";
import { z } from "zod";
import { createClient } from "@/lib/supabase/server";
import { createAdminClient } from "@/lib/supabase/admin";
import { isValidUUID } from "@/lib/utils/validation";
import { sendEmail } from "@/lib/google/gmail";
import {
  buildPromoTemplate,
  renderPromoHtml,
  type PromoExperimentInput,
} from "@/lib/services/participant-promo-email";

// /api/participants/promo-email
//
// Admin-only recruitment ("홍보") blast. Deliberate template→preview→
// send flow; nothing auto-fires.
//
//   GET                    → lab-wide active experiments (dropdown).
//   POST {mode:"preview"}  → editable {subject, body} (seeded from the
//                            experiment template when omitted) + the
//                            rendered HTML + recipient breakdown.
//   POST {mode:"send", confirm:true}
//                          → ONE email: To = the lab sending account
//                            (self), BCC = every deliverable selected
//                            participant. Same body to all. Logs one
//                            participant_promo_sends row per recipient.
//
// BCC (not per-recipient To) per the 2026-05-19 spec: a single send,
// addresses hidden from each other.

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

const MAX_RECIPIENTS = 1000;

function isUndeliverableEmail(raw: string | null | undefined): boolean {
  const s = (raw ?? "").trim();
  if (!s || !/^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(s)) return true;
  if (/@-$|@no-email\.local$|@imported\.invalid$/.test(s)) return true;
  if (s.endsWith("@vnilab.local") || s.endsWith("@example.com")) return true;
  return false;
}

// 2026-05-19 directive: the 홍보 발송 workflow is open to every
// authenticated lab member (admin + researcher), not admin-only.
// Disabled accounts are still rejected.
async function requireMember(): Promise<
  | { ok: true; userId: string; admin: ReturnType<typeof createAdminClient> }
  | { ok: false; status: number; error: string }
> {
  const supabase = await createClient();
  const {
    data: { user },
    error: authError,
  } = await supabase.auth.getUser();
  if (authError || !user) {
    return { ok: false, status: 401, error: "Unauthorized" };
  }
  const admin = createAdminClient();
  const { data: profile } = await admin
    .from("profiles")
    .select("role, disabled")
    .eq("id", user.id)
    .maybeSingle();
  const p = profile as { role?: string; disabled?: boolean } | null;
  if (!p || p.disabled || (p.role !== "admin" && p.role !== "researcher")) {
    return { ok: false, status: 403, error: "Forbidden" };
  }
  return { ok: true, userId: user.id, admin };
}

export async function GET() {
  const auth = await requireMember();
  if (!auth.ok) {
    return NextResponse.json({ error: auth.error }, { status: auth.status });
  }
  const { data, error } = await auth.admin
    .from("experiments")
    .select("id, title, project_name, status, start_date, end_date")
    .eq("status", "active")
    .order("created_at", { ascending: false });
  if (error) {
    return NextResponse.json(
      { error: "활성 실험 목록을 불러오지 못했습니다" },
      { status: 500 },
    );
  }
  return NextResponse.json({ experiments: data ?? [] });
}

const bodySchema = z.object({
  experimentId: z.string().refine(isValidUUID, "Invalid experiment ID"),
  participantIds: z.array(z.string()).min(1).max(MAX_RECIPIENTS),
  mode: z.enum(["preview", "send"]),
  subject: z.string().trim().min(1).max(300).optional(),
  body: z.string().min(1).max(20000).optional(),
  confirm: z.boolean().optional(),
});

export async function POST(request: NextRequest) {
  const auth = await requireMember();
  if (!auth.ok) {
    return NextResponse.json({ error: auth.error }, { status: auth.status });
  }
  const { admin, userId } = auth;

  let json: unknown;
  try {
    json = await request.json();
  } catch {
    return NextResponse.json({ error: "Invalid JSON" }, { status: 400 });
  }
  const parsed = bodySchema.safeParse(json);
  if (!parsed.success) {
    return NextResponse.json(
      { error: "Validation failed", issues: parsed.error.issues },
      { status: 400 },
    );
  }
  const { experimentId, participantIds, mode } = parsed.data;
  const ids = [...new Set(participantIds)].filter(isValidUUID);
  if (ids.length === 0) {
    return NextResponse.json({ error: "유효한 참여자가 없습니다" }, { status: 400 });
  }

  const { data: exp } = await admin
    .from("experiments")
    .select(
      "id, title, project_name, status, start_date, end_date, daily_start_time, daily_end_time, weekdays, session_duration_minutes, session_type, required_sessions, participation_fee, description, experiment_mode",
    )
    .eq("id", experimentId)
    .maybeSingle();
  if (!exp) {
    return NextResponse.json({ error: "실험을 찾을 수 없습니다" }, { status: 404 });
  }
  if (exp.status !== "active") {
    return NextResponse.json(
      { error: "활성(진행 중) 상태인 실험만 홍보 메일을 보낼 수 있습니다" },
      { status: 400 },
    );
  }
  const experiment: PromoExperimentInput = {
    id: exp.id,
    title: exp.title,
    project_name: exp.project_name ?? null,
    start_date: exp.start_date,
    end_date: exp.end_date,
    daily_start_time: exp.daily_start_time ?? null,
    daily_end_time: exp.daily_end_time ?? null,
    weekdays: exp.weekdays ?? null,
    session_duration_minutes: exp.session_duration_minutes,
    session_type: exp.session_type as "single" | "multi",
    required_sessions: exp.required_sessions,
    participation_fee: exp.participation_fee,
    description: exp.description ?? null,
    experiment_mode:
      (exp.experiment_mode as "offline" | "online" | "hybrid" | null) ?? null,
  };

  // Resolve recipients.
  const { data: participantRows } = await admin
    .from("participants")
    .select("id, name, email")
    .in("id", ids);
  const participants = (participantRows ?? []) as Array<{
    id: string;
    name: string | null;
    email: string | null;
  }>;
  const { data: priorRows } = await admin
    .from("participant_promo_sends")
    .select("participant_id, status")
    .eq("experiment_id", experimentId)
    .in("participant_id", ids);
  const alreadySent = new Set(
    ((priorRows ?? []) as Array<{ participant_id: string; status: string }>)
      .filter((r) => r.status === "sent")
      .map((r) => r.participant_id),
  );
  const recipients = participants.map((p) => {
    const email = (p.email ?? "").trim();
    return {
      id: p.id,
      name: p.name ?? null,
      email,
      deliverable: !isUndeliverableEmail(email),
      alreadySent: alreadySent.has(p.id),
    };
  });
  const deliverable = recipients.filter((r) => r.deliverable);

  // Effective subject/body — operator edits override the template seed.
  const template = buildPromoTemplate(experiment);
  const subject = parsed.data.subject?.trim() || template.subject;
  const body = parsed.data.body ?? template.body;

  if (mode === "preview") {
    return NextResponse.json({
      experiment: { id: experiment.id, title: experiment.title },
      subject,
      body,
      html: renderPromoHtml(body),
      recipients,
      counts: {
        selected: recipients.length,
        deliverable: deliverable.length,
        undeliverable: recipients.length - deliverable.length,
        alreadySent: recipients.filter((r) => r.alreadySent).length,
      },
    });
  }

  // ── send ──
  if (parsed.data.confirm !== true) {
    return NextResponse.json(
      { error: "confirm:true is required to send" },
      { status: 400 },
    );
  }
  if (deliverable.length === 0) {
    return NextResponse.json(
      { error: "발송 가능한 이메일 주소를 가진 참여자가 없습니다" },
      { status: 400 },
    );
  }
  const self = (process.env.GMAIL_USER ?? "").trim();
  if (!self) {
    return NextResponse.json(
      { error: "발신 계정(GMAIL_USER)이 설정되어 있지 않습니다" },
      { status: 500 },
    );
  }

  const html = renderPromoHtml(body);
  const bcc = deliverable.map((r) => r.email);
  const res = await sendEmail({
    to: self, // self — addresses are hidden in BCC
    bcc,
    subject,
    html,
    text: body,
  });

  // One audit row per deliverable recipient, sharing the message-id.
  const status: "sent" | "failed" = res.success ? "sent" : "failed";
  const auditRows = deliverable.map((r) => ({
    experiment_id: experimentId,
    participant_id: r.id,
    email: r.email,
    status,
    message_id: res.messageId ?? null,
    error: res.success ? null : (res.error ?? "send failed").slice(0, 500),
    sent_by: userId,
  }));
  if (auditRows.length > 0) {
    const { error: logErr } = await admin
      .from("participant_promo_sends")
      .insert(auditRows);
    if (logErr) {
      console.error("[PromoEmail] audit insert failed:", logErr.message);
    }
  }

  if (!res.success) {
    return NextResponse.json(
      { error: `발송 실패: ${res.error ?? "unknown"}` },
      { status: 502 },
    );
  }
  return NextResponse.json({
    ok: true,
    messageId: res.messageId ?? null,
    counts: {
      sent: deliverable.length,
      undeliverable: recipients.length - deliverable.length,
    },
  });
}
