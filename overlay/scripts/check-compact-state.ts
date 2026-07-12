/**
 * Regression check pinned to the Compact button's dead-feedback bug (2026-07-12).
 *
 * THE REPORT: "you click compact and it works but no way to know if it's actually
 * compacting". Two causes, both pinned here.
 *
 *   1. `runCompact` set "Compacting…" inside a `try` and reset it in a `finally`. The
 *      `finally` ran the instant the KEYSTROKE was sent — not when the compaction
 *      finished — so the label reverted after a few milliseconds of a 40–120 second job.
 *   2. Even without that, `renderUnitMeter` re-derived `disabled` from the tab on every
 *      4s poll, so the next tick would have wiped any in-flight state anyway. That is
 *      why `compactBtn()` is the ONE place the button's state is decided.
 *
 * A third cause was caught in review before it ever shipped, and case 8 is its headstone:
 * the state was originally a SINGLE slot, so typing `/compact` into a second session
 * evicted the first one's watch and its button went quietly back to "Compact" while it was
 * still compacting. Sessions compact concurrently; the state is a map, one entry each.
 *
 * THE SIGNATURE THIS PINS: a poll never clobbers an in-flight compaction (case 2), no
 * session's state can touch another's (cases 4–8), and the button is released only when the
 * TRANSCRIPT says the compaction finished (case 3) — never on a timer, never on optimism.
 *
 *   node --experimental-strip-types scripts/check-compact-state.ts
 */
import {
  abandonCompact,
  beginCompact,
  compactBtn,
  compactEntry,
  resolveCompact,
  COMPACT_DONE_MS,
  COMPACT_WAIT_MS,
  NO_COMPACT,
  type CompactState,
} from "../src/compact-logic.ts";

let failed = 0;
function check(name: string, cond: boolean): void {
  console.log(`${cond ? "  ok  " : "FAIL  "}${name}`);
  if (!cond) failed++;
}

const T0 = 1_783_612_485_400; // any fixed clock; the logic only ever reads differences
const UNIT = "claude-code-companion";
const SESS = "ef654874-aaaa-bbbb-cccc-000000000000";
const TAB = "tab-1";

/** The user has just pressed Compact on a session with 0 prior compactions. */
const TYPED: CompactState = beginCompact(NO_COMPACT, {
  unitKey: UNIT,
  sessionId: SESS,
  baseline: 0,
  startedAt: T0,
});

const view = (
  o: Partial<{ unitKey: string; sessionId: string; tabId: string | null; now: number }> = {},
) => ({ unitKey: UNIT, sessionId: SESS, tabId: TAB as string | null, now: T0, ...o });
const poll = (
  o: Partial<{ unitKey: string; sessionId: string; compactions: number; now: number }> = {},
) => ({ unitKey: UNIT, sessionId: SESS, compactions: 0, now: T0, ...o });

// ---- 1. the click is visible at all -----------------------------------------
check("1. a typed /compact reads as busy", compactBtn(TYPED, view()) === "busy");

// ---- 2. THE BUG: the poll must not take the button back ----------------------
// Four seconds in, the meter polls and the transcript still shows no compaction. The
// old code reset the label here (and on every tick after). It must hold.
const midRun = resolveCompact(TYPED, poll({ now: T0 + 4000 }));
check(
  "2. a poll mid-compaction does NOT clobber the busy state (the reported bug)",
  compactBtn(midRun, view({ now: T0 + 4000 })) === "busy",
);
check(
  "2b. still busy 119s in, the length of a real manual compaction",
  compactBtn(resolveCompact(midRun, poll({ now: T0 + 119_120 })), view({ now: T0 + 119_120 })) ===
    "busy",
);

// ---- 3. released by the TRANSCRIPT, not by a timer ---------------------------
// Claude records a compaction only once it FINISHES. The count ticking 0 -> 1 is the
// only thing that may end the wait.
const landed = resolveCompact(TYPED, poll({ compactions: 1, now: T0 + 42_452 }));
check(
  "3. the compaction count ticking is what ends the wait",
  compactEntry(landed, UNIT, SESS)?.kind === "done",
);
check("3b. and the button says so", compactBtn(landed, view({ now: T0 + 42_452 })) === "done");
check(
  "3c. 'Compacted' does not linger past its beat",
  compactBtn(landed, view({ now: T0 + 42_452 + COMPACT_DONE_MS + 1 })) === "ready",
);
check(
  "3d. and the spent entry is swept, so the map cannot grow without bound",
  compactEntry(
    resolveCompact(landed, poll({ now: T0 + 42_452 + COMPACT_DONE_MS + 1 })),
    UNIT,
    SESS,
  ) === null,
);
// An auto-compact that beats the user's click to it still frees the context, so the
// button has nothing left to wait for. Any new compaction resolves the watch.
check(
  "3e. an auto-compact landing during the wait also resolves it",
  compactEntry(resolveCompact(TYPED, poll({ compactions: 1 })), UNIT, SESS)?.kind === "done",
);

// ---- 4-7. THE SHARED-BUTTON BUG: no bleed across units/sessions --------------
// One button element serves every unit. Unit A is compacting; the user switches to B.
const OTHER = "some-other-repo";
check(
  "4. a compaction in unit A does not paint unit B's button busy",
  compactBtn(TYPED, view({ unitKey: OTHER })) === "ready",
);
check(
  "4b. nor does a finished one bleed its 'Compacted' onto unit B",
  compactBtn(landed, view({ unitKey: OTHER })) === "ready",
);
check(
  "5. a poll of ANOTHER unit cannot resolve unit A's compaction",
  compactEntry(resolveCompact(TYPED, poll({ unitKey: OTHER, compactions: 9 })), UNIT, SESS)
    ?.kind === "watch",
);
// Same trap one level down: a NEW session in the same unit is not the one compacting.
check(
  "6. a different session in the same unit is not the one compacting",
  compactBtn(TYPED, view({ sessionId: "different-session" })) === "ready",
);
check(
  "7. a failed keystroke drops only ITS session's watch",
  compactEntry(abandonCompact(TYPED, OTHER, "other-session"), UNIT, SESS)?.kind === "watch",
);

// ---- 8. THE CONCURRENCY BUG (caught in review, never shipped) ----------------
// Compactions run for MINUTES. Starting one, moving to another session, and compacting
// that too is ordinary. With a single state slot the second `/compact` evicted the first's
// watch — so when the first finished, nothing resolved it and its button had already gone
// quietly back to "Compact" while it was still running.
const BOTH = beginCompact(TYPED, {
  unitKey: OTHER,
  sessionId: "other-session",
  baseline: 3,
  startedAt: T0 + 1000,
});
check(
  "8. compacting a SECOND session does not evict the first's watch",
  compactBtn(BOTH, view()) === "busy",
);
check("8b. and the second session is busy too — both at once", compactBtn(BOTH, view({ unitKey: OTHER, sessionId: "other-session", now: T0 + 1000 })) === "busy");
// The first one finishes. It must still resolve, on its own baseline, to its own button.
const firstDone = resolveCompact(BOTH, poll({ compactions: 1, now: T0 + 42_452 }));
check(
  "8c. the first compaction still resolves after the second was started",
  compactBtn(firstDone, view({ now: T0 + 42_452 })) === "done",
);
check(
  "8d. and resolving the first leaves the second still running",
  compactBtn(firstDone, view({ unitKey: OTHER, sessionId: "other-session", now: T0 + 42_452 })) ===
    "busy",
);
// Each watch keeps its OWN baseline: the second session already had 3 compactions on file,
// so a 4th is its completion — not the 1 that completed the first session's.
check(
  "8e. each session resolves against its own baseline, not a shared one",
  compactBtn(
    resolveCompact(BOTH, {
      unitKey: OTHER,
      sessionId: "other-session",
      compactions: 3,
      now: T0 + 50_000,
    }),
    view({ unitKey: OTHER, sessionId: "other-session", now: T0 + 50_000 }),
  ) === "busy",
);

// ---- 9. a /compact that never runs cannot strand the button ------------------
check(
  "9. an unlanded compaction times out rather than spinning forever",
  compactEntry(resolveCompact(TYPED, poll({ now: T0 + COMPACT_WAIT_MS + 1 })), UNIT, SESS) === null,
);
check(
  "9b. and the timeout reports nothing — it did not compact",
  compactBtn(
    resolveCompact(TYPED, poll({ now: T0 + COMPACT_WAIT_MS + 1 })),
    view({ now: T0 + COMPACT_WAIT_MS + 1 }),
  ) === "ready",
);
// The bound has to outlast a real run: the manual compaction measured on this machine took
// 119s, and a near-full 1M window is worse.
check("9c. the timeout is generous enough to not cut a real run short", COMPACT_WAIT_MS > 119_120);

// ---- 10. the resting states still work ---------------------------------------
check("10. idle with a Board-owned terminal is ready", compactBtn(NO_COMPACT, view()) === "ready");
check(
  "10b. no owned terminal to type into is unavailable",
  compactBtn(NO_COMPACT, view({ tabId: null })) === "unavailable",
);
// Busy outranks it: the state is a fact about the SESSION, not about which terminal the
// Board happens to own. A tab dying mid-run must not silently un-busy the button.
check(
  "10c. a compaction in flight outranks a lost terminal",
  compactBtn(TYPED, view({ tabId: null })) === "busy",
);

console.log(failed ? `\n${failed} check(s) failed` : "\nall checks passed");
process.exit(failed ? 1 : 0);
