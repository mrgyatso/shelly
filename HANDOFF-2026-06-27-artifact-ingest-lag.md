# HANDOFF — Board artifact ingest lag (~2 min before a new artifact pops)

**Date:** 2026-06-27
**Branch:** `feat/cron-artifact-pipeline`
**Author:** prior session (Opus) — `claude-code-companion--11c8d718`
**Status:** path/doctor drift FIXED in this session; the **ingest-lag bug is OPEN and is your job.**

---

## TL;DR for the next agent

The user reports: an artifact is written to the correct dir, but **nothing appears on the
Board for ~2 minutes**, then it pops into the right session. Observed twice today:

- `~/.claude/companion/artifacts/demo-lineup.html` (12:30) — didn't surface; `file-confirmed.html`
  (12:32, ~2 min later) did.
- `~/.claude/companion/artifacts/justtcg-api-key.html` (different project, unit `gyatso`) — nothing
  for ~2 min, then popped into the right session.

**This is NOT a path bug and NOT a cold-start bug** (both ruled out — see below). It is a lag in
the Board's **live ingest / auto-advance pipeline**. Find why a freshly-written artifact takes ~2
min to surface when the poll loop runs every **1.2 s**, and fix it so it surfaces within a poll or
two.

---

## What was already FIXED this session (do NOT redo)

The user approved and I applied these — the artifacts dir drift that misled diagnosis:

| Fix | File | Change |
|-----|------|--------|
| Doctor default (canonical) | `overlay/scripts/companion-doctor:12` | `codeviz/public/artifacts` → `.claude/companion/artifacts` |
| Doctor default (installed, ships live) | `/Applications/Companion Overlay.app/Contents/Resources/scripts/companion-doctor:12` | same — verified `companion doctor` now reports the right dir |
| README contradiction | `README.md:143` | now points to `.claude/companion/artifacts`, codeviz marked legacy fallback |
| "doctor is source of truth" wording | `~/.claude/rules/common/html-output.md:~109` + `plugin/skills/prefer-html/SKILL.md:3` | softened — names the canonical default, demotes doctor to a convenience echo |

**Root cause of the drift (for context):** `companion-doctor` defaulted to the legacy
`codeviz/public/artifacts` while `companion-hook` (the thing that actually pops the overlay)
defaulted to `.claude/companion/artifacts`. The docs told the agent to "trust companion doctor as
the source of truth" — so the diagnostic that had drifted was the one being trusted. Prior
observations **7582, 7583, 7598** (Jun 24) already flagged this mismatch. Full analysis artifact:
`~/.claude/companion/artifacts/artifact-path-audit.html`.

### Loose-end cleanup (small, optional)
Two **build-output** copies of `companion-doctor` still carry the old codeviz default but
regenerate from the now-fixed source on rebuild — fix if you do a formal build, else ignore:
- `overlay/src-tauri/target/release/scripts/companion-doctor:12`
- `overlay/src-tauri/target/release/bundle/macos/Companion Overlay.app/Contents/Resources/scripts/companion-doctor:12`

(The `x86_64`/`aarch64` target copies were already correct.) A formal rebuild is
`cd overlay && npm run tauri build`; **not required** for the doctor fix — it already shipped via
the live script edit. Only rebuild if you change Rust/TS (which the ingest-lag fix will).

---

## The OPEN bug — diagnosis so far

### Ruled out
- **Wrong save path** — the index shows both `demo-lineup.html` and `file-confirmed.html` written to
  `.claude/companion/artifacts` and correctly keyed to this session's unit. Writes were never wrong.
- **Cold start** — the overlay process (`/Applications/Companion Overlay.app/.../companion-overlay`,
  PID 722) has run since 12:09 PM, well before any write. Confirm anytime with
  `ps aux | grep -i "Companion Overlay"`.
- **Poll interval too slow** — it isn't. `POLL_MS = 1200` (`overlay/src/board.ts:138`). The poll
  re-reads `list_artifacts()` every 1.2 s.

### The ingest pipeline (exact pointers — all in `overlay/src/board.ts` unless noted)
1. `pollLive()` @ **2706** — runs every 1.2 s. Reads `read_all_live` (live JSON per session) then
   `list_artifacts` (Rust).
2. Live→unit binding @ **2725–2753** — correlates each Board-owned terminal's `companion_session`
   (a tabId) to a `unit_key`, via `reconcileBindings(sessionToUnit)`. **A brand-new session's
   binding only resolves once its live JSON has been read and correlated here.**
3. Artifact sig guard @ **2783–2787** — `artifactSig()` (@ **2801**) = `path:modified_ms` joined.
   If unchanged, `ingestArtifacts` is skipped. A new file changes the sig, so this should fire
   within one poll.
4. `ingestArtifacts(artifacts)` @ **2829** — `newOnes = artifacts.filter(a => !knownPaths.has(a.path))`.
   `knownPaths` seeded at init (@ **217**) so pre-existing files aren't "new".
5. **Auto-advance gating** @ **207** — `awaitingAdvanceSource`: *"Only THIS session's artifacts
   auto-advance; another session's new work just raises the ambient 'N agents need you' awareness
   (unread)."* See also `unreadByUnit` @ **220**, `heroPendingPath` @ **235**, and `ingestIntoUnit`.
6. Rust side: `list_artifacts` → `overlay/src-tauri/src/history.rs` `artifact_dirs()` @ **65**
   (probes `$COMPANION_ARTIFACTS_DIR`, then `.claude/companion/artifacts`, `/remote`, `codeviz`).
   Routing index written by the hook: `overlay/scripts/companion-index.cjs` →
   `~/.claude/companion/artifact-index.json` (keys each artifact path → `unit_key` + `source`,
   resolved from the writing session's **live file** at write time).

### Ranked hypotheses (start at #1)
1. **Auto-advance requires a session→unit binding that lags ~2 min.** A new artifact whose writing
   session isn't yet bound (step 2) can't auto-advance (step 5) — it only accrues as **unread** on a
   unit card. It "pops into the right session" only once the binding resolves, which likely happens
   when the session next rewrites its live JSON (agents rewrite live ~once per turn; turns can be
   minutes apart → the ~2 min). **This best fits "popped into the right session after 2 min."**
   *Check:* in `pollLive`, log when the artifact first appears in `list_artifacts` vs when its
   `unit_key`/source becomes a known binding. If the artifact is present for ~2 min before the
   binding resolves, this is it. Fix: route by the artifact's **own** `unit_key`/`source` from the
   index (already on `ArtifactEntry` — see `history.rs` fields `unit_key`/`source`) instead of
   waiting on the live-derived binding; the index is stamped at write time, so it's immediately
   authoritative.
2. **`list_artifacts` returns stale data for ~2 min** (Rust-side caching, or `artifact_dirs()` mtime
   resolution). Less likely (sig is `path:mtime`), but instrument `list_artifacts` to confirm the new
   path shows up immediately.
3. **Sig/knownPaths race at init** — if a file lands in `list_artifacts` during init it's seeded into
   `knownPaths` and never treated as "new". Edge case; unlikely for brand-new files written after init.

---

## Concrete next steps
1. **Reproduce with instrumentation.** Add `console.log` markers in `pollLive` around the
   `list_artifacts` result and `ingestArtifacts` (and in `reconcileBindings`) that print the new
   artifact path, its `unit_key`/`source`, and whether a binding exists. Then write a throwaway
   artifact and read the overlay console with the Chrome/devtools path or the
   `read_console_messages` MCP tool. Measure the gap between "path present in list_artifacts" and
   "surfaced/auto-advanced."
2. **Confirm hypothesis #1.** If the artifact sits present-but-unbound, switch ingest/auto-advance to
   trust the index's `unit_key`/`source` on `ArtifactEntry` directly (it's already plumbed through
   `history.rs`) rather than waiting on the live-session binding.
3. **Fix + verify latency < ~3 s.** A fresh write should surface within 1–2 polls. Verify in BOTH
   cases: (a) artifact for the **currently-viewed** unit (should hero/auto-advance), (b) artifact for
   **another** unit (should badge as unread promptly, not after 2 min).
4. **Rebuild** (`cd overlay && npm run tauri build`) since this touches TS/Rust, then re-verify on the
   installed app. Also fix the two build-output doctor copies noted above (they regenerate on build).
5. **Watch for regressions** in the recent board fixes (see `git log` — `pollLive`/hero/notification
   work landed in commits `357dc76`, `afe997f`, `bd67fa4`, `73285db`, `91d8069`). The blank-hero
   re-light (`maybeLightBlankHero` @ ~2771/2797) and unread routing are adjacent — don't break them.

## Verification checklist
- [ ] New artifact for the active unit surfaces within ~3 s (not ~2 min).
- [ ] New artifact for an inactive unit badges as unread within ~3 s.
- [ ] `companion doctor` reports `~/.claude/companion/artifacts` (already true post-fix).
- [ ] No regression in hero re-light / unread-clear / session-resume (commits above).
- [ ] Rebuild + retest on the installed `/Applications` app.

## Key files
- `overlay/src/board.ts` — poll + ingest + auto-advance (lines cited above)
- `overlay/src-tauri/src/history.rs` — `list_artifacts` / `artifact_dirs` (+ `ArtifactEntry.unit_key`/`source`)
- `overlay/scripts/companion-index.cjs` — routing index stamper (write-time `unit_key`)
- `overlay/scripts/companion-hook` — PostToolUse hook (pops overlay, stamps index)
- `~/.claude/companion/artifact-index.json` — path → unit_key/source map (live data to inspect)
- Analysis artifact: `~/.claude/companion/artifacts/artifact-path-audit.html`
