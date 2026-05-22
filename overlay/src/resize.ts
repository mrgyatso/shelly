import { getCurrentWindow, currentMonitor } from "@tauri-apps/api/window";
import { LogicalSize } from "@tauri-apps/api/dpi";

// Fit-to-content sizing. The artifact iframe is opaque-origin (no
// `allow-same-origin`), so the parent can't read its layout. Instead the
// artifact reports its own content size via postMessage (see the fit-reporter
// snippet baked into generated artifacts), and we grow/shrink the window to
// match — clamped to the monitor work area, animated so it feels fluid.

/** Height of the chrome bar — keep in sync with `--chrome-h` in styles.css. */
const CHROME_H = 38;
const MIN_W = 320;
const MIN_H = 280;
/** Breathing room so the artifact's own scrollbars don't appear at fit size. */
const PAD = 8;
/** Keep the window off the very edge of the work area. */
const SCREEN_MARGIN = 16;
const ANIM_MS = 180;

const win = getCurrentWindow();

interface Size {
  w: number;
  h: number;
}

interface FitMessage {
  source: "companion-artifact";
  kind: "size";
  w: number;
  h: number;
}

let raf = 0;
let lastTarget: Size | null = null;

function isFitMessage(d: unknown): d is FitMessage {
  if (!d || typeof d !== "object") return false;
  const m = d as Record<string, unknown>;
  return (
    m.source === "companion-artifact" &&
    m.kind === "size" &&
    typeof m.w === "number" &&
    typeof m.h === "number"
  );
}

/** Translate a reported content size into a clamped target window size. */
async function targetSize(content: Size): Promise<Size> {
  const mon = await currentMonitor();
  const scale = mon?.scaleFactor ?? 1;
  const maxW = mon ? Math.floor(mon.workArea.size.width / scale) - SCREEN_MARGIN : 1600;
  const maxH = mon ? Math.floor(mon.workArea.size.height / scale) - SCREEN_MARGIN : 1000;
  const w = Math.min(Math.max(content.w + PAD, MIN_W), maxW);
  const h = Math.min(Math.max(content.h + CHROME_H + PAD, MIN_H), maxH);
  return { w, h };
}

const easeOutCubic = (t: number): number => 1 - Math.pow(1 - t, 3);

/** Tween the window's inner size to `target` (Tauri has no native animated resize). */
async function animateTo(target: Size): Promise<void> {
  const mon = await currentMonitor();
  const scale = mon?.scaleFactor ?? 1;
  const startPhys = await win.innerSize();
  const start: Size = { w: startPhys.width / scale, h: startPhys.height / scale };
  cancelAnimationFrame(raf);
  const t0 = performance.now();
  await new Promise<void>((resolve) => {
    const step = (now: number): void => {
      const p = Math.min((now - t0) / ANIM_MS, 1);
      const k = easeOutCubic(p);
      const w = Math.round(start.w + (target.w - start.w) * k);
      const h = Math.round(start.h + (target.h - start.h) * k);
      void win.setSize(new LogicalSize(w, h));
      if (p < 1) raf = requestAnimationFrame(step);
      else resolve();
    };
    raf = requestAnimationFrame(step);
  });
}

async function fit(content: Size): Promise<void> {
  const target = await targetSize(content);
  // Echo guard: resizing reflows the artifact, which re-reports; ignore reports
  // that resolve to (nearly) the size we just applied so we don't oscillate.
  if (
    lastTarget &&
    Math.abs(lastTarget.w - target.w) <= 4 &&
    Math.abs(lastTarget.h - target.h) <= 4
  ) {
    return;
  }
  lastTarget = target;
  await animateTo(target);
}

/** Clear fit state so the next artifact re-fits from scratch. */
export function resetFit(): void {
  lastTarget = null;
}

/** Start listening for size reports from the artifact iframe. Call once on boot. */
export function initFit(): void {
  window.addEventListener("message", (e: MessageEvent) => {
    if (isFitMessage(e.data)) void fit({ w: e.data.w, h: e.data.h });
  });
}
