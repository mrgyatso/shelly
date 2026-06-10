# The Board — multi-agent steering canvas (architecture + handoff)

> Plan-first design + handoff for a dedicated agent. Supersedes and **absorbs**
> `overlay/COLLAPSIBLE-UI-BRIEF.md` (the pill is now the collapsed state of this board).
> Repo: `~/claude-code-companion`, overlay app under `overlay/`. Branch off `master`.

## Vision (locked with Zach, 2026-06-09)

Companion is a **steering tool for multi-agent work**: you run ~5 agents and often answer
~4; each agent puts an interactive artifact on your screen and you **steer each** by
reacting to its specific sentences (💬) and items (✓/✎/✗). The Board is the surface that
makes that real.

**Decisions (from Zach's review of the architecture plan):**
1. **The Board is a NEW window, and *all* artifacts live in it.** No more floating
   one-off panels — every artifact (single or multi-agent, local or hub-pulled) is a tile
   in the Board. The current per-artifact `NSPanel` column is replaced by this.
2. **Grid layout, polished, iOS-feel.** Not a plain vertical column — a responsive grid of
   tiles with **seamless, iOS-smooth transitions** and a **very good organization +
   navigation system**: you can reach **any artifact from the keyboard**, fast.
3. **The pill is the collapsed Board.** Collapsed = a small beautiful pill; expand = the
   Board. (The old pill brief's vision folds in here.)
4. **Board ≠ Workspace for v1.** Share the source-routing seed; converge later (a tile/lane
   could embed a terminal — the Workspace — down the road). Keep separate for now.
5. **Response routing is phased** (see below): v1 clipboard-tagged; later auto-routes.

## What the Board is

One always-present surface (collapsed to a **pill**, expandable to the full **Board**) that
holds **every** artifact as a tile, organized by **source** (the agent/session that produced
it), navigable like a polished iOS home screen:

```
┌──────────────────────────── The Board (expanded) ───────────────────────────┐
│  ▲ hermes            ▲ claude-session-2        ▲ cron / other                │
│  ┌────────┐ ┌──────┐  ┌────────┐ ┌────────┐     ┌────────┐                    │
│  │ tile   │ │ tile │  │ tile   │ │ tile   │     │ tile   │   ← each tile =    │
│  │ (live  │ │      │  │        │ │        │     │        │     one artifact   │
│  │ iframe)│ │      │  │        │ │        │     │        │     (sandboxed)    │
│  └────────┘ └──────┘  └────────┘ └────────┘     └────────┘                    │
│   grouped by source · grid · keyboard-navigable · iOS transitions             │
└────────────────────────────────────────────────────────────────────────────────┘
        collapse ▼                                   ▲ expand (click / shortcut)
                          ●  pill (collapsed)
```

- **Tile** = one artifact, rendered live in a sandboxed iframe (via the existing
  `artifact-view.ts` path → `asset:` protocol → its JS runs → buttons work).
- **Group/lane** = a source (agent/session). Tiles are organized by who produced them, so
  steering ~5 agents means scanning ~5 groups.
- **Focus** = expand one tile to full interactive size; the rest recede (iOS-style).
- **Navigation** = keyboard-first: arrow/Tab to move between tiles + groups, Enter to focus,
  Esc to back out, a quick-switcher (⌘K-style) to jump to any artifact by name/source.

## Architecture

- **Window model.** A single new **non-activating Board panel** (reuse `macos_panel.rs`'s
  Accessory + `becomesKeyOnlyIfNeeded` + key-panel-subclass trio) so it floats without
  stealing terminal focus, yet can take key focus when you click into a tile's textarea.
  Tiles are **internal DOM regions** (iframes), not OS windows. This replaces the
  one-window-per-artifact model in `windows.rs`/`layout.rs`.
- **Tile/source model.** Each artifact is tagged with a **source id** and routed to that
  source's group. Generalize `route_artifact(path, session)` (the Workspace seed) from
  *session→tab* to *source→Board-group*. Sources: a local hook's `$COMPANION_SESSION`, or a
  hub artifact's `project`/source field. Keep a small per-source history (the history HUD
  already enumerates artifacts — fold it in).
- **Render path (reuse, don't reinvent).** Each tile iframe loads via
  `artifact-view.ts::loadArtifactInto` → `asset:` protocol. **The asset-scope fix matters:**
  tiles must load via `asset://` (real origin) so their inline JS runs; never `srcdoc`
  (CSP blocks JS → dead buttons). All artifacts already live under
  `~/.claude/companion/{artifacts,remote}` which is in the asset scope.
- **Layout / grid.** Responsive grid of tiles, grouped by source. Compositor-friendly
  transitions only (`transform`/`opacity`) for the iOS feel; honor `prefers-reduced-motion`.
- **Navigation.** Keyboard model: move focus across tiles/groups, Enter to expand a tile,
  Esc to collapse, a fuzzy quick-switcher to jump to any artifact. This is the "very good
  organization + navigation" bar — treat it as a headline feature, not an afterthought.
- **Pill.** Collapsed Board = a small paper/clay pill (see the absorbed pill brief's design
  language + `overlay/LIVE_UI_BRIEF.md`). It peeks/badges when a tile updates; expand → Board.
- **Provenance.** Every tile/group shows which agent/person it came from (a load-bearing
  trust signal for the eventual collaboration network).

### Response routing (per tile) — phased
Each tile's `✓/✎/✗` Submit must return to **that tile's source agent**.
- **v1 — clipboard-tagged:** compile the response tagged with the source; copy to the system
  clipboard; user pastes into that agent. (Reuse today's submit→clipboard path; add the tag.)
- **Later — auto-route by source:** *remote* agents (e.g. Hermes) get the response via the
  **hub return path** (a return endpoint the agent reads); *local* PTY agents (a terminal
  Claude, the Workspace) get a **terminal-write** (bracketed-paste → PTY, from the
  `feat/direct-agent-feedback` spike on `wip/workspace-tabbed-terminal`).

## The hard parts (where the risk is)
- **Focus vs non-activating** — the Board needs key focus for typing into a tile, but must
  never steal terminal focus. Historically the most delicate area; reuse the panels' proven
  trio, do not reinvent.
- **N live iframes** — performance/memory with many simultaneous tiles. Lazy-mount tiles
  outside the viewport; the history HUD already renders scaled `srcdoc` thumbnails for
  off-screen artifacts — use that for un-focused tiles, promote to a live `asset:` iframe on
  focus.
- **Render discipline** — every *focused/live* tile loads via `asset:` (JS runs). The
  `srcdoc`/CSP dead-button trap must not reappear for interactive tiles.
- **iOS-quality polish** — the transitions/keyboard-nav are the headline; budget real time
  for feel. Test breakpoints (multi-monitor, the Board on a secondary screen — note the
  existing `layout.rs` only knew the primary monitor; the Board must be monitor-aware).
- **Don't regress the overlay mid-migration** — build the Board as a new surface first;
  flip artifacts over to it once it's solid; keep the daemon usable throughout.

## Feature tree

- **P0 — Board shell.** New non-activating Board panel that statically hosts a few tiles,
  each an iframe rendering an artifact via `artifact-view.ts`. Prove: multi-iframe grid,
  per-tile interactivity (buttons work), no terminal-focus theft, `asset:` JS runs. (Isolated;
  doesn't touch the existing panel path yet.)
- **P1 — Source-routed tiles.** Generalize `route_artifact` so an incoming artifact (local
  hook or hub pull) lands in its source's group; provenance label; small per-source history.
- **P2 — Navigation + iOS polish.** Keyboard navigation (move/focus/back + fuzzy
  quick-switcher), focus-to-expand with seamless transitions, the organization system.
- **P2.5 — Arrival reveal (Board provides the transition; the *content* is the agent's).**
  When you open the Board after being away, new tiles **fade/stagger in** — the Board tracks
  which artifacts are *new since last seen* and reveals them smoothly. **Important division of
  labor (Zach's call):** the Board only provides the generic reveal/transition surface — the
  actual **"good morning" dashboard is each agent's own HTML artifact.** Hermes (and every
  other agent) crafts a *unique animated good-morning* for its user (see `hub/PUBLISHING.md`),
  which simply shows up as one of the revealed tiles. Do NOT build a hardcoded good-morning
  scene into the Board — keep the Board a generic, beautiful host; the bespoke welcome is
  per-agent content. (Compositor-friendly transforms/opacity; reduced-motion aware.)
- **P3 — Make it the only surface.** Route *all* artifacts into the Board; retire the
  floating one-off panels; the pill becomes the collapsed Board; peek-on-update.
- **P4 — Per-tile response routing.** Clipboard-tagged-by-source first; then the auto-route
  (hub return path / terminal-write).
- **P5 (later) — Composition protocol.** A tile hosts multiple agent-composed regions
  (artifact + media + form); the artifact `postMessage` protocol extends to a region/layout
  protocol — the real "compositor."

## Critical files / reuse
- New: a `board` window in `windows.rs` (model it on `open_live_window`/`open_history_window`),
  a frontend `overlay/src/board.ts` (the grid/nav/tiles), board styles.
- Reuse: `artifact-view.ts` (`loadArtifactInto` per tile); `route_artifact` (generalize
  session→source); `macos_panel.rs` (non-activating panel); `history.rs` (enumerate artifacts
  + `srcdoc` thumbnails for off-screen tiles); `layout.rs` (monitor-awareness, but the Board
  does internal layout); the hub pull (remote tiles); `live.ts`/`LIVE_UI_BRIEF.md` (paper
  aesthetic); the Workspace per-session routing on `wip/workspace-tabbed-terminal` (the seed).
- The **asset-scope fix** in `tauri.conf.json` (`$HOME/.claude/companion/**`) is load-bearing
  — tiles must load via `asset:`.

## Coordination
This is the **presentation layer**; the in-flight hub work is the **data layer**
(`hub/`, `overlay/src-tauri/src/hub.rs`, the CLI). Low overlap, but both touch `windows.rs`
and `lib.rs setup()`. **Branch `feat/canvas` off `master`**, keep changes to the Board
surface, flag any `windows.rs`/`route_artifact` signature changes early, and rebase on
`master` as the hub work lands. Hub-pulled artifacts arrive through the same `route_artifact`
path, so they become Board tiles for free.

## Verify with the dev bridge
`npm run tauri dev` builds with the MCP bridge on **127.0.0.1:9339** (debug only). Use the
tauri-mcp-server `driver_session` (port 9339) → `webview_execute_js` / `manage_window` /
`webview_screenshot` to drive + screenshot. Caveats learned: the bridge does **not** await
promises from `webview_execute_js` (stash async results on `window.__x`, read them in a second
call); the tile iframes are cross-origin/sandboxed so you can inspect the Board window but not
reach inside a tile's iframe; kill the installed daemon (`pkill -x companion-overlay`) before
`npm run tauri dev` (single-instance forwards otherwise).

## Definition of done (P0–P2, the demoable core)
A beautiful Board (collapsible to a pill) holds several live, interactive artifact tiles
grouped by source; you keyboard-navigate to any tile, expand it with a seamless transition,
steer it (✓/✎/✗ work), and collapse back — no terminal-focus theft, iOS-smooth, on a
secondary monitor too.
