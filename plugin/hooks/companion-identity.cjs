#!/usr/bin/env node
// companion-identity.cjs — the ONE shared identity registry for Companion.
//
// THE WHOLE POINT: identity is REGISTERED ONCE, then REFERENCED — never re-derived
// on read by every consumer. Every identity bug this project has hit (the surfacing
// lag, the cwd-fork, the owned-tab tie-break, Finding B) is two derivations of the
// same fact disagreeing. A single authoritative record, keyed by the immutable
// session_id, removes that entire class by construction.
//
//   CLI (from the sh hooks):
//     node companion-identity.cjs register <session_id> <unit_key> <is_repo> \
//          <project_root> <project> [owned_tab] [provider] [slug]
//   lib (from node hooks / the observer worker):
//     const id = require("./companion-identity.cjs");
//     id.register({ session_id, unit_key, project_root, is_repo, project, owned_tab });
//     id.resolveUnit(session_id);   // -> unit_key | null
//     id.readRecord(session_id);    // -> record  | null
//     id.appendEvent({ evt: "...", ... });
//
// FILES (under ~/.claude/companion/, HOME-overridable for sandboxed tests):
//   sessions/<session_id>.json  — the authoritative, immutable session record:
//     { session_id, unit_key, project_root, slug, is_repo, project, created_ms, owned_tab }
//     Written ONCE at SessionStart; resume/compact (same session_id) find it and
//     leave it untouched, so identity is frozen for the session's whole life.
//   events.ndjson               — the append-only source-of-truth event log:
//     {"evt":"session.registered","session_id","unit_key","root","ts_ms"}  (one/line)
//     The Board will TAIL this (Phase 3) instead of re-deriving all state every poll.
//
// SHARING (§5.4 decision, documented in DECISIONS-identity-registry.md): this file is
// the single canonical copy in plugin/hooks/. The observer plugin carries the SAME
// file via git (its branch rebases onto master at Phase 5) and `require()`s it by the
// same relative path from its own CLAUDE_PLUGIN_ROOT — never a second forked copy.
//
// IDENTITY IS NOT RE-DERIVED HERE. The caller (companion-session, via
// companion-livepath.sh) already derived unit_key/is_repo/project ONCE; register()
// only RECORDS what it is handed. Re-deriving would reintroduce the two-derivations
// disease. resolveUnit() is then a pure lookup.

const fs = require("fs");
const path = require("path");
const os = require("os");

// Co-located trace breadcrumb (off-by-default harness; separate from the always-on
// events.ndjson). Never let a missing trace lib sink a registry write.
let trace = { emit() {} };
try {
  trace = require("./companion-trace.cjs");
} catch (_) {}

function homeDir(opts) {
  return (opts && opts.home) || process.env.HOME || os.homedir();
}
function companionDir(opts) {
  return path.join(homeDir(opts), ".claude", "companion");
}
function sessionsDir(opts) {
  return path.join(companionDir(opts), "sessions");
}
function eventsPath(opts) {
  return path.join(companionDir(opts), "events.ndjson");
}

// session_id is a UUID, already filename-safe; sanitize defensively so a malformed
// id can never escape the sessions dir (path traversal) or collide on a separator.
function safeId(session_id) {
  return String(session_id || "").replace(/[^A-Za-z0-9._-]/g, "-");
}

function recordPath(session_id, opts) {
  return path.join(sessionsDir(opts), safeId(session_id) + ".json");
}

/** Read a session's record, or null if absent/unreadable. Pure lookup — no derive. */
function readRecord(session_id, opts) {
  const sid = safeId(session_id);
  if (!sid) return null;
  try {
    return JSON.parse(fs.readFileSync(recordPath(sid, opts), "utf8")) || null;
  } catch (_) {
    return null;
  }
}

/** Resolve a session's unit_key from its record, or null if unregistered. The one
 *  function every consumer will call (Phase 2+). Phase 4 turns "null" into a
 *  fail-loud surface; for now callers fall back to the old derivation. */
function resolveUnit(session_id, opts) {
  const rec = readRecord(session_id, opts);
  const unit = rec && rec.unit_key ? rec.unit_key : null;
  trace.emit("registry", unit ? "resolve" : "resolve-miss", {
    session_id: safeId(session_id),
    unit_key: unit || "",
  });
  return unit;
}

/** Append one event to the source-of-truth log. Builds the full line and does a
 *  single appendFileSync — a sub-4KB write under O_APPEND is atomic, so it never
 *  interleaves with concurrent writers (same guarantee the trace log relies on). */
function appendEvent(evt, opts) {
  const rec = Object.assign({ ts_ms: Date.now() }, evt);
  try {
    fs.mkdirSync(companionDir(opts), { recursive: true });
    fs.appendFileSync(eventsPath(opts), JSON.stringify(rec) + "\n");
  } catch (_) {
    // The event log must never throw into a hook's critical path.
  }
}

/**
 * Register a session's identity, ONCE. Idempotent on the FULL session_id: if a
 * record already exists (resume/compact/second SessionStart), it is returned
 * UNCHANGED — created_ms and the frozen identity are preserved. This idempotency is
 * the entire reason the registry exists: re-deriving identity on resume is exactly
 * what forked one session into two roster units (a11a020).
 *
 * `rec` carries the identity the caller already derived (no re-derivation here):
 *   { session_id, unit_key, project_root, slug, is_repo, project, owned_tab }
 * `slug` is the live stem's slug (the <slug> in live/<slug>--<shortid>.json) — the
 * name every source-stem comparison on the Board uses. It is NOT the unit_key:
 * for a $HOME session unit_key is '__home__' while the stem slug is the cwd
 * basename, and conflating them stamped artifacts with a source no live session
 * matches (blank hero, 2026-07-14). Callers that predate the split may omit it;
 * unit_key is then the fallback (identical for repo sessions).
 *
 * Returns { record, created }: created=false means the record already existed.
 */
function register(rec, opts) {
  const sid = safeId(rec && rec.session_id);
  if (!sid) return { record: null, created: false };

  const existing = readRecord(sid, opts);
  if (existing) {
    trace.emit("registry", "register", {
      session_id: sid,
      unit_key: existing.unit_key || "",
      created: "false",
    });
    return { record: existing, created: false };
  }

  const record = {
    session_id: sid,
    unit_key: rec.unit_key || "",
    project_root: rec.project_root || "",
    slug: rec.slug || rec.unit_key || "",
    is_repo: !!rec.is_repo,
    project: rec.project || "",
    created_ms: Date.now(),
    owned_tab: rec.owned_tab || null,
    // Which CLI runs this session ("claude" | "codex"). Absent on pre-Codex records,
    // so readers treat a missing value as "claude". Frozen like the rest: the CLI
    // that starts a session is the CLI that resumes it.
    provider: rec.provider || "claude",
  };

  // Atomic create: temp + rename, so a concurrent reader never sees a partial file.
  // The existsSync fast-path above makes the common case (resume) a no-op; the rare
  // concurrent first-start race is benign — identity is deterministic, so both
  // writers land the same unit_key.
  try {
    const dir = sessionsDir(opts);
    fs.mkdirSync(dir, { recursive: true });
    const finalPath = recordPath(sid, opts);
    const tmp = finalPath + "." + process.pid + ".tmp";
    fs.writeFileSync(tmp, JSON.stringify(record));
    fs.renameSync(tmp, finalPath);
  } catch (_) {
    // Registration is best-effort in Phase 1 (dual-write); the old sidecars still
    // carry routing, so a failed write can't lose work.
    return { record, created: false };
  }

  appendEvent(
    {
      evt: "session.registered",
      session_id: sid,
      unit_key: record.unit_key,
      root: record.project_root,
    },
    opts,
  );
  trace.emit("registry", "register", {
    session_id: sid,
    unit_key: record.unit_key,
    created: "true",
  });
  return { record, created: true };
}

/**
 * Route an artifact to its owning session — the ONE stamp every producer uses
 * (the PostToolUse hook for agent-written artifacts, the observer worker for
 * generated ones). Forked stamp implementations are how identity drifts; any
 * new artifact producer must call this, never write the index itself.
 *
 * Resolves the unit from the session's frozen registry record when one exists
 * (authoritative), else falls back to the caller's `unit_key` (captured at
 * enqueue/glob time — pre-registry sessions only). Stamps the index entry
 * atomically and appends the `artifact.routed` event the Board tails.
 *
 * args: { artifactPath, session_id?, unit_key?, shortid?, source?, indexPath? }
 * Returns the stamped entry, or null when there is no identity to stamp
 * (the caller's legacy fallback — e.g. project-slug routing — then covers it).
 */
function routeArtifact(args, opts) {
  if (!args || !args.artifactPath) return null;
  const key = path.resolve(String(args.artifactPath));
  const sid = args.session_id ? safeId(args.session_id) : null;
  const unit_key = (sid && resolveUnit(sid, opts)) || args.unit_key || null;
  if (!unit_key) return null;

  const entry = {
    unit_key,
    shortid: args.shortid || (sid ? sid.slice(0, 8) : null),
    source: args.source || null,
    ts: Date.now(),
    session_id: sid,
    // Which user prompt this artifact was written under. The PreToolUse fork hook
    // (companion-artifact-fork.cjs) compares it against the prompt_id on a later write to
    // decide "still authoring" vs "sealed in an earlier turn" — an identity comparison,
    // where `ts` could only offer a clock comparison against a lagging transcript. Null on
    // an older client (prompt_id predates Claude Code 2.1.196); the fork hook then falls
    // back to mtime. The Rust reader picks index fields by name, so this is additive.
    prompt_id: args.prompt_id || null,
  };
  const indexPath = args.indexPath || path.join(companionDir(opts), "artifact-index.json");
  try {
    let index = {};
    try {
      index = JSON.parse(fs.readFileSync(indexPath, "utf8")) || {};
    } catch (_) {}
    index[key] = entry;
    // Atomic write (temp + rename) so a concurrent reader never sees a partial file.
    const tmp = indexPath + "." + process.pid + ".tmp";
    fs.writeFileSync(tmp, JSON.stringify(index));
    fs.renameSync(tmp, indexPath);
  } catch (_) {
    return null;
  }
  appendEvent({ evt: "artifact.routed", path: key, session_id: sid, unit_key }, opts);
  trace.emit("registry", "route", { corr: key, session_id: sid || "", unit_key });
  return entry;
}

module.exports = { register, resolveUnit, readRecord, appendEvent, routeArtifact, recordPath, sessionsDir, eventsPath };

// CLI form for the sh hooks (companion-session). Mirrors companion-trace.cjs's
// require.main pattern. Positional args keep the sh call site simple:
//   register <session_id> <unit_key> <is_repo> <project_root> <project> [owned_tab] [provider] [slug]
// is_repo is the string "1"/"0" the sh hooks already carry.
if (require.main === module) {
  const [cmd, ...rest] = process.argv.slice(2);
  if (cmd === "register") {
    const [session_id, unit_key, is_repo, project_root, project, owned_tab, provider, slug] = rest;
    register({
      session_id,
      unit_key,
      is_repo: is_repo === "1",
      project_root,
      project,
      owned_tab: owned_tab || null,
      provider: provider || "claude",
      slug: slug || "",
    });
  } else if (cmd === "resolve") {
    const unit = resolveUnit(rest[0]);
    if (unit) process.stdout.write(unit);
  }
}
