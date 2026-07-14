/**
 * Regression check pinned to the sibling-session disappearance bug (2026-07-09).
 *
 * THE REPORT: two Claude sessions run in one repo. They share a `unit_key` by design
 * (`companion-livepath.sh`: unit_key = git-root basename). Session B wrote an artifact
 * 19 minutes AFTER session A's; the user never saw B's. `enterUnit` called
 * `clearUnread(unitKey)` — wiping the whole unit's unread, including B's artifact,
 * which the hero (scoped to A) had never painted. Badge zeroed, artifact buried.
 *
 * THE SIGNATURE THIS PINS: the hero NEVER selects a sibling session's artifact, however
 * much newer it is. Since `renderHero` marks read exactly what it paints — and nothing
 * else does — a sibling's artifact cannot be marked read behind the user's back.
 * If a future refactor re-scopes the hero to the unit (or reinstates a blanket
 * clear-on-entry keyed off "freshest artifact wins"), case 1 fails.
 *
 *   node --experimental-strip-types scripts/check-sibling-unread.ts
 */
import { readFileSync } from "node:fs";
import { heroArtifactFor, artifactMatchesSource, type HeroCandidate } from "../src/ingest-logic.ts";

let failed = 0;
function check(name: string, cond: boolean): void {
  console.log(`${cond ? "  ok  " : "FAIL  "}${name}`);
  if (!cond) failed++;
}

// The exact 2026-07-09 timeline, in one unit (`claude-code-companion`).
const A_SRC = "claude-code-companion--c6f77d0e";
const B_SRC = "claude-code-companion--ef654874";
const A_ART = "/art/mtx-observer-product-boundary.html"; // 11:35:59
const B_ART = "/art/usage-meter-found.html"; //             11:54:45 — NEWER
const UNIT: HeroCandidate[] = [
  { path: A_ART, modified_ms: 1_783_611_359_788, source: A_SRC },
  { path: B_ART, modified_ms: 1_783_612_485_400, source: B_SRC },
];

// ---- 1. THE BUG: a newer sibling artifact must never take A's hero ----------
check(
  "1. hero scoped to A ignores B's NEWER artifact (the reported bug)",
  heroArtifactFor(UNIT, A_SRC, true)?.path === A_ART,
);

// The corollary that makes "artifacts never disappear" true: entering the unit with A
// active paints only A_ART, so only A_ART is marked read. B_ART stays unread → bell.
check(
  "2. entering with A active leaves B's artifact unpainted, so it stays unread",
  heroArtifactFor(UNIT, A_SRC, true)?.path !== B_ART,
);

// ---- 3. …and B is reachable: picking B re-heroes to B, clearing only B ------
check("3. picking session B heroes B's own artifact", heroArtifactFor(UNIT, B_SRC, true)?.path === B_ART);

// ---- 4. freshness must not leak in through a null active source ------------
// `activeSessionSource` falls back to "freshest artifact wins" when no terminal is
// bound. A FRESH session (owned tab, no live file yet ⇒ null source) must still blank,
// never inherit a sibling's artifact.
check("4. fresh session (owned tab, no source) → blank hero, not a sibling's", heroArtifactFor(UNIT, null, true) === null);

// ---- 5. no session at all (cloud unit / closed external) → freshest ---------
check(
  "5. no owned tab and no source → lead with the unit's freshest",
  heroArtifactFor(UNIT, null, false)?.path === B_ART,
);

// ---- 6. a session that owns nothing yet stays blank -------------------------
check("6. active session with zero artifacts → blank hero", heroArtifactFor(UNIT, "unit--nobody", true) === null);

// ---- 7. empty unit -----------------------------------------------------------
check("7. empty unit → null", heroArtifactFor([], A_SRC, true) === null);

// ---- 9. THE HOME-SLUG SPLIT (2026-07-14): a session's OWN artifact must hero --
// The index stamps source from the identity record's slug; for a home session that
// slug is the unit key ('__home__') while the live stem uses the cwd basename
// ('gyatso--<id>'). Strict string equality dropped the session's own artifact —
// blank hero right after it was written. The artifact's session_id shortid is the
// identity both stems derive from, so it must bridge the split.
const HOME_SID = "39f7edc5-55ca-4823-8a61-e74f73afbdf6";
const HOME_LIVE_SRC = "gyatso--39f7edc5";
const HOME_ART = "/art/discord-links-brief.html";
const HOME_UNIT_ARTS: HeroCandidate[] = [
  { path: HOME_ART, modified_ms: 1_784_039_390_000, source: "__home__--39f7edc5", session_id: HOME_SID },
];
check(
  "9. home session heroes its OWN artifact despite the '__home__' source stamp",
  heroArtifactFor(HOME_UNIT_ARTS, HOME_LIVE_SRC, true)?.path === HOME_ART,
);
check(
  "9b. a home SIBLING still never inherits it (shortid mismatch)",
  heroArtifactFor(HOME_UNIT_ARTS, "gyatso--c54fdb07", true) === null,
);
check(
  "9c. no session_id + mismatched source → still no match (no false positives)",
  heroArtifactFor([{ path: HOME_ART, modified_ms: 1, source: "__home__--39f7edc5" }], HOME_LIVE_SRC, true) === null,
);
check(
  "9d. matcher: exact source equality still matches without a session_id",
  artifactMatchesSource({ source: HOME_LIVE_SRC }, HOME_LIVE_SRC),
);
check("9e. matcher: null source → no match", !artifactMatchesSource({ session_id: HOME_SID }, null));

// ---- 8. STRUCTURAL: entry must not clear the unit's unread wholesale ---------
// Cases 1–2 prove a sibling's artifact is never PAINTED. This pins the other half of
// the bug — that entering the unit must not mark it read ANYWAY. `enterUnit` is
// DOM-coupled, and its one failure mode is a re-added blanket clear, so guard the
// source directly: unread may only be retired per-path (`markArtifactRead`).
const boardSrc = readFileSync(new URL("../src/board.ts", import.meta.url), "utf8");
const enterAt = boardSrc.indexOf("function enterUnit(");
const enterEnd = boardSrc.indexOf("\nfunction ", enterAt + 1);
const enterUnitBody = boardSrc.slice(enterAt, enterEnd === -1 ? undefined : enterEnd);

check("8. enterUnit() body was located (guard is live, not vacuous)", enterAt !== -1 && enterUnitBody.length > 0);
check(
  "8b. enterUnit does not clear the unit's unread wholesale",
  !/clearUnread\s*\(|unreadByUnit\s*\.\s*delete\s*\(/.test(enterUnitBody),
);

console.log(failed === 0 ? "\nall checks passed" : `\n${failed} check(s) FAILED`);
process.exit(failed === 0 ? 0 : 1);
