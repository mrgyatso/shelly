# Claude Code Companion

**A floating overlay that renders the HTML artifacts Claude writes, the moment it writes them, on top of your terminal.**

[![Latest release](https://img.shields.io/github/v/release/mrgyatso/claude-code-companion?include_prereleases&sort=semver)](https://github.com/mrgyatso/claude-code-companion/releases)
[![Platform: macOS](https://img.shields.io/badge/platform-macOS-black?logo=apple)](#requirements)
[![Signing: unsigned preview](https://img.shields.io/badge/signing-unsigned%20preview-orange)](#first-launch)
[![Downloads](https://img.shields.io/github/downloads/mrgyatso/claude-code-companion/total)](https://github.com/mrgyatso/claude-code-companion/releases)

Companion watches for the HTML files Claude saves and pops each one into a small floating panel over whatever you're working on. You don't open anything or switch windows. The artifact appears, and your terminal keeps focus.

## Why

This is built on an idea from Anthropic's ["The unreasonable effectiveness of HTML"](https://claude.com/blog/using-claude-code-the-unreasonable-effectiveness-of-html) by Thariq Shihipar ([@trq212](https://x.com/trq212)).

As Claude does more, the plans and reports it writes as Markdown get longer and easier to skim past, and you drift out of the loop. HTML fixes that. The same output can show tables, diagrams, charts, and interactive controls, and it's much nicer to read and share. The post puts it well: "You stay in the loop, but the loop gets much tighter."

The catch is that those HTML files have to live somewhere, and opening them by hand pulls you right back out of the loop. Companion removes that step. Claude writes an artifact, and it shows up in front of you.

## Demo

<!--
  To add the demo video:
    1. Open a new GitHub issue (or edit the latest release) and drag your .mp4/.mov in.
    2. GitHub uploads it and returns a https://github.com/user-attachments/assets/… URL.
    3. Paste that URL on its own line below (plain, no image markdown; GitHub embeds a player).
-->

> Demo video coming soon.

## Features

- Artifacts open on their own, the moment Claude writes one.
- Interactive artifacts work. Their scripts run, so sliders, toggles, and SVG behave as intended.
- Open several at once and compare them side by side.
- Panels never take keyboard focus, so you stay in your terminal.
- Each panel sizes itself to its content and re-flows as you open and close them.
- Artifacts render in a sandboxed frame, isolated from the overlay and the rest of your system.

## Requirements

macOS. The release build is Intel (x86_64) and runs on Apple Silicon under Rosetta 2. Building from source needs Rust and Node 18+.

## Install

1. Download the latest `.dmg` from the [Releases page](https://github.com/mrgyatso/claude-code-companion/releases).
2. Open it and drag Companion Overlay into Applications.
3. Approve it on first launch (see below).
4. Clone this repo and link the CLI so Claude and you can open artifacts:
   ```bash
   ln -sf "$PWD/overlay/scripts/companion" /usr/local/bin/companion
   ```

## First launch

The build isn't signed yet, so macOS will block it the first time ("Companion Overlay can't be opened because Apple cannot check it for malicious software"). Right-click the app in Applications, choose Open, then Open again. If that doesn't work, clear the quarantine flag:

```bash
xattr -dr com.apple.quarantine "/Applications/Companion Overlay.app"
```

You only do this once. A signed build will follow.

## Usage

Open an artifact yourself:

```bash
companion open path/to/artifact.html
```

The daemon stays running and pops panels on demand. Re-opening the same file refreshes its panel. Hover a panel for its controls (reload, open in browser, close), and drag the top edge to move it.

Shortcuts:

- `⌘0` show or hide all panels
- `⌘9` switch between the free column layout and packing beside your terminal

## Auto-pop

The point of the tool is not opening artifacts by hand. Add a `PostToolUse` hook so the overlay pops whenever Claude writes an `.html` file. In `~/.claude/settings.json`:

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

The watched folder defaults to `$HOME/codeviz/public/artifacts` and can be changed with the `COMPANION_ARTIFACTS_DIR` environment variable. Tell Claude to prefer HTML for plans, reviews, and reports, and the loop runs itself.

## Build from source

It's a Tauri v2 (Rust) app with a vanilla TypeScript frontend.

```bash
git clone https://github.com/mrgyatso/claude-code-companion.git
cd claude-code-companion/overlay
npm install
npm run tauri build -- --bundles app
cp -R "src-tauri/target/release/bundle/macos/Companion Overlay.app" ~/Applications/
ln -sf "$PWD/scripts/companion" /usr/local/bin/companion
```

Use `--bundles dmg` to produce a distributable `.dmg` instead.

## Roadmap

- Signing and notarization, to remove the Gatekeeper warning.
- A native Apple Silicon build alongside the Intel one.
- Binding panels to the terminal that produced them, for multiple Claude sessions at once.

## Credit and license

The idea comes from Thariq Shihipar's ["The unreasonable effectiveness of HTML"](https://claude.com/blog/using-claude-code-the-unreasonable-effectiveness-of-html) ([@trq212](https://x.com/trq212)). This project is the surface that makes that workflow effortless.

No license is set yet, so treat this as all rights reserved for now. If you want to use or redistribute it, open an issue and ask.
