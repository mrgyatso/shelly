---
description: Build and pop an example artifact in the overlay that explains what Shelly does
---

Build a real, self-contained HTML artifact that explains what the Shelly overlay is — and
build it in the **combined "brief + Next steps" shape** (the skill's default), so the example
*is* a live demo of the format, not just a description of it. Write it to
`${SHELLY_ARTIFACTS_DIR:-~/.shelly/artifacts}/shelly-example.html`. Writing the
file is what pops the overlay — no other action needed.

Generate it fresh (don't copy a canned file). Make it look designed — this is the user's first
impression. Give it:

- **An informative page (or two)**, wrapped in `data-shelly-commentable` so the user can hover
  any block and click 💬 to ask about it. Cover, briefly and visually: what the overlay is (a
  floating, focus-stealing-free window that auto-renders any HTML Claude writes); how artifacts
  appear (Claude writes a self-contained `.html` into the watched dir → the overlay pops it, no
  copy-paste, no browser tab); the cadence (Claude renders **by judgment** — when a turn has real
  substance — not on every action); and the health check (`/shelly:doctor`).
- **A final "Next steps" page** — a small review form (✓ try it / ✎ note / ✗ skip + **Do all**)
  with a couple of starter actions like "render an example for my current project" or "switch to
  manual mode", so the user's very first artifact teaches the read-then-decide loop.

Use the self-contained **unified helper** from the `prefer-html` skill ("The default shape"
section) for comments + decisions + the single Submit, plus the required `data-fit-root` wrapper
and the size-report snippet. Only drop to a plain pill if the overlay can't be confirmed working.

If, after writing, nothing appears, the app/CLI likely isn't installed — tell the user to install
with `brew install --cask mrgyatso/tap/shelly`, then run `/shelly:doctor` to
diagnose.
