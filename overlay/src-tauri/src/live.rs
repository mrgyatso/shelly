//! The always-on "live" surface's data layer.
//!
//! Unlike artifacts (one immutable `.html` per panel), the live surface is a
//! single persistent window that reflects the *current* state of the work —
//! what we're on and what's next — read from small JSON state files the agent
//! rewrites each turn. The window ([`crate::windows::open_live_window`]) renders
//! it and polls [`read_live`] for changes, so a fresh write updates it in place
//! with no popup. Two-tier model: this is the ephemeral "where are we" pane;
//! substantive turns still snapshot a full artifact into history separately.
//!
//! **Per-session state.** A single shared file would let concurrent Claude
//! sessions clobber each other's surface. Instead each session writes its own
//! file under `~/.claude/companion/live/<slug>.json` (slug = the working dir's
//! basename), and [`read_live`] returns the **most-recently-modified** one — so
//! the pane tracks the session you most recently took a turn in. Each file
//! carries a `project` label so the pane can say *whose* work it's showing. The
//! legacy single `live.json` is still read as a fallback when the dir is empty.

use std::path::PathBuf;

/// `~/.claude/companion` — the companion runtime dir.
fn companion_dir() -> Option<PathBuf> {
    std::env::var_os("HOME").map(|home| PathBuf::from(home).join(".claude").join("companion"))
}

/// `~/.claude/companion/live/` — the per-session state directory.
fn live_dir() -> Option<PathBuf> {
    companion_dir().map(|d| d.join("live"))
}

/// `~/.claude/companion/live.json` — the legacy single state file (fallback).
fn legacy_live_path() -> Option<PathBuf> {
    companion_dir().map(|d| d.join("live.json"))
}

/// The most-recently-modified `*.json` under the per-session dir, if any.
fn newest_live_file() -> Option<PathBuf> {
    let dir = live_dir()?;
    let mut newest: Option<(std::time::SystemTime, PathBuf)> = None;
    for entry in std::fs::read_dir(&dir).ok()?.flatten() {
        let path = entry.path();
        if path.extension().and_then(|e| e.to_str()) != Some("json") {
            continue;
        }
        let mtime = match entry.metadata().and_then(|m| m.modified()) {
            Ok(t) => t,
            Err(_) => continue,
        };
        if newest.as_ref().is_none_or(|(t, _)| mtime > *t) {
            newest = Some((mtime, path));
        }
    }
    newest.map(|(_, p)| p)
}

/// Raw contents of the active live-state file, or an empty string if none is
/// present or readable. Prefers the newest per-session file; falls back to the
/// legacy single `live.json`. Returns the bytes verbatim (the frontend parses)
/// so a malformed file surfaces as a render fallback rather than sinking the
/// command.
#[tauri::command]
pub fn read_live() -> String {
    newest_live_file()
        .or_else(legacy_live_path)
        .and_then(|p| std::fs::read_to_string(p).ok())
        .unwrap_or_default()
}
