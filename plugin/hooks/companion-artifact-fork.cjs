#!/usr/bin/env node
// companion-artifact-fork.cjs — PreToolUse: a rewrite of a SEALED artifact forks.
//
// THE PROBLEM: an agent revisiting a subject rewrites the same slug. Nothing snapshots
// the old revision, so the previous version is destroyed — and with it every 💬 comment
// the user typed, because those live ONLY in the Board's iframe DOM and die on reload.
// The user asked a question on plan.html; the agent rewrote plan.html; the question is
// gone and neither side knows it happened.
//
// THE RULE: the trigger is the TURN BOUNDARY, not "did the user look at it".
//   written THIS turn  → the agent is still authoring (the user hasn't got the terminal
//                        back yet) → let the overwrite through. Forking mid-authoring
//                        would spray plan-2/-3/-4.html for ONE revision.
//   sealed in an EARLIER turn → fork to the next free slug, keep the old file intact.
//
// HOW WE ANSWER "this turn?" — two rungs, in order:
//   1. prompt_id. The PreToolUse payload carries a UUID for the prompt being processed
//      (Claude Code ≥ 2.1.196); companion-index.cjs stamps it onto every artifact's
//      index entry at PostToolUse. Same prompt_id ⇒ same turn. This is an IDENTITY
//      comparison: no clock skew, and immune to the transcript lag below.
//   2. mtime vs turnStart, when there's no prompt_id (older client, un-indexed artifact,
//      no overlay CLI installed so nothing ever stamped the index). This rung is WEAKER
//      than it looks mid-turn: the transcript is written asynchronously and may not yet
//      carry the current turn's prompt, so turnStart can resolve to the PREVIOUS turn
//      and a sealed artifact then reads as "this turn" → we miss a fork. Missing a fork
//      is the failure we accept here; see the fail-open contract below.
//
// MECHANISM — silent redirect, not a block. A PreToolUse hook can replace the tool's
// arguments via hookSpecificOutput.updatedInput, so the Write simply LANDS on the forked
// path; the agent needs no round-trip and cannot decline. NON-OBVIOUS AND LOAD-BEARING:
// updatedInput is honored ONLY when permissionDecision is "allow" or "ask" — the client
// maps permissionDecision → an internal permissionBehavior, and drops updatedInput when
// that behavior is unset. So the "allow" below is NOT us auto-approving for convenience;
// omitting it silently discards the redirect and the write clobbers the sealed file. The
// scope of that allow is exactly one .html inside the artifacts dir that the agent had
// already chosen to write. updatedInput REPLACES the whole input object, so we spread the
// original and swap only file_path. additionalContext then tells the agent where its
// write actually went, so its follow-up edits and its report to the user name the real
// file instead of the sealed one.
//
// FAIL OPEN, ALWAYS. This sits in front of every Write. A hook that wrongly blocks an
// artifact write is far worse than one that misses a fork, so EVERY uncertainty —
// unreadable transcript, no turn boundary, corrupt index, missing file, a throw — exits
// silently and lets the write through untouched. We only ever act on a POSITIVE "this
// file exists and was sealed in an earlier turn".
//
// The external-terminals guard and the cheap non-artifact pre-filter live in the sh
// wrapper (companion-artifact-fork), mirroring companion-hook — so this module is pure
// decision logic and is unit-tested directly.

const fs = require("fs");
const os = require("os");
const path = require("path");

// Shared with the Stop-hook seatbelt — one turn-boundary derivation, not two. Fall back
// to a null-returning stub on a require hiccup: no turnStart → rung 2 goes "unknown" →
// fail open, which is exactly this hook's contract anyway.
let turn = { lastRealUserPromptTs: () => null };
try {
  turn = require("./companion-turn.cjs");
} catch (_) {}

const HOME = os.homedir();
const ARTIFACTS_DIR =
  process.env.COMPANION_ARTIFACTS_DIR || path.join(HOME, ".claude", "companion", "artifacts");
const INDEX_PATH = path.join(HOME, ".claude", "companion", "artifact-index.json");

// How far to walk the -N suffixes before giving up (and failing open). A slug with 50
// live forks is a runaway, not a workflow; blocking forever on it would be worse than
// letting the 51st overwrite land.
const MAX_FORKS = 50;

// The living surfaces: per-project digests the agent is MEANT to rewrite forever, so the
// Board's full-bleed home always reflects current state. Forking them would strand the
// Board on revision 1 and litter the dir with home-2/-3.html. Mirrors the skip arms in
// companion-hook exactly (home.html and home.<unit_key>.html) — these are also the paths
// it never indexes, so they'd otherwise fall to rung 2 and fork on every single update.
function isLivingSurface(base) {
  return base === "home.html" || /^home\..+\.html$/.test(base);
}

// Is this a write we own? Only .html directly inside the artifacts dir. Everything else —
// source files, docs, artifacts nested in a subdir — passes untouched.
function isArtifactPath(file, artifactsDir) {
  return (
    typeof file === "string" &&
    file.endsWith(".html") &&
    path.dirname(path.resolve(file)) === path.resolve(artifactsDir)
  );
}

// The routing index, keyed by absolute artifact path. A MISSING file is a legit empty
// index; a corrupt one returns {} too — both just mean "rung 1 can't answer", and rung 2
// takes over. Never throws.
function readIndex(indexPath) {
  try {
    return JSON.parse(fs.readFileSync(indexPath, "utf8")) || {};
  } catch (_) {
    return {};
  }
}

// Was `file` written during the CURRENT turn? Returns true / false / null(unknown).
// null is the fail-open signal — callers must never treat it as "sealed".
function writtenThisTurn(file, ctx) {
  // Rung 1 — prompt_id identity. Needs both sides: a prompt_id on the payload AND one
  // stamped on this artifact's index entry. Older entries predate the stamp and fall through.
  const entry = ctx.index[path.resolve(file)];
  if (ctx.promptId && entry && entry.prompt_id) return entry.prompt_id === ctx.promptId;

  // Rung 2 — mtime vs turnStart. Only usable when we actually know when the turn began.
  if (!ctx.turnStart) return null;
  try {
    return fs.statSync(file).mtimeMs >= ctx.turnStart;
  } catch (_) {
    return null; // vanished mid-flight → don't guess
  }
}

// The fork target: plan.html → plan-2.html → plan-3.html …
//
// Two subtleties:
//  * Suffix stripping is CONDITIONAL. "plan-2.html" should fork to "plan-3.html", but
//    "incident-2024.html" must NOT fork to "incident-2025.html" — that trailing number is
//    part of the name, not a fork counter. We only treat "-N" as ours when the un-suffixed
//    sibling ("plan.html") actually exists, i.e. we demonstrably forked from it.
//  * A candidate written THIS turn is REUSED, not skipped. Otherwise the second Write of
//    one revision forks again (the original's index entry still carries the old prompt_id,
//    since our redirect meant it was never rewritten) and one revision sprays -2/-3/-4.
//    Reuse requires a POSITIVE same-turn answer: unknown → move on, because overwriting a
//    file we can't vouch for is the very thing this hook exists to prevent.
function nextForkPath(file, ctx) {
  const dir = path.dirname(file);
  const base = path.basename(file, ".html");
  const m = base.match(/^(.+)-(\d+)$/);
  let stem = base;
  let start = 2;
  if (m && fs.existsSync(path.join(dir, m[1] + ".html"))) {
    stem = m[1];
    start = parseInt(m[2], 10) + 1;
  }
  for (let n = start; n < start + MAX_FORKS; n++) {
    const cand = path.join(dir, `${stem}-${n}.html`);
    if (!fs.existsSync(cand)) return cand;
    if (writtenThisTurn(cand, ctx) === true) return cand;
  }
  return null; // runaway → caller fails open
}

// An Edit we can't safely redirect: its old_string is matched against the file at
// file_path, so pointing it at a fork that doesn't exist yet would just error. Deny with
// the instruction instead. This is the ONE place we block, and it is safe by construction
// — even if the agent ignores the wording and re-Writes the sealed slug, that Write forks.
function buildEditDenyReason(file, fork) {
  return (
    "That artifact is SEALED — " +
    path.basename(file) +
    " was finished in an earlier turn and the user may have typed 💬 comments into it, which " +
    "live only in the Board's iframe and are destroyed by any rewrite. Editing it in place would " +
    "lose that revision. Do this instead: Read " +
    path.basename(file) +
    " and Write the full updated document to " +
    fork +
    " — a new artifact carrying your changes, with the sealed one left intact. Do not retry this Edit."
  );
}

// The agent believes it wrote the sealed path; reality says otherwise. Tell it, so its
// follow-up edits and its message to the user both name the file that actually exists.
function buildRedirectContext(file, fork) {
  return (
    "Companion redirected this write: " +
    path.basename(file) +
    " was sealed in an earlier turn (rewriting it would destroy that revision and any 💬 comments " +
    "the user left on it), so your content was written to " +
    fork +
    " instead. The sealed file is untouched. Use the new path for any further edits this turn, and " +
    "refer to the new artifact — not the old slug — when you tell the user what you produced."
  );
}

// Pure decision — unit-tested. Returns {} to pass the write through untouched, or
// { updatedInput, context, fork } to redirect, or { deny } to block an un-redirectable
// Edit. Never throws on bad input.
function decide(input, opts) {
  opts = opts || {};
  const artifactsDir = opts.artifactsDir || ARTIFACTS_DIR;
  const indexPath = opts.indexPath || INDEX_PATH;
  input = input || {};

  // Write authors an artifact; Edit rewrites one in place. Both destroy a sealed revision.
  const tool = input.tool_name;
  if (tool !== "Write" && tool !== "Edit") return {};

  const ti = input.tool_input;
  if (!ti || typeof ti.file_path !== "string") return {};
  const file = ti.file_path;
  if (!isArtifactPath(file, artifactsDir)) return {};
  if (isLivingSurface(path.basename(file))) return {};

  // Nothing on disk → a brand-new artifact. No revision to lose.
  try {
    if (!fs.statSync(file).isFile()) return {};
  } catch (_) {
    return {};
  }

  const ctx = {
    promptId: input.prompt_id || null,
    turnStart: turn.lastRealUserPromptTs(input.transcript_path),
    index: readIndex(indexPath),
  };

  // Only a POSITIVE "sealed in an earlier turn" acts. true (still authoring) and null
  // (can't tell) both pass the write through.
  if (writtenThisTurn(file, ctx) !== false) return {};

  const fork = nextForkPath(file, ctx);
  if (!fork) return {};

  // A same-turn fork already exists ⇒ it holds the content the agent thinks it's editing,
  // so an Edit redirected there still matches. Otherwise the Edit can't be redirected.
  if (tool === "Edit" && !fs.existsSync(fork)) return { deny: buildEditDenyReason(file, fork) };

  return {
    fork,
    updatedInput: { ...ti, file_path: fork },
    context: buildRedirectContext(file, fork),
  };
}

function main() {
  let raw = "";
  process.stdin.on("data", (c) => (raw += c));
  process.stdin.on("end", () => {
    let input = {};
    try {
      input = JSON.parse(raw) || {};
    } catch (_) {}
    let d = {};
    try {
      d = decide(input);
    } catch (_) {
      // Any unexpected error → fail open (the write lands where the agent aimed it).
      d = {};
    }
    // permissionDecision is REQUIRED for updatedInput to take effect — see the header.
    if (d.updatedInput) {
      process.stdout.write(
        JSON.stringify({
          hookSpecificOutput: {
            hookEventName: "PreToolUse",
            permissionDecision: "allow",
            permissionDecisionReason: "Companion: forked a rewrite of a sealed artifact.",
            updatedInput: d.updatedInput,
            additionalContext: d.context,
          },
        }),
      );
    } else if (d.deny) {
      process.stdout.write(
        JSON.stringify({
          hookSpecificOutput: {
            hookEventName: "PreToolUse",
            permissionDecision: "deny",
            permissionDecisionReason: d.deny,
          },
        }),
      );
    }
    process.exit(0);
  });
}

if (require.main === module) main();
else
  module.exports = {
    decide,
    writtenThisTurn,
    nextForkPath,
    isLivingSurface,
    isArtifactPath,
    readIndex,
  };
