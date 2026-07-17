#!/usr/bin/env node
// shelly-turn.cjs — the ONE derivation of "when did this turn start".
//
// WHY THIS FILE EXISTS: two hooks need the turn boundary, and they must agree.
// The Stop-hook seatbelt (shelly-artifact-gate.cjs) asks "did an artifact land
// since this turn began?"; the PreToolUse fork hook (shelly-artifact-fork.cjs)
// asks "was this artifact sealed in an EARLIER turn?". Same fact, two callers — and
// every identity bug this project has hit was two derivations of one fact drifting
// apart (see shelly-identity.cjs's header for the same lesson). So it is derived
// here, once, and required by both.
//
// CAVEAT THE CALLERS MUST RESPECT: Claude Code writes the transcript ASYNCHRONOUSLY.
// The docs are explicit that it "may lag the in-memory conversation, so it may not yet
// include the current turn's most recent messages when a hook fires". At Stop that lag
// is harmless (the turn's user prompt landed long ago). MID-TURN — where the fork hook
// lives — it is not: the newest prompt may still be missing, so this returns the
// PREVIOUS turn's start and everything looks older than it is. That is why the fork
// hook prefers the payload's `prompt_id` (an identity, not a clock) and only falls back
// to this. Do not "fix" the lag here; it is a property of the file, not of this code.

const fs = require("fs");

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

module.exports = { lastRealUserPromptTs };
