/**
 * Regression check pinned to the stuck-tap updater bug (2026-07-15).
 *
 * THE REPORT: "it says 0.9 is ready. I click update, the app restarts, still shows 0.8.1.
 * updater not working?" The updater WAS working — it ran `brew upgrade`. But the Homebrew
 * tap still served 0.8.1 (its cask-bump CI 403'd), so the upgrade was a no-op and the app
 * relaunched unchanged while GitHub still reported 0.9.0 available. To the user that is
 * indistinguishable from a dead button.
 *
 * `classifyUpdate` turns that silence into a message: it compares the version we clicked
 * from against the version we relaunched on. Same version + still behind + recent click =
 * the upgrade didn't take → show a "the download source is stale, not your machine"
 * warning instead of blithely re-offering the same update.
 *
 * THE SIGNATURE THIS PINS: a genuine success clears the marker (never nags), a real no-op
 * inside the window reads as stale, and a marker that outlives its window or points at a
 * future clock is dropped rather than trusted.
 *
 *   node --experimental-strip-types scripts/check-update-stale.ts
 */
import {
  classifyUpdate,
  STALE_WINDOW_MS,
  type UpdateAttempt,
} from "../src/update-stale.ts";

let failed = 0;
function check(name: string, cond: boolean): void {
  console.log(`${cond ? "  ok  " : "FAIL  "}${name}`);
  if (!cond) failed++;
}

const T0 = 1_784_000_000_000; // any fixed clock; the logic only reads differences
const CLICK: UpdateAttempt = { from: "0.8.1", at: T0 };

// 1. No marker → nothing pending, nothing to clear. The overwhelming common case.
check(
  "no pending attempt is inert",
  JSON.stringify(classifyUpdate({ app: "0.8.1", behind: true }, null, T0)) ===
    JSON.stringify({ stale: false, clearMarker: false }),
);

// 2. Relaunched on the SAME version, still behind, moments later → the update no-op'd.
{
  const v = classifyUpdate({ app: "0.8.1", behind: true }, CLICK, T0 + 5_000);
  check("same version + still behind + recent → stale", v.stale && !v.clearMarker);
}

// 3. Version advanced → the update took. Clear the marker, no warning.
{
  const v = classifyUpdate({ app: "0.9.0", behind: false }, CLICK, T0 + 5_000);
  check("version advanced → cleared, not stale", !v.stale && v.clearMarker);
}

// 4. A version can advance yet still be behind (0.8.1 → 0.9.0 while 0.10.0 exists). The
//    upgrade plainly took (the version moved), so this is NOT the stuck-tap signature.
{
  const v = classifyUpdate({ app: "0.9.0", behind: true }, CLICK, T0 + 5_000);
  check("version moved but still behind → cleared, not stale", !v.stale && v.clearMarker);
}

// 5. Same version but no longer behind (GitHub now unreachable, or the release was pulled)
//    → don't cry stale over a state we can't stand behind. Clear it.
{
  const v = classifyUpdate({ app: "0.8.1", behind: false }, CLICK, T0 + 5_000);
  check("same version but not behind → cleared, not stale", !v.stale && v.clearMarker);
}

// 6. The click was long ago → a still-behind app is just an un-taken update, not a fresh
//    failure. Drop the marker so it stops nagging across days of an always-open daemon.
{
  const v = classifyUpdate(
    { app: "0.8.1", behind: true },
    CLICK,
    T0 + STALE_WINDOW_MS + 1,
  );
  check("stale marker past the window → cleared, not stale", !v.stale && v.clearMarker);
}

// 7. Exactly at the window boundary is already expired (strict `<`).
{
  const v = classifyUpdate({ app: "0.8.1", behind: true }, CLICK, T0 + STALE_WINDOW_MS);
  check("window boundary is expired → cleared", !v.stale && v.clearMarker);
}

// 8. One millisecond inside the window still counts as a fresh failure.
{
  const v = classifyUpdate(
    { app: "0.8.1", behind: true },
    CLICK,
    T0 + STALE_WINDOW_MS - 1,
  );
  check("just inside the window → stale", v.stale && !v.clearMarker);
}

// 9. A backwards clock (marker timestamped in the "future") is untrustworthy → treat as
//    out-of-window and clear, never as a live failure.
{
  const v = classifyUpdate({ app: "0.8.1", behind: true }, CLICK, T0 - 1);
  check("future-dated marker (clock skew) → cleared, not stale", !v.stale && v.clearMarker);
}

console.log(failed === 0 ? "\nall update-stale checks passed" : `\n${failed} FAILED`);
process.exit(failed === 0 ? 0 : 1);
