#!/usr/bin/env node
// RENDER verification for the injected frame — the check the unit tests cannot make.
//
//   node plugin/hooks/__tests__/render-frame.mjs
//
// Everything in frame.cjs asserts on strings. Strings cannot tell you whether the 💬 icons
// actually appear, whether a competing click handler double-toggles the ballot, or whether
// CSS injected at the end of <body> quietly out-orders the artifact's own paint. Those are
// engine behaviours, and the first browser run of this suite found a real bug the entire
// string-level suite had passed: `ensureCommentable` was tagging the CSS SELECTOR
// `[data-fit-root]{…}` instead of the element, so artifacts rendered with no 💬 at all.
//
// Drives headless Chrome over CDP with no dependencies (Node 22 ships WebSocket). Skips
// cleanly with exit 0 when no Chrome is present, so it can run in CI without becoming a
// platform requirement.
//
// The interior under test is HOSTILE on purpose: it carries its own hand-rolled ballot
// handler, which is the authoring drift the capture-phase veto exists to neutralise.

import { spawn, execFileSync } from "node:child_process";
import { mkdtempSync, writeFileSync, readFileSync, rmSync, existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const HERE = dirname(fileURLToPath(import.meta.url));
const HOOK = join(HERE, "..", "shelly-frame.cjs");
const PORT = Number(process.env.SHELLY_RENDER_PORT || 9455);

const CANDIDATES = [
  process.env.CHROME_BIN,
  "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome",
  "/Applications/Chromium.app/Contents/MacOS/Chromium",
  "/usr/bin/google-chrome",
  "/usr/bin/google-chrome-stable",
  "/usr/bin/chromium-browser",
  "/usr/bin/chromium",
].filter(Boolean);
const CHROME = CANDIDATES.find((p) => existsSync(p));
if (!CHROME) {
  console.log("### frame render: SKIPPED (no Chrome/Chromium found; set CHROME_BIN to run)");
  process.exit(0);
}

let pass = 0, fail = 0;
const ok = (c, m) => { c ? (pass++, console.log("  ✓ " + m)) : (fail++, console.log("  ✗ FAIL: " + m)); };

// ---------------------------------------------------------------------------
// A hostile interior: styles [data-fit-root] in CSS BEFORE using it as an attribute (the
// shape every skill template has — and the shape that exposed the selector bug), and ships
// a competing hand-rolled ballot handler that would double-toggle if it ever saw the click.
const HOSTILE = `<!doctype html>
<html lang="en"><head><meta charset="utf-8"><title>hostile interior</title>
<style>
  html,body{margin:0;background:#FBFAF6;font-family:system-ui}
  [data-fit-root]{width:700px;margin:0 auto;padding:40px 56px}
</style></head>
<body>
<main data-fit-root>
  <h2>A heading the user might question</h2>
  <p>First paragraph of prose.</p>
  <p>Second paragraph of prose.</p>
  <div class="item" data-shelly-item data-item-label="Ship the thing">
    <span class="item-title">Ship the thing</span>
    <button data-action="approve">Y</button>
    <button data-action="comment">N</button>
    <button data-action="reject">X</button>
    <textarea data-comment hidden></textarea>
  </div>
  <button data-shelly-submit="Render test">Submit</button>
</main>
<script>
  document.addEventListener("click", function (e) {
    var b = e.target.closest("[data-action]"); if (!b) return;
    var it = b.closest("[data-shelly-item]"), a = b.getAttribute("data-action");
    if (it.getAttribute("data-state") === a) it.removeAttribute("data-state");
    else it.setAttribute("data-state", a);
    window.__hostileFired = (window.__hostileFired || 0) + 1;
  });
</script>
</body></html>`;

const sandbox = mkdtempSync(join(tmpdir(), "shelly-render-"));
const artPath = join(sandbox, "hostile.html");
writeFileSync(artPath, HOSTILE);
execFileSync("node", [HOOK, artPath]);
const framed = readFileSync(artPath, "utf8");

// Carry the artifact as base64. Inlining it as text would let its own `</script>` close the
// carrier element early, and escaping that as `<\/script>` only works inside a JS string —
// read back as raw text nothing runs at all, which looks exactly like a broken product.
const b64 = Buffer.from(framed, "utf8").toString("base64");
const harnessPath = join(sandbox, "harness.html");
writeFileSync(
  harnessPath,
  `<!doctype html><html><head><meta charset="utf-8"><title>frame harness</title>
<style>body{margin:0;background:#333}iframe{width:100%;height:1600px;border:0}</style></head>
<body><iframe id="f" sandbox="allow-scripts allow-same-origin"></iframe>
<script>
  window.__msgs = []; window.__errs = [];
  addEventListener("message", function (e) {
    window.__msgs.push(e.data);
    // Ack exactly as the Board does (board.ts postSubmitAck). Without it the helper waits
    // ACK_MS and holds a lock that silently drops any further submit in that window.
    if (e.data && e.data.kind === "submit" && e.source) {
      e.source.postMessage({ source: "shelly-board", kind: "submit-ack", ok: true, via: "terminal" }, "*");
    }
  });
  addEventListener("error", function (e) { window.__errs.push(String(e.message)); });
  var bytes = Uint8Array.from(atob("${b64}"), function (ch) { return ch.charCodeAt(0); });
  document.getElementById("f").srcdoc = new TextDecoder("utf-8").decode(bytes);
</script></body></html>`,
);

const chrome = spawn(CHROME, [
  "--headless=new", `--remote-debugging-port=${PORT}`, "--no-first-run", "--no-default-browser-check",
  "--disable-gpu", `--user-data-dir=${join(sandbox, "profile")}`, "--window-size=1200,1600", "about:blank",
], { stdio: "ignore" });

function cleanup() {
  try { chrome.kill(); } catch (_) {}
  try { rmSync(sandbox, { recursive: true, force: true }); } catch (_) {}
}
process.on("exit", cleanup);

async function endpoint() {
  for (let i = 0; i < 80; i++) {
    try {
      const r = await fetch(`http://127.0.0.1:${PORT}/json/version`);
      return (await r.json()).webSocketDebuggerUrl;
    } catch { await new Promise((r) => setTimeout(r, 250)); }
  }
  throw new Error("Chrome never exposed a debugger endpoint");
}

const ws = new WebSocket(await endpoint());
let msgId = 0;
const waiting = new Map();
await new Promise((res) => (ws.onopen = res));
ws.onmessage = (e) => {
  const m = JSON.parse(e.data);
  if (m.id && waiting.has(m.id)) { waiting.get(m.id)(m); waiting.delete(m.id); }
};
const send = (method, params = {}, sessionId) =>
  new Promise((res, rej) => {
    const id = ++msgId;
    waiting.set(id, (m) => (m.error ? rej(new Error(`${method}: ${m.error.message}`)) : res(m.result)));
    ws.send(JSON.stringify({ id, method, params, sessionId }));
  });

const { targetInfos } = await send("Target.getTargets");
const page = targetInfos.find((t) => t.type === "page");
const { sessionId } = await send("Target.attachToTarget", { targetId: page.targetId, flatten: true });
const ev = async (expression) => {
  const r = await send("Runtime.evaluate", { expression, returnByValue: true, awaitPromise: true }, sessionId);
  if (r.exceptionDetails) throw new Error(r.exceptionDetails.exception?.description || "eval threw");
  return r.result.value;
};

await send("Page.enable", {}, sessionId);
await send("Page.navigate", { url: "file://" + harnessPath }, sessionId);
await new Promise((r) => setTimeout(r, 1800));

console.log("### frame render (headless Chrome, hostile interior)");
ok(await ev(`!!frames[0] && !!frames[0].document.querySelector("[data-fit-root]")`), "the artifact mounted");
ok((await ev(`window.__errs.length`)) === 0, "no script errors during mount");

// 💬 — the invariant that was silently missing on 28% of real artifacts.
const icons = await ev(`frames[0].document.querySelectorAll(".shelly-ask-btn").length`);
ok(icons >= 3, `gutter 💬 icons rendered on content blocks (found ${icons})`);
ok(
  await ev(`!frames[0].document.querySelector("[data-shelly-item] .shelly-ask-btn")`),
  "no 💬 inside a ballot item (the helper's exclusion holds)",
);

// The frame must never repaint an artifact that painted itself — see the :where() note.
const bg = await ev(`getComputedStyle(frames[0].document.body).backgroundColor`);
ok(bg === "rgb(251, 250, 246)", `the interior's own background survived injection (got ${bg})`);

// THE HAZARD: one click must leave the state SET. A second live handler would toggle it off,
// which is precisely how "the buttons are dead" gets reported.
await ev(`frames[0].document.querySelector('[data-action="approve"]').click()`);
ok(
  (await ev(`frames[0].document.querySelector("[data-shelly-item]").getAttribute("data-state")`)) === "approve",
  "one click on ✓ leaves state=approve",
);
ok(!(await ev(`frames[0].window.__hostileFired`)), "the competing hand-rolled handler never fired (capture veto)");
await ev(`frames[0].document.querySelector('[data-action="approve"]').click()`);
ok(
  (await ev(`frames[0].document.querySelector("[data-shelly-item]").getAttribute("data-state")`)) === null,
  "clicking ✓ again still un-marks it (the veto did not break the toggle)",
);

ok((await ev(`window.__msgs.filter(m=>m&&m.kind==="size").length`)) >= 1, "the size reporter posted");

// One unified submit: ballot decision AND ambient comment in a single message.
await ev(`frames[0].document.querySelector('[data-action="approve"]').click()`);
await ev(`(function(){var d=frames[0].document;d.querySelectorAll(".shelly-ask-btn")[1].click();
  var ta=d.querySelector(".shelly-composer textarea");ta.value="why this paragraph?";
  d.querySelector(".shelly-composer .save").click();})()`);
ok(await ev(`!!frames[0].document.querySelector(".shelly-annotation")`), "a saved 💬 renders as an annotation");

await ev(`window.__msgs.length = 0; frames[0].document.querySelector("[data-shelly-submit]").click()`);
await new Promise((r) => setTimeout(r, 600));
const subs = JSON.parse((await ev(`JSON.stringify(window.__msgs.filter(m=>m&&m.kind==="submit"))`)) || "[]");
ok(subs.length === 1, `exactly ONE submit reached the parent (got ${subs.length})`);
const text = subs[0]?.text || "";
ok(typeof subs[0]?.text === "string", "the submit carries text: (the only field the Board accepts)");
ok(/— Questions \/ comments —/.test(text), "the 💬 comment is sectioned into the submit");
ok(/why this paragraph\?/.test(text), "the typed comment text is carried");
ok(/— Decisions —/.test(text), "…alongside a Decisions section, in the SAME submit");
ok(/✓ Do it: Ship the thing/.test(text), "the ballot label is compiled in");
ok(await ev(`!!frames[0].document.querySelector(".cmp-submitted")`), "the 'working' splash appears on a real ack");

ws.close();
console.log(`\n=== frame render: ${pass} passed, ${fail} failed ===`);
process.exit(fail ? 1 : 0);
