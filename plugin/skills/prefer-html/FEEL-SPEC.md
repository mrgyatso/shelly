# Companion artifact FEEL — the gold standard ("Broadsheet")

This is the design point-of-view every agent-authored Companion artifact follows, across all
three authoring paths. It is the spec the prompts and the renderer encode. Established in the
2026-06-29/30 feel session (3 directions explored and rendered; the user picked Broadsheet).

## The one rule

**Make the decision the loudest thing on the page.** A Companion artifact floats over a live
coding agent and its job is to *move the work forward without the user touching the terminal*. So
the single most confident, most-designed element is always the **next move**. Inform, then propel —
never recap and stop.

The old renderer failed this three ways, and the gold standard fixes each:

| Old (failure) | Broadsheet (gold) |
|---|---|
| Floated as a hard card with a drop shadow | **Dissolves into the board canvas** — edge to edge, no chrome |
| Hierarchy flattened after the headline | **Scale contrast** — one dominant headline, everything steps down |
| Decision buried in a pale footer of tiny buttons | **The "Decide" ballot** — elevated, the boldest interaction |

## House style — "Broadsheet"

An editorial page, not a UI card.

- **Dissolve into the board.** `html`/`body` background = the exact board shade `oklch(0.945 0.014 60)`
  (the opaque-origin iframe can't read parent vars, so hardcode it). No outer border/shadow; the
  board resizes its window to the artifact's reported size, so the artifact *is* the surface.
- **Hierarchy through scale.** One Newsreader headline (clamp ~34–60px, letter-spacing ~-.03em)
  earns its size; standfirst, body, labels step down hard.
- **Palette.** board `oklch(0.945 0.014 60)`, paper `#FBFAF6`, ink `#171A1F`, soft `#39404A`,
  muted `#646C76`, hairline `#CDC8BC`. One semantic accent per artifact — blue `#3D7EFF`,
  amber `#F2B84B`, clay `#D98158`, mint `#4DAA7D` — each with a darker ink variant for text.
- **Type.** Newsreader = display/headlines; Inter = reading; JetBrains Mono = kickers, labels,
  edition lines, file chips. Small-caps mono kickers + hairline rules carry the editorial texture.
- **Clawd is the emblem.** The pixel-art clay character lives in the **masthead** (not a parked
  rail mascot), posing to the work. Signature, not wallpaper. Transform/opacity animation only.

### The skeleton (degrades cleanly to a fixed template)

`masthead (Clawd emblem + project + edition) → kicker → dominant headline → standfirst → working
chip → touches (files) → visuals → evidence (collapsible) → **Decide ballot**`

This skeleton is the contract that lets the deterministic local renderer hit the same feel as the
free-form Sonnet designer — the key constraint behind "one product, three paths."

### The Decide ballot (load-bearing)

An elevated panel set off with an accent top-rule and a real "Decide" header. Each move = kind
label + title + one-line detail + generous ~42px tap targets **✓ do / ✎ note / ✗ skip**, plus a
**Do all** and a primary dark **Commit & continue**. One shared comment rides the same submit,
which posts `{source:'companion-artifact',kind:'submit',text}` with clear `✓ Do it / ✎ Note /
✗ Skip` lines. "Spend boldness on one memorable interaction" — this is it.

### Two modes of the same style

- **Steer** (decision-dominant): the recommendation itself becomes the headline with one confident
  primary action; context collapses below. For "just tell me the next move" / lazy-vibecode days.
- **Canvas** (always-on): a persistent steer rail keeps the moves in reach while the user reads —
  the wheel never leaves the screen. For when the user truly lives in the board.

## The three authoring paths (must feel like one product)

| Path | Where | Model | Embodiment |
|---|---|---|---|
| Observer local renderer | `renderer.cjs` (`rendererCss`/`renderArtifact`/`nextSteps`) | none (deterministic) | The Broadsheet skeleton as a fixed template. |
| Observer bespoke designer | `designer.cjs` (`DESIGN_SYSTEM`) | Sonnet | Free-form HTML in the same house style; Steer/Canvas modes. |
| Inline working agent | `prefer-html/SKILL.md` | the live session | Same house style + the unified interaction helper. |

The Haiku **director** (`model.cjs` `SYSTEM_PROMPT`) chooses presentation tier + schema and writes
propulsive `next_steps`; it briefs the designer with the mode (`steer`/`canvas`) when escalating.

## The quality dial

`~/.claude/companion/quality` (sibling of `mode`): `fast` (default) | `pretty`. Read per-job in
`worker.cjs:processGroup`, so flipping it needs no restart. `/companion:quality` flips it.

- **fast** — Haiku director + the local Broadsheet renderer; Sonnet only for true visual escalations.
- **pretty** — raise the **director to Sonnet** (sharper judgment/copy) while still rendering through
  the local template (scope "director"). `COMPANION_QUALITY_SCOPE=all` instead routes *every*
  should_write turn through the Sonnet **designer** as bespoke HTML (higher ceiling, slower, a full
  HTML generation per turn).

Because the fixed template is now genuinely beautiful, **scope "director" is the cheap sweet spot**:
better content rendered through a great template at schema-call cost. See `bench/` for the
Haiku-vs-Sonnet numbers behind the default.

**Default (confirmed by the user, 2026-06-30): `fast`.** The bench reversed the handoff's
pretty-first lean — Haiku on this template is good, ~2–3× cheaper, latency a wash — so `fast` ships
as the default and `pretty` is the one-flag upgrade. The Sonnet **designer** runs at `--effort low`
(medium ran away past the timeout; low is equally on-brand and completes in ~2 min).

## Future directions (user direction, 2026-06-30 — not built this session)

1. **Building blocks, not just templates.** Broadsheet is *one configuration* of a block kit —
   masthead (Clawd emblem), kicker, headline, byline/touches, the registered visuals
   (`components.cjs`), the evidence log, and the **Decide ballot**. The next step is to treat these
   as a first-class **block library** and give the model *both* the full templates *and* the raw
   blocks, letting it decide per-artifact: drop into a full template, or compose a custom
   arrangement from blocks. The free-form designer path is already the "custom" end and the local
   renderer is the "full template" end — formalize a shared block kit so all three paths assemble
   from the same pieces, and the choice of "template vs custom" becomes the model's to make.
2. **Quality / model dial in app settings.** Today the dial is the `~/.claude/companion/quality`
   file + `/companion:quality`. Surface it (and model selection — Haiku/Sonnet/etc.) as a real
   **toggle in the app's settings UI**, alongside the mode dial. This is overlay/app work, separate
   from this plugin session.
