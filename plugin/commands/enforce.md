---
description: Toggle the prefer-html-enforcer Stop hook on/off (off by default)
---

Toggle the optional `prefer-html-enforcer` Stop hook. The hook is **off by default** — the common case is skill-guided judgment plus `/companion:render` for user-pull. Turn it on only when you want forced rendering at end-of-turn (e.g. walking away from a long task and wanting a wall of artifacts on return).

Parse the argument the user passed after `/companion:enforce`:

- **`on`** — Use the Bash tool to run: `mkdir -p "$HOME/.claude/companion" && touch "$HOME/.claude/companion/enforce.flag"`. Report: "Enforcer ON — Stop hook will block end-of-turn messages that look like deliverables until an HTML artifact is written."
- **`off`** — Use the Bash tool to run: `rm -f "$HOME/.claude/companion/enforce.flag"`. Report: "Enforcer OFF — back to skill-judged cadence + /companion:render."
- **`status`** (or no argument given) — Use the Bash tool to run: `[ -f "$HOME/.claude/companion/enforce.flag" ] && echo ON || echo OFF`. Report the current state.

Keep the reply to a single line — this is a state-flip confirmation, not a deliverable. Do not render an HTML artifact for this command.
