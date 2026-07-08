#!/usr/bin/env node
// Unit + integration tests for the write-time charset safety net.
//   - unit: ensureArtifactCharset (pure string→string) in companion-charset.cjs
//   - integration: spawn the REAL companion-index.cjs on a charset-less temp artifact and
//     confirm the file gains <meta charset> even when routing can't resolve (no session record).
// SANDBOXED: temp files under a throwaway dir; never touches live ~/.claude state.

const fs = require("fs");
const os = require("os");
const path = require("path");
const { spawnSync } = require("child_process");

const { ensureArtifactCharset } = require("../companion-charset.cjs");

let pass = 0,
  fail = 0;
function ok(cond, msg) {
  if (cond) { pass++; console.log("  ✓ " + msg); }
  else { fail++; console.log("  ✗ FAIL: " + msg); }
}

const sandbox = fs.mkdtempSync(path.join(os.tmpdir(), "cmp-charset-"));

// ---- unit: ensureArtifactCharset -----------------------------------------
console.log("### ensureArtifactCharset");
const META = '<meta charset="utf-8" />';

ok(
  ensureArtifactCharset("<div>hi — there</div>") === '<!doctype html>\n' + META + '\n<div>hi — there</div>',
  "bare content (no head/doctype) → prepend doctype + meta",
);
ok(
  ensureArtifactCharset('<head><meta charset="UTF-8"></head>') === '<head><meta charset="UTF-8"></head>',
  "already has charset → no-op (idempotent)",
);
ok(
  ensureArtifactCharset('<meta charset=utf-8>') === '<meta charset=utf-8>',
  "unquoted charset also recognized → no-op",
);
ok(
  ensureArtifactCharset("<head><title>x</title></head>") === "<head>\n  " + META + "<title>x</title></head>",
  "head present, no charset → insert right after <head>",
);
ok(
  ensureArtifactCharset("<!doctype html><div>x</div>") === "<!doctype html>\n" + META + "<div>x</div>",
  "doctype but no head → insert after the doctype (standards mode preserved)",
);
ok(ensureArtifactCharset("") === "", "empty string → unchanged");
ok(ensureArtifactCharset(null) === null, "null → unchanged (no throw)");
// double-apply is stable (idempotent)
const once = ensureArtifactCharset("<div>x</div>");
ok(ensureArtifactCharset(once) === once, "running twice is a no-op the second time");

// ---- integration: companion-index.cjs repairs a real file ----------------
console.log("### companion-index.cjs charset repair");
const artifact = path.join(sandbox, "bare.html");
fs.writeFileSync(artifact, '<div data-fit-root>Shipped — all done</div>');
const before = fs.readFileSync(artifact, "utf8");
ok(!/<meta\s+charset/i.test(before), "fixture starts WITHOUT a charset label");

const idxPath = path.join(sandbox, "artifact-index.json");
const liveDir = path.join(sandbox, "live");
fs.mkdirSync(liveDir, { recursive: true });
// No session record exists → indexing will bail, but the charset fix runs first.
const r = spawnSync(
  "node",
  [path.join(__dirname, "..", "companion-index.cjs"), artifact, liveDir, idxPath],
  { env: { ...process.env, SID: "deadbeef-0000-1111-2222-333344445555" }, encoding: "utf8" },
);
ok(r.status === 0, "companion-index.cjs exits 0");
const after = fs.readFileSync(artifact, "utf8");
ok(/<meta\s+charset="utf-8"/i.test(after), "artifact gained <meta charset> after the hook ran");
ok(after.includes("Shipped — all done"), "original content preserved (em-dash intact)");

// running the hook again must NOT double-insert
const r2 = spawnSync(
  "node",
  [path.join(__dirname, "..", "companion-index.cjs"), artifact, liveDir, idxPath],
  { env: { ...process.env, SID: "deadbeef-0000-1111-2222-333344445555" }, encoding: "utf8" },
);
ok(r2.status === 0, "second run exits 0");
const after2 = fs.readFileSync(artifact, "utf8");
ok((after2.match(/<meta\s+charset/gi) || []).length === 1, "still exactly one charset meta (idempotent across runs)");

// ---- cleanup + result -----------------------------------------------------
try { fs.rmSync(sandbox, { recursive: true, force: true }); } catch (_) {}
console.log(`\n=== ${pass}/${pass + fail} checks passed ===`);
process.exit(fail ? 1 : 0);
