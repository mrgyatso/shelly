//! The identity registry — read side (Rust).
//!
//! The single resolution rule of the redesign: an artifact or live source carries a
//! `session_id`; look up `sessions/<session_id>.json` (written ONCE at SessionStart by
//! `plugin/hooks/companion-identity.cjs`); read its frozen `unit_key`. No re-derivation
//! from a volatile cwd/slug/mtime — the answer was decided before the artifact existed.
//!
//! Phase 2 is additive: callers resolve via the registry FIRST and fall back to the old
//! derivation when there is no record (every pre-registry session). Phase 4 removes the
//! fallback and makes a miss fail loud.
//!
//! This mirrors the read half of `companion-identity.cjs` (same paths, same `safe_id`
//! sanitization) so the two languages resolve a given `session_id` identically.

use std::path::PathBuf;

/// `~/.claude/companion` — the companion runtime dir.
fn companion_dir() -> Option<PathBuf> {
    crate::paths::companion_dir()
}

/// Filename-safe form of a session_id — identical to `companion-identity.cjs`'s `safeId`
/// (keep `[A-Za-z0-9._-]`, every other byte → `-`). A UUID is unchanged; this only guards
/// against a malformed id escaping the sessions dir. Both writer and reader apply it, so
/// the lookup key always matches the file name.
fn safe_id(session_id: &str) -> String {
    session_id
        .chars()
        .map(|c| {
            if c.is_ascii_alphanumeric() || matches!(c, '.' | '_' | '-') {
                c
            } else {
                '-'
            }
        })
        .collect()
}

/// Absolute path of a session's record, or `None` without a HOME / empty id.
fn record_path(session_id: &str) -> Option<PathBuf> {
    let sid = safe_id(session_id);
    if sid.is_empty() {
        return None;
    }
    companion_dir().map(|d| d.join("sessions").join(format!("{sid}.json")))
}

/// The raw record JSON for a session, or `None` if unregistered/unreadable.
pub fn read_record(session_id: &str) -> Option<serde_json::Value> {
    let path = record_path(session_id)?;
    let text = std::fs::read_to_string(path).ok()?;
    serde_json::from_str(&text).ok()
}

/// A session's frozen identity: the fields the Board GROUPS and LABELS by. Every one of
/// them is recorded once at SessionStart, so none may be taken from the live file — that
/// file is rewritten by the model each turn, and a model that fat-fingers `project` into a
/// freeform description would otherwise re-home and re-title its own tile.
pub struct Identity {
    pub unit_key: String,
    pub project: Option<String>,
    pub is_repo: Option<bool>,
}

/// Resolve a session's authoritative identity from its record, or `None` if there is no
/// record yet (caller falls back to the old derivation in Phase 2). Emits a
/// `registry/resolve` | `registry/resolve-miss` trace breadcrumb so the oracle shows which
/// road each routing took.
pub fn resolve_identity(session_id: &str) -> Option<Identity> {
    let rec = read_record(session_id);
    let str_field = |k: &str| {
        rec.as_ref()
            .and_then(|v| v.get(k))
            .and_then(|v| v.as_str())
            .filter(|s| !s.is_empty())
            .map(|s| s.to_string())
    };
    // The record is only an identity if it names a unit — a record without one resolves to
    // nothing rather than stamping a half-identity over the live file's values.
    let id = str_field("unit_key").map(|unit_key| Identity {
        unit_key,
        project: str_field("project"),
        is_repo: rec
            .as_ref()
            .and_then(|v| v.get("is_repo"))
            .and_then(|v| v.as_bool()),
    });
    crate::trace::emit(
        "registry",
        if id.is_some() { "resolve" } else { "resolve-miss" },
        &[
            ("session_id", &safe_id(session_id)),
            (
                "unit_key",
                id.as_ref().map(|i| i.unit_key.as_str()).unwrap_or(""),
            ),
        ],
    );
    id
}

/// Resolve a session's authoritative `unit_key` alone — the artifact-routing caller, which
/// needs the unit and nothing else.
pub fn resolve_unit(session_id: &str) -> Option<String> {
    resolve_identity(session_id).map(|i| i.unit_key)
}

#[cfg(test)]
mod tests {
    use super::*;

    // Thread-local, so no lock and no environment mutation: each test owns its home.
    fn with_home<T>(home: &std::path::Path, f: impl FnOnce() -> T) -> T {
        crate::paths::set_home_for_test(home);
        f()
    }

    fn write_record(home: &std::path::Path, sid: &str, unit: &str) {
        let dir = home.join(".claude/companion/sessions");
        std::fs::create_dir_all(&dir).unwrap();
        std::fs::write(
            dir.join(format!("{sid}.json")),
            format!(r#"{{"session_id":"{sid}","unit_key":"{unit}"}}"#),
        )
        .unwrap();
    }

    #[test]
    fn resolves_unit_from_record() {
        let tmp = std::env::temp_dir().join(format!("cmp-reg-{}", std::process::id()));
        let sid = "abcd1234-1111-2222-3333-444444444444";
        write_record(&tmp, sid, "my-repo");
        let got = with_home(&tmp, || resolve_unit(sid));
        assert_eq!(got.as_deref(), Some("my-repo"));
        let _ = std::fs::remove_dir_all(&tmp);
    }

    #[test]
    fn missing_record_returns_none() {
        let tmp = std::env::temp_dir().join(format!("cmp-reg-miss-{}", std::process::id()));
        std::fs::create_dir_all(tmp.join(".claude/companion")).unwrap();
        let got = with_home(&tmp, || resolve_unit("no-such-session-id"));
        assert_eq!(got, None);
        let _ = std::fs::remove_dir_all(&tmp);
    }

    #[test]
    fn safe_id_leaves_uuid_untouched_and_sanitizes_traversal() {
        assert_eq!(
            safe_id("abcd1234-5678-90ab-cdef-000011112222"),
            "abcd1234-5678-90ab-cdef-000011112222"
        );
        // The safety property that matters: no path separator survives, so a malformed id
        // can only ever be a single filename component (no `..`-into-parent traversal). `.`
        // is allowed, so the slashes — not the dots — are what get neutralised.
        let s = safe_id("../../etc/passwd");
        assert_eq!(s, "..-..-etc-passwd");
        assert!(!s.contains('/') && !s.contains(std::path::MAIN_SEPARATOR));
    }
}
