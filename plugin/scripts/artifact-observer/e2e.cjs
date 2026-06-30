#!/usr/bin/env node
const fs = require("fs");
const os = require("os");
const path = require("path");
const { spawnSync } = require("child_process");
const { atomicWrite } = require("./lib.cjs");
const { normalizeState, renderArtifact } = require("./renderer.cjs");

const live = process.argv.includes("--live");
const outArg = process.argv.find((arg) => arg.startsWith("--out="));
const root = outArg ? path.resolve(outArg.slice(6)) : path.join(os.tmpdir(), `companion-observer-e2e-${Date.now()}`);
const previewsDir = path.join(root, "family-previews");
fs.mkdirSync(previewsDir, { recursive: true });

const visualByFamily = {
  answer: { type: "checklist", title: "What matters", note: "One clear answer with supporting facts.", items: [{ label: "Root cause identified", value: "yes", detail: "The worker was blocking in the hook.", status: "good" }] },
  brief: { type: "code_diff", title: "Changed surface", note: "The primary session no longer writes routine HTML.", items: [{ label: "Stop hook invokes model", value: "−", detail: "removed", status: "bad" }, { label: "Stop hook enqueues delta", value: "+", detail: "added", status: "good" }] },
  comparison: { type: "comparison", title: "Rendering paths", note: "Use the least expensive path that preserves the experience.", items: [{ label: "Routine", value: "Haiku", detail: "Structured state and local rendering", status: "good" }, { label: "Bespoke", value: "Sonnet", detail: "Custom interaction when appearance is the work", status: "active" }] },
  timeline: { type: "timeline", title: "Observer lifecycle", note: "Every slow step is outside the hook.", items: [{ label: "Capture", value: "0s", detail: "Queue the delta", status: "good" }, { label: "Batch", value: "30s", detail: "Coalesce nearby turns", status: "active" }, { label: "Render", value: "after", detail: "Publish one revision", status: "neutral" }] },
  gallery: { type: "option_gallery", title: "Choose a direction", note: "The component is interactive without generated JavaScript.", items: [{ label: "WorkBench", value: "Focused", detail: "Clawd and one thesis", status: "active" }, { label: "Signal room", value: "Dense", detail: "Metrics and timelines", status: "neutral" }, { label: "Studio", value: "Visual", detail: "Gallery and comparisons", status: "neutral" }] },
  metrics: { type: "bar_chart", title: "Token shape", note: "Illustrative fixture data.", items: [{ label: "Old Opus HTML", value: "12000", detail: "Full artifact generation", status: "bad" }, { label: "Haiku state", value: "3500", detail: "Structured batch", status: "good" }, { label: "Local render", value: "0", detail: "No model tokens", status: "good" }] },
  decision: { type: "before_after", title: "Architecture change", note: "The decision is visible at a glance.", items: [{ label: "Before", value: "Opus", detail: "Primary session writes every artifact", status: "bad" }, { label: "After", value: "Hybrid", detail: "Haiku composes; Sonnet invents only when needed", status: "good" }] },
};

const poses = ["thinking", "typing", "conducting", "juggling", "beacon", "happy", "wizard"];
const accents = ["blue", "mint", "clay", "amber", "violet", "blue", "clay"];
Object.keys(visualByFamily).forEach((family, index) => {
  const state = normalizeState({
    should_write: true, presentation: family === "answer" ? "routine" : "composed", family,
    clawd_pose: poses[index], accent: accents[index], escalation_reason: "", bespoke_brief: "",
    title: `${family[0].toUpperCase()}${family.slice(1)} family`,
    summary: "A Companion-specific workbench shell that stays useful even when the underlying exchange is simple.",
    working: "Fixture ready for visual review", changes: ["Family-specific composition"],
    decisions: ["Clawd is the signature, not decoration"], blockers: [],
    next_steps: [{ title: "Keep this family", detail: "Mark the directions worth carrying forward.", kind: "decision" }],
    files: [], visuals: [visualByFamily[family]],
  });
  atomicWrite(path.join(previewsDir, `${family}.html`), renderArtifact(state, { project: "companion-e2e", unitKey: "e2e", shortid: family, sessionId: `e2e-${family}` }));
});

const fakeBespoke = `<!doctype html><html><head><meta charset="utf-8"><title>Bespoke mascot lab</title><script type="application/json" id="companion-meta">{"subject":"Mascot lab","summary":"Interactive Sonnet-path fixture","project":"companion-e2e"}</script><style>*{box-sizing:border-box}body{margin:0;background:#171a1f;color:#f2efe8;font-family:system-ui}main{width:820px;padding:30px}.grid{display:grid;grid-template-columns:repeat(3,1fr);gap:10px}button{min-height:120px;border:1px solid #69717d;background:#222831;color:inherit;cursor:pointer}button:focus,button:hover{border-color:#3d7eff;background:#29354a}</style></head><body><main data-fit-root><h1>Pick Clawd's working pose</h1><div class="grid"><button>Debugger</button><button>Conductor</button><button>Builder</button></div></main><script>new ResizeObserver(function(){parent.postMessage({source:'companion-artifact',kind:'size',width:880,height:330},'*')}).observe(document.querySelector('[data-fit-root]'))</script></body></html>`;

const fakeStates = {
  routine: {
    should_write: true, presentation: "routine", family: "answer", clawd_pose: "thinking", accent: "blue",
    escalation_reason: "", bespoke_brief: "", title: "The queue is healthy", summary: "The hook returns immediately and the worker owns model processing.", working: "Ready for integration",
    changes: ["Capture and processing are separated"], decisions: ["Keep routine rendering deterministic"], blockers: [],
    next_steps: [{ title: "Run live smoke", detail: "Verify Haiku auth when the subscription returns.", kind: "todo" }], files: ["capture.cjs"], visuals: [],
  },
  composed: {
    should_write: true, presentation: "composed", family: "comparison", clawd_pose: "conducting", accent: "mint",
    escalation_reason: "", bespoke_brief: "", title: "Two rendering lanes", summary: "Routine composition stays cheap while visual invention remains available.", working: "Hybrid router complete",
    changes: ["Added component families", "Added Sonnet escalation"], decisions: ["Use deterministic hard triggers"], blockers: [],
    next_steps: [{ title: "Review the shells", detail: "Open the generated family previews.", kind: "decision" }], files: ["renderer.cjs"], visuals: [visualByFamily.comparison],
  },
};

function writeTranscript(file, user, assistant) {
  const entries = [
    { message: { role: "user", content: user } },
    { message: { role: "assistant", content: [
      { type: "tool_use", name: "Edit", input: { file_path: path.join(root, "fixture.js") } },
      { type: "text", text: assistant },
    ] } },
  ];
  fs.writeFileSync(file, entries.map((entry) => JSON.stringify(entry)).join("\n"));
}

function runCase(name, user, assistant, fakeState) {
  const dir = path.join(root, `pipeline-${name}`);
  const stateDir = path.join(dir, "state");
  const artifactsDir = path.join(dir, "artifacts");
  const transcript = path.join(dir, "session.jsonl");
  fs.mkdirSync(dir, { recursive: true });
  writeTranscript(transcript, user, assistant);
  const payload = JSON.stringify({ session_id: `${name.padEnd(8, "0")}-e2e`, cwd: process.cwd(), transcript_path: transcript });
  const baseEnv = {
    ...process.env,
    COMPANION_OBSERVER_IGNORE_MODE: "1",
    COMPANION_OBSERVER_NO_START: "1",
    COMPANION_OBSERVER_STATE_DIR: stateDir,
    COMPANION_ARTIFACTS_DIR: artifactsDir,
    COMPANION_OBSERVER_INDEX_PATH: path.join(dir, "artifact-index.json"),
  };
  let result = spawnSync(process.execPath, [path.join(__dirname, "capture.cjs")], { input: payload, env: baseEnv, timeout: 5000 });
  if (result.status !== 0) throw new Error(`${name} capture failed: ${result.stderr}`);
  const workerEnv = {
    ...baseEnv,
    COMPANION_OBSERVER_DEBOUNCE_MS: "0",
    COMPANION_OBSERVER_IDLE_EXIT_MS: "20",
    COMPANION_OBSERVER_POLL_MS: "5",
  };
  if (!live && fakeState) workerEnv.COMPANION_OBSERVER_FAKE_RESPONSE = JSON.stringify(fakeState);
  if (!live && name === "bespoke") workerEnv.COMPANION_DESIGNER_FAKE_HTML = fakeBespoke;
  result = spawnSync(process.execPath, [path.join(__dirname, "worker.cjs")], { env: workerEnv, timeout: live ? 300000 : 5000 });
  if (result.status !== 0) throw new Error(`${name} worker failed: ${result.stderr}`);
  const artifacts = fs.existsSync(artifactsDir) ? fs.readdirSync(artifactsDir).map((file) => path.join(artifactsDir, file)) : [];
  if (!artifacts.length) {
    const dead = path.join(stateDir, "dead");
    const failure = fs.existsSync(dead) && fs.readdirSync(dead).length ? JSON.parse(fs.readFileSync(path.join(dead, fs.readdirSync(dead)[0]), "utf8")).lastError : "no artifact was published";
    throw new Error(`${name} produced no artifact: ${failure}`);
  }
  return { name, artifacts, metrics: fs.existsSync(path.join(stateDir, "metrics.jsonl")) ? fs.readFileSync(path.join(stateDir, "metrics.jsonl"), "utf8").trim().split("\n").filter(Boolean).map(JSON.parse) : [] };
}

const results = [
  runCase("routine", "Explain the observer state after the implementation.", "Implemented the observer separation and verified the queue. The routine answer should stay focused and use the default shell.", fakeStates.routine),
  runCase("composed", "Compare the routine and bespoke rendering lanes.", "Implemented both lanes and verified their routing. The comparison is supported by the current architecture and test results.", fakeStates.composed),
  runCase("bespoke", "Show me ten interactive mascot variants and what each would look like live.", "Prepared the mascot exploration request for the visual designer.", null),
];

const summary = { mode: live ? "live" : "fake", root, familyPreviews: Object.keys(visualByFamily).length, results };
fs.writeFileSync(path.join(root, "summary.json"), JSON.stringify(summary, null, 2));
process.stdout.write(`${JSON.stringify(summary, null, 2)}\n`);
