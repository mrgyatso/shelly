/**
 * Regression check pinned to the rewrite-to-displayed-hero bug (2026-06-30).
 *
 * Pure-logic test of the ingest gate's reload + identity-retain decisions — no
 * DOM, no Tauri — so it runs with `node --experimental-strip-types` (Node >= 22.6),
 * matching the repo's standalone-script convention (no test framework installed).
 *
 *   npm test                                              # from overlay/
 *   node --experimental-strip-types scripts/check-ingest-rewrite.ts
 *
 * THE SIGNATURE THIS PINS: overwriting the artifact already on the hero must emit a
 * reload, never a silent no-op. If a future refactor reintroduces the bug (all roads
 * keyed on path-novelty/difference), case 1 fails.
 */
import { rewritesOnScreen, effectsForRewrites } from "../src/ingest-logic.ts";

let failed = 0;
function check(name: string, cond: boolean): void {
  console.log(`${cond ? "  ok  " : "FAIL  "}${name}`);
  if (!cond) failed++;
}
const eq = (a: unknown, b: unknown): boolean => JSON.stringify(a) === JSON.stringify(b);

// ---- rewritesOnScreen — THE canonical signature ----------------------------
const P = "/art/ac-condensate-pump-shopping-list.html";

check(
  "1. rewrite of the on-screen hero is detected (the reported bug)",
  eq(
    rewritesOnScreen(new Map([[P, 1000]]), [{ path: P, modified_ms: 2000 }], {
      digestPath: P,
      focusPath: null,
    }),
    [{ path: P, target: "hero" }],
  ),
);

check(
  "2. rewrite of the artifact open in the reader targets the reader (reader wins)",
  eq(
    rewritesOnScreen(new Map([[P, 1000]]), [{ path: P, modified_ms: 2000 }], {
      digestPath: P,
      focusPath: P,
    }),
    [{ path: P, target: "reader" }],
  ),
);

check(
  "3. brand-new artifact is left to the routing roads (not a content refresh)",
  eq(
    rewritesOnScreen(new Map(), [{ path: P, modified_ms: 2000 }], {
      digestPath: null,
      focusPath: null,
    }),
    [],
  ),
);

check(
  "4. unchanged artifact does not reload (idempotent poll)",
  eq(
    rewritesOnScreen(new Map([[P, 2000]]), [{ path: P, modified_ms: 2000 }], {
      digestPath: P,
      focusPath: null,
    }),
    [],
  ),
);

check(
  "5. rewrite of an OFF-screen artifact does not reload",
  eq(
    rewritesOnScreen(new Map([[P, 1000]]), [{ path: P, modified_ms: 2000 }], {
      digestPath: "/art/other.html",
      focusPath: null,
    }),
    [],
  ),
);

// ---- the two rules, which are NOT the same rule ------------------------------
// NEVER RELOAD (2026-07-09): an agent re-authored one artifact 10× in 7 minutes;
// every rewrite reloaded the frame showing it and destroyed the comments the user
// had typed in. Enforced in board.ts — nothing here returns a reload.
//
// NEVER GO SILENT (2026-07-11): that fix over-corrected. A rewrite under the OPEN
// READER was deferred *and unmentioned*, so an agent could replace what the user
// was reading and the user would never know — observed live, with the user
// answering a recommendation that had already been superseded twice. A rewritten
// reader must therefore be REPORTED (case 7); board.ts turns that into a "↻
// Updated · Refresh" button, never an automatic reload.

check(
  "6. a rewritten hero is offered the advance pill, never reloaded",
  eq(
    effectsForRewrites(new Map([[P, 1000]]), [{ path: P, modified_ms: 2000 }], {
      digestPath: P,
      focusPath: null,
    }),
    [{ path: P, affordance: "hero-pill" }],
  ),
);

check(
  "7. THE SILENCE BUG: a rewrite under the OPEN READER offers a refresh, and is NOT swallowed",
  eq(
    effectsForRewrites(new Map([[P, 1000]]), [{ path: P, modified_ms: 2000 }], {
      digestPath: P,
      focusPath: P,
    }),
    [{ path: P, affordance: "reader-refresh" }],
  ),
);

check(
  "8. hero rewritten while the reader shows a DIFFERENT artifact → pill on the hero",
  eq(
    effectsForRewrites(new Map([[P, 1000]]), [{ path: P, modified_ms: 2000 }], {
      digestPath: P,
      focusPath: "/art/other.html",
    }),
    [{ path: P, affordance: "hero-pill" }],
  ),
);

// The regression this file exists for, stated as a property rather than an example:
// EVERY on-screen rewrite must hand the user something to act on. The old bug was a
// reader rewrite mapping to "defer" — an effect the user could never see or reach.
check(
  "9. no on-screen rewrite is ever dropped on the floor (hero AND reader both offered)",
  eq(
    (["hero", "reader"] as const).map(
      (surface) =>
        effectsForRewrites(new Map([[P, 1000]]), [{ path: P, modified_ms: 2000 }], {
          digestPath: P,
          focusPath: surface === "reader" ? P : null,
        })[0]?.affordance ?? "DROPPED",
    ),
    ["hero-pill", "reader-refresh"],
  ),
);

// (retainedIdentity checks removed with the function at the Phase 4 cutover — the
// staleness guard that caused the identity flap is gone from history.rs.)

console.log(failed === 0 ? "\nPASS — ingest gate holds" : `\n${failed} check(s) FAILED`);
process.exit(failed === 0 ? 0 : 1);
