#!/usr/bin/env node
// Unit + integration tests for the write-time frame substrate (shelly-frame.cjs).
//   - unit: applyFrame / stripPayloadSubmit / stripDarkBg / ensureCommentable / ensureFrame
//   - integration: spawn the REAL shelly-frame.cjs on a broken-interior temp artifact and
//     confirm it comes out frame-correct (text submit, 💬, light bg, size reporter), idempotently.
// SANDBOXED: temp files under a throwaway dir; never touches live ~/.shelly state.

const fs = require("fs");
const os = require("os");
const path = require("path");
const { spawnSync } = require("child_process");

const F = require("../shelly-frame.cjs");

let pass = 0, fail = 0;
function ok(cond, msg) {
  if (cond) { pass++; console.log("  ✓ " + msg); }
  else { fail++; console.log("  ✗ FAIL: " + msg); }
}

const FRAME = fs.readFileSync(path.join(__dirname, "..", "frame", "frame-core.html"), "utf8");

// A "broken interior" exactly like the job-applier-bot-ats clones: payload submit,
// dark-mode black bg, no commentable, but a real bespoke design + ballot markup.
const BROKEN = [
  "<meta charset=\"utf-8\">",
  "<style>",
  "  html,body{ background: oklch(0.945 0.014 60); }",
  "  @media (prefers-color-scheme: dark){ html,body{ background:#14181d; color:#e8edf3; } }",
  "</style>",
  "<div data-fit-root>",
  "  <h1>My bespoke card</h1>",
  "  <div class=\"item\" data-shelly-item data-item-label=\"Do the thing\">…</div>",
  "  <button data-shelly-submit>Submit</button>",
  "</div>",
  "<script>",
  "  var picks={};",
  "  document.querySelector('button').addEventListener('click',function(){",
  "    parent.postMessage({ source:'shelly-artifact', kind:'submit', payload:picks }, '*');",
  "  });",
  "</script>",
].join("\n");

// ---- unit: stripPayloadSubmit -------------------------------------------------
console.log("### stripPayloadSubmit");
ok(!/payload:/.test(F.stripPayloadSubmit(BROKEN)), "removes the dead-wire payload submit script");
ok(
  F.stripPayloadSubmit("<script>parent.postMessage({kind:'submit',text:'x'})</script>").includes("text:"),
  "keeps a correct text: submit script",
);

// ---- unit: stripDarkBg --------------------------------------------------------
console.log("### stripDarkBg");
const noDark = F.stripDarkBg(BROKEN);
ok(!/prefers-color-scheme:\s*dark/.test(noDark), "removes the dark-mode background block");
ok(/oklch\(0\.945/.test(noDark), "leaves the light background intact");

// ---- unit: ensureCommentable --------------------------------------------------
console.log("### ensureCommentable");
ok(/data-fit-root data-shelly-commentable/.test(F.ensureCommentable(BROKEN)), "tags fit-root commentable when absent");
ok(
  F.ensureCommentable("<div data-fit-root data-shelly-commentable>x</div>").match(/data-shelly-commentable/g).length === 1,
  "already commentable → not double-tagged (idempotent)",
);
// REGRESSION — the shape every skill template actually has: `[data-fit-root]` appears in a
// CSS selector in <head> BEFORE it appears as an attribute. Tagging the first bare string
// match corrupted the selector and left the real element unmarked, so the artifact rendered
// with no 💬 whatsoever. Caught only by a browser render; locked down here.
const CSS_FIRST = [
  "<head><style>",
  "  [data-fit-root]{width:900px;margin:0 auto}",
  "  .zone{display:grid}",
  "</style></head>",
  "<body><main data-fit-root><p>prose</p></main></body>",
].join("\n");
const cssFirst = F.ensureCommentable(CSS_FIRST);
ok(/<main data-fit-root data-shelly-commentable>/.test(cssFirst), "tags the ELEMENT, not the CSS selector");
ok(/\[data-fit-root\]\{width:900px/.test(cssFirst), "leaves the CSS selector intact");
// …and the mirror case: an artifact carrying the ambient CSS but marking no element must
// still get tagged. A bare-string test would see the selector and wrongly call it done.
const CSS_ONLY_COMMENTABLE = [
  "<head><style>[data-shelly-commentable] .shelly-commentable{position:relative}</style></head>",
  "<body><main data-fit-root><p>prose</p></main></body>",
].join("\n");
ok(
  /<main data-fit-root data-shelly-commentable>/.test(F.ensureCommentable(CSS_ONLY_COMMENTABLE)),
  "a [data-shelly-commentable] CSS selector does not count as a marked element",
);
ok(
  F.ensureCommentable("<script>document.querySelector('[data-fit-root]')</script>") ===
    "<script>document.querySelector('[data-fit-root]')</script>",
  "a fit-root reference inside a script is never treated as the element",
);

// ---- unit: ensureFrame + idempotency ------------------------------------------
console.log("### ensureFrame");
const framed = F.ensureFrame(BROKEN, FRAME);
ok(framed.includes(F.FRAME_MARK), "injects the frame marker");
ok(F.ensureFrame(framed, FRAME) === framed, "second pass is a no-op (idempotent)");
ok(
  F.ensureFrame("<div data-fit-root>x</div><!-- shelly-frame -->", FRAME).includes(F.FRAME_MARK),
  "expands the <!--shelly-frame--> placeholder",
);

// ---- REGRESSION: an artifact that MENTIONS the marker must still get framed ----
// The idempotency gate used to be `html.includes("SHELLY-FRAME-START")` — a bare substring
// test against the whole document. So any artifact that merely TALKED about the frame (a page
// documenting Shelly's internals, or one showing `grep SHELLY-FRAME-START` as a verification
// step) looked already-framed, `ensureFrame` bailed, and the mechanics were silently never
// injected. The artifact explaining the frame was the one artifact guaranteed to ship without
// it — which is exactly how this was found: by writing that artifact.
console.log("### an artifact that only MENTIONS the marker is still framed");
{
  const TALKS_ABOUT_IT = [
    '<!doctype html><html><head><meta charset="utf-8"><style>[data-fit-root]{width:900px}</style></head>',
    "<body><main data-fit-root>",
    "  <p>To verify, run:</p>",
    '  <pre>grep -c "SHELLY-FRAME-START" ~/.shelly/artifacts/card.html</pre>',
    "</main></body></html>",
  ].join("\n");
  ok(!F.hasFrame(TALKS_ABOUT_IT), "prose mentioning the marker does not count as a frame");
  const framedTalk = F.applyFrame(TALKS_ABOUT_IT, FRAME);
  ok(F.hasFrame(framedTalk), "…so it gets framed anyway");
  ok(/kind: ?"size"/.test(framedTalk), "…with the size reporter");
  ok(/<main data-fit-root data-shelly-commentable>/.test(framedTalk), "…and 💬 on the element");
  ok(F.applyFrame(framedTalk, FRAME) === framedTalk, "…and is STILL idempotent once framed");
  // The real comment form must of course register.
  ok(F.hasFrame("<!-- SHELLY-FRAME-START v=abc12345 -->"), "the injected comment form registers");
  ok(F.frameVersion("grep SHELLY-FRAME-START v=deadbeef") === null, "a version is only read from the comment");
}

// ---- unit: applyFrame end-to-end ----------------------------------------------
console.log("### applyFrame (full)");
const out = F.applyFrame(BROKEN, FRAME);
ok(/kind: ?"submit"/.test(out) && /\btext:/.test(out), "output has the correct text: submit (from the frame)");
ok(!/payload:/.test(out), "output has NO payload: submit anywhere");
ok(!/prefers-color-scheme:\s*dark/.test(out), "output has no dark-mode background");
ok(/data-shelly-commentable/.test(out), "output guarantees 💬 commentable");
ok(/kind: ?"size"/.test(out), "output has the size reporter");
ok(F.applyFrame(out, FRAME) === out, "applyFrame is idempotent on already-framed input");

// ---- integration: spawn the REAL hook on a temp file --------------------------
console.log("### integration: real shelly-frame.cjs on a temp artifact");
const sandbox = fs.mkdtempSync(path.join(os.tmpdir(), "shelly-frame-"));
const tmp = path.join(sandbox, "broken.html");
fs.writeFileSync(tmp, BROKEN);
const r = spawnSync("node", [path.join(__dirname, "..", "shelly-frame.cjs"), tmp], { stdio: "pipe" });
const result = fs.readFileSync(tmp, "utf8");
ok(r.status === 0, "hook exits 0");
ok(!/payload:/.test(result) && /\btext:/.test(result), "temp file now has a working text: submit");
ok(!/prefers-color-scheme:\s*dark/.test(result), "temp file no longer goes black");
ok(/data-shelly-commentable/.test(result), "temp file now has 💬 comments");
ok(result.includes(F.FRAME_MARK), "temp file carries the injected frame");
// idempotency on re-run
spawnSync("node", [path.join(__dirname, "..", "shelly-frame.cjs"), tmp], { stdio: "pipe" });
const result2 = fs.readFileSync(tmp, "utf8");
ok(result2 === result, "re-running the hook is a no-op (no churn)");

fs.rmSync(sandbox, { recursive: true, force: true });

// ---- the frame asset must not drift from its source ---------------------------
// frame-core.html is ~860 lines that also live verbatim in the skill reference. Hand-
// copying them is the very failure the frame exists to prevent, so the asset is
// GENERATED and this is the check that keeps it honest. Without this test, the fix has
// the same decay mode as the bug.
console.log("### frame-core.html is generated, not hand-edited");
const gen = spawnSync("node", [path.join(__dirname, "..", "frame", "extract.mjs"), "--check"], {
  stdio: "pipe",
  encoding: "utf8",
});
ok(
  gen.status === 0,
  "frame-core.html is in sync with interaction-helper.md (else: node plugin/hooks/frame/extract.mjs)",
);

// ---- the frame must never repaint an artifact that painted itself -------------
// The frame lands at the END of <body>, after the artifact's own <head> styles, so an
// equal-specificity `html, body { background }` would win on source order and force every
// artifact back to the app shade — including one that declared a curated shell (SKILL.md
// §5), whose Board chrome would repaint while its iframe did not. That seam is the exact
// thing invariant §1.6 forbids, so the frame's shell rule is zero-specificity.
console.log("### the frame's shell is a fallback, not an override");
ok(/:where\(html\), :where\(body\)/.test(FRAME), "shell background is wrapped in :where() (zero specificity)");
ok(
  !/(^|\n)\s*html\s*,\s*body\s*\{[^}]*background/.test(FRAME),
  "no bare `html, body { background }` rule that would out-order the artifact",
);
const REPAINTED = [
  '<meta charset="utf-8">',
  "<style>html,body{background:#14181D;color:#E8EDF3}</style>",
  '<div data-fit-root data-shelly-commentable><h1>ink shell</h1></div>',
].join("\n");
const repainted = F.applyFrame(REPAINTED, FRAME);
ok(/html,body\{background:#14181D/.test(repainted), "a declared curated shell survives framing");

// ---- sole ownership of the ballot --------------------------------------------
// Two live helper copies (one pasted, one injected) would each mount a comment box and
// handle every click twice, so the second toggles off what the first just set and the
// button reads as dead. Guarded two ways: run-second-stand-down for a recognisable copy,
// and a capture-phase veto for a hand-rolled one that can't be recognised.
console.log("### the frame is the sole interaction owner");
ok(/window\.__shellyHelperMounted/.test(FRAME), "helper carries the run-second-stand-down guard");
ok(/document\.querySelector\("\.shelly-ask-btn"\)/.test(FRAME), "stand-down also detects an ambient-only copy");
ok(/stopImmediatePropagation/.test(FRAME), "ballot clicks are vetoed so a hand-rolled handler can't double-fire");
ok(/\}, true\);/.test(FRAME), "the ballot listener is registered in the capture phase");

// ---- version awareness -------------------------------------------------------
// A frame left by an older plugin should be swapped on the next write, so
// `claude plugin update` reaches artifacts that already exist rather than only new ones.
// It must NOT stack two frames, and must leave a current frame completely alone.
console.log("### version-aware replacement");
ok(/^[0-9a-f]{8}$/.test(F.frameVersion(FRAME) || ""), "the frame asset carries a version stamp");
ok(F.frameVersion("<div>no frame here</div>") === null, "an unframed artifact reports no version");
const stale = F.applyFrame(BROKEN, FRAME).replace(/SHELLY-FRAME-START v=[0-9a-f]+/, "SHELLY-FRAME-START v=deadbeef");
const refreshed = F.ensureFrame(stale, FRAME);
ok(F.frameVersion(refreshed) === F.frameVersion(FRAME), "a stale frame is replaced with the current one");
ok(
  (refreshed.match(new RegExp(F.FRAME_MARK, "g")) || []).length === 1,
  "replacement does not stack a second frame",
);
ok(F.ensureFrame(refreshed, FRAME) === refreshed, "a current frame is left untouched");

// ---- the LIVE path: shelly-index.cjs is what actually frames -----------------
// The unit tests above prove the transform; this proves it is WIRED. shelly-index.cjs is
// the process the PostToolUse hook already spawns per artifact write, and folding the
// frame into it is what makes every artifact frame-correct without a second spawn. If
// this test fails, the fix is inert no matter how green everything above is.
console.log("### integration: shelly-index.cjs frames on the live write path");
const sandbox2 = fs.mkdtempSync(path.join(os.tmpdir(), "shelly-index-frame-"));
const live = path.join(sandbox2, "live");
const art = path.join(sandbox2, "unframed.html");
fs.mkdirSync(live, { recursive: true });
fs.writeFileSync(art, BROKEN);
const ri = spawnSync(
  "node",
  [path.join(__dirname, "..", "shelly-index.cjs"), art, live, path.join(sandbox2, "index.json")],
  { stdio: "pipe", env: { ...process.env, HOME: sandbox2, SID: "" } },
);
const framedLive = fs.readFileSync(art, "utf8");
ok(ri.status === 0, "shelly-index.cjs exits 0");
ok(framedLive.includes(F.FRAME_MARK), "the artifact came out of the live path FRAMED");
ok(/data-shelly-commentable/.test(framedLive), "…with 💬 comments guaranteed");
ok(!/payload:/.test(framedLive) && /\btext:/.test(framedLive), "…and a working text: submit");
ok(/<meta[^>]+charset/i.test(framedLive), "…charset repair still runs alongside it");
fs.rmSync(sandbox2, { recursive: true, force: true });

console.log(`\n=== frame: ${pass} passed, ${fail} failed ===`);
process.exit(fail ? 1 : 0);
