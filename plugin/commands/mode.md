---
description: Set or inspect the Companion artifact mode — agent (background observer) or manual (only on /companion:html)
---

Flip the mode that controls automatic artifacts. **Two modes:**

- **`agent`** (default) — a background Haiku director batches transcript deltas and composes prebuilt Clawd workbench components; visual mockups/variants escalate to an isolated Sonnet designer. The primary Claude session is not interrupted.
- **`manual`** — the observer does not enqueue automatic artifacts. The user pulls artifacts explicitly with `/companion:html`.

Mode is persisted in `~/.claude/companion/mode` (a single word, `agent` or `manual`). Absent file = default `agent`.

Parse the argument the user passed after `/companion:mode`:

- **`agent`** — Use the Bash tool to run: `mkdir -p "$HOME/.claude/companion" && echo agent > "$HOME/.claude/companion/mode"`. Report: "Mode → agent. The background observer will update artifacts after meaningful work. Pull a bespoke artifact any time with `/companion:html`."
- **`manual`** — Use the Bash tool to run: `mkdir -p "$HOME/.claude/companion" && echo manual > "$HOME/.claude/companion/mode"`. Report: "Mode → manual. The background observer is disabled. Use `/companion:html` to pull an artifact any time."
- **`status`** (or no argument given) — Use the Bash tool to run: `cat "$HOME/.claude/companion/mode" 2>/dev/null || echo agent`. Report the current mode in a single line.

Keep the reply to a single line — this is a state-flip confirmation, not a deliverable. Do not render an HTML artifact for this command, regardless of mode.
