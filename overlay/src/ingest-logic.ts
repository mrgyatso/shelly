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

/**
 * The passive affordance the Board offers for a rewritten artifact.
 *
 * THE UNION HAS NO "none"/"defer" MEMBER, AND THAT IS THE POINT. The 2026-07-11
 * silence bug was exactly a rewrite mapping to "do nothing" — so the type now makes
 * that unsayable. Every on-screen rewrite must name a surface the user can act on.
 * Neither value reloads anything: both are offers, and the reload is the user's click.
 */
export type RewriteAffordance = "hero-pill" | "reader-refresh";

/** What the Board must OFFER about an in-place rewrite of an artifact it displays. */
export interface RewriteEffect {
  path: string;
  affordance: RewriteAffordance;
}

/**
 * Map each on-screen rewrite to the affordance the Board owes the user.
 *
 * This exists as a pure function *because* the bug it fixes lived in the gap between
 * detection and reaction: `rewritesOnScreen` always reported the reader, and board.ts
 * silently dropped it. A regression test against detection alone would pass on the
 * buggy code. Pinning the REACTION here is what makes the test real.
 */
export function effectsForRewrites(
  prevMtime: ReadonlyMap<string, number>,
  next: readonly ArtifactDelta[],
  shown: DisplayState,
): RewriteEffect[] {
  return rewritesOnScreen(prevMtime, next, shown).map((r) => ({
    path: r.path,
    affordance: r.target === "hero" ? "hero-pill" : "reader-refresh",
  }));
}

/**
 * Return the on-screen artifacts that were REWRITTEN IN PLACE (same path, newer
 * mtime). Detection only — `effectsForRewrites` owns what the user is offered.
 *
 * The four routing roads in `ingestArtifacts` all key on path-novelty or
 * path-DIFFERENCE, so overwriting the artifact already on the hero
 * (`a.path === digestPath`) falls through every one and the stale render sticks.
 * This keys on MTIME instead — the missing dimension — and only for the path(s)
 * actually displayed. Brand-new paths (no prior mtime) and unchanged paths return
 * nothing; routing owns those. The reader wins over the hero when both match,
 * since the reader is the focused surface.
 *
 * TWO RULES, AND THEY ARE NOT THE SAME RULE.
 *
 * 1. NEVER RELOAD (the 2026-07-09 comment-loss fix). An agent re-authoring one
 *    path — observed 10× in 7 minutes — used to reload the frame showing it,
 *    destroying whatever the user had typed into its 💬 blocks, silently and with
 *    no navigation involved. So a rewrite still never reloads a displayed frame.
 *    Both surfaces only ever *offer*; the reload is the user's click.
 *
 * 2. NEVER GO SILENT (2026-07-11). That fix over-corrected: the reader was left
 *    untouched *and unmentioned*, so an agent could replace the artifact the user
 *    was reading and the user would never know. "Don't reload" had quietly become
 *    "don't tell" — the user reads stale content believing it is current, and the
 *    agent silently fails to reach them. Observed live: a recommendation flipped
 *    twice under an open reader; the user answered the superseded version.
 *
 * So BOTH targets are surfaced, passively: the hero gets the click-to-advance
 * pill, the reader gets a refresh button in its nav. Nothing moves behind the
 * user's back, and nothing is hidden from them either.
 */
export function rewritesOnScreen(
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
  session_id?: string | null;
}

/**
 * Does this artifact belong to the session whose live stem is `src`?
 *
 * The stamped source stem is the primary key and matches by string when healthy. But
 * the stamp is composed from the identity RECORD's slug, and home sessions split that
 * from the live stem (record slug `__home__` vs live `gyatso--<id>`) — so equality
 * alone silently drops a home session's own artifact (blank hero, mis-badged unread,
 * submit falling back to the clipboard). The artifact's session_id — the identity
 * BOTH stems are derived from — settles it: every live stem ends with
 * `--<first 8 of the session_id>`, so the shortid match holds wherever the slug halves
 * drifted apart, and old index entries heal without a re-stamp.
 */
export function artifactMatchesSource(
  a: { source?: string | null; session_id?: string | null },
  src: string | null | undefined,
): boolean {
  if (!src) return false;
  if (a.source === src) return true;
  const sid = a.session_id ?? "";
  return sid.length >= 8 && src.endsWith(`--${sid.slice(0, 8)}`);
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
  return scopeToSession(unitArts, activeSource, hasOwnedTab).reduce<T | null>(
    (best, a) => (best === null || a.modified_ms > best.modified_ms ? a : best),
    null,
  );
}

/**
 * The scoping half of `heroArtifactFor`, extracted so the artifact DECK (deck-logic.ts)
 * pages through EXACTLY the set the hero selects from. Two copies of this filter would
 * be free to drift, and the drift would land precisely on the sibling-session rule above
 * — a deck that paged onto a sibling's artifact would reintroduce the 2026-07-09
 * disappearance bug through the back door. One definition, two callers.
 *
 * Selection order is NOT decided here: the hero takes the freshest, the deck sorts
 * chronologically. This answers only "whose artifacts are these".
 */
export function scopeToSession<T extends HeroCandidate>(
  unitArts: readonly T[],
  activeSource: string | null,
  hasOwnedTab: boolean,
): T[] {
  if (activeSource) return unitArts.filter((a) => artifactMatchesSource(a, activeSource));
  return hasOwnedTab ? [] : unitArts.slice();
}
