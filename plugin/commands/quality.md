---
description: Inspect or set the legacy Companion quality flag (fast | pretty) — retained as app state; no longer changes how artifacts are authored
---

**Note (since 0.4.5):** artifacts are now authored **inline by the working agent** in full context.
The background observer that this dial used to tune — its Haiku director, the local Broadsheet
renderer, and the Sonnet designer — were all removed. **This flag no longer changes *how* artifacts
are authored;** quality is now a function of the agent authoring well (see the `prefer-html` skill).
The `fast`/`pretty` value is retained only as app state the Companion overlay reads.

Persisted in `~/.claude/companion/quality` (a single word, `fast` or `pretty`; absent file = `fast`).
It composes with `/companion:mode`.

Parse the argument the user passed after `/companion:quality`:

- **`fast`** — Use the Bash tool to run: `mkdir -p "$HOME/.claude/companion" && echo fast > "$HOME/.claude/companion/quality"`. Report: "Quality → fast (legacy app-state flag; artifacts are authored inline regardless)."
- **`pretty`** — Use the Bash tool to run: `mkdir -p "$HOME/.claude/companion" && echo pretty > "$HOME/.claude/companion/quality"`. Report: "Quality → pretty (legacy app-state flag; artifacts are authored inline regardless)."
- **`status`** (or no argument given) — Use the Bash tool to run: `cat "$HOME/.claude/companion/quality" 2>/dev/null || echo fast`. Report the current value in a single line.

Keep the reply to a single line — this is a state-flip confirmation, not a deliverable. Do not render an HTML artifact for this command, regardless of mode.
