#!/usr/bin/env node
// shelly-digest.cjs — the producer side of the per-project standing digest.
//
// The Board has always been able to SHOW a per-project digest: history.rs deliberately
// keeps `home.<unit_key>.html` out of the artifact index and out of pruning so it can live
// forever, and board.ts's renderHero() prefers it over a unit's most recent artifact, so
// entering a project lands on it full-bleed. The receiver was finished; nothing ever wrote
// one. Zero digests had existed on disk. This module is the missing producer.
//
// It does not author the HTML — it decides whether this unit's digest is MISSING, STALE, or
// current, and returns the one line the SessionStart hook injects into the agent's context.
// The agent (which is about to read the repo anyway) writes it.
//
// SESSIONSTART, NOT STOP — deliberately. "Arriving at a project" is exactly when the digest
// earns its keep and exactly when refreshing it is nearly free: the agent is orienting
// regardless. A Stop-hook nudge would fire at the end of every turn and nag for a document
// that only changes meaningfully between sessions.
//
// STALENESS IS MEASURED AGAINST THE CODE, NOT THE CLOCK. A digest written before commits
// that have since landed is wrong no matter how recently it was written; a digest on a repo
// nobody has touched in a month is still accurate. So the primary test is "have commits
// landed since this file was written", with a plain age cap as the fallback for non-repos.
//
// FAIL-QUIET by design. Every uncertainty — no git, an unreadable stat, a spawn that fails —
// returns "" and the session proceeds untouched. A missing digest costs some orientation; a
// SessionStart hook that throws costs the session.

const fs = require("fs");
const os = require("os");
const path = require("path");
const { spawnSync } = require("child_process");

const HOME = os.homedir();

// Non-repo fallback: a one-off directory has no commit history to measure against, so the
// only available signal is age. Deliberately generous — re-authoring a digest for a
// directory that has not changed is pure cost.
const STALE_AFTER_MS = 3 * 24 * 60 * 60 * 1000;

// Guard against a pathological repo (or a wrong --since) turning one cheap probe into a
// long walk. We only ever need "0 or more than 0", so a small cap is plenty.
const GIT_TIMEOUT_MS = 1500;

function artifactsDir() {
  return process.env.SHELLY_ARTIFACTS_DIR || path.join(HOME, ".shelly", "artifacts");
}

/** The reserved living slug for a unit. Mirrors the exclusion rule in history.rs
 *  (`stem == "home" || stem.starts_with("home.")`) — keep the two in step. */
function digestPath(unitKey, dir) {
  return path.join(dir || artifactsDir(), `home.${unitKey}.html`);
}

/** Commits on HEAD since `sinceMs`, or null when we cannot tell (not a repo, git missing,
 *  timeout). null is the uncertainty signal and always lands on the fail-quiet path.
 *
 *  The +1 is load-bearing: git's `--since=@T` is INCLUSIVE, so a commit made in the same
 *  second the digest was written would count as "after" it — and since writing the digest
 *  right after committing is the normal flow, that reads as permanently behind. Excluding
 *  the boundary second costs us only a commit landing in the very same second AFTER the
 *  write, which the next commit picks up anyway. */
function commitsSince(root, sinceMs) {
  if (!root) return null;
  try {
    const r = spawnSync(
      "git",
      ["-C", root, "rev-list", "--count", "HEAD", `--since=@${Math.floor(sinceMs / 1000) + 1}`],
      { encoding: "utf8", timeout: GIT_TIMEOUT_MS }
    );
    if (r.error || r.status !== 0) return null;
    const n = parseInt(String(r.stdout).trim(), 10);
    return Number.isFinite(n) ? n : null;
  } catch (_) {
    return null;
  }
}

/**
 * Decide what this unit's digest needs. Pure apart from one stat and (only when the file
 * exists on a repo) one `git rev-list --count`.
 *
 * Returns { path, exists, stale, why } where `why` is one of:
 *   "missing"     — no digest has ever been written for this unit
 *   "behind"      — commits landed after the digest was written  (repos)
 *   "aged"        — untouched for longer than STALE_AFTER_MS     (non-repos, or no git)
 *   null          — current
 */
function digestState(opts) {
  opts = opts || {};
  const now = typeof opts.now === "number" ? opts.now : Date.now();
  const p = digestPath(opts.unitKey, opts.artifactsDir);

  let mtime;
  try {
    mtime = fs.statSync(p).mtimeMs;
  } catch (_) {
    return { path: p, exists: false, stale: true, why: "missing" };
  }

  // Repo: measure against the code. A digest older than commits that have since landed is
  // stale by definition, however recently it was written.
  if (opts.isRepo && opts.root) {
    const n = commitsSince(opts.root, mtime);
    if (n !== null) {
      return n > 0
        ? { path: p, exists: true, stale: true, why: "behind", commits: n }
        : { path: p, exists: true, stale: false, why: null };
    }
    // git unavailable/timed out → fall through to the age cap rather than guessing.
  }

  const ageMs = now - mtime;
  if (ageMs > STALE_AFTER_MS) {
    return { path: p, exists: true, stale: true, why: "aged", days: Math.floor(ageMs / 86400000) };
  }
  return { path: p, exists: true, stale: false, why: null };
}

// What the digest has to answer. Kept in one place because all three lines below quote it,
// and because it is the actual contract with the reader arriving cold.
const CONTENT_BRIEF =
  "what this project IS (two sentences, for someone who forgot), what we LAST did, what the " +
  "NEXT objective was, the honest STATE (shipping · mid-refactor · blocked · parked · cold) " +
  "including the loose ends that actually block progress, and the RANKED next moves with one " +
  "recommended and why";

// The living-document rule, repeated in both write paths because it is the one way this
// artifact differs from every other one and the one-turn-one-slug rule points the other way.
const LIVING =
  "This is the ONE artifact you rewrite IN PLACE — it is a living document keyed to the " +
  "project, not a turn artifact, so keep this exact path forever rather than minting a new " +
  "slug. It still carries the normal mechanical floor: <meta charset>, data-fit-root plus " +
  "the size reporter, a shelly-meta block, and an answerable surface. Write it as part of " +
  "this session's first substantive turn — in ADDITION to that turn's own artifact, not " +
  "instead of it.";

/** The context line for the SessionStart injection. "" when there is nothing to say. */
function buildLine(state) {
  if (!state || !state.path) return "";

  if (state.why === "missing") {
    return (
      `Project digest: this project has no standing digest yet. AUTHOR ONE at ${state.path} — ` +
      `the living per-project home the Board shows full-bleed whenever this project is opened, ` +
      `so arriving here answers itself. It covers ${CONTENT_BRIEF}. ${LIVING}`
    );
  }

  if (state.why === "behind") {
    const n = state.commits;
    return (
      `Project digest: ${state.path} is STALE — ${n} commit${n === 1 ? "" : "s"} landed after it ` +
      `was last written, so it now describes a codebase that has moved. READ IT FIRST to orient ` +
      `yourself, then REFRESH IT IN PLACE once you know what changed. It covers ${CONTENT_BRIEF}. ` +
      LIVING
    );
  }

  if (state.why === "aged") {
    return (
      `Project digest: ${state.path} has not been updated in ${state.days} days. READ IT FIRST to ` +
      `orient yourself, then REFRESH IT IN PLACE if this session shows it is out of date. It ` +
      `covers ${CONTENT_BRIEF}. ${LIVING}`
    );
  }

  // Current — the common steady state. Still worth one line: the whole point of the digest is
  // that arriving at a project is self-answering, and the agent is a reader here too.
  return (
    `Project digest: ${state.path} is current — READ IT FIRST to orient yourself (what this is, ` +
    `what we last did, what was next). Keep it accurate: if this session changes any of those ` +
    `answers, rewrite it in place before you finish.`
  );
}

/** One call for the sh wrapper. Never throws. */
function line(opts) {
  try {
    return buildLine(digestState(opts));
  } catch (_) {
    return "";
  }
}

function main() {
  // node shelly-digest.cjs line <unit_key> <root> <is_repo>
  const [cmd, unitKey, root, isRepo] = process.argv.slice(2);
  if (cmd !== "line" || !unitKey) process.exit(0);
  process.stdout.write(line({ unitKey, root, isRepo: isRepo === "1" }));
  process.exit(0);
}

if (require.main === module) main();
else
  module.exports = {
    STALE_AFTER_MS,
    artifactsDir,
    digestPath,
    commitsSince,
    digestState,
    buildLine,
    line,
  };
