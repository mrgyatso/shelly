const fs = require("fs");
const path = require("path");
const { spawn } = require("child_process");

function workerAlive(stateDir) {
  try {
    const pid = Number(fs.readFileSync(path.join(stateDir, "worker.pid"), "utf8"));
    const heartbeat = path.join(stateDir, "heartbeat");
    const age = fs.existsSync(heartbeat) ? Date.now() - fs.statSync(heartbeat).mtimeMs : 0;
    if (!pid || age > 180000) return false;
    process.kill(pid, 0);
    return true;
  } catch (_) {
    return false;
  }
}

function hasPendingJobs(stateDir) {
  try {
    return fs.readdirSync(path.join(stateDir, "queue")).some((name) => name.endsWith(".json"));
  } catch (_) {
    return false;
  }
}

function ensureWorker({ stateDir, artifactsDir, indexPath, onlyIfPending = false }) {
  if ((onlyIfPending && !hasPendingJobs(stateDir)) || workerAlive(stateDir)) return false;
  fs.mkdirSync(stateDir, { recursive: true });
  const log = fs.openSync(path.join(stateDir, "worker.log"), "a");
  const child = spawn(process.execPath, [path.join(__dirname, "worker.cjs")], {
    detached: true,
    stdio: ["ignore", log, log],
    env: {
      ...process.env,
      COMPANION_OBSERVER_STATE_DIR: stateDir,
      COMPANION_ARTIFACTS_DIR: artifactsDir,
      COMPANION_OBSERVER_INDEX_PATH: indexPath,
    },
  });
  child.unref();
  fs.closeSync(log);
  return true;
}

module.exports = { ensureWorker, hasPendingJobs, workerAlive };
