#!/usr/bin/env node
// Phase 5 verification — SANDBOXED. The observer worker attributes its generated
// artifacts to the OBSERVED session through the shared identity lib (routeArtifact),
// and the observer's own model calls never register a spurious session.

const fs = require("fs");
const os = require("os");
const path = require("path");
const { execFileSync } = require("child_process");

const HOOKS = path.join(__dirname, "..");
const SESSION_HOOK = path.join(HOOKS, "companion-session");
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

// ---- Case 4: the worker's stamp goes through the shared lib (no forked writer) ----
console.log("\nCase 4 — worker.cjs has no forked index writer:");
{
  const workerSrc = fs.readFileSync(path.join(HOOKS, "..", "scripts", "artifact-observer", "worker.cjs"), "utf8");
  ok(/identity\.routeArtifact\(/.test(workerSrc), "worker calls identity.routeArtifact");
  ok(!/atomicJson\(indexPath/.test(workerSrc), "worker no longer writes artifact-index.json itself");
  ok(/require\(path\.join\(__dirname, "\.\.", "\.\.", "hooks", "companion-identity\.cjs"\)\)/.test(workerSrc), "worker requires the ONE canonical lib by path");
}

// ---- Case 5: observer self-marker → companion-session registers nothing ----
console.log("\nCase 5 — observer's own model call never self-registers:");
{
  const home = mkSandbox("self");
  const repo = fs.mkdtempSync(path.join(os.tmpdir(), "cmp-p5-repo-"));
  execFileSync("git", ["init", "-q"], { cwd: repo });
  const sid = "aaaa5555-bbbb-cccc-dddd-000000000005";
  const env = { ...process.env, HOME: home, COMPANION_OBSERVER_SELF: "1" };
  delete env.COMPANION_SESSION;
  execFileSync("sh", [SESSION_HOOK], { input: JSON.stringify({ cwd: repo, session_id: sid }), env, encoding: "utf8" });
  const recPath = path.join(home, ".claude", "companion", "sessions", sid + ".json");
  ok(!fs.existsSync(recPath), "no registry record for the observer's own session");
  const liveDir = path.join(home, ".claude", "companion", "live");
  const stems = fs.existsSync(liveDir) ? fs.readdirSync(liveDir) : [];
  ok(stems.length === 0, "no live stub either (fully silent)");
  // model.cjs actually sets the marker:
  const modelSrc = fs.readFileSync(path.join(HOOKS, "..", "scripts", "artifact-observer", "model.cjs"), "utf8");
  ok(/COMPANION_OBSERVER_SELF = "1"/.test(modelSrc), "cleanClaudeEnv stamps COMPANION_OBSERVER_SELF");
}

console.log(`\n=== ${pass} passed, ${fail} failed ===`);
process.exit(fail ? 1 : 0);
