# Companion artifact FEEL — the gold standard ("Broadsheet")

The design point-of-view every Companion artifact follows. Since 0.4.5 there is **one authoring
path**: the working agent writes the HTML inline, in full context (no background observer, no
deterministic renderer). This spec is the **floor** that keeps every artifact reading as one
product — it is *not* a template the agent fills in. Established in the 2026-06-29/30 feel session
(3 directions explored and rendered; the user picked Broadsheet).

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

1. **Dissolve into the board** — `html`/`body` background = the exact board shade `oklch(0.945 0.014 60)`
   (the opaque-origin iframe can't read parent vars — hardcode it). No outer border/shadow; the
   board resizes its window to the artifact's reported size, so the artifact *is* the surface.
2. **One palette, one semantic accent** — board `oklch(0.945 0.014 60)`, paper `#FBFAF6`, ink
   `#171A1F`, soft `#39404A`, muted `#646C76`, hairline `#CDC8BC`; accent ∈ blue `#3D7EFF`, amber
   `#F2B84B`, clay `#D98158`, mint `#4DAA7D` (each with a darker ink variant for text).
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

## Declined for now — the block kit

A prior direction floated turning Broadsheet into *one configuration of a block library* the model
composes from. **Declined (2026-07-08):** now that every artifact is authored inline, the agent
already composes freeform — a formal block kit would add scaffolding that narrows the range and
risks the "wow" of an agent inventing the right presentation for the moment. The invariants above
are the guardrail; the ceiling stays open. Revisit only if inline output proves *too* inconsistent
to read as one product — which the invariants exist to prevent.
