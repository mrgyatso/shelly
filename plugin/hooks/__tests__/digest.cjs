#!/usr/bin/env node
// Unit tests for shelly-digest.cjs — the per-project standing digest producer.
// SANDBOXED: every digest file and git repo is created under a throwaway tmp dir, so this
// never touches live ~/.shelly state or the real repo.

const fs = require("fs");
const os = require("os");
const path = require("path");
const { spawnSync } = require("child_process");

const digest = require("../shelly-digest.cjs");

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

const sandbox = fs.mkdtempSync(path.join(os.tmpdir(), "cmp-digest-"));
const artifacts = path.join(sandbox, "artifacts");
fs.mkdirSync(artifacts, { recursive: true });

const DAY = 86400000;

function writeDigest(unitKey, ageMs) {
  const p = digest.digestPath(unitKey, artifacts);
  fs.writeFileSync(p, "<!doctype html><title>digest</title>");
  if (ageMs) {
    const t = (Date.now() - ageMs) / 1000;
    fs.utimesSync(p, t, t);
  }
  return p;
}

// A throwaway git repo with one commit, so the "behind HEAD" probe has real history.
// `agoMs` backdates that commit — needed to build a repo that genuinely has not been
// touched, rather than one whose only commit happens to be seconds old.
function makeRepo(name, agoMs) {
  const root = path.join(sandbox, name);
  fs.mkdirSync(root, { recursive: true });
  const git = (args, env) =>
    spawnSync("git", ["-C", root, ...args], {
      encoding: "utf8",
      timeout: 5000,
      env: { ...process.env, ...(env || {}) },
    });
  git(["init", "-q"]);
  git(["config", "user.email", "t@example.com"]);
  git(["config", "user.name", "T"]);
  fs.writeFileSync(path.join(root, "a.txt"), "one");
  git(["add", "-A"]);
  const when = agoMs ? new Date(Date.now() - agoMs).toISOString() : null;
  git(
    ["commit", "-q", "-m", "one"],
    when ? { GIT_AUTHOR_DATE: when, GIT_COMMITTER_DATE: when } : null
  );
  return { root, git: (...a) => git(a) };
}

// ---- digestPath -----------------------------------------------------------
// The slug must stay in the shape history.rs excludes from the index and from pruning
// (`stem == "home" || stem.starts_with("home.")`). If this ever drifts, the digest starts
// being indexed as a normal artifact and gets pruned out from under the Board.
{
  const p = digest.digestPath("claude-code-companion", artifacts);
  ok(path.basename(p) === "home.claude-code-companion.html", "digestPath uses the reserved home.<unit>.html slug");
  ok(path.basename(p, ".html").startsWith("home."), "the stem is excluded by history.rs's prefix rule");
}

// ---- missing --------------------------------------------------------------
{
  const s = digest.digestState({ unitKey: "never-written", artifactsDir: artifacts });
  ok(s.exists === false && s.stale === true && s.why === "missing", "a unit with no digest reads as missing");
  const line = digest.buildLine(s);
  ok(/AUTHOR ONE/.test(line), "the missing line instructs the agent to author one");
  ok(line.includes(s.path), "the missing line names the exact path to write");
  ok(/rewrite it IN PLACE|rewrite IN PLACE/i.test(line), "the missing line carries the living-document rule");
}

// ---- repo: commits landed after the digest was written --------------------
{
  const { root, git } = makeRepo("behind-repo");
  writeDigest("behind-repo", 5000); // written 5s ago
  spawnSync("sleep", ["1"]);
  fs.writeFileSync(path.join(root, "b.txt"), "two");
  git("add", "-A");
  git("commit", "-q", "-m", "two");

  const s = digest.digestState({ unitKey: "behind-repo", root, isRepo: true, artifactsDir: artifacts });
  ok(s.stale === true && s.why === "behind", "a digest written before a new commit reads as behind");
  ok(s.commits >= 1, "it reports how many commits landed since");
  const line = digest.buildLine(s);
  ok(/STALE/.test(line) && /commit/.test(line), "the behind line says stale and cites commits");
  ok(/READ IT FIRST/.test(line), "the behind line still tells the agent to read it for orientation");
}

// ---- repo: no commits since the digest ------------------------------------
{
  const { root } = makeRepo("current-repo");
  writeDigest("current-repo"); // written now, after the repo's only commit
  const s = digest.digestState({ unitKey: "current-repo", root, isRepo: true, artifactsDir: artifacts });
  ok(s.stale === false && s.why === null, "a digest newer than HEAD reads as current");
  const line = digest.buildLine(s);
  ok(/is current/.test(line) && /READ IT FIRST/.test(line), "the current line points the agent at it to orient");
  ok(!/AUTHOR ONE/.test(line), "the current line does not ask for a rewrite it does not need");
}

// ---- age is measured against the CODE, not the clock ----------------------
// A repo nobody has touched in months still has an accurate digest. This is the whole
// reason staleness is commit-relative rather than a plain timer.
{
  const { root } = makeRepo("old-but-accurate", 60 * DAY); // last commit 60 days ago
  writeDigest("old-but-accurate", 30 * DAY); // digest written 30 days ago — after it
  const s = digest.digestState({ unitKey: "old-but-accurate", root, isRepo: true, artifactsDir: artifacts });
  ok(s.stale === false, "a month-old digest on an untouched repo is NOT stale");
}

// ---- non-repo: the age cap is the fallback --------------------------------
{
  writeDigest("one-off-dir", 5 * DAY);
  const s = digest.digestState({ unitKey: "one-off-dir", isRepo: false, artifactsDir: artifacts });
  ok(s.stale === true && s.why === "aged", "a non-repo digest past the age cap reads as aged");
  ok(s.days >= 4, "it reports its age in days");
  ok(/has not been updated/.test(digest.buildLine(s)), "the aged line says so plainly");
}
{
  writeDigest("fresh-dir", 1 * DAY);
  const s = digest.digestState({ unitKey: "fresh-dir", isRepo: false, artifactsDir: artifacts });
  ok(s.stale === false, "a non-repo digest inside the age cap is current");
}

// ---- fail-quiet -----------------------------------------------------------
// Every uncertainty must degrade to silence, never to a throw: this runs inside
// SessionStart, where an exception costs the whole session.
{
  ok(digest.commitsSince(path.join(sandbox, "not-a-repo"), Date.now()) === null, "commitsSince returns null outside a repo");
  ok(digest.commitsSince("", Date.now()) === null, "commitsSince returns null with no root");

  // A repo path that exists but has no git history → null, so digestState falls through
  // to the age cap instead of guessing.
  const bare = path.join(sandbox, "bare-dir");
  fs.mkdirSync(bare, { recursive: true });
  writeDigest("bare-unit", 1 * DAY);
  const s = digest.digestState({ unitKey: "bare-unit", root: bare, isRepo: true, artifactsDir: artifacts });
  ok(s.stale === false, "an unreadable git falls back to the age cap rather than forcing a rewrite");

  ok(digest.line({}) !== undefined, "line() survives an empty opts object");
  ok(digest.buildLine(null) === "", "buildLine(null) is empty, not a throw");
  ok(digest.buildLine({}) === "", "buildLine on a stateless object is empty");
}

// ---- the content contract --------------------------------------------------
// Every write path quotes CONTENT_BRIEF, so the command deck has to be reachable from all
// of them — a digest that describes the project but never says how to start it leaves the
// reader exactly where they were.
{
  const missing = digest.buildLine({ path: "/x/home.u.html", exists: false, stale: true, why: "missing" });
  const behind = digest.buildLine({ path: "/x/home.u.html", exists: true, stale: true, why: "behind", commits: 3 });
  const aged = digest.buildLine({ path: "/x/home.u.html", exists: true, stale: true, why: "aged", days: 9 });
  for (const [name, line] of [["missing", missing], ["behind", behind], ["aged", aged]]) {
    ok(/FREQUENT COMMANDS/.test(line), `the ${name} line asks for the command deck`);
    ok(/data-copy/.test(line), `the ${name} line names the copyable markup`);
  }
  ok(/READ OUT of/.test(missing), "commands are to be read from the repo, not guessed");
}

// ---- the CLI surface the sh wrapper actually calls -------------------------
{
  const r = spawnSync("node", [path.join(__dirname, "..", "shelly-digest.cjs"), "line", "cli-unit", "", "0"], {
    encoding: "utf8",
    env: { ...process.env, SHELLY_ARTIFACTS_DIR: artifacts },
  });
  ok(r.status === 0, "the CLI exits 0");
  ok(/AUTHOR ONE/.test(r.stdout), "the CLI prints the missing-digest line for an unwritten unit");
  ok(r.stdout.includes(artifacts), "the CLI honours SHELLY_ARTIFACTS_DIR");

  const bad = spawnSync("node", [path.join(__dirname, "..", "shelly-digest.cjs")], { encoding: "utf8" });
  ok(bad.status === 0 && bad.stdout === "", "the CLI with no args exits 0 and says nothing");
}

console.log(`\n  ${pass} passed, ${fail} failed`);
try {
  fs.rmSync(sandbox, { recursive: true, force: true });
} catch (_) {}
process.exit(fail ? 1 : 0);
