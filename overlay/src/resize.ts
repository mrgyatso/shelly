import { getCurrentWindow, currentMonitor } from "@tauri-apps/api/window";
import { LogicalPosition, LogicalSize } from "@tauri-apps/api/dpi";
import { invoke } from "@tauri-apps/api/core";
import { handleSubmit, copyToClipboard } from "./submit";

// Fit-to-content sizing. The artifact iframe is opaque-origin (no
// `allow-same-origin`), so the parent can't read its layout. Instead the
// artifact reports its own content size via postMessage (see the fit-reporter
// snippet baked into generated artifacts), and we grow/shrink the window to
// match — clamped to the monitor work area, animated so it feels fluid.

const MIN_W = 320;
const MIN_H = 120;
/** Panel corner-radius range — the card morphs rounder when tall, tighter when wide. */
const MIN_RADIUS = 10;
const MAX_RADIUS = 20;
/** Breathing room so the artifact's own scrollbars don't appear at fit size. */
const PAD = 8;
/** Keep the window off the very edge of the work area. */
const SCREEN_MARGIN = 16;
const ANIM_MS = 180;
/** If an artifact never reports a size (snippet missing / 3rd-party HTML), fall
 *  back to a sensible window after this delay instead of leaving it at MIN_*. */
const FALLBACK_W = 760;
const FALLBACK_H = 900;
const FALLBACK_MS = 400;

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

interface SubmitMessage {
  source: "companion-artifact";
  kind: "submit";
  text: string;
}

/** A "copy this to the system clipboard" request from an artifact's Copy button.
 *  The artifact's own `navigator.clipboard` / `execCommand` path is unreliable in
 *  the sandboxed opaque-origin iframe (WebKitGTK blocks both on Linux), so the
 *  button bridges here and the overlay — which owns Tauri's clipboard — writes it.
 *  UNTRUSTED artifact text, but a clipboard write is strictly lower-risk than the
 *  submit→PTY path (worst case: it clobbers the clipboard). */
export interface CopyMessage {
  source: "companion-artifact";
  kind: "copy";
  text: string;
}

/** Type guard for a CopyMessage. Exported so board.ts can wire its own listener. */
export function isCopyMessage(d: unknown): d is CopyMessage {
  if (!d || typeof d !== "object") return false;
  const m = d as Record<string, unknown>;
  return (
    m.source === "companion-artifact" &&
    m.kind === "copy" &&
    typeof m.text === "string"
  );
}

/** A Board navigation request from a full-bleed Hub iframe (or any artifact).
 *  `to` is one of: "hub", "sessions", `session:<slug>`, `artifact:<path>`.
 *  Treated as UNTRUSTED by the board.ts listener (validated before acting). */
export interface NavigateMessage {
  source: "companion-artifact";
  kind: "navigate";
  to: string;
}

/** Type guard for a NavigateMessage. Exported so board.ts can wire its own
 *  listener (the Board must never feed these to fit()/resize the window). */
export function isNavigateMessage(d: unknown): d is NavigateMessage {
  if (!d || typeof d !== "object") return false;
  const m = d as Record<string, unknown>;
  return m.source === "companion-artifact" && m.kind === "navigate" && typeof m.to === "string";
}

/** "Start a new session with this quote": the user highlighted text in an artifact
 *  and wants a fresh Claude session seeded with it. `quote` is the selection; `artifact`
 *  (optional) is the source's subject/path, for attribution in the seeded prompt.
 *  UNTRUSTED (artifact-controlled) — the board.ts listener ESC-strips `quote` before
 *  it touches the PTY and never auto-sends it (pre-fill only). */
export interface NewSessionMessage {
  source: "companion-artifact";
  kind: "new-session";
  quote: string;
  artifact?: string;
}

/** Type guard for a NewSessionMessage. Exported so board.ts can wire it. */
export function isNewSessionMessage(d: unknown): d is NewSessionMessage {
  if (!d || typeof d !== "object") return false;
  const m = d as Record<string, unknown>;
  return (
    m.source === "companion-artifact" &&
    m.kind === "new-session" &&
    typeof m.quote === "string"
  );
}

let raf = 0;
let lastTarget: Size | null = null;
let gotReport = false;
let fallbackTimer = 0;

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

function isSubmitMessage(d: unknown): d is SubmitMessage {
  if (!d || typeof d !== "object") return false;
  const m = d as Record<string, unknown>;
  return (
    m.source === "companion-artifact" &&
    m.kind === "submit" &&
    typeof m.text === "string"
  );
}

/** Translate a reported content size into a clamped target window size. */
async function targetSize(content: Size): Promise<Size> {
  const mon = await currentMonitor();
  const scale = mon?.scaleFactor ?? 1;
  const maxW = mon ? Math.floor(mon.workArea.size.width / scale) - SCREEN_MARGIN : 1600;
  const maxH = mon ? Math.floor(mon.workArea.size.height / scale) - SCREEN_MARGIN : 1000;
  const w = Math.min(Math.max(content.w + PAD, MIN_W), maxW);
  const h = Math.min(Math.max(content.h + PAD, MIN_H), maxH);
  return { w, h };
}

const easeOutCubic = (t: number): number => 1 - Math.pow(1 - t, 3);

/** Tween the window's inner size *and* position to `target`.
 *
 *  Why both: Tauri's setSize grows the window from its top-left anchor, so a
 *  panel placed flush to the right edge of the screen would extend past the
 *  monitor's right edge as it grew — visibly spilling onto an adjacent monitor
 *  for the ~180ms of the resize, before the Rust re-flow snapped it back.
 *
 *  Fix: capture the current monitor *before* the tween starts (so a brief
 *  multi-monitor straddle can't switch which monitor we're targeting), keep
 *  the panel's right edge anchored to where it was, and clamp the resulting
 *  rect to that monitor's work area. The Rust arrange() that fires afterwards
 *  will then see "already at target" and skip its own move. */
async function animateTo(target: Size): Promise<void> {
  const mon = await currentMonitor();
  const scale = mon?.scaleFactor ?? 1;
  const startPhys = await win.innerSize();
  const startPosPhys = await win.outerPosition();
  const start: Size = { w: startPhys.width / scale, h: startPhys.height / scale };
  const startPos = { x: startPosPhys.x / scale, y: startPosPhys.y / scale };

  // Right-anchored re-flow: keep the right edge where it is, grow leftward.
  // Then clamp into the monitor's work area so we can never spill across a
  // multi-monitor boundary mid-tween.
  const monLeft = mon ? mon.workArea.position.x / scale : 0;
  const monTop = mon ? mon.workArea.position.y / scale : 0;
  const monW = mon ? mon.workArea.size.width / scale : 1600;
  const monH = mon ? mon.workArea.size.height / scale : 1000;
  const startRight = startPos.x + start.w;
  const desiredX = startRight - target.w;
  const targetX = Math.max(
    monLeft + SCREEN_MARGIN,
    Math.min(desiredX, monLeft + monW - target.w - SCREEN_MARGIN),
  );
  const targetY = Math.max(
    monTop + SCREEN_MARGIN,
    Math.min(startPos.y, monTop + monH - target.h - SCREEN_MARGIN),
  );

  cancelAnimationFrame(raf);
  const t0 = performance.now();
  await new Promise<void>((resolve) => {
    const step = (now: number): void => {
      const p = Math.min((now - t0) / ANIM_MS, 1);
      const k = easeOutCubic(p);
      const w = Math.round(start.w + (target.w - start.w) * k);
      const h = Math.round(start.h + (target.h - start.h) * k);
      const x = Math.round(startPos.x + (targetX - startPos.x) * k);
      const y = Math.round(startPos.y + (targetY - startPos.y) * k);
      void win.setSize(new LogicalSize(w, h));
      void win.setPosition(new LogicalPosition(x, y));
      if (p < 1) raf = requestAnimationFrame(step);
      else resolve();
    };
    raf = requestAnimationFrame(step);
  });
}

/**
 * Map a target window size to a panel corner radius and set it as a CSS var:
 * tall/portrait artifacts get a rounder card, wide/landscape ones a tighter one.
 * styles.css transitions `border-radius` over the same ~180ms (ANIM_MS), so the
 * shape morphs in parallel with the window resize.
 */
function applyRadius({ w, h }: Size): void {
  const ratio = Math.max(0.5, Math.min(2, w / h)); // clamp portrait..landscape
  const t = (ratio - 0.5) / 1.5; // 0 at portrait, 1 at landscape
  const radius = Math.round(MAX_RADIUS - t * (MAX_RADIUS - MIN_RADIUS));
  document.documentElement.style.setProperty("--radius", `${radius}px`);
}

async function fit(content: Size): Promise<void> {
  gotReport = true;
  clearTimeout(fallbackTimer);
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
  applyRadius(target);
  await animateTo(target);
  // Let Rust re-flow the column now that this panel knows its real size.
  void invoke("notify_fit");
}

/** Clear fit state so the next artifact re-fits from scratch. */
export function resetFit(): void {
  lastTarget = null;
  gotReport = false;
  clearTimeout(fallbackTimer);
  fallbackTimer = window.setTimeout(() => {
    if (!gotReport) void fit({ w: FALLBACK_W, h: FALLBACK_H });
  }, FALLBACK_MS);
}

/**
 * Start listening for messages from the artifact iframe. Call once on boot.
 *
 * Kinds handled today:
 *   - `size`   — content size report; drives fit-to-content resize
 *   - `submit` — interactive review artifact pasted compiled prose; write to clipboard
 *   - `copy`   — an artifact Copy button; write its text to the system clipboard
 *
 * Unknown kinds are silently dropped (artifact authors may add their own
 * iframe-internal messaging without us mistaking it for protocol traffic).
 */
export function initFit(): void {
  window.addEventListener("message", (e: MessageEvent) => {
    if (isFitMessage(e.data)) {
      void fit({ w: e.data.w, h: e.data.h });
    } else if (isSubmitMessage(e.data)) {
      void handleSubmit(e.data.text);
    } else if (isCopyMessage(e.data)) {
      void copyToClipboard(e.data.text);
    }
  });
}
