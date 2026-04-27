// Parse JSON findings out of a qwen response and write per-slice + aggregate reports.

import { mkdir, writeFile } from "node:fs/promises";
import { join } from "node:path";

// Lenient JSON recovery: qwen sometimes emits trailing commas inside
// objects/arrays, and occasionally puts raw newlines inside string values
// (unescaped). Neither is valid JSON. This tries strict parse first,
// then progressively patches and retries.
function tryParseLenient(raw) {
  try {
    return JSON.parse(raw);
  } catch {
    // fall through
  }
  // 1) Strip trailing commas before } or ].
  let patched = raw.replace(/,(\s*[}\]])/g, "$1");
  try {
    return JSON.parse(patched);
  } catch {
    // fall through
  }
  // 2) Escape bare newlines inside string literals. We walk the text
  // tracking quote state; whenever we see a literal \n (0x0a) while
  // inside a "..." string, replace with \\n.
  const chars = [...patched];
  let inStr = false;
  let prev = "";
  for (let i = 0; i < chars.length; i += 1) {
    const c = chars[i];
    if (inStr) {
      if (c === "\n" || c === "\r") {
        chars[i] = c === "\n" ? "\\n" : "\\r";
      } else if (c === '"' && prev !== "\\") {
        inStr = false;
      }
    } else if (c === '"') {
      inStr = true;
    }
    prev = c;
  }
  patched = chars.join("");
  try {
    return JSON.parse(patched);
  } catch {
    return null;
  }
}

// Dedup within one slice — qwen sometimes repeats the same finding 2-3x
// in a row (observed with repeat_penalty=1.05 in presets/qwen36-review).
// Key on (severity|file|line|category|title) so near-duplicates still
// collapse. Preserves the first occurrence (which usually has the best
// scenario/evidence).
function dedupFindings(findings) {
  const seen = new Set();
  const out = [];
  for (const f of findings) {
    const key = [
      (f.severity ?? "").toUpperCase(),
      f.file ?? "",
      f.line ?? "",
      f.category ?? "",
      (f.title ?? "").trim().slice(0, 80),
    ].join("|");
    if (seen.has(key)) continue;
    seen.add(key);
    out.push(f);
  }
  return out;
}

// Brace-aware JSON object scan that respects quote state and `\`-escaped
// quotes. Returns each top-level `{...}` substring that mentions "severity".
// Used by both the fenced and brace-fallback paths since model output often
// contains literal ``` inside `evidence` strings (which breaks naive fence
// regex termination).
function* scanJsonObjects(text) {
  let i = 0;
  while (i < text.length) {
    const open = text.indexOf("{", i);
    if (open < 0) break;
    let depth = 0;
    let close = -1;
    let inStr = false;
    let prev = "";
    for (let j = open; j < text.length; j += 1) {
      const c = text[j];
      if (inStr) {
        if (c === '"' && prev !== "\\") inStr = false;
      } else if (c === '"') {
        inStr = true;
      } else if (c === "{") {
        depth += 1;
      } else if (c === "}") {
        depth -= 1;
        if (depth === 0) {
          close = j;
          break;
        }
      }
      prev = c;
    }
    if (close < 0) break;
    const candidate = text.slice(open, close + 1);
    if (/"severity"\s*:/.test(candidate)) {
      yield candidate;
    }
    i = close + 1;
  }
}

export function extractFindings(text) {
  const findings = [];
  // Pass 1 — fence-anchored matches. The close fence MUST be on its own
  // line (^```), because `evidence` strings frequently contain literal
  // ``` inline-code wrappers that would terminate a non-anchored regex.
  const fenceRe = /^```json\s*\n([\s\S]*?)\n```\s*$/gm;
  let m;
  while ((m = fenceRe.exec(text)) !== null) {
    const obj = tryParseLenient(m[1].trim());
    if (obj && obj.severity) findings.push(obj);
  }
  // Pass 2 — brace walker over the whole text. Catches blocks where the
  // closing fence wasn't anchored cleanly (model emitted trailing spaces,
  // unbalanced fences, etc). Dedup at the end collapses overlap with
  // pass 1.
  for (const candidate of scanJsonObjects(text)) {
    const obj = tryParseLenient(candidate);
    if (obj && obj.severity) findings.push(obj);
  }
  return dedupFindings(findings);
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
