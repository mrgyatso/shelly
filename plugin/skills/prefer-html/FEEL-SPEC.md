# Companion artifact FEEL — the frame, and Broadsheet as its default look

The design point-of-view every Companion artifact follows. Since 0.4.5 there is **one authoring
path**: the working agent writes the HTML inline, in full context (no background observer, no
deterministic renderer). This spec is the **floor** that keeps every artifact reading as one
product — it is *not* a template the agent fills in. Broadsheet, established in the 2026-06-29/30
feel session (3 directions explored and rendered; the user picked it), is now the **default
look** — one pattern's worth of taste — not the only law. `SKILL.md` carries the full pattern
menu (pill, blob canvas, paginated wizard, sidebar multi-page, two-zone, dashboard); this file
carries the invariants that hold across all of them.

> **Lock the frame, free the interior (2026-07-15).** The owner chose to demote Broadsheet from
> law to *default look* and introduce a **pattern menu**: a short absolute set of invariants
> (below), then a menu of blessed named shapes each with a copy-paste template, then open
> composition inside whichever shape fits. The trigger: a bespoke, characterful artifact was
> destroyed when a reactive skill-load forced a full restyle onto its hard aesthetic mandates.
> The verdict — **lock the frame, free the interior**: the invariants are guardrails, not a
> costume. See `SKILL.md` §1 (the invariants) and §2–3 (the pattern menu).

## The one rule

**Make the decision the loudest thing on the page.** A Companion artifact floats over a live
coding agent and its job is to *move the work forward without the user touching the terminal*. So
the single most confident, most-designed element is always the **next move**. Inform, then propel —
never recap and stop.

Three failure modes it avoids:

| Failure | Broadsheet |
|---|---|
| Floats as a hard card with a drop shadow | **Dissolves into the board canvas** — edge to edge, no chrome |
| Hierarchy flattens after the headline | **Scale contrast** — one dominant headline, everything steps down |
| Decision buried in a pale footer of tiny buttons | **The "Decide" ballot** — elevated, the boldest interaction |

## Strong floor, open ceiling

The agent authors freeform HTML — there is no template engine stamping a fixed layout. The feel is
held by a **small set of invariants**, not by a mold. Hold these; invent everything else.

**The invariants — what makes a bespoke page still read as *Companion*:**

1. **Dissolve into the board — one color at a time across the whole surface.** Default:
   `html`/`body` background = the exact board shade `oklch(0.945 0.014 60)`, ink `#171A1F` (the
   opaque-origin iframe can't read parent vars — hardcode it). No outer border/shadow; the board
   resizes its window to the artifact's reported size, so the artifact *is* the surface.
   **Amended (2026-07-15):** the surface is one color at a time; the app-shade is the default and
   home; an artifact *may* repaint the **whole** surface to a **curated** color, animated by the
   Board. The seam was always the real enemy, not color — so a **partial** repaint (dark card on
   light board) or an **off-palette** page background is still forbidden. Curated shell set
   (bg / ink): paper `#FBFAF6`/`#171A1F`, slate `#E7ECF1`/`#1B2530`, mint `#E6F1EA`/`#16281F`,
   clay `#F3E7DF`/`#2A1C14`, ink `#14181D`/`#E8EDF3`. Full repaint contract: `SKILL.md` §5.
2. **One palette, one semantic accent per page** — board `oklch(0.945 0.014 60)`, paper `#FBFAF6`,
   ink `#171A1F`, soft `#39404A`, muted `#646C76`, hairline `#CDC8BC`; accent ∈ blue `#3D7EFF`,
   amber `#F2B84B`, clay `#D98158`, mint `#4DAA7D` (each with a darker ink variant for text). One
   accent per page is the default discipline; **the blob canvas is the sanctioned multi-color
   pattern** — each blob takes its own palette color used semantically (`SKILL.md` §3.2).
3. **The type pairing** — Newsreader = display/headlines; Inter = reading; JetBrains Mono = kickers,
   labels, edition lines, file chips.
4. **Decision-loudest hierarchy** — the next move is the most-designed thing on the page; everything
   else steps down hard.
5. **The interaction plumbing** — commentable blocks + the Decide ballot + the size/meta snippets
   (the unified helper; see `SKILL.md` and `references/interaction-helper.md`).

**Everything else is yours to invent** — layout, composition, how to show *this* data. When the
content invites a better form, break format; that is the whole point of authoring inline. A block
that merely fills the skeleton is worse than a bespoke one that earns its place. Clawd is the
emblem: the pixel-art clay character lives in the **masthead**, posing to the work — signature, not
wallpaper; transform/opacity animation only.

## A suggested skeleton (a starting point, not a mold)

`masthead (Clawd emblem + project + edition) → kicker → dominant headline → standfirst → working
chip → touches (files) → visuals → evidence (collapsible) → **Decide ballot**`

Follow it when nothing better suggests itself; depart from it when the content wants a different
shape. The invariants above are the contract — the skeleton is only a convenience.

## The Decide ballot (load-bearing)

An elevated panel set off with an accent top-rule and a real "Decide" header. Each move = kind
label + title + one-line detail + generous ~42px tap targets **✓ do / ✎ note / ✗ skip**, plus a
**Do all** and a primary dark **Commit & continue**. One shared comment rides the same submit,
which posts `{source:'companion-artifact',kind:'submit',text}` with clear `✓ Do it / ✎ Note /
✗ Skip` lines. "Spend boldness on one memorable interaction" — this is it.

## Two modes of the same style

- **Steer** (decision-dominant): the recommendation itself becomes the headline with one confident
  primary action; context collapses below. For "just tell me the next move" / lazy-vibecode days.
- **Canvas** (always-on): a persistent steer rail keeps the moves in reach while the user reads —
  the wheel never leaves the screen. For when the user truly lives in the board.

## The block kit (declined) vs. the pattern menu (adopted)

A prior direction floated turning Broadsheet into *one configuration of a block library* the model
composes from. **Declined (2026-07-08):** a formal block kit would add scaffolding that narrows the
range and risks the "wow" of an agent inventing the right presentation for the moment.

**The pattern menu (2026-07-15) is not that block kit — and the distinction matters.** The block
kit was a library of *composable blocks* the model assembles a layout from; it narrows by making
you build from parts. The pattern menu is a set of a few blessed **whole shapes** (pill, blob
canvas, paginated wizard, sidebar multi-page, two-zone, dashboard) each with an **open interior** —
you pick the shape that fits the content, then compose freely inside it. It exists to **harness the
range, not narrow it**: the agent gets a known-good frame instead of inventing from zero (which
drifts) *or* filling one mold (which flattens). The invariants above stay the guardrail; the
ceiling inside each pattern is genuinely open.
