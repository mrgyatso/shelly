/**
 * Checks pinned to the Board's extracted state: the UNREAD LEDGER (`src/unread-store.ts`,
 * cases 1–7) and the READER STATE (`src/reader-state.ts`, cases 8–14).
 *
 * WHY THESE EXIST. Unread was a bare `Map<string, Set<string>>` living in board.ts, mutated
 * at seven sites across 5,400 lines, with the one invariant that keeps the 🔔 count honest —
 * *drop the unit key the moment its set empties* — hand-written at four of them. board.ts
 * mounts the Tauri webview at import, so no test could ever reach that state: `tsc --noEmit`
 * was the only thing that looked at it. Every unread bug this project has shipped lived in
 * that blind spot, and each one was found by a user rather than by CI.
 *
 * THE THREE REGRESSIONS THESE PIN — every one a bug that actually shipped:
 *
 *  1. THE BADGE THAT NEVER RESET. Artifacts were counted per ARTIFACT but retired per PATH,
 *     so a unit whose set drained kept its key and the global total never reached zero.
 *     Case 2 fails if `prune` is ever skipped on a removal path.
 *  2. THE SIBLING SESSION THAT VANISHED. A unit holds EVERY session's artifacts, so a
 *     blanket clear-on-entry wiped a sibling's queued work. Case 3 pins that marking one
 *     artifact read is surgical, and case 6 pins that the blunt clear is opt-in.
 *  3. THE DOT THAT LINGERED AFTER RE-ROUTING. When the routing index landed and moved an
 *     artifact to its real unit, the old bucket kept it. Case 4 makes that state
 *     unrepresentable rather than merely corrected: `add` is exclusive.
 *
 *   node --experimental-strip-types scripts/check-board-state.ts
 */
import { readFileSync } from "node:fs";
import * as R from "../src/reader-state.ts";
import * as U from "../src/unread-store.ts";

let failed = 0;
function check(name: string, cond: boolean): void {
  console.log(`${cond ? "  ok  " : "FAIL  "}${name}`);
  if (!cond) failed++;
}

// The shape that is normal by design: two sessions in one repo share a unit_key.
const REPO = "claude-code-companion";
const OTHER = "job-applier-bot";
const A1 = "/art/audit.html";
const A2 = "/art/verdict.html";
const B1 = "/art/applier-status.html";

// ---- 1. basic accounting -----------------------------------------------------
{
  const s = U.createUnreadState();
  U.add(s, REPO, A1);
  U.add(s, REPO, A2);
  U.add(s, OTHER, B1);
  check("1. count is per unit", U.count(s, REPO) === 2 && U.count(s, OTHER) === 1);
  check("1b. total sums across units", U.total(s) === 3);
  check(
    "1c. adding the same path twice is idempotent",
    (U.add(s, REPO, A1), U.count(s, REPO) === 2),
  );
  check("1d. an unknown unit counts zero, not undefined", U.count(s, "never-seen") === 0);
}

// ---- 2. THE BADGE THAT NEVER RESET -------------------------------------------
// A drained unit must stop existing, or `unitsWithUnread`/the 🔔 dropdown keep a stale row
// and the global count floors above zero forever.
{
  const s = U.createUnreadState();
  U.add(s, REPO, A1);
  U.markRead(s, A1);
  check("2. draining a unit removes its key entirely", s.byUnit.has(REPO) === false);
  check("2b. total returns to exactly zero", U.total(s) === 0);
  check("2c. no stale row survives in the dropdown", U.unitsWithUnread(s).length === 0);

  // …by every removal route, not just markRead. This is the point of funnelling them.
  const viaRetain = U.createUnreadState();
  U.add(viaRetain, REPO, A1);
  U.retainPaths(viaRetain, new Set()); // the artifact was deleted from disk
  check("2d. retainPaths also prunes the emptied unit", viaRetain.byUnit.has(REPO) === false);

  const viaDrop = U.createUnreadState();
  U.add(viaDrop, REPO, A1);
  U.drop(viaDrop, [A1]);
  check("2e. drop() also prunes the emptied unit", viaDrop.byUnit.has(REPO) === false);
}

// ---- 3. THE SIBLING SESSION THAT VANISHED ------------------------------------
// Reading one artifact must not clear its unit. Two sessions share the bucket, so a
// blanket clear here is how a sibling's work disappeared without a trace.
{
  const s = U.createUnreadState();
  U.add(s, REPO, A1);
  U.add(s, REPO, A2);
  U.markRead(s, A1);
  check("3. marking one artifact read leaves the sibling's queued", U.count(s, REPO) === 1);
  check("3b. …and it is the OTHER path that survives", U.pathsIn(s, REPO)[0] === A2);
  check(
    "3c. markRead reports whether anything was actually unread",
    U.markRead(s, "/art/nope.html") === false,
  );
}

// ---- 4. THE DOT THAT LINGERED AFTER RE-ROUTING -------------------------------
// The routing index lands a poll or two after first sight and can move an artifact to its
// real unit. `add` is EXCLUSIVE, so re-filing is sufficient — being unread in two units is
// now impossible to represent, not merely tidied up afterwards.
{
  const s = U.createUnreadState();
  U.add(s, "UNSOURCED", A1); // first ingest, before the index landed
  U.add(s, REPO, A1); // re-routed to its real unit
  check("4. a re-filed path leaves its old unit", s.byUnit.has("UNSOURCED") === false);
  check("4b. …and is unread in exactly one place", U.total(s) === 1 && U.count(s, REPO) === 1);
  check("4c. allPaths() cannot double-count it", U.allPaths(s).size === 1);
}

// ---- 5. derived views stay consistent with the ledger ------------------------
{
  const s = U.createUnreadState();
  U.add(s, REPO, A1);
  U.add(s, REPO, A2);
  U.add(s, OTHER, B1);
  const counts = U.countsByUnit(s);
  check("5. countsByUnit matches count() per unit", counts[REPO] === 2 && counts[OTHER] === 1);
  check(
    "5b. countsByUnit sums to total",
    Object.values(counts).reduce((a, b) => a + b, 0) === U.total(s),
  );
  check("5c. allPaths is the flattened union", U.allPaths(s).size === 3);
  const rows = U.unitsWithUnread(s).sort((a, b) => b.n - a.n);
  check(
    "5d. unitsWithUnread reports both units, biggest first",
    rows.length === 2 && rows[0].unit === REPO,
  );
  // retainPaths must prune per-unit, not wholesale — one unit's artifact vanishing cannot
  // take another unit's with it.
  U.retainPaths(s, new Set([A2, B1]));
  check(
    "5e. retainPaths drops only the missing path",
    U.count(s, REPO) === 1 && U.count(s, OTHER) === 1,
  );
}

// ---- 6. the blunt clear is opt-in, and only that -----------------------------
{
  const s = U.createUnreadState();
  U.add(s, REPO, A1);
  U.add(s, OTHER, B1);
  U.clearUnit(s, REPO);
  check("6. clearUnit empties exactly one unit", U.count(s, REPO) === 0 && U.count(s, OTHER) === 1);
  check("6b. …and removes its key", s.byUnit.has(REPO) === false);
}

// ---- 7. board.ts must go THROUGH the store ----------------------------------
// A future edit that reaches back into the raw map reopens the blind spot these tests
// exist to close, and would do it silently: everything above would still pass.
{
  const boardSrc = readFileSync(new URL("../src/board.ts", import.meta.url), "utf8");
  check("7. board.ts holds no bare unreadByUnit map any more", !/\bunreadByUnit\b/.test(boardSrc));
  check(
    "7b. board.ts owns the state object",
    /const unreadState = unread\.createUnreadState\(\)/.test(boardSrc),
  );
  check(
    "7c. board.ts never mutates the ledger's internals directly",
    !/unreadState\.byUnit\s*\.\s*(set|delete|clear)/.test(boardSrc),
  );
  // The store is the only place `prune` is written. If a second copy of that invariant
  // appears in board.ts, the four-sites-disagreeing bug class is back.
  check(
    "7d. the 'delete the key when empty' invariant lives only in the store",
    (boardSrc.match(/size === 0\).*delete/g) || []).length === 0,
  );
}

// =============================================================================
// Checks pinned to the READER STATE (`src/reader-state.ts`) — what the user is
// reading, and what they are waiting for.
//
// Same blind spot, five more bindings: `focusPath`, `digestPath`, `readerStalePath`,
// `readerBackStack`, `awaitingAdvanceSource` and the `submittedArtifacts` map were
// assigned at ~30 sites in board.ts, with three rules hand-copied between them. Cases
// 10–12 pin those three rules; 13–15 pin the derived reads that were written longhand
// more than once.
// =============================================================================

const CARD_A = "/art/plan.html";
const CARD_B = "/art/review.html";
const CARD_C = "/art/next.html";
const SESSION = "claude-code-companion--e5dee8f4";

// ---- 8. the two pointers, and which one wins ---------------------------------
{
  const s = R.createReaderState();
  check("8. nothing open reads as null, not undefined", R.openPath(s) === null);
  R.setHero(s, CARD_A);
  check("8b. with only a hero, the hero is what's open", R.openPath(s) === CARD_A);
  R.open(s, CARD_B);
  check("8c. THE PRECEDENCE: the reader sits on top, so it wins", R.openPath(s) === CARD_B);
  check("8d. …and the hero pointer is untouched underneath", s.digestPath === CARD_A);
  R.close(s);
  check("8e. closing the reader falls back to the hero", R.openPath(s) === CARD_A);
  check("8f. isOnScreen covers BOTH slots", R.isOnScreen(s, CARD_A) && !R.isOnScreen(s, CARD_C));
}

// ---- 9. the back-trail -------------------------------------------------------
{
  const s = R.createReaderState();
  R.open(s, CARD_A);
  check("9. the first open leaves nothing behind it", s.backStack.length === 0);
  R.advance(s, CARD_B);
  R.advance(s, CARD_C);
  check("9b. advancing keeps a trail", s.backStack.length === 2);
  check("9c. back returns where it went", R.back(s) === CARD_B && s.focusPath === CARD_B);
  check("9d. …and again", R.back(s) === CARD_A);
  check("9e. back on an empty trail is null, and changes nothing", R.back(s) === null);
  check("9f. …leaving the reader where it was", s.focusPath === CARD_A);
}

// ---- 10. RULE: closing the reader drops the trail with it --------------------
// Otherwise "← Back" in a LATER reader session walks into an artifact the user already
// finished with — a jump to a document they never navigated to in this session.
{
  const s = R.createReaderState();
  R.open(s, CARD_A);
  R.advance(s, CARD_B);
  R.close(s);
  check("10. closing empties the trail", s.backStack.length === 0);
  R.open(s, CARD_C);
  check("10b. …so Back in the next reader session has nowhere to go", R.back(s) === null);
}

// ---- 11. RULE: any reader load shows current content, so nothing is stale ----
// The "↻ Updated" offer is an OFFER over the artifact that is open. Leaving it set across
// a navigation puts the button over content that was just loaded fresh.
{
  const s = R.createReaderState();
  R.open(s, CARD_A);
  R.markStale(s, CARD_A);
  check("11. a rewrite under the reader raises the offer", R.isStale(s, CARD_A));
  check("11b. …only for the path it concerns", !R.isStale(s, CARD_B));
  R.advance(s, CARD_B);
  check("11c. advancing clears it — that load was current", s.stalePath === null);
  R.markStale(s, CARD_B);
  R.back(s);
  check("11d. going back clears it too", s.stalePath === null);
  R.markStale(s, CARD_A);
  check("11e. takeStale hands it over once…", R.takeStale(s) === CARD_A);
  check("11f. …and cannot be taken twice", R.takeStale(s) === null);
  R.markStale(s, CARD_A);
  R.close(s);
  check("11g. closing clears it", s.stalePath === null);
}

// ---- 12. RULE: manual navigation cancels a pending auto-advance --------------
// THE ASYMMETRY THIS FIXES. The three reader nav sites each disarmed by hand; the two
// HERO nav sites (deck chevron, "new artifact" pill) did not — so after a hero submit,
// flipping back to re-read an older card and then having the agent write meant being
// yanked off the card you deliberately went to. board.ts already states the principle at
// the splash-dismissed handler ("they're back on the prior artifact, not waiting"); a
// deck flip is that same act by another route.
{
  const s = R.createReaderState();
  R.setHero(s, CARD_A);
  R.arm(s, SESSION);
  check("12. a submit arms the advance", R.isArmed(s) && R.armedSource(s) === SESSION);
  R.navigateHero(s, CARD_B);
  check("12. THE HERO NOW DISARMS ON A MANUAL FLIP", !R.isArmed(s));

  // …and the reader paths keep the behaviour they already had.
  for (const [name, act] of [
    ["open", (t: R.ReaderState) => R.open(t, CARD_C)],
    ["advance", (t: R.ReaderState) => R.advance(t, CARD_C)],
    ["back", (t: R.ReaderState) => R.back(t)],
    ["close", (t: R.ReaderState) => R.close(t)],
  ] as const) {
    const t = R.createReaderState();
    R.open(t, CARD_A);
    R.advance(t, CARD_B); // gives `back` somewhere to go
    R.arm(t, SESSION);
    act(t);
    check(`12b. reader ${name}() disarms`, !R.isArmed(t));
  }

  // Rendering is NOT navigation: an arm must survive the re-render that paints its own
  // waiting scene, or the artifact it is waiting for arrives to a disarmed board.
  const r = R.createReaderState();
  R.arm(r, SESSION);
  R.setHero(r, CARD_A);
  check("12c. …but a plain hero RE-RENDER does not disarm", R.isArmed(r));
  R.setHero(r, null);
  check("12d. …nor does blanking the hero", R.isArmed(r));

  // Arming from a lookup that found nothing is simply not armed — callers pass the
  // result straight through, so this must not represent "armed for null".
  const z = R.createReaderState();
  R.arm(z, null);
  check("12e. arming with no source is not armed", !R.isArmed(z) && R.armedSource(z) === null);
}

// ---- 13. the answered-card rule, in one place -------------------------------
// Written out longhand in BOTH iframe load handlers as stamp/lookup/compare. The two
// could drift, and only one of them was reachable in any given view.
{
  const s = R.createReaderState();
  check("13. an unanswered card shows no overlay", !R.wasSubmitted(s, CARD_A, 1000));
  R.noteSubmitted(s, CARD_A, 1000);
  check("13b. an answered card re-shows it", R.wasSubmitted(s, CARD_A, 1000));
  check(
    "13c. a REWRITE re-arms the card — fresh content is fresh work",
    !R.wasSubmitted(s, CARD_A, 2000),
  );
  check(
    "13d. an unknown mtime trusts the stamp (archived, or the poll is behind)",
    R.wasSubmitted(s, CARD_A, undefined),
  );
  check(
    "13e. a mtime of 0 is not 'unknown' — it must still compare",
    !R.wasSubmitted(s, CARD_A, 0),
  );
  R.retainSubmitted(s, new Set([CARD_B]));
  check("13f. retainSubmitted forgets what is gone from disk", s.submitted.size === 0);
}

// ---- 14. board.ts must go THROUGH the module -------------------------------
// The value here is not the module existing; it is that no site assigns these fields
// directly. One that does re-opens the "three rules, hand-copied" bug class silently.
{
  const boardSrc = readFileSync(new URL("../src/board.ts", import.meta.url), "utf8");
  check(
    "14. board.ts holds no bare reader bindings any more",
    !/\blet (focusPath|digestPath|readerStalePath|awaitingAdvanceSource)\b/.test(boardSrc),
  );
  check(
    "14b. board.ts owns the state object",
    /const readerState = reader\.createReaderState\(\)/.test(boardSrc),
  );
  check(
    "14c. no site assigns a reader-state field directly",
    !/readerState\.(focusPath|digestPath|stalePath|awaitingSource)\s*=[^=]/.test(boardSrc),
  );
  check(
    "14d. …nor mutates the trail or the stamps by hand",
    !/readerState\.(backStack\s*\.\s*(push|pop)|backStack\.length\s*=|submitted\s*\.\s*(set|delete|clear))/.test(
      boardSrc,
    ),
  );
  // The precedence and the answered-card rule each live in the module now. A second copy
  // in board.ts is the drift these tests exist to catch.
  check(
    "14e. the focus-over-hero precedence is not re-derived in board.ts",
    !/focusPath\s*\?\?\s*readerState\.digestPath/.test(boardSrc),
  );
  check(
    "14f. the answered-card comparison is not re-derived in board.ts",
    !/submitted\.get\(/.test(boardSrc),
  );
}

console.log(failed === 0 ? "\nall checks passed" : `\n${failed} check(s) FAILED`);
process.exit(failed === 0 ? 0 : 1);
