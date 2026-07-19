// Curated shell repaint — when a displayed artifact declares one of a small,
// curated set of shell colors, the Board repaints its WHOLE visible surface
// (stage backdrop + board + the chrome abutting the artifact) to match, via an
// expanding clip-path circle reveal originating from the artifact. Shell and
// artifact then read as one continuous surface with no seam.
//
// SECURITY: the `shell` message arrives from a sandboxed, untrusted iframe
// (opaque origin, no allow-same-origin). We validate strictly — source string,
// kind, and curated-set membership — and NEVER inject the received color strings
// into CSS. A requested bg only ever selects OUR own known-good {bg, ink} pair
// from the table below; anything off-palette is ignored and the app shade holds.
//
// The pure logic (resolveShell / nextShellAction / isShellMessage) is DOM-free
// and unit-tested in scripts/check-shell-repaint.ts. The DOM controller reads
// `document`/`window` only inside function bodies, so importing this module in a
// Node test runner is side-effect-free.

export interface ShellColors {
  bg: string;
  ink: string;
}

/** The five curated shells. Keys are the LOWERCASED bg hex (the lookup is
 *  case-insensitive); values are the canonical bg + ink we actually paint. */
const CURATED: Readonly<Record<string, ShellColors>> = {
  "#fbfaf6": { bg: "#FBFAF6", ink: "#171A1F" }, // paper
  "#e7ecf1": { bg: "#E7ECF1", ink: "#1B2530" }, // slate
  "#e6f1ea": { bg: "#E6F1EA", ink: "#16281F" }, // mint
  "#f3e7df": { bg: "#F3E7DF", ink: "#2A1C14" }, // clay
  "#14181d": { bg: "#14181D", ink: "#E8EDF3" }, // ink
};

/** The Board's default surface shade (the app shell). Reset animates back to this. */
export const APP_SHADE = "oklch(0.945 0.014 60)";

const REVEAL_MS = 600;
const REVEAL_EASE = "cubic-bezier(0.22, 1, 0.36, 1)";
/** After a new artifact is shown, if no valid shell message lands within this
 *  window we assume it declared none and reset to the app shade. A shell message
 *  clears the timer first, so a shelled artifact never flashes through default. */
const RESET_GRACE_MS = 500;

export interface ShellMessage {
  source: "shelly-artifact";
  kind: "shell";
  bg: string;
  ink?: string;
}

/** Strict type guard for an incoming shell message from an artifact iframe. */
export function isShellMessage(d: unknown): d is ShellMessage {
  if (!d || typeof d !== "object") return false;
  const m = d as Record<string, unknown>;
  return (
    m.source === "shelly-artifact" &&
    m.kind === "shell" &&
    typeof m.bg === "string"
  );
}

/** Map a requested bg (any case) to the curated {bg, ink}, or null if off-palette.
 *  A message's `ink` is intentionally IGNORED — a curated bg has exactly one ink,
 *  and we never trust iframe-supplied color strings (that IS the ink fallback). */
export function resolveShell(bg: unknown): ShellColors | null {
  if (typeof bg !== "string") return null;
  return CURATED[bg.trim().toLowerCase()] ?? null;
}

/** The committed shell identity: a curated bg hex (canonical case) or null = app shade. */
export type ShellState = string | null;

/**
 * Pure transition: given the currently-committed shell and a request (resolved
 * curated colors, or null to reset to the app shade), decide what to do.
 * Returns null when nothing should happen — the requested surface is already
 * shown, so we must NOT re-animate (the same-color / default→default no-op rule).
 */
export function nextShellAction(
  current: ShellState,
  request: ShellColors | null,
): { colors: ShellColors | null; state: ShellState } | null {
  const nextState: ShellState = request ? request.bg : null;
  if (nextState === current) return null;
  return { colors: request, state: nextState };
}

// ---- DOM controller ---------------------------------------------------------

type OriginRef = HTMLElement | null;

let stageEl: HTMLElement | null = null;
let currentState: ShellState = null;
let resetTimer = 0;
/** The in-flight reveal, if any: its wash element, the WAAPI animation, and the
 *  commit/cleanup callback + its authoritative timer. */
let active: {
  wash: HTMLElement;
  anim: Animation | null;
  timer: number;
  finish: () => void;
} | null = null;

/** Wire the controller to the Board's stage root. Call once on boot. */
export function initShellRepaint(stage: HTMLElement): void {
  stageEl = stage;
  currentState = null;
}

function reducedMotion(): boolean {
  return (
    typeof window !== "undefined" &&
    typeof window.matchMedia === "function" &&
    window.matchMedia("(prefers-reduced-motion: reduce)").matches === true
  );
}

/** Center of an element in viewport coords, falling back to the viewport center
 *  when the element is absent or not yet laid out. */
function centerOf(el: OriginRef): { x: number; y: number } {
  if (el && typeof el.getBoundingClientRect === "function") {
    const r = el.getBoundingClientRect();
    if (r.width || r.height) {
      return { x: r.left + r.width / 2, y: r.top + r.height / 2 };
    }
  }
  return { x: (window.innerWidth || 0) / 2, y: (window.innerHeight || 0) / 2 };
}

/** Largest distance from (x,y) to any corner of a w×h box — the radius the reveal
 *  circle must reach to cover the whole surface. */
function maxRadius(x: number, y: number, w: number, h: number): number {
  return Math.hypot(Math.max(x, w - x), Math.max(y, h - y));
}

/** Write the committed shell onto the stage: a curated shell sets the tokens +
 *  `.shelled`; null clears them (back to the app shade). See board.css. */
function commitShell(stage: HTMLElement, colors: ShellColors | null): void {
  if (colors) {
    stage.style.setProperty("--shell-bg", colors.bg);
    stage.style.setProperty("--shell-ink", colors.ink);
    stage.classList.add("shelled");
  } else {
    stage.classList.remove("shelled");
    stage.style.removeProperty("--shell-bg");
    stage.style.removeProperty("--shell-ink");
  }
}

/** Tear down whatever reveal is in flight WITHOUT committing it (a newer reveal is
 *  taking over). The new reveal will paint from the current (uncommitted) surface. */
function abortActive(): void {
  if (!active) return;
  clearTimeout(active.timer);
  active.anim?.cancel();
  active.wash.remove();
  active = null;
}

/** Run the expanding-circle reveal of `bg` over the current surface, then commit.
 *
 *  The commit is driven by an AUTHORITATIVE timer, not the WAAPI `finish` event:
 *  a backgrounded tab can throttle/strand the animation's finish callback, which
 *  would leave `.shell-revealing` (and the wash) stuck forever. The timer always
 *  fires, so the surface always settles. The animation is purely the visual reveal
 *  (fill:forwards holds its end frame until we drop it). */
function reveal(
  stage: HTMLElement,
  bg: string,
  origin: { x: number; y: number },
  done: () => void,
): void {
  abortActive();

  const wash = document.createElement("div");
  wash.className = "shell-wash";
  wash.style.background = bg;
  stage.appendChild(wash);
  stage.classList.add("shell-revealing");

  const rect = stage.getBoundingClientRect();
  const x = origin.x - rect.left;
  const y = origin.y - rect.top;
  const r = maxRadius(x, y, rect.width, rect.height);

  const anim = wash.animate(
    [
      { clipPath: `circle(0px at ${x}px ${y}px)` },
      { clipPath: `circle(${Math.ceil(r)}px at ${x}px ${y}px)` },
    ],
    { duration: REVEAL_MS, easing: REVEAL_EASE, fill: "forwards" },
  );

  const finish = (): void => {
    if (!active || active.wash !== wash) return;
    clearTimeout(active.timer);
    // Commit the chrome tokens FIRST so the surface underneath already matches the
    // wash, THEN drop the wash — the removal is seamless (same color underneath).
    done();
    anim.cancel();
    wash.remove();
    stage.classList.remove("shell-revealing");
    active = null;
  };

  active = { wash, anim, finish, timer: window.setTimeout(finish, REVEAL_MS + 80) };
  // If the animation's own finish lands first (visible tab, the common case), let
  // it commit immediately rather than waiting out the safety margin.
  anim.onfinish = finish;
}

/** Apply a resolved shell (or null = reset) with the reveal, honoring the
 *  same-surface no-op rule and reduced-motion. */
function run(colors: ShellColors | null, origin: OriginRef): void {
  const action = nextShellAction(currentState, colors);
  if (!action) return;
  currentState = action.state;
  const stage = stageEl;
  if (!stage) return;

  const commit = (): void => commitShell(stage, colors);
  if (reducedMotion()) {
    abortActive();
    commit();
    return;
  }
  reveal(stage, colors ? colors.bg : APP_SHADE, centerOf(origin), commit);
}

function clearReset(): void {
  if (resetTimer) {
    clearTimeout(resetTimer);
    resetTimer = 0;
  }
}

/** Handle a validated shell message from an artifact iframe. `originEl` is the
 *  iframe the message came from (its center seeds the reveal). */
export function handleShellMessage(msg: ShellMessage, originEl: OriginRef): void {
  const colors = resolveShell(msg.bg);
  // Off-palette (or junk) → ignore entirely: do NOT clear a pending grace-timer
  // reset, so a non-curated artifact still returns the surface to the app shade.
  // Only a genuinely-curated shell cancels the reset and repaints.
  if (!colors) return;
  clearReset();
  run(colors, originEl);
}

/** Note that a (possibly different) artifact is now on screen. Arms a grace timer
 *  that resets to the app shade unless a valid shell message lands first — so a
 *  non-shell artifact returns the surface to default, while a shelled one repaints
 *  before the timer fires. `originEl` seeds the reset reveal. */
export function noteArtifactShown(originEl: OriginRef): void {
  clearReset();
  if (typeof window === "undefined") return;
  resetTimer = window.setTimeout(() => {
    resetTimer = 0;
    run(null, originEl);
  }, RESET_GRACE_MS);
}
