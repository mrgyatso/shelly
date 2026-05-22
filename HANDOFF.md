# Handoff — Claude Code Companion (Tauri HTML-artifact overlay)

> Updated 2026-05-20 (late session) on macOS. The empty-render bug is **fixed**,
> and **item #1 (inline-JS in the sandboxed iframe) is ANSWERED, FIXED, and now
> VERIFIED end-to-end** (a freshly generated artifact with a live clock, rAF
> visualizer, and a click counter renders + runs its JS in the overlay). The
> MCP-bridge blocker turned out to be a permanent CSP incompatibility, not a flaky
> bridge — see the lesson in the RESOLVED section.
>
> **➡️ THE NEXT WORKSTREAM IS THE "ADAPTIVE WINDOW" (see the section directly below):
> fit-to-artifact sizing, removing the top bar(s), custom non-rectangular shape, and
> a fluid/morphing shape that tracks artifact size.** These are framed as OPEN
> QUESTIONS for you (the next agent) to investigate and answer, then build — they are
> not settled requirements. The global auto-trigger (old item #2) is **PAUSED** per
> the user; do not start it unless asked.
>
> **Currently running:** a demo instance may still be up — `companion-overlay open
> .../codeviz/public/artifacts/companion-overlay-demo.html` (PID was 73748, bridge on
> :9339). Re-check `pgrep -fl companion-overlay`; kill by exact PID when done.

## ⚠️ NEXT WORKSTREAM — adaptive window (sizing · chrome removal · custom + fluid shape)

The render path works (item #1). The next focus is making the **window adapt to the
artifact** instead of being a fixed 460×640 box with OS chrome. **Treat each item as
an open question to answer, not a spec** — investigate trade-offs, propose, confirm
with the user, then build. Keep the existing guardrails (don't ship a hostile
invisible ghost window; verify bridge-free since the mcp-bridge is CSP-dead here).

Baseline today (what you're changing): `app.windows[0]` = `460×640`,
`decorations:true`, `transparent:false`, `alwaysOnTop:false` (but
`artifact.rs::open_in_window` force-sets always-on-top on open); a **custom chrome
bar** lives in `overlay/index.html` (filename + refresh/external/hide buttons) above
the artifact `<iframe>`; the artifact loads in a `sandbox="allow-scripts"` (NO
`allow-same-origin`) **opaque-origin** `asset:` iframe.

### Q1 — Resize when an artifact is larger than the window
When Claude generates an artifact bigger than the window, it should resize so it isn't
clipped.
- Should the **window grow to the artifact's natural size** (capped to the display
  work-area, then scroll past that), or should the **content scale to fit** a bounded
  window — or both, as a toggle? What's the default?
- **Hard part — measuring the artifact.** The `asset:` iframe is opaque-origin (no
  `allow-same-origin`), so the parent **cannot read `iframe.contentDocument` /
  scroll size**. Evaluate: (a) the artifact `postMessage`s its `scrollWidth/Height`
  (works for our own artifacts, not arbitrary ones); (b) a thin trusted wrapper/shim
  we control measures and reports; (c) sniff dimensions from the HTML before render
  (Rust side); (d) a sane default size + manual resize. Pick one and justify the
  trade-off vs. the no-`allow-same-origin` isolation guarantee.
- Define min/max bounds, aspect-ratio handling, and behavior when the artifact
  changes size *after* load.

### Q2 — Remove the top bar(s)
There are **two** "top bars"; decide each independently:
- **OS title bar** (`decorations:true`) — go frameless (`decorations:false`)? If so,
  how do you **move and close** the window (custom `data-tauri-drag-region`, a
  hover-reveal control strip, a global hotkey, a tray item)?
- **Our custom chrome bar** in `index.html` (filename + refresh/external/hide) —
  remove it or auto-hide on hover? If removed, where do refresh / open-externally /
  hide actions go (context menu, hover affordance, keyboard)?

### Q3 — Custom (non-rectangular) window shape
Can the overlay be a custom shape (rounded card, blob, notched panel)?
- macOS path to evaluate: `transparent:true` + `macOSPrivateApi:true` + CSS
  `border-radius`/`clip-path` on the root with a clear WKWebView background. **Confirm
  hit-testing:** clicks *outside* the visible shape must pass through — no invisible
  click-blocking bounding rect (this exact failure mode previously ghosted the
  desktop; see §5 and Key decisions in the wiki).
- Re-enable any transparent/ghostly look as an **opt-in**, only after it reliably
  paints and click-through is verified. `macOSPrivateApi` ⇒ no Mac App Store (already
  accepted for a personal tool).

### Q4 — Fluid / morphing shape tied to artifact size
Can the shape be fluid — morphing as the generated artifact's size/aspect changes?
- Smoothly animate the window resize (compositor-friendly) and transition the mask
  (`clip-path`) as content dimensions change between artifacts?
- Should the shape track the artifact's **aspect ratio** (tall doc → portrait pill,
  wide dashboard → landscape card)? Define the mapping and the morph timing.

### Where to look / how to verify
- Window + security config: `overlay/src-tauri/tauri.conf.json` (`app.windows[0]`,
  `security.csp`, `security.assetProtocol`). Chrome + iframe + load logic:
  `overlay/index.html`, `overlay/src/main.ts` (`loadArtifact`). Show/raise/always-on-top:
  `overlay/src-tauri/src/artifact.rs::open_in_window`.
- **Verify bridge-free** (the mcp-bridge can't eval under our CSP — see RESOLVED):
  use the `postMessage` → throwaway Rust command → `/tmp/*.txt` relay pattern, or
  temporarily loosen `script-src` and revert. The dev window is currently safe/opaque
  — keep it paintable while iterating; don't launch invisible windows.
- Reuse the sibling `helpdesk-companion` Tauri scaffold for any transparency / NSPanel
  patterns it already proved.

## ✅ RESOLVED — item #1 verified (inline JS runs via `asset:`)

### TL;DR
- **The inline-JS question is answered.** Inline scripts were blocked because the
  `srcdoc` render loads as `about:srcdoc`, which **inherits the overlay's
  `script-src 'self'` CSP**. (The iframe sandbox was never the cause.)
- **The fix is implemented + built.** In-scope artifacts now render via the
  **`asset:` protocol** (a real-origin document with its own absent CSP) instead of
  `srcdoc` — inline/module scripts run, isolation preserved, **no parent-CSP change
  needed** (`frame-src`/`img-src` already allow `asset:`).
- **VERIFIED (2026-05-20, follow-up session).** Launched the rebuilt binary on
  `test-artifacts/inline-js-probe.html` (an in-scope $HOME path) under the **real
  shipping CSP**. Both the classic inline `<script>` and the inline
  `<script type="module">` (the exact form the demo board uses) **ran** — proven via
  a bridge-free relay (probe `postMessage` → parent → throwaway Rust command →
  `/tmp/probe-proof.txt`, which received both `[PROBE] … RAN` lines). The stderr log
  showed **no `read_artifact OK`**, independently confirming `loadArtifact` took the
  `artifact_in_scope → asset:` branch (not the `srcdoc` fallback). Since `srcdoc`
  inline JS is CSP-blocked, inline JS running ⟹ the asset branch loaded it. All
  verification instrumentation was reverted and the binary rebuilt clean
  (frontend bundle hash returned to the pre-instrumentation `index-DAjucKGU.js`).

### ⚠️ New lesson — the mcp-bridge is CSP-incompatible with this app
The hypothesi `tauri-mcp-server` bridge fails **every** `webview_execute_js` /
`read_logs(console)` call with `Resolve-ref helper was not available in the webview
after registration`. This is **not** flaky session state (it reproduces from a clean
launch + fresh `driver_session` every time). Root cause: the bridge injects an
eval-based helper into the **parent** webview, which our `script-src 'self'` CSP
blocks (no `'unsafe-eval'`/`'unsafe-inline'`). It only worked in the *first* probe
last session because the window was still loading TUICommander's permissive app
(pre-`custom-protocol`-fix). **Implication for future webview verification on this
app:** the bridge won't work against the real CSP. Either (a) verify bridge-free
(the relay-to-Rust file-proof above), or (b) temporarily add `'unsafe-eval'
'unsafe-inline'` to `script-src` in `tauri.conf.json`, rebuild, verify, revert
(loosening the *parent* CSP is sound for verification — it doesn't affect the
child `asset:` iframe, which has its own absent CSP either way).

### What changed this session (on disk; NOT git-committed)
- `overlay/src/main.ts` — `loadArtifact()` now `invoke("artifact_in_scope")`; if
  true → `frame.removeAttribute("srcdoc"); frame.src = convertFileSrc(path) + "?_=" + Date.now()`
  (cache-bust so re-opening the same path reloads); else → the old
  `read_artifact`→`srcdoc` fallback. Added `convertFileSrc` to the `@tauri-apps/api/core` import.
- `overlay/src-tauri/src/artifact.rs` — new `#[tauri::command] artifact_in_scope(app, path) -> bool`
  = `app.asset_protocol_scope().is_allowed(&path)`. Authoritative scope check, so the
  frontend picks asset-vs-srcdoc deterministically (no flaky cross-origin iframe
  `error` events that could silently fall back to srcdoc and re-break inline JS).
- `overlay/src-tauri/src/lib.rs` — registered `artifact::artifact_in_scope` in `generate_handler!`.
- `overlay/test-artifacts/inline-js-probe.html` — NEW regression fixture: a classic
  inline `<script>` + an inline `<script type="module">`, each doing `console.log` +
  `window.parent.postMessage("[PROBE] … RAN")` + a DOM marker. **Keep it.**
- Rebuilt the debug binary: `npm run build` then `cargo build --features custom-protocol`
  in a **sanitized env** (the session shell leaks TUICommander's `TAURI_*` — see §4).
  Both succeeded; `target/debug/companion-overlay` mtime ~20:08.

### Why the fix is right (two independent proofs)
1. **Mechanism — directly observed (probe #1, pre-rebuild, bridge working):**
   - `srcdoc`: child URL `about:srcdoc`; classic + module inline both **NOT RUN**
     *even after* adding `allow-same-origin` (⇒ it's CSP inheritance, not the opaque
     origin). Static HTML/CSS rendered (style-src has `'unsafe-inline'`), which is why
     it *looked* like it worked.
   - `asset://` (`convertFileSrc`, sandbox `allow-scripts`): both inline scripts
     **RAN** — parent received `[PROBE] classic-inline RAN` + `[PROBE] module-inline RAN`
     via postMessage; `event.origin === "null"` (still isolated).
2. **Code path — confirmed via stderr (probe #2 and #3, rebuilt binary):** launching
   an in-scope artifact prints the bridge-init lines but **NO `[overlay] read_artifact OK …`**.
   `read_artifact` is only called by the srcdoc fallback, so its absence proves
   `loadArtifact` took the `artifact_in_scope == true` → `asset:` branch.
   - The one thing NOT directly re-observed is the *conjunction* (rebuilt binary +
     asset branch → inline JS visibly running). Proof (1) is independent of the
     rebuild, so confidence is high.

### The blocker, in detail (HISTORICAL — resolved; cause was CSP, see lesson above)
- Every `webview_execute_js` (even `(() => 1+1)()`) and `read_logs(source:"console")`
  returns `WebView execution failed: Resolve-ref helper was not available in the
  webview after registration.`
- `driver_session(start, port:9339)` SUCCEEDS; `status` shows connected
  (`com.claudecode.companion-overlay`, :9339). Only the JS-eval/log helper is broken.
- Ruled out:
  - **Stray procs / wrong port:** `lsof -iTCP:9339` showed exactly one
    `companion-overlay` listening; `pgrep -fl companion-overlay` only it.
  - **asset-child-navigation interfering:** fails even when launched with NO artifact
    (empty overlay, no child iframe navigation).
  - **Session churn / settle time:** fails fresh after stop + 10s wait + reconnect.
- **Leading hypothesis:** the MCP-server-side bridge went into a bad state after the
  first session's stop and never recovered — it worked on the very first connect and
  has failed on every connect since, across fresh app launches *and* the rebuild. The
  19:50→20:08 binary correlation is likely coincidental (the first failure was simply
  the first reconnect).
- **Alternative to rule out:** the rebuilt frontend bundle breaks the bridge's helper
  injection. Cheap check: connect *first thing* against a clean launch before doing
  anything else.

### Next steps to unblock (HISTORICAL — these were tried/superseded; verified bridge-free instead)
1. **Restart the hypothesi `tauri-mcp-server`** (the MCP server process, not the app)
   — most likely fix. Then: `companion-overlay open <abs .../inline-js-probe.html>`,
   `driver_session(start, port:9339)`, install a parent listener
   (`window.__probe=[]; addEventListener('message', e=>window.__probe.push(String(e.data)))`),
   click `#refresh`, read `window.__probe` → expect
   `["[PROBE] classic-inline RAN","[PROBE] module-inline RAN"]`. Also assert
   `frame.getAttribute('src')` starts with `asset://localhost/` and
   `frame.hasAttribute('srcdoc') === false`.
2. If the bridge stays broken: non-bridge proof — temporarily add a `message` listener
   in `main.ts` that on `[PROBE]` calls a throwaway Rust command writing
   `/tmp/probe-proof.txt`, rebuild, launch, `cat` the file. (Heavier; only if needed.)
3. After verifying: **kill the test instance by exact PID** (never broad `pkill` — it
   once took down TUICommander), remove any temp instrumentation, then move to item #2
   (global auto-trigger).

### Housekeeping at handoff
- All driver sessions stopped; all debug `companion-overlay` instances killed; port
  9339 free. (Re-check with `pgrep -fl companion-overlay`.)
- **Wiki not yet updated** (per CLAUDE.md rule #5, pending confirmation + green verify):
  once verified, flip the key decision **srcdoc-primary → asset-primary (srcdoc fallback
  for out-of-scope)**, move the inline-JS open-question to answered (CSP inheritance),
  note the new `artifact_in_scope` command, and append `~/wiki/log.md`.

## 0. Read the wiki FIRST (non-negotiable)

Before touching anything, read the canonical project state:

- **Wiki entity (source of truth):** `~/wiki/entities/claude-code-companion/claude-code-companion.md`
  (`~/wiki` is a symlink → `~/Documents/SyncThing`). It carries the full journey
  (why we pivoted MCP App → overlay), current state, key decisions, open questions,
  and roadmap. **Trust it over this file if they ever disagree**, and keep it in
  sync as you work (the global `~/.claude/CLAUDE.md` rule #5 governs how: surface
  the proposed edit, get a yes, then write the entity page + append `~/wiki/log.md`).
- **Implementation plan:** `~/.claude/plans/yes-parallel-thacker.md` — the full
  overlay design (window config, Rust seams, CLI, auto-trigger, verification steps).
- **Wiki log of the most recent work:** `~/wiki/log.md` (latest entry =
  `[2026-05-20] verified | claude-code-companion — inline-JS executes via asset: protocol`).

## 1. What this project is

A way to **see the HTML artifacts Claude produces** without leaving whatever client
you run Claude in. Current build = a standalone **Tauri v2 (Rust) "ghostly" overlay**:
a floating panel that renders any local `.html` Claude writes, in a sandboxed
`<iframe>`, and pops up when an artifact is created. Host-agnostic by design (works
from the terminal/Ghostty/VS Code/Desktop) because the trigger is just "Claude
writes a file and runs a shell command."

It's the macOS evolution of the earlier Linux/Axum `html-artifact-server` idea, and
reuses the Tauri scaffold proven by the sibling `helpdesk-companion`.

> The earlier **MCP App** path (`companion-app/`) still exists and works inline in
> Claude Desktop, but it was set aside (renders only in graphical hosts — wrong
> audience). The **overlay** (`overlay/`) is the real direction. Don't build on
> `companion-app/` unless you're deliberately reviving that path.

## 2. How it works (overlay)

- **Render:** Rust `read_artifact(path)` reads the file's bytes; the frontend
  (`overlay/src/main.ts`) injects them via `iframe.srcdoc`. The iframe is
  `sandbox="allow-scripts"` **without** `allow-same-origin` (artifact runs its JS in
  an opaque origin, can't touch the overlay's IPC/storage).
- **Trigger / `companion open <file>`:** `tauri-plugin-single-instance` forwards a
  second invocation's argv to the running instance, which loads the file + raises
  the window. First-launch argv handled in `setup()`; macOS Finder/`open` via
  `RunEvent::Opened`; `companion://open?path=…` deep link as an alternate.
- **Boot drain:** on first launch the artifact path is queued in Rust
  (`PendingArtifact`) because the `open-artifact` event fires before the webview's
  listener exists; the frontend drains it on boot via `take_pending_artifact`.

## 3. The empty-render bug — FIXED (so you don't re-litigate it)

**Symptom (old):** launching `companion-overlay open <abs.html>` produced a window
that never painted the artifact; `[overlay] read_artifact …` never logged.

**Root cause (CSP was a red herring):** the binary was built **without the
`custom-protocol` Cargo feature**, which was missing from `overlay/src-tauri/Cargo.toml`.
In Tauri v2, `tauri-codegen` sets `dev = cfg!(not(feature = "custom-protocol"))`
(tauri-macros `context.rs:155`). With it off, `generate_context!` resolves the
frontend to **`devUrl` (`http://localhost:1420`)** instead of embedding `dist/`. No
overlay Vite runs there — and **TUICommander's own `tauri dev` Vite squats on :1420
(`strictPort`)** — so the overlay window actually loaded **TUICommander's React app**.
Our `main.ts` therefore never ran, so `take_pending_artifact` / `read_artifact` were
never called → blank window. (Diagnosed via DOM probe:
`location.href = http://localhost:1420/`, `document.title = "TUICommander"`,
`/src/index.tsx` in the document.)

**Fix applied:**
- Added to `overlay/src-tauri/Cargo.toml`:
  ```toml
  [features]
  custom-protocol = ["tauri/custom-protocol"]
  ```
- Rebuilt with the feature on, in a sanitized env (see §4).

**Verified (headless, no screenshots):** stderr
`[overlay] read_artifact OK: …/companion-app/ui-dist/index.html (353059 bytes)`;
DOM probe `location.href = tauri://localhost`, `document.title = "Companion Overlay"`,
`__TAURI_INTERNALS__` present (our main.ts ran), `#empty` hidden, iframe visible,
`frame.srcdoc` = 334,267 chars (the 353 KB board injected as UTF-8).

## 4. How to build & run CORRECTLY (operational gotchas)

Two traps will silently re-break it:

1. **Always build with `custom-protocol`** or you get the dev frontend again.
   - Dev/iteration (keeps the debug-only mcp-bridge for headless checks):
     ```sh
     cd ~/claude-code-companion/overlay
     npm run build                 # refresh dist/
     cd src-tauri
     cargo build --features custom-protocol
     ```
   - Shipping: `npm run tauri build` (release enables `custom-protocol`
     automatically — but **release drops the mcp-bridge**, which is
     `#[cfg(debug_assertions)]`).

2. **Build in a CLEAN env.** A shell spawned inside another app's `tauri dev`
   (e.g. this repo work happened inside TUICommander's dev session) inherits
   `TAURI_*`, `CARGO_MANIFEST_DIR`, `OUT_DIR`, `TAURI_DEEP_LINK_PLUGIN_CONFIG`
   (schemes=`tuic`!) that silently steer the build to the wrong manifest / dev
   frontend / foreign deep-link config. Unset them:
   ```sh
   env -u CARGO_MANIFEST_DIR -u CARGO_MANIFEST_PATH -u OUT_DIR \
       -u npm_lifecycle_event -u npm_lifecycle_script \
       -u TAURI_CLI_VERBOSITY -u TAURI_ENV_TARGET_TRIPLE \
       -u TAURI_DEEP_LINK_PLUGIN_CONFIG -u TAURI_UPDATER_PLUGIN_CONFIG \
       -u TAURI_ANDROID_PACKAGE_NAME_APP_NAME -u TAURI_ANDROID_PACKAGE_NAME_PREFIX \
       cargo build --features custom-protocol
   ```
   Check `env | grep -i tauri` first — if it's empty, you're clean.

Run (records exact PID, captures the Rust stderr):
```sh
cd ~/claude-code-companion/overlay
ART="/Users/gyatso/claude-code-companion/companion-app/ui-dist/index.html"  # demo artifact
nohup ./src-tauri/target/debug/companion-overlay open "$ART" >/tmp/companion-overlay.log 2>&1 &
echo $! > /tmp/companion-overlay.pid
cat /tmp/companion-overlay.log   # expect: [overlay] read_artifact OK … (N bytes)
```

## 5. Verify headlessly — do NOT throw windows at the desktop

The lesson that started this whole episode: an always-on-top + transparent +
borderless empty window is an invisible click-blocking ghost, and broad `pkill`
took down the user's TUICommander. Rules:

- **Dev window is already safe** in `tauri.conf.json` (`alwaysOnTop:false`,
  `transparent:false`, `decorations:true`, `visible:true`). Keep it that way until
  rendering is fully proven; re-enable the ghostly look only as an opt-in.
- **Inspect via the mcp-bridge, not screenshots.** Our bridge is pinned to
  `127.0.0.1:9339` (vs TUICommander's 9223) in `lib.rs`. Use the hypothesi
  tauri-mcp-server: `driver_session(start, port:9339)` → `read_logs(source:"console")`
  and `webview_execute_js` DOM probes. **No `webview_screenshot`, no `screencapture`.**
- **One instance, exact-PID kill.** Never `pkill -f` broad patterns. Kill only the
  PID you recorded, after confirming its command is `companion-overlay`:
  ```sh
  PID=$(cat /tmp/companion-overlay.pid)
  ps -p "$PID" -o command= | grep -q companion-overlay && kill "$PID"
  ```
- **Never disrupt TUICommander** (PID on :9223 / vite on :1420) — it hosts the live
  Claude session.

## 6. Where to pick up (priority order)

1. **➡️ ACTIVE — the "ADAPTIVE WINDOW" workstream** (fit-to-artifact sizing, top-bar
   removal, custom non-rectangular shape, fluid/morphing shape). Full open-question
   brief is in the **NEXT WORKSTREAM** section near the top of this file. This is the
   current task.
2. **~~Verify the artifact's own JS executes in the sandboxed iframe~~ — DONE
   (ANSWERED + FIXED + VERIFIED).** Inline JS was blocked by CSP inheritance through
   `about:srcdoc`; the fix renders in-scope artifacts via `asset:` instead, and both
   classic + module inline scripts were verified running under the real CSP. See the
   "RESOLVED" section.
3. **PAUSED (per user) — global auto-trigger:** `~/.claude/CLAUDE.md` rule + a global
   `PostToolUse` hook that runs `companion open <abs-path>` on `.html` writes;
   symlink the `overlay/scripts/companion` CLI into PATH (point its dev `BIN` at the
   debug binary). See plan §"Auto-trigger". **Do not start unless asked.**
4. **Decide the ghostly mode** (always-on-top toggle vs always); NSPanel
   non-activating window so it never steals terminal focus. Overlaps with Q3/Q4 of the
   adaptive-window workstream — fold in there.
5. **Deferred (designed-for, not built):** board interactivity (iframe `postMessage`
   → `invoke` → Rust state) and "ask-back" (inject a user turn into a terminal
   session via PTY / `tmux send-keys` / TUICommander `session input`).

## 7. File map

```
~/claude-code-companion/
├── HANDOFF.md                         # this file
├── companion-app/                     # OLD MCP App (works in Claude Desktop); set aside
│   └── ui-dist/index.html             # 353 KB self-contained status board = demo artifact
└── overlay/                           # CURRENT direction — the Tauri overlay
    ├── index.html                     # chrome bar + sandboxed <iframe id="frame">
    ├── src/main.ts                    # open-artifact listener + read_artifact→srcdoc + chrome
    ├── dist/                          # vite build output (embedded by generate_context!)
    ├── scripts/companion              # CLI shim (single-instance arg forwarding)
    └── src-tauri/
        ├── Cargo.toml                 # NOTE: [features] custom-protocol  ← the fix
        ├── tauri.conf.json            # window (safe dev settings) + CSP + assetProtocol + deep-link
        └── src/
            ├── lib.rs                 # Builder + single-instance + RunEvent::Opened + setup(argv); mcp-bridge pinned :9339
            ├── artifact.rs            # parse_open_args / open_in_window / read_artifact / take_pending_artifact
            └── main.rs                # calls companion_overlay_lib::run()
```

Plan: `~/.claude/plans/yes-parallel-thacker.md`. Wiki: `~/wiki/entities/claude-code-companion/`.
