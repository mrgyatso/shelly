#!/usr/bin/env node
// companion-artifact-gate.cjs — the logic behind the Stop-hook seatbelt.
//
// Artifacts are now authored INLINE by the agent (the proactive path), guided by the
// html-output rule + prefer-html skill it carries in context — no background observer,
// no deterministic renderer. This is the seatbelt: at turn-end it checks ONE mechanical
// fact — did an .html artifact land during THIS turn? — and if not, hands control back
// ONCE (decision:block) so the agent authors it in full, warm-cache context. It JUDGES
// NOTHING about substance; the block reason puts that call on the agent, which alone has
// the conversation. The user re-judges nothing either — the agent does, in-context.
//
// Fail-OPEN by design. A false "nothing written" (unreadable index/transcript) that
// blocked would nag forever and push duplicate artifacts — strictly worse than a missed
// seatbelt (the proactive path already covers the common case). So on ANY uncertainty we
// do NOT block; we only block when we can positively confirm "index readable, and nothing
// this session wrote landed since this turn began".
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
// { known, wrote }: known=false when we can't tell (no turn boundary, or a corrupt index)
// so the caller fails open. A MISSING index file is a legit empty index (known:true).
function artifactWrittenSince(sessionId, turnStart, indexPath) {
  if (!turnStart) return { known: false, wrote: false };
  let raw;
  try {
    raw = fs.readFileSync(indexPath, "utf8");
  } catch (e) {
    if (e && e.code === "ENOENT") return { known: true, wrote: false };
    return { known: false, wrote: false };
  }
  let index;
  try {
    index = JSON.parse(raw) || {};
  } catch (_) {
    return { known: false, wrote: false };
  }
  const sid = safeId(sessionId);
  const short = sid.slice(0, 8);
  for (const entry of Object.values(index)) {
    if (!entry || typeof entry.ts !== "number") continue;
    if (entry.ts < turnStart) continue;
    if (entry.session_id === sid || entry.shortid === short) return { known: true, wrote: true };
  }
  return { known: true, wrote: false };
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
  // Fail open on uncertainty; pass when an artifact already landed this turn.
  if (!res.known || res.wrote) return { block: false };
  return { block: true, reason: buildReason(artifactsDir) };
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
else module.exports = { lastRealUserPromptTs, artifactWrittenSince, decide, buildReason, safeId };
