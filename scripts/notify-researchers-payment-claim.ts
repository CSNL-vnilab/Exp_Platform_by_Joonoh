// scripts/notify-researchers-payment-claim.ts
//
// One-shot announcement to all researchers about:
//   1) 2026 3차년도 form update auto-applied to the participant-fee
//      claim system (no user action required — backend swap).
//   2) Step-by-step usage guide for the 참여자비 청구 flow including
//      the new 행정 메일 발송 button.
//
// Send model: one email with To=vnilab@gmail.com (lab inbox) + BCC to
// every active researcher profile. BCC keeps researcher addresses
// private from each other. Reuses src/lib/google/gmail.ts so this run
// uses the same SMTP path as the in-app feature.
//
// Usage:  npx tsx scripts/notify-researchers-payment-claim.ts
// Add  --dry-run  to print the recipient list + body without sending.

import { createClient } from "@supabase/supabase-js";
import { readFile } from "node:fs/promises";
import { existsSync } from "node:fs";
import path from "node:path";

async function loadEnvLocal() {
  const p = path.join(process.cwd(), ".env.local");
  if (!existsSync(p)) return;
  const txt = await readFile(p, "utf8");
  for (const line of txt.split("\n")) {
    const m = line.match(/^([A-Z_][A-Z0-9_]*)\s*=\s*(.*)$/);
    if (!m) continue;
    let v = m[2].trim();
    if (
      (v.startsWith('"') && v.endsWith('"')) ||
      (v.startsWith("'") && v.endsWith("'"))
    )
      v = v.slice(1, -1);
    if (!process.env[m[1]]) process.env[m[1]] = v;
  }
}

const SUBJECT =
  "[CSNL] 실험참여자비 청구 시스템 안내 — 2026 3차년도 양식 적용 + 행정 메일 자동 발송 기능";

const APP_URL = "https://lab-reservation-seven.vercel.app";

// Group salutation — set per-call to either "OOO 연구원님" (individual
// send) or "CSNL 연구원 여러분" (broadcast w/ BCC).
function textBody(researcherName: string): string {
  return [
    `안녕하세요, ${researcherName}.`,
    "",
    "박준오입니다. 산학협력단에서 발행한 2026년 3차년도 (2026.05.01–2027.04.30, 과제번호 339-20260009) 전문가활용비 사용내역서 양식이 lab-reservation 의 실험참여자비 청구 시스템에 반영되었음을 안내드립니다. 또한 청구 서류를 행정 선생님께 한 번의 클릭으로 발송하는 기능이 새로 추가되었습니다.",
    "",
    "▶ 무엇이 바뀌었나",
    "  • 양식 메타데이터(과제번호·연구기간·연구책임자)가 2026 3차년도로 자동 갱신",
    "  • 행정 선생님 (jhlim23@snu.ac.kr) 자동 발송 버튼 추가 — 미리보기 + 컨펌 후 발송",
    "  • 청구 시 자동 첨부: 일회성경비지급자_업로드양식, 참여자별 실험참여자비 양식 (서명 임베드 포함), 통장사본.zip",
    "  • 발송 실패 시 정확한 원인이 모달 상단 + 다음 시도 시 표시",
    "",
    "▶ 참여자비 청구 사용 방법 (5분)",
    "",
    `  Step 1. ${APP_URL} 로그인`,
    "  Step 2. 본인 실험 → \"예약 / 정산\" 탭 (URL: /experiments/<실험ID>/bookings)",
    "  Step 3. \"참여자비 정산\" 카드 내용 확인",
    "    - 참여자가 정산 정보 (이름·연락처·계좌·주민번호·서명·통장사본) 제출 → 상태 \"제출됨\"",
    "    - 미입력 시 우측 \"정산 안내 재발송\" 버튼으로 참여자에게 재요청",
    "  Step 4. \"📦 참여자비 청구 (N명)\" 클릭",
    "    - 확인 다이얼로그 후 ZIP 다운로드 시작",
    "    - ZIP 내용: 일회성경비_업로드양식.xlsx · 실험참여자비 양식_*.xlsx (서명 포함) · 통장사본.zip · README.txt",
    "    - 청구 직후 emerald 색 \"📧 행정 메일 발송\" 버튼이 청구 버튼 옆에 활성화",
    "  Step 5. \"📧 행정 메일 발송\" 클릭",
    "    - 모달이 열리며 미리보기 표시:",
    "        받는 사람: jhlim23@snu.ac.kr  (수정 가능)",
    "        CC: 본인 contact_email  (자동, 사본 보관용)",
    "        Reply-To: 본인 contact_email  (행정 회신이 본인에게 직접 도달)",
    "        제목 + 본문 + 첨부 파일 5개 (업로드양식 1 · 참여자별 양식 N · 통장사본 zip 1)",
    "    - 받는 사람·내용 확인 후 \"📧 발송\" 클릭",
    "    - 8–10초 후 성공 토스트 + 본인 메일함에도 CC 도착",
    "    - 자동 발송 절대 X — 컨펌 누르기 전까지 메일은 보내지지 않음",
    "",
    "▶ 자주 묻는 상황",
    "  • 참여자가 서명/통장사본 미입력 → 메일은 발송되지만 해당 첨부 누락. 참여자에게 재요청 후 \"재발송\" (재발송 시 confirm 다이얼로그 표시)",
    "  • 발송 실패 → 모달 상단의 빨간색 \"지난 시도 실패\" 배너에 정확한 메시지 + 시각 + 시도 횟수 표시. 캡쳐해서 박준오 또는 vnilab@gmail.com 공유",
    "  • 이미 발송한 청구 → 버튼이 안 보임. 행정 답변 받은 후 다음 청구부터 동일 흐름으로 진행",
    "  • 청구 가능한 참여자가 없음 → 정산 정보 입력 대기 중. 참여자에게 안내 메일 재발송",
    "",
    "▶ 행정 선생님께 도착하는 메일 (예시)",
    "  제목: 실험참여자비 지급을 요청드립니다",
    "  본문:",
    "    안녕하세요 선생님,",
    "    ",
    "    <연구원 이름> 연구원입니다.",
    "    ",
    "    YYYY년 M월 D일 ~ YYYY년 M월 D일 진행한 실험에 대하여 N건의 실험참여자비를 지급요청드립니다.",
    "    ",
    "    - 실험자: <연구원 이름>",
    "    - 총 청구액: NNN,NNN원",
    "    - 참여자: AAA, BBB, CCC",
    "    ",
    "    첨부 파일 안내:",
    "      ① 일회성경비지급자_업로드양식_작성_*.xlsx — 행정 일괄 업로드용",
    "      ② 실험참여자비 양식_*.xlsx — 참여자별 청구서 (서명 포함)",
    "      ③ 통장사본_*.zip — 참여자별 통장 사본 모음",
    "    ",
    "    감사합니다.",
    "    <연구원 이름> 올림",
    "",
    "▶ 문의",
    "  박준오 (joonop99@snu.ac.kr)",
    "  버그/개선 제안은 lab-reservation GitHub Issue 로 등록 가능",
    "",
    "감사합니다.",
    "CSNL Lab Reservation System",
  ].join("\n");
}

function htmlBody(researcherName: string): string {
  const esc = (s: string) =>
    s
      .replace(/&/g, "&amp;")
      .replace(/</g, "&lt;")
      .replace(/>/g, "&gt;")
      .replace(/"/g, "&quot;");

  return [
    `<!doctype html><html><body style="font-family:-apple-system,BlinkMacSystemFont,'Apple SD Gothic Neo','Malgun Gothic',sans-serif;color:#111;line-height:1.7;font-size:14px;max-width:680px;">`,
    `<p>안녕하세요, ${esc(researcherName)}.</p>`,
    `<p>박준오입니다. 산학협력단에서 발행한 <strong>2026년 3차년도</strong> (2026.05.01–2027.04.30, 과제번호 <code>339-20260009</code>) 전문가활용비 사용내역서 양식이 lab-reservation 의 실험참여자비 청구 시스템에 반영되었음을 안내드립니다. 또한 청구 서류를 <strong>행정 선생님께 한 번의 클릭으로 발송</strong>하는 기능이 새로 추가되었습니다.</p>`,

    `<h3 style="margin-top:24px;font-size:15px;color:#1a4480;">▶ 무엇이 바뀌었나</h3>`,
    `<ul style="margin:6px 0 16px 22px;padding:0;">`,
    `<li>양식 메타데이터(과제번호·연구기간·연구책임자)가 2026 3차년도로 자동 갱신</li>`,
    `<li>행정 선생님 (<code>jhlim23@snu.ac.kr</code>) 자동 발송 버튼 추가 — <strong>미리보기 + 컨펌 후 발송</strong></li>`,
    `<li>청구 시 자동 첨부: 일회성경비지급자_업로드양식, 참여자별 실험참여자비 양식 (서명 임베드), 통장사본.zip</li>`,
    `<li>발송 실패 시 정확한 원인이 모달 상단 + 다음 시도 시 표시</li>`,
    `</ul>`,

    `<h3 style="margin-top:24px;font-size:15px;color:#1a4480;">▶ 참여자비 청구 사용 방법 (5분)</h3>`,
    `<ol style="margin:6px 0 16px 22px;padding:0;">`,
    `<li><a href="${APP_URL}">${APP_URL}</a> 로그인</li>`,
    `<li>본인 실험 → "예약 / 정산" 탭 (URL: <code>/experiments/&lt;실험ID&gt;/bookings</code>)</li>`,
    `<li>"참여자비 정산" 카드 내용 확인
      <ul style="margin:4px 0 4px 18px;padding:0;">
        <li>참여자가 정산 정보 (이름·연락처·계좌·주민번호·서명·통장사본) 제출 → 상태 "<strong>제출됨</strong>"</li>
        <li>미입력 시 우측 <em>"정산 안내 재발송"</em> 버튼으로 참여자에게 재요청</li>
      </ul></li>`,
    `<li><strong>"📦 참여자비 청구 (N명)"</strong> 클릭
      <ul style="margin:4px 0 4px 18px;padding:0;">
        <li>확인 다이얼로그 후 ZIP 다운로드</li>
        <li>ZIP 내용: 일회성경비_업로드양식.xlsx · 실험참여자비 양식_*.xlsx (서명 포함) · 통장사본.zip · README.txt</li>
        <li>청구 직후 emerald 색 <strong>"📧 행정 메일 발송"</strong> 버튼이 청구 버튼 옆에 활성화</li>
      </ul></li>`,
    `<li><strong>"📧 행정 메일 발송"</strong> 클릭
      <ul style="margin:4px 0 4px 18px;padding:0;">
        <li>모달이 열리며 미리보기 표시:
          <ul style="margin:2px 0 2px 18px;padding:0;">
            <li>받는 사람: <code>jhlim23@snu.ac.kr</code> (수정 가능)</li>
            <li>CC: 본인 contact_email (자동, 사본 보관용)</li>
            <li>Reply-To: 본인 contact_email (행정 회신이 본인에게 직접 도달)</li>
            <li>제목 + 본문 + 첨부 파일 5개</li>
          </ul>
        </li>
        <li>받는 사람·내용 확인 후 <strong>"📧 발송"</strong> 클릭</li>
        <li>8–10초 후 성공 토스트 + 본인 메일함에도 CC 도착</li>
        <li><strong>자동 발송 절대 X</strong> — 컨펌 누르기 전까지 메일은 보내지지 않음</li>
      </ul></li>`,
    `</ol>`,

    `<h3 style="margin-top:24px;font-size:15px;color:#1a4480;">▶ 자주 묻는 상황</h3>`,
    `<ul style="margin:6px 0 16px 22px;padding:0;">`,
    `<li><strong>참여자가 서명/통장사본 미입력</strong> → 메일은 발송되지만 해당 첨부 누락. 참여자에게 재요청 후 재발송 (재발송 시 confirm 다이얼로그 표시)</li>`,
    `<li><strong>발송 실패</strong> → 모달 상단의 빨간색 "지난 시도 실패" 배너에 정확한 메시지 + 시각 + 시도 횟수 표시. 캡쳐해서 박준오 또는 <code>vnilab@gmail.com</code> 공유</li>`,
    `<li><strong>이미 발송한 청구</strong> → 버튼이 안 보임. 행정 답변 받은 후 다음 청구부터 동일 흐름</li>`,
    `<li><strong>청구 가능한 참여자가 없음</strong> → 정산 정보 입력 대기 중. 참여자에게 안내 메일 재발송</li>`,
    `</ul>`,

    `<h3 style="margin-top:24px;font-size:15px;color:#1a4480;">▶ 행정 선생님께 도착하는 메일 (예시)</h3>`,
    `<div style="border-left:3px solid #1a4480;padding:8px 12px;background:#f5f7fa;font-size:13px;color:#222;margin:8px 0;">`,
    `<p style="margin:0 0 8px 0;"><strong>제목</strong>: 실험참여자비 지급을 요청드립니다</p>`,
    `<p style="margin:0;">안녕하세요 선생님,</p>`,
    `<p style="margin:8px 0;">&lt;연구원 이름&gt; 연구원입니다.</p>`,
    `<p style="margin:8px 0;">YYYY년 M월 D일 ~ YYYY년 M월 D일 진행한 실험에 대하여 N건의 실험참여자비를 지급요청드립니다.</p>`,
    `<p style="margin:8px 0;">- 실험자: &lt;연구원 이름&gt;<br/>- 총 청구액: NNN,NNN원<br/>- 참여자: AAA, BBB, CCC</p>`,
    `<p style="margin:8px 0;">감사합니다.<br/>&lt;연구원 이름&gt; 올림</p>`,
    `</div>`,

    `<p style="margin-top:24px;color:#555;font-size:13px;">문의: 박준오 (<code>joonop99@snu.ac.kr</code>) · 버그/개선은 lab-reservation GitHub Issue</p>`,
    `<p style="color:#888;font-size:12px;">CSNL Lab Reservation System</p>`,
    `</body></html>`,
  ].join("");
}

async function main() {
  await loadEnvLocal();
  const dryRun = process.argv.includes("--dry-run");

  const url = process.env.NEXT_PUBLIC_SUPABASE_URL!;
  const key = process.env.SUPABASE_SERVICE_ROLE_KEY!;
  const sb = createClient(url, key, {
    auth: { persistSession: false, autoRefreshToken: false },
  });

  console.log("=== Step 1: Fetch researcher profiles ===");
  const { data: profiles, error } = await sb
    .from("profiles")
    .select("id, role, display_name, contact_email")
    .in("role", ["researcher", "admin"]);
  if (error) throw new Error(`profiles fetch: ${error.message}`);
  if (!profiles || profiles.length === 0)
    throw new Error("no researcher profiles found");

  // Filter out profiles missing contact_email + dedupe the lab account
  // (csnl shares vnilab@gmail.com = sender, so we drop it from the BCC).
  const SENDER_EMAIL = "vnilab@gmail.com";
  const recipients = (profiles as Array<{
    id: string;
    role: string;
    display_name: string | null;
    contact_email: string | null;
  }>)
    .filter(
      (p) =>
        p.contact_email &&
        p.contact_email.toLowerCase() !== SENDER_EMAIL.toLowerCase(),
    )
    .map((p) => ({
      name: p.display_name ?? "연구원",
      email: p.contact_email!,
      role: p.role,
    }));

  console.log(`  ${recipients.length} recipient(s):`);
  for (const r of recipients) {
    console.log(`    - ${r.name.padEnd(8, " ")} <${r.email}>  [${r.role}]`);
  }

  if (recipients.length === 0) {
    console.log("\nNo eligible recipients. Exiting.");
    return;
  }

  console.log("\n=== Step 2: Preview email body (text) ===");
  console.log(textBody("OOO").slice(0, 600) + "...\n");

  if (dryRun) {
    console.log("--dry-run requested → not sending.");
    return;
  }

  console.log("=== Step 3: Send via Gmail SMTP ===");
  // ── 1회성 그룹 발송 모드 ─────────────────────────────────────────
  // CC: 이상훈 교수님 (1회성 추가, 시스템 안내라 visibility OK)
  // BCC: 6 연구원 (서로의 주소 비공개)
  // To: vnilab@gmail.com (self-copy / audit)
  // Salutation: "CSNL 연구원 여러분" (단체 발송)
  const { sendEmail } = await import("../src/lib/google/gmail");
  const PROFESSOR_CC = "sanghun.lee.vni@gmail.com";
  const groupSalutation = "CSNL 연구원 여러분";
  const bccList = recipients.map((r) => r.email);
  console.log(`  Mode: GROUP broadcast`);
  console.log(`  To  : ${SENDER_EMAIL} (self-copy)`);
  console.log(`  Cc  : ${PROFESSOR_CC} (이상훈 교수님)`);
  console.log(`  Bcc : ${bccList.length} researcher(s)`);
  for (const r of recipients) console.log(`        - ${r.name} <${r.email}>`);

  const result = await sendEmail({
    to: SENDER_EMAIL,
    cc: PROFESSOR_CC,
    bcc: bccList,
    subject: SUBJECT,
    html: htmlBody(groupSalutation),
    text: textBody(groupSalutation),
    replyTo: "joonop99@snu.ac.kr",
  });

  if (result.success) {
    console.log(`\n✓ SENT — messageId=${result.messageId}`);
    console.log(
      `  delivered to ${bccList.length} researcher(s) via BCC + 1 CC (교수님) + 1 self-copy`,
    );
  } else {
    console.log(`\n✗ FAILED — ${result.error}`);
    process.exit(1);
  }
}

main().catch((err) => {
  console.error("FAILED:", err);
  process.exit(1);
});
