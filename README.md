# Claude Code Companion

**A ghostly floating overlay that renders the HTML artifacts Claude writes — right on top of your terminal, without ever stealing keyboard focus.**

[![Latest release](https://img.shields.io/github/v/release/mrgyatso/claude-code-companion?include_prereleases&sort=semver)](https://github.com/mrgyatso/claude-code-companion/releases)
[![Platform: macOS](https://img.shields.io/badge/platform-macOS-black?logo=apple)](#requirements)
[![Signing: unsigned preview](https://img.shields.io/badge/signing-unsigned%20preview-orange)](#-first-launch-its-unsigned)
[![Downloads](https://img.shields.io/github/downloads/mrgyatso/claude-code-companion/total)](https://github.com/mrgyatso/claude-code-companion/releases)

When Claude saves an `.html` artifact — a plan, a diagram, a review, a dashboard — a borderless panel fades in and renders it live, on top of whatever you're doing. Run Claude anywhere (Ghostty, iTerm, VS Code, Desktop); the trigger is just "Claude writes a file." Open several at once — each artifact gets its own panel you can drag, pin, and close. Your terminal keeps the keyboard the whole time.

---

## Contents

- [Demo](#demo)
- [Highlights](#highlights)
- [Requirements](#requirements)
- [Install (recommended)](#install-recommended)
- [⚠️ First launch: it's unsigned](#-first-launch-its-unsigned)
- [Usage](#usage)
- [Auto-pop on artifact write](#auto-pop-on-artifact-write)
- [Writing artifacts that fit](#writing-artifacts-that-fit)
- [Build from source](#build-from-source)
- [How it works](#how-it-works)
- [Project layout](#project-layout)
- [Status & roadmap](#status--roadmap)
- [License](#license)

---

## Demo

<!--
  To add the demo video:
    1. Open a new GitHub issue (or edit the latest release) and drag your .mp4/.mov in.
    2. GitHub uploads it and returns a https://github.com/user-attachments/assets/… URL.
    3. Paste that URL on its own line below (plain, no image markdown — GitHub embeds a player).
  Or drop a GIF at assets/demo.gif and use:  ![demo](assets/demo.gif)
-->

> 📹 **Demo video coming soon.** Paste the uploaded video URL here — it shows an artifact popping in, two panels re-flowing, the corner-radius morph, drag-to-pin, and `⌘0` toggle.

---

## Highlights

- **Renders any local `.html`** in a sandboxed `<iframe>`. In-scope artifacts load via the `asset:` protocol so their own inline/module scripts run — interactive artifacts work, not just static markup.
- **Fit-to-content sizing** — each panel grows/shrinks to its artifact's real size, clamped to your screen, with an animated re-flow and a corner-radius that morphs with the aspect ratio.
- **One panel per artifact** — several float at once, each dragged / pinned / closed independently. Re-opening the same file refreshes it in place.
- **Never steals focus** — each panel is a non-activating macOS `NSPanel` and the app runs as a Dock-less background daemon, so clicking or scrolling a panel leaves your terminal keyboard-focused.
- **Two layout modes** — a tidy right-edge column (default), or packed beside your focused terminal and following it as it moves (`⌘9`).
- **Drag-to-pin** — drag a panel and it stays put, opting out of re-flow until you close it.
- **No scrollbar chrome** — tall artifacts scroll on small screens, but the ugly bar never shows.
- **Auto-pops** when Claude writes an artifact, via a `PostToolUse` hook.

---

## Requirements

- **macOS.** The prebuilt release is an **Intel (x86_64)** binary; it runs on Apple Silicon under Rosetta 2. Apple Silicon users who want a native build can [build from source](#build-from-source).
- For building from source: **Rust** (stable) and **Node 18+**.

---

## Install (recommended)

1. Download the latest **`Companion Overlay_x.y.z_x64.dmg`** from the [Releases page](https://github.com/mrgyatso/claude-code-companion/releases).
2. Open the DMG and drag **Companion Overlay** into **Applications**.
3. Approve it through Gatekeeper on first launch — see below.
4. Put the `companion` launcher on your `PATH` (clone this repo, then):
   ```bash
   ln -sf "$PWD/overlay/scripts/companion" /usr/local/bin/companion
   ```

> The `companion` CLI is what lets Claude (and you) pop artifacts into the running overlay. It resolves the installed `.app` automatically.

---

## ⚠️ First launch: it's unsigned

This is an **unsigned, un-notarized preview build.** macOS Gatekeeper will block it the first time with *"Companion Overlay can't be opened because Apple cannot check it for malicious software"* (or *"is damaged"* on a fresh download). This is expected — pick **one** of the following:

**Option A — right-click to open (simplest)**
1. In **Applications**, right-click (or Control-click) **Companion Overlay**.
2. Choose **Open**, then **Open** again in the dialog.

**Option B — clear the quarantine flag (if A doesn't stick)**
```bash
xattr -dr com.apple.quarantine "/Applications/Companion Overlay.app"
```

You only have to do this once. A signed + notarized build (no warning) will follow once a Developer ID is in place.

---

## Usage

```bash
companion open path/to/artifact.html   # opens a panel (starts the daemon if needed)
```

The daemon stays alive with no panels open and pops them on demand. Re-running `companion open` on the same path refreshes that panel instead of spawning a duplicate.

### Panel controls

Hover a panel to reveal its controls (top-right):

| Control | Action |
|---------|--------|
| ⟳ | Reload the artifact |
| ↗ | Open it in your default browser |
| ✕ | Close this panel |

Drag the **top edge** of a panel to move it (dragging pins it — it stops re-flowing).

### Keyboard shortcuts

| Shortcut | Action |
|----------|--------|
| `⌘0` | Show / hide **all** panels (the escape hatch if anything mis-paints) |
| `⌘9` | Flip layout: **Free** column ↔ **Terminal** (pack beside & follow the focused terminal) |

> `⌘0` and `⌘9` are **global** while the overlay runs, so they shadow any app-wide bindings on those keys (e.g. zoom-reset). Change them in `overlay/src-tauri/src/lib.rs` if that bites.

---

## Auto-pop on artifact write

Wire a `PostToolUse` hook so the overlay pops whenever Claude writes an `.html` into your artifacts directory. Add to `~/.claude/settings.json` (use the **absolute** path to the script):

```json
{
  "hooks": {
    "PostToolUse": [
      {
        "matcher": "Write|Edit",
        "hooks": [
          { "type": "command", "command": "/abs/path/to/overlay/scripts/companion-hook" }
        ]
      }
    ]
  }
}
```

The watched directory defaults to `$HOME/codeviz/public/artifacts` and is configurable via the **`COMPANION_ARTIFACTS_DIR`** environment variable. The hook cheap-prefilters on that path, never blocks the originating write, and only fires for `*.html`.

---

## Writing artifacts that fit

The overlay can't measure the sandboxed iframe (it's opaque-origin by design), so **each artifact reports its own size**. For a panel to fit perfectly, an artifact should:

1. Mark its main content wrapper with `data-fit-root` (give it a definite width; let height flow).
2. Set a background on `html, body` so any remainder doesn't flash white.
3. Hide the root scrollbar (the overlay clamps tall artifacts to the screen and scrolls them — the bar shouldn't show).
4. Include this snippet at the end of `<body>`:

```html
<style>
  /* Scroll when clamped to a small screen, but never show the bar. */
  html { scrollbar-width: none; }
  html::-webkit-scrollbar { width: 0; height: 0; display: none; }
</style>
<script>
  (function () {
    var el = document.querySelector("[data-fit-root]") || document.body;
    var post = function () {
      parent.postMessage({ source: "companion-artifact", kind: "size",
        w: Math.ceil(el.scrollWidth), h: Math.ceil(el.scrollHeight) }, "*");
    };
    if (typeof ResizeObserver !== "undefined") new ResizeObserver(post).observe(el);
    addEventListener("load", post); post();
  })();
</script>
```

Artifacts that report no size still open at a sensible fallback (≈760×900) and can be resized by hand — they just don't auto-fit. Reference snippets live in `overlay/test-artifacts/`.

---

## Build from source

Requires Rust + Node, on macOS.

```bash
git clone https://github.com/mrgyatso/claude-code-companion.git
cd claude-code-companion/overlay
npm install
npm run tauri build -- --bundles app    # .app in src-tauri/target/release/bundle/macos/
cp -R "src-tauri/target/release/bundle/macos/Companion Overlay.app" ~/Applications/
ln -sf "$PWD/scripts/companion" /usr/local/bin/companion
```

To produce a distributable `.dmg` instead, build the `dmg` target (note: this stages
and then removes the `.app`, so use `--bundles app` separately if you also want to install):

```bash
npm run tauri build -- --bundles dmg    # .dmg in src-tauri/target/release/bundle/dmg/
```

> **Two build traps** (see `HANDOFF.md` §3 for the full story):
>
> 1. **Build with the `custom-protocol` feature** (the `tauri build` path does this for you). Without it, the binary loads `devUrl` instead of the embedded frontend. Frontend changes also need a cargo rebuild — `dist/` is embedded at compile time.
> 2. **Build in a clean env.** If you build from inside another app's `tauri dev` shell, inherited `TAURI_*` / `CARGO_MANIFEST_DIR` / `OUT_DIR` vars steer the build wrong. Strip them:
>    ```bash
>    env -u CARGO_MANIFEST_DIR -u CARGO_MANIFEST_PATH -u OUT_DIR \
>        -u TAURI_DEEP_LINK_PLUGIN_CONFIG -u TAURI_UPDATER_PLUGIN_CONFIG \
>        npm run tauri build -- --bundles dmg
>    ```

---

## How it works

- **Tauri v2 (Rust) + vanilla TypeScript / Vite.** No app framework on the frontend.
- **Trigger:** `tauri-plugin-single-instance` forwards `companion open <path>` to the running daemon, which creates a panel on the main thread.
- **Render:** in-scope artifacts load via `asset:` (real origin, scripts run); out-of-scope paths fall back to reading the bytes in Rust → `iframe.srcdoc` (static content only).
- **Isolation:** the iframe is `sandbox="allow-scripts"` **without** `allow-same-origin` — the artifact runs in an opaque origin and can't reach the overlay's IPC or storage. (This is also why size reporting is done by the artifact, not measured by the host.)
- **Sizing:** artifacts `postMessage` their content size; the host clamps to the monitor work area and tweens `setSize` with `requestAnimationFrame` (Tauri has no native animated resize), morphing the corner radius in parallel.

---

## Project layout

```
claude-code-companion/
├── overlay/                          # the Tauri overlay — the product
│   ├── index.html                    # custom chrome bar (drag region) + sandboxed <iframe>
│   ├── src/
│   │   ├── main.ts                   # load artifact (asset:/srcdoc), chrome, load guard
│   │   ├── resize.ts                 # fit-to-content, animated re-flow, aspect→radius morph
│   │   └── styles.css                # ghostly translucent rounded panel
│   ├── scripts/
│   │   ├── companion                 # CLI: `companion open <file.html>`
│   │   └── companion-hook            # PostToolUse hook: auto-pop on artifact write
│   ├── test-artifacts/               # fit-reporter + size test fixtures
│   └── src-tauri/                    # Rust: window/panel/layout/shortcuts
│       └── src/{lib.rs,windows.rs,macos_panel.rs,layout.rs,artifact.rs}
├── companion-app/                    # earlier MCP-App status board (set aside; reference only)
└── HANDOFF.md                        # full architecture context & history
```

---

## Status & roadmap

In daily use on macOS. Shipped: fit-to-content sizing, frameless transparent panels, `⌘0` toggle, `⌘9` Free/Terminal modes, animated re-flow, drag-to-pin, the close-crash fix, fallback sizing, and the iframe load guard.

Next up:
- **Signing + notarization** (removes the Gatekeeper warning) — the main gate to a clean public release.
- **Apple Silicon native build** alongside the Intel one.
- **Universal fitting** — inject the size reporter for hand-written / third-party HTML that lacks it.
- **Multi-instance focus-following** — bind panels to the terminal that produced them.

---

## License

No license is set yet — treat this as **all rights reserved** for now. If you'd like to use or redistribute it, please open an issue and ask.
