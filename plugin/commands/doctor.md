---
description: Check the Shelly overlay setup and render a self-demonstrating health panel
---

Run `shelly doctor` using the Bash tool and report its output to the user.

`shelly doctor` checks the Shelly overlay installation (app, CLI on PATH, daemon,
PostToolUse hook, artifacts dir, signing), prints a plaintext summary, and renders the same
report as a health panel **inside the overlay** — so if the panel appears, the render path
works end to end.

If the `shelly` command is not found, the app/CLI isn't installed: tell the user to install
with `brew install --cask mrgyatso/tap/shelly` (which also links the CLI onto
PATH and clears the quarantine flag), or download the GitHub release DMG and symlink `shelly`
to PATH, then try again.
