# Handoff — Claude Code Companion (Tauri HTML-artifact overlay)

> Updated **2026-05-22**. **The adaptive-window workstream is DONE: Q1 (fit-to-content
> sizing), Q2 (frameless + global ⌘0 toggle), Q3 (rounded-rect transparency), and Q4
> (fluid aspect→radius morph) are all built and verified.** All of Q1–Q4 are now
> merged to `master` — Q1 via PR #1, Q2–Q4 via PR #2 (merge commit `7ac0f1c`);
> branch `feat/adaptive-window-q2-q4` deleted, no open PRs remain.
>
> The global auto-trigger is now **LIVE** (2026-05-22): a global `PostToolUse` hook
> auto-pops the overlay when Claude writes `*.html` into `~/codeviz/public/artifacts/`.
> See "Auto-trigger — how it's wired" below.
> If this file and the wiki ever disagree, **trust the wiki**
> (`~/wiki/entities/claude-code-companion/`).

## 0. Read the wiki FIRST

- **Source of truth:** `~/wiki/entities/claude-code-companion/claude-code-companion.md`
  (`~/wiki` → `~/Documents/SyncThing`). Carries the full journey (MCP App → overlay),
  current state, key decisions, roadmap. Keep it in sync (global `~/.claude/CLAUDE.md`
  §5: surface the edit, get a yes, then write the entity page + append `~/wiki/log.md`).
- **Design dossier (Q1–Q4 plan + verified Tauri APIs):**
  `~/codeviz/public/artifacts/companion-adaptive-window-plan.html`.

## 1. What this project is

A way to **see the HTML artifacts Claude produces** without leaving whatever client you
run Claude in. The build is a standalone **Tauri v2 (Rust) "ghostly" overlay**: a
floating panel that renders any local `.html` Claude writes, in a sandboxed `<iframe>`,
and pops up when an artifact is created. Host-agnostic by design (terminal/Ghostty/VS
Code/Desktop) because the trigger is just "Claude writes a file and runs a shell command."

> The earlier **MCP App** (`companion-app/`) still exists and works inline in Claude
> Desktop, but it was set aside (renders only in graphical hosts — wrong audience). The
> **overlay** (`overlay/`) is the real direction. Don't build on `companion-app/` unless
> you're deliberately reviving that path.

## 2. Adaptive window — what shipped (Q1–Q4)

All four are built and verified. The window now adapts to each artifact instead of being
a fixed 460×640 box with OS chrome.

- **Q1 — fit-to-content sizing** (`overlay/src/resize.ts`). Artifacts self-report their
  content size via `postMessage({source:"companion-artifact",kind:"size",w,h})` (the
  `asset:` iframe is opaque-origin, so the parent can't measure it). The host clamps to
  `Monitor.workArea` and tweens `setSize` (rAF, ~180ms ease-out — Tauri has no native
  animated resize). Our-artifacts-only: HTML without the reporter gets the default size +
  manual resize. Convention: include `test-artifacts/fit-reporter.html`'s snippet and
  mark the content wrapper `data-fit-root`.
- **Q2 — frameless + global ⌘0 toggle.** `decorations:false` drops the OS title bar; the
  custom chrome bar (`overlay/index.html`, `data-tauri-drag-region`) handles move +
  refresh/external/hide. A global **⌘0** show/hide toggle is registered **from Rust** in
  `lib.rs` (`#[cfg(desktop)]`, `tauri-plugin-global-shortcut`) — no capability permission
  needed (capabilities only gate frontend IPC). It's the guaranteed escape hatch for the
  transparent window. **Tradeoff:** as a *global* hotkey, ⌘0 shadows "Actual Size"/zoom-
  reset app-wide while the overlay runs — change the `Shortcut::new(...)` in `lib.rs` if
  that bites.
- **Q3 — rounded-rect transparency.** `transparent:true` + `backgroundColor:"#00000000"`
  (+ `macOSPrivateApi:true`, already set). `styles.css` was already ghostly (transparent
  body, `border-radius` + `overflow:hidden`, backdrop-blur chrome), so this was pure
  re-activation. `shadow:true` stays — macOS draws it around the rounded content's alpha.
  Click-through is a non-issue for a rounded-rect (dead-zones are ~12px corner triangles).
  **Blob/notch shape is deferred** (needs a Rust ~60fps cursor-polling loop toggling
  `setIgnoreCursorEvents` — the ghost-window risk; opt-in only).
- **Q4 — fluid shape morph.** `resize.ts::applyRadius()` maps the fitted aspect ratio to
  a panel corner radius (portrait → rounder ~20px, landscape → tighter ~10px) via the
  `--radius` CSS var; `styles.css` transitions `border-radius` over the same ~180ms, so
  the corners morph in parallel with the resize. `test-artifacts/fit-wide.html` exercises
  the landscape branch.

## 3. Build & run CORRECTLY (operational traps — do not skip)

Two traps will silently re-break it:

1. **Always build with the `custom-protocol` feature**, or `generate_context!` resolves
   the frontend to `devUrl` (`http://localhost:1420`) instead of embedding `dist/` — and
   the window loads whatever squats on :1420 (TUICommander's dev Vite). Frontend changes
   need a cargo rebuild too (`dist/` is embedded).
2. **Build in a CLEAN env.** A shell inside another app's `tauri dev` (this work happens
   inside TUICommander) inherits `TAURI_*` / `CARGO_MANIFEST_DIR` / `OUT_DIR` /
   `TAURI_DEEP_LINK_PLUGIN_CONFIG` (schemes=`tuic`!) that steer the build wrong. Strip them.

```sh
cd ~/claude-code-companion/overlay
npm run build                         # refresh dist/ (tsc + vite)
env | grep -i 'tauri\|CARGO_MANIFEST\|OUT_DIR'   # if non-empty, you're dirty
env -u CARGO_MANIFEST_DIR -u CARGO_MANIFEST_PATH -u OUT_DIR \
    -u npm_lifecycle_event -u npm_lifecycle_script \
    -u TAURI_CLI_VERBOSITY -u TAURI_ENV_TARGET_TRIPLE \
    -u TAURI_DEEP_LINK_PLUGIN_CONFIG -u TAURI_UPDATER_PLUGIN_CONFIG \
    -u TAURI_ANDROID_PACKAGE_NAME_APP_NAME -u TAURI_ANDROID_PACKAGE_NAME_PREFIX \
    cargo build --manifest-path ~/claude-code-companion/overlay/src-tauri/Cargo.toml \
    --features custom-protocol
```

Run (record exact PID, capture stderr):
```sh
BIN=~/claude-code-companion/overlay/src-tauri/target/debug/companion-overlay
nohup "$BIN" open <ABS.html> >/tmp/companion-overlay.log 2>&1 &
echo $! > /tmp/companion-overlay.pid
```
`companion-overlay open <other.html>` on a second invocation forwards to the running
instance (single-instance) — handy for cycling artifacts to watch the morph live.

## 4. Verify headlessly — and the bridge's limits

- **The debug mcp-bridge is on `127.0.0.1:9339`** (`driver_session(start, port:9339)`),
  pinned away from TUICommander's 9223. `#[cfg(debug_assertions)]` only — release drops it.
- **`manage_window action=info` WORKS** — native window query (size/position/visibility),
  the bridge-free way to verify sizing/positioning. This is how Q1/Q2/Q4 sizing was checked.
- **`webview_execute_js`, `read_logs(source:"console")`, and `webview_screenshot` all FAIL**
  under this app's `script-src 'self'` CSP (the bridge injects an eval/html2canvas helper
  the CSP blocks: `Resolve-ref helper was not available…`). Not flaky — structural. For
  in-frame assertions use the artifact-`postMessage` → throwaway Rust command → `/tmp`
  relay, or temporarily loosen the *parent* CSP, build, verify, revert.
- **Transparency/visual checks can't be done headlessly** (screenshots are CSP-dead) — ask
  the user to glance; ⌘0 is the escape hatch if a window mis-paints.
- **Exact-PID kill only.** Never `pkill -f` broad patterns (it once took down TUICommander):
  ```sh
  PID=$(cat /tmp/companion-overlay.pid)
  ps -p "$PID" -o command= | grep -q companion-overlay && kill "$PID"
  ```
- **Never disrupt TUICommander** (vite :1420, bridge :9223) — it hosts the live Claude session.

## 4b. Auto-trigger — how it's wired (LIVE, 2026-05-22)

When Claude writes `*.html` into `~/codeviz/public/artifacts/`, the overlay pops on its own:

- **Hook:** `~/.claude/settings.json` → `hooks.PostToolUse` (matcher `Write|Edit`) runs
  `overlay/scripts/companion-hook`.
- **Filter:** `companion-hook` reads the hook JSON on stdin, cheap-prefilters on the artifacts
  path, extracts `tool_input.file_path` (via `node`), and on a match runs `companion open <path>`
  (`nohup`, non-blocking; always exits 0 so it never blocks the write).
- **CLI:** `companion` (`overlay/scripts/companion`) symlinked into `/usr/local/bin`; resolves
  the binary from `~/Applications/Companion Overlay.app` first.
- **Binary:** release `.app` at `~/Applications/Companion Overlay.app`
  (`npm run tauri build -- --bundles app`, env stripped per §3). Release drops the debug
  mcp-bridge — so **no headless webview introspection on it; verify by eye** (⌘0 escape hatch).
- **Convention:** `~/.claude/rules/common/html-output.md` documents the auto-preview and now
  carries the fit-reporter snippet, so generated artifacts self-size (Option 1).
- **Scope decision:** complements codeviz (artifacts still served at `localhost:3001`); the
  trigger is scoped to the artifacts dir so it never fires on node_modules / build output.

Two fit bugs were fixed while verifying: `styles.css` `.empty[hidden]` (placeholder was
overlapping the iframe — `.empty`'s `display:grid` overrode `[hidden]`), and `resize.ts`
`MIN_H` 280→120 (small artifacts were clamped up, exposing the iframe's white background).

## 5. Where to pick up next

The global auto-trigger is **DONE / LIVE**. Remaining, roughly in priority:

1. **Non-activating auto-pop (high):** artifacts now pop while you work in the terminal, so the
   window stealing focus is disruptive. Make it show-without-activating (NSPanel
   `nonactivatingPanel` / `setActivationPolicy`, or show + don't focus) so it never grabs the
   keyboard mid-type.
2. **Universal fitting (Option 3):** the reporter is opt-in per artifact (baked into the
   `html-output.md` convention for Claude's own output). For hand-written / third-party /
   pre-existing HTML, have the overlay inject the reporter itself — intercept the `asset:`
   response in Rust and rewrite the HTML before serving.
3. **Multi-instance / focus-following (big, parked):** several Claude instances across Ghostty
   tabs each emit artifacts; bind each to its terminal instance and show the right one as focus
   changes. Open design Qs in the wiki backlog.
4. **Smaller polish:** `MIN_W` (320) leaves a white strip on narrow artifacts (same class as the
   fixed `MIN_H`); the 8px `PAD` shows the iframe's white on non-filling artifacts; ⌘0 is global
   so it shadows zoom-reset app-wide.
5. **Blob / non-rectangular shape (Q3 stretch):** Rust ~60fps cursor-polling loop toggling
   `setIgnoreCursorEvents`. Opt-in only — the exact failure mode that ghosted the desktop.
6. **Deferred (designed-for):** board interactivity (iframe `postMessage` → `invoke` → Rust
   state) and "ask-back" (inject a user turn via PTY / TUICommander `session input`).

## 6. RESOLVED earlier — inline JS runs via `asset:` (kept for context)

In-scope artifacts render via the **`asset:` protocol** (a real-origin document with its
own absent CSP), not `srcdoc` — so inline/module scripts run while the
`sandbox="allow-scripts"` (no `allow-same-origin`) iframe stays isolated. `srcdoc` inline
JS was blocked because `about:srcdoc` inherits the overlay's `script-src 'self'`.
`artifact.rs::artifact_in_scope` picks the branch deterministically. The empty-render bug
before that was the missing `custom-protocol` feature (§3, trap 1).

## 7. File map

```
~/claude-code-companion/
├── HANDOFF.md                         # this file
├── companion-app/                     # OLD MCP App (works in Claude Desktop); set aside
└── overlay/                           # CURRENT direction — the Tauri overlay
    ├── index.html                     # custom chrome bar (drag region) + sandboxed <iframe>
    ├── src/
    │   ├── main.ts                    # open-artifact listener; asset:/srcdoc load; chrome; initFit/resetFit
    │   ├── resize.ts                  # Q1 fit-to-content + Q4 aspect→radius morph
    │   └── styles.css                 # ghostly card (transparent body, rounded panel, border-radius transition)
    ├── test-artifacts/                # fit-reporter (snippet), fit-tall, fit-short, fit-wide, inline-js-probe
    └── src-tauri/
        ├── Cargo.toml                 # [features] custom-protocol; tauri-plugin-global-shortcut
        ├── tauri.conf.json            # window: decorations:false, transparent:true, bg #00000000, macOSPrivateApi
        ├── capabilities/default.json  # window perms incl. set-size/inner-size/current-monitor
        └── src/
            ├── lib.rs                 # Builder + single-instance + RunEvent::Opened + setup(argv); ⌘0 toggle; bridge :9339
            ├── artifact.rs            # parse_open_args / open_in_window / read_artifact / artifact_in_scope
            └── main.rs                # calls companion_overlay_lib::run()
```

Dossier: `~/codeviz/public/artifacts/companion-adaptive-window-plan.html` ·
Wiki: `~/wiki/entities/claude-code-companion/`.
