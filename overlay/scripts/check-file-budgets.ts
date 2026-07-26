/**
 * File-size and shared-state RATCHETS for the Board.
 *
 * The project's own standard is 200–400 lines typical, 800 max. `board.ts` is currently
 * 5,430 and `board.css` 3,076, and nothing in the repo notices when they grow — there is no
 * ESLint, so `tsc --strict` is the only thing that has ever looked at that file. A monolith
 * does not fail loudly; it just charges ~20% more per change, forever, and the only person
 * paying is the one who wrote it.
 *
 * So this is a ratchet, not a rule. Each budget below is pinned slightly UNDER today's real
 * size, which means:
 *   · growth fails CI immediately, with the reason attached;
 *   · shrinking is free — and when a budget goes slack the check says so, so the number
 *     follows the code down instead of quietly granting headroom back.
 *
 * That is the same trick as `rust-tests.yml`'s grep guard against `std::env::set_var`: turn
 * a docstring nobody re-reads into a mechanism that cannot be forgotten. Lower these numbers
 * as extractions land; never raise one without saying why in the commit.
 *
 *   node --experimental-strip-types scripts/check-file-budgets.ts
 */
import { readFileSync } from "node:fs";
import { readdirSync } from "node:fs";

let failed = 0;
function check(name: string, cond: boolean): void {
  console.log(`${cond ? "  ok  " : "FAIL  "}${name}`);
  if (!cond) failed++;
}

const read = (rel: string) => readFileSync(new URL(`../${rel}`, import.meta.url), "utf8");
const lines = (rel: string) => read(rel).split("\n").length;

/** How much slack before a budget is called stale. Tight enough that a real extraction
 *  trips it, loose enough that a few deleted lines don't nag. */
const SLACK = 120;

/** The default ceiling for anything not explicitly grandfathered. */
const DEFAULT_MAX = 800;

/** Grandfathered files, with the size they must stay under. Each is a debt with a number
 *  on it rather than an unbounded one. */
const BUDGETS: Record<string, number> = {
  // Raised once, deliberately, from 5500: adopting Prettier normalised this file's formatting
  // and cost +76 lines (5,431 → 5,507) in one-time churn, not new code. That is the kind of
  // increase this ratchet is meant to make you justify out loud rather than nudge silently —
  // so it is written down here. It goes DOWN from now on, as extractions land — and it has:
  // 5560 → 5512 as the reader state moved to `src/reader-state.ts`.
  // Raised 5512 → 5525 for the standing-project-digest hero: entering a unit now resolves
  // `home.<unit_key>.html` and leads with it. Saying why out loud, as this header demands:
  // the +13 is the behaviour itself (the resolve, the hero branch, the two staleness
  // guards), and it is what is left AFTER pushing the parts that could leave — the
  // `resolveUnitDigest` probe to `artifact-view.ts` and the deck composition to
  // `withDigest` in `deck-logic.ts`, where it is also finally testable. ~31 lines of the
  // feature landed outside board.ts; only the DOM-coupled remainder stayed.
  // Raised 5525 → 5532 for Prettier, not for code: the file had never been run through the
  // formatter this branch introduced, and `format:check` failed CI on it. Formatting rewrapped
  // one import across 7 more lines — zero new statements — which is the format gate and this
  // gate disagreeing about the same 7 lines. The ratchet is meant to catch code growth, so it
  // yields to the formatter here and keeps its grip on everything else. (`board.css` gets the
  // opposite treatment two lines down — see .prettierignore — because there the formatter
  // wanted 960 lines, which is a formatter making a too-big file bigger.)
  "src/board.ts": 5532,
  // board.css is NOT Prettier-formatted on purpose (see .prettierignore): the formatter grew
  // it by 960 lines expanding dense declarations, which is a formatter making a too-big file
  // measurably worse. So this number reflects hand-formatted CSS and should stay tight.
  "src/board.css": 3150,
};

console.log("### grandfathered budgets (ratchet down, never up)");
for (const [file, max] of Object.entries(BUDGETS)) {
  const n = lines(file);
  check(`${file} is ${n} lines, budget ${max}`, n <= max);
  if (n <= max - SLACK) {
    console.log(
      `  ↓  ${file} is ${max - n} lines under budget — lower it to ~${n + 20} in this commit`,
    );
  }
}

console.log("\n### everything else stays under the project's own 800-line rule");
const srcFiles = readdirSync(new URL("../src", import.meta.url))
  .filter((f) => /\.(ts|css)$/.test(f) && !f.endsWith(".d.ts"))
  .map((f) => `src/${f}`)
  .filter((f) => !(f in BUDGETS));
// Count THIS section's failures, not the global `failed`. Reusing the global made a
// grandfathered budget being over ALSO fail the unrelated "everything else is fine" summary,
// so one real problem reported as two and the summary line was simply lying. A check whose
// condition is "did anything at all go wrong earlier" is not a check.
let oversized = 0;
for (const file of srcFiles) {
  const n = lines(file);
  if (n > DEFAULT_MAX) {
    check(`${file} is ${n} lines (max ${DEFAULT_MAX}) — extract a module`, false);
    oversized++;
  }
}
check(
  `all ${srcFiles.length} ungrandfathered src files are under ${DEFAULT_MAX} lines`,
  oversized === 0,
);

/**
 * SHARED MUTABLE STATE in board.ts — the real liability, of which line count is only a
 * symptom. 66 module-level `let`s means any of ~200 functions can read or write any of them,
 * and every unread/identity/navigation bug this project has shipped was two of those
 * functions disagreeing about one of these. See `check-board-state.ts` for the ledger that
 * was extracted first, and why.
 *
 * The number may only go DOWN. Adding another cross-path global is the change most likely to
 * cost a future debugging session, so it should cost a conversation first.
 */
console.log("\n### board.ts shared mutable state (ratchet down, never up)");
const boardSrc = read("src/board.ts");
const globals = (boardSrc.match(/^let /gm) || []).length;
// 66 → 62: `focusPath`, `digestPath`, `readerStalePath` and `awaitingAdvanceSource` became
// fields of one tested state object (`src/reader-state.ts`).
const GLOBAL_BUDGET = 62;
check(
  `board.ts has ${globals} module-level \`let\`s, budget ${GLOBAL_BUDGET}`,
  globals <= GLOBAL_BUDGET,
);
if (globals < GLOBAL_BUDGET) {
  console.log(
    `  ↓  ${GLOBAL_BUDGET - globals} fewer than budget — lower GLOBAL_BUDGET to ${globals}`,
  );
}

console.log(failed === 0 ? "\nall checks passed" : `\n${failed} check(s) FAILED`);
process.exit(failed === 0 ? 0 : 1);
