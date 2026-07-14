#!/usr/bin/env node
// Phase 1 verification — SANDBOXED. Every probe runs under a throwaway HOME so it
// never touches the live session's ~/.claude/companion state or trace.ndjson.
// Exercises the REAL companion-session hook end-to-end (it calls companion-livepath.sh
// + companion-identity.cjs) for the deterministic slice of the §8 matrix.

const fs = require("fs");
const os = require("os");
const path = require("path");
const { execFileSync } = require("child_process");

// Repo-relative so the suite runs from any checkout (this worktree OR the main checkout
// after merge) — the hooks dir is the parent of this __tests__ dir.
const HOOKS = path.join(__dirname, "..");
const SESSION_HOOK = path.join(HOOKS, "companion-session");

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

// Fresh sandbox HOME per run; returns the home path.
function mkSandbox(tag) {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), `cmp-id-${tag}-`));
  fs.mkdirSync(path.join(home, ".claude", "companion", "logs"), { recursive: true });
  // Opt the sandbox machine into external terminals: most cases here simulate
  // sessions the Board did NOT spawn, and without this flag companion-session
  // exits at the external-terminal gate before registering anything (031e588).
  fs.writeFileSync(path.join(home, ".claude", "companion", "external-terminals"), "on");
  return home;
}

// Run companion-session with a given cwd/session_id/owned_tab under sandbox HOME.
function runSession({ home, cwd, session_id, owned_tab }) {
  const env = { ...process.env, HOME: home, COMPANION_TRACE: "1" };
  if (owned_tab) env.COMPANION_SESSION = owned_tab;
  else delete env.COMPANION_SESSION;
  const payload = JSON.stringify({ cwd, session_id });
  const out = execFileSync("sh", [SESSION_HOOK], { input: payload, env, encoding: "utf8" });
  return out;
}

function recordOf(home, session_id) {
  const p = path.join(home, ".claude", "companion", "sessions", session_id + ".json");
  return fs.existsSync(p) ? JSON.parse(fs.readFileSync(p, "utf8")) : null;
}
function events(home) {
  const p = path.join(home, ".claude", "companion", "events.ndjson");
  if (!fs.existsSync(p)) return [];
  return fs
    .readFileSync(p, "utf8")
    .trim()
    .split("\n")
    .filter(Boolean)
    .map((l) => JSON.parse(l));
}
function liveStems(home) {
  const d = path.join(home, ".claude", "companion", "live");
  return fs.existsSync(d) ? fs.readdirSync(d).filter((f) => f.endsWith(".json")) : [];
}
function sessionDirs(home) {
  const p = path.join(home, ".claude", "companion", "session-dirs.json");
  return fs.existsSync(p) ? JSON.parse(fs.readFileSync(p, "utf8")) : {};
}
function ownedSessions(home) {
  const p = path.join(home, ".claude", "companion", "owned-sessions.json");
  return fs.existsSync(p) ? JSON.parse(fs.readFileSync(p, "utf8")) : {};
}

// ---- Case 1: repo session ----
console.log("\nCase 1 — repo session:");
{
  const home = mkSandbox("repo");
  const repo = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "cmp-repo-")));
  execFileSync("git", ["init", "-q"], { cwd: repo });
  const sid = "11111111-aaaa-bbbb-cccc-000000000001";
  runSession({ home, cwd: repo, session_id: sid });
  const rec = recordOf(home, sid);
  ok(rec !== null, "record sessions/<id>.json written");
  ok(rec && rec.is_repo === true, "is_repo === true");
  ok(rec && rec.session_id === sid, "record keyed by FULL session_id");
  ok(rec && rec.unit_key === path.basename(repo).replace(/[^A-Za-z0-9._-]/g, "-"), "unit_key === repo slug");
  ok(rec && rec.slug === rec.unit_key, "slug === unit_key (repo session: stem slug and unit coincide)");
  ok(rec && rec.project_root === repo, "project_root === gitroot (canonicalized)");
  ok(rec && rec.owned_tab === null, "owned_tab null (not Board-launched)");
  ok(rec && typeof rec.created_ms === "number" && rec.created_ms > 0, "created_ms stamped");
  const evs = events(home).filter((e) => e.evt === "session.registered" && e.session_id === sid);
  ok(evs.length === 1, "exactly one session.registered event");
  ok(evs[0] && evs[0].unit_key === rec.unit_key, "event unit_key matches record");
  // Old sidecars still written (dual-write parity):
  ok(liveStems(home).some((s) => s.endsWith(`--${sid.slice(0, 8)}.json`)), "old live stub still written");
  // PARITY: the record's project_root must equal what the old session-dirs sidecar
  // recorded for the SAME session (both come from git's canonical root — one derivation).
  const dirs = sessionDirs(home);
  ok(Object.values(dirs).includes(repo), "old session-dirs sidecar still written");
  ok(Object.values(dirs)[0] === rec.project_root, "record project_root === session-dirs sidecar (parity)");
}

// ---- Case 2: non-repo session (launched from a plain dir) ----
console.log("\nCase 2 — non-repo session:");
{
  const home = mkSandbox("norepo");
  const plain = fs.mkdtempSync(path.join(os.tmpdir(), "cmp-plain-"));
  const sid = "22222222-aaaa-bbbb-cccc-000000000002";
  runSession({ home, cwd: plain, session_id: sid });
  const rec = recordOf(home, sid);
  ok(rec !== null, "record written");
  ok(rec && rec.is_repo === false, "is_repo === false");
  ok(rec && rec.project_root === plain, "project_root === cwd (no gitroot)");
  ok(rec && rec.unit_key === path.basename(plain).replace(/[^A-Za-z0-9._-]/g, "-"), "unit_key === cwd slug");
}

// ---- Case 2b: $HOME session → slug (stem name) and unit_key ('__home__') SPLIT ----
// The 2026-07-14 blank-hero bug: slug was recorded = unit_key, so home artifacts were
// stamped source '__home__--<id>' while the live stem is '<cwd-basename>--<id>' — no
// live session ever matched its own artifact. The record must carry BOTH names.
console.log("\nCase 2b — $HOME session: slug is the live stem's name, not the unit key:");
{
  const home = mkSandbox("home");
  const sid = "2b2b2b2b-aaaa-bbbb-cccc-00000000002b";
  runSession({ home, cwd: home, session_id: sid });
  const rec = recordOf(home, sid);
  const stemSlug = path.basename(home).replace(/[^A-Za-z0-9._-]/g, "-");
  ok(rec !== null, "record written");
  ok(rec && rec.unit_key === "__home__", "unit_key === '__home__' (the Home shelf)");
  ok(rec && rec.slug === stemSlug, "slug === cwd basename (the live stem's name)");
  ok(rec && rec.slug !== rec.unit_key, "slug ≠ unit_key (the split this case exists to pin)");
  const stem = liveStems(home).find((s) => s.endsWith(`--${sid.slice(0, 8)}.json`)) || "";
  ok(stem === `${rec.slug}--${sid.slice(0, 8)}.json`, "record slug + shortid rebuilds the live stem exactly");
}

// ---- Case 3: resumed session (same session_id) → idempotent, same record ----
console.log("\nCase 3 — resumed (same session_id):");
{
  const home = mkSandbox("resume");
  const repo = fs.mkdtempSync(path.join(os.tmpdir(), "cmp-resume-"));
  execFileSync("git", ["init", "-q"], { cwd: repo });
  const sid = "33333333-aaaa-bbbb-cccc-000000000003";
  runSession({ home, cwd: repo, session_id: sid });
  const rec1 = recordOf(home, sid);
  // Resume: same id, even if cwd moved (simulate a cd into a subdir).
  const sub = path.join(repo, "subdir");
  fs.mkdirSync(sub);
  runSession({ home, cwd: sub, session_id: sid });
  const rec2 = recordOf(home, sid);
  ok(rec1 && rec2, "record present before and after resume");
  ok(rec1 && rec2 && rec1.created_ms === rec2.created_ms, "created_ms UNCHANGED (idempotent, frozen)");
  ok(rec1 && rec2 && rec1.unit_key === rec2.unit_key, "unit_key UNCHANGED (no cwd-fork)");
  ok(rec1 && rec2 && JSON.stringify(rec1) === JSON.stringify(rec2), "record byte-identical after resume");
  const evs = events(home).filter((e) => e.evt === "session.registered" && e.session_id === sid);
  ok(evs.length === 1, "resume appended NO second session.registered (no-op)");
}

// ---- Case 4: two sessions in one repo → distinct records, same unit, no fork ----
console.log("\nCase 4 — two sessions in one repo:");
{
  const home = mkSandbox("two");
  const repo = fs.mkdtempSync(path.join(os.tmpdir(), "cmp-two-"));
  execFileSync("git", ["init", "-q"], { cwd: repo });
  const sidA = "44444444-aaaa-bbbb-cccc-00000000000a";
  const sidB = "44444444-aaaa-bbbb-cccc-00000000000b";
  runSession({ home, cwd: repo, session_id: sidA });
  runSession({ home, cwd: repo, session_id: sidB });
  const a = recordOf(home, sidA),
    b = recordOf(home, sidB);
  ok(a && b, "two distinct records exist");
  ok(a && b && a.session_id !== b.session_id, "distinct session_ids");
  ok(a && b && a.unit_key === b.unit_key, "SAME unit_key (one repo = one unit, no fork)");
  const dir = path.join(home, ".claude", "companion", "sessions");
  ok(fs.readdirSync(dir).filter((f) => f.endsWith(".json")).length === 2, "exactly two record files");
}

// ---- Case 5: Board-launched session (COMPANION_SESSION set) → owned_tab in record ----
console.log("\nCase 5 — Board-launched (owned tab):");
{
  const home = mkSandbox("owned");
  const repo = fs.mkdtempSync(path.join(os.tmpdir(), "cmp-owned-"));
  execFileSync("git", ["init", "-q"], { cwd: repo });
  const sid = "55555555-aaaa-bbbb-cccc-000000000005";
  runSession({ home, cwd: repo, session_id: sid, owned_tab: "board-7" });
  const rec = recordOf(home, sid);
  ok(rec && rec.owned_tab === "board-7", "owned_tab === 'board-7'");
  ok(Object.values(ownedSessions(home)).includes("board-7"), "old owned-sessions sidecar still written");
}

// ---- Case 6: empty session_id → no record (can't key the registry) ----
console.log("\nCase 6 — missing session_id → graceful skip:");
{
  const home = mkSandbox("nosid");
  const plain = fs.mkdtempSync(path.join(os.tmpdir(), "cmp-nosid-"));
  runSession({ home, cwd: plain, session_id: "" });
  const dir = path.join(home, ".claude", "companion", "sessions");
  const n = fs.existsSync(dir) ? fs.readdirSync(dir).filter((f) => f.endsWith(".json")).length : 0;
  ok(n === 0, "no record written when session_id is empty");
  ok(liveStems(home).length === 1, "old live stub still written (old path unaffected)");
}

// ---- Case 7: external terminal, opt-in flag OFF → gate exits, nothing written ----
console.log("\nCase 7 — external terminal with flag off → silent:");
{
  const home = mkSandbox("gated");
  fs.rmSync(path.join(home, ".claude", "companion", "external-terminals"));
  const repo = fs.mkdtempSync(path.join(os.tmpdir(), "cmp-gated-"));
  execFileSync("git", ["init", "-q"], { cwd: repo });
  const sid = "77777777-aaaa-bbbb-cccc-000000000007";
  runSession({ home, cwd: repo, session_id: sid });
  ok(recordOf(home, sid) === null, "no record (gate exits before register)");
  ok(liveStems(home).length === 0, "no live stub either (fully silent)");
  // A Board-owned session passes the gate regardless of the flag:
  runSession({ home, cwd: repo, session_id: sid, owned_tab: "board-9" });
  ok(recordOf(home, sid) !== null, "Board-owned session registers with flag off");
}

console.log(`\n=== ${pass} passed, ${fail} failed ===`);
process.exit(fail ? 1 : 0);
