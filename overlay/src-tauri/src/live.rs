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

/// Contents of the active live-state file, or an empty string if none is present
/// or readable. Prefers the newest per-session file; falls back to the legacy
/// single `live.json`.
///
/// The file's mtime is injected as `updated_ms` so the frontend can pick the
/// freshest of this *local* state and a *remote* hub's state (which carries the
/// same field). A malformed file is returned verbatim so it still surfaces as
/// the render fallback rather than sinking the command.
#[tauri::command]
pub fn read_live() -> String {
    let path = match newest_live_file().or_else(legacy_live_path) {
        Some(p) => p,
        None => return String::new(),
    };
    let raw = match std::fs::read_to_string(&path) {
        Ok(r) => r,
        Err(_) => return String::new(),
    };
    let updated_ms = std::fs::metadata(&path)
        .and_then(|m| m.modified())
        .ok()
        .and_then(|t| t.duration_since(std::time::UNIX_EPOCH).ok())
        .map(|d| d.as_millis() as u64)
        .unwrap_or(0);
    match serde_json::from_str::<serde_json::Value>(&raw) {
        Ok(mut v) => {
            if let Some(obj) = v.as_object_mut() {
                obj.insert("updated_ms".into(), serde_json::json!(updated_ms));
            }
            v.to_string()
        }
        Err(_) => raw,
    }
}
