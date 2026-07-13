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

// The rule is ABSOLUTE: the gate must not hand the agent a trivial-turn escape. It used to
// end with "or the turn was trivial (a quick answer, a lookup) — just STOP", which is the
// exemption we removed. Pin its absence, and pin that the reason demands a next step: an
// artifact that just recaps and stops is the failure this whole gate exists to prevent.
ok(!/\btrivial\b/i.test(blockRes.reason), "block reason offers NO trivial-turn escape");
ok(/absolute/i.test(blockRes.reason), "block reason states the rule is absolute");
ok(/next (step|move)/i.test(blockRes.reason), "block reason demands a next step, not just a page");

// Same for the content-lint: "it's a look-only pill, just STOP" was the other escape.
const responderReason = gate.buildResponderReason();
ok(!/look-only/i.test(responderReason), "responder reason offers NO look-only escape");
ok(/done/i.test(responderReason), "responder reason covers the finished-work case (still needs a next step)");

// Artifact landed this turn but its file is unreadable (index points at /a/x.html which
// doesn't exist) → content-lint can't verify → fail open (no block).
ok(
  gate.decide({ transcript_path: transcript, session_id: SID }, { indexPath: freshMatch }).block === false,
  "artifact written but file unreadable → content-lint fails open (no block)",
);

// Unreadable transcript → no turn boundary → fail open (no block).
ok(
  gate.decide({ transcript_path: path.join(sandbox, "nope.jsonl"), session_id: SID }, { indexPath: freshMatch }).block === false,
  "unreadable transcript → fail open (no block)",
);

// ---- hasAnswerableSurface -------------------------------------------------
console.log("### hasAnswerableSurface");
const artWithBallot = writeFile("art-ballot.html", '<div data-companion-item data-item-label="x"></div>');
const artWithSubmit = writeFile("art-submit.html", '<button data-companion-submit="Do">Submit</button>');
const artWithComment = writeFile("art-comment.html", '<section data-companion-commentable><p>hi</p></section>');
const artBare = writeFile("art-bare.html", "<h1>We shipped it 🎉</h1><p>All done.</p>");
ok(gate.hasAnswerableSurface([artWithBallot]).any === true, "ballot item counts as an answerable surface");
ok(gate.hasAnswerableSurface([artWithSubmit]).any === true, "submit button counts as an answerable surface");
ok(gate.hasAnswerableSurface([artWithComment]).any === true, "commentable blocks count as an answerable surface");
ok(gate.hasAnswerableSurface([artBare]).any === false, "bare recap has no answerable surface");
const bareSurf = gate.hasAnswerableSurface([artBare]);
ok(bareSurf.known === true && bareSurf.any === false, "all-readable + no responder → known, none");
const partial = gate.hasAnswerableSurface([artBare, path.join(sandbox, "gone.html")]);
ok(partial.known === false, "an unreadable path → not known (caller fails open)");
const mixed = gate.hasAnswerableSurface([artBare, artWithBallot]);
ok(mixed.any === true, "any one artifact with a responder → any=true");

// The helper's OWN source names every marker; a pure recap that embeds it just for the
// fallback chat bar must NOT count as a responder (markup-only match, script/style stripped).
const artHelperOnly = writeFile(
  "art-helper-only.html",
  "<h1>Done</h1><p>Shipped it.</p>" +
    "<style>[data-companion-commentable] .companion-commentable{position:relative}</style>" +
    '<script>var s=document.querySelector("[data-companion-submit]");' +
    'document.querySelectorAll("[data-companion-item]");' +
    'document.querySelectorAll("[data-companion-commentable]");</script>',
);
ok(
  gate.hasAnswerableSurface([artHelperOnly]).any === false,
  "helper/CSS source that only NAMES the markers (no real markup) → not a responder",
);
// Real commentable markup alongside the helper script still counts.
const artRealPlusHelper = writeFile(
  "art-real-helper.html",
  '<section data-companion-commentable><p>hi</p></section>' +
    '<script>document.querySelector("[data-companion-submit]");</script>',
);
ok(
  gate.hasAnswerableSurface([artRealPlusHelper]).any === true,
  "real commentable markup alongside the helper script → responder",
);

// ---- decide: content-lint -------------------------------------------------
console.log("### decide (content-lint)");
function idxAt(name, htmlPath) {
  return idx(name, { [htmlPath]: { session_id: SID, shortid: SHORT, ts: TURN + 500 } });
}
// Artifact with a responder → pass.
ok(
  gate.decide({ transcript_path: transcript, session_id: SID }, { indexPath: idxAt("idx-ok.json", artWithBallot) }).block === false,
  "artifact with an answerable surface → pass",
);
// Artifact with NO responder (bare recap) → block, with the responder reason.
const bareRes = gate.decide({ transcript_path: transcript, session_id: SID }, { indexPath: idxAt("idx-bare.json", artBare) });
ok(bareRes.block === true, "bare recap artifact (no responder) → block");
ok(typeof bareRes.reason === "string" && /respond in place/i.test(bareRes.reason), "block reason flags the missing responder");
// Two artifacts, one has a responder → pass (don't nag when a responder exists somewhere).
const idxTwo = idx("idx-two.json", {
  [artBare]: { session_id: SID, shortid: SHORT, ts: TURN + 400 },
  [artWithSubmit]: { session_id: SID, shortid: SHORT, ts: TURN + 600 },
});
ok(
  gate.decide({ transcript_path: transcript, session_id: SID }, { indexPath: idxTwo }).block === false,
  "one of two artifacts has a responder → pass",
);
// stop_hook_active still short-circuits the content-lint (fires at most once per chain).
ok(
  gate.decide({ stop_hook_active: true, transcript_path: transcript, session_id: SID }, { indexPath: idxAt("idx-bare2.json", artBare) }).block === false,
  "stop_hook_active → content-lint also never blocks (loop guard)",
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
