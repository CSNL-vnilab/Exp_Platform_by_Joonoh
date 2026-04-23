#!/usr/bin/env node
// Continuous QC smoke loop. Runs:
//   1. node scripts/db-audit.mjs      (schema + trigger + RLS + etc.)
//   2. node scripts/notion-setup.mjs  (idempotent schema re-verify — no-ops on healthy DB)
//   3. node scripts/notion-demo.mjs   (optional, only every Nth iteration — writes a fresh demo)
//
// Emits one line per iteration so the Monitor tool can pipe events into
// the Claude Code chat. Intended to run via:
//   Monitor({ command: "node scripts/qc-loop.mjs", persistent: true })
//
// Flags:
//   --interval=SEC   seconds between iterations (default 600 = 10 min)
//   --demo-every=N   write a demo page every N iterations (default 0 = never)
//   --once           one pass and exit (for ad-hoc CI-like runs)

import { spawn } from "node:child_process";

const intervalArg = process.argv.find((a) => a.startsWith("--interval="));
const intervalSec = intervalArg
  ? Math.max(60, parseInt(intervalArg.split("=")[1], 10) || 600)
  : 600;
const demoEveryArg = process.argv.find((a) => a.startsWith("--demo-every="));
const demoEvery = demoEveryArg
  ? Math.max(0, parseInt(demoEveryArg.split("=")[1], 10) || 0)
  : 0;
const once = process.argv.includes("--once");

function iso() {
  return new Date().toISOString();
}

function runScript(path) {
  return new Promise((resolve) => {
    const child = spawn("node", [path], { stdio: ["ignore", "pipe", "pipe"] });
    let stdout = "";
    let stderr = "";
    child.stdout.on("data", (d) => (stdout += d.toString()));
    child.stderr.on("data", (d) => (stderr += d.toString()));
    child.on("exit", (code) => {
      resolve({ code, stdout, stderr });
    });
  });
}

function summarize(path, result) {
  const lines = result.stdout.split("\n").filter(Boolean);
  // Keep only the final summary line (scripts are chatty but end with totals).
  const tail = lines.slice(-3).join(" | ").replace(/\s+/g, " ").slice(0, 240);
  const code = result.code === 0 ? "ok" : `fail(${result.code})`;
  return `${path} ${code} — ${tail}`;
}

let iter = 0;

async function tick() {
  iter += 1;
  const line = [`[qc ${iso()}] iter=${iter}`];
  try {
    const audit = await runScript("scripts/db-audit.mjs");
    line.push(summarize("db-audit", audit));
  } catch (err) {
    line.push(`db-audit crash: ${err.message}`);
  }
  try {
    const setup = await runScript("scripts/notion-setup.mjs");
    line.push(summarize("notion-setup", setup));
  } catch (err) {
    line.push(`notion-setup crash: ${err.message}`);
  }
  if (demoEvery > 0 && iter % demoEvery === 0) {
    try {
      const demo = await runScript("scripts/notion-demo.mjs");
      line.push(summarize("notion-demo", demo));
    } catch (err) {
      line.push(`notion-demo crash: ${err.message}`);
    }
  }
  console.log(line.join(" · "));
}

async function loop() {
  await tick();
  if (once) return;
  setInterval(tick, intervalSec * 1000);
}

loop().catch((err) => {
  console.error("qc-loop fatal:", err.message);
  process.exit(1);
});
