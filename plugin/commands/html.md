---
description: Render an HTML artifact summarising the most recent work, decisions, or status from this conversation
---

Render a self-contained HTML artifact that summarises the most recent meaningful work, decisions, or status from this conversation. The user has invoked this verb explicitly — they want a visual summary on the overlay instead of more terminal text. **Render the artifact regardless of the current Companion mode** (this is the user pull verb; it bypasses `agent`/`manual` mode entirely).

**Use the `prefer-html` skill's default shape** — see its "The default shape (MANDATORY): brief + a Next steps page" section. For anything substantive the standing format is a **single multi-page artifact that both informs and propels**:

- **Content pages** — the recap / status / findings / comparison, each wrapped in `data-companion-commentable` so the user can hover any block and click 💬 to question *that line*.
- A final **"Next steps" page** — a review form (✓ do it / ✎ note / ✗ skip per item, plus a **Do all** button) that turns the content into decisions and pushes the work forward.

One **unified Submit** collects *both* the block-comments and the per-item decisions into a single pasteable payload (`— Questions / comments —` then `— Decisions —`). Keep the `data-companion-commentable` wrapper OFF the Next-steps page so the two helpers don't collide. Copy the self-contained **unified helper** straight from the `prefer-html` skill ("The default shape" section).

**The only exception is a genuine one-liner** — a status flip with nothing to question and nothing to decide. Then a small **pill card** (~360px) is the correct finished form. Density decides, but default toward the dual shape whenever there's real substance.

Write the file to `${COMPANION_ARTIFACTS_DIR:-~/.claude/companion/artifacts}/<descriptive-kebab-slug>.html`. Use a slug that reflects content (e.g. `status-recap.html`, `design-comparison.html`) — not `html.html`. Writing the file is what pops the overlay; no other action needed.

Include the required `data-fit-root` wrapper (definite width, height flows), the root-scrollbar-hide CSS, the unified comments/decisions helper, and the size-report `postMessage` snippet at the end of `<body>` — see the `prefer-html` skill for all of these. The overlay loads artifacts in a sandboxed iframe and cannot measure them, so artifacts must self-report size.

After writing, briefly tell the user what you rendered and the path. If the overlay app/CLI isn't installed and nothing pops, point them to `/companion:doctor` to diagnose.
