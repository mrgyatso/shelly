// Owns the Board's embedded per-session terminals AND their L2 panel chrome.
//
// Each terminal is a real `claude` the Board spawned in a PTY it owns (the only
// ToS-compliant way to use the user's OAuth). This module:
//   • tracks the owned terminals (Map<tabId, …>),
//   • builds the collapsible panel inside the L2 `#unit-terminals` slot (header
//     with a "+ session" button, a close button, and a collapse chevron, above a
//     body the terminal mounts live in),
//   • reveals the terminals bound to the unit being viewed, and
//   • keeps every PTY alive across navigation and collapse — mounts persist
//     (hidden, never disposed); only `pty-exit` or an explicit close disposes.
//
// Binding: a freshly spawned terminal knows only its own `tabId`. The
// SessionStart hook writes `owned-sessions.json` (`<slug>--<shortid>` → tabId);
// `live.rs` injects `companion_session` into each live source; `reconcileBindings`
// (from the Board's pollLive) adopts the terminal into the unit of the source
// whose `companion_session === tabId`. A new terminal may be given a PROVISIONAL
// unit at spawn (when launched from inside an L2 unit) so it shows immediately;
// the binding later confirms it.

import { createTerminal, type TerminalHandle } from "./terminal";

interface OwnedTerminal {
  readonly tabId: string;
  /** null while unbound; a provisional or confirmed unit_key otherwise. */
  unitKey: string | null;
  readonly mount: HTMLElement;
  handle: TerminalHandle | null;
  exited: boolean;
}

/** A binding adopted this poll (returned so the Board can re-show / auto-navigate). */
export interface NewBinding {
  tabId: string;
  unitKey: string;
}

export interface OwnedTerminalsOpts {
  /** Resolve the absolute dir to spawn `claude` in for the given unit (from the
   *  Board's unit_dir, injected per live source). null ⇒ can't auto-start here. */
  resolveDir: (unitKey: string) => string | null;
  /** The Board's floating status dot — pulses when output arrives while the
   *  terminal is tucked away (the panel itself carries no header now). */
  statusDot?: HTMLElement | null;
}

const terminals = new Map<string, OwnedTerminal>();

let panelEl: HTMLElement | null = null; // #unit-terminals (the whole panel)
let pillsEl: HTMLElement | null = null; // session switcher (>1 session per unit)
let bodyEl: HTMLElement | null = null; // holds the .term-mount divs
let dotEl: HTMLElement | null = null; // floating status dot (pulses on hidden activity)
/** Per-unit active terminal (when a unit has >1 owned session). */
const activeByUnit = new Map<string, string>();
let resolveDir: (unitKey: string) => string | null = () => null;

/** Collapsed = the panel is tucked to just its header; the PTY keeps running.
 *  Module-level so it persists across Board navigation. */
let collapsed = false;
/** The unit currently shown at L2 (drives "+ session" cwd + which terminal shows). */
let currentUnit: string | null = null;
let seq = 0;
/** A per-process tag so two coexisting overlay instances (e.g. your stable app +
 *  a `tauri dev` build sharing one ~/.claude/companion) never mint the same tabId
 *  — owned-sessions.json is keyed stem→tabId, so a shared `board-1` would cross-
 *  bind sessions between the two apps. 4 random chars is plenty to disambiguate. */
const INSTANCE = Math.random().toString(36).slice(2, 6);

/** Build the panel chrome inside the L2 `#unit-terminals` slot. Call once. */
export function initOwnedTerminals(slot: HTMLElement, opts: OwnedTerminalsOpts): void {
  panelEl = slot;
  resolveDir = opts.resolveDir;
  dotEl = opts.statusDot ?? null;
  slot.replaceChildren();

  // No header bar: the terminal fills the surface (a unit IS a session, so there's
  // no "start a session" / "+ session" empty state). The resize / status-dot / end
  // controls live in the Board's floating cluster (wired in board.ts); the passed-in
  // dot pulses when output arrives while the terminal is tucked away.
  pillsEl = document.createElement("div");
  pillsEl.className = "term-pills";
  pillsEl.hidden = true;

  bodyEl = document.createElement("div");
  bodyEl.className = "term-body";

  // The embedded terminal IS claude's prompt; you type directly into it. (Artifact
  // ✓/✎/✗ answers still route into the PTY via the Board's submit handler.)
  slot.append(pillsEl, bodyEl);
  applyCollapsed();
}

/** Spawn a Board-owned `claude` in `cwd`. Returns the tabId. `provisionalUnit`
 *  shows it immediately under that unit (launched from inside an L2 unit);
 *  otherwise it stays unbound until `reconcileBindings` adopts it. */
export async function spawnOwnedSession(
  cwd: string,
  provisionalUnit?: string,
  resume?: string,
): Promise<string> {
  if (!bodyEl) throw new Error("owned terminals not initialized");
  seq += 1;
  const tabId = `board-${INSTANCE}-${seq}`;
  const mount = document.createElement("div");
  mount.className = "term-mount";
  mount.dataset.tab = tabId;
  mount.hidden = true;
  bodyEl.appendChild(mount);

  const owned: OwnedTerminal = {
    tabId,
    unitKey: provisionalUnit ?? null,
    mount,
    handle: null,
    exited: false,
  };
  terminals.set(tabId, owned);
  // A freshly spawned terminal is the one to SHOW for its unit — make it active so
  // `shownForUnit` returns it even when the unit already has a prior active session
  // (otherwise reusing a project key as the provisional would reveal the OLD
  // terminal, not the one just created). ensureOwnedTerminal/showSessionInUnit also
  // set this right after spawn; doing it here covers the launch/resume paths too.
  if (provisionalUnit) activeByUnit.set(provisionalUnit, tabId);
  owned.handle = await createTerminal(tabId, mount, {
    cwd,
    resume,
    onExit: () => {
      owned.exited = true;
    },
    onActivity: () => {
      // Output arrived while this terminal was hidden — pulse the header dot if
      // it's the shown session of the current unit (i.e. tucked behind collapse).
      if (currentUnit && owned.unitKey === currentUnit && owned === shownForUnit(currentUnit)) {
        dotEl?.classList.add("pulsing");
      }
    },
  });
  return tabId;
}

/** Adopt freshly-bound terminals into their units. `sessionToUnit` maps a
 *  `companion_session` (tabId) → the `unit_key` of the live source carrying it.
 *  Returns the bindings that changed this call (for re-show / auto-navigate). */
export function reconcileBindings(sessionToUnit: Map<string, string>): NewBinding[] {
  const changed: NewBinding[] = [];
  for (const t of terminals.values()) {
    const unit = sessionToUnit.get(t.tabId);
    if (unit && unit !== t.unitKey) {
      t.unitKey = unit;
      changed.push({ tabId: t.tabId, unitKey: unit });
    }
  }
  return changed;
}

/** Reveal the panel for `unitKey`: header always (so "+ session" is reachable),
 *  the bound terminal's body unless collapsed. */
export function showOwnedTerminals(unitKey: string): void {
  if (!panelEl) return;
  currentUnit = unitKey;
  const shown = shownForUnit(unitKey);
  // No live terminal to show → keep the panel hidden (no "start a session" empty
  // box). Auto-start spawns one on entry; this is re-called once it exists.
  if (!shown) {
    for (const t of terminals.values()) t.mount.hidden = true;
    panelEl.hidden = true;
    return;
  }
  panelEl.hidden = false;
  for (const t of terminals.values()) t.mount.hidden = t !== shown;
  renderPills(unitKey);
  applyCollapsed();
  if (shown && !collapsed) {
    dotEl?.classList.remove("pulsing"); // visible now — clear any activity pulse
    fitSoon(shown);
  }
}

/** Hide the panel (leaving L2). PTYs keep running — only visibility changes; the
 *  collapsed state is preserved for the next visit. */
export function hideOwnedTerminals(): void {
  currentUnit = null;
  for (const t of terminals.values()) t.mount.hidden = true;
  if (panelEl) panelEl.hidden = true;
}

/** Whether `unitKey` has any owned terminal (drives the L1 "terminal" badge). */
export function unitHasOwnedTerminal(unitKey: string): boolean {
  for (const t of terminals.values()) if (t.unitKey === unitKey) return true;
  return false;
}

/** A live owned-terminal tabId for `unitKey` (the shown one if any, else the
 *  first), or null. Lets an artifact's Submit route into the session's terminal
 *  even when the precise owning session can't be resolved from the artifact. */
export function ownedTabForUnit(unitKey: string): string | null {
  const shown = shownForUnit(unitKey);
  if (shown && !shown.exited) return shown.tabId;
  for (const t of terminals.values()) if (t.unitKey === unitKey && !t.exited) return t.tabId;
  return null;
}

/** End (kill the PTY of) every owned terminal in `unitKey`. Used when closing a
 *  unit off the roster so a Board-launched `claude` can't keep running in the
 *  background. The session stays REJOINABLE via `claude --resume` — its session
 *  id is preserved in the (now-dismissed) live source. */
export function endOwnedTerminalsForUnit(unitKey: string): void {
  for (const t of [...terminals.values()]) {
    if (t.unitKey === unitKey) closeOwnedTerminal(t.tabId);
  }
}

/** Distinct unit keys that currently have a (non-disposed) owned terminal. The
 *  Board lists these at L1 even when the agent's live file is gone — SessionEnd
 *  deletes that file, but the PTY is the Board's OWN state, so a launched session
 *  must stay reachable until it's explicitly closed. */
export function ownedUnits(): string[] {
  const set = new Set<string>();
  for (const t of terminals.values()) if (t.unitKey) set.add(t.unitKey);
  return [...set];
}

// ── launch + lifecycle ──────────────────────────────────────────────────────

/** Ensure the unit has a live owned terminal. With session-first unit_keys a unit
 *  IS one specific session, so entry must RESUME that session (`resume` = its
 *  Claude session id) — a resumed claude keeps the same id ⇒ same unit_key ⇒ it
 *  binds back to THIS unit and is reused on re-entry. A fresh (no-resume) spawn
 *  would mint a NEW session id ⇒ NEW unit_key ⇒ it re-homes away from the clicked
 *  card, orphaning it and cloning a new card on every entry (the clone bug). A
 *  guard prevents a double-spawn from rapid re-entry. Returns whether a terminal
 *  is now present. */
const spawningUnits = new Set<string>();
export async function ensureOwnedTerminal(unitKey: string, resume?: string): Promise<boolean> {
  if (shownForUnit(unitKey)) return true;
  if (spawningUnits.has(unitKey)) return false;
  const dir = resolveDir(unitKey);
  if (!dir) return false;
  spawningUnits.add(unitKey);
  try {
    const tabId = await spawnOwnedSession(dir, unitKey, resume);
    activeByUnit.set(unitKey, tabId);
    return true;
  } finally {
    spawningUnits.delete(unitKey);
  }
}

/** Switch to a SPECIFIC session within `unitKey` (the two-level rail's per-session
 *  click). Three cases, mirroring the per-unit rule at the session grain:
 *   • already-owned terminal (matched by its tabId) ⇒ activate + show;
 *   • Board-launchable but no terminal here (resumeId present) ⇒ resume by id;
 *   • external session (no terminal, no resumeId) ⇒ false — caller shows state only,
 *     never spawning a duplicate `claude` for a session in the user's own terminal.
 *  Resuming by id keeps the session id ⇒ it binds back to THIS unit ⇒ no clone. */
const resumingSessions = new Set<string>();
export async function showSessionInUnit(
  unitKey: string,
  tabId: string | null,
  resumeId: string | null,
): Promise<boolean> {
  if (tabId) {
    const t = terminals.get(tabId);
    if (t && !t.exited) {
      activeByUnit.set(unitKey, tabId);
      showOwnedTerminals(unitKey);
      return true;
    }
  }
  if (resumeId) {
    if (resumingSessions.has(resumeId)) return false;
    const dir = resolveDir(unitKey);
    if (!dir) return false;
    resumingSessions.add(resumeId);
    try {
      const newTab = await spawnOwnedSession(dir, unitKey, resumeId);
      activeByUnit.set(unitKey, newTab);
      showOwnedTerminals(unitKey);
      return true;
    } finally {
      resumingSessions.delete(resumeId);
    }
  }
  return false;
}

/** End the shown owned terminal of the current unit (the floating ✕). */
export function endShownTerminal(): void {
  if (!currentUnit) return;
  const shown = shownForUnit(currentUnit);
  if (shown) closeOwnedTerminal(shown.tabId);
}

/** Dispose a terminal: kill its PTY, remove its mount, drop it from the map. */
export function closeOwnedTerminal(tabId: string): void {
  const t = terminals.get(tabId);
  if (!t) return;
  t.handle?.dispose(); // disconnects listeners + close_pty + xterm.dispose
  t.mount.remove();
  terminals.delete(tabId);
  if (t.unitKey && activeByUnit.get(t.unitKey) === tabId) activeByUnit.delete(t.unitKey);
  if (currentUnit) showOwnedTerminals(currentUnit);
}

/** A pill switcher: one per owned session in this unit, shown only when >1. */
function renderPills(unitKey: string): void {
  if (!pillsEl) return;
  const list = terminalsForUnit(unitKey);
  pillsEl.replaceChildren();
  pillsEl.hidden = list.length < 2;
  if (list.length < 2) return;
  const shown = shownForUnit(unitKey);
  list.forEach((t, i) => {
    const pill = document.createElement("button");
    pill.className = "term-pill" + (t === shown ? " active" : "") + (t.exited ? " exited" : "");
    pill.textContent = `claude ${i + 1}`;
    pill.addEventListener("click", () => {
      activeByUnit.set(unitKey, t.tabId);
      showOwnedTerminals(unitKey);
    });
    pillsEl!.appendChild(pill);
  });
}

function terminalsForUnit(unitKey: string): OwnedTerminal[] {
  const list: OwnedTerminal[] = [];
  for (const t of terminals.values()) if (t.unitKey === unitKey) list.push(t);
  return list;
}

// ── collapse + header state ─────────────────────────────────────────────────

function setCollapsed(next: boolean): void {
  if (collapsed === next) return;
  collapsed = next;
  applyCollapsed();
  if (!next && currentUnit) {
    dotEl?.classList.remove("pulsing"); // expanded — the user is looking at it now
    const shown = shownForUnit(currentUnit);
    if (shown) fitSoon(shown);
  }
}

/** Drive the terminal's collapse from the Board's focus strip. Tucks the panel to
 *  its (warm) bar; the PTY keeps running, and expanding refits it. */
export function setTerminalCollapsed(next: boolean): void {
  setCollapsed(next);
}

/** Fit the shown terminal to its current box. Use after a layout change that grows
 *  the panel WITHOUT toggling collapse (e.g. the artifact tucking away on
 *  focus-terminal) — the ResizeObserver would catch it too, but this is immediate. */
export function fitShownTerminal(): void {
  if (!currentUnit) return;
  const shown = shownForUnit(currentUnit);
  if (shown) fitSoon(shown);
}

function applyCollapsed(): void {
  const shown = currentUnit ? shownForUnit(currentUnit) : null;
  // The body + chat only matter when there's a terminal to show; collapse hides
  // them too (the header bar stays so "+ session" / expand remain reachable).
  const hideBody = collapsed || !shown;
  if (bodyEl) bodyEl.hidden = hideBody;
  panelEl?.classList.toggle("collapsed", hideBody);
}

function shownForUnit(unitKey: string): OwnedTerminal | null {
  const list = terminalsForUnit(unitKey);
  if (list.length === 0) return null;
  const activeId = activeByUnit.get(unitKey);
  const active = activeId ? list.find((t) => t.tabId === activeId) : null;
  // Default to the most-recently-created when none is explicitly active.
  return active ?? list[list.length - 1];
}

/** Fit + focus a terminal after the next frame, once its mount has a real box. */
function fitSoon(t: OwnedTerminal): void {
  requestAnimationFrame(() => {
    t.handle?.fit();
    t.handle?.focus();
  });
}
