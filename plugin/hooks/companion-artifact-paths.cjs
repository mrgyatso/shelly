#!/usr/bin/env node
// companion-artifact-paths.cjs — pull artifact paths out of a PostToolUse payload.
//
// Claude Code's Write/Edit carry the target as tool_input.file_path. Codex CLI edits
// files through apply_patch (the path is embedded in the patch text) or a shell tool
// (the path is inside a command string), so there is no single field to read. This
// helper owns that difference: it prints every path under ARTIFACTS_DIR ending in
// .html that the payload plausibly wrote, one per line, deduped —
//   1. tool_input.file_path when present (the Claude fast path, exact),
//   2. a literal scan of the raw payload for "<ARTIFACTS_DIR>/…*.html" (patch text,
//      command strings — whatever shape the tool_input takes).
// The scan is safe to over-match: every consumer re-checks the path against its own
// case rules (home.html/_*.html skips) and the file's existence before acting on it.
//
// Usage: printf '%s' "$payload" | ARTIFACTS_DIR=<dir> node companion-artifact-paths.cjs

function extractPaths(payload, artifactsDir) {
  if (!payload || !artifactsDir) return [];
  const found = new Set();

  let parsed = null;
  try {
    parsed = JSON.parse(payload);
  } catch (_) {}
  const fp = parsed && parsed.tool_input && parsed.tool_input.file_path;
  if (typeof fp === "string" && fp.startsWith(artifactsDir + "/") && fp.endsWith(".html")) {
    found.add(fp);
  }

  // Literal scan for artifact paths embedded in patch/command text. JSON encoders may
  // escape "/" as "\/"; normalize that first, then stop each match at any character a
  // JSON-escaped string can't carry mid-path (quotes, whitespace, backslash).
  const norm = payload.replace(/\\\//g, "/");
  const esc = artifactsDir.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  const re = new RegExp(esc + "/[^\"'`\\s\\\\]+?\\.html", "g");
  for (const m of norm.match(re) || []) found.add(m);

  return [...found];
}

module.exports = { extractPaths };

if (require.main === module) {
  let raw = "";
  process.stdin.on("data", (c) => (raw += c));
  process.stdin.on("end", () => {
    const dir = process.env.ARTIFACTS_DIR || "";
    for (const p of extractPaths(raw, dir)) process.stdout.write(p + "\n");
  });
}
