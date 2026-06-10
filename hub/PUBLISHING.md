# Publishing to the Companion Hub (for agents)

This explains how an agent — e.g. **Hermes** on a VPS, a cron job, or any other
process — gets its **live status** and its **HTML artifacts** onto the user's
Companion overlay (on their Mac) and the hub's web UI.

The hub is **URL-agnostic** and authenticated by **one shared bearer token**.
There are two ways to publish, depending on where you run relative to the hub.

---

## The data the hub serves

The hub serves two things straight off disk, from a data dir (default
`~/.claude/companion/` on the hub machine):

1. **Live state** — `live/<project>.json`, the "what I'm doing right now" pane.
   One file per project; the newest-modified one wins. Shape:

   ```json
   {
     "working": "one line: what you're doing right now",
     "where": ["short status line", "another"],
     "next": [
       { "title": "a next step or decision", "sub": "one line of detail", "kind": "decision" }
     ],
     "project": "a label for whose work this is"
   }
   ```
   `kind` is one of `decision` | `todo` | `blocked`. Rewrite this file whenever
   your state changes; the overlay polls and updates in place.

2. **Artifacts** — `artifacts/<slug>.html`, self-contained HTML documents (a
   morning briefing, a report, a plan). Each should be a single file with inline
   CSS/JS and, in its `<head>`, a metadata block so it's identifiable:

   ```html
   <script type="application/json" id="companion-meta">
   { "subject": "Morning briefing", "summary": "Today's plan + tasks",
     "project": "hermes", "created": "2026-06-09" }
   </script>
   ```
   The filename stem is the slug (`artifacts/morning-briefing.html` → `morning-briefing`).

   **Design it however fits — it's a full HTML canvas, not a checklist.** A briefing,
   a report, a dashboard, an animated "good morning" — craft a unique, polished UI with
   your own layout, type, and motion; make it *yours*. Only add interactive review
   controls (`✓/✎/✗` + a Submit button) **à la carte**, for the few items the user should
   actually respond to — never force a rigid template onto a presentation-first artifact.
   The morning dashboard is yours to make distinctive for your user.

   **REQUIRED — sizing (get this wrong and it renders thin/tall and flickers).** The overlay
   sizes the window to your *content*, which your artifact must self-report. So: wrap your UI
   in one `<main data-fit-root>` with a **DEFINITE width** — `width: 680px` (pick what fits) —
   **never `max-width`, `width:100%`, `width:auto`, or `vw`** (those make the measured width
   oscillate → a resize feedback loop → the thin/tall flicker). Let height flow. Then include
   this snippet once at the end of `<body>`:
   ```html
   <script>
   (function () {
     var el = document.querySelector("[data-fit-root]") || document.body;
     var post = function () { parent.postMessage({ source: "companion-artifact", kind: "size",
       w: Math.ceil(el.scrollWidth), h: Math.ceil(el.scrollHeight) }, "*"); };
     if (typeof ResizeObserver !== "undefined") new ResizeObserver(post).observe(el);
     addEventListener("load", post); post();
   })();
   </script>
   ```

---

## Option A — colocated (you run on the hub machine) — works today

If your agent runs on the **same machine as the hub** (the common case: Hermes
and the hub both on the VPS), you don't need the network at all. **Just write the
files** into the hub's data dir:

- live state → `<data-dir>/live/<project>.json`
- artifacts  → `<data-dir>/artifacts/<slug>.html`

The hub serves them as-is. No token needed on your side — you're writing local
files. (The token only gates the *readers*: the Mac overlay and the web UI.)

> To find the data dir: it's whatever `COMPANION_HUB_DATA_DIR` was set to when the
> hub was started, else `~/.claude/companion/`. Check the hub's startup log — it
> prints `artifacts:` and `live:` paths on boot.

## Option B — remote (you run elsewhere) — Phase 2, see below

If your agent runs on a **different machine** than the hub, you can't write its
files directly. The hub will expose authenticated ingest endpoints (Phase 2):

- `POST /api/publish/live`     — body = the live-state JSON above
- `POST /api/publish/artifact` — body = the artifact HTML (slug from a header/field)

Both require `Authorization: Bearer <token>`. Example once it lands:

```sh
curl -fsS -X POST "$HUB_URL/api/publish/live" \
  -H "Authorization: Bearer $HUB_TOKEN" \
  -H "Content-Type: application/json" \
  --data @live.json
```

Until Phase 2 ships, a remote agent can still publish by writing to a path that
**syncs** to the hub machine (e.g. a Syncthing/rsync'd dir that the hub's data
dir points at) — that reuses Option A.

---

## What you need from the user to wire this up

Ask the user for (or read from the hub's environment):

- **`HUB_URL`** — where the hub is reachable (public https domain, Tailscale IP,
  or LAN address). Only needed for Option B.
- **`HUB_TOKEN`** — the shared bearer token. The hub prints it on first run and
  stores it at `<data-dir>/hub-token`. Only needed for Option B (readers + remote
  publishers); a colocated writer doesn't need it.
- **`DATA_DIR`** — the hub's data dir, for Option A. Default `~/.claude/companion/`.

That's it: write the two file shapes above (Option A), or POST them (Option B),
and your status + artifacts show up on the user's overlay and web UI.
