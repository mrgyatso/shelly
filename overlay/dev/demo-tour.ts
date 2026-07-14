/* =============================================================================
   DEMO TOUR — a driven, step-at-a-time walkthrough of the real Board.

   Demo-build only (imported by demo-boot.ts). The tour performs REAL clicks on
   the live shell — an animated cursor moves to the control, clicks it, and a
   popover explains what just happened. Nothing is faked: the same handlers the
   user will click run underneath, against the demo profile's fixtures.

   Start with `?tour` on the demo URL, or programmatically via
   `window.__companionTour.start()` (also how Playwright drives it).
   ============================================================================= */

interface TourStep {
  /** Element to spotlight once the step settles. */
  spot: string | (() => Element | null);
  title: string;
  /** Trusted, authored-here HTML. */
  body: string;
  /** Element the tour's cursor clicks on ENTERING the step (the driven action). */
  click?: string | (() => Element | null);
  /** After the click, wait until this selector matches before spotlighting. */
  settle?: string;
  /** Runs on entry, before anything else (e.g. dismiss a menu a prior step opened). */
  pre?: () => void;
  placement?: "left" | "right" | "top" | "bottom";
}

const ACCENT = "#cc785c";
const DIM = "rgba(24, 19, 15, 0.5)";
const EASE = "cubic-bezier(.4,0,.2,1)";

/* The dim is FOUR panels around the spotlight hole, not one huge box-shadow —
   Chromium clamps very large shadow spreads, which left most of the screen
   undimmed. Each panel transitions its own rect, so the hole glides. */
const CSS = `
  .tour-dim { position: fixed; inset: 0; z-index: 10480; pointer-events: none; }
  .tour-dim > div {
    position: fixed; background: ${DIM};
    transition: top 480ms ${EASE}, left 480ms ${EASE},
                width 480ms ${EASE}, height 480ms ${EASE}, opacity 260ms ease;
  }
  .tour-shield { position: fixed; inset: 0; z-index: 10490; background: transparent; }
  .tour-ring {
    position: fixed; z-index: 10485; pointer-events: none;
    border-radius: 11px; box-shadow: 0 0 0 2px ${ACCENT}, 0 0 26px rgba(204,120,92,.45);
    transition: top 480ms ${EASE}, left 480ms ${EASE},
                width 480ms ${EASE}, height 480ms ${EASE}, opacity 260ms ease;
  }
  .tour-pop {
    position: fixed; z-index: 10520; width: 318px;
    background: #FBFAF6; color: #171A1F; border-radius: 13px;
    border: 1px solid rgba(23,26,31,.14);
    box-shadow: 0 24px 60px -18px rgba(20,16,12,.55);
    padding: 15px 17px 13px;
    font-family: 'Inter', ui-sans-serif, system-ui, -apple-system, sans-serif;
    opacity: 0; transform: translateY(6px);
    transition: opacity 240ms ease, transform 240ms ease,
                top 420ms ${EASE}, left 420ms ${EASE};
  }
  .tour-pop.show { opacity: 1; transform: none; }
  .tour-pop .tp-kicker {
    font: 600 9.5px/1 ui-monospace, Menlo, monospace;
    letter-spacing: .17em; text-transform: uppercase; color: ${ACCENT};
    display: flex; align-items: center; justify-content: space-between; margin-bottom: 8px;
  }
  .tour-pop .tp-skip {
    all: unset; cursor: pointer; color: #9a9184; font-size: 13px; line-height: 1;
    padding: 2px 4px; letter-spacing: 0;
  }
  .tour-pop .tp-skip:hover { color: #171A1F; }
  .tour-pop .tp-title {
    font-family: Georgia, 'Times New Roman', serif;
    font-size: 18.5px; font-weight: 600; letter-spacing: -.015em; line-height: 1.15;
    margin: 0 0 7px;
  }
  .tour-pop .tp-body { font-size: 13px; line-height: 1.58; color: #39404A; margin: 0 0 12px; }
  .tour-pop .tp-body b { color: #171A1F; }
  .tour-pop .tp-body code {
    font: 11.5px/1 ui-monospace, Menlo, monospace;
    background: rgba(23,26,31,.07); padding: 1.5px 4px; border-radius: 4px;
  }
  .tour-pop .tp-foot { display: flex; align-items: center; justify-content: space-between; }
  .tour-pop .tp-dots { display: flex; gap: 4.5px; }
  .tour-pop .tp-dots span {
    width: 5.5px; height: 5.5px; border-radius: 50%; background: rgba(23,26,31,.16);
    transition: background 200ms;
  }
  .tour-pop .tp-dots span.on { background: ${ACCENT}; }
  .tour-pop .tp-next {
    all: unset; cursor: pointer; background: #171A1F; color: #FBFAF6;
    font-size: 12.5px; font-weight: 600; padding: 7px 15px; border-radius: 8px;
    transition: background 140ms;
  }
  .tour-pop .tp-next:hover { background: #2c333d; }
  .tour-cursor {
    position: fixed; z-index: 10530; left: 0; top: 0; pointer-events: none;
    width: 21px; height: 21px; opacity: 0;
    transition: transform 680ms cubic-bezier(.3,.75,.25,1), opacity 300ms ease;
    filter: drop-shadow(0 2px 5px rgba(0,0,0,.4));
  }
  .tour-ripple {
    position: fixed; z-index: 10529; pointer-events: none;
    width: 34px; height: 34px; border-radius: 50%; border: 2.5px solid ${ACCENT};
    transform: translate(-50%,-50%) scale(.25); opacity: .95;
    animation: tourRipple 520ms ease-out forwards;
  }
  @keyframes tourRipple {
    to { transform: translate(-50%,-50%) scale(1.5); opacity: 0; }
  }
  @media (prefers-reduced-motion: reduce) {
    .tour-dim > div, .tour-ring, .tour-pop, .tour-cursor { transition-duration: 1ms; }
  }
`;

const CURSOR_SVG = `<svg viewBox="0 0 24 24" xmlns="http://www.w3.org/2000/svg">
  <path d="M5.5 2.2 L5.5 18.6 L9.6 15.1 L12.2 21.4 L15.1 20.2 L12.5 14.1 L18 13.6 Z"
        fill="#FBFAF6" stroke="#171A1F" stroke-width="1.4" stroke-linejoin="round"/></svg>`;

const sleep = (ms: number): Promise<void> => new Promise((r) => setTimeout(r, ms));

function resolveEl(sel: string | (() => Element | null)): HTMLElement | null {
  const el = typeof sel === "string" ? document.querySelector(sel) : sel();
  return el instanceof HTMLElement ? el : null;
}

/** Resolve once `sel` matches a visible element, or reject after `timeoutMs`. */
function settleOn(sel: string, timeoutMs = 6000): Promise<HTMLElement> {
  return new Promise((resolve, reject) => {
    const started = Date.now();
    const tick = (): void => {
      const el = document.querySelector(sel);
      if (el instanceof HTMLElement && el.getClientRects().length > 0) { resolve(el); return; }
      if (Date.now() - started > timeoutMs) { reject(new Error(`tour: ${sel} never settled`)); return; }
      requestAnimationFrame(tick);
    };
    tick();
  });
}

class Tour {
  private steps: TourStep[];
  private i = -1;
  private dim!: HTMLDivElement;
  private panels: HTMLDivElement[] = [];
  private shield!: HTMLDivElement;
  private ring!: HTMLDivElement;
  private pop!: HTMLDivElement;
  private cursor!: HTMLDivElement;
  private alive = false;
  private onKey = (e: KeyboardEvent): void => {
    if (e.key === "Escape") this.end();
  };

  constructor(steps: TourStep[]) {
    this.steps = steps;
  }

  start(): void {
    if (this.alive) return;
    this.alive = true;
    const style = document.createElement("style");
    style.dataset.tour = "1";
    style.textContent = CSS;
    document.head.append(style);
    this.dim = document.createElement("div");
    this.dim.className = "tour-dim";
    this.panels = Array.from({ length: 4 }, () => {
      const p = document.createElement("div");
      this.dim.append(p);
      return p;
    });
    this.shield = document.createElement("div");
    this.shield.className = "tour-shield";
    this.ring = document.createElement("div");
    this.ring.className = "tour-ring";
    this.ring.style.opacity = "0";
    this.pop = document.createElement("div");
    this.pop.className = "tour-pop";
    this.cursor = document.createElement("div");
    this.cursor.className = "tour-cursor";
    this.cursor.innerHTML = CURSOR_SVG;
    document.body.append(this.dim, this.shield, this.ring, this.pop, this.cursor);
    document.addEventListener("keydown", this.onKey, true);
    window.addEventListener("resize", this.onResize);
    void this.goto(0);
  }

  end(): void {
    if (!this.alive) return;
    this.alive = false;
    document.removeEventListener("keydown", this.onKey, true);
    window.removeEventListener("resize", this.onResize);
    for (const el of [this.dim, this.shield, this.ring, this.pop, this.cursor]) el.remove();
    document.querySelector("style[data-tour]")?.remove();
    // A tour-opened transient menu should not outlive the tour.
    document.querySelector(".newsession-menu")?.remove();
  }

  private onResize = (): void => {
    // Re-anchor everything to the (possibly moved) spot target.
    const step = this.steps[this.i];
    if (!step) return;
    const el = resolveEl(step.spot);
    if (el) this.frame(el.getBoundingClientRect(), step.placement);
  };

  /** Position the four dim panels and the accent ring around `r`. */
  private frame(r: DOMRect, placement?: TourStep["placement"]): void {
    const pad = 7;
    const t = Math.max(0, r.top - pad);
    const l = Math.max(0, r.left - pad);
    const b = Math.min(window.innerHeight, r.bottom + pad);
    const rt = Math.min(window.innerWidth, r.right + pad);
    const set = (el: HTMLElement, x: number, y: number, w: number, h: number): void => {
      el.style.left = `${x}px`;
      el.style.top = `${y}px`;
      el.style.width = `${Math.max(0, w)}px`;
      el.style.height = `${Math.max(0, h)}px`;
    };
    set(this.panels[0], 0, 0, window.innerWidth, t); // above
    set(this.panels[1], 0, b, window.innerWidth, window.innerHeight - b); // below
    set(this.panels[2], 0, t, l, b - t); // left
    set(this.panels[3], rt, t, window.innerWidth - rt, b - t); // right
    this.ring.style.opacity = "1";
    set(this.ring, l, t, rt - l, b - t);
    this.placePop(r, placement);
  }

  /** Animate the fake cursor to `el`'s centre, pulse, and dispatch a real click. */
  private async cursorClick(el: HTMLElement): Promise<void> {
    const r = el.getBoundingClientRect();
    const x = r.left + r.width / 2;
    const y = r.top + r.height / 2;
    const cur = this.cursor;
    if (cur.style.opacity !== "1") {
      // (Re)appearance: come in from the popover's corner, not from (0,0).
      const pr = this.pop.getBoundingClientRect();
      cur.style.transitionProperty = "opacity";
      cur.style.transform = `translate(${pr.left + 40}px, ${pr.bottom - 6}px)`;
      void cur.offsetWidth; // flush so the jump isn't animated
      cur.style.transitionProperty = "";
      cur.style.opacity = "1";
    }
    cur.style.transform = `translate(${x - 4}px, ${y - 3}px)`;
    await sleep(720);
    const ripple = document.createElement("div");
    ripple.className = "tour-ripple";
    ripple.style.left = `${x}px`;
    ripple.style.top = `${y}px`;
    document.body.append(ripple);
    setTimeout(() => ripple.remove(), 600);
    await sleep(140);
    el.click();
  }

  private placePop(target: DOMRect, placement?: TourStep["placement"]): void {
    const W = 318;
    const H = this.pop.offsetHeight || 170;
    const gap = 14;
    const vw = window.innerWidth;
    const vh = window.innerHeight;
    let side = placement;
    if (!side) {
      if (target.right + gap + W < vw) side = "right";
      else if (target.left - gap - W > 0) side = "left";
      else if (target.bottom + gap + H < vh) side = "bottom";
      else side = "top";
    }
    let left: number;
    let top: number;
    if (side === "right") { left = target.right + gap; top = target.top; }
    else if (side === "left") { left = target.left - gap - W; top = target.top; }
    else if (side === "bottom") { left = target.left; top = target.bottom + gap; }
    else { left = target.left; top = target.top - gap - H; }
    left = Math.max(12, Math.min(left, vw - W - 12));
    top = Math.max(12, Math.min(top, vh - H - 12));
    this.pop.style.left = `${left}px`;
    this.pop.style.top = `${top}px`;
  }

  private async goto(i: number): Promise<void> {
    if (!this.alive) return;
    if (i >= this.steps.length) { this.end(); return; }
    this.i = i;
    const step = this.steps[i];
    this.pop.classList.remove("show");

    try {
      step.pre?.();
      if (step.click) {
        const target = resolveEl(step.click);
        if (!target) throw new Error("tour: click target missing");
        await this.cursorClick(target);
        if (step.settle) await settleOn(step.settle);
        await sleep(280); // let the view's own transitions finish
        // A click that navigated away leaves nothing to point at — retire the
        // cursor rather than let it float over unrelated UI.
        if (!target.isConnected || target.getClientRects().length === 0) {
          this.cursor.style.opacity = "0";
        }
      }
    } catch (e) {
      console.error(e);
      this.end();
      return;
    }
    if (!this.alive) return;

    const el = resolveEl(step.spot);
    if (!el) { console.error("tour: spot target missing, skipping step"); void this.goto(i + 1); return; }

    const last = i === this.steps.length - 1;
    const dots = this.steps.map((_, n) => `<span${n === i ? ' class="on"' : ""}></span>`).join("");
    this.pop.innerHTML = `
      <div class="tp-kicker"><span>Tour · ${i + 1} of ${this.steps.length}</span>
        <button class="tp-skip" title="End tour">✕</button></div>
      <div class="tp-title">${step.title}</div>
      <div class="tp-body">${step.body}</div>
      <div class="tp-foot"><div class="tp-dots">${dots}</div>
        <button class="tp-next">${last ? "Finish" : "Next →"}</button></div>`;
    this.pop.querySelector(".tp-skip")?.addEventListener("click", () => this.end());
    this.pop.querySelector(".tp-next")?.addEventListener("click", () => void this.goto(i + 1));

    this.frame(el.getBoundingClientRect(), step.placement);
    await sleep(60);
    this.pop.classList.add("show");
  }
}

/* ---- The script: the first-run guide's TOC, driven live. -------------------
   Copy mirrors docs/guide/companion-guide.html; every selector is a real shell
   control (see index.html / board.ts). One session per demo unit means the
   multi-session drawer can't be clicked here — the rail step narrates it. */

const STEPS: TourStep[] = [
  {
    spot: "#hub-door-sessions",
    title: "Your work lives behind this door",
    body: "This is the Board's home. <b>Sessions</b> holds every project you and your agents are working on. Watch — I'll open it.",
    placement: "right",
  },
  {
    click: "#hub-door-sessions",
    settle: "#board-unit:not([hidden])",
    spot: "#unit-rail",
    title: "The rail",
    body: "Every <b>project</b> is a row — live work on top, <b>recent</b> work below, ordered by who needs a decision from you. A project holds its <b>sessions</b>; when it has several, a ▸ chevron opens them.",
    placement: "right",
  },
  {
    spot: "#unit-digest",
    title: "This page is an artifact",
    body: "Your agent wrote it — a real HTML page, not chat scrollback. Instead of reading a wall of terminal text, you read <b>this</b>: the finding, the evidence, and what it wants from you.",
    placement: "left",
  },
  {
    spot: "#unit-digest",
    title: "Answer it without typing",
    body: "Artifacts end in choices: <b>✓ do it</b>, <b>✎ add a note</b>, <b>✗ skip</b> — then one <b>Submit</b> sends your decisions to the agent. Hover any paragraph and a <b>💬</b> appears to question that exact line.",
    placement: "bottom",
  },
  {
    spot: "#unit-terminals",
    title: "The terminal is right here",
    body: "The real Claude Code session, on the Board. Click in and type when you want to get granular — you never <i>have</i> to leave the artifact, but you're one click from the raw session.",
    placement: "top",
  },
  {
    click: '.surface-focus[data-focus="terminal"]',
    spot: "#unit-surface-controls",
    title: "Resize the split",
    body: "I just focused the terminal — watch it take the pane. These three buttons pick the layout: <b>⬒ artifact</b>, <b>⊟ split</b>, <b>⬓ terminal</b>. Use whichever the moment needs.",
    placement: "bottom",
  },
  {
    click: '.surface-focus[data-focus="split"]',
    spot: "#unit-meter",
    title: "Keep an eye on context",
    body: "The meter shows how full the session's context is. When it runs hot, <b>Compact</b> asks Claude to summarize and free room — one click, no typing.",
    placement: "bottom",
  },
  {
    click: "#board-newsession",
    settle: ".newsession-menu",
    spot: ".newsession-menu",
    title: "Starting a new session",
    body: "The <b>+</b> button, from anywhere: <b>Start in a folder…</b> points Claude at a project, <b>Start at home</b> opens a scratch session. The terminal appears right on the Board — and ✕ on the toolbar ends it.",
    placement: "left",
  },
  {
    pre: () => document.querySelector(".newsession-menu")?.remove(),
    spot: "#demo-links",
    title: "That's the whole loop",
    body: "Agent works → artifact lands → you answer → it keeps moving. Everything here was the real shell; only the sessions were recorded. <b>Install it from GitHub</b> and the Board does this with your own projects.",
    placement: "bottom",
  },
];

const tour = new Tour(STEPS);
declare global {
  interface Window { __companionTour?: { start: () => void; end: () => void } }
}
window.__companionTour = { start: () => tour.start(), end: () => tour.end() };

/* The script assumes it begins on the hub (step 1 spotlights a hub door). A
   fresh boot lands there; once the visitor has wandered into a unit, the only
   reliable way back to the scripted state is a reload with ?tour. */
const TOURED_KEY = "companion-demo-toured";
document.getElementById("demo-tour-btn")?.addEventListener("click", () => {
  const door = document.getElementById("hub-door-sessions");
  if (door && door.getClientRects().length > 0) tour.start();
  else location.search = "?tour";
});

/* Auto-run for first-time visitors — the tour IS the teaching surface — and on
   an explicit ?tour. The delay gives demo-boot's terminal priming a beat to
   land. Once seen (or skipped), never auto-run again. */
const wantsTour = new URLSearchParams(location.search).has("tour");
let firstVisit = false;
try {
  firstVisit = !localStorage.getItem(TOURED_KEY);
  localStorage.setItem(TOURED_KEY, "1");
} catch { /* storage may be blocked; the button still works */ }
if (wantsTour || firstVisit) setTimeout(() => tour.start(), 1600);

export {};
