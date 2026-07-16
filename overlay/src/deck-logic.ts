/**
 * Pure logic for the Board's artifact DECK — the hero's pageable stack. DOM-free and
 * dependency-light so it can be unit-tested directly (see `scripts/check-artifact-deck.ts`)
 * without standing up the Tauri/webview runtime. board.ts holds the state and side
 * effects; this file holds the ordering, the addressing, and the flip arithmetic.
 *
 * The deck replaces the hero's ONE SLOT: a newer artifact used to overwrite the same
 * rectangle with no transition ("you can't even tell that it updates") and buried the
 * previous one in history. The deck keeps every card of the active session's run
 * reachable, one flip apart.
 */

// Extension-explicit (tsconfig sets `allowImportingTsExtensions`) because this is the
// first tested module that isn't a leaf: `scripts/check-artifact-deck.ts` runs it under
// node's native type-stripping, which resolves real paths rather than bundler-style bare
// specifiers. Vite resolves it identically.
import { scopeToSession, type HeroCandidate } from "./ingest-logic.ts";

/** A card as the deck sees it — the same shape the hero selector reads. */
export type DeckCard = HeroCandidate;

/** Which way a flip travels: `1` toward the newer end, `-1` toward the older. */
export type FlipDir = 1 | -1;

/** Where the read card sits in the deck, 0-based, plus how deep the deck is. */
export interface DeckPosition {
  index: number;
  total: number;
}

/**
 * Build the deck for a unit: the ACTIVE SESSION's artifacts, oldest card first.
 *
 * SCOPE (invariant): a sibling session's artifact is never a card here, however new it
 * is — it is ambient unread instead. The rule isn't re-derived: `scopeToSession` is the
 * same filter `heroArtifactFor` selects the hero through, so the deck's newest card and
 * the hero's pick cannot drift apart (pinned by `check-artifact-deck.ts` case 6).
 *
 * ORDER — ASCENDING, AND THAT IS THE POINT. Chronological order makes the read card's
 * number stable ACROSS ARRIVALS: sitting on card 3 of 5, a newly-arrived artifact makes
 * it "3 of 6", not "4 of 6". So the indicator changing on an arrival is unambiguously
 * "the deck got deeper", never "you were moved". Descending order would shift every
 * card's number on each arrival — the same class of behind-your-back movement the sticky
 * hero exists to prevent.
 *
 * KNOWN, ACCEPTED CONSEQUENCE — an in-place REWRITE re-sorts. Ordering by mtime means an
 * artifact rewritten in place (the 10×-in-7-minutes agent) becomes the newest and moves
 * to the deck's top, renumbering itself and everything after it, while the user sits
 * still. Verified live: reading "2 of 3", a rewrite of that card made it "5 of 5". This
 * is deliberate, and it is only the LABEL:
 *   - the frame is never reloaded and never flipped, so no comment is ever lost (the
 *     destructive half of the rule is closed elsewhere, and stays closed);
 *   - the new number is HONEST — that artifact genuinely is the freshest card now;
 *   - the user is told, by the "Updated" pill `effectsForRewrites` raises for it;
 *   - repeated rewrites of one card keep it at the top, so it settles rather than jitters.
 * Freezing each card's slot at first-sight would hold the number still, but it would
 * break `deckTop() === heroArtifactFor()` — entering the unit would then land mid-deck
 * instead of on the top card, which is a louder confusion than the renumber. Pinned both
 * ways by `check-artifact-deck.ts` cases 4 and 4d.
 */
export function buildDeck<T extends DeckCard>(
  unitArts: readonly T[],
  activeSource: string | null,
  hasOwnedTab: boolean,
): T[] {
  return scopeToSession(unitArts, activeSource, hasOwnedTab)
    .slice()
    .sort((a, b) => a.modified_ms - b.modified_ms);
}

/** The newest card — the top of the deck, and what a fresh entry leads with. */
export function deckTop<T extends DeckCard>(deck: readonly T[]): T | null {
  return deck.length ? deck[deck.length - 1] : null;
}

/**
 * Locate the read card BY PATH — never by a retained index.
 *
 * board.ts addresses the deck through `digestPath` (what is actually loaded in the
 * frame) rather than storing a current-index, so this is the only translation from
 * "what the user is reading" to "where that sits". A stored index would silently
 * re-point at a different document the moment the deck's contents changed; a path
 * cannot. Returns null when the read card has left the deck (session switched, artifact
 * deleted) — the caller hides the nav rather than guessing a position.
 */
export function deckPosition(deck: readonly DeckCard[], currentPath: string | null): DeckPosition | null {
  if (!currentPath) return null;
  const index = deck.findIndex((c) => c.path === currentPath);
  return index === -1 ? null : { index, total: deck.length };
}

/**
 * The card a prev/next click lands on, or null when the deck ends there.
 *
 * Deliberately does NOT wrap: at the newest card, "next" is nothing. Wrapping would
 * teleport the user from the newest card to the oldest on a click that reads as a small
 * step, and the ends are exactly where the position indicator is most informative.
 */
export function flipTarget<T extends DeckCard>(
  deck: readonly T[],
  currentPath: string | null,
  dir: FlipDir,
): T | null {
  const pos = deckPosition(deck, currentPath);
  if (!pos) return null;
  const next = pos.index + dir;
  return next >= 0 && next < deck.length ? deck[next] : null;
}

/**
 * Is `path` a card of this deck? The gate on flip-adjacent side effects (the advance
 * pill, the position indicator) so they can't act on an artifact that isn't the read
 * session's — the deck and the unread rail stay separate surfaces.
 */
export function deckHas(deck: readonly DeckCard[], path: string | null): boolean {
  return deckPosition(deck, path) !== null;
}
