#!/usr/bin/env node
const path = require("path");
const { ensureWorker } = require("./process.cjs");

const companionDir = path.join(process.env.HOME, ".claude", "companion");
ensureWorker({
  stateDir: process.env.COMPANION_OBSERVER_STATE_DIR || path.join(companionDir, "observer"),
  artifactsDir: process.env.COMPANION_ARTIFACTS_DIR || path.join(companionDir, "artifacts"),
  indexPath: process.env.COMPANION_OBSERVER_INDEX_PATH || path.join(companionDir, "artifact-index.json"),
  onlyIfPending: true,
});
