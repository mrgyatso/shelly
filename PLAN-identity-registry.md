# Identity Registry + Event-Log — full implementation spec (cold-agent ready)

> **You are picking this up cold.** This document is self-contained: it explains the problem, the
> exact current architecture (with file paths + symbol names to grep), the target design, a phased
> migration, the regression oracle, build mechanics, and the gotchas. Read it top to bottom before
> touching code. Where line numbers would drift, grep by the **symbol names** given.

---

## 0. Where you are, what's already true

- **Work here:** worktree `~/shelly-identity-registry`, branch `feat/identity-registry` (forked from
  `master` @ `bb7fc80`). Build and commit in THIS worktree only.
- **Do NOT touch `~/shelly`** (the main checkout) — a concurrent session has uncommitted
  `overlay/src-tauri/src/{sessions,windows}.rs` there. It's the same git repo (worktrees share `.git`),
  so committing here is fine; just don't edit files in that other directory.
- **The repo:** a Tauri (Rust + TS/Vite) overlay app under `overlay/`, plus a Claude Code plugin under
  `plugin/`. Remote: `git@github.com:mrgyatso/shelly.git`. Default branch `master`.
- **Already shipped on `master`** (do not redo; build on top):
  - `364fc2b` — the **trace harness** (your regression oracle; see §4).
  - `9a37849` — an interim **re-route fix** in `board.ts` (artifact re-resolves identity when the index
    lands). The redesign makes this unnecessary; **remove it at Phase 4**, not before.
  - `bb7fc80` — **hook cleanup**: the redundant `~/.claude/settings.json` PostToolUse entry was removed
    and `shelly open` dropped, so PostToolUse now fires ONCE, via the plugin.
- **The plugin runs LIVE from the repo.** `CLAUDE_PLUGIN_ROOT` resolves to `<repo>/plugin` (proven this
  session — an instrumented `plugin/hooks/` copy fired). `~/.claude/plugins/.../installed_plugins.json`
  lists a stale cache path; ignore it. **Shell/hook edits are live immediately**; Rust/TS edits need a
  rebuild + install (§6).

---

## 1. The problem (why we're doing this)

Every identity bug this project has hit is the **same root**: identity is **derived on read** from
volatile signals and **reconstructed by every consumer**, never **registered once**.

- **The surfacing lag** (just fixed interim): the native watcher wakes the Board's poll ~600ms BEFORE
  the PostToolUse hook stamps the routing index, so the Board routes an artifact with empty identity via
  slug-fallback, and a signature guard freezes that wrong routing forever. (Memory:
  `surfacing-lag-root-cause`.)
- **The cwd-fork**: the session slug was re-derived from a moved cwd → one session became two roster
  units. (Patched by freezing slug by `session_id` in `a11a020`.)
- **Owned-tab tie-break**: multiple slugs claim one terminal tab; resolved by a "freshest source wins"
  heuristic.
- **Finding B**: an artifact's file mtime ends up after its index-stamp `ts` (a post-write rewrite via a
  non-hook path), tripping a staleness guard that then distrusts a *correct* index entry.

All four are consistency races or heuristic disagreements between two derivations of the same fact.
**Register-once + reference removes the entire class** by construction.

**Non-negotiables (from the user):** an across-the-board sounder architecture; **no regressions**; **not
held together by sticks** (no fragile interim patches — fold fixes into the design); and it **must
support the observer plugin** (§5).

---

## 2. Current architecture — exactly what exists today

### 2.1 The state files (`~/.shelly/`)
- `live/<slug>--<shortid>.json` — per-session live STATE the agent rewrites each turn
  (`{working, where, next, project, is_repo, unit_key}`). `slug` = git-root/cwd basename (sanitized);
  `shortid` = first 8 chars of `session_id`. The Board reads these for the roster.
- `artifact-index.json` — `{ "<abs-artifact-path>": {unit_key, shortid, source, ts} }`. Stamped by the
  PostToolUse hook AFTER an artifact write. `source` = `<slug>--<shortid>` of the writing session.
- `owned-sessions.json` — `{ "<slug>--<shortid>": "<tabId>" }`. Board-owned terminal → live source.
- `session-dirs.json` — `{ "<stem>": "<project_root>" }`.
- `session-ids.json` — `{ "<stem>": "<full session_id>" }` (only for Board-launched sessions).
- `dismissed.json` — array of stems manually closed off the roster.
- `unit-names.json` — `{ unit_key: custom_name }`.
- `logs/trace.ndjson` — the harness log (§4). `mode` — `agent`|`manual` (artifact rendering mode).

### 2.2 The hooks (`plugin/hooks/`, registered by `plugin/hooks/hooks.json`)
- `shelly-session` (SessionStart) — derives identity via `shelly-livepath.sh`, writes the live
  stub if absent, and writes the sidecars (`owned-sessions` if `SHELLY_SESSION` env set,
  `session-dirs`, `session-ids`), prunes old live files, injects the live path + digest path into the
  agent's context. **Bails early on observer/`.claude-mem` sessions** (keep this).
- `shelly-livepath.sh` — the identity derivation: reuse-existing-by-shortid (frozen identity) vs
  fresh-derive (slug from gitroot/cwd). Prints a TAB line `live_path\tproject\tshortid\tis_repo\tunit_key`.
- `shelly-hook` (PostToolUse Write|Edit) — on an artifact write into the artifacts dir, calls
  `shelly-index.cjs` to stamp the index. (`overlay/scripts/shelly-hook` is a now-dormant older
  copy — settings.json no longer invokes it; the plugin copy is live.)
- `shelly-index.cjs` — globs `live/*--<shortid>.json` for the writing session, reads its `unit_key`,
  stamps `artifact-index.json`. **First-match-wins glob = a fork hazard** (logs `matchCount`).
- `shelly-session-end` (SessionEnd) — deletes the live file + sidecar entries, but ONLY on genuine
  user-initiated ends (`clear|logout|prompt_input_exit`); keeps everything on forced/crash exits.
- `shelly-trace.{cjs,sh}` — the shared NDJSON trace appender (§4). `shelly-consider` — Stop hook.

### 2.3 The overlay (`overlay/src-tauri/src/` Rust, `overlay/src/` TS)
- `lib.rs` — `mod` declarations (top); `tauri::generate_handler![...]` (~line 128) registers commands;
  `artifact_watch::init(app.handle())` in setup (~line 325).
- `live.rs` — `read_all_live()` (`#[tauri::command]`, ~258): reads every `live/*.json`, and
  `inject_fields()` (~343) injects `updated_ms`, `shelly_session` (from `owned-sessions`), `unit_dir`
  (from `session-dirs`), `session_id` (from `session-ids`, validated against real transcripts),
  `dismissed`. Helpers: `owned_sessions()`, `session_dirs()`, `session_ids()`, `dismissed_set()`.
- `history.rs` — `artifact_dirs()` (~65, the scan dirs), `list_artifacts()` (~241): lists `*.html`,
  attaches `unit_key`+`source` from `load_artifact_index()` with a **staleness guard**
  (`STALE_INDEX_TOLERANCE_MS`: if file mtime > entry ts + tolerance, distrust the entry). `ArtifactEntry`
  carries `path, modified_ms, unit_key, source, project, …`.
- `artifact_watch.rs` — native 700ms dir-scan thread; emits Tauri event `board:artifacts-changed` when
  the `*.html` set changes. Instrumented via `crate::trace`.
- `trace.rs` — the harness Rust side: `emit()`, `enabled()`, and `#[tauri::command] trace_event/trace_enabled`.
- `board.ts` — the webview. Key symbols (grep by name; lines drift):
  - constants `POLL_MS` (1200), `UNSOURCED` (`"__unsourced__"`), `IDLE`.
  - `initBoard()` — sets up the poll `setInterval(pollLive, POLL_MS)` + force-poll wakes
    (`visibilitychange`, window `focus`, `onFocusChanged`, `listen("board:artifacts-changed")`).
  - `pollLive()` — reads `read_all_live` + `list_artifacts`, builds `sessionToUnit`, calls
    `reconcileBindings()`, then `ingestArtifacts()` when the artifact signature changed.
  - `artifactSig()` — `path:mtime:source:unit_key` (identity folded in by `9a37849`).
  - `unitForArtifact(a)` — resolves an artifact's unit: source-match (`allSources`) → `a.unit_key`
    (from index) → slug-fallback (`projectSlug(a.project)`) → `UNSOURCED`.
  - `activeSessionSource(unitKey)` — the live source of the unit's active owned terminal.
  - `ingestArtifacts()` — the keystone: routes new (and, per `9a37849`, re-routed) artifacts into
    `unreadByUnit` / hero pill / auto-advance. Has a **fail-loud guard** (warns on empty-source /
    `UNSOURCED`).
  - `reconcileBindings()` / `ownedTabForUnit()` in `overlay/src/owned-terminals.ts`.

---

## 3. Target architecture (register once, reference, tail events)

1. **Authoritative session record** — `~/.shelly/sessions/<session_id>.json`, written ONCE at
   SessionStart, immutable identity:
   ```json
   { "session_id": "...", "unit_key": "...", "project_root": "/abs/path", "slug": "...",
     "is_repo": true, "created_ms": 0, "owned_tab": "<tabId|null>" }
   ```
   `unit_key` is resolved from gitroot/cwd at registration, then **frozen**. Keyed by the FULL,
   immutable `session_id` (not the 8-char shortid — that was a collision source).
2. **Artifacts reference their owning `session_id`.** The PostToolUse hook records `path → session_id`
   (a thin index, or write the id into the artifact's `shelly-meta`). Unit is resolved
   `session_id → record → unit_key`. **No slug-from-cwd, no mtime staleness guard, no freshest-source
   tie-break, no shortid glob.**
3. **Append-only event log** = source of truth for "what happened when" (promote the harness shape):
   `~/.shelly/events.ndjson`, one event per line:
   - `{"evt":"session.registered","session_id","unit_key","root","ts_ms"}`
   - `{"evt":"artifact.routed","path","session_id","ts_ms"}`
   - `{"evt":"tab.bound","session_id","tab","ts_ms"}`
   - `{"evt":"session.ended","session_id","ts_ms"}`
   The Board **tails** this (incremental) instead of re-reading + re-deriving all state every 1.2s. Keep
   a bounded poll as a fallback/cold-start (read the registry dir) so a missed event self-heals.
4. **Fail loud** — if a consumer can't resolve a `session_id` for an artifact, surface a **visible error
   tile** on the Board, never the silent `UNSOURCED` void. Log it to the trace too.
5. **Keep the file-based virtues** — plain JSON/NDJSON on disk, `cat`-inspectable, language-agnostic,
   atomic writes (temp+rename, or O_APPEND for the log). Live files revert to **pure STATE**
   (`working/where/next`), no identity fields. Do NOT introduce a database.

### Resolution rule (the one function everything calls)
`resolveUnit(session_id) -> unit_key | ERROR`: look up `sessions/<id>.json`; if missing →
fail-loud ERROR (surface it). That's it. No fallbacks once Phase 4 lands.

---

## 4. The regression oracle — the trace harness (already built)

- **Turn on:** `touch ~/.shelly/logs/trace.on` (or env `SHELLY_TRACE=1`). **Off:**
  `rm` the flag. Off by default; non-blocking; structured fields only (never raw stdin/env).
- **One NDJSON log:** `~/.shelly/logs/trace.ndjson`, joined on `corr` (artifact abs path),
  epoch-ms clock across all layers (shell hook, node index, Rust watcher/readers, TS board).
- **Read it:** `node overlay/scripts/trace-view.mjs <corr-substring>` (stage timeline + per-layer first
  touch + branch), `--branches` (every routing decision), `--polls` (poll cadence / throttle gaps).
- **Event vocabulary today:** `hook/fire`, `hook/index-spawn|done`, `index/start|match|stamp`,
  `watcher/detect|emit|slow-tick`, `live/read`, `history/list|index-stale-drop`, `board/poll.start|end`,
  `board/wake`, `board/bindings.newly`, `board/ingest.run|branch|reroute|unrouted`, `board/autoadvance.*`.
  ADD events for the new layers: `registry/register`, `registry/resolve|resolve-miss`, `events/append`,
  `events/tail`.
- **This is your safety net for every phase.** Before/after each phase, run the §7 case matrix with
  tracing on and diff the timelines. A regression = a routing that changed for the worse or a new silent
  `UNSOURCED`.

---

## 5. Observer-plugin compatibility (HARD requirement)

The observer lives at `~/shelly-artifact-observer` (branch `feat/async-artifact-observer`), plugin
`shelly@shelly-observer-dev`. It is BOTH:
- **A fork of the identity hooks** — `plugin/hooks/{shelly-session,shelly-livepath.sh,
  shelly-index.cjs,shelly-hook,shelly-session-end}` are copies of the same identity machinery.
- **A second artifact producer** — `plugin/scripts/artifact-observer/`:
  - `capture.cjs` (a hook) reads the session turn from stdin, detects substantive/visual intent,
    enqueues work; per-session turn state under `~/.shelly/observer/sessions/`.
  - `worker.cjs` — a background daemon (queue `~/.shelly/observer/queue`, debounce 30s, idle
    exit 5m) that calls a model (`model.cjs` + `designer.cjs`), renders an artifact (`renderer.cjs`),
    **writes it into the artifacts dir AND stamps `artifact-index.json`** on behalf of an OBSERVED session.
  - `start.cjs` / `process.cjs` — worker lifecycle.

**Compat requirements (build these into the design, verify in Phase 5):**
1. **One shared identity implementation both plugins source** — extract the registry + resolution +
   event-append logic into a single lib (e.g. `plugin/hooks/shelly-identity.cjs` and/or a small
   `.sh`) that BOTH the main plugin and the observer plugin reference. **Never fork it again** — forked
   hook drift is the disease.
2. The observer worker must **attribute its generated artifacts to the OBSERVED `session_id`** (it has
   per-session capture state) via the same `artifact.routed`/index API — not by re-deriving identity.
3. The observer's OWN worker process must **not** register a spurious session. The SessionStart hook
   already bails on observer/`.claude-mem` sessions — preserve that exclusion.
4. Decide the sharing mechanism explicitly: either (a) the observer worktree's plugin symlinks/copies the
   shared lib from the main repo, or (b) the shared lib is published with the plugin and both install it.
   Pick one and document it in this worktree; verify the observer routes correctly with it.

---

## 6. Build / run / verify mechanics

- **Overlay (Rust/TS) build:** `cd ~/shelly-identity-registry/overlay && npm run tauri build`
  (~few min; first build slower). Produces `src-tauri/target/release/bundle/macos/Shelly.app`.
- **Install + run:** `pkill -f "Shelly"; rm -rf "/Applications/Shelly.app";
  ditto "<built .app>" "/Applications/Shelly.app"; open "/Applications/Shelly.app"`.
  (There is only one installed overlay system-wide; installing from this worktree replaces it — fine for
  dev, just be aware the main checkout's build would differ.)
- **TS typecheck (fast, pre-build):** `cd overlay && npx tsc --noEmit`.
- **Rust check (fast):** `cd overlay/src-tauri && cargo check`; format with `cargo fmt`.
- **Hooks are live from the repo** (no build); but they run from `<repo>/plugin` = the MAIN checkout's
  plugin dir for sessions started in the main repo. For the redesign, decide whether you test hooks via
  this worktree's plugin (point a test session's `CLAUDE_PLUGIN_ROOT` / marketplace at this worktree) —
  document the test setup. The overlay you build here is what renders regardless.
- **Sequence all Rust/TS edits for a phase into ONE build.** Restart the app after install.

---

## 7. Migration — phased, additive-first, each phase fully working

> Rule: never delete an old path until the new one is verified at parity. Each phase must leave the
> system working on exactly ONE source of truth (old until Phase 4, new after). A half-migrated registry
> coexisting with old derivations is the failure mode.

- **Phase 0 — oracle check.** Build this worktree's overlay, confirm `trace-view.mjs` works and the §7
  case matrix passes on the *current* (master) behavior. Capture baseline timelines.
- **Phase 1 — dual-write registry (non-breaking).** Add the shared identity lib; `shelly-session`
  writes `sessions/<session_id>.json` AND appends `session.registered` to `events.ndjson`, ALONGSIDE
  today's sidecars. Nothing reads the registry yet. Add `registry/register` trace events. **Verify:**
  records appear correct for repo / non-repo / resumed (same session_id → same record) / two sessions in
  one repo (no fork) / Board-launched (owned_tab set).
- **Phase 2 — read primary, fall back.** `live.rs`, `history.rs`, `board.ts` resolve identity from the
  registry first, falling back to the OLD derivation when no record exists (so pre-existing sessions
  still work). The PostToolUse hook records `path → session_id`. Add `registry/resolve` events.
  **Verify:** routing parity vs the Phase 0 baseline across the full matrix; zero new silent `UNSOURCED`.
- **Phase 3 — event log.** The Board tails `events.ndjson` (incremental state) for artifact routing /
  bindings instead of poll-and-re-derive; keep a bounded registry-dir poll as cold-start + self-heal.
  Add `events/tail` events. **Verify:** an occluded write surfaces under its unit with NO reroute (the
  identity is correct on first ingest, because it was recorded, not reconstructed).
- **Phase 4 — cutover + cleanup.** Once parity holds, remove: the slug-fallback path, the staleness
  guard in `history.rs`, the 4 sidecars (subsumed into the record), the shortid glob in the index hook,
  and the interim re-route in `board.ts` (`9a37849`). Turn ON fail-loud (visible error tile). **Verify:**
  full matrix; deliberately feed an unresolvable artifact and confirm the error tile (not silence).
- **Phase 5 — observer.** Point the observer plugin at the shared identity lib; the worker attributes
  artifacts to the observed `session_id`. **Verify:** an observer-generated artifact routes to the
  OBSERVED session's unit; the observer's own process registers no spurious session.

---

## 8. Regression case matrix (run every phase, `SHELLY_TRACE=1`)

For each, write an artifact via the Write tool and read `trace-view.mjs <slug>`:
1. repo-session artifact, Board **foreground** → routes to its unit, surfaces.
2. repo-session artifact, Board **occluded** (defocus, idle ~100s) → surfaces, no freeze. (The §1 case.)
3. **non-repo** session (launched from `$HOME`) artifact → routes to the right unit, not `UNSOURCED`.
4. **two sessions in one repo** (use a git worktree) → two distinct correct units, no fork.
5. **sibling-session** artifact (a 2nd session in a unit you're viewing) → ambient unread, not the hero.
6. **resumed/compacted** session (same `session_id`) → same record, same unit.
7. **observer-generated** artifact → routes to the OBSERVED session's unit (Phase 5).
8. **unresolvable** artifact (no record) → fail-loud error tile (Phase 4), never silent.

**Pass bar:** routing identical-or-better than the Phase 0 baseline; **zero silent `UNSOURCED`**; **one
ingest per artifact** (no reroute — identity is right the first time because it was registered, not raced).

---

## 9. Gotchas (learned this session — don't relearn them)

- **macOS `date +%s%3N` is broken** (BSD date has no `%N`). Use `node -e 'Date.now()'` for ms in shell.
- **The LaunchAgent strips shell env**, so the overlay daemon won't see `SHELLY_TRACE`. The
  `trace.on` flag file is the cross-layer switch every layer checks identically — keep that pattern for
  any new gating.
- **Atomic writes:** sidecars use temp+rename; the trace/event log uses a single O_APPEND write per line
  (sub-4KB lines are atomic). Preserve this for `events.ndjson` (build the full line, one `write_all`).
- **`session_id` vs `shortid`:** the live filename uses the 8-char shortid, which CAN collide; the
  registry MUST key on the full `session_id`. The index hook's shortid glob is a fork hazard — the
  registry replaces it.
- **Shared working tree:** committing in this worktree is fine; never edit files in `~/shelly`.
- **The Board is a sandboxed, opaque-origin iframe host** — artifacts self-report size; the webview
  can't read disk, hence the `trace_event` Tauri command bridge (mirror that pattern if the Board needs
  to write events).
- **There are ~8 stale `shelly--*` live files** in `live/` from prior sessions; don't
  assume one session per unit when testing.

---

## 10. Supporting context (read if you need more)
- Agent memories (in `~/.claude/projects/-Users-gyatso-shelly/memory/`):
  `surfacing-lag-root-cause`, `shelly-identity-registry-redesign` (points here),
  `terminal-rehydrate-on-restart`.
- Handoffs at the main repo root: `HANDOFF-2026-06-28-logging-harness.md` (the harness mission),
  `HANDOFF-2026-06-28-hook-cleanup.md` (the double-registration / `shelly open` cleanup + Finding B).
- The harness commit `364fc2b` body has the full layer-by-layer description.

---

## 11. First action when you pick this up
1. `cd ~/shelly-identity-registry` and confirm `git branch` shows `feat/identity-registry`.
2. Read this plan fully.
3. Do **Phase 0**: build the overlay here, `touch ~/.shelly/logs/trace.on`, run the §8 matrix
   on current behavior, save the baseline timelines (the parity reference for every later phase).
4. Then **Phase 1** (dual-write the registry). Commit per phase with a clear message; keep tracing as the gate.
