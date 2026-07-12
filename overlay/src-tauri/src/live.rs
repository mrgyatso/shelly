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
    crate::paths::companion_dir()
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

/// Whether a live source is a tool-internal "observer" session that must never
/// reach the Board. claude-mem (and similar) spawn long-lived `claude` processes
/// under `~/.claude-mem/observer-sessions` to watch other sessions; those run the
/// companion SessionStart hook too, so they write `live/observer-sessions--*.json`.
/// They are NOT user-interactive work — left in, they flood the roster and (worse)
/// get bound/resumed like a real session. The plugin now early-exits for
/// `.claude-mem` cwds, but we filter here too so an already-written file (or an
/// un-updated plugin install) can never surface. Matched on the slug (the cwd
/// basename, `observer-sessions`) or any `.claude-mem` marker in the file body.
fn is_observer_source(source: &str, raw: &str) -> bool {
    source.split("--").next() == Some("observer-sessions") || raw.contains(".claude-mem")
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
    inject_fields(&raw, updated_ms, None, None, false, None, None, None)
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
    // Only ids with a real transcript are resumable — a stub session registers a
    // session-id but never writes a conversation, so resuming it 404s ("No conversation
    // found"). Validate the sidecar ids against on-disk transcripts so the Board never
    // offers a phantom for `--resume`. Skip the scan entirely when nothing's owned.
    let existing_ids = if sids.is_empty() {
        std::collections::HashSet::new()
    } else {
        crate::sessions::existing_session_ids()
    };
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
        // Tool-internal observer sessions (claude-mem et al.) never reach the Board.
        if is_observer_source(&source, &raw) {
            continue;
        }
        let updated_ms = std::fs::metadata(&path)
            .and_then(|m| m.modified())
            .ok()
            .and_then(|t| t.duration_since(std::time::UNIX_EPOCH).ok())
            .map(|d| d.as_millis() as u64)
            .unwrap_or(0);
        let companion_session = owned.get(&source).map(|s| s.as_str());
        let unit_dir = dirs.get(&source).map(|s| s.as_str());
        let is_dismissed = dismissed.contains(&source);
        let session_id = sids
            .get(&source)
            .map(|s| s.as_str())
            .filter(|id| existing_ids.contains(*id));
        // Phase 2: resolve this source's identity authoritatively from the registry when its
        // full session_id is known (owned sessions record it in session-ids.json). Uses the
        // RAW sidecar id — resolution needs no transcript, unlike the resume `session_id`
        // above. `None` (no record yet) leaves the live file's own identity in place.
        let identity = sids
            .get(&source)
            .and_then(|id| crate::registry::resolve_identity(id));
        // Which CLI owns this session — from the same frozen record. Lets the Board
        // badge Codex sessions and pick the right resume verb. Only resolvable for
        // owned sessions (the sidecar carries the full id); external sessions keep
        // whatever provider their live stub recorded.
        let provider = sids
            .get(&source)
            .and_then(|id| crate::registry::resolve_provider(id));
        out.push(LiveSource {
            json: inject_fields(
                &raw,
                updated_ms,
                companion_session,
                unit_dir,
                is_dismissed,
                session_id,
                identity.as_ref(),
                provider.as_deref(),
            ),
            source,
        });
    }
    out.sort_by(|a, b| a.source.cmp(&b.source));
    crate::trace::emit(
        "live",
        "read",
        &[
            ("sources", &out.len().to_string()),
            ("owned", &owned.len().to_string()),
        ],
    );
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
    identity: Option<&crate::registry::Identity>,
    provider: Option<&str>,
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
                // PHASE 2 — registry first. When this source's identity was resolved
                // authoritatively from its session record, override EVERY identity field the
                // live file carries. At parity they're equal (both come from the one
                // SessionStart derivation); they differ when the live-file value drifted —
                // exactly the case the registry is meant to win.
                //
                // All three, not just `unit_key`: the live file is rewritten by the MODEL each
                // turn, so `project` and `is_repo` are self-reported too. `project` is the
                // Board's grouping key AND the tile's title, so a model that writes a freeform
                // description there ("IT drop-and-run tool (concept eval)") instead of the
                // directory name re-homes its own tile under a phantom unit and re-titles it —
                // while its artifacts, which already route via this registry, stay filed under
                // the real unit. Same session, two homes. Identity is recorded once, at
                // SessionStart; the model owns STATUS (`working`/`where`/`next`) and nothing
                // more. Fields absent from the record are left as-is rather than blanked.
                if let Some(id) = identity {
                    obj.insert("unit_key".into(), serde_json::json!(id.unit_key));
                    if let Some(p) = &id.project {
                        obj.insert("project".into(), serde_json::json!(p));
                    }
                    if let Some(r) = id.is_repo {
                        obj.insert("is_repo".into(), serde_json::json!(r));
                    }
                }
                // The registry's provider wins over whatever the live file carries
                // (the agent may drop the field when rewriting its heartbeat).
                if let Some(p) = provider {
                    obj.insert("provider".into(), serde_json::json!(p));
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
            None,
            None,
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
        let out = inject_fields(r#"{"working":"x"}"#, 7, None, None, false, None, None, None);
        let v: serde_json::Value = serde_json::from_str(&out).unwrap();
        assert!(v.get("companion_session").is_none());
        assert!(v.get("unit_dir").is_none());
        assert!(v.get("session_id").is_none());
        assert!(v.get("dismissed").is_none());
        assert_eq!(v["updated_ms"], 7);
    }

    #[test]
    fn injects_dismissed_only_when_true() {
        let out = inject_fields(r#"{"working":"x"}"#, 1, None, None, true, None, None, None);
        let v: serde_json::Value = serde_json::from_str(&out).unwrap();
        assert_eq!(v["dismissed"], true);
    }

    /// Thread-local, so no lock and no environment mutation: each test owns its home.
    fn with_home<T>(home: &std::path::Path, f: impl FnOnce() -> T) -> T {
        crate::paths::set_home_for_test(home);
        f()
    }

    /// A registry-resolved identity, as `read_all_live` hands it to `inject_fields`.
    fn ident(
        unit_key: &str,
        project: Option<&str>,
        is_repo: Option<bool>,
    ) -> crate::registry::Identity {
        crate::registry::Identity {
            unit_key: unit_key.to_string(),
            project: project.map(|s| s.to_string()),
            is_repo,
        }
    }

    #[test]
    fn unit_override_replaces_live_file_unit_key() {
        // The registry-resolved unit wins over the live file's own (possibly drifted) value.
        let id = ident("true-unit", None, None);
        let out = inject_fields(
            r#"{"working":"x","unit_key":"drifted-slug"}"#,
            5,
            None,
            None,
            false,
            None,
            Some(&id),
            None,
        );
        let v: serde_json::Value = serde_json::from_str(&out).unwrap();
        assert_eq!(v["unit_key"], "true-unit");
    }

    #[test]
    fn heartbeat_that_lies_about_identity_is_overruled_by_the_record() {
        // The incident this fix exists for: the model rewrote its own live file with the
        // FILENAME STEM as `unit_key` and a freeform description as `project`, re-homing its
        // tile under a phantom unit and re-titling it — while its artifacts, routed through
        // the same registry, stayed filed under the real unit. The record wins on identity;
        // status stays the model's to report.
        let id = ident("claude-portable", Some("claude-portable"), Some(false));
        let out = inject_fields(
            r#"{"working":"Assessing the tool","where":["docs/eval.md"],
                "unit_key":"claude-portable--a7ce6917",
                "project":"IT AI-agent drop-and-run tool (concept eval)",
                "is_repo":true}"#,
            5,
            None,
            None,
            false,
            Some("a7ce6917-2e13-4e7e-9448-19905a93d953"),
            Some(&id),
            None,
        );
        let v: serde_json::Value = serde_json::from_str(&out).unwrap();
        // Identity — every self-reported field is overruled by the record.
        assert_eq!(v["unit_key"], "claude-portable");
        assert_eq!(v["project"], "claude-portable");
        assert_eq!(v["is_repo"], false);
        // Status — untouched, still model-owned.
        assert_eq!(v["working"], "Assessing the tool");
        assert_eq!(v["where"][0], "docs/eval.md");
    }

    #[test]
    fn well_behaved_heartbeat_is_unchanged() {
        // No regression for the normal case: record and live file already agree.
        let id = ident("repo", Some("repo"), Some(true));
        let out = inject_fields(
            r#"{"working":"x","unit_key":"repo","project":"repo","is_repo":true}"#,
            5,
            None,
            None,
            false,
            None,
            Some(&id),
            None,
        );
        let v: serde_json::Value = serde_json::from_str(&out).unwrap();
        assert_eq!(v["unit_key"], "repo");
        assert_eq!(v["project"], "repo");
        assert_eq!(v["is_repo"], true);
    }

    #[test]
    fn record_without_project_leaves_the_live_value_alone() {
        // A partial record stamps what it has and blanks nothing — an older record with no
        // `project`/`is_repo` must not erase the tile's title.
        let id = ident("repo", None, None);
        let out = inject_fields(
            r#"{"unit_key":"drifted","project":"repo","is_repo":true}"#,
            5,
            None,
            None,
            false,
            None,
            Some(&id),
            None,
        );
        let v: serde_json::Value = serde_json::from_str(&out).unwrap();
        assert_eq!(v["unit_key"], "repo");
        assert_eq!(v["project"], "repo");
        assert_eq!(v["is_repo"], true);
    }

    #[test]
    fn no_unit_override_keeps_live_file_unit_key() {
        let out = inject_fields(
            r#"{"working":"x","unit_key":"repo"}"#,
            5,
            None,
            None,
            false,
            None,
            None,
            None,
        );
        let v: serde_json::Value = serde_json::from_str(&out).unwrap();
        assert_eq!(v["unit_key"], "repo");
    }

    #[test]
    fn provider_from_registry_wins_over_live_file() {
        // A Codex session whose agent dropped the field on rewrite gets it back…
        let out = inject_fields(
            r#"{"working":"x"}"#,
            5,
            None,
            None,
            false,
            None,
            None,
            Some("codex"),
        );
        let v: serde_json::Value = serde_json::from_str(&out).unwrap();
        assert_eq!(v["provider"], "codex");
        // …and with no registry value, whatever the live file carries survives.
        let keep = inject_fields(
            r#"{"working":"x","provider":"codex"}"#,
            5,
            None,
            None,
            false,
            None,
            None,
            None,
        );
        let v: serde_json::Value = serde_json::from_str(&keep).unwrap();
        assert_eq!(v["provider"], "codex");
    }

    #[test]
    fn malformed_passes_through_verbatim() {
        let id = ident("u", Some("u"), Some(true));
        let out = inject_fields(
            "not json",
            1,
            Some("board-1"),
            None,
            true,
            Some("x"),
            Some(&id),
            None,
        );
        assert_eq!(out, "not json");
    }

    #[test]
    fn read_all_live_corrects_a_lying_heartbeat_end_to_end() {
        // The incident, reproduced from disk through the real poll command: a live file the
        // model mis-wrote, next to the record that was frozen at SessionStart. This is the
        // exact shape the Board renders a tile from, so it is the level the bug lived at.
        // The session is EXTERNAL (no owned tab, no transcript) — the correction must not
        // depend on the Board having spawned it.
        let tmp = std::env::temp_dir().join(format!("cmp-live-e2e-{}", std::process::id()));
        let cmp = tmp.join(".claude/companion");
        let sid = "a7ce6917-2e13-4e7e-9448-19905a93d953";
        std::fs::create_dir_all(cmp.join("live")).unwrap();
        std::fs::create_dir_all(cmp.join("sessions")).unwrap();
        std::fs::write(
            cmp.join("live/claude-portable--a7ce6917.json"),
            r#"{"working":"Assessing the tool",
                "unit_key":"claude-portable--a7ce6917",
                "project":"IT AI-agent drop-and-run tool (concept eval)"}"#,
        )
        .unwrap();
        std::fs::write(
            cmp.join(format!("sessions/{sid}.json")),
            format!(
                r#"{{"session_id":"{sid}","unit_key":"claude-portable",
                     "project":"claude-portable","slug":"claude-portable","is_repo":false}}"#
            ),
        )
        .unwrap();
        std::fs::write(
            cmp.join("session-ids.json"),
            format!(r#"{{"claude-portable--a7ce6917":"{sid}"}}"#),
        )
        .unwrap();

        let sources = with_home(&tmp, read_all_live);

        assert_eq!(sources.len(), 1);
        let v: serde_json::Value = serde_json::from_str(&sources[0].json).unwrap();
        // The tile now groups under the real unit and is titled for the real project.
        assert_eq!(v["unit_key"], "claude-portable");
        assert_eq!(v["project"], "claude-portable");
        assert_eq!(v["is_repo"], false);
        // Status still comes from the model.
        assert_eq!(v["working"], "Assessing the tool");
        let _ = std::fs::remove_dir_all(&tmp);
    }

    #[test]
    fn observer_sources_are_filtered() {
        // The claude-mem observer slug, by stem.
        assert!(is_observer_source(
            "observer-sessions--12e33a8c",
            r#"{"project":"observer-sessions"}"#
        ));
        // A real session that mentions .claude-mem in its body (e.g. cwd leaked in).
        assert!(is_observer_source(
            "repo--abc12345",
            r#"{"working":"poking /Users/me/.claude-mem/db"}"#
        ));
        // A normal session is untouched.
        assert!(!is_observer_source(
            "claude-code-companion--96c4bed2",
            r#"{"working":"x","unit_key":"claude-code-companion--96c4bed2"}"#
        ));
    }
}
