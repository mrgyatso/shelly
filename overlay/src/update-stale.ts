//! update-stale.ts — "the button ran, and nothing changed. Why?"
//!
//! The Update button runs `brew upgrade` (macOS) / a `.deb` swap (Linux), which is a
//! **no-op when the tap or package repo hasn't published the new version yet** — the
//! exact shape of the stuck-cask bug where GitHub has 0.9.0 but the Homebrew tap still
//! serves 0.8.1. The app then quits and relaunches on the SAME version while
//! `update_status` still reports a newer release. To the user that is indistinguishable
//! from "the button did nothing" — the most confusing possible outcome, because the app
//! silently insists an update is available right after it "updated".
//!
//! This turns that silence into a message. On click we record what version we were on;
//! after the relaunch we compare. Same version + still behind + recent click = the
//! upgrade didn't take, and the honest thing to say is "the download source is stale —
//! not your machine". The logic is pure and clock-injected so it can be pinned by a test.

/** How long after an Update click we still treat "still behind" as a *failed update*
 *  rather than an unrelated new release. Past this, a lingering marker is stale intent,
 *  not evidence the last click failed — so we drop it instead of nagging forever. */
export const STALE_WINDOW_MS = 30 * 60 * 1000; // 30 minutes

/** Written the instant Update is clicked, read back after the app relaunches.
 *  `from` is the app version at click time; `at` is the click timestamp (ms). */
export type UpdateAttempt = { from: string; at: number };

/** The slice of the update status the classifier needs: what we're running now, and
 *  whether GitHub still reports something newer. */
export type UpdateSnapshot = { app: string; behind: boolean };

/** What `syncUpdate` should do with a pending attempt marker.
 *   - `stale`      → the last update didn't take; show the "source is stale" warning.
 *   - `clearMarker`→ the marker has done its job (the update took, we're no longer
 *                    behind, or the window elapsed); delete it so it can't mislead later. */
export type UpdateVerdict = { stale: boolean; clearMarker: boolean };

/** Decide, purely, whether a just-attempted update silently failed.
 *
 *  `attempt === null` means nothing is pending — the common case, nothing to do. Any
 *  outcome that resolves the marker (success, no-longer-behind, or an elapsed window)
 *  asks the caller to clear it; only a same-version-still-behind-and-recent state is
 *  reported as `stale`. A future-dated marker (a clock that jumped back) counts as
 *  outside the window, so it is cleared rather than trusted. */
export function classifyUpdate(
  status: UpdateSnapshot,
  attempt: UpdateAttempt | null,
  now: number,
): UpdateVerdict {
  if (!attempt) return { stale: false, clearMarker: false };

  // The version moved, or GitHub no longer reports anything newer → the update landed
  // (or there is nothing left to chase). Either way the marker is spent.
  const advanced = status.app !== attempt.from;
  if (advanced || !status.behind) return { stale: false, clearMarker: true };

  // Still on the same version and still behind. Only call that a failed update while the
  // click is recent; `now < at` is a backwards clock and is treated as out-of-window.
  const elapsed = now - attempt.at;
  const withinWindow = elapsed >= 0 && elapsed < STALE_WINDOW_MS;
  if (!withinWindow) return { stale: false, clearMarker: true };

  return { stale: true, clearMarker: false };
}
