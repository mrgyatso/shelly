//! The always-on "live" surface's data layer.
//!
//! Unlike artifacts (one immutable `.html` per panel), the live surface is a
//! single persistent window that reflects the *current* state of the work —
//! what we're on and what's next — read from a small JSON state file the agent
//! rewrites each turn. The window ([`crate::windows::open_live_window`]) renders
//! it and polls [`read_live`] for changes, so a fresh write updates it in place
//! with no popup. Two-tier model: this is the ephemeral "where are we" pane;
//! substantive turns still snapshot a full artifact into history separately.

use std::path::PathBuf;

/// `~/.claude/companion/live.json` — the single state file the live surface reads.
fn live_path() -> Option<PathBuf> {
    std::env::var_os("HOME").map(|home| {
        PathBuf::from(home)
            .join(".claude")
            .join("companion")
            .join("live.json")
    })
}

/// Raw contents of the live-state file, or an empty string if it's absent or
/// unreadable. Returns the bytes verbatim (the frontend parses) so a malformed
/// file surfaces as a render fallback rather than sinking the command.
#[tauri::command]
pub fn read_live() -> String {
    live_path()
        .and_then(|p| std::fs::read_to_string(p).ok())
        .unwrap_or_default()
}
