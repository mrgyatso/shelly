#!/usr/bin/env node
// companion-artifact-gate.cjs — the logic behind the Stop-hook seatbelt.
//
// Artifacts are authored INLINE by the agent (the proactive path), guided by the pattern
// INDEX in the SessionStart injection and the prefer-html skill it pulls PROACTIVELY when it
// picks a pattern — no background observer, no deterministic renderer. This module is the
// seatbelt: at turn-end it checks two MECHANICAL facts and hands control back ONCE
// (decision:block) so the agent fixes it in full, warm-cache context:
//   1. Did an .html artifact land during THIS turn? If not → "author one".
//   2. If one did, does it give the user a way to RESPOND in place (a Next-steps ballot,
//      a Submit, commentable blocks, or a custom-wired ballot that posts a submit to the
//      Board)? If it has none of those → "graft an answerable surface on".
//
// THE GATE IS THE FLOOR, AND IT IS SELF-SUFFICIENT. Both block messages spell out the
// mechanical minimum INLINE — the required head/charset, the size-reporter, companion-meta,
// and the answerable-surface wiring — so the agent needs nothing else to comply. Crucially,
// the reactive path NEVER tells the agent to load a skill: the block instructs a GRAFT onto
// the design the agent already wrote (keep the look, add the plumbing), because a "load the
// skill" remedy once caused an agent to REWRITE a working bespoke artifact into the house
// style and destroy the design the user loved. The skill is the PROACTIVE pattern library,
// pulled when choosing a pattern — never a block remedy.
//
// THE RULE IS ABSOLUTE: every turn ends with an artifact, and every artifact ends with a
// next step. There is no trivial-turn exemption and no look-only exemption. If you are in
// the app you are here for the artifact — the off switch is which TERMINAL you're in (the
// external-terminals guard in the sh wrapper), not a mode, and not the agent's judgment
// call turn by turn. Both block reasons therefore INSTRUCT rather than ask: "author one",
// "graft the responder". The gate still judges nothing about substance — the agent sizes the
// artifact to the turn (a lookup earns a compact card, not a padded document) — but it no
// longer gets to decide that a turn earns nothing at all.
//
// Fail-OPEN by design. A false block would nag forever and push duplicate/needless
// artifacts — strictly worse than a missed seatbelt (the proactive path already covers the
// common case). So on ANY uncertainty we do NOT block: check (1) blocks only when the index
// is readable and nothing this session wrote landed since this turn began; check (2) blocks
// only when EVERY artifact this turn was readable and none carried a responder signal.
//
// Loop guard: stop_hook_active is true only inside a continuation this hook itself drove;
// it resets on the next real user prompt, so the seatbelt still fires every fresh turn.
//
// The external-terminals guard lives in the sh wrapper (companion-artifact-gate), mirroring
// companion-observe — so this module is pure gate logic and is unit-tested directly.

const fs = require("fs");
const os = require("os");
const path = require("path");

// The turn boundary is SHARED with the PreToolUse fork hook (companion-artifact-fork.cjs)
// — one derivation, required by both, rather than two copies drifting apart. Co-located;
// fall back to a null-returning stub if the require ever hiccups, which lands on the gate's
// EXISTING uncertainty path (turnStart null → known:false → fail open), never a crash.
let turn = { lastRealUserPromptTs: () => null };
try {
  turn = require("./companion-turn.cjs");
} catch (_) {}

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
// Derived by the shared companion-turn.cjs (see its header for the tool_result skip and
// the transcript-lag caveat); re-exported here so this module's public surface — and its
// tests — are unchanged by the extraction.
function lastRealUserPromptTs(transcriptPath) {
  return turn.lastRealUserPromptTs(transcriptPath);
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

// Signal 2 marker: the page's JS posts a submit to the Board (a custom-wired ballot emits
// this from its own inline script, under whatever attribute names it likes). Matched against
// the RAW html (scripts included), then gated on a real <button being present in the MARKUP.
const SUBMIT_POST_RE = /kind:\s*["']submit["']/;

// Do the artifacts written this turn give the user an in-place way to respond? Reads each
// path and applies a two-signal check. Returns { known, any }: known=false when ANY path was
// unreadable (mid-write, moved) so the caller fails OPEN — we only ever block on a positive
// "every artifact this turn was readable and none carried EITHER signal".
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
    // Signal 1 — the standard house markers in the markup.
    if (RESPONDER_RE.test(markup)) {
      any = true;
      continue;
    }
    // Signal 2 — a working custom-wired ballot. It counts when BOTH the RAW html posts a
    // submit (kind:"submit", scripts included) AND the stripped markup has a real <button.
    // This admits a beautifully bespoke ballot that never touches the house attribute names
    // (data-a="do", id="submit", a clipboard-only submit) — the exact case that used to
    // false-block. TRADEOFF: a pure recap that merely EMBEDS the unified helper also carries
    // kind:"submit" in its script source — but the helper injects its chat-bar button at
    // RUNTIME, so the static markup has no <button; requiring a markup <button keeps that
    // recap blocked while letting the genuine custom ballot through.
    if (SUBMIT_POST_RE.test(html) && /<button\b/i.test(markup)) any = true;
  }
  return { known: allReadable, any };
}

function buildReason(artifactsDir) {
  return (
    "This turn ended with no artifact on the Companion Board. THE RULE IS ABSOLUTE: every turn " +
    "ends with one, with no exemptions. AUTHOR IT NOW: write a self-contained .html into " +
    artifactsDir +
    ". Size it to the turn — a decision, plan, review or analysis earns a full document; a quick " +
    "answer or a lookup earns a COMPACT CARD, not a padded one. The mechanical floor, inline (you " +
    'need nothing else): (a) a real <head> with <meta charset="utf-8">; (b) data-fit-root on the ' +
    "main wrapper plus the size-report snippet at the end of <body> — it posts " +
    "{source:'companion-artifact',kind:'size',w,h} to parent so the overlay can size the frame; " +
    "(c) a companion-meta JSON <script> block in the head; (d) an ANSWERABLE SURFACE — a short " +
    "'Next steps' ballot (✓ do it / ✎ note / ✗ skip), each move marked data-companion-item and the " +
    "Submit button marked data-companion-submit, whose click posts " +
    "parent.postMessage({source:'companion-artifact',kind:'submit',text},'*'). Every artifact ends " +
    "by showing the user where they stand and what happens next; even when the work is finished, " +
    "say so and hand them the next move as a surface they can answer in place. You may copy the " +
    "size-reporter and ballot wiring verbatim from any recent .html in " +
    artifactsDir +
    ". Only STOP if you already wrote an artifact this turn and it simply hasn't been indexed yet."
  );
}

// Soft content-lint reason: an artifact landed but there is no way to respond to it in
// place. The fix is a GRAFT onto the page the agent already wrote — never a restyle, never a
// skill load, because that is what once destroyed a working bespoke design.
function buildResponderReason() {
  return (
    "You wrote a Companion artifact this turn, but it gives the user NO way to respond in place — " +
    "no ✓/✎/✗ next-move items (data-companion-item), no Submit (data-companion-submit), no " +
    "commentable blocks (data-companion-commentable), and no custom ballot that posts a submit to " +
    "the Board. That strands the user with only the fallback chat bar. GRAFT an answerable surface " +
    "onto the page you ALREADY wrote — keep your design exactly as it is; do NOT restyle it, do NOT " +
    "rebuild it, do NOT reach for a template or reference. The minimal wiring: mark each next-move with " +
    "data-companion-item + a data-item-label, add one data-companion-submit button, and have its " +
    "click post {source:'companion-artifact',kind:'submit',text} to parent. If the page ALREADY has " +
    'a working ballot under custom names (e.g. data-a="do", id="submit", a clipboard submit), the ' +
    "fix is just adding those marker attributes and the postMessage — a ~5-line graft, not a " +
    "redesign. This holds even when the work is DONE: say it's done, then hand over the next move " +
    "('nothing left here — here's what I'd pick up next, or tell me where to go'). And every " +
    "question you raised must be its OWN clickable item — a question posed only as prose is a bug."
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
