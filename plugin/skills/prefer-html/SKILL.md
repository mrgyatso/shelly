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

## Verify it's wired

Run `/companion:doctor` (or `companion doctor` in a shell) — it renders a health panel in
the overlay. If you can see the panel, the whole path works.
