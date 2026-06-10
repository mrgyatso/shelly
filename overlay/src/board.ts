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
// Render discipline (CANVAS-ARCHITECTURE.md): every artifact tile loads via the
// `asset:` protocol (loadArtifactInto), never srcdoc, so its inline JS runs and
// its buttons stay live. Tiles are built ONCE on open; the poll only re-renders
// changed pane *headers*, never touching the artifact iframes (a reload would
// flicker, lose scroll, and re-run their JS). Each tile is individually
// resizable (a drag handle on a wrapper around the iframe).
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

const win = getCurrentWebviewWindow();

/** Last-rendered live JSON per source, so a poll only re-renders what changed. */
const lastJsonBySource = new Map<string, string>();
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

// ---- artifact tile (resizable; asset:-loaded) -------------------------------

function buildTile(entry: ArtifactEntry): HTMLElement {
  // The resizable wrapper. `resize: both` is on this wrapper, not the iframe —
  // a cross-origin iframe filling the corner would swallow the native gripper,
  // so a dedicated drag handle (below) drives the resize and the iframe gets
  // `pointer-events: none` only while dragging.
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

  const handle = document.createElement("div");
  handle.className = "tile-resize";
  handle.title = "Drag to resize";
  wireResize(tile, iframe, handle);

  tile.append(head, body, handle);

  loadArtifactInto(entry.path, iframe).catch((e) => {
    console.error("loadArtifactInto failed", entry.path, e);
    title.textContent = `Could not load ${entry.title}`;
  });

  return tile;
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
