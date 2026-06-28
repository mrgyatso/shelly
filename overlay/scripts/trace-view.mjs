#!/usr/bin/env node
// trace-view.mjs — read the Companion trace harness log and print ONE artifact's
// cross-layer timeline (the join the harness exists to produce).
//
//   node trace-view.mjs <corr-substring>     # one artifact's stage-by-stage timeline
//   node trace-view.mjs --branches           # every ingest.branch decision + its inputs
//   node trace-view.mjs --polls              # poll cadence (spot webview throttling)
//
// The log is ~/.claude/companion/logs/trace.ndjson (one NDJSON event per line,
// epoch-ms clock, `corr` = the artifact's absolute path = the cross-layer join key).
// Turn the harness on with:  touch ~/.claude/companion/logs/trace.on   (rm to stop).
//
// To drive a FULL-pipeline trace you must write the artifact via Claude's Write tool
// (a shell `cp` into the artifacts dir does NOT fire the PostToolUse hook — only a
// Claude tool-write does). The watcher → board half traces either way.

import fs from "node:fs";
import os from "node:os";
import path from "node:path";

const LOG = path.join(os.homedir(), ".claude/companion/logs/trace.ndjson");

function load() {
  let raw;
  try {
    raw = fs.readFileSync(LOG, "utf8");
  } catch {
    console.error(`no trace log at ${LOG} — is the harness on? (touch ${path.dirname(LOG)}/trace.on)`);
    process.exit(1);
  }
  return raw
    .trim()
    .split("\n")
    .filter(Boolean)
    .map((l) => {
      try {
        return JSON.parse(l);
      } catch {
        return null;
      }
    })
    .filter(Boolean);
}

const KNOWN = new Set(["ts_ms", "pid", "layer", "evt", "corr"]);
const extras = (o) =>
  Object.entries(o)
    .filter(([k]) => !KNOWN.has(k))
    .map(([k, v]) => `${k}=${v}`)
    .join(" ");

function timeline(sub) {
  const ls = load().filter(
    (o) => (o.corr || "").includes(sub) || (o.file_path || "").includes(sub),
  );
  ls.sort((a, b) => a.ts_ms - b.ts_ms);
  if (!ls.length) {
    console.error(`no events matching "${sub}"`);
    process.exit(1);
  }
  const t0 = ls[0].ts_ms;
  console.log(`=== timeline for "${sub}" — ${ls.length} events, t0=${t0} ===`);
  const firstByLayer = {};
  for (const o of ls) {
    const dt = String(o.ts_ms - t0).padStart(7);
    console.log(`+${dt}ms  ${`${o.layer}/${o.evt}`.padEnd(24)}  ${extras(o)}`);
    firstByLayer[o.layer] ??= o.ts_ms;
  }
  console.log("\n--- first touch per layer (ms after t0) ---");
  for (const [layer, ts] of Object.entries(firstByLayer)) {
    console.log(`  ${layer.padEnd(10)} +${ts - t0}ms`);
  }
  const branch = ls.find((o) => o.evt === "ingest.branch");
  if (branch) console.log(`\n--- board branch: ${branch.branch} (unitFrom=${branch.unitFrom}, source="${branch.source}") ---`);
}

function branches() {
  for (const o of load().filter((o) => o.evt === "ingest.branch")) {
    const name = (o.corr || "").split("/").pop();
    console.log(
      `${name}  =>  ${o.branch}  | unit=${o.unit} viewingUnit=${o.viewingUnit} unitFrom=${o.unitFrom} source="${o.source}" activeSrc="${o.activeSrc}"`,
    );
  }
}

function polls() {
  const ps = load().filter((o) => o.evt === "poll.start");
  let prev = null;
  for (const o of ps) {
    const gap = prev === null ? 0 : o.ts_ms - prev;
    prev = o.ts_ms;
    const flag = gap > 5000 ? "  <-- GAP (poll throttled?)" : "";
    console.log(`${o.ts_ms}  gap=${String(gap).padStart(6)}ms${flag}`);
  }
}

const arg = process.argv[2];
if (!arg) {
  console.error("usage: node trace-view.mjs <corr-substring> | --branches | --polls");
  process.exit(1);
} else if (arg === "--branches") {
  branches();
} else if (arg === "--polls") {
  polls();
} else {
  timeline(arg);
}
