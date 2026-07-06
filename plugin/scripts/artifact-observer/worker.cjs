#!/usr/bin/env node
const fs = require("fs");
const path = require("path");
const { atomicJson, atomicWrite, safeId } = require("./lib.cjs");
const identity = require(path.join(__dirname, "..", "..", "hooks", "companion-identity.cjs"));
const { callDesigner } = require("./designer.cjs");
const { artifactFilename, bespokeFilename, mapBriefToState, normalizeState, renderArtifact } = require("./renderer.cjs");

const stateDir = process.env.COMPANION_OBSERVER_STATE_DIR || path.join(process.env.HOME, ".claude", "companion", "observer");
const queueDir = path.join(stateDir, "queue");
const deadDir = path.join(stateDir, "dead");
const sessionDir = path.join(stateDir, "sessions");
const artifactsDir = process.env.COMPANION_ARTIFACTS_DIR || path.join(process.env.HOME, ".claude", "companion", "artifacts");
const indexPath = process.env.COMPANION_OBSERVER_INDEX_PATH || path.join(process.env.HOME, ".claude", "companion", "artifact-index.json");
const debounceMs = Number(process.env.COMPANION_OBSERVER_DEBOUNCE_MS || 30000);
const idleExitMs = Number(process.env.COMPANION_OBSERVER_IDLE_EXIT_MS || 300000);
const pollMs = Number(process.env.COMPANION_OBSERVER_POLL_MS || 1000);
const retryBaseMs = Number(process.env.COMPANION_OBSERVER_RETRY_BASE_MS || 5000);

for (const dir of [stateDir, queueDir, deadDir, sessionDir, artifactsDir]) fs.mkdirSync(dir, { recursive: true });

const lockPath = path.join(stateDir, "worker.lock");
let lockFd;
for (let attempt = 0; attempt < 2; attempt += 1) {
  try {
    lockFd = fs.openSync(lockPath, "wx");
    break;
  } catch (_) {
    let ownerAlive = false;
    try {
      const owner = Number(fs.readFileSync(lockPath, "utf8"));
      process.kill(owner, 0);
      ownerAlive = true;
    } catch (_) {}
    if (ownerAlive) process.exit(0);
    try { fs.unlinkSync(lockPath); } catch (_) {}
  }
}
if (lockFd === undefined) process.exit(0);
fs.writeFileSync(lockFd, String(process.pid));
fs.writeFileSync(path.join(stateDir, "worker.pid"), String(process.pid));

function heartbeat() {
  fs.closeSync(fs.openSync(path.join(stateDir, "heartbeat"), "w"));
}

function cleanup() {
  try { fs.closeSync(lockFd); } catch (_) {}
  try { fs.unlinkSync(lockPath); } catch (_) {}
  try { fs.unlinkSync(path.join(stateDir, "worker.pid")); } catch (_) {}
}
process.on("exit", cleanup);
process.on("SIGTERM", () => process.exit(0));
process.on("SIGINT", () => process.exit(0));

function readJobs() {
  const jobs = [];
  for (const file of fs.readdirSync(queueDir).filter((name) => name.endsWith(".json"))) {
    try {
      const job = JSON.parse(fs.readFileSync(path.join(queueDir, file), "utf8"));
      jobs.push({ ...job, _file: path.join(queueDir, file) });
    } catch (_) {}
  }
  return jobs.sort((a, b) => a.createdAt - b.createdAt);
}

function readyGroup(jobs, now) {
  const groups = new Map();
  for (const job of jobs) {
    if ((job.availableAt || 0) > now) continue;
    const group = groups.get(job.sessionId) || [];
    group.push(job);
    groups.set(job.sessionId, group);
  }
  for (const group of groups.values()) {
    const latest = Math.max(...group.map((job) => job.createdAt));
    if (now - latest >= debounceMs) return group;
  }
  return null;
}

function loadPrior(job) {
  try {
    return JSON.parse(fs.readFileSync(path.join(sessionDir, `${safeId(job.sessionId)}.json`), "utf8"));
  } catch (_) {
    return null;
  }
}

// The tier dial — a sibling of the mode file, read per-job so flipping it needs no restart.
// `agent` (default) lets the agent's own per-turn tier choice win; `cheap` forces the
// deterministic code render (never spend on a model); `bespoke` forces the Sonnet/Opus
// designer on every turn; `off` suppresses artifacts entirely. A per-unit `tier.<unit>`
// override wins over the global `tier` file, mirroring resolveMode's hybrid scope.
const companionDir = path.join(process.env.HOME, ".claude", "companion");
const tierPath = process.env.COMPANION_TIER_PATH || path.join(companionDir, "tier");
const bespokeModelPath = process.env.COMPANION_BESPOKE_MODEL_PATH || path.join(companionDir, "bespoke-model");
const qualityPath = process.env.COMPANION_QUALITY_PATH || path.join(companionDir, "quality");

function normTierDial(raw) {
  const w = String(raw || "").trim().toLowerCase();
  return ["agent", "cheap", "bespoke", "off"].includes(w) ? w : null;
}

function readTierFile(file) {
  try { return normTierDial(fs.readFileSync(file, "utf8")); } catch (_) { return null; }
}

function safeUnit(unitKey) {
  return String(unitKey || "").replace(/[^A-Za-z0-9._-]/g, "");
}

// Backward-compat bridge for the legacy quality dial (fast|pretty), which predates the tier
// dial but still has an overlay UI segment and a /companion:quality command. With the Haiku
// director gone, `pretty` no longer means "Sonnet director"; its closest surviving meaning is
// "always the bespoke designer", so map pretty → bespoke. `fast` falls through to the
// agent-decides default. Retire once the overlay ships a native `tier` segment.
function readQualityAsTier() {
  let raw = process.env.COMPANION_QUALITY || "";
  if (!raw) { try { raw = fs.readFileSync(qualityPath, "utf8"); } catch (_) {} }
  return raw.trim().toLowerCase() === "pretty" ? "bespoke" : null;
}

function resolveTierDial(unitKey) {
  // Env override wins (matches readQuality/resolveMode — env is the ops/test lever), then a
  // per-unit `tier.<unit>` file, then the global `tier` file, then the legacy quality bridge,
  // else default `agent`.
  const envDial = normTierDial(process.env.COMPANION_TIER);
  if (envDial) return envDial;
  const safe = safeUnit(unitKey);
  const perUnit = safe ? readTierFile(path.join(companionDir, `tier.${safe}`)) : null;
  return perUnit || readTierFile(tierPath) || readQualityAsTier() || "agent";
}

// Resolve the effective build path for a job from the dial + the agent's authored tier.
// Returns "cheap" (code render), "high" (bespoke designer), or "off" (skip).
function resolveTier(authoredTier, dial) {
  if (dial === "off") return "off";
  if (dial === "cheap") return "cheap";
  if (dial === "bespoke") return "high";
  // dial === "agent": the agent's per-turn choice wins; cheap/mid both code-render.
  const t = String(authoredTier || "").trim().toLowerCase();
  return t === "high" || t === "bespoke" ? "high" : "cheap";
}

// Bespoke model dial: `sonnet` (default) | `opus`. Env override then the sibling file.
function readBespokeModel() {
  let raw = process.env.COMPANION_BESPOKE_MODEL || "";
  if (!raw) { try { raw = fs.readFileSync(bespokeModelPath, "utf8"); } catch (_) {} }
  return raw.trim().toLowerCase() === "opus" ? "opus" : "sonnet";
}

function updateIndex(artifactPath, job) {
  // Attribute the artifact to the OBSERVED session through the ONE shared identity
  // API (the same stamp the PostToolUse hook uses): the session's frozen registry
  // record decides the unit; job.unitKey (captured at enqueue) is only the fallback
  // for pre-registry sessions. Never re-derive identity here — a forked stamp is
  // exactly the drift the shared lib exists to kill. Also appends `artifact.routed`.
  identity.routeArtifact({
    artifactPath,
    session_id: job.sessionId,
    unit_key: job.unitKey,
    shortid: job.shortid,
    // The watched session's REAL source stem (<slug>--<shortid>), captured at enqueue
    // time, so the Board scopes this artifact to its live session (renderHero matches by
    // source). The old `observer--<shortid>` was a fabricated slug that could NEVER match
    // a live source, so every observer artifact sat behind a blank hero. Fall back to it
    // only for legacy jobs queued before this field existed.
    source: job.source || `observer--${job.shortid}`,
    indexPath,
  });
}

function appendMetric(job, stage, turns, result, extra = {}) {
  fs.appendFileSync(path.join(stateDir, "metrics.jsonl"), `${JSON.stringify({
    at: Date.now(),
    sessionId: job.sessionId,
    stage,
    // Deterministic renders carry no model; only the designer stage has one.
    model: extra.model || (stage === "designer" ? (process.env.COMPANION_DESIGNER_MODEL || "sonnet") : null),
    batchedTurns: turns.length,
    usage: result.usage,
    totalCostUsd: result.totalCostUsd,
    ...extra,
  })}\n`);
}

async function publishBespoke(job, turns, prior, reason, brief, model) {
  const result = await callDesigner({ prior, turns, reason, brief, project: job.project, model });
  const artifactPath = path.join(artifactsDir, bespokeFilename(job));
  atomicWrite(artifactPath, result.html);
  updateIndex(artifactPath, job);
  appendMetric(job, "designer", turns, result, { reason, artifactPath, model });
  return artifactPath;
}

function removeJobs(group) {
  for (const job of group) {
    try { fs.unlinkSync(job._file); } catch (_) {}
  }
}

function retryGroup(group, error) {
  const first = group[0];
  const attempts = Math.max(...group.map((job) => job.attempts || 0)) + 1;
  const message = String(error && error.message || error);
  // A timeout won't succeed on an identical retry, and the worker is single-threaded
  // (processGroup blocks the main loop), so 3× full-timeout attempts stall every other
  // session's artifacts for minutes. Cap timeout failures at 2 attempts; other
  // (possibly transient) errors keep the full 3-attempt budget.
  const maxAttempts = /timed out/.test(message) ? 2 : 3;
  const combined = {
    ...first,
    attempts,
    availableAt: Date.now() + Math.min(60000, retryBaseMs * 2 ** (attempts - 1)),
    turns: group.flatMap((job) => job.turns || []),
    lastError: message.slice(0, 1000),
  };
  removeJobs(group);
  if (attempts >= maxAttempts) {
    atomicJson(path.join(deadDir, path.basename(first._file)), combined);
  } else {
    atomicJson(first._file, combined);
  }
}

async function processGroup(group) {
  const job = group[group.length - 1];
  const turns = group.flatMap((item) => item.turns || []).slice(-8);
  const prior = loadPrior(job);
  try {
    // An explicit user visual request always wins — a bespoke surface the user asked for,
    // regardless of the agent's tier or the dial.
    const hardBespoke = [...group].reverse().find((item) => item.hardBespokeReason);
    if (hardBespoke) {
      const latestUser = [...turns].reverse().find((turn) => turn.user)?.user || "Create the requested visual artifact.";
      await publishBespoke(job, turns, prior, hardBespoke.hardBespokeReason, latestUser, readBespokeModel());
      removeJobs(group);
      return;
    }

    // The agent authors the artifact in its live-state. Take the freshest brief in the batch
    // and read ITS OWN authored tier — coupled, so a high tier and its bespoke_brief always
    // come from the same object (never a high paired with an older brief lacking the brief).
    const brief = [...group].reverse().map((item) => item.brief).find(Boolean) || null;
    const authoredTier = (brief && brief.artifact && brief.artifact.tier) || null;
    const tier = resolveTier(authoredTier, resolveTierDial(job.unitKey));

    if (tier === "off") { removeJobs(group); return; }

    if (tier === "high") {
      // Agent-authored bespoke: the curated bespoke_brief is the PRIMARY signal, not blind
      // deltas — so the designer builds from the agent's full-context framing.
      const art = (brief && brief.artifact) || {};
      const designBrief = art.bespoke_brief || art.summary || (brief && brief.working) || "Author a bespoke view of this turn.";
      const reason = art.escalation_reason || "agent selected the high (bespoke) tier";
      await publishBespoke(job, turns, prior, reason, designBrief, readBespokeModel());
      removeJobs(group);
      return;
    }

    // cheap | mid — deterministic code render straight from the agent-authored brief. No
    // model call: correct attribution, instant, ~free. No brief to render from ⇒ skip
    // (never fall back to a blind summarizer, which is what re-introduced hallucination).
    const raw = mapBriefToState(brief);
    if (!raw) { removeJobs(group); return; }
    const state = normalizeState(raw, { title: `${job.project} update` });
    appendMetric(job, "render", turns, { usage: null, totalCostUsd: null }, { tier: authoredTier || "cheap", brief: Boolean(brief), family: state.family, presentation: state.presentation });
    const artifactPath = path.join(artifactsDir, artifactFilename(job));
    atomicWrite(artifactPath, renderArtifact(state, job));
    updateIndex(artifactPath, job);
    atomicJson(path.join(sessionDir, `${safeId(job.sessionId)}.json`), state);
    removeJobs(group);
  } catch (error) {
    retryGroup(group, error);
  }
}

async function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

async function main() {
  let lastWork = Date.now();
  while (true) {
    heartbeat();
    const jobs = readJobs();
    const group = readyGroup(jobs, Date.now());
    if (group) {
      lastWork = Date.now();
      await processGroup(group);
      continue;
    }
    if (!jobs.length && Date.now() - lastWork >= idleExitMs) return;
    await sleep(pollMs);
  }
}

main().then(() => process.exit(0)).catch((error) => {
  process.stderr.write(`${new Date().toISOString()} worker fatal: ${error.stack || error}\n`);
  process.exit(1);
});
