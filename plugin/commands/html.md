---
description: Render an HTML artifact summarising the most recent work, decisions, or status from this conversation
---

Render a self-contained HTML artifact that summarises the most recent meaningful work, decisions, or status from this conversation. The user has invoked this verb explicitly — they want a visual summary on the overlay instead of more terminal text. **Render the artifact regardless of the current Companion mode** (this is the user pull verb; it bypasses `agent`/`manual` mode entirely).

Use the `prefer-html` skill's guidance for **form factor**:

- A small **pill card** (~360px) for a light recap — a status flip, a single decision, a short summary, a "what just changed."
- A **full document** when the content earns it — a plan, a side-by-side comparison, a multi-section status writeup, a review, a diagram. Don't pad to fill space; don't shrink for shrinking's sake. Density decides.

Write the file to `${COMPANION_ARTIFACTS_DIR:-~/.claude/companion/artifacts}/<descriptive-kebab-slug>.html`. Use a slug that reflects content (e.g. `status-recap.html`, `design-comparison.html`, `last-changes.html`) — not `html.html`. Writing the file is what pops the overlay; no other action needed.

Include the required `data-fit-root` wrapper (definite width, height flows), the root-scrollbar-hide CSS, and the size-report `postMessage` snippet at the end of `<body>` — see the `prefer-html` skill for the snippet. The overlay loads artifacts in a sandboxed iframe and cannot measure them, so artifacts must self-report size.

If the content is information the user might want to ask questions about (a recap, briefing, explainer, comparison), **include the ambient-comments helper** so they can hover any block to drop a question. If it's a list of decisions for them to react to per-item, use the interactive review form instead. See the skill for both helpers and the mutual-exclusion note.

After writing, briefly tell the user what you rendered and the path. If the overlay app/CLI isn't installed and nothing pops, point them to `/companion:doctor` to diagnose.
