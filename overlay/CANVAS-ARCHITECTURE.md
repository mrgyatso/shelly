# The Board — multi-agent steering canvas (architecture + handoff)

> Plan-first design + handoff for a dedicated agent. Supersedes and **absorbs**
> `overlay/COLLAPSIBLE-UI-BRIEF.md` (the pill is now the collapsed state of this board).
> Repo: `~/claude-code-companion`, overlay app under `overlay/`. Branch off `master`.

## Vision (locked with Zach, 2026-06-09)

Companion is a **steering tool for multi-agent work**: you run ~5 agents and often answer
~4; each agent puts an interactive artifact on your screen and you **steer each** by
reacting to its specific sentences (💬) and items (✓/✎/✗). The Board is the surface that
makes that real.

**Decisions (locked with Zach; the convergence + form-split decisions below supersede the
earlier "Board ≠ Workspace" / "Option A only" framing):**

1. **CONVERGENCE — a Board pane *is* a Workspace terminal session.** Each connected agent's
   pane is **that agent's embedded REAL terminal/PTY** (the Workspace) with **that session's
   artifacts grouped under it**. This **supersedes** the old "Board ≠ Workspace for v1"
   decision and the old "embedding the terminal is Option B, saved for later — do not build
   it now." Embedding the terminal **is the direction now.** The parked Workspace WIP
   (`wip/workspace-tabbed-terminal`: PTYs via `portable-pty`, xterm.js, bracketed-paste
   write-into-terminal) is the **seed we build on**, not a someday exploration.

2. **FORM SPLIT — pill = ambient overlay, Board = focal app window.** This is the key
   architectural change. The **collapsed pill** stays an ambient, **non-activating `NSPanel`
   overlay** (the wedge: an artifact or notification appears over whatever you're doing with
   **zero focus theft**). The **expanded Board** becomes a **normal, focusable app window** —
   a destination you go to. **Do NOT build the full-screen Board as a non-activating panel.**
   A focal surface is *allowed* to take focus, so building it as a real app window sheds most
   of the `NSPanel`/FFI fragility (the focus-trio, `becomesKeyOnlyIfNeeded`, key-window
   subclassing) the project has fought. The rationale, in one line: **the fragility was never
   about being an overlay — it was about making the big focal surface pretend to be a ghost.**
   So: pill = overlay (ambient), Board = app window (focal). The just-shipped macOS menu work
   (⌘V Edit menu) is **step one** of the Board being a proper app — keep building it out.

3. **TRIAGE IS THE HEADLINE — "which agent needs me," not a render-wall.** The organizing
   principle is *triage*, not five equal live dashboards lit up at once. **One main artifact
   in focus + fast keyboard navigation** to the other sessions and their artifacts. The
   per-pane live state's `next: [{kind: blocked|decision|todo}]` is **the triage signal** and
   is the *point of the surface* — you scan it to decide who to attend to next, then jump.
   The old "5 live tiles at once" framing is demoted; navigation/triage is central, not a
   later polish pass.

4. **STEERING LOOP — bracketed-paste closes it only for live PTYs; async-remote still needs
   the hub return path.** Writing into a session's PTY (bracketed-paste) closes the loop for
   **live LOCAL or SSH'd terminals**. The **async-remote case** — a finished cron run or
   morning brief that has **no live PTY** — still needs the **hub return path**: a return
   endpoint or file that the agent's *next* run reads. This is a **separate, required piece**;
   the Workspace/PTY path does **not** cover it. (See Response routing.)

5. **The pill is the collapsed Board.** Collapsed = the small beautiful ambient pill; expand =
   the focal Board window. (The old pill brief's design language folds in here.)

6. **Response routing is phased** (see below): v1 clipboard-tagged-by-source; later auto-routes
   (live PTY → terminal-write; async-remote → hub return path).

## What the Board is

Two forms of one surface. **Collapsed**, it's an ambient **pill** (non-activating overlay)
that peeks/badges when an agent needs you. **Expanded**, it's a focal **app window** organized
around a single question — **which agent needs me right now** — with one session in focus and
everything else a keystroke away:

```
┌──────────────────────── The Board (expanded — a focal app window) ──────────┐
│ ┌─ sessions ────────┐  ┌──────────── focus: claude-session-2 ─────────────┐ │
│ │ ● hermes   ⬤decide │  │  ┌─────────────────────────────────────────────┐ │ │
│ │ ▸ claude-2 ⬤block  │  │  │  embedded REAL terminal (PTY / xterm.js)    │ │ │
│ │   cron     ·todo   │  │  │  …live scrolling session…                   │ │ │
│ │   ssh-box  ·idle   │  │  └─────────────────────────────────────────────┘ │ │
│ │                    │  │  ┌──────────┐ ┌──────────┐  ← this session's     │ │
│ │  ↑ triage rail:    │  │  │ artifact │ │ artifact │    artifacts, grouped │ │
│ │  next.kind sorts   │  │  │  (asset: │ │          │    under its terminal │ │
│ │  who needs me      │  │  │  iframe) │ │          │                       │ │
│ └────────────────────┘  │  └──────────┘ └──────────┘                       │ │
│   ⌘K quick-switch · ↑↓ jump sessions · → into artifacts · Enter focus       │ │
└──────────────────────────────────────────────────────────────────────────────┘
        collapse ▼                                   ▲ expand (click / shortcut)
              ●  pill (ambient non-activating overlay — the wedge)
```

- **Session pane** = one connected agent = **its embedded real terminal/PTY** (the Workspace)
  **plus that session's artifacts** grouped under it. Each artifact renders live in a
  sandboxed iframe (via `artifact-view.ts` → `asset:` protocol → its JS runs → buttons work).
- **Triage rail** = the list of sessions, sorted/badged by each one's live-state
  `next.kind` (`blocked` > `decision` > `todo`). This is the **point of the surface**: scan
  the rail, see who needs you, jump there. Steering ~5 agents is *triage*, not staring at
  five live walls.
- **Focus** = exactly one session pane is the focal one (its terminal is live + interactive);
  the others are lightweight rail entries showing only their live-state header. Promote a rail
  entry to focus and its terminal/artifacts come alive.
- **Navigation** = keyboard-first: ↑↓ move between sessions in the rail, → step into a
  session's artifacts, Enter to focus/expand, Esc to back out, a ⌘K quick-switcher to jump to
  any session or artifact by name/source.

## Architecture

- **Two-window model (the form split).** **Two** surfaces, not one panel:
  - **The pill** stays a **non-activating `NSPanel` overlay** — keep `macos_panel.rs`'s
    Accessory + `becomesKeyOnlyIfNeeded` + key-panel-subclass trio *here, and only here.*
    The pill is the wedge: it peeks/badges over whatever you're doing with **zero focus
    theft**. This is the one surface where the FFI fragility is justified, because it must
    stay a ghost.
  - **The Board** is a **normal, focusable app window** — `WindowBuilder` with standard
    activation, allowed to take focus. **Do not** reuse the non-activating trio for it. A
    focal destination *should* take focus when you go to it, which is exactly why building it
    as a real app window sheds the focus-trio fragility the project has fought. The macOS
    menu work (⌘V Edit menu, already shipped) is step one of the Board being a proper app;
    continue down that path (standard window chrome, menu, activation, full-screen).
  - This replaces the one-window-per-artifact model in `windows.rs`/`layout.rs`.
- **Session/PTY model (the convergence).** A pane **is** a session = an embedded real
  terminal/PTY + that session's artifacts. Build on the `wip/workspace-tabbed-terminal` seed
  (`portable-pty` + xterm.js + bracketed-paste). Generalize `route_artifact(path, session)`
  from *session→tab* to *session→Board-pane* so each artifact lands under its session's
  terminal. Session ids come from a local hook's `$COMPANION_SESSION` or a hub artifact's
  `project`/source field. (Async-remote sources with no live PTY still get a pane — just
  with live-state + artifacts and no terminal; see Response routing for their return path.)
- **Render path (reuse, don't reinvent).** Each artifact iframe loads via
  `artifact-view.ts::loadArtifactInto` → `asset:` protocol. **The asset-scope fix matters:**
  artifacts must load via `asset://` (real origin) so their inline JS runs; never `srcdoc`
  (CSP blocks JS → dead buttons). All artifacts already live under
  `~/.claude/companion/{artifacts,remote}` which is in the asset scope.
- **Triage-first layout.** Not a grid of N equal live panes. A **triage rail** of sessions
  (sorted/badged by `next.kind`) + **one focal session** whose terminal + artifacts are live.
  Only the focal session runs a live PTY/xterm; the rest are lightweight live-state headers
  until promoted. Compositor-friendly transitions only (`transform`/`opacity`) for the iOS
  feel; honor `prefers-reduced-motion`.
- **Navigation = the headline.** Keyboard model: ↑↓ across the triage rail, → into a
  session's artifacts, Enter to focus, Esc to back out, a fuzzy ⌘K quick-switcher to jump to
  any session or artifact. This *is* "which agent needs me" — treat triage + navigation as
  the central feature, not a later polish pass.
- **Pill.** Collapsed Board = a small paper/clay pill (see the absorbed pill brief's design
  language + `overlay/LIVE_UI_BRIEF.md`). It peeks/badges when a session needs you (a new
  artifact, or a `next.kind` flips to `blocked`/`decision`); expand → the focal Board window.
- **Provenance.** Every session/artifact shows which agent/person it came from (a load-bearing
  trust signal for the eventual collaboration network).

### Response routing (per session) — phased
Each artifact's `✓/✎/✗` Submit must return to **that session's agent**. The cut is **whether
the session has a live PTY**, not whether it's local vs remote (an SSH'd terminal is remote
*and* has a live PTY):
- **v1 — clipboard-tagged-by-source:** compile the response tagged with the source; copy to
  the system clipboard; user pastes into that agent. (Reuse today's submit→clipboard path;
  add the tag.)
- **Later — auto-route, two distinct paths:**
  - **Live PTY (local OR SSH'd terminal)** → **terminal-write**: bracketed-paste straight into
    that session's PTY (from the `feat/direct-agent-feedback` spike on
    `wip/workspace-tabbed-terminal`). This closes the loop in-place.
  - **Async-remote, NO live PTY (a finished cron / morning brief)** → **hub return path**: a
    return endpoint or file the agent's **next run reads**. This is a **separate required
    piece** — the PTY/terminal-write path cannot reach an agent that isn't currently running,
    so it does **not** cover the async case. Build the hub return path explicitly.

## The hard parts (where the risk is)
- **The form split, done right** — the pill keeps the non-activating trio; the Board sheds it.
  The risk is *not* the old "Board needs key focus but must never steal terminal focus" — that
  tension dissolves the moment the Board is a real app window that's *allowed* to take focus.
  The fragility was never about being an overlay; it was about making the big focal surface
  pretend to be a ghost. So the discipline is: **keep the `NSPanel` trio scoped to the pill,
  and resist the temptation to make the Board non-activating "for consistency."**
- **Convergence × triage = the load-bearing performance call.** A pane being a real embedded
  terminal means N panes would be N live PTYs + xterm instances — *heavier* than the old
  N-live-iframes worry. **Triage is the resolution:** only the **focal** session runs a live
  PTY/xterm + live `asset:` artifact iframes; every other session is a lightweight live-state
  header in the triage rail (its terminal/artifacts mount on promotion). Without this, the
  convergence and triage decisions read as incompatible — make the focal-only-is-live rule
  explicit in the layout.
- **Render discipline** — every *focused/live* artifact loads via `asset:` (JS runs). The
  `srcdoc`/CSP dead-button trap must not reappear. For off-screen/un-focused artifacts the
  history HUD's scaled `srcdoc` thumbnails are fine (no interactivity needed there); promote
  to a live `asset:` iframe on focus.
- **iOS-quality polish** — the triage rail, the transitions, and keyboard-nav are the
  headline; budget real time for feel. Test breakpoints (multi-monitor, the Board on a
  secondary screen — note the existing `layout.rs` only knew the primary monitor; the Board
  must be monitor-aware). A focal app window makes standard fullscreen/zoom straightforward.
- **Don't regress the overlay mid-migration** — build the Board (and the pill split) as new
  surfaces first; flip artifacts over once solid; keep the daemon usable throughout.

## Feature tree

- **P0 — Board shell as a focal app window.** New **focusable app window** (`WindowBuilder`,
  standard activation — **not** the non-activating panel) that hosts a focal area + a side
  rail, with the focal area statically rendering one or two artifact iframes via
  `artifact-view.ts`. Prove: it's a real app window (takes focus cleanly, standard chrome +
  the ⌘V Edit menu), per-artifact interactivity (buttons work), `asset:` JS runs. The pill
  stays the existing non-activating panel, untouched. (Isolated; doesn't touch the existing
  artifact-panel path yet.)
- **P1 — Triage rail (the "which agent needs me" milestone; this is what makes it *feel* like
  the vision).** Read **every** `~/.claude/companion/live/<source>.json` (not just the newest
  — generalize `live.rs::read_live` to return all) → render the **triage rail**: one entry per
  session showing its live-state header (`working`/`where`/`next`) and **badged/sorted by
  `next.kind`** (`blocked` > `decision` > `todo`). Selecting a rail entry makes that session
  **focal**: its artifacts (matched by `project`/source) render live in the focal area.
  Generalize `route_artifact` (session→source) so new artifacts land under the right session.
  This **absorbs the live surface** — once the rail shows live state, the separate `live_main`
  window is retired. (Terminal embedding comes in P3; ship the rail + focal artifacts first.)
- **P2 — Navigation + keyboard triage (central, not polish).** Keyboard model: ↑↓ across the
  rail, → into a session's artifacts, Enter to focus, Esc to back out, a fuzzy ⌘K
  quick-switcher to jump to any session/artifact. Seamless focus-to-expand transitions. This
  is the headline interaction — the surface lives or dies on how fast you can answer "who
  needs me, jump there."
- **P3 — Embed the terminal (the convergence).** Make the **focal** session pane an embedded
  **real terminal/PTY** (the Workspace), with that session's artifacts grouped beneath it.
  Build on the `wip/workspace-tabbed-terminal` seed (`portable-pty` + xterm.js). **Only the
  focal session runs a live PTY** (triage keeps it to one); rail entries stay lightweight
  until promoted. This is the heaviest piece and the core of the converged design.
- **P3.5 — Arrival reveal (Board provides the transition; the *content* is the agent's).**
  When you open the Board after being away, new artifacts **fade/stagger in** — the Board
  tracks which are *new since last seen* and reveals them smoothly. **Division of labor
  (Zach's call):** the Board provides only the generic reveal/transition surface — the actual
  **"good morning" dashboard is each agent's own HTML artifact.** Hermes (and every other
  agent) crafts a *unique animated good-morning* (see `hub/PUBLISHING.md`) that simply shows
  up as a revealed artifact. Do NOT hardcode a good-morning scene into the Board — keep it a
  generic, beautiful host. (Compositor-friendly transforms/opacity; reduced-motion aware.)
- **P4 — Per-session response routing.** Clipboard-tagged-by-source first; then the
  auto-route, **two distinct paths**: **live PTY (local OR SSH)** → terminal-write
  (bracketed-paste into the focal session's PTY); **async-remote with no live PTY (cron /
  morning brief)** → the **hub return path** (return endpoint/file the agent's next run reads).
  The hub return path is a separate required build — the PTY path can't reach a non-running
  agent.
- **P5 (later) — Composition protocol.** A pane hosts multiple agent-composed regions
  (artifact + media + form); the artifact `postMessage` protocol extends to a region/layout
  protocol — the real "compositor."

## Critical files / reuse
- New: a `board` **focusable app window** in `windows.rs` (a standard `WindowBuilder` with
  normal activation — **not** modeled on the non-activating `open_live_window`; do extend the
  ⌘V Edit menu work into the Board's app menu); a frontend `overlay/src/board.ts` (the triage
  rail / nav / focal area); board styles.
- **Primary build-on — `wip/workspace-tabbed-terminal`** (the Workspace seed): `portable-pty`
  PTYs, xterm.js, bracketed-paste write-into-terminal, and its per-session `route_artifact`.
  The convergence *is* porting this in, so treat it as a foundation, not a reference. The
  `feat/direct-agent-feedback` spike (session-threading → per-session artifact routing) feeds
  P4's terminal-write.
- Reuse: `artifact-view.ts` (`loadArtifactInto` per artifact); `route_artifact` (generalize
  session→Board-pane); `macos_panel.rs` (non-activating panel — **scoped to the pill only**,
  the Board does NOT use it); `history.rs` (enumerate artifacts + `srcdoc` thumbnails for
  off-screen artifacts); `layout.rs` (monitor-awareness, but the Board does internal layout);
  the hub pull (remote sessions); `live.rs`/`live.ts`/`LIVE_UI_BRIEF.md` (read-all-sources +
  paper aesthetic for the rail).
- The **asset-scope fix** in `tauri.conf.json` (`$HOME/.claude/companion/**`) is load-bearing
  — artifacts must load via `asset:`.
- New for P4's async case: a **hub return path** (return endpoint/file under the hub) so a
  finished cron/brief agent reads its steering response on its next run. This lives in the hub
  data layer, coordinate with the hub work.

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

**IMPORTANT — restore the user's overlay when you finish.** Killing the installed daemon for
`tauri dev` closes the overlay the user is actively using. When done verifying, relaunch it:
`open "/Applications/Companion Overlay.app"`. Never leave the user with no overlay running.

## Definition of done (P0–P2, the demoable core)
A beautiful **focal Board app window** (collapsible to the ambient pill) shows a **triage
rail** of sessions sorted/badged by `next.kind`, so you can see at a glance **which agent
needs you**; you keyboard-navigate (↑↓ / → / Enter / ⌘K) to focus any session, its artifacts
render live (`asset:` JS runs, ✓/✎/✗ steering works), and you back out with a seamless
transition. The Board takes focus cleanly as a real app window (no focus-trio gymnastics); the
pill stays the ambient non-activating overlay. iOS-smooth, on a secondary monitor too.
**(Terminal embedding lands in P3; per-session response auto-routing in P4.)**
