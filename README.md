# Claude Code Companion

A **ghostly floating overlay** that renders the HTML artifacts Claude writes —
right on top of your terminal, no matter where you run Claude (Ghostty, VS Code,
Desktop). When Claude saves an `.html` artifact, a borderless panel pops up and
renders it, **without stealing keyboard focus from your terminal**. Open several
at once — each artifact gets its own panel you can drag, resize, and close.

> macOS only for now. This is a personal tool; it is **not yet packaged for
> distribution** (no notarized build / installer — see *Status*).

## What it does

- **Renders any local `.html`** in a sandboxed `<iframe>`; in-scope artifacts load
  via the `asset:` protocol so their own inline/module scripts run (interactive
  artifacts work).
- **One panel per artifact** — several can float at once, each dragged/resized/
  closed independently. Re-opening the same file refreshes its panel in place.
- **Never steals focus** — each panel is a non-activating macOS `NSPanel` and the
  app runs under `ActivationPolicy::Prohibited` (a Dock-less background daemon), so
  clicking/scrolling/dragging a panel leaves your terminal keyboard-focused.
- **Auto-pops** when Claude writes an artifact, via a `PostToolUse` hook.
- **`⌘0`** toggles all panels; **`✕`** closes one.

## Layout

- `overlay/` — the Tauri (Rust) overlay app (**the current product**).
- `companion-app/` — an earlier MCP-App status board (set aside; renders inline in
  Claude Desktop). Kept for reference, not the active direction.
- `HANDOFF.md` — full context, architecture decisions, and history.

## Build & install (from source)

Requires Rust + Node. macOS.

```bash
cd overlay
npm install
npm run tauri build          # release .app + .dmg in src-tauri/target/release/bundle/
cp -R "src-tauri/target/release/bundle/macos/Companion Overlay.app" ~/Applications/
```

Put the launcher on your PATH (it resolves the installed `.app` first):

```bash
ln -sf "$PWD/scripts/companion" /usr/local/bin/companion
```

## Usage

```bash
companion open path/to/artifact.html   # opens a panel (starts the daemon if needed)
```

- The daemon stays alive with no panels open and pops them on demand.
- `⌘0` show/hide all panels · `✕` close a panel.

### Auto-pop on artifact write

Add a `PostToolUse` hook in `~/.claude/settings.json` so the overlay pops whenever
Claude writes an `.html` into your artifacts dir:

```json
{
  "hooks": {
    "PostToolUse": [
      { "matcher": "Write|Edit",
        "hooks": [{ "type": "command",
          "command": "/abs/path/to/overlay/scripts/companion-hook" }] }
    ]
  }
}
```

The watched directory defaults to `$HOME/codeviz/public/artifacts` and is
configurable via the `COMPANION_ARTIFACTS_DIR` environment variable.

## Architecture notes

- **Tauri v2** (Rust) + vanilla TypeScript/Vite frontend.
- **Trigger:** `tauri-plugin-single-instance` forwards `companion open <path>` to the
  running daemon, which creates a panel on the main thread.
- **Render:** in-scope artifacts via `asset:` (own origin, scripts run); out-of-scope
  paths fall back to `read_artifact` → `iframe.srcdoc` (static only).
- **Isolation:** iframe `sandbox="allow-scripts"` without `allow-same-origin` — the
  artifact runs in an opaque origin and can't touch the overlay's IPC or storage.
- Key files: `overlay/src-tauri/src/{lib.rs, windows.rs, macos_panel.rs, artifact.rs}`,
  `overlay/src/main.ts`.

## Status

Working and in daily use on macOS. **Not yet distributable to others:** the build is
unsigned/un-notarized (Gatekeeper would warn on download), the artifacts dir default
and the auto-pop hook still assume this machine's layout, and there's no installer or
Claude Code plugin yet. Those are the remaining steps before a public release.
