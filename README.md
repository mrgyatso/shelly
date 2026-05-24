# Claude Code Companion

**Claude writes HTML to keep you in the loop. This keeps the HTML in front of you.**

[![Latest release](https://img.shields.io/github/v/release/mrgyatso/claude-code-companion?include_prereleases&sort=semver)](https://github.com/mrgyatso/claude-code-companion/releases)
[![Platform: macOS](https://img.shields.io/badge/platform-macOS-black?logo=apple)](#requirements)
[![Signing: unsigned preview](https://img.shields.io/badge/signing-unsigned%20preview-orange)](#-first-launch-its-unsigned)
[![Downloads](https://img.shields.io/github/downloads/mrgyatso/claude-code-companion/total)](https://github.com/mrgyatso/claude-code-companion/releases)

A **ghostly floating overlay** that renders the HTML artifacts Claude writes — the instant it writes them, right on top of your terminal, without ever stealing your keyboard.

> 💡 *Inspired by Anthropic's [**"Using Claude Code: the unreasonable effectiveness of HTML"**](https://claude.com/blog/using-claude-code-the-unreasonable-effectiveness-of-html) by Thariq Shihipar ([@trq212](https://x.com/trq212)). That post makes the case for HTML; this tool is the surface that makes it effortless.*

---

## The idea

This tool exists because of one observation, made far better in Anthropic's [*"The unreasonable effectiveness of HTML"*](https://claude.com/blog/using-claude-code-the-unreasonable-effectiveness-of-html):

> As Claude takes on more, I'd noticed I was reading plans less closely… the real reason I use HTML instead of Markdown is that it helps me **feel much more in the loop with Claude**.

As agents get more capable, Markdown becomes a restrictive way for them to talk back to you. A hundred-line plan is hard to read; a wall of text invites you to skim and disengage. HTML reverses that. The same output can carry **tables, CSS, SVG illustrations, live code, sliders and toggles, spatial layouts** — and it's instantly shareable and even interactive. You stop reading *about* the work and start *looking at* it. As the post puts it: **"You stay in the loop, but the loop gets much tighter."**

But there's a gap. Once Claude is emitting a *web of HTML files* — brainstorms, mockups, plans, reviews, dashboards — where do they go? Into a folder you forget, or a graveyard of browser tabs. The friction of *finding and opening them* quietly loosens the loop again.

**Claude Code Companion closes that gap.** The moment Claude saves an `.html` artifact, a borderless panel fades in and renders it live — over whatever you're doing, in whatever client you run Claude in (Ghostty, iTerm, VS Code, Desktop). Interactive artifacts actually work; their scripts run. Open several at once and compare them side by side. You never leave your terminal, never hunt for a file, never lose focus. The artifact just *appears* — and the loop stays tight.

---

## Contents

- [The idea](#the-idea)
- [Demo](#demo)
- [What makes it work](#what-makes-it-work)
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
- [Credit & license](#credit--license)

---

## Demo

<!--
  To add the demo video:
    1. Open a new GitHub issue (or edit the latest release) and drag your .mp4/.mov in.
    2. GitHub uploads it and returns a https://github.com/user-attachments/assets/… URL.
    3. Paste that URL on its own line below (plain, no image markdown — GitHub embeds a player).
  Or drop a GIF at assets/demo.gif and use:  ![demo](assets/demo.gif)
-->

> 📹 **Demo video coming soon.** Paste the uploaded video URL here — it shows an artifact popping in the moment Claude writes it, two panels re-flowing so you can compare them, the corner-radius morph, drag-to-pin, and the `⌘0` toggle.

---

## What makes it work

Each capability maps to *why* HTML keeps you in the loop — and removes the friction that would otherwise pull you out of it.

- **The artifact appears on its own.** A `PostToolUse` hook pops the overlay the instant Claude writes an `.html`. No "where did it save that," no opening a file — the work shows up where your eyes already are.
- **Interactive artifacts actually run.** In-scope files load via the `asset:` protocol in a sandboxed iframe, so their inline scripts execute — sliders, toggles, editable fields, SVG, canvases. Two-way artifacts work, not just static markup.
- **Compare side by side.** One panel per artifact; several float at once. Lay six approaches next to each other — the "web of HTML files" the blog describes, all on screen at once.
- **It never breaks your flow.** Each panel is a non-activating macOS `NSPanel` and the app is a Dock-less background daemon, so clicking, scrolling, or dragging a panel leaves your terminal keyboard-focused. The loop tightens; your hands never leave the keyboard.
- **It fits the work, not a fixed box.** Panels size to each artifact's real content, clamp to your screen, re-flow with a smooth animation, and morph their corner radius to the aspect ratio. Tall artifacts scroll on small screens — with no ugly scrollbar.
- **Host-agnostic.** The only trigger is "Claude writes a file and runs a command," so it works the same wherever you run Claude.

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

This is the heart of the tool — the artifact showing up on its own. Wire a `PostToolUse` hook so the overlay pops whenever Claude writes an `.html` into your artifacts directory. Add to `~/.claude/settings.json` (use the **absolute** path to the script):

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

> Pair this with a house rule telling Claude to *prefer HTML artifacts* for plans, comparisons, reviews, and reports, and to write them into that directory. Then the loop runs itself: Claude thinks → writes HTML → it appears in front of you.

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

## Credit & license

The idea is owed to Anthropic's [*"Using Claude Code: the unreasonable effectiveness of HTML"*](https://claude.com/blog/using-claude-code-the-unreasonable-effectiveness-of-html) by Thariq Shihipar ([@trq212](https://x.com/trq212)). This project is just the surface that makes that workflow effortless.

No license is set yet — treat this as **all rights reserved** for now. If you'd like to use or redistribute it, please open an issue and ask.
