#!/usr/bin/env node
// Unit tests for companion-artifact-gate.cjs — the Stop-hook seatbelt logic.
// SANDBOXED: every transcript/index file is written under a throwaway tmp dir, so this
// never touches live ~/.claude/companion state. Exercises the pure functions directly
// (turn-boundary detection, the index check with its fail-open paths, and decide()).

const fs = require("fs");
const os = require("os");
const path = require("path");

const gate = require("../companion-artifact-gate.cjs");

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

const sandbox = fs.mkdtempSync(path.join(os.tmpdir(), "cmp-gate-"));
function writeFile(name, contents) {
  const p = path.join(sandbox, name);
  fs.writeFileSync(p, contents);
  return p;
}

// ---- lastRealUserPromptTs -------------------------------------------------
// A transcript mixing a real prompt, a tool_use, a tool_result (type:user — must be
// SKIPPED), then the latest real prompt (array content, text block). turnStart must be
// the LATEST real prompt, not the tool_result that came after the first prompt.
const T1 = "2026-07-08T12:00:00.000Z";
const T_TOOLRESULT = "2026-07-08T12:00:30.000Z";
const T_LATEST = "2026-07-08T12:01:00.000Z";
const transcript = writeFile(
  "transcript.jsonl",
  [
    JSON.stringify({ type: "user", timestamp: T1, message: { role: "user", content: "first prompt" } }),
    JSON.stringify({ type: "assistant", timestamp: "2026-07-08T12:00:10.000Z", message: { role: "assistant", content: [{ type: "tool_use" }] } }),
    JSON.stringify({ type: "user", timestamp: T_TOOLRESULT, message: { role: "user", content: [{ type: "tool_result", content: "x" }] } }),
    JSON.stringify({ type: "user", timestamp: T_LATEST, message: { role: "user", content: [{ type: "text", text: "latest prompt" }] } }),
    JSON.stringify({ type: "assistant", timestamp: "2026-07-08T12:01:20.000Z", message: { role: "assistant", content: [{ type: "text", text: "reply" }] } }),
    "",
  ].join("\n"),
);
console.log("### lastRealUserPromptTs");
ok(gate.lastRealUserPromptTs(transcript) === Date.parse(T_LATEST), "returns the LATEST real user prompt ts");
ok(gate.lastRealUserPromptTs(transcript) !== Date.parse(T_TOOLRESULT), "skips a tool_result user entry");
ok(gate.lastRealUserPromptTs(path.join(sandbox, "nope.jsonl")) === null, "unreadable transcript → null");
ok(gate.lastRealUserPromptTs(null) === null, "no path → null");

// ---- artifactWrittenSince -------------------------------------------------
const TURN = Date.parse(T_LATEST); // this turn started at T_LATEST
const SID = "c55c6e2d-dfcc-4914-a7c5-985543339cb4";
const SHORT = "c55c6e2d";
const OTHER_SID = "aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee";

function idx(name, obj) {
  return writeFile(name, JSON.stringify(obj));
}
console.log("### artifactWrittenSince");

const freshMatch = idx("idx-fresh.json", {
  "/a/x.html": { session_id: SID, shortid: SHORT, ts: TURN + 500 },
});
ok(gate.artifactWrittenSince(SID, TURN, freshMatch).wrote === true, "this-session artifact written this turn → wrote");

const stale = idx("idx-stale.json", {
  "/a/x.html": { session_id: SID, shortid: SHORT, ts: TURN - 500 },
});
const staleRes = gate.artifactWrittenSince(SID, TURN, stale);
ok(staleRes.known === true && staleRes.wrote === false, "artifact from a PRIOR turn (ts<turnStart) → known, not written");

const otherSession = idx("idx-other.json", {
  "/a/y.html": { session_id: OTHER_SID, shortid: OTHER_SID.slice(0, 8), ts: TURN + 500 },
});
ok(gate.artifactWrittenSince(SID, TURN, otherSession).wrote === false, "another session's fresh artifact does NOT count");

const legacy = idx("idx-legacy.json", {
  "/a/z.html": { shortid: SHORT, ts: TURN + 500 }, // no session_id field (legacy entry)
});
ok(gate.artifactWrittenSince(SID, TURN, legacy).wrote === true, "legacy entry matched by shortid → wrote");

const missing = gate.artifactWrittenSince(SID, TURN, path.join(sandbox, "no-index.json"));
ok(missing.known === true && missing.wrote === false, "missing index file → legit empty (known, not written)");

const corrupt = gate.artifactWrittenSince(SID, TURN, writeFile("idx-bad.json", "{not json"));
ok(corrupt.known === false, "corrupt index → NOT known (caller fails open)");

ok(gate.artifactWrittenSince(SID, null, freshMatch).known === false, "no turn boundary → not known");

// ---- decide ---------------------------------------------------------------
console.log("### decide");

// stop_hook_active short-circuits everything (loop guard).
ok(
  gate.decide({ stop_hook_active: true, transcript_path: transcript, session_id: SID }, { indexPath: missingPath() }).block === false,
  "stop_hook_active → never block (loop guard)",
);

// Substantive-looking turn, nothing written this turn → block, with a reason naming the dir.
const blockRes = gate.decide(
  { transcript_path: transcript, session_id: SID },
  { indexPath: path.join(sandbox, "no-index.json"), artifactsDir: "/tmp/arts" },
);
ok(blockRes.block === true, "no artifact this turn → block");
ok(typeof blockRes.reason === "string" && blockRes.reason.includes("/tmp/arts"), "block reason names the artifacts dir");

// Artifact already landed this turn → pass.
ok(
  gate.decide({ transcript_path: transcript, session_id: SID }, { indexPath: freshMatch }).block === false,
  "artifact written this turn → pass",
);

// Unreadable transcript → no turn boundary → fail open (no block).
ok(
  gate.decide({ transcript_path: path.join(sandbox, "nope.jsonl"), session_id: SID }, { indexPath: freshMatch }).block === false,
  "unreadable transcript → fail open (no block)",
);

function missingPath() {
  return path.join(sandbox, "no-index.json");
}

// ---- cleanup + result -----------------------------------------------------
try {
  fs.rmSync(sandbox, { recursive: true, force: true });
} catch (_) {}

console.log(`\n=== ${pass}/${pass + fail} checks passed ===`);
process.exit(fail ? 1 : 0);
