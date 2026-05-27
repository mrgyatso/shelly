---
name: prefer-html
description: Render a heads-up in the Companion overlay after making changes, and prefer self-contained HTML artifacts for plans, reviews, comparisons, diagrams, and reports. Use after completing any non-trivial change (to show what changed) or when a response would otherwise be a standalone document. Decides between a small "pill" heads-up and a full HTML document by content density.
---

# Prefer HTML — render what changed in the Companion overlay

The Companion overlay auto-renders any `.html` file written into the artifacts dir,
floating it over the terminal without stealing focus. This skill makes Claude *use*
that surface: emit an artifact after meaningful work, sized to the work.

## The cadence: consider an artifact after every change

When you finish a change, run a quick meta-check — *"is this worth a heads-up?"* — and
**almost always emit some artifact when real work was done.** The overlay is meant to be
a continuous "here's what just changed" feed, not an occasional report. The check is
cheap; default toward showing something.

**Skip it** only for: trivial conversational answers, pure code edits the user is actively
watching, one-line lookups, or when the user has said they don't want artifacts.

> **Two user-side verbs and an opt-in backstop.** When the user wants an artifact
> about what was just discussed but Claude didn't render one, they run
> `/companion:render` to pull one explicitly — Claude renders, the overlay pops it,
> the turn ends. For sessions that *do* want forced rendering (e.g. walking away and
> wanting a wall of artifacts on return), `/companion:enforce on` activates a Stop
> hook that blocks end-of-turn messages scoring ≥2 deliverable signals (numbered
> steps, install commands, multiple URLs/paths, code blocks, bold section heads)
> until an artifact is written. Enforcer is **off by default**: skill-guided
> judgment plus user pull cover the common case without surprise Stop blocks.
> Toggle off again with `/companion:enforce off`; check state with
> `/companion:enforce status`.

## The form factor: small by default, large only when dense

Pick the artifact's weight from the **content's density**, not habit:

- **Small pill / square — the common case.** A glanceable "this is what changed":
  a title and 1–5 lines. No scrolling, no sections. Right for bug fixes, small edits,
  a status flip, a single decision, a short summary.
- **Full document — only when the content earns it.** Use the room for diagrams,
  graphs, tables, multi-section plans, code reviews, comparisons, post-mortems —
  anything genuinely dense or visual.

**Principle: don't shrink for shrinking's sake, and don't pad to fill space.** A small
pill is the *correct, finished* form for a light change — not a degraded document.
A full document is correct when there's real substance. Density decides.

## How to emit

Write one **self-contained** `.html` file (inline all CSS/JS, no build step, no external
deps) into the artifacts dir:

```
${COMPANION_ARTIFACTS_DIR:-~/.claude/companion/artifacts}/<kebab-slug>.html
```

Use a descriptive slug (e.g. `auth-fix-heads-up.html`, `migration-plan.html`). Writing the
file is what pops the overlay — no other action needed.

### Required in every artifact (so the overlay sizes it)

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

## Pill template (the default — copy, fill, write)

A ~360px self-sizing "what changed" card. Swap the accent color by intent
(green = done/fixed, amber = heads-up/partial, red = broke/blocked):

```html
<!doctype html>
<html lang="en">
<head><meta charset="UTF-8" /><title>changed</title>
<style>
  :root { --accent:#2e7d52; --ink:#1a1714; --muted:#6e655b; --surface:#fff; --paper:#f4f1ec; }
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

For the **full-document** case, build a normal self-contained page (your own layout,
sections, SVG/diagrams as needed) — just keep `data-fit-root` on the main wrapper with a
definite width (e.g. 720–960px) and include the size-report snippet above.

## Interactive review artifacts (multi-item plans, todos, reviews)

When the artifact is a **list of N items the user might want to react to individually** —
implementation plans, todo lists, code-review checklists, decision sets, comparison
options — reach for the **interactive review form**. Each item gets inline action
buttons (approve / comment / reject). The user marks items as they read, optionally
types a free-text comment under any item, and clicks a single Submit button. The
overlay compiles all decisions into one coherent prose message and writes it to the
system clipboard. The user pastes the result into the terminal — one paste, the whole
review batched.

**Reach for this form** for: implementation plans (3+ steps), prioritised todo lists,
plan-mode review handoffs, multi-option comparisons where each option needs its own
verdict, "things I noticed" review checklists. **Skip it** for: pill recaps, single-
section reports, dashboards, status snapshots without per-item decisions, anything
where the user is going to respond holistically rather than per-row.

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

`data-item-label` is what goes into the compiled output. The visible item content
can be richer (sub-text, code spans, links) — only the label string is sent.

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
          if (ta) ta.hidden = true;
          return;
        }
        item.setAttribute("data-state", action);
        if (ta) ta.hidden = (action !== "comment");
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

The whole artifact should still pass the [design-quality](../../../README.md) bar —
this is not a stock todo widget.

### Default to the review form for multi-item artifacts

When emitting an artifact that's effectively a list of 3+ decisions, **default to
the interactive review form**. The user shouldn't have to ask for it — that's the
whole point. Single round trip beats ten retyped responses.

## Surfacing or re-showing an existing artifact

Writing a new `.html` into the artifacts dir is what pops the overlay. But the auto-pop only
fires on a *fresh* write — so when the user asks to **see an artifact again** ("show me that
again", "open it", "pull that back up"), don't re-write the file. Run the explicit surface verb:

```
companion open <abs-path>
```

That's the one way to put an existing file on the overlay. Don't use other file-delivery
mechanisms for this — they hand the file to the client without rendering it on the overlay.

## First-run: build an example artifact on request

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

## Verify it's wired

Run `/companion:doctor` (or `companion doctor` in a shell) — it renders a health panel in
the overlay. If you can see the panel, the whole path works.
