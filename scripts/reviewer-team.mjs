#!/usr/bin/env node
// Multi-model reviewer team. Reads E2E evidence + relevant source snippets,
// hands each to a different local Ollama model with a focused system prompt,
// prints findings.

import { readFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";

const __dirname = dirname(fileURLToPath(import.meta.url));
const ROOT = join(__dirname, "..");
const OLLAMA = process.env.OLLAMA_HOST ?? "http://127.0.0.1:11434";

const reviewers = [
  {
    model: "gemma4:31b",
    role: "Senior Architect",
    system:
      "너는 시니어 풀스택 아키텍트다. 실험 예약 시스템의 E2E 싸이클(예약 제출 → DB 기록 → Google Calendar 이벤트 생성)을 검토한다. 한국어로, 아키텍처·데이터 흐름·실패 모드·트랜잭션 경계 관점에서 답한다. 반드시 [CRITICAL/HIGH/MED/LOW] 태그를 사용하고, 구체적인 파일/코드 경로를 인용한다.",
  },
  {
    model: "gemma4:26b",
    role: "QA / Test Engineer",
    system:
      "너는 QA 엔지니어다. 테스트 커버리지, 경계 조건, 회귀 위험, 누락된 assertion을 본다. 한국어로, 각 항목에 [CRITICAL/HIGH/MED/LOW] 태그. 특히 E2E 에비던스의 각 phase가 충분한지, 어떤 케이스가 빠졌는지 본다.",
  },
  {
    model: "qwen3.6:latest",
    role: "Security / Integration",
    system:
      "너는 보안·통합 리뷰어다. 서비스 계정 자격증명, RLS 우회 경로, 외부 시스템(GCal/SMTP/Notion/SMS) 실패의 영향, 데이터 누출, 입력 검증을 본다. 한국어로, [CRITICAL/HIGH/MED/LOW] 태그.",
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
  const evidence =
    (await readIfExists("/tmp/e2e-booking-evidence.json")) ?? "(no evidence found)";
  const files = [
    "src/app/api/bookings/route.ts",
    "src/lib/services/booking.service.ts",
    "src/app/api/experiments/[experimentId]/slots/range/route.ts",
    "src/lib/google/calendar.ts",
    "src/components/booking/booking-flow.tsx",
    "src/components/booking/week-timetable.tsx",
  ];
  const snippets = [];
  for (const rel of files) {
    const full = join(ROOT, rel);
    const body = await readIfExists(full);
    if (body) snippets.push(`--- ${rel} ---\n${body}`);
  }
  return { evidence, code: snippets.join("\n\n") };
}

async function callOllama(model, system, user) {
  const res = await fetch(`${OLLAMA}/api/chat`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      model,
      messages: [
        { role: "system", content: system },
        { role: "user", content: user },
      ],
      stream: false,
      options: { temperature: 0.2, num_ctx: 24_000, num_predict: 4_000 },
    }),
  });
  if (!res.ok) throw new Error(`${model} ${res.status}: ${await res.text().catch(() => "")}`);
  const data = await res.json();
  return data.message?.content ?? "";
}

async function main() {
  console.log("=".repeat(70));
  console.log("Reviewer Team — Booking E2E Cycle");
  console.log("=".repeat(70));
  const { evidence, code } = await gatherContext();

  const user = `# E2E Test Evidence (JSON)
${evidence}

# Relevant source (truncated)
${code.slice(0, 80_000)}

---
위 자료는 실제 E2E 테스트 결과와 관련 소스코드다. 당신의 역할에 따라 핵심 이슈를 찾아 간결하게 리포트하라. 5개 이내의 이슈로 정리하고, 각 이슈는 1) 요약 2) 근거(파일:라인 또는 phase) 3) 권장 조치로 쓴다.`;

  const results = [];
  for (const r of reviewers) {
    const t0 = Date.now();
    process.stdout.write(`\n[${r.role} · ${r.model}] 분석 중...\n`);
    try {
      const out = await callOllama(r.model, r.system, user);
      const dt = Math.round((Date.now() - t0) / 1000);
      results.push({ role: r.role, model: r.model, durationSec: dt, output: out });
      console.log(`  ✓ ${dt}s`);
    } catch (e) {
      results.push({ role: r.role, model: r.model, error: e.message });
      console.log(`  ✗ ${e.message}`);
    }
  }

  console.log("\n" + "=".repeat(70));
  console.log("  Reviewer Reports");
  console.log("=".repeat(70));
  for (const r of results) {
    console.log(`\n### ${r.role} (${r.model})${r.durationSec ? `  [${r.durationSec}s]` : ""}`);
    console.log("-".repeat(70));
    if (r.error) console.log("ERROR:", r.error);
    else console.log(r.output);
  }
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
