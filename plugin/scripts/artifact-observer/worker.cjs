#!/usr/bin/env node
const fs = require("fs");
const path = require("path");
const { atomicJson, atomicWrite, safeId } = require("./lib.cjs");
const { callObserver } = require("./model.cjs");
const { callDesigner } = require("./designer.cjs");
const { artifactFilename, bespokeFilename, normalizeState, renderArtifact } = require("./renderer.cjs");

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

// The quality dial — a sibling of the mode file. `fast` (default) keeps the cheap
// Haiku director + the local Broadsheet renderer (Sonnet only for true bespoke
// escalations). `pretty` raises the director to Sonnet for sharper judgment while
// still rendering through the local template (scope "director"); set
// COMPANION_QUALITY_SCOPE=all to instead route every should_write turn through the
// Sonnet designer (scope "all"). Read per-job so flipping the dial needs no restart.
const qualityPath = process.env.COMPANION_QUALITY_PATH || path.join(process.env.HOME, ".claude", "companion", "quality");
function readQuality() {
  let raw = process.env.COMPANION_QUALITY || "";
  if (!raw) { try { raw = fs.readFileSync(qualityPath, "utf8"); } catch (_) {} }
  return raw.trim().toLowerCase() === "pretty" ? "pretty" : "fast";
}

function directorModelFor(quality) {
  if (quality === "pretty") return process.env.COMPANION_PRETTY_DIRECTOR_MODEL || "sonnet";
  return process.env.COMPANION_OBSERVER_MODEL || "haiku";
}

function updateIndex(artifactPath, job) {
  let index = {};
  try { index = JSON.parse(fs.readFileSync(indexPath, "utf8")) || {}; } catch (_) {}
  index[path.resolve(artifactPath)] = {
    unit_key: job.unitKey,
    shortid: job.shortid,
    // The watched session's REAL source stem (<slug>--<shortid>), captured at enqueue
    // time, so the Board scopes this artifact to its live session (renderHero matches by
    // source). The old `observer--<shortid>` was a fabricated slug that could NEVER match
    // a live source, so every observer artifact sat behind a blank hero. Fall back to it
    // only for legacy jobs queued before this field existed.
    source: job.source || `observer--${job.shortid}`,
    ts: Date.now(),
  };
  atomicJson(indexPath, index);
}

function appendMetric(job, stage, turns, result, extra = {}) {
  fs.appendFileSync(path.join(stateDir, "metrics.jsonl"), `${JSON.stringify({
    at: Date.now(),
    sessionId: job.sessionId,
    stage,
    model: extra.model || (stage === "designer" ? (process.env.COMPANION_DESIGNER_MODEL || "sonnet") : (process.env.COMPANION_OBSERVER_MODEL || "haiku")),
    batchedTurns: turns.length,
    usage: result.usage,
    totalCostUsd: result.totalCostUsd,
    ...extra,
  })}\n`);
}

async function publishBespoke(job, turns, prior, reason, brief) {
  const result = await callDesigner({ prior, turns, reason, brief, project: job.project });
  const artifactPath = path.join(artifactsDir, bespokeFilename(job));
  atomicWrite(artifactPath, result.html);
  updateIndex(artifactPath, job);
  appendMetric(job, "designer", turns, result, { reason, artifactPath });
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
  const combined = {
    ...first,
    attempts,
    availableAt: Date.now() + Math.min(60000, retryBaseMs * 2 ** (attempts - 1)),
    turns: group.flatMap((job) => job.turns || []),
    lastError: String(error && error.message || error).slice(0, 1000),
  };
  removeJobs(group);
  if (attempts >= 3) {
    atomicJson(path.join(deadDir, path.basename(first._file)), combined);
  } else {
    atomicJson(first._file, combined);
  }
}

async function processGroup(group) {
  const job = group[group.length - 1];
  const turns = group.flatMap((item) => item.turns || []).slice(-8);
  const prior = loadPrior(job);
  const quality = readQuality();
  const directorModel = directorModelFor(quality);
  // pretty + scope "all" routes every should_write turn through the Sonnet designer;
  // otherwise pretty just sharpens the director and we keep the local renderer.
  const forceBespoke = quality === "pretty" && (process.env.COMPANION_QUALITY_SCOPE || "director") === "all";
  try {
    const hardBespoke = [...group].reverse().find((item) => item.hardBespokeReason);
    if (hardBespoke) {
      const latestUser = [...turns].reverse().find((turn) => turn.user)?.user || "Create the requested visual artifact.";
      await publishBespoke(job, turns, prior, hardBespoke.hardBespokeReason, latestUser);
      removeJobs(group);
      return;
    }

    const result = await callObserver({ prior, turns, model: directorModel });
    const state = normalizeState(result.state, { title: `${job.project} update` });
    appendMetric(job, "observer", turns, result, { model: directorModel, quality, shouldWrite: state.should_write, presentation: state.presentation, family: state.family });
    // `always` mode (job.alwaysWrite) overrides the director's veto — but capture.cjs's
    // isSubstantive pre-filter still applies, so it's "always when there's something."
    if (state.should_write || job.alwaysWrite) {
      if (state.presentation === "bespoke" || forceBespoke) {
        const reason = state.presentation === "bespoke"
          ? (state.escalation_reason || "observer requested a bespoke surface")
          : "quality=pretty (scope all): authored by the Sonnet designer";
        await publishBespoke(job, turns, prior, reason, state.bespoke_brief || state.summary);
      } else {
        const artifactPath = path.join(artifactsDir, artifactFilename(job));
        atomicWrite(artifactPath, renderArtifact(state, job));
        updateIndex(artifactPath, job);
        atomicJson(path.join(sessionDir, `${safeId(job.sessionId)}.json`), state);
      }
    }
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
