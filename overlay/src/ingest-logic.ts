/**
 * Pure decision helpers for the Board's artifact-ingest gate. Deliberately
 * DOM-free and dependency-free so they can be unit-tested directly (see
 * `scripts/check-ingest-rewrite.ts`) without standing up the Tauri/webview
 * runtime. board.ts holds the state and side effects; this file holds the logic.
 */

/** The minimum an artifact must expose for the in-place-rewrite check. */
export interface ArtifactDelta {
  path: string;
  modified_ms: number;
}

/** What the Board currently shows: the L2 hero digest, and the reader if open. */
export interface DisplayState {
  digestPath: string | null;
  focusPath: string | null;
}

/** A frame that must reload because the artifact it shows was rewritten in place. */
export interface ReloadTarget {
  path: string;
  target: "reader" | "hero";
}

/**
 * THE REWRITE-TO-DISPLAYED-HERO FIX. Return the on-screen artifacts that were
 * REWRITTEN IN PLACE (same path, newer mtime) and so must reload their frame.
 *
 * The four routing roads in `ingestArtifacts` all key on path-novelty or
 * path-DIFFERENCE, so overwriting the artifact already on the hero
 * (`a.path === digestPath`) falls through every one and the stale render sticks.
 * This keys on MTIME instead — the missing dimension — and only for the path(s)
 * actually displayed. Brand-new paths (no prior mtime) and unchanged paths return
 * nothing; routing owns those. The reader wins over the hero when both match,
 * since the reader is the focused surface.
 */
export function rewritesNeedingReload(
  prevMtime: ReadonlyMap<string, number>,
  next: readonly ArtifactDelta[],
  shown: DisplayState,
): ReloadTarget[] {
  const out: ReloadTarget[] = [];
  for (const a of next) {
    const prev = prevMtime.get(a.path);
    if (prev === undefined) continue; // brand-new path → routing surfaces it
    if (a.modified_ms <= prev) continue; // unchanged (or clock skew) → nothing to do
    if (shown.focusPath === a.path) out.push({ path: a.path, target: "reader" });
    else if (shown.digestPath === a.path) out.push({ path: a.path, target: "hero" });
    // rewritten but off-screen → no reload; the unit/history list re-reads on its own
  }
  return out;
}

/** Routing identity of an artifact — which session/unit owns it. */
export interface Identity {
  source: string | null | undefined;
  unit_key: string | null | undefined;
}

/**
 * THE REWRITE IDENTITY-FLAP FIX. history.rs distrusts the index for the one poll
 * between an in-place rewrite and the hook's re-stamp (the `index-stale-drop`
 * trace), blanking `source`/`unit_key` to None. If the Board trusts that empty
 * identity it re-files the artifact under `__unsourced__` and flashes a phantom
 * cross-unit unread dot, then re-routes it back a poll later — churn the user sees.
 *
 * Retain the last firm identity the Board held for this path — but ONLY when it
 * names a still-live session. A genuinely reused filename inherited from a DEAD
 * session is exactly what the staleness guard exists to catch, so for that case
 * we let the drop stand (return the current, blank identity) and fall through to
 * slug routing as before.
 */
export function retainedIdentity(
  current: Identity,
  prior: Identity | undefined,
  isLiveSource: (source: string) => boolean,
): Identity {
  if (current.source) return current; // identity present this poll → nothing to retain
  if (!prior || !prior.source) return current; // no firm prior → can't retain
  if (!isLiveSource(prior.source)) return current; // dead session → let the guard stand
  return { source: prior.source, unit_key: prior.unit_key };
}
