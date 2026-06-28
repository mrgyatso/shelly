#!/usr/bin/env node
// Phase 2 hook-layer verification — SANDBOXED. Confirms the artifact→record link:
//   1. companion-session registers sessions/<id>.json (Phase 1).
//   2. companion-index.cjs now stamps session_id into the index entry.
//   3. index.session_id → sessions/<id>.json → unit_key round-trips (what the Rust
//      reader history.rs/registry.rs does; its own unit tests cover the Rust read).

const fs = require("fs");
const os = require("os");
const path = require("path");
const { execFileSync } = require("child_process");

// Repo-relative: the hooks dir is the parent of this __tests__ dir.
const HOOKS = path.join(__dirname, "..");

let pass = 0, fail = 0;
function ok(c, m) { if (c) { pass++; console.log("  ✓ " + m); } else { fail++; console.log("  ✗ FAIL: " + m); } }

const home = fs.mkdtempSync(path.join(os.tmpdir(), "cmp-p2-"));
fs.mkdirSync(path.join(home, ".claude", "companion", "logs"), { recursive: true });
const repo = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "cmp-p2-repo-")));
execFileSync("git", ["init", "-q"], { cwd: repo });
const SID = "deadbeef-2222-3333-4444-555566667777";

// 1. Register via the real SessionStart hook.
execFileSync("sh", [path.join(HOOKS, "companion-session")], {
  input: JSON.stringify({ cwd: repo, session_id: SID }),
  env: { ...process.env, HOME: home, COMPANION_TRACE: "1" },
  encoding: "utf8",
});
const recPath = path.join(home, ".claude", "companion", "sessions", SID + ".json");
ok(fs.existsSync(recPath), "record written by companion-session");
const rec = JSON.parse(fs.readFileSync(recPath, "utf8"));

// 2. Stamp the index for an artifact written by that session.
const liveDir = path.join(home, ".claude", "companion", "live");
const indexPath = path.join(home, ".claude", "companion", "artifact-index.json");
const artifact = path.join(home, ".claude", "companion", "artifacts", "demo.html");
fs.mkdirSync(path.dirname(artifact), { recursive: true });
fs.writeFileSync(artifact, "<html></html>");
execFileSync("node", [path.join(HOOKS, "companion-index.cjs"), artifact, liveDir, indexPath], {
  env: { ...process.env, HOME: home, SID, COMPANION_TRACE: "1" },
  encoding: "utf8",
});
ok(fs.existsSync(indexPath), "index stamped");
const index = JSON.parse(fs.readFileSync(indexPath, "utf8"));
const entry = index[artifact];
ok(!!entry, "index has an entry for the artifact (keyed by abs path)");
ok(entry && entry.session_id === SID, "index entry carries the FULL session_id");
ok(entry && entry.unit_key === rec.unit_key, "index entry unit_key matches the record (parity)");

// 3. Round-trip: index.session_id → record → unit_key (what the Rust reader does).
function resolveUnit(home, sid) {
  const p = path.join(home, ".claude", "companion", "sessions", sid + ".json");
  try { return (JSON.parse(fs.readFileSync(p, "utf8")) || {}).unit_key || null; } catch (_) { return null; }
}
const resolved = resolveUnit(home, entry.session_id);
ok(resolved === rec.unit_key, "index.session_id resolves to the record's unit_key");
ok(resolved === path.basename(repo).replace(/[^A-Za-z0-9._-]/g, "-"), "resolved unit === repo slug");

// 4. Pre-registry artifact (no SID) → no session_id in entry → reader falls back.
const art2 = path.join(home, ".claude", "companion", "artifacts", "legacy.html");
fs.writeFileSync(art2, "<html></html>");
// Seed a live file so the shortid glob has a unit_key to stamp (legacy path).
execFileSync("node", [path.join(HOOKS, "companion-index.cjs"), art2, liveDir, indexPath], {
  env: { ...process.env, HOME: home, SID: "", COMPANION_TRACE: "1" },
  encoding: "utf8",
});
const idx2 = JSON.parse(fs.readFileSync(indexPath, "utf8"));
ok(!idx2[art2], "no-SID artifact is left un-indexed (legacy slug-fallback covers it) — no phantom session_id");

console.log(`\n=== ${pass} passed, ${fail} failed ===`);
process.exit(fail ? 1 : 0);
