---
description: Build and pop an example artifact in the overlay that explains what Companion does
---

Build a real, self-contained **full-document** HTML artifact that explains what the Companion
overlay is and how it works, then write it into the artifacts dir
(`${COMPANION_ARTIFACTS_DIR:-~/.claude/companion/artifacts}/companion-example.html`). Writing the
file is what pops the overlay — no other action needed.

Generate it fresh (don't copy a canned file). Make it look designed — this is the user's first
impression. Cover, briefly and visually:

- **What the overlay is** — a floating, focus-stealing-free window that auto-renders any HTML
  Claude writes, layered over your terminal.
- **How artifacts appear** — Claude writes a self-contained `.html` into the watched dir and the
  overlay pops it. No copy-paste, no browser tab.
- **The cadence** — a small "pill" heads-up for light changes, a full document when the content
  is dense (plans, reviews, diagrams, comparisons).
- **Health check** — `/companion:doctor` renders a health panel in the overlay.

Keep the required `data-fit-root` wrapper (definite width, e.g. 720–960px) and the size-report
snippet so the overlay sizes it correctly. See the `prefer-html` skill for the snippet and
templates.

If, after writing, nothing appears, the app/CLI likely isn't installed — tell the user to install
with `brew install --cask mrgyatso/tap/claude-code-companion`, then run `/companion:doctor` to
diagnose.
