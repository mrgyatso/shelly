#!/usr/bin/env node
// shelly-adopt.cjs — a homeless session GRADUATES onto its own project shelf.
//
//   Usage:  <hook payload on stdin> | node shelly-adopt.cjs
//
// THE PROBLEM. A session launched from $HOME (the Board's "+ New session") has no
// project of its own, so it lands on the shared Home shelf. But identity is FROZEN at
// SessionStart — deliberately, because re-deriving it from a moving cwd is what once
// forked one session into two roster units. That freeze is right for a session that
// STARTED somewhere real. It is wrong for one that started NOWHERE: tell it "build me a
// snake game", it creates ~/snake and `git init`s, and it is now unmistakably a real
// project — yet its frozen note still says "$HOME", so it is stuck on the Home shelf
// forever, and "+ session in this project" keeps spawning back in ~.
//
// THE TRANSITION. A session is either HOMELESS or ROOTED. homeless → rooted happens at
// most ONCE and is terminal; rooted → rooted never happens. That one-way, monotonic
// shape is what makes this safe: it is not identity tracking a moving cwd (the bug the
// freeze exists to prevent), it is a single exit from a null state. A session that has
// already adopted carries no marker, so it can never adopt again.
//
// THE TRIGGER is the first WRITE that lands inside a git repo which isn't $HOME — not a
// `cd`. A write is a far stronger claim of "this is my project" than a cd is: an agent
// cd's into a skill cache or ~/wiki merely to READ, and under a cd-trigger the first
// such wander would be adopted permanently. It also keys off the write's absolute
// file_path, so it does not depend on whether the hook payload's `cwd` tracks the
// agent's `cd` at all.
//
// WHAT IT REWRITES (all atomic tmp+rename; all best-effort — a failed adopt must never
// break the write that triggered it):
//   session-dirs.json[stem]   → the new root. This is the load-bearing one: the Board
//                               derives a session's unit from its unit_dir, so this
//                               alone moves the card off the Home shelf.
//   live/<stem>.json          → unit_key / project / is_repo, so a resume re-freezes on
//                               the adopted identity rather than the stale home one.
//   sessions/<id>.json        → same, in the authoritative identity record.
//   artifact-index.json       → every artifact this session already wrote is re-stamped
//                               to the new unit. Without this the pre-adoption cards
//                               look fine while the session is live (the Board resolves
//                               them through the live source) and then SNAP BACK to Home
//                               the moment it closes, splitting its history across two
//                               shelves.

const fs = require("fs");
const path = require("path");
const os = require("os");

const HOME = process.env.HOME || os.homedir();
const CMP = path.join(HOME, ".shelly");
const HOMELESS_DIR = path.join(CMP, "homeless");
const LIVE_DIR = path.join(CMP, "live");
const INDEX_PATH = path.join(CMP, "artifact-index.json");

let trace = { emit() {} };
try {
  trace = require("./shelly-trace.cjs");
} catch (_) {}

function readJson(p) {
  try {
    return JSON.parse(fs.readFileSync(p, "utf8")) || null;
  } catch (_) {
    return null;
  }
}

/** Atomic write — a concurrent reader never sees a partial file. */
function writeJson(p, obj) {
  try {
    const tmp = p + "." + process.pid + ".tmp";
    fs.writeFileSync(tmp, JSON.stringify(obj));
    fs.renameSync(tmp, p);
    return true;
  } catch (_) {
    return false;
  }
}

/**
 * The git root containing `dir`, or null. Walked in-process rather than shelling out to
 * `git rev-parse` — this runs on the write path, and a subprocess per Write is exactly
 * the cost the hook's cheap pre-filters exist to avoid. Stops at $HOME: a repo whose
 * root IS $HOME (some people git-track their dotfiles) must NOT count as a project, or
 * every home session would instantly "adopt" the home directory it is already on.
 */
function gitRootOf(dir) {
  let cur = path.resolve(dir);
  const stop = path.parse(cur).root;
  while (cur && cur !== stop) {
    if (cur === HOME) return null; // reached $HOME without finding a repo below it
    try {
      if (fs.existsSync(path.join(cur, ".git"))) return cur;
    } catch (_) {}
    const up = path.dirname(cur);
    if (up === cur) break;
    cur = up;
  }
  return null;
}

function main(payload) {
  const sid = String(payload.session_id || "");
  const short = sid.slice(0, 8).replace(/[^A-Za-z0-9]/g, "-");
  if (!short) return;

  // Only a session still ON the Home shelf carries a marker. This is the one-way latch:
  // no marker ⇒ already rooted (or never homeless) ⇒ nothing to do, ever.
  const marker = path.join(HOMELESS_DIR, short);
  if (!fs.existsSync(marker)) return;

  const fp = String((payload.tool_input || {}).file_path || "");
  if (!fp || !path.isAbsolute(fp)) return;

  // Shelly's own plumbing (artifacts, memory, settings) is not project work — an
  // agent writing an artifact from a home session has not thereby started a project.
  if (fp.startsWith(path.join(HOME, ".claude") + path.sep)) return;

  const root = gitRootOf(path.dirname(fp));
  if (!root || root === HOME) return; // not a repo yet, or the repo *is* ~ ⇒ stay homeless

  // The Board keys a unit off `basename(unit_dir)` (projectSlug → sourceProjectKey), so
  // the unit name must be the RAW basename — not a sanitized slug, or the two disagree.
  const unit = path.basename(root);
  if (!unit) return;

  // The stem (<slug>--<shortid>) is how every sidecar keys this session.
  let stem = null;
  try {
    stem = fs.readdirSync(LIVE_DIR).find((f) => f.endsWith("--" + short + ".json"));
  } catch (_) {}
  if (!stem) return;
  stem = stem.slice(0, -5);

  // 1. THE load-bearing write: the Board derives the unit from unit_dir, so re-pointing
  //    session-dirs is what actually moves the session off the Home shelf.
  const dirsPath = path.join(CMP, "session-dirs.json");
  const dirs = readJson(dirsPath) || {};
  dirs[stem] = root;
  if (!writeJson(dirsPath, dirs)) return; // couldn't adopt — leave the marker, retry next write

  // 2. The live file, so a compact/resume re-freezes on the adopted identity.
  const livePath = path.join(LIVE_DIR, stem + ".json");
  const live = readJson(livePath);
  if (live) {
    live.unit_key = unit;
    live.project = unit;
    live.is_repo = true;
    writeJson(livePath, live);
  }

  // 3. The authoritative identity record.
  const recPath = path.join(CMP, "sessions", sid.replace(/[^A-Za-z0-9._-]/g, "-") + ".json");
  const rec = readJson(recPath);
  if (rec) {
    rec.unit_key = unit;
    // rec.slug stays FROZEN: it names the live stem (live/<slug>--<shortid>.json),
    // which adoption does not rename. Rewriting it to the unit would stamp future
    // artifacts with a source no live session matches (the __home__ hero bug's twin).
    rec.project = unit;
    rec.project_root = root;
    rec.is_repo = true;
    writeJson(recPath, rec);
  }

  // 4. Bring this session's existing artifacts along (else they snap back to Home once
  //    the session closes and its live source stops covering for them).
  const index = readJson(INDEX_PATH);
  let moved = 0;
  if (index) {
    for (const entry of Object.values(index)) {
      if (entry && entry.shortid === short && entry.unit_key !== unit) {
        entry.unit_key = unit;
        moved++;
      }
    }
    if (moved) writeJson(INDEX_PATH, index);
  }

  // 5. Latch it shut. From here the session is rooted, and rooted is terminal.
  try {
    fs.rmSync(marker);
  } catch (_) {}

  // The Board tails events.ndjson; announce both the move and the re-routed artifacts.
  try {
    fs.appendFileSync(
      path.join(CMP, "events.ndjson"),
      JSON.stringify({
        evt: "session.adopted",
        session_id: sid,
        unit_key: unit,
        root,
        artifacts_moved: moved,
        ts_ms: Date.now(),
      }) + "\n",
    );
  } catch (_) {}
  trace.emit("adopt", "adopted", { session_id: short, unit_key: unit, root, moved: String(moved) });
}

let buf = "";
process.stdin.on("data", (c) => (buf += c));
process.stdin.on("end", () => {
  try {
    main(JSON.parse(buf));
  } catch (_) {
    // Adoption is best-effort and must never throw into the write path.
  }
});
