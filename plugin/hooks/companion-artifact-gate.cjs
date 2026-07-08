#!/usr/bin/env node
// companion-artifact-gate.cjs — the logic behind the Stop-hook seatbelt.
//
// Artifacts are now authored INLINE by the agent (the proactive path), guided by the
// html-output rule + prefer-html skill it carries in context — no background observer,
// no deterministic renderer. This is the seatbelt: at turn-end it checks two MECHANICAL
// facts and hands control back ONCE (decision:block) so the agent fixes it in full,
// warm-cache context:
//   1. Did an .html artifact land during THIS turn? If not → "author one".
//   2. If one did, does it give the user a way to RESPOND in place (a Next-steps ballot,
//      a Submit, or commentable blocks)? If it has none of those → "add an answerable
//      surface" — the artifact stranded the user with only the fallback chat bar.
// It JUDGES NOTHING about substance; both block reasons put that call on the agent, which
// alone has the conversation and can decline (e.g. a genuine look-only status pill). The
// user re-judges nothing either — the agent does, in-context.
//
// Fail-OPEN by design. A false block would nag forever and push duplicate/needless
// artifacts — strictly worse than a missed seatbelt (the proactive path already covers the
// common case). So on ANY uncertainty we do NOT block: check (1) blocks only when the index
// is readable and nothing this session wrote landed since this turn began; check (2) blocks
// only when EVERY artifact this turn was readable and none carried a responder marker.
//
// Loop guard: stop_hook_active is true only inside a continuation this hook itself drove;
// it resets on the next real user prompt, so the seatbelt still fires every fresh turn.
//
// The external-terminals guard lives in the sh wrapper (companion-artifact-gate), mirroring
// companion-observe — so this module is pure gate logic and is unit-tested directly.

const fs = require("fs");
const os = require("os");
const path = require("path");

const HOME = os.homedir();
const ARTIFACTS_DIR =
  process.env.COMPANION_ARTIFACTS_DIR || path.join(HOME, ".claude", "companion", "artifacts");
const INDEX_PATH = path.join(HOME, ".claude", "companion", "artifact-index.json");

// Mirror of companion-identity.cjs safeId — the index stamps session_id through it.
// A normal UUID session_id is unchanged; this only matters for exotic ids.
function safeId(id) {
  return String(id || "").replace(/[^A-Za-z0-9._-]/g, "-");
}

// turnStart = epoch-ms timestamp of the last GENUINE user prompt in the transcript.
// Claude Code records tool_results as type:"user" too, so a real prompt is a user entry
// whose content is a string, or an array WITHOUT any tool_result block. Returns null if
// the transcript can't be read or has no such entry (→ caller fails open).
function lastRealUserPromptTs(transcriptPath) {
  if (!transcriptPath) return null;
  let text;
  try {
    text = fs.readFileSync(transcriptPath, "utf8");
  } catch (_) {
    return null;
  }
  let ts = null;
  for (const line of text.split("\n")) {
    if (!line.trim()) continue;
    let o;
    try {
      o = JSON.parse(line);
    } catch (_) {
      continue;
    }
    if (o.type !== "user" || !o.message) continue;
    const c = o.message.content;
    const isReal =
      typeof c === "string" || (Array.isArray(c) && !c.some((b) => b && b.type === "tool_result"));
    if (isReal && o.timestamp) {
      const t = Date.parse(o.timestamp);
      if (!Number.isNaN(t)) ts = t;
    }
  }
  return ts;
}

// Did THIS session write an .html artifact since turnStart? Reads the Board's artifact
// index (stamped by companion-hook/companion-index on every inline write). Returns
// { known, wrote, paths }: known=false when we can't tell (no turn boundary, or a corrupt
// index) so the caller fails open; paths is the abs-path list this session wrote this turn
// (the index KEY is the artifact path) so the content-lint can read them. A MISSING index
// file is a legit empty index (known:true).
function artifactWrittenSince(sessionId, turnStart, indexPath) {
  if (!turnStart) return { known: false, wrote: false, paths: [] };
  let raw;
  try {
    raw = fs.readFileSync(indexPath, "utf8");
  } catch (e) {
    if (e && e.code === "ENOENT") return { known: true, wrote: false, paths: [] };
    return { known: false, wrote: false, paths: [] };
  }
  let index;
  try {
    index = JSON.parse(raw) || {};
  } catch (_) {
    return { known: false, wrote: false, paths: [] };
  }
  const sid = safeId(sessionId);
  const short = sid.slice(0, 8);
  const paths = [];
  for (const [artifactPath, entry] of Object.entries(index)) {
    if (!entry || typeof entry.ts !== "number") continue;
    if (entry.ts < turnStart) continue;
    if (entry.session_id === sid || entry.shortid === short) paths.push(artifactPath);
  }
  return { known: true, wrote: paths.length > 0, paths };
}

// The three DOM markers that give the user a way to RESPOND from the Board without opening
// the terminal: the Next-steps ballot items (✓/✎/✗), the Submit button, and commentable
// blocks (the 💬 affordance). An artifact with none of them strands the user with only the
// fallback chat bar — the exact "questions I can't answer" gap this gate guards.
const RESPONDER_RE = /data-companion-(?:item|submit|commentable)/;

// Do the artifacts written this turn give the user an in-place way to respond? Reads each
// path and looks for a responder marker. Returns { known, any }: known=false when ANY path
// was unreadable (mid-write, moved) so the caller fails OPEN — we only ever block on a
// positive "every artifact this turn was readable and none carried a responder".
function hasAnswerableSurface(paths) {
  let any = false;
  let allReadable = true;
  for (const p of paths) {
    let html;
    try {
      html = fs.readFileSync(p, "utf8");
    } catch (_) {
      allReadable = false;
      continue;
    }
    // Strip <script>/<style> first. The unified helper's OWN source references every marker
    // (querySelector("[data-companion-submit]"), [data-companion-item], …) and the ambient
    // CSS has a [data-companion-commentable] selector — so a pure recap that embeds the
    // helper only for its fallback chat bar would falsely pass. Match against rendered
    // MARKUP only, where these appear solely as real attributes on real elements.
    const markup = html.replace(/<(script|style)[\s\S]*?<\/\1>/gi, "");
    if (RESPONDER_RE.test(markup)) any = true;
  }
  return { known: allReadable, any };
}

function buildReason(artifactsDir) {
  return (
    "This turn ended without a visual artifact on the Companion Board. " +
    "If it was substantive — a decision, comparison, plan, analysis, or a status the user will " +
    "want to see and react to — AUTHOR ONE NOW: write a self-contained .html into " +
    artifactsDir +
    " (load the prefer-html skill for the how). Lead with the decision, cut the recap, end on the " +
    "next move. If you already wrote an artifact this turn, or the turn was trivial (a quick answer, " +
    "a lookup, a conversational reply), just STOP — write nothing and do not restate your answer."
  );
}

// Soft content-lint reason: an artifact landed but there is no way to respond to it in
// place. Decline-able by design — the agent, which alone has the conversation, decides
// whether this one is genuinely look-only.
function buildResponderReason() {
  return (
    "You wrote a Companion artifact this turn, but it gives the user NO way to respond in place — " +
    "no ✓/✎/✗ next-move items (data-companion-item), no Submit (data-companion-submit), and no " +
    "commentable blocks (data-companion-commentable). That strands the user with only the fallback " +
    "chat bar, so the work can't move forward from the Board — they have to open the terminal to " +
    "continue. An artifact should ALMOST ALWAYS end with an answerable surface: a short 'Next steps' " +
    "ballot of concrete moves (✓ do it / ✎ note / ✗ skip), and every question you raised wired as its " +
    "OWN item — a question posed only as prose is a bug. Add one now (load the prefer-html skill / " +
    "references/interaction-helper.md for the wiring). If this is genuinely a look-only artifact — a " +
    "one-line status pill, or a pure celebration with nothing to decide — just STOP; write nothing."
  );
}

// Pure decision — unit-tested. Returns { block, reason? }. Never throws on bad input.
function decide(input, opts) {
  opts = opts || {};
  const indexPath = opts.indexPath || INDEX_PATH;
  const artifactsDir = opts.artifactsDir || ARTIFACTS_DIR;
  input = input || {};
  // Loop guard: never block twice inside one continuation chain.
  if (input.stop_hook_active) return { block: false };
  const turnStart = lastRealUserPromptTs(input.transcript_path);
  const res = artifactWrittenSince(input.session_id, turnStart, indexPath);
  // Fail open on uncertainty (no turn boundary / corrupt index).
  if (!res.known) return { block: false };
  // Nothing written this turn → the "author one" seatbelt.
  if (!res.wrote) return { block: true, reason: buildReason(artifactsDir) };
  // An artifact landed — soft-lint it for an answerable surface. Pass when it has one, or
  // when we couldn't fully verify (fail open); block once when every artifact this turn was
  // readable and none carried a responder.
  const surf = hasAnswerableSurface(res.paths);
  if (surf.any || !surf.known) return { block: false };
  return { block: true, reason: buildResponderReason() };
}

function main() {
  let raw = "";
  process.stdin.on("data", (c) => (raw += c));
  process.stdin.on("end", () => {
    let input = {};
    try {
      input = JSON.parse(raw) || {};
    } catch (_) {}
    let d = { block: false };
    try {
      d = decide(input);
    } catch (_) {
      // Any unexpected error → fail open (never wedge the session).
    }
    if (d.block) process.stdout.write(JSON.stringify({ decision: "block", reason: d.reason }));
    process.exit(0);
  });
}

if (require.main === module) main();
else
  module.exports = {
    lastRealUserPromptTs,
    artifactWrittenSince,
    hasAnswerableSurface,
    decide,
    buildReason,
    buildResponderReason,
    safeId,
  };
