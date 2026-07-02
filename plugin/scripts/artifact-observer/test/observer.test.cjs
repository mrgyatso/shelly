const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const { spawnSync } = require("node:child_process");
const test = require("node:test");

const observerDir = path.resolve(__dirname, "..");
const { detectVisualIntent, extractCurrentTurn, isSubstantive, turnHash } = require("../lib.cjs");
const { observerPrompt, parseClaudeOutput } = require("../model.cjs");
const { validateBespokeHtml } = require("../designer.cjs");
const { RENDERERS, renderVisual } = require("../components.cjs");
const { artifactFilename, normalizeState, renderArtifact } = require("../renderer.cjs");

function tempDir() {
  return fs.mkdtempSync(path.join(os.tmpdir(), "companion-observer-"));
}

// A stub `claude` binary that trips <home>/model-was-called if it is EVER spawned. The
// cheap/mid render path must never invoke a model, so tests point the observer bin at this
// and assert the sentinel stays absent.
function sentinelBin(home) {
  const bin = path.join(home, "claude-stub.sh");
  fs.writeFileSync(bin, `#!/bin/sh\ntouch "${path.join(home, "model-was-called")}"\necho '{"result":"stub"}'\n`);
  fs.chmodSync(bin, 0o755);
  return bin;
}

function transcript(entries) {
  const dir = tempDir();
  const file = path.join(dir, "session.jsonl");
  fs.writeFileSync(file, entries.map((entry) => JSON.stringify(entry)).join("\n"));
  return file;
}

test("extractCurrentTurn reads only the latest human turn and strips private text", () => {
  const file = transcript([
    { message: { role: "user", content: [{ type: "text", text: "old request" }] } },
    { message: { role: "assistant", content: [{ type: "text", text: "old response" }] } },
    { message: { role: "user", content: [{ type: "text", text: "build it <private>secret</private>" }] } },
    { message: { role: "assistant", content: [
      { type: "tool_use", name: "Edit", input: { file_path: "/repo/app.js" } },
      { type: "text", text: "Implemented the queue and verified recovery." },
    ] } },
  ]);
  const turn = extractCurrentTurn(file, "/tmp/artifacts");
  assert.match(turn.user, /private content omitted/);
  assert.doesNotMatch(turn.user, /secret/);
  assert.equal(turn.assistant, "Implemented the queue and verified recovery.");
  assert.deepEqual(turn.files, ["/repo/app.js"]);
  assert.equal(turn.wroteArtifact, false);
  assert.equal(isSubstantive(turn), true);
});

test("extractCurrentTurn suppresses observer work when the primary agent wrote HTML", () => {
  const file = transcript([
    { message: { role: "user", content: "show me a bespoke design" } },
    { message: { role: "assistant", content: [
      { type: "tool_use", name: "Write", input: { file_path: "/tmp/artifacts/design.html" } },
      { type: "text", text: "Done." },
    ] } },
  ]);
  assert.equal(extractCurrentTurn(file, "/tmp/artifacts").wroteArtifact, true);
});

test("turn hashes are stable and sensitive to changed deltas", () => {
  const turn = { user: "u", assistant: "a", tools: [], files: [], wroteArtifact: false };
  assert.equal(turnHash(turn), turnHash({ ...turn }));
  assert.notEqual(turnHash(turn), turnHash({ ...turn, assistant: "b" }));
});

test("hard visual intent catches mockups and variants without escalating ordinary questions", () => {
  assert.match(detectVisualIntent({ user: "Show me ten mascot variants I can click through" }), /visual|variant/);
  assert.match(detectVisualIntent({ user: "What would the new onboarding screen look like?" }), /look like/);
  assert.equal(detectVisualIntent({ user: "What caused the build to fail?" }), null);
});

test("model prompt contains only prior compact state and supplied deltas", () => {
  const prompt = JSON.parse(observerPrompt({ title: "Prior" }, [{ user: "u", assistant: "a", tools: [], files: [] }]));
  assert.equal(prompt.prior_state.title, "Prior");
  assert.equal(prompt.new_turn_deltas.length, 1);
  assert.equal(parseClaudeOutput(JSON.stringify({ structured_output: { should_write: false }, usage: { input_tokens: 12 } })).state.should_write, false);
  assert.equal(parseClaudeOutput(JSON.stringify({ structured_output: { should_write: false }, usage: { input_tokens: 12 } })).usage.input_tokens, 12);
});

test("renderer creates one safe interactive artifact from normalized state", () => {
  const state = normalizeState({
    should_write: true,
    presentation: "composed",
    family: "metrics",
    clawd_pose: "typing",
    accent: "mint",
    title: "Queue <ready>",
    summary: "Background observer is running.",
    working: "Testing",
    changes: ["Thin hook"],
    decisions: ["Use Haiku"],
    blockers: [],
    next_steps: [{ title: "Ship", detail: "Verify first", kind: "todo" }],
    files: ["plugin/hooks/companion-observe"],
    visuals: [{ type: "bar_chart", title: "Checks", note: "All green", items: [
      { label: "Tests", value: "8", detail: "Passing", status: "good" },
      { label: "Failures", value: "0", detail: "None", status: "neutral" },
    ] }],
  });
  const job = { project: "companion", unitKey: "companion", shortid: "12345678", sessionId: "12345678-rest" };
  const html = renderArtifact(state, job);
  assert.match(html, /Queue &lt;ready&gt;/);
  assert.match(html, /data-fit-root/);
  assert.match(html, /companion-artifact/);
  assert.match(html, /clawd--typing/);
  assert.match(html, /visual-bar_chart/);
  assert.match(html, /family-metrics/);
  assert.equal(artifactFilename(job), "observer-companion-12345678.html");
});

test("every registered visual component renders from the shared item contract", () => {
  const items = [
    { label: "Alpha", value: "42", detail: "First", status: "good" },
    { label: "Beta", value: "18", detail: "Second", status: "warn" },
  ];
  for (const type of Object.keys(RENDERERS)) {
    const html = renderVisual({ type, title: type, note: "note", items });
    assert.match(html, new RegExp(`visual-${type}`));
    assert.match(html, /Alpha/);
  }
});

test("bespoke designer validation accepts safe interactive HTML and rejects network code", () => {
  const safe = '<!doctype html><html><head><script type="application/json" id="companion-meta">{}</script></head><body><main data-fit-root>Preview</main><script>new ResizeObserver(function(){parent.postMessage({source:"companion-artifact",kind:"size"},"*")}).observe(document.querySelector("main"))</script></body></html>';
  assert.equal(validateBespokeHtml(safe), safe);
  assert.throws(() => validateBespokeHtml(safe.replace("</main>", '<script>fetch("https://x.test")</script></main>')), /network/);
});

test("capture hook enqueues once and deduplicates the same Stop payload", () => {
  const home = tempDir();
  const stateDir = path.join(home, "observer");
  const file = transcript([
    { message: { role: "user", content: "implement the observer" } },
    { message: { role: "assistant", content: [
      { type: "tool_use", name: "Edit", input: { file_path: "/repo/worker.cjs" } },
      { type: "text", text: "Implemented the worker and tests." },
    ] } },
  ]);
  const payload = JSON.stringify({ session_id: "aaaaaaaa-bbbb", cwd: home, transcript_path: file });
  const env = {
    ...process.env,
    HOME: home,
    COMPANION_OBSERVER_STATE_DIR: stateDir,
    COMPANION_ARTIFACTS_DIR: path.join(home, "artifacts"),
    COMPANION_OBSERVER_NO_START: "1",
  };
  for (let i = 0; i < 2; i += 1) {
    const result = spawnSync(process.execPath, [path.join(observerDir, "capture.cjs")], { input: payload, env });
    assert.equal(result.status, 0, result.stderr.toString());
  }
  assert.equal(fs.readdirSync(path.join(stateDir, "queue")).length, 1);
  const queued = JSON.parse(fs.readFileSync(path.join(stateDir, "queue", fs.readdirSync(path.join(stateDir, "queue"))[0]), "utf8"));
  assert.equal(queued.hardBespokeReason, null);
});

test("capture hook keeps explicit visual requests even when the reply is short", () => {
  const home = tempDir();
  const stateDir = path.join(home, "observer");
  const file = transcript([
    { message: { role: "user", content: "Show me three clickable mascot variants" } },
    { message: { role: "assistant", content: "Here are three compact options." } },
  ]);
  const payload = JSON.stringify({ session_id: "visual-smoke", cwd: home, transcript_path: file });
  const result = spawnSync(process.execPath, [path.join(observerDir, "capture.cjs")], {
    input: payload,
    env: {
      ...process.env,
      HOME: home,
      COMPANION_OBSERVER_STATE_DIR: stateDir,
      COMPANION_ARTIFACTS_DIR: path.join(home, "artifacts"),
      COMPANION_OBSERVER_NO_START: "1",
    },
  });
  assert.equal(result.status, 0, result.stderr.toString());
  const [queueFile] = fs.readdirSync(path.join(stateDir, "queue"));
  const queued = JSON.parse(fs.readFileSync(path.join(stateDir, "queue", queueFile), "utf8"));
  assert.match(queued.hardBespokeReason, /visual|variant/);
});

test("worker coalesces jobs, renders locally from the brief (no model), indexes output, and exits idle", () => {
  const home = tempDir();
  const stateDir = path.join(home, "observer");
  const queueDir = path.join(stateDir, "queue");
  const artifactsDir = path.join(home, ".claude", "companion", "artifacts");
  fs.mkdirSync(queueDir, { recursive: true });
  const base = {
    version: 1,
    sessionId: "abcd1234-rest",
    shortid: "abcd1234",
    cwd: home,
    project: "companion",
    unitKey: "companion",
    availableAt: 0,
    attempts: 0,
    // The agent authors the artifact in its live brief; a mid tier renders locally, no model.
    brief: {
      working: "Ready",
      where: ["Queue", "Renderer"],
      next: [{ title: "Verify", sub: "Run the suite", kind: "todo" }],
      artifact: {
        tier: "mid", title: "Observer shipped", summary: "The isolated observer works.",
        accent: "blue", family: "brief", decisions: ["Code render by default"],
        visuals: [{ type: "checklist", title: "Verification", items: [
          { label: "Tests", value: "pass", detail: "Suite is green", status: "good" },
        ] }],
      },
    },
  };
  for (let i = 0; i < 2; i += 1) {
    fs.writeFileSync(path.join(queueDir, `${i}.json`), JSON.stringify({
      ...base,
      id: String(i),
      createdAt: Date.now() - 100,
      turns: [{ user: `u${i}`, assistant: `a${i}`, tools: [], files: [] }],
    }));
  }
  const result = spawnSync(process.execPath, [path.join(observerDir, "worker.cjs")], {
    env: {
      ...process.env,
      HOME: home,
      COMPANION_OBSERVER_STATE_DIR: stateDir,
      COMPANION_ARTIFACTS_DIR: artifactsDir,
      COMPANION_OBSERVER_DEBOUNCE_MS: "0",
      COMPANION_OBSERVER_IDLE_EXIT_MS: "20",
      COMPANION_OBSERVER_POLL_MS: "5",
      COMPANION_OBSERVER_CLAUDE_BIN: sentinelBin(home),
    },
    timeout: 5000,
  });
  assert.equal(result.status, 0, result.stderr.toString());
  assert.deepEqual(fs.readdirSync(queueDir), []);
  const artifact = path.join(artifactsDir, "observer-companion-abcd1234.html");
  assert.equal(fs.existsSync(artifact), true);
  assert.match(fs.readFileSync(artifact, "utf8"), /Observer shipped/);
  assert.equal(fs.existsSync(path.join(home, "model-was-called")), false); // zero model spawns
  const index = JSON.parse(fs.readFileSync(path.join(home, ".claude", "companion", "artifact-index.json"), "utf8"));
  assert.equal(index[path.resolve(artifact)].unit_key, "companion");
  const metric = JSON.parse(fs.readFileSync(path.join(stateDir, "metrics.jsonl"), "utf8").trim());
  assert.equal(metric.batchedTurns, 2);
  assert.equal(metric.stage, "render");
  assert.equal(metric.model, null);
});

test("hard visual intent bypasses Haiku and publishes a one-off Sonnet artifact", () => {
  const home = tempDir();
  const stateDir = path.join(home, "observer");
  const queueDir = path.join(stateDir, "queue");
  const artifactsDir = path.join(home, "artifacts");
  fs.mkdirSync(queueDir, { recursive: true });
  fs.writeFileSync(path.join(queueDir, "visual.json"), JSON.stringify({
    version: 1, id: "visual", sessionId: "facefeed-rest", shortid: "facefeed",
    cwd: home, project: "companion", unitKey: "companion", createdAt: Date.now() - 100,
    availableAt: 0, attempts: 0, hardBespokeReason: "requested visual character variants",
    turns: [{ user: "Show me ten mascot variants", assistant: "I explored the mascot direction.", tools: [], files: [] }],
  }));
  const bespoke = '<!doctype html><html><head><title>Mascot gallery</title><script type="application/json" id="companion-meta">{}</script></head><body><main data-fit-root><button>Variant one</button></main><script>new ResizeObserver(function(){parent.postMessage({source:"companion-artifact",kind:"size"},"*")}).observe(document.querySelector("main"))</script></body></html>';
  const result = spawnSync(process.execPath, [path.join(observerDir, "worker.cjs")], {
    env: {
      ...process.env, HOME: home, COMPANION_OBSERVER_STATE_DIR: stateDir,
      COMPANION_ARTIFACTS_DIR: artifactsDir, COMPANION_OBSERVER_DEBOUNCE_MS: "0",
      COMPANION_OBSERVER_IDLE_EXIT_MS: "20", COMPANION_OBSERVER_POLL_MS: "5",
      COMPANION_OBSERVER_FAKE_RESPONSE: "not-json",
      COMPANION_DESIGNER_FAKE_HTML: bespoke,
    },
    timeout: 5000,
  });
  assert.equal(result.status, 0, result.stderr.toString());
  const files = fs.readdirSync(artifactsDir);
  assert.equal(files.length, 1);
  assert.match(files[0], /^bespoke-companion-/);
  assert.match(fs.readFileSync(path.join(artifactsDir, files[0]), "utf8"), /Variant one/);
  const metric = JSON.parse(fs.readFileSync(path.join(stateDir, "metrics.jsonl"), "utf8").trim());
  assert.equal(metric.stage, "designer");
});

test("an agent-selected high tier routes the turn to the Sonnet designer (dial=agent default)", () => {
  const home = tempDir();
  const stateDir = path.join(home, "observer");
  const queueDir = path.join(stateDir, "queue");
  const artifactsDir = path.join(home, "artifacts");
  fs.mkdirSync(queueDir, { recursive: true });
  // No dial file in this HOME ⇒ default `agent` ⇒ the brief's own tier:high drives the route.
  fs.writeFileSync(path.join(queueDir, "soft.json"), JSON.stringify({
    version: 1, id: "soft", sessionId: "cafebabe-rest", shortid: "cafebabe",
    cwd: home, project: "companion", unitKey: "companion", createdAt: Date.now() - 100,
    availableAt: 0, attempts: 0, hardBespokeReason: null, tier: "high",
    brief: { working: "Designing", where: [], next: [], artifact: {
      tier: "high", bespoke_brief: "Build an interactive spatial comparison of the two layouts",
    } },
    turns: [{ user: "Help me explore the feel of this", assistant: "The choice depends on spatial interaction.", tools: [{ name: "Edit", file: "x" }], files: ["x"] }],
  }));
  const bespoke = '<!doctype html><html><head><title>Spatial comparison</title><script type="application/json" id="companion-meta">{}</script></head><body><main data-fit-root>Interactive comparison</main><script>new ResizeObserver(function(){parent.postMessage({source:"companion-artifact",kind:"size"},"*")}).observe(document.querySelector("main"))</script></body></html>';
  const result = spawnSync(process.execPath, [path.join(observerDir, "worker.cjs")], {
    env: {
      ...process.env, HOME: home, COMPANION_OBSERVER_STATE_DIR: stateDir,
      COMPANION_ARTIFACTS_DIR: artifactsDir, COMPANION_OBSERVER_DEBOUNCE_MS: "0",
      COMPANION_OBSERVER_IDLE_EXIT_MS: "20", COMPANION_OBSERVER_POLL_MS: "5",
      COMPANION_DESIGNER_FAKE_HTML: bespoke,
    }, timeout: 5000,
  });
  assert.equal(result.status, 0, result.stderr.toString());
  const files = fs.readdirSync(artifactsDir);
  assert.equal(files.length, 1);
  assert.match(files[0], /^bespoke-companion-/);
  const metrics = fs.readFileSync(path.join(stateDir, "metrics.jsonl"), "utf8").trim().split("\n").map(JSON.parse);
  assert.deepEqual(metrics.map((metric) => metric.stage), ["designer"]);
});

test("worker retries designer failures and dead-letters after the third attempt", () => {
  const home = tempDir();
  const stateDir = path.join(home, "observer");
  const queueDir = path.join(stateDir, "queue");
  fs.mkdirSync(queueDir, { recursive: true });
  fs.writeFileSync(path.join(stateDir, "worker.lock"), "99999999");
  // A high-tier job whose designer output never validates ⇒ callDesigner rejects every attempt.
  fs.writeFileSync(path.join(queueDir, "failed.json"), JSON.stringify({
    version: 1,
    id: "failed",
    sessionId: "deadbeef-rest",
    shortid: "deadbeef",
    cwd: home,
    project: "companion",
    unitKey: "companion",
    createdAt: Date.now() - 100,
    availableAt: 0,
    attempts: 0,
    tier: "high",
    brief: { working: "x", where: [], next: [], artifact: { tier: "high", bespoke_brief: "make it" } },
    turns: [{ user: "u", assistant: "a", tools: [{ name: "Edit", file: "x" }], files: ["x"] }],
  }));
  const result = spawnSync(process.execPath, [path.join(observerDir, "worker.cjs")], {
    env: {
      ...process.env,
      HOME: home,
      COMPANION_OBSERVER_STATE_DIR: stateDir,
      COMPANION_ARTIFACTS_DIR: path.join(home, "artifacts"),
      COMPANION_OBSERVER_DEBOUNCE_MS: "0",
      COMPANION_OBSERVER_RETRY_BASE_MS: "1",
      COMPANION_OBSERVER_IDLE_EXIT_MS: "20",
      COMPANION_OBSERVER_POLL_MS: "2",
      COMPANION_TIER: "bespoke",
      COMPANION_DESIGNER_FAKE_HTML: "<p>not a complete document</p>", // fails validateBespokeHtml
    },
    timeout: 5000,
  });
  assert.equal(result.status, 0, result.stderr.toString());
  assert.deepEqual(fs.readdirSync(queueDir), []);
  const dead = fs.readdirSync(path.join(stateDir, "dead"));
  assert.equal(dead.length, 1);
  const job = JSON.parse(fs.readFileSync(path.join(stateDir, "dead", dead[0]), "utf8"));
  assert.equal(job.attempts, 3);
  assert.match(job.lastError, /complete HTML document|designer/);
});

const MODE_TURN = [
  { message: { role: "user", content: "implement the observer" } },
  { message: { role: "assistant", content: [
    { type: "tool_use", name: "Edit", input: { file_path: "/repo/worker.cjs" } },
    { type: "text", text: "Implemented the worker and tests." },
  ] } },
];

function captureInMode(mode) {
  const home = tempDir();
  const stateDir = path.join(home, "observer");
  if (mode) {
    fs.mkdirSync(path.join(home, ".claude", "companion"), { recursive: true });
    fs.writeFileSync(path.join(home, ".claude", "companion", "mode"), `${mode}\n`);
  }
  const file = transcript(MODE_TURN);
  const payload = JSON.stringify({ session_id: `${mode || "default"}01-rest`, cwd: home, transcript_path: file });
  const result = spawnSync(process.execPath, [path.join(observerDir, "capture.cjs")], {
    input: payload,
    env: {
      ...process.env,
      HOME: home,
      COMPANION_OBSERVER_STATE_DIR: stateDir,
      COMPANION_ARTIFACTS_DIR: path.join(home, "artifacts"),
      COMPANION_OBSERVER_NO_START: "1",
      COMPANION_OBSERVER_IGNORE_MODE: "",
    },
  });
  assert.equal(result.status, 0, result.stderr.toString());
  return stateDir;
}

test("capture hook stays silent in manual mode", () => {
  const stateDir = captureInMode("manual");
  assert.equal(fs.existsSync(path.join(stateDir, "queue")), false);
});

test("capture stamps alwaysWrite only in always mode (selective default does not)", () => {
  function queued(stateDir) {
    const [queueFile] = fs.readdirSync(path.join(stateDir, "queue"));
    return JSON.parse(fs.readFileSync(path.join(stateDir, "queue", queueFile), "utf8"));
  }
  assert.equal(queued(captureInMode("always")).alwaysWrite, true);
  assert.equal(queued(captureInMode(null)).alwaysWrite, false); // absent file → selective default
});

test("resolveMode: per-unit override wins, else global, else selective", () => {
  const { resolveMode } = require("../capture.cjs");
  const dir = tempDir();
  const modeFile = path.join(dir, "mode");
  const unitFile = path.join(dir, "mode.proj");
  // absent files → selective default
  assert.equal(resolveMode(dir, "proj"), "selective");
  // global only
  fs.writeFileSync(modeFile, "always");
  assert.equal(resolveMode(dir, "proj"), "always");
  // per-unit override beats global for THIS unit only
  fs.writeFileSync(unitFile, "manual");
  assert.equal(resolveMode(dir, "proj"), "manual");
  assert.equal(resolveMode(dir, "other"), "always"); // a different unit still sees global
  // `agent` is a real override (→ selective), not a fall-through to global
  fs.writeFileSync(unitFile, "agent");
  assert.equal(resolveMode(dir, "proj"), "selective");
  // empty/garbage per-unit file falls through to global
  fs.writeFileSync(unitFile, "  \n");
  assert.equal(resolveMode(dir, "proj"), "always");
});

test("globallyDisabled is true only for global-manual with no per-unit overrides", () => {
  const { globallyDisabled } = require("../capture.cjs");
  const dir = tempDir();
  assert.equal(globallyDisabled(dir), false); // no mode file → selective default, not disabled
  fs.writeFileSync(path.join(dir, "mode"), "manual");
  assert.equal(globallyDisabled(dir), true); // global manual, no overrides → off
  fs.writeFileSync(path.join(dir, "mode.proj"), "always");
  assert.equal(globallyDisabled(dir), false); // an override exists → must fall through
});

test("the off tier dial suppresses the artifact entirely (no write, no model)", () => {
  const home = tempDir();
  const stateDir = path.join(home, "observer");
  const queueDir = path.join(stateDir, "queue");
  const artifactsDir = path.join(home, ".claude", "companion", "artifacts");
  fs.mkdirSync(queueDir, { recursive: true });
  // The agent authored a high tier, but the dial=off must override and write nothing.
  fs.writeFileSync(path.join(queueDir, "off.json"), JSON.stringify({
    version: 1,
    id: "off",
    sessionId: "feedf00d-rest",
    shortid: "feedf00d",
    cwd: home,
    project: "companion",
    unitKey: "companion",
    createdAt: Date.now() - 100,
    availableAt: 0,
    attempts: 0,
    tier: "high",
    brief: { working: "Ready", where: ["a"], next: [], artifact: { tier: "high", bespoke_brief: "x" } },
    turns: [{ user: "u", assistant: "a", tools: [], files: [] }],
  }));
  const result = spawnSync(process.execPath, [path.join(observerDir, "worker.cjs")], {
    env: {
      ...process.env,
      HOME: home,
      COMPANION_OBSERVER_STATE_DIR: stateDir,
      COMPANION_ARTIFACTS_DIR: artifactsDir,
      COMPANION_OBSERVER_DEBOUNCE_MS: "0",
      COMPANION_OBSERVER_IDLE_EXIT_MS: "20",
      COMPANION_OBSERVER_POLL_MS: "5",
      COMPANION_TIER: "off",
      COMPANION_OBSERVER_CLAUDE_BIN: sentinelBin(home),
    },
    timeout: 5000,
  });
  assert.equal(result.status, 0, result.stderr.toString());
  assert.deepEqual(fs.readdirSync(queueDir), []); // job consumed
  assert.equal(fs.existsSync(artifactsDir) ? fs.readdirSync(artifactsDir).length : 0, 0); // nothing written
  assert.equal(fs.existsSync(path.join(home, "model-was-called")), false); // and no model spawned
});

test("quality=pretty (legacy compat) forces a cheap turn through the Sonnet designer", () => {
  const home = tempDir();
  const stateDir = path.join(home, "observer");
  const queueDir = path.join(stateDir, "queue");
  const artifactsDir = path.join(home, "artifacts");
  fs.mkdirSync(queueDir, { recursive: true });
  // The agent authored a cheap tier; the legacy quality=pretty dial must still bridge to bespoke.
  fs.writeFileSync(path.join(queueDir, "pretty.json"), JSON.stringify({
    version: 1, id: "pretty", sessionId: "0ddba11a-rest", shortid: "0ddba11a",
    cwd: home, project: "companion", unitKey: "companion", createdAt: Date.now() - 100,
    availableAt: 0, attempts: 0, hardBespokeReason: null, tier: "cheap",
    brief: { working: "Shipped the renderer", where: [], next: [], artifact: { tier: "cheap" } },
    turns: [{ user: "ship it", assistant: "Shipped the renderer.", tools: [{ name: "Edit", file: "x" }], files: ["x"] }],
  }));
  const bespoke = '<!doctype html><html><head><title>Pretty</title><script type="application/json" id="companion-meta">{}</script></head><body><main data-fit-root>Pretty surface</main><script>new ResizeObserver(function(){parent.postMessage({source:"companion-artifact",kind:"size"},"*")}).observe(document.querySelector("main"))</script></body></html>';
  const result = spawnSync(process.execPath, [path.join(observerDir, "worker.cjs")], {
    env: {
      ...process.env, HOME: home, COMPANION_OBSERVER_STATE_DIR: stateDir,
      COMPANION_ARTIFACTS_DIR: artifactsDir, COMPANION_OBSERVER_DEBOUNCE_MS: "0",
      COMPANION_OBSERVER_IDLE_EXIT_MS: "20", COMPANION_OBSERVER_POLL_MS: "5",
      COMPANION_QUALITY: "pretty", COMPANION_DESIGNER_FAKE_HTML: bespoke,
    }, timeout: 5000,
  });
  assert.equal(result.status, 0, result.stderr.toString());
  const files = fs.readdirSync(artifactsDir);
  assert.equal(files.length, 1);
  assert.match(files[0], /^bespoke-companion-/);
  const metrics = fs.readFileSync(path.join(stateDir, "metrics.jsonl"), "utf8").trim().split("\n").map(JSON.parse);
  assert.deepEqual(metrics.map((m) => m.stage), ["designer"]);
});

// ── Phase 2: the agent brief (live state) informs the director ────────────────

test("observer prompt carries the agent brief when present and null when absent", () => {
  const turn = [{ user: "u", assistant: "a", tools: [], files: [] }];
  const withBrief = JSON.parse(observerPrompt(null, turn, { working: "shipping #6", next: [{ title: "verify", kind: "decision" }] }));
  assert.equal(withBrief.agent_brief.working, "shipping #6");
  assert.equal(withBrief.agent_brief.next[0].kind, "decision");
  assert.equal(withBrief.new_turn_deltas.length, 1);
  const without = JSON.parse(observerPrompt(null, turn));
  assert.equal(without.agent_brief, null);
});

test("readBrief parses a live brief object and guards bad or absent input", () => {
  const { readBrief } = require("../capture.cjs");
  assert.equal(readBrief(null), null);
  const dir = tempDir();
  const file = path.join(dir, "live.json");
  fs.writeFileSync(file, JSON.stringify({ working: "wiring the brief", next: [{ title: "ship" }] }));
  assert.equal(readBrief(file).working, "wiring the brief");
  fs.writeFileSync(file, "not json");
  assert.equal(readBrief(file), null);
  fs.writeFileSync(file, JSON.stringify([1, 2, 3])); // array, not an object
  assert.equal(readBrief(file), null);
});

test("capture attaches the agent's live brief to the queued job", () => {
  const home = tempDir();
  const stateDir = path.join(home, "observer");
  const liveDir = path.join(home, ".claude", "companion", "live");
  fs.mkdirSync(liveDir, { recursive: true });
  // The live-path helper reuses any file matching *--<shortid>.json (shortid = first
  // 8 chars of session_id), so pre-seeding one makes the brief read deterministic.
  fs.writeFileSync(path.join(liveDir, "proj--br1efced.json"), JSON.stringify({
    working: "wiring the artifact brief",
    where: ["director now reads the brief"],
    next: [{ title: "ship #6", sub: "verify with a before/after", kind: "decision" }],
    project: "companion", is_repo: true, unit_key: "companion",
  }));
  const file = transcript(MODE_TURN);
  const payload = JSON.stringify({ session_id: "br1efced-feed", cwd: home, transcript_path: file });
  const result = spawnSync(process.execPath, [path.join(observerDir, "capture.cjs")], {
    input: payload,
    env: {
      ...process.env,
      HOME: home,
      COMPANION_OBSERVER_STATE_DIR: stateDir,
      COMPANION_ARTIFACTS_DIR: path.join(home, "artifacts"),
      COMPANION_OBSERVER_NO_START: "1",
    },
  });
  assert.equal(result.status, 0, result.stderr.toString());
  const [queueFile] = fs.readdirSync(path.join(stateDir, "queue"));
  const queued = JSON.parse(fs.readFileSync(path.join(stateDir, "queue", queueFile), "utf8"));
  assert.equal(queued.brief.working, "wiring the artifact brief");
  assert.equal(queued.brief.next[0].kind, "decision");
});

test("worker threads the agent brief through and the metric records it", () => {
  const home = tempDir();
  const stateDir = path.join(home, "observer");
  const queueDir = path.join(stateDir, "queue");
  const artifactsDir = path.join(home, "artifacts");
  fs.mkdirSync(queueDir, { recursive: true });
  fs.writeFileSync(path.join(queueDir, "brief.json"), JSON.stringify({
    version: 1, id: "brief", sessionId: "br1efced-rest", shortid: "br1efced",
    cwd: home, project: "companion", unitKey: "companion", createdAt: Date.now() - 100,
    availableAt: 0, attempts: 0, hardBespokeReason: null,
    brief: { working: "wiring the brief", next: [{ title: "ship", sub: "verify", kind: "todo" }] },
    turns: [{ user: "do it", assistant: "Wired it.", tools: [{ name: "Edit", file: "x" }], files: ["x"] }],
  }));
  const response = {
    should_write: true, presentation: "routine", family: "brief", clawd_pose: "happy", accent: "blue",
    escalation_reason: "", bespoke_brief: "", title: "Brief-informed", summary: "x", working: "",
    changes: [], decisions: [], blockers: [], next_steps: [], files: [], visuals: [],
  };
  const result = spawnSync(process.execPath, [path.join(observerDir, "worker.cjs")], {
    env: {
      ...process.env, HOME: home, COMPANION_OBSERVER_STATE_DIR: stateDir,
      COMPANION_ARTIFACTS_DIR: artifactsDir, COMPANION_OBSERVER_DEBOUNCE_MS: "0",
      COMPANION_OBSERVER_IDLE_EXIT_MS: "20", COMPANION_OBSERVER_POLL_MS: "5",
      COMPANION_OBSERVER_FAKE_RESPONSE: JSON.stringify(response),
    },
    timeout: 5000,
  });
  assert.equal(result.status, 0, result.stderr.toString());
  const metric = JSON.parse(fs.readFileSync(path.join(stateDir, "metrics.jsonl"), "utf8").trim());
  assert.equal(metric.brief, true);
});

// ── Tiered dispatch: the agent authors, the pipeline renders ──────────────────

test("mapBriefToState maps the live brief and lets authored fields enrich it", () => {
  const { mapBriefToState } = require("../renderer.cjs");
  assert.equal(mapBriefToState(null), null);
  assert.equal(mapBriefToState("nope"), null);
  const raw = mapBriefToState({
    working: "wiring",
    where: ["a", "b"],
    next: [{ title: "ship", sub: "verify", kind: "decision" }],
    artifact: { tier: "mid", title: "T", summary: "S", accent: "mint" },
  });
  assert.equal(raw.should_write, true);
  assert.equal(raw.working, "wiring");
  assert.deepEqual(raw.changes, ["a", "b"]);        // where -> changes (cumulative)
  assert.equal(raw.next_steps[0].detail, "verify"); // sub -> detail
  assert.equal(raw.next_steps[0].kind, "decision");
  assert.equal(raw.title, "T");                     // authored fields merge on top
  assert.equal(raw.accent, "mint");
  assert.equal(raw.presentation, "composed");       // mid -> composed edition
  // A legacy brief with no artifact still maps to a renderable card.
  assert.equal(mapBriefToState({ working: "w", where: [], next: [] }).presentation, "routine");
  // A stray base key inside artifact must not shadow the mapped live-state.
  assert.equal(mapBriefToState({ working: "real", artifact: { working: "stray" } }).working, "real");
});
