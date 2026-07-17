/**
 * Checks pinned to the artifact DECK — the hero's pageable stack.
 *
 * THE REPORT that motivated the deck: a newer artifact replaced the hero's content in
 * the same rectangle with no transition ("you can't even tell that it updates"), and the
 * previous artifact was unreachable. The deck makes every card of the active session's
 * run one flip apart.
 *
 * THE SIGNATURES THESE PIN — the two rules a future refactor is most likely to break:
 *
 *  1. THE DECK NEVER MOVES THE USER. A new artifact makes the deck DEEPER; the read
 *     card keeps its identity AND its number (cases 3–4). This is the pure-logic half of
 *     the sticky-hero rule that the 2026-07-09 comment-loss fix bought: the deck is
 *     addressed by PATH, and ascending order means arrival can't renumber the read card.
 *     A refactor to descending order, or to a retained index, fails case 4.
 *  2. THE DECK IS THE ACTIVE SESSION'S. A sibling's artifact is never a card, so it can
 *     never be flipped onto (cases 5–6) — the deck cannot become the back door into the
 *     sibling-session disappearance bug that `check-sibling-unread.ts` closed.
 *
 *   node --experimental-strip-types scripts/check-artifact-deck.ts
 */
import { readFileSync } from "node:fs";
import { buildDeck, deckTop, deckPosition, flipTarget, deckHas, type DeckCard } from "../src/deck-logic.ts";
import { heroArtifactFor } from "../src/ingest-logic.ts";

let failed = 0;
function check(name: string, cond: boolean): void {
  console.log(`${cond ? "  ok  " : "FAIL  "}${name}`);
  if (!cond) failed++;
}

// One session's run of three artifacts, plus a sibling's, in a shared unit — the
// two-sessions-in-one-repo shape that is normal by design (unit_key = repo basename).
const A_SRC = "claude-code-companion--3f8c1d04";
const B_SRC = "claude-code-companion--ef654874";
const OLD = { path: "/art/observer-latency.html", modified_ms: 1_000, source: A_SRC };
const MID = { path: "/art/board-ui-audit.html", modified_ms: 2_000, source: A_SRC };
const NEW = { path: "/art/shell-slate.html", modified_ms: 3_000, source: A_SRC };
const SIBLING = { path: "/art/siblings-work.html", modified_ms: 9_999, source: B_SRC }; // NEWEST of all
const UNIT: DeckCard[] = [MID, SIBLING, NEW, OLD]; // deliberately unordered on input

// ---- 1. ORDER: chronological, oldest card first ------------------------------
const deck = buildDeck(UNIT, A_SRC, true);
check(
  "1. deck is the active session's artifacts, oldest first",
  deck.map((c) => c.path).join() === [OLD, MID, NEW].map((c) => c.path).join(),
);
check("1b. deck top is the newest card", deckTop(deck)?.path === NEW.path);
check("1c. deckTop of an empty deck → null", deckTop([]) === null);

// ---- 2. ADDRESSING: position is found by path, and reads 1-based at the UI ----
check("2. position of the newest card is 3 of 3", JSON.stringify(deckPosition(deck, NEW.path)) === '{"index":2,"total":3}');
check("2b. position of the oldest card is 1 of 3", deckPosition(deck, OLD.path)?.index === 0);
check("2c. a path outside the deck has no position (nav hides, never guesses)", deckPosition(deck, SIBLING.path) === null);
check("2d. a null path (blank hero) has no position", deckPosition(deck, null) === null);
check("2e. deckHas mirrors position", deckHas(deck, MID.path) && !deckHas(deck, SIBLING.path));

// ---- 3. THE INVARIANT: a new artifact DEEPENS the deck, never moves the reader --
// The user is reading MID. A fourth artifact lands for the same session.
const LATE = { path: "/art/harness-live-ingest.html", modified_ms: 4_000, source: A_SRC };
const deeper = buildDeck([...UNIT, LATE], A_SRC, true);
check("3. the arrival deepened the deck to 4", deeper.length === 4);
check("3b. the read card is still in the deck, same identity", deckHas(deeper, MID.path));

// ---- 4. …AND THE READ CARD KEEPS ITS NUMBER ---------------------------------
// The load-bearing consequence of ascending order. "2 of 3" → "2 of 4": the total grew,
// the position did not move. Under descending order this would read "3 of 4" → "2 of 4"
// for an artifact the user never touched, which is a renumber they didn't ask for.
const before = deckPosition(deck, MID.path)!;
const after = deckPosition(deeper, MID.path)!;
check("4. THE INVARIANT: an arrival leaves the read card's index untouched", before.index === after.index);
check("4b. …and only the total grows (2 of 3 → 2 of 4)", before.total === 3 && after.total === 4);
check("4c. the new card is reachable — it is the deck's new top", deckTop(deeper)?.path === LATE.path);

// ---- 4d. THE LIMIT OF CASE 4, PINNED HONESTLY -------------------------------
// An in-place REWRITE (same path, newer mtime — the 10×-in-7-minutes agent) DOES re-sort
// its own card to the top, because the deck orders by mtime. Verified live in the
// harness: reading "2 of 3", a rewrite of that card made it "5 of 5". Pinned so the
// asymmetry with case 4 is a documented guarantee rather than a surprise: an ARRIVAL
// never renumbers the read card, a REWRITE of it does. Only the label moves — the frame
// is never reloaded (that rule lives in `effectsForRewrites`, which raises the "Updated"
// pill for exactly this). If a future change freezes the deck's order at first-sight,
// this case flips — and case 6's lockstep with the hero is what it would cost.
const rewritten = buildDeck(UNIT.map((c) => (c.path === MID.path ? { ...c, modified_ms: 5_000 } : c)), A_SRC, true);
check("4d. an in-place rewrite re-sorts its own card to the deck's top (accepted)", deckTop(rewritten)?.path === MID.path);
check("4e. …and the rewrite does not reload: it is the label that moved, not the frame", deckPosition(rewritten, MID.path)?.index === 2);

// ---- 5. SCOPE: a sibling's artifact is never a card, however new --------------
check("5. the sibling's NEWEST artifact is not in A's deck", !deck.some((c) => c.path === SIBLING.path));
check("5b. …so it can never be flipped onto from the newest card", flipTarget(deck, NEW.path, 1) === null);
check("5c. picking session B decks B's own artifact only", buildDeck(UNIT, B_SRC, true).map((c) => c.path).join() === SIBLING.path);
check("5d. a fresh session (owned tab, no source yet) → empty deck, not a sibling's", buildDeck(UNIT, null, true).length === 0);
check("5e. no owned tab and no source (cloud/closed) → the whole unit decks", buildDeck(UNIT, null, false).length === 4);

// ---- 6. LOCKSTEP WITH THE HERO ----------------------------------------------
// The deck's top and the hero's pick must be the same artifact, or entering a unit would
// land on a card the deck says isn't the top. Shared `scopeToSession` is what makes this
// hold; this case is what catches a future re-derivation of either filter.
for (const [name, src, owned] of [
  ["active session", A_SRC, true],
  ["sibling session", B_SRC, true],
  ["fresh session", null, true],
  ["no session", null, false],
] as const) {
  check(
    `6. deck top === hero pick (${name})`,
    (deckTop(buildDeck(UNIT, src, owned))?.path ?? null) === (heroArtifactFor(UNIT, src, owned)?.path ?? null),
  );
}

// ---- 7. FLIP ARITHMETIC: steps, and hard ends (no wrap) ----------------------
check("7. next from the oldest → the middle card", flipTarget(deck, OLD.path, 1)?.path === MID.path);
check("7b. prev from the middle → the oldest card", flipTarget(deck, MID.path, -1)?.path === OLD.path);
check("7c. prev from the oldest → null (no wrap to the newest)", flipTarget(deck, OLD.path, -1) === null);
check("7d. next from the newest → null (no wrap to the oldest)", flipTarget(deck, NEW.path, 1) === null);
check("7e. flipping from a path outside the deck → null", flipTarget(deck, SIBLING.path, 1) === null);
check("7f. flipping a single-card deck → null both ways", flipTarget([NEW], NEW.path, 1) === null && flipTarget([NEW], NEW.path, -1) === null);

// ---- 8. STRUCTURAL: the poll must never flip the deck ------------------------
// Cases 3–4 prove the deck's LOGIC can't move the reader. This pins the other half —
// that board.ts doesn't call the flip from an ingest path anyway. `flipDeck` is
// DOM-coupled, so guard the source directly: the ingest/poll functions may deepen the
// deck and offer a pill, but must not invoke the flip.
const boardSrc = readFileSync(new URL("../src/board.ts", import.meta.url), "utf8");
const fnBody = (name: string): string => {
  const at = boardSrc.indexOf(`function ${name}(`);
  if (at === -1) return "";
  const end = boardSrc.indexOf("\nfunction ", at + 1);
  return boardSrc.slice(at, end === -1 ? undefined : end);
};
for (const fn of ["ingestArtifacts", "ingestIntoUnit", "maybeLightBlankHero"]) {
  const body = fnBody(fn);
  check(`8. ${fn}() body was located (guard is live, not vacuous)`, body.length > 0);
  check(`8b. ${fn} never flips the deck (the flip is the user's click)`, !/\bflipDeck\s*\(/.test(body));
}

console.log(failed === 0 ? "\nall checks passed" : `\n${failed} check(s) FAILED`);
process.exit(failed === 0 ? 0 : 1);
