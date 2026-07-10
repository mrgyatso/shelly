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

/** A displayed frame whose artifact was rewritten in place. */
export interface ReloadTarget {
  path: string;
  target: "reader" | "hero";
}

/** What the Board DOES about an in-place rewrite of an artifact it is displaying.
 *  Never a reload: `loadArtifactInto` cache-busts the iframe `src`, so reloading
 *  tears the document down and wipes any comment the user is mid-typing. */
export interface RewriteEffect {
  path: string;
  target: "reader" | "hero";
  /** "pill" = offer a click-to-refresh affordance; "defer" = leave the frame alone. */
  action: "pill" | "defer";
}

/**
 * THE MID-TYPING COMMENT-LOSS FIX (2026-07-09). An agent re-authoring the same
 * artifact path — observed 10× in 7 minutes — used to reload the frame showing it,
 * destroying everything the user had typed into its 💬 blocks, silently and with no
 * navigation involved.
 *
 * So a rewrite NEVER reloads a displayed frame. It is surfaced the same way a
 * brand-new artifact is: passively. The HERO gets the click-to-advance pill (the
 * user chooses to move on, so nothing is lost behind their back). The READER — the
 * focused surface, where the user is demonstrably reading and typing — is left
 * untouched entirely, matching `ingestIntoUnit`'s existing defer-while-open rule.
 * Fresh content still lands on the next entry, nav, or re-open.
 */
export function effectsForRewrites(
  prevMtime: ReadonlyMap<string, number>,
  next: readonly ArtifactDelta[],
  shown: DisplayState,
): RewriteEffect[] {
  return rewritesNeedingReload(prevMtime, next, shown).map((r) => ({
    ...r,
    action: r.target === "hero" ? "pill" : "defer",
  }));
}

/**
 * Return the on-screen artifacts that were REWRITTEN IN PLACE (same path, newer
 * mtime). Detection only — `effectsForRewrites` owns what to do about them.
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

// (retainedIdentity — the rewrite identity-flap patch — was removed at the Phase 4
// cutover along with its cause: history.rs no longer distrusts a stamped identity
// on mtime, so a stamped source/unit_key can't flap to None across a rewrite.)

/** An artifact as the hero selector sees it: when it landed, and whose session wrote it. */
export interface HeroCandidate {
  path: string;
  modified_ms: number;
  source?: string | null;
}

/**
 * THE SIBLING-SESSION FIX. Choose the ONE artifact a unit's hero paints.
 *
 * A unit holds every session's artifacts, but the hero belongs to a single session.
 * Scope to the active session's own artifacts and take its freshest — so a sibling's
 * artifact is NEVER selected, however new it is. `renderHero` marks exactly what it
 * paints as read, which is why entering a unit can no longer mark a sibling's work
 * read behind the user's back (the disappearance bug, 2026-07-09).
 *
 * `activeSource === null` means no session owns this unit's hero: a unit with an owned
 * terminal but no live file yet is a FRESH session ⇒ blank (never a sibling's last
 * artifact), while a unit with neither — a cloud unit, or a closed external session —
 * has no session to scope to, so it leads with its freshest artifact rather than
 * looking empty.
 */
export function heroArtifactFor<T extends HeroCandidate>(
  unitArts: readonly T[],
  activeSource: string | null,
  hasOwnedTab: boolean,
): T | null {
  const scoped = activeSource
    ? unitArts.filter((a) => a.source === activeSource)
    : hasOwnedTab
      ? []
      : unitArts;
  return scoped.reduce<T | null>(
    (best, a) => (best === null || a.modified_ms > best.modified_ms ? a : best),
    null,
  );
}
