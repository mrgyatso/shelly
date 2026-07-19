# Shelly demo video — recording script

Target: 60–90 seconds. Goal: someone who's never seen Shelly understands the loop —
**agent works → turn becomes a page → you answer with a click** — before they get bored.

## Before you hit record

- Do Not Disturb on (no notification banners).
- Close anything with sensitive tabs/windows open; Shelly will be full-screen or near it.
- Pick a resolution you'd actually publish at (1440p/1080p). Screen Studio, QuickTime, or Kap all work.
- Use the **replay setup** below so the recording is a clean, repeatable take instead of a live
  API call that might be slow or say something dumb on camera. You can also do a genuine live
  take once you're happy with the choreography — see "Alternative: fully live" at the end.

## Setup: the replay trick (do this once, before recording)

This makes a real Claude session "recall" a polished, pre-built page instead of generating one
live — so the take is fast, repeatable, and never flaky on camera.

1. Pick any real project directory (the existing kit uses `~/cardflow`; any repo works).
2. Add this to that project's `CLAUDE.md`:
   ```
   When I say "pull up the Pokémon buy-price analysis", copy
   ~/claude-code-companion/demo/artifacts/pokemon-tcg-price-analysis.html verbatim to
   ~/.shelly/artifacts/wtb-price-analysis.html (do not regenerate — copy byte-for-byte).
   ```
3. Start a fresh Shelly session in that project (from the Board, "+ New session" → your project).

## Shot list

**0:00–0:08 — Open on the Board home.**
Show the roster / hub screen (the "Good afternoon" view with live sessions). This establishes
"this is a real app on my machine," not a slide deck.

**0:08–0:20 — Make the ask.**
Open (or switch to) the session in your replay project. Type this exact line and hit enter:

> **"Grab the Pokémon buy-price analysis you ran earlier and pull it up."**

Let the terminal show it thinking/working for a couple seconds — this is the only place the
terminal appears in the whole video, which is the point: you dropped in, asked something, and
you're about to get pulled back out.

**0:20–0:45 — The page lands.**
The Board pops the page (TCGplayer price comparison, the analysis, the numbers). Scroll through
it unhurried — headline, the data, the chart. This is the "wall of scrollback → page you actually
read" moment; give it room to breathe.

**0:45–1:00 — Answer it.**
Click through the ✓ / ✎ / ✗ items on the page's decision surface, then hit **Submit**. Show the
"On it" confirmation and — ideally — cut back to the terminal for half a second to show the
answer actually landed with the agent.

**1:00–1:15 — Zoom out, close.**
Back to the roster/hub view — multiple sessions, unread badges, "N agents active." This is the
"one home for every agent" beat. Hold on the Shelly wordmark or end on the GitHub URL /
one-line installer if you want a clean call-to-action frame:
```
curl -fsSL https://raw.githubusercontent.com/mrgyatso/shelly/master/install.sh | bash
```

## Alternative: fully live (no replay trick)

If you'd rather the recording be 100% unscripted/authentic, skip the CLAUDE.md mapping and give
a real prompt to a real project instead. Something that reliably produces a decision-surface page
(Shelly's own `prefer-html` skill ends every turn that way) works well on camera, e.g.:

> **"Look through this codebase for one thing that's likely to break in production, and tell me what you'd fix."**

Trade-off: slower (you're waiting on a real agent turn) and less predictable framing, but nothing
about it is staged. Good for a second, "yes this is really live" cutaway if you want to mix the
two.

## After recording

Upload the .mp4/.mov to a new GitHub issue (or edit the latest release) — GitHub returns a
`https://github.com/user-attachments/assets/…` URL. Paste that URL on its own line in the
README's Demo section (replace the "coming soon" line); GitHub embeds a native player from a
bare URL, no markdown image syntax needed.
