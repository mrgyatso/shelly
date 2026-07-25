/**
 * Checks pinned to the Board's UNREAD LEDGER (`src/unread-store.ts`).
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
  check("1c. adding the same path twice is idempotent", (U.add(s, REPO, A1), U.count(s, REPO) === 2));
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
  check("3c. markRead reports whether anything was actually unread", U.markRead(s, "/art/nope.html") === false);
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
  check("5b. countsByUnit sums to total", Object.values(counts).reduce((a, b) => a + b, 0) === U.total(s));
  check("5c. allPaths is the flattened union", U.allPaths(s).size === 3);
  const rows = U.unitsWithUnread(s).sort((a, b) => b.n - a.n);
  check("5d. unitsWithUnread reports both units, biggest first", rows.length === 2 && rows[0].unit === REPO);
  // retainPaths must prune per-unit, not wholesale — one unit's artifact vanishing cannot
  // take another unit's with it.
  U.retainPaths(s, new Set([A2, B1]));
  check("5e. retainPaths drops only the missing path", U.count(s, REPO) === 1 && U.count(s, OTHER) === 1);
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
  check("7b. board.ts owns the state object", /const unreadState = unread\.createUnreadState\(\)/.test(boardSrc));
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

console.log(failed === 0 ? "\nall checks passed" : `\n${failed} check(s) FAILED`);
process.exit(failed === 0 ? 0 : 1);
