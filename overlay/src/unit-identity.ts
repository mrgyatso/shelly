/**
 * Pure decision helpers for UNIT IDENTITY — which shelf a session belongs on.
 * Deliberately DOM-free and dependency-free so they can be unit-tested directly (see
 * `scripts/check-unit-identity.ts`) without standing up the Tauri/webview runtime.
 * board.ts holds the state and side effects; this file holds the logic.
 *
 * THE ONE RULE: a unit is always a function of its DIRECTORY, never of any label the
 * agent wrote. `unit_dir` is written by the hook and is agent-proof; `project` is a
 * cosmetic field the agent rewrites freely. Key a unit off the label and a session
 * TELEPORTS between units the moment its agent renames itself — the whatnot-api → gyatso
 * bug. So: directory in, unit out.
 */

/** The shared unit every $HOME-launched session lands in — the "Home" shelf. $HOME is not
 *  a project, it is where the user lives; keying it by folder name would mint a "project"
 *  named after their USERNAME and collapse every unrelated ~-launched session into it.
 *  Sessions here are told apart by their first-prompt title, not a folder. A session
 *  LEAVES this shelf for good once it establishes a real root (`git init`) — see
 *  plugin/hooks/companion-adopt.cjs. */
export const HOME_UNIT = "__home__";

/** The minimum a live source must expose to be placed on a shelf. */
export interface UnitSource {
  /** The live file's stem, `<slug>--<shortid>`. */
  source: string;
  /** The session's real project root, injected by the Rust reader from session-dirs.json.
   *  Absent only for pre-hook sources. */
  unit_dir?: string | null;
  /** The agent's cosmetic label. NEVER used to key a unit — only as a last-resort
   *  fallback for a pre-hook source that carries no unit_dir. */
  project?: string | null;
}

/** Strip trailing slashes so a recorded root and $HOME compare equal regardless of a
 *  stray trailing separator. Returns null for a null/empty input. */
export function normalizeDir(dir: string | null | undefined): string | null {
  if (!dir) return null;
  const trimmed = dir.replace(/\/+$/, "");
  return trimmed || "/";
}

/** The basename of a path-ish string (the Board's unit naming unit). */
export function projectSlug(project?: string | null): string | null {
  if (!project) return null;
  const trimmed = project.replace(/\/+$/, "");
  const base = trimmed.split("/").pop() || trimmed;
  return base || null;
}

/** True when `dir` IS the user's $HOME — the directory behind the shared Home shelf. The
 *  path-level rule both the read side (isHomeRooted, on a live source) and the launch side
 *  (unitKeyForDir, on a spawn dir) answer to, so neither can drift from the other. */
export function isHomeDir(dir: string | null | undefined, homeDir: string | null): boolean {
  if (!homeDir) return false;
  const d = normalizeDir(dir);
  return d !== null && d === normalizeDir(homeDir);
}

/** True when this session's recorded root is still the user's $HOME — i.e. it was
 *  launched from ~ and has not yet adopted a project directory of its own. */
export function isHomeRooted(s: UnitSource, homeDir: string | null): boolean {
  return isHomeDir(s.unit_dir, homeDir);
}

/** A throwaway/scratch directory: the system temp roots, or a folder literally named
 *  `tmp`/`temp`. Sessions rooted here are incidental, not projects. */
export function isScratchDir(dir: string): boolean {
  const base = dir.split("/").filter(Boolean).pop()?.toLowerCase() ?? "";
  if (base === "tmp" || base === "temp") return true;
  return /^\/(private\/)?tmp(\/|$)|^\/var\/folders\//.test(dir);
}

/**
 * The project-match key for a source — the basename of its `unit_dir`, the REAL directory
 * the hook recorded.
 *
 * This deliberately does NOT key off `project`. That field is the agent's, and keying a
 * unit off it lets a session hop to another unit the instant its agent renames itself.
 * `unit_dir` comes from session-dirs.json (hook-written, agent-proof) and normally holds
 * the same basename `project` does — verified identical across every live session — so
 * this is a no-op except where the label had drifted, which is exactly what it fixes.
 *
 * Falls back to `project`, then the stem's slug prefix, for pre-hook sources with no
 * unit_dir.
 */
export function sourceProjectKey(s: UnitSource): string {
  const fromDir = projectSlug(normalizeDir(s.unit_dir) ?? undefined);
  if (fromDir) return fromDir;
  const fromJson = projectSlug(s.project ?? undefined);
  if (fromJson) return fromJson;
  const i = s.source.indexOf("--");
  return i >= 0 ? s.source.slice(0, i) : s.source;
}

/** The UNIT a source belongs to. $HOME-launched sessions share the one Home shelf; every
 *  other session belongs to its project DIRECTORY, so two agents in one folder land in the
 *  same unit (per-session identity lives in the rail's switcher, not the unit key). */
export function unitKeyOf(s: UnitSource, homeDir: string | null): string {
  if (isHomeRooted(s, homeDir)) return HOME_UNIT;
  return sourceProjectKey(s);
}

/**
 * The unit a session spawned in `dir` will land on — the SAME rule as `unitKeyOf`, but
 * answerable from the DIRECTORY alone, before the session has a live file to read.
 *
 * The Board must place a freshly spawned terminal on a shelf immediately (claude's
 * first-run trust prompt can hold SessionStart for seconds, and the user has to SEE the
 * terminal), so the launch path needs this answer early. It used to guess with the raw
 * basename of the spawn dir — but for $HOME that is the USERNAME, while `unitKeyOf` answers
 * HOME_UNIT for the very same directory. Two derivations of one fact, in two namespaces:
 * the launch path's "is this unit already on the roster?" test then compared "gyatso"
 * against "__home__", never matched, and minted a throwaway `gyatso~N` project that sat in
 * the rail beside the real Home shelf until the live file landed and re-homed it.
 * Directory in, unit out — one rule, so the provisional IS the final key.
 */
export function unitKeyForDir(dir: string, homeDir: string | null): string {
  if (isHomeDir(dir, homeDir)) return HOME_UNIT;
  return projectSlug(normalizeDir(dir)) ?? dir;
}

/**
 * An INCIDENTAL unit the roster should ignore entirely: one rooted in a scratch/temp dir.
 * Those are genuinely throwaway — "if I wanted it in here I would have run it in here."
 *
 * $HOME used to be lumped in here, which is what made ~-launched sessions VANISH: the
 * Board hid them while SessionStart still told their agent to author artifacts, so the
 * agent filed cards into a unit that was never rendered. Home is now a real, visible shelf
 * that a session graduates OUT of on `git init`. Scratch stays gone.
 */
export function isEphemeralUnit(sources: UnitSource[]): boolean {
  return sources.some((s) => {
    const dir = normalizeDir(s.unit_dir);
    return dir !== null && isScratchDir(dir);
  });
}
