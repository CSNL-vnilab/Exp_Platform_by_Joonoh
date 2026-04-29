// Source fetcher: turn a researcher-supplied address into a flat list
// of {path, content} files the bundler can consume. Two source kinds:
//
//   1. server-path: an absolute path on a mounted filesystem (e.g.
//      "/Volumes/CSNL_new-1/people/JOP/Magnitude/Experiment"). The
//      caller-supplied path is validated against an env-driven
//      allow-list to prevent reading from arbitrary locations.
//
//   2. github: an HTTPS URL or owner/repo[#branch] shorthand. We
//      shallow-clone via the system `git` binary (works for public
//      repos and any private repo where the server has credentials —
//      no API token plumbing required for v1).
//
// Both paths cap total bytes read (default 5 MiB) and skip binary
// extensions / heavy directories so a 200-MB repo doesn't blow up the
// process.

import { mkdtemp, readdir, readFile, stat, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { spawn } from "node:child_process";
import path from "node:path";

const TEXT_EXT = /\.(m|py|js|mjs|ts|tsx|jsx|r|txt|md|markdown|json|ya?ml|toml|cfg|ini|sh|csv|tex)$/i;
const SKIP_DIR = /^(\.git|node_modules|results|data|raw|figures|figs|__pycache__|dist|build|\.venv|venv|env|coverage|\.next|\.cache|tex_cache)$/;
const DEFAULT_TOTAL_CAP = 5 * 1024 * 1024;
const DEFAULT_FILE_CAP = 400_000;

// ---------------------------------------------------------------------------
// allow-list resolution
// ---------------------------------------------------------------------------
// Comma-separated absolute paths. Defaults to a pair that match the lab's
// CSNL volume mount conventions; admins should set CODE_SOURCE_ROOTS in
// their env to lock things down.
function getAllowedRoots(): string[] {
  const raw = (
    process.env.CODE_SOURCE_ROOTS ??
    "/Volumes/CSNL_new-1,/Volumes/CSNL_new,/srv/csnl,/Volumes/CSNL"
  ).split(",");
  const explicit = raw
    .map((p) => p.trim())
    .filter(Boolean)
    .map((p) => path.resolve(p));
  // Also accept anything under the running project's `scripts/fixtures`
  // tree — needed for the bench harness on developer laptops where
  // CODE_SOURCE_ROOTS doesn't include the repo path. Vercel functions
  // never resolve to this path so it doesn't widen production attack
  // surface.
  const fixtureRoot = path.resolve(process.cwd(), "scripts", "fixtures");
  return [...explicit, fixtureRoot];
}

function isUnderAllowedRoot(target: string): boolean {
  const resolved = path.resolve(target);
  for (const root of getAllowedRoots()) {
    const rel = path.relative(root, resolved);
    if (!rel.startsWith("..") && !path.isAbsolute(rel)) return true;
  }
  return false;
}

export interface FetchedFile {
  path: string; // posix-style relative to the source root
  content: string;
}

export interface FetchResult {
  files: FetchedFile[];
  rootPath: string;          // for server-path: the supplied dir; for github: the temp clone root
  rootDisplay: string;       // human-friendly label (the supplied URL / path)
  truncated: boolean;        // hit the byte cap
  skipped: Array<{ path: string; reason: string }>;
  cleanup?: () => Promise<void>; // call after analysis (github tmp dir removal)
}

// ---------------------------------------------------------------------------
// server-path source
// ---------------------------------------------------------------------------
export async function fetchServerPath(absPath: string): Promise<FetchResult> {
  if (!path.isAbsolute(absPath)) {
    throw new Error("절대 경로만 허용합니다 (e.g. /Volumes/...)");
  }
  if (!isUnderAllowedRoot(absPath)) {
    throw new Error(
      `허용되지 않은 경로입니다. CODE_SOURCE_ROOTS 환경변수에 등록된 루트만 허용됩니다.`,
    );
  }
  const st = await stat(absPath).catch(() => null);
  if (!st) throw new Error(`경로를 찾을 수 없습니다: ${absPath}`);
  if (!st.isDirectory()) {
    // Single-file source — wrap as a 1-file list.
    const content = await readFile(absPath, "utf8");
    const base = path.basename(absPath);
    return {
      files: [{ path: base, content }],
      rootPath: path.dirname(absPath),
      rootDisplay: absPath,
      truncated: false,
      skipped: [],
    };
  }
  return readDirRecursive(absPath, absPath, DEFAULT_TOTAL_CAP);
}

async function readDirRecursive(
  root: string,
  cur: string,
  cap: number,
): Promise<FetchResult> {
  const files: FetchedFile[] = [];
  const skipped: FetchResult["skipped"] = [];
  let total = 0;
  let truncated = false;

  async function walk(dir: string): Promise<void> {
    if (truncated) return;
    let entries: import("node:fs").Dirent[];
    try {
      entries = await readdir(dir, { withFileTypes: true });
    } catch (err) {
      skipped.push({ path: path.relative(root, dir) || ".", reason: `read failed: ${(err as Error).message.slice(0, 80)}` });
      return;
    }
    for (const e of entries) {
      const abs = path.join(dir, e.name);
      const rel = path.relative(root, abs).replace(/\\/g, "/");
      if (e.isDirectory()) {
        if (SKIP_DIR.test(e.name)) {
          skipped.push({ path: rel, reason: "skipped dir" });
          continue;
        }
        await walk(abs);
        if (truncated) return;
        continue;
      }
      if (!e.isFile()) continue;
      if (!TEXT_EXT.test(e.name)) {
        skipped.push({ path: rel, reason: "binary/unknown ext" });
        continue;
      }
      const fst = await stat(abs).catch(() => null);
      if (!fst) continue;
      if (fst.size > DEFAULT_FILE_CAP) {
        skipped.push({ path: rel, reason: `>${(DEFAULT_FILE_CAP / 1024).toFixed(0)}KB` });
        continue;
      }
      if (total + fst.size > cap) {
        truncated = true;
        skipped.push({ path: rel, reason: "total budget" });
        return;
      }
      try {
        const content = await readFile(abs, "utf8");
        files.push({ path: rel, content });
        total += content.length;
      } catch (err) {
        skipped.push({ path: rel, reason: `read failed: ${(err as Error).message.slice(0, 60)}` });
      }
    }
  }

  await walk(cur);
  return {
    files,
    rootPath: root,
    rootDisplay: root,
    truncated,
    skipped,
  };
}

// ---------------------------------------------------------------------------
// github source
// ---------------------------------------------------------------------------
export interface GithubSpec {
  url: string;       // canonical: https://github.com/<owner>/<repo>(.git)? or git@…
  ref?: string | null; // branch / tag / sha
}

export function parseGithub(input: string): GithubSpec {
  const trimmed = input.trim();
  if (!trimmed) throw new Error("github 주소가 비어있습니다");

  let ref: string | null = null;
  const hashIdx = trimmed.lastIndexOf("#");
  let urlish = trimmed;
  if (hashIdx > 0 && !/https?:\/\//i.test(trimmed.slice(hashIdx))) {
    ref = trimmed.slice(hashIdx + 1).trim() || null;
    urlish = trimmed.slice(0, hashIdx);
  }

  // Shorthand: "owner/repo"
  if (/^[\w.-]+\/[\w.-]+$/.test(urlish)) {
    return { url: `https://github.com/${urlish}.git`, ref };
  }
  // SSH: git@github.com:owner/repo.git
  if (/^git@[\w.-]+:/.test(urlish)) {
    return { url: urlish, ref };
  }
  // HTTPS URL — accept github.com, github enterprise, gitlab, bitbucket
  if (/^https?:\/\//i.test(urlish)) {
    return { url: urlish.replace(/\/$/, ""), ref };
  }
  throw new Error(`지원하지 않는 git 주소 형식: ${urlish.slice(0, 80)}`);
}

export async function fetchGithub(spec: GithubSpec): Promise<FetchResult> {
  // Strategy:
  //   1. If the URL is github.com (or github.com/api), use the tarball
  //      REST endpoint — no git binary required (works on Vercel).
  //   2. Else (gitlab / bitbucket / private SSH), fall back to git CLI.
  //
  // Tarball path also accepts an optional GITHUB_TOKEN env for private
  // repos. Public repos work anonymously up to the rate limit.
  const ghMatch = spec.url.match(/^https?:\/\/github\.com\/([\w.-]+)\/([\w.-]+?)(?:\.git)?\/?$/i);
  if (ghMatch) {
    const owner = ghMatch[1];
    const repo = ghMatch[2];
    return fetchGithubTarball(owner, repo, spec.ref ?? null, spec.url + (spec.ref ? `#${spec.ref}` : ""));
  }
  // git CLI fallback (preserves the original behaviour for non-GitHub
  // hosts and for environments with credentials configured)
  const tmp = await mkdtemp(path.join(tmpdir(), "labres-clone-"));
  const args = ["clone", "--depth", "1", "--single-branch"];
  if (spec.ref) args.push("--branch", spec.ref);
  args.push(spec.url, tmp);
  await runCmd("git", args, { timeoutMs: 60_000 });
  const result = await readDirRecursive(tmp, tmp, DEFAULT_TOTAL_CAP);
  return {
    ...result,
    rootDisplay: spec.url + (spec.ref ? `#${spec.ref}` : ""),
    cleanup: async () => {
      await rm(tmp, { recursive: true, force: true }).catch(() => {});
    },
  };
}

// Pull and extract the GitHub repo as a tarball. Uses Node's built-in
// fetch (Vercel-friendly) and a tiny tar.gz reader. Works for public
// repos without a token; private repos need GITHUB_TOKEN.
async function fetchGithubTarball(
  owner: string,
  repo: string,
  ref: string | null,
  rootDisplay: string,
): Promise<FetchResult> {
  const headers: Record<string, string> = {
    Accept: "application/vnd.github.v3.raw",
    "User-Agent": "lab-reservation-analyzer",
  };
  if (process.env.GITHUB_TOKEN) headers.Authorization = `Bearer ${process.env.GITHUB_TOKEN}`;
  const refPart = ref ? `/${encodeURIComponent(ref)}` : "";
  const url = `https://api.github.com/repos/${owner}/${repo}/tarball${refPart}`;
  const res = await fetch(url, { headers });
  if (!res.ok) {
    throw new Error(`GitHub tarball fetch 실패 (${res.status}): ${url}`);
  }
  const buf = Buffer.from(await res.arrayBuffer());

  const files: FetchedFile[] = [];
  const skipped: FetchResult["skipped"] = [];
  const extracted = await readTarballEntries(buf);
  let total = 0;
  let truncated = false;
  // Files arrive prefixed with "{owner}-{repo}-{sha}/" — strip that.
  const stripPrefix = (p: string): string => p.replace(/^[^/]+\//, "");
  for (const entry of extracted) {
    if (truncated) break;
    const rel = stripPrefix(entry.path).replace(/\\/g, "/");
    if (!rel) continue;
    if (isNoiseInTarball(rel)) {
      skipped.push({ path: rel, reason: "filtered (dir/ext)" });
      continue;
    }
    if (entry.size > DEFAULT_FILE_CAP) {
      skipped.push({ path: rel, reason: `>${(DEFAULT_FILE_CAP / 1024).toFixed(0)}KB` });
      continue;
    }
    if (total + entry.size > DEFAULT_TOTAL_CAP) {
      truncated = true;
      skipped.push({ path: rel, reason: "total budget" });
      break;
    }
    const content = entry.data.toString("utf8");
    files.push({ path: rel, content });
    total += content.length;
  }
  return { files, rootPath: `tarball:${owner}/${repo}`, rootDisplay, truncated, skipped };
}

// Mirror NOISE_PATTERNS / TEXT_EXT logic but inlined here to avoid the
// filesystem-walk machinery — tarball entries are already in memory.
const TARBALL_NOISE_DIR = /(^|\/)(\.git|node_modules|results|data|raw|figures|figs|__pycache__|dist|build|\.venv|venv|env|coverage|\.next|\.cache|tex_cache|archive|legacy|deprecated|Old_)/i;
function isNoiseInTarball(p: string): boolean {
  if (TARBALL_NOISE_DIR.test(p)) return true;
  if (!TEXT_EXT.test(p)) return true;
  if (p.includes("__MACOSX/") || p.endsWith(".DS_Store")) return true;
  return false;
}

// Minimal tar.gz reader — handles ustar files, skips global headers /
// links / longnames. Pure JS, no zlib loaded outside Node core.
import { gunzipSync } from "node:zlib";
interface TarEntry {
  path: string;
  size: number;
  type: "file" | "dir" | "other";
  data: Buffer;
}
async function readTarballEntries(buf: Buffer): Promise<TarEntry[]> {
  const tar = gunzipSync(buf);
  const entries: TarEntry[] = [];
  let offset = 0;
  while (offset + 512 <= tar.length) {
    const header = tar.subarray(offset, offset + 512);
    // detect end of archive (two consecutive 512-byte zero blocks)
    if (header.every((b) => b === 0)) break;
    const name = readCString(header, 0, 100);
    const sizeOctal = readCString(header, 124, 12).trim();
    const size = parseInt(sizeOctal, 8) || 0;
    const typeflag = String.fromCharCode(header[156] || 0);
    const prefix = readCString(header, 345, 155);
    const fullPath = prefix ? `${prefix}/${name}` : name;
    offset += 512;
    if (typeflag === "0" || typeflag === "" || typeflag === " ") {
      const data = tar.subarray(offset, offset + size);
      entries.push({ path: fullPath, size, type: "file", data: Buffer.from(data) });
    } else if (typeflag === "5") {
      entries.push({ path: fullPath, size: 0, type: "dir", data: Buffer.alloc(0) });
    } else {
      // longnames, pax, links — skip
    }
    // tar pads to 512-byte boundary
    offset += Math.ceil(size / 512) * 512;
  }
  return entries;
}
function readCString(buf: Buffer, off: number, len: number): string {
  const end = buf.indexOf(0, off);
  const stop = end >= 0 && end < off + len ? end : off + len;
  return buf.toString("utf8", off, stop);
}

// ---------------------------------------------------------------------------
// helpers
// ---------------------------------------------------------------------------
async function runCmd(
  cmd: string,
  args: string[],
  opts: { timeoutMs?: number; cwd?: string } = {},
): Promise<{ stdout: string; stderr: string }> {
  return new Promise((resolve, reject) => {
    const child = spawn(cmd, args, {
      cwd: opts.cwd,
      env: { ...process.env, GIT_TERMINAL_PROMPT: "0" },
      stdio: ["ignore", "pipe", "pipe"],
    });
    let stdout = "";
    let stderr = "";
    const timeout = opts.timeoutMs
      ? setTimeout(() => {
          child.kill("SIGKILL");
          reject(new Error(`${cmd} 타임아웃 (${opts.timeoutMs} ms)`));
        }, opts.timeoutMs)
      : null;
    child.stdout.on("data", (d) => (stdout += d.toString()));
    child.stderr.on("data", (d) => (stderr += d.toString()));
    child.on("error", (err) => {
      if (timeout) clearTimeout(timeout);
      reject(err);
    });
    child.on("close", (code) => {
      if (timeout) clearTimeout(timeout);
      if (code === 0) resolve({ stdout, stderr });
      else reject(new Error(`${cmd} 실패 (exit ${code}): ${stderr.slice(0, 200)}`));
    });
  });
}

// Public entry — kind is auto-detected from the input shape.
export async function fetchSource(input: {
  kind?: "auto" | "server-path" | "github";
  source: string;
}): Promise<FetchResult> {
  const src = input.source.trim();
  const kind =
    input.kind && input.kind !== "auto"
      ? input.kind
      : src.startsWith("/") || src.startsWith("~")
        ? "server-path"
        : "github";
  if (kind === "server-path") {
    return fetchServerPath(src.startsWith("~") ? path.join(process.env.HOME ?? "", src.slice(1)) : src);
  }
  return fetchGithub(parseGithub(src));
}
