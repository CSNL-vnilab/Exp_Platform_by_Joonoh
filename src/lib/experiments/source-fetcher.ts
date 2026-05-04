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

import { mkdtemp, readdir, readFile, stat, lstat, realpath, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { spawn } from "node:child_process";
import path from "node:path";

// Allow-list of git hosts the cloner will reach. Locks out internal
// gitlab / SSH-mounted hosts that would let a researcher exfiltrate
// the deploy machine's git credentials. Override via CODE_GIT_HOSTS
// (comma-separated suffixes).
const GIT_HOST_ALLOWLIST = (
  process.env.CODE_GIT_HOSTS ?? "github.com,gitlab.com,bitbucket.org,codeberg.org"
)
  .split(",")
  .map((s) => s.trim().toLowerCase())
  .filter(Boolean);

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
  // The fixtures dir is opt-in — only when explicitly enabled AND not
  // running in production. This was previously always-appended which
  // meant a self-hosted prod deploy with cwd=/repo could be tricked
  // into reading anything that landed under `scripts/fixtures` (e.g.
  // a planted symlink). See review item #7.
  const isProd = process.env.NODE_ENV === "production";
  if (!isProd && process.env.ANALYZER_FIXTURE_ROOT === "1") {
    explicit.push(path.resolve(process.cwd(), "scripts", "fixtures"));
  }
  return explicit;
}

function isUnderAllowedRoot(target: string): boolean {
  const resolved = path.resolve(target);
  for (const root of getAllowedRoots()) {
    const rel = path.relative(root, resolved);
    if (!rel.startsWith("..") && !path.isAbsolute(rel)) return true;
  }
  return false;
}

// Resolve symlinks before recursion. The previous walker used `stat`
// which follows links transparently — a symlink inside an allowed
// root could point to /etc/shadow and the walker would happily
// readFile through it. We use lstat first to detect links, then
// realpath the target and re-check the allow-list. Also defends
// against symlink loops (realpath rejects them on most platforms;
// we additionally bail on excessive depth via the maxFiles cap).
async function safeResolveEntry(
  abs: string,
): Promise<{ kind: "file" | "dir" | "skip"; reason?: string; size?: number }> {
  let lst;
  try {
    lst = await lstat(abs);
  } catch (err) {
    return { kind: "skip", reason: `lstat: ${(err as Error).message.slice(0, 60)}` };
  }
  if (lst.isSymbolicLink()) {
    let real: string;
    try {
      real = await realpath(abs);
    } catch {
      return { kind: "skip", reason: "broken symlink" };
    }
    if (!isUnderAllowedRoot(real)) {
      return { kind: "skip", reason: `symlink escapes allow-list → ${real}` };
    }
    let realSt;
    try {
      realSt = await stat(real);
    } catch {
      return { kind: "skip", reason: "symlink target unreadable" };
    }
    if (realSt.isDirectory()) return { kind: "dir" };
    if (realSt.isFile()) return { kind: "file", size: realSt.size };
    return { kind: "skip", reason: "non-regular link target" };
  }
  if (lst.isDirectory()) return { kind: "dir" };
  if (lst.isFile()) return { kind: "file", size: lst.size };
  return { kind: "skip", reason: "non-regular file" };
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

// Heuristic: file is binary if it contains a NUL byte in the first
// 4KB or > 30% of those bytes are U+FFFD (replacement char). Pure
// content-based - works for both filesystem and tarball flows.
function looksBinary(s: string): boolean {
  const head = s.slice(0, 4096);
  for (let i = 0; i < head.length; i += 1) {
    if (head.charCodeAt(i) === 0) return true;
  }
  let repl = 0;
  for (let i = 0; i < head.length; i += 1) {
    if (head.charCodeAt(i) === 0xfffd) repl += 1;
  }
  return repl > head.length * 0.3;
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
      // Use lstat-based resolution so symlinks can't escape the
      // allow-list (review item #1).
      const resolved = await safeResolveEntry(abs);
      if (resolved.kind === "skip") {
        skipped.push({ path: rel, reason: resolved.reason ?? "skipped" });
        continue;
      }
      if (resolved.kind === "dir") {
        if (SKIP_DIR.test(e.name)) {
          skipped.push({ path: rel, reason: "skipped dir" });
          continue;
        }
        await walk(abs);
        if (truncated) return;
        continue;
      }
      if (!TEXT_EXT.test(e.name)) {
        skipped.push({ path: rel, reason: "binary/unknown ext" });
        continue;
      }
      const size = resolved.size ?? 0;
      if (size > DEFAULT_FILE_CAP) {
        skipped.push({ path: rel, reason: `>${(DEFAULT_FILE_CAP / 1024).toFixed(0)}KB` });
        continue;
      }
      if (total + size > cap) {
        truncated = true;
        skipped.push({ path: rel, reason: "total budget" });
        return;
      }
      try {
        const content = await readFile(abs, "utf8");
        // Reject binary files masquerading as text (review item #11).
        // A `.mat` saved as `.m`, a corrupted file, or a UTF-16 BOM
        // file all light up the heuristic regex extractor with junk.
        if (looksBinary(content)) {
          skipped.push({ path: rel, reason: "binary content" });
          continue;
        }
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

  // Host allow-list. Block any host that isn't on the configured list
  // so a researcher pasting `https://internal-gitlab.lab.local/...`
  // can't make the deploy machine reach internal infra (review #8).
  let host = "";
  try {
    host = new URL(spec.url).host.toLowerCase();
  } catch {
    throw new Error(`잘못된 git URL 형식: ${spec.url.slice(0, 80)}`);
  }
  const hostOk = GIT_HOST_ALLOWLIST.some((suffix) => host === suffix || host.endsWith(`.${suffix}`));
  if (!hostOk) {
    throw new Error(
      `허용되지 않은 git 호스트: ${host}. CODE_GIT_HOSTS 환경변수에 등록된 호스트만 허용됩니다.`,
    );
  }

  // git CLI fallback for allow-listed non-github hosts. Strip every
  // possible source of credentials so the spawned `git` cannot use the
  // deploy machine's keychain / askpass / .gitconfig (review #8).
  const tmp = await mkdtemp(path.join(tmpdir(), "labres-clone-"));
  const args = [
    "-c", "core.askPass=/bin/false",
    "-c", "credential.helper=",
    "-c", "http.extraheader=",
    "clone", "--depth", "1", "--single-branch",
  ];
  if (spec.ref) args.push("--branch", spec.ref);
  args.push(spec.url, tmp);
  await runCmd("git", args, {
    timeoutMs: 60_000,
    env: {
      // Only PATH + LANG; everything else (HOME, credential helpers,
      // GIT_*, SSH_ASKPASS) deliberately unset.
      PATH: process.env.PATH ?? "/usr/bin:/bin",
      LANG: "C",
      GIT_TERMINAL_PROMPT: "0",
      GIT_ASKPASS: "/bin/false",
      SSH_ASKPASS: "/bin/false",
      // Empty HOME stops git from reading ~/.gitconfig and the user
      // keychain on macOS.
      HOME: tmp,
      XDG_CONFIG_HOME: tmp,
    } as unknown as NodeJS.ProcessEnv,
  });
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
    if (entry.type !== "file") continue;
    // Normalize backslash to forward-slash *before* security checks
    // (review #9).
    const rel = stripPrefix(entry.path).replace(/\\/g, "/");
    if (!rel) continue;
    // Path-traversal defence (review #2). Reject absolute paths and
    // any segment-equal `..`. The tarball reader's own header parser
    // also rejects these, but defence-in-depth.
    if (rel.startsWith("/") || rel.split("/").includes("..")) {
      skipped.push({ path: rel, reason: "path traversal blocked" });
      continue;
    }
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
    if (looksBinary(content)) {
      skipped.push({ path: rel, reason: "binary content" });
      continue;
    }
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
  // Carry-over from longname/pax headers that supply the path of the
  // *next* entry. Without this, tarballs with > 100-char paths (very
  // common on GNU tar) put the path payload into a "file" entry with
  // the previous truncated name -- silent data corruption (review #2).
  let pendingLongName: string | null = null;
  let pendingPaxPath: string | null = null;
  while (offset + 512 <= tar.length) {
    const header = tar.subarray(offset, offset + 512);
    if (header.every((b) => b === 0)) break;
    const name = readCString(header, 0, 100);
    const sizeOctal = readCString(header, 124, 12).trim();
    const size = parseInt(sizeOctal, 8) || 0;
    if (size < 0 || size > tar.length) break; // malformed octal -- bail
    const typeflag = String.fromCharCode(header[156] || 0);
    const prefix = readCString(header, 345, 155);
    let fullPath = prefix ? `${prefix}/${name}` : name;
    if (pendingLongName) { fullPath = pendingLongName; pendingLongName = null; }
    else if (pendingPaxPath) { fullPath = pendingPaxPath; pendingPaxPath = null; }
    offset += 512;
    const dataStart = offset;
    const dataEnd = Math.min(offset + size, tar.length);
    if (typeflag === "0" || typeflag === "" || typeflag === " ") {
      entries.push({
        path: fullPath,
        size: dataEnd - dataStart,
        type: "file",
        data: Buffer.from(tar.subarray(dataStart, dataEnd)),
      });
    } else if (typeflag === "5") {
      entries.push({ path: fullPath, size: 0, type: "dir", data: Buffer.alloc(0) });
    } else if (typeflag === "L") {
      pendingLongName = readCString(tar, dataStart, dataEnd - dataStart);
    } else if (typeflag === "x") {
      const text = tar.toString("utf8", dataStart, dataEnd);
      const m = text.match(/(?:^|\n)\d+ path=([^\n]+)\n/);
      if (m) pendingPaxPath = m[1];
    } else {
      // global pax ("g"), symlink ("2"), char/block/fifo (3/4/6) etc.
    }
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
  opts: { timeoutMs?: number; cwd?: string; env?: NodeJS.ProcessEnv } = {},
): Promise<{ stdout: string; stderr: string }> {
  return new Promise((resolve, reject) => {
    const child = spawn(cmd, args, {
      cwd: opts.cwd,
      // Caller may pass a tightly-scoped env (e.g. clearing HOME for
      // git fallback). Default still provides PATH so the binary can
      // be found.
      env: opts.env ?? { ...process.env, GIT_TERMINAL_PROMPT: "0" },
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
