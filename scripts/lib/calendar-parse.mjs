// Shared calendar title/description parser for backfill scripts.
//
// Returns `initials: string[]` (not a single string) so dual-initial
// events like `[JYK BHL] LabTour` keep both researchers. The bracketless
// fallback accepts a leading ALL-CAPS 2-4 token, but the caller is
// expected to whitelist it against the Members DB — this module itself
// does not judge validity.

const INITIAL_RE =
  /^\s*\[(?<initials>[A-Za-z]{2,6}(?:\s+[A-Za-z]{2,6})*)\]\s*/;
// Bracketless fallback: a leading ALL-CAPS 2-4 token followed by ':' or
// whitespace then more text. Caller MUST whitelist before treating the
// token as a researcher initial (see C1 in review of 2026-04-23).
const BRACKETLESS_INITIAL_RE = /^(?<initial>[A-Z]{2,4})\s*[:\s]\s*(?<rest>.+)$/;
const SBJ_RE = /(?:Sbj|SBJ|sbj)\s*(\d+)/;
const DAY_RE = /(?:Day|DAY|day)\s*(\d+)/;
const PERIOD_RE = /기간\s*(\d+)/;
const PAREN_RE = /\(([^()]+)\)/;

export function parseTitle(summary) {
  if (!summary) return null;
  const trimmed = summary.trim();
  let initials = null;
  let rest = "";
  let bracketless = false;
  const im = trimmed.match(INITIAL_RE);
  if (im) {
    initials = im.groups.initials
      .split(/\s+/)
      .filter(Boolean)
      .map((s) => s.toUpperCase());
    rest = trimmed.slice(im[0].length).trim();
  } else {
    const bm = trimmed.match(BRACKETLESS_INITIAL_RE);
    if (bm) {
      initials = [bm.groups.initial.toUpperCase()];
      rest = bm.groups.rest.trim();
      bracketless = true;
    }
  }
  if (!initials || initials.length === 0) return null;

  let titleParticipant = null;
  const pm = rest.match(PAREN_RE);
  if (pm) {
    titleParticipant = pm[1].trim();
    rest = (rest.slice(0, pm.index) + rest.slice(pm.index + pm[0].length))
      .replace(/\s+/g, " ")
      .trim();
  }
  let sbj = null;
  let day = null;
  let period = null;
  const sm = rest.match(SBJ_RE);
  if (sm) {
    sbj = Number.parseInt(sm[1], 10);
    rest = rest.replace(SBJ_RE, "").trim();
  }
  const dm = rest.match(DAY_RE);
  if (dm) {
    day = Number.parseInt(dm[1], 10);
    rest = rest.replace(DAY_RE, "").trim();
  }
  const perm = rest.match(PERIOD_RE);
  if (perm) {
    period = Number.parseInt(perm[1], 10);
    rest = rest.replace(PERIOD_RE, "").trim();
  }

  if (!titleParticipant) {
    const segments = rest.split(/\s*\/\s*/);
    const last = segments[segments.length - 1]?.trim() ?? "";
    if (/^[가-힣]{2,4}$/.test(last)) {
      titleParticipant = last;
      segments.pop();
      rest = segments.join(" / ").trim();
    }
  }
  let project = rest.replace(/\s*\/\s*/g, " / ").replace(/\s+/g, " ").trim();
  // Strip leading/trailing separators aggressively, including common
  // Korean/ASCII punctuation that slips in at title boundaries.
  while (
    project.startsWith("/") ||
    project.startsWith("-") ||
    project.endsWith("/") ||
    project.endsWith("-") ||
    project.endsWith(".") ||
    project.endsWith(",") ||
    project.endsWith("·") ||
    project.endsWith("。")
  ) {
    project = project.replace(/^[-/\s]+/, "").replace(/[-/\s.,·。]+$/, "");
  }
  if (!project) return null;

  const format =
    sbj != null && day != null && !titleParticipant
      ? "platform"
      : titleParticipant && sbj == null && day == null
        ? "legacy-paren"
        : "legacy-tags";

  return {
    format,
    initial: initials[0], // legacy single-initial field, kept for back-compat
    initials, // ALL initials — use this for relation writes
    bracketless, // caller should require membersByInitial[initial] to be set
    project,
    sbj,
    day,
    period,
    titleParticipant,
  };
}

export function parseDescription(desc) {
  if (!desc) return {};
  const out = {};
  for (const line of desc.split(/\r?\n/)) {
    const m = line.trim().match(/^(예약자|이메일|전화번호|회차)\s*[:：]\s*(.+)$/);
    if (!m) continue;
    out[
      m[1] === "예약자"
        ? "name"
        : m[1] === "이메일"
          ? "email"
          : m[1] === "전화번호"
            ? "phone"
            : "session"
    ] = m[2].trim();
  }
  return out;
}

// Project-name canonicalization. Case-insensitive, collapses whitespace /
// dashes / underscores. `self-pilot` === `Self Pilot` === `self_pilot`.
//
// Normalises to NFC and strips zero-width joiners so that titles copied
// from macOS (often NFD) or pasted from rich-text (U+200B/U+200C/U+200D/
// U+FEFF) compare equal to their canonical Notion counterparts. Without
// this, `Café` (NFD, 5 code points) and `Café` (NFC, 4) would miss.
export function canonProject(name) {
  return (name ?? "")
    .normalize("NFC")
    .replace(/[​-‍﻿]/g, "")
    .trim()
    .toLowerCase()
    .replace(/[\s\-_]+/g, "-");
}
