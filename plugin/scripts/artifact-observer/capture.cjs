#!/usr/bin/env node
const fs = require("fs");
const os = require("os");
const path = require("path");
const { execFileSync } = require("child_process");
const {
  atomicJson,
  detectVisualIntent,
  extractCurrentTurn,
  isSubstantive,
  safeId,
  turnHash,
} = require("./lib.cjs");
const { ensureWorker } = require("./process.cjs");

function readStdin() {
  return new Promise((resolve) => {
    let data = "";
    process.stdin.setEncoding("utf8");
    process.stdin.on("data", (chunk) => { data += chunk; });
    process.stdin.on("end", () => resolve(data));
  });
}

function unitInfo(cwd, sessionId) {
  try {
    const helper = path.resolve(__dirname, "../../hooks/companion-livepath.sh");
    const line = execFileSync("sh", [helper, cwd, sessionId], { encoding: "utf8" }).trim();
    const fields = line.split("\t");
    // fields[0] is the live-file path; its basename (minus .json) is the session's
    // SOURCE stem (<slug>--<shortid>) — the exact key the Board matches an artifact to
    // its live session by (renderHero: a.source === activeSessionSource). Capture it so
    // the worker can stamp the REAL source; otherwise a fabricated slug never matches the
    // session and every observer artifact lands behind a blank hero.
    const source = fields[0] ? path.basename(fields[0]).replace(/\.json$/, "") : null;
    return { project: fields[1] || path.basename(cwd), unitKey: fields[4] || fields[1], source, livePath: fields[0] || null };
  } catch (_) {
    return { project: path.basename(cwd) || "session", unitKey: path.basename(cwd) || "session", source: null, livePath: null };
  }
}

// The agent's own live state file (the roster brief) is the richest signal we have for
// a turn — first-person working/where/next, often with a recommendation and why. The
// agent writes it DURING the turn, so it's fresh on disk by the Stop hook. Read it here
// and attach it to the job so the director can author from the agent's framing instead
// of reverse-engineering tool deltas. Size-guarded; any failure falls back to deltas-only.
function readBrief(livePath) {
  if (!livePath) return null;
  try {
    const raw = fs.readFileSync(livePath, "utf8");
    if (raw.length > 64 * 1024) return null;
    const parsed = JSON.parse(raw);
    return parsed && typeof parsed === "object" && !Array.isArray(parsed) ? parsed : null;
  } catch (_) {
    return null;
  }
}

// App-owned generation dial, read every Stop. Four advertised positions; `agent`
// (inline working-agent authoring) has no machinery yet, so it ALIASES to
// `selective` — selecting it never goes silent, and legacy `agent` files keep
// producing artifacts.
//   manual    → observer off (only the /companion:html pull renders)
//   selective → observer runs; the director's should_write decides (default)
//   always    → observer runs; force a write on any substantive turn
function normMode(raw) {
  const w = String(raw || "").trim().toLowerCase();
  if (w === "manual" || w === "always" || w === "selective") return w;
  if (w === "agent") return "selective"; // reserved alias until inline authoring lands
  return null; // empty/unknown → no opinion (fall through)
}

function readModeFile(file) {
  try {
    return normMode(fs.readFileSync(file, "utf8"));
  } catch (_) {
    return null;
  }
}

function safeUnit(unitKey) {
  return String(unitKey || "").replace(/[^A-Za-z0-9._-]/g, "");
}

// Hybrid scope: a per-unit override (`mode.<unit_key>`) wins, else the global
// `mode` file, else `selective`.
function resolveMode(companionDir, unitKey) {
  if (process.env.COMPANION_OBSERVER_IGNORE_MODE === "1") return "selective";
  const safe = safeUnit(unitKey);
  const perUnit = safe ? readModeFile(path.join(companionDir, `mode.${safe}`)) : null;
  return perUnit || readModeFile(path.join(companionDir, "mode")) || "selective";
}

// Cheap fast-path: observer globally OFF (`mode` = manual) AND no per-unit
// overrides exist at all ⇒ skip every Stop before the costly transcript read +
// unit lookup. (With overrides present, a unit could re-enable itself, so we
// fall through and resolve per-unit after unitInfo.)
function globallyDisabled(companionDir) {
  if (process.env.COMPANION_OBSERVER_IGNORE_MODE === "1") return false;
  if (readModeFile(path.join(companionDir, "mode")) !== "manual") return false;
  try {
    return !fs.readdirSync(companionDir).some((f) => f.startsWith("mode."));
  } catch (_) {
    return true;
  }
}

async function main() {
  let payload;
  try {
    payload = JSON.parse(await readStdin());
  } catch (_) {
    return;
  }

  const home = process.env.HOME || os.homedir();
  const companionDir = path.join(home, ".claude", "companion");
  if (globallyDisabled(companionDir)) return;

  const transcript = payload.transcript_path;
  const sessionId = String(payload.session_id || "");
  const cwd = String(payload.cwd || process.cwd());
  if (!sessionId || !transcript || !fs.existsSync(transcript)) return;
  if (cwd.includes(`${path.sep}.claude-mem${path.sep}`)) return;

  const artifactsDir = process.env.COMPANION_ARTIFACTS_DIR || path.join(companionDir, "artifacts");
  let turn;
  try {
    turn = extractCurrentTurn(transcript, artifactsDir);
  } catch (_) {
    return;
  }
  const hardBespokeReason = detectVisualIntent(turn);
  if (turn.wroteArtifact || (!hardBespokeReason && !isSubstantive(turn))) return;

  const hash = turnHash(turn);
  const stateDir = process.env.COMPANION_OBSERVER_STATE_DIR || path.join(companionDir, "observer");
  const captureFile = path.join(stateDir, "captured", `${safeId(sessionId)}.json`);
  try {
    if (JSON.parse(fs.readFileSync(captureFile, "utf8")).hash === hash) return;
  } catch (_) {}

  const info = unitInfo(cwd, sessionId);
  const mode = resolveMode(companionDir, info.unitKey);
  if (mode === "manual") return;
  // The agent authors the artifact in its own live-state: brief.artifact carries the tier
  // (cheap | mid | high | skip) plus any rich fields. tier defaults to cheap at the worker;
  // "skip" is the agent judging this turn not worth an artifact — honor it and enqueue
  // nothing. An explicit user visual request (hardBespokeReason) overrides a skip.
  const brief = readBrief(info.livePath);
  const authoredTier = brief && brief.artifact && typeof brief.artifact.tier === "string"
    ? brief.artifact.tier.trim().toLowerCase() : "";
  if (authoredTier === "skip" && !hardBespokeReason) return;
  const job = {
    version: 1,
    id: `${Date.now()}-${hash.slice(0, 12)}`,
    sessionId,
    shortid: safeId(sessionId.slice(0, 8)),
    cwd,
    project: info.project,
    unitKey: info.unitKey,
    source: info.source,
    brief,
    tier: authoredTier || null,
    createdAt: Date.now(),
    availableAt: Date.now(),
    attempts: 0,
    hardBespokeReason,
    alwaysWrite: mode === "always",
    turns: [turn],
  };
  const queueFile = path.join(stateDir, "queue", `${job.id}.json`);
  atomicJson(queueFile, job);
  atomicJson(captureFile, { hash, capturedAt: Date.now() });
  if (process.env.COMPANION_OBSERVER_NO_START !== "1") {
    ensureWorker({ stateDir, artifactsDir, indexPath: path.join(companionDir, "artifact-index.json") });
  }
}

if (require.main === module) {
  main().catch(() => {});
}

module.exports = { resolveMode, normMode, globallyDisabled, readBrief };
