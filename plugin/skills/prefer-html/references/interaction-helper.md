# Interaction helper — commentable blocks + Decide ballot → one submit

Paste-able, self-contained interactivity for a Shelly artifact. **Load this file when the
artifact has commentable content, a Decide review ballot, or both.** Copy the `<script>` **verbatim**
(do not retype or trim it). The **ambient-comments CSS is included below** (one fetch, self-sufficient);
style the review-item ballot (`.item`, `.act`, `.bar`, `[data-state]`) yourself in the Broadsheet house style.

One unified Submit gathers block-comments **and** item-decisions into one pasteable payload. Put
`data-shelly-commentable` only on **content** blocks, never on the Next-steps ballot, so the two
do not double up on the same block.

## HTML wiring

```html
<!-- content page(s): commentable -->
<section data-shelly-commentable> … prose, lists, headings … </section>
<!-- the Next-steps ballot: review items, NOT commentable -->
<section>
  <div class="item" data-shelly-item data-item-label="Short label that reads well in the submit message">
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
  <div class="bar">
    <span class="count" data-count>nothing marked yet</span>
    <button class="doall" data-doall>✓ Do all</button>
    <button class="submit" data-shelly-submit="Title that prefixes the compiled message">Submit → ⌘V</button>
  </div>
</section>
```

The helper auto-discovers semantic blocks (`p, li, h2–h4, blockquote, pre`) inside a
`data-shelly-commentable` region. Content in styled `<div>`s is invisible to that list — add
`data-shelly-block` to any such container to make it commentable.

**Click anywhere — comment on anything, not just marked blocks. No mode, no toggle.** Prose,
list items and headings inside `data-shelly-commentable` keep working exactly as above (hover →
gutter 💬 → click the icon) so reading and text selection are never disturbed by a stray click.
For everything else on the page — a card, an image, a whole section, anything not already
commentable and not a native interactive control — a plain click opens the same composer
immediately, keyed off a generated name + short CSS-ish path instead of a text snippet. Hovering
such an element first shows a small, decorative 💬 hint near its corner (`pointer-events: none` —
it never intercepts the click itself) so the reader knows it's there before they click. There is
no activation step: it's live the moment the page loads, same as the gutter icons. Both paths
write into the same `comments`/`picked` state and compile into the one Submit payload — no second
submit button, no separate flow. Native interactive elements (`a`, `button`, `input`, etc.) and
the Decide ballot are excluded automatically; give any other custom-interactive region (rare) a
`data-shelly-noninspect` attribute to opt it out too.

**Reading always wins over picking.** Two guards keep the picker from fighting the reader, and
they apply to the *whole* page, not just commentable regions: a click that ends a **text
selection** is treated as a read and never opens a composer (otherwise dragging across any
non-commentable text would pop a composer and wipe the selection — an artifact you can't copy
from); and `body` / `documentElement` / the `data-fit-root` wrapper are never pickable, so
clicking dead space dismisses rather than spawning a composer named `body` with an empty path.

## The unified helper script (copy verbatim)

```html
<script>
(function () {
  var BLOCK_SELECTOR = "p, li, h2, h3, h4, blockquote, pre, [data-shelly-block]";
  var submitBtn = document.querySelector("[data-shelly-submit]");
  var countEl = document.querySelector("[data-count]");
  var items = [].slice.call(document.querySelectorAll("[data-shelly-item]"));
  var comments = new Map();
  var open = null;

  // ambient comments on every commentable block (skipping review items)
  var blocks = [];
  [].slice.call(document.querySelectorAll("[data-shelly-commentable]")).forEach(function (root) {
    [].slice.call(root.querySelectorAll(BLOCK_SELECTOR)).forEach(function (b) {
      if (b.closest("[data-shelly-item]")) return;
      if (b.parentElement && b.parentElement.closest(BLOCK_SELECTOR)) return; // avoid nested icons
      blocks.push(b);
    });
  });
  blocks.forEach(function (b, i) {
    b.classList.add("shelly-commentable");
    b.dataset.cBlockId = "b" + i;
    var btn = document.createElement("button");
    btn.type = "button"; btn.className = "shelly-ask-btn";
    btn.title = "Comment on this block"; btn.textContent = "💬";
    btn.addEventListener("click", function (e) { e.stopPropagation(); openFor(b); });
    b.appendChild(btn);
  });
  function snippet(b) {
    var c = b.cloneNode(true); var x = c.querySelector(".shelly-ask-btn"); if (x) x.remove();
    var t = (c.textContent || "").replace(/\s+/g, " ").trim();
    return t.length > 80 ? t.slice(0, 77) + "…" : t;
  }
  function closeOpen() { if (open) { open.remove(); open = null; } }
  function openFor(b) {
    closeOpen();
    var id = b.dataset.cBlockId;
    var box = document.createElement("div");
    box.className = "shelly-composer";
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
    note.className = "shelly-annotation"; note.dataset.forBlock = b.dataset.cBlockId;
    note.textContent = t; note.addEventListener("click", function () { openFor(b); });
    b.parentNode.insertBefore(note, b.nextSibling);
  }
  function removeAnno(b) {
    var n = b.parentNode.querySelector('.shelly-annotation[data-for-block="' + b.dataset.cBlockId + '"]');
    if (n) n.remove();
  }

  // --- Click anywhere: comment on ANY element, not just auto-discovered blocks -
  // No mode, no toggle, no activation step — live from page load. A plain click
  // on anything that isn't already commentable, a native interactive control, or
  // the ballot opens a composer immediately. A small pointer-events:none 💬 hint
  // previews the target on hover so the reader knows before they click; it never
  // intercepts the click itself, so it can't fight the artifact's own
  // interactivity (blob expand, ballot buttons, links) — those simply aren't
  // matched by isDirectPickable() below and are left completely alone.
  // Naming/path logic here is written from scratch for Shelly's simpler target
  // (one static file, no shadow DOM, no framework) — not derived from any
  // third-party component-detection tool.
  var picked = new Map(); // pickId -> { name, path, comment }
  var pickCounter = 0;
  var pickPop = null;

  function firstReadableClass(el) {
    var raw = el.className;
    if (typeof raw !== "string" || !raw) return "";
    var tokens = raw.split(/\s+/);
    for (var i = 0; i < tokens.length; i++) {
      var t = tokens[i];
      if (t.length > 2 && t.length < 24 && !/^[a-z]{1,2}$/.test(t) && !/\d{4,}/.test(t)) return t;
    }
    return "";
  }
  function describeEl(el) {
    var tag = el.tagName.toLowerCase();
    if (tag === "img") { var alt = el.getAttribute("alt"); return alt ? 'image "' + alt.slice(0, 30) + '"' : "image"; }
    if (tag === "button" || tag === "a") {
      var label = (el.getAttribute("aria-label") || el.textContent || "").replace(/\s+/g, " ").trim().slice(0, 30);
      return label ? tag + ' "' + label + '"' : tag;
    }
    if (/^h[1-6]$/.test(tag)) {
      var ht = (el.textContent || "").replace(/\s+/g, " ").trim().slice(0, 40);
      return ht ? tag + ' "' + ht + '"' : tag;
    }
    if (tag === "input" || tag === "textarea" || tag === "select") {
      return tag + " [" + (el.getAttribute("placeholder") || el.getAttribute("name") || el.getAttribute("type") || tag) + "]";
    }
    var cls = firstReadableClass(el);
    if (cls) return tag + "." + cls;
    var text = (el.textContent || "").replace(/\s+/g, " ").trim();
    if (text && text.length < 60 && !el.children.length) return '"' + text + '"';
    return el.id ? tag + "#" + el.id : tag;
  }
  function pathFor(el) {
    var root = document.querySelector("[data-fit-root]") || document.body;
    var parts = [], node = el, depth = 0;
    while (node && node !== root && node.nodeType === 1 && depth < 5) {
      var seg = node.tagName.toLowerCase();
      if (node.id) { parts.unshift(seg + "#" + node.id); break; }
      var cls = firstReadableClass(node);
      if (cls) { seg += "." + cls; }
      else if (node.parentElement) {
        var same = [].filter.call(node.parentElement.children, function (c) { return c.tagName === node.tagName; });
        if (same.length > 1) seg += ":nth-of-type(" + (same.indexOf(node) + 1) + ")";
      }
      parts.unshift(seg);
      node = node.parentElement;
      depth++;
    }
    return parts.join(" > ");
  }
  // A click target qualifies for the direct "open a composer" behavior only when
  // it is none of: a native interactive control, the ballot / chrome / composer
  // itself, or an element already covered by the gutter-icon block system above.
  function isDirectPickable(el) {
    if (!el || el.nodeType !== 1) return false;
    // The page itself is not a target: clicking dead space would otherwise open a
    // composer named "body" with an empty path, and every click-away would spawn
    // another one instead of dismissing the open composer.
    if (el === document.body || el === document.documentElement) return false;
    if (el.hasAttribute("data-fit-root")) return false;
    if (el.closest("a, button, input, select, textarea, label, summary, [role='button'], [tabindex]")) return false;
    if (el.closest(
      "[data-shelly-noninspect], [data-shelly-item], .decide, .bar, .cmp-comment, .cmp-chat, " +
      ".shelly-composer, .pick-popover, .shelly-pick-badge, .shelly-annotation, .cmp-submitted"
    )) return false;
    if (el.closest("[data-c-block-id]")) return false;
    return true;
  }
  function closePick() { if (pickPop) { pickPop.remove(); pickPop = null; } }
  function openPickComposer(el, id) {
    closeOpen(); closePick();
    var name = describeEl(el), path = pathFor(el);
    var box = document.createElement("div");
    box.className = "shelly-composer pick-popover";
    box.innerHTML = '<div class="ref"></div>' +
      '<textarea placeholder="Your question or comment about this element…"></textarea>' +
      '<div class="row"><button type="button" class="delete">Discard</button>' +
      '<div style="display:flex;gap:6px;"><button type="button" class="cancel">Cancel</button>' +
      '<button type="button" class="save">Save</button></div></div>';
    box.querySelector(".ref").textContent = name + " — " + path;
    document.body.appendChild(box);
    var rect = el.getBoundingClientRect();
    var left = Math.max(8, Math.min(rect.left, window.innerWidth - box.offsetWidth - 8 || window.innerWidth - 276));
    var top = rect.bottom + 8;
    if (top + 170 > window.innerHeight) top = Math.max(8, rect.top - 178);
    box.style.position = "fixed"; box.style.zIndex = "10001"; box.style.width = "260px";
    box.style.left = left + "px"; box.style.top = top + "px";
    pickPop = box;
    var ta = box.querySelector("textarea");
    var prior = picked.get(id); ta.value = prior ? prior.comment : "";
    setTimeout(function () { ta.focus(); }, 60);
    box.querySelector(".save").addEventListener("click", function () {
      var v = ta.value.trim();
      if (v) { picked.set(id, { name: name, path: path, comment: v }); el.classList.add("shelly-pick-marked"); }
      else { picked.delete(id); el.classList.remove("shelly-pick-marked"); }
      closePick(); refresh();
    });
    box.querySelector(".cancel").addEventListener("click", closePick);
    box.querySelector(".delete").addEventListener("click", function () {
      picked.delete(id); el.classList.remove("shelly-pick-marked"); closePick(); refresh();
    });
  }

  // Decorative hover hint — a single reused node, repositioned to whatever's
  // under the cursor. pointer-events:none so it can never itself be the click
  // target; the real click always lands on the underlying element.
  var pickBadge = null;
  function showPickBadge(el) {
    if (!pickBadge) {
      pickBadge = document.createElement("div");
      pickBadge.className = "shelly-pick-badge";
      pickBadge.textContent = "💬";
      document.body.appendChild(pickBadge);
    }
    var r = el.getBoundingClientRect();
    pickBadge.style.left = Math.max(4, Math.min(r.right - 12, window.innerWidth - 26)) + "px";
    pickBadge.style.top = Math.max(4, r.top - 12) + "px";
    pickBadge.style.display = "flex";
  }
  function hidePickBadge() {
    if (pickBadge) pickBadge.style.display = "none";
  }
  document.addEventListener("mousemove", function (e) {
    if (pickPop) { hidePickBadge(); return; }
    var el = document.elementFromPoint(e.clientX, e.clientY);
    if (!isDirectPickable(el)) { hidePickBadge(); return; }
    showPickBadge(el);
  });
  window.addEventListener("scroll", hidePickBadge, true);

  document.addEventListener("click", function (e) {
    var el = e.target;
    // A click that ends a text selection is a READ, not a pick — without this,
    // dragging across any non-commentable text pops a composer and wipes the
    // selection, so the reader can never copy from an artifact.
    if (String(window.getSelection() || "").trim()) return;
    if (!isDirectPickable(el)) return;
    hidePickBadge();
    var id = el.dataset.pickId;
    if (!id) { id = "pk" + (pickCounter++); el.dataset.pickId = id; }
    openPickComposer(el, id);
  });

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
    if (btn) { var it = btn.closest("[data-shelly-item]"); if (it) setState(it, btn.getAttribute("data-action")); return; }
    if (e.target.closest("[data-doall]")) {
      items.forEach(function (it) { it.setAttribute("data-state", "approve");
        var ta = it.querySelector("textarea[data-comment]"); if (ta) ta.style.display = "none"; });
      refresh(); return;
    }
    var sub = e.target.closest("[data-shelly-submit]");
    if (sub) doSubmit(sub);
  });

  var commentEl = null; // the single freeform comment field, injected below
  function freeComment() { return commentEl ? commentEl.value.trim() : ""; }
  function pending() {
    return comments.size + picked.size + document.querySelectorAll("[data-shelly-item][data-state]").length + (freeComment() ? 1 : 0);
  }
  function refresh() {
    var c = comments.size + picked.size, d = document.querySelectorAll("[data-shelly-item][data-state]").length, fc = freeComment() ? 1 : 0;
    if (countEl) countEl.textContent = (c || d || fc)
      ? (d + " decision" + (d !== 1 ? "s" : "") + (c ? (" · " + c + " comment" + (c !== 1 ? "s" : "")) : "") + (fc ? " · note added" : ""))
      : "nothing marked yet";
    if (submitBtn) submitBtn.classList.toggle("ready", (c + d + fc) > 0);
  }
  function meta() {
    var el = document.getElementById("shelly-meta");
    if (!el) return [];
    try { var m = JSON.parse(el.textContent); } catch (e) { return []; }
    var L = ["[Shelly artifact feedback]"];
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
    if (cBlocks.length || picked.size) {
      lines.push("— Questions / comments —", "");
      cBlocks.forEach(function (b) {
        lines.push("On: " + JSON.stringify(snippet(b)));
        comments.get(b.dataset.cBlockId).split("\n").forEach(function (l) { lines.push("    " + l); });
        lines.push("");
      });
      picked.forEach(function (p) {
        lines.push("On: " + p.name + " (" + p.path + ")");
        p.comment.split("\n").forEach(function (l) { lines.push("    " + l); });
        lines.push("");
      });
    }
    var marked = [].slice.call(document.querySelectorAll("[data-shelly-item][data-state]"));
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
    var text = build(sub.getAttribute("data-shelly-submit") || "Review");
    try { parent.postMessage({ source: "shelly-artifact", kind: "submit", text: text }, "*"); } catch (e) {}
    // Inside the Shelly overlay (iframed) the overlay is the single clipboard
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
    // ---- Pixel-art crab waiting-splash library (adapted from clawd-tank, MIT) ----
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
      { id:"typing", cap:"Your agent’s heads-down in the code",
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

      { id:"thinking", cap:"Your agent’s turning it over",
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

      { id:"conducting", cap:"Your agent’s orchestrating the next move",
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

      { id:"juggling", cap:"Your agent’s juggling a few threads",
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

      { id:"sweeping", cap:"Your agent’s sweeping up the details",
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

      { id:"beacon", cap:"Your agent’s directing the subagents",
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

      { id:"wizard", cap:"Your agent’s working some magic",
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

      { id:"confused", cap:"Your agent’s puzzling it out",
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

      { id:"happy", cap:"Your agent’s pretty pleased with that",
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
      // The post-submit "Claude is working" scene — a pixel-art crab doing a
      // random bit of work (typing, conducting, juggling, …) while the agent
      // works the next step. A fresh pose rolls on every show, so the wait never
      // feels stale. Keeps the user on the Board, out of the terminal. All motion
      // is transform/opacity, scoped to .cmp-submitted, reduced-motion aware.
      // The crab library (CW_* above) carries the scenes + their CSS (CW_CSS).
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
        try { parent.postMessage({ source: "shelly-artifact", kind: "submit", text: v }, "*"); } catch (e) {}
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
      // Roll a fresh crab pose every time — re-mounting the artifact (nav-back)
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
        try { parent.postMessage({ source: "shelly-artifact", kind: "splash-dismissed" }, "*"); } catch (e) {}
        ov.remove();
      });
      document.body.appendChild(ov);
    };

    // The Board re-shows the "submitted" overlay when you navigate back to an
    // artifact you already submitted from (the iframe reloads fresh, so the
    // state would otherwise be lost). It posts this message after each reload.
    window.addEventListener("message", function (e) {
      var d = e.data;
      if (d && d.source === "shelly-board" && d.kind === "restore-submitted") {
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
    try { subject = (JSON.parse(document.getElementById("shelly-meta").textContent).subject) || ""; } catch (e) {}
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
        try { parent.postMessage({ source: "shelly-artifact", kind: "new-session", quote: q, artifact: subject }, "*"); } catch (err) {}
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

## Ambient-comments CSS (pair with the helper)

The helper adds these classes for the 💬 affordance and the inline composer — include this `<style>` so
they render right. Tune the colors to your artifact’s accent. (The review-item ballot — `.item`,
`.act`, `.bar`, `[data-state]` — you style yourself in the Broadsheet house style.)

```html
<style>
  [data-shelly-commentable] .shelly-commentable {
    position: relative; border-radius: 5px; cursor: text;
    transition: background 140ms ease, box-shadow 140ms ease;
  }
  /* Hover-bridge: extend the hover hit area 36 px into the left gutter so
     the cursor doesn't leave :hover while travelling toward the 💬 icon. */
  .shelly-commentable::before {
    content: ""; position: absolute;
    top: 0; left: -36px; width: 36px; height: 100%;
  }
  .shelly-commentable:hover {
    background: rgba(182,120,29,0.07); box-shadow: inset 2px 0 0 #b6781d;
  }
  .shelly-commentable.has-comment {
    background: rgba(46,125,82,0.05); box-shadow: inset 2px 0 0 #2e7d52;
  }
  .shelly-ask-btn {
    position: absolute; left: -36px; top: 50%; transform: translateY(-50%);
    width: 26px; height: 26px; padding: 0;
    border: 1px solid rgba(26,23,20,0.2); background: #fff; color: #6e655b;
    border-radius: 6px; cursor: pointer;
    display: none; align-items: center; justify-content: center;
    font-size: 12px; box-shadow: 0 4px 10px -6px rgba(26,23,20,0.4);
  }
  .shelly-commentable:hover > .shelly-ask-btn,
  .shelly-commentable.has-comment > .shelly-ask-btn { display: inline-flex; }
  .shelly-commentable.has-comment > .shelly-ask-btn {
    color: #2e7d52; border-color: #2e7d52;
  }
  .shelly-composer {
    margin: 6px 0 10px; padding: 10px 11px;
    background: #fff; border: 1px solid #b6781d; border-radius: 8px;
    box-shadow: 0 10px 24px -16px rgba(26,23,20,0.5);
  }
  .shelly-composer .ref {
    font: 600 11px/1.4 ui-monospace, Menlo, monospace; color: #6e655b;
    border-left: 2px solid #b6781d; padding: 4px 8px; margin-bottom: 6px;
    background: rgba(182,120,29,0.07); border-radius: 0 4px 4px 0;
  }
  .shelly-composer textarea {
    display: block; width: 100%; min-height: 64px; padding: 8px 10px;
    font: 13px/1.5 -apple-system, system-ui, sans-serif;
    background: #f4f1ec; color: #1a1714;
    border: 1px solid rgba(26,23,20,0.2); border-radius: 6px;
    outline: none; resize: vertical; box-sizing: border-box;
  }
  .shelly-composer textarea:focus { border-color: #b6781d; }
  .shelly-composer .row {
    display: flex; justify-content: space-between; gap: 8px; margin-top: 8px;
  }
  .shelly-composer button {
    font: 600 11.5px/1 -apple-system, system-ui, sans-serif;
    padding: 7px 11px; border-radius: 6px; cursor: pointer;
    border: 1px solid rgba(26,23,20,0.2); background: #fff; color: #1a1714;
  }
  .shelly-composer button.save {
    background: #1a1714; color: #f4f1ec; border-color: #1a1714;
  }
  .shelly-composer button.delete {
    color: #6e655b; border-color: transparent; background: transparent;
  }
  .shelly-annotation {
    margin: 4px 0 10px; padding: 7px 10px;
    background: rgba(46,125,82,0.08); border-left: 2px solid #2e7d52;
    border-radius: 0 6px 6px 0; color: #1a1714;
    font-size: 12.5px; line-height: 1.5; cursor: pointer;
  }
  .shelly-annotation::before { content: "💬 "; }

  /* Click-anywhere picker: decorative hover hint + persistent "has comment" marker.
     No toggle, no mode CSS — this is live from page load. */
  .shelly-pick-badge {
    position: fixed; pointer-events: none; z-index: 10000; display: none;
    align-items: center; justify-content: center; width: 24px; height: 24px;
    border-radius: 7px; background: #1a1714; color: #f4f1ec; font-size: 12px;
    box-shadow: 0 6px 16px -8px rgba(0,0,0,.6); opacity: .9;
  }
  .shelly-pick-marked { outline: 2px solid #2e7d52; outline-offset: 2px; cursor: pointer; }
</style>
```

## Pre-ship self-check

- [ ] This `<script>` is present and **unedited** (copy-paste, do not retype).
- [ ] Every `[data-action]` button sits inside a `[data-shelly-item]` ancestor.
- [ ] Exactly one `[data-shelly-submit]` button exists.
- [ ] No `position:fixed`/absolute element overlaps the buttons at load (the `.cmp-submitted`
      overlay is fine — it only appears *after* submit).
- [ ] The click-anywhere picker never fights native interactive elements or the Decide ballot —
      both are excluded automatically (`isDirectPickable`); no extra markup needed unless a
      custom non-ballot region also needs `data-shelly-noninspect`.
