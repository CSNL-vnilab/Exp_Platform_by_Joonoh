#!/usr/bin/env node
// Calendar-grounded metadata-interview email for backfilled-but-empty
// experiment rows. Targets researchers (default: BYL, SMJ) whose
// import-byl-smj-bhl-2026 run created experiment rows with title +
// dates + weekdays + slot times only, leaving every other gap field
// (code_repo_url, data_path, checklist, protocol_version, location,
// description, fee, IRB, recruitment) empty.
//
// Each email:
//   - addresses the researcher by display_name
//   - lists every owned experiment with non-zero gap count
//   - per-experiment booking count (calendar-grounded confirmation that
//     the experiment really ran)
//   - one CTA link → /metadata-fill on production (the one-shot
//     researcher page that lets them fill all rows from a single screen)
//   - To: researcher's contact_email, CC: lab inbox (vnilab@gmail.com)
//
// Default = DRY-RUN: writes per-recipient HTML to /tmp/interview-<init>
// .html and prints a summary. Pass `--apply` to actually send.
// Pass `--only <INIT>` to scope (e.g. `--only BYL`).

import { readFile, writeFile } from "node:fs/promises";
import { createClient } from "@supabase/supabase-js";
import nodemailer from "nodemailer";

const env = await readFile(".env.local", "utf8");
for (const l of env.split("\n")) {
  const m = l.match(/^([A-Z_][A-Z0-9_]*)=(.*)$/);
  if (m && !process.env[m[1]]) process.env[m[1]] = m[2].replace(/^['"]|['"]$/g, "");
}

const APPLY = process.argv.includes("--apply");
const onlyIdx = process.argv.indexOf("--only");
const ONLY = onlyIdx !== -1 ? process.argv[onlyIdx + 1]?.toUpperCase() : null;

const TARGETS = ["BYL", "SMJ"]; // initials = local-part of internal email
const APP_URL = "https://lab-reservation-seven.vercel.app";

const sb = createClient(
  process.env.NEXT_PUBLIC_SUPABASE_URL,
  process.env.SUPABASE_SERVICE_ROLE_KEY,
  { auth: { persistSession: false } },
);

const GAP_FIELDS = [
  ["code_repo_url", "분석 코드 저장소/디렉토리", true /* required for activation */],
  ["data_path", "원본 데이터 경로", true],
  ["pre_experiment_checklist", "사전 체크리스트", false],
  ["protocol_version", "프로토콜 버전", false],
  ["location_id", "장소", false],
  ["description", "실험 소개", false],
  ["participation_fee", "참여비", false],
  ["irb_document_url", "IRB 문서 URL", false],
  ["recruitment_target", "모집 인원", false],
];

function isEmpty(field, v) {
  if (v == null || v === "") return true;
  if (Array.isArray(v) && v.length === 0) return true;
  if (typeof v === "string" && v.trim() === "") return true;
  if (field === "participation_fee" && v === 0) return true; // ambiguous but consistent w/ the fill page
  return false;
}

function escapeHtml(s) {
  return String(s ?? "")
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;");
}

// ── load targets ─────────────────────────────────────────────────────
const initials = TARGETS.filter((i) => !ONLY || ONLY === i);
const emails = initials.map((i) => `${i.toLowerCase()}@vnilab.local`);
const { data: profs } = await sb
  .from("profiles")
  .select("id, display_name, email, contact_email")
  .in("email", emails);

if (!profs || profs.length === 0) {
  console.error("FATAL: no matching researcher profiles");
  process.exit(1);
}

console.log(APPLY ? "MODE: APPLY (will send)" : "MODE: DRY-RUN");
console.log(`Targets: ${profs.map((p) => p.display_name).join(", ")}`);
console.log("");

// ── per-researcher email payload ─────────────────────────────────────
const payloads = [];
for (const p of profs) {
  const init = p.email.split("@")[0].toUpperCase();
  const { data: exps } = await sb
    .from("experiments")
    .select(
      "id, title, project_name, status, start_date, end_date, code_repo_url, data_path, pre_experiment_checklist, protocol_version, location_id, description, participation_fee, irb_document_url, recruitment_target",
    )
    .eq("created_by", p.id)
    .order("start_date", { ascending: false });

  // calendar-grounded confirmation: count completed bookings per experiment
  const ids = (exps ?? []).map((e) => e.id);
  const bkCount = {};
  if (ids.length > 0) {
    const { data: bks } = await sb
      .from("bookings")
      .select("experiment_id, status")
      .in("experiment_id", ids);
    for (const b of bks ?? []) {
      bkCount[b.experiment_id] = (bkCount[b.experiment_id] ?? 0) + 1;
    }
  }

  const rowsWithGaps = (exps ?? [])
    .map((e) => {
      const gaps = GAP_FIELDS.filter(([f]) => isEmpty(f, e[f])).map(([, label, req]) => ({
        label,
        required: req,
      }));
      return {
        ...e,
        gaps,
        bookings: bkCount[e.id] ?? 0,
      };
    })
    .filter((r) => r.gaps.length > 0);

  if (rowsWithGaps.length === 0) {
    console.log(`${init} (${p.display_name}): no gaps — skipping`);
    continue;
  }

  payloads.push({ profile: p, init, rows: rowsWithGaps });
}

function buildHtml({ profile, init, rows }) {
  const totalRequiredGaps = rows.reduce(
    (n, r) => n + r.gaps.filter((g) => g.required).length,
    0,
  );

  const rowsHtml = rows
    .map((r) => {
      const reqGaps = r.gaps.filter((g) => g.required);
      const recGaps = r.gaps.filter((g) => !g.required);
      return `
      <div style="margin:14px 0;padding:14px 16px;border:1px solid #e5e7eb;border-radius:10px;background:#f9fafb;">
        <p style="margin:0;font-size:14px;font-weight:600;color:#111827;">
          ${escapeHtml(r.title)}
          <span style="font-weight:400;color:#6b7280;font-size:12px;"> · ${escapeHtml(r.project_name ?? "-")} · ${escapeHtml(r.status)}</span>
        </p>
        <p style="margin:4px 0 0 0;font-size:12px;color:#6b7280;">
          모집기간 ${r.start_date} ~ ${r.end_date} · 캘린더 예약 ${r.bookings}건 기록됨
        </p>
        ${
          reqGaps.length > 0
            ? `<p style="margin:8px 0 0 0;font-size:13px;color:#9a3412;"><b>활성화 필요:</b> ${reqGaps.map((g) => escapeHtml(g.label)).join(", ")}</p>`
            : ""
        }
        ${
          recGaps.length > 0
            ? `<p style="margin:6px 0 0 0;font-size:13px;color:#374151;">권장: ${recGaps.map((g) => escapeHtml(g.label)).join(", ")}</p>`
            : ""
        }
      </div>`;
    })
    .join("");

  return `<!doctype html>
<html lang="ko">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width,initial-scale=1">
<meta name="color-scheme" content="light only">
<title>실험 메타데이터 입력 요청</title>
</head>
<body style="margin:0;padding:0;background:#ffffff;color:#111827;">
<div style="max-width:640px;margin:0 auto;padding:24px 18px;font-family:-apple-system,'Apple SD Gothic Neo','Malgun Gothic',sans-serif;line-height:1.65;font-size:14px;">

  <div style="padding:14px 18px;background:#eff6ff;border:1px solid #93c5fd;border-radius:10px;margin-bottom:18px;">
    <p style="margin:0;font-size:15px;font-weight:600;color:#1d4ed8;">📋 실험 메타데이터 입력 요청 — ${escapeHtml(profile.display_name)}님</p>
  </div>

  <p style="margin:0 0 10px 0;">안녕하세요, <b>${escapeHtml(profile.display_name)}</b>님.</p>
  <p style="margin:0 0 14px 0;">
    캘린더에 기록된 실험은 백필되었지만, Lab DB 의 <b>메타데이터(코드 경로 / 데이터 경로 / 프로토콜 / 장소 등)</b> 가 비어 있는 상태입니다.
    이 정보가 채워져야 향후 분석 재현, 정산 자동 처리, 참여자 모집/홍보까지 묶여 동작합니다.
  </p>
  <p style="margin:0 0 18px 0;">
    아래 ${rows.length}개 실험에 채워야 할 항목이 있습니다. <b>활성화 필요</b> 표시 항목 ${totalRequiredGaps}건은
    실험을 다시 <code>active</code> 로 돌리거나 새 정산 흐름을 태우려면 필수입니다.
  </p>

  <p style="margin:0 0 16px 0;text-align:center;">
    <a href="${APP_URL}/metadata-fill"
       style="display:inline-block;padding:12px 22px;background:#2563eb;color:#ffffff;border-radius:6px;text-decoration:none;font-size:15px;font-weight:600;">
      한 페이지에서 한번에 입력 →
    </a>
  </p>
  <p style="margin:0 0 18px 0;text-align:center;font-size:12px;color:#6b7280;">
    위 버튼이 안 보이면 다음 주소를 직접 열어주세요:<br>
    <span style="font-family:monospace;">${APP_URL}/metadata-fill</span>
  </p>

  <h3 style="margin:24px 0 8px 0;font-size:14px;color:#111827;">실험별 현황</h3>
  ${rowsHtml}

  <p style="margin:20px 0 6px 0;font-size:13px;color:#374151;">
    한 번에 다 채우지 않으셔도 됩니다 — 각 카드의 <b>"이 실험 저장"</b> 버튼은 그 실험만 갱신합니다.
    저장 후엔 실험 상세 화면(<code>${APP_URL}/experiments/&lt;id&gt;</code>)에서 사전 체크리스트의 필수 답변 토글 등 세부 옵션을 조정할 수 있습니다.
  </p>

  <p style="margin:18px 0 4px 0;font-size:12px;color:#9ca3af;">
    문의: <a href="mailto:vnilab@gmail.com" style="color:#2563eb;">vnilab@gmail.com</a>
  </p>
</div>
</body>
</html>`;
}

// ── render previews / send ───────────────────────────────────────────
const transporter = APPLY
  ? nodemailer.createTransport({
      host: "smtp.gmail.com",
      port: 587,
      secure: false,
      auth: { user: process.env.GMAIL_USER, pass: process.env.GMAIL_APP_PASSWORD },
    })
  : null;

for (const payload of payloads) {
  const html = buildHtml(payload);
  const previewPath = `/tmp/interview-${payload.init}.html`;
  await writeFile(previewPath, html);

  const requiredGapsTotal = payload.rows.reduce(
    (n, r) => n + r.gaps.filter((g) => g.required).length,
    0,
  );

  console.log(
    `${payload.init} (${payload.profile.display_name}) → ` +
      `${payload.profile.contact_email}: ` +
      `${payload.rows.length} experiments, ${requiredGapsTotal} required gaps, preview at ${previewPath}`,
  );

  if (!APPLY) continue;

  const to = payload.profile.contact_email?.trim();
  if (!to || !/@/.test(to)) {
    console.error(`  ! skipping ${payload.init}: no contact_email`);
    continue;
  }

  const subject = `[CSNL] 실험 메타데이터 입력 요청 — ${payload.profile.display_name}님 (${payload.rows.length}건)`;
  const info = await transporter.sendMail({
    from: `"CSNL" <${process.env.GMAIL_USER}>`,
    to,
    cc: process.env.GMAIL_USER,
    subject,
    html,
    text:
      `안녕하세요, ${payload.profile.display_name}님.\n\n` +
      `백필된 ${payload.rows.length}개 실험에 메타데이터를 채워주세요.\n\n` +
      `한번에 입력: ${APP_URL}/metadata-fill\n\n` +
      `실험 목록:\n` +
      payload.rows
        .map(
          (r) =>
            `- ${r.title} (${r.start_date}~${r.end_date}) — ` +
            `필요: ${r.gaps
              .filter((g) => g.required)
              .map((g) => g.label)
              .join(", ") || "-"} / 권장: ${r.gaps
              .filter((g) => !g.required)
              .map((g) => g.label)
              .join(", ") || "-"}`,
        )
        .join("\n"),
  });
  console.log(`  ✓ sent — message-id ${info.messageId}`);
}

if (!APPLY) {
  console.log("\nDRY-RUN. Re-run with --apply to send. Previews under /tmp/.");
}
