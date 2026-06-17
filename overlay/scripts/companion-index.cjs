#!/usr/bin/env node
// companion-index.js — stamp the Board's artifact routing index.
//
// Usage:  SID=<session_id> node companion-index.js <artifact_path> <live_dir> <index_path>
//
// WHY this exists: the Board groups an artifact under the session that wrote it.
// The only identity that is STABLE across a session is its session_id — the cwd
// is volatile (it moves as the agent `cd`s around), so we must NOT derive the
// session/unit from cwd. We key on the first 8 chars of session_id (the same
// shortid the live file is named with: `<slug>--<shortid>.json`), look up that
// live file, and freeze its authoritative `unit_key` into the index. Freezing
// means the grouping survives the session ending (the live file going away).
//
// Index shape: { "<abs-path>.html": { unit_key, shortid, source, ts }, ... }
// Keyed by the ABSOLUTE artifact path (not basename) so two artifacts that share
// a filename across scan dirs — e.g. ~/.claude/companion/artifacts vs
// ~/codeviz/public/artifacts — can't collide and mis-route. The Rust reader
// (history.rs list_artifacts) looks up by full path, falling back to basename
// for entries written by older hooks. Use a LEXICAL resolve (not realpath): the
// reader scans dirs without resolving symlinks, so keys must match literally.
// On any failure we exit 0 without writing — routing then falls back to the
// model-stamped project (display-only), so a broken index can never lose work.

const fs = require("fs");
const path = require("path");

const [artifactPath, liveDir, indexPath] = process.argv.slice(2);
if (!artifactPath || !liveDir || !indexPath) process.exit(0);

const key = path.resolve(artifactPath);
const shortid = (process.env.SID || "").slice(0, 8).replace(/[^A-Za-z0-9]/g, "-");
if (!shortid) process.exit(0);

// Find this session's live file by its shortid suffix and read its unit_key.
let unitKey = null;
let source = null;
try {
  for (const f of fs.readdirSync(liveDir)) {
    if (f.endsWith("--" + shortid + ".json")) {
      source = f.slice(0, -5); // strip ".json"
      try {
        unitKey = (JSON.parse(fs.readFileSync(path.join(liveDir, f), "utf8")) || {}).unit_key || null;
      } catch (_) {}
      break;
    }
  }
} catch (_) {}

// No live file (or no unit_key) ⇒ leave un-indexed; the project-slug fallback covers it.
if (!unitKey) process.exit(0);

let index = {};
try {
  index = JSON.parse(fs.readFileSync(indexPath, "utf8")) || {};
} catch (_) {}
index[key] = { unit_key: unitKey, shortid, source, ts: Date.now() };

// Atomic write (temp + rename) so a concurrent reader never sees a partial file.
try {
  const tmp = indexPath + ".tmp";
  fs.writeFileSync(tmp, JSON.stringify(index));
  fs.renameSync(tmp, indexPath);
} catch (_) {}
