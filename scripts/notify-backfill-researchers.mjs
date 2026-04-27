#!/usr/bin/env node
// One-shot notification: each researcher whose description starts with
// [백필] gets a single email summarising their backfilled experiments
// + the gap fields they need to fill in.
//
// Why a separate script and not the metadata-reminders cron:
// metadata-reminders only scans status IN ('draft','active'), but the
// backfill rows are created with status='completed'. They wouldn't ever
// land in that cron's sweep. This script is the targeted bridge.
//
// Idempotent in principle: dry-run by default, --apply to actually
// send. The script doesn't track a "sent" log itself — operator runs
// it once after each backfill batch. Re-running sends again.
//
// Usage:
//   node scripts/notify-backfill-researchers.mjs            # dry-run
//   node scripts/notify-backfill-researchers.mjs --apply    # send

import { readFile } from "node:fs/promises";
import { createClient } from "@supabase/supabase-js";
import nodemailer from "nodemailer";

const env = await readFile(".env.local", "utf8");
for (const l of env.split("\n")) {
  const m = l.match(/^([A-Z_][A-Z0-9_]*)=(.*)$/);
  if (m && !process.env[m[1]]) process.env[m[1]] = m[2].replace(/^['"]|['"]$/g, "");
}

const APPLY = process.argv.includes("--apply");
const APP_BASE =
  process.env.NEXT_PUBLIC_APP_URL?.replace(/\/$/, "") ||
  "https://lab-reservation-seven.vercel.app";
const LAB_NAME = process.env.NEXT_PUBLIC_LAB_NAME || "VNI Lab";
const FROM = `"${LAB_NAME} 운영" <${process.env.GMAIL_USER}>`;

const sb = createClient(
  process.env.NEXT_PUBLIC_SUPABASE_URL,
  process.env.SUPABASE_SERVICE_ROLE_KEY,
  { auth: { persistSession: false } },
);

console.log(APPLY ? "MODE: APPLY (will send)" : "MODE: DRY-RUN");

// ── 1. find backfill experiments grouped by owner ─────────────────────
const { data: exps, error } = await sb
  .from("experiments")
  .select("id, title, project_name, created_by, protocol_version, location_id, participation_fee, description, start_date, end_date")
  .like("description", "[백필]%");
if (error) { console.error(error); process.exit(1); }
console.log(`Backfilled experiments found: ${exps.length}`);

if (exps.length === 0) {
  console.log("Nothing to notify.");
  process.exit(0);
}

const byOwner = new Map();
for (const e of exps) {
  if (!e.created_by) continue;
  const list = byOwner.get(e.created_by) ?? [];
  list.push(e);
  byOwner.set(e.created_by, list);
}

// ── 2. resolve owner profiles + booking counts ────────────────────────
const ownerIds = [...byOwner.keys()];
const { data: profiles } = await sb
  .from("profiles")
  .select("id, display_name, email, contact_email, disabled")
  .in("id", ownerIds);
const profById = new Map((profiles ?? []).map((p) => [p.id, p]));

async function bookingCount(expId) {
  const { count } = await sb
    .from("bookings")
    .select("id", { count: "exact", head: true })
    .eq("experiment_id", expId);
  return count ?? 0;
}

// ── 3. transport ──────────────────────────────────────────────────────
let transporter = null;
if (APPLY) {
  if (!process.env.GMAIL_USER || !process.env.GMAIL_APP_PASSWORD) {
    console.error("FATAL: GMAIL_USER / GMAIL_APP_PASSWORD missing");
    process.exit(1);
  }
  transporter = nodemailer.createTransport({
    host: "smtp.gmail.com", port: 587, secure: false,
    auth: { user: process.env.GMAIL_USER, pass: process.env.GMAIL_APP_PASSWORD },
  });
}

// ── 4. compose + send ────────────────────────────────────────────────
function gapFields(exp) {
  const gaps = [];
  if (!exp.protocol_version) gaps.push("protocol_version (예: 'v1.0', 'TimeExp Ver.1.1')");
  if (!exp.location_id) gaps.push("location (실험실 위치)");
  if (exp.participation_fee == null || exp.participation_fee === 0) gaps.push("participation_fee (참여자비)");
  return gaps;
}

const escapeHtml = (s) => String(s).replace(/[&<>"']/g, (c) => ({"&":"&amp;","<":"&lt;",">":"&gt;",'"':"&quot;","'":"&#39;"}[c]));

for (const [userId, expList] of byOwner) {
  const profile = profById.get(userId);
  if (!profile) { console.log(`  ! no profile for ${userId}`); continue; }
  if (profile.disabled) { console.log(`  - skip disabled: ${profile.email}`); continue; }
  const to = (profile.contact_email || profile.email || "").trim();
  if (!to || !to.includes("@")) {
    console.log(`  ! ${profile.email}: no valid contact_email — skipping`);
    continue;
  }

  const counts = await Promise.all(expList.map(async (e) => ({ exp: e, n: await bookingCount(e.id) })));
  const expRowsHtml = counts
    .map(({ exp, n }) => {
      const gaps = gapFields(exp);
      const url = `${APP_BASE}/admin/experiments/${exp.id}`;
      return `
        <tr>
          <td style="padding:8px;border:1px solid #e5e7eb;"><a href="${url}" style="color:#1d4ed8;text-decoration:none;">${escapeHtml(exp.title)}</a></td>
          <td style="padding:8px;border:1px solid #e5e7eb;">${exp.start_date} ~ ${exp.end_date}</td>
          <td style="padding:8px;border:1px solid #e5e7eb;text-align:center;">${n}</td>
          <td style="padding:8px;border:1px solid #e5e7eb;color:#b91c1c;font-size:12px;">${gaps.length ? gaps.map(escapeHtml).join("<br/>") : "—"}</td>
        </tr>`;
    })
    .join("");

  const subject = `[${LAB_NAME}] 캘린더 백필 완료 — ${expList.length}개 실험 정보 보완 요청`;
  const html = `
    <div style="font-family:-apple-system,'Segoe UI',sans-serif;max-width:700px;margin:0 auto;padding:16px;color:#111827;line-height:1.55;">
      <div style="padding:14px 18px;background:#eff6ff;border:1px solid #93c5fd;border-radius:10px;margin-bottom:18px;">
        <p style="margin:0;font-size:15px;font-weight:600;color:#1e40af;">📦 캘린더 백필이 적용되었습니다</p>
      </div>
      <p>안녕하세요, ${escapeHtml(profile.display_name ?? "연구원")}님.</p>
      <p>${LAB_NAME} 예약 시스템에 ${LAB_NAME} 공유 캘린더의 2026년 ${LAB_NAME} 실험 일정이 백필되었습니다. 아래 ${expList.length}개 실험이 본인 계정 하에 등록되었으며, 일부 정보는 캘린더에서 추출할 수 없어 비어 있습니다.</p>

      <table style="border-collapse:collapse;width:100%;margin:14px 0;font-size:14px;">
        <thead>
          <tr style="background:#f9fafb;">
            <th style="padding:8px;border:1px solid #e5e7eb;text-align:left;">실험명</th>
            <th style="padding:8px;border:1px solid #e5e7eb;text-align:left;">기간</th>
            <th style="padding:8px;border:1px solid #e5e7eb;text-align:center;">예약 수</th>
            <th style="padding:8px;border:1px solid #e5e7eb;text-align:left;">보완 필요</th>
          </tr>
        </thead>
        <tbody>${expRowsHtml}</tbody>
      </table>

      <p style="margin:18px 0 6px 0;font-size:13px;color:#6b7280;">
        각 실험명을 클릭하면 관리자 대시보드의 상세 페이지로 이동합니다.
        <b>protocol_version</b>·<b>location</b>·<b>participation_fee</b>는 추후 결과 분석/정산 단계에서 필요하므로 가능한 한 빨리 채워주세요.
      </p>
      <p style="margin:6px 0;font-size:13px;color:#6b7280;">
        참여자 정보(연락처)도 캘린더에 없으면 공란으로 두었습니다 (이름은 그대로).
        같은 인물이 한국어/영문 이름으로 중복 등록된 경우가 있을 수 있어 — 참여자 목록에서 중복 정리 부탁드립니다.
      </p>
      <p style="margin:6px 0;font-size:12px;color:#9ca3af;">
        ${LAB_NAME} — calendar-backfill notification (1회성)
      </p>
    </div>
  `;

  const total = counts.reduce((a, c) => a + c.n, 0);
  console.log(`  → ${profile.email.padEnd(15)} (${to})  ${expList.length} exps / ${total} bookings`);
  if (!APPLY) continue;

  try {
    const info = await transporter.sendMail({ from: FROM, to, subject, html });
    console.log(`     ✓ sent ${info.messageId}`);
  } catch (err) {
    console.error(`     ✗ failed:`, err instanceof Error ? err.message : err);
  }
}

console.log(APPLY ? "\nDone." : "\nDry-run only. Re-run with --apply to send.");
