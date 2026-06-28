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
"no regressions" non-negotiable. How/when are they verified — a manual pass before the
Phase 4 cutover?
