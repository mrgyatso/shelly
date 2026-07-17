# Identity-registry hook tests

Integration tests for the register-once identity machinery (`companion-session`,
`companion-index.cjs`, `companion-identity.cjs`). They run the **real shell + node hook
path** under a sandboxed throwaway `HOME`, so they touch no live `~/.claude/companion`
state. This is the deterministic slice of the §8 regression matrix the live
merge-and-test session leans on (see `DECISIONS-identity-registry.md`).

Run all:

```sh
node plugin/hooks/__tests__/run.cjs
```

- `registry-phase1.cjs` — dual-write registry: record written once, idempotent on resume,
  two-in-one-repo no fork, owned_tab, empty-id skip, parity with the old sidecars (30 checks).
- `registry-phase2.cjs` — index entry carries `session_id` and the writing turn's
  `prompt_id` (null when the client sends none); artifact → session_id → record → unit_key
  round-trips with parity; no-SID write stays un-indexed (13 checks).
- `artifact-fork.cjs` — the PreToolUse fork hook: a rewrite of an artifact sealed in an
  EARLIER turn redirects to the next free slug, while a same-turn overwrite (still
  authoring) is allowed. Covers both turn-detection rungs (`prompt_id` identity, then
  mtime-vs-turnStart), the `home.html`/`home.<unit>.html` exemption, the non-artifact
  passthroughs, the fork-target walk (suffix reuse within a turn; a year-like suffix is not
  a fork counter), Edit (denied when it can't be redirected), every fail-open path, and the
  emitted JSON contract — including that `updatedInput` is paired with
  `permissionDecision:"allow"`, without which the client silently drops it (42 checks).
- `registry-phase3.cjs` — a successful index stamp appends an `artifact.routed` event with
  path + session_id + the registry unit; no-SID write appends none (6 checks).
- `home-adoption.cjs` — the Home shelf + graduation: a `$HOME` session keys to `__home__`
  (not the username) and is latched homeless; a rooted session never is; adoption fires on
  the first write into a git repo that isn't `$HOME` (and not on an artifact / non-repo /
  bare-`$HOME` write); it is ONE-WAY (a second repo can't steal an adopted session); it
  survives resume/compact; and pre-adoption artifacts are re-stamped to the new unit so the
  session's history doesn't split (27 checks).

The Rust side (`registry.rs`, `events.rs`, `live.rs`) has its own committed
`#[cfg(test)]` units — run with `cd overlay/src-tauri && cargo test --lib`.
