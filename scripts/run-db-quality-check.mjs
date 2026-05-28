#!/usr/bin/env node
// Local-runnable mirror of /api/cron/db-quality-check.
//
// Used to run the daily DB-quality sweep manually when the production
// cron route can't be reached (e.g. CRON_SECRET not decryptable via
// `vercel env pull` in the operator's shell). Sweeps every non-disabled
// researcher, classifies metadata gaps the same way the cron route +
// /metadata-fill page do, sends the calendar-grounded interview email,
// and writes one metadata_reminder_log row per send so future cron
// runs see today's notification and respect the 20-hour dedup window.
//
// Usage:
//   node scripts/run-db-quality-check.mjs           # DRY-RUN
//   node scripts/run-db-quality-check.mjs --apply   # actually send
//   node scripts/run-db-quality-check.mjs --apply --only BYL,SMJ
//
// 우선순위가 cron HTTP 라우트 → 이 script 인 이유: cron 은 GH Actions
// secret 으로 동작하고, log 가 한 번 쌓이면 rate-limit (20h) 으로 다음
// 호출이 자동 skip 됩니다. 이 script 도 같은 log 에 쓰므로 두 채널이
// 같은 dedup 윈도우를 공유합니다.

import { readFile } from "node:fs/promises";
import { createClient } from "@supabase/supabase-js";
import nodemailer from "nodemailer";

const env = await readFile(".env.local", "utf8");
for (const l of env.split("\n")) {
  const m = l.match(/^([A-Z_][A-Z0-9_]*)=(.*)$/);
  if (m && !process.env[m[1]]) process.env[m[1]] = m[2].replace(/^['"]|['"]$/g, "");
}

const APPLY = process.argv.includes("--apply");
const FORCE = process.argv.includes("--force"); // bypass dedup + no-progress (one-shot announcements)
const onlyIdx = process.argv.indexOf("--only");
const ONLY = onlyIdx !== -1
  ? new Set(
      process.argv[onlyIdx + 1]
        .toUpperCase()
        .split(",")
        .map((s) => s.trim()),
    )
  : null;

const DEDUP_WINDOW_HOURS = 20;
const APP_URL = "https://lab-reservation-seven.vercel.app";
const BRAND_NAME = process.env.NEXT_PUBLIC_LAB_NAME || "CSNL";

const sb = createClient(
  process.env.NEXT_PUBLIC_SUPABASE_URL,
  process.env.SUPABASE_SERVICE_ROLE_KEY,
  { auth: { persistSession: false } },
);

const GAP_FIELDS = [
  ["code_repo_url", "분석 코드 저장소/디렉토리", true],
  ["data_path", "원본 데이터 경로", true],
  ["pre_experiment_checklist", "사전 체크리스트", false],
  ["protocol_version", "프로토콜 버전", false],
  ["location_id", "장소", false],
  ["description", "실험 소개", false],
  ["participation_fee", "참여비", false],
  ["irb_document_url", "IRB 문서 URL", false],
  ["recruitment_target", "모집 인원", false],
];
const isEmpty = (f, v) =>
  v == null ||
  v === "" ||
  (Array.isArray(v) && v.length === 0) ||
  (typeof v === "string" && v.trim() === "") ||
  (f === "participation_fee" && v === 0);
const escapeHtml = (s) =>
  String(s ?? "")
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;");

// ── inventory ────────────────────────────────────────────────────────
const { data: profs } = await sb
  .from("profiles")
  .select("id, display_name, email, contact_email, role, disabled")
  .in("role", ["admin", "researcher"])
  .eq("disabled", false);

const cutoffIso = new Date(
  Date.now() - DEDUP_WINDOW_HOURS * 3_600_000,
).toISOString();
const { data: recent } = await sb
  .from("metadata_reminder_log")
  .select("researcher_user_id, sent_at")
  .gte("sent_at", cutoffIso);
const recentlyNotified = new Set(
  (recent ?? []).map((r) => r.researcher_user_id),
);

// "No progress" skip: also pull each researcher's most recent log row
// within the last 7 days. If today's required-gap count equals the
// last reminder's required-gap count, the researcher hasn't acted —
// don't re-nag. Only triggers when 20h dedup didn't catch (so e.g. a
// reminder 26h ago + zero progress today → still skip).
const sevenDaysAgo = new Date(Date.now() - 7 * 86_400_000).toISOString();
const { data: priorAll } = await sb
  .from("metadata_reminder_log")
  .select("researcher_user_id, sent_at, gap_summary")
  .gte("sent_at", sevenDaysAgo)
  .order("sent_at", { ascending: false });
const lastReqCountByUser = new Map();
for (const r of priorAll ?? []) {
  if (lastReqCountByUser.has(r.researcher_user_id)) continue;
  const n = r.gap_summary?.required_gaps;
  if (typeof n === "number") lastReqCountByUser.set(r.researcher_user_id, n);
}

const inventory = [];
for (const p of profs ?? []) {
  const init = p.email.split("@")[0].toUpperCase();
  if (ONLY && !ONLY.has(init)) continue;
  const { data: exps } = await sb
    .from("experiments")
    .select(
      "id, title, project_name, status, start_date, end_date, code_repo_url, data_path, pre_experiment_checklist, protocol_version, location_id, description, participation_fee, irb_document_url, recruitment_target",
    )
    .eq("created_by", p.id)
    .eq("is_project", true) // 2026-05-28: pilot/장비테스트 면제 처리된 행은 제외
    .in("status", ["draft", "active", "completed"]);
  const ids = (exps ?? []).map((e) => e.id);
  const bkCount = {};
  if (ids.length > 0) {
    const { data: bks } = await sb
      .from("bookings")
      .select("experiment_id")
      .in("experiment_id", ids)
      .in("status", ["confirmed", "completed", "running", "no_show"]);
    for (const b of bks ?? [])
      bkCount[b.experiment_id] = (bkCount[b.experiment_id] ?? 0) + 1;
  }
  const rows = (exps ?? [])
    .map((e) => {
      const requiredGaps = GAP_FIELDS.filter(([f, , req]) => req && isEmpty(f, e[f]));
      const optionalGaps = GAP_FIELDS.filter(([f, , req]) => !req && isEmpty(f, e[f]));
      return { exp: e, bookings: bkCount[e.id] ?? 0, requiredGaps, optionalGaps };
    })
    .filter((r) => r.requiredGaps.length + r.optionalGaps.length > 0);
  if (rows.length === 0) continue;
  inventory.push({ profile: p, init, rows });
}

console.log(APPLY ? "MODE: APPLY" : "MODE: DRY-RUN");
console.log(`Researchers with gaps: ${inventory.length}`);
console.log("");

// ── render + send ────────────────────────────────────────────────────
function renderHtml(g) {
  const totalReq = g.rows.reduce((n, r) => n + r.requiredGaps.length, 0);
  const cards = g.rows
    .map((r) => {
      const req = r.requiredGaps.map((x) => escapeHtml(x[1])).join(", ");
      const opt = r.optionalGaps.map((x) => escapeHtml(x[1])).join(", ");
      return `
      <div style="margin:14px 0;padding:14px 16px;border:1px solid #e5e7eb;border-radius:10px;background:#f9fafb;">
        <p style="margin:0;font-size:14px;font-weight:600;color:#111827;">
          ${escapeHtml(r.exp.title)}
          <span style="font-weight:400;color:#6b7280;font-size:12px;"> · ${escapeHtml(r.exp.project_name ?? "-")} · ${escapeHtml(r.exp.status)}</span>
        </p>
        <p style="margin:4px 0 0 0;font-size:12px;color:#6b7280;">
          모집기간 ${r.exp.start_date} ~ ${r.exp.end_date} · 캘린더 예약 ${r.bookings}건 기록됨
        </p>
        ${req ? `<p style="margin:8px 0 0 0;font-size:13px;color:#9a3412;"><b>활성화 필요:</b> ${req}</p>` : ""}
        ${opt ? `<p style="margin:6px 0 0 0;font-size:13px;color:#374151;">권장: ${opt}</p>` : ""}
      </div>`;
    })
    .join("");
  return `<!doctype html><html lang="ko"><head><meta charset="utf-8"><meta name="color-scheme" content="light only"><title>실험 메타데이터 입력 요청</title></head><body style="margin:0;background:#fff;color:#111827;">
<div style="max-width:640px;margin:0 auto;padding:24px 18px;font-family:-apple-system,'Apple SD Gothic Neo','Malgun Gothic',sans-serif;line-height:1.65;font-size:14px;">
  <div style="padding:14px 18px;background:#eff6ff;border:1px solid #93c5fd;border-radius:10px;margin-bottom:18px;">
    <p style="margin:0;font-size:15px;font-weight:600;color:#1d4ed8;">📋 실험 메타데이터 입력 요청 — ${escapeHtml(g.profile.display_name ?? "")}님</p>
  </div>
  <p style="margin:0 0 10px 0;">안녕하세요, <b>${escapeHtml(g.profile.display_name ?? "")}</b>님.</p>
  <p style="margin:0 0 14px 0;">
    캘린더에 기록된 실험 중 Lab DB 의 메타데이터(코드 경로 / 데이터 경로 / 프로토콜 / 장소 등) 가
    비어 있는 항목이 있습니다. 이 정보가 채워져야 향후 분석 재현, 정산 자동 처리, 참여자 모집/홍보까지 묶여 동작합니다.
  </p>
  <p style="margin:0 0 18px 0;">
    아래 ${g.rows.length}개 실험에 채워야 할 항목이 있습니다.
    <b>활성화 필요</b> ${totalReq}건은 실험을 다시 <code>active</code> 로 돌리거나 새 정산 흐름을 태우려면 필수입니다.
  </p>
  <p style="margin:0 0 16px 0;text-align:center;">
    <a href="${APP_URL}/metadata-fill" style="display:inline-block;padding:12px 22px;background:#2563eb;color:#ffffff;border-radius:6px;text-decoration:none;font-size:15px;font-weight:600;">한 페이지에서 한번에 입력 →</a>
  </p>
  <p style="margin:0 0 18px 0;text-align:center;font-size:12px;color:#6b7280;">${APP_URL}/metadata-fill</p>
  <h3 style="margin:24px 0 8px 0;font-size:14px;">실험별 현황</h3>
  ${cards}
  <p style="margin:20px 0 6px 0;font-size:13px;color:#374151;">
    카드별 <b>"이 실험 저장"</b> 버튼은 그 실험만 갱신합니다. 본 메일은 매일 09:00 KST 에 비어 있는 항목이 남아있을 때만 자동 발송됩니다.
  </p>
  <p style="margin:6px 0 0 0;padding:10px 12px;font-size:13px;color:#374151;background:#fef9c3;border:1px solid #fde68a;border-radius:8px;">
    💡 <b>pilot · 장비 테스트 · 일회성 예약</b> 처럼 정식 프로젝트가 아닌 항목은
    각 카드 우측 상단의 <b>"프로젝트 아님 (면제)"</b> 버튼으로 면제 처리할 수 있습니다.
    면제 처리된 실험은 이 안내에서 자동으로 빠집니다.
  </p>
  <p style="margin:18px 0 4px 0;font-size:12px;color:#9ca3af;">문의: <a href="mailto:vnilab@gmail.com" style="color:#2563eb;">vnilab@gmail.com</a></p>
</div></body></html>`;
}

const transporter = APPLY
  ? nodemailer.createTransport({
      host: "smtp.gmail.com",
      port: 587,
      secure: false,
      auth: { user: process.env.GMAIL_USER, pass: process.env.GMAIL_APP_PASSWORD },
    })
  : null;

let sent = 0, rateLimited = 0, noProgress = 0, noContact = 0, failed = 0;
for (const g of inventory) {
  const totalReq = g.rows.reduce((n, r) => n + r.requiredGaps.length, 0);
  if (!FORCE && recentlyNotified.has(g.profile.id)) {
    rateLimited += 1;
    console.log(`  ⏸ ${g.init.padEnd(5)} ${g.profile.display_name}  rate-limited (last reminder <20h ago)`);
    continue;
  }
  const lastReq = lastReqCountByUser.get(g.profile.id);
  if (!FORCE && lastReq != null && lastReq === totalReq) {
    noProgress += 1;
    console.log(`  ⏸ ${g.init.padEnd(5)} ${g.profile.display_name}  no-progress (last reminder still ${lastReq} required, skipping today)`);
    continue;
  }
  const to = g.profile.contact_email?.trim();
  if (!to || !/@/.test(to)) {
    noContact += 1;
    console.log(`  ! ${g.init.padEnd(5)} ${g.profile.display_name}  no contact_email`);
    continue;
  }
  console.log(`  ${APPLY ? "→" : "·"} ${g.init.padEnd(5)} ${g.profile.display_name.padEnd(11)} ${to}  ${g.rows.length} exps, ${totalReq} required`);
  if (!APPLY) continue;
  try {
    const info = await transporter.sendMail({
      from: `"${BRAND_NAME}" <${process.env.GMAIL_USER}>`,
      to,
      cc: process.env.GMAIL_USER,
      subject: `[${BRAND_NAME}] 실험 메타데이터 입력 요청 — ${g.profile.display_name}님 (${g.rows.length}건)`,
      html: renderHtml(g),
    });
    const { error: logErr } = await sb.from("metadata_reminder_log").insert({
      researcher_user_id: g.profile.id,
      sent_at: new Date().toISOString(),
      email_to: to,
      experiment_count: g.rows.length,
      gap_summary: {
        source: "run-db-quality-check.mjs",
        required_gaps: totalReq,
        rows: g.rows.map((r) => ({
          id: r.exp.id,
          title: r.exp.title,
          required: r.requiredGaps.map((x) => x[1]),
          optional: r.optionalGaps.map((x) => x[1]),
        })),
      },
    });
    if (logErr) console.error(`    ! log insert: ${logErr.message}`);
    sent += 1;
    console.log(`    ✓ sent — ${info.messageId}`);
  } catch (err) {
    failed += 1;
    console.error(`    ✗ ${err.message}`);
  }
}

console.log(
  `\n${APPLY ? "Done" : "Dry-run"}. sent=${sent} rate-limited=${rateLimited} no-progress=${noProgress} no-contact=${noContact} failed=${failed} of ${inventory.length} researchers with gaps.`,
);
if (!APPLY) console.log("Re-run with --apply to send.");
