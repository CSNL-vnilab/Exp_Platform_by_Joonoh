#!/usr/bin/env node
// Smoke tests for the shared calendar parser.
//
// Run: `node --test scripts/test-calendar-parse.mjs`
// Or:  `node scripts/test-calendar-parse.mjs` (also works — it's just
// assertions that throw on failure).
//
// Covers the formats the strict reviewer flagged (2026-04-23) + known
// historical edge cases in the live SLab calendar. Add a new case here
// any time you patch scripts/lib/calendar-parse.mjs.

import test from "node:test";
import { strict as assert } from "node:assert";
import { parseTitle, parseDescription, canonProject } from "./lib/calendar-parse.mjs";

test("platform format — full tags", () => {
  const r = parseTitle("[BYL] Pilot Sbj3 Day2");
  assert.deepEqual(r?.initials, ["BYL"]);
  assert.equal(r?.project, "Pilot");
  assert.equal(r?.sbj, 3);
  assert.equal(r?.day, 2);
  assert.equal(r?.bracketless, false);
});

test("dual-initial — keeps both in initials[]", () => {
  const r = parseTitle("[JYK BHL] LabTour 실습 준비");
  assert.deepEqual(r?.initials, ["JYK", "BHL"]);
  assert.equal(r?.project, "LabTour 실습 준비");
});

test("triple-initial — keeps all three", () => {
  const r = parseTitle("[BYL BHL SYJ] Exp");
  assert.deepEqual(r?.initials, ["BYL", "BHL", "SYJ"]);
});

test("bracketless accepted but flagged for whitelist check", () => {
  const r = parseTitle("JOP: Pilot");
  assert.deepEqual(r?.initials, ["JOP"]);
  assert.equal(r?.project, "Pilot");
  assert.equal(r?.bracketless, true);
});

test("bracketless phantom — parser admits it; caller must whitelist", () => {
  const r = parseTitle("GPU 회의");
  // 회의 is Korean so trailing-Korean heuristic strips it → project empty → null.
  assert.equal(r, null);
});

test("bracketless NEW EVENT", () => {
  const r = parseTitle("NEW EVENT");
  assert.deepEqual(r?.initials, ["NEW"]);
  assert.equal(r?.project, "EVENT");
  assert.equal(r?.bracketless, true);
  // Caller (consistency-check) rejects this because NEW isn't in Members DB.
});

test("legacy-paren format with Korean participant", () => {
  const r = parseTitle("[SMJ] Pilot (조수영)");
  assert.deepEqual(r?.initials, ["SMJ"]);
  assert.equal(r?.project, "Pilot");
  assert.equal(r?.titleParticipant, "조수영");
  assert.equal(r?.format, "legacy-paren");
});

test("multi-segment Korean format", () => {
  const r = parseTitle("[BYL] Exp1 / Day 2 / 기간 3 / 김영희");
  assert.deepEqual(r?.initials, ["BYL"]);
  assert.equal(r?.project, "Exp1");
  assert.equal(r?.day, 2);
  assert.equal(r?.period, 3);
  assert.equal(r?.titleParticipant, "김영희");
});

test("Meeting: SK blacklist candidate", () => {
  const r = parseTitle("Meeting: SK");
  // "Meeting" is title-case, not all-caps, so bracketless regex fails.
  assert.equal(r, null);
});

test("TAC meeting: SK — parser admits TAC, caller rejects", () => {
  const r = parseTitle("TAC meeting: SK");
  assert.deepEqual(r?.initials, ["TAC"]);
  assert.equal(r?.bracketless, true);
});

test("null/empty inputs", () => {
  assert.equal(parseTitle(null), null);
  assert.equal(parseTitle(""), null);
  assert.equal(parseTitle("(no title)"), null);
});

test("description parser — standard KST booking", () => {
  const d = parseDescription("예약자: 김다영\n이메일: kim@example.com\n전화번호: 010-1234-5678");
  assert.equal(d.name, "김다영");
  assert.equal(d.email, "kim@example.com");
  assert.equal(d.phone, "010-1234-5678");
});

test("description parser — Korean colon (：)", () => {
  const d = parseDescription("예약자：이보연\n이메일：lee@example.com");
  assert.equal(d.name, "이보연");
  assert.equal(d.email, "lee@example.com");
});

test("canonProject — case + space + dash collapse", () => {
  assert.equal(canonProject("Self Pilot"), "self-pilot");
  assert.equal(canonProject("self pilot"), "self-pilot");
  assert.equal(canonProject("Self-Pilot"), "self-pilot");
  assert.equal(canonProject("self_pilot"), "self-pilot");
  assert.equal(canonProject("  Self  Pilot  "), "self-pilot");
});

test("canonProject — distinct projects stay distinct", () => {
  assert.notEqual(canonProject("Pilot"), canonProject("Main task pilot"));
  assert.notEqual(canonProject("Pilot"), canonProject("Pilot with Interns"));
  assert.notEqual(canonProject("Pilot"), canonProject("Self Pilot"));
});

test("canonProject — NFC normalisation equates NFC + NFD forms", () => {
  // Composed vs decomposed Hangul.
  const nfc = "한글";
  const nfd = "한글".normalize("NFD");
  assert.notEqual(nfc, nfd); // raw strings differ
  assert.equal(canonProject(nfc), canonProject(nfd));
});

test("canonProject — strips zero-width and BOM characters", () => {
  assert.equal(canonProject("Pilot​"), "pilot"); // trailing ZWSP
  assert.equal(canonProject("﻿Pilot"), "pilot"); // leading BOM
  assert.equal(canonProject("Pi‍lot"), "pilot"); // embedded ZWJ
});

test("project with trailing punctuation stripped", () => {
  const r = parseTitle("[BYL] Pilot.");
  assert.equal(r?.project, "Pilot");
});

test("project with trailing slash stripped", () => {
  const r = parseTitle("[BYL] Exp1/");
  assert.equal(r?.project, "Exp1");
});

test("legacy-tags format with Sbj only", () => {
  const r = parseTitle("[BYL] Exp1 Sbj9 (김서연) Day1");
  assert.deepEqual(r?.initials, ["BYL"]);
  assert.equal(r?.project, "Exp1");
  assert.equal(r?.sbj, 9);
  assert.equal(r?.day, 1);
  assert.equal(r?.titleParticipant, "김서연");
});
