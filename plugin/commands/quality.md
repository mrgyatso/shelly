---
description: Set or inspect the Companion artifact quality dial — fast (Haiku director + local renderer) or pretty (Sonnet)
---

Flip the quality/cost dial that controls how the background observer authors artifacts. **Two settings:**

- **`fast`** (default) — the Haiku director batches transcript deltas and the **local Broadsheet renderer** draws routine/composed artifacts with no model at render time; only true visual escalations go to the Sonnet designer. Cheapest and fastest.
- **`pretty`** — "always prefer prettier docs." Raises the **director to Sonnet** for sharper judgment and copy, still rendered through the local Broadsheet template (so it stays fast and consistent). Set the env `COMPANION_QUALITY_SCOPE=all` to instead route *every* artifact through the Sonnet designer as bespoke HTML (higher visual ceiling, slower, costs a full HTML generation per turn).

Quality is persisted in `~/.claude/companion/quality` (a single word, `fast` or `pretty`). Absent file = default `fast`. It is read per-job, so flipping it takes effect on the next artifact without restarting the observer. It composes with `/companion:mode` (mode decides *whether* to author; quality decides *how well*).

Parse the argument the user passed after `/companion:quality`:

- **`fast`** — Use the Bash tool to run: `mkdir -p "$HOME/.claude/companion" && echo fast > "$HOME/.claude/companion/quality"`. Report: "Quality → fast. Haiku director + the local Broadsheet renderer; Sonnet only for true visual escalations."
- **`pretty`** — Use the Bash tool to run: `mkdir -p "$HOME/.claude/companion" && echo pretty > "$HOME/.claude/companion/quality"`. Report: "Quality → pretty. Sonnet director for sharper artifacts, still rendered through the local template. Set COMPANION_QUALITY_SCOPE=all to route everything through the Sonnet designer."
- **`status`** (or no argument given) — Use the Bash tool to run: `cat "$HOME/.claude/companion/quality" 2>/dev/null || echo fast`. Report the current quality in a single line.

Keep the reply to a single line — this is a state-flip confirmation, not a deliverable. Do not render an HTML artifact for this command, regardless of mode.
