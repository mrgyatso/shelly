// Structural blocks — the Broadsheet kit. These are the page-level building blocks
// (masthead, lead, evidence, the Decide ballot) that sit alongside the 9 visual blocks
// in components.cjs. Each is a small, pure (state[, job]) -> HTML function sharing the
// rendererCss tokens, so a layout can be assembled by composing blocks. renderArtifact
// composes the Broadsheet preset (masthead -> lead -> visuals -> evidence -> ballot);
// later phases let the director choose a custom arrangement from this same kit.
const { esc, renderVisual } = require("./components.cjs");
const { renderClawd } = require("./clawd.cjs");

// Every block is a pure (state, ctx) -> HTML function — ctx carries render-time
// context (the job + the edition date) so blocks can be composed in any order by
// assemble() below, regardless of which fields each one happens to read.

// Masthead — Clawd as the publication emblem + project + edition line.
function masthead(state, ctx) {
  return `<header class="plate"><div class="brand">${renderClawd(state.clawd_pose)}<div class="word"><b>Companion</b><span>${esc(ctx.job.project)}</span></div></div><div class="ed">${esc(ctx.edition)}<span>${esc(state.presentation)}</span></div></header>`;
}

// Touches — the files this turn concerns, as compact mono chips (max 5 + overflow).
function touches(files) {
  if (!files.length) return "";
  return `<div class="touches"><span class="tl">Touches</span>${files.slice(0, 5).map((file) => `<code title="${esc(file)}">${esc(file.split("/").pop() || file)}</code>`).join("")}${files.length > 5 ? `<code>+${files.length - 5}</code>` : ""}</div>`;
}

// Lead — kicker (family) + dominant headline + standfirst + working chip + touches.
function lead(state) {
  return `<section class="lead"><p class="kicker">${esc(state.family)}</p><h1>${esc(state.title)}</h1>${state.summary ? `<p class="summary">${esc(state.summary)}</p>` : ""}${state.working ? `<p class="working">${esc(state.working)}</p>` : ""}${touches(state.files)}</section>`;
}

// Visuals — the registered visual blocks (components.cjs) the director selected.
function visuals(state) {
  const inner = state.visuals.map(renderVisual).filter(Boolean).join("");
  return inner ? `<div class="visuals">${inner}</div>` : "";
}

function evidenceBlock(title, items, tone = "") {
  if (!items.length) return "";
  return `<section class="evidence ${tone}"><h3>${esc(title)}</h3><ul>${items.map((item) => `<li>${esc(item)}</li>`).join("")}</ul></section>`;
}

// Evidence — the quiet, collapsible work log (changes / decisions / blockers).
function evidence(state) {
  const inner = [evidenceBlock("What changed", state.changes), evidenceBlock("Decisions", state.decisions), evidenceBlock("Blockers", state.blockers, "alert")].filter(Boolean).join("");
  return inner ? `<details class="evidence-wrap"><summary class="evidence-toggle">Evidence &amp; work log</summary><div class="evidence-grid">${inner}</div></details>` : "";
}

// The Decide ballot — the load-bearing decision surface. "Spend boldness on one
// memorable interaction": this is it. Elevated panel with an accent top-rule, a real
// header, generous tap targets, Do-all + Commit. Each move is ✓ do / ✎ note / ✗ skip
// (one choice per move). One shared comment rides the same Submit. The interaction
// script that drives it lives in renderArtifact (renderer.cjs).
function ballot(state) {
  if (!state.next_steps.length) return "";
  const n = state.next_steps.length;
  const moves = state.next_steps.map((item, index) => `<article class="step k-${esc(item.kind)}" data-item data-label="${esc(item.title)}" data-step="${index}"><div class="meta"><span class="kind">${esc(item.kind)}</span><h3>${esc(item.title)}</h3><p>${esc(item.detail)}</p></div><div class="acts" aria-label="Choose what to do"><button type="button" class="do" data-choice="do" title="Do it" aria-label="Do it">✓</button><button type="button" class="note" data-choice="note" title="Add a note" aria-label="Add note">✎</button><button type="button" class="skip" data-choice="skip" title="Skip" aria-label="Skip">✗</button></div></article>`).join("");
  return `<section class="ballot" aria-label="Decide"><header class="ballot-head"><h2>Decide</h2><span class="sub">${n} move${n === 1 ? "" : "s"} · steer the work</span></header><div class="steps">${moves}</div><label class="comment"><span>Add context</span><textarea id="comment" placeholder="A tweak, a constraint, or a note for the agent…"></textarea></label><div class="ballot-foot"><span class="tally" id="tally">Nothing marked yet</span><div class="foot-btns"><button id="doall" type="button" class="doall">✓ Do all</button><button id="submit" type="button" class="commit">Commit &amp; continue</button></div></div></section>`;
}

// The kit — every page-level block, keyed by name, all sharing the (state, ctx)
// signature so a layout is just an ordered list of names.
const BLOCKS = { masthead, lead, visuals, evidence, ballot };

// Presets — named block-arrays. "broadsheet" is today's skeleton, byte-for-byte.
// steer (decision-hero) and canvas (persistent rail) are the same kit in a different
// arrangement; they get their hero/frame block variants in a later phase, so for now
// they alias the broadsheet order (the registry + assemble are the Phase-2 deliverable;
// the distinct layouts come next).
const PRESETS = {
  broadsheet: ["masthead", "lead", "visuals", "evidence", "ballot"],
  steer: ["masthead", "lead", "visuals", "evidence", "ballot"],
  canvas: ["masthead", "lead", "visuals", "evidence", "ballot"],
};

// Assemble a layout from a preset name OR an explicit block-name array (the future
// model-chosen arrangement). Unknown names are skipped; unknown preset -> broadsheet.
function assemble(layout, state, ctx) {
  const names = Array.isArray(layout) ? layout : (PRESETS[layout] || PRESETS.broadsheet);
  return names.map((name) => (BLOCKS[name] ? BLOCKS[name](state, ctx) : "")).join("");
}

module.exports = { masthead, touches, lead, visuals, evidence, evidenceBlock, ballot, BLOCKS, PRESETS, assemble };
