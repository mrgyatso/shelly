#!/usr/bin/env node
// Run all identity-registry hook-integration suites; exit non-zero if any fails.
// These exercise the REAL shell+node hook path (companion-session, companion-index.cjs,
// companion-identity.cjs) under a sandboxed throwaway HOME — the deterministic slice of the
// §8 matrix the live merge-and-test session leans on (see DECISIONS-identity-registry.md).
//
//   node plugin/hooks/__tests__/run.cjs

const path = require("path");
const { spawnSync } = require("child_process");

const suites = [
  "registry-phase1.cjs",
  "registry-phase2.cjs",
  "registry-phase3.cjs",
  "registry-phase4.cjs",
  "registry-phase5.cjs",
  "artifact-gate.cjs",
  "charset.cjs",
  "home-adoption.cjs",
];
let failed = 0;
for (const s of suites) {
  console.log(`\n### ${s}`);
  const r = spawnSync("node", [path.join(__dirname, s)], { stdio: "inherit" });
  if (r.status !== 0) failed++;
}
console.log(`\n=== ${suites.length - failed}/${suites.length} suites passed ===`);
process.exit(failed ? 1 : 0);
