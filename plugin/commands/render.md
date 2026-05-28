---
description: Deprecated alias for /html — render an HTML artifact summarising the most recent work, decisions, or status from this conversation
---

**Deprecation note:** `/companion:render` is the deprecated alias of `/html` (top-level). They do the same thing; `/html` is preferred going forward. After rendering, mention briefly to the user that `/html` is the new shorter verb. This alias is kept for one release.

Render a self-contained HTML artifact that summarises the most recent meaningful work, decisions, or status from this conversation. The user has asked for one explicitly — they want to see a visual summary instead of more terminal text. **Render the artifact regardless of the current Companion mode** (this is the user pull verb; it bypasses `agent`/`manual` mode entirely).

**Use the `prefer-html` skill's default shape** — its "The default shape (MANDATORY): brief + a Next steps page" section. For anything substantive, render a **single multi-page artifact that both informs and propels**: content pages wrapped in `data-companion-commentable` (hover any block → 💬 to question it) plus a final **"Next steps" page** — a review form (✓ do it / ✎ note / ✗ skip + **Do all**). One **unified Submit** collects both block-comments and per-item decisions into a single pasteable payload; keep the commentable wrapper OFF the Next-steps page. Copy the self-contained **unified helper** from the `prefer-html` skill ("The default shape" section). Only a genuine one-liner (nothing to question or decide) drops to a small **pill card** (~360px).

Write the file to `${COMPANION_ARTIFACTS_DIR:-~/.claude/companion/artifacts}/<descriptive-kebab-slug>.html`. Use a slug that reflects content (e.g. `status-recap.html`, `design-comparison.html`) — not `render.html`. Writing the file is what pops the overlay; no other action needed.

Include the required `data-fit-root` wrapper (definite width, height flows), the root-scrollbar-hide CSS, the unified comments/decisions helper, and the size-report `postMessage` snippet at the end of `<body>` — see the `prefer-html` skill. The overlay loads artifacts in a sandboxed iframe and cannot measure them, so artifacts must self-report size.

After writing, briefly tell the user what you rendered and the path. If the overlay app/CLI isn't installed and nothing pops, point them to `/companion:doctor` to diagnose.
