---
name: prefer-html
description: MANDATORY before writing any `.html` artifact into the Companion artifacts dir (`${COMPANION_ARTIFACTS_DIR:-~/.claude/companion/artifacts}` — confirm the live path with `companion doctor`). The skill carries the unified helper script, the required DOM markers (`data-companion-commentable`, `data-companion-item`, `data-companion-submit`, `data-fit-root`), the size-reporter snippet, and the pill / full-document / multi-page templates. Writing an HTML artifact without first loading this skill ships a static page with no commentable blocks, no review form, and no submit — the user cannot interact with it. Use BEFORE the Write call, not after. Also use when responding to `/companion:html`, when emitting a heads-up after a non-trivial change, or when a response would otherwise be a standalone document (plans, reviews, comparisons, diagrams, reports). Decides between a pill heads-up, a full document, and a multi-page document by content density.
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
  turn, period. The user controls rendering explicitly via the `/companion:html` slash
  command (which bypasses this mode check and always renders). Skip the rest of this
  skill's cadence advice and reply in plain chat instead. Exception: if the user *did*
  run `/companion:html` (or its deprecated alias `/companion:render`) this turn, that
  command's own prompt overrides — render the artifact it asked for.

The user flips between modes with `/companion:mode agent|manual|status`.

## The default shape: DRIVE THE WORK FORWARD — inform + propel, every substantive turn

**The Companion's job is to move the project toward shipping — solve the problem, build the
feature, ship the product — not to recap.** On any substantive turn (real work OR real
discussion) the default artifact does two jobs at once and **always ends by pushing the next
step**, as a single multi-page document:

1. **Inform.** One or more content pages (findings, status, explanation, comparison),
   each wrapped in `data-companion-commentable` so the user can hover any block and
   click 💬 to question *that specific line* without retyping it.
2. **Propel.** A final **"Next steps" page** — a review form (✓ do it / ✎ note / ✗ skip
   per item, plus a **Do all** button) that converts the brief into decisions and pushes
   the work forward. **Every substantive artifact MUST end with one of these — a decision
   surface, never a closing paragraph of prose.** Propose concrete next moves, recommend the
   strongest option and *why*, and ask the sharp questions that advance the work. **Never
   wait for the user to say what is next — propose it, offer ideas.** And **if the goal /
   north-star is unclear, ASK for it inside the artifact** (a question surface) so the target
   gets locked and the work keeps moving.

This is the standing format for *steering* artifacts: **informative AND goal-oriented**,
always handing the user a clear next thing to act on. It governs **shape, not frequency** —
whether a turn deserves an artifact at all is the cadence judgment below — but when an
artifact IS warranted, a substantive turn earns this forward-driving surface, **not a thin
info block**.

**The combined shape is a DEFAULT, not a cage — choose it by intent.** Reach for it when the
user needs to **react / decide / steer**: status, plans, reviews, comparisons, options,
strategy, multi-agent steering. But when the content is **presentation-first** — a morning
debrief, a dashboard, a data visualization, a recap or explainer the user just wants to *see
beautifully*, a celebration, a one-off custom interface — **design a fully bespoke UI
instead.** Do NOT force `data-companion-commentable` blocks or a Next-steps "questions" page
onto content that isn't asking to be steered; a rigid template on a debrief is worse than a
custom one. You may still drop in interactive bits à la carte (a Copy button, a few ✓/✎/✗
where something is genuinely actionable), but the layout, structure, and feel are yours to
craft. **Ask: does the user need to *act on* this, or *look at* it?** Act on → combined
shape. Look at → bespoke. (Still keep the required `data-fit-root` + size-reporter snippet so
it sizes in the overlay, and the `companion-meta` block; those are about plumbing, not shape.)

> **Heads-up for agents pushing to the hub (e.g. a morning-briefing cron):** the always-on
> **live pane** is a *fixed* glanceable format (`working` / `where` / `next`) rendered from
> the `live/*.json` you write — it is NOT a place for a bespoke UI. For a beautiful debrief,
> write an **artifact** (`artifacts/<slug>.html`, any design you like) — that's the rich
> surface; the live JSON is just the status strip.

**One unified Submit collects both.** The ambient-comments helper and the review-form
helper would otherwise fight over `data-companion-submit`. Use the **combined helper**
(below) instead: it gathers block-comments *and* item-decisions into one pasteable payload,
sectioned as `— Questions / comments —` then `— Decisions —`. Critical wiring rule: put
`data-companion-commentable` only on the **content** pages, never on the Next-steps page,
so the two helpers don't double up on the same blocks.

The **unified helper is inlined below** — copy it verbatim. It is self-contained (no
external files, no machine-specific paths); use the ambient-comments CSS and the
review-form CSS documented later in this file for styling.

### Buttons must NEVER be dead (non-negotiable)

A review surface whose ✓/✎/✗ buttons don't respond is a broken artifact — it strands the
user with a decision form they can't use. This must never ship. Two hard rules:

1. **Always include the unified helper script verbatim** (the block below) in any artifact
   that has `[data-action]` buttons. The buttons are inert markup on their own — *the helper
   is what makes them click*. Don't hand-roll a partial handler; don't drop the helper to
   "save space"; don't use the ambient-comments-only helper (it has no `[data-action]`
   handling) on a page that has review buttons.
2. **Keep every review item reachable.** In a multi-page document, buttons on a
   `display:none` page can't be clicked until that page is shown — fine, but never leave a
   Next-steps form on a page with no nav link to it. When in doubt, **put the decision
   surface on a single, always-visible page** (the safest shape, and what to default to).

**Pre-ship self-check (run this before writing the file).** Confirm all four, every time:

- [ ] The unified helper `<script>` is present and **unedited** (copy-paste, don't retype).
- [ ] Every `[data-action]` button sits inside a `[data-companion-item]` ancestor.
- [ ] Exactly one `[data-companion-submit]` button exists.
- [ ] No element with `position:fixed`/absolute overlaps the buttons at load (the
      `.cmp-submitted` overlay is fine — it only appears *after* submit).

If you can't tick all four, the artifact isn't ready. A dead-button form is worse than no
artifact at all.

### HTML wiring

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

### Unified helper script (ambient comments + review items → one submit)

```html
<script>
(function () {
  var BLOCK_SELECTOR = "p, li, h2, h3, h4, blockquote, pre, [data-companion-block]";
  var submitBtn = document.querySelector("[data-companion-submit]");
  var countEl = document.querySelector("[data-count]");
  var items = [].slice.call(document.querySelectorAll("[data-companion-item]"));
  var comments = new Map();
  var open = null;

  // ambient comments on every commentable block (skipping review items)
  var blocks = [];
  [].slice.call(document.querySelectorAll("[data-companion-commentable]")).forEach(function (root) {
    [].slice.call(root.querySelectorAll(BLOCK_SELECTOR)).forEach(function (b) {
      if (b.closest("[data-companion-item]")) return;
      if (b.parentElement && b.parentElement.closest(BLOCK_SELECTOR)) return; // avoid nested icons
      blocks.push(b);
    });
  });
  blocks.forEach(function (b, i) {
    b.classList.add("companion-commentable");
    b.dataset.cBlockId = "b" + i;
    var btn = document.createElement("button");
    btn.type = "button"; btn.className = "companion-ask-btn";
    btn.title = "Comment on this block"; btn.textContent = "💬";
    btn.addEventListener("click", function (e) { e.stopPropagation(); openFor(b); });
    b.appendChild(btn);
  });
  function snippet(b) {
    var c = b.cloneNode(true); var x = c.querySelector(".companion-ask-btn"); if (x) x.remove();
    var t = (c.textContent || "").replace(/\s+/g, " ").trim();
    return t.length > 80 ? t.slice(0, 77) + "…" : t;
  }
  function closeOpen() { if (open) { open.remove(); open = null; } }
  function openFor(b) {
    closeOpen();
    var id = b.dataset.cBlockId;
    var box = document.createElement("div");
    box.className = "companion-composer";
    box.innerHTML = '<div class="ref"></div>' +
      '<textarea placeholder="Your question or comment about this block…"></textarea>' +
      '<div class="row"><button type="button" class="delete">Discard</button>' +
      '<div style="display:flex;gap:6px;"><button type="button" class="cancel">Cancel</button>' +
      '<button type="button" class="save">Save</button></div></div>';
    box.querySelector(".ref").textContent = snippet(b);
    b.parentNode.insertBefore(box, b.nextSibling);
    open = box;
    var ta = box.querySelector("textarea"); ta.value = comments.get(id) || "";
    setTimeout(function () { ta.focus(); }, 60);
    box.querySelector(".save").addEventListener("click", function () {
      var v = ta.value.trim();
      if (v) { comments.set(id, v); b.classList.add("has-comment"); renderAnno(b, v); }
      else { comments.delete(id); b.classList.remove("has-comment"); removeAnno(b); }
      closeOpen(); refresh();
    });
    box.querySelector(".cancel").addEventListener("click", closeOpen);
    box.querySelector(".delete").addEventListener("click", function () {
      comments.delete(id); b.classList.remove("has-comment"); removeAnno(b); closeOpen(); refresh();
    });
  }
  function renderAnno(b, t) {
    removeAnno(b);
    var note = document.createElement("div");
    note.className = "companion-annotation"; note.dataset.forBlock = b.dataset.cBlockId;
    note.textContent = t; note.addEventListener("click", function () { openFor(b); });
    b.parentNode.insertBefore(note, b.nextSibling);
  }
  function removeAnno(b) {
    var n = b.parentNode.querySelector('.companion-annotation[data-for-block="' + b.dataset.cBlockId + '"]');
    if (n) n.remove();
  }

  // review items: ✓ approve / ✎ comment / ✗ reject.
  // The comment box stays hidden until ✎ is clicked. Toggle via inline style.display
  // (NOT the `hidden` attr) so author CSS like `.item textarea{display:block}` can't
  // accidentally reveal it — inline style wins. Force-hide all boxes on load too.
  items.forEach(function (it) { var t = it.querySelector("textarea[data-comment]"); if (t) t.style.display = "none"; });
  function setState(item, action) {
    var current = item.getAttribute("data-state");
    var ta = item.querySelector("textarea[data-comment]");
    if (current === action) { item.removeAttribute("data-state"); if (ta) ta.style.display = "none"; }
    else { item.setAttribute("data-state", action); if (ta) ta.style.display = (action === "comment") ? "block" : "none";
      if (action === "comment" && ta) setTimeout(function () { ta.focus(); }, 0); }
    refresh();
  }

  document.addEventListener("click", function (e) {
    var btn = e.target.closest("[data-action]");
    if (btn) { var it = btn.closest("[data-companion-item]"); if (it) setState(it, btn.getAttribute("data-action")); return; }
    if (e.target.closest("[data-doall]")) {
      items.forEach(function (it) { it.setAttribute("data-state", "approve");
        var ta = it.querySelector("textarea[data-comment]"); if (ta) ta.style.display = "none"; });
      refresh(); return;
    }
    var sub = e.target.closest("[data-companion-submit]");
    if (sub) doSubmit(sub);
  });

  var commentEl = null; // the single freeform comment field, injected below
  function freeComment() { return commentEl ? commentEl.value.trim() : ""; }
  function pending() {
    return comments.size + document.querySelectorAll("[data-companion-item][data-state]").length + (freeComment() ? 1 : 0);
  }
  function refresh() {
    var c = comments.size, d = document.querySelectorAll("[data-companion-item][data-state]").length, fc = freeComment() ? 1 : 0;
    if (countEl) countEl.textContent = (c || d || fc)
      ? (d + " decision" + (d !== 1 ? "s" : "") + (c ? (" · " + c + " comment" + (c !== 1 ? "s" : "")) : "") + (fc ? " · note added" : ""))
      : "nothing marked yet";
    if (submitBtn) submitBtn.classList.toggle("ready", (c + d + fc) > 0);
  }
  function meta() {
    var el = document.getElementById("companion-meta");
    if (!el) return [];
    try { var m = JSON.parse(el.textContent); } catch (e) { return []; }
    var L = ["[Companion artifact feedback]"];
    if (m.subject) L.push("Subject: " + m.subject);
    if (m.summary) L.push("About: " + m.summary);
    if (m.project) L.push("Project: " + m.project + (m.branch ? " (" + m.branch + ")" : ""));
    if (m.created) L.push("Created: " + m.created);
    if (m.files && m.files.length) L.push("Files: " + m.files.join(", "));
    L.push("");
    return L;
  }
  function build(title) {
    var lines = meta().concat(["Re: " + title, ""]);
    var cBlocks = blocks.filter(function (b) { return comments.has(b.dataset.cBlockId); });
    if (cBlocks.length) {
      lines.push("— Questions / comments —", "");
      cBlocks.forEach(function (b) {
        lines.push("On: " + JSON.stringify(snippet(b)));
        comments.get(b.dataset.cBlockId).split("\n").forEach(function (l) { lines.push("    " + l); });
        lines.push("");
      });
    }
    var marked = [].slice.call(document.querySelectorAll("[data-companion-item][data-state]"));
    if (marked.length) {
      var verb = { approve: "✓ Do it:", reject: "✗ Skip:", comment: "✎ Note:" };
      lines.push("— Decisions —", "");
      marked.forEach(function (it) {
        var s = it.getAttribute("data-state");
        lines.push(verb[s] + " " + (it.getAttribute("data-item-label") || "(unlabeled)"));
        if (s === "comment") { var t = it.querySelector("textarea[data-comment]");
          if (t && t.value.trim()) t.value.trim().split("\n").forEach(function (l) { lines.push("    " + l); }); }
      });
      lines.push("");
    }
    var fc = freeComment();
    if (fc) {
      lines.push("— Comment —", "");
      fc.split("\n").forEach(function (l) { lines.push(l); });
      lines.push("");
    }
    return lines.join("\n");
  }
  function fallbackCopy(text) {
    try { var ta = document.createElement("textarea"); ta.value = text;
      ta.style.position = "fixed"; ta.style.top = "-1000px"; document.body.appendChild(ta);
      ta.focus(); ta.select(); var ok = document.execCommand("copy"); ta.remove(); return ok;
    } catch (e) { return false; }
  }
  function flash(msg) {
    if (!submitBtn) return;
    var prev = submitBtn.dataset.label || submitBtn.textContent;
    submitBtn.dataset.label = prev; submitBtn.textContent = msg;
    clearTimeout(submitBtn._t); submitBtn._t = setTimeout(function () { submitBtn.textContent = submitBtn.dataset.label; }, 2000);
  }
  function doSubmit(sub) {
    if (pending() === 0) { flash("Mark an item, leave a 💬, or write a comment first"); return; }
    var text = build(sub.getAttribute("data-companion-submit") || "Review");
    try { parent.postMessage({ source: "companion-artifact", kind: "submit", text: text }, "*"); } catch (e) {}
    // Inside the Companion overlay (iframed) the overlay is the single clipboard
    // writer — it appends the artifact's file path before writing, so we must NOT
    // also self-write here or the two race and the path-less copy can win. Only
    // self-write when standalone (opened directly in a browser, not iframed).
    if (window.parent === window) {
      if (navigator.clipboard && navigator.clipboard.writeText) {
        navigator.clipboard.writeText(text)
          .then(function () { flash("Copied ✓ — ⌘V to paste"); })
          .catch(function () { flash(fallbackCopy(text) ? "Copied ✓ — ⌘V to paste" : "Sent ✓"); });
      } else { flash(fallbackCopy(text) ? "Copied ✓ — ⌘V to paste" : "Sent ✓"); }
    } else { flash("Sent to overlay ✓ — ⌘V to paste"); }
    try { if (window.__cmpShowSubmitted) window.__cmpShowSubmitted(); } catch (e) {}
  }

  // --- Comment field + post-submit "submitted" state ---------------------------
  // The comment box and the decisions submit are ONE action. When a review form
  // exists, the freeform comment sits directly above the Submit bar (end of the
  // list → comment → Submit), and the single Submit button sends decisions +
  // ambient comments + this comment together — there is no separate "Send".
  // Only a pure-recap artifact (no Submit button at all) gets a standalone Send
  // bar as a fallback. doSubmit() flips to a "submitted" screen either way.
  (function () {
    // ---- Pixel-art clawd waiting-splash library (adapted from clawd-tank, MIT) ----
    // Shared character rig — body, arms, nested eyes. Drawn once per mount.
    var CW_RIG =
      '<g class="cw-rig">' +
        '<g class="cw-body" fill="#d98a5c">' +
          '<rect x="3" y="13" width="1" height="2"/><rect x="5" y="13" width="1" height="2"/>' +
          '<rect x="9" y="13" width="1" height="2"/><rect x="11" y="13" width="1" height="2"/>' +
          '<rect x="2" y="6" width="11" height="7"/>' +
          '<g class="cw-arm-l"><rect x="0" y="9" width="2" height="2"/></g>' +
          '<g class="cw-arm-r"><rect x="13" y="9" width="2" height="2"/></g>' +
        '</g>' +
        '<g class="cw-eyes"><g class="cw-eyes-b" fill="#2a2018">' +
          '<rect x="4.5" y="8" width="1" height="2"/><rect x="9.5" y="8" width="1" height="2"/>' +
        '</g></g>' +
      '</g>';

    // Base CSS shared by every scene (halo, canvas, shadow, prop defaults).
    var CW_BASE =
      ".cmp-submitted .halo{position:absolute;top:50%;left:50%;width:200px;height:200px;transform:translate(-50%,-64%);background:radial-gradient(circle,rgba(217,138,92,.30) 0%,transparent 62%);filter:blur(6px);animation:cwHalo 4.5s ease-in-out infinite;pointer-events:none}" +
      "@keyframes cwHalo{0%,100%{opacity:.5;transform:translate(-50%,-64%) scale(1)}50%{opacity:.85;transform:translate(-50%,-64%) scale(1.08)}}" +
      ".cmp-submitted .cw{width:150px;height:150px;shape-rendering:crispEdges;overflow:visible}" +
      ".cmp-submitted .cw-shadow{fill:#201b15;opacity:.4}" +
      // sensible idle defaults so a scene only overrides what it animates
      ".cmp-submitted .cw-eyes-b{transform-origin:7.5px 9px;animation:cwBlink 4.2s steps(1) infinite}" +
      "@keyframes cwBlink{0%,45%,55%,100%{transform:scaleY(1)}50%{transform:scaleY(.12)}}" +
      // Reduced motion: freeze every pose, but keep the floating props faintly
      // visible (they start at opacity:0 and only the animation reveals them).
      "@media (prefers-reduced-motion:reduce){.cmp-submitted .cw *,.cmp-submitted .halo{animation:none!important}.cmp-submitted .cw-bit,.cmp-submitted .cw-load,.cmp-submitted .cw-str,.cmp-submitted .cw-pk,.cmp-submitted .cw-dust,.cmp-submitted .cw-wave,.cmp-submitted .cw-star,.cmp-submitted .cw-q,.cmp-submitted .cw-sp{opacity:.6!important}}";

    // Each scene: id, caption, behind/front prop SVG, and scoped CSS.
    var CW_SCENES = [
      { id:"typing", cap:"Claude’s heads-down in the code",
        behind:'<g fill="#40c4ff"><rect class="cw-bit" x="-2" y="12" width="1.4" height="1.4"/><rect class="cw-bit b2" x="6" y="11" width="1.4" height="1.4"/><rect class="cw-bit b3" x="13" y="12" width="1.4" height="1.4"/><rect class="cw-bit b4" x="3" y="10" width="1.4" height="1.4"/></g>',
        front:'<g transform="translate(2.5 10.5)"><rect x="-0.5" y="4.6" width="11" height="1" fill="#546e7a"/><rect x="0" y="0" width="10" height="4.8" fill="#78909c"/><rect x="4.5" y="2" width="1" height="1" fill="#fff"/></g>',
        css:
          ".cmp-submitted .cw--typing .cw-rig{transform-origin:7.5px 15px;animation:cwJitter .09s steps(2) infinite alternate}" +
          "@keyframes cwJitter{from{transform:translateY(0)}to{transform:translateY(.5px)}}" +
          ".cmp-submitted .cw--typing .cw-arm-l{transform-origin:2px 10px;animation:cwTypeL .16s ease-in-out infinite}" +
          ".cmp-submitted .cw--typing .cw-arm-r{transform-origin:13px 10px;animation:cwTypeR .13s ease-in-out infinite}" +
          "@keyframes cwTypeL{0%,100%{transform:rotate(58deg)}50%{transform:rotate(90deg)}}" +
          "@keyframes cwTypeR{0%,100%{transform:rotate(-58deg)}50%{transform:rotate(-90deg)}}" +
          ".cmp-submitted .cw--typing .cw-eyes{animation:cwRead 1.2s steps(1) infinite}" +
          "@keyframes cwRead{0%,32%{transform:translateX(-1.2px)}33%,66%{transform:translateX(0)}67%,100%{transform:translateX(1.2px)}}" +
          ".cmp-submitted .cw--typing .cw-eyes-b{animation:none}" +
          ".cmp-submitted .cw--typing .cw-bit{opacity:0;animation:cwBit 1s linear infinite}" +
          ".cmp-submitted .cw--typing .cw-bit.b2{animation-delay:.33s}.cmp-submitted .cw--typing .cw-bit.b3{animation-delay:.66s}.cmp-submitted .cw--typing .cw-bit.b4{animation-delay:.85s}" +
          "@keyframes cwBit{0%{opacity:0;transform:translateY(0) scale(.5)}25%{opacity:.85}100%{opacity:0;transform:translateY(-13px) scale(1.15)}}" },

      { id:"thinking", cap:"Claude’s turning it over",
        behind:'<g transform="translate(7 -10)"><g fill="#fff" opacity="0.95"><rect x="2" y="1" width="8" height="6"/><rect x="1" y="2" width="10" height="4"/><rect x="3" y="0" width="6" height="8"/><rect x="2" y="7" width="2" height="2"/><rect x="1" y="9" width="1" height="1"/></g><g fill="#0082fc"><rect class="cw-load" x="2.5" y="3" width="1.2" height="1.2"/><rect class="cw-load l2" x="5.4" y="3" width="1.2" height="1.2"/><rect class="cw-load l3" x="8.3" y="3" width="1.2" height="1.2"/></g></g>',
        front:"",
        css:
          ".cmp-submitted .cw--thinking .cw-rig{transform-origin:7.5px 15px;animation:cwSway 4s ease-in-out infinite}" +
          "@keyframes cwSway{0%,100%{transform:rotate(0deg)}25%{transform:rotate(-3deg)}75%{transform:rotate(3deg)}}" +
          ".cmp-submitted .cw--thinking .cw-arm-r{transform-origin:14px 10px;animation:cwTap .8s ease-in-out infinite alternate}" +
          "@keyframes cwTap{0%{transform:rotate(-122deg)}100%{transform:rotate(-145deg)}}" +
          ".cmp-submitted .cw--thinking .cw-load{opacity:.15;animation:cwLoad 2s infinite}" +
          ".cmp-submitted .cw--thinking .cw-load.l2{animation-delay:.25s}.cmp-submitted .cw--thinking .cw-load.l3{animation-delay:.5s}" +
          "@keyframes cwLoad{0%,18%{opacity:.15}40%,80%{opacity:1}100%{opacity:.15}}" },

      { id:"conducting", cap:"Claude’s orchestrating the next move",
        behind:'<g><rect class="cw-str" x="0" y="0" width="1.5" height="1.5" fill="#0082fc"/><rect class="cw-str s2" x="0" y="0" width="1.5" height="1.5" fill="#ffc107"/><rect class="cw-str s3" x="0" y="0" width="1.5" height="1.5" fill="#ff5252"/><rect class="cw-str s4" x="0" y="0" width="1.5" height="1.5" fill="#4caf50"/><rect class="cw-str s5" x="0" y="0" width="1.5" height="1.5" fill="#9c27b0"/></g>',
        front:"",
        css:
          ".cmp-submitted .cw--conducting .cw-rig{transform-origin:7.5px 15px;animation:cwBob 2s ease-in-out infinite}" +
          "@keyframes cwBob{0%,100%{transform:translateY(0) scaleY(1)}50%{transform:translateY(1.5px) scaleY(.98)}}" +
          ".cmp-submitted .cw--conducting .cw-arm-l{transform-origin:1px 10px;animation:cwCondL 2s ease-in-out infinite}" +
          ".cmp-submitted .cw--conducting .cw-arm-r{transform-origin:14px 10px;animation:cwCondR 2s ease-in-out infinite}" +
          "@keyframes cwCondL{0%,100%{transform:rotate(15deg)}50%{transform:rotate(85deg)}}" +
          "@keyframes cwCondR{0%,100%{transform:rotate(-85deg)}50%{transform:rotate(-15deg)}}" +
          ".cmp-submitted .cw--conducting .cw-str{opacity:0;animation:cwStream 2s linear infinite}" +
          ".cmp-submitted .cw--conducting .cw-str.s2{animation-delay:.4s}.cmp-submitted .cw--conducting .cw-str.s3{animation-delay:.8s}.cmp-submitted .cw--conducting .cw-str.s4{animation-delay:1.2s}.cmp-submitted .cw--conducting .cw-str.s5{animation-delay:1.6s}" +
          "@keyframes cwStream{0%{opacity:0;transform:translate(-2px,6px) scale(0)}15%{opacity:1;transform:translate(0,1px) scale(1)}50%{opacity:1;transform:translate(7.5px,-3px) scale(1.5)}85%{opacity:1;transform:translate(15px,1px) scale(1)}100%{opacity:0;transform:translate(17px,6px) scale(0)}}" },

      { id:"juggling", cap:"Claude’s juggling a few threads",
        behind:"",
        front:'<g><rect class="cw-pk" x="-1" y="-1" width="2" height="2" fill="#ff5252"/><rect class="cw-pk p2" x="-1" y="-1" width="2" height="2" fill="#ffc107"/><rect class="cw-pk p3" x="-1" y="-1" width="2" height="2" fill="#4caf50"/></g>',
        css:
          ".cmp-submitted .cw--juggling .cw-rig{transform-origin:7.5px 15px;animation:cwRock .6s ease-in-out infinite alternate}" +
          "@keyframes cwRock{0%{transform:rotate(-5deg)}100%{transform:rotate(5deg)}}" +
          ".cmp-submitted .cw--juggling .cw-arm-l{transform-origin:1px 10px;animation:cwJugL .6s ease-in-out infinite alternate}" +
          ".cmp-submitted .cw--juggling .cw-arm-r{transform-origin:14px 10px;animation:cwJugR .6s ease-in-out infinite alternate}" +
          "@keyframes cwJugL{0%{transform:rotate(60deg)}100%{transform:rotate(10deg)}}" +
          "@keyframes cwJugR{0%{transform:rotate(-10deg)}100%{transform:rotate(-60deg)}}" +
          ".cmp-submitted .cw--juggling .cw-eyes{animation:cwDart 1.2s infinite}" +
          "@keyframes cwDart{0%,100%{transform:translate(-2px,-2px)}25%{transform:translate(0,-3px)}50%{transform:translate(2px,-2px)}75%{transform:translate(0,0)}}" +
          ".cmp-submitted .cw--juggling .cw-eyes-b{animation:none}" +
          ".cmp-submitted .cw--juggling .cw-pk{animation:cwJuggle 1.2s linear infinite}" +
          ".cmp-submitted .cw--juggling .cw-pk.p2{animation-delay:-.4s}.cmp-submitted .cw--juggling .cw-pk.p3{animation-delay:-.8s}" +
          "@keyframes cwJuggle{0%{transform:translate(0,9px) rotate(0deg)}25%{transform:translate(8px,0) rotate(90deg)}50%{transform:translate(15px,9px) rotate(180deg)}75%{transform:translate(8px,4px) rotate(270deg)}100%{transform:translate(0,9px) rotate(360deg)}}" },

      { id:"sweeping", cap:"Claude’s sweeping up the details",
        behind:'<g class="cw-dust" fill="#9e9e9e"><rect x="0" y="0" width="1.5" height="1.5"/></g><g class="cw-dust d2" fill="#b0bec5"><rect x="0" y="0" width="1" height="1"/></g>',
        front:'<g class="cw-broom"><rect x="13.5" y="4" width="1" height="10" fill="#795548"/><rect x="12" y="14" width="4" height="2" fill="#ffc107"/></g>',
        css:
          ".cmp-submitted .cw--sweeping .cw-rig{transform-origin:7.5px 15px;animation:cwLean 1.5s ease-in-out infinite}" +
          "@keyframes cwLean{0%,100%{transform:rotate(5deg) translate(1px,0)}50%{transform:rotate(13deg) translate(3px,1px)}}" +
          ".cmp-submitted .cw--sweeping .cw-arm-l{transform-origin:1px 10px;transform:translate(6px,1px) rotate(-15deg)}" +
          ".cmp-submitted .cw--sweeping .cw-arm-r{transform-origin:14px 10px;animation:cwSwArm 1.5s ease-in-out infinite}" +
          "@keyframes cwSwArm{0%,100%{transform:rotate(0deg)}50%{transform:rotate(-20deg)}}" +
          ".cmp-submitted .cw--sweeping .cw-broom{transform-origin:13.5px 14px;animation:cwBroom 1.5s ease-in-out infinite}" +
          "@keyframes cwBroom{0%,100%{transform:rotate(10deg)}50%{transform:rotate(30deg) translate(2px,-1px)}}" +
          ".cmp-submitted .cw--sweeping .cw-dust{opacity:0;animation:cwDust 1.5s ease-out infinite}" +
          ".cmp-submitted .cw--sweeping .cw-dust.d2{animation-delay:.3s}" +
          "@keyframes cwDust{0%,40%{transform:translate(17px,14px) scale(0);opacity:0}50%{transform:translate(19px,14px) scale(1);opacity:1}100%{transform:translate(25px,14px) scale(.5);opacity:0}}" },

      { id:"beacon", cap:"Claude’s directing the subagents",
        behind:'<g fill="none"><circle class="cw-wave" cx="7.5" cy="5" r="3" stroke="#0082fc" stroke-width="0.6"/><circle class="cw-wave w2" cx="7.5" cy="5" r="3" stroke="#ffc107" stroke-width="0.6"/><circle class="cw-wave w3" cx="7.5" cy="5" r="3" stroke="#ff5252" stroke-width="0.6"/></g>',
        front:'<g><rect x="7" y="2" width="1" height="4" fill="#78909c"/><circle class="cw-ant" cx="7.5" cy="1.5" r="1" fill="#ff5252"/></g>',
        css:
          ".cmp-submitted .cw--beacon .cw-rig{transform-origin:7.5px 15px;animation:cwBeac 1.5s ease-in-out infinite}" +
          "@keyframes cwBeac{0%,100%{transform:translateY(0)}50%{transform:translateY(.5px)}}" +
          ".cmp-submitted .cw--beacon .cw-arm-l{transform-origin:1px 10px;transform:rotate(15deg)}" +
          ".cmp-submitted .cw--beacon .cw-arm-r{transform-origin:14px 10px;transform:rotate(-15deg)}" +
          ".cmp-submitted .cw--beacon .cw-wave{transform-origin:7.5px 5px;opacity:0;animation:cwWave 2s ease-out infinite}" +
          ".cmp-submitted .cw--beacon .cw-wave.w2{animation-delay:.5s}.cmp-submitted .cw--beacon .cw-wave.w3{animation-delay:1s}" +
          "@keyframes cwWave{0%{transform:scale(.4);opacity:0}10%{opacity:.7}100%{transform:scale(2.6);opacity:0}}" +
          ".cmp-submitted .cw--beacon .cw-ant{animation:cwAnt .8s ease-in-out infinite alternate}" +
          "@keyframes cwAnt{0%{opacity:.4}100%{opacity:1}}" },

      { id:"wizard", cap:"Claude’s working some magic",
        behind:'<g class="cw-stars"><polygon class="cw-star" points="14,-6 14.5,-5.5 15,-5.5 14.6,-5.1 14.8,-4.5 14,-4.9 13.2,-4.5 13.4,-5.1 13,-5.5 13.5,-5.5" fill="#ffd700"/><polygon class="cw-star sb" points="4,-4 4.5,-3.5 5,-3.5 4.6,-3.1 4.8,-2.5 4,-2.9 3.2,-2.5 3.4,-3.1 3,-3.5 3.5,-3.5" fill="#40c4ff"/><polygon class="cw-star sc" points="19,0 19.5,.5 20,.5 19.6,.9 19.8,1.5 19,1.1 18.2,1.5 18.4,.9 18,.5 18.5,.5" fill="#b388ff"/></g>',
        front:'<g class="cw-wand"><rect x="13.5" y="4" width="1" height="6" fill="#8d6e63"/><rect x="13.5" y="4" width="1" height="1" fill="#ffd700"/></g><g transform="translate(7.5 6)"><polygon points="-4,0 4,0 0,-6" fill="#673ab7"/><rect x="-5" y="0" width="10" height="1" fill="#512da8"/></g>',
        css:
          ".cmp-submitted .cw--wizard .cw-rig{transform-origin:7.5px 15px;animation:cwFloat 3s ease-in-out infinite}" +
          "@keyframes cwFloat{0%,100%{transform:translateY(0)}50%{transform:translateY(-2px)}}" +
          ".cmp-submitted .cw--wizard .cw-arm-l{transform-origin:1px 10px;animation:cwWizL 3s ease-in-out infinite}" +
          "@keyframes cwWizL{0%,100%{transform:rotate(20deg)}50%{transform:rotate(120deg)}}" +
          ".cmp-submitted .cw--wizard .cw-arm-r{transform-origin:13px 10px;animation:cwWizR 3s ease-in-out infinite}" +
          ".cmp-submitted .cw--wizard .cw-wand{transform-origin:14px 10px;animation:cwWizR 3s ease-in-out infinite}" +
          "@keyframes cwWizR{0%,100%{transform:rotate(-20deg)}50%{transform:rotate(-120deg)}}" +
          ".cmp-submitted .cw--wizard .cw-star{opacity:0;animation:cwSparkle 2s ease-out infinite}" +
          ".cmp-submitted .cw--wizard .cw-star.sb{animation-delay:.6s}.cmp-submitted .cw--wizard .cw-star.sc{animation-delay:1.2s}" +
          "@keyframes cwSparkle{0%{opacity:0;transform:translateY(4px) scale(0) rotate(0)}20%{opacity:1}100%{opacity:0;transform:translateY(-13px) scale(1.4) rotate(180deg)}}" },

      { id:"confused", cap:"Claude’s puzzling it out",
        behind:'<g class="cw-q" fill="#40c4ff"><rect x="1" y="0" width="2" height="1"/><rect x="0" y="1" width="1" height="1"/><rect x="3" y="1" width="1" height="2"/><rect x="2" y="3" width="1" height="1"/><rect x="1" y="4" width="1" height="1"/><rect x="1" y="6" width="1" height="1"/></g><g class="cw-q q2" fill="#ffc107" transform="translate(10 0)"><rect x="1" y="0" width="2" height="1"/><rect x="0" y="1" width="1" height="1"/><rect x="3" y="1" width="1" height="2"/><rect x="2" y="3" width="1" height="1"/><rect x="1" y="4" width="1" height="1"/><rect x="1" y="6" width="1" height="1"/></g>',
        front:"",
        css:
          ".cmp-submitted .cw--confused .cw-rig{transform-origin:7.5px 15px;animation:cwLook 6s ease-in-out infinite}" +
          "@keyframes cwLook{0%,10%{transform:translate(0,0)}15%,35%{transform:translate(-2px,0) rotate(-2deg)}40%,45%{transform:translate(0,0)}50%,70%{transform:translate(2px,0) rotate(2deg)}75%,100%{transform:translate(0,0)}}" +
          ".cmp-submitted .cw--confused .cw-arm-l{transform-origin:1px 10px;transform:translate(0,-2px) rotate(18deg)}" +
          ".cmp-submitted .cw--confused .cw-eyes{animation:cwLookEye 6s ease-in-out infinite}" +
          "@keyframes cwLookEye{0%,10%{transform:translate(0,0)}15%,35%{transform:translate(-2px,0)}40%,45%{transform:translate(0,0)}50%,70%{transform:translate(2px,0)}75%,100%{transform:translate(0,0)}}" +
          ".cmp-submitted .cw--confused .cw-q{opacity:0;animation:cwQL 6s ease-in-out infinite}" +
          ".cmp-submitted .cw--confused .cw-q.q2{animation:cwQR 6s ease-in-out infinite}" +
          "@keyframes cwQL{0%,15%{opacity:0;transform:translate(-6px,6px) scale(.5)}20%,30%{opacity:1;transform:translate(-8px,-2px) scale(1)}35%,100%{opacity:0;transform:translate(-8px,-8px) scale(1.2)}}" +
          "@keyframes cwQR{0%,50%{opacity:0;transform:translate(16px,6px) scale(.5)}55%,65%{opacity:1;transform:translate(18px,-2px) scale(1)}70%,100%{opacity:0;transform:translate(18px,-8px) scale(1.2)}}" },

      { id:"happy", cap:"Claude’s pretty pleased with that",
        behind:'<g class="cw-sp" fill="#ffd700"><rect x="-4" y="-2" width="1.4" height="1.4"/></g><g class="cw-sp sp2" fill="#ffa000"><rect x="18" y="-4" width="1.4" height="1.4"/></g><g class="cw-sp sp3" fill="#fff59d"><rect x="19" y="9" width="1.4" height="1.4"/></g><g class="cw-sp sp4" fill="#ffc107"><rect x="-5" y="11" width="1.4" height="1.4"/></g><g class="cw-sp sp5" fill="#fff59d"><rect x="7" y="-8" width="1.4" height="1.4"/></g>',
        front:"",
        css:
          ".cmp-submitted .cw--happy .cw-rig{transform-origin:7.5px 15px;animation:cwBounce 1s ease-in-out infinite}" +
          "@keyframes cwBounce{0%,15%,100%{transform:translateY(0) scaleY(1)}20%{transform:translateY(0) scaleY(.85)}40%{transform:translateY(-9px) scaleY(1.05)}50%{transform:translateY(-11px) scaleY(1)}60%{transform:translateY(-9px) scaleY(1.05)}80%{transform:translateY(0) scaleY(.85)}85%{transform:translateY(0) scaleY(1)}}" +
          ".cmp-submitted .cw--happy .cw-arm-l{transform-origin:2px 10px;animation:cwHapL .15s ease-in-out infinite alternate}" +
          ".cmp-submitted .cw--happy .cw-arm-r{transform-origin:13px 10px;animation:cwHapR .15s ease-in-out infinite alternate}" +
          "@keyframes cwHapL{0%{transform:rotate(45deg)}100%{transform:rotate(85deg)}}" +
          "@keyframes cwHapR{0%{transform:rotate(-45deg)}100%{transform:rotate(-85deg)}}" +
          ".cmp-submitted .cw--happy .cw-sp{opacity:0;animation:cwSpark 1.5s step-end infinite}" +
          ".cmp-submitted .cw--happy .cw-sp.sp2{animation-delay:.3s}.cmp-submitted .cw--happy .cw-sp.sp3{animation-delay:.6s}.cmp-submitted .cw--happy .cw-sp.sp4{animation-delay:.9s}.cmp-submitted .cw--happy .cw-sp.sp5{animation-delay:1.2s}" +
          "@keyframes cwSpark{0%{opacity:0}12%{opacity:1}30%{opacity:0}100%{opacity:0}}" },
    ];

    // Assemble the full stylesheet (base + every scene) once.
    var CW_CSS = CW_BASE + CW_SCENES.map(function (s) { return s.css; }).join("");

    // Build one scene's SVG: shadow + behind props + shared rig + front props.
    function cwSceneSVG(scene) {
      return '<svg class="cw cw--' + scene.id + '" viewBox="-7 -12 30 30" aria-hidden="true">' +
        '<rect class="cw-shadow" x="3" y="15" width="9" height="1"/>' +
        scene.behind + CW_RIG + scene.front +
        '</svg>';
    }

    var st = document.createElement("style");
    st.textContent =
      ".cmp-comment{grid-column:1/-1;margin:16px 0 0}" +
      ".cmp-comment textarea{display:block;width:100%;box-sizing:border-box;min-height:54px;resize:vertical;padding:10px 12px;border:1px solid rgba(32,27,21,.22);border-radius:9px;font:13px/1.5 -apple-system,system-ui,sans-serif;background:#fff;color:#201b15;outline:none}" +
      ".cmp-comment textarea:focus{border-color:#b0552f}" +
      // Selection toolbar — floats above a highlight: 💬 Ask · ✦ New session.
      ".cmp-seltb{position:fixed;z-index:10000;display:flex;align-items:center;gap:2px;padding:4px;border-radius:10px;background:#201b15;box-shadow:0 8px 22px -8px rgba(0,0,0,.5);font-family:-apple-system,system-ui,sans-serif;animation:cmpSelIn .12s ease both}" +
      "@keyframes cmpSelIn{from{opacity:0;transform:translateY(3px) scale(.97)}to{opacity:1;transform:none}}" +
      ".cmp-seltb button{border:0;background:transparent;color:#f4f1ec;font:600 12px/1 -apple-system,system-ui,sans-serif;padding:7px 11px;border-radius:7px;cursor:pointer;white-space:nowrap}" +
      ".cmp-seltb button:hover{background:rgba(255,255,255,.12)}" +
      ".cmp-seltb .sep{width:1px;height:16px;background:rgba(255,255,255,.18)}" +
      ".cmp-seltb-done{color:#f4f1ec;font:600 12px/1 -apple-system,system-ui,sans-serif;padding:7px 11px;white-space:nowrap}" +
      ".cmp-chat{display:flex;gap:8px;margin-top:18px;padding-top:14px;border-top:1px solid rgba(32,27,21,.14);grid-column:1/-1}" +
      ".cmp-chat input{flex:1;min-width:0;padding:9px 11px;border:1px solid rgba(32,27,21,.22);border-radius:8px;font:13px/1.4 -apple-system,system-ui,sans-serif;background:#fff;color:#201b15;outline:none}" +
      ".cmp-chat input:focus{border-color:#b0552f}" +
      ".cmp-chat button{flex:0 0 auto;padding:9px 14px;border-radius:8px;border:1px solid #201b15;background:#201b15;color:#f4f1ec;font:600 12px/1 -apple-system,system-ui,sans-serif;cursor:pointer}" +
      // The post-submit "Claude is working" scene — a pixel-art clawd doing a
      // random bit of work (typing, conducting, juggling, …) while the agent
      // works the next step. A fresh pose rolls on every show, so the wait never
      // feels stale. Keeps the user on the Board, out of the terminal. All motion
      // is transform/opacity, scoped to .cmp-submitted, reduced-motion aware.
      // The clawd library (CW_* above) carries the scenes + their CSS (CW_CSS).
      ".cmp-submitted{position:fixed;inset:0;z-index:9999;display:flex;flex-direction:column;align-items:center;justify-content:center;gap:18px;background:radial-gradient(120% 90% at 50% 32%,#fbf8f2 0%,rgba(244,241,236,.97) 70%);backdrop-filter:blur(3px);font-family:-apple-system,system-ui,sans-serif}" +
      ".cmp-submitted .t{font-size:16px;font-weight:650;color:#201b15;text-align:center}" +
      ".cmp-submitted .dots{margin-top:9px;text-align:center}" +
      ".cmp-submitted .dots span{display:inline-block;width:5px;height:5px;border-radius:50%;background:#c06a3a;margin:0 2px;opacity:.3;animation:cmpBlink 1.4s ease-in-out infinite}" +
      ".cmp-submitted .dots span:nth-child(2){animation-delay:.2s}.cmp-submitted .dots span:nth-child(3){animation-delay:.4s}" +
      "@keyframes cmpBlink{0%,100%{opacity:.25;transform:translateY(0)}50%{opacity:1;transform:translateY(-3px)}}" +
      ".cmp-submitted .s{font-size:12px;color:#6e655b;margin-top:8px;text-align:center;max-width:300px}" +
      ".cmp-submitted .b{margin-top:4px;padding:8px 14px;border-radius:8px;border:1px solid rgba(32,27,21,.25);background:#fff;color:#201b15;font:600 12px/1 -apple-system,system-ui,sans-serif;cursor:pointer}" +
      CW_CSS;
    document.head.appendChild(st);

    if (submitBtn) {
      // Merged path: comment field directly above the Submit bar; Submit sends all.
      var box = document.createElement("div");
      box.className = "cmp-comment";
      box.innerHTML = '<textarea placeholder="Add a comment for the terminal (optional)…" aria-label="Comment"></textarea>';
      var bar = submitBtn.closest(".bar") || submitBtn.parentElement;
      bar.parentNode.insertBefore(box, bar);
      commentEl = box.querySelector("textarea");
      commentEl.addEventListener("input", refresh);
    } else {
      // Fallback: no review form (pure recap / presentation-first). A freeform
      // Send bar at the bottom that posts immediately to the owning terminal.
      var root = document.querySelector("[data-fit-root]") || document.body;
      var cbar = document.createElement("div");
      cbar.className = "cmp-chat";
      cbar.innerHTML = '<input type="text" placeholder="Message the terminal…" aria-label="Message the terminal" autocomplete="off" autocorrect="off" autocapitalize="off" spellcheck="false"><button type="button">Send</button>';
      root.appendChild(cbar);
      var inp = cbar.querySelector("input"), snd = cbar.querySelector("button");
      var sendChat = function () {
        var v = inp.value.trim(); if (!v) return;
        try { parent.postMessage({ source: "companion-artifact", kind: "submit", text: v }, "*"); } catch (e) {}
        if (window.parent === window && navigator.clipboard) { navigator.clipboard.writeText(v).catch(function () {}); }
        inp.value = ""; var p = snd.textContent; snd.textContent = "Sent ✓";
        setTimeout(function () { snd.textContent = p; }, 1500);
        try { if (window.__cmpShowSubmitted) window.__cmpShowSubmitted(); } catch (e) {}
      };
      snd.addEventListener("click", sendChat);
      inp.addEventListener("keydown", function (e) { if (e.key === "Enter") { e.preventDefault(); sendChat(); } });
    }

    window.__cmpShowSubmitted = function () {
      if (document.querySelector(".cmp-submitted")) return;
      // Roll a fresh clawd pose every time — re-mounting the artifact (nav-back)
      // re-rolls, which is exactly the "a new one each artifact" feel we want.
      var scene = CW_SCENES[Math.floor(Math.random() * CW_SCENES.length)];
      var ov = document.createElement("div"); ov.className = "cmp-submitted";
      ov.innerHTML =
        '<div class="halo"></div>' +
        cwSceneSVG(scene) +
        '<div><div class="t">' + scene.cap + '</div>' +
        '<div class="dots"><span></span><span></span><span></span></div>' +
        '<div class="s">Your answer went to the terminal — the next artifact lands here.</div></div>' +
        '<button class="b" type="button">← View last artifact</button>';
      // Dismissing the waiting splash means "I'm going back to read the last artifact" —
      // tell the Board so it disarms auto-advance and the NEXT artifact arrives as a
      // pill instead of yanking the reader. Staying on the splash keeps auto-advance on.
      ov.querySelector("button").addEventListener("click", function () {
        try { parent.postMessage({ source: "companion-artifact", kind: "splash-dismissed" }, "*"); } catch (e) {}
        ov.remove();
      });
      document.body.appendChild(ov);
    };

    // The Board re-shows the "submitted" overlay when you navigate back to an
    // artifact you already submitted from (the iframe reloads fresh, so the
    // state would otherwise be lost). It posts this message after each reload.
    window.addEventListener("message", function (e) {
      var d = e.data;
      if (d && d.source === "companion-board" && d.kind === "restore-submitted") {
        try { window.__cmpShowSubmitted(); } catch (err) {}
      }
    });
  })();

  // --- Selection toolbar: highlight any text → 💬 Ask · ✦ New session ----------
  // Rides the same postMessage rail. "✦ New session" asks the Board to spawn a fresh
  // Claude session pre-filled with the quote (a tangent that deserves its own thread).
  // "💬 Ask" drops the quoted selection into the comment field so it goes out with the
  // next Submit (or the chat input on a pure-recap artifact). Self-contained.
  (function () {
    var subject = "";
    try { subject = (JSON.parse(document.getElementById("companion-meta").textContent).subject) || ""; } catch (e) {}
    var tb = null;
    function clearTb() { if (tb) { tb.remove(); tb = null; } }
    function selText() {
      var s = window.getSelection();
      if (!s || s.isCollapsed) return "";
      return (s.toString() || "").replace(/\s+/g, " ").trim();
    }
    function flashTb(msg) {
      if (!tb) return;
      tb.innerHTML = '<span class="cmp-seltb-done">' + msg + "</span>";
      setTimeout(clearTb, 1400);
    }
    function askAboutSelection(q) {
      // Drop the quoted selection into the comment field so it rides the next Submit;
      // fall back to the chat input on a pure-recap artifact.
      var target = commentEl || document.querySelector(".cmp-chat input");
      if (!target) return;
      var ref = 'On: "' + (q.length > 100 ? q.slice(0, 97) + "…" : q) + '" — ';
      target.value = (target.value ? target.value + "\n" : "") + ref;
      target.focus();
      try { target.setSelectionRange(target.value.length, target.value.length); } catch (e) {}
      if (target === commentEl) refresh();
    }
    function showTb() {
      var q = selText();
      if (q.length < 3) { clearTb(); return; }
      var sel = window.getSelection(), rect;
      try { rect = sel.getRangeAt(0).getBoundingClientRect(); } catch (e) { return; }
      if (!rect || (!rect.width && !rect.height)) return;
      clearTb();
      tb = document.createElement("div");
      tb.className = "cmp-seltb";
      tb.innerHTML =
        '<button type="button" data-sel="ask">💬 Ask</button>' +
        '<span class="sep"></span>' +
        '<button type="button" data-sel="new">✦ New session</button>';
      document.body.appendChild(tb);
      var tw = tb.offsetWidth, th = tb.offsetHeight;
      var left = Math.max(8, Math.min(rect.left + rect.width / 2 - tw / 2, window.innerWidth - tw - 8));
      var top = rect.top - th - 8;
      if (top < 6) top = rect.bottom + 8; // flip below the selection when no room above
      tb.style.left = left + "px";
      tb.style.top = top + "px";
      // mousedown + preventDefault so clicking a button doesn't collapse the selection
      // before the handler runs (we captured `q` already, but it keeps focus tidy).
      tb.querySelector('[data-sel="new"]').addEventListener("mousedown", function (e) {
        e.preventDefault();
        try { parent.postMessage({ source: "companion-artifact", kind: "new-session", quote: q, artifact: subject }, "*"); } catch (err) {}
        flashTb("✦ Starting a session…");
      });
      tb.querySelector('[data-sel="ask"]').addEventListener("mousedown", function (e) {
        e.preventDefault();
        askAboutSelection(q);
        clearTb();
      });
    }
    document.addEventListener("mouseup", function (e) { if (tb && tb.contains(e.target)) return; setTimeout(showTb, 10); });
    document.addEventListener("selectionchange", function () { if (!selText()) clearTb(); });
    document.addEventListener("mousedown", function (e) { if (tb && !tb.contains(e.target)) clearTb(); });
    window.addEventListener("scroll", clearTb, true);
  })();

  refresh();
})();
</script>
```

The ambient-comments and review-form snippets documented later in this file remain valid
for **single-purpose** artifacts (a pure recap, or a pure decision list). The unified helper
above supersedes them whenever a single artifact carries both.

Skip the dual shape only for genuine one-liners (a pill status flip) — nothing to question,
nothing to decide.

## The cadence (agent mode only): consider an artifact after every change

When you finish a change, run a quick meta-check — *"is this worth a heads-up?"* —
and **emit an artifact when real work was done.** The overlay is meant to be a
"here's what just changed" feed for the user; default toward showing something when
there's something to show.

**Always render for strategic / vision / direction-setting turns.** When the turn is a
*discussion* rather than a change — weighing big directions, exploring a grand-scheme
idea, evaluating options/trade-offs, doing multi-point analysis, planning architecture,
or any reply the user will want to revisit, share, or react to point-by-point — produce
the artifact (informative content pages + a Next-steps page carrying the decisions/fork).
A long, opinionated reply in chat is exactly the case that belongs on the surface, not in
the terminal scrollback. This is a primary trigger, not an edge case — don't leave a
substantive strategy answer as prose just because no file changed.

**Skip it** for: trivial conversational answers, pure code edits the user is actively
watching, one-line lookups, or when the user has said they don't want artifacts. (And
of course in **manual mode**, skip every time.)

> **The pull verb.** Regardless of mode, the user can run `/companion:html` to ask
> for an artifact about the current turn. `/companion:html` bypasses the mode check —
> it always renders. `/companion:render` is the deprecated alias and still works for
> one release.

## The form factor: size by density — but ALWAYS drive forward

Pick the artifact's **visual weight** from the content's density — but never let "small"
become "passive." Even the lightest artifact on a substantive turn carries a next step.

- **Compact card — a light change, but still propelling.** A glanceable "this is what
  changed" (title + 1–5 lines) that **still names the next move** — a recommended action, a
  one-tap decision, or the question that unblocks progress. Right for bug fixes, small edits,
  a status flip. NOT an inert dead-end: if there is genuinely nothing to decide or ask, the
  turn was trivial and you should not have rendered at all.
- **Full document — when the content earns it.** Use the room for diagrams, graphs, tables,
  multi-section plans, code reviews, comparisons, post-mortems — and end it in a decision /
  Next-steps surface that pushes the work forward.
- **Multi-page document — when the work splits into several independent subjects.**
  One self-contained file with a sidebar that navigates between pages: an overview plus
  one page per subject (per project, per incident, per area). Right when a single scroll
  would bury distinct topics that each deserve their own space — *"audit my whole wiki
  for loose ends"*, *"review these five incidents"*. See **Multi-page documents** below
  for the guardrails and template.

**Principle: don't shrink for shrinking's sake, and don't pad to fill space.** A small
pill is the *correct, finished* form for a light change — not a degraded document.
A full document is correct when there's real substance. Density decides — and when the
substance is several *independent* things, the right shape is multi-page, not a longer
scroll.

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

### Metadata block (so feedback on this artifact is self-identifying)

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
two sentences — it is the highest-leverage field for a cold agent picking up context.

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

## Two-zone layout: use the open right side (don't ship a thin column)

The most common waste in a full-document artifact is a single narrow column of prose
running top-to-bottom while the **entire right half of the Board sits empty**. Don't. When
a turn has real substance to explain, default to a **two-zone layout**: prose on the left,
a **genuinely useful visual on the right** — a diagram, chart, figure, or annotated image
that helps the user *understand the topic and make the decision*.

**The visual must earn its place.** It illustrates what the prose is arguing — a flow
diagram of the bug, a before/after, a tree of options, a data chart. **Never decorative
filler** (no stock gradients, abstract blobs, or a logo to "balance" the layout). If you
can't name what a reader learns from the visual, leave the column out and go single-column.

**Pick the visual medium by what it is:**
- **Diagrams / flows / relationships / before-after** → hand-author an inline **SVG** (no
  dependency, crisp, themeable). This covers most cases.
- **Quantitative data** → **D3** (bundled — see Bundled assets) for charts/graphs.
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
</style>
```

Reach for two-zone on any substantive full-document turn (a triage, a plan, a comparison,
an explainer). Skip it for pills, pure dashboards (those get a bespoke editorial layout),
and turns with nothing worth visualizing.

## Multi-page documents (several independent subjects in one file)

Some deliverables aren't one topic — they're *many*. *"Audit my whole wiki for loose
ends"* might surface ten projects, each with its own open threads; *"review these five
incidents"* is five write-ups. Flattening those into one long scroll buries them. Instead,
emit a **single self-contained `.html` with internal navigation**: a sidebar lists the
pages, the content pane shows the active one, an **Overview** page lands first.

**This is still ONE file.** Multi-page means internal show/hide navigation — *not*
multiple files. That keeps the self-contained rule intact, opens in a browser, pops as a
single overlay panel, and sizes through the same size-report snippet (switching pages
re-fires the `ResizeObserver`, so the panel re-fits to each page).

### When to go multi-page (all three should hold)

1. **≥3 genuinely independent subjects** that are *peers* — per-project, per-incident,
   per-component — with no single narrative thread running through them. If there *is* a
   through-line, a single scrolling document with headings reads better.
2. **Each subject has real substance** — more than a few lines. A two-line subject
   belongs in the Overview, not on its own page.
3. **The reader will want to jump**, not read top-to-bottom.

### Guardrails

- **One file, always.** Internal nav, never N separate files.
- **Lead with an Overview page** — orient the reader, give the count, one line per
  subject. It's the landing page (`.active` on load).
- **Soft cap ~12 pages.** Beyond that, group subjects or summarise the long tail on the
  Overview — don't emit 30 pages.
- **At most one submit-driven helper in the whole file.** The interactive review form
  and ambient comments both fire the single `data-companion-submit` button, so across a
  multi-page file you still get only *one* of them. Plain multi-page nav uses no submit
  button, so it composes freely with one helper — e.g. ambient comments layered on the
  pages. If you do layer ambient comments, bump `.mp-pages { padding-left: 56px }` so the
  💬 icon clears the sidebar.

### Multi-page template (copy, fill, write)

A ~780px file: a sticky sidebar of page links beside a content pane. Pure DOM show/hide
(no history API — the sandboxed iframe is opaque-origin, so `pushState` would throw).
Duplicate a `<section data-mp-page>` + its `<a data-mp-link>` per subject:

```html
<!doctype html>
<html lang="en">
<head><meta charset="UTF-8" /><title>multi-page</title>
<style>
  :root { --accent:#2e7d52; --ink:#1a1714; --muted:#6e655b; --surface:#fff;
    --paper:#f4f1ec; --line:rgba(26,23,20,0.12); }
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
      <section id="overview" data-mp-page class="active">
        <div class="kicker">Overview</div>
        <h1>What this covers</h1>
        <p>One short orienting paragraph + the count.</p>
        <ul>
          <li><strong>First subject</strong> — one-line summary.</li>
          <li><strong>Second subject</strong> — one-line summary.</li>
        </ul>
      </section>
      <section id="p1" data-mp-page>
        <div class="kicker">Subject 1 of N</div>
        <h1>First subject</h1>
        <p>Real substance for this subject.</p>
      </section>
      <section id="p2" data-mp-page>
        <div class="kicker">Subject 2 of N</div>
        <h1>Second subject</h1>
        <p>Real substance for this subject.</p>
      </section>
      <!-- one <section> per subject -->
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
</body>
</html>
```

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

## Copyable handoff blocks (paste-this-elsewhere content)

When an artifact contains content the user is meant to **copy verbatim and paste
somewhere else** — an integration brief to hand another agent ("paste this to Hermes"),
a prompt, a config/code snippet, a handoff note, an onboarding blurb — give it a **Copy
button**, never leave them to hand-select. This is a first-class capability of the
surface: a Companion artifact can deliver ready-to-paste handoffs for the user's *other*
agents/tools, so "onboard this agent" becomes "open the card → Copy → paste."

Mark the copyable element `data-copy` and pair a `data-copy-btn` button with it (same
container, or point at it with `data-copy-target="#id"`). The artifact runs in a sandboxed
iframe, so use the helper below — it tries `navigator.clipboard` then falls back to a
range-select + `execCommand("copy")` (which works for user-initiated copies even in the
sandbox). Supports multiple blocks per artifact.

```html
<div class="copy-block">
  <button type="button" data-copy-btn>Copy</button>
  <pre data-copy>the exact text to copy…</pre>
</div>
```

```html
<script>
(function () {
  document.querySelectorAll("[data-copy-btn]").forEach(function (btn) {
    btn.addEventListener("click", function () {
      var sel = btn.getAttribute("data-copy-target");
      var target = sel ? document.querySelector(sel)
                       : (btn.closest(".copy-block") || btn.parentElement).querySelector("[data-copy]");
      if (!target) return;
      var text = target.innerText;
      var done = function () { var p = btn.dataset.label || btn.textContent; btn.dataset.label = p;
        btn.textContent = "Copied ✓"; clearTimeout(btn._t);
        btn._t = setTimeout(function () { btn.textContent = btn.dataset.label; }, 1600); };
      function fallback() {
        try { var r = document.createRange(); r.selectNodeContents(target);
          var s = window.getSelection(); s.removeAllRanges(); s.addRange(r);
          document.execCommand("copy"); s.removeAllRanges(); done();
        } catch (e) { btn.textContent = "Select + ⌘C"; }
      }
      if (navigator.clipboard && navigator.clipboard.writeText) {
        navigator.clipboard.writeText(text).then(done).catch(fallback);
      } else { fallback(); }
    });
  });
})();
</script>
```

This is independent of the `data-companion-submit` helper (which routes feedback to the
agent) — a Copy button copies to the *system clipboard for the user*, so the two coexist
freely in one artifact.

## Surfacing or re-showing an artifact

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

## The L0 dashboard (`home.html`) + the modular top bar

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

### The L2 unit home (`home.<unit_key>.html`) — a durable per-project digest

`home.html` is the cross-project L0 hub. One level deeper, each **unit** (a project/git repo,
or a bare non-repo session) has its OWN durable home: write it to the reserved slug
**`home.<unit_key>.html`** in the same artifacts dir (e.g.
`~/.claude/companion/artifacts/home.canvas-board.html`). The Board loads it as the unit's
**HERO** — shown large at the top of the L2 view, above a readable **history** list of the
unit's artifacts (size your content to flow; the hero is tall but not the whole screen).

- **`unit_key`** is handed to you at session start (the `companion-session` hook injects it
  alongside the live-surface path) and is written into your live JSON. Use it verbatim as the
  filename suffix — it's the same key the Board groups sessions by.
- Same mechanics as `home.html`: a `companion-bar` block themes the top bar at L2 too; the
  `navigate` protocol works; include the `data-fit-root` + size-reporter snippet.
- It's a **digest**, not a dashboard-of-everything: "where this project's work stands now" —
  current focus, open decisions, what shipped, what's next. It **grows across sessions** (read
  the existing file, regenerate it richer), so it's the project's living memory on the Board.
- It is **optional**: when absent, the Board falls back to showing the unit's most recent
  artifact as the hero (with history below), so author one only when a curated digest adds
  real signal over "just show my latest artifact."
- **Concurrency:** two agents in one repo share one `home.<unit_key>.html` — last-writer-wins is
  fine (it's slow, curated, read-then-regenerate content). Don't try to lock it.

(This applies to any artifact, but dashboards are where the grid reflex is strongest — see
the design-quality rules: *default card grids with uniform spacing and no hierarchy* are
explicitly banned.) Pair this with the bundled fonts below — real type is half of looking
intentional.

## Bundled assets (fonts, D3, GSAP)

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

## Verify it's wired

Run `/companion:doctor` (or `companion doctor` in a shell) — it renders a health panel in
the overlay. If you can see the panel, the whole path works.
