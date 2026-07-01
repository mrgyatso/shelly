const { spawn } = require("child_process");

const ITEM_SCHEMA = {
  type: "object",
  additionalProperties: false,
  properties: {
    label: { type: "string", maxLength: 120 },
    value: { type: "string", maxLength: 120 },
    detail: { type: "string", maxLength: 500 },
    status: { enum: ["neutral", "good", "warn", "bad", "active"] },
  },
  required: ["label", "value", "detail", "status"],
};

const OBSERVER_SCHEMA = {
  type: "object",
  additionalProperties: false,
  properties: {
    should_write: { type: "boolean" },
    presentation: { enum: ["routine", "composed", "bespoke"] },
    layout: { enum: ["broadsheet", "steer", "canvas"] },
    family: { enum: ["answer", "brief", "comparison", "timeline", "gallery", "metrics", "decision"] },
    clawd_pose: { enum: ["thinking", "typing", "conducting", "juggling", "sweeping", "beacon", "wizard", "confused", "happy"] },
    accent: { enum: ["blue", "amber", "clay", "mint", "violet"] },
    escalation_reason: { type: "string", maxLength: 300 },
    bespoke_brief: { type: "string", maxLength: 1000 },
    title: { type: "string", maxLength: 120 },
    summary: { type: "string", maxLength: 600 },
    working: { type: "string", maxLength: 300 },
    changes: { type: "array", maxItems: 8, items: { type: "string", maxLength: 300 } },
    decisions: { type: "array", maxItems: 8, items: { type: "string", maxLength: 300 } },
    blockers: { type: "array", maxItems: 6, items: { type: "string", maxLength: 300 } },
    next_steps: {
      type: "array",
      maxItems: 8,
      items: {
        type: "object",
        additionalProperties: false,
        properties: {
          title: { type: "string", maxLength: 160 },
          detail: { type: "string", maxLength: 400 },
          kind: { enum: ["todo", "decision", "blocked"] },
        },
        required: ["title", "detail", "kind"],
      },
    },
    files: { type: "array", maxItems: 20, items: { type: "string", maxLength: 500 } },
    visuals: {
      type: "array",
      maxItems: 4,
      items: {
        type: "object",
        additionalProperties: false,
        properties: {
          type: { enum: ["metric_strip", "bar_chart", "line_chart", "timeline", "comparison", "option_gallery", "before_after", "checklist", "code_diff"] },
          title: { type: "string", maxLength: 160 },
          note: { type: "string", maxLength: 400 },
          items: { type: "array", maxItems: 12, items: ITEM_SCHEMA },
        },
        required: ["type", "title", "note", "items"],
      },
    },
  },
  required: [
    "should_write", "presentation", "family", "clawd_pose", "accent",
    "escalation_reason", "bespoke_brief", "title", "summary", "working",
    "changes", "decisions", "blockers", "next_steps", "files", "visuals",
  ],
};

const SYSTEM_PROMPT = `You are Companion's quiet artifact director. You receive new turn deltas
plus the prior compact state, never the whole conversation. Decide whether work materially advanced:
implementation, diagnosis, a durable decision, a blocker, or a useful plan. Do not emit for
acknowledgements, repetition, status polling, or prose with no durable project signal. When it did
advance, return a concise CURRENT snapshot that merges prior state with new facts. Never invent.

You may also receive agent_brief — the working agent's own first-person account of THIS turn, the same
live state it writes for the roster: what it is doing (working), where things stand (where), what
changed (changed), and the real next moves (next, often with a recommendation and why). When present it
is your most authoritative signal: the agent already reasoned the propulsion you would otherwise have to
infer from raw tool deltas. Let it anchor the title/summary and especially next_steps — carry the
agent's recommendation and reasoning into the moves rather than re-deriving weaker ones. Still
cross-check against the deltas and never invent beyond what they support; the brief informs your
judgment, it does not force a write — if nothing materially advanced, stay silent.

Choose presentation=routine for ordinary answers/status with no useful visualization. Choose
presentation=composed when a registered component clarifies real data. Available components:
metric_strip, bar_chart, line_chart, timeline, comparison, option_gallery, before_after, checklist,
code_diff. Use only facts supported by the turn. Choose family by information shape, not decoration.
Choose a Clawd pose reflecting the work: thinking, typing, conducting, juggling, sweeping, beacon,
wizard, confused, or happy.

Choose layout = the page shape. Default "broadsheet" (editorial column — almost always right). Use
"steer" when the turn is dominated by ONE decision the user should act on now — it promotes the
"Decide" ballot to the top as the hero and quiets everything else (great for lazy-vibecode "just
tell me the next move" turns). Use "canvas" when there's substantial reading AND ongoing decisions —
it splits into a reading column plus a persistent ballot rail so the next move stays in reach.

next_steps is the load-bearing surface — it renders as an elevated "Decide" ballot the user acts on
without touching the terminal, so make it genuinely propulsive. Write moves that ADVANCE the work,
not restate it: concrete actions and the real decisions to make, phrased as imperatives, the
strongest option first. Prefer kind=decision when the user must choose; kind=blocked only for a true
blocker. 1–4 sharp moves beat 8 vague ones. If the goal is unclear, make a next step that asks for it.

Choose presentation=bespoke only when the interface itself is the deliverable: visual variants,
mockups, animation, live preview, spatial interaction, or a choice that depends on seeing the result.
Provide a precise bespoke_brief and escalation_reason; a separate Sonnet designer authors it in the
house "Broadsheet" style (editorial page that dissolves into the board; the decision is the loudest
element). In the brief, say which mode fits: "steer" when the turn is one dominant choice, "canvas"
when the user is living in the board and needs the moves always in reach. The routine/composed
renderer creates HTML locally; you only return schema data.`;

function observerPrompt(prior, turns, brief) {
  return JSON.stringify({
    prior_state: prior || null,
    agent_brief: brief || null,
    new_turn_deltas: turns.map((turn) => ({
      user: turn.user,
      assistant: turn.assistant,
      tools: turn.tools,
      files: turn.files,
    })),
  });
}

function parseClaudeOutput(stdout) {
  const outer = JSON.parse(stdout);
  let state = outer;
  if (outer && typeof outer.structured_output === "object") state = outer.structured_output;
  else if (outer && typeof outer.result === "object") state = outer.result;
  else if (outer && typeof outer.result === "string") state = JSON.parse(outer.result);
  return { state, usage: (outer && outer.usage) || null, totalCostUsd: (outer && outer.total_cost_usd) || null };
}

function cleanClaudeEnv() {
  const env = { ...process.env };
  delete env.CLAUDECODE;
  delete env.CLAUDE_CODE_ENTRYPOINT;
  delete env.COMPANION_SESSION;
  return env;
}

function callObserver({ prior, turns, brief, model, timeoutMs = 120000 }) {
  if (process.env.COMPANION_OBSERVER_FAKE_RESPONSE) {
    return Promise.resolve({
      state: JSON.parse(process.env.COMPANION_OBSERVER_FAKE_RESPONSE),
      usage: null,
      totalCostUsd: null,
    });
  }

  const command = process.env.COMPANION_OBSERVER_CLAUDE_BIN || "claude";
  // The quality dial (worker.cjs) passes an explicit director model; fall back to
  // the env/default Haiku when it doesn't.
  const resolvedModel = model || process.env.COMPANION_OBSERVER_MODEL || "haiku";
  const args = [
    "--safe-mode", "--print", "--model", resolvedModel, "--effort", "low", "--tools", "",
    // Disable the user's global advisorModel for this call: --safe-mode and
    // --tools "" do not suppress the advisor (it's gated by the setting, not the
    // tool list), and inheriting it pulls Opus into every routine turn — which
    // defeats the cheap-Haiku design this worker exists to deliver.
    "--settings", JSON.stringify({ advisorModel: null }),
    "--no-session-persistence", "--output-format", "json", "--json-schema",
    JSON.stringify(OBSERVER_SCHEMA), "--system-prompt", SYSTEM_PROMPT,
  ];

  return new Promise((resolve, reject) => {
    const child = spawn(command, args, { env: cleanClaudeEnv(), stdio: ["pipe", "pipe", "pipe"] });
    let stdout = "";
    let stderr = "";
    const timer = setTimeout(() => {
      child.kill("SIGTERM");
      reject(new Error(`observer model timed out after ${timeoutMs}ms`));
    }, timeoutMs);
    child.stdout.on("data", (chunk) => { stdout += chunk; });
    child.stderr.on("data", (chunk) => { stderr += chunk; });
    child.on("error", (error) => { clearTimeout(timer); reject(error); });
    child.on("close", (code) => {
      clearTimeout(timer);
      if (code !== 0) {
        reject(new Error(`observer model exited ${code}: ${stderr.trim().slice(-1000)}`));
        return;
      }
      try { resolve(parseClaudeOutput(stdout)); }
      catch (error) { reject(new Error(`invalid observer response: ${error.message}`)); }
    });
    child.stdin.end(observerPrompt(prior, turns, brief));
  });
}

module.exports = { OBSERVER_SCHEMA, SYSTEM_PROMPT, callObserver, cleanClaudeEnv, observerPrompt, parseClaudeOutput };
