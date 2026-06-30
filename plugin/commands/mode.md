---
description: Set or inspect the Companion artifact mode — manual, selective (default), or always
---

Flip the app-owned mode that controls automatic artifacts. **Three positions:**

- **`selective`** (default) — a background Haiku director batches transcript deltas and *decides* whether the turn is worth an artifact; when it is, it composes prebuilt Clawd workbench components, escalating visual mockups/variants to an isolated Sonnet designer. The primary Claude session is never interrupted. This is the "right artifact at the right time" default.
- **`always`** — the observer writes an artifact on every substantive turn, skipping the director's "is this worth it" veto (it still respects the substantive-turn filter, so it's *always when there's something*, not literally every Stop).
- **`manual`** — the observer enqueues nothing automatically. The user pulls artifacts explicitly with `/companion:html`.

Mode is persisted in `~/.claude/companion/mode` (a single lowercase word). Absent file = default `selective`. (`agent` — inline working-agent authoring — is a reserved fourth position whose machinery isn't built yet; it currently aliases to `selective`.)

Parse the argument the user passed after `/companion:mode`:

- **`selective`** — Use the Bash tool to run: `mkdir -p "$HOME/.claude/companion" && echo selective > "$HOME/.claude/companion/mode"`. Report: "Mode → selective. The background observer decides when work is worth an artifact and surfaces it on the Board. Pull one any time with `/companion:html`."
- **`always`** — Use the Bash tool to run: `mkdir -p "$HOME/.claude/companion" && echo always > "$HOME/.claude/companion/mode"`. Report: "Mode → always. The observer surfaces an artifact after every substantive turn."
- **`manual`** — Use the Bash tool to run: `mkdir -p "$HOME/.claude/companion" && echo manual > "$HOME/.claude/companion/mode"`. Report: "Mode → manual. The background observer is disabled. Use `/companion:html` to pull an artifact any time."
- **`status`** (or no argument given) — Use the Bash tool to run: `cat "$HOME/.claude/companion/mode" 2>/dev/null || echo selective`. Report the current mode in a single line.

Keep the reply to a single line — this is a state-flip confirmation, not a deliverable. Do not render an HTML artifact for this command, regardless of mode.
