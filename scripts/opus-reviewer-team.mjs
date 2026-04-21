#!/usr/bin/env node
// Opus coding agent team harness.
//
// Runs three reviewer personas against the current E2E evidence + relevant
// source snippets. All three use Claude Opus 4.7 (1M context) via the
// Anthropic API; differentiation comes from system prompts, not model choice.
//
// Env: ANTHROPIC_API_KEY is required. Optional:
//   REVIEWER_MODEL  (default: claude-opus-4-7)
//   EVIDENCE_PATH   (default: /tmp/e2e-booking-evidence.json)
//
// Usage:
//   node --env-file=.env.local scripts/opus-reviewer-team.mjs

import { readFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";

const __dirname = dirname(fileURLToPath(import.meta.url));
const ROOT = join(__dirname, "..");
const API_URL = "https://api.anthropic.com/v1/messages";
const MODEL = process.env.REVIEWER_MODEL ?? "claude-opus-4-7";
const EVIDENCE_PATH = process.env.EVIDENCE_PATH ?? "/tmp/e2e-booking-evidence.json";

if (!process.env.ANTHROPIC_API_KEY) {
  console.error("ANTHROPIC_API_KEY is required.");
  process.exit(1);
}

const reviewers = [
  {
    role: "Senior Architect",
    system: [
      "You are a senior full-stack architect reviewing a Korean lab booking",
      "platform (Next.js 16 App Router + Supabase + Google Calendar).",
      "Focus on data flow, transaction boundaries, failure modes, and",
      "race conditions. Tag every finding [CRITICAL/HIGH/MED/LOW] and",
      "cite specific file:line. Respond in Korean. Max 5 findings.",
    ].join(" "),
  },
  {
    role: "QA Engineer",
    system: [
      "You are a QA engineer. Look for missing test coverage, boundary",
      "conditions, regression risk, and gaps in E2E evidence. For each",
      "gap cite which phase or assertion is missing. Tag [CRITICAL/HIGH/",
      "MED/LOW]. Respond in Korean. Max 5 findings.",
    ].join(" "),
  },
  {
    role: "Security Reviewer",
    system: [
      "You are a security + integrations reviewer. Scrutinize service",
      "account credentials, RLS bypass paths, external dependency failure",
      "impact (GCal, SMTP, SMS), data exfiltration, and input validation.",
      "Tag [CRITICAL/HIGH/MED/LOW]. Respond in Korean. Max 5 findings.",
    ].join(" "),
  },
];

async function readIfExists(p) {
  try {
    return await readFile(p, "utf8");
  } catch {
    return null;
  }
}

async function gatherContext() {
  const evidence = (await readIfExists(EVIDENCE_PATH)) ?? "(no evidence file)";
  const files = [
    "src/app/api/bookings/route.ts",
    "src/app/api/bookings/[bookingId]/route.ts",
    "src/lib/services/booking.service.ts",
    "src/lib/services/reminder.service.ts",
    "src/app/api/experiments/[experimentId]/slots/range/route.ts",
    "src/lib/google/calendar.ts",
    "src/components/booking/booking-flow.tsx",
    "src/components/booking/week-timetable.tsx",
  ];
  const snippets = [];
  for (const rel of files) {
    const body = await readIfExists(join(ROOT, rel));
    if (body) snippets.push(`--- ${rel} ---\n${body}`);
  }
  return { evidence, code: snippets.join("\n\n") };
}

async function callOpus(system, user) {
  const res = await fetch(API_URL, {
    method: "POST",
    headers: {
      "x-api-key": process.env.ANTHROPIC_API_KEY,
      "anthropic-version": "2023-06-01",
      "content-type": "application/json",
    },
    body: JSON.stringify({
      model: MODEL,
      max_tokens: 2_000,
      temperature: 0.2,
      system,
      messages: [{ role: "user", content: user }],
    }),
  });
  if (!res.ok) {
    const text = await res.text().catch(() => "");
    throw new Error(`${MODEL} ${res.status}: ${text.slice(0, 500)}`);
  }
  const data = await res.json();
  return data.content?.[0]?.text ?? "";
}

async function main() {
  console.log("=".repeat(70));
  console.log(`Opus Reviewer Team — ${MODEL}`);
  console.log("=".repeat(70));

  const { evidence, code } = await gatherContext();
  const userPrompt = [
    "# E2E Test Evidence (JSON)",
    evidence,
    "",
    "# Relevant source (may be truncated)",
    code.slice(0, 120_000),
    "",
    "---",
    "위 자료는 실제 E2E 테스트 결과와 관련 소스코드입니다.",
    "당신의 역할에 맞는 이슈를 5개 이내로 찾아 다음 형식으로 보고하세요:",
    "  1) [TAG] 제목",
    "     - 근거: 파일:라인 또는 phase",
    "     - 권장 조치: ...",
  ].join("\n");

  const results = await Promise.all(
    reviewers.map(async (r) => {
      const t0 = Date.now();
      process.stdout.write(`[${r.role}] 분석 중...\n`);
      try {
        const out = await callOpus(r.system, userPrompt);
        return {
          role: r.role,
          durationSec: Math.round((Date.now() - t0) / 1000),
          output: out,
        };
      } catch (e) {
        return { role: r.role, error: e.message };
      }
    }),
  );

  console.log("\n" + "=".repeat(70));
  console.log("  Reviewer Reports");
  console.log("=".repeat(70));
  for (const r of results) {
    console.log(`\n### ${r.role}${r.durationSec ? `  [${r.durationSec}s]` : ""}`);
    console.log("-".repeat(70));
    if (r.error) console.log("ERROR:", r.error);
    else console.log(r.output);
  }
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
