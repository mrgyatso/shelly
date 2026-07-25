/**
 * The Board's UNREAD ledger — which artifacts arrived while the user was not looking at
 * their unit. DOM-free and dependency-free so it can be unit-tested directly (see
 * `scripts/check-board-state.ts`) without standing up the Tauri/webview runtime.
 *
 * WHY THIS IS ITS OWN FILE. Unread lived in board.ts as a bare
 * `Map<string, Set<string>>` with seven mutation sites spread over 5,400 lines, and the
 * one invariant that keeps it honest — *drop the unit key the moment its set empties*, or
 * the 🔔 count never reaches zero — was hand-written at FOUR of them. Every unread bug
 * this project has shipped is that shape: two paths agreeing on the data and disagreeing
 * on the bookkeeping.
 *
 *   · the badge that never reset — artifacts were ADDED per artifact and retired per PATH
 *   · the sibling session whose artifacts vanished — a blanket clear keyed off the wrong
 *     identity wiped a unit that held two sessions' work
 *   · the dot that lingered on the old unit after an artifact was re-routed
 *
 * None of those were hard to fix once found; all of them were invisible until a user hit
 * them, because module state inside an import-time-mounting file cannot be reached by a
 * test. So the ledger moved out, the invariants moved into one place each, and the third
 * bug above is now UNREPRESENTABLE rather than merely fixed — see `add`.
 *
 * board.ts keeps the state object and the side effects; this file owns the arithmetic.
 */

/** Unread artifact paths, bucketed by UNIT key (so two same-repo sessions share one
 *  bucket, which is what makes the per-session badge a derived value, not a second map). */
export interface UnreadState {
  byUnit: Map<string, Set<string>>;
}

export function createUnreadState(): UnreadState {
  return { byUnit: new Map() };
}

/** THE invariant, in the only place it is written: a unit with an empty set is not a unit
 *  with unread. Every removal path funnels through here, so no caller can forget it. */
function prune(state: UnreadState, unitKey: string): void {
  const set = state.byUnit.get(unitKey);
  if (set && set.size === 0) state.byUnit.delete(unitKey);
}

/**
 * File `path` as unread under `unitKey`.
 *
 * EXCLUSIVE by construction: the path is first removed from every other unit. An artifact
 * belongs to exactly one unit, so being unread in two is always a bug — it showed up as a
 * dot lingering on the old unit after the routing index landed and moved the artifact.
 * That used to be corrected by a separate sweep at the call site, which is a fix that only
 * works while somebody remembers to call it. Enforcing it here retires the class.
 */
export function add(state: UnreadState, unitKey: string, path: string): void {
  for (const [unit, set] of state.byUnit) {
    if (unit !== unitKey && set.delete(path)) prune(state, unit);
  }
  let set = state.byUnit.get(unitKey);
  if (!set) {
    set = new Set();
    state.byUnit.set(unitKey, set);
  }
  set.add(path);
}

/** Mark ONE artifact read, wherever it is filed, leaving the rest of its unit queued.
 *  Surgical on purpose: jumping to one agent must not silently clear another's work.
 *  Returns whether anything was actually unread. */
export function markRead(state: UnreadState, path: string): boolean {
  for (const [unit, set] of state.byUnit) {
    if (set.delete(path)) {
      prune(state, unit);
      return true;
    }
  }
  return false;
}

/** Drop several paths at once — used for artifacts that were re-routed to a new unit. */
export function drop(state: UnreadState, paths: Iterable<string>): void {
  for (const path of paths) markRead(state, path);
}

/** Forget everything that no longer exists on disk, so the ledger cannot grow without
 *  bound as artifacts are archived or deleted. */
export function retainPaths(state: UnreadState, present: Set<string>): void {
  for (const [unit, set] of [...state.byUnit]) {
    for (const path of [...set]) if (!present.has(path)) set.delete(path);
    prune(state, unit);
  }
}

/** Clear an entire unit. Rare and blunt — prefer `markRead`. A unit can hold several
 *  sessions' artifacts, so clearing one on ENTRY is what made a sibling's work vanish;
 *  the caller must genuinely mean "every session in here is caught up". */
export function clearUnit(state: UnreadState, unitKey: string): void {
  state.byUnit.delete(unitKey);
}

export function count(state: UnreadState, unitKey: string): number {
  return state.byUnit.get(unitKey)?.size ?? 0;
}

export function total(state: UnreadState): number {
  let n = 0;
  for (const set of state.byUnit.values()) n += set.size;
  return n;
}

/** Every unread path, flattened. The per-session badge and the agent queue both derive
 *  from this rather than keeping a second index that could drift out of step with it. */
export function allPaths(state: UnreadState): Set<string> {
  const out = new Set<string>();
  for (const set of state.byUnit.values()) for (const path of set) out.add(path);
  return out;
}

export function pathsIn(state: UnreadState, unitKey: string): string[] {
  return [...(state.byUnit.get(unitKey) ?? [])];
}

/** Units that have unread work, for the 🔔 dropdown. Only non-empty buckets exist (see
 *  `prune`), so this needs no filter — but it keeps one anyway, because a caller that
 *  hands us a hand-built state in a test should still get a truthful answer. */
export function unitsWithUnread(state: UnreadState): Array<{ unit: string; n: number }> {
  const out: Array<{ unit: string; n: number }> = [];
  for (const [unit, set] of state.byUnit) if (set.size > 0) out.push({ unit, n: set.size });
  return out;
}

/** Flat `{ unit: count }` — the shape posted into the full-bleed home.html iframe. */
export function countsByUnit(state: UnreadState): Record<string, number> {
  const out: Record<string, number> = {};
  for (const [unit, set] of state.byUnit) out[unit] = set.size;
  return out;
}
