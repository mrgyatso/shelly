// The Board — P1: one pane per connected agent.
//
// Each connected agent (one `~/.claude/companion/live/<source>.json`) gets its
// own pane: a header showing that agent's live-state (working / where / next,
// rendered in the live-surface aesthetic, read-only) and, under it, that agent's
// artifacts — list_artifacts grouped by matching each artifact's
// companion-meta.project (a path like `~/foo`) to the pane's source slug (its
// basename, `foo`). Artifacts with no matching live source land in an
// "unsourced" pane. The Board absorbs the live surface: panes ARE the live
// state, refreshed on the same poll cadence as live.ts.
//
// Render discipline (CANVAS-ARCHITECTURE.md): tiles are LAZY-MOUNTED for
// performance. By default a tile is a cheap static thumbnail — the artifact's
// HTML injected via `iframe.srcdoc` and scaled down (like the history HUD). Under
// the overlay CSP `script-src 'self'`, srcdoc's inline JS does NOT run, so a
// thumbnail has no observers, no animations, no continuous compositing → near-zero
// CPU. Only when a tile is CLICKED (focused) is it promoted to a LIVE `asset:`
// iframe (loadArtifactInto), whose JS runs and whose ✓/✎/✗ buttons work. We cap
// the number of concurrent live tiles (LRU): promoting past the cap demotes the
// least-recently-focused live tile back to a thumbnail, killing its JS/compositing.
// Net: at idle the Board is all static thumbnails (0 live) → a fraction of the CPU
// of mounting every artifact live.
//
// One stable <iframe> per tile for its whole life — we flip its state (srcdoc
// thumbnail ⇄ asset: live), never swap the element. wireResize captures the
// iframe in a closure; replacing it would break resize. Tiles are built ONCE on
// open; the poll only re-renders changed pane *headers*, never the iframes. Each
// tile is individually resizable (a drag handle on a wrapper around the iframe).
//
// Deferred to P2: keyboard nav / quick-switcher / focus-to-expand, and dynamic
// add/remove of panes mid-session (arrival-reveal). This builds the static set
// once and keeps each pane's live header current.

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
  /** Raw companion-meta.project (often a path like `~/foo`); matched by basename. */
  project?: string | null;
}

interface LiveSource {
  source: string;
  json: string;
}

interface NextItem {
  title: string;
  sub?: string;
  kind?: string;
}

interface LiveState {
  working?: string;
  where?: string[];
  next?: NextItem[];
  project?: string;
}

/** Slug used for the catch-all pane holding artifacts with no live source. */
const UNSOURCED = "__unsourced__";
/** Poll cadence for live-state headers — matches live.ts's calm cadence. */
const POLL_MS = 1200;
/** Cross-fade duration for a header content swap (matches the CSS transition). */
const FADE_MS = 180;
/** Logical width a thumbnail iframe renders at before being scaled to the tile. */
const THUMB_VIEWPORT_W = 1200;
/** Max concurrent LIVE (asset:) tiles; the rest stay cheap static thumbnails. */
const MAX_LIVE_TILES = 3;

const win = getCurrentWebviewWindow();

/** Last-rendered live JSON per source, so a poll only re-renders what changed. */
const lastJsonBySource = new Map<string, string>();
/** Cache of artifact HTML so demote→re-promote (and re-mount) doesn't re-read. */
const htmlCache = new Map<string, string>();
/** Currently-live tiles in focus order (front = least-recently-focused = LRU). */
const liveTiles: HTMLElement[] = [];
/** Observes which tiles are on-screen so only visible thumbnails are mounted —
 *  off-screen tiles are torn down to a cheap placeholder (history-HUD discipline,
 *  adapted to the Board's 2D scroll). `rootMargin` adds hysteresis so a tiny
 *  scroll doesn't thrash mount/unmount. */
let tileObserver: IntersectionObserver | null = null;
/** Whether the Board is currently maximized to its monitor. */
let isFullscreen = false;

export async function initBoard(): Promise<void> {
  const root = document.getElementById("board");
  const panes = document.getElementById("board-panes");
  const status = document.getElementById("board-status");
  const count = document.getElementById("board-count");
  const frame = document.getElementById("frame");
  const empty = document.getElementById("empty");
  const controls = document.getElementById("controls");
  if (!root || !panes || !status) return;

  // Shared bundle: hide the single-artifact chrome, reveal the Board.
  frame?.setAttribute("hidden", "");
  empty?.setAttribute("hidden", "");
  controls?.setAttribute("hidden", "");
  root.removeAttribute("hidden");

  document.getElementById("board-close")?.addEventListener("click", () => {
    win.hide().catch((e) => console.error("board hide failed", e));
  });
  wireFullscreen();

  setStatus(status, "Loading…");

  let sources: LiveSource[] = [];
  let artifacts: ArtifactEntry[] = [];
  try {
    [sources, artifacts] = await Promise.all([
      invoke<LiveSource[]>("read_all_live"),
      invoke<ArtifactEntry[]>("list_artifacts"),
    ]);
  } catch (e) {
    console.error("board load failed", e);
    setStatus(status, "Couldn't read the Board's data.");
    return;
  }

  const grouped = groupArtifacts(sources, artifacts);
  if (sources.length === 0 && grouped.get(UNSOURCED)?.length === 0) {
    setStatus(status, "No agents or artifacts yet.");
    return;
  }
  status.setAttribute("hidden", "");

  // Gate thumbnail mounting on visibility: only tiles in (or near) the viewport
  // hold a live srcdoc; off-screen tiles are torn down. With many artifacts this
  // is the difference between compositing ~10 documents and ~100+ at idle.
  tileObserver = new IntersectionObserver(onTileVisibility, {
    root: panes,
    rootMargin: "300px 0px", // mount a little before a tile scrolls in (hysteresis)
  });

  // Stable pane order: live sources (already slug-sorted by Rust), then the
  // unsourced catch-all last. Built ONCE — the poll only updates headers.
  const order = [...sources.map((s) => s.source)];
  if (grouped.get(UNSOURCED)?.length) order.push(UNSOURCED);

  for (const source of order) {
    panes.appendChild(buildPane(source, grouped.get(source) ?? []));
  }
  if (count) {
    const n = order.length;
    count.textContent = `${n} ${n === 1 ? "agent" : "agents"}`;
  }

  // Seed each header with the live state we just read, then keep them current.
  for (const s of sources) renderHeader(s.source, s.json);
  window.setInterval(() => void pollLive(), POLL_MS);
}

function setStatus(el: HTMLElement, text: string): void {
  el.textContent = text;
  el.removeAttribute("hidden");
}

/** Group artifacts under the live source whose slug matches the basename of the
 *  artifact's `project`. Unmatched artifacts go under UNSOURCED. */
function groupArtifacts(
  sources: LiveSource[],
  artifacts: ArtifactEntry[],
): Map<string, ArtifactEntry[]> {
  const slugs = new Set(sources.map((s) => s.source));
  const out = new Map<string, ArtifactEntry[]>();
  for (const s of sources) out.set(s.source, []);
  out.set(UNSOURCED, []);

  for (const art of artifacts) {
    const slug = projectSlug(art.project);
    const key = slug && slugs.has(slug) ? slug : UNSOURCED;
    out.get(key)?.push(art);
  }
  return out;
}

/** `~/claude-code-companion` → `claude-code-companion`; `hermes` → `hermes`. */
function projectSlug(project?: string | null): string | null {
  if (!project) return null;
  const trimmed = project.replace(/\/+$/, "");
  const base = trimmed.split("/").pop() || trimmed;
  return base || null;
}

// ---- panes ------------------------------------------------------------------

function buildPane(source: string, artifacts: ArtifactEntry[]): HTMLElement {
  const pane = document.createElement("section");
  pane.className = "pane";
  pane.dataset.source = source;

  // Header = the agent's live state (filled by renderHeader; the unsourced pane
  // has no live source, so it just gets a provenance label).
  const header = document.createElement("div");
  header.className = "pane-head";

  const prov = document.createElement("div");
  prov.className = "pane-prov";
  const dot = document.createElement("span");
  dot.className = "pane-dot";
  const label = document.createElement("span");
  label.className = "pane-source";
  label.textContent = source === UNSOURCED ? "unsourced" : source;
  prov.append(dot, label);
  header.append(prov);

  if (source !== UNSOURCED) {
    const body = document.createElement("div");
    body.className = "pane-live";
    body.id = `pane-live-${source}`;
    body.innerHTML = `<div class="pane-idle">Loading…</div>`;
    header.append(body);
  }

  const tiles = document.createElement("div");
  tiles.className = "pane-tiles";
  if (artifacts.length === 0) {
    const none = document.createElement("div");
    none.className = "pane-empty";
    none.textContent = "No artifacts.";
    tiles.append(none);
  } else {
    for (const art of artifacts) tiles.appendChild(buildTile(art));
  }

  pane.append(header, tiles);
  return pane;
}

// ---- live-state header (read-only; aesthetic reused from live.ts) -----------

async function pollLive(): Promise<void> {
  let sources: LiveSource[] = [];
  try {
    sources = await invoke<LiveSource[]>("read_all_live");
  } catch (e) {
    console.error("read_all_live failed", e);
    return;
  }
  for (const s of sources) {
    if (lastJsonBySource.get(s.source) === s.json) continue; // unchanged
    renderHeader(s.source, s.json);
  }
}

function renderHeader(source: string, json: string): void {
  const body = document.getElementById(`pane-live-${source}`);
  if (!body) return; // pane not built (e.g. appeared mid-session — P2)
  lastJsonBySource.set(source, json);

  const frag = buildLiveFragment(json);
  body.classList.add("fading");
  window.setTimeout(() => {
    body.replaceChildren(frag);
    body.classList.remove("fading");
  }, FADE_MS);
}

/** Render a live-state JSON into a read-only fragment (working / where / next),
 *  reusing the live-* CSS classes for the warm paper aesthetic. No ✓/✎/✗ — the
 *  Board's per-tile response routing is P4; these are display-only. */
function buildLiveFragment(json: string): DocumentFragment {
  const frag = document.createDocumentFragment();
  let state: LiveState;
  try {
    state = JSON.parse(json) as LiveState;
  } catch {
    const idle = document.createElement("div");
    idle.className = "pane-idle";
    idle.textContent = "live state didn't parse.";
    frag.append(idle);
    return frag;
  }

  if (state.working) {
    const h = document.createElement("div");
    h.className = "pane-working";
    h.textContent = state.working;
    frag.append(h);
  }

  if (state.where?.length) {
    frag.append(sectionLabel("Where we are"));
    const ul = document.createElement("ul");
    ul.className = "pane-where";
    for (const line of state.where) {
      const li = document.createElement("li");
      li.textContent = line;
      ul.append(li);
    }
    frag.append(ul);
  }

  if (state.next?.length) {
    frag.append(sectionLabel("Next"));
    const list = document.createElement("div");
    list.className = "pane-next";
    for (const item of state.next) list.append(nextCard(item));
    frag.append(list);
  }
  return frag;
}

function sectionLabel(text: string): HTMLElement {
  const el = document.createElement("div");
  el.className = "pane-section";
  el.textContent = text;
  return el;
}

function nextCard(item: NextItem): HTMLElement {
  const card = document.createElement("div");
  card.className = "pane-item";
  const title = document.createElement("div");
  title.className = "pane-item-title";
  title.textContent = item.title;
  card.append(title);
  if (item.sub) {
    const sub = document.createElement("div");
    sub.className = "pane-item-sub";
    sub.textContent = item.sub;
    card.append(sub);
  }
  if (item.kind) {
    const chip = document.createElement("span");
    chip.className = "pane-chip";
    chip.textContent = item.kind;
    card.append(chip);
  }
  return card;
}

// ---- artifact tile (resizable; lazy-mounted thumbnail ⇄ live) ---------------

function buildTile(entry: ArtifactEntry): HTMLElement {
  // The resizable wrapper. `resize: both` is on this wrapper, not the iframe —
  // a cross-origin iframe filling the corner would swallow the native gripper,
  // so a dedicated drag handle (below) drives the resize and the iframe gets
  // `pointer-events: none` only while dragging.
  const tile = document.createElement("div");
  tile.className = "tile"; // not .is-live → thumbnail (pointer-transparent iframe)
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
  iframe.tabIndex = -1;
  body.append(iframe);

  const handle = document.createElement("div");
  handle.className = "tile-resize";
  handle.title = "Drag to resize";
  wireResize(tile, iframe, handle);

  tile.append(head, body, handle);

  // Default to a cheap static thumbnail — but only mount it when on-screen.
  // Off-screen tiles stay empty placeholders (the observer mounts/unmounts as
  // they scroll), so idle cost scales with visible tiles, not total artifacts.
  tileObserver?.observe(tile);

  // Click anywhere on a not-yet-live tile → promote it to a live asset: iframe.
  // The thumbnail iframe is pointer-transparent (CSS), so the click reaches the
  // tile; once live, `.is-live .tile-frame` re-enables pointer events so the
  // artifact's own buttons work and further clicks pass through to it.
  tile.addEventListener("click", () => {
    if (!tile.classList.contains("is-live")) void promoteTile(tile, iframe);
  });

  return tile;
}

/** Render the artifact as a scaled-down static `srcdoc` snapshot (history-HUD
 *  recipe). Inline JS won't run under the overlay CSP → cheap static thumbnail. */
async function mountThumbnail(tile: HTMLElement, iframe: HTMLIFrameElement): Promise<void> {
  const path = tile.dataset.path;
  if (!path) return;

  let html = htmlCache.get(path);
  if (html === undefined) {
    try {
      html = await invoke<string>("read_artifact", { path });
      htmlCache.set(path, html);
    } catch (e) {
      console.error("read_artifact failed", path, e);
      return;
    }
  }
  // The tile may have been promoted/hidden while we awaited the read.
  if (tile.classList.contains("is-live") || !tile.dataset.visible) return;
  if (iframe.hasAttribute("srcdoc")) return; // already mounted

  const body = iframe.parentElement as HTMLElement;
  const scale = body.clientWidth / THUMB_VIEWPORT_W || 0.25;
  iframe.removeAttribute("src");
  iframe.style.width = `${THUMB_VIEWPORT_W}px`;
  iframe.style.height = `${Math.round((body.clientHeight || 220) / scale)}px`;
  iframe.style.transform = `scale(${scale})`;
  iframe.srcdoc = html;
}

/** Mount/unmount thumbnails as tiles scroll in and out of the viewport. Live
 *  tiles are left alone (they're capped by the LRU and the user may scroll back
 *  to a running one); only the thumbnail layer is gated. */
function onTileVisibility(entries: IntersectionObserverEntry[]): void {
  for (const entry of entries) {
    const tile = entry.target as HTMLElement;
    if (entry.isIntersecting) {
      tile.dataset.visible = "1";
      if (!tile.classList.contains("is-live")) {
        const iframe = tile.querySelector(".tile-frame") as HTMLIFrameElement | null;
        if (iframe) void mountThumbnail(tile, iframe);
      }
    } else {
      delete tile.dataset.visible;
      if (!tile.classList.contains("is-live")) unmountThumbnail(tile);
    }
  }
}

/** Tear a thumbnail back down to an empty placeholder — drops its layout/layer
 *  so an off-screen tile costs nothing. */
function unmountThumbnail(tile: HTMLElement): void {
  const iframe = tile.querySelector(".tile-frame") as HTMLIFrameElement | null;
  if (!iframe) return;
  iframe.removeAttribute("srcdoc");
  iframe.style.width = "";
  iframe.style.height = "";
  iframe.style.transform = "";
}

/** Promote a tile to a LIVE `asset:` iframe so its JS runs and buttons work.
 *  Enforces the live-tile cap (LRU): demotes the least-recently-focused live
 *  tile if we're at the cap before adding this one. */
async function promoteTile(tile: HTMLElement, iframe: HTMLIFrameElement): Promise<void> {
  // Already tracked? just move it to most-recently-focused.
  const existing = liveTiles.indexOf(tile);
  if (existing !== -1) liveTiles.splice(existing, 1);

  // Enforce the cap before promoting a new live tile.
  while (liveTiles.length >= MAX_LIVE_TILES) {
    const lru = liveTiles.shift();
    if (lru) demoteTile(lru);
  }

  liveTiles.push(tile);
  tile.classList.add("is-live");

  // Clear the thumbnail's scale/sizing so .tile-frame fills the body 100%×100%.
  iframe.style.width = "";
  iframe.style.height = "";
  iframe.style.transform = "";

  const path = tile.dataset.path;
  if (!path) return;
  await loadArtifactInto(path, iframe).catch((e) => {
    console.error("loadArtifactInto failed", path, e);
  });
}

/** Demote a live tile back to a static thumbnail — clearing `src`/`srcdoc` tears
 *  down the live document, killing its JS/observers/compositing → CPU drops. Only
 *  re-mount a thumbnail if the tile is on-screen; otherwise leave it an empty
 *  placeholder (the observer mounts it when it scrolls back in). */
function demoteTile(tile: HTMLElement): void {
  tile.classList.remove("is-live");
  const iframe = tile.querySelector(".tile-frame") as HTMLIFrameElement | null;
  if (!iframe) return;
  iframe.removeAttribute("src");
  if (tile.dataset.visible) void mountThumbnail(tile, iframe);
}

/** Drag the bottom-right handle to resize one tile. The iframe is made
 *  pointer-transparent during the drag so a cross-origin tile can't swallow the
 *  pointer-move stream. */
function wireResize(tile: HTMLElement, iframe: HTMLIFrameElement, handle: HTMLElement): void {
  const MIN_W = 220;
  const MIN_H = 160;
  handle.addEventListener("pointerdown", (e: PointerEvent) => {
    e.preventDefault();
    const startX = e.clientX;
    const startY = e.clientY;
    const startW = tile.offsetWidth;
    const startH = tile.offsetHeight;
    iframe.style.pointerEvents = "none";
    document.body.style.userSelect = "none";
    handle.setPointerCapture(e.pointerId);

    const move = (ev: PointerEvent) => {
      tile.style.width = `${Math.max(MIN_W, startW + (ev.clientX - startX))}px`;
      tile.style.height = `${Math.max(MIN_H, startH + (ev.clientY - startY))}px`;
    };
    const up = (ev: PointerEvent) => {
      iframe.style.pointerEvents = "";
      document.body.style.userSelect = "";
      handle.releasePointerCapture(ev.pointerId);
      handle.removeEventListener("pointermove", move);
      handle.removeEventListener("pointerup", up);
    };
    handle.addEventListener("pointermove", move);
    handle.addEventListener("pointerup", up);
  });
}

// ---- full-screen toggle -----------------------------------------------------

function wireFullscreen(): void {
  const btn = document.getElementById("board-fullscreen");
  btn?.addEventListener("click", () => {
    invoke<boolean>("set_board_fullscreen", { on: !isFullscreen })
      .then((on) => {
        isFullscreen = on;
        if (btn) {
          btn.textContent = on ? "Exit full screen" : "Full screen";
          btn.classList.toggle("on", on);
        }
      })
      .catch((e) => console.error("set_board_fullscreen failed", e));
  });
}
