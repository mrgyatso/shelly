#!/usr/bin/env node
// Unit tests for companion-artifact-fork.cjs — the PreToolUse "sealed artifacts fork" hook.
// SANDBOXED: every artifact/transcript/index file is written under a throwaway tmp dir, so
// this never touches live ~/.claude/companion state. Exercises decide() directly (both
// turn-detection rungs, the exemptions, the fork-target walk, and every fail-open path),
// plus one end-to-end run of the real .cjs over stdin to pin the emitted JSON contract.

const fs = require("fs");
const os = require("os");
const path = require("path");
const { spawnSync } = require("child_process");

const fork = require("../companion-artifact-fork.cjs");

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

const sandbox = fs.mkdtempSync(path.join(os.tmpdir(), "cmp-fork-"));
const ARTIFACTS = path.join(sandbox, "artifacts");
fs.mkdirSync(ARTIFACTS);

const T_PREV = "2026-07-16T12:00:00.000Z"; // an earlier turn
const T_NOW = "2026-07-16T12:05:00.000Z"; // the turn under test
const TURN_START = Date.parse(T_NOW);
const P_PREV = "11111111-1111-1111-1111-111111111111";
const P_NOW = "22222222-2222-2222-2222-222222222222";

// A transcript whose LAST real user prompt is T_NOW → turnStart = TURN_START.
const transcript = path.join(sandbox, "transcript.jsonl");
fs.writeFileSync(
  transcript,
  [
    JSON.stringify({ type: "user", timestamp: T_PREV, message: { role: "user", content: "older prompt" } }),
    JSON.stringify({ type: "user", timestamp: T_NOW, message: { role: "user", content: [{ type: "text", text: "current prompt" }] } }),
    "",
  ].join("\n"),
);

// Write an artifact and force its mtime to a chosen turn.
function artifact(name, whenMs) {
  const p = path.join(ARTIFACTS, name);
  fs.writeFileSync(p, "<html><body>x</body></html>");
  const t = new Date(whenMs);
  fs.utimesSync(p, t, t);
  return p;
}
function indexAt(name, entries) {
  const p = path.join(sandbox, name);
  fs.writeFileSync(p, JSON.stringify(entries));
  return p;
}
const EMPTY_INDEX = path.join(sandbox, "no-index.json"); // never created → missing index

// Standard payload builder. Defaults to the Write of a full document.
function payload(file, over) {
  return Object.assign(
    {
      tool_name: "Write",
      tool_input: { file_path: file, content: "<html>new</html>" },
      transcript_path: transcript,
      prompt_id: P_NOW,
    },
    over || {},
  );
}
function decide(input, indexPath) {
  return fork.decide(input, { artifactsDir: ARTIFACTS, indexPath: indexPath || EMPTY_INDEX });
}

// ---- rung 1: prompt_id identity -------------------------------------------
console.log("### prompt_id (rung 1)");
{
  // Sealed in an earlier turn, but its mtime is RECENT — so only prompt_id can tell the
  // truth. This is the transcript-lag case the whole rung exists for.
  const a = artifact("plan.html", TURN_START + 9999);
  const idx = indexAt("idx-prev.json", { [a]: { prompt_id: P_PREV, ts: 1 } });
  const d = decide(payload(a), idx);
  ok(d.fork === path.join(ARTIFACTS, "plan-2.html"), "earlier prompt_id → forks (even with a fresh mtime)");
  ok(d.updatedInput.file_path === path.join(ARTIFACTS, "plan-2.html"), "updatedInput carries the forked file_path");
  ok(d.updatedInput.content === "<html>new</html>", "updatedInput preserves the rest of the tool input");
  ok(fs.readFileSync(a, "utf8") === "<html><body>x</body></html>", "the sealed file is left untouched");

  // Same prompt_id → the agent is still authoring this very turn.
  const idxSame = indexAt("idx-same.json", { [a]: { prompt_id: P_NOW, ts: 1 } });
  ok(!decide(payload(a), idxSame).updatedInput, "same prompt_id → same turn → overwrite allowed");
}

// ---- rung 2: mtime vs turnStart -------------------------------------------
console.log("### mtime fallback (rung 2)");
{
  // No prompt_id anywhere (older client) → fall back to the clock.
  const sealed = artifact("recap.html", TURN_START - 60000);
  ok(
    decide(payload(sealed, { prompt_id: null }), EMPTY_INDEX).fork === path.join(ARTIFACTS, "recap-2.html"),
    "mtime before turnStart → sealed → forks",
  );
  const fresh = artifact("draft.html", TURN_START + 1000);
  ok(!decide(payload(fresh, { prompt_id: null }), EMPTY_INDEX).updatedInput, "mtime after turnStart → same turn → allowed");

  // An index entry with no prompt_id (written before this feature) must not short-circuit
  // rung 1 into a false "different" — it has to fall through to mtime.
  const idxOld = indexAt("idx-legacy.json", { [fresh]: { ts: 1, session_id: "x" } });
  ok(!decide(payload(fresh), idxOld).updatedInput, "index entry lacking prompt_id → falls back to mtime → allowed");
}

// ---- exemptions -----------------------------------------------------------
console.log("### exemptions");
{
  const homeUnit = artifact("home.claude-code-companion.html", TURN_START - 60000);
  ok(!decide(payload(homeUnit), EMPTY_INDEX).updatedInput, "home.<unit_key>.html is exempt → rewritten in place");
  const homeBare = artifact("home.html", TURN_START - 60000);
  ok(!decide(payload(homeBare), EMPTY_INDEX).updatedInput, "home.html is exempt → rewritten in place");
  // Not exempt just because the name starts with "home" — home-page.html is a normal slug.
  const homeish = artifact("home-page.html", TURN_START - 60000);
  ok(decide(payload(homeish), EMPTY_INDEX).fork, "home-page.html is NOT exempt (not a digest)");
  // _*.html — companion-hook refuses to index the diagnostic scaffolds, so they can never
  // answer "same turn?" and would fork on EVERY write. Exempt, in lockstep with that hook.
  const scaffold = artifact("_probe.html", TURN_START - 60000);
  ok(!decide(payload(scaffold), EMPTY_INDEX).updatedInput, "_*.html scaffold is exempt → rewritten in place");
}

// ---- permission posture is mirrored, never authored ------------------------
// The redirect must claim "allow" or "ask" (nothing else carries updatedInput), so the
// hook has to pick one — and the only defensible pick is whatever the session would have
// done anyway. These pin BOTH directions so a future edit flips a test, not a user's
// expectations: no strict user is silently auto-approved, no auto user is newly nagged.
console.log("### permission posture");
{
  ok(fork.forkDecision("default") === "ask", "strict default mode → ask (the user still vets the write)");
  ok(fork.forkDecision("plan") === "ask", "plan mode → ask");
  ok(fork.forkDecision("acceptEdits") === "allow", "acceptEdits → allow (it was never going to prompt)");
  ok(fork.forkDecision("bypassPermissions") === "allow", "bypassPermissions → allow");
  ok(fork.forkDecision("dontAsk") === "allow", "dontAsk → allow");
  ok(fork.forkDecision("auto") === "allow", "auto → allow");
  ok(fork.forkDecision(undefined) === "ask", "absent mode → ask (never auto-approve a posture we cannot read)");
  ok(fork.forkDecision("some-future-mode") === "ask", "unknown mode → ask (fail toward asking)");
}

// ---- paths we must never touch --------------------------------------------
console.log("### non-artifact paths");
{
  const src = path.join(sandbox, "src.ts");
  fs.writeFileSync(src, "export const x = 1;");
  fs.utimesSync(src, new Date(TURN_START - 60000), new Date(TURN_START - 60000));
  ok(!decide(payload(src), EMPTY_INDEX).updatedInput, "a source file outside the artifacts dir → untouched");

  const md = path.join(ARTIFACTS, "notes.md");
  fs.writeFileSync(md, "# notes");
  fs.utimesSync(md, new Date(TURN_START - 60000), new Date(TURN_START - 60000));
  ok(!decide(payload(md), EMPTY_INDEX).updatedInput, "a non-.html file inside the artifacts dir → untouched");

  const nested = path.join(ARTIFACTS, "sub");
  fs.mkdirSync(nested);
  const deep = path.join(nested, "deep.html");
  fs.writeFileSync(deep, "<html></html>");
  fs.utimesSync(deep, new Date(TURN_START - 60000), new Date(TURN_START - 60000));
  ok(!decide(payload(deep), EMPTY_INDEX).updatedInput, "an .html in a SUBDIR of the artifacts dir → untouched");

  ok(!decide(payload(path.join(ARTIFACTS, "brand-new.html")), EMPTY_INDEX).updatedInput, "a path with no file on disk → new artifact → untouched");
  ok(!decide(payload(ARTIFACTS + "/"), EMPTY_INDEX).updatedInput, "a directory, not a file → untouched");

  const other = Object.assign(payload(artifact("t.html", TURN_START - 60000)), { tool_name: "Bash" });
  ok(!decide(other, EMPTY_INDEX).updatedInput, "a tool other than Write/Edit → untouched");
}

// ---- fork-target walk -----------------------------------------------------
console.log("### fork target");
{
  // plan.html and plan-2.html are both sealed → the next free suffix is plan-3.html.
  artifact("plan.html", TURN_START - 60000);
  artifact("plan-2.html", TURN_START - 30000);
  ok(
    decide(payload(path.join(ARTIFACTS, "plan.html")), EMPTY_INDEX).fork === path.join(ARTIFACTS, "plan-3.html"),
    "occupied suffix → walks to the next free one",
  );
  ok(
    decide(payload(path.join(ARTIFACTS, "plan-2.html")), EMPTY_INDEX).fork === path.join(ARTIFACTS, "plan-3.html"),
    "forking plan-2.html continues the chain (plan-3), not plan-2-2",
  );

  // REUSE: a fork written THIS turn is the same revision, so a second Write of it must
  // land on the same file rather than spraying plan-4.html.
  artifact("plan-3.html", TURN_START + 1000);
  ok(
    decide(payload(path.join(ARTIFACTS, "plan.html")), EMPTY_INDEX).fork === path.join(ARTIFACTS, "plan-3.html"),
    "a fork written THIS turn is reused, not sprayed",
  );

  // A trailing number that is part of the NAME must not be read as a fork counter —
  // incident-2024.html has no incident.html sibling, so it forks to incident-2024-2.html.
  artifact("incident-2024.html", TURN_START - 60000);
  ok(
    decide(payload(path.join(ARTIFACTS, "incident-2024.html")), EMPTY_INDEX).fork ===
      path.join(ARTIFACTS, "incident-2024-2.html"),
    "a year-like suffix is not a fork counter (incident-2024 → incident-2024-2)",
  );
}

// ---- Edit ------------------------------------------------------------------
console.log("### Edit");
{
  const sealed = artifact("report.html", TURN_START - 60000);
  const editIn = { tool_name: "Edit", tool_input: { file_path: sealed, old_string: "x", new_string: "y" }, transcript_path: transcript, prompt_id: null };
  const d = decide(editIn, EMPTY_INDEX);
  ok(!!d.deny, "Edit of a sealed artifact with no same-turn fork → denied (an Edit can't be redirected onto a file that doesn't exist)");
  ok(/report-2\.html/.test(d.deny), "the deny names the fork path to write instead");
  ok(!d.updatedInput, "the denied Edit carries no updatedInput");

  // Once a same-turn fork EXISTS it holds the content the agent thinks it's editing, so
  // the Edit can be transparently redirected onto it.
  artifact("report-2.html", TURN_START + 1000);
  const d2 = decide(editIn, EMPTY_INDEX);
  ok(d2.updatedInput && d2.updatedInput.file_path === path.join(ARTIFACTS, "report-2.html"), "Edit redirects onto an existing same-turn fork");
  ok(d2.updatedInput.old_string === "x", "the redirected Edit keeps its old_string/new_string");
}

// ---- fail-open paths -------------------------------------------------------
console.log("### fail open");
{
  const sealed = artifact("open.html", TURN_START - 60000);
  ok(!decide(payload(sealed, { transcript_path: null, prompt_id: null }), EMPTY_INDEX).updatedInput, "no transcript AND no prompt_id → can't tell → allowed");
  ok(
    !decide(payload(sealed, { transcript_path: path.join(sandbox, "nope.jsonl"), prompt_id: null }), EMPTY_INDEX).updatedInput,
    "unreadable transcript → no turn boundary → allowed",
  );

  const noPrompts = path.join(sandbox, "empty.jsonl");
  fs.writeFileSync(noPrompts, JSON.stringify({ type: "assistant", timestamp: T_NOW, message: { role: "assistant", content: "hi" } }) + "\n");
  ok(!decide(payload(sealed, { transcript_path: noPrompts, prompt_id: null }), EMPTY_INDEX).updatedInput, "transcript with no real user prompt → allowed");

  const corrupt = path.join(sandbox, "corrupt.json");
  fs.writeFileSync(corrupt, "{not json");
  ok(fork.readIndex(corrupt) && Object.keys(fork.readIndex(corrupt)).length === 0, "corrupt index reads as empty, never throws");
  ok(decide(payload(sealed, { prompt_id: null }), corrupt).fork, "corrupt index → rung 2 still decides (mtime says sealed → fork)");

  ok(!fork.decide(null, { artifactsDir: ARTIFACTS, indexPath: EMPTY_INDEX }).updatedInput, "null input → allowed, no throw");
  ok(!decide({ tool_name: "Write" }, EMPTY_INDEX).updatedInput, "missing tool_input → allowed, no throw");
  ok(!decide({ tool_name: "Write", tool_input: {} }, EMPTY_INDEX).updatedInput, "missing file_path → allowed, no throw");
  ok(!decide({ tool_name: "Write", tool_input: { file_path: 42 } }, EMPTY_INDEX).updatedInput, "non-string file_path → allowed, no throw");
}

// ---- end-to-end: the emitted JSON contract ---------------------------------
// The exact shape the client honors. NON-OBVIOUS: updatedInput is dropped unless
// permissionDecision is "allow"/"ask", so this asserts the pairing, not just the path.
console.log("### stdin → stdout contract");
{
  // Run the real binary under BOTH postures. The pairing is what matters: whatever
  // decision we emit must be one the client honors updatedInput for ("allow"/"ask"),
  // and it must match the mode the session was already in.
  const run = (file, mode) => {
    const r = spawnSync("node", [path.join(__dirname, "..", "companion-artifact-fork.cjs")], {
      input: JSON.stringify(payload(file, { prompt_id: null, permission_mode: mode })),
      encoding: "utf8",
      env: Object.assign({}, process.env, { COMPANION_ARTIFACTS_DIR: ARTIFACTS, HOME: sandbox }),
    });
    let out = null;
    try {
      out = JSON.parse(r.stdout);
    } catch (_) {}
    return { status: r.status, stdout: r.stdout, hso: out && out.hookSpecificOutput };
  };

  const a = artifact("wire.html", TURN_START - 60000);
  const auto = run(a, "auto");
  ok(auto.status === 0, "hook exits 0");
  ok(!!auto.hso, "emits JSON with hookSpecificOutput");
  ok(auto.hso && auto.hso.hookEventName === "PreToolUse", "hookEventName is PreToolUse");
  ok(auto.hso && auto.hso.permissionDecision === "allow", 'auto mode → "allow" (a decision is REQUIRED — updatedInput is dropped without one)');
  ok(auto.hso && auto.hso.updatedInput && auto.hso.updatedInput.file_path === path.join(ARTIFACTS, "wire-2.html"), "updatedInput redirects file_path to the fork");
  ok(auto.hso && typeof auto.hso.additionalContext === "string" && /wire-2\.html/.test(auto.hso.additionalContext), "additionalContext tells the agent the real path");

  const strict = run(artifact("wire-strict.html", TURN_START - 60000), "default");
  ok(strict.hso && strict.hso.permissionDecision === "ask", 'strict default mode → "ask" — the fork never auto-approves a write the user vets');
  ok(strict.hso && strict.hso.updatedInput && /wire-strict-2\.html/.test(strict.hso.updatedInput.file_path), "…and the redirect still carries (ask honors updatedInput too)");

  // A pass-through write must emit NOTHING — an empty stdout leaves the tool call alone.
  const r2 = spawnSync("node", [path.join(__dirname, "..", "companion-artifact-fork.cjs")], {
    input: JSON.stringify({ tool_name: "Write", tool_input: { file_path: path.join(sandbox, "x.ts"), content: "y" } }),
    encoding: "utf8",
    env: Object.assign({}, process.env, { COMPANION_ARTIFACTS_DIR: ARTIFACTS, HOME: sandbox }),
  });
  ok(r2.status === 0 && r2.stdout.trim() === "", "a non-artifact write emits no output at all");
}

// ---- cleanup + result -----------------------------------------------------
try {
  fs.rmSync(sandbox, { recursive: true, force: true });
} catch (_) {}

console.log(`\n=== ${pass}/${pass + fail} checks passed ===`);
process.exit(fail ? 1 : 0);
