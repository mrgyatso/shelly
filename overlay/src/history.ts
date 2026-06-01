// The history HUD: a horizontal carousel of past artifacts. The centered card
// is focused (full-size live preview + title); neighbors peek on either side.
// Navigate by scrolling (wheel), dragging to scrub, the ‹ › arrows, or clicking
// a side card to center it. Clicking the centered card (or pressing Enter)
// re-opens that artifact as a panel. Loaded lazily by main.ts only on the
// `hist_main` window (window.__HISTORY_MODE__).
//
// Previews render via the artifact's HTML injected into an iframe `srcdoc`
// (read through the read_artifact command), NOT the asset: protocol — asset:
// iframes render blank in this window context, whereas srcdoc renders the
// artifact's static content + inline styles. (Inline scripts don't run under the
// overlay CSP, so purely JS-built artifacts show their static skeleton only —
// acceptable for a thumbnail.)

import { invoke } from "@tauri-apps/api/core";
import { getCurrentWebviewWindow } from "@tauri-apps/api/webviewWindow";

interface ArtifactEntry {
  path: string;
  title: string;
  subject?: string | null;
  summary?: string | null;
  modified_ms: number;
  size_bytes: number;
}

/** Logical width each preview iframe renders at before being scaled to the card. */
const PREVIEW_VIEWPORT_W = 1200;
/** Mount live previews for the focused card ± this many neighbours. */
const MOUNT_RADIUS = 2;
/** Pointer travel (px) past which a press is a drag-scrub, not a click. */
const DRAG_THRESHOLD = 5;

const win = getCurrentWebviewWindow();
const htmlCache = new Map<string, string>();

let cards: HTMLElement[] = [];
let track: HTMLElement;
let activeIndex = 0;

export async function initHistory(): Promise<void> {
  const root = document.getElementById("history");
  const carousel = document.getElementById("history-carousel");
  const status = document.getElementById("history-status");
  const frame = document.getElementById("frame");
  const empty = document.getElementById("empty");
  if (!root || !carousel || !status) return;
  track = carousel;

  frame?.setAttribute("hidden", "");
  empty?.setAttribute("hidden", "");
  root.removeAttribute("hidden");

  document.getElementById("history-close")?.addEventListener("click", () => {
    win.hide().catch((e) => console.error("hide failed", e));
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

  cards = entries.map(buildCard);
  const frag = document.createDocumentFragment();
  cards.forEach((c) => frag.appendChild(c));
  track.appendChild(frag);

  wireNavigation();

  // Land on the newest (first) card, centered, with its preview mounted.
  setActive(0, false);
  requestAnimationFrame(() => centerOn(0, false));
}

function setStatus(el: HTMLElement, text: string): void {
  el.textContent = text;
  el.removeAttribute("hidden");
}

function buildCard(entry: ArtifactEntry, index: number): HTMLElement {
  const card = document.createElement("div");
  card.className = "hcard";
  card.dataset.path = entry.path;
  card.dataset.index = String(index);

  const thumb = document.createElement("div");
  thumb.className = "thumb";

  const meta = document.createElement("div");
  meta.className = "hcard-meta";
  const title = document.createElement("div");
  title.className = "hcard-title";
  title.textContent = entry.title;
  const date = document.createElement("div");
  date.className = "hcard-date";
  date.textContent = formatDate(entry.modified_ms);
  meta.append(title);
  if (entry.summary) {
    const summary = document.createElement("div");
    summary.className = "hcard-summary";
    summary.textContent = entry.summary;
    meta.append(summary);
  }
  meta.append(date);

  card.append(thumb, meta);
  return card;
}

// ---- navigation: wheel, drag-scrub, click, arrows, keyboard ------------------

function wireNavigation(): void {
  // Vertical wheel → horizontal scroll (trackpads still send deltaX through).
  track.addEventListener(
    "wheel",
    (e: WheelEvent) => {
      if (Math.abs(e.deltaY) > Math.abs(e.deltaX)) {
        track.scrollLeft += e.deltaY;
        e.preventDefault();
      }
    },
    { passive: false },
  );

  // Drag to scrub. Snap is disabled mid-drag (.dragging) and restored on release
  // so the carousel settles onto the nearest card.
  let dragging = false;
  let moved = false;
  let startX = 0;
  let startScroll = 0;
  track.addEventListener("pointerdown", (e: PointerEvent) => {
    dragging = true;
    moved = false;
    startX = e.clientX;
    startScroll = track.scrollLeft;
    track.classList.add("dragging");
    track.setPointerCapture(e.pointerId);
  });
  track.addEventListener("pointermove", (e: PointerEvent) => {
    if (!dragging) return;
    const dx = e.clientX - startX;
    if (Math.abs(dx) > DRAG_THRESHOLD) moved = true;
    track.scrollLeft = startScroll - dx;
  });
  const endDrag = () => {
    if (!dragging) return;
    dragging = false;
    track.classList.remove("dragging");
    centerOn(activeIndex, true); // settle onto the focused card
  };
  track.addEventListener("pointerup", endDrag);
  track.addEventListener("pointercancel", endDrag);

  // Click a side card → center it; click the focused card → open it. A press
  // that turned into a drag must not also open/navigate.
  track.addEventListener("click", (e: MouseEvent) => {
    if (moved) return;
    const card = (e.target as HTMLElement).closest(".hcard") as HTMLElement | null;
    if (!card) return;
    const i = Number(card.dataset.index);
    if (i === activeIndex) openArtifact(card.dataset.path);
    else centerOn(i, true);
  });

  // Keep the focused card in sync as the carousel scrolls (rAF-throttled).
  let ticking = false;
  track.addEventListener("scroll", () => {
    if (ticking) return;
    ticking = true;
    requestAnimationFrame(() => {
      ticking = false;
      setActive(nearestCardToCenter(), false);
    });
  });

  document.getElementById("hist-prev")?.addEventListener("click", () => centerOn(activeIndex - 1, true));
  document.getElementById("hist-next")?.addEventListener("click", () => centerOn(activeIndex + 1, true));

  window.addEventListener("keydown", (e: KeyboardEvent) => {
    if (e.key === "ArrowRight") centerOn(activeIndex + 1, true);
    else if (e.key === "ArrowLeft") centerOn(activeIndex - 1, true);
    else if (e.key === "Enter") openArtifact(cards[activeIndex]?.dataset.path);
    else if (e.key === "Escape") win.hide().catch(() => {});
  });
}

function nearestCardToCenter(): number {
  const mid = track.scrollLeft + track.clientWidth / 2;
  let best = 0;
  let bestDist = Infinity;
  cards.forEach((c, i) => {
    const center = c.offsetLeft + c.offsetWidth / 2;
    const d = Math.abs(center - mid);
    if (d < bestDist) {
      bestDist = d;
      best = i;
    }
  });
  return best;
}

function centerOn(index: number, smooth: boolean): void {
  const i = Math.max(0, Math.min(cards.length - 1, index));
  cards[i]?.scrollIntoView({
    behavior: smooth ? "smooth" : "auto",
    inline: "center",
    block: "nearest",
  });
  setActive(i, false);
}

function setActive(index: number, _scroll: boolean): void {
  activeIndex = index;
  cards.forEach((c, i) => {
    c.classList.toggle("active", i === index);
    if (Math.abs(i - index) <= MOUNT_RADIUS) void mountThumb(c);
    else unmountThumb(c);
  });
}

// ---- previews ----------------------------------------------------------------

async function mountThumb(card: HTMLElement): Promise<void> {
  const thumb = card.querySelector(".thumb") as HTMLElement | null;
  const path = card.dataset.path;
  if (!thumb || !path || thumb.dataset.mounted) return;
  thumb.dataset.mounted = "1";

  let html = htmlCache.get(path);
  if (html === undefined) {
    try {
      html = await invoke<string>("read_artifact", { path });
      htmlCache.set(path, html);
    } catch (e) {
      console.error("read_artifact failed", e);
      showFallback(thumb, path);
      return;
    }
  }
  // The card may have scrolled out of the mount window while we awaited.
  if (!thumb.dataset.mounted) return;

  const scale = thumb.clientWidth / PREVIEW_VIEWPORT_W;
  const iframe = document.createElement("iframe");
  iframe.setAttribute("sandbox", "allow-scripts");
  iframe.setAttribute("referrerpolicy", "no-referrer");
  iframe.tabIndex = -1;
  iframe.style.width = `${PREVIEW_VIEWPORT_W}px`;
  iframe.style.height = `${Math.round(thumb.clientHeight / scale)}px`;
  iframe.style.transform = `scale(${scale})`;
  iframe.srcdoc = html;
  thumb.appendChild(iframe);
}

function unmountThumb(card: HTMLElement): void {
  const thumb = card.querySelector(".thumb") as HTMLElement | null;
  if (!thumb) return;
  delete thumb.dataset.mounted;
  thumb.querySelector("iframe")?.remove();
  thumb.querySelector(".thumb-fallback")?.remove();
}

function showFallback(thumb: HTMLElement, path: string): void {
  const chip = document.createElement("div");
  chip.className = "thumb-fallback";
  chip.textContent = path.split("/").pop() || path;
  thumb.appendChild(chip);
}

function openArtifact(path?: string): void {
  if (!path) return;
  invoke("reopen_artifact", { path }).catch((e) => console.error("reopen_artifact failed", e));
}

function formatDate(ms: number): string {
  if (!ms) return "";
  return new Date(ms).toLocaleDateString(undefined, {
    year: "numeric",
    month: "short",
    day: "numeric",
  });
}
