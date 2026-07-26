/**
 * The 5,000-token re-attach budget for `prefer-html/SKILL.md`.
 *
 * WHY THIS EXISTS. From the Claude Code docs on skills:
 *
 *   "Auto-compaction carries invoked skills forward within a token budget. When the
 *    conversation is summarized to free context, Claude Code re-attaches the most recent
 *    invocation of each skill after the summary, KEEPING THE FIRST 5,000 TOKENS OF EACH.
 *    Re-attached skills share a combined budget of 25,000 tokens."
 *
 * So after any compaction, everything past ~5,000 tokens of this file is gone for the rest
 * of the session. Shelly's rule is that every turn ends with an artifact, which means the
 * sessions writing the MOST artifacts are exactly the ones that have compacted.
 *
 * That makes the first 5,000 tokens a real budget rather than a curiosity: §1 (the
 * invariants, including the mechanical floor in §1.4) and §2 (the pattern selector) must
 * fit inside it, because they are what a post-compaction turn has left to work from.
 * Everything after — the templates, the interaction layer, the house style — is craft on
 * top of a floor that still has to hold on its own.
 *
 * HONESTY ABOUT WHAT THIS DOES NOT SHOW. The correlation was run over 857 artifacts and
 * found NO measurable quality drop after a compact boundary: 💬 presence moved -0.9pp
 * within-session against a -1.6pp never-compacted control. So this guard is insurance on a
 * mechanism that is documented and real, not a fix for a demonstrated regression. It is
 * cheap; that is the whole argument for it.
 *
 * The bytes-per-token figure is calibrated, not assumed: `claude plugin details shelly`
 * reported ~38.9k tokens for the 99,059-byte version of this file, which is 2.55 B/tok.
 * HTML- and CSS-dense markdown tokenises far worse than prose, where ~4 would be right.
 */
"use strict";
const fs = require("node:fs");
const path = require("node:path");

const SKILL = path.join(__dirname, "..", "..", "skills", "prefer-html", "SKILL.md");

/** Calibrated against the CLI's own reported count for this exact file. */
const BYTES_PER_TOKEN = 2.55;
/** What auto-compaction re-attaches, per the docs quoted above. */
const REATTACH_TOKENS = 5000;
/** Headroom, so a one-line edit doesn't fail CI the day the file lands exactly on the line.
 *  Small on purpose: the budget is a real ceiling, not a target to grow into. */
const MARGIN_TOKENS = 150;

const src = fs.readFileSync(SKILL, "utf8");
const lines = src.split("\n");

/** Byte offset at which a heading starts, or -1. */
function offsetOfHeading(prefix) {
  let bytes = 0;
  for (const line of lines) {
    if (line.startsWith(prefix)) return bytes;
    bytes += Buffer.byteLength(line) + 1;
  }
  return -1;
}

const tokensAt = (bytes) => bytes / BYTES_PER_TOKEN;

let failed = 0;
function check(name, cond, detail) {
  console.log(`  ${cond ? "✓" : "✗"} ${name}${detail ? ` — ${detail}` : ""}`);
  if (!cond) failed++;
}

console.log("### prefer-html/SKILL.md survives a compaction with its floor intact");

// The floor is everything up to the start of §3 — i.e. §1 and §2 complete.
const startOfThree = offsetOfHeading("# 3 · ");
check("§3 exists, so the floor has a defined end", startOfThree > 0);

const floorTokens = tokensAt(startOfThree);
check(
  `§1 + §2 fit inside the ${REATTACH_TOKENS.toLocaleString()}-token re-attach budget`,
  floorTokens <= REATTACH_TOKENS - MARGIN_TOKENS,
  `${Math.round(floorTokens).toLocaleString()} tok used, ` +
    `${Math.round(REATTACH_TOKENS - MARGIN_TOKENS - floorTokens).toLocaleString()} to spare`,
);

// The mechanical floor is the part a post-compaction turn cannot do without: it is what
// makes an artifact WORK, as opposed to what makes it good. Pin its contents by name, so
// moving one of these downstream fails here rather than silently in a long session.
const floor = src.slice(0, startOfThree);
for (const [what, needle] of [
  ["charset", "meta charset"],
  ["data-fit-root", "data-fit-root"],
  ["the shelly-meta block", "shelly-meta"],
  ["data-shelly-commentable", "data-shelly-commentable"],
  ["the ballot item attribute", "data-shelly-item"],
  ["the ballot label attribute", "data-item-label"],
  ["the submit attribute", "data-shelly-submit"],
  ["the action attribute", "data-action"],
  ["write with Write, not Bash", "`Write` tool"],
]) {
  check(`the floor names ${what}`, floor.includes(needle));
}

// The floor must not tell the model to produce something the hook injects — that is how a
// contradictory instruction gets in, and past compaction it is the ONLY instruction left.
for (const [what, rx] of [
  ["paste the helper verbatim", /VERBATIM/],
  ["include the size-reporter snippet", /size-reporter\s+snippet\*{0,2}\s+at the end/],
]) {
  check(`the floor does not ask the model to ${what}`, !rx.test(floor));
}

// And the whole file: no instruction to copy a helper that is now injected.
// Narrowly: the MODEL being told to copy a helper. §4.5 legitimately tells the model to give
// the USER a copy button for handoff content, and an earlier draft of this check flagged that.
check(
  "no instruction to copy a helper script into an artifact survives",
  !/(?:copy|paste)[^.\n]{0,60}(?:helper|interaction-helper\.md)[^.\n]{0,60}verbatim/i.test(src) &&
    !/VERBATIM/.test(src),
);

console.log(
  `\n  file: ${lines.length.toLocaleString()} lines, ` +
    `~${Math.round(tokensAt(Buffer.byteLength(src))).toLocaleString()} tok total, ` +
    `floor ends at line ${src.slice(0, startOfThree).split("\n").length}`,
);

// ---------------------------------------------------------------------------
// The OTHER floor: the always-on session context.
//
// `shelly-session` runs on SessionStart — including `SessionStart:compact`, so unlike the
// skill body this text is RE-INJECTED after every compaction. It is therefore the only
// artifact guidance guaranteed to be present on every turn of a long session, which makes
// it the real backstop and makes any staleness in it expensive: a false instruction here
// is a false instruction the model can never lose.
//
// (This is almost certainly why the compaction correlation came back null. The mitigation
// already existed; it just had not been kept in step with the injector.)
// ---------------------------------------------------------------------------
console.log("\n### the always-on session context is a complete, truthful floor");

const { spawnSync } = require("node:child_process");
const hook = path.join(__dirname, "..", "shelly-session");
const run = spawnSync("bash", [hook], {
  input: JSON.stringify({
    session_id: "skillbudget-probe",
    cwd: path.join(__dirname, "..", "..", ".."),
    source: "compact",
  }),
  env: {
    ...process.env,
    SHELLY_ARTIFACTS_DIR: require("node:os").tmpdir() + "/shelly-probe",
    // A Board-started session. Without this the hook takes its external-terminals
    // early-exit and emits nothing at all — correct behaviour, and how this check first
    // failed in CI while passing on a machine that has external terminals switched on.
    SHELLY_SESSION: "1",
  },
  encoding: "utf8",
});

let ctx = "";
try {
  ctx = JSON.parse(run.stdout || "{}").hookSpecificOutput?.additionalContext ?? "";
} catch {
  /* falls through to the check below */
}
check("the hook emits parseable SessionStart context", ctx.length > 500, `${ctx.length} bytes`);

if (ctx) {
  // Everything the injector CONSUMES but cannot invent. Marker attributes the model fails to
  // write are the one failure the frame cannot repair — `ensureCommentable` falls back to the
  // fit-root, and an unmarked ballot has nothing to bind to.
  for (const needle of [
    "meta charset",
    "data-fit-root",
    "shelly-meta",
    "data-shelly-commentable",
    "data-shelly-item",
    "data-item-label",
    "data-action",
    "data-shelly-submit",
  ]) {
    check(`the always-on floor names ${needle}`, ctx.includes(needle));
  }
  // …and must not ask for what the hook now supplies, nor describe the skill as it used to be.
  check(
    "it does not ask for the injected size reporter",
    !/size-reporter script/.test(ctx),
    "the frame injects it; asking produces a duplicate and a false instruction",
  );
  check(
    "it does not claim the skill carries a helper to paste",
    !/carrying the interaction helper/.test(ctx),
  );
  console.log(`\n  always-on context: ${ctx.length} bytes, ~${Math.round(ctx.length / 4)} tok, `
    + "paid on EVERY session start and re-paid on every compaction");
}

console.log(`\n${failed} failed`);
process.exit(failed === 0 ? 0 : 1);
