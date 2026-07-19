# Collapsible "pill" overlay — handoff brief

> For an agent picking up the **presentation-layer redesign** of the Shelly overlay,
> in parallel with ongoing hub work. Sibling of `LIVE_UI_BRIEF.md` (read that for the
> visual language). Repo: `~/shelly`, overlay app under `overlay/`.

## The problem (why this exists)

Today every artifact pops as a **full floating panel** that sits over the terminal until
you close it. The friction the user named: an artifact appears → you read it → you copy/
paste your response → you close it → the next one reopens a big window → repeat. It's
always *in the way*, and closing-then-reopening is uncomfortable. The overlay should feel
like a calm, beautiful, **collapsed** presence that you *expand on demand*, not a stack of
windows you keep dismissing.

## The vision

A small, elegant **pill / floating icon** that lives unobtrusively (think macOS
notch / Dynamic Island, or a draggable corner chip). Its states:

1. **Collapsed (default):** a small pill — quiet, beautiful, out of the way. Shows a subtle
   indicator when there's something to look at (a new artifact, a count/stack badge, a soft
   glow). Never steals focus.
2. **Expanded:** click the pill → it animates open into the full artifact (the same rich,
   interactive artifact we render today). Read it, interact (✓/✎/✗ → clipboard), done.
3. **Collapse back (not close):** a collapse affordance returns it to the pill — the
   artifact isn't destroyed, it's *parked*. Multiple artifacts stack behind the pill
   (cycle / pick from the pill, which ties into the existing history HUD).

End state: the shelly is always present but never intrusive — a pill you tap to see the
current thing, that folds away when you're done.

## What you're building on (current architecture)

- **Tauri v2 (Rust) + vanilla TS.** Each artifact today = its own `WebviewWindow` reclassed
  to a **non-activating NSPanel** so it floats without stealing terminal focus.
  - `overlay/src-tauri/src/windows.rs` — `open_artifact_window` (panel per artifact, keyed by
    a path hash), `route_artifact`, the live pane (`open_live_window`) and history HUD
    (`open_history_window`). **This is where window lifecycle lives.**
  - `overlay/src-tauri/src/macos_panel.rs` — the NSPanel reclass + `order_front_without_activating`
    + the focus-theft guarantees. **Do not regress these** — the non-activating behavior is
    historically delicate (see the wiki). The pill must also never activate the app.
  - `overlay/src-tauri/src/layout.rs` — column arrangement of multiple panels, drag-pinning,
    Follow-Ghostty docking. The pill model likely *replaces* the column-of-panels model, so
    this is the biggest area of change.
- **The always-on Live pane is your closest precedent** — a single persistent, beautiful,
  small surface that polls and re-renders in place (`overlay/src/live.ts`,
  `overlay/src-tauri/src/live.rs`, the live section of `overlay/src/styles.css`). The pill is
  spiritually "the Live pane, but it's the entry point that expands into artifacts."
- **Artifact render path** (don't reinvent): `overlay/src/artifact-view.ts` loads an artifact
  into an `<iframe>` via the `asset:` protocol (real origin, inline JS runs) — **note the
  recent fix**: `tauri.conf.json` asset scope must include the artifact dir or it falls back
  to `srcdoc` where CSP blocks inline JS (dead buttons). Artifacts self-report size via
  `postMessage({source:"shelly-artifact", kind:"size"})` and submit via `kind:"submit"`
  (→ `resize.ts`/`submit.ts` → clipboard). Keep this protocol intact.
- **Global shortcuts** already exist (⌘0 toggle all, ⌘8 history, ⌘⌥0 panic-hide) in
  `lib.rs setup()` — add a pill toggle here.

## Constraints

- **Never steal focus.** `ActivationPolicy::Accessory` + non-activating NSPanel +
  `becomesKeyOnlyIfNeeded`. The pill and the expanded artifact must not pull the terminal
  out of focus (except an explicit text-field click inside an artifact, which is allowed).
- **Compositor-friendly motion only** (transform/opacity/clip-path) for expand/collapse;
  honor `prefers-reduced-motion`.
- **Match the paper aesthetic** (ivory `#F4F1EC`, clay `#CC785C`, warm ink, serif accents) —
  see `LIVE_UI_BRIEF.md`. This should look *designed*, like a premium macOS utility.
- macOS-first (the dev box is Intel; arm64 runtime is owed). Single-arch local builds are fine.

## Suggested feature tree (phased)

- **P0 — Decide the anchor + shape.** Notch-adjacent (Dynamic-Island style) vs draggable
  corner chip vs docked edge. Prototype the collapsed pill as a tiny always-on NSPanel
  (reuse the live-pane window plumbing). No artifacts yet — just the beautiful pill that
  toggles via a shortcut + click.
- **P1 — Expand/collapse one artifact.** Pill → click → animate into a full artifact panel
  rendering via the existing `artifact-view.ts` path → a collapse control returns it to the
  pill (park, don't destroy). This is the core loop.
- **P2 — Arrival behavior.** A new artifact (incl. hub-pulled ones) updates the pill
  (badge/glow/peek) instead of auto-popping a full window. Respect a "peek then settle"
  micro-interaction.
- **P3 — Stack / multiplicity.** Several parked artifacts → the pill shows a count and lets
  you cycle/pick (fold the history HUD in here, or a mini-stack).
- **P4 — Polish.** Animation curves, reduced-motion, multi-monitor, the notch treatment,
  empty/idle state.

## How this interacts with the hub work (coordination)

The hub work in flight touches **`hub/`, `overlay/src-tauri/src/hub.rs`, `live.ts`,
`history.rs`, the CLI** — i.e. the *data source*, not the *presentation*. Your work is in
`windows.rs`, `macos_panel.rs`, `layout.rs`, and the frontend presentation. Overlap is small
but real on `windows.rs`/`lib.rs setup()`. Recommendation: **branch off `master`** (or current
`feat/shelly-hub` once it merges) as `feat/pill-overlay`, keep changes to the presentation
layer, and we rebase. Flag any `windows.rs` signature changes early.

Hub artifacts arrive through the **same `route_artifact` path**, so once the pill owns
presentation, hub-pulled artifacts get the pill treatment for free.

## Verify with the dev bridge

`npm run tauri dev` builds with the MCP bridge on **127.0.0.1:9339** (debug only). Use the
tauri-mcp-server `driver_session` (port 9339) → `webview_execute_js` / `manage_window` /
`webview_screenshot` to drive and screenshot the UI headlessly. (Caveat: it does **not**
await promises returned from `webview_execute_js` — stash async results on `window.__x` and
read them in a second call. The artifact iframe is cross-origin/sandboxed, so you can inspect
the panel window but not reach inside the artifact's iframe.)

## Definition of done (P0–P1, the demoable core)

A beautiful collapsed pill is always present (no focus theft), a new artifact makes it peek
rather than popping a full window, clicking expands it into the full interactive artifact,
and a collapse control folds it back to the pill without destroying it. Looks like a premium
macOS utility, matches the paper language.
