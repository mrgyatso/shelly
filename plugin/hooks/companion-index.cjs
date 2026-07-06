#!/usr/bin/env node
// companion-index.js — stamp the Board's artifact routing index.
//
// Usage:  SID=<session_id> [CWD=<session_cwd>] node companion-index.js \
//           <artifact_path> <live_dir> <index_path>
//
// WHY this exists: the Board groups an artifact under the session that wrote it.
// The only identity that is STABLE across a session is its session_id — the cwd
// is volatile (it moves as the agent `cd`s around), so we must NOT derive the
// session/unit from cwd. Identity is resolved from the session's FROZEN registry
// record (sessions/<session_id>.json, written once at SessionStart) — never
// re-derived here. The old shortid live-file glob (first-match-wins, a fork
// hazard when two sessions shared a shortid) is gone: the record IS the identity.
//
// LATE REGISTRATION: a session with no record (it started before the registry
// hooks shipped, or its SessionStart failed) is registered on first sight, by
// the SAME single derivation SessionStart uses (companion-livepath.sh — which
// itself reuses a frozen live-file identity when one exists). One derivation,
// invoked wherever the session is first seen; recorded once; frozen thereafter.
//
// Index shape: { "<abs-path>.html": { unit_key, shortid, source, ts, session_id }, ... }
// Keyed by the ABSOLUTE artifact path (not basename) so two artifacts that share
// a filename across scan dirs can't collide. Use a LEXICAL resolve (not realpath):
// the reader scans dirs without resolving symlinks, so keys must match literally.
// On any failure we exit 0 without writing — the artifact is left un-indexed and
// the Board surfaces it as unrouted (fail-loud), never silently mis-filed.

const path = require("path");
const { execFileSync } = require("child_process");

// Trace harness (no-op unless enabled). Co-located; require must never sink the
// index write, so fall back to a noop if it can't be loaded.
let trace = { emit() {} };
try {
  trace = require("./companion-trace.cjs");
} catch (_) {}

// Identity registry. routeArtifact is THE shared stamp (index entry + the always-on
// `artifact.routed` event the Board tails) every producer uses — this hook and the
// observer worker alike. Unlike the trace, this require is LOAD-BEARING: without it
// there is no identity to stamp, so bail (fail-loud covers the artifact downstream).
let identity = null;
try {
  identity = require("./companion-identity.cjs");
} catch (_) {}

const [artifactPath, , indexPath] = process.argv.slice(2);
if (!artifactPath || !indexPath || !identity) process.exit(0);

const key = path.resolve(artifactPath);
const sessionId = process.env.SID || null;
const shortid = (sessionId || "").slice(0, 8).replace(/[^A-Za-z0-9]/g, "-");
trace.emit("index", "start", { corr: key, shortid });
if (!sessionId || !shortid) {
  trace.emit("index", "skip", { corr: key, reason: "no-shortid" });
  process.exit(0);
}

let rec = identity.readRecord(sessionId);
if (!rec) {
  // Late registration (see header). companion-livepath.sh prints
  //   live_path \t project \t shortid \t is_repo \t unit_key \t root
  try {
    const cwd = process.env.CWD || process.cwd();
    const line = execFileSync("sh", [path.join(__dirname, "companion-livepath.sh"), cwd, sessionId], {
      encoding: "utf8",
    }).trim();
    const f = line.split("\t");
    identity.register({
      session_id: sessionId,
      unit_key: f[4] || "",
      is_repo: f[3] === "1",
      project_root: f[5] || "",
      project: f[1] || "",
      owned_tab: process.env.COMPANION_SESSION || null,
    });
    rec = identity.readRecord(sessionId);
    trace.emit("index", "late-register", { corr: key, unit_key: (rec && rec.unit_key) || "" });
  } catch (_) {}
}

if (!rec || !rec.unit_key) {
  trace.emit("index", "skip", { corr: key, reason: "no-record" });
  process.exit(0);
}

// The session's source stem (<slug>--<shortid>) — the key the Board matches an
// artifact to its live session by. slug is frozen in the record, so this equals
// the live filename without ever reading the live dir.
const source = `${rec.slug}--${shortid}`;

// Stamp through the SHARED producer API (registry record decides the unit) and
// append `artifact.routed` for the Board's event tail.
const entry = identity.routeArtifact(
  { artifactPath: key, session_id: sessionId, unit_key: rec.unit_key, shortid, source, indexPath },
  undefined,
);
if (entry) {
  trace.emit("index", "stamp", { corr: key, unit_key: entry.unit_key, source, ts: entry.ts });
} else {
  trace.emit("index", "stamp-failed", { corr: key, err: "route-null" });
}
