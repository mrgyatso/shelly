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

/// Board-written sidecar mapping a live-source stem (`<slug>--<shortid>`) → the
/// `tabId` of the Board-owned PTY that spawned that session. The SessionStart
/// hook (`companion-session`) writes it when `COMPANION_SESSION` is in env. The
/// Board reads it (injected per source by `read_all_live`) to match its embedded
/// terminal to the live source the spawned `claude` produces. Agent-proof: the
/// agent never writes this file, so its turn-by-turn live rewrites can't lose the
/// binding. Re-read every poll so a fresh bind is picked up within ~1 poll.
fn owned_sessions() -> std::collections::HashMap<String, String> {
    let path = match companion_dir() {
        Some(d) => d.join("owned-sessions.json"),
        None => return std::collections::HashMap::new(),
    };
    std::fs::read_to_string(&path)
        .ok()
        .and_then(|s| serde_json::from_str(&s).ok())
        .unwrap_or_default()
}

/// Board-owned sidecar mapping a live-source stem → that session's absolute
/// project root (gitroot or cwd), written by `companion-session` for every
/// session. The Board reads it (injected per source as `unit_dir`) to resolve a
/// unit's directory for "+ session in this project". Agent-proof.
fn session_dirs() -> std::collections::HashMap<String, String> {
    let path = match companion_dir() {
        Some(d) => d.join("session-dirs.json"),
        None => return std::collections::HashMap::new(),
    };
    std::fs::read_to_string(&path)
        .ok()
        .and_then(|s| serde_json::from_str(&s).ok())
        .unwrap_or_default()
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
    inject_fields(&raw, updated_ms, None, None)
}

/// One agent's live-state, tagged with the slug of the file it came from. The
/// Board renders one pane per entry (its header = the live state, its body =
/// that source's artifacts).
#[derive(serde::Serialize)]
pub struct LiveSource {
    /// The file's slug (basename without `.json`) — the source id panes group by.
    pub source: String,
    /// The file's contents with `updated_ms` injected (same shape `read_live`
    /// returns), or the raw text if it didn't parse.
    pub json: String,
}

/// EVERY `live/<slug>.json`, one entry per connected agent, sorted by slug for a
/// stable pane order (so a poll never reshuffles the Board). Generalizes
/// [`read_live`] (which returns only the newest) for the Board's per-agent panes.
/// Returns a `Vec` (never a `Result`) so a single unreadable file can't sink the
/// whole Board.
#[tauri::command]
pub fn read_all_live() -> Vec<LiveSource> {
    let dir = match live_dir() {
        Some(d) => d,
        None => return Vec::new(),
    };
    let mut out: Vec<LiveSource> = Vec::new();
    let owned = owned_sessions();
    let dirs = session_dirs();
    let entries = match std::fs::read_dir(&dir) {
        Ok(e) => e,
        Err(_) => return Vec::new(),
    };
    for entry in entries.flatten() {
        let path = entry.path();
        if path.extension().and_then(|e| e.to_str()) != Some("json") {
            continue;
        }
        let source = match path.file_stem().and_then(|s| s.to_str()) {
            Some(s) => s.to_string(),
            None => continue,
        };
        let raw = match std::fs::read_to_string(&path) {
            Ok(r) => r,
            Err(_) => continue,
        };
        let updated_ms = std::fs::metadata(&path)
            .and_then(|m| m.modified())
            .ok()
            .and_then(|t| t.duration_since(std::time::UNIX_EPOCH).ok())
            .map(|d| d.as_millis() as u64)
            .unwrap_or(0);
        let companion_session = owned.get(&source).map(|s| s.as_str());
        let unit_dir = dirs.get(&source).map(|s| s.as_str());
        out.push(LiveSource {
            json: inject_fields(&raw, updated_ms, companion_session, unit_dir),
            source,
        });
    }
    out.sort_by(|a, b| a.source.cmp(&b.source));
    out
}

/// Inject `updated_ms` (and, for Board-owned sessions, `companion_session`) into
/// a live-state JSON object, returning the serialized string. A malformed file is
/// returned verbatim so it still surfaces as the render fallback rather than being
/// dropped.
fn inject_fields(
    raw: &str,
    updated_ms: u64,
    companion_session: Option<&str>,
    unit_dir: Option<&str>,
) -> String {
    match serde_json::from_str::<serde_json::Value>(raw) {
        Ok(mut v) => {
            if let Some(obj) = v.as_object_mut() {
                obj.insert("updated_ms".into(), serde_json::json!(updated_ms));
                if let Some(cs) = companion_session {
                    obj.insert("companion_session".into(), serde_json::json!(cs));
                }
                if let Some(dir) = unit_dir {
                    obj.insert("unit_dir".into(), serde_json::json!(dir));
                }
            }
            v.to_string()
        }
        Err(_) => raw.to_string(),
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn injects_companion_session_and_dir_when_owned() {
        let out = inject_fields(
            r#"{"working":"x","unit_key":"repo"}"#,
            42,
            Some("board-3"),
            Some("/Users/me/repo"),
        );
        let v: serde_json::Value = serde_json::from_str(&out).unwrap();
        assert_eq!(v["companion_session"], "board-3");
        assert_eq!(v["unit_dir"], "/Users/me/repo");
        assert_eq!(v["updated_ms"], 42);
        assert_eq!(v["unit_key"], "repo"); // existing fields preserved
    }

    #[test]
    fn omits_optional_fields_when_external() {
        let out = inject_fields(r#"{"working":"x"}"#, 7, None, None);
        let v: serde_json::Value = serde_json::from_str(&out).unwrap();
        assert!(v.get("companion_session").is_none());
        assert!(v.get("unit_dir").is_none());
        assert_eq!(v["updated_ms"], 7);
    }

    #[test]
    fn malformed_passes_through_verbatim() {
        let out = inject_fields("not json", 1, Some("board-1"), None);
        assert_eq!(out, "not json");
    }
}
