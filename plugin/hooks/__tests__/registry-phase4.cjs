#!/usr/bin/env node
// Phase 4 verification — SANDBOXED. companion-index.cjs resolves identity from the
// frozen registry record (no shortid live-file glob), LATE-REGISTERS sessions it has
// never seen (same single derivation as SessionStart), and leaves artifacts with no
// resolvable identity un-indexed (the Board fails those loud — never a silent guess).

const fs = require("fs");
const os = require("os");
const path = require("path");
const { execFileSync } = require("child_process");

const HOOKS = path.join(__dirname, "..");
const INDEX_HOOK = path.join(HOOKS, "companion-index.cjs");
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
  const home = fs.mkdtempSync(path.join(os.tmpdir(), `cmp-p4-${tag}-`));
  fs.mkdirSync(path.join(home, ".claude", "companion", "logs"), { recursive: true });
  fs.mkdirSync(path.join(home, ".claude", "companion", "live"), { recursive: true });
  fs.writeFileSync(path.join(home, ".claude", "companion", "external-terminals"), "on");
  return home;
}
function runIndex({ home, artifact, sid, cwd }) {
  const env = { ...process.env, HOME: home, SID: sid || "", CWD: cwd || "" };
  delete env.COMPANION_SESSION;
  const liveDir = path.join(home, ".claude", "companion", "live");
  const indexPath = path.join(home, ".claude", "companion", "artifact-index.json");
  execFileSync("node", [INDEX_HOOK, artifact, liveDir, indexPath], { env, encoding: "utf8" });
  try {
    return JSON.parse(fs.readFileSync(indexPath, "utf8"));
  } catch (_) {
    return {};
  }
}
function events(home) {
  const p = path.join(home, ".claude", "companion", "events.ndjson");
  if (!fs.existsSync(p)) return [];
  return fs.readFileSync(p, "utf8").trim().split("\n").filter(Boolean).map((l) => JSON.parse(l));
}

// ---- Case 1: registered session → stamp from the record, no live dir needed ----
console.log("\nCase 1 — registered session stamps from its record:");
{
  const home = mkSandbox("rec");
  const sid = "44440000-aaaa-bbbb-cccc-000000000001";
  identity.register(
    { session_id: sid, unit_key: "proj-a", project_root: "/tmp/proj-a", is_repo: true, project: "proj-a" },
    { home },
  );
  const art = path.join(home, "one.html");
  fs.writeFileSync(art, "<html></html>");
  const idx = runIndex({ home, artifact: art, sid });
  const e = idx[path.resolve(art)];
  ok(!!e, "index entry stamped");
  ok(e && e.unit_key === "proj-a", "unit_key from the record");
  ok(e && e.session_id === sid, "session_id stamped");
  ok(e && e.source === `proj-a--${sid.slice(0, 8)}`, "source stem reconstructed from record slug (no live-dir read)");
}

// ---- Case 2: THE FORK HAZARD, gone. Two live files share a shortid ----
console.log("\nCase 2 — shortid collision cannot mis-route (glob removed):");
{
  const home = mkSandbox("fork");
  const sid = "44440000-aaaa-bbbb-cccc-000000000002";
  const short = sid.slice(0, 8);
  // Two live files with the SAME shortid, DIFFERENT units — the old glob picked
  // whichever readdir returned first; the record makes routing deterministic.
  const liveDir = path.join(home, ".claude", "companion", "live");
  fs.writeFileSync(path.join(liveDir, `aaa-wrong--${short}.json`), JSON.stringify({ unit_key: "wrong-unit" }));
  fs.writeFileSync(path.join(liveDir, `zzz-right--${short}.json`), JSON.stringify({ unit_key: "right-unit" }));
  identity.register(
    { session_id: sid, unit_key: "right-unit", project_root: "/tmp/right", is_repo: true, project: "right-unit" },
    { home },
  );
  const art = path.join(home, "two.html");
  fs.writeFileSync(art, "<html></html>");
  const e = runIndex({ home, artifact: art, sid })[path.resolve(art)];
  ok(e && e.unit_key === "right-unit", "record decides the unit — collision is irrelevant");
}

// ---- Case 3: unregistered session with a live file → LATE-REGISTERS (frozen reuse) ----
console.log("\nCase 3 — late registration reuses the frozen live identity:");
{
  const home = mkSandbox("late");
  const sid = "44440000-aaaa-bbbb-cccc-000000000003";
  const short = sid.slice(0, 8);
  // A live file from a pre-registry session (frozen identity, no record).
  const liveDir = path.join(home, ".claude", "companion", "live");
  fs.writeFileSync(
    path.join(liveDir, `old-proj--${short}.json`),
    JSON.stringify({ project: "old-proj", is_repo: true, unit_key: "old-proj" }),
  );
  const art = path.join(home, "three.html");
  fs.writeFileSync(art, "<html></html>");
  // cwd deliberately elsewhere — the live file's frozen identity must win over cwd.
  const elsewhere = fs.mkdtempSync(path.join(os.tmpdir(), "cmp-p4-elsewhere-"));
  const e = runIndex({ home, artifact: art, sid, cwd: elsewhere })[path.resolve(art)];
  ok(e && e.unit_key === "old-proj", "stamped with the live file's frozen unit, not cwd");
  const rec = identity.readRecord(sid, { home });
  ok(rec !== null, "session late-registered (record now exists)");
  ok(rec && rec.unit_key === "old-proj", "record carries the frozen identity");
  const regs = events(home).filter((v) => v.evt === "session.registered" && v.session_id === sid);
  ok(regs.length === 1, "one session.registered event appended");
  // Idempotent thereafter: a second artifact re-uses the record.
  const art2 = path.join(home, "three-b.html");
  fs.writeFileSync(art2, "<html></html>");
  runIndex({ home, artifact: art2, sid, cwd: elsewhere });
  ok(
    events(home).filter((v) => v.evt === "session.registered" && v.session_id === sid).length === 1,
    "second artifact does NOT re-register",
  );
}

// ---- Case 4: unregistered, no live file → late-register derives from cwd ----
console.log("\nCase 4 — fully unseen session registers from cwd (best available, once):");
{
  const home = mkSandbox("cwd");
  const sid = "44440000-aaaa-bbbb-cccc-000000000004";
  const repo = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "cmp-p4-repo-")));
  execFileSync("git", ["init", "-q"], { cwd: repo });
  const art = path.join(home, "four.html");
  fs.writeFileSync(art, "<html></html>");
  const e = runIndex({ home, artifact: art, sid, cwd: repo })[path.resolve(art)];
  const slug = path.basename(repo).replace(/[^A-Za-z0-9._-]/g, "-");
  ok(e && e.unit_key === slug, "stamped with the repo slug derived from cwd");
  ok(identity.readRecord(sid, { home }) !== null, "record created");
}

// ---- Case 5: no SID → left un-indexed (fail-loud covers it downstream) ----
console.log("\nCase 5 — no session_id → no stamp, no event:");
{
  const home = mkSandbox("nosid");
  const art = path.join(home, "five.html");
  fs.writeFileSync(art, "<html></html>");
  const idx = runIndex({ home, artifact: art, sid: "" });
  ok(Object.keys(idx).length === 0, "index untouched");
  ok(events(home).length === 0, "no events appended");
}

// ---- Case 6: end-to-end — SessionStart registers, index stamps, identities agree ----
console.log("\nCase 6 — SessionStart + index round-trip, one identity:");
{
  const home = mkSandbox("e2e");
  const repo = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "cmp-p4-e2e-")));
  execFileSync("git", ["init", "-q"], { cwd: repo });
  const sid = "44440000-aaaa-bbbb-cccc-000000000006";
  const env = { ...process.env, HOME: home };
  delete env.COMPANION_SESSION;
  execFileSync("sh", [SESSION_HOOK], { input: JSON.stringify({ cwd: repo, session_id: sid }), env, encoding: "utf8" });
  const art = path.join(home, "six.html");
  fs.writeFileSync(art, "<html></html>");
  const e = runIndex({ home, artifact: art, sid, cwd: repo })[path.resolve(art)];
  const rec = identity.readRecord(sid, { home });
  ok(rec && e && e.unit_key === rec.unit_key, "index unit === registered unit");
  const routed = events(home).filter((v) => v.evt === "artifact.routed");
  ok(routed.length === 1 && routed[0].unit_key === rec.unit_key, "artifact.routed event agrees");
}

console.log(`\n=== ${pass} passed, ${fail} failed ===`);
process.exit(fail ? 1 : 0);
