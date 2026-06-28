# Decisions log — identity registry redesign

Companion to `PLAN-identity-registry.md`. Records choices made while implementing, so a
later/cold agent doesn't re-litigate them.

## D1 — Shared identity lib: ONE canonical file, inherited via git (§5.4)

**Decision.** The shared identity logic lives in a single canonical file,
`plugin/hooks/companion-identity.cjs`, committed to the repo. Both the main plugin and
the observer plugin (`companion@companion-observer-dev`, worktree
`~/companion-artifact-observer`) carry the SAME file **via git** — the observer branch
rebases/merges onto master at Phase 5 and then `require()`s it by the same relative path
from its own `CLAUDE_PLUGIN_ROOT`. No build-time symlink, no second copy, no publish step.

**Why this over the alternatives.**
- A runtime symlink across plugin roots is fragile — each plugin resolves `require()`
  relative to its own `CLAUDE_PLUGIN_ROOT`, and a symlink can dangle on reinstall.
- Both plugins are branches of the SAME repo, so a normal committed file is already
  shared by construction. "Never fork it again" (the §5 mandate) is enforced by there
  being exactly one file in git history; the observer's job at Phase 5 is to DELETE its
  forked identity logic (its copies of `companion-livepath.sh` derivation, the shortid
  glob, etc.) and call into `companion-identity.cjs` instead.

**Consequence for the observer (Phase 5).** `worker.cjs` attributes a generated artifact
to the OBSERVED session by calling `companion-identity.{resolveUnit,appendEvent}` /
recording `path → session_id` — it must NOT re-derive identity. The observer's own worker
process registers no session (the `.claude-mem` SessionStart bail already prevents it;
the registry write sits below that bail).

## D2 — register() RECORDS, it does not RE-DERIVE

Identity is derived exactly once per session, by `companion-livepath.sh` at SessionStart.
`register()` is handed those values and only persists them keyed by the full `session_id`.
Adding a second derivation inside `register()` would reintroduce the two-derivations-
disagree disease this whole redesign exists to kill.

## D3 — Idempotency keyed on the FULL session_id

`sessions/<session_id>.json` is written once. Resume/compact (same session_id) find the
record and return it UNCHANGED (`created_ms` + frozen identity preserved). The 8-char
shortid is never the key (it can collide — the index-hook glob fork hazard). Tab
(re)binding stays in the `owned-sessions.json` sidecar for Phase 1; the record's
`owned_tab` is best-effort first-seen and is not rewritten on resume.

## D4 — Two logs, distinct purposes

- `events.ndjson` — always-on, source-of-truth event log (`session.registered`,
  later `artifact.routed` / `tab.bound` / `session.ended`). The Board tails it in Phase 3.
- `logs/trace.ndjson` — off-by-default debugging harness (the regression oracle). The
  registry emits `registry/register|resolve|resolve-miss` breadcrumbs here ONLY when the
  trace flag is on. Never conflate the two.

## D5 — Phase 0 baseline scope (build deferred)

Phase 1 writes files nothing reads yet, so it cannot regress routing by construction; its
gate is "old sidecars unchanged for the same inputs + new records correct," verified by
sandboxed (HOME-overridden) direct hook invocation — NOT a full pipeline baseline. The
expensive overlay build + §8 matrix baseline is deferred to the Phase 1→2 boundary (a
fresh build from this worktree @ master is a cleaner reference than the currently-installed
binary of uncertain provenance). Fast checks done now: `cargo check` (pass), `npm install`
(done), `trace-view.mjs` parses.

**Open (needs user sign-off):** the visual §8 cases a headless agent can't run faithfully
(occluded-idle no-freeze; hero vs. ambient sibling routing) bear on the user's
"no regressions" non-negotiable. RESOLVED 2026-06-28: user chose a **manual pass before the
Phase 4 cutover** — phases gate on trace-timeline routing parity (headless), user does the
visual smoke before cutover.

## D6 — No overlay build/install while the other worktree is live (user, 2026-06-28)

The user has a second worktree (the main checkout) actively using the ONE installed
`Companion Overlay.app`. Building/installing from this worktree would swap that app and
cause "which version am I seeing?" confusion. Decision: **never build or install the app
from here.** Write code + verify the ways that don't need a running app (cargo check,
cargo test, tsc, sandboxed hook tests). Do the single live "watch it surface" pass —
including the full §8 matrix + the master before/after baseline — TOGETHER in the main
checkout after merging, when the user is present. One app, one place.

## STATUS LEDGER (for the merge-and-test-together session)

Branch `feat/identity-registry`. Built + STATICALLY verified, NOT yet run in a live overlay:

- **Phase 1 (done, `5563e7c`)** — dual-write registry. `companion-identity.cjs` shared lib;
  `companion-session` writes `sessions/<id>.json` + appends `session.registered`. Verified:
  sandboxed 30/30. Nothing reads it.
- **Phase 2 (done, `efd9745`)** — read registry first, fall back. `registry.rs` resolver;
  `companion-index.cjs` stamps `session_id`; `history.rs`/`live.rs`/`board.ts` prefer the
  record, fall back to the old derivation. Verified: cargo check, cargo test (registry 3/3,
  live 7/7), tsc clean, sandboxed hook 8/8 (artifact→session_id→record→unit_key round-trip).

- **Phase 3 (plumbing done, `ec01b6c`)** — event-log tail. `companion-index.cjs` appends
  `artifact.routed`; `events.rs` `poll_events(from)` tails by byte offset (unit-tested 4/4);
  `board.ts` folds events into `routedByPath`, consulted first by `unitForArtifact` + folded
  into `artifactSig`. STRICTLY ADDITIVE (no event → Phase 2 behavior). The Phase 2 reroute
  machinery is deliberately untouched.

**Deferred to this live session (do NOT assume done):**
- The full §8 pipeline matrix with `COMPANION_TRACE=1` + the master before/after baseline diff.
- **Phase 3 LIVE BEHAVIOR (unverified)** — the payoff "occluded write surfaces with NO
  reroute" is a live-timing property. Confirmed Phase 2 still leaves the interim reroute
  (`9a37849`) firing; the watcher still wakes the poll before the stamp+event land, so a
  first ingest can still fall back + reroute. Making the EVENT the trigger (and deleting the
  watcher-first-ingest / the `9a37849` reroute) is the Phase 4 cutover. Verify no-reroute then.
- **Phase 4** — cutover (delete slug-fallback, staleness guard, 4 sidecars, shortid glob,
  the `9a37849` reroute) + fail-loud error tile.
- **Phase 5** — observer: point its plugin at the shared lib (D1), attribute artifacts to
  the OBSERVED session_id.
