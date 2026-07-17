---
name: dashboard
description: Compose the Shelly Board's L0 Hub dashboard — the agent-authored "home" surface the user lands on. Write a single self-contained HTML file to exactly `${SHELLY_ARTIFACTS_DIR:-~/.shelly/artifacts}/home.html`; the Board hosts it full-bleed and routes its navigate buttons into the three-level drill-down (Hub → Sessions → one session). Use when the user runs `/shelly:dashboard`, asks to design / compose / refresh their Shelly home screen or hub, or wants a glanceable triage view across their running agents. The hub is a TRIAGE-FIRST glance (who needs you, a briefing line, one button per live source) — not a one-off report. It is the reserved `home.html` slug; do NOT load `prefer-html` for it (different shape: full-bleed, no window size-reporter, no Next-steps page).
---

# Shelly Dashboard — author the Board's L0 Hub (`home.html`)

The Shelly Board is a 3-level drill-down:

```
L0  Hub          ← THIS skill authors it (home.html). Full-bleed, agent-composed.
       └▸ L1  Sessions picker   (native; one card per running agent)
              └▸ L2  one session's artifacts (the bento board)
```

The Hub is the **first thing the user sees** when they open the Board (`shelly
board`). When no `home.html` exists, the Board shows a plain native fallback. This
skill replaces that fallback with a glanceable, **triage-first** dashboard you compose.

## The one hard rule: the path

Write exactly one file to:

```
${SHELLY_ARTIFACTS_DIR:-~/.shelly/artifacts}/home.html
```

Confirm the live dir with `shelly doctor` (the "artifacts dir" line). The file
**must** sit in the artifacts dir — that's the only path in the overlay's `asset:`
scope, which is what lets the Hub's navigate buttons' inline JS actually run. The
reserved `home.html` name is special-cased: it never shows as a Board tile, never
appears in the History HUD, and writing it pops **no** floating panel (unlike every
other artifact). So re-authoring it just refreshes the Hub on the user's next entry.

## What to compose — triage first

The Hub answers, at a glance: **who needs me, and where do I go?** Lead with triage,
not chrome. A good hub has, roughly top to bottom:

1. **A who-needs-you line.** Scan the running agents (below) for any that are blocked
   or awaiting review; name them first. If none, say so calmly ("All agents nominal").
2. **A one-line briefing.** The single most useful sentence about the current state of
   the user's work right now.
3. **One navigate button per live source**, plus an **"All sessions →"** button. These
   are the actual navigation — see the convention below.

Keep it calm and glanceable — it's a home screen, not a slide. Design it well (it's a
real surface the user lives in), but don't bury the triage under decoration.

### Reading the running agents

The live sources are the per-session JSON files under
`~/.shelly/live/<slug>.json` (each: `working`, `where`, `next[]`, `project`).
List them and read the ones you want to surface:

```bash
ls ~/.shelly/live/ 2>/dev/null
cat ~/.shelly/live/<slug>.json 2>/dev/null
```

The `<slug>` (the filename without `.json`) is the **session id** you target in a
`session:<slug>` navigate button. An agent whose top `next[].kind` is `blocked` is the
one to flag first; `todo` / `in-progress` is busy; `done` / `ok` is calm.

## The navigate-button convention

The Board listens for navigation requests from the Hub iframe. A button opts in with a
`data-shelly-navigate` attribute whose value is the destination:

| `data-shelly-navigate` value | Goes to |
| --- | --- |
| `sessions` | L1 — the Sessions picker (all agents) |
| `session:<slug>` | L2 — that one agent's artifacts |
| `artifact:<abs-path>` | L2 for that artifact's session, with the tile focused |
| `hub` | back to L0 (rarely needed from the Hub itself) |

```html
<button data-shelly-navigate="sessions">All sessions →</button>
<button data-shelly-navigate="session:shelly">Resume Shelly →</button>
```

Drop this **tiny helper once**, before `</body>`. It delegates clicks from any element
carrying `data-shelly-navigate` and posts the message the Board validates:

```html
<script>
  (function () {
    document.addEventListener("click", function (e) {
      var el = e.target.closest ? e.target.closest("[data-shelly-navigate]") : null;
      if (!el) return;
      var to = el.getAttribute("data-shelly-navigate");
      if (to) parent.postMessage({ source: "shelly-artifact", kind: "navigate", to: to }, "*");
    });
  })();
</script>
```

The Board treats every payload as **untrusted**: a `session:<slug>` that isn't a known
live source is silently ignored, and an `artifact:<path>` is opened only if it passes
the asset-scope check. So a stale or wrong button can't navigate anywhere unsafe — but
it also won't work, so target real slugs you read from the live dir.

## Full-bleed: what to OMIT

The Hub fills the Board surface edge-to-edge. It does **not** float and does **not**
resize a window, so unlike a normal artifact it must **omit the window size-reporter
snippet** (the `data-fit-root` + `postMessage({kind:"size"})` block). Including it does
no harm but is pointless — the Hub is never measured.

- **No** `data-fit-root` / size-reporter. Style `html, body { margin:0; height:100%; }`
  and let your layout fill the viewport.
- **No** Next-steps / review form, **no** `data-shelly-commentable` blocks — those
  are for steering artifacts (`prefer-html`), not the home surface.
- `shelly-meta` is optional here (the Hub isn't a history entry).
- Self-contained: inline all CSS/JS, no external requests (the iframe is sandboxed
  `allow-scripts` with no same-origin, so storage/fetch won't work — only postMessage,
  which the helper uses).

## A crab mascot (encouraged)

Give the Hub a little life: a pixel-art **crab** shelly (the same character that
greets the post-submit waiting splash). A ready-to-paste, self-contained block lives next
to this skill at **`crab-snippet.html`** (in this skill's directory) — **read that file and
paste its whole contents into `home.html`**. It defines `<div id="crab-mascot">` plus an
inline script that animates a random pose on load (typing · thinking · conducting); no
external requests, so it's safe in the sandboxed full-bleed iframe.

- Place the `<div id="crab-mascot">` where it fits your composition — beside the greeting,
  a quiet corner, or as a hero flourish. Size it via the div's `width`/`height`.
- It's a flourish, not the point — keep the **triage-first** content primary; crab accents
  it. Skip it if the layout is already dense.
- Motion is transform/opacity only and honors `prefers-reduced-motion`.

## Minimal skeleton

```html
<!doctype html>
<html lang="en">
<head>
  <meta charset="UTF-8" />
  <style>
    html, body { margin: 0; height: 100%; background: oklch(0.945 0.014 60); }
    body { font-family: ui-sans-serif, system-ui, sans-serif; color: oklch(0.265 0.012 55);
           display: flex; flex-direction: column; gap: 20px; padding: 48px; box-sizing: border-box; }
    h1 { font-family: Georgia, serif; font-weight: 420; font-size: 30px; margin: 0; }
    .brief { font-family: ui-monospace, monospace; font-size: 13px; color: oklch(0.45 0.012 55); }
    .row { display: flex; flex-wrap: wrap; gap: 10px; }
    button { font: inherit; font-size: 14px; border: 0; border-radius: 11px; padding: 10px 18px;
             background: oklch(0.988 0.007 60); box-shadow: 0 1px 3px oklch(0 0 0 / 0.1); cursor: pointer; }
    button.primary { background: #cc785c; color: #fff; }
  </style>
</head>
<body>
  <!-- Optional crab mascot: paste crab-snippet.html's block here (or anywhere),
       then position #crab-mascot to taste. See "A crab mascot" above. -->
  <div id="crab-mascot" class="crab-stage" style="width:120px;height:120px"></div>
  <h1>Good morning. <em>2 agents need you.</em></h1>
  <div class="brief">helpdesk-shelly is BLOCKED on the demo recording · everything else nominal.</div>
  <div class="row">
    <button data-shelly-navigate="session:helpdesk-shelly" class="primary">helpdesk-shelly →</button>
    <button data-shelly-navigate="session:shelly">shelly →</button>
    <button data-shelly-navigate="sessions">All sessions →</button>
  </div>
  <script>
    (function () {
      document.addEventListener("click", function (e) {
        var el = e.target.closest ? e.target.closest("[data-shelly-navigate]") : null;
        if (!el) return;
        var to = el.getAttribute("data-shelly-navigate");
        if (to) parent.postMessage({ source: "shelly-artifact", kind: "navigate", to: to }, "*");
      });
    })();
  </script>
</body>
</html>
```

## After writing

Tell the user it's live and how to see it: open the Board with `shelly board` (or, if
already open, leave & re-enter L0 — the Hub re-resolves on each entry, not live). The
buttons drill straight into the picker / a session.
