# Design brief — the Companion **Live** surface

A brief to hand to a design agent. The goal is to redesign the visual language of
the always-on **Live** pane so it feels like an Anthropic product: **beautiful,
articulate, and simple — a really good app to be in.**

---

## What this surface is

The Live pane is a small, **always-on floating window** that sits over the user's
terminal and reflects the *current state of the work* in real time. It is not a
document and not a popup — it is a calm, persistent companion that updates **in
place** every turn. Think: a living "where are we / what's next" card that's always
glanceable in the corner of the screen.

It shows three things, top to bottom:

1. **`working`** — one line: what we're focused on right now (the hero).
2. **`where`** — a short list of status lines: where things stand.
3. **`next`** — a list of the next decisions, each one **interactive**: the user
   marks each ✓ do it / ✎ note / ✗ skip, optionally types a note, and hits **Submit**,
   which compiles the decisions to the clipboard for one paste back to the agent.

A footer carries the submit affordance: a count ("2 decisions"), a **Do all**, and
**Submit → ⌘V**.

## The feeling to hit

- **Anthropic brand.** Warm, humanist, paper-like. Calm and confident, never loud.
  Tactile but restrained. It should feel like it was made by people who care about
  typography and whitespace.
- **Articulate.** Clear hierarchy through scale and weight, not borders and boxes.
  Nothing extraneous. Every element earns its place.
- **Simple.** Glanceable in under a second. The user should always know *what we're
  on* and *what to decide next* without reading hard.
- **Alive, not jarring.** It updates constantly. Updates should feel like a gentle
  breath — a soft cross-fade as content changes — never a flash or a jump. The whole
  point is that an always-on surface that updates calmly removes the "popup blaring to
  say nothing" problem.
- **"A really good app to be in."** Inviting, warm, low-friction. The user should
  *want* it on screen.

## Brand system (starting point — bring craft, don't just copy)

**Palette** — Anthropic's warm neutrals + clay accent:
- Paper / surface: warm ivory, e.g. `#FAF9F5` / `#F0EEE6` (the card background).
- Ink / text: warm near-black, e.g. `#191919` with a softer `#6B6660` for secondary.
- Accent: the signature clay / terracotta, e.g. `#CC785C` (used sparingly — the live
  pulse, the active decision, the submit-ready state).
- Semantic for decisions: a calm green for "do it", the clay for "note", a muted
  rust/red for "skip" — all desaturated to sit inside the warm palette, not pop out of it.

**This panel floats over a (usually dark) terminal.** A warm ivory card over a dark
backdrop reads beautifully — like a sheet of paper laid on the desk. Use a solid or
near-solid warm background (a subtle backdrop blur is available) with a soft shadow so
it reads as a real, liftable card. (A refined warm-dark variant is acceptable if you
make the case — but light/warm is the default direction.)

**Typography** — Anthropic pairs a geometric sans (Styrene) with a literary serif
(Tiempos). Those are licensed, so use close analogs:
- Display / `working` hero: a literary serif (e.g. Tiempos, Lora, Georgia) for warmth
  and editorial character.
- UI / body / labels: a clean humanist grotesque (system-ui, Inter, or similar).
- Generous line-height, real type scale contrast between the hero and the body.

**Motion** — subtle and compositor-friendly (`transform` / `opacity` only). A soft
fade on content change; a gentle, slow "live" pulse somewhere small (it's *alive*);
considered hover/active states on the decision actions. Nothing bouncy or attention-grabbing.

## Surface anatomy (design each with intent)

- **Header / identity** — minimal. A quiet "Live" mark plus a small, slow pulse that
  signals the surface is watching. A close (✕) affordance, unobtrusive. The header is
  also the **drag handle** — grabbing it moves the window.
- **`working` hero** — the focus line. The largest, warmest type. This is the anchor.
- **`where` list** — 2–5 short status lines. Calm, scannable, low-contrast. Not bullets-
  by-default-template; find a more considered rhythm (hanging indents, hairline ticks,
  a timeline feel — your call).
- **`next` decision cards** — each: a title, an optional sub-line, an optional **kind**
  chip (`decision` / `todo` / `blocked`), and three actions **✓ ✎ ✗**. Marking one
  should feel satisfying and obviously stateful (the card shifts to reflect the choice).
  ✎ reveals an inline note field. These are the heart of the interaction — make them feel
  designed, tactile, and clear.
- **Submit footer** — the count, **Do all**, and **Submit → ⌘V**. Submit should feel
  "ready" (the clay accent) once anything is marked.
- **Idle / empty state** — when there's nothing yet, a calm, warm "nothing on the
  surface yet" — it should feel intentional and serene, never like a broken/empty box.

## Technical contract (so the redesign keeps working)

This pane is **real app HTML/CSS** rendered by `overlay/src/live.ts` into
`overlay/index.html`, styled in `overlay/src/styles.css` — **not** a sandboxed
artifact. You may freely reshape the markup and styling. **Two things are the contract:**

1. **Data shape** stays: `{ working: string, where: string[], next: [{ title, sub?, kind? }] }`.
2. **Interaction model** stays: per-item ✓ do / ✎ note (with a text field) / ✗ skip, a
   Do-all, and a single Submit that batches decisions.

`live.ts` currently builds the DOM with these hooks — **keep them, or change them and
note what changed so we rewire `live.ts` (cheap):**
- Container `#live`; body `#live-body` (content is injected here on each update).
- Footer `#live-foot`, `#live-count`, `#live-doall`, `#live-submit`.
- Header `.live-bar` (this is the `data-tauri-drag-region` drag handle); close `#live-close`.
- Per item: `.live-item[data-state="approve|comment|reject"]`, `.live-item-title`,
  `.live-item-sub`, `.live-chip`, `.live-actions` with `button[data-action="approve|comment|reject"]`,
  and `textarea.live-comment` (hidden until ✎).

**Constraints:** the window is transparent with rounded corners and resizable (so the
content should flow/scroll, not assume a fixed height). Keep motion on `transform`/`opacity`.
No external network assets; bundle any fonts locally or use system stacks.

## Do / don't

- **Do** lead with hierarchy and whitespace; make the `working` hero sing; make marking
  a decision feel good.
- **Do** make updates feel like a calm breath.
- **Don't** ship a generic dark dashboard with uniform cards and borders.
- **Don't** add chrome, gradients-for-decoration, or motion that distracts.
- **Don't** break the data shape or the ✓/✎/✗ → Submit interaction.
