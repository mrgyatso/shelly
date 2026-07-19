# Crab the hermit crab — mascot assets

Crab, the app's pixel crab, tucked into a hermit-crab shell — because Shelly is a
"shell" for Claude. Same sprite style as the animated mascot (`overlay/src/crab.ts`):
flat pixel-art, hard edges, warm limited palette.

## Palette

| role        | hex        |
|-------------|------------|
| crab body   | `#d98a5c`  |
| crab eyes   | `#2a2018`  |
| shell mid   | `#d9c9a3`  |
| shell light | `#ece0c6`  |
| shell dark  | `#c9a875`  |
| board tile  | `#f0e9df`  (`oklch(0.945 0.014 60)`) |

## Files

- `crab-hermit.png` — hero render, transparent, 1024² (landscape composition).
- `app-icon-source.png` — 1024² square, crab on a board-cream rounded tile; the source
  the macOS/Windows app icon set was generated from.
- `sizes/` — the exported set: transparent + white + board-tinted at 1024/512/256, plus
  transparent 128/64/32/16 and a multi-size `favicon.ico`. Autocropped + squared, so they
  crop cleanly to an icon.

## Where it's used

- **App icon** → `overlay/src-tauri/icons/` was regenerated from `app-icon-source.png`
  via `tauri icon`.
- **Idle / "waiting for an artifact" splash** → the `hermit` scene in
  `overlay/src/crab.ts` (a static pixel shell behind the shared rig; left claw waves).
  It joins the random pose rotation on `#hub-crab` and `#unit-blank-crab`.

## Provenance

The hero was generated with OpenAI `gpt-image-2` (`images.edit`) using a rasterized
reference of the real Crab rig to keep the character consistent, then its white
background was flood-filled to transparent. The in-app `hermit` pose is hand-authored
vector pixels (not the raster), matching the other `crab.ts` scenes.
