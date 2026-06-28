#!/usr/bin/env node
// Phase 3 hook-layer verification — SANDBOXED. companion-index.cjs must, on a successful
// stamp, append an `artifact.routed` event carrying path + session_id + the registry unit.

const fs = require("fs");
const os = require("os");
const path = require("path");
const { execFileSync } = require("child_process");

// Repo-relative: the hooks dir is the parent of this __tests__ dir.
const HOOKS = path.join(__dirname, "..");
let pass = 0, fail = 0;
function ok(c, m) { if (c) { pass++; console.log("  ✓ " + m); } else { fail++; console.log("  ✗ FAIL: " + m); } }

const home = fs.mkdtempSync(path.join(os.tmpdir(), "cmp-p3-"));
fs.mkdirSync(path.join(home, ".claude", "companion", "logs"), { recursive: true });
const repo = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "cmp-p3-repo-")));
execFileSync("git", ["init", "-q"], { cwd: repo });
const SID = "feed1234-aaaa-bbbb-cccc-eventroute0001";

// Register the session (writes the record + a session.registered event).
execFileSync("sh", [path.join(HOOKS, "companion-session")], {
  input: JSON.stringify({ cwd: repo, session_id: SID }),
  env: { ...process.env, HOME: home, COMPANION_TRACE: "1" },
  encoding: "utf8",
});
const rec = JSON.parse(fs.readFileSync(path.join(home, ".claude/companion/sessions", SID + ".json"), "utf8"));

// Stamp the index for an artifact this session wrote.
const liveDir = path.join(home, ".claude/companion/live");
const indexPath = path.join(home, ".claude/companion/artifact-index.json");
const artifact = path.join(home, ".claude/companion/artifacts", "p3.html");
fs.mkdirSync(path.dirname(artifact), { recursive: true });
fs.writeFileSync(artifact, "<html></html>");
execFileSync("node", [path.join(HOOKS, "companion-index.cjs"), artifact, liveDir, indexPath], {
  env: { ...process.env, HOME: home, SID, COMPANION_TRACE: "1" },
  encoding: "utf8",
});

function events(home) {
  const p = path.join(home, ".claude/companion/events.ndjson");
  return fs.existsSync(p) ? fs.readFileSync(p, "utf8").trim().split("\n").filter(Boolean).map((l) => JSON.parse(l)) : [];
}
const evs = events(home);
const routed = evs.filter((e) => e.evt === "artifact.routed");
ok(routed.length === 1, "exactly one artifact.routed event appended");
ok(routed[0] && routed[0].path === artifact, "event carries the artifact's abs path");
ok(routed[0] && routed[0].session_id === SID, "event carries the full session_id");
ok(routed[0] && routed[0].unit_key === rec.unit_key, "event unit_key === the registry record's unit_key");
ok(evs.some((e) => e.evt === "session.registered" && e.session_id === SID), "session.registered still present (Phase 1)");

// A no-SID (pre-registry) write stamps nothing → appends NO artifact.routed.
const art2 = path.join(home, ".claude/companion/artifacts", "legacy.html");
fs.writeFileSync(art2, "<html></html>");
execFileSync("node", [path.join(HOOKS, "companion-index.cjs"), art2, liveDir, indexPath], {
  env: { ...process.env, HOME: home, SID: "", COMPANION_TRACE: "1" },
  encoding: "utf8",
});
ok(events(home).filter((e) => e.evt === "artifact.routed").length === 1, "no-SID write appends no artifact.routed");

console.log(`\n=== ${pass} passed, ${fail} failed ===`);
process.exit(fail ? 1 : 0);
