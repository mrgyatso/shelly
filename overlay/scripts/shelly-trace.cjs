#!/usr/bin/env node
// shelly-trace.cjs — the ONE NDJSON appender for the Shelly trace harness.
//
// Every layer that runs as Node (this CLI, called by the shell hooks; and
// shelly-index.cjs, which `require()`s it) writes through here so there is a
// single envelope, a single clock (epoch ms), and a single file to `jq`.
//
//   CLI:   node shelly-trace.cjs <layer> <evt> [k=v ...]
//   lib:   require("./shelly-trace").emit(layer, evt, { k: v, ... })
//
// Output: one line per event into ~/.shelly/logs/trace.ndjson
//   {"ts_ms":1782651008241,"pid":1234,"layer":"hook","evt":"fire","corr":"…","…":"…"}
// `corr` (by convention the artifact's ABSOLUTE path) is the join key across layers.
//
// GATING: off unless `SHELLY_TRACE=1` in the env OR the flag file
// ~/.shelly/logs/trace.on exists. The flag file is the primary switch —
// the overlay daemon is launched by a LaunchAgent that does NOT inherit a shell
// env, so a flag file is the one condition all layers (shell, node, Rust, webview)
// can check identically regardless of how they were started. `touch` it to turn the
// whole harness on; `rm` it to turn off. No relaunch needed.
//
// LOG ONLY STRUCTURED FIELDS — never raw hook stdin (it carries the entire artifact
// HTML) or env (it carries secrets). Paths, ids, units, and decision branches only.

const fs = require("fs");
const path = require("path");
const os = require("os");

const HOME = process.env.HOME || os.homedir();
const LOG_DIR = path.join(HOME, ".shelly/logs");
const FLAG = path.join(LOG_DIR, "trace.on");
const LOG_FILE = path.join(LOG_DIR, "trace.ndjson");

function enabled() {
  if (process.env.SHELLY_TRACE === "1") return true;
  try {
    fs.accessSync(FLAG);
    return true;
  } catch (_) {
    return false;
  }
}

// Append one event. Single appendFileSync write of a sub-4KB line is atomic under
// O_APPEND, so interleaving with the Rust writers never corrupts a line.
function emit(layer, evt, fields) {
  if (!enabled()) return;
  const rec = { ts_ms: Date.now(), pid: process.pid, layer, evt };
  if (fields) for (const k of Object.keys(fields)) rec[k] = fields[k];
  try {
    fs.mkdirSync(LOG_DIR, { recursive: true });
    fs.appendFileSync(LOG_FILE, JSON.stringify(rec) + "\n");
  } catch (_) {
    // tracing must never throw into a hook's critical path
  }
}

module.exports = { emit, enabled };

// CLI form for the shell hooks: each `k=v` arg becomes a field (v = everything
// after the first '='). The shell gates on its own cheap check before invoking,
// so reaching here generally means tracing is on; emit() re-checks anyway.
if (require.main === module) {
  const [layer, evt, ...rest] = process.argv.slice(2);
  if (layer && evt) {
    const fields = {};
    for (const kv of rest) {
      const i = kv.indexOf("=");
      if (i > 0) fields[kv.slice(0, i)] = kv.slice(i + 1);
    }
    emit(layer, evt, fields);
  }
}
