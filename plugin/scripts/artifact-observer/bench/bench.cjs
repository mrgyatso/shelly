#!/usr/bin/env node
// Haiku-vs-Sonnet bench. For each representative turn:
//   - director @ haiku   (fast)            → schema → local Broadsheet renderer
//   - director @ sonnet  (pretty/director) → schema → local Broadsheet renderer
//   - designer @ sonnet  (pretty/all)      → bespoke HTML (turn B only)
// Records cost (total_cost_usd) + wall latency, and writes rendered HTML for visual judging.
const fs = require("fs");
const path = require("path");
const OBS = path.join(__dirname, "..");
const { callObserver } = require(path.join(OBS, "model.cjs"));
const { callDesigner } = require(path.join(OBS, "designer.cjs"));
const { normalizeState, renderArtifact } = require(path.join(OBS, "renderer.cjs"));

const outDir = path.join(__dirname, "out");
fs.mkdirSync(outDir, { recursive: true });
const job = { project: "claude-code-companion", sessionId: "bench-0000", unitKey: "claude-code-companion", shortid: "bench000", source: "claude-code-companion--bench" };

const TURNS = {
  A: [{
    user: "the artifact surfacing lag is back — the board takes ~600ms to show the observer artifact after a turn",
    assistant: "Found it: the watcher ingests the artifact ~640ms before the hook stamps the index, so the slug-fallback identity is frozen by the signature guard and the hero stays blank. Fixed by re-routing the artifact when the index identity lands, and waking surfacing off the throttled JS poll instead of waiting for it. Added an end-to-end trace harness (off by default). Tests green; pushed to master.",
    tools: [{ name: "Edit", file: "overlay/src/board.ts" }, { name: "Bash", file: "" }, { name: "Edit", file: "plugin/hooks/companion-observe" }],
    files: ["overlay/src/board.ts", "plugin/hooks/companion-observe"],
  }],
  B: [{
    user: "should the always-on artifact mode default to Sonnet for prettier docs, or keep Haiku to stay cheap?",
    assistant: "It's a real tradeoff. Sonnet gives sharper copy and better visual-component judgment, but it costs a full model call per turn and adds latency. A well-harnessed Haiku rendering through the new Broadsheet template may be close enough that the visual difference is marginal. The honest move is to bench both on quality AND cost on the new template before locking the default, rather than assuming pretty-first.",
    tools: [],
    files: [],
  }],
};

async function timed(fn) {
  const t0 = Date.now();
  try { const r = await fn(); return { ok: true, ms: Date.now() - t0, ...r }; }
  catch (e) { return { ok: false, ms: Date.now() - t0, error: String(e && e.message || e) }; }
}

async function director(turnKey, model) {
  const r = await timed(() => callObserver({ prior: null, turns: TURNS[turnKey], model }));
  if (r.ok) {
    const state = normalizeState(r.state, { title: `${job.project} update` });
    fs.writeFileSync(path.join(outDir, `director-${turnKey}-${model}.html`), renderArtifact(state, job));
    r.presentation = state.presentation; r.family = state.family; r.title = state.title;
    r.nextStepsCount = state.next_steps.length; r.visualsCount = state.visuals.length;
    delete r.state;
  }
  return { stage: `director:${turnKey}:${model}`, costUsd: r.totalCostUsd, ...r };
}

async function designer(turnKey) {
  const brief = TURNS[turnKey][0].user;
  const r = await timed(() => callDesigner({ prior: null, turns: TURNS[turnKey], brief, reason: "bench: scope=all bespoke", project: job.project }));
  if (r.ok) { fs.writeFileSync(path.join(outDir, `designer-${turnKey}-sonnet.html`), r.html); r.bytes = Buffer.byteLength(r.html); delete r.html; }
  return { stage: `designer:${turnKey}:sonnet`, costUsd: r.totalCostUsd, ...r };
}

(async () => {
  const results = [];
  // sequential for honest latency
  results.push(await director("A", "haiku"));
  results.push(await director("A", "sonnet"));
  results.push(await director("B", "haiku"));
  results.push(await director("B", "sonnet"));
  results.push(await designer("B"));
  for (const r of results) delete r.usage;
  fs.writeFileSync(path.join(outDir, "results.json"), JSON.stringify(results, null, 2));
  for (const r of results) {
    console.log(`${r.stage.padEnd(26)} ${r.ok ? "ok " : "ERR"} ${String(r.ms).padStart(6)}ms  $${(r.costUsd || 0).toFixed(4)}  ${r.presentation || r.error || ""} ${r.family || ""} steps=${r.nextStepsCount ?? "-"} viz=${r.visualsCount ?? "-"}`);
  }
})();
