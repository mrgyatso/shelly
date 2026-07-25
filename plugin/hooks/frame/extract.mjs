#!/usr/bin/env node
// extract.mjs — generate `frame-core.html` from its single source of truth.
//
//   node plugin/hooks/frame/extract.mjs            # regenerate frame-core.html
//   node plugin/hooks/frame/extract.mjs --check    # exit 1 if it has drifted
//
// WHY THIS FILE EXISTS. `frame-core.html` is ~860 lines that also live, verbatim, in
// `plugin/skills/prefer-html/references/interaction-helper.md` — the copy an authoring
// agent pastes. The first version of the frame was extracted by hand, which quietly
// recreated the exact problem the frame was built to solve one level up: two copies of
// the mechanics with nothing keeping them in step. A fix whose own correctness depends
// on somebody remembering to re-copy 860 lines is not a fix.
//
// So: the Markdown is the source, this script is the only way the asset is produced, and
// `--check` runs in the test suite. Edit the skill reference; never edit frame-core.html.
//
// Blocks are located by HEADING, not by ordinal position — inserting a new example into
// the reference must not silently repoint the extraction at the wrong fence.

import { createHash } from "node:crypto";
import { readFileSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const HERE = dirname(fileURLToPath(import.meta.url));
const SOURCE = join(HERE, "..", "..", "skills", "prefer-html", "references", "interaction-helper.md");
const TARGET = join(HERE, "frame-core.html");

/** The fenced block under `## <heading>`, without its ``` fences. */
function blockUnder(md, heading) {
  const h = md.indexOf(`\n## ${heading}`);
  if (h === -1) throw new Error(`extract: heading not found: "## ${heading}"`);
  const open = md.indexOf("\n```", h);
  if (open === -1) throw new Error(`extract: no fenced block under "## ${heading}"`);
  const bodyStart = md.indexOf("\n", open + 1) + 1;
  const close = md.indexOf("\n```", bodyStart);
  if (close === -1) throw new Error(`extract: unterminated fence under "## ${heading}"`);
  return md.slice(bodyStart, close + 1);
}

// ---------------------------------------------------------------------------
// The BASE layer — the only part of the frame authored here rather than extracted.
// It is the mechanical floor from SKILL.md §1.4 / §7.3: shell shade, hidden root
// scrollbar, size reporter.
//
// Two things about it are load-bearing and were both wrong in the first prototype:
//
// 1. `:where()` — ZERO specificity, deliberately. The frame is injected at the END of
//    <body>, so it lands after the artifact's own <head> styles. A plain
//    `html, body { background: … }` would therefore WIN on source order and repaint
//    every artifact back to the app shade — including one that legitimately declared a
//    curated shell (SKILL.md §5), whose Board chrome would repaint to slate/ink while
//    its iframe was forced back to paper. That is precisely the seam invariant §1.6
//    exists to prevent. Wrapping in `:where()` drops specificity to 0, which turns the
//    rule into a FALLBACK: it paints only when the artifact declared nothing itself.
//
// 2. The reporter is flag-guarded. A double reporter is benign (both observe the same
//    element and post identical numbers) but a doubled ResizeObserver on every artifact
//    forever is pure waste, so a pasted copy that ran first wins and this one stands
//    down — the same run-second-stand-down rule the helper itself uses.
const BASE = `<style data-shelly-frame>
  /* Zero-specificity FALLBACK shell — never overrides an artifact's own paint. */
  :where(html), :where(body) { background: oklch(0.945 0.014 60); margin: 0; }
  :where(html) { scrollbar-width: none; }
  html::-webkit-scrollbar { width: 0; height: 0; display: none; }
</style>
<script data-shelly-frame>
  (function () {
    if (window.__shellySizeMounted) return;
    window.__shellySizeMounted = true;
    var el = document.querySelector("[data-fit-root]") || document.body;
    var post = function () { parent.postMessage({ source: "shelly-artifact", kind: "size", w: Math.ceil(el.scrollWidth), h: Math.ceil(el.scrollHeight) }, "*"); };
    if (typeof ResizeObserver !== "undefined") new ResizeObserver(post).observe(el);
    addEventListener("load", post); post();
  })();
</script>
`;

export function buildFrame(md) {
  const helper = blockUnder(md, "The unified helper script (copy verbatim)");
  const css = blockUnder(md, "Ambient-comments CSS (pair with the helper)");
  // Version = the extracted source, not the whole file: a prose edit to the reference
  // must not churn the stamp on every artifact. Lets a later migration find artifacts
  // still carrying an older frame.
  const version = createHash("sha1").update(helper + css).digest("hex").slice(0, 8);
  return (
    `<!-- SHELLY-FRAME-START v=${version} (generated; do not edit) -->\n` +
    `<!-- shelly-frame: injected substrate — behaviour + affordance defaults + base shell.\n` +
    `     Source of truth: plugin/skills/prefer-html/references/interaction-helper.md\n` +
    `     Regenerate with: node plugin/hooks/frame/extract.mjs  (--check verifies in CI) -->\n` +
    BASE +
    css +
    helper +
    `<!-- SHELLY-FRAME-END -->\n`
  );
}

function main() {
  const md = readFileSync(SOURCE, "utf8");
  const next = buildFrame(md);
  const check = process.argv.includes("--check");
  let current = null;
  try {
    current = readFileSync(TARGET, "utf8");
  } catch {
    /* first generation */
  }
  if (check) {
    if (current === next) {
      process.stdout.write("frame-core.html is in sync with interaction-helper.md\n");
      return;
    }
    process.stderr.write(
      "frame-core.html has DRIFTED from interaction-helper.md.\n" +
        "Run: node plugin/hooks/frame/extract.mjs\n",
    );
    process.exit(1);
  }
  if (current === next) {
    process.stdout.write("frame-core.html already up to date\n");
    return;
  }
  writeFileSync(TARGET, next);
  process.stdout.write(`frame-core.html regenerated (${next.split("\n").length} lines)\n`);
}

if (process.argv[1] && process.argv[1].endsWith("extract.mjs")) main();
