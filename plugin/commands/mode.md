---
description: Set or inspect the Companion artifact mode — agent (auto-render with judgment) or manual (only on /html)
---

Flip the mode that controls when Claude writes HTML artifacts to the overlay. **Two modes:**

- **`agent`** (default) — Claude renders an artifact whenever the `prefer-html` skill's judgment says it would help: recaps after meaningful work, plans before non-trivial implementation, comparisons, status reports. The user can still pull on demand with `/html`.
- **`manual`** — Claude **never** auto-renders. Plain chat replies only. The user pulls artifacts explicitly with `/html`. Right for users who want full control over what appears on the overlay.

Mode is persisted in `~/.claude/companion/mode` (a single word, `agent` or `manual`). Absent file = default `agent`.

Parse the argument the user passed after `/companion:mode`:

- **`agent`** — Use the Bash tool to run: `mkdir -p "$HOME/.claude/companion" && echo agent > "$HOME/.claude/companion/mode"`. Report: "Mode → agent. Claude will auto-render artifacts when the prefer-html skill judges it useful. Pull on demand any time with `/html`."
- **`manual`** — Use the Bash tool to run: `mkdir -p "$HOME/.claude/companion" && echo manual > "$HOME/.claude/companion/mode"`. Report: "Mode → manual. Claude will not auto-render. Use `/html` to pull an artifact any time."
- **`status`** (or no argument given) — Use the Bash tool to run: `cat "$HOME/.claude/companion/mode" 2>/dev/null || echo agent`. Report the current mode in a single line.

Keep the reply to a single line — this is a state-flip confirmation, not a deliverable. Do not render an HTML artifact for this command, regardless of mode.
