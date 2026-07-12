#!/usr/bin/env node
// Home-shelf + adoption verification — SANDBOXED (throwaway HOME, never touches the live
// session's ~/.claude/companion state). Drives the REAL hook path end to end:
// companion-session → companion-livepath.sh → companion-hook → companion-adopt.cjs.
//
// The invariants under test:
//   * a $HOME-launched session lands on the shared "__home__" shelf, NOT in a unit named
//     after the user's username, and is latched as homeless (eligible to graduate);
//   * a session in a real dir is NEVER latched (it has nothing to graduate to);
//   * adoption fires on the first WRITE into a git repo that isn't $HOME — and not on a
//     write into ~/.claude, nor into a plain non-repo dir;
//   * adoption is ONE-WAY: once rooted, a later write into a DIFFERENT repo cannot move
//     it again (this is the guard against reintroducing the cwd-fork the identity freeze
//     exists to prevent);
//   * adoption SURVIVES resume/compact (the old code re-derived root from cwd, which
//     would silently un-adopt and drop the session back onto the Home shelf);
//   * artifacts written BEFORE adoption are re-stamped to the new unit, so the session's
//     history doesn't split across two shelves once it closes.

const fs = require("fs");
const os = require("os");
const path = require("path");
const { execFileSync } = require("child_process");

const HOOKS = path.join(__dirname, "..");
const SESSION_HOOK = path.join(HOOKS, "companion-session");
const WRITE_HOOK = path.join(HOOKS, "companion-hook");

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

function mkSandbox(tag) {
  // realpath: on macOS os.tmpdir() is a /var symlink, and the hooks compare canonical
  // paths ($HOME vs a git root), so an un-resolved HOME would never compare equal.
  const home = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), `cmp-home-${tag}-`)));
  fs.mkdirSync(path.join(home, ".claude", "companion", "logs"), { recursive: true });
  fs.writeFileSync(path.join(home, ".claude", "companion", "external-terminals"), "on");
  return home;
}

function runSession({ home, cwd, session_id }) {
  const env = { ...process.env, HOME: home };
  delete env.COMPANION_SESSION;
  execFileSync("sh", [SESSION_HOOK], {
    input: JSON.stringify({ cwd, session_id }),
    env,
    encoding: "utf8",
  });
}

/** A Write through the REAL PostToolUse hook — the path adoption actually rides. */
function runWrite({ home, cwd, session_id, file_path }) {
  const env = { ...process.env, HOME: home };
  delete env.COMPANION_SESSION;
  execFileSync("sh", [WRITE_HOOK], {
    input: JSON.stringify({
      cwd,
      session_id,
      hook_event_name: "PostToolUse",
      tool_name: "Write",
      tool_input: { file_path, content: "x" },
    }),
    env,
    encoding: "utf8",
  });
}

const cmp = (home, ...p) => path.join(home, ".claude", "companion", ...p);
const readJson = (p, d) => (fs.existsSync(p) ? JSON.parse(fs.readFileSync(p, "utf8")) : d);
const sessionDirs = (home) => readJson(cmp(home, "session-dirs.json"), {});
const liveStems = (home) =>
  fs.existsSync(cmp(home, "live"))
    ? fs.readdirSync(cmp(home, "live")).filter((f) => f.endsWith(".json"))
    : [];
const isHomeless = (home, short) => fs.existsSync(cmp(home, "homeless", short));
const recordOf = (home, sid) => readJson(cmp(home, "sessions", sid + ".json"), null);
const liveOf = (home, stem) => readJson(cmp(home, "live", stem + ".json"), null);

/** A git repo at <home>/<name> — i.e. a project the agent creates from a home session. */
function mkRepo(home, name) {
  const dir = path.join(home, name);
  fs.mkdirSync(dir, { recursive: true });
  execFileSync("git", ["init", "-q"], { cwd: dir });
  return dir;
}

// ---- Case 1: a $HOME session lands on the Home shelf and is latched homeless ----
console.log("\nCase 1 — session launched in $HOME:");
{
  const home = mkSandbox("shelf");
  const sid = "aaaaaaaa-0000-0000-0000-000000000001";
  const short = sid.slice(0, 8);
  runSession({ home, cwd: home, session_id: sid });

  const rec = recordOf(home, sid);
  ok(rec !== null, "record written");
  ok(rec && rec.unit_key === "__home__", "unit_key === '__home__' (NOT the username)");
  ok(rec && rec.unit_key !== path.basename(home), "unit_key is not basename($HOME)");
  ok(isHomeless(home, short), "homeless latch set (eligible to graduate)");
  ok(Object.values(sessionDirs(home))[0] === home, "session-dirs root === $HOME");
  const stem = liveStems(home)[0];
  ok(liveOf(home, stem.slice(0, -5)).unit_key === "__home__", "live stub carries '__home__'");
}

// ---- Case 2: a session in a REAL dir is never latched ----
console.log("\nCase 2 — session in a real repo → never homeless:");
{
  const home = mkSandbox("rooted");
  const repo = mkRepo(home, "already-a-project");
  const sid = "bbbbbbbb-0000-0000-0000-000000000002";
  runSession({ home, cwd: repo, session_id: sid });
  ok(!isHomeless(home, sid.slice(0, 8)), "no homeless latch");
  ok(recordOf(home, sid).unit_key === "already-a-project", "unit_key === the repo dir");
}

// ---- Case 3: writes that must NOT adopt ----
console.log("\nCase 3 — writes that must NOT trigger adoption:");
{
  const home = mkSandbox("noadopt");
  const sid = "cccccccc-0000-0000-0000-000000000003";
  const short = sid.slice(0, 8);
  runSession({ home, cwd: home, session_id: sid });

  // an artifact — Companion's own plumbing is not project work
  runWrite({
    home,
    cwd: home,
    session_id: sid,
    file_path: cmp(home, "artifacts", "some-card.html"),
  });
  ok(isHomeless(home, short), "writing an artifact does NOT adopt");

  // a plain, non-repo folder — created but not yet `git init`ed
  const plain = path.join(home, "notes");
  fs.mkdirSync(plain, { recursive: true });
  runWrite({ home, cwd: home, session_id: sid, file_path: path.join(plain, "todo.md") });
  ok(isHomeless(home, short), "writing into a non-repo dir does NOT adopt");

  // a file dropped straight into $HOME
  runWrite({ home, cwd: home, session_id: sid, file_path: path.join(home, "scratch.txt") });
  ok(isHomeless(home, short), "writing straight into $HOME does NOT adopt");
  ok(Object.values(sessionDirs(home))[0] === home, "still rooted at $HOME");
}

// ---- Case 4: git init → adopt, and bring the artifacts along ----
console.log("\nCase 4 — the snake game: git init → graduate:");
{
  const home = mkSandbox("adopt");
  const sid = "dddddddd-0000-0000-0000-000000000004";
  const short = sid.slice(0, 8);
  runSession({ home, cwd: home, session_id: sid });
  const stem = liveStems(home)[0].slice(0, -5);

  // it wrote a card while still on the Home shelf — this is what B+ has to move
  const card = cmp(home, "artifacts", "plan.html");
  fs.mkdirSync(path.dirname(card), { recursive: true });
  fs.writeFileSync(card, "<html></html>");
  fs.writeFileSync(
    cmp(home, "artifact-index.json"),
    JSON.stringify({ [card]: { unit_key: "__home__", shortid: short, source: stem, ts: 1 } }),
  );

  // mkdir ~/snake && git init && write the game
  const snake = mkRepo(home, "snake");
  runWrite({ home, cwd: home, session_id: sid, file_path: path.join(snake, "snake.py") });

  ok(sessionDirs(home)[stem] === snake, "session-dirs re-pointed at ~/snake (the card moves)");
  ok(!isHomeless(home, short), "homeless latch cleared (rooted is terminal)");
  ok(liveOf(home, stem).unit_key === "snake", "live file re-keyed to 'snake'");
  ok(liveOf(home, stem).is_repo === true, "live file is_repo flipped true");
  ok(recordOf(home, sid).unit_key === "snake", "identity record re-keyed to 'snake'");
  ok(recordOf(home, sid).project_root === snake, "identity record root === ~/snake");

  const idx = readJson(cmp(home, "artifact-index.json"), {});
  ok(idx[card].unit_key === "snake", "B+: the pre-adoption artifact followed it to 'snake'");

  const evs = fs
    .readFileSync(cmp(home, "events.ndjson"), "utf8")
    .trim()
    .split("\n")
    .map((l) => JSON.parse(l))
    .filter((e) => e.evt === "session.adopted");
  ok(evs.length === 1, "exactly one session.adopted event");
  ok(evs[0].artifacts_moved === 1, "event reports 1 artifact moved");
}

// ---- Case 5: adoption is ONE-WAY (the anti-fork invariant) ----
console.log("\nCase 5 — one-way: a second repo cannot steal an adopted session:");
{
  const home = mkSandbox("oneway");
  const sid = "eeeeeeee-0000-0000-0000-000000000005";
  runSession({ home, cwd: home, session_id: sid });
  const stem = liveStems(home)[0].slice(0, -5);

  const snake = mkRepo(home, "snake");
  runWrite({ home, cwd: home, session_id: sid, file_path: path.join(snake, "snake.py") });
  ok(sessionDirs(home)[stem] === snake, "adopted ~/snake");

  // the agent now wanders into ANOTHER repo and writes there
  const other = mkRepo(home, "some-other-repo");
  runWrite({ home, cwd: other, session_id: sid, file_path: path.join(other, "README.md") });
  ok(sessionDirs(home)[stem] === snake, "STILL ~/snake — a rooted session never re-adopts");
}

// ---- Case 6: adoption survives resume/compact ----
console.log("\nCase 6 — resume/compact does not un-adopt:");
{
  const home = mkSandbox("resume");
  const sid = "ffffffff-0000-0000-0000-000000000006";
  const short = sid.slice(0, 8);
  runSession({ home, cwd: home, session_id: sid });
  const stem = liveStems(home)[0].slice(0, -5);

  const snake = mkRepo(home, "snake");
  runWrite({ home, cwd: home, session_id: sid, file_path: path.join(snake, "snake.py") });
  ok(sessionDirs(home)[stem] === snake, "adopted ~/snake");

  // SessionStart fires again (compact / resume) — and Claude Code still reports the cwd
  // the session was LAUNCHED in. The old code re-derived root from that cwd and would
  // have silently reverted this session to $HOME, dropping it back onto the Home shelf.
  runSession({ home, cwd: home, session_id: sid });
  ok(sessionDirs(home)[stem] === snake, "STILL ~/snake after resume (root is frozen, not re-derived)");
  ok(!isHomeless(home, short), "resume did NOT re-latch it as homeless");
  ok(liveStems(home).length === 1, "no second live file (no fork)");
}

console.log(`\n=== ${pass} passed, ${fail} failed ===`);
process.exit(fail ? 1 : 0);
