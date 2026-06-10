// The Board — P0 shell of the multi-agent steering canvas.
//
// A grid of tiles, each a sandboxed iframe rendering one real artifact live via
// the `asset:` protocol (see ./artifact-view). This proves the core of the
// architecture (overlay/CANVAS-ARCHITECTURE.md): multiple interactive artifacts
// coexist in one non-activating surface, each fully live (its inline JS runs →
// its ✓/✎/✗ + Submit buttons work) because tiles load via `asset://`, never
// `srcdoc`. Loaded lazily by main.ts only on the board_main window
// (window.__BOARD_MODE__).
//
// P0 deliberately stops here: no source-grouping, keyboard nav, transitions, or
// response routing — those are P1+. The grid is populated from the most-recent
// few artifacts (list_artifacts).

import { invoke } from "@tauri-apps/api/core";
import { getCurrentWebviewWindow } from "@tauri-apps/api/webviewWindow";
import { loadArtifactInto } from "./artifact-view";

interface ArtifactEntry {
  path: string;
  title: string;
  subject?: string | null;
  summary?: string | null;
  modified_ms: number;
  size_bytes: number;
}

/** How many of the most-recent artifacts to show as tiles in P0. */
const MAX_TILES = 6;

const win = getCurrentWebviewWindow();

export async function initBoard(): Promise<void> {
  const root = document.getElementById("board");
  const grid = document.getElementById("board-grid");
  const status = document.getElementById("board-status");
  const count = document.getElementById("board-count");
  const frame = document.getElementById("frame");
  const empty = document.getElementById("empty");
  const controls = document.getElementById("controls");
  if (!root || !grid || !status) return;

  // This bundle is shared with the single-artifact panel; hide that chrome and
  // reveal the Board (mirrors what live.ts / history.ts do).
  frame?.setAttribute("hidden", "");
  empty?.setAttribute("hidden", "");
  controls?.setAttribute("hidden", "");
  root.removeAttribute("hidden");

  document.getElementById("board-close")?.addEventListener("click", () => {
    win.hide().catch((e) => console.error("board hide failed", e));
  });

  setStatus(status, "Loading…");
  let entries: ArtifactEntry[] = [];
  try {
    entries = await invoke<ArtifactEntry[]>("list_artifacts");
  } catch (e) {
    console.error("list_artifacts failed", e);
    setStatus(status, "Couldn't read the artifacts directory.");
    return;
  }
  if (entries.length === 0) {
    setStatus(status, "No artifacts yet.");
    return;
  }
  status.setAttribute("hidden", "");

  const tiles = entries.slice(0, MAX_TILES);
  if (count) count.textContent = `${tiles.length} ${tiles.length === 1 ? "tile" : "tiles"}`;

  for (const entry of tiles) {
    grid.appendChild(buildTile(entry));
  }
}

function setStatus(el: HTMLElement, text: string): void {
  el.textContent = text;
  el.removeAttribute("hidden");
}

// One tile = a titled card wrapping a live, sandboxed artifact iframe. The
// sandbox mirrors the single-panel #frame EXACTLY (`allow-scripts`, NO
// `allow-same-origin`): inline JS runs (so the artifact's buttons are live)
// while the tile stays isolated in an opaque origin (can't reach the overlay's
// IPC/storage). loadArtifactInto sets `iframe.src` to an `asset://` URL.
function buildTile(entry: ArtifactEntry): HTMLElement {
  const tile = document.createElement("div");
  tile.className = "tile";
  tile.dataset.path = entry.path;

  const head = document.createElement("div");
  head.className = "tile-head";
  const title = document.createElement("span");
  title.className = "tile-title";
  title.textContent = entry.title;
  head.append(title);
  if (entry.summary) {
    const sub = document.createElement("span");
    sub.className = "tile-sub";
    sub.textContent = entry.summary;
    head.append(sub);
  }

  const body = document.createElement("div");
  body.className = "tile-body";
  const iframe = document.createElement("iframe");
  iframe.className = "tile-frame";
  iframe.setAttribute("sandbox", "allow-scripts");
  iframe.setAttribute("referrerpolicy", "no-referrer");
  body.append(iframe);

  tile.append(head, body);

  loadArtifactInto(entry.path, iframe).catch((e) => {
    console.error("loadArtifactInto failed", entry.path, e);
    title.textContent = `Could not load ${entry.title}`;
  });

  return tile;
}
