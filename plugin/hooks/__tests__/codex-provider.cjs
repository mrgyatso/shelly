#!/usr/bin/env node
// Codex-provider verification — SANDBOXED (throwaway HOME, same harness style as the
// registry-phase suites). Codex CLI runs this plugin's hooks through its Claude-shaped
// hooks system; these cases pin the provider-aware slice of that integration:
//   - SessionStart records provider "codex"/"claude" from the transcript_path shape,
//     and provider is frozen with the rest of the identity (resume can't flip it).
//   - companion-artifact-paths.cjs extracts artifact paths from every payload shape
//     (Claude Write file_path, Codex apply_patch text, shell commands, escaped JSON).
//   - The real companion-hook sh path indexes an artifact from a Codex-shaped
//     apply_patch payload end-to-end (late registration carries the provider).
//   - The Stop gate FAILS OPEN on a Codex rollout transcript (no Claude-style user
//     entries → no turn boundary → never block). The seatbelt staying quiet under
//     Codex is deliberate v1 behavior; a rollout-aware parser can come later.

const fs = require("fs");
const os = require("os");
const path = require("path");
const { execFileSync } = require("child_process");

const HOOKS = path.join(__dirname, "..");
const SESSION_HOOK = path.join(HOOKS, "companion-session");
const COMPANION_HOOK = path.join(HOOKS, "companion-hook");
const { extractPaths } = require(path.join(HOOKS, "companion-artifact-paths.cjs"));
const gate = require(path.join(HOOKS, "companion-artifact-gate.cjs"));

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
  const home = fs.mkdtempSync(path.join(os.tmpdir(), `cmp-codex-${tag}-`));
  fs.mkdirSync(path.join(home, ".claude", "companion", "logs"), { recursive: true });
  fs.writeFileSync(path.join(home, ".claude", "companion", "external-terminals"), "on");
  return home;
}

function runSession({ home, cwd, session_id, transcript_path }) {
  const env = { ...process.env, HOME: home };
  delete env.COMPANION_SESSION;
  delete env.COMPANION_ARTIFACTS_DIR;
  const payload = JSON.stringify({ cwd, session_id, transcript_path });
  return execFileSync("sh", [SESSION_HOOK], { input: payload, env, encoding: "utf8" });
}

function recordOf(home, session_id) {
  const p = path.join(home, ".claude", "companion", "sessions", session_id + ".json");
  return fs.existsSync(p) ? JSON.parse(fs.readFileSync(p, "utf8")) : null;
}

// ---- Case 1: SessionStart provider detection ----
console.log("\nCase 1 — SessionStart records the provider:");
{
  const home = mkSandbox("provider");
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "cmp-codex-proj-"));

  runSession({
    home,
    cwd: dir,
    session_id: "codex-sess-1",
    transcript_path: path.join(home, ".codex", "sessions", "2026", "07", "12", "rollout-2026-07-12T10-00-00-abc.jsonl"),
  });
  let rec = recordOf(home, "codex-sess-1");
  ok(rec && rec.provider === "codex", "rollout transcript under ~/.codex → provider codex");

  runSession({
    home,
    cwd: dir,
    session_id: "claude-sess-1",
    transcript_path: path.join(home, ".claude", "projects", "-tmp-x", "claude-sess-1.jsonl"),
  });
  rec = recordOf(home, "claude-sess-1");
  ok(rec && rec.provider === "claude", "Claude transcript → provider claude");

  runSession({ home, cwd: dir, session_id: "bare-sess-1" });
  rec = recordOf(home, "bare-sess-1");
  ok(rec && rec.provider === "claude", "no transcript_path → defaults to claude");

  // CODEX_HOME redirection: the rollout filename alone is enough of a signal.
  runSession({
    home,
    cwd: dir,
    session_id: "codex-sess-2",
    transcript_path: "/srv/codex-home/sessions/2026/07/12/rollout-2026-07-12T11-00-00-def.jsonl",
  });
  rec = recordOf(home, "codex-sess-2");
  ok(rec && rec.provider === "codex", "rollout-*.jsonl outside ~/.codex still → codex");

  // Frozen on resume: a second SessionStart with a DIFFERENT transcript shape must
  // not rewrite the record (idempotency on the full session_id).
  runSession({
    home,
    cwd: dir,
    session_id: "codex-sess-1",
    transcript_path: path.join(home, ".claude", "projects", "-tmp-x", "y.jsonl"),
  });
  rec = recordOf(home, "codex-sess-1");
  ok(rec && rec.provider === "codex", "resume with a different transcript shape leaves provider frozen");
}

// ---- Case 2: artifact-path extraction across payload shapes ----
console.log("\nCase 2 — companion-artifact-paths.cjs extraction:");
{
  const A = "/home/u/.claude/companion/artifacts";

  let got = extractPaths(
    JSON.stringify({ tool_input: { file_path: A + "/plan.html" } }),
    A,
  );
  ok(got.length === 1 && got[0] === A + "/plan.html", "Claude Write file_path");

  const patch = "*** Begin Patch\n*** Add File: " + A + "/codex-page.html\n+<!doctype html>\n*** End Patch";
  got = extractPaths(JSON.stringify({ tool_name: "apply_patch", tool_input: { input: patch } }), A);
  ok(got.length === 1 && got[0] === A + "/codex-page.html", "Codex apply_patch add-file text");

  got = extractPaths(
    JSON.stringify({ tool_name: "shell", tool_input: { command: "mv /tmp/x.html " + A + "/moved.html" } }),
    A,
  );
  ok(got.length === 1 && got[0] === A + "/moved.html", "shell command referencing an artifact path");

  // JSON encoders that escape forward slashes still resolve to the real path.
  const escaped = '{"tool_input":{"input":"*** Add File: ' + A.replace(/\//g, "\\/") + '\\/esc.html"}}';
  got = extractPaths(escaped, A);
  ok(got.length === 1 && got[0] === A + "/esc.html", "escaped-slash (\\/) payload normalizes");

  got = extractPaths(JSON.stringify({ tool_input: { file_path: "/tmp/elsewhere/nope.html" } }), A);
  ok(got.length === 0, "non-artifact write extracts nothing");

  got = extractPaths(
    JSON.stringify({ tool_input: { file_path: A + "/a.html" }, extra: "also " + A + "/a.html here" }),
    A,
  );
  ok(got.length === 1, "duplicate mentions dedupe to one path");
}

// ---- Case 3: companion-hook end-to-end with a Codex apply_patch payload ----
console.log("\nCase 3 — companion-hook indexes a Codex artifact end-to-end:");
{
  const home = mkSandbox("hook");
  const artifacts = path.join(home, ".claude", "companion", "artifacts");
  fs.mkdirSync(artifacts, { recursive: true });
  // The hook bails without a `companion` CLI on PATH (harmless-without-the-app seam);
  // stub one so the sandbox exercises the indexing path.
  const bin = path.join(home, "bin");
  fs.mkdirSync(bin, { recursive: true });
  fs.writeFileSync(path.join(bin, "companion"), "#!/bin/sh\nexit 0\n", { mode: 0o755 });

  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "cmp-codex-proj-"));
  const fp = path.join(artifacts, "codex-turn.html");
  fs.writeFileSync(fp, "<!doctype html><html><head><meta charset=\"utf-8\"></head><body>x</body></html>");

  const payload = JSON.stringify({
    session_id: "codex-hook-1",
    cwd: dir,
    transcript_path: path.join(home, ".codex", "sessions", "2026", "07", "12", "rollout-2026-07-12T12-00-00-xyz.jsonl"),
    tool_name: "apply_patch",
    tool_input: { input: "*** Begin Patch\n*** Add File: " + fp + "\n+<!doctype html>\n*** End Patch" },
  });
  const env = { ...process.env, HOME: home, PATH: bin + ":" + process.env.PATH };
  delete env.COMPANION_SESSION;
  delete env.COMPANION_ARTIFACTS_DIR;
  execFileSync("sh", [COMPANION_HOOK], { input: payload, env, encoding: "utf8" });

  const idxPath = path.join(home, ".claude", "companion", "artifact-index.json");
  const idx = fs.existsSync(idxPath) ? JSON.parse(fs.readFileSync(idxPath, "utf8")) : {};
  const entry = idx[fp];
  ok(!!entry, "artifact-index.json gained an entry for the apply_patch write");
  ok(entry && entry.session_id === "codex-hook-1", "entry keyed to the writing session");
  const rec = recordOf(home, "codex-hook-1");
  ok(rec && rec.provider === "codex", "late registration recorded provider codex");
  ok(rec && rec.unit_key && entry && entry.unit_key === rec.unit_key, "entry unit_key matches the frozen record");
}

// ---- Case 4: the Stop gate fails open on Codex rollout transcripts ----
console.log("\nCase 4 — Stop gate fails open under Codex:");
{
  const home = mkSandbox("gate");
  const roll = path.join(home, "rollout-2026-07-12T13-00-00-aaa.jsonl");
  fs.writeFileSync(
    roll,
    [
      JSON.stringify({ timestamp: "2026-07-12T13:00:00.000Z", type: "session_meta", payload: { id: "aaa", cwd: "/tmp" } }),
      JSON.stringify({ timestamp: "2026-07-12T13:00:01.000Z", type: "response_item", payload: { type: "message", role: "user", content: [{ type: "input_text", text: "do the thing" }] } }),
      JSON.stringify({ timestamp: "2026-07-12T13:00:09.000Z", type: "event_msg", payload: { type: "agent_message", message: "done" } }),
    ].join("\n") + "\n",
  );
  const d = gate.decide(
    { session_id: "aaa", transcript_path: roll, stop_hook_active: false },
    { indexPath: path.join(home, "no-index.json"), artifactsDir: path.join(home, "artifacts") },
  );
  ok(d.block === false, "rollout transcript yields no turn boundary → no block (fail open)");
}

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
