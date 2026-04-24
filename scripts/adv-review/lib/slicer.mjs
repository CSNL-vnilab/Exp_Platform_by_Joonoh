// Packs a slice's files into a single text blob within byte budget.
// Truncates individual files head+tail style so large files keep context at
// both ends. If total exceeds maxInputChars, trims from tail files.

import { readFile, stat } from "node:fs/promises";
import { join } from "node:path";

export async function packSlice({ root, files, budget }) {
  const { maxInputChars, maxFilesPerSlice, perFileHeadChars, perFileTailChars } = budget;
  const picked = files.slice(0, maxFilesPerSlice ?? files.length);
  const parts = [];
  const skipped = [];
  const missing = [];
  let total = 0;

  for (const rel of picked) {
    const abs = join(root, rel);
    let body;
    try {
      await stat(abs);
      body = await readFile(abs, "utf8");
    } catch {
      missing.push(rel);
      continue;
    }

    const head = body.slice(0, perFileHeadChars);
    const tail =
      body.length > perFileHeadChars + perFileTailChars
        ? "\n... [중략] ...\n" + body.slice(-perFileTailChars)
        : body.length > perFileHeadChars
          ? body.slice(perFileHeadChars)
          : "";
    const chunk = `--- ${rel} (${body.length}B) ---\n${head}${tail}\n`;

    if (total + chunk.length > maxInputChars) {
      skipped.push(rel);
      continue;
    }
    parts.push(chunk);
    total += chunk.length;
  }

  return {
    content: parts.join("\n"),
    included: picked.filter((f) => !skipped.includes(f) && !missing.includes(f)),
    skipped,
    missing,
    totalChars: total,
  };
}
