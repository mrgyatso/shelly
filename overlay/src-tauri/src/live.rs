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

/// `~/.claude/companion/dismissed.json` — the set of live-source stems
/// (`<slug>--<shortid>`) the user has manually closed off the roster. A JSON
/// array of strings. Honored as a sticky override of mtime-freshness (and the
/// Board's owned-terminal promotion) so a closed session stays archived even if
/// it's still being written, until it's restored or its file is pruned.
fn dismissed_path() -> Option<PathBuf> {
    companion_dir().map(|d| d.join("dismissed.json"))
}

/// Read the dismissed-stem set (empty when the file is absent or unreadable).
fn dismissed_set() -> std::collections::HashSet<String> {
    let path = match dismissed_path() {
        Some(p) => p,
        None => return std::collections::HashSet::new(),
    };
    std::fs::read_to_string(&path)
        .ok()
        .and_then(|s| serde_json::from_str::<Vec<String>>(&s).ok())
        .map(|v| v.into_iter().collect())
        .unwrap_or_default()
}

/// Atomically persist the dismissed-stem set (sorted for a stable diff).
fn write_dismissed(set: &std::collections::HashSet<String>) -> Result<(), String> {
    let path = dismissed_path().ok_or("no HOME")?;
    if let Some(dir) = path.parent() {
        std::fs::create_dir_all(dir).map_err(|e| e.to_string())?;
    }
    let mut v: Vec<&String> = set.iter().collect();
    v.sort();
    let tmp = path.with_extension("json.tmp");
    std::fs::write(&tmp, serde_json::to_string(&v).map_err(|e| e.to_string())?)
        .map_err(|e| e.to_string())?;
    std::fs::rename(&tmp, &path).map_err(|e| e.to_string())
}

/// `~/.claude/companion/unit-names.json` — user-assigned display names, keyed by
/// `unit_key`. A JSON object `{unit_key: name}`. The Board renders the custom name
/// over the derived folder/slug label (so several home-folder sessions don't all
/// read "gyatso"); a blank name removes the override.
fn unit_names_path() -> Option<PathBuf> {
    companion_dir().map(|d| d.join("unit-names.json"))
}

/// Read the unit-name overrides (empty when the file is absent or unreadable).
fn read_unit_names_map() -> std::collections::HashMap<String, String> {
    let path = match unit_names_path() {
        Some(p) => p,
        None => return std::collections::HashMap::new(),
    };
    std::fs::read_to_string(&path)
        .ok()
        .and_then(|s| serde_json::from_str::<std::collections::HashMap<String, String>>(&s).ok())
        .unwrap_or_default()
}

/// Atomically persist the unit-name overrides.
fn write_unit_names(map: &std::collections::HashMap<String, String>) -> Result<(), String> {
    let path = unit_names_path().ok_or("no HOME")?;
    if let Some(dir) = path.parent() {
        std::fs::create_dir_all(dir).map_err(|e| e.to_string())?;
    }
    let tmp = path.with_extension("json.tmp");
    std::fs::write(&tmp, serde_json::to_string(map).map_err(|e| e.to_string())?)
        .map_err(|e| e.to_string())?;
    std::fs::rename(&tmp, &path).map_err(|e| e.to_string())
}

/// The unit-name overrides for the Board to render (`unit_key` → custom name).
#[tauri::command]
pub fn read_unit_names() -> std::collections::HashMap<String, String> {
    read_unit_names_map()
}

/// Set (or clear, when `name` is blank) a unit's display-name override.
#[tauri::command]
pub fn set_unit_name(unit_key: String, name: String) -> Result<(), String> {
    let mut map = read_unit_names_map();
    let trimmed = name.trim();
    if trimmed.is_empty() {
        map.remove(&unit_key);
    } else {
        map.insert(unit_key, trimmed.to_string());
    }
    write_unit_names(&map)
}

/// The user's home dir as an absolute path — so "+ New session" can spawn a
/// Board-owned `claude` in `~` instantly, without a folder picker. Resolved from
/// `$HOME` (no Tauri path capability needed).
#[tauri::command]
pub fn resolve_home_dir() -> Option<String> {
    std::env::var_os("HOME").map(|h| PathBuf::from(h).to_string_lossy().into_owned())
}

/// Whether `dir` is inside a git repo. Lets the Board pick the right PROVISIONAL
/// unit for a freshly-spawned session: a repo's basename IS its real unit_key
/// (so sessions in one repo correctly share it), but a non-repo session's real
/// unit_key is `slug--shortid` (unique) — its basename collides across sessions
/// (every `~` session is "gyatso"), so it needs a unique provisional instead.
/// Falls back to `false` (treat as non-repo → unique provisional, always safe)
/// when git is unavailable.
#[tauri::command]
pub fn path_is_repo(dir: String) -> bool {
    std::process::Command::new("git")
        .args(["-C", &dir, "rev-parse", "--is-inside-work-tree"])
        .output()
        .map(|o| o.status.success() && o.stdout.starts_with(b"true"))
        .unwrap_or(false)
}

/// Board-owned sidecar mapping a live-source stem → that session's FULL Claude
/// Code `session_id` (the SessionStart hook records it; the stem only carries the
/// 8-char shortid, which can't drive `claude --resume`). The Board injects it per
/// source as `session_id` so a closed Board-launched session can be REJOINED via
/// `claude --resume <id>`. Agent-proof, like the other sidecars.
fn session_ids() -> std::collections::HashMap<String, String> {
    let path = match companion_dir() {
        Some(d) => d.join("session-ids.json"),
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
    inject_fields(&raw, updated_ms, None, None, false, None)
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
    let dismissed = dismissed_set();
    let sids = session_ids();
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
        let is_dismissed = dismissed.contains(&source);
        let session_id = sids.get(&source).map(|s| s.as_str());
        out.push(LiveSource {
            json: inject_fields(
                &raw,
                updated_ms,
                companion_session,
                unit_dir,
                is_dismissed,
                session_id,
            ),
            source,
        });
    }
    out.sort_by(|a, b| a.source.cmp(&b.source));
    out
}

/// Manually close a session off the live roster: add its stem to `dismissed.json`.
/// Sticky — overrides mtime-freshness everywhere liveness is computed (Board,
/// popover, tray), so a still-writing session stays archived until restored. Does
/// NOT touch the live file or any process; the caller ends a Board-owned PTY
/// separately (so a launched claude can't balloon).
#[tauri::command]
pub fn dismiss_session(source: String) -> Result<(), String> {
    let mut set = dismissed_set();
    set.insert(source);
    write_dismissed(&set)
}

/// Reverse [`dismiss_session`]: drop the stem from `dismissed.json` so the session
/// returns to the live roster (used by click-to-restore on an archived card).
#[tauri::command]
pub fn restore_session(source: String) -> Result<(), String> {
    let mut set = dismissed_set();
    set.remove(&source);
    write_dismissed(&set)
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
    dismissed: bool,
    session_id: Option<&str>,
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
                if dismissed {
                    obj.insert("dismissed".into(), serde_json::json!(true));
                }
                if let Some(sid) = session_id {
                    obj.insert("session_id".into(), serde_json::json!(sid));
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
            false,
            Some("abc-123-full"),
        );
        let v: serde_json::Value = serde_json::from_str(&out).unwrap();
        assert_eq!(v["companion_session"], "board-3");
        assert_eq!(v["unit_dir"], "/Users/me/repo");
        assert_eq!(v["session_id"], "abc-123-full");
        assert_eq!(v["updated_ms"], 42);
        assert_eq!(v["unit_key"], "repo"); // existing fields preserved
        assert!(v.get("dismissed").is_none()); // only present when true
    }

    #[test]
    fn omits_optional_fields_when_external() {
        let out = inject_fields(r#"{"working":"x"}"#, 7, None, None, false, None);
        let v: serde_json::Value = serde_json::from_str(&out).unwrap();
        assert!(v.get("companion_session").is_none());
        assert!(v.get("unit_dir").is_none());
        assert!(v.get("session_id").is_none());
        assert!(v.get("dismissed").is_none());
        assert_eq!(v["updated_ms"], 7);
    }

    #[test]
    fn injects_dismissed_only_when_true() {
        let out = inject_fields(r#"{"working":"x"}"#, 1, None, None, true, None);
        let v: serde_json::Value = serde_json::from_str(&out).unwrap();
        assert_eq!(v["dismissed"], true);
    }

    #[test]
    fn malformed_passes_through_verbatim() {
        let out = inject_fields("not json", 1, Some("board-1"), None, true, Some("x"));
        assert_eq!(out, "not json");
    }
}
