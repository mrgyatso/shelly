---
description: Check the Companion overlay setup and render a self-demonstrating health panel
---

Run `companion doctor` using the Bash tool and report its output to the user.

`companion doctor` checks the Companion overlay installation (app, CLI on PATH, daemon,
PostToolUse hook, artifacts dir, signing), prints a plaintext summary, and renders the same
report as a health panel **inside the overlay** — so if the panel appears, the render path
works end to end.

If the `companion` command is not found, the app/CLI isn't installed: tell the user to install
with `brew install --cask mrgyatso/tap/claude-code-companion` (which also links the CLI onto
PATH and clears the quarantine flag), or download the GitHub release DMG and symlink `companion`
to PATH, then try again.
