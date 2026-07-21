#!/usr/bin/env node
// shelly-identity.cjs — the ONE shared identity registry for Shelly.
//
// THE WHOLE POINT: identity is REGISTERED ONCE, then REFERENCED — never re-derived
// on read by every consumer. Every identity bug this project has hit (the surfacing
// lag, the cwd-fork, the owned-tab tie-break, Finding B) is two derivations of the
// same fact disagreeing. A single authoritative record, keyed by the immutable
// session_id, removes that entire class by construction.
//
//   CLI (from the sh hooks):
//     node shelly-identity.cjs register <session_id> <unit_key> <is_repo> \
//          <project_root> <project> [owned_tab] [provider] [slug]
//   lib (from node hooks / the observer worker):
//     const id = require("./shelly-identity.cjs");
//     id.register({ session_id, unit_key, project_root, is_repo, project, owned_tab });
//     id.resolveUnit(session_id);   // -> unit_key | null
//     id.readRecord(session_id);    // -> record  | null
//     id.appendEvent({ evt: "...", ... });
//
// FILES (under ~/.shelly/, HOME-overridable for sandboxed tests):
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
// IDENTITY IS NOT RE-DERIVED HERE. The caller (shelly-session, via
// shelly-livepath.sh) already derived unit_key/is_repo/project ONCE; register()
// only RECORDS what it is handed. Re-deriving would reintroduce the two-derivations
// disease. resolveUnit() is then a pure lookup.

const fs = require("fs");
const path = require("path");
const os = require("os");

// Co-located trace breadcrumb (off-by-default harness; separate from the always-on
// events.ndjson). Never let a missing trace lib sink a registry write.
let trace = { emit() {} };
try {
  trace = require("./shelly-trace.cjs");
} catch (_) {}

function homeDir(opts) {
  return (opts && opts.home) || process.env.HOME || os.homedir();
}
function shellyDir(opts) {
  return path.join(homeDir(opts), ".shelly");
}
function sessionsDir(opts) {
  return path.join(shellyDir(opts), "sessions");
}
function eventsPath(opts) {
  return path.join(shellyDir(opts), "events.ndjson");
}

// session_id is a UUID, already filename-safe; sanitize defensively so a malformed
// id can never escape the sessions dir (path traversal) or collide on a separator.
function safeId(session_id) {
  return String(session_id || "").replace(/[^A-Za-z0-9._-]/g, "-");
}

function recordPath(session_id, opts) {
  return path.join(sessionsDir(opts), safeId(session_id) + ".json");
}

// ---- artifact-index.json write lock -----------------------------------------
//
// EVERY WRITER OF THE INDEX READ-MODIFY-WRITES THE WHOLE FILE, so two hooks racing lose
// each other's updates. The temp+rename below is atomic for READERS (nobody sees a torn
// file) but does nothing for writers: A reads, B reads, A writes, B writes — and A's
// entry is gone. That is not theoretical here. Two sessions in one repo is the normal
// case, and the collision is exactly `sealArtifacts` (fires at Stop, rewrites many
// entries) landing on top of a sibling's `routeArtifact` (fires on every artifact write).
// The lost entry means an artifact with no identity, which the Board surfaces as UNROUTED.
//
// So both writers serialize on one lock. `mkdir` is the primitive: atomic on POSIX, fails
// with EEXIST if held, and needs no dependency.
//
// The read MUST happen inside the critical section — that is the whole point. A lock held
// only around the write serializes nothing, because the stale copy was already in hand.

/** How long a lock may be held before we assume its owner died and steal it. Hooks touch
 *  this file for single-digit milliseconds, so seconds of age means a crash — and a
 *  crashed hook must never wedge artifact indexing permanently. */
const LOCK_STALE_MS = 5000;
/** How long to wait for the lock before giving up and proceeding UNLOCKED. */
const LOCK_WAIT_MS = 2000;
const LOCK_POLL_MS = 15;

/** Block this process without a dependency (these hooks are short-lived CLI processes,
 *  so a synchronous wait is honest — there is no event loop to starve). */
function sleepSync(ms) {
  try {
    Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms);
  } catch (_) {
    const until = Date.now() + ms;
    while (Date.now() < until) {} // eslint-disable-line no-empty
  }
}

/**
 * Run `fn` holding the index write lock. Returns whatever `fn` returns.
 *
 * FAILS OPEN, DELIBERATELY: if the lock can't be taken within `LOCK_WAIT_MS` we run `fn`
 * anyway, unlocked. Skipping the write instead would strand an artifact with no index
 * entry — the unrouted state — and a rare lost update is strictly better than a
 * guaranteed lost one. Contention here is microseconds of real work, so the timeout
 * should never be reached in practice; it exists so a pathological case degrades to
 * today's behaviour rather than to silence.
 */
function withIndexLock(indexPath, fn) {
  const lockPath = indexPath + ".lock";
  const deadline = Date.now() + LOCK_WAIT_MS;
  let held = false;
  while (Date.now() < deadline) {
    try {
      fs.mkdirSync(lockPath);
      held = true;
      break;
    } catch (e) {
      if (!e || e.code !== "EEXIST") break; // unusable lock path → proceed unlocked
      try {
        if (Date.now() - fs.statSync(lockPath).mtimeMs > LOCK_STALE_MS) {
          fs.rmdirSync(lockPath); // owner died mid-write; reclaim and retry immediately
          continue;
        }
      } catch (_) {} // the holder released between our EEXIST and the stat — just retry
      sleepSync(LOCK_POLL_MS);
    }
  }
  try {
    return fn();
  } finally {
    if (held) {
      try {
        fs.rmdirSync(lockPath);
      } catch (_) {}
    }
  }
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
    fs.mkdirSync(shellyDir(opts), { recursive: true });
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
    // (shelly-artifact-fork.cjs) compares it against the prompt_id on a later write to
    // decide "still authoring" vs "sealed in an earlier turn" — an identity comparison,
    // where `ts` could only offer a clock comparison against a lagging transcript. Null on
    // an older client (prompt_id predates Claude Code 2.1.196); the fork hook then falls
    // back to mtime. The Rust reader picks index fields by name, so this is additive.
    prompt_id: args.prompt_id || null,
  };
  const indexPath = args.indexPath || path.join(shellyDir(opts), "artifact-index.json");
  // Read + write INSIDE the lock (see withIndexLock): a concurrent sealArtifacts holding
  // an older copy would otherwise drop this entry on its own write, leaving the artifact
  // unrouted.
  const wrote = withIndexLock(indexPath, () => {
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
      return true;
    } catch (_) {
      return false;
    }
  });
  if (!wrote) return null;
  appendEvent({ evt: "artifact.routed", path: key, session_id: sid, unit_key }, opts);
  trace.emit("registry", "route", { corr: key, session_id: sid || "", unit_key });
  return entry;
}

/**
 * SEAL this session's artifacts — "the agent has stopped writing; you may show them now."
 *
 * WHY: `routeArtifact` stamps the index on EVERY write, and an agent authoring one
 * artifact writes it many times in a turn (a Write, then edits, then a rewrite). The
 * Board polls that index, so it used to surface revision 1 the instant it landed and
 * then nag an "Updated" affordance on every keystroke after it — the user watching a
 * document assemble itself and being asked to re-read it each time. An artifact is a
 * SEALED deliverable, not a live buffer; the in-flight surface is the live pane.
 *
 * So the Board withholds an artifact until it carries `sealed_ms`, and this is what
 * stamps it: called from the Stop hook, i.e. exactly when the agent hands the terminal
 * back. That is the SAME turn boundary shelly-turn.cjs serves to the gate and the fork
 * hook — a third caller of one fact, never a fourth derivation of it.
 *
 * SEALS THE WHOLE SESSION, NOT JUST THIS TURN. An interrupted turn (the user hits ESC)
 * never reaches Stop, so its artifact would otherwise stay unsealed — invisible — forever.
 * Sweeping every unsealed entry this session owns means the next Stop adopts that orphan.
 * The Rust reader carries a time backstop for the session that never Stops again at all.
 *
 * Idempotent: an already-sealed entry keeps its original `sealed_ms`, so re-running at
 * every Stop can't keep bumping the seal time. Returns the number of entries newly
 * sealed; 0 on any failure — a seal that doesn't land costs visibility for the backstop
 * window, never correctness.
 */
function sealArtifacts(session_id, opts) {
  const sid = safeId(session_id);
  if (!sid) return 0;
  const indexPath =
    (opts && opts.indexPath) || path.join(shellyDir(opts), "artifact-index.json");
  // THE WHOLE READ-MODIFY-WRITE IS THE CRITICAL SECTION. This function rewrites EVERY
  // entry it owns, so it is the writer most likely to clobber a sibling's freshly-routed
  // artifact — and re-reading here, under the lock, is what makes that impossible.
  const sealed = withIndexLock(indexPath, () => {
    let index;
    try {
      index = JSON.parse(fs.readFileSync(indexPath, "utf8")) || {};
    } catch (_) {
      return 0; // no index yet, or unreadable — nothing to seal
    }
    const now = Date.now();
    const short = sid.slice(0, 8);
    let n = 0;
    for (const [key, entry] of Object.entries(index)) {
      if (!entry || typeof entry !== "object") continue;
      if (entry.sealed_ms) continue; // already sealed — keep the original stamp
      // Match the gate's ownership test: session_id when present, else the shortid an
      // older entry was stamped with.
      if (entry.session_id !== sid && entry.shortid !== short) continue;
      index[key] = { ...entry, sealed_ms: now };
      n++;
    }
    if (!n) return 0;
    try {
      // Atomic (temp + rename), matching routeArtifact — the Board polls this file.
      const tmp = indexPath + "." + process.pid + ".seal.tmp";
      fs.writeFileSync(tmp, JSON.stringify(index));
      fs.renameSync(tmp, indexPath);
    } catch (_) {
      return 0;
    }
    return n;
  });
  if (!sealed) return 0;
  trace.emit("registry", "seal", { session_id: sid, count: sealed });
  return sealed;
}

module.exports = { register, resolveUnit, readRecord, appendEvent, routeArtifact, sealArtifacts, recordPath, sessionsDir, eventsPath };

// CLI form for the sh hooks (shelly-session). Mirrors shelly-trace.cjs's
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
