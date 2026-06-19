//! Auto-worktree for parallel sessions.
//!
//! When the Board starts a NEW session in a git repo that ALREADY has a live
//! session, we spawn the new `claude` in a fresh git **worktree** (on its own
//! branch) instead of the repo itself. Two agents on one project then get
//! isolated working trees + git indexes (no file/commit collisions) AND distinct
//! Board units: a worktree's `git rev-parse --show-toplevel` is its OWN path, and
//! `companion-livepath.sh` slugs the unit by that basename — so the worktree
//! lands as its own session card instead of collapsing into the repo's unit (the
//! "Claude 2 in the same session" behaviour).
//!
//! The FIRST session in a repo runs in place; only the 2nd+ isolates. Any failure
//! degrades to "spawn in place" — this never blocks starting a session.

use std::path::{Path, PathBuf};

use serde::Serialize;

/// A session is "live" (so a new one must isolate) if its live file changed
/// within this window. Mirrors the Board's own liveness window.
const LIVENESS_MS: u128 = 2 * 60 * 60 * 1000;

#[derive(Serialize)]
pub struct SpawnPlan {
    /// Where to spawn the new session — the picked dir, or a fresh worktree.
    pub dir: String,
    /// Whether `dir` is inside a git repo (drives the provisional unit choice,
    /// same as [`crate::live::path_is_repo`] but folded in to save a round-trip).
    pub is_repo: bool,
    /// True when we created a worktree for this spawn.
    pub worktree: bool,
    /// The branch checked out in the new worktree (None when spawning in place).
    pub branch: Option<String>,
}

fn live_dir() -> Option<PathBuf> {
    std::env::var_os("HOME")
        .map(|h| PathBuf::from(h).join(".claude").join("companion").join("live"))
}

/// Sanitize a project name into a slug, byte-for-byte matching
/// `companion-livepath.sh`: non-`[A-Za-z0-9._-]` → `-`, collapse `-` runs, trim.
fn sanitize_slug(name: &str) -> String {
    let mut out = String::with_capacity(name.len());
    let mut prev_dash = false;
    for c in name.chars() {
        let ch = if c.is_ascii_alphanumeric() || c == '.' || c == '_' || c == '-' {
            c
        } else {
            '-'
        };
        if ch == '-' {
            if prev_dash {
                continue;
            }
            prev_dash = true;
        } else {
            prev_dash = false;
        }
        out.push(ch);
    }
    let trimmed = out.trim_matches('-');
    if trimmed.is_empty() {
        "session".to_string()
    } else {
        trimmed.to_string()
    }
}

/// The repo root containing `dir`, or None when `dir` isn't in a git work tree.
fn git_toplevel(dir: &str) -> Option<PathBuf> {
    let out = std::process::Command::new("git")
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

/// Whether the repo `slug` already has a live session (a `live/<slug>--*.json`
/// touched within [`LIVENESS_MS`]). Note `<slug>--` (double dash) can't match a
/// worktree sibling like `<slug>-wt2--…`, so worktrees don't count as the repo.
fn has_live_session(slug: &str) -> bool {
    let dir = match live_dir() {
        Some(d) => d,
        None => return false,
    };
    let prefix = format!("{slug}--");
    let now = std::time::SystemTime::now();
    let rd = match std::fs::read_dir(&dir) {
        Ok(r) => r,
        Err(_) => return false,
    };
    for entry in rd.flatten() {
        let name = entry.file_name();
        let name = name.to_string_lossy();
        if !name.starts_with(&prefix) || !name.ends_with(".json") {
            continue;
        }
        if let Ok(mtime) = entry.metadata().and_then(|m| m.modified()) {
            if let Ok(age) = now.duration_since(mtime) {
                if age.as_millis() <= LIVENESS_MS {
                    return true;
                }
            }
        }
    }
    false
}

fn branch_exists(toplevel: &Path, branch: &str) -> bool {
    std::process::Command::new("git")
        .arg("-C")
        .arg(toplevel)
        .args(["rev-parse", "--verify", "--quiet"])
        .arg(format!("refs/heads/{branch}"))
        .output()
        .map(|o| o.status.success())
        .unwrap_or(false)
}

/// Create a sibling worktree `<repo>-wt<n>` on a fresh branch `companion/<slug>-wt<n>`,
/// branching from the repo's current HEAD. Returns `(worktree_path, branch)`.
fn create_worktree(toplevel: &Path, slug: &str) -> Option<(String, String)> {
    let parent = toplevel.parent()?;
    let base = toplevel.file_name()?.to_string_lossy().into_owned();
    for n in 2..1000u32 {
        let wt_path = parent.join(format!("{base}-wt{n}"));
        let branch = format!("companion/{slug}-wt{n}");
        if wt_path.exists() || branch_exists(toplevel, &branch) {
            continue;
        }
        let ok = std::process::Command::new("git")
            .arg("-C")
            .arg(toplevel)
            .args(["worktree", "add"])
            .arg(&wt_path)
            .args(["-b", &branch])
            .output()
            .map(|o| o.status.success())
            .unwrap_or(false);
        // A free (path, branch) that still failed is a real error (disk, perms) —
        // don't spin through 998 names; fall back to in-place.
        return if ok {
            Some((wt_path.to_string_lossy().into_owned(), branch))
        } else {
            None
        };
    }
    None
}

/// Decide where a new Board-owned session should spawn. Non-repo or first-in-repo
/// → the picked dir. Second+ session in a repo → a fresh isolated worktree.
#[tauri::command]
pub fn resolve_spawn_dir(dir: String) -> SpawnPlan {
    let toplevel = match git_toplevel(&dir) {
        Some(t) => t,
        None => {
            return SpawnPlan {
                dir,
                is_repo: false,
                worktree: false,
                branch: None,
            }
        }
    };
    let base = toplevel
        .file_name()
        .map(|s| s.to_string_lossy().into_owned())
        .unwrap_or_default();
    let slug = sanitize_slug(&base);

    if !has_live_session(&slug) {
        // First session in this repo — run in place (the dir the user picked).
        return SpawnPlan {
            dir,
            is_repo: true,
            worktree: false,
            branch: None,
        };
    }

    match create_worktree(&toplevel, &slug) {
        Some((path, branch)) => SpawnPlan {
            dir: path,
            is_repo: true,
            worktree: true,
            branch: Some(branch),
        },
        None => SpawnPlan {
            dir,
            is_repo: true,
            worktree: false,
            branch: None,
        },
    }
}

#[cfg(test)]
mod tests {
    use super::sanitize_slug;

    #[test]
    fn slug_matches_livepath_sh() {
        assert_eq!(sanitize_slug("claude-code-companion"), "claude-code-companion");
        assert_eq!(sanitize_slug("My Project!"), "My-Project");
        assert_eq!(sanitize_slug("a__b.c-d"), "a__b.c-d");
        assert_eq!(sanitize_slug("--weird--"), "weird");
        assert_eq!(sanitize_slug("///"), "session");
        assert_eq!(sanitize_slug("claude-code-companion-wt2"), "claude-code-companion-wt2");
    }
}
