#!/usr/bin/env node
// routeArtifact verification — SANDBOXED. The shared identity lib attributes a generated
// artifact to its session through routeArtifact: the frozen registry record wins over a
// stale enqueue-time unit_key, an unregistered session falls back, and no identity yields
// no stamp. (Formerly "Phase 5 observer integration"; the observer is gone, but routeArtifact
// remains the ONE canonical stamp — companion-index.cjs uses it on every inline write.)

const fs = require("fs");
const os = require("os");
const path = require("path");

const HOOKS = path.join(__dirname, "..");
const identity = require(path.join(HOOKS, "companion-identity.cjs"));

let pass = 0,
  fail = 0;
function ok(cond, msg) {
  if (cond) {
    pass++;
    console.log("  ✓ " + msg);
  } else {
    fail++;
    console.log("  ✗ FAIL: " + msg);
  }
}

function mkSandbox(tag) {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), `cmp-p5-${tag}-`));
  fs.mkdirSync(path.join(home, ".claude", "companion", "logs"), { recursive: true });
  fs.writeFileSync(path.join(home, ".claude", "companion", "external-terminals"), "on");
  return home;
}
function events(home) {
  const p = path.join(home, ".claude", "companion", "events.ndjson");
  if (!fs.existsSync(p)) return [];
  return fs.readFileSync(p, "utf8").trim().split("\n").filter(Boolean).map((l) => JSON.parse(l));
}
function indexOf(home) {
  const p = path.join(home, ".claude", "companion", "artifact-index.json");
  return fs.existsSync(p) ? JSON.parse(fs.readFileSync(p, "utf8")) : {};
}

// ---- Case 1: routeArtifact — registry record wins over the caller's stale unit_key ----
console.log("\nCase 1 — routeArtifact prefers the frozen record:");
{
  const home = mkSandbox("route");
  const opts = { home };
  const sid = "aaaa1111-bbbb-cccc-dddd-000000000001";
  identity.register({ session_id: sid, unit_key: "real-unit", project_root: "/tmp/x", is_repo: true, project: "real-unit" }, opts);
  const art = path.join(home, "gen.html");
  fs.writeFileSync(art, "<html></html>");
  const entry = identity.routeArtifact(
    { artifactPath: art, session_id: sid, unit_key: "stale-enqueue-unit", shortid: sid.slice(0, 8), source: `real-unit--${sid.slice(0, 8)}` },
    opts,
  );
  ok(entry !== null, "routeArtifact stamped an entry");
  ok(entry && entry.unit_key === "real-unit", "registry unit_key WINS over the enqueue-time fallback");
  ok(entry && entry.session_id === sid, "entry carries the full observed session_id");
  const idx = indexOf(home);
  ok(idx[path.resolve(art)] && idx[path.resolve(art)].unit_key === "real-unit", "index entry persisted with registry unit");
  const routed = events(home).filter((e) => e.evt === "artifact.routed" && e.path === path.resolve(art));
  ok(routed.length === 1, "exactly one artifact.routed event appended");
  ok(routed[0] && routed[0].unit_key === "real-unit" && routed[0].session_id === sid, "event carries registry unit + session_id");
}

// ---- Case 2: routeArtifact — no record → enqueue-time fallback (pre-registry session) ----
console.log("\nCase 2 — no record falls back to the caller's unit_key:");
{
  const home = mkSandbox("fallback");
  const opts = { home };
  const art = path.join(home, "gen2.html");
  fs.writeFileSync(art, "<html></html>");
  const sid = "aaaa2222-bbbb-cccc-dddd-000000000002"; // never registered
  const entry = identity.routeArtifact({ artifactPath: art, session_id: sid, unit_key: "enqueue-unit", shortid: sid.slice(0, 8) }, opts);
  ok(entry && entry.unit_key === "enqueue-unit", "falls back to enqueue-time unit_key");
  ok(entry && entry.session_id === sid, "still carries session_id (record may land later)");
}

// ---- Case 3: routeArtifact — no identity at all → null, nothing written ----
console.log("\nCase 3 — no identity → null, no stamp, no event:");
{
  const home = mkSandbox("noid");
  const opts = { home };
  const art = path.join(home, "gen3.html");
  fs.writeFileSync(art, "<html></html>");
  const entry = identity.routeArtifact({ artifactPath: art }, opts);
  ok(entry === null, "returns null with neither session_id nor unit_key");
  ok(Object.keys(indexOf(home)).length === 0, "index untouched");
  ok(events(home).length === 0, "no event appended");
}

console.log(`\n=== ${pass} passed, ${fail} failed ===`);
process.exit(fail ? 1 : 0);
