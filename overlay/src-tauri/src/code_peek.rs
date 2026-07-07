//! Code-peek: list the files in play for a session and read them for the
//! read-only Monaco side panel.
//!
//! "Peek and nudge," not an IDE. The "files in play" are the changed files in the
//! unit's working tree (`git status`) — the code the agent is touching right now,
//! not a project browser. Reads are scope-guarded to the repository so the panel
//! can never become an arbitrary file-read oracle. No writes here yet; edit + save
//! (with an mtime conflict guard) are a deliberate fast-follow.

use std::path::{Path, PathBuf};
use std::process::Command;

/// A changed file in a unit's working tree, as reported by `git status`.
#[derive(serde::Serialize)]
pub struct ChangedFile {
    /// Path relative to the repository root — stable regardless of cwd, and what
    /// the panel both displays and passes back to [`read_source_file`].
    pub path: String,
    /// The porcelain status code, trimmed (e.g. "M", "??", "A", "R", "D"). Left
    /// otherwise raw for the frontend to map to a badge.
    pub status: String,
}

/// The repository top-level for `dir`, or `None` if `dir` isn't inside a git repo.
fn repo_toplevel(dir: &str) -> Option<PathBuf> {
    let out = Command::new("git")
        .args(["-C", dir, "rev-parse", "--show-toplevel"])
        .output()
        .ok()?;
    if !out.status.success() {
        return None;
    }
    let s = String::from_utf8_lossy(&out.stdout).trim().to_string();
    if s.is_empty() {
        None
    } else {
        Some(PathBuf::from(s))
    }
}

/// Parse one `git status --porcelain` line into (status, repo-relative path).
/// Handles the rename form `R  old -> new` (takes `new`). Returns `None` for a
/// line too short to carry a path.
fn parse_porcelain_line(line: &str) -> Option<(String, String)> {
    // Porcelain v1: two status chars, a space, then the path (`XY <path>`).
    if line.len() < 4 {
        return None;
    }
    let status = line[..2].trim().to_string();
    let rest = line[3..].trim();
    // A rename/copy reports `old -> new`; the file in play is the new path.
    let path = match rest.split_once(" -> ") {
        Some((_, new)) => new,
        None => rest,
    };
    // Skip directory entries (a trailing `/` — e.g. a collapsed untracked dir):
    // they aren't readable files. `--untracked-files=all` normally expands these,
    // but guard here too (submodules, edge cases).
    if path.is_empty() || path.ends_with('/') {
        None
    } else {
        Some((status, path.to_string()))
    }
}

/// The changed files in `unit_dir`'s working tree (staged, unstaged, untracked),
/// each relative to the repo root. Empty when `unit_dir` isn't a git repo — the
/// panel then shows its empty state rather than erroring. `core.quotePath=false`
/// keeps non-ASCII paths literal (no C-style `\NNN` escaping to unquote).
#[tauri::command]
pub fn list_changed_files(unit_dir: String) -> Vec<ChangedFile> {
    if repo_toplevel(&unit_dir).is_none() {
        return Vec::new();
    }
    let out = match Command::new("git")
        .args([
            "-c",
            "core.quotePath=false",
            "-C",
            &unit_dir,
            "status",
            "--porcelain",
            "--untracked-files=all",
        ])
        .output()
    {
        Ok(o) if o.status.success() => o,
        _ => return Vec::new(),
    };
    String::from_utf8_lossy(&out.stdout)
        .lines()
        .filter_map(parse_porcelain_line)
        .map(|(status, path)| ChangedFile { path, status })
        .collect()
}

/// Join `rel_path` onto `root` and read it, refusing anything that escapes `root`.
/// Canonicalizing BOTH sides before the prefix check is what defeats `../` and
/// symlink escape — a raw string prefix check would not. Split out from the
/// command so the scope guard is unit-testable without git.
fn read_in_scope(root: &Path, rel_path: &str) -> Result<String, String> {
    let root = root.canonicalize().map_err(|e| e.to_string())?;
    let target = root
        .join(rel_path)
        .canonicalize()
        .map_err(|e| e.to_string())?;
    if !target.starts_with(&root) {
        return Err("path is outside the repository".into());
    }
    std::fs::read_to_string(&target).map_err(|e| e.to_string())
}

/// Read a source file in play for the panel. `rel_path` is repo-root-relative (as
/// returned by [`list_changed_files`]); it's resolved against the unit's repo root
/// and scope-guarded to that root.
#[tauri::command]
pub fn read_source_file(unit_dir: String, rel_path: String) -> Result<String, String> {
    let root = repo_toplevel(&unit_dir).ok_or("not a git repository")?;
    read_in_scope(&root, &rel_path)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn parses_modified_and_untracked() {
        assert_eq!(
            parse_porcelain_line(" M overlay/src/board.ts"),
            Some(("M".into(), "overlay/src/board.ts".into()))
        );
        assert_eq!(
            parse_porcelain_line("?? new_file.rs"),
            Some(("??".into(), "new_file.rs".into()))
        );
        assert_eq!(
            parse_porcelain_line("A  staged.rs"),
            Some(("A".into(), "staged.rs".into()))
        );
    }

    #[test]
    fn rename_takes_the_new_path() {
        assert_eq!(
            parse_porcelain_line("R  old/name.rs -> new/name.rs"),
            Some(("R".into(), "new/name.rs".into()))
        );
    }

    #[test]
    fn ignores_lines_without_a_path() {
        assert_eq!(parse_porcelain_line(""), None);
        assert_eq!(parse_porcelain_line("M"), None);
    }

    #[test]
    fn skips_directory_entries() {
        // A collapsed untracked directory is not a readable file.
        assert_eq!(parse_porcelain_line("?? .claude/"), None);
    }

    #[test]
    fn reads_a_file_inside_the_root() {
        let root = std::env::temp_dir().join("code_peek_scope_ok");
        let _ = std::fs::remove_dir_all(&root);
        std::fs::create_dir_all(root.join("sub")).unwrap();
        std::fs::write(root.join("sub/file.txt"), "hello").unwrap();
        assert_eq!(read_in_scope(&root, "sub/file.txt").unwrap(), "hello");
        let _ = std::fs::remove_dir_all(&root);
    }

    #[test]
    fn rejects_traversal_outside_the_root() {
        let base = std::env::temp_dir().join("code_peek_scope_escape");
        let root = base.join("root");
        let _ = std::fs::remove_dir_all(&base);
        std::fs::create_dir_all(&root).unwrap();
        // A secret sibling of root — reachable only via `../`.
        std::fs::write(base.join("secret.txt"), "top secret").unwrap();
        let err = read_in_scope(&root, "../secret.txt").unwrap_err();
        assert_eq!(err, "path is outside the repository");
        let _ = std::fs::remove_dir_all(&base);
    }
}
