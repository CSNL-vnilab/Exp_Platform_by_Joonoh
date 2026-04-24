#!/usr/bin/env node
// Adversarial full-stack review harness, powered by local Ollama (qwen3.6:latest).
//
// Sequentially:
//   1. Pings Ollama and verifies the configured model is available.
//   2. For each slice (scripts/adv-review/slices.mjs), packs the slice's
//      files within a bounded char budget, sends [persona] + [briefing] +
//      [slice focus] + [packed code] to qwen, streams output, parses
//      JSON findings.
//   3. Feeds the aggregated findings (structured, no raw code) into a
//      synthesis pass that writes the final verdict.
//
// Context memory safety:
//   - num_ctx is bounded per preset (default 32K) — far below qwen3.6's
//     262K max — so VRAM pressure stays manageable on M-series.
//   - Input is packed to ~80K chars per slice (head+tail truncation per
//     file), leaving headroom for system prompts and output tokens.
//   - The synthesis pass only consumes structured findings JSON, never
//     raw code — so adding more slices doesn't blow the final context.
//
// Usage:
//   node scripts/adv-review/run.mjs                  # all slices + synth
//   node scripts/adv-review/run.mjs --slice 02       # one slice (id prefix match)
//   node scripts/adv-review/run.mjs --skip-synth     # slices only
//   node scripts/adv-review/run.mjs --only-synth     # synth from existing findings
//   node scripts/adv-review/run.mjs --list           # list slices and exit
//   node scripts/adv-review/run.mjs --out /tmp/adv   # output dir
//
// Env:
//   OLLAMA_HOST     default http://127.0.0.1:11434
//   ADV_PRESET      path to review preset json (default presets/qwen36-review.json)
//   ADV_SYNTH       path to synth preset json (default presets/qwen36-synth.json)
//   ADV_MODEL       override model name

import { readFile, mkdir } from "node:fs/promises";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { argv, stdout, stderr, exit } from "node:process";

import { slices as allSlices } from "./slices.mjs";
import { streamChat, ping, hasModel, warmup } from "./lib/ollama.mjs";
import { packSlice } from "./lib/slicer.mjs";
import { extractFindings, writeSliceReport, writeAggregate } from "./lib/report.mjs";

const HERE = dirname(fileURLToPath(import.meta.url));
const ROOT = join(HERE, "..", "..");

function parseArgs(args) {
  const opts = {
    slice: null,
    skipSynth: false,
    onlySynth: false,
    list: false,
    out: join(ROOT, ".adv-review"),
  };
  for (let i = 2; i < args.length; i++) {
    const a = args[i];
    if (a === "--slice") opts.slice = args[++i];
    else if (a === "--skip-synth") opts.skipSynth = true;
    else if (a === "--only-synth") opts.onlySynth = true;
    else if (a === "--list") opts.list = true;
    else if (a === "--out") opts.out = args[++i];
    else if (a === "--help" || a === "-h") opts.help = true;
  }
  return opts;
}

function printUsage() {
  stdout.write(`Usage: node scripts/adv-review/run.mjs [options]
  --slice <id-prefix>    Run a single slice (matches id prefix, e.g. "02")
  --skip-synth           Skip final synthesis pass
  --only-synth           Only run synthesis (expects existing *.findings.json)
  --list                 List slices and exit
  --out <dir>            Output directory (default .adv-review/)
  --help                 Show this help
`);
}

async function loadJson(path) {
  const body = await readFile(path, "utf8");
  return JSON.parse(body);
}

function buildUserPrompt({ briefing, slice, packed }) {
  const focusLines = slice.focus.map((f) => `- ${f}`).join("\n");
  return [
    "# 심사 대상 앱 브리핑",
    briefing,
    "",
    "---",
    `# 이번 슬라이스: ${slice.id} — ${slice.title}`,
    "",
    "## 이 슬라이스에서 특히 주의할 지점",
    focusLines,
    "",
    `## 포함된 파일 (${packed.included.length}개${packed.skipped.length ? `, 예산 초과로 제외: ${packed.skipped.length}개` : ""})`,
    packed.included.map((f) => `- ${f}`).join("\n"),
    packed.skipped.length ? `\n예산 초과 제외: ${packed.skipped.join(", ")}` : "",
    packed.missing.length ? `\n파일 없음 (건너뜀): ${packed.missing.join(", ")}` : "",
    "",
    "---",
    "# 코드",
    "",
    packed.content,
    "",
    "---",
    "위 자료를 바탕으로, 당신의 역할(적대적 풀스택 심사위원)에 맞게",
    "JSON 이슈 블록 + 마지막 `## 요약` 섹션 형식으로만 응답하라.",
    "이 슬라이스 외부에서만 확정 가능한 경로는 OPEN으로 남겨라.",
  ]
    .filter(Boolean)
    .join("\n");
}

async function runSlice({ slice, persona, briefing, preset, outDir }) {
  stdout.write(`\n${"=".repeat(74)}\n▶ [${slice.id}] ${slice.title}\n${"=".repeat(74)}\n`);
  const packed = await packSlice({
    root: ROOT,
    files: slice.files,
    budget: preset.budget,
  });
  stdout.write(
    `  포함: ${packed.included.length}개 / 제외: ${packed.skipped.length}개 / 누락: ${packed.missing.length}개 / ${packed.totalChars.toLocaleString()} chars\n\n`,
  );
  if (packed.included.length === 0) {
    stdout.write("  (슬라이스에 유효한 파일이 없어 건너뜀)\n");
    return { sliceId: slice.id, title: slice.title, findings: [], skipped: true };
  }

  const userPrompt = buildUserPrompt({ briefing, slice, packed });
  const t0 = Date.now();
  const { text, meta } = await streamChat({
    model: process.env.ADV_MODEL ?? preset.model,
    messages: [
      { role: "system", content: persona },
      { role: "user", content: userPrompt },
    ],
    options: preset.options,
    think: preset.think,
    timeouts: preset.timeouts,
    onToken: (t) => stdout.write(t),
  });
  stdout.write(`\n  [${slice.id}] 완료 (${Math.round((Date.now() - t0) / 1000)}s)\n`);
  const findings = extractFindings(text);
  stdout.write(`  JSON 이슈 추출: ${findings.length}건\n`);

  await writeSliceReport({
    outDir,
    slice,
    rawText: text,
    findings,
    meta,
    included: packed.included,
    skipped: packed.skipped,
    missing: packed.missing,
  });
  return { sliceId: slice.id, title: slice.title, findings };
}

async function runSynthesis({ results, synthPersona, preset, outDir }) {
  const payload = results
    .filter((r) => (r.findings?.length ?? 0) > 0)
    .map((r) => ({
      sliceId: r.sliceId,
      title: r.title,
      findings: r.findings,
    }));
  if (payload.length === 0) {
    stdout.write("\n  (이슈가 하나도 없어 최종 판결문 생략)\n");
    return null;
  }

  const userPrompt = [
    "# 슬라이스별 심사 결과 (구조화)",
    "",
    "아래는 각 슬라이스 심사위원이 제출한 JSON 이슈 배열이다.",
    "원본 코드는 주어지지 않는다. 이 메타데이터만으로 최종 판결문을 작성하라.",
    "",
    "```json",
    JSON.stringify(payload, null, 2),
    "```",
    "",
    "persona에 명시된 형식(한국어 Markdown)으로만 응답하라.",
  ].join("\n");

  let truncated = userPrompt;
  if (userPrompt.length > preset.budget.maxInputChars) {
    stderr.write(
      `\n  [synth] 입력이 ${userPrompt.length}B > 예산 ${preset.budget.maxInputChars}B — 하위 심각도 이슈를 잘라내 재압축합니다.\n`,
    );
    const trimmed = payload.map((p) => ({
      ...p,
      findings: p.findings.filter((f) => ["CRITICAL", "HIGH", "MED"].includes(f.severity)),
    }));
    truncated = userPrompt.replace(
      /```json[\s\S]*```/,
      "```json\n" + JSON.stringify(trimmed, null, 2) + "\n```",
    );
  }

  stdout.write(`\n${"=".repeat(74)}\n▶ 최종 판결문 생성 중...\n${"=".repeat(74)}\n`);
  const t0 = Date.now();
  const { text } = await streamChat({
    model: process.env.ADV_MODEL ?? preset.model,
    messages: [
      { role: "system", content: synthPersona },
      { role: "user", content: truncated },
    ],
    options: preset.options,
    think: preset.think,
    timeouts: preset.timeouts,
    onToken: (t) => stdout.write(t),
  });
  stdout.write(`\n  최종 판결문 완료 (${Math.round((Date.now() - t0) / 1000)}s)\n`);
  return text;
}

async function loadExistingFindings(outDir) {
  const results = [];
  for (const slice of allSlices) {
    try {
      const body = await readFile(join(outDir, `${slice.id}.findings.json`), "utf8");
      const parsed = JSON.parse(body);
      results.push({ sliceId: slice.id, title: slice.title, findings: parsed.findings ?? [] });
    } catch {
      // skip
    }
  }
  return results;
}

async function main() {
  const opts = parseArgs(argv);
  if (opts.help) {
    printUsage();
    return;
  }
  if (opts.list) {
    stdout.write("슬라이스 목록:\n");
    for (const s of allSlices) stdout.write(`  ${s.id.padEnd(32)}  ${s.title}\n`);
    return;
  }

  const presetPath = process.env.ADV_PRESET ?? join(HERE, "presets", "qwen36-review.json");
  const synthPath = process.env.ADV_SYNTH ?? join(HERE, "presets", "qwen36-synth.json");
  const [preset, synthPreset, persona, synthPersona, briefing] = await Promise.all([
    loadJson(presetPath),
    loadJson(synthPath),
    readFile(join(HERE, "personas", "adversarial.md"), "utf8"),
    readFile(join(HERE, "personas", "synthesizer.md"), "utf8"),
    readFile(join(HERE, "briefing.md"), "utf8"),
  ]);

  if (!(await ping())) {
    stderr.write("Ollama에 접속 불가. `ollama serve`가 떠 있는지 확인하세요.\n");
    exit(2);
  }
  const model = process.env.ADV_MODEL ?? preset.model;
  if (!(await hasModel(model))) {
    stderr.write(`모델 ${model} 이 설치되어 있지 않습니다. \`ollama pull ${model}\` 후 다시 실행하세요.\n`);
    exit(2);
  }

  await mkdir(opts.out, { recursive: true });
  stdout.write(`적대적 심사 시작  model=${model}  out=${opts.out}\n`);
  stdout.write(
    `preset: num_ctx=${preset.options.num_ctx}  num_predict=${preset.options.num_predict}  maxInput=${preset.budget.maxInputChars}B  think=${preset.think ?? "default"}\n`,
  );
  stdout.write(`모델 워밍업 중... `);
  const wt0 = Date.now();
  const warm = await warmup(model);
  stdout.write(warm ? `OK (${Math.round((Date.now() - wt0) / 1000)}s)\n` : `실패 — 계속 진행\n`);

  let results = [];
  if (opts.onlySynth) {
    results = await loadExistingFindings(opts.out);
    stdout.write(`기존 findings 로드: ${results.length}개 슬라이스\n`);
  } else {
    const picked = opts.slice
      ? allSlices.filter((s) => s.id.startsWith(opts.slice))
      : allSlices;
    if (picked.length === 0) {
      stderr.write(`슬라이스 '${opts.slice}' 매치 없음. --list 로 확인하세요.\n`);
      exit(1);
    }
    for (const slice of picked) {
      try {
        const r = await runSlice({
          slice,
          persona,
          briefing,
          preset,
          outDir: opts.out,
        });
        results.push(r);
      } catch (e) {
        stderr.write(`\n  [${slice.id}] 실패: ${e.message}\n`);
        results.push({ sliceId: slice.id, title: slice.title, findings: [], error: e.message });
      }
    }
  }

  let synthesisText = null;
  if (!opts.skipSynth && !opts.slice) {
    try {
      synthesisText = await runSynthesis({
        results,
        synthPersona,
        preset: synthPreset,
        outDir: opts.out,
      });
    } catch (e) {
      stderr.write(`\n  최종 판결문 실패: ${e.message}\n`);
    }
  }

  await writeAggregate({ outDir: opts.out, results, synthesisText });
  stdout.write(`\n완료.  결과: ${opts.out}/README.md\n`);
}

main().catch((e) => {
  stderr.write(`\n[fatal] ${e.message}\n${e.stack ?? ""}\n`);
  exit(1);
});
