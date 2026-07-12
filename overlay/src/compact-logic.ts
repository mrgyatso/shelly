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
 * WHY THE STATE IS A MAP KEYED BY (unit, session), and not one slot: sessions compact
 * CONCURRENTLY. One button element serves every unit on the Board, so a single slot fails
 * twice over — it paints "Compacting…" onto whatever unit the user switches to next, and,
 * worse, starting a second `/compact` elsewhere silently EVICTS the first one's watch. When
 * that first compaction then finishes, nothing is left to resolve it: its button quietly
 * goes back to reading "Compact" while it is still running, which is the very bug this
 * whole module exists to kill. Compactions take minutes, so starting one, moving to another
 * session, and compacting that too is an ordinary thing to do. Each session owns its own
 * entry, and nothing another session does can touch it.
 */

/** The key a session's compact state lives under. A NUL cannot occur in a unit key or a
 *  session id, so no two pairs can collide by concatenation. */
export function compactKey(unitKey: string, sessionId: string): string {
  return `${unitKey}\u0000${sessionId}`;
}

/** One session's compact state. A session is either waiting on a compaction or showing the
 *  one that just landed — never both, which is why this is a union and not two fields. */
export type CompactEntry =
  | {
      kind: "watch";
      /** Compactions already in the transcript when we typed — the one we caused is next. */
      baseline: number;
      startedAt: number;
    }
  | { kind: "done"; at: number };

/** Every session's compact state. Treated as immutable: each function below returns a new
 *  Map rather than mutating, so a stale reference can never rewrite live state. */
export type CompactState = ReadonlyMap<string, CompactEntry>;

export const NO_COMPACT: CompactState = new Map();

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

/** What this one session has going on, or `null` for nothing. */
export function compactEntry(
  state: CompactState,
  unitKey: string,
  sessionId: string,
): CompactEntry | null {
  return state.get(compactKey(unitKey, sessionId)) ?? null;
}

/** A `/compact` has just been typed into this session. Touches only this session's entry —
 *  a compaction already running in another session keeps its own. */
export function beginCompact(
  state: CompactState,
  w: { unitKey: string; sessionId: string; baseline: number; startedAt: number },
): CompactState {
  const next = new Map(state);
  next.set(compactKey(w.unitKey, w.sessionId), {
    kind: "watch",
    baseline: w.baseline,
    startedAt: w.startedAt,
  });
  return next;
}

/** The `/compact` never reached the session (the keystroke failed), so no compaction is
 *  coming and nothing will ever tick the count. Drop THIS session's watch — and only it. */
export function abandonCompact(
  state: CompactState,
  unitKey: string,
  sessionId: string,
): CompactState {
  const k = compactKey(unitKey, sessionId);
  if (!state.has(k)) return state;
  const next = new Map(state);
  next.delete(k);
  return next;
}

/** One meter poll, folded into the compact state.
 *
 *  A watch resolves on ANY new compaction, not only a `manual` one: if an auto-compact
 *  wins the race with the user's click, the context still got compacted and the button has
 *  nothing left to wait for.
 *
 *  Reads and writes only the polled session's entry, so a poll can neither finish nor time
 *  out a compaction running in some other session. */
export function resolveCompact(
  state: CompactState,
  poll: { unitKey: string; sessionId: string; compactions: number; now: number },
): CompactState {
  const k = compactKey(poll.unitKey, poll.sessionId);
  const e = state.get(k);
  if (!e) return state;

  if (e.kind === "done") {
    // Its moment on screen has passed. Drop it, so the map cannot grow without bound.
    if (poll.now - e.at >= COMPACT_DONE_MS) {
      const next = new Map(state);
      next.delete(k);
      return next;
    }
    return state;
  }

  if (poll.compactions > e.baseline) {
    const next = new Map(state);
    next.set(k, { kind: "done", at: poll.now });
    return next;
  }
  if (poll.now - e.startedAt > COMPACT_WAIT_MS) {
    const next = new Map(state); // it is not coming — see COMPACT_WAIT_MS
    next.delete(k);
    return next;
  }
  return state; // still running
}

/** What the button must show for the unit and session currently on screen.
 *
 *  `tabId` is null when the Board does not own the session's terminal, so it has nothing to
 *  type `/compact` into — that is `unavailable`, and it is the ONLY reason the button is
 *  greyed. A compaction in flight outranks it: the state is a fact about the session, not
 *  about which terminal the Board happens to own. */
export function compactBtn(
  state: CompactState,
  view: { unitKey: string; sessionId: string; tabId: string | null; now: number },
): CompactBtn {
  const e = compactEntry(state, view.unitKey, view.sessionId);
  if (e?.kind === "watch") return "busy";
  if (e?.kind === "done" && view.now - e.at < COMPACT_DONE_MS) return "done";
  return view.tabId ? "ready" : "unavailable";
}
