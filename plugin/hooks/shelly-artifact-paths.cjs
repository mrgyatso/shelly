#!/usr/bin/env node
// shelly-artifact-paths.cjs — pull artifact paths out of a PostToolUse payload.
//
// Claude Code's Write/Edit carry the target as tool_input.file_path. Codex CLI edits
// files through apply_patch (the path is embedded in the patch text) or a shell tool
// (the path is inside a command string), so there is no single field to read. This
// helper owns that difference: it prints every path under ARTIFACTS_DIR ending in
// .html that the payload plausibly wrote, one per line, deduped —
//   1. tool_input.file_path when present (the Claude fast path, EXACT — the field only
//      exists on a write tool, so its presence is itself proof of a write),
//   2. a literal scan of the raw payload for "<ARTIFACTS_DIR>/…*.html" (patch text,
//      command strings — whatever shape the tool_input takes).
//
// ORIGIN matters downstream. A scanned path is a MENTION, not a proven write: a shell
// tool that only READS an artifact (`grep … foo.html`, `cat foo.html`) carries the exact
// same text as one that wrote it. Stamping the index off a mention re-routes another
// session's artifact to whoever grepped it. So scanned paths carry origin "scan" and
// must clear two gates the exact path skips:
//   - here: the file exists and its mtime is FRESH (something really did just write it),
//   - shelly-index.cjs: it is not already indexed to a DIFFERENT session (no hijack).
//
// Usage: printf '%s' "$payload" | ARTIFACTS_DIR=<dir> node shelly-artifact-paths.cjs
//        → one "<origin>\t<path>" line per path.

const fs = require("fs");

// How recently a scanned path must have been written to count as this call's doing.
// Generous enough for a command that writes the file and then does slow work in the same
// invocation (build, verify, screenshot) — the hook only fires once the whole command exits.
const FRESH_MS = 30_000;

function freshOnDisk(p, nowMs) {
  try {
    return nowMs - fs.statSync(p).mtimeMs <= FRESH_MS;
  } catch (_) {
    return false; // missing/unreadable — a mention of a path nothing wrote
  }
}

// [{ path, origin: "exact" | "scan" }], deduped, exact winning over scan for a path
// named both ways. opts.isFresh / opts.now are injectable so tests stay off the clock.
function classifyPaths(payload, artifactsDir, opts) {
  if (!payload || !artifactsDir) return [];
  const isFresh = (opts && opts.isFresh) || freshOnDisk;
  const now = (opts && opts.now) || Date.now();
  const byPath = new Map();

  let parsed = null;
  try {
    parsed = JSON.parse(payload);
  } catch (_) {}
  const fp = parsed && parsed.tool_input && parsed.tool_input.file_path;
  if (typeof fp === "string" && fp.startsWith(artifactsDir + "/") && fp.endsWith(".html")) {
    byPath.set(fp, "exact");
  }

  // Literal scan for artifact paths embedded in patch/command text. JSON encoders may
  // escape "/" as "\/"; normalize that first, then stop each match at any character a
  // JSON-escaped string can't carry mid-path (quotes, whitespace, backslash).
  const norm = payload.replace(/\\\//g, "/");
  const esc = artifactsDir.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  const re = new RegExp(esc + "/[^\"'`\\s\\\\]+?\\.html", "g");
  for (const m of norm.match(re) || []) {
    if (!byPath.has(m)) byPath.set(m, "scan");
  }

  return [...byPath.entries()]
    .filter(([p, origin]) => origin === "exact" || isFresh(p, now))
    .map(([path, origin]) => ({ path, origin }));
}

// Back-compat: paths only, and no freshness gate (pure — no fs, no clock).
function extractPaths(payload, artifactsDir) {
  return classifyPaths(payload, artifactsDir, { isFresh: () => true }).map((e) => e.path);
}

module.exports = { extractPaths, classifyPaths, FRESH_MS };

if (require.main === module) {
  let raw = "";
  process.stdin.on("data", (c) => (raw += c));
  process.stdin.on("end", () => {
    const dir = process.env.ARTIFACTS_DIR || "";
    for (const e of classifyPaths(raw, dir)) process.stdout.write(e.origin + "\t" + e.path + "\n");
  });
}
