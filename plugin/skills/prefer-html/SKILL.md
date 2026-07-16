---
name: prefer-html
description: The Companion artifact pattern library — invariants + copy-paste templates (pill, blob canvas, paginated wizard, sidebar multi-page, two-zone, dashboard) + the interaction helpers (Decide ballot, ambient comments, copy blocks). MANDATORY to read before building any non-trivial artifact (anything past a compact pill) — load it proactively the moment you pick a pattern. The floor (charset, size reporter, answerable responder, shell shade) is also enforced by the always-on session context + the Stop-hook gate; this skill is the single source for *how* to make an artifact good.
---

# Prefer HTML — render what changed in the Companion overlay

The Companion overlay renders any `.html` file written into the artifacts dir. **Every
Companion artifact is authored inline by the working agent** — there is no background observer
and no deterministic renderer (both removed in 0.4.5). You write the file yourself, in full
context; this skill is the single source for *how* to make it good.

**How this skill is organized — read the layer you need:**

1. **The invariants** — the short, absolute frame. Every artifact obeys these. (Loaded for you
   in the always-on session context too; the Stop-hook gate enforces the mechanical floor.)
2. **Pick the pattern** — a content-shape selector. Name the shape before you write.
3. **The pattern menu** — one blessed, copy-paste template per shape.
4. **The interaction layer** — the Decide ballot, ambient comments, copy blocks, the unified
   helper. These compose *into* whichever pattern you picked.
5. **Shell repaint** — the optional whole-surface color capability.
6. **House style — Broadsheet** — the default *look*. One pattern's worth of taste, not a law.
7. **Emit / surface / bundled assets / verify** — the plumbing reference.

**Lock the frame, free the interior.** The invariants in §1 are absolute — they are what keep
every artifact reading as one product. Everything else — which pattern, how you compose inside
it, how *this* data wants to look — is yours to invent. The pattern menu is a set of blessed
*shapes* with open interiors; it exists to harness your range, not narrow it.

---

# 1 · The invariants (the frame — short and absolute)

These hold on every artifact, no exceptions. They are the whole reason a bespoke page still
reads as *Companion*. If a template below ever seems to conflict with one of these, the
invariant wins.

### 1.1 Every turn ends with an artifact

**There is no exemption** — you are never deciding *whether*, only *what shape*. If the user is
in the app, they are here for the artifact; the off switch is which **terminal** they're in
(external terminals are skipped entirely, in the sh wrapper), not a judgment you make turn by
turn. A Stop-hook backstop (`companion-artifact-gate`) hands the turn back once if it ends with
nothing written — but author it inline rather than lean on the reminder.

- **One turn, one artifact — always a fresh slug.** Never rewrite a slug you shipped in an
  earlier turn, even when the same subject advances: the user may still be reading it, and a
  rewrite destroys both that revision and any 💬 comments they typed into it (those live only
  in the iframe DOM, so any reload is total loss). Write a new slug and let it land as its own
  card in the deck — the previous one stays one flip back. *Within* the turn you are free to
  overwrite and edit your own artifact as much as you like; that's authoring, and the user
  hasn't got the terminal back yet.
- **The exception is a living document** — `home.<unit_key>.html`, the per-project digest, is
  meant to be rewritten forever and keeps updating in place.
- **Even "we're done" is an artifact.** Say the work is finished, then hand over the next move —
  *"nothing left here; here's what I'd pick up next, or tell me where to go."* "Nothing to
  decide" is never true: choosing the next piece of work IS the decision.

### 1.2 Size it to the turn

A decision, plan, review or analysis earns a full document. A quick answer or a lookup earns a
**compact pill** — small is the *correct finished form* for a light turn, not a degraded one.
Never pad a thin turn to fill a page; never shrink a substantive one to save space. Density
decides the shape (see §2).

### 1.3 An answerable surface, always

Every artifact — bespoke ones included — ends with a way for the user to respond **in place**,
so they steer without opening the terminal. At minimum a clickable "what's next →"; usually a
short Decide ballot of ✓/✎/✗ moves; on an informational page, the ambient 💬. **A question posed
only as prose is a bug** — wire every question the artifact raises as its own
`data-companion-item` or an ambient 💬 target, so one click answers it. The lone "Message the
terminal" chat bar is a freeform fallback, never the way to answer a question the artifact
itself raised. All responders post the same message to the parent:

```js
parent.postMessage({ source: "companion-artifact", kind: "submit", text: "…" }, "*");
```

**Inform AND propel.** The Companion's job is to move the project toward shipping, not to
recap. So a substantive artifact does two jobs: it informs (findings, status, explanation),
then it **propels** — it ends by proposing the next move with a recommendation and a reason,
asks the sharp questions, and never waits for the user to say what's next. If the goal /
north-star is unclear, **ask for it inside the artifact.** A closing paragraph of prose that
just stops is the failure this exists to prevent.

### 1.4 The plumbing (mechanical floor — the gate checks these)

Five mechanical things every artifact must carry. They are shape-agnostic and appear in every
template below:

- **`<meta charset="utf-8">`** in a real `<head>` — not optional (see §7.2 for why: mojibake).
- **`data-fit-root`** on the main wrapper (definite width, height flows) **+ the size-reporter
  snippet** at the end of `<body>` — the sandboxed opaque-origin iframe can't be measured from
  outside, so the artifact self-reports its size (see §7.3).
- **The `companion-meta` block** in `<head>` — so feedback is self-identifying, even to a later
  session reopening it (see §7.4).
- **`data-companion-commentable` on the content + the unified helper `<script>` pasted verbatim**
  from `references/interaction-helper.md`, plus the §4.2 ambient CSS. §1.3 is only true if the 💬
  actually renders. **The markup alone is inert — the helper is what injects the icons**, so
  shipping one without the other is the single most common way an artifact arrives with nothing
  to click (§4.4). Content in styled `<div>`s (cards, blobs, callouts) is invisible to the
  helper's tag list until you mark it `data-companion-block`.
  *Two shapes are exempt:* the **compact pill** (§3.1 — a status flip has nothing to annotate)
  and the **bespoke dashboard / L0 home** (§3.6 — presentation-first and persistent, not a turn
  artifact; it still carries its own responder per §1.3). Every other shape carries the helper.
- **Write it with the `Write` tool, not `Bash`** — a `PostToolUse(Write|Edit)` hook indexes the
  artifact to your session; a `Bash`-written file lands unsourced (see §7.1).

### 1.5 Decision-loudest editorial (what to show — and what to cut)

An artifact floats over a live agent so the user can **steer without reading the terminal**.
That one job decides everything on the page:

- **Lead with the pending decision or blocker.** Make it the loudest, most-designed element —
  bigger than the recap that justifies it.
- **Show only what is needed to make that decision.** The two facts that matter, not the eight
  that are true.
- **Push evidence down and keep it collapsible.** Logs, diffs, full reasoning — reachable,
  never front-and-center.
- **Cut the transcript.** If a block only narrates what already happened and asks nothing of
  the user, it does not belong. An artifact is triage, not a log.

If you cannot name what the user *learns* from a block or *does* with it, delete the block.

### 1.6 The shell shade (amended: whole surface, one color at a time)

**Default:** set `html, body` background to the exact board shade `oklch(0.945 0.014 60)` and
ink to `#171A1F`. The opaque-origin iframe can't read the parent's vars, so **hardcode the
literal.** No outer card border or page-wide drop shadow; the artifact fills the window edge to
edge — it *is* the surface, with no seam against the board.

**Amended (2026-07-15):** the surface is **one color at a time across the whole thing.** The
app-shade is home and the default. An artifact **may repaint the entire surface** — shell chrome
and iframe together — to a **curated** color, animated by the Board (see §5 for the contract).

**The seam is the enemy, not color.** What is *never* allowed: a **partial** repaint (a
dark card on the light board), or an **off-palette** page background that isn't one of the
curated shell colors. Either creates the seam this rule exists to kill. If you're not using the
§5 repaint contract, stay on the app shade. Full stop.

### 1.7 Type pairing (the house default)

The bundled pairing is the default and carries the identity: **Newsreader** = display/headlines,
**Inter** = reading/body, **JetBrains Mono** = kickers, labels, edition lines, file chips. Load
the faces via the bundled `fonts.css` (see §7.7) with system fallbacks. A pattern may theme
*within* this — but reach past the pairing only for a real reason, not a reflex.

### 1.8 One semantic accent per page (blob canvas exempted)

One artifact, one accent, used with meaning (status/type) — not decoration. Accent ∈ blue
`#3D7EFF`, amber `#F2B84B`, clay `#D98158`, mint `#4DAA7D` (each with a darker ink variant for
text). **The one sanctioned exception is the blob canvas** (§3.2), where each blob takes its own
palette color used semantically — lively, never a clown suite.

---

# 2 · Pick the pattern (the content-shape selector)

**Pattern choice is deliberate. Name the shape to yourself before you write a line.** Match the
turn's *content shape* to a blessed pattern, then compose freely inside it (§3), and layer the
interaction helpers you need (§4) on top.

| The turn is… | Pattern | § |
|---|---|---|
| a quick answer, a status flip, a small fix | **Compact pill** | 3.1 |
| **N independent points / findings** (no single thread) | **Blob canvas** ← *default for this* | 3.2 |
| **one deep sequence** the reader should walk in order | **Paginated wizard** | 3.3 |
| **3+ peer subjects** the reader will jump between | **Sidebar multi-page** | 3.4 |
| prose that needs **one explanatory visual** | **Two-zone** | 3.5 |
| **one narrative argument**, top to bottom | Single scroll (a plain full document) | 3.5 note |
| **presentation-first** — a debrief, a dashboard, a data viz to *look at* | **Bespoke / dashboard** | 3.6 |

**Blob canvas vs. paginated wizard vs. sidebar multi-page** — the three multi-thing shapes, kept
distinct on purpose:

- **Blob canvas** — N *peer points* on one canvas, each a collapsed card you open or skip. Glance
  order is the reader's; triage motion ("this one doesn't need a long look → next").
- **Paginated wizard** — one *guided sequence*; page 1→N with Next/Back, ending on the ballot.
  Use when order matters and you want them to walk it.
- **Sidebar multi-page** — 3+ *substantial peer subjects* (per-project, per-incident) the reader
  jumps between from a sidebar. Use when each subject is a page's worth and there's no through-line.

**Ask two questions:** (1) *How many things?* one → pill/two-zone/scroll; a few peer points →
blob canvas; a guided sequence → wizard; several deep subjects → sidebar. (2) *Act on it, or look
at it?* Act → the pattern carries a Decide ballot. Look → bespoke design, but it **still** carries
a forward-driving responder. The design is yours; the responder never disappears.

---

# 3 · The pattern menu

Each pattern below is a self-contained, copy-paste template that already carries the §1.4
plumbing. Fill it, wire in the §4 helper you need, write it.

## 3.1 · Compact pill

**When:** a light turn — a bug fix, a small edit, a quick lookup, a status flip. This is the
*finished* form for a light change, not a degraded document — don't pad it into a page. But it is
never an inert dead-end: it still names the next move (a recommended action, a one-tap decision,
or the question that unblocks progress). If you can't find a next move, the next move is "what
should I pick up?" — ask it, answerably.

A ~360px self-sizing "what changed" card. Swap the accent color by intent (green = done/fixed,
amber = heads-up/partial, red = broke/blocked):

```html
<!doctype html>
<html lang="en">
<head><meta charset="UTF-8" /><title>changed</title>
<style>
  :root { --accent:#2e7d52; --ink:#1a1714; --muted:#6e655b; --surface:#fff;
    /* board shade — matches the overlay shell so the artifact has no card seam.
       Opaque-origin iframe can't read parent vars, so hardcode the literal. */
    --paper:oklch(0.945 0.014 60); }
  * { box-sizing: border-box; }
  html { scrollbar-width: none; } html::-webkit-scrollbar { display:none; }
  html, body { margin:0; background:var(--paper);
    font-family: ui-sans-serif, system-ui, -apple-system, "Segoe UI", Roboto, sans-serif; }
  [data-fit-root] { width:360px; margin:0 auto; padding:16px 18px; }
  .card { background:var(--surface); border:1px solid rgba(26,23,20,0.12);
    border-left:3px solid var(--accent); border-radius:12px; padding:14px 16px;
    box-shadow:0 12px 30px -20px rgba(26,23,20,0.5); }
  .k { font:700 11px/1 ui-monospace, "SF Mono", Menlo, monospace; letter-spacing:.12em;
    text-transform:uppercase; color:var(--accent); margin-bottom:7px; }
  h1 { font-size:16px; margin:0 0 6px; color:var(--ink); letter-spacing:-0.01em; }
  ul { margin:6px 0 0; padding-left:18px; color:var(--muted); font-size:13px; line-height:1.5; }
  p { margin:0; color:var(--muted); font-size:13px; line-height:1.5; }
</style></head>
<body>
  <main data-fit-root>
    <div class="card">
      <div class="k">changed</div>
      <h1>SHORT WHAT-CHANGED HEADLINE</h1>
      <ul>
        <li>one line per concrete change</li>
        <li>keep it glanceable</li>
      </ul>
    </div>
  </main>
  <script>
    (function () { var el = document.querySelector("[data-fit-root]") || document.body;
      var post = function () { parent.postMessage({ source:"companion-artifact", kind:"size",
        w: Math.ceil(el.scrollWidth), h: Math.ceil(el.scrollHeight) }, "*"); };
      if (typeof ResizeObserver !== "undefined") new ResizeObserver(post).observe(el);
      addEventListener("load", post); post(); })();
  </script>
</body>
</html>
```

The pill is the one pattern where a `companion-meta` block and a full Decide ballot are optional
— a one-tap "what's next →" can be a single item. Everything heavier needs both.

## 3.2 · Blob canvas — the default for N independent points

**When:** the turn is **N independent points, findings, or answers** with no single narrative
thread — a multi-point response, a set of review notes, several answers to several questions.
This is the **default** shape for that content, and it's the one the owner explicitly likes the
look of. Floating colored cards sit on the shell canvas; each is collapsed to a kicker + title +
one-line teaser; the reader **clicks to expand** the ones worth a look and glides past the rest.

**How it works.** A grid of `.blob` cards on the shell background. Each blob carries an accent
via the `--a` custom property (from the palette, used **semantically** — by point type or
status; this is §1.8's sanctioned multi-color exception). Collapsed state = a colored dot, a mono
**kicker**, a serif **title**, and a one-line **teaser**, with a `+` chevron. Click the head to
toggle `.open`: the accent top-rule appears, the chevron rotates to `×`, and the detail body
fades in. A `.wide` blob spans the full row for a headline point. The **Decide ballot** (§4.1)
sits below the canvas — read the blobs, then mark the moves.

**Every blob is 💬-answerable, and that is not optional.** Responding to *one specific point*
is the whole reason this shape exists — a canvas of N points the reader can only answer as a
lump is a broken artifact. Two granularities, and they nest cleanly:

| Target | How it's wired | The reader is saying |
|---|---|---|
| `.blob-head` | `data-companion-block` (a styled div is invisible to the helper's tag list without it) | "about *this point*…" |
| each `<p>` in `.blob-body` | auto-discovered by the `p` in `BLOCK_SELECTOR` | "about *this sentence*…" |

The head and the body are siblings, so the helper's nesting guard leaves both live. Wire
`data-companion-commentable` on `.canvas` — **never** on the ballot below it (§4.3) — and paste
the unified helper. Markup alone is inert: no helper, no icons, no way to answer (§4.4).

```html
<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8" />
<title>blob canvas</title>
<link rel="stylesheet" href="asset://localhost/Users/gyatso/.claude/companion/vendor/fonts.css" />
<script type="application/json" id="companion-meta">
{ "subject": "<short subject>", "summary": "<1–2 sentence description>",
  "files": [], "project": "~/claude-code-companion", "branch": "<branch>", "created": "<YYYY-MM-DD>" }
</script>
<style>
  :root{
    --board:oklch(0.945 0.014 60); --paper:#FBFAF6; --ink:#171A1F; --soft:#39404A;
    --muted:#646C76; --hair:#CDC8BC;
    --blue:#3D7EFF; --clay:#D98158; --mint:#4DAA7D; --indigo:#6D5AE6; --amber:#E0A53A;
    --good:#4DAA7D; --bad:#C0503A;
    --serif:'Newsreader',ui-serif,Georgia,serif;
    --sans:'Inter',ui-sans-serif,system-ui,-apple-system,sans-serif;
    --mono:'JetBrains Mono',ui-monospace,'SF Mono',Menlo,monospace;
  }
  *{box-sizing:border-box}
  html{scrollbar-width:none} html::-webkit-scrollbar{width:0;height:0;display:none}
  html,body{margin:0;background:var(--board);color:var(--ink);
    font-family:var(--sans);-webkit-font-smoothing:antialiased;font-size:15px;line-height:1.6}
  [data-fit-root]{width:900px;max-width:100%;margin:0 auto;padding:34px 40px 46px}

  .masthead{display:flex;align-items:baseline;justify-content:space-between;gap:16px;
    border-bottom:2px solid var(--ink);padding-bottom:10px}
  .brand{font-family:var(--mono);font-size:11px;letter-spacing:.18em;text-transform:uppercase;font-weight:700}
  .edition{font-family:var(--mono);font-size:10.5px;letter-spacing:.08em;color:var(--muted)}
  .kick{font-family:var(--mono);font-size:11px;letter-spacing:.16em;text-transform:uppercase;
    color:var(--indigo);font-weight:700;margin:26px 0 0}
  h1{font-family:var(--serif);font-weight:620;letter-spacing:-.032em;line-height:1.02;
    font-size:clamp(34px,4.6vw,54px);margin:10px 0 0}
  h1 em{font-style:italic}
  .dek{font-size:17px;line-height:1.55;color:var(--soft);margin:16px 0 0;max-width:66ch}
  .dek b{color:var(--ink);font-weight:640}
  .hint{font-family:var(--mono);font-size:11px;color:var(--muted);letter-spacing:.04em;margin:28px 0 12px;
    display:flex;align-items:center;gap:8px}
  .hint::before{content:"▸";color:var(--indigo)}

  /* THE BLOB CANVAS — floating colored cards on the shell */
  .canvas{display:grid;grid-template-columns:1fr 1fr;gap:16px;align-items:start}
  .blob{--a:var(--muted);background:var(--paper);border:1px solid var(--hair);border-radius:16px;
    box-shadow:0 14px 34px -26px rgba(23,26,31,.55);overflow:hidden;transition:box-shadow .16s,transform .16s;
    cursor:pointer}
  .blob:hover{transform:translateY(-2px);box-shadow:0 20px 42px -26px rgba(23,26,31,.6)}
  .blob.wide{grid-column:1 / -1}
  .blob .rule{height:4px;background:var(--a);opacity:0;transition:opacity .18s}
  .blob.open .rule{opacity:1}
  .blob-head{padding:16px 18px;display:flex;gap:13px;align-items:flex-start}
  .dot{flex:0 0 auto;width:12px;height:12px;border-radius:50%;background:var(--a);margin-top:5px;
    box-shadow:0 0 0 4px color-mix(in srgb, var(--a) 16%, transparent)}
  .bh-main{flex:1;min-width:0}
  .bh-kick{font-family:var(--mono);font-size:9.5px;letter-spacing:.12em;text-transform:uppercase;
    font-weight:700;color:var(--a)}
  .bh-title{font-family:var(--serif);font-size:19px;font-weight:620;letter-spacing:-.015em;color:var(--ink);
    margin:3px 0 3px;line-height:1.12}
  .bh-teaser{font-size:12.5px;color:var(--muted);line-height:1.45}
  .chev{flex:0 0 auto;font-family:var(--mono);color:var(--a);font-size:16px;font-weight:700;margin-top:2px;
    transition:transform .2s;width:18px;text-align:center}
  .blob.open .chev{transform:rotate(45deg)}
  .blob-body{display:none;padding:0 18px 18px 43px}
  .blob.open .blob-body{display:block;animation:fade .22s ease both}
  @keyframes fade{from{opacity:0;transform:translateY(-4px)}to{opacity:1;transform:none}}
  .blob-body p{margin:0 0 10px;font-size:13.5px;line-height:1.6;color:var(--soft)}
  .blob-body p:last-child{margin-bottom:0}
  .blob-body strong{color:var(--ink);font-weight:640}
  .blob-body code{font-family:var(--mono);font-size:12px;background:#EEE9DF;padding:1px 5px;border-radius:4px;color:var(--ink)}
  .blob-body .rec{font-family:var(--mono);font-size:11px;letter-spacing:.03em;color:var(--a);font-weight:700;
    margin-top:6px;display:inline-block;border:1px solid var(--a);border-radius:20px;padding:3px 9px}
  /* per-blob palette color — used semantically, one meaning per color */
  .b-blue{--a:var(--blue)} .b-clay{--a:var(--clay)} .b-mint{--a:var(--mint)}
  .b-indigo{--a:var(--indigo)} .b-amber{--a:var(--amber)}

  /* 💬 ON A CARD — the ambient-comment CSS (§4.2) positions the icon in the LEFT GUTTER
     (left:-36px). On a blob that lands outside the card and .blob{overflow:hidden} CLIPS it,
     so the head must anchor its icon INSIDE, just left of the chevron. Paragraphs in
     .blob-body sit 43px in and keep the normal gutter icon — no override needed. */
  .blob-head.companion-commentable{cursor:pointer}
  .blob-head.companion-commentable::before{display:none}       /* gutter hover-bridge: N/A inside a card */
  .blob-head > .companion-ask-btn{left:auto;right:44px;top:14px;transform:none}
  .blob-head.companion-commentable:hover{box-shadow:none;background:rgba(182,120,29,.05)}
  .blob-head.companion-commentable.has-comment{box-shadow:none;background:rgba(46,125,82,.07)}
  .blob-body .companion-composer,.blob-body .companion-annotation{margin-left:0}

  /* DECIDE ballot — sits below the canvas */
  .decide{margin-top:38px;background:var(--paper);border:1px solid var(--hair);border-radius:16px;
    padding:0 24px 22px;box-shadow:0 20px 50px -34px rgba(0,0,0,.6)}
  .decide .top{height:4px;background:var(--indigo);border-radius:16px 16px 0 0;margin:0 -24px 0}
  .decide .dh{font-family:var(--mono);font-size:11px;letter-spacing:.16em;text-transform:uppercase;
    color:var(--indigo);font-weight:700;margin-top:20px}
  .decide h2{font-family:var(--serif);margin:4px 0 2px;font-size:28px;letter-spacing:-.02em}
  .decide .dsub{font-size:14px;color:var(--muted);margin:0 0 6px;max-width:72ch}
  .item{border-top:1px solid var(--hair);padding:15px 0}
  .item-row{display:flex;gap:16px;align-items:flex-start;justify-content:space-between}
  .item-title{font-size:15.5px;font-weight:650;color:var(--ink);letter-spacing:-.01em}
  .item-sub{font-size:13px;line-height:1.5;color:var(--muted);margin-top:4px;max-width:64ch}
  .item-actions{display:flex;gap:7px;flex:0 0 auto}
  .act{width:42px;height:42px;border-radius:10px;border:1px solid var(--hair);background:#fff;font-size:17px;
    cursor:pointer;color:var(--muted);transition:all .12s ease;line-height:1}
  .act:hover{transform:translateY(-1px)}
  .act.do:hover,[data-state=approve] .act.do{background:var(--good);border-color:var(--good);color:#fff}
  .act.info:hover,[data-state=comment] .act.info{background:var(--amber);border-color:var(--amber);color:#3a2f10}
  .act.skip:hover,[data-state=reject] .act.skip{background:var(--bad);border-color:var(--bad);color:#fff}
  [data-state] .item-title::after{font-family:var(--mono);font-size:10px;font-weight:700;margin-left:10px;letter-spacing:.05em}
  [data-state=approve] .item-title::after{content:"✓ DO";color:#2f7d54}
  [data-state=comment] .item-title::after{content:"✎ NOTE";color:#b06a3f}
  [data-state=reject] .item-title::after{content:"✗ SKIP";color:var(--bad)}
  .item textarea{width:100%;margin-top:11px;min-height:54px;resize:vertical;padding:10px 12px;
    border:1px solid var(--hair);border-radius:9px;font:13px/1.5 var(--sans);background:#fff;color:var(--ink);display:none}
  .bar{display:flex;align-items:center;gap:12px;margin-top:20px;padding-top:16px;border-top:2px solid var(--ink)}
  .count{font-size:12.5px;color:var(--muted);flex:1;font-family:var(--mono)}
  .doall{padding:10px 15px;border-radius:9px;border:1px solid var(--hair);background:#fff;color:var(--ink);
    font:640 12.5px var(--sans);cursor:pointer}
  .doall:hover{border-color:var(--good);color:#2f7d54}
  .submit{padding:12px 22px;border-radius:9px;border:1px solid var(--ink);background:var(--ink);color:var(--paper);
    font:660 13.5px var(--sans);cursor:pointer;opacity:.5;transition:opacity .15s}
  .submit.ready{opacity:1}

  @media (max-width:720px){ .canvas{grid-template-columns:1fr} }
</style>
</head>
<body>
<main data-fit-root>

  <div class="masthead">
    <span class="brand">Companion · <!-- project --></span>
    <span class="edition"><!-- edition line · date --></span>
  </div>

  <div class="kick"><!-- one-line kicker --></div>
  <h1>The <em>headline</em> point.</h1>
  <p class="dek">One standfirst paragraph that frames the N points below.</p>

  <div class="hint">Click a card to open it. Skip what you don't need.</div>

  <!-- data-companion-commentable wraps the CANVAS (never the ballot below it) so every
       point is 💬-answerable. Each .blob-head carries data-companion-block — a styled div
       is invisible to the helper's tag list without it. -->
  <div class="canvas" data-companion-commentable>
    <!-- duplicate one .blob per point; give each a semantic palette class (.b-blue etc.) -->
    <div class="blob b-blue" data-blob>
      <div class="rule"></div>
      <div class="blob-head" data-companion-block>
        <span class="dot"></span>
        <div class="bh-main">
          <div class="bh-kick">Point 1 · label</div>
          <div class="bh-title">The point, stated as a claim.</div>
          <div class="bh-teaser">One line the reader sees while collapsed.</div>
        </div>
        <span class="chev">+</span>
      </div>
      <div class="blob-body">
        <p>The detail. <strong>Bold the load-bearing bit.</strong> Use <code>code</code> where it helps.</p>
        <span class="rec">→ the one-line takeaway</span>
      </div>
    </div>

    <div class="blob b-amber wide" data-blob>
      <div class="rule"></div>
      <div class="blob-head" data-companion-block>
        <span class="dot"></span>
        <div class="bh-main">
          <div class="bh-kick">Point N · label</div>
          <div class="bh-title">A headline point spans the full row.</div>
          <div class="bh-teaser">Use .wide for the one that deserves width.</div>
        </div>
        <span class="chev">+</span>
      </div>
      <div class="blob-body">
        <p>Detail for the wide blob.</p>
        <span class="rec">→ takeaway</span>
      </div>
    </div>
  </div>

  <!-- DECIDE -->
  <section class="decide">
    <div class="top"></div>
    <div class="dh">Decide · what to do</div>
    <h2>Where we land</h2>
    <p class="dsub">One line framing the moves.</p>

    <div class="item" data-companion-item
      data-item-label="Imperative label — reads well inside the compiled submit message.">
      <div class="item-row">
        <div>
          <div class="item-title">Short move title</div>
          <div class="item-sub">One line on what it is / why.</div>
        </div>
        <div class="item-actions">
          <button class="act do"   data-action="approve" title="Do it">✓</button>
          <button class="act info" data-action="comment" title="Note">✎</button>
          <button class="act skip" data-action="reject"  title="Skip">✗</button>
        </div>
      </div>
      <textarea data-comment placeholder="A note on this move…"></textarea>
    </div>
    <!-- one .item per move -->

    <div class="bar">
      <span class="count" data-count>nothing marked yet</span>
      <button class="doall" data-doall>✓ Do all</button>
      <button class="submit" data-companion-submit="Decisions">Submit → ⌘V</button>
    </div>
  </section>

</main>

<script>
/* blob expand/collapse — independent of the ballot */
(function(){
  document.querySelectorAll('[data-blob]').forEach(function(b){
    b.querySelector('.blob-head').addEventListener('click',function(){ b.classList.toggle('open'); });
  });
})();
</script>
<!-- THE HELPER — NOT OPTIONAL. This canvas carries BOTH 💬 comments and a Decide ballot,
     so it needs the UNIFIED helper (§4.3): one submit, sectioned comments + decisions.
     Copy the <script> from references/interaction-helper.md VERBATIM — do not retype or
     trim it, and do not substitute a ballot-only script (that is what silently ships a
     canvas with no 💬 on it). Paste it here, plus the ambient-comment CSS from §4.2. -->
<script>
  /* … unified helper from references/interaction-helper.md, verbatim … */
</script>
<script>
  (function () {
    var el = document.querySelector("[data-fit-root]") || document.body;
    var post = function () { parent.postMessage({ source: "companion-artifact", kind: "size",
      w: Math.ceil(el.scrollWidth), h: Math.ceil(el.scrollHeight) }, "*"); };
    if (typeof ResizeObserver !== "undefined") new ResizeObserver(post).observe(el);
    addEventListener("load", post); post();
  })();
</script>
</body>
</html>
```

**Note on the ballot script.** The blob template inlines a compact ballot handler (with a live
count + Do-all) so it stands alone. When an artifact *also* has ambient-commentable prose, don't
run two competing handlers — use the **unified helper** (§4.3) instead, which gathers block
comments *and* item decisions into one submit.

## 3.3 · Paginated wizard — one guided sequence

**When:** the content is **one deep sequence** the reader should walk in order — a step-by-step
plan, a walkthrough, an onboarding flow, a narrative that builds — ending on a decisions /
questions page. This is distinct from the sidebar multi-page (§3.4), which is jump-anywhere; the
wizard is **linear**, with Next/Back and a progress indicator, and the **final page is the Decide
ballot**.

Pure DOM show/hide — **no history API**: the sandboxed iframe is opaque-origin, so `pushState`
throws (same constraint the sidebar template documents). The size-reporter observes
`data-fit-root`, so switching pages changes its height and **re-fires the report automatically**.

```html
<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8" />
<title>wizard</title>
<link rel="stylesheet" href="asset://localhost/Users/gyatso/.claude/companion/vendor/fonts.css" />
<script type="application/json" id="companion-meta">
{ "subject": "<short subject>", "summary": "<1–2 sentence description>",
  "files": [], "project": "~/claude-code-companion", "branch": "<branch>", "created": "<YYYY-MM-DD>" }
</script>
<style>
  :root{
    --board:oklch(0.945 0.014 60); --paper:#FBFAF6; --ink:#171A1F; --soft:#39404A;
    --muted:#646C76; --hair:#CDC8BC; --accent:#6D5AE6; --good:#4DAA7D; --bad:#C0503A; --amber:#E0A53A;
    --serif:'Newsreader',ui-serif,Georgia,serif;
    --sans:'Inter',ui-sans-serif,system-ui,-apple-system,sans-serif;
    --mono:'JetBrains Mono',ui-monospace,'SF Mono',Menlo,monospace;
  }
  *{box-sizing:border-box}
  html{scrollbar-width:none} html::-webkit-scrollbar{width:0;height:0;display:none}
  html,body{margin:0;background:var(--board);color:var(--ink);
    font-family:var(--sans);-webkit-font-smoothing:antialiased;font-size:15px;line-height:1.6}
  [data-fit-root]{width:720px;max-width:100%;margin:0 auto;padding:30px 40px 40px}

  /* progress rail */
  .wz-top{display:flex;align-items:center;justify-content:space-between;gap:16px;
    border-bottom:2px solid var(--ink);padding-bottom:12px}
  .wz-brand{font-family:var(--mono);font-size:11px;letter-spacing:.18em;text-transform:uppercase;font-weight:700}
  .wz-count{font-family:var(--mono);font-size:10.5px;letter-spacing:.08em;color:var(--muted)}
  .wz-progress{height:4px;background:var(--hair);border-radius:3px;margin:14px 0 8px;overflow:hidden}
  .wz-progress > i{display:block;height:100%;width:0;background:var(--accent);border-radius:3px;
    transition:width .28s cubic-bezier(.4,0,.2,1)}

  /* pages */
  .wz-page{display:none}
  .wz-page.active{display:block;animation:wzIn .2s ease both}
  @keyframes wzIn{from{opacity:0;transform:translateY(6px)}to{opacity:1;transform:none}}
  .kick{font-family:var(--mono);font-size:11px;letter-spacing:.16em;text-transform:uppercase;
    color:var(--accent);font-weight:700;margin:22px 0 0}
  h1{font-family:var(--serif);font-weight:620;letter-spacing:-.03em;line-height:1.05;
    font-size:clamp(28px,3.4vw,40px);margin:8px 0 0}
  p{color:var(--soft);line-height:1.6} strong{color:var(--ink);font-weight:640}
  code{font-family:var(--mono);font-size:12px;background:#EEE9DF;padding:1px 5px;border-radius:4px}

  /* nav */
  .wz-nav{display:flex;align-items:center;justify-content:space-between;gap:12px;
    margin-top:26px;padding-top:16px;border-top:1px solid var(--hair)}
  .wz-btn{padding:11px 20px;border-radius:9px;border:1px solid var(--hair);background:#fff;color:var(--ink);
    font:640 13px var(--sans);cursor:pointer;transition:all .12s}
  .wz-btn:hover{border-color:var(--accent);color:var(--accent)}
  .wz-btn[disabled]{opacity:.4;cursor:default;pointer-events:none}
  .wz-btn.next{background:var(--ink);color:var(--paper);border-color:var(--ink)}
  .wz-btn.next:hover{color:var(--paper);opacity:.9}

  /* final decide page */
  .decide .dh{font-family:var(--mono);font-size:11px;letter-spacing:.16em;text-transform:uppercase;
    color:var(--accent);font-weight:700}
  .decide h2{font-family:var(--serif);margin:4px 0 2px;font-size:26px;letter-spacing:-.02em}
  .decide .dsub{font-size:14px;color:var(--muted);margin:0 0 6px}
  .item{border-top:1px solid var(--hair);padding:15px 0}
  .item-row{display:flex;gap:16px;align-items:flex-start;justify-content:space-between}
  .item-title{font-size:15.5px;font-weight:650;color:var(--ink)}
  .item-sub{font-size:13px;line-height:1.5;color:var(--muted);margin-top:4px}
  .item-actions{display:flex;gap:7px;flex:0 0 auto}
  .act{width:42px;height:42px;border-radius:10px;border:1px solid var(--hair);background:#fff;font-size:17px;
    cursor:pointer;color:var(--muted);transition:all .12s;line-height:1}
  .act:hover{transform:translateY(-1px)}
  .act.do:hover,[data-state=approve] .act.do{background:var(--good);border-color:var(--good);color:#fff}
  .act.info:hover,[data-state=comment] .act.info{background:var(--amber);border-color:var(--amber);color:#3a2f10}
  .act.skip:hover,[data-state=reject] .act.skip{background:var(--bad);border-color:var(--bad);color:#fff}
  [data-state] .item-title::after{font-family:var(--mono);font-size:10px;font-weight:700;margin-left:10px}
  [data-state=approve] .item-title::after{content:"✓ DO";color:#2f7d54}
  [data-state=comment] .item-title::after{content:"✎ NOTE";color:#b06a3f}
  [data-state=reject] .item-title::after{content:"✗ SKIP";color:var(--bad)}
  .item textarea{width:100%;margin-top:11px;min-height:54px;resize:vertical;padding:10px 12px;
    border:1px solid var(--hair);border-radius:9px;font:13px/1.5 var(--sans);background:#fff;color:var(--ink);display:none}
  .submit{padding:12px 22px;border-radius:9px;border:1px solid var(--ink);background:var(--ink);color:var(--paper);
    font:660 13.5px var(--sans);cursor:pointer;opacity:.5;transition:opacity .15s}
  .submit.ready{opacity:1}
  .doall{padding:10px 15px;border-radius:9px;border:1px solid var(--hair);background:#fff;color:var(--ink);
    font:640 12.5px var(--sans);cursor:pointer}
</style>
</head>
<body>
<main data-fit-root>

  <div class="wz-top">
    <span class="wz-brand">Companion · <!-- title --></span>
    <span class="wz-count"><span data-wz-now>1</span> of <span data-wz-total>3</span></span>
  </div>
  <div class="wz-progress"><i data-wz-fill></i></div>

  <!-- one .wz-page per step; the LAST page is the Decide ballot -->
  <!-- CONTENT pages are commentable; the decide page below is NOT (§4.3) -->
  <section class="wz-page active" data-wz-page data-companion-commentable>
    <div class="kick">Step 1</div>
    <h1>First step of the sequence.</h1>
    <p>Walk the reader through it. <strong>One idea per page.</strong></p>
  </section>

  <section class="wz-page" data-wz-page data-companion-commentable>
    <div class="kick">Step 2</div>
    <h1>It builds on the last.</h1>
    <p>Order matters here — that's why it's a wizard and not a scroll.</p>
  </section>

  <section class="wz-page decide" data-wz-page>
    <div class="dh">Decide</div>
    <h2>What to do</h2>
    <p class="dsub">The sequence lands on the moves.</p>
    <div class="item" data-companion-item data-item-label="Imperative label for the compiled submit message.">
      <div class="item-row">
        <div><div class="item-title">Move title</div><div class="item-sub">One line.</div></div>
        <div class="item-actions">
          <button class="act do"   data-action="approve" title="Do it">✓</button>
          <button class="act info" data-action="comment" title="Note">✎</button>
          <button class="act skip" data-action="reject"  title="Skip">✗</button>
        </div>
      </div>
      <textarea data-comment placeholder="A note…"></textarea>
    </div>
  </section>

  <div class="wz-nav">
    <button class="wz-btn" data-wz-back disabled>← Back</button>
    <div style="display:flex;gap:10px;align-items:center">
      <button class="doall" data-doall style="display:none">✓ Do all</button>
      <button class="wz-btn next" data-wz-next>Next →</button>
      <button class="submit" data-companion-submit="Wizard decisions" style="display:none">Submit → ⌘V</button>
    </div>
  </div>

</main>

<script>
/* wizard: linear show/hide + progress; no history API (opaque-origin iframe) */
(function(){
  var pages=[].slice.call(document.querySelectorAll('[data-wz-page]'));
  var i=0, last=pages.length-1;
  var back=document.querySelector('[data-wz-back]'), next=document.querySelector('[data-wz-next]');
  var submit=document.querySelector('[data-companion-submit]'), doall=document.querySelector('[data-doall]');
  var fill=document.querySelector('[data-wz-fill]'), now=document.querySelector('[data-wz-now]'),
      total=document.querySelector('[data-wz-total]');
  if(total) total.textContent=pages.length;
  function render(){
    pages.forEach(function(p,n){ p.classList.toggle('active', n===i); });
    if(now) now.textContent=i+1;
    if(fill) fill.style.width=((i+1)/pages.length*100)+'%';
    back.disabled = i===0;
    var onLast = i===last;
    next.style.display  = onLast?'none':'';
    submit.style.display= onLast?'':'none';
    doall.style.display = onLast?'':'none';
  }
  next.addEventListener('click',function(){ if(i<last){i++;render();} });
  back.addEventListener('click',function(){ if(i>0){i--;render();} });
  render();
})();
</script>
<!-- THE HELPER — NOT OPTIONAL. Content pages carry 💬 comments and the last page carries the
     ballot, so this wizard needs the UNIFIED helper (§4.3): one submit, sectioned comments +
     decisions. Copy the <script> from references/interaction-helper.md VERBATIM — a ballot-only
     script silently ships a wizard whose pages cannot be answered. Add the §4.2 ambient CSS too. -->
<script>
  /* … unified helper from references/interaction-helper.md, verbatim … */
</script>
<script>
  (function () {
    var el = document.querySelector("[data-fit-root]") || document.body;
    var post = function () { parent.postMessage({ source: "companion-artifact", kind: "size",
      w: Math.ceil(el.scrollWidth), h: Math.ceil(el.scrollHeight) }, "*"); };
    if (typeof ResizeObserver !== "undefined") new ResizeObserver(post).observe(el);
    addEventListener("load", post); post();
  })();
</script>
</body>
</html>
```

## 3.4 · Sidebar multi-page — several peer subjects, jump anywhere

**When:** the deliverable is **3+ genuinely independent, substantial subjects** that are *peers*
— per-project, per-incident, per-component — with **no single narrative thread** and the reader
will want to **jump**, not read top-to-bottom. *"Audit my whole wiki for loose ends"* (one page
per project), *"review these five incidents"*. Contrast with the **paginated wizard** (§3.3): the
sidebar is jump-anywhere; the wizard is one guided sequence. If there *is* a through-line, use a
single scrolling document with headings instead.

**This is still ONE file.** Multi-page means internal show/hide navigation — *not* multiple
files. That keeps the self-contained rule intact, opens in a browser, pops as a single overlay
panel, and sizes through the same size-report snippet (switching pages re-fires the
`ResizeObserver`, so the panel re-fits to each page).

### When to go multi-page (all three should hold)

1. **≥3 genuinely independent subjects** that are *peers* — with no single narrative thread. If
   there *is* a through-line, a single scrolling document with headings reads better.
2. **Each subject has real substance** — more than a few lines. A two-line subject belongs in the
   Overview, not on its own page.
3. **The reader will want to jump**, not read top-to-bottom.

### Guardrails

- **One file, always.** Internal nav, never N separate files.
- **Lead with an Overview page** — orient the reader, give the count, one line per subject. It's
  the landing page (`.active` on load).
- **Soft cap ~12 pages.** Beyond that, group subjects or summarise the long tail on the Overview
  — don't emit 30 pages.
- **Every content page is 💬-answerable — that is the floor, not a garnish.** Put
  `data-companion-commentable` on each `data-mp-page` and paste the unified helper (§4.3); it
  scans **all** commentable roots, so one helper covers every page. Bump
  `.mp-pages { padding-left: 56px }` so the 💬 icon clears the sidebar.
- **One submit button for the whole file.** The unified helper gathers block-comments *and* any
  ballot items into that single `data-companion-submit` — never wire a second submit per page.

### Sidebar multi-page template (copy, fill, write)

A ~780px file: a sticky sidebar of page links beside a content pane. Pure DOM show/hide
(no history API — the sandboxed iframe is opaque-origin, so `pushState` would throw).
Duplicate a `<section data-mp-page>` + its `<a data-mp-link>` per subject:

```html
<!doctype html>
<html lang="en">
<head><meta charset="UTF-8" /><title>multi-page</title>
<style>
  :root { --accent:#2e7d52; --ink:#1a1714; --muted:#6e655b; --surface:#fff;
    --paper:oklch(0.945 0.014 60); --line:rgba(26,23,20,0.12); }
  * { box-sizing:border-box; }
  html { scrollbar-width:none; } html::-webkit-scrollbar { display:none; }
  html, body { margin:0; background:var(--paper); color:var(--ink);
    font-family: ui-sans-serif, system-ui, -apple-system, "Segoe UI", Roboto, sans-serif; }
  [data-fit-root] { width:780px; margin:0 auto; background:var(--paper);
    display:grid; grid-template-columns:212px 1fr; align-items:start; }
  .mp-nav { position:sticky; top:0; align-self:start;
    padding:20px 14px 22px 18px; border-right:1px solid var(--line); }
  .mp-brand { font:700 11px/1.2 ui-monospace, Menlo, monospace; letter-spacing:.14em;
    text-transform:uppercase; color:var(--accent); margin-bottom:14px; }
  .mp-nav a { display:flex; gap:8px; padding:7px 10px; margin:1px 0; border-radius:7px;
    color:var(--muted); text-decoration:none; font-size:13px; line-height:1.35;
    cursor:pointer; transition:background 120ms, color 120ms; }
  .mp-nav a:hover { background:rgba(26,23,20,0.05); color:var(--ink); }
  .mp-nav a.active { background:var(--ink); color:var(--paper); }
  .mp-nav a .n { min-width:1.3em; opacity:.55; font-variant-numeric:tabular-nums; }
  .mp-pages { padding:26px 30px 32px; min-width:0; }
  .mp-pages > section { display:none; }
  .mp-pages > section.active { display:block; animation:mpIn 180ms ease both; }
  @keyframes mpIn { from{opacity:0; transform:translateY(4px);} to{opacity:1; transform:none;} }
  .kicker { font:600 11px/1 ui-monospace, Menlo, monospace; letter-spacing:.12em;
    text-transform:uppercase; color:var(--accent); margin-bottom:9px; }
  .mp-pages h1 { font-size:21px; margin:0 0 8px; letter-spacing:-0.01em; }
  .mp-pages h2 { font-size:14px; margin:18px 0 6px; }
  .mp-pages p, .mp-pages li { font-size:14px; line-height:1.6; }
  .mp-pages ul { padding-left:18px; }
</style></head>
<body>
  <div data-fit-root>
    <nav class="mp-nav" aria-label="Pages">
      <div class="mp-brand">DOC TITLE</div>
      <a data-mp-link href="#overview" class="active"><span class="n">·</span> Overview</a>
      <a data-mp-link href="#p1"><span class="n">1</span> First subject</a>
      <a data-mp-link href="#p2"><span class="n">2</span> Second subject</a>
      <!-- one <a> per subject -->
    </nav>
    <main class="mp-pages">
      <section id="overview" data-mp-page class="active" data-companion-commentable>
        <div class="kicker">Overview</div>
        <h1>What this covers</h1>
        <p>One short orienting paragraph + the count.</p>
        <ul>
          <li><strong>First subject</strong> — one-line summary.</li>
          <li><strong>Second subject</strong> — one-line summary.</li>
        </ul>
      </section>
      <section id="p1" data-mp-page data-companion-commentable>
        <div class="kicker">Subject 1 of N</div>
        <h1>First subject</h1>
        <p>Real substance for this subject.</p>
      </section>
      <section id="p2" data-mp-page data-companion-commentable>
        <div class="kicker">Subject 2 of N</div>
        <h1>Second subject</h1>
        <p>Real substance for this subject.</p>
      </section>
      <!-- one <section> per subject — each one data-companion-commentable -->
    </main>
  </div>
  <script>
    (function () {
      var links = [].slice.call(document.querySelectorAll("[data-mp-link]"));
      var pages = [].slice.call(document.querySelectorAll("[data-mp-page]"));
      function show(id) {
        var hit = false;
        pages.forEach(function (p) { var on = p.id === id; p.classList.toggle("active", on); if (on) hit = true; });
        links.forEach(function (a) { a.classList.toggle("active", a.getAttribute("href") === "#" + id); });
        if (!hit && pages[0]) { pages[0].classList.add("active"); if (links[0]) links[0].classList.add("active"); }
      }
      links.forEach(function (a) {
        a.addEventListener("click", function (e) { e.preventDefault(); show(a.getAttribute("href").slice(1)); });
      });
    })();
    (function () {
      var el = document.querySelector("[data-fit-root]") || document.body;
      var post = function () { parent.postMessage({ source: "companion-artifact", kind: "size",
        w: Math.ceil(el.scrollWidth), h: Math.ceil(el.scrollHeight) }, "*"); };
      if (typeof ResizeObserver !== "undefined") new ResizeObserver(post).observe(el);
      addEventListener("load", post); post();
    })();
  </script>
  <!-- THE HELPER — NOT OPTIONAL. One helper covers every page (it scans all commentable roots).
       Copy the <script> from references/interaction-helper.md VERBATIM, plus the §4.2 ambient CSS.
       Without it the pages are marked up but inert: no 💬, nothing to answer (§4.4). -->
  <script>
    /* … unified helper from references/interaction-helper.md, verbatim … */
  </script>
</body>
</html>
```

## 3.5 · Two-zone — prose plus one explanatory visual

**When:** a substantive full-document turn has real substance to *explain* and one genuinely
useful visual would help the reader understand it and decide — a triage, a plan, a comparison, an
explainer. The most common waste in a full-document artifact is a single narrow column of prose
running top-to-bottom while the **entire right half of the Board sits empty**. Don't. Default to
a **two-zone layout**: prose on the left, a **useful visual on the right**.

> **Single scroll (a plain full document).** When the turn is *one narrative argument* with no
> single visual to anchor — a post-mortem, a long explanation — a plain full document is right:
> your own layout and sections, `data-fit-root` on the main wrapper with a definite width
> (720–960px), the size-report snippet, and ambient comments (§4.2) so the prose is answerable.
> Two-zone is the *default when there's a visual*; single scroll when there isn't.

**The visual must earn its place.** It illustrates what the prose is arguing — a flow diagram of
the bug, a before/after, a tree of options, a data chart. **Never decorative filler** (no stock
gradients, abstract blobs, or a logo to "balance" the layout). If you can't name what a reader
learns from the visual, leave the column out and go single-column.

**Pick the visual medium by what it is:**
- **Diagrams / flows / relationships / before-after** → hand-author an inline **SVG** (no
  dependency, crisp, themeable). This covers most cases.
- **Quantitative data** → **D3** (bundled — see §7.7) for charts/graphs.
- **Rich illustrative figures** a diagram can't capture (a scene, a textured concept image,
  a realistic mock) → generate one with **gpt image-2**, save it into the artifacts dir
  (e.g. `~/.claude/companion/artifacts/img/<slug>-<n>.png`), and reference it via the
  `asset:` protocol (external URLs are blocked in the sandbox):
  ```html
  <img src="asset://localhost/Users/gyatso/.claude/companion/artifacts/img/<slug>-1.png"
       width="360" alt="<what it shows>" />
  ```
  Always set an explicit `width`/`height` and a real `alt`. Generate sparingly — one
  purposeful figure beats three pretty ones.

### Two-zone template (copy, fill, write)

`data-fit-root` stays a block wrapper; the two-zone grid is its own element so the unified
helper's auto-injected `.cmp-chat` bar (which targets `data-fit-root`) lands full-width
below. The right column is `position:sticky` so it stays beside the prose as the left
scrolls. The left column carries `data-companion-commentable`; the visual does not.

```html
<main data-fit-root> <!-- width ~860–900px to actually use the space -->
  <header>…kicker + h1 + sub…</header>
  <div class="zone">
    <div class="col-main" data-companion-commentable>
      <h2>…</h2><p>…prose that the visual illustrates…</p>
    </div>
    <aside class="visual"><!-- sticky card -->
      <svg viewBox="0 0 320 240" width="100%"> … </svg>
      <div class="cap">One line on what the figure shows.</div>
    </aside>
  </div>
  <!-- Next-steps decision section spans full width below the zone -->
</main>
<style>
  .zone { display:grid; grid-template-columns:1fr 360px; gap:26px; align-items:start; }
  .visual { position:sticky; top:16px; }
  @media (max-width:720px){ .zone{ grid-template-columns:1fr; } } /* graceful narrow fallback */
  /* the 💬 sits at left:-36px — give the prose column room so it isn't clipped */
  .col-main { padding-left: 40px; }
</style>
<!-- THE HELPER — NOT OPTIONAL. data-companion-commentable above is inert markup on its own:
     it is the helper that injects the 💬 icons. Copy the <script> from
     references/interaction-helper.md VERBATIM, plus the §4.2 ambient CSS. -->
<script>
  /* … unified helper from references/interaction-helper.md, verbatim … */
</script>
```

Reach for two-zone on any substantive full-document turn (a triage, a plan, a comparison,
an explainer). Skip it for pills, pure dashboards (§3.6), and turns with nothing worth
visualizing.

## 3.6 · Bespoke dashboard / L0 (`home.html`)

**When:** the content is **presentation-first** — a morning debrief, a dashboard, a data viz, a
recap or explainer to *look at beautifully*, a celebration, a one-off custom interface. Here the
layout and feel are yours to craft; a rigid template on a debrief is worse than a bespoke one.
**But bespoke does NOT license shipping without a responder** — even a dashboard carries a
forward-driving surface where the next moves live (§1.3). *Ask: act on it, or look at it?* Look →
bespoke design; act → one of the ballot-carrying patterns above.

The Board (`companion board`) opens to an **L0 hub** that an agent fully authors: write a
self-contained dashboard to the **reserved slug** `home.html` in the artifacts dir
(`~/.claude/companion/artifacts/home.html`). The Board loads it **full-bleed** as the L0
surface — it does NOT auto-pop as a panel (the hook skips it), and you re-see it by opening
the Board, not via `companion open`. Think of it as a **daily dashboard**: regenerate it for
whatever the user is actually working on that day — what needs them, what's running, the one
thing that matters most.

### The top bar is the Board's, themed by you (`companion-bar` block)

The Board renders a persistent top bar across the whole surface. At L0 it is **themed and
filled by your dashboard** so it matches your design; the **mandatory control cluster**
(back / full-screen / collapse / close) is always rendered by the Board — you never draw or
declare those, they can't go missing. You compose the bar's *content + colors* via a JSON
block in `home.html`'s `<head>`:

```html
<script type="application/json" id="companion-bar">
{
  "bg": "#efe9df", "fg": "#201b15", "accent": "#b0552f",
  "font": "Newsreader",
  "left":   [{ "type": "title", "text": "Tuesday triage" }],
  "center": [{ "type": "clock" }],
  "right":  [{ "type": "badge", "text": "3 need you", "tone": "accent" }]
}
</script>
```

- **Theme keys:** `bg`, `fg`, `accent` (hex), `font` (`"Newsreader"` | `"Inter"` |
  `"JetBrains Mono"`). **Set `bg`/`fg` to match your dashboard body** — the bar lives outside
  your iframe, so it can't inherit your CSS; if you don't pass colors it won't match.
- **Slots:** `left`, `center`, `right` — arrays of items the Board renders + wires:
  - `{"type":"title","text":"…"}` — display title (uses `font`)
  - `{"type":"clock"}` — live HH:MM, Board-updated
  - `{"type":"badge","text":"…","tone":"accent"|"default"}` — a pill (e.g. a count)
  - `{"type":"text","text":"…"}` — muted label
  - `{"type":"link","text":"…","to":"sessions"|"unit:<key>"|"hub"|"artifact:<path>"}` —
    navigates the Board (`session:<src>` still works as a back-compat alias → its unit)
- **Rule:** if you set `companion-bar`, **do NOT draw your own header in the body** — the
  Board's bar is your header. Start the body at the content.

Without a `companion-bar` block the Board shows its native greeting. The theming applies at
**L0 only**; L1 (sessions) and L2 (one session) use native chrome.

### Navigation from inside the dashboard

Any element can drive the Board by posting a navigate message to the parent — this is how
the dashboard links to sessions, and how it stays *inside* the Board (no separate windows):

```js
parent.postMessage({ source: "companion-artifact", kind: "navigate",
  to: "unit:scalp-defense" }, "*");   // or "sessions" | "hub" | "artifact:<abs-path>"
```

### Editorial, NOT a grid (read this before you lay it out)

The single most common failure here is defaulting to a **uniform card grid** — N equal tiles,
equal spacing, no hierarchy. Don't. A dashboard with a point of view reads like an editorial
front page, not a spreadsheet:

- **Give the one thing that matters most real weight** — large type, a hero block — and let
  the rest recede. Scale contrast *is* the triage.
- **Use a list, not cards, for "the rest."** Rows with a thin colored rule carry a roster far
  better than a wall of identical boxes.
- **Vary rhythm** — whitespace, asymmetry, a center of gravity. Uniform padding everywhere is
  the tell of a template.
- Idle / low-priority items collapse to **chips or a single line**, not full cards.

(This applies to any artifact, but dashboards are where the grid reflex is strongest — see
the design-quality rules: *default card grids with uniform spacing and no hierarchy* are
explicitly banned.) Pair this with the bundled fonts (§7.7) — real type is half of looking
intentional.

---

# 4 · The interaction layer

The responders below compose *into* whichever pattern you picked in §3. Pick by what the artifact
is: a decision list → the **Decide ballot / review form** (§4.1); an informational page the user
might question → **ambient comments** (§4.2); an artifact that carries *both* → the **unified
helper** (§4.3). Copyable handoff content → a **copy block** (§4.4), which coexists with any of
them.

## 4.1 · The Decide ballot / interactive review form

When the artifact is a **list of N items the user might react to individually** —
implementation plans, todo lists, code-review checklists, decision sets, comparison
options — reach for the **interactive review form**. Each item gets inline action
buttons (approve / comment / reject). The user marks items as they read, optionally
types a free-text comment under any item, and clicks a single Submit button. The
overlay compiles all decisions into one coherent prose message and writes it to the
system clipboard. The user pastes the result into the terminal — one paste, the whole
review batched.

**Reach for this form** for: implementation plans (3+ steps), prioritised todo lists,
plan-mode review handoffs, multi-option comparisons where each option needs its own
verdict, "things I noticed" review checklists. **Default to it** whenever an artifact is
effectively a list of 3+ decisions — the user shouldn't have to ask. But the bar is lower than
"3+": **almost every substantive artifact ends with at least one answerable next-move item**,
even a single "ship it?" or a "done — what's next →" on a recap. **Skip it** for: pure recaps
(use ambient comments), dashboards, status snapshots without per-item decisions.

### Item HTML shape

Each reviewable item is a `<li>` (or any element) marked with `data-companion-item`
and a `data-item-label` describing what the item is, in a way that will read
naturally inside the compiled submit message:

```html
<li data-companion-item data-item-label="Wire the postMessage handler in resize.ts">
  <div class="item-row">
    <span class="item-label">Wire the postMessage handler in resize.ts</span>
    <div class="item-actions">
      <button class="act" data-action="approve" aria-label="Approve">✓</button>
      <button class="act" data-action="comment" aria-label="Comment">✎</button>
      <button class="act" data-action="reject"  aria-label="Reject">✗</button>
    </div>
  </div>
  <textarea data-comment hidden placeholder="Comment on this item…"></textarea>
</li>
```

`data-item-label` is what goes into the compiled output — and it's the **only** text that
reaches the agent, so phrase it as an **imperative** ("Wire the handler…"), never a yes/no
question. The visible item content can be richer (sub-text, code spans, links) — only the label
string is sent.

### Submit button

One Submit button per artifact, with `data-companion-submit` set to the title that
prefixes the compiled message:

```html
<button class="submit" data-companion-submit="Implementation plan review">
  Submit feedback
</button>
```

### Required review helper snippet

This script handles click delegation (sets `data-state` on items, toggles textarea
visibility), and on submit walks all items to compose the prose message and
postMessage it. Include it in addition to (not instead of) the size-reporter
snippet — the review helper is opt-in, the size-reporter is required for every
artifact:

```html
<script>
  (function () {
    var GLY = { approve: "✓", comment: "✎", reject: "✗" };

    // Click delegation: action buttons set data-state on the parent item;
    // clicking the same action again toggles it off. Comment shows textarea.
    document.addEventListener("click", function (e) {
      var btn = e.target.closest("[data-action]");
      if (btn) {
        var item = btn.closest("[data-companion-item]");
        if (!item) return;
        var action = btn.getAttribute("data-action");
        var current = item.getAttribute("data-state");
        var ta = item.querySelector("textarea[data-comment]");
        if (current === action) {
          item.removeAttribute("data-state");
          if (ta) ta.style.display = "none";
          return;
        }
        item.setAttribute("data-state", action);
        if (ta) ta.style.display = (action === "comment") ? "block" : "none";
        if (action === "comment" && ta) setTimeout(function () { ta.focus(); }, 0);
        return;
      }
      var submitBtn = e.target.closest("[data-companion-submit]");
      if (submitBtn) {
        var title = submitBtn.getAttribute("data-companion-submit") || "Review feedback";
        var items = document.querySelectorAll("[data-companion-item][data-state]");
        if (items.length === 0) return;
        var lines = ["Re: " + title, ""];
        items.forEach(function (it) {
          var state = it.getAttribute("data-state");
          var label = it.getAttribute("data-item-label") || "(unlabeled)";
          lines.push(GLY[state] + " " + label);
          if (state === "comment") {
            var t = it.querySelector("textarea[data-comment]");
            if (t && t.value.trim()) {
              t.value.trim().split("\n").forEach(function (l) { lines.push("   " + l); });
            }
          }
        });
        parent.postMessage({
          source: "companion-artifact",
          kind: "submit",
          text: lines.join("\n")
        }, "*");
      }
    });
  })();
</script>
```

### Compiled output shape

The submitted message follows a deterministic shape so Claude can parse it cleanly
when the user pastes it back in. For a 5-item review:

```
Re: Implementation plan review

✓ Item 1 label
✓ Item 2 label
✎ Item 3 label
   user's free-text comment, multi-line preserved
✗ Item 4 label
✎ Item 5 label
   another comment
```

### Minimal CSS guidance

Avoid the template-y look. Action buttons should:

- Be small icon-only inline buttons (✓ ✎ ✗ glyphs are fine; aria-labels carry the meaning).
- Tint per-state via `[data-state="approve|comment|reject"]` on the item — e.g. coloured
  left border + filled active button. Subtle, not loud.
- Reveal the textarea inline under the item (not as a modal) when comment is selected.
- **Keep the comment textarea hidden by default** (`display:none`), revealed only on ✎.
  GOTCHA: a rule like `.item textarea { display:block }` overrides the `hidden` attribute
  and leaves the box always-open — which makes ✎ look dead and lets typed text be dropped
  on submit (the item never gets `data-state="comment"`). The helper now toggles
  `style.display` inline (and force-hides on load) so this can't bite, but don't author a
  default-visible textarea anyway.

The whole artifact should still pass the [design-quality](../../../README.md) bar —
this is not a stock todo widget.

## 4.2 · Ambient inline comments (let the user ask about any block)

The review form above asks *"do you approve / reject / comment on these specific
items?"*. Sometimes the artifact isn't a decision form at all — it's an
informational artifact (a recap, a status report, a design dossier, an explainer)
and the user might still have a question about some specific part of it. The
**ambient comments helper** turns every paragraph, heading, list item, code block,
and blockquote in the artifact into a hover-revealed comment target. The artifact
*looks like a normal report*; on hover, a small 💬 icon appears in the gutter next
to each block. Click it to drop an inline comment composer, type, save. Submit
compiles every comment with its quoted snippet into prose and copies it.

**Reach for this form** for any informational artifact where you want to lower the
threshold for "the user wants to ask about one specific paragraph but doesn't want
to retype it" — recaps, status briefings, explainers, comparisons-as-prose,
research summaries, post-mortems. **Don't combine** it with the interactive review
form in the same artifact — both helpers respond to the same `data-companion-submit`
button and would write competing payloads to the clipboard. When an artifact needs both,
use the **unified helper** (§4.3) instead. Otherwise pick one per artifact.

### Convention

Wrap the readable content in a `<div data-companion-commentable>` and include the
helper snippet below. The helper auto-discovers `p, li, h2, h3, h4, blockquote, pre`
elements inside the wrapper and attaches the affordance to each. **Content placed in
styled `<div>`s — cards, callouts, custom rows — is invisible to that tag list.** Add
`data-companion-block` to any such container to make it commentable. Add a Submit
button anywhere in the page with `data-companion-submit="title"` — the same
attribute the review form uses (the helper short-circuits when no comments exist,
so a Submit button can safely live next to other UI):

```html
<div data-companion-commentable>
  <h2>What shipped this session</h2>
  <p>Normal prose. On hover, a 💬 appears to the left.</p>
  <ul>
    <li>List items are commentable too.</li>
  </ul>
  <pre><code>// so are code blocks</code></pre>
</div>

<button data-companion-submit="Comments on session recap">Submit → ⌘V</button>
```

### Required ambient-comments helper snippet

Drop this in addition to (not instead of) the size-reporter snippet. Safe to
include even when there's no `data-companion-commentable` wrapper present — the
helper no-ops in that case:

```html
<style>
  [data-companion-commentable] .companion-commentable {
    position: relative; border-radius: 5px; cursor: text;
    transition: background 140ms ease, box-shadow 140ms ease;
  }
  /* Hover-bridge: extend the hover hit area 36 px into the left gutter so
     the cursor doesn't leave :hover while travelling toward the 💬 icon. */
  .companion-commentable::before {
    content: ""; position: absolute;
    top: 0; left: -36px; width: 36px; height: 100%;
  }
  .companion-commentable:hover {
    background: rgba(182,120,29,0.07); box-shadow: inset 2px 0 0 #b6781d;
  }
  .companion-commentable.has-comment {
    background: rgba(46,125,82,0.05); box-shadow: inset 2px 0 0 #2e7d52;
  }
  .companion-ask-btn {
    position: absolute; left: -36px; top: 50%; transform: translateY(-50%);
    width: 26px; height: 26px; padding: 0;
    border: 1px solid rgba(26,23,20,0.2); background: #fff; color: #6e655b;
    border-radius: 6px; cursor: pointer;
    display: none; align-items: center; justify-content: center;
    font-size: 12px; box-shadow: 0 4px 10px -6px rgba(26,23,20,0.4);
  }
  .companion-commentable:hover > .companion-ask-btn,
  .companion-commentable.has-comment > .companion-ask-btn { display: inline-flex; }
  .companion-commentable.has-comment > .companion-ask-btn {
    color: #2e7d52; border-color: #2e7d52;
  }
  .companion-composer {
    margin: 6px 0 10px; padding: 10px 11px;
    background: #fff; border: 1px solid #b6781d; border-radius: 8px;
    box-shadow: 0 10px 24px -16px rgba(26,23,20,0.5);
  }
  .companion-composer .ref {
    font: 600 11px/1.4 ui-monospace, Menlo, monospace; color: #6e655b;
    border-left: 2px solid #b6781d; padding: 4px 8px; margin-bottom: 6px;
    background: rgba(182,120,29,0.07); border-radius: 0 4px 4px 0;
  }
  .companion-composer textarea {
    display: block; width: 100%; min-height: 64px; padding: 8px 10px;
    font: 13px/1.5 -apple-system, system-ui, sans-serif;
    background: #f4f1ec; color: #1a1714;
    border: 1px solid rgba(26,23,20,0.2); border-radius: 6px;
    outline: none; resize: vertical; box-sizing: border-box;
  }
  .companion-composer textarea:focus { border-color: #b6781d; }
  .companion-composer .row {
    display: flex; justify-content: space-between; gap: 8px; margin-top: 8px;
  }
  .companion-composer button {
    font: 600 11.5px/1 -apple-system, system-ui, sans-serif;
    padding: 7px 11px; border-radius: 6px; cursor: pointer;
    border: 1px solid rgba(26,23,20,0.2); background: #fff; color: #1a1714;
  }
  .companion-composer button.save {
    background: #1a1714; color: #f4f1ec; border-color: #1a1714;
  }
  .companion-composer button.delete {
    color: #6e655b; border-color: transparent; background: transparent;
  }
  .companion-annotation {
    margin: 4px 0 10px; padding: 7px 10px;
    background: rgba(46,125,82,0.08); border-left: 2px solid #2e7d52;
    border-radius: 0 6px 6px 0; color: #1a1714;
    font-size: 12.5px; line-height: 1.5; cursor: pointer;
  }
  .companion-annotation::before { content: "💬 "; }
</style>
<script>
  (function () {
    var root = document.querySelector("[data-companion-commentable]");
    if (!root) return;
    var BLOCK_SELECTOR = "p, li, h2, h3, h4, blockquote, pre, [data-companion-block]";
    var blocks = Array.prototype.slice.call(root.querySelectorAll(BLOCK_SELECTOR))
      .filter(function (b) {   // an outer marked card must not double-icon its inner text
        return !(b.parentElement && b.parentElement.closest(BLOCK_SELECTOR));
      });
    var comments = new Map();
    var open = null;

    blocks.forEach(function (b, i) {
      b.classList.add("companion-commentable");
      b.dataset.cBlockId = "b" + i;
      var btn = document.createElement("button");
      btn.type = "button";
      btn.className = "companion-ask-btn";
      btn.title = "Comment on this block";
      btn.textContent = "💬";
      btn.addEventListener("click", function (e) { e.stopPropagation(); openFor(b); });
      b.appendChild(btn);
      b.addEventListener("click", function (e) {
        if (btn.contains(e.target)) return;
        if (!e.shiftKey) return;
        openFor(b);
      });
    });

    function snippet(b) {
      var c = b.cloneNode(true);
      var x = c.querySelector(".companion-ask-btn"); if (x) x.remove();
      var t = (c.textContent || "").replace(/\s+/g, " ").trim();
      return t.length > 80 ? t.slice(0, 77) + "…" : t;
    }
    function closeOpen() { if (open) { open.remove(); open = null; } }
    function openFor(b) {
      closeOpen();
      var id = b.dataset.cBlockId;
      var box = document.createElement("div");
      box.className = "companion-composer";
      box.innerHTML =
        '<div class="ref"></div>' +
        '<textarea placeholder="Your question or comment about this block…"></textarea>' +
        '<div class="row">' +
          '<button type="button" class="delete">Discard</button>' +
          '<div style="display:flex;gap:6px;">' +
            '<button type="button" class="cancel">Cancel</button>' +
            '<button type="button" class="save">Save</button>' +
          '</div>' +
        '</div>';
      box.querySelector(".ref").textContent = snippet(b);
      b.parentNode.insertBefore(box, b.nextSibling);
      open = box;
      var ta = box.querySelector("textarea");
      ta.value = comments.get(id) || "";
      setTimeout(function () { ta.focus(); }, 60);
      box.querySelector(".save").addEventListener("click", function () {
        var v = ta.value.trim();
        if (v) { comments.set(id, v); b.classList.add("has-comment"); renderAnno(b, v); }
        else   { comments.delete(id); b.classList.remove("has-comment"); removeAnno(b); }
        closeOpen();
      });
      box.querySelector(".cancel").addEventListener("click", closeOpen);
      box.querySelector(".delete").addEventListener("click", function () {
        comments.delete(id); b.classList.remove("has-comment"); removeAnno(b); closeOpen();
      });
    }
    function renderAnno(b, t) {
      removeAnno(b);
      var note = document.createElement("div");
      note.className = "companion-annotation";
      note.dataset.forBlock = b.dataset.cBlockId;
      note.textContent = t;
      note.addEventListener("click", function () { openFor(b); });
      b.parentNode.insertBefore(note, b.nextSibling);
    }
    function removeAnno(b) {
      var n = b.parentNode.querySelector(
        '.companion-annotation[data-for-block="' + b.dataset.cBlockId + '"]'
      );
      if (n) n.remove();
    }

    document.addEventListener("click", function (e) {
      var submitBtn = e.target.closest("[data-companion-submit]");
      if (!submitBtn || comments.size === 0) return;
      var title = submitBtn.getAttribute("data-companion-submit") || "Comments";
      var lines = ["Re: " + title, ""];
      blocks.forEach(function (b) {
        var id = b.dataset.cBlockId;
        if (!comments.has(id)) return;
        lines.push("On: " + JSON.stringify(snippet(b)));
        comments.get(id).split("\n").forEach(function (l) { lines.push("    " + l); });
        lines.push("");
      });
      parent.postMessage({
        source: "companion-artifact",
        kind: "submit",
        text: lines.join("\n")
      }, "*");
    });
  })();
</script>
```

### Layout note (margin for the 💬 icon)

The icon floats in a negative left margin (`left: -36px`). The wrapping container
needs enough left padding to give it room — bump the artifact's main wrapper to
`padding-left: 56px` (or whatever pulls the prose ~36 px clear of the left edge),
otherwise the icon will be clipped by the overlay's edge:

```css
[data-fit-root] { padding-left: 56px; }
```

### Compiled output shape

For an artifact with three commented blocks, the submitted message lands as:

```
Re: Comments on session recap

On: "The overlay's borderless NSPanel now becomes the key window when…"
    why does becomesKeyOnlyIfNeeded play with the subclass override —
    do they conflict?

On: "ActivationPolicy::Accessory keeps the app out of Dock and Cmd-Tab"
    is there a way to also hide from Mission Control?

On: "Push the three local commits to origin/master."
    let's do this in the next session
```

The quoted snippet is the first 80 characters of the block's text — enough context
for Claude to know which paragraph the user is asking about without echoing the
whole thing back.

### When to include ambient comments by default

Default ON for any informational artifact longer than ~3 blocks (a multi-paragraph
recap, a sectioned briefing, an explainer with code). The cost is small — ~150
lines of CSS + JS, all dead until the user hovers — and it converts every
informational artifact from a one-way wall into a thing the user can ask back
about without leaving the overlay.

Default OFF for: pills, single-card status flips, decision artifacts (use the
review form instead), anything where the user isn't reading prose. But "OFF for ambient
comments" never means "no responder at all" — a decision artifact still ships the review
form, and even a pure recap still ends with an answerable next-move (a "what's next →").
The ambient-comment 💬 and the Next-steps ballot are two ways to give the user a voice; at
least one of them belongs on almost every artifact.

## 4.3 · The unified helper (both comments AND decisions in one submit)

When one artifact carries **both** ambient-commentable content **and** a Decide ballot, the two
single-purpose helpers above would fight over `data-companion-submit`. Use the **combined
helper** instead: it gathers block-comments *and* item-decisions into one pasteable payload,
sectioned as `— Questions / comments —` then `— Decisions —`.

**Critical wiring rule:** put `data-companion-commentable` only on the **content** pages/blocks,
never on the Next-steps ballot, so the two behaviours don't double up on the same blocks.

```html
<!-- content page(s): commentable -->
<section data-companion-commentable> … prose, lists, headings … </section>
<!-- the Next-steps page: review items, NOT commentable -->
<section>
  <div class="item" data-companion-item data-item-label="Short label that reads well in the submit message">
    <div class="item-row">
      <div class="item-main"><div class="item-title">…</div><div class="item-sub">…</div></div>
      <div class="item-actions">
        <button class="act do"   data-action="approve" title="Do it">✓</button>
        <button class="act info" data-action="comment" title="More info / note">✎</button>
        <button class="act skip" data-action="reject"  title="Skip">✗</button>
      </div>
    </div>
    <textarea data-comment hidden placeholder="What to clarify, or a note…"></textarea>
  </div>
  <!-- submit bar -->
  <div class="bar">
    <span class="count" data-count>nothing marked yet</span>
    <button class="doall" data-doall>✓ Do all</button>
    <button class="submit" data-companion-submit="Title that prefixes the compiled message">Submit → ⌘V</button>
  </div>
</section>
```

The helper auto-discovers semantic blocks (`p, li, h2–h4, blockquote, pre`) inside a
`data-companion-commentable` region. **Content placed in styled `<div>`s — cards, callouts,
custom rows — is invisible to that tag list and will get no 💬.** Add `data-companion-block`
to any such container to make it commentable (the helper de-dupes nested matches, so marking
an outer card won't double-icon its inner text).

**The unified helper lives in `references/interaction-helper.md`** — a ~540-line self-contained
`<script>`. It is self-contained (no external files, no machine-specific paths). **When building
any artifact with commentable blocks AND a Decide ballot, read that file and copy the `<script>`
verbatim** — do not retype or trim it. On its own the markup is inert; the helper is what makes
the buttons click and the 💬 icons appear. Use the ambient-comments CSS (§4.2) and the
review-form CSS (§4.1) for styling.

The single-purpose ambient-comments and review-form snippets above remain valid for a **pure**
recap or a **pure** decision list; the unified helper supersedes them whenever one artifact
carries both.

## 4.4 · Buttons must NEVER be dead (non-negotiable)

A review surface whose ✓/✎/✗ buttons don't respond is a broken artifact — it strands the
user with a decision form they can't use. This must never ship. Two hard rules:

1. **Always include the matching helper script verbatim** (the review helper §4.1, the ambient
   helper §4.2, or the unified helper §4.3 from `references/interaction-helper.md`) in any
   artifact that has `[data-action]` buttons. The buttons are inert markup on their own — *the
   helper is what makes them click*. Don't hand-roll a partial handler; don't drop the helper to
   "save space"; don't use the ambient-comments-only helper (it has no `[data-action]`
   handling) on a page that has review buttons.
2. **Keep every review item reachable.** In a multi-page document (wizard or sidebar), buttons on
   a `display:none` page can't be clicked until that page is shown — fine, but never leave a
   ballot on a page with no nav link to it. When in doubt, **put the decision surface on a
   single, always-visible page** (the safest shape, and what to default to).

### Pre-ship self-check (run this before writing the file)

Confirm all four, every time:

- [ ] The interaction helper `<script>` is present and **unedited** (copy-paste, don't retype).
- [ ] Every `[data-action]` button sits inside a `[data-companion-item]` ancestor.
- [ ] Exactly one `[data-companion-submit]` button exists.
- [ ] No element with `position:fixed`/absolute overlaps the buttons at load (the
      `.cmp-submitted` overlay is fine — it only appears *after* submit).

If you can't tick all four, the artifact isn't ready. A dead-button form is worse than no
artifact at all.

## 4.5 · Copyable handoff blocks (paste-this-elsewhere content)

When an artifact contains content the user is meant to **copy verbatim and paste
somewhere else** — an integration brief to hand another agent ("paste this to Hermes"),
a prompt, a config/code snippet, a handoff note, an onboarding blurb — give it a **Copy
button**, never leave them to hand-select. This is a first-class capability of the
surface: a Companion artifact can deliver ready-to-paste handoffs for the user's *other*
agents/tools, so "onboard this agent" becomes "open the card → Copy → paste."

Mark the copyable element `data-copy` and pair a `data-copy-btn` button with it (same
container, or point at it with `data-copy-target="#id"`). The artifact runs in a sandboxed,
opaque-origin iframe where **both `navigator.clipboard` and `execCommand("copy")` are blocked
on WebKitGTK (Linux)** — so the helper below **bridges to the Companion overlay**
(`postMessage({kind:"copy"})`, which the overlay writes through Tauri's clipboard) *and* also
tries the in-page clipboard so a standalone browser (artifact opened directly, no overlay
parent) still copies. Whichever path lands, the button confirms. Supports multiple blocks per
artifact.

```html
<div class="copy-block">
  <button type="button" data-copy-btn>Copy</button>
  <pre data-copy>the exact text to copy…</pre>
</div>
```

```html
<script>
(function () {
  // Copy `text` to the user's system clipboard from inside the sandboxed iframe.
  function copy(text) {
    // 1) Bridge to the Companion overlay — the reliable path on Linux, where the
    //    iframe's own clipboard APIs are blocked. The overlay writes it via Tauri.
    //    A no-op (harmless) in a standalone browser with no such parent listener.
    try { parent.postMessage({ source: "companion-artifact", kind: "copy", text: text }, "*"); } catch (e) {}
    // 2) Also try the in-page clipboard so a standalone browser still copies.
    if (navigator.clipboard && navigator.clipboard.writeText) {
      navigator.clipboard.writeText(text).catch(function () { exec(text); });
    } else { exec(text); }
  }
  function exec(text) {
    try {
      var ta = document.createElement("textarea");
      ta.value = text; ta.setAttribute("readonly", "");
      ta.style.position = "fixed"; ta.style.top = "-1000px";
      document.body.appendChild(ta); ta.select();
      document.execCommand("copy"); document.body.removeChild(ta);
    } catch (e) { /* both paths exhausted; the overlay bridge above still handles the overlay case */ }
  }
  document.querySelectorAll("[data-copy-btn]").forEach(function (btn) {
    btn.addEventListener("click", function () {
      var sel = btn.getAttribute("data-copy-target");
      var target = sel ? document.querySelector(sel)
                       : (btn.closest(".copy-block") || btn.parentElement).querySelector("[data-copy]");
      if (!target) return;
      copy(target.innerText);
      var prev = btn.dataset.label || btn.textContent;
      btn.dataset.label = prev; btn.textContent = "Copied ✓";
      clearTimeout(btn._t);
      btn._t = setTimeout(function () { btn.textContent = btn.dataset.label; }, 1600);
    });
  });
})();
</script>
```

This is independent of the `data-companion-submit` helper (which routes feedback to the
agent) — a Copy button copies to the *system clipboard for the user*, so the two coexist
freely in one artifact.

---

# 5 · Shell repaint (the whole-surface color capability)

**Amends invariant §1.6.** By default the surface is the app shade and stays home. An artifact
may **repaint the entire Board surface** — shell chrome and the iframe together — to a **curated**
color, which the Board animates as an expanding-circle reveal so there is never a seam. Use it
**opt-in and OCCASIONALLY** — a debrief, a celebration, a distinct mode; **never every turn**, or
navigating between tiles strobes through colors.

### The curated set (bg / ink) — nothing else is honored

| Name | Background | Ink |
|---|---|---|
| paper (default) | `#FBFAF6` | `#171A1F` |
| slate | `#E7ECF1` | `#1B2530` |
| mint | `#E6F1EA` | `#16281F` |
| clay | `#F3E7DF` | `#2A1C14` |
| ink | `#14181D` | `#E8EDF3` |

The app-shade default is `oklch(0.945 0.014 60)` / `#171A1F`; declaring nothing keeps the Board
on it. The Board **validates against this curated set** — any other color is ignored and the
surface stays app-shade.

### To repaint, do ALL THREE

1. **Declare it in `companion-meta`** — add a `"shell"` field:
   ```json
   "shell": { "bg": "#E7ECF1", "ink": "#1B2530" }
   ```
2. **Post it on load** — alongside the size snippet, post a `kind:"shell"` message:
   ```js
   parent.postMessage({ source: "companion-artifact", kind: "shell",
     bg: "#E7ECF1", ink: "#1B2530" }, "*");
   ```
3. **Set your own `html, body` background to exactly that bg** (and ink) — so the iframe matches
   the shell the Board paints around it.

The Board animates a **clip-path circle reveal** across the whole surface, **instant-swaps** under
`prefers-reduced-motion`, and **skips the animation** when consecutive artifacts declare the same
color. (The reveal is a Board capability — the artifact just *asks*; the shell *moves*.)

---

# 6 · House style — "Broadsheet", the default look

Broadsheet is the **default look** — one pattern's worth of taste, **not a law**. It was the law
until 2026-07-15; it is now demoted to "the default costume among several." The invariants in §1
are the floor and they are absolute; Broadsheet is a *look* you apply on top, and a pattern may
theme within the invariants. (Full spec: `FEEL-SPEC.md`, alongside this skill.)

**The one rule that carries the look:** make the decision the loudest thing on the page — an
editorial front page, not a floating UI card. Three failure modes it avoids: floating as a hard
card with a drop shadow (instead: dissolve into the board, §1.6); hierarchy flattening after the
headline (instead: scale contrast — one dominant Newsreader headline, everything steps down hard);
the decision buried in a pale footer of tiny buttons (instead: the elevated Decide ballot).

**Strong floor, open ceiling — honestly.** The floor is §1: the shell, the plumbing,
always-answerable, decision-loudest, the type pairing, one accent. The **ceiling is genuinely
open** — which pattern (§2/§3), how you compose inside it, how *this* data wants to look. When the
content invites a better form, break format; a bespoke page that earns its shape beats one that
just fills a skeleton. That range is the point of authoring inline — the invariants are what keep
it still reading as Companion.

### The look, concretely

- **Hierarchy through scale.** One dominant **Newsreader** headline earns its size
  (clamp ~34–60px, letter-spacing ~-.03em); everything else steps down hard.
- **Palette** (one semantic accent per artifact, per §1.8): board `oklch(0.945 0.014 60)`, paper
  `#FBFAF6`, ink `#171A1F`, soft `#39404A`, muted `#646C76`, hairline `#CDC8BC`; accent ∈ blue
  `#3D7EFF`, amber `#F2B84B`, clay `#D98158`, mint `#4DAA7D` (each with a darker ink variant for
  text). **The blob canvas (§3.2) is the sanctioned place for multiple palette colors.**
- **Type:** Newsreader = display, Inter = reading, JetBrains Mono = kickers/labels/file chips.
  Load the bundled faces via `fonts.css` (§7.7) with system fallbacks. Small-caps mono kickers +
  hairline rules carry the texture.
- **The Decide ballot is load-bearing.** When the artifact carries next moves, end on an
  **elevated** decision panel (accent top-rule, a real "Decide" header, ~42px ✓/✎/✗ targets, a
  Do-all and a primary dark Commit) — never a footer of tiny buttons. This is where you spend
  boldness; keep the rest disciplined.

### A suggested skeleton (a starting point, not a mold)

`masthead (project + edition) → kicker → dominant headline → standfirst → working chip → touches
(files) → visuals → evidence (collapsible) → **Decide ballot**`

Follow it when nothing better suggests itself; depart when the content wants a different shape.

### Two modes of the look

- **Steer** (decision-dominant): the recommendation itself becomes the headline with one
  confident primary action; context collapses below. For "just tell me the next move" days.
- **Canvas** (always-on): a persistent steer rail keeps the moves in reach while the user reads —
  the wheel never leaves the screen. For when the user truly lives in the board.

---

# 7 · Emit, surface, bundled assets, verify

## 7.1 · How to emit

Write one **self-contained** `.html` file (inline all CSS/JS, no build step, no external
deps) into the artifacts dir:

```
${COMPANION_ARTIFACTS_DIR:-~/.claude/companion/artifacts}/<kebab-slug>.html
```

Use a descriptive slug (e.g. `auth-fix-heads-up.html`, `migration-plan.html`). Writing the
file is what pops the overlay — no other action needed.

> **Write it with the `Write` tool — not `Bash` (`cat >`, `cp`, a node/python script).**
> A `PostToolUse(Write|Edit)` hook auto-stamps `artifact-index.json` so the Board maps the
> artifact to *this* session's unit. That hook only fires for the `Write`/`Edit` tools — an
> artifact created via `Bash` is never indexed, so it lands in the Board's UNSOURCED bucket
> instead of your session (it may still flash up transiently via the live poll, then vanish
> from the unit's history). If you must template/substitute, build the final HTML string,
> then emit it through the `Write` tool.

### The pull verb

The user can run `/companion:html` at any time to ask for an artifact about the current turn.
`/companion:render` is the deprecated alias and still works for one release. (You never have to
decide *whether* to author — see §1.1. This verb just lets the user ask for a fresh one mid-turn.)

## 7.2 · Required: a full-document head with `<meta charset>`

Every artifact is a **complete HTML document** — open it with a real head, not straight into
`<div>` or `<script>`:

```html
<!doctype html>
<html lang="en">
<head><meta charset="utf-8" /><title>…</title></head>
<body>
  … artifact …
</body>
</html>
```

`<meta charset="utf-8">` is **not optional**. Tiles load over the `asset://` protocol, whose
response carries no `charset`, so with no meta the WebView falls back to Windows-1252 and every
`—`, `'`, `"` renders as mojibake (`â€"`, `â€™`). The templates in §3 already open with it — if you
hand-assemble an artifact, don't drop it.

## 7.3 · Required in every artifact (so the overlay sizes it)

The overlay loads artifacts in a sandboxed, opaque-origin iframe and **cannot measure
them** — each artifact must self-report its size. Mark the main wrapper with
`data-fit-root` (definite width, height flows), give `html, body` a background, hide the
root scrollbar, and include this snippet at the end of `<body>`:

```html
<style>
  html { scrollbar-width: none; }
  html::-webkit-scrollbar { width: 0; height: 0; display: none; }
</style>
<script>
  (function () {
    var el = document.querySelector("[data-fit-root]") || document.body;
    var post = function () {
      parent.postMessage({ source: "companion-artifact", kind: "size",
        w: Math.ceil(el.scrollWidth), h: Math.ceil(el.scrollHeight) }, "*");
    };
    if (typeof ResizeObserver !== "undefined") new ResizeObserver(post).observe(el);
    addEventListener("load", post); post();
  })();
</script>
```

## 7.4 · Metadata block (so feedback on this artifact is self-identifying)

Add a `companion-meta` block in `<head>`. When the user submits feedback, the helper
prepends these fields to the pasted message, so the agent — **even in a different,
later session re-opening this artifact from the history HUD (⌘8)** — knows which
artifact it is, what it was about, and which files it concerns. The history HUD also
shows `summary` as the card subtitle. Skip it only for throwaway pills.

```html
<script type="application/json" id="companion-meta">
{
  "subject": "<short subject line>",
  "summary": "<1–2 sentence plain-English description of what this artifact is about>",
  "files": ["<repo-relative paths the artifact concerns>"],
  "project": "<cwd or repo, e.g. ~/claude-code-companion>",
  "branch": "<git branch>",
  "created": "<YYYY-MM-DD>"
}
</script>
```

All fields are optional; fill what you know at authoring time. Keep `summary` to one or
two sentences — it is the highest-leverage field for a cold agent picking up context. (Add a
`"shell"` field only when repainting the surface — see §5.)

## 7.5 · Surfacing or re-showing an artifact

Artifacts surface **only inside the Board shell** — the single Companion surface. Writing a
new `.html` into the artifacts dir is enough: the Board ingests it as a tile in its session
via the live poll. **Artifacts never open as standalone floating windows**, so there is no
"pop this file" verb to run.

When the user asks to **see an artifact again** ("show me that again", "open it", "pull that
back up"), don't re-write the file — run **`companion board`** to bring the shell forward
(the artifact is already ingested inside it).

> **Never run `companion open <path>`.** It spawns a standalone OS window outside the shell —
> the obsolete pre-Board behavior. Launching an artifact without the shell is exactly what
> must not happen. Use `companion board`.

## 7.6 · First-run: build an example artifact on request

When someone has just installed Companion and asks to **see what it does** — "show me an
example artifact", "show me an example", "what does this do", "demo it" — build a real,
self-contained **full-document** artifact that explains Companion itself, and write it into
the artifacts dir (writing pops it). Don't pre-fetch or copy a canned file; generate a fresh,
polished page each time — it's the product's first impression.

Cover, briefly and visually:

- **What the overlay is** — a focus-stealing-free floating window that auto-renders any HTML
  Claude writes, layered over your terminal.
- **How artifacts appear** — Claude writes a self-contained `.html` into the watched dir
  (`${COMPANION_ARTIFACTS_DIR:-~/.claude/companion/artifacts}`) and the overlay pops it. No
  copy-paste, no browser tab.
- **The cadence** — small "pill" heads-up for light changes, full document when the content is
  dense (a plan, review, diagram, comparison).
- **How to check it's healthy** — `/companion:doctor` renders a health panel in the overlay.

Make it look designed (this is onboarding), and keep the required `data-fit-root` + size-report
snippet so it sizes correctly. This is also the perfect smoke test: if the page pops in the
overlay, the whole skill → write → hook → overlay path works end to end.

## 7.7 · Bundled assets (fonts, D3, GSAP)

Three libraries are bundled in `~/.claude/companion/vendor/` and accessible via `asset:`.
Use them instead of CDN links — the artifact sandbox blocks external URLs.

### Fonts

```html
<link rel="stylesheet" href="asset://localhost/Users/gyatso/.claude/companion/vendor/fonts.css">
```

Loads three variable fonts:

| Family | Style | Weights | Use for |
|--------|-------|---------|---------|
| `Inter` | normal | 100–900 | UI text, body, labels |
| `Newsreader` | normal + italic | 200–800 | Headings, editorial, pull quotes |
| `JetBrains Mono` | normal | 100–800 | Code, monospace labels, data |

```css
/* after loading fonts.css, reference them normally */
font-family: 'Inter', ui-sans-serif, sans-serif;
font-family: 'Newsreader', ui-serif, serif;
font-family: 'JetBrains Mono', ui-monospace, monospace;

/* variable font weight axis — any value 100–900 works */
font-weight: 350;   /* lighter Inter body */
font-weight: 650;   /* medium-bold heading */
```

### D3 (data visualization)

```html
<script src="asset://localhost/Users/gyatso/.claude/companion/vendor/d3.min.js"></script>
```

Full D3 v7. Use for charts, graphs, force layouts, geographic projections, data transforms.
The `d3` global is available after the script loads.

```html
<svg id="chart"></svg>
<script src="asset://localhost/Users/gyatso/.claude/companion/vendor/d3.min.js"></script>
<script>
  var data = [4, 8, 15, 16, 23, 42];
  var svg = d3.select("#chart").attr("width", 400).attr("height", 120);
  svg.selectAll("rect")
    .data(data).enter().append("rect")
    .attr("x", function(d, i) { return i * 60; })
    .attr("y", function(d) { return 120 - d * 2; })
    .attr("width", 50).attr("height", function(d) { return d * 2; })
    .attr("fill", "#6366f1");
</script>
```

### GSAP (animation)

```html
<script src="asset://localhost/Users/gyatso/.claude/companion/vendor/gsap.min.js"></script>
<!-- optional: scroll-triggered animation -->
<script src="asset://localhost/Users/gyatso/.claude/companion/vendor/ScrollTrigger.min.js"></script>
```

GSAP 3 core + ScrollTrigger. The `gsap` global is available after the script loads.

```html
<script src="asset://localhost/Users/gyatso/.claude/companion/vendor/gsap.min.js"></script>
<script>
  // animate in on load
  gsap.from(".card", { opacity: 0, y: 20, duration: 0.5, stagger: 0.08, ease: "power2.out" });

  // timeline
  var tl = gsap.timeline();
  tl.from(".title", { opacity: 0, y: -10, duration: 0.4 })
    .from(".body",  { opacity: 0,          duration: 0.3 }, "-=0.1");
</script>
```

With ScrollTrigger (register first):
```js
gsap.registerPlugin(ScrollTrigger);
gsap.from(".section", {
  scrollTrigger: { trigger: ".section", start: "top 80%" },
  opacity: 0, y: 30, duration: 0.6
});
```

### Loading order

Always load scripts before your inline `<script>` that uses them. Fonts load async
(they're `font-display: swap`) so layout won't block. Recommended order:

```html
<head>
  <link rel="stylesheet" href="asset://localhost/Users/gyatso/.claude/companion/vendor/fonts.css">
</head>
<body>
  <!-- content -->
  <script src="asset://localhost/Users/gyatso/.claude/companion/vendor/d3.min.js"></script>
  <script src="asset://localhost/Users/gyatso/.claude/companion/vendor/gsap.min.js"></script>
  <script>/* your code here */</script>
</body>
```

## 7.8 · Verify it's wired

Run `/companion:doctor` (or `companion doctor` in a shell) — it renders a health panel in
the overlay. If you can see the panel, the whole path works.
