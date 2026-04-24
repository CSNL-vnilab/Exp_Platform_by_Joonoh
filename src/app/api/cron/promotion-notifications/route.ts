import { NextResponse } from "next/server";
import type { NextRequest } from "next/server";
import { createAdminClient } from "@/lib/supabase/admin";
import { authorizeCronRequest } from "@/lib/auth/cron-secret";
import { sendEmail } from "@/lib/google/gmail";
import { BRAND_NAME } from "@/lib/branding";
import { escapeHtml } from "@/lib/utils/validation";
import { formatDateKR, formatTimeKR } from "@/lib/utils/date";

// D8 — email researchers when one of their participants auto-promotes to
// Royal. Reads `pending_promotion_notifications()` (migration 00038),
// sends one email per (audit × researcher) pair via the existing Gmail
// transport, and inserts a `class_promotion_notifications` row so the
// next sweep skips it.
//
// Intentionally narrow: only `changed_kind='auto' AND new_class='royal'`
// transitions. Manual assignments (admin bumps) don't need an email —
// the admin doing the bump already knows.
//
// PII-wise: the email surfaces the participant's PUBLIC_CODE
// (CSNL-XXXXXX), NOT their name, in line with invariant #1 (PII stays
// out of external surfaces where possible). Researchers already have
// the participant's identity via the /participants/[id] page.

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

const MAX_SENDS_PER_SWEEP = 30; // guard against stampede
const MIN_GMAIL_DELAY_MS = 250; // Gmail quota ≪ 3rps; this is plenty

function sleep(ms: number): Promise<void> {
  return new Promise((r) => setTimeout(r, ms));
}

interface Candidate {
  audit_id: string;
  participant_id: string;
  lab_id: string;
  lab_code: string | null;
  new_class: string;
  previous_class: string | null;
  audit_created_at: string;
  researcher_user_id: string;
  researcher_contact_email: string | null;
  researcher_display_name: string | null;
  public_code: string | null;
}

function buildEmailHtml(c: Candidate): string {
  const researcherName = escapeHtml(
    c.researcher_display_name || "담당 연구원",
  );
  const code = c.public_code
    ? escapeHtml(c.public_code)
    : `<code>${escapeHtml(c.participant_id.slice(0, 8))}…</code>`;
  const prev = c.previous_class ? escapeHtml(c.previous_class) : "뉴비";
  const when = `${formatDateKR(c.audit_created_at)} ${formatTimeKR(c.audit_created_at)}`;
  return `
    <div style="font-family:-apple-system,'Segoe UI',sans-serif;max-width:620px;margin:0 auto;padding:16px;color:#111827;line-height:1.55;">
      <div style="padding:14px 18px;background:#fdf4ff;border:1px solid #d8b4fe;border-radius:10px;margin-bottom:18px;">
        <p style="margin:0;font-size:15px;font-weight:600;color:#6b21a8;">
          🎉 참여자 등급이 <b>Royal</b> 로 자동 승급되었습니다
        </p>
      </div>

      <p>안녕하세요, ${researcherName}님.</p>
      <p>
        ${c.lab_code ? escapeHtml(c.lab_code) + " 랩" : "랩"}에서 다음 참여자가
        누적 완료 세션 기준을 충족하여 Royal 등급으로 자동 승급되었습니다.
      </p>

      <table style="border-collapse:collapse;width:100%;margin:14px 0;font-size:14px;">
        <tr>
          <td style="padding:10px 12px;border:1px solid #e5e7eb;background:#f9fafb;font-weight:600;width:130px;">공개 ID</td>
          <td style="padding:10px 12px;border:1px solid #e5e7eb;"><code>${code}</code></td>
        </tr>
        <tr>
          <td style="padding:10px 12px;border:1px solid #e5e7eb;background:#f9fafb;font-weight:600;">이전 등급</td>
          <td style="padding:10px 12px;border:1px solid #e5e7eb;">${prev} → Royal</td>
        </tr>
        <tr>
          <td style="padding:10px 12px;border:1px solid #e5e7eb;background:#f9fafb;font-weight:600;">승급 시각</td>
          <td style="padding:10px 12px;border:1px solid #e5e7eb;">${when} (KST)</td>
        </tr>
      </table>

      <p style="margin:18px 0 6px 0;font-size:13px;color:#6b7280;">
        참여자 상세는 관리자 대시보드 →
        <b>참여자 관리</b> → 공개 ID 검색에서 확인할 수 있습니다.
        Royal 등급은 자동 규칙 (누적 완료 15세션 이상) 으로 부여되며,
        수동 조정이 필요한 경우 참여자 상세 페이지의 <b>클래스 변경</b>
        을 사용해 주세요.
      </p>
      <p style="margin:4px 0 0 0;font-size:12px;color:#9ca3af;">
        ${BRAND_NAME} — class change audit trail
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
    const { data: rawCandidates, error } = await admin.rpc(
      "pending_promotion_notifications",
    );
    if (error) {
      console.error("[PromoCron] RPC failed:", error.message);
      return NextResponse.json(
        { error: "Supabase RPC failed", detail: error.message },
        { status: 500 },
      );
    }

    const candidates = (rawCandidates ?? []) as unknown as Candidate[];
    const toProcess = candidates.slice(0, MAX_SENDS_PER_SWEEP);

    let sent = 0;
    let failed = 0;
    let skipped = 0;
    let rateLimitedAt: string | null = null;
    const results: Array<{
      audit_id: string;
      researcher_user_id: string;
      ok: boolean;
      error?: string;
    }> = [];

    for (let i = 0; i < toProcess.length; i += 1) {
      const c = toProcess[i];
      if (i > 0) await sleep(MIN_GMAIL_DELAY_MS);

      const to = (c.researcher_contact_email ?? "").trim();
      // H7 fix: the RPC (migration 00040) no longer returns rows
      // with missing contact_email, but defense-in-depth — skip here
      // too WITHOUT writing a tracking row so the researcher can set
      // contact_email later and the row re-enters the queue.
      if (!to || !to.includes("@")) {
        skipped += 1;
        results.push({
          audit_id: c.audit_id,
          researcher_user_id: c.researcher_user_id,
          ok: false,
          error: "missing researcher email (deferred)",
        });
        continue;
      }

      const subject = `[${BRAND_NAME}] 참여자 Royal 승급 알림 · ${
        c.public_code ?? c.participant_id.slice(0, 8)
      }`;
      const result = await sendEmail({
        to,
        subject,
        html: buildEmailHtml(c),
      });

      if (result.success) {
        // H1 fix: only record success rows without error_message so the
        // RPC treats them as delivered. Transient Gmail errors (below)
        // do NOT insert a tracking row — next sweep retries.
        await admin.from("class_promotion_notifications").insert({
          audit_id: c.audit_id,
          researcher_user_id: c.researcher_user_id,
          email_to: to,
          error_message: null,
        });
        sent += 1;
        results.push({
          audit_id: c.audit_id,
          researcher_user_id: c.researcher_user_id,
          ok: true,
        });
      } else {
        // Classify the error. Per RFC 5321, SMTP 4xx is transient (mail
        // server should retry) and 5xx is permanent (give up). Nodemailer
        // surfaces the SMTP reply in err.message. Transient patterns:
        // - SMTP 4xx codes (4\d\d as a word)
        // - HTTP 429 (rate limit, sometimes surfaced by Gmail API paths)
        // - Quota / greylisting / temporary wording
        // - Network errors (ETIMEDOUT/ECONNRESET/ENOTFOUND/ECONNABORTED)
        // 5xx is deliberately excluded so 550 "user unknown" and 553
        // "invalid mailbox" don't spin forever. 552 (over quota) often
        // recovers next day, but leaving it permanent is safer than an
        // infinite loop against a mis-addressed recipient.
        const err = result.error ?? "unknown";
        // Scrub recipient email from error body (L6 reviewer concern).
        const scrubbed = err
          .replace(/\b[\w._%+-]+@[\w.-]+\.[A-Za-z]{2,}\b/g, "<email>")
          .slice(0, 500);
        const isTransient =
          /\b4\d\d\b|\b429\b|ETIMEDOUT|ECONNRESET|ENOTFOUND|ECONNABORTED|rate[ _-]?limit|quota|temporar|greylist|try again|busy/i.test(
            err,
          );
        if (!isTransient) {
          await admin.from("class_promotion_notifications").insert({
            audit_id: c.audit_id,
            researcher_user_id: c.researcher_user_id,
            email_to: to,
            error_message: scrubbed,
          });
        }
        failed += 1;
        results.push({
          audit_id: c.audit_id,
          researcher_user_id: c.researcher_user_id,
          ok: false,
          error: scrubbed,
        });

        // M4 fix: on the FIRST transient failure, stop the sweep. Don't
        // burn the remaining quota against a locked-out Gmail account.
        if (isTransient) {
          rateLimitedAt = new Date().toISOString();
          break;
        }
      }
    }

    return NextResponse.json({
      ok: true,
      candidates: candidates.length,
      processed: toProcess.length,
      sent,
      failed,
      skipped,
      rate_limited_at: rateLimitedAt,
      duration_ms: Date.now() - started,
      results,
    });
  } catch (err) {
    console.error("[PromoCron] error:", err);
    return NextResponse.json(
      { error: err instanceof Error ? err.message : "Internal server error" },
      { status: 500 },
    );
  }
}

export const GET = handle;
export const POST = handle;
