#!/usr/bin/env node
// Phase 2 before/after: the SAME turn through the live Haiku director, twice.
//   BEFORE  — deltas only (today): the director reverse-engineers the snapshot from
//             {user, assistant, tools, files}.
//   AFTER   — deltas + agent_brief (#6): the director also gets the agent's own live
//             state (working/where/changed/next, with recommendation + why).
// Renders both through the local Broadsheet renderer so the quality gain is visible,
// and prints the next_steps each run produced (where the brief earns its keep).
//
// Run:  node bench/brief-ab.cjs           → writes bench/out + the two Board tiles
//       (needs the `claude` binary on PATH; ~2 cheap Haiku calls)
const fs = require("fs");
const path = require("path");
const os = require("os");
const OBS = path.join(__dirname, "..");
const { callObserver } = require(path.join(OBS, "model.cjs"));
const { normalizeState, renderArtifact } = require(path.join(OBS, "renderer.cjs"));

const outDir = path.join(__dirname, "out");
fs.mkdirSync(outDir, { recursive: true });
const artifactsDir = process.env.COMPANION_ARTIFACTS_DIR || path.join(os.homedir(), ".claude", "companion", "artifacts");

const job = {
  project: "claude-code-companion",
  sessionId: "brief-ab-0000",
  unitKey: "claude-code-companion",
  shortid: "briefab0",
  source: "claude-code-companion--briefab",
};

// One representative engineering turn. The assistant reply reports WHAT shipped but —
// as is typical — does NOT spell out the next decision; that lives in the agent's head
// (its brief), not the chat. So only the brief-informed run can surface it.
const TURN = [{
  user: "the artifact surfacing lag is back — the board takes ~600ms to show the observer artifact after a turn",
  assistant: "Found it: the watcher ingests the artifact ~640ms before the hook stamps the index, so the slug-fallback identity is frozen by the signature guard and the hero stays blank. Fixed by re-routing the artifact when the real index identity lands, and waking surfacing off the index event instead of the throttled JS poll. Added an end-to-end trace harness (off by default). Tests green; pushed to master.",
  tools: [{ name: "Edit", file: "overlay/src/board.ts" }, { name: "Bash", file: "" }, { name: "Edit", file: "plugin/hooks/companion-observe" }],
  files: ["overlay/src/board.ts", "plugin/hooks/companion-observe"],
}];

// The agent's own live state for that turn (the evolved roster brief). The `next`
// decision — default-on the trace harness for one release — is NOWHERE in the deltas.
const BRIEF = {
  headline: "Surfacing lag killed — artifacts appear the instant the index lands",
  summary: "Root-caused the ~640ms board lag to an index-vs-ingest race; fixed by re-routing on index-land plus waking surfacing off the index event. Shipped with a trace harness (off by default).",
  working: "Verifying the fix holds across rapid back-to-back turns",
  where: [
    "Re-route artifact when the real index identity lands (kills the slug-fallback freeze)",
    "Surfacing wakes off index-land, not the throttled ~600ms JS poll",
    "Trace harness landed behind COMPANION_TRACE (off by default)",
  ],
  changed: [
    "overlay/src/board.ts — re-route on index identity",
    "plugin/hooks/companion-observe — wake surfacing off the index event",
    "end-to-end trace harness (off by default)",
  ],
  next: [
    {
      title: "Ship the trace harness default-ON for one release to catch regressions",
      sub: "It's off by default; one release with it on would surface any residual race in the wild before we call it closed.",
      kind: "decision",
      recommendation: "Default-on for exactly one release, then flip back off",
      why: "The race was invisible until we built the harness — one release of real telemetry is cheap insurance",
    },
    {
      title: "Add a regression test: hero non-blank within 100ms of index-land",
      sub: "Lock the fix so the race can't silently return.",
      kind: "todo",
    },
  ],
  project: "claude-code-companion", is_repo: true, unit_key: "claude-code-companion",
};

async function run(label, brief) {
  const t0 = Date.now();
  const { state: raw, totalCostUsd } = await callObserver({ prior: null, turns: TURN, brief, model: process.env.BRIEF_AB_MODEL || "haiku" });
  const ms = Date.now() - t0;
  const state = normalizeState(raw, { title: `${job.project} update` });
  const html = renderArtifact(state, job);
  fs.writeFileSync(path.join(outDir, `${label}.html`), html);
  return { label, ms, costUsd: totalCostUsd || 0, state, html };
}

(async () => {
  // sequential for honest latency + cost
  const before = await run("before-deltas-only", null);
  const after = await run("after-brief-informed", BRIEF);

  // also publish the two real artifacts as Board tiles the user can open + feel
  const tiles = {
    "phase2-before-deltas-only.html": before.html,
    "phase2-after-brief-informed.html": after.html,
  };
  fs.mkdirSync(artifactsDir, { recursive: true });
  for (const [name, html] of Object.entries(tiles)) fs.writeFileSync(path.join(artifactsDir, name), html);

  const slim = (r) => ({
    label: r.label, ms: r.ms, costUsd: r.costUsd,
    title: r.state.title, summary: r.state.summary,
    should_write: r.state.should_write, layout: r.state.layout, family: r.state.family,
    next_steps: r.state.next_steps.map((s) => ({ title: s.title, kind: s.kind, detail: s.detail })),
  });
  const results = { before: slim(before), after: slim(after) };
  fs.writeFileSync(path.join(outDir, "results.json"), JSON.stringify(results, null, 2));

  for (const r of [before, after]) {
    console.log(`\n=== ${r.label} === ${r.ms}ms  $${(r.costUsd || 0).toFixed(4)}  layout=${r.state.layout} family=${r.state.family}`);
    console.log(`  title: ${r.state.title}`);
    console.log(`  next_steps:`);
    for (const s of r.state.next_steps) console.log(`    [${s.kind}] ${s.title}`);
  }
  console.log(`\nwrote bench/out/{before-deltas-only,after-brief-informed,results}.* and 2 Board tiles`);
})().catch((e) => { console.error(e.stack || String(e)); process.exit(1); });
