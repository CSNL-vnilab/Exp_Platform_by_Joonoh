// Parse JSON findings out of a qwen response and write per-slice + aggregate reports.

import { mkdir, writeFile } from "node:fs/promises";
import { join } from "node:path";

export function extractFindings(text) {
  const findings = [];
  // Match ```json ... ``` blocks as well as bare { ... } that look like findings.
  const fenceRe = /```json\s*([\s\S]*?)```/g;
  let m;
  while ((m = fenceRe.exec(text)) !== null) {
    try {
      const obj = JSON.parse(m[1].trim());
      if (obj && obj.severity) findings.push(obj);
    } catch {
      // ignore
    }
  }
  if (findings.length === 0) {
    // Fallback: try to find top-level JSON objects with "severity".
    const braceRe = /\{[\s\S]*?"severity"[\s\S]*?\n\}/g;
    while ((m = braceRe.exec(text)) !== null) {
      try {
        const obj = JSON.parse(m[0]);
        if (obj && obj.severity) findings.push(obj);
      } catch {
        // ignore
      }
    }
  }
  return findings;
}

export async function writeSliceReport({ outDir, slice, rawText, findings, meta, included, skipped, missing }) {
  await mkdir(outDir, { recursive: true });
  const basename = slice.id;
  await writeFile(
    join(outDir, `${basename}.md`),
    `# ${slice.id} — ${slice.title}\n\n` +
      `- files included: ${included.length}\n` +
      (skipped.length ? `- files skipped (budget): ${skipped.join(", ")}\n` : "") +
      (missing.length ? `- files missing: ${missing.join(", ")}\n` : "") +
      (meta ? `- eval_count: ${meta.eval_count ?? "?"}, prompt_tokens: ${meta.prompt_eval_count ?? "?"}\n` : "") +
      `\n---\n\n${rawText}\n`,
    "utf8",
  );
  await writeFile(
    join(outDir, `${basename}.findings.json`),
    JSON.stringify({ sliceId: slice.id, title: slice.title, findings }, null, 2),
    "utf8",
  );
}

export async function writeAggregate({ outDir, results, synthesisText }) {
  const all = results.flatMap((r) =>
    (r.findings ?? []).map((f) => ({ sliceId: r.sliceId, ...f })),
  );
  const bySeverity = all.reduce((acc, f) => {
    acc[f.severity] = (acc[f.severity] ?? 0) + 1;
    return acc;
  }, {});
  await writeFile(
    join(outDir, "all-findings.json"),
    JSON.stringify({ count: all.length, bySeverity, findings: all }, null, 2),
    "utf8",
  );
  if (synthesisText) {
    await writeFile(join(outDir, "00-final-verdict.md"), synthesisText, "utf8");
  }
  const indexLines = [
    "# 적대적 심사 — 슬라이스 인덱스",
    "",
    `생성 시각: ${new Date().toISOString()}`,
    `총 이슈: ${all.length}  (${Object.entries(bySeverity)
      .map(([k, v]) => `${k}:${v}`)
      .join(", ")})`,
    "",
    ...results.map((r) => `- [${r.sliceId}](./${r.sliceId}.md) — ${r.title} — ${r.findings?.length ?? 0}건`),
    "",
    synthesisText ? "- [최종 판결문](./00-final-verdict.md)" : "",
  ];
  await writeFile(join(outDir, "README.md"), indexLines.join("\n"), "utf8");
}
