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
    return { project: fields[1] || path.basename(cwd), unitKey: fields[4] || fields[1], source };
  } catch (_) {
    return { project: path.basename(cwd) || "session", unitKey: path.basename(cwd) || "session", source: null };
  }
}

// App-owned generation mode, read every Stop. The dial advertises four positions,
// but `agent` (inline working-agent authoring) has no machinery yet, so it aliases
// to `selective` — selecting it never goes silent, and any legacy `agent` mode file
// keeps getting observer artifacts.
//   manual    → observer disabled (only the /companion:html pull renders)
//   selective → observer runs; the director's should_write decides (default)
//   always    → observer runs; force a write on any substantive turn
function resolveMode(companionDir) {
  if (process.env.COMPANION_OBSERVER_IGNORE_MODE === "1") return "selective";
  let raw = "";
  try {
    raw = fs.readFileSync(path.join(companionDir, "mode"), "utf8").trim().toLowerCase();
  } catch (_) {}
  if (raw === "manual") return "manual";
  if (raw === "always") return "always";
  return "selective";
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
  const mode = resolveMode(companionDir);
  if (mode === "manual") return;

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
  const job = {
    version: 1,
    id: `${Date.now()}-${hash.slice(0, 12)}`,
    sessionId,
    shortid: safeId(sessionId.slice(0, 8)),
    cwd,
    project: info.project,
    unitKey: info.unitKey,
    source: info.source,
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

main().catch(() => {});
