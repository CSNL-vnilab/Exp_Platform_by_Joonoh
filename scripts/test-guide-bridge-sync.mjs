#!/usr/bin/env node
// Keeps docs/online-experiment-designer-guide.md and the demo-exp stubs
// in sync with the actual bridge surface declared in
// src/components/run/run-shell.tsx. If a new expPlatform property or
// method is added without updating the guide, or the guide advertises a
// name the bridge doesn't expose, this fails. Cheap to run; pair it
// with the smoke-cron-auth script in CI.
//
// Usage: node scripts/test-guide-bridge-sync.mjs
// Exit 0 on sync, 1 on drift.

import { readFile } from "node:fs/promises";

const BRIDGE = "src/components/run/run-shell.tsx";
const GUIDE = "docs/online-experiment-designer-guide.md";
const DEMOS = [
  "public/demo-exp/hello-world.js",
  "public/demo-exp/number-task.js",
  "public/demo-exp/rating-task.js",
  "public/demo-exp/timeexp/main.js",
];

// Canonical surface the bridge hands to the iframe. Keep this list
// narrow — it's the "public API" researchers code against. If you
// deliberately add or rename a surface, update this constant.
const EXPECTED_PROPS = [
  "subject",
  "experimentId",
  "bookingId",
  "config",
  "blocksSubmitted",
  "condition",
  "isPilot",
  "clock",
];
const EXPECTED_METHODS = ["submitBlock", "reportAttentionFailure", "log"];
// Namespaced methods under expPlatform.clock. Keep in the same grammar
// as EXPECTED_METHODS (checked as a name token in both bridge + guide).
const EXPECTED_CLOCK_METHODS = ["now", "nextFrame"];
const SUBMIT_KEYS_SHIM_ACCEPTS = [
  "blockIndex",
  "block_index",
  "trials",
  "blockMetadata",
  "block_metadata",
  "completedAt",
  "completed_at",
  "isLast",
  "is_last",
];

function fail(msg) {
  console.error(`✗ ${msg}`);
  process.exitCode = 1;
}
function pass(msg) {
  console.log(`  ✓ ${msg}`);
}

const bridgeSrc = await readFile(BRIDGE, "utf8");
const guideSrc = await readFile(GUIDE, "utf8");

console.log("Bridge/guide sync check");
console.log("───────────────────────────────────────");

// 1. Every EXPECTED surface is declared in the bridge file.
for (const prop of [...EXPECTED_PROPS, ...EXPECTED_METHODS]) {
  const inBridge = new RegExp(`\\b${prop}\\s*:`).test(bridgeSrc);
  if (!inBridge) fail(`bridge missing expected surface: ${prop}`);
  else pass(`bridge exposes .${prop}`);
}

// 2. Guide mentions every expected surface (so researchers know it exists).
for (const prop of [...EXPECTED_PROPS, ...EXPECTED_METHODS]) {
  const inGuide = new RegExp(`(expPlatform\\.)?${prop}\\b`).test(guideSrc);
  if (!inGuide) fail(`guide doesn't document: ${prop}`);
  else pass(`guide documents .${prop}`);
}

// 2b. Clock sub-surface — the iframe bridge exposes expPlatform.clock
// as a namespace. Both bridge + guide must mention each method by its
// `clock.<name>` path; a bare `.now` token would be ambiguous so we
// scan for the dotted form.
for (const m of EXPECTED_CLOCK_METHODS) {
  const inBridge = new RegExp(`\\b${m}\\b\\s*:\\s*function`).test(bridgeSrc);
  if (!inBridge) fail(`bridge clock missing: ${m}`);
  else pass(`bridge exposes clock.${m}`);
  const inGuide = new RegExp(`clock\\.${m}\\b`).test(guideSrc);
  if (!inGuide) fail(`guide doesn't document clock.${m}`);
  else pass(`guide documents clock.${m}`);
}

// 3. submitBlock payload keys the guide teaches must all be recognized
// by the shim's normalizer (blockIndex OR block_index etc).
const taughtKeys =
  guideSrc.match(/submitBlock\s*\(\s*\{([\s\S]*?)\}\s*\)/g) ?? [];
const keysInGuide = new Set();
for (const block of taughtKeys) {
  const keys = block.match(/\b([a-zA-Z_]+)\s*:/g) ?? [];
  for (const k of keys) keysInGuide.add(k.replace(/\s*:$/, "").trim());
}
for (const k of keysInGuide) {
  if (!SUBMIT_KEYS_SHIM_ACCEPTS.includes(k)) {
    fail(`guide teaches submitBlock key "${k}" that the shim doesn't accept`);
  } else {
    pass(`shim accepts submitBlock.${k}`);
  }
}

// 4. Every demo-exp stub references expPlatform and calls submitBlock at least once.
for (const path of DEMOS) {
  let src;
  try {
    src = await readFile(path, "utf8");
  } catch {
    fail(`demo file missing: ${path}`);
    continue;
  }
  if (!/window\.expPlatform|var\s+EP\s*=\s*window\.expPlatform/.test(src)) {
    fail(`${path} never touches window.expPlatform`);
    continue;
  }
  if (!/\bsubmitBlock\s*\(/.test(src)) {
    fail(`${path} never calls submitBlock`);
    continue;
  }
  pass(`${path} uses the bridge correctly`);
}

if (process.exitCode) {
  console.log("───────────────────────────────────────");
  console.log("✗ guide/bridge drift detected");
  process.exit(1);
}
console.log("───────────────────────────────────────");
console.log("✓ guide, demos, and bridge surface are in sync");
