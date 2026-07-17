#!/usr/bin/env node
// Phase 2 hook-layer verification — SANDBOXED. Confirms the artifact→record link:
//   1. shelly-session registers sessions/<id>.json (Phase 1).
//   2. shelly-index.cjs now stamps session_id into the index entry.
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
fs.mkdirSync(path.join(home, ".shelly", "logs"), { recursive: true });
// Hermetic: track external terminals in the sandbox, and don't inherit the developer
// shell's SHELLY_SESSION — without these the hook bails as an untracked terminal
// on CI (no Shelly app) while silently passing on a dev machine.
fs.writeFileSync(path.join(home, ".shelly", "external-terminals"), "on");
const baseEnv = { ...process.env, HOME: home, SHELLY_TRACE: "1" };
delete baseEnv.SHELLY_SESSION;
const repo = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "cmp-p2-repo-")));
execFileSync("git", ["init", "-q"], { cwd: repo });
const SID = "deadbeef-2222-3333-4444-555566667777";

// 1. Register via the real SessionStart hook.
execFileSync("sh", [path.join(HOOKS, "shelly-session")], {
  input: JSON.stringify({ cwd: repo, session_id: SID }),
  env: baseEnv,
  encoding: "utf8",
});
const recPath = path.join(home, ".shelly", "sessions", SID + ".json");
ok(fs.existsSync(recPath), "record written by shelly-session");
const rec = JSON.parse(fs.readFileSync(recPath, "utf8"));

// 2. Stamp the index for an artifact written by that session.
const liveDir = path.join(home, ".shelly", "live");
const indexPath = path.join(home, ".shelly", "artifact-index.json");
const artifact = path.join(home, ".shelly", "artifacts", "demo.html");
fs.mkdirSync(path.dirname(artifact), { recursive: true });
fs.writeFileSync(artifact, "<html></html>");
const PROMPT_ID = "aaaa1111-bbbb-2222-cccc-333344445555";
execFileSync("node", [path.join(HOOKS, "shelly-index.cjs"), artifact, liveDir, indexPath], {
  env: { ...baseEnv, SID, PROMPT_ID },
  encoding: "utf8",
});
ok(fs.existsSync(indexPath), "index stamped");
const index = JSON.parse(fs.readFileSync(indexPath, "utf8"));
const entry = index[artifact];
ok(!!entry, "index has an entry for the artifact (keyed by abs path)");
ok(entry && entry.session_id === SID, "index entry carries the FULL session_id");
ok(entry && entry.unit_key === rec.unit_key, "index entry unit_key matches the record (parity)");
// The turn stamp the PreToolUse fork hook reads back to tell "still authoring" from
// "sealed in an earlier turn". Absent PROMPT_ID (older client) it must be null, not
// undefined/missing — the fork hook treats a falsy value as "fall back to mtime".
ok(entry && entry.prompt_id === PROMPT_ID, "index entry carries the writing turn's prompt_id");
const artNoPrompt = path.join(path.dirname(artifact), "no-prompt.html");
fs.writeFileSync(artNoPrompt, "<html></html>");
execFileSync("node", [path.join(HOOKS, "shelly-index.cjs"), artNoPrompt, liveDir, indexPath], {
  env: { ...baseEnv, SID },
  encoding: "utf8",
});
const noPromptEntry = JSON.parse(fs.readFileSync(indexPath, "utf8"))[artNoPrompt];
ok(noPromptEntry && noPromptEntry.prompt_id === null, "no PROMPT_ID in env → entry carries prompt_id:null");

// 3. Round-trip: index.session_id → record → unit_key (what the Rust reader does).
function resolveUnit(home, sid) {
  const p = path.join(home, ".shelly", "sessions", sid + ".json");
  try { return (JSON.parse(fs.readFileSync(p, "utf8")) || {}).unit_key || null; } catch (_) { return null; }
}
const resolved = resolveUnit(home, entry.session_id);
ok(resolved === rec.unit_key, "index.session_id resolves to the record's unit_key");
ok(resolved === path.basename(repo).replace(/[^A-Za-z0-9._-]/g, "-"), "resolved unit === repo slug");

// 4. Pre-registry artifact (no SID) → no session_id in entry → reader falls back.
const art2 = path.join(home, ".shelly", "artifacts", "legacy.html");
fs.writeFileSync(art2, "<html></html>");
// Seed a live file so the shortid glob has a unit_key to stamp (legacy path).
execFileSync("node", [path.join(HOOKS, "shelly-index.cjs"), art2, liveDir, indexPath], {
  env: { ...baseEnv, SID: "" },
  encoding: "utf8",
});
const idx2 = JSON.parse(fs.readFileSync(indexPath, "utf8"));
ok(!idx2[art2], "no-SID artifact is left un-indexed (legacy slug-fallback covers it) — no phantom session_id");

// 5. $HOME session → the stamped `source` must be the LIVE STEM, not the unit key.
// The 2026-07-14 blank-hero bug: slug was recorded = unit_key ('__home__'), so home
// artifacts stamped source '__home__--<id>' — matching no live session, so the Board
// disowned the session's own artifact. source must rebuild <cwd-basename>--<shortid>.
// NOTE: shortid = first 8 chars — must differ from SID's, or livepath's reuse branch
// matches the repo session's live file and freezes this session onto ITS identity.
const HSID = "cafe0042-8888-9999-aaaa-bbbbccccdddd";
execFileSync("sh", [path.join(HOOKS, "shelly-session")], {
  input: JSON.stringify({ cwd: home, session_id: HSID }),
  env: baseEnv,
  encoding: "utf8",
});
const art3 = path.join(home, ".shelly", "artifacts", "home-brief.html");
fs.writeFileSync(art3, "<html></html>");
execFileSync("node", [path.join(HOOKS, "shelly-index.cjs"), art3, liveDir, indexPath], {
  env: { ...baseEnv, SID: HSID },
  encoding: "utf8",
});
const idx3 = JSON.parse(fs.readFileSync(indexPath, "utf8"));
const hentry = idx3[art3];
const homeStem = `${path.basename(home).replace(/[^A-Za-z0-9._-]/g, "-")}--${HSID.slice(0, 8)}`;
ok(!!hentry, "home artifact indexed");
ok(hentry && hentry.unit_key === "__home__", "home artifact routes to the Home shelf (unit_key)");
ok(hentry && hentry.source === homeStem, "home artifact source === live stem (NOT '__home__--<id>')");

console.log(`\n=== ${pass} passed, ${fail} failed ===`);
process.exit(fail ? 1 : 0);
