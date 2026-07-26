/**
 * What the user is READING, and what they are WAITING for.
 *
 * Five pieces of state that were five module-level bindings in board.ts, tangled together
 * by rules nobody wrote down in one place:
 *
 *   · `focusPath`      — the artifact open full-surface in the reader (null ⇒ reader closed)
 *   · `digestPath`      — the artifact loaded in the unit's hero slot
 *   · `backStack`       — where "← Back" goes, within one reader session
 *   · `awaitingSource`  — after a submit, the session whose NEXT artifact should auto-open
 *   · `submitted`       — path → the file's modified_ms when the user answered it
 *
 * WHY THIS IS ITS OWN FILE. Same reason as `unread-store.ts`: board.ts mounts the webview at
 * import, so nothing in it can be reached by a test, and these five were assigned at ~30
 * sites across 5,500 lines. Three rules were hand-copied between those sites, which is the
 * shape every shipped Board bug has had — two paths agreeing on the data and disagreeing on
 * the bookkeeping:
 *
 *   1. THE FOCUS/HERO PRECEDENCE. "The artifact the user is looking at" is
 *      `focusPath ?? digestPath` — the reader wins, because it is on top. Written out
 *      longhand at the submit site and re-derived by hand at two others. Now `openPath`.
 *   2. ANY READER LOAD SHOWS CURRENT CONTENT, so nothing can still be stale. Four nav paths
 *      each cleared `readerStalePath` themselves; a fifth would have left the "↻ Updated"
 *      offer sitting over content it had already loaded.
 *   3. MANUAL NAVIGATION CANCELS A PENDING AUTO-ADVANCE — otherwise the next artifact yanks
 *      the user off whatever they deliberately went to look at. Written at three of the
 *      reader's nav sites and at NONE of the hero's, which is a real asymmetry: the Board
 *      already states the principle at the splash-dismissed handler ("they're back on the
 *      prior artifact, not waiting"), and a deck flip is that same act by another route.
 *      Now every navigate function disarms, so the rule cannot be forgotten at a new one.
 *
 * DOM-free and dependency-free on purpose, so `scripts/check-board-state.ts` can drive it
 * directly. board.ts keeps the iframes and the side effects; this file owns the bookkeeping.
 */

export interface ReaderState {
  /** The artifact open full-surface in the reader, or null when the reader is closed. */
  focusPath: string | null;
  /** The artifact loaded in the unit hero's iframe, or null when the hero is blank. */
  digestPath: string | null;
  /** The on-screen unit's STANDING DIGEST (`home.<unit_key>.html`), resolved on the last
   *  renderHero, or null when that unit has none.
   *
   *  Held rather than re-probed because two sites need "is the thing on screen the digest?"
   *  — the deck (which must carry the digest as a card, since it is un-indexed and would
   *  otherwise have no position) and the bar (which themes from the digest's own
   *  `shelly-bar` block). Deriving it as `digestPath === unitDigestPath` keeps that one
   *  question answered from the frame's actual contents, rather than a second boolean that
   *  could disagree with what is loaded — the same reasoning as the no-retained-deck-index
   *  rule. Cleared whenever the hero leaves a unit, or a previous project's digest follows
   *  the user into the next one. */
  unitDigestPath: string | null;
  /** Set when the artifact open in the reader is rewritten underneath it — drives the
   *  "↻ Updated" button, which is an OFFER and never an automatic reload, so a comment
   *  being typed survives. */
  stalePath: string | null;
  /** Artifacts visited in THIS reader session, for "← Back" after jumping through the
   *  agents-need-you queue. Emptied when the reader closes, so Back can never walk into a
   *  previous session's artifact. */
  backStack: string[];
  /** After a submit, the source (session) whose NEXT artifact should auto-open. Only this
   *  session's artifacts auto-advance; another's just raises ambient unread. */
  awaitingSource: string | null;
  /** path → the file's modified_ms at submit time. Lets a card re-show its "submitted"
   *  overlay when you navigate back to it, and re-arms it when the agent rewrites it —
   *  fresh content is fresh work, not an already-answered card. */
  submitted: Map<string, number>;
}

export function createReaderState(): ReaderState {
  return {
    focusPath: null,
    digestPath: null,
    unitDigestPath: null,
    stalePath: null,
    backStack: [],
    awaitingSource: null,
    submitted: new Map(),
  };
}

// ---- what is in front of the user -------------------------------------------

/** The artifact the user is actually looking at. The reader sits ON TOP of the hero, so it
 *  wins whenever it is open — the one place that precedence is decided. */
export function openPath(state: ReaderState): string | null {
  return state.focusPath ?? state.digestPath;
}

export function isReaderOpen(state: ReaderState): boolean {
  return state.focusPath !== null;
}

/** Already on screen, in either slot. Auto-advance filters on this: "advancing" to the
 *  document already in front of you is a flicker, not a navigation. */
export function isOnScreen(state: ReaderState, path: string): boolean {
  return path === state.focusPath || path === state.digestPath;
}

// ---- reader navigation ------------------------------------------------------
// Every function here loads current content, so each clears `stalePath` (rule 2), and each
// is a deliberate move, so each disarms auto-advance (rule 3). That is why they are
// functions rather than assignments: the two rules are stated once, here.

/** First open of the reader. No back-stack push — there is nothing behind it yet. */
export function open(state: ReaderState, path: string): void {
  state.focusPath = path;
  state.stalePath = null;
  state.awaitingSource = null;
}

/** Move the reader to another artifact, keeping a trail for "← Back". Used by the
 *  agents-need-you jump AND by a consumed auto-advance, which are the same motion. */
export function advance(state: ReaderState, path: string): void {
  if (state.focusPath !== null) state.backStack.push(state.focusPath);
  state.focusPath = path;
  state.stalePath = null;
  state.awaitingSource = null;
}

/** Step back to the previously-viewed artifact. Returns the path moved to, or null when
 *  the trail is empty (in which case nothing changes and the caller should do nothing). */
export function back(state: ReaderState): string | null {
  const prev = state.backStack.pop();
  if (prev === undefined) return null;
  state.focusPath = prev;
  state.stalePath = null;
  state.awaitingSource = null;
  return prev;
}

/** Close the reader. The trail goes with it: a Back after re-opening must not jump into an
 *  artifact from a reader session the user already finished with. */
export function close(state: ReaderState): void {
  state.focusPath = null;
  state.stalePath = null;
  state.awaitingSource = null;
  state.backStack.length = 0;
}

// ---- the hero slot ----------------------------------------------------------

/** Paint the hero as part of RENDERING a unit — entry, session switch, or blanking it with
 *  null. Deliberately does NOT disarm: an arm survives the re-render that shows its own
 *  waiting scene, which is the whole point of arming. */
export function setHero(state: ReaderState, path: string | null): void {
  state.digestPath = path;
}

/** The user moved the hero themselves — a deck chevron, or the "new artifact" pill. A
 *  chosen destination, so a pending auto-advance is cancelled: the next artifact arrives as
 *  a click-to-view pill instead of yanking them off the card they just asked for. */
export function navigateHero(state: ReaderState, path: string): void {
  state.digestPath = path;
  state.awaitingSource = null;
}

// ---- the auto-advance arm ---------------------------------------------------

/** Arm after a submit. `source` may be null (nothing identifiable to wait for), which is
 *  simply not armed — so callers can pass a lookup result straight through. */
export function arm(state: ReaderState, source: string | null): void {
  state.awaitingSource = source;
}

export function disarm(state: ReaderState): void {
  state.awaitingSource = null;
}

export function armedSource(state: ReaderState): string | null {
  return state.awaitingSource;
}

export function isArmed(state: ReaderState): boolean {
  return state.awaitingSource !== null;
}

// ---- rewritten under the reader ---------------------------------------------

export function markStale(state: ReaderState, path: string): void {
  state.stalePath = path;
}

/** Whether the "↻ Updated" offer applies to what is open right now. A stale mark for some
 *  other path is not an offer — the reader moved on. */
export function isStale(state: ReaderState, path: string): boolean {
  return state.stalePath !== null && state.stalePath === path;
}

/** Read the stale path and clear it in one step, for the click that accepts the offer. The
 *  offer is consumed whether or not the reload proceeds, so it cannot be taken twice. */
export function takeStale(state: ReaderState): string | null {
  const path = state.stalePath;
  state.stalePath = null;
  return path;
}

// ---- answered cards --------------------------------------------------------

/** Record that the user answered `path`, stamped with the file's mtime at that moment. */
export function noteSubmitted(state: ReaderState, path: string, modifiedMs: number): void {
  state.submitted.set(path, modifiedMs);
}

/**
 * Should this artifact re-show its "submitted" overlay?
 *
 * THE RULE, in the one place it is written: answered, and not rewritten since. It was
 * spelled out twice — once in the reader's load handler and once in the hero's — as a
 * three-step stamp/lookup/compare each time, so the two could drift.
 *
 * `currentModifiedMs` is undefined when the artifact is not in the list we hold (it was
 * archived, or the poll has not caught up). The stamp is then the only evidence there is,
 * and it says answered — so trust it, exactly as both original sites did.
 */
export function wasSubmitted(
  state: ReaderState,
  path: string,
  currentModifiedMs: number | undefined,
): boolean {
  const stamp = state.submitted.get(path);
  if (stamp === undefined) return false;
  if (currentModifiedMs === undefined) return true;
  return currentModifiedMs === stamp;
}

/** Forget artifacts that no longer exist, so the map cannot grow for the life of the
 *  process. Rides along with the unread ledger's own prune on the same poll. */
export function retainSubmitted(state: ReaderState, present: Set<string>): void {
  for (const path of [...state.submitted.keys()]) {
    if (!present.has(path)) state.submitted.delete(path);
  }
}
