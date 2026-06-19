# Handoff — Rework the Companion **plugin** (hooks · install · agent-facing UI prompting)

**Updated:** 2026-06-19 (rewritten with concrete app-side knowledge by the overlay agent)
**Repo:** `~/claude-code-companion` (branch `master`)
**Report back through Companion itself:** write HTML artifacts into `~/.claude/companion/artifacts/`
following `plugin/skills/prefer-html/SKILL.md` (see *How to build the proper UI* below).

---

## Who you are, and what this doc is

You are taking over the **Companion plugin** (`plugin/**`) — the Claude Code hooks, commands, and
skills that connect a running `claude` session to the **Companion overlay app** ("the Board").

The earlier version of this handoff assumed two agents working in parallel with a hard "don't touch
the overlay" wall. **That's superseded** — the overlay side has moved a lot since, and the user now
wants the plugin reworked *with full knowledge of how the app actually consumes its output*. So this
doc is not "go research the codebase." It is **me (the overlay agent) handing you the contracts and
the app model directly**, so you know exactly what to build and what to go find. Verify against the
files I cite, but don't reverse-engineer from scratch.

**Your goal:** make the plugin (1) correctly wired to how the Board *actually* reads its output,
(2) prompt agents to produce the *best info and the best UI*, and (3) install with zero mystery.

---

## The app in one paragraph (what your plugin feeds)

The Companion Overlay is a Tauri/macOS app — **the Board** — that floats over the terminal without
stealing focus. It drills **L0 Hub → L1 Sessions roster → L2 one session** (each L2 has an embedded
`claude` terminal the Board itself spawned in a PTY). Two things the Board shows depend entirely on
your plugin: **(A) the SESSION ROSTER** — which sessions exist, are they alive, what are they doing —
and **(B) ARTIFACTS** — HTML the agent writes, routed to the right session's card. Everything below is
about getting A and B right.

---

## THE CONTRACTS (the heart of the job)

### 1. Session identity — `unit_key` is now PER-SESSION (keystone; do not revert)

- `plugin/hooks/companion-livepath.sh` derives per session: `live_path`, `project`, `shortid`
  (first 8 chars of the Claude `session_id`), `is_repo`, `unit_key`.
- **`unit_key = <slug>--<shortid>` ALWAYS.** This was *just changed* (it used to be a bare `slug`
  for git repos). The old behavior made two sessions in the **same repo** collapse into one Board
  card sharing one artifact space — the user's #1 complaint ("a 2nd session just adds a terminal to
  the same session"). Now **every session is its own unit → its own card → its own artifacts.** The
  Board is *session-first*.
- `is_repo` is still emitted (for worktree decisions + display) but **no longer collapses sessions.**
- ⚠️ If you touch identity, **keep `unit_key` per-session.** The whole roster + artifact routing now
  assumes it.

### 2. The SessionStart stub + the agent-proof sidecars (what the roster + terminal binding read)

`plugin/hooks/companion-session` (SessionStart) does several things — all consumed by the Board:

- Writes a **stub live file** `~/.claude/companion/live/<slug>--<shortid>.json` =
  `{working, where[], next[], project, is_repo, unit_key}` and injects the path into the agent's
  context (`additionalContext`).
- Writes **agent-proof sidecars** (the agent never writes these, so its turn-by-turn rewrites can't
  corrupt the bindings — the Board re-reads them every poll):
  - `owned-sessions.json` — stem → Board PTY `tabId` (only when `COMPANION_SESSION` is set, i.e. the
    Board spawned this session). Binds the Board's embedded terminal to this live source.
  - `session-dirs.json` — stem → absolute project root. Lets "+ session in this project" know where
    to spawn.
  - `session-ids.json` — stem → **full** `session_id` (Board-owned only). **Drives `claude --resume
    <id>`** so a closed session can be rejoined.
- `companion-session-end` (SessionEnd) removes the live file + prunes the sidecars. SessionEnd is
  **not guaranteed** (crash / `kill -9`); the app has its own backstops.

### 3. LIVENESS — stop making the agent rewrite live.json every turn (the big change)

- **History:** the agent rewrote the live JSON every turn (`working/where/next`), and the Board used
  the *file mtime* to decide "alive." That per-turn rewrite was a **token-waste nudge** (a Stop
  hook). It was removed in commit `9f5c4e3` — which silently broke the roster's liveness, because the
  roster still depended on a fresh mtime. The user explicitly wants this token cost gone.
- **The new model (being implemented app-side):** the Board derives liveness from **(a) the PTY it
  owns** (alive/dead — certain, zero tokens) and **(b) the transcript mtime** of
  `~/.claude/projects/<encoded-cwd>/<session_id>.jsonl` — which Claude Code writes **every turn,
  automatically**, so it's a **free "last active" heartbeat**, cheaper than any ping.
- **Your plugin job:** keep the SessionStart **stub** (it supplies identity: `project/is_repo/
  unit_key`). But **the `additionalContext` must stop telling the agent to "rewrite your live state …
  on each work turn"** — that's the dead token cost. If a card still wants live "working" text, it
  should come from the latest **artifact**, not a per-turn JSON write. Reconcile that injected text
  with the app's no-nudge model (coordinate the exact wording — don't just delete it blindly; confirm
  what the roster will show).

### 4. Artifact routing — how an HTML file lands on the right card

- `plugin/hooks/companion-hook` (PostToolUse `Write|Edit`) fires when a file is written into
  `$COMPANION_ARTIFACTS_DIR` (default `~/.claude/companion/artifacts`).
- It calls `plugin/hooks/companion-index.cjs` with the `session_id`. That script finds the **writing
  session's** live file by `shortid`, reads its `unit_key`, and **freezes** `{unit_key, shortid,
  source}` into `~/.claude/companion/artifact-index.json`, keyed by the artifact's **absolute path**.
- The Board reads that index → stamps `unit_key` on each artifact → groups it under the writing
  session's card. Falls back to the artifact's `companion-meta.project` basename when unindexed.
- **Because `unit_key` is now per-session, each session's artifacts route to ITS card.** (Section 1
  is load-bearing for this.)

---

## How to build the PROPER UI for the app (the prefer-html contract)

The single source of truth is **`plugin/skills/prefer-html/SKILL.md`** — the agent loads it before
writing any artifact. Your prompting must drive agents to produce *exactly* this shape. Key points:

- **Self-sizing is mandatory.** The Board iframes artifacts in a sandboxed, opaque-origin iframe and
  **cannot measure them.** Every artifact must mark its main wrapper `data-fit-root` and include the
  **size-reporter** snippet (it posts `{kind:"size", w, h}` to the parent). Without it the panel
  won't fit.
- **Interactivity markers** (the unified helper wires them):
  - `data-companion-commentable` → hover any block, click 💬 to question that exact line.
  - `data-companion-item` + `data-action="approve|comment|reject"` → ✓/✎/✗ review rows.
  - exactly one `data-companion-submit` → one Submit. The helper posts
    `{source:"companion-artifact", kind:"submit", text}` to the Board, which routes it **into the
    owning session's terminal** (or clipboard fallback).
- **The combined shape** (the default for steering turns): informative commentable content pages +
  a final **"Next steps" decision form** that pushes the work forward. (Bespoke UI for
  presentation-first content.)
- **`companion-meta`** block (subject/summary/files/project/branch/created) makes pasted feedback
  self-identifying across sessions.
- **Reserved home slugs:** `home.html` (cross-project L0 hub) and `home.<unit_key>.html` (per-session
  L2 digest) are loaded **full-bleed**. A `companion-bar` JSON block themes the Board's top bar; the
  `navigate` postMessage protocol (`{kind:"navigate", to:"unit:…|sessions|hub|artifact:…"}`) drives
  the Board from inside an artifact.
- **Bundled assets** (variable fonts, D3, GSAP) live in `~/.claude/companion/vendor/` and load via the
  `asset:` protocol — external URLs are blocked in the sandbox.

> ⚠️ Version skew bites here too: an artifact's interactivity is **baked in at write time** from
> whatever skill the writing session loaded. We already saw an old artifact (`shikari-editor-…`) with
> a Submit button but **no `__cmpShowSubmitted` splash code** — it was generated without the current
> helper. Keeping the installed plugin current (below) is what keeps generated UI correct.

---

## The install model (make it crystal clear — a real task)

- The plugin's marketplace **source is a local directory = this repo**
  (`.claude-plugin/marketplace.json` → `./plugin`). Installing **copies** `plugin/**` into
  `~/.claude/plugins/cache/claude-code-companion/companion/<version>/`. **The hooks that RUN come
  from that cache** (via `$CLAUDE_PLUGIN_ROOT`), **not** the repo.
- **The gotcha we just fixed:** the cache had drifted — installed metadata said `0.3.4` while the repo
  was `0.3.10`, and the cache had been *partially hand-synced* (some hooks matched the repo, some
  didn't). **This is the reason "I edited a hook but nothing changed"** — running sessions read the
  stale cache. We ran `/plugin update`; the active install is now `0.3.10` and every hook matches the
  repo.
- **Rule going forward:** a hook change only lands after a clean **`/plugin update`** (the user runs
  it — it's interactive). Editing repo `plugin/**` alone does nothing for live sessions. Bump
  `plugin/.claude-plugin/plugin.json` `version` whenever you change hooks so the update is visible.
- **README + `companion doctor`:** the real install path is **app install (the Tauri overlay) AND
  plugin-marketplace registration — both required.** Make that obvious; make `companion doctor` verify
  the whole chain (overlay running? artifacts dir correct? hooks installed + current version?).

---

## Concrete problems to fix (start here)

1. **claude-mem observer pollution — surface, don't decide.** A *third-party* plugin,
   `thedotmack/claude-mem` (**the user's memory system** — the cross-session observations and
   `mem-search` tools), is still installed and active. It spawns **~1,375+ "memory agent" observer
   sessions** under `~/.claude-mem/observer-sessions`, which flooded the Board's new "Recent Sessions"
   band. **App side is already handled** — the overlay's `sessions.rs` now filters `claude-mem` dirs
   out of Recent. The remaining decision is **the user's** and must not be made unilaterally:
   fully uninstalling claude-mem *loses their memory*. Options to put in front of them: (a) fully
   remove claude-mem, (b) configure it to stop the observer subagents but keep memory capture,
   (c) leave it (the Board already hides the noise). Investigate claude-mem's own config for (b);
   **do not silently uninstall it.**
2. **Reconcile the live-JSON prompting** with the no-nudge liveness model (Contract §3): stop asking
   the agent to rewrite live state every turn; keep the identity stub.
3. **Worktree-awareness (cheap, high value):** in `companion-session`, if another session is already
   live in the **same repo** (scan the live dir / `session-dirs.json` for a sibling sharing this
   gitroot), inject one line: *"another agent is active in this repo — you have your own artifact
   space, but use a `git worktree` if you'll edit files."* The agent decides; you just make it aware.
   (This is the *file-clobber* half of session separation — artifacts are already isolated by §1.)
4. **Wiring audit:** walk every hook in `plugin/hooks/hooks.json` (SessionStart, PostToolUse,
   `Stop`/`companion-consider`, SessionEnd) and confirm no field/file/env is written-but-unread or
   read-but-unwritten. Document the full producer→consumer map.
5. **Prompting quality:** the SessionStart `additionalContext` + `prefer-html`/`dashboard` skills
   should make a fresh agent *immediately* produce great info **and** great UI. Audit for clarity,
   currency, accessibility/perf guidance, and self-consistency with what the Board supports.

---

## Boundary / ownership

- **You own:** `plugin/**`, `.claude-plugin/`, `plugin/.claude-plugin/plugin.json`,
  `marketplace.json`, `overlay/scripts/companion` (the CLI), `README.md` / onboarding docs.
- **App side (understand, don't churn):** `overlay/src/**` (`board.ts`, `sessions.rs`,
  `owned-terminals.ts`, `live.rs`, `pty.rs`…), `overlay/src-tauri/**`. The **shared contract** is the
  live-JSON schema + the sidecars + `artifact-index.json`. Propose schema changes; don't unilaterally
  rename fields the Board renders.

## Key files

```
plugin/hooks/hooks.json             # hook registration (SessionStart/PostToolUse/Stop/SessionEnd)
plugin/hooks/companion-session      # SessionStart: stub live file + sidecars + injected context (THE prompt)
plugin/hooks/companion-session-end  # SessionEnd: remove live file + prune sidecars
plugin/hooks/companion-livepath.sh  # identity: live_path + shortid + is_repo + unit_key (per-session now)
plugin/hooks/companion-hook         # PostToolUse: artifact watcher → calls the indexer
plugin/hooks/companion-index.cjs    # stamp artifact-index.json (unit_key from the writing session)
plugin/hooks/companion-consider     # Stop hook: nudges for an ARTIFACT (not live state) on substantive turns
plugin/skills/prefer-html/SKILL.md  # the agent-facing UI contract — STUDY THIS
plugin/skills/dashboard/SKILL.md
plugin/commands/{doctor,example,html,mode,render}.md
plugin/.claude-plugin/plugin.json   # plugin manifest (bump version on hook changes!)
.claude-plugin/marketplace.json     # marketplace: local-directory source = this repo
overlay/scripts/companion           # the `companion` CLI (install/doctor/board) — YOURS
README.md                           # install docs — make them match reality
```

## Deliverables

1. Fixes within plugin turf (wiring, prompting, install, CLI, README).
2. The **claude-mem decision surfaced to the user** — never acted on unilaterally.
3. Prompting reconciled with the **no-nudge liveness** model + **worktree-awareness** added.
4. A crystal-clear install path verified by `companion doctor`.
5. Report findings back as a **Companion artifact** (prefer-html), so the user reviews it on the Board.
