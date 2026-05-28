---
name: prefer-html
description: Render a heads-up in the Companion overlay after making changes, and prefer self-contained HTML artifacts for plans, reviews, comparisons, diagrams, and reports. Use after completing any non-trivial change (to show what changed) or when a response would otherwise be a standalone document. Decides between a small "pill" heads-up and a full HTML document by content density.
---

# Prefer HTML — render what changed in the Companion overlay

The Companion overlay auto-renders any `.html` file written into the artifacts dir,
floating it over the terminal without stealing focus. This skill makes Claude *use*
that surface: emit an artifact after meaningful work, sized to the work.

## First — check the mode

Before deciding whether to render anything, read `~/.claude/companion/mode` with a
quick Bash call: `cat "$HOME/.claude/companion/mode" 2>/dev/null || echo agent`. The
file's content is one word and controls the rest of this skill.

- **`agent`** (default; the file may not exist) — Follow the cadence rules below.
  Claude judges when an artifact helps and renders one.
- **`manual`** — **Render nothing in this skill.** No auto-rendered HTML on this
  turn, period. The user controls rendering explicitly via the `/html` slash command
  (which bypasses this mode check and always renders). Skip the rest of this skill's
  cadence advice and reply in plain chat instead. Exception: if the user *did* run
  `/html` (or its deprecated alias `/companion:render`) this turn, that command's own
  prompt overrides — render the artifact it asked for.

The user flips between modes with `/companion:mode agent|manual|status`.

## The cadence (agent mode only): consider an artifact after every change

When you finish a change, run a quick meta-check — *"is this worth a heads-up?"* —
and **emit an artifact when real work was done.** The overlay is meant to be a
"here's what just changed" feed for the user; default toward showing something when
there's something to show.

**Skip it** for: trivial conversational answers, pure code edits the user is actively
watching, one-line lookups, or when the user has said they don't want artifacts. (And
of course in **manual mode**, skip every time.)

> **The pull verb.** Regardless of mode, the user can run `/html` to ask for an
> artifact about the current turn. `/html` bypasses the mode check — it always
> renders. `/companion:render` is the deprecated alias and still works for one
> release.

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

## Ambient inline comments (let the user ask about any block)

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
button and would write competing payloads to the clipboard. Pick one per artifact.

### Convention

Wrap the readable content in a `<div data-companion-commentable>` and include the
helper snippet below. The helper auto-discovers `p, li, h2, h3, h4, blockquote, pre`
elements inside the wrapper and attaches the affordance to each. Add a Submit
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
    var BLOCK_SELECTOR = "p, li, h2, h3, h4, blockquote, pre";
    var blocks = Array.prototype.slice.call(root.querySelectorAll(BLOCK_SELECTOR));
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
review form instead), anything where the user isn't reading prose.

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
