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
  "src/board.ts": 5500,
  "src/board.css": 3150,
};

console.log("### grandfathered budgets (ratchet down, never up)");
for (const [file, max] of Object.entries(BUDGETS)) {
  const n = lines(file);
  check(`${file} is ${n} lines, budget ${max}`, n <= max);
  if (n <= max - SLACK) {
    console.log(`  ↓  ${file} is ${max - n} lines under budget — lower it to ~${n + 20} in this commit`);
  }
}

console.log("\n### everything else stays under the project's own 800-line rule");
const srcFiles = readdirSync(new URL("../src", import.meta.url))
  .filter((f) => /\.(ts|css)$/.test(f) && !f.endsWith(".d.ts"))
  .map((f) => `src/${f}`)
  .filter((f) => !(f in BUDGETS));
for (const file of srcFiles) {
  const n = lines(file);
  if (n > DEFAULT_MAX) check(`${file} is ${n} lines (max ${DEFAULT_MAX}) — extract a module`, false);
}
check(`all ${srcFiles.length} ungrandfathered src files are under ${DEFAULT_MAX} lines`, failed === 0);

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
const GLOBAL_BUDGET = 66;
check(`board.ts has ${globals} module-level \`let\`s, budget ${GLOBAL_BUDGET}`, globals <= GLOBAL_BUDGET);
if (globals < GLOBAL_BUDGET) {
  console.log(`  ↓  ${GLOBAL_BUDGET - globals} fewer than budget — lower GLOBAL_BUDGET to ${globals}`);
}

console.log(failed === 0 ? "\nall checks passed" : `\n${failed} check(s) FAILED`);
process.exit(failed === 0 ? 0 : 1);
