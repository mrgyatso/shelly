# Claude Code Companion

**The desktop app where your coding agents show you what they're doing — and ask you what's next. Read each turn in seconds, answer with a click, and keep as many agents moving as you want.**

[![Latest release](https://img.shields.io/github/v/release/mrgyatso/claude-code-companion?include_prereleases&sort=semver)](https://github.com/mrgyatso/claude-code-companion/releases)
[![Platform: macOS](https://img.shields.io/badge/platform-macOS-black?logo=apple)](#requirements)
[![Platform: Linux](https://img.shields.io/badge/platform-Ubuntu%2FDebian-e95420?logo=ubuntu&logoColor=white)](#requirements)
[![Signing: unsigned preview](https://img.shields.io/badge/signing-unsigned%20preview-orange)](#first-launch)
[![Downloads](https://img.shields.io/github/downloads/mrgyatso/claude-code-companion/total)](https://github.com/mrgyatso/claude-code-companion/releases)

Your agent keeps doing more on its own. In a terminal, that arrives as a wall of scrollback you skim past — and you drift out of the loop. Companion turns every turn into a page you actually read: the plan, the diff, the call it needs from you, laid out to digest at a glance. And it doesn't only show you — it **asks**. Each page ends in the agent's open questions as one-click **✓ / ✎ / ✗** answers that go straight back to it. You move the work forward from the app, and for a lot of turns you never open the terminal at all.

Run one agent or ten — local, or running on a box across the world. They all land on one surface, and each one tells you the moment it needs you, so you switch between them in seconds.

## Demo

![Companion rendering a debugging session as a page you read and answer in the app](docs/images/companion-example.png)

*A real session: Claude tracked down a UI freeze, and Companion rendered its write-up — root cause, a proof chart, and a one-click decision — as a page you read and answer without touching the terminal.*

<!--
  To add the demo video:
    1. Open a new GitHub issue (or edit the latest release) and drag your .mp4/.mov in.
    2. GitHub uploads it and returns a https://github.com/user-attachments/assets/… URL.
    3. Paste that URL on its own line below (plain, no image markdown; GitHub embeds a player).
-->

> Demo video coming soon.

## Why it reads so well

This builds on Anthropic's ["The unreasonable effectiveness of HTML"](https://claude.com/blog/using-claude-code-the-unreasonable-effectiveness-of-html) by Thariq Shihipar ([@trq212](https://x.com/trq212)). The idea: an agent that reports its plans, reviews, and decisions as rich, interactive HTML — tables, diagrams, charts, live controls — instead of walls of Markdown keeps your review loop tight. *"You stay in the loop, but the loop gets much tighter."*

Your agent writes each turn as one of those HTML pages. Companion watches for it and renders it the instant it's written — no file to open, no window to switch to. That's why a turn you'd have skimmed past in scrollback becomes something you read, react to, and answer in place.

## What you do here

- **Read, don't scroll.** Every turn is a page built to digest at a glance — the plan, the diff, the call to make — instead of scrollback you skim past.
- **Answer in the UI.** The agent's open questions and decisions become **✓ do it / ✎ note / ✗ skip** you click; your answer lands straight back with the agent. For decision and question turns, you never touch the terminal.
- **Run the agents themselves.** Start Claude sessions right in the app and type into them whenever you want. They survive restarts and resume where they left off.
- **One home for every agent.** Sessions group by project — two agents in one repo read as a single card — and the home orders them by who needs a decision, so you always know where to look next.
- **Reach agents anywhere.** Connect remote or offsite agents through the optional hub; they appear on the same surface and you answer them the same way.
- **Peek the code.** See the files a session is touching, in a real editor, without leaving the app.
- **Stays out of your way.** It never steals keyboard focus — when you *do* drop to the terminal, it's right beside you.

## Requirements

- **An OS Companion runs on:**
  - **macOS 11 or later.** The release is a universal build that runs natively on both Apple Silicon and Intel.
  - **Ubuntu 22.04+ / Debian 12+** (x86_64 or arm64), on a `.deb` or an AppImage. The app is a WebKitGTK build; the package pulls in what it needs.
- **[Claude Code](https://claude.com/claude-code).**
- **Node 18 or later.** The plugin's hooks are Node scripts. Claude Code now ships as a native binary, so having `claude` does **not** mean you have Node — check with `node -v`.

Starting from a machine with none of that? The installer below sets it all up. Building from source additionally needs Rust.

Two platform differences are worth knowing up front, and both are called out again where they bite: the global shortcuts are `⌘`-chords on macOS but **`Ctrl+Alt`**-chords on Linux, and **Terminal-follow mode is macOS-only** (it reads other windows' bounds, which only macOS exposes). Everything else is the same on both.

## Install

One command, on either platform — from a factory-fresh Mac or a fresh Ubuntu box.

```bash
curl -fsSL https://raw.githubusercontent.com/mrgyatso/claude-code-companion/master/install.sh | bash
```

It detects your platform, checks for Node 18+, Claude Code and the app (plus Homebrew on macOS), offers to install whatever is missing, and then wires the plugin. On macOS it installs the app from the Homebrew cask; on Ubuntu/Debian it pulls the `.deb` for your architecture from the latest release. Everything it does is skipped on a re-run, so it is safe to run twice. Two flags are worth knowing: `--check` reports what is missing and changes nothing, and `--yes` accepts every install without asking (needed when there is no terminal to prompt on).

The one thing it cannot do for you is sign you in — that is a browser login. If Claude Code has never been authenticated, the installer stops, tells you to run `claude` and finish the login, and asks you to run it again. The second run picks up where it left off.

Prefer to read a script before piping it to a shell? [Read it here](install.sh), or download it, then run it:

```bash
curl -fsSL -O https://raw.githubusercontent.com/mrgyatso/claude-code-companion/master/install.sh
less install.sh && bash install.sh
```

<details>
<summary>macOS — already have Homebrew, Node and Claude Code?</summary>

Then it is three commands, and the installer above is doing exactly this for you:

```bash
brew trust mrgyatso/tap          # Homebrew 6+ only; older versions have no `trust`
brew install --cask mrgyatso/tap/claude-code-companion
companion setup
```

Homebrew 6 refuses to load a cask from any non-official tap until you trust it once — the cask runs code at install time (it clears the quarantine flag), and Homebrew now wants you to say so out loud. Skip the first command on Homebrew 6 and the second fails with *"Refusing to load cask … from untrusted tap."*

The second installs the app to `/Applications`, puts the `companion` CLI on your PATH, and clears the macOS quarantine flag. The third wires the app to Claude Code — it adds the plugin marketplace, installs the `companion` plugin, creates the watched folder, and finishes by running `companion doctor` so you can see it worked.

`companion setup` is safe to re-run; every step it has already done is skipped. Restart any `claude` session you had open so it picks up the plugin.

</details>

<details>
<summary>Linux — already have Node and Claude Code?</summary>

Then it is two commands. Grab the `.deb` for your architecture from the [latest release](https://github.com/mrgyatso/claude-code-companion/releases/latest) and install it:

```bash
sudo apt install ./Companion*_amd64.deb   # or _arm64.deb
companion setup
```

`apt` pulls in WebKitGTK and the other system libraries the app links against. The package puts the app on your menu and the `companion` CLI on your `PATH`; `companion setup` then wires it to Claude Code — it adds the plugin marketplace, installs the `companion` plugin, creates the watched folder, and finishes by running `companion doctor` so you can see it worked.

> **Installing a `.deb` older than 0.1.11?** Those packages never linked the CLI onto `PATH`, so `companion setup` comes back `command not found`. Link it once and carry on — or just use the one-command installer above, which does this for you:
> ```bash
> sudo ln -sf "/usr/lib/Companion Overlay/scripts/companion" /usr/bin/companion
> ```

`companion setup` is safe to re-run; every step it has already done is skipped. Restart any `claude` session you had open so it picks up the plugin.

</details>

Two things surprise people on a genuinely clean Mac, and the installer handles both. Homebrew installs to `/opt/homebrew` on Apple Silicon, which is not on `PATH` until you add it. And Claude Code installs to `~/.local/bin`, appending to your shell profile — which does not affect the shell you are already standing in. Install by hand and the next command will not find what you just installed. The same `~/.local/bin` catch applies on Linux.

<details>
<summary>macOS — installing without Homebrew</summary>

1. Download the latest `.dmg` from the [Releases page](https://github.com/mrgyatso/claude-code-companion/releases) and drag Companion Overlay into Applications.
2. The build isn't signed yet, so macOS blocks it the first time ("Companion Overlay can't be opened because Apple cannot check it for malicious software"). Clear the quarantine flag:
   ```bash
   xattr -dr com.apple.quarantine "/Applications/Companion Overlay.app"
   ```
3. Link the `companion` CLI (it ships inside the app):
   ```bash
   ln -sf "/Applications/Companion Overlay.app/Contents/Resources/scripts/companion" /usr/local/bin/companion
   ```
4. Run `companion setup`.

</details>

<details>
<summary>Linux — installing without apt (AppImage)</summary>

Every release also carries an AppImage, which runs on distros the `.deb` doesn't target. It bundles its own libraries, so there is nothing to install:

```bash
chmod +x Companion_Overlay_*.AppImage
./Companion_Overlay_*.AppImage
```

The AppImage does **not** put the `companion` CLI on your `PATH`, and `companion setup` is what wires the plugin to Claude Code — so on this path, extract the CLI once and link it:

```bash
./Companion*.AppImage --appimage-extract >/dev/null
sudo ln -sf "$PWD/squashfs-root/usr/lib/Companion Overlay/scripts/companion" /usr/local/bin/companion
companion setup
```

(The path really does have a capital and a space in it — that is the Tauri product name.)

If your distro has no AppImage support out of the box, install `libfuse2` (Ubuntu 22.04+: `sudo apt install libfuse2`).

</details>

## First launch

**macOS.** The build is not signed or notarized yet, so Gatekeeper blocks it the first time: *"Companion Overlay can't be opened because Apple cannot check it for malicious software."* The Homebrew cask clears the quarantine flag for you. If you installed the `.dmg` by hand, clear it yourself:

```bash
xattr -dr com.apple.quarantine "/Applications/Companion Overlay.app"
```

Signing and notarization are on the [roadmap](#roadmap).

**Linux.** Nothing blocks the app, but two things are worth knowing. The global shortcuts are `Ctrl+Alt`-chords, not `⌘` (GNOME reserves `Super`+digit for the dock). And **on Wayland, the compositor can refuse global shortcuts outright** — if `Ctrl+Alt+0` does nothing, that is why, and it is not a bug you can fix from the app. The tray icon carries every shortcut's action as a menu item, so the app stays fully usable either way. `companion board` also brings it forward from any terminal.

## Using it

Bring the app forward:

```bash
companion board
```

You land on your home — every live session and connected agent, ordered by who needs a decision. Open one to read its latest page, answer its questions right there, and drop back. Start a new session from the home and it runs inside the app; type into its terminal whenever you want to.

The app also runs quietly in the menu bar (macOS) or the system tray (Linux). Its icon shows how many agents need you, and a click gives you the same roster at a glance. The tray menu also carries every shortcut below as a menu item — which is what you fall back on if a shortcut doesn't register.

Shortcuts:

| | macOS | Linux |
|---|---|---|
| Show or hide the app | `⌘0` | `Ctrl+Alt+0` |
| The history of past pages | `⌘8` | `Ctrl+Alt+8` |
| Toggle Free ↔ Terminal mode | `⌘9` | *macOS only* |

Linux uses `Ctrl+Alt` because GNOME reserves `Super`+digit for the dock. Terminal mode docks the column to your focused terminal window and follows it, which needs to read other windows' bounds — only macOS exposes that, so it stays macOS-only. And on Wayland the compositor may refuse global shortcuts entirely; use the tray menu or `companion board`.

## Where your sessions have to run

By default the plugin only acts in terminals **the app itself spawns**. Start a session from the home and everything works. Run `claude` in your own terminal — Terminal or iTerm on macOS, GNOME Terminal or Kitty on Linux — and Companion stays silent by design: that session never joins the home and its pages are never rendered. This keeps agents that aren't using the app from cluttering it.

If you'd rather have *every* session picked up, wherever you start it:

```bash
companion setup --external-terminals
```

To go back to app-spawned sessions only, `rm ~/.claude/companion/external-terminals`. Either way, `companion doctor` tells you which mode you're in. (Remote agents pushing pages through the hub are a separate path and aren't affected by this setting.)

## What the plugin adds

`companion setup` installs it for you. It gives you:

- lifecycle hooks that turn the working agent into the author of these pages — every substantive turn can surface one, with its state and open questions,
- a `prefer-html` skill that shapes those pages (and ends each one in a decision surface you can answer),
- slash commands:
  - `/companion:html` — render a page for the current turn on demand.
  - `/companion:mode selective|always|manual` — how eagerly pages are generated. **selective** (default) renders when a turn is worth it; **always** renders on every substantive turn; **manual** renders nothing until you ask with `/companion:html`.
  - `/companion:doctor` — a health panel, rendered through the same path it verifies.
  - `/companion:example` — an onboarding page that explains the app.

`/companion:render` is the deprecated alias of `/companion:html`, and `/companion:quality` is a legacy no-op kept as app state — since 0.4.5 the working agent authors every page in full context, so there is no renderer left to tune.

The watched folder defaults to `~/.claude/companion/artifacts` (override with `COMPANION_ARTIFACTS_DIR`).

### Wiring it by hand

If you'd rather not use the plugin, add a `PostToolUse` hook in `~/.claude/settings.json`. This renders pages the agent writes, but you don't get the skill, the slash commands, or the session roster — the agent won't know to author pages unless you ask it to.

The hook script ships inside the app bundle, so the path depends on your platform:

| Platform | `companion-hook` lives at |
|---|---|
| macOS | `/Applications/Companion Overlay.app/Contents/Resources/scripts/companion-hook` |
| Linux (`.deb`) | `/usr/lib/Companion Overlay/scripts/companion-hook` |

```json
{
  "hooks": {
    "PostToolUse": [
      {
        "matcher": "Write|Edit",
        "hooks": [
          { "type": "command", "command": "/usr/lib/Companion Overlay/scripts/companion-hook" }
        ]
      }
    ]
  }
}
```

The watched folder defaults to `~/.claude/companion/artifacts` (override with `COMPANION_ARTIFACTS_DIR`).

## Build from source

It's a Tauri v2 (Rust) app with a vanilla TypeScript frontend. Both platforms need [Rust](https://rustup.rs) and Node 18+.

**macOS:**

```bash
git clone https://github.com/mrgyatso/claude-code-companion.git
cd claude-code-companion/overlay
npm install
npm run tauri build -- --bundles app
cp -R "src-tauri/target/release/bundle/macos/Companion Overlay.app" ~/Applications/
ln -sf "$PWD/scripts/companion" /usr/local/bin/companion
```

Use `--bundles dmg` to produce a distributable `.dmg` instead. Add `--target universal-apple-darwin` (with both `rustup target add aarch64-apple-darwin x86_64-apple-darwin`) to build the universal binary that ships in releases.

**Ubuntu/Debian:** the app links against WebKitGTK, so install the system libraries first — a missing one fails the build deep into the Rust compile, not up front.

```bash
sudo apt update && sudo apt install -y libwebkit2gtk-4.1-dev build-essential \
  curl wget file libxdo-dev libssl-dev libayatana-appindicator3-dev librsvg2-dev xdg-utils

git clone https://github.com/mrgyatso/claude-code-companion.git
cd claude-code-companion/overlay
npm install
npm run tauri build          # → .deb + .rpm + AppImage under src-tauri/target/release/bundle/
sudo apt install ./src-tauri/target/release/bundle/deb/*.deb
```

`xdg-utils` is not optional: the AppImage bundler shells out to `xdg-mime` and dies without it — after the `.deb` has already been produced, which makes it look like a late, unrelated failure. `libayatana-appindicator3-dev` is what puts the tray icon in your system tray.

Releases are cut by CI: on a tag push, [`release-linux.yml`](.github/workflows/release-linux.yml) builds the `.deb` and AppImage for amd64 and arm64, and [`release-macos.yml`](.github/workflows/release-macos.yml) builds the universal `.dmg`; all of them are attached to the release.

## Uninstall

The mirror of the installer — one command removes what it set up:

```bash
companion uninstall
```

It removes the plugin and the marketplace wiring, then the app itself — the Homebrew cask on macOS, the `.deb` on Ubuntu/Debian, or the symlinks of a from-source install. Your artifacts and history under `~/.claude/companion` survive by default; add `--purge` to delete those too. It is safe to re-run: anything already gone is reported and skipped.

The flags mirror the installer's: `--check` reports what would be removed and changes nothing, and `--yes` accepts every prompt. One guard worth knowing about: sessions started from the Board run *inside* the app's process, so an uninstall launched from one would kill its own terminal mid-run — the script detects that, refuses, and asks you to quit the app and re-run from a normal terminal (`--force` overrides).

## Roadmap

- Signing and notarization, to remove the Gatekeeper warning.
- Editing code inline in the peek panel, not just reading it.
- Answering more of the loop from the UI, so the terminal becomes optional even more of the time.

## Credit and license

The idea comes from Thariq Shihipar's ["The unreasonable effectiveness of HTML"](https://claude.com/blog/using-claude-code-the-unreasonable-effectiveness-of-html) ([@trq212](https://x.com/trq212)). This project is the surface that makes that workflow effortless.

Licensed under the [MIT License](./LICENSE).
