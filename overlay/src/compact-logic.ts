/**
 * The Compact button's state machine, kept pure so it can be pinned by a check.
 *
 * THE PROBLEM IT SOLVES: `/compact` is fire-and-forget. The Board types it into the
 * session's PTY and gets nothing back — no completion callback, no exit code. Meanwhile
 * the run is long: two real compactions on this machine took 42s and 119s. The old
 * button reset itself the instant the keystroke was sent and the meter sat unchanged
 * throughout, so from the outside, pressing Compact did nothing at all.
 *
 * THE DONE-SIGNAL: Claude writes a compaction into the session transcript only when it
 * FINISHES — the record is stamped with the `durationMs` the run took, which is what
 * makes it an ending rather than a beginning. `usage.rs` counts those records; the
 * Board baselines the count when it types `/compact` and waits for it to tick. So
 * "finished" is observed, never assumed or timed.
 *
 * WHY NOT THE `PostCompact` HOOK: it exists, and it would work. It is not used because
 * the Board is poll-based — a hook could only write a file that the Board would then
 * have to poll, which is strictly more machinery than polling the transcript it ALREADY
 * scans on this same tick. The hook would also have to be installed to work at all,
 * silently stranding the button on any session whose settings lack it, whereas Claude
 * writes the transcript unconditionally. The transcript count is derived from the whole
 * file, so it also survives a Board restart mid-compaction and catches auto-compactions
 * for free.
 *
 * WHY EVERY STATE IS SCOPED TO (unit, session): one button element serves every unit on
 * the Board. An unscoped "busy" flag paints "Compacting…" onto whatever unit the user
 * switches to next, and the finish then lands on the wrong one.
 */

/** A `/compact` that has been typed and has not landed yet. */
export interface CompactWatch {
  unitKey: string;
  sessionId: string;
  /** Compactions already in the transcript when we typed — the one we caused is the next. */
  baseline: number;
  startedAt: number;
}

/** A compaction that just landed, held on screen long enough to be read. */
export interface CompactDone {
  unitKey: string;
  sessionId: string;
  at: number;
}

export interface CompactState {
  watch: CompactWatch | null;
  done: CompactDone | null;
}

export const NO_COMPACT: CompactState = { watch: null, done: null };

/** What the button shows. `ready` is the only enabled one. */
export type CompactBtn = "busy" | "done" | "ready" | "unavailable";

/** How long to wait for a typed `/compact` to land before giving the button back.
 *  Generous against MEASURED runs, not a guess: the two real compactions on this machine
 *  reported a `durationMs` of 42s (auto, over a 202k context) and 119s (manual, 402k) —
 *  and a near-full 1M window is worse still. Reverting while it is genuinely working is
 *  the confusing failure, so this bound sits well clear of them. It exists only so a
 *  `/compact` that never runs (interrupted, or the session died) cannot strand the
 *  button at "Compacting…" forever. */
export const COMPACT_WAIT_MS = 5 * 60 * 1000;
/** How long "Compacted" stays up — long enough to catch the eye of someone who looked
 *  away while it ran. */
export const COMPACT_DONE_MS = 2500;

/** One meter poll, folded into the compact state.
 *
 *  A watch resolves on ANY new compaction, not only a `manual` one: if an auto-compact
 *  wins the race with the user's click, the context still got compacted and the button
 *  has nothing left to wait for.
 *
 *  Only ever resolves the watch for the session it was opened on, so a poll of some
 *  other session cannot finish (or time out) a compaction running elsewhere. */
export function resolveCompact(
  state: CompactState,
  poll: { unitKey: string; sessionId: string; compactions: number; now: number },
): CompactState {
  const w = state.watch;
  if (!w || w.unitKey !== poll.unitKey || w.sessionId !== poll.sessionId) return state;

  if (poll.compactions > w.baseline) {
    return { watch: null, done: { unitKey: w.unitKey, sessionId: w.sessionId, at: poll.now } };
  }
  if (poll.now - w.startedAt > COMPACT_WAIT_MS) {
    return { watch: null, done: null }; // it is not coming — see COMPACT_WAIT_MS
  }
  return state; // still running
}

/** What the button must show for the unit and session currently on screen.
 *
 *  `tabId` is null when the Board does not own the session's terminal, so it has
 *  nothing to type `/compact` into — that is `unavailable`, and it is the ONLY reason
 *  the button is greyed. A compaction in flight outranks it: the state is a fact about
 *  the session, not about which unit happens to be on screen. */
export function compactBtn(
  state: CompactState,
  view: { unitKey: string; sessionId: string; tabId: string | null; now: number },
): CompactBtn {
  const mine = (c: CompactWatch | CompactDone | null): boolean =>
    !!c && c.unitKey === view.unitKey && c.sessionId === view.sessionId;

  if (mine(state.watch)) return "busy";
  if (mine(state.done) && view.now - state.done!.at < COMPACT_DONE_MS) return "done";
  return view.tabId ? "ready" : "unavailable";
}
