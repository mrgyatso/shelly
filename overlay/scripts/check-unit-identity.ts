/**
 * Unit checks for the Board's UNIT IDENTITY logic — which shelf a session lands on.
 * Pure, DOM-free; run with `npm test` (node --experimental-strip-types).
 *
 * These cover the half of the home-session fix the hook suite structurally cannot see:
 * plugin/hooks/__tests__/home-adoption.cjs proves the SIDECARS are written right, this
 * proves the BOARD reads them right. Between them, the whole path is covered.
 */

import {
  HOME_UNIT,
  unitKeyOf,
  unitKeyForDir,
  isHomeRooted,
  isEphemeralUnit,
  sourceProjectKey,
  isScratchDir,
  normalizeDir,
  projectSlug,
  type UnitSource,
} from "../src/unit-identity.ts";

let pass = 0;
let fail = 0;
function ok(cond: boolean, msg: string): void {
  if (cond) {
    pass++;
    console.log("  ok  " + msg);
  } else {
    fail++;
    console.log("  FAIL " + msg);
  }
}

const HOME = "/home/mrgyatso";
const src = (o: Partial<UnitSource> & { source: string }): UnitSource => ({
  unit_dir: null,
  project: null,
  ...o,
});

console.log("\n### the Home shelf");
{
  // The bug: $HOME's basename is the USERNAME, so a home session used to mint a project
  // called "mrgyatso" — and every unrelated ~-launched session piled into it.
  const a = src({ source: "mrgyatso--aaaaaaaa", unit_dir: HOME, project: "mrgyatso" });
  const b = src({ source: "mrgyatso--bbbbbbbb", unit_dir: HOME, project: "mrgyatso" });

  ok(isHomeRooted(a, HOME), "a session rooted at $HOME is home-rooted");
  ok(unitKeyOf(a, HOME) === HOME_UNIT, "…and lands on the shared Home shelf");
  ok(unitKeyOf(a, HOME) !== "mrgyatso", "…NOT in a unit named after the user");
  ok(unitKeyOf(a, HOME) === unitKeyOf(b, HOME), "two home sessions SHARE one shelf");

  // Trailing-slash and $HOME-with-slash must still compare equal.
  const c = src({ source: "x--cccccccc", unit_dir: HOME + "/" });
  ok(unitKeyOf(c, HOME + "/") === HOME_UNIT, "trailing slashes don't defeat the match");

  // A dir merely UNDER $HOME is a real project, not the Home shelf.
  const proj = src({ source: "snake--dddddddd", unit_dir: HOME + "/snake" });
  ok(!isHomeRooted(proj, HOME), "~/snake is NOT home-rooted");
  ok(unitKeyOf(proj, HOME) === "snake", "…it is its own 'snake' unit");
}

console.log("\n### the Home shelf is VISIBLE (the bug that hid the artifacts)");
{
  // This is the regression that made ~-sessions vanish: they were classed ephemeral and
  // dropped from the roster, while SessionStart still told their agent to write artifacts.
  const home = src({ source: "mrgyatso--aaaaaaaa", unit_dir: HOME });
  ok(!isEphemeralUnit([home]), "a Home session is NOT ephemeral — it renders");

  // Scratch/tmp stays hidden — that rule was right, just applied too broadly.
  ok(isEphemeralUnit([src({ source: "t--1", unit_dir: "/tmp/whatever" })]), "/tmp is ephemeral");
  ok(isEphemeralUnit([src({ source: "t--2", unit_dir: "/var/folders/xy/z" })]), "/var/folders is ephemeral");
  ok(isEphemeralUnit([src({ source: "t--3", unit_dir: "/home/me/tmp" })]), "a dir named tmp is ephemeral");
  ok(!isEphemeralUnit([src({ source: "r--4", unit_dir: "/home/me/real-project" })]), "a real project is not");
  ok(isScratchDir("/tmp"), "isScratchDir(/tmp)");
  ok(!isScratchDir("/home/me/templates"), "'templates' is not 'tmp' (no prefix match)");
}

console.log("\n### a unit is keyed by its DIRECTORY, never the agent's label");
{
  // THE bug this fixes: `project` is written by the agent and is cosmetic. Keying a unit
  // off it let a session TELEPORT to another unit the moment its agent renamed itself
  // (whatnot-api → gyatso). unit_dir is hook-written and agent-proof, so it wins.
  const honest = src({ source: "snake--aaaaaaaa", unit_dir: "/home/me/snake", project: "snake" });
  const lying = src({ source: "snake--bbbbbbbb", unit_dir: "/home/me/snake", project: "whatnot-api" });

  ok(sourceProjectKey(honest) === "snake", "label agrees with dir → 'snake'");
  ok(sourceProjectKey(lying) === "snake", "agent RENAMED itself → still 'snake' (no teleport)");
  ok(
    unitKeyOf(honest, HOME) === unitKeyOf(lying, HOME),
    "both sessions in one folder stay in ONE unit regardless of label",
  );

  // Fallbacks, for pre-hook sources that carry no unit_dir at all.
  ok(sourceProjectKey(src({ source: "x--cccccccc", project: "legacy" })) === "legacy", "no unit_dir → falls back to project");
  ok(sourceProjectKey(src({ source: "legacy--dddddddd" })) === "legacy", "no unit_dir/project → stem prefix");
  ok(sourceProjectKey(src({ source: "bare" })) === "bare", "a stem with no -- → itself");
}

console.log("\n### graduation (what companion-adopt.cjs rewrites, seen from the Board)");
{
  // Before: rooted at $HOME → Home shelf. After adoption the hook re-points unit_dir at
  // the new repo, and that ALONE is what moves the card — the Board re-derives from it.
  const before = src({ source: "mrgyatso--aaaaaaaa", unit_dir: HOME, project: "mrgyatso" });
  ok(unitKeyOf(before, HOME) === HOME_UNIT, "before git init → Home shelf");

  const after = src({ source: "mrgyatso--aaaaaaaa", unit_dir: HOME + "/snake", project: "snake" });
  ok(unitKeyOf(after, HOME) === "snake", "after adoption → its own 'snake' unit");
  ok(!isEphemeralUnit([after]), "…and it is visible");

  // The live-file STEM keeps its old home slug (identity is frozen per session, only the
  // unit moves). The unit must not follow the stale stem.
  ok(after.source.startsWith("mrgyatso--"), "stem still carries the old home slug");
  ok(unitKeyOf(after, HOME) !== "mrgyatso", "…but the unit does NOT follow the stem");
}

console.log("\n### launch-time identity (unitKeyForDir) agrees with read-time (unitKeyOf)");
{
  // The bug this pins: the launch path derived a provisional unit from the raw BASENAME of
  // the spawn dir ("mrgyatso"), while unitKeyOf answers HOME_UNIT for that very directory.
  // Two namespaces for one fact ⇒ the "is this unit already on the roster?" test could never
  // match Home ⇒ every ~-launch minted a bogus `mrgyatso~N` project that sat beside Home
  // until its live file landed and re-homed it. One rule, one namespace, no interim card.
  ok(unitKeyForDir(HOME, HOME) === HOME_UNIT, "launching in $HOME → the Home shelf, not the username");
  ok(unitKeyForDir(HOME + "/", HOME) === HOME_UNIT, "…even with a trailing slash");
  ok(
    unitKeyForDir(HOME, HOME) === unitKeyOf(src({ source: "mrgyatso--aaaaaaaa", unit_dir: HOME }), HOME),
    "launch-time key === the key its live source will resolve to (Home)",
  );

  const repo = HOME + "/snake";
  ok(unitKeyForDir(repo, HOME) === "snake", "launching in a repo → its project unit");
  ok(
    unitKeyForDir(repo, HOME) === unitKeyOf(src({ source: "snake--cccccccc", unit_dir: repo }), HOME),
    "launch-time key === the key its live source will resolve to (project)",
  );

  ok(unitKeyForDir(HOME, null) === "mrgyatso", "no homeDir → cannot know it is home; falls back to basename");
}

console.log("\n### degenerate input");
{
  ok(unitKeyOf(src({ source: "x--aaaaaaaa", unit_dir: HOME }), null) !== HOME_UNIT, "no homeDir → cannot be home-rooted");
  ok(normalizeDir("") === null, "normalizeDir('') → null");
  ok(normalizeDir("/") === "/", "normalizeDir('/') → '/'");
  ok(projectSlug(null) === null, "projectSlug(null) → null");
  ok(projectSlug("/a/b/") === "b", "projectSlug strips trailing slash");
}

console.log(`\n${fail === 0 ? "all checks passed" : `${fail} FAILED`} (${pass} ok, ${fail} failed)`);
if (fail > 0) process.exit(1);
