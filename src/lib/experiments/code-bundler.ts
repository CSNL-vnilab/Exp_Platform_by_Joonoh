// Multi-file → single bundle for code analysis. Given a flat list of
// uploaded files (zip-extracted, drag-drop, or a checked-out tree), pick
// an entry file, follow 1-2 hops of references, drop noise, and produce
// a single budget-fitted text the analyzer can consume.
//
// The bundler is intentionally deterministic (no LLM) — its job is only
// to *select* what the LLM sees. Selection rules:
//
//   1. Entry detection
//      - explicit hint > main_*.* > run_*.* > index.* > app.*
//      - prefer files in the root, not deep paths
//
//   2. Reference graph
//      - MATLAB: top-level `addpath(genpath('foo'))` brings everything
//        under `foo/` into scope; we resolve identifiers seen in the
//        entry to filenames in the supplied tree (one .m per function).
//      - Python: `from x.y import z`, `import x` → look up x/y.py
//      - JS/TS: `import … from "./foo"` / `require("./foo")` → ./foo.{js,ts,jsx,tsx}
//
//   3. Priority weighting
//      - parameter / config / setup / init files get max priority
//      - stim / display / texture / UI files demoted
//      - legacy / archive / *_backup / .asv / *_old files dropped
//
//   4. Budget fit
//      - default 80,000 chars total (matches analyzer ctx budget)
//      - trim each file at line boundary, keep header comments
//      - emit `=== file: path (Nlines, M chars; Lcalls→[…]) ===` markers

export interface InputFile {
  path: string;       // posix-style relative path, e.g. "sub/Seed_Duration.m"
  content: string;
}

export interface BundleOptions {
  entryHint?: string | null;   // path the user explicitly nominated
  budgetChars?: number;        // default 80_000
  maxFiles?: number;           // hard cap to keep prompt readable; default 30
  // Optional caller-provided language. If absent, inferred from extensions.
  language?: "matlab" | "python" | "javascript" | "typescript" | "r" | "other" | "auto";
}

export interface BundleResult {
  entry: string | null;
  language: "matlab" | "python" | "javascript" | "typescript" | "r" | "other";
  bundled: string;
  selected: Array<{
    path: string;
    bytes: number;
    truncated: boolean;
    role: "entry" | "called" | "supporting" | "config";
    score: number;
  }>;
  dropped: Array<{ path: string; reason: string }>;
  totalChars: number;
}

const DEFAULT_BUDGET = 80_000;
const DEFAULT_MAX_FILES = 30;

const NOISE_PATTERNS = [
  /(^|\/)archive(\/|$)/i,
  /(^|\/)old(\/|$)/i,
  /(^|\/)Old_/,                  // "Old_2026-02-20_..." date-stamped legacy folders
  /_old\b/i,
  /_old\//i,
  /_backup_\d/i,
  /(^|\/)backup_/i,
  /(^|\/)legacy(\/|$)/i,
  /(^|\/)deprecated(\/|$)/i,
  /\.asv$/i,
  /\.DS_Store$/i,
  /(^|\/)tex_/i,                 // texture caches in many psychtoolbox repos
  /(^|\/)\.git\//,
  /(^|\/)node_modules(\/|$)/,
  /(^|\/)results(\/|$)/i,
  /(^|\/)data(\/|$)/i,
  /\.(mat|png|jpg|jpeg|tiff?|gif|wav|mp3|mp4|pdf|csv|tsv|xlsx?|zip|gz)$/i,
];

const PRIORITY_PATTERNS: Array<{ rx: RegExp; bonus: number; role: BundleResult["selected"][number]["role"] }> = [
  { rx: /(^|\/)(setup|exp_info|param[s]?_|param[A-Z]|init_|config|settings)/i, bonus: 100, role: "config" },
  { rx: /(^|\/)(make_|build_|generate_|prep_|seed_|trial_schedule)/i, bonus: 60, role: "supporting" },
  { rx: /summary|results?_|save_|backup_/i, bonus: 50, role: "supporting" },
  { rx: /run_loop|trial_run|run_block|main_loop|orchestrate/i, bonus: 40, role: "supporting" },
];

const DEMOTE_PATTERNS = [
  { rx: /(^|\/)(disp|draw|tex_template|stimuli|ui|render|gui|dialog)/i, penalty: 40 },
  { rx: /(^|\/)(legacy|deprecated)/i, penalty: 80 },
  { rx: /(^|\/)demo[_/]/i, penalty: 30 },
];

function inferLang(path: string): BundleResult["language"] {
  const ext = path.toLowerCase().match(/\.([a-z0-9]+)$/)?.[1];
  if (ext === "m") return "matlab";
  if (ext === "py") return "python";
  if (ext === "js" || ext === "mjs") return "javascript";
  if (ext === "ts" || ext === "tsx" || ext === "jsx") return "typescript";
  if (ext === "r") return "r";
  return "other";
}

function basename(path: string): string {
  return path.replace(/\\/g, "/").split("/").pop() ?? path;
}
function stem(path: string): string {
  return basename(path).replace(/\.[^.]+$/, "");
}

function isNoise(path: string): string | null {
  for (const rx of NOISE_PATTERNS) {
    if (rx.test(path)) return rx.source;
  }
  return null;
}

function detectEntry(files: InputFile[], hint: string | null | undefined): InputFile | null {
  if (hint) {
    const exact = files.find((f) => f.path === hint);
    if (exact) return exact;
    const byBase = files.find((f) => basename(f.path) === basename(hint));
    if (byBase) return byBase;
  }
  // explicit "main_*" → "run_*" → "index"/"app" preference, code-bearing only
  const code = files.filter((f) => {
    const lang = inferLang(f.path);
    return lang !== "other" && !isNoise(f.path);
  });
  // prefer shallow paths (fewer slashes), then by name
  const score = (f: InputFile): number => {
    const b = basename(f.path).toLowerCase();
    const depth = (f.path.match(/\//g) ?? []).length;
    let s = -depth * 5;
    if (b.startsWith("main_") || b === "main.m" || b === "main.py") s += 100;
    if (b.startsWith("run_") || b === "run.py") s += 80;
    if (b.startsWith("experiment") || b.startsWith("exp_")) s += 60;
    if (b === "index.js" || b === "index.ts" || b === "app.py" || b === "app.js") s += 40;
    return s;
  };
  const sorted = [...code].sort((a, b) => score(b) - score(a));
  return sorted[0] ?? null;
}

// Identifier extractor — for MATLAB `foo(par, ...)` we want "foo"; for
// Python `from x.y import z` we want x/y; etc. Returns a Set of bare
// stems we'll try to match against the file tree.
function extractReferenceIdents(content: string, lang: BundleResult["language"]): Set<string> {
  const out = new Set<string>();
  if (lang === "matlab") {
    // identifiers used in call position: `name(...)`. Skip language keywords.
    const KW = new Set([
      "if", "elseif", "else", "for", "while", "switch", "case", "end", "function",
      "return", "break", "continue", "try", "catch", "global", "persistent",
      "true", "false", "size", "length", "numel", "zeros", "ones", "nan", "inf",
      "isfield", "isnan", "isnumeric", "ischar", "isempty", "fprintf", "sprintf",
      "disp", "input", "error", "warning", "addpath", "genpath", "fullfile",
      "Screen", "GetSecs", "WaitSecs", "DrawFormattedText", "SetMouse", "HideCursor",
      "ShowCursor", "KbCheck", "GetMouse", "rng", "save", "load", "clear", "clc",
      "close", "pause", "round", "mod", "min", "max", "sum", "mean", "find",
      "RandStream", "make", "iff", "cellfun", "arrayfun", "structfun", "strcmp",
      "regexp", "ismember", "any", "all", "not", "abs", "log", "exp",
    ]);
    for (const m of content.matchAll(/\b([A-Za-z_][A-Za-z0-9_]{2,})\s*\(/g)) {
      const id = m[1];
      if (!KW.has(id) && !KW.has(id.toLowerCase())) out.add(id);
    }
  } else if (lang === "python") {
    for (const m of content.matchAll(/^\s*from\s+([\w.]+)\s+import/gm)) out.add(m[1]);
    for (const m of content.matchAll(/^\s*import\s+([\w.]+)/gm)) out.add(m[1]);
  } else if (lang === "javascript" || lang === "typescript") {
    for (const m of content.matchAll(/from\s+['"]([^'"]+)['"]/g)) out.add(m[1]);
    for (const m of content.matchAll(/require\s*\(\s*['"]([^'"]+)['"]/g)) out.add(m[1]);
  } else if (lang === "r") {
    for (const m of content.matchAll(/source\s*\(\s*['"]([^'"]+)['"]/g)) out.add(m[1]);
  }
  return out;
}

function resolveRef(
  ident: string,
  files: InputFile[],
  lang: BundleResult["language"],
): InputFile | null {
  if (lang === "matlab") {
    // ident is a function name; match against any .m file with that stem
    const target = files.find((f) => stem(f.path) === ident);
    return target ?? null;
  }
  if (lang === "python") {
    // dotted ident → path/to/x.py
    const candidates = [
      `${ident.replace(/\./g, "/")}.py`,
      `${ident.replace(/\./g, "/")}/__init__.py`,
    ];
    for (const c of candidates) {
      const f = files.find((fl) => fl.path === c || fl.path.endsWith("/" + c));
      if (f) return f;
    }
    // fallback: last segment as basename
    const last = ident.split(".").pop()!;
    return files.find((fl) => stem(fl.path) === last) ?? null;
  }
  if (lang === "javascript" || lang === "typescript") {
    // relative-ish path; try common extensions
    const exts = [".ts", ".tsx", ".js", ".jsx", ".mjs"];
    const baseRel = ident.replace(/^\.\//, "");
    for (const ext of exts) {
      const f = files.find((fl) => fl.path.endsWith("/" + baseRel + ext) || fl.path === baseRel + ext);
      if (f) return f;
    }
    return null;
  }
  if (lang === "r") {
    const f = files.find((fl) => fl.path.endsWith("/" + ident) || fl.path === ident);
    return f ?? null;
  }
  return null;
}

function priorityOf(path: string): { score: number; role: BundleResult["selected"][number]["role"] } {
  let score = 0;
  let role: BundleResult["selected"][number]["role"] = "supporting";
  for (const p of PRIORITY_PATTERNS) {
    if (p.rx.test(path)) {
      score += p.bonus;
      role = p.role;
      break;
    }
  }
  for (const d of DEMOTE_PATTERNS) {
    if (d.rx.test(path)) score -= d.penalty;
  }
  return { score, role };
}

export function bundle(files: InputFile[], opts: BundleOptions = {}): BundleResult {
  const budget = opts.budgetChars ?? DEFAULT_BUDGET;
  const maxFiles = opts.maxFiles ?? DEFAULT_MAX_FILES;
  const dropped: BundleResult["dropped"] = [];

  // 1. drop noise files
  const usable = files.filter((f) => {
    const reason = isNoise(f.path);
    if (reason) {
      dropped.push({ path: f.path, reason: `noise: ${reason}` });
      return false;
    }
    return true;
  });

  // 2. detect entry
  const entry = detectEntry(usable, opts.entryHint ?? null);
  if (!entry) {
    return {
      entry: null,
      language: "other",
      bundled: "",
      selected: [],
      dropped,
      totalChars: 0,
    };
  }
  const language: BundleResult["language"] =
    opts.language && opts.language !== "auto" ? opts.language : inferLang(entry.path);

  // 3. follow references (1-hop). For MATLAB, also do a 2nd hop because
  //    parameter functions usually call into other parameter helpers.
  const idents = extractReferenceIdents(entry.content, language);
  const oneHop = new Map<string, InputFile>();
  for (const id of idents) {
    const f = resolveRef(id, usable, language);
    if (f && f.path !== entry.path && !oneHop.has(f.path)) oneHop.set(f.path, f);
  }
  const twoHop = new Map<string, InputFile>();
  if (language === "matlab" || language === "python") {
    for (const f of oneHop.values()) {
      const sub = extractReferenceIdents(f.content, language);
      for (const id of sub) {
        const r = resolveRef(id, usable, language);
        if (r && r.path !== entry.path && !oneHop.has(r.path) && !twoHop.has(r.path)) {
          twoHop.set(r.path, r);
        }
      }
    }
  }

  // 4. score & rank
  type Cand = {
    file: InputFile;
    score: number;
    role: BundleResult["selected"][number]["role"];
    hop: 0 | 1 | 2;
  };
  const cands: Cand[] = [];
  cands.push({ file: entry, score: 1_000_000, role: "entry", hop: 0 });
  for (const f of oneHop.values()) {
    const p = priorityOf(f.path);
    cands.push({ file: f, score: 1000 + p.score, role: p.role === "supporting" ? "called" : p.role, hop: 1 });
  }
  for (const f of twoHop.values()) {
    const p = priorityOf(f.path);
    cands.push({ file: f, score: 100 + p.score, role: p.role, hop: 2 });
  }
  cands.sort((a, b) => b.score - a.score);

  // 5. fit to budget
  const selected: BundleResult["selected"] = [];
  const parts: string[] = [];
  let used = 0;
  for (const c of cands) {
    if (selected.length >= maxFiles) {
      dropped.push({ path: c.file.path, reason: `maxFiles ${maxFiles}` });
      continue;
    }
    const lines = c.file.content.split(/\r?\n/);
    const refs = Array.from(extractReferenceIdents(c.file.content, language)).slice(0, 8);
    let body = c.file.content;
    let truncated = false;
    // give entry the largest slice; helpers limited to 12K each
    const fileCap = c.role === "entry" ? Math.min(40_000, budget - used) : Math.min(12_000, budget - used);
    if (body.length > fileCap) {
      // keep the head (where most identifier defs live in matlab/python)
      const head = body.slice(0, Math.floor(fileCap * 0.85));
      const tail = body.slice(-Math.floor(fileCap * 0.15));
      body = `${head}\n% [...truncated...]\n${tail}`;
      truncated = true;
    }
    const header = `=== file: ${c.file.path} (${lines.length} lines, ${c.file.content.length} chars; refs→[${refs.join(", ")}]) ===`;
    const piece = `${header}\n${body}\n`;
    if (used + piece.length > budget) {
      dropped.push({ path: c.file.path, reason: "budget" });
      continue;
    }
    parts.push(piece);
    used += piece.length;
    selected.push({
      path: c.file.path,
      bytes: body.length,
      truncated,
      role: c.role,
      score: c.score,
    });
  }

  return {
    entry: entry.path,
    language,
    bundled: parts.join("\n"),
    selected,
    dropped,
    totalChars: used,
  };
}
